"""
server.py - CREST Flask API Server
====================================
Exposes CREST data over HTTP for the React dashboard.

Usage:
    python server.py

Endpoints:
    GET /api/scan     - Run a full manufacturing scan and return results
    GET /api/wallet   - Return current wallet balance
    GET /api/plex     - Return PLEX progress data
    GET /api/minerals - Return Jita mineral prices
"""

from flask import Flask, jsonify, send_file, send_from_directory, Response, stream_with_context
from flask_cors import CORS
import time
import json
import os
import threading
import requests

from blueprints import load_blueprints, MINERALS
from calculator import calculate_all
from database import save_scan, record_wallet_snapshot, record_wealth_snapshot, get_wallet_history
import alert_scanner as _alert_scanner

app = Flask(__name__)
CORS(app)  # Allow React dev server (localhost:3000 / file://) to call the API

# ── Corp BPO static fallback ──────────────────────────────────────────────────
# Loaded once at startup from src/corp_BPOs (tab-separated, col 0 = BP name).
# Used when ESI corp blueprints endpoint returns 403 (insufficient role).
def _load_corp_bpo_type_ids() -> set:
    """Parse src/corp_BPOs and return a set of blueprint type_ids via crest.db lookup."""
    result = set()
    try:
        import sqlite3 as _sq
        _base = os.path.dirname(__file__)
        _txt  = os.path.join(_base, "src", "corp_BPOs")
        _db   = os.path.join(_base, "crest.db")
        if not os.path.exists(_txt) or not os.path.exists(_db):
            return result
        con = _sq.connect(_db)
        cur = con.cursor()
        cur.execute("SELECT blueprint_id, output_name FROM blueprints")
        name_to_id = {(row[1].strip() + " Blueprint").lower(): row[0] for row in cur.fetchall()}
        con.close()
        with open(_txt, "r", encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split("\t")
                if not parts or not parts[0].strip():
                    continue
                key = parts[0].strip().lower()
                if key in name_to_id:
                    result.add(name_to_id[key])
        print(f"  [corp_BPOs] Loaded {len(result)} unique corp BP type_ids from static file.")
    except Exception as e:
        print(f"  [corp_BPOs] Failed to load static file: {e}")
    return result

CORP_BPO_TYPE_IDS: set = _load_corp_bpo_type_ids()

# ── PLEX config ───────────────────────────────────────────────────────────────
PLEX_CONFIG = {
    "accounts":         6,
    "plex_per_account": 500,
}

# ── In-memory scan cache (avoids re-running a long scan on every page load) ───
_scan_cache: dict = {}
SCAN_CACHE_TTL = 300  # 5 minutes


def _scan_is_fresh() -> bool:
    ts = _scan_cache.get("scanned_at", 0)
    return (time.time() - ts) < SCAN_CACHE_TTL


# ── Calculator cache (keyed by facility+system params, TTL 30 min) ───────────
_calc_cache: dict = {}
CALC_CACHE_TTL = 1800  # 30 minutes

# ── Skill name cache (type_id → skill name, loaded once from Fuzzwork CSV) ───
_skill_id_names: dict[int, str] = {}


def _calc_cache_key(system: str, facility: str) -> str:
    return f"{system.lower()}|{facility.lower()}"


def _calc_is_fresh(key: str) -> bool:
    entry = _calc_cache.get(key)
    if not entry:
        return False
    return (time.time() - entry.get("generated_at", 0)) < CALC_CACHE_TTL


# ── Live progress broadcast (SSE) ─────────────────────────────────────────────
# Maps cache_key → list of subscriber queues
import queue as _queue
_progress_subscribers: dict[str, list] = {}
_progress_lock = threading.Lock()


def _broadcast_progress(cache_key: str, msg: dict):
    """Push a progress message to all SSE subscribers for this key."""
    with _progress_lock:
        subs = _progress_subscribers.get(cache_key, [])
        dead = []
        for q in subs:
            try:
                q.put_nowait(msg)
            except Exception:
                dead.append(q)
        for q in dead:
            subs.remove(q)


def _subscribe_progress(cache_key: str) -> _queue.Queue:
    q = _queue.Queue(maxsize=200)
    with _progress_lock:
        _progress_subscribers.setdefault(cache_key, []).append(q)
    return q


def _unsubscribe_progress(cache_key: str, q: _queue.Queue):
    with _progress_lock:
        subs = _progress_subscribers.get(cache_key, [])
        if q in subs:
            subs.remove(q)


# ── Helpers ───────────────────────────────────────────────────────────────────
def _get_wallet() -> float:
    """Fetch combined wallet balance across ALL authenticated characters."""
    try:
        import requests as _req
        from characters import get_all_auth_headers, load_characters
        ESI_BASE = "https://esi.evetech.net/latest"
        auth_headers = get_all_auth_headers()
        total = 0.0
        for cid, headers in auth_headers:
            try:
                r = _req.get(f"{ESI_BASE}/characters/{cid}/wallet/", headers=headers, timeout=8)
                if r.ok:
                    total += float(r.json())
            except Exception:
                pass
        return total
    except Exception:
        return 0.0


def _get_plex_price(prices: dict) -> float:
    """Return Jita sell price for PLEX (type_id 44992)."""
    try:
        from pricer import get_prices_bulk
        result = get_prices_bulk([44992])
        return result.get(44992, {}).get("sell", 4_300_000)
    except Exception:
        return 4_300_000  # Reasonable fallback


def _mineral_prices(prices: dict) -> dict:
    """Extract mineral prices from a prices dict keyed by type_id."""
    mineral_data = {}
    for name, tid in MINERALS.items():
        entry = prices.get(tid, {})
        mineral_data[name] = {
            "type_id":   tid,
            "sell":      entry.get("sell", 0),
            "buy":       entry.get("buy", 0),
        }
    return mineral_data


# ── Routes ────────────────────────────────────────────────────────────────────

_HERE = os.path.dirname(os.path.abspath(__file__))

@app.route("/", methods=["GET"])
def dashboard():
    dist = os.path.join(_HERE, "dist", "index.html")
    if os.path.exists(dist):
        return send_file(dist)
    return send_file(os.path.join(_HERE, "dashboard.html"))

@app.route("/assets/<path:filename>")
def serve_assets(filename):
    return send_from_directory(os.path.join(_HERE, "dist", "assets"), filename)


# ── Character management endpoints ────────────────────────────────────────────

@app.route("/api/characters", methods=["GET"])
def api_characters_list():
    """Return list of all connected characters with live wallet + job data."""
    try:
        from characters import list_characters
        return jsonify({"characters": list_characters()})
    except Exception as e:
        return jsonify({"error": str(e), "characters": []}), 200

@app.route("/api/characters/<character_id>", methods=["DELETE"])
def api_characters_remove(character_id):
    """Remove a character from the store."""
    try:
        from characters import remove_character
        removed = remove_character(character_id)
        return jsonify({"ok": removed})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/characters/<character_id>/stats", methods=["GET"])
def api_character_stats(character_id):
    """Fetch live wallet + active job count for a single character."""
    try:
        from characters import get_character_stats
        return jsonify(get_character_stats(character_id))
    except Exception as e:
        return jsonify({"error": str(e)}), 200

@app.route("/api/characters/add", methods=["POST"])
def api_characters_add():
    """Start the OAuth flow — opens browser, returns a state token to poll."""
    try:
        from characters import begin_add_character
        state = begin_add_character()
        return jsonify({"state": state})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/characters/poll/<state>", methods=["GET"])
def api_characters_poll(state):
    """Poll a pending OAuth flow for completion."""
    try:
        from characters import poll_add_character
        result = poll_add_character(state, timeout=0.5)
        return jsonify(result)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 200


@app.route("/api/scan", methods=["GET"])
def api_scan():
    global _scan_cache

    if _scan_is_fresh():
        return jsonify(_scan_cache)

    try:
        results = calculate_all()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    # Try to add hangar data if ESI token is available
    try:
        from hangar import enrich_results_with_hangar
        from assets import CHARACTER_ID
        from auth import get_auth_header
        results = enrich_results_with_hangar(results, load_blueprints(), CHARACTER_ID, get_auth_header())
    except Exception:
        # No ESI token — hangar data will be absent (can_build = None)
        pass

    try:
        save_scan(results)
    except Exception:
        pass

    # Collect all type_ids we need for mineral pricing
    all_type_ids = set(MINERALS.values())
    for r in results:
        for mat in r.get("material_breakdown", []):
            all_type_ids.add(mat["type_id"])

    try:
        from pricer import get_prices_bulk
        prices = get_prices_bulk(list(all_type_ids))
    except Exception:
        prices = {}

    # Strip material_breakdown from results (internal detail – keep payload lean)
    # But save mineral price info first
    for r in results:
        r.pop("material_breakdown", None)

    # Deduplicate by output_id — keep highest-profit entry per product
    seen = set()
    deduped = []
    for r in results:
        oid = r.get("output_id")
        if oid in seen:
            continue
        seen.add(oid)
        deduped.append(r)

    _scan_cache = {
        "scanned_at": int(time.time()),
        "results":    deduped[:50],   # Overview: top 50 by net profit
        "minerals":   _mineral_prices(prices),
    }
    return jsonify(_scan_cache)


@app.route("/api/wallet", methods=["GET"])
def api_wallet():
    balance = _get_wallet()
    return jsonify({"balance": balance})


@app.route("/api/plex", methods=["GET"])
def api_plex():
    balance    = _get_wallet()
    if balance > 0:
        try:
            record_wallet_snapshot(balance)
        except Exception:
            pass
    plex_price = _get_plex_price({})

    # NOTE: PLEX in the Account Vault is not exposed by esi-assets.read_assets.v1.
    # All character asset pages were scanned — PLEX simply does not appear there.
    # We return plex_count=null so the UI knows to hide the field rather than show 0.

    accounts         = PLEX_CONFIG["accounts"]
    plex_per_account = PLEX_CONFIG["plex_per_account"]
    monthly_target   = accounts * plex_per_account * plex_price

    # Days remaining: rough estimate — use current day-of-month
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    # Last day of current month
    import calendar
    days_in_month   = calendar.monthrange(now.year, now.month)[1]
    days_remaining  = days_in_month - now.day

    return jsonify({
        "accounts":        accounts,
        "plex_price":      plex_price,
        "plex_per_account":plex_per_account,
        "monthly_target":  monthly_target,
        "current_balance": balance,
        "plex_count":      None,
        "plex_value":      None,
        "days_remaining":  days_remaining,
    })


@app.route("/api/wallet/history", methods=["GET"])
def api_wallet_history():
    """Return wallet balance snapshots for the sparkline."""
    try:
        history = get_wallet_history(days=30)
        return jsonify(history)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Ore price trend helpers — persisted in market_cache.db market_meta ──────
import sqlite3 as _sqlite3

def _load_ore_price_prev() -> dict:
    """Load the previously saved ore sell prices from market_meta (survives restarts)."""
    try:
        conn = _sqlite3.connect(os.path.join(_HERE, "market_cache.db"))
        conn.row_factory = _sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT value FROM market_meta WHERE key='ore_price_prev'")
        row = cur.fetchone()
        conn.close()
        if row:
            import json as _json
            return _json.loads(row["value"])
    except Exception:
        pass
    return {}


def _save_ore_price_prev(prices: dict) -> None:
    """Persist ore sell prices into market_meta for trend comparison on next fetch."""
    try:
        import json as _json
        conn = _sqlite3.connect(os.path.join(_HERE, "market_cache.db"))
        conn.execute(
            "INSERT OR REPLACE INTO market_meta (key, value) VALUES ('ore_price_prev', ?)",
            (_json.dumps(prices),)
        )
        conn.commit()
        conn.close()
    except Exception:
        pass


@app.route("/api/minerals", methods=["GET"])
def api_minerals():
    """Return current Jita prices for all 8 minerals + common base ores with ISK/m3."""
    # Base ores: type_id → { name, volume_m3 }  (volume per unit from SDE)
    ORES = {
        1230:  {"name": "Veldspar",    "m3": 0.1},
        1228:  {"name": "Scordite",    "m3": 0.15},
        1224:  {"name": "Pyroxeres",   "m3": 0.3},
        18:    {"name": "Kernite",     "m3": 1.2},
        1226:  {"name": "Omber",       "m3": 0.6},
        20:    {"name": "Jaspet",      "m3": 2.0},
        21:    {"name": "Hemorphite",  "m3": 3.0},
        1227:  {"name": "Hedbergite",  "m3": 3.0},
        22:    {"name": "Gneiss",      "m3": 5.0},
        1229:  {"name": "Dark Ochre",  "m3": 8.0},
        17470: {"name": "Bistot",      "m3": 16.0},
        17463: {"name": "Crokite",     "m3": 16.0},
        17464: {"name": "Spodumain",   "m3": 16.0},
        17459: {"name": "Arkonor",     "m3": 16.0},
        17425: {"name": "Mercoxit",    "m3": 40.0},
    }
    try:
        from pricer import get_prices_bulk
        mineral_ids = list(MINERALS.values())
        ore_ids     = list(ORES.keys())
        prices = get_prices_bulk(mineral_ids + ore_ids)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    minerals_out = {}
    for name, tid in MINERALS.items():
        entry = prices.get(tid, {})
        minerals_out[name] = {
            "type_id": tid,
            "sell":    entry.get("sell", 0),
            "buy":     entry.get("buy", 0),
        }

    ores_out = {}
    ore_prev = _load_ore_price_prev()
    for tid, meta in ORES.items():
        entry  = prices.get(tid, {})
        sell   = entry.get("sell", 0)
        buy    = entry.get("buy", 0)
        m3     = meta["m3"]
        name   = meta["name"]
        prev   = ore_prev.get(name, sell)
        diff_pct = ((sell - prev) / prev * 100) if prev else 0
        if diff_pct > 0.5:
            trend = "up"
        elif diff_pct < -0.5:
            trend = "down"
        else:
            trend = "flat"
        ores_out[name] = {
            "type_id":    tid,
            "sell":       sell,
            "buy":        buy,
            "isk_per_m3": round(sell / m3, 2) if sell and m3 else 0,
            "buy_per_m3": round(buy  / m3, 2) if buy  and m3 else 0,
            "m3":         m3,
            "trend":      trend,
            "trend_pct":  round(diff_pct, 2),
        }

    # Persist current prices for next fetch comparison (survives server restarts)
    _save_ore_price_prev({name: ores_out[name]["sell"] for name in ores_out})

    return jsonify({"minerals": minerals_out, "ores": ores_out})


# Maps SDE invCategories.categoryName → frontend TYPE_FILTERS chip labels
_CATEGORY_MAP = {
    "Ship":                    "Ships",
    "Module":                  "Modules",
    "Charge":                  "Charges",
    "Drone":                   "Drones",
    "Fighter":                 "Drones",        # fighters shown under Drones
    "Implant":                 "Implants",
    "Booster":                 "Booster",
    "Subsystem":               "Modules",
    "Structure":               "Structures",
    "Structure Module":        "Structures",
    "Starbase":                "Structures",
    "Deployable":              "Structures",
    "Sovereignty Structures":  "Structures",
    "Infrastructure Upgrades": "Structures",
    "Commodity":               "Components",
    "Material":                "Components",
    "Asteroid":                "Components",
    "Celestial":               "Components",
    "Orbitals":                "Components",
    "Special Edition Assets":  "Other",
    # pass-through for already-correct labels (hardcoded fallback BPs)
    "Ships":       "Ships",
    "Modules":     "Modules",
    "Charges":     "Charges",
    "Drones":      "Drones",
    "Rigs":        "Rigs",
    "Structures":  "Structures",
    "Components":  "Components",
    "Implants":    "Implants",
    "Other":       "Other",
}

def _normalize_category(raw: str) -> str:
    """Normalise SDE category name → frontend TYPE_FILTERS chip label."""
    return _CATEGORY_MAP.get(raw, "Other")


@app.route("/api/calculator", methods=["GET"])
def api_calculator():
    """
    Return full manufacturing data for the calculator page.
    Accepts optional query params:
      system    - system name or ID to use for SCI lookup
      facility  - facility type: 'station', 'medium', 'large', 'xl' (structure size)
      sell_loc  - sell location: 'jita', 'amarr', 'dodixie', 'rens', 'hek'
      buy_loc   - buy location: same options
    """
    from flask import request as flask_request
    try:
        from pricer import get_prices_bulk

        # ── Parse query params ────────────────────────────────────────────────
        system_param   = flask_request.args.get("system", "").strip()
        facility_param = flask_request.args.get("facility", "station").strip().lower()
        sell_loc       = flask_request.args.get("sell_loc", "jita").strip().lower()
        buy_loc        = flask_request.args.get("buy_loc",  "jita").strip().lower()

        # ── Return from cache if fresh ────────────────────────────────────────
        cache_key = _calc_cache_key(system_param, facility_param)
        if _calc_is_fresh(cache_key):
            return jsonify(_calc_cache[cache_key])

        # ── Resolve SCI for the requested system ──────────────────────────────
        sci = _resolve_sci(system_param)

        # ── Resolve structure bonuses ─────────────────────────────────────────
        facility_cfg = _facility_config(facility_param)

        # ── Gather all type IDs needed ────────────────────────────────────────
        _all_blueprints = load_blueprints()
        total_bps    = len(_all_blueprints)

        # ── Merge ESI ME/TE levels so researched BPs use actual levels ────────
        # ESI blueprint type_id is the BLUEPRINT item (e.g. "Raven Blueprint"),
        # crest.db blueprint_id matches this — build a lookup by blueprint_id.
        esi_me_te: dict = {}   # blueprint_id → {me_level, te_level, bp_type}
        try:
            from characters import get_all_auth_headers, load_characters as _lc
            _char_records = _lc()
            _auth_headers = get_all_auth_headers()
            for _cid, _headers in _auth_headers:
                try:
                    _r = requests.get(
                        f"https://esi.evetech.net/latest/characters/{_cid}/blueprints/",
                        headers=_headers, params={"include_completed": False}, timeout=15
                    )
                    if not _r.ok:
                        continue
                    for _bp in _r.json():
                        _tid = _bp["type_id"]        # blueprint type_id (the BP item itself)
                        _me  = _bp.get("material_efficiency", 0)
                        _te  = _bp.get("time_efficiency", 0)
                        _runs = _bp.get("runs", -1)
                        _bpt = "BPO" if _runs == -1 else "BPC"
                        # Keep highest ME/TE if character has duplicates
                        existing = esi_me_te.get(_tid)
                        if not existing or _me > existing["me_level"]:
                            esi_me_te[_tid] = {
                                "me_level": _me,
                                "te_level": _te,
                                "bp_type":  _bpt,
                            }
                except Exception:
                    pass
        except Exception:
            pass

        # Apply ESI ME/TE to blueprints: blueprint_id in crest.db = ESI type_id of the BP
        for bp in _all_blueprints:
            _esi = esi_me_te.get(bp.get("blueprint_id"))
            if _esi:
                bp["me_level"] = _esi["me_level"]
                bp["te_level"] = _esi["te_level"]
                bp["bp_type"]  = _esi["bp_type"]

        all_type_ids = set()
        output_ids   = set()
        for bp in _all_blueprints:
            output_ids.add(bp["output_id"])
            all_type_ids.add(bp["output_id"])
            for mat in bp["materials"]:
                all_type_ids.add(mat["type_id"])
        all_type_ids.update(MINERALS.values())

        _broadcast_progress(cache_key, {"stage": "prices", "msg": "Fetching Jita market data…", "done": 0, "total": total_bps})

        # Only fetch volume history for outputs — skips thousands of material IDs
        prices = get_prices_bulk(list(all_type_ids), history_ids=list(output_ids))

        # ── Build results ──────────────────────────────────────────────────────
        mineral_names = {v: k for k, v in MINERALS.items()}
        results = []
        done = 0
        for bp in _all_blueprints:
            from calculator import calculate_profit, CONFIG
            # Build a per-request config override
            cfg_override = {
                **CONFIG,
                "system_cost_index":          sci,
                "structure_me_bonus":         facility_cfg["me_bonus"],
                "job_cost_structure_discount": facility_cfg["job_discount"],
                "sales_tax":                  facility_cfg["sales_tax"],
            }
            result = calculate_profit(bp, prices, config_override=cfg_override)
            done += 1

            # Broadcast progress every 50 items
            if done % 50 == 0 or done == total_bps:
                _broadcast_progress(cache_key, {
                    "stage": "calc",
                    "msg":   bp["name"],
                    "done":  done,
                    "total": total_bps,
                })

            if not result:
                continue

            # Resolve material names — use the name already loaded from crest.db,
            # fall back to mineral_names dict, then a "Type N" placeholder
            for mat in result.get("material_breakdown", []):
                if not mat.get("name"):
                    mat["name"] = mineral_names.get(mat["type_id"], f"Type {mat['type_id']}")

            # Add blueprint metadata
            result["me_level"]       = bp.get("me_level", 0)
            result["te_level"]       = bp.get("te_level", 0)
            result["category"]       = _normalize_category(bp.get("category", "Other"))
            result["tech"]           = bp.get("tech", "I")
            result["size"]           = bp.get("size", "U")
            result["bp_type"]        = bp.get("bp_type", "BPO")
            result["duration"]       = result.get("time_seconds") or bp.get("time_seconds", 0)
            result["volume"]         = bp.get("volume", 0)
            result["required_skills"] = bp.get("required_skills", [])
            result["blueprint_id"]   = bp.get("blueprint_id")   # type_id of the BP itself
            # Derived metrics
            cost       = result.get("material_cost", 0) + result.get("job_cost", 0) + result.get("sales_tax", 0) + result.get("broker_fee", 0)
            profit     = result.get("net_profit", 0)
            time_s     = result.get("time_seconds") or bp.get("time_seconds", 0)
            duration_h = time_s / 3600.0 if time_s else 0
            result["roi"]          = (profit / cost * 100) if cost > 0 else 0
            result["isk_per_hour"] = (profit / duration_h) if duration_h > 0 else None
            result["isk_per_m3"]   = (profit / result["volume"]) if result.get("volume", 0) > 0 else 0

            # Annotate which facility/system was used
            result["resolved_sci"]      = sci
            result["facility_label"]    = facility_cfg["label"]

            results.append(result)

        results.sort(key=lambda x: x["net_profit"], reverse=True)

        # Deduplicate by output_id — keep the highest-profit entry per product
        seen_output_ids = set()
        deduped = []
        for r in results:
            oid = r.get("output_id")
            if oid in seen_output_ids:
                continue
            seen_output_ids.add(oid)
            deduped.append(r)

        payload = {
            "results":      deduped,
            "generated_at": int(time.time()),
            "sci":          sci,
            "facility":     facility_cfg,
        }
        _calc_cache[cache_key] = payload
        # Signal done to all SSE subscribers
        _broadcast_progress(cache_key, {"stage": "done", "msg": "Ready", "done": total_bps, "total": total_bps})
        return jsonify(payload)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/calculator/progress", methods=["GET"])
def api_calculator_progress():
    """
    SSE endpoint — streams progress events while /api/calculator is computing.
    Query params must match those sent to /api/calculator (system, facility).
    Client connects before or during the calculation; events arrive in real time.
    """
    from flask import request as freq
    system_param   = freq.args.get("system",   "").strip()
    facility_param = freq.args.get("facility", "station").strip().lower()
    cache_key = _calc_cache_key(system_param, facility_param)

    # If already cached, immediately send a "done" event and close
    if _calc_is_fresh(cache_key):
        def instant():
            yield f"data: {json.dumps({'stage':'done','msg':'Ready','done':1,'total':1})}\n\n"
        return Response(stream_with_context(instant()), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    q = _subscribe_progress(cache_key)

    def generate():
        try:
            while True:
                try:
                    msg = q.get(timeout=60)
                    yield f"data: {json.dumps(msg)}\n\n"
                    if msg.get("stage") == "done":
                        break
                except _queue.Empty:
                    # keepalive ping so the connection doesn't time out
                    yield ": ping\n\n"
        finally:
            _unsubscribe_progress(cache_key, q)

    return Response(stream_with_context(generate()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── System Cost Index lookup ───────────────────────────────────────────────────
_SCI_CACHE: dict = {}        # system_id_str → cost_index float
_SCI_NAME_CACHE: dict = {}   # lowercase_name → system_id_str
_SCI_CACHE_TS: float = 0
_SCI_TTL = 3600  # 1 hour

# Well-known systems we always want names for (avoids bulk name fetch on cold start)
_KNOWN_SYSTEMS = {
    "30000142": "Jita",
    "30000160": "Korsiki",
    "30000144": "Perimeter",
    "30002187": "Amarr",
    "30002659": "Dodixie",
    "30002510": "Rens",
    "30002053": "Hek",
    "30000049": "Camal",
    "30000148": "Maurasi",
    "30000163": "Uedama",
    "30000206": "Sivala",
    "30002704": "Bourynes",
    "30002646": "Adahum",
}

def _refresh_sci_cache():
    """Fetch ESI industry/systems and rebuild both caches."""
    global _SCI_CACHE, _SCI_NAME_CACHE, _SCI_CACHE_TS
    try:
        resp = requests.get(
            "https://esi.evetech.net/latest/industry/systems/",
            timeout=15
        )
        if not resp.ok:
            return
        data = resp.json()
        new_sci: dict = {}
        for entry in data:
            sid = str(entry.get("solar_system_id", ""))
            for cost in entry.get("cost_indices", []):
                if cost.get("activity") == "manufacturing":
                    new_sci[sid] = cost.get("cost_index", 0.0)
                    break
        _SCI_CACHE = new_sci

        # Build name → id map from known systems + bulk ESI names for all IDs
        name_map: dict = {}
        # Seed with hardcoded known names first (instant, no API call)
        for sid, name in _KNOWN_SYSTEMS.items():
            name_map[name.lower()] = sid

        # Fetch names for all system IDs in batches of 1000
        all_ids = [int(sid) for sid in new_sci.keys() if sid.isdigit()]
        batch_size = 1000
        for i in range(0, min(len(all_ids), 5000), batch_size):  # cap at 5k to stay fast
            batch = all_ids[i:i + batch_size]
            try:
                nr = requests.post(
                    "https://esi.evetech.net/latest/universe/names/",
                    json=batch,
                    timeout=10
                )
                if nr.ok:
                    for item in nr.json():
                        if item.get("category") == "solar_system":
                            name_map[item["name"].lower()] = str(item["id"])
            except Exception:
                pass

        _SCI_NAME_CACHE = name_map
        _SCI_CACHE_TS = time.time()
        print(f"  SCI cache refreshed: {len(_SCI_CACHE)} systems, {len(_SCI_NAME_CACHE)} names")
    except Exception as e:
        print(f"  SCI cache refresh failed: {e}")


def _ensure_sci_cache():
    """Refresh the SCI cache if stale or empty."""
    if not _SCI_CACHE or (time.time() - _SCI_CACHE_TS) > _SCI_TTL:
        _refresh_sci_cache()


def _name_to_system_id(name: str) -> str | None:
    """Resolve a system name (case-insensitive) to its system_id string."""
    _ensure_sci_cache()
    return _SCI_NAME_CACHE.get(name.strip().lower())


def _resolve_sci(system_name_or_id: str) -> float:
    """
    Look up the manufacturing SCI for a solar system.
    Falls back to the CONFIG default if not found.
    """
    from calculator import CONFIG as CALC_CONFIG
    default_sci = CALC_CONFIG["system_cost_index"]

    if not system_name_or_id:
        return default_sci

    _ensure_sci_cache()

    # Lookup by numeric ID
    if system_name_or_id.isdigit():
        return _SCI_CACHE.get(system_name_or_id, default_sci)

    # Lookup by name
    sid = _name_to_system_id(system_name_or_id)
    if sid:
        return _SCI_CACHE.get(sid, default_sci)

    return default_sci


# ── Facility configuration ─────────────────────────────────────────────────────
_FACILITY_PRESETS = {
    "station":  {"label": "NPC Station",          "me_bonus": 0.00, "job_discount": 0.00, "sales_tax": 0.036},
    "medium":   {"label": "Medium Eng. Complex",  "me_bonus": 0.01, "job_discount": 0.03, "sales_tax": 0.036},
    "large":    {"label": "Large Eng. Complex",   "me_bonus": 0.01, "job_discount": 0.04, "sales_tax": 0.036},
    "xl":       {"label": "XL Eng. Complex",      "me_bonus": 0.01, "job_discount": 0.05, "sales_tax": 0.036},
    "raitaru":  {"label": "Raitaru",              "me_bonus": 0.01, "job_discount": 0.03, "sales_tax": 0.036},
    "azbel":    {"label": "Azbel",                "me_bonus": 0.01, "job_discount": 0.04, "sales_tax": 0.036},
    "sotiyo":   {"label": "Sotiyo",               "me_bonus": 0.01, "job_discount": 0.05, "sales_tax": 0.036},
}

def _facility_config(key: str) -> dict:
    return _FACILITY_PRESETS.get(key, _FACILITY_PRESETS["station"])


@app.route("/api/systems/search", methods=["GET"])
def api_systems_search():
    """
    Search for solar systems by name prefix and return SCI for each.
    Query param: q=<search string>
    """
    from flask import request as freq
    q = freq.args.get("q", "").strip()
    if not q or len(q) < 2:
        return jsonify([])

    try:
        _ensure_sci_cache()

        # Search the local name cache for prefix matches (case-insensitive)
        q_lower = q.lower()
        matches = [
            (name, sid)
            for name, sid in _SCI_NAME_CACHE.items()
            if q_lower in name
        ]
        # Sort: exact-start matches first, then alphabetically, cap at 10
        matches.sort(key=lambda x: (not x[0].startswith(q_lower), x[0]))
        matches = matches[:10]

        results = []
        for name, sid in matches:
            # Capitalise the stored lowercase name back using the known map if possible
            display = _KNOWN_SYSTEMS.get(sid, name.title())
            sci = _SCI_CACHE.get(sid)
            results.append({"id": int(sid), "name": display, "sci": sci})
        return jsonify(results)

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/sci", methods=["GET"])
def api_sci():
    """
    GET /api/sci?system_name=Korsiki
    Returns { system_name, system_id, cost_index, cached_at } for the given system.
    Returns 404 { error: "System not found" } if the name doesn't match.
    """
    from flask import request as freq
    system_name = freq.args.get("system_name", "").strip()
    if not system_name:
        return jsonify({"error": "system_name is required"}), 400

    try:
        _ensure_sci_cache()

        sid = _name_to_system_id(system_name)
        if not sid:
            return jsonify({"error": "System not found"}), 404

        sci = _SCI_CACHE.get(sid)
        if sci is None:
            return jsonify({"error": "System not found"}), 404

        return jsonify({
            "system_name": system_name,
            "system_id":   int(sid),
            "cost_index":  sci,
            "cached_at":   _SCI_CACHE_TS,
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


_SCI_SUGGESTIONS = [
    {"name": "Jita",      "system_id": 30000142, "region": "The Forge"},
    {"name": "Korsiki",   "system_id": 30000160, "region": "The Forge"},
    {"name": "Perimeter", "system_id": 30000144, "region": "The Forge"},
    {"name": "Amarr",     "system_id": 30002187, "region": "Domain"},
    {"name": "Dodixie",   "system_id": 30002659, "region": "Sinq Laison"},
    {"name": "Rens",      "system_id": 30002510, "region": "Heimatar"},
    {"name": "Hek",       "system_id": 30002053, "region": "Metropolis"},
]

@app.route("/api/sci/suggestions", methods=["GET"])
def api_sci_suggestions():
    """
    GET /api/sci/suggestions
    Returns the curated list of recommended manufacturing systems with live SCI values.
    """
    try:
        _ensure_sci_cache()

        results = []
        for sys in _SCI_SUGGESTIONS:
            sci = _SCI_CACHE.get(str(sys["system_id"]))
            results.append({
                "name":       sys["name"],
                "system_id":  sys["system_id"],
                "region":     sys["region"],
                "cost_index": sci,
            })
        return jsonify(results)

    except Exception as e:
        return jsonify({"error": str(e)}), 500



@app.route("/api/skills", methods=["GET"])
def api_skills():
    """
    Return ALL character skill levels keyed by skill name from ESI.
    Uses the invTypes name lookup from crest.db to resolve skill_id → name.
    Requires a valid ESI token.
    """
    try:
        from auth import get_auth_header
        from assets import CHARACTER_ID
        import sqlite3 as _sq

        headers = get_auth_header()
        resp = requests.get(
            f"https://esi.evetech.net/latest/characters/{CHARACTER_ID}/skills/",
            headers=headers,
            timeout=10
        )
        resp.raise_for_status()
        data = resp.json()

        # Build a skill_id → active_level map from ESI response
        skill_map = {s["skill_id"]: s["active_skill_level"] for s in data.get("skills", [])}

        # Resolve type names from crest.db blueprint_skills (covers every skill
        # that any blueprint actually requires — fast and complete)
        crest_path = os.path.join(os.path.dirname(__file__), "crest.db")
        skill_names: dict[int, str] = {}
        if os.path.exists(crest_path):
            try:
                conn = _sq.connect(crest_path)
                # Fuzzwork CSV download also put names in invTypes-equivalent data;
                # we don't have that table, but we can derive skill_id from the ESI
                # universe types if needed. For now resolve from blueprint_skills
                # distinct names — but we need the type_id to look up levels.
                # Better: use the Fuzzwork invTypes data we fetched earlier to seed
                # a skill_id → name map. We'll build it from the ESI skill list
                # and a reverse lookup from blueprint_skills names.
                conn.close()
            except Exception:
                pass

        # The cleanest approach: return all skills by type_id AND resolve names
        # via ESI universe/types in batch. But for now, use the skill_id directly
        # by querying ESI's universe/categories/16 skill names.
        # Fastest no-extra-request approach: resolve the skill IDs present in
        # blueprint_skills by fetching invTypes data we already have in crest.db.
        # Since we don't store invTypes, use Fuzzwork's static skill name list.
        # We cache it in memory after first load.
        global _skill_id_names
        if not _skill_id_names:
            try:
                import bz2 as _bz2, urllib.request as _ur
                req = _ur.Request(
                    "https://www.fuzzwork.co.uk/dump/latest/invTypes.csv.bz2",
                    headers={"User-Agent": "CREST-Server/1.0"}
                )
                with _ur.urlopen(req, timeout=20) as r:
                    raw = _bz2.decompress(r.read())
                for line in raw.decode("utf-8").splitlines()[1:]:
                    parts = line.split(",")
                    try:
                        _skill_id_names[int(parts[0])] = parts[2]
                    except (ValueError, IndexError):
                        pass
            except Exception:
                pass  # Network unavailable — skills will still work for known skills

        # Build result: { skill_name: level } for all skills the character has
        result = {}
        for skill_id, level in skill_map.items():
            name = _skill_id_names.get(skill_id)
            if name:
                result[name] = level

        return jsonify({
            "skills": result,
            "total_sp": data.get("total_sp", 0),
        })

    except Exception as e:
        return jsonify({"error": str(e), "skills": {}}), 200  # 200 so UI can still render


@app.route("/api/blueprints/bp_finder", methods=["GET"])
def api_blueprints_bp_finder():
    """
    Return profitable items that have NO personal or corp blueprint, sorted by net_profit desc.
    Also includes blueprint_id (the BP's own type_id) for contract searches.

    Query params:
        system   - system name for calculator (default: Korsiki)
        facility - facility type (default: large)
        sell_loc - sell location hub (default: jita)
        buy_loc  - buy location hub (default: jita)
        limit    - max rows to return (default: 50)

    Response: { items: [{output_id, blueprint_id, name, net_profit, roi, category, tech, ...}] }
    """
    try:
        import sqlite3 as _sq

        from flask import request as _freq
        system   = _freq.args.get("system",   "Korsiki")
        facility = _freq.args.get("facility", "large")
        sell_loc = _freq.args.get("sell_loc", "jita")
        buy_loc  = _freq.args.get("buy_loc",  "jita")
        limit    = int(_freq.args.get("limit", 50))

        # --- Get calc results (reuse cache if fresh, else use any cached key) ---
        cache_key = _calc_cache_key(system, facility)

        if not _calc_is_fresh(cache_key):
            # Try to find ANY fresh cache entry (user may have loaded with different params)
            fresh_key = next(
                (k for k, v in _calc_cache.items()
                 if (time.time() - v.get("generated_at", 0)) < CALC_CACHE_TTL),
                None
            )
            if fresh_key:
                cache_key = fresh_key
            else:
                # No cache at all — ask the user to open the Calculator tab first
                return jsonify({
                    "items": [],
                    "count": 0,
                    "not_ready": True,
                    "message": "Open the Calculator tab first to load market prices, then try again.",
                })

        calc_results = _calc_cache[cache_key]["results"]

        # --- Load corp BP set from crest.db ---
        cdb = _sq.connect(os.path.join(os.path.dirname(__file__), "crest.db"))
        bp_rows = cdb.execute("SELECT output_id, blueprint_id FROM blueprints").fetchall()
        cdb.close()
        corp_output_ids  = {r[0] for r in bp_rows}
        output_to_bpid   = {r[0]: r[1] for r in bp_rows}   # output_id → blueprint_id

        # --- Load personal ESI BPs ---
        personal_output_ids = set()
        try:
            from characters import get_all_auth_headers
            import requests as _ureq
            for cid, headers in get_all_auth_headers():
                resp = _ureq.get(
                    f"https://esi.evetech.net/latest/characters/{cid}/blueprints/",
                    headers=headers, timeout=10
                )
                if resp.ok:
                    for bp in resp.json():
                        personal_output_ids.add(bp.get("type_id"))
        except Exception:
            pass

        # --- Filter: keep only items with no personal BP and not in corp library ---
        items = []
        for r in calc_results:
            oid = r.get("output_id")
            if oid in corp_output_ids:
                continue
            if oid in personal_output_ids:
                continue
            blueprint_id = output_to_bpid.get(oid)  # may be None if not in crest.db at all
            items.append({
                "output_id":    oid,
                "blueprint_id": blueprint_id,
                "name":         r.get("name", ""),
                "net_profit":   r.get("net_profit", 0),
                "roi":          r.get("roi", 0),
                "isk_per_hour": r.get("isk_per_hour", 0),
                "material_cost": r.get("material_cost", 0),
                "gross_revenue": r.get("gross_revenue", 0),
                "avg_daily_volume": r.get("avg_daily_volume", 0),
                "category":     r.get("category", ""),
                "tech":         r.get("tech", "I"),
                "size":         r.get("size", "U"),
                "duration":     r.get("duration", 0),
            })
            if len(items) >= limit:
                break

        return jsonify({"items": items, "count": len(items)})

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e), "items": []}), 200


@app.route("/api/bpo_market_scan", methods=["GET"])
def api_bpo_market_scan():
    """
    Scan ESI public contracts in a region for BPOs that match profitable unowned items.

    Query params:
        region_id - ESI region ID (default: 10000002 = The Forge)
        system    - calculator system (default: Korsiki)
        facility  - calculator facility (default: large)
        max_pages - max contract pages to fetch (default: 5, each page = 1000 contracts)

    Response:
        { results: [{name, blueprint_id, output_id, contract_id, price, me, te,
                     net_profit, roi, isk_per_hour, issuer_id, location_id, expires}],
          pages_scanned, contracts_checked, matched }
    """
    try:
        import sqlite3 as _sq
        from flask import request as _freq
        from concurrent.futures import ThreadPoolExecutor, as_completed

        region_id  = int(_freq.args.get("region_id", 10000002))
        system     = _freq.args.get("system",   "Korsiki")
        facility   = _freq.args.get("facility", "large")
        max_pages  = min(int(_freq.args.get("max_pages", 20)), 40)

        # ── 1. Get calc results from cache ─────────────────────────────────────
        cache_key = _calc_cache_key(system, facility)
        if not _calc_is_fresh(cache_key):
            fresh_key = next(
                (k for k, v in _calc_cache.items()
                 if (time.time() - v.get("generated_at", 0)) < CALC_CACHE_TTL),
                None
            )
            if fresh_key:
                cache_key = fresh_key
            else:
                return jsonify({
                    "results": [], "not_ready": True,
                    "message": "Open the Calculator tab first to load market prices, then scan.",
                })
        calc_results = _calc_cache[cache_key]["results"]

        # ── 2. Build wanted_bp_ids from calc results directly ─────────────────
        #    Calc results already contain blueprint_id. We scan for ALL profitable
        #    items (not just unowned) so the user sees what's available to buy.
        #    Optionally load owned BP sets to flag duplicates in the response.
        import requests as _esi

        # Personal ESI BPs (for flagging already-owned in results)
        personal_bp_ids = set()
        corp_bp_ids = set(CORP_BPO_TYPE_IDS)  # start with static fallback
        try:
            from characters import get_all_auth_headers
            import requests as _ureq2
            seen_corp_ids_scan = set()
            for cid, headers in get_all_auth_headers():
                # Personal BPs
                resp_p = _ureq2.get(
                    f"https://esi.evetech.net/latest/characters/{cid}/blueprints/",
                    headers=headers, timeout=10
                )
                if resp_p.ok:
                    for bp in resp_p.json():
                        personal_bp_ids.add(bp.get("type_id"))
                # Corp BPs via ESI (may fail with 403 if insufficient role)
                try:
                    corp_resp = _ureq2.get(
                        f"https://esi.evetech.net/latest/characters/{cid}/",
                        headers=headers, timeout=8
                    )
                    if corp_resp.ok:
                        corp_id = corp_resp.json().get("corporation_id")
                        if corp_id and corp_id not in seen_corp_ids_scan:
                            seen_corp_ids_scan.add(corp_id)
                            page = 1
                            while True:
                                cr = _ureq2.get(
                                    f"https://esi.evetech.net/latest/corporations/{corp_id}/blueprints/",
                                    headers=headers,
                                    params={"page": page},
                                    timeout=15
                                )
                                if not cr.ok:
                                    break  # static fallback already loaded above
                                page_bps = cr.json()
                                if not page_bps:
                                    break
                                for bp in page_bps:
                                    corp_bp_ids.add(bp.get("type_id"))
                                if len(page_bps) < 1000:
                                    break
                                page += 1
                except Exception:
                    pass
        except Exception:
            pass

        # Build: blueprint_id → calc row, for all profitable items
        bpid_to_calc = {}
        for r in calc_results:
            bpid = r.get("blueprint_id")
            if bpid:
                bpid_to_calc[bpid] = r

        wanted_bp_ids = set(bpid_to_calc.keys())

        if not wanted_bp_ids:
            return jsonify({"results": [], "matched": 0, "pages_scanned": 0,
                            "contracts_checked": 0,
                            "message": "No calc data found — open the Calculator tab first."})

        # ── 3. Fetch ESI public contracts (paginated, concurrent) ─────────────
        import requests as _esi
        ESI_BASE = "https://esi.evetech.net/latest"
        session = _esi.Session()

        def fetch_page(page):
            try:
                r = session.get(
                    f"{ESI_BASE}/contracts/public/{region_id}/",
                    params={"page": page},
                    timeout=12,
                )
                if r.status_code == 404:   # page beyond X-Pages
                    return []
                r.raise_for_status()
                return r.json()
            except Exception:
                return []

        # First page to get total page count
        first_resp = session.get(
            f"{ESI_BASE}/contracts/public/{region_id}/",
            params={"page": 1}, timeout=12
        )
        first_resp.raise_for_status()
        total_pages = min(int(first_resp.headers.get("X-Pages", 1)), max_pages)
        all_contracts = [c for c in first_resp.json() if c.get("type") == "item_exchange"]

        # Fetch remaining pages concurrently
        if total_pages > 1:
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = {pool.submit(fetch_page, p): p for p in range(2, total_pages + 1)}
                for fut in as_completed(futures):
                    page_data = fut.result()
                    all_contracts.extend(
                        c for c in page_data if c.get("type") == "item_exchange"
                    )

        contracts_checked = len(all_contracts)

        # ── 4. Fetch items for each contract and match blueprint_ids ──────────
        matched_contracts = {}   # contract_id → {contract, type_id, me, te}

        def fetch_items(contract):
            cid = contract["contract_id"]
            try:
                r = session.get(
                    f"{ESI_BASE}/contracts/public/items/{cid}/",
                    timeout=10
                )
                if not r.ok:
                    return None
                items = r.json()
                for item in items:
                    tid = item.get("type_id")
                    if tid in wanted_bp_ids and item.get("is_included", True):
                        is_bpc = item.get("is_blueprint_copy", False)
                        return {
                            "contract":    contract,
                            "type_id":     tid,
                            "me":          item.get("material_efficiency", 0),
                            "te":          item.get("time_efficiency", 0),
                            "quantity":    item.get("quantity", 1),
                            "is_bpc":      is_bpc,
                        }
            except Exception:
                pass
            return None

        # Only fetch items for contracts that look like they could contain BPs.
        # Volume filter is intentionally generous — multi-item contracts can report
        # higher volumes, and we deduplicate by cheapest price after matching anyway.
        bp_candidate_contracts = [
            c for c in all_contracts
            if c.get("volume", 999) <= 1000   # BPs are tiny but contracts can bundle items
        ]

        results = []
        with ThreadPoolExecutor(max_workers=12) as pool:
            futures = [pool.submit(fetch_items, c) for c in bp_candidate_contracts]
            for fut in as_completed(futures):
                match = fut.result()
                if match is None:
                    continue
                contract  = match["contract"]
                bpid      = match["type_id"]
                calc_row  = bpid_to_calc.get(bpid, {})
                oid       = calc_row.get("output_id")

                results.append({
                    "blueprint_id":  bpid,
                    "output_id":     oid,
                    "name":          calc_row.get("name", "?"),
                    "me":            match["me"],
                    "te":            match["te"],
                    "is_bpc":        match.get("is_bpc", False),
                    "contract_id":   contract["contract_id"],
                    "price":         contract.get("price", 0),
                    "location_id":   contract.get("start_location_id"),
                    "issuer_id":     contract.get("issuer_id"),
                    "expires":       contract.get("date_expired", ""),
                    "already_owned": bpid in corp_bp_ids or bpid in personal_bp_ids,
                    # Calc stats
                    "net_profit":    calc_row.get("net_profit", 0),
                    "roi":           calc_row.get("roi", 0),
                    "isk_per_hour":  calc_row.get("isk_per_hour", 0),
                    "material_cost": calc_row.get("material_cost", 0),
                    "gross_revenue": calc_row.get("gross_revenue", 0),
                    "category":      calc_row.get("category", ""),
                    "tech":          calc_row.get("tech", ""),
                })

        # Deduplicate by blueprint_id — keep only the cheapest contract per BP
        # Also track how many listings were found per BP for debugging
        all_by_bpid = {}
        for r in results:
            bpid = r["blueprint_id"]
            if bpid not in all_by_bpid:
                all_by_bpid[bpid] = []
            all_by_bpid[bpid].append(r)

        cheapest = {}
        for bpid, entries in all_by_bpid.items():
            entries.sort(key=lambda x: x["price"])
            best = entries[0]
            best["listing_count"] = len(entries)
            best["cheapest_price"] = entries[0]["price"]
            if len(entries) > 1:
                print(f"  [dedup] {best['name']}: {len(entries)} listings, prices: {[e['price'] for e in entries]} → keeping {best['price']}")
            cheapest[bpid] = best
        results = list(cheapest.values())

        # Sort by net_profit desc
        results.sort(key=lambda x: x.get("net_profit", 0), reverse=True)

        return jsonify({
            "results":           results,
            "matched":           len(results),
            "pages_scanned":     total_pages,
            "contracts_checked": contracts_checked,
            "bp_candidates":     len(bp_candidate_contracts),
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e), "results": []}), 200


@app.route("/api/ui/open_ingame", methods=["POST"])
def api_ui_open_ingame():
    """
    Ask EVE client to open a window via ESI UI endpoints.
    Body JSON: { type_id: int, window: "market" | "info" }
    Uses the first available authenticated character.
    """
    try:
        from characters import get_all_auth_headers
        import requests as _ureq

        from flask import request as _freq2
        body     = _freq2.get_json(force=True, silent=True) or {}
        type_id  = int(body.get("type_id", 0))
        window   = body.get("window", "market")

        if not type_id:
            return jsonify({"error": "type_id required"}), 400

        auth_headers = get_all_auth_headers()
        if not auth_headers:
            return jsonify({"error": "No authenticated characters"}), 401

        # Use the first character's token
        _, headers = auth_headers[0]

        if window == "market":
            url = f"https://esi.evetech.net/latest/ui/openwindow/marketdetails/?type_id={type_id}"
        else:
            url = f"https://esi.evetech.net/latest/ui/openwindow/information/?target_id={type_id}"

        resp = _ureq.post(url, headers=headers, timeout=10)
        if resp.status_code == 204:
            return jsonify({"ok": True})
        return jsonify({"ok": False, "status": resp.status_code, "detail": resp.text}), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 200


@app.route("/api/blueprints/corp", methods=["GET"])
def api_blueprints_corp():
    """
    Return the set of output_ids for blueprints in the corp stash.
    Uses the static corp_BPOs file (loaded at startup into CORP_BPO_TYPE_IDS).
    Response: { output_ids: [int, ...], count: int }
    """
    try:
        import sqlite3 as _sq
        cdb = _sq.connect(os.path.join(os.path.dirname(__file__), "crest.db"))
        # Get output_id for each blueprint_id in the corp stash
        if CORP_BPO_TYPE_IDS:
            placeholders = ",".join("?" * len(CORP_BPO_TYPE_IDS))
            rows = cdb.execute(
                f"SELECT blueprint_id, output_id, output_name FROM blueprints WHERE blueprint_id IN ({placeholders})",
                list(CORP_BPO_TYPE_IDS)
            ).fetchall()
        else:
            rows = []
        cdb.close()
        return jsonify({
            "output_ids": [r[1] for r in rows],
            "names":      {r[1]: r[2] for r in rows},
            "count":      len(rows),
        })
    except Exception as e:
        return jsonify({"error": str(e), "output_ids": [], "names": {}}), 200


@app.route("/api/blueprints/esi", methods=["GET"])
def api_blueprints_esi():
    """
    Return character AND corporation blueprints from ESI for ALL authenticated characters.
    Returns list of { type_id, name, me_level, te_level, runs, location_id, bp_type,
                       character_id, character_name, owner }
    owner = 'personal' | 'corp'
    """
    try:
        from characters import get_all_auth_headers, load_characters
        import requests as req

        char_records = load_characters()
        auth_headers = get_all_auth_headers()

        all_bps = []
        seen_corp_ids = set()   # avoid duplicate fetches when multiple chars share a corp

        for cid, headers in auth_headers:
            char_name = char_records.get(cid, {}).get("character_name", f"Char {cid}")

            # ── Personal blueprints ──
            try:
                resp = req.get(
                    f"https://esi.evetech.net/latest/characters/{cid}/blueprints/",
                    headers=headers, timeout=15
                )
                if resp.ok:
                    for bp in resp.json():
                        bp["_character_id"]   = cid
                        bp["_character_name"] = char_name
                        bp["_owner"]          = "personal"
                        all_bps.append(bp)
            except Exception as e:
                print(f"  [esi-bps] personal failed for {char_name}: {e}")

            # ── Corp blueprints ──
            try:
                corp_resp = req.get(
                    f"https://esi.evetech.net/latest/characters/{cid}/",
                    headers=headers, timeout=10
                )
                if corp_resp.ok:
                    corp_id = corp_resp.json().get("corporation_id")
                    if corp_id and corp_id not in seen_corp_ids:
                        seen_corp_ids.add(corp_id)
                        esi_corp_ok = False
                        page = 1
                        while True:
                            cr = req.get(
                                f"https://esi.evetech.net/latest/corporations/{corp_id}/blueprints/",
                                headers=headers,
                                params={"page": page},
                                timeout=15
                            )
                            if not cr.ok:
                                break  # fall through to static fallback below
                            esi_corp_ok = True
                            page_bps = cr.json()
                            if not page_bps:
                                break
                            for bp in page_bps:
                                bp["_character_id"]   = cid
                                bp["_character_name"] = char_name
                                bp["_owner"]          = "corp"
                                bp["_corp_id"]        = corp_id
                                all_bps.append(bp)
                            if len(page_bps) < 1000:
                                break
                            page += 1
                        # Static fallback: if ESI corp fetch failed (e.g. 403 no role),
                        # inject corp BPOs from the static corp_BPOs file
                        if not esi_corp_ok and CORP_BPO_TYPE_IDS:
                            print(f"  [esi-bps] ESI corp fetch failed for {char_name} — using static corp_BPOs fallback ({len(CORP_BPO_TYPE_IDS)} BPOs)")
                            for tid in CORP_BPO_TYPE_IDS:
                                all_bps.append({
                                    "type_id":          tid,
                                    "material_efficiency": 10,
                                    "time_efficiency":  20,
                                    "runs":             -1,
                                    "location_id":      None,
                                    "quantity":         1,
                                    "_character_id":    cid,
                                    "_character_name":  char_name,
                                    "_owner":           "corp",
                                    "_corp_id":         corp_id,
                                })
            except Exception as e:
                print(f"  [esi-bps] corp failed for {char_name}: {e}")

        if not all_bps:
            return jsonify({"blueprints": []})

        # Resolve type names
        type_ids = list({bp["type_id"] for bp in all_bps})
        names = {}
        for i in range(0, len(type_ids), 1000):
            chunk = type_ids[i:i+1000]
            names_resp = req.post(
                "https://esi.evetech.net/latest/universe/names/",
                json=chunk, timeout=10
            )
            if names_resp.ok:
                for item in names_resp.json():
                    names[item["id"]] = item["name"]

        result = []
        for bp in all_bps:
            result.append({
                "type_id":        bp["type_id"],
                "name":           names.get(bp["type_id"], f"Type {bp['type_id']}"),
                "me_level":       bp.get("material_efficiency", 0),
                "te_level":       bp.get("time_efficiency", 0),
                "runs":           bp.get("runs", -1),
                "bp_type":        "BPO" if bp.get("runs", -1) == -1 else "BPC",
                "location_id":    bp.get("location_id"),
                "quantity":       bp.get("quantity", 1),
                "character_id":   bp["_character_id"],
                "character_name": bp["_character_name"],
                "owner":          bp["_owner"],
            })

        result.sort(key=lambda x: x["name"])
        return jsonify({"blueprints": result, "count": len(result)})

    except Exception as e:
        return jsonify({"error": str(e), "blueprints": []}), 200


# ── Character Assets ──────────────────────────────────────────────────────────
_ASSETS_CACHE:    dict  = {}
_ASSETS_CACHE_TS: float = 0
_ASSETS_TTL = 300  # 5 minutes

@app.route("/api/assets", methods=["GET"])
def api_assets():
    """
    Return character assets as { type_id: total_quantity } plus name map.
    Response: { assets: {type_id: qty}, names: {type_id: name}, cached_at: ts }
    """
    global _ASSETS_CACHE, _ASSETS_CACHE_TS
    try:
        from flask import request as flask_request
        force = flask_request.args.get("force", "0") == "1"
        if not force and _ASSETS_CACHE and (time.time() - _ASSETS_CACHE_TS) < _ASSETS_TTL:
            return jsonify(_ASSETS_CACHE)

        from auth import get_auth_header
        from assets import CHARACTER_ID
        import requests as req

        headers = get_auth_header()

        all_items = []
        page = 1
        while True:
            resp = req.get(
                f"https://esi.evetech.net/latest/characters/{CHARACTER_ID}/assets/",
                headers=headers, params={"page": page}, timeout=15
            )
            resp.raise_for_status()
            page_items = resp.json()
            if not page_items:
                break
            all_items.extend(page_items)
            if len(page_items) < 1000:
                break
            page += 1

        from collections import defaultdict
        inventory: dict = defaultdict(int)
        for item in all_items:
            inventory[item["type_id"]] += item["quantity"]

        type_ids = list(inventory.keys())
        names: dict = {}

        # Resolve names from crest.db first
        try:
            import sqlite3 as _sql
            conn = _sql.connect("crest.db")
            placeholders = ",".join("?" * len(type_ids))
            rows = conn.execute(
                f"SELECT output_id, output_name FROM blueprints WHERE output_id IN ({placeholders})",
                type_ids
            ).fetchall()
            conn.close()
            for tid, name in rows:
                names[tid] = name
        except Exception:
            pass

        # Remaining via ESI universe/names
        missing_ids = [t for t in type_ids if t not in names]
        if missing_ids:
            try:
                for i in range(0, len(missing_ids), 1000):
                    chunk = missing_ids[i:i+1000]
                    nr = req.post(
                        "https://esi.evetech.net/latest/universe/names/",
                        json=chunk, timeout=10
                    )
                    if nr.ok:
                        for item in nr.json():
                            names[item["id"]] = item["name"]
            except Exception:
                pass

        _ASSETS_CACHE = {
            "assets":    dict(inventory),
            "names":     {str(k): v for k, v in names.items()},
            "cached_at": int(time.time()),
        }
        _ASSETS_CACHE_TS = time.time()
        return jsonify(_ASSETS_CACHE)

    except Exception as e:
        return jsonify({"error": str(e), "assets": {}, "names": {}}), 200


def _build_profit(pid: int, runs: int, sell_price, mat_cost_per_unit: dict) -> dict:
    """Compute material_cost, profit, margin_pct for one job."""
    cpu = mat_cost_per_unit.get(pid)
    mat_cost = round(cpu * runs, 2) if cpu is not None else None
    sell_total = round(sell_price * runs, 2) if sell_price is not None else None
    if mat_cost is not None and sell_total is not None:
        profit = round(sell_total - mat_cost, 2)
        margin_pct = round(profit / sell_total * 100, 1) if sell_total > 0 else None
    else:
        profit = None
        margin_pct = None
    return {"material_cost": mat_cost, "profit": profit, "margin_pct": margin_pct}


# ── Industry Jobs ──────────────────────────────────────────────────────────────
@app.route("/api/industry/jobs", methods=["GET"])
def api_industry_jobs():
    """
    Return active industry jobs for ALL authenticated characters combined,
    sorted by time remaining (soonest first).
    Each job includes character_name and character_id for attribution.
    """
    try:
        from characters import get_all_auth_headers, load_characters
        import requests as req
        from datetime import datetime, timezone

        ACTIVITY_NAMES = {
            1: "Manufacturing",
            3: "TE Research",
            4: "ME Research",
            5: "Copying",
            8: "Invention",
            9: "Reactions",
            11: "Reaction",
        }

        # Load character records for name lookup
        char_records = load_characters()  # cid → record

        # Fetch jobs from every character in parallel (sequential for simplicity)
        auth_headers = get_all_auth_headers()  # list of (cid, header_dict)

        all_jobs = []
        seen_job_ids = set()
        seen_corp_ids_jobs = set()

        for cid, headers in auth_headers:
            char_name = char_records.get(cid, {}).get("character_name", f"Char {cid}")
            try:
                resp = req.get(
                    f"https://esi.evetech.net/latest/characters/{cid}/industry/jobs/",
                    headers=headers,
                    params={"include_completed": False},
                    timeout=15,
                )
                if not resp.ok:
                    continue
                for j in resp.json():
                    jid = j.get("job_id")
                    if jid and jid not in seen_job_ids:
                        seen_job_ids.add(jid)
                        j["_character_id"]   = cid
                        j["_character_name"] = char_name
                        all_jobs.append(j)
            except Exception as e:
                print(f"  [jobs] Failed for {char_name}: {e}")

            # Also try corp jobs endpoint (requires esi-industry.read_corporation_jobs.v1)
            try:
                corp_resp = req.get(
                    f"https://esi.evetech.net/latest/characters/{cid}/",
                    timeout=10,
                )
                corp_id = corp_resp.json().get("corporation_id") if corp_resp.ok else None
                if corp_id and corp_id not in seen_corp_ids_jobs:
                    cresp = req.get(
                        f"https://esi.evetech.net/latest/corporations/{corp_id}/industry/jobs/",
                        headers=headers,
                        params={"include_completed": False},
                        timeout=15,
                    )
                    if cresp.ok:
                        seen_corp_ids_jobs.add(corp_id)  # only mark seen on success
                        our_char_ids = {int(k) for k in char_records.keys()}
                        for j in cresp.json():
                            installer_id = j.get("installer_id")
                            # Only include jobs installed by one of our authenticated characters
                            if installer_id not in our_char_ids:
                                continue
                            jid = j.get("job_id")
                            if jid and jid not in seen_job_ids:
                                seen_job_ids.add(jid)
                                installer_name = char_records.get(installer_id, {}).get("character_name", char_name)
                                j["_character_id"]   = installer_id
                                j["_character_name"] = installer_name
                                all_jobs.append(j)
            except Exception as e:
                print(f"  [jobs] Corp jobs failed for {char_name}: {e}")

        if not all_jobs:
            return jsonify({"jobs": []})

        # Collect all product type_ids for name resolution
        product_ids = list({j.get("product_type_id") for j in all_jobs if j.get("product_type_id")})

        names = {}
        if product_ids:
            try:
                nr = req.post(
                    "https://esi.evetech.net/latest/universe/names/",
                    json=product_ids[:1000],
                    timeout=10,
                )
                if nr.ok:
                    for item in nr.json():
                        names[item["id"]] = item["name"]
            except Exception:
                pass

        # Fetch Jita sell prices for all product types (best sell order = estimated proceeds)
        mfg_activity_ids = {1, 11}  # Manufacturing, Reaction
        mfg_product_ids = list({
            j.get("product_type_id") for j in all_jobs
            if j.get("activity_id") in mfg_activity_ids and j.get("product_type_id")
        })
        market_prices = {}
        if mfg_product_ids:
            try:
                from pricer import get_prices_bulk
                market_prices = get_prices_bulk(mfg_product_ids)
            except Exception:
                pass

        # Look up material costs for MFG products from crest.db
        # material_cost_per_unit[output_id] = ISK cost for 1 run at ME0 (approximate)
        material_cost_per_unit: dict[int, float] = {}
        if mfg_product_ids:
            try:
                import sqlite3 as _sqlite3
                _cdb = _sqlite3.connect(os.path.join(os.path.dirname(__file__), "crest.db"))
                _cdb.row_factory = _sqlite3.Row
                for pid in mfg_product_ids:
                    bp_row = _cdb.execute(
                        "SELECT blueprint_id FROM blueprints WHERE output_id = ? LIMIT 1", (pid,)
                    ).fetchone()
                    if not bp_row:
                        continue
                    mats = _cdb.execute(
                        "SELECT material_type_id, base_quantity FROM blueprint_materials WHERE blueprint_id = ?",
                        (bp_row["blueprint_id"],)
                    ).fetchall()
                    cost = 0.0
                    for mat in mats:
                        mp = market_prices.get(mat["material_type_id"])
                        if mp and mp.get("sell"):
                            cost += mp["sell"] * mat["base_quantity"]
                        else:
                            cost = None
                            break
                    if cost is not None:
                        material_cost_per_unit[pid] = cost
                # Also fetch material prices for any mat type_ids not in market_prices
                # (handles components that weren't in the initial price fetch)
                missing_mat_ids = set()
                for pid in mfg_product_ids:
                    bp_row = _cdb.execute(
                        "SELECT blueprint_id FROM blueprints WHERE output_id = ? LIMIT 1", (pid,)
                    ).fetchone()
                    if bp_row:
                        for mat in _cdb.execute(
                            "SELECT material_type_id FROM blueprint_materials WHERE blueprint_id = ?",
                            (bp_row["blueprint_id"],)
                        ).fetchall():
                            if mat["material_type_id"] not in market_prices:
                                missing_mat_ids.add(mat["material_type_id"])
                if missing_mat_ids:
                    from pricer import get_prices_bulk as _gpb
                    extra = _gpb(list(missing_mat_ids))
                    market_prices.update(extra)
                    # Re-compute costs with full price data
                    material_cost_per_unit.clear()
                    for pid in mfg_product_ids:
                        bp_row = _cdb.execute(
                            "SELECT blueprint_id FROM blueprints WHERE output_id = ? LIMIT 1", (pid,)
                        ).fetchone()
                        if not bp_row:
                            continue
                        mats = _cdb.execute(
                            "SELECT material_type_id, base_quantity FROM blueprint_materials WHERE blueprint_id = ?",
                            (bp_row["blueprint_id"],)
                        ).fetchall()
                        cost = 0.0
                        for mat in mats:
                            mp = market_prices.get(mat["material_type_id"])
                            if mp and mp.get("sell"):
                                cost += mp["sell"] * mat["base_quantity"]
                            else:
                                cost = None
                                break
                        if cost is not None:
                            material_cost_per_unit[pid] = cost
                _cdb.close()
            except Exception as _e:
                print(f"  [jobs] material cost lookup failed: {_e}")

        now_ts = int(time.time())
        result = []
        for j in all_jobs:
            end_str   = j.get("end_date", "")
            start_str = j.get("start_date", "")
            try:
                end_ts = int(datetime.fromisoformat(end_str.replace("Z", "+00:00")).timestamp())
            except Exception:
                end_ts = now_ts

            try:
                start_ts = int(datetime.fromisoformat(start_str.replace("Z", "+00:00")).timestamp())
            except Exception:
                start_ts = end_ts - 86400

            total_secs = max(1, end_ts - start_ts)
            secs_left = max(0, end_ts - now_ts)
            activity_id = j.get("activity_id", 0)
            # For Copying (5), ESI returns no product_type_id — the output is a BPC of the source blueprint
            pid = j.get("product_type_id") or (j.get("blueprint_type_id") if activity_id == 5 else None)
            runs = j.get("runs", 1)
            p = market_prices.get(pid) if pid else None
            sell_price = p["sell"] if p and p.get("sell") else None
            result.append({
                "job_id":            j.get("job_id"),
                "activity":          ACTIVITY_NAMES.get(activity_id, f"Activity {activity_id}"),
                "activity_id":       activity_id,
                "product_type_id":   pid,
                "product_name":      names.get(pid, f"Type {pid}"),
                "runs":              runs,
                "start_date":        start_str,
                "end_date":          end_str,
                "end_ts":            end_ts,
                "total_secs":        total_secs,
                "seconds_remaining": secs_left,
                "status":            j.get("status", ""),
                "installer_id":      j.get("installer_id"),
                "character_id":      j["_character_id"],
                "character_name":    j["_character_name"],
                "sell_price":        sell_price,
                "sell_total":        round(sell_price * runs, 2) if sell_price is not None else None,
                **_build_profit(pid, runs, sell_price, material_cost_per_unit),
            })

        # Sort by soonest completing first
        result.sort(key=lambda x: x["seconds_remaining"])
        return jsonify({"jobs": result, "count": len(result)})

    except Exception as e:
        return jsonify({"error": str(e), "jobs": []}), 200


# ── Character Market Orders ────────────────────────────────────────────────────
@app.route("/api/orders", methods=["GET"])
def api_orders():
    """
    Return active sell and buy orders for ALL characters combined.
    Response: { sell: [...], buy: [...] }
    Each order includes character_name and character_id for attribution.
    """
    try:
        from characters import get_all_auth_headers, load_characters
        import requests as req

        char_records = load_characters()
        auth_headers = get_all_auth_headers()

        all_orders = []
        for cid, headers in auth_headers:
            char_name = char_records.get(cid, {}).get("character_name", f"Char {cid}")
            try:
                resp = req.get(
                    f"https://esi.evetech.net/latest/characters/{cid}/orders/",
                    headers=headers,
                    timeout=15,
                )
                if not resp.ok:
                    continue
                for o in resp.json():
                    o["_character_id"]   = cid
                    o["_character_name"] = char_name
                    all_orders.append(o)
            except Exception as e:
                print(f"  [orders] Failed for {char_name}: {e}")

        if not all_orders:
            return jsonify({"sell": [], "buy": []})

        # Resolve type names
        type_ids = list({o["type_id"] for o in all_orders})
        names = {}
        try:
            nr = req.post(
                "https://esi.evetech.net/latest/universe/names/",
                json=type_ids[:1000],
                timeout=10,
            )
            if nr.ok:
                for item in nr.json():
                    names[item["id"]] = item["name"]
        except Exception:
            pass

        # Resolve region names
        region_ids = list({o.get("region_id") for o in all_orders if o.get("region_id")})
        region_names = {}
        if region_ids:
            try:
                rr = req.post(
                    "https://esi.evetech.net/latest/universe/names/",
                    json=region_ids[:100],
                    timeout=10,
                )
                if rr.ok:
                    for item in rr.json():
                        region_names[item["id"]] = item["name"]
            except Exception:
                pass

        sell, buy = [], []
        for o in all_orders:
            enriched = {
                "order_id":       o.get("order_id"),
                "type_id":        o.get("type_id"),
                "type_name":      names.get(o["type_id"], f"Type {o['type_id']}"),
                "price":          o.get("price", 0),
                "volume_remain":  o.get("volume_remain", 0),
                "volume_total":   o.get("volume_total", 0),
                "range":          o.get("range", ""),
                "is_buy_order":   o.get("is_buy_order", False),
                "issued":         o.get("issued", ""),
                "duration":       o.get("duration", 0),
                "escrow":         o.get("escrow", 0),
                "region_name":    region_names.get(o.get("region_id"), ""),
                "character_id":   o["_character_id"],
                "character_name": o["_character_name"],
            }
            (buy if o.get("is_buy_order") else sell).append(enriched)

        sell.sort(key=lambda x: x["price"] * x["volume_remain"], reverse=True)
        buy.sort(key=lambda x: x["escrow"], reverse=True)

        return jsonify({"sell": sell, "buy": buy})

    except Exception as e:
        return jsonify({"error": str(e), "sell": [], "buy": []}), 200


@app.route("/api/alerts/status", methods=["GET"])
def api_alerts_status():
    """Return the current status of the background alert scanner."""
    return jsonify(_alert_scanner.status)


if __name__ == "__main__":
    # Pre-warm the scan cache in the background so the first dashboard load is instant
    def _prewarm():
        print("  [prewarm] Background scan starting...")
        try:
            with app.app_context():
                client = app.test_client()
                client.get("/api/scan")
                client.get("/api/calculator?system=Korsiki&facility=large")
            print("  [prewarm] Cache ready.")
        except Exception as e:
            print(f"  [prewarm] Failed: {e}")

    threading.Thread(target=_prewarm, daemon=True).start()

    # Periodic wealth snapshot — records wallet balance every 2 hours
    def _wealth_snapshot_loop():
        import time as _time
        # Wait 60s before first run so auth tokens can be ready
        _time.sleep(60)
        while True:
            try:
                balance = _get_wallet()
                if balance and balance > 0:
                    record_wealth_snapshot(balance)
                    print(f"  [snapshot] Wealth recorded: {balance:,.0f} ISK")
            except Exception as e:
                print(f"  [snapshot] Failed: {e}")
            _time.sleep(7200)  # sleep 2 hours between snapshots

    threading.Thread(target=_wealth_snapshot_loop, daemon=True).start()

    # Background alert scanner — Telegram notifications for high-ROI BPs and cheap contracts
    _alert_scanner.start_alert_scanner(_calc_cache, CALC_CACHE_TTL)

    print()
    print("  ╔══════════════════════════════════════════════════╗")
    print("  ║   CREST  ·  API Server  ·  http://localhost:5000  ║")
    print("  ╚══════════════════════════════════════════════════╝")
    print()
    app.run(host="0.0.0.0", port=5001, debug=False, threaded=True)
