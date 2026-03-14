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

app = Flask(__name__)
CORS(app)  # Allow React dev server (localhost:3000 / file://) to call the API

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


# ── Calculator cache (keyed by facility+system params, TTL 5 min) ─────────────
_calc_cache: dict = {}
CALC_CACHE_TTL = 300  # 5 minutes

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
_SCI_CACHE: dict = {}
_SCI_CACHE_TS: float = 0
_SCI_TTL = 3600  # 1 hour

def _resolve_sci(system_name_or_id: str) -> float:
    """
    Look up the manufacturing SCI for a solar system via ESI.
    Falls back to the CONFIG default if ESI is unavailable or system not found.
    """
    from calculator import CONFIG as CALC_CONFIG
    default_sci = CALC_CONFIG["system_cost_index"]

    if not system_name_or_id:
        return default_sci

    global _SCI_CACHE, _SCI_CACHE_TS
    try:
        # Refresh industry systems cache if stale
        if not _SCI_CACHE or (time.time() - _SCI_CACHE_TS) > _SCI_TTL:
            resp = requests.get(
                "https://esi.evetech.net/latest/industry/systems/",
                timeout=10
            )
            if resp.ok:
                data = resp.json()
                _SCI_CACHE = {}
                for entry in data:
                    sid = str(entry.get("solar_system_id", ""))
                    for cost in entry.get("cost_indices", []):
                        if cost.get("activity") == "manufacturing":
                            _SCI_CACHE[sid] = cost.get("cost_index", default_sci)
                            break
                _SCI_CACHE_TS = time.time()

        # Try lookup by ID first
        if system_name_or_id.isdigit():
            return _SCI_CACHE.get(system_name_or_id, default_sci)

        # Try name → ID via ESI search
        search_resp = requests.get(
            "https://esi.evetech.net/latest/search/",
            params={"categories": "solar_system", "search": system_name_or_id, "strict": False},
            timeout=5
        )
        if search_resp.ok:
            ids = search_resp.json().get("solar_system", [])
            if ids:
                return _SCI_CACHE.get(str(ids[0]), default_sci)
    except Exception:
        pass

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
        # Refresh SCI cache if needed
        _resolve_sci("")  # warm the cache

        search_resp = requests.get(
            "https://esi.evetech.net/latest/search/",
            params={"categories": "solar_system", "search": q, "strict": False},
            timeout=5
        )
        if not search_resp.ok:
            return jsonify([])

        ids = search_resp.json().get("solar_system", [])[:10]
        if not ids:
            return jsonify([])

        # Resolve names
        names_resp = requests.post(
            "https://esi.evetech.net/latest/universe/names/",
            json=ids,
            timeout=5
        )
        names = {}
        if names_resp.ok:
            for item in names_resp.json():
                names[str(item["id"])] = item["name"]

        results = []
        for sid in ids:
            name = names.get(str(sid), str(sid))
            sci  = _SCI_CACHE.get(str(sid), None)
            results.append({"id": sid, "name": name, "sci": sci})
        results.sort(key=lambda x: x["name"])
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
                        page = 1
                        while True:
                            cr = req.get(
                                f"https://esi.evetech.net/latest/corporations/{corp_id}/blueprints/",
                                headers=headers,
                                params={"page": page},
                                timeout=15
                            )
                            if not cr.ok:
                                break
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
            11: "Reaction",
        }

        # Load character records for name lookup
        char_records = load_characters()  # cid → record

        # Fetch jobs from every character in parallel (sequential for simplicity)
        auth_headers = get_all_auth_headers()  # list of (cid, header_dict)

        all_jobs = []
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
                    j["_character_id"]   = cid
                    j["_character_name"] = char_name
                    all_jobs.append(j)
            except Exception as e:
                print(f"  [jobs] Failed for {char_name}: {e}")

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
            pid = j.get("product_type_id")
            runs = j.get("runs", 1)
            p = market_prices.get(pid) if pid else None
            sell_price = p["sell"] if p and p.get("sell") else None
            result.append({
                "job_id":            j.get("job_id"),
                "activity":          ACTIVITY_NAMES.get(j.get("activity_id", 0), f"Activity {j.get('activity_id')}"),
                "activity_id":       j.get("activity_id", 0),
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


if __name__ == "__main__":
    # Pre-warm the scan cache in the background so the first dashboard load is instant
    def _prewarm():
        print("  [prewarm] Background scan starting...")
        try:
            with app.app_context():
                from flask import Request
                import werkzeug.test
                client = app.test_client()
                client.get("/api/scan")
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

    print()
    print("  ╔══════════════════════════════════════════════════╗")
    print("  ║   CREST  ·  API Server  ·  http://localhost:5000  ║")
    print("  ╚══════════════════════════════════════════════════╝")
    print()
    app.run(host="0.0.0.0", port=5001, debug=False)
