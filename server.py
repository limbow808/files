"""
server.py - CREST Quart API Server
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

from quart import Quart, jsonify, send_file, send_from_directory, Response, request
from quart_cors import cors
import asyncio
import time
import json
import os
import threading
import requests
import esi_client as _esi

from blueprints import load_blueprints, MINERALS
from calculator import calculate_all
from database import (
    save_scan, record_wallet_snapshot, record_wealth_snapshot, get_wallet_history,
    sync_open_orders, get_sell_history_stats,
    upsert_craft_jobs, get_craft_log, get_craft_stats,
)
import alert_scanner as _alert_scanner
import contracts_cache as _cc

# ── Contract cache background refresher config ────────────────────────────────
_CC_REGION_ID        = 10_000_002   # The Forge / Jita
_CC_REFRESH_INTERVAL = 600          # re-fetch contract headers every 10 min


def _contract_cache_refresher() -> None:
    """
    Daemon: continuously fills contracts_cache.db so that user-facing scans
    become instant SQL queries instead of blocking live ESI calls.

    Uses async aiohttp with 50 concurrent connections for high throughput.
    Processes ~30K contracts in ~5-10 min instead of 35+ min.
    """
    import asyncio
    import aiohttp

    _cc.init_db()
    ESI = "https://esi.evetech.net/latest"

    async def _run():
        connector = aiohttp.TCPConnector(limit=60, ttl_dns_cache=300)
        timeout   = aiohttp.ClientTimeout(total=15, connect=6)
        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            while True:
                try:
                    await _refresh_cycle(session)
                except Exception as e:
                    print(f"  [contract-cache] refresh error: {e}")
                await asyncio.sleep(_CC_REFRESH_INTERVAL)

    async def _esi_get(session, url, params=None, retries=3):
        """GET with retry + 429 backoff."""
        for attempt in range(retries):
            try:
                async with session.get(url, params=params) as resp:
                    if resp.status == 429:
                        wait = float(resp.headers.get("Retry-After", "3") or "3") + 0.5
                        await asyncio.sleep(min(wait, 15))
                        continue
                    if resp.status >= 500:
                        await asyncio.sleep(1 + attempt)
                        continue
                    if resp.status == 200:
                        return await resp.json(content_type=None)
                    return None
            except (asyncio.TimeoutError, aiohttp.ClientError):
                await asyncio.sleep(1 + attempt)
        return None

    async def _refresh_cycle(session):
        # ── 1. Fetch contract header pages (fast, ~50 pages) ──────────────
        try:
            async with session.get(
                f"{ESI}/contracts/public/{_CC_REGION_ID}/",
                params={"page": 1},
            ) as r0:
                if r0.status != 200:
                    print("  [contract-cache] ESI unreachable — sleeping 60 s")
                    await asyncio.sleep(60)
                    return
                total_pages = min(int(r0.headers.get("X-Pages", 1)), 50)
                data0 = await r0.json(content_type=None)
        except (asyncio.TimeoutError, aiohttp.ClientError):
            print("  [contract-cache] ESI unreachable — sleeping 60 s")
            await asyncio.sleep(60)
            return

        all_contracts = list(data0)

        if total_pages > 1:
            pages = await asyncio.gather(*[
                _esi_get(session, f"{ESI}/contracts/public/{_CC_REGION_ID}/",
                         params={"page": p})
                for p in range(2, total_pages + 1)
            ])
            for page_data in pages:
                if page_data:
                    all_contracts.extend(page_data)

        inserted = _cc.upsert_contracts(_CC_REGION_ID, all_contracts)
        print(
            f"  [contract-cache] {len(all_contracts):,} headers fetched, "
            f"{inserted:,} new"
        )

        # ── 2. Fetch items — 50 concurrent requests, bulk DB writes ─────
        sem = asyncio.Semaphore(50)

        _BATCH = 5_000
        while True:
            pending = _cc.get_ids_needing_items(_CC_REGION_ID, limit=_BATCH)
            if not pending:
                break
            total = len(pending)
            t_start = time.time()
            print(f"  [contract-cache] fetching items for {total:,} contracts…")

            # Collect all results in memory first
            batch_results = {}

            async def _fetch_one(cid):
                async with sem:
                    data = await _esi_get(
                        session,
                        f"{ESI}/contracts/public/items/{cid}/",
                        retries=3,
                    )
                batch_results[cid] = data  # None for failures

            await asyncio.gather(*[_fetch_one(cid) for cid in pending])

            # Single bulk write — one lock, one commit
            _cc.store_items_bulk(batch_results, time.time())

            ok_count = sum(1 for v in batch_results.values() if v is not None)
            fail_count = total - ok_count
            elapsed = time.time() - t_start
            rate = total / max(elapsed, 0.1)
            print(
                f"  [contract-cache] batch done in {elapsed:.0f}s "
                f"({rate:.0f}/s  ok={ok_count:,} fail={fail_count:,})"
            )
            if fail_count > ok_count:
                print("  [contract-cache] many failures — pausing 30 s")
                await asyncio.sleep(30)

        # ── 3. Purge expired contracts ────────────────────────────────────
        purged = _cc.purge_expired(_CC_REGION_ID)
        if purged:
            print(f"  [contract-cache] purged {purged:,} expired contracts")

    # Run the async loop in this daemon thread
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(_run())


app = cors(Quart(__name__))  # Allow React dev server (localhost:3000 / file://) to call the API

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

# Dedup guard — prevents duplicate full-compute runs for the same cache key.
# If a thread is already computing key X, new arrivals wait for it instead of
# spawning a parallel compute (which is what maxed the CPU on page load).
_calc_computing:      set            = set()
_calc_computing_lock: threading.Lock = threading.Lock()

# ── Skill name cache (type_id → skill name, loaded once from Fuzzwork CSV) ───
_skill_id_names: dict[int, str] = {}
_SKILL_NAMES_PATH    = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skill_names.json")
_SKILL_NAMES_MAX_AGE = 7 * 86400  # re-download after 7 days

# ── Warmup state ─────────────────────────────────────────────────────────────
# _server_ready: True once the prewarm scan+calculator caches are populated.
# _warmup_done:  Event set at the same moment — used by alert_scanner to delay
#                its first contract scan until the server is fully warm.
_server_ready: bool         = False
_warmup_done: threading.Event = threading.Event()

# ── Contract scan tuning / caches ────────────────────────────────────────────
# Request-rate controls:
#   min_rps = guaranteed floor speed (lower bound)
#   max_rps = allowed peak speed before adaptive throttle reduces it
SCAN_MIN_RPS_DEFAULT = 4.0
SCAN_MAX_RPS_DEFAULT = 12.0
SCAN_MIN_RPS_LIMITS = (1.0, 20.0)
SCAN_MAX_RPS_LIMITS = (2.0, 30.0)

# Cache contract item lookups to avoid re-fetching unchanged listings every scan.
# TTL is set per-entry to the contract's own date_expired (see _run_blueprint_contract_scan);
# this module-level constant is the fallback when expiry is absent (24 h).
_CONTRACT_ITEMS_CACHE: dict[int, dict] = {}
_CONTRACT_ITEMS_CACHE_TTL = 86400  # 24 h fallback (overridden per-entry by expiry)
_CONTRACT_ITEMS_CACHE_LOCK = threading.Lock()

# Timestamp of the last completed contract scan — used to skip contracts we've
# already seen so repeat scans only fetch items for new listings.
_LAST_CONTRACT_SCAN_TS: float = 0.0
_LAST_CONTRACT_SCAN_LOCK = threading.Lock()

# Cache expensive owned-BP lookup to avoid repeated character/corp blueprint fetches.
_OWNED_BP_CACHE: dict = {"ts": 0.0, "personal": set(), "corp": set()}
_OWNED_BP_CACHE_TTL = 300  # 5 min
_OWNED_BP_CACHE_LOCK = threading.Lock()


def _calc_cache_key(
    system: str,
    facility: str,
    structure_id: str = "",
    facility_tax_rate: str = "",
    rig_bonus_mfg: str = "",
) -> str:
    return "|".join([
        system.lower(),
        facility.lower(),
        (structure_id or "").strip(),
        (facility_tax_rate or "").strip(),
        (rig_bonus_mfg or "").strip(),
    ])


def _calc_is_fresh(key: str) -> bool:
    entry = _calc_cache.get(key)
    if not entry:
        return False
    return (time.time() - entry.get("generated_at", 0)) < CALC_CACHE_TTL


def _upgrade_calc_payload_formula(payload: dict) -> None:
    """
    Retroactively correct cached calculator results to job formula v2.
    Updates payload in place.
    """
    if not payload:
        return
    try:
        from calculator import calculate_industry_job_cost
    except Exception:
        return

    results = payload.get("results") or []
    if not results:
        payload["job_formula_version"] = 2
        return

    facility = payload.get("facility") or {}
    payload_sci = payload.get("sci", 0)

    for r in results:
        if int(r.get("job_formula_version", 0) or 0) >= 2 and r.get("job_cost_breakdown"):
            continue

        sci = float(r.get("resolved_sci") or payload_sci or 0)
        facility_tax_rate = float(
            r.get("facility_tax_rate")
            if r.get("facility_tax_rate") is not None
            else facility.get("facility_tax_rate", 0.001)
        )

        cfg = {
            "facility_tax_rate": facility_tax_rate,
            "scc_surcharge_rate": 0.04,
            "structure_type_id": r.get("structure_type_id") or facility.get("structure_type_id"),
            "rig_bonus_mfg": 0.0,
            "job_formula_version": 2,
        }
        breakdown = calculate_industry_job_cost(
            activity="manufacturing",
            eiv=float(r.get("estimated_item_value", r.get("material_cost", 0)) or 0),
            sci=sci,
            cfg=cfg,
        )

        job_cost = breakdown["total_job_cost"]
        gross_revenue = float(r.get("gross_revenue", 0) or 0)
        material_cost = float(r.get("material_cost", 0) or 0)
        sales_tax = float(r.get("sales_tax", 0) or 0)
        broker_fee = float(r.get("broker_fee", 0) or 0)
        invention_cost = float(r.get("invention_cost", 0) or 0)

        total_cost = material_cost + job_cost + sales_tax + broker_fee + invention_cost
        net_profit = gross_revenue - total_cost

        # Keep duration semantics aligned with calculator output
        time_s = float(r.get("time_seconds") or r.get("duration") or 0)
        avg_sell_days = float(r.get("avg_sell_days", 3.0) or 3.0)
        cycle_h = (time_s + avg_sell_days * 86400.0) / 3600.0 if (time_s or avg_sell_days) else 0.0

        r["job_cost"] = job_cost
        r["job_cost_breakdown"] = breakdown
        r["net_profit"] = net_profit
        r["margin_pct"] = (net_profit / gross_revenue * 100.0) if gross_revenue > 0 else 0.0
        r["roi"] = (net_profit / total_cost * 100.0) if total_cost > 0 else 0.0
        r["isk_per_hour"] = (net_profit / cycle_h) if cycle_h > 0 else None
        r["job_formula_version"] = 2

    payload["job_formula_version"] = 2
    payload["recalculated_at"] = int(time.time())


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
# Wallet cache: shared by /api/plex and /api/wallet, avoids duplicate serial ESI calls
_WALLET_CACHE: float = 0.0
_WALLET_CACHE_TS: float = 0
_WALLET_CACHE_TTL = 60  # 1 min

def _get_wallet() -> float:
    """Fetch combined wallet balance across ALL authenticated characters (parallel)."""
    global _WALLET_CACHE, _WALLET_CACHE_TS
    if (time.time() - _WALLET_CACHE_TS) < _WALLET_CACHE_TTL:
        return _WALLET_CACHE
    try:
        import requests as _req
        from characters import get_all_auth_headers
        from concurrent.futures import ThreadPoolExecutor, as_completed
        ESI_BASE = "https://esi.evetech.net/latest"
        auth_headers = get_all_auth_headers()

        def _fetch_one(cid, headers):
            try:
                r = _req.get(f"{ESI_BASE}/characters/{cid}/wallet/", headers=headers, timeout=8)
                return float(r.json()) if r.ok else 0.0
            except Exception:
                return 0.0

        total = 0.0
        with ThreadPoolExecutor(max_workers=len(auth_headers)) as pool:
            futs = [pool.submit(_fetch_one, cid, h) for cid, h in auth_headers]
            for f in as_completed(futs):
                total += f.result()
        _WALLET_CACHE = total
        _WALLET_CACHE_TS = time.time()
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

@app.route("/api/ping", methods=["GET"])
def ping():
    return jsonify({"ok": True})


@app.route("/api/ready", methods=["GET"])
def api_ready():
    """Return whether the prewarm scan+calculator caches are populated."""
    age: float | None = None
    try:
        from pricer import get_market_age as _gma
        raw = _gma()
        age = round(raw, 1) if raw != float("inf") else None
    except Exception:
        pass
    return jsonify({"ready": _server_ready, "market_age_seconds": age})


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


# ── Character skills cache: char_id → {ts, skills} ────────────────────────────
_SKILLS_CACHE: dict[str, dict] = {}
_SKILLS_CACHE_TTL = 3600  # 1 hour — skills change rarely


@app.route("/api/characters/<character_id>/skills", methods=["GET"])
def api_character_skills(character_id: str):
    """
    Return the trained skill levels for a character.
    Response: { skills: { skill_name: trained_level, ... } }
    Names are resolved from skill_names.json (populated by seeder) or via
    the ESI universe/names endpoint as a fallback.
    """
    try:
        import requests as _req
        from characters import get_auth_header, load_characters

        # Validate character exists in our store
        chars = load_characters()
        if str(character_id) not in chars:
            return jsonify({"error": "Character not found"}), 404

        cached = _SKILLS_CACHE.get(str(character_id))
        if cached and (time.time() - cached["ts"]) < _SKILLS_CACHE_TTL:
            return jsonify(cached["data"])

        headers = get_auth_header(str(character_id))
        r = _req.get(
            f"https://esi.evetech.net/latest/characters/{character_id}/skills/",
            headers=headers,
            timeout=10,
        )
        r.raise_for_status()
        payload = r.json()
        raw_skills = payload.get("skills", [])

        # Resolve skill names: prefer loaded skill_names.json, else ESI bulk names
        skill_id_to_name: dict[int, str] = {}
        if _skill_id_names:
            skill_id_to_name = {int(k): v for k, v in _skill_id_names.items()}
        else:
            # Fallback: bulk-resolve via ESI universe/names
            skill_ids = [s["skill_id"] for s in raw_skills]
            if skill_ids:
                try:
                    nr = _req.post(
                        "https://esi.evetech.net/latest/universe/names/",
                        json=skill_ids[:1000],
                        timeout=10,
                    )
                    if nr.ok:
                        for item in nr.json():
                            skill_id_to_name[item["id"]] = item["name"]
                except Exception:
                    pass

        skills_out: dict[str, int] = {}
        for s in raw_skills:
            sid  = s["skill_id"]
            lvl  = s.get("trained_skill_level", 0)
            name = skill_id_to_name.get(sid, f"Skill {sid}")
            skills_out[name] = lvl

        result = {
            "character_id":        str(character_id),
            "total_sp":            payload.get("total_sp", 0),
            "unallocated_sp":      payload.get("unallocated_sp", 0),
            "skills":              skills_out,
        }
        _SKILLS_CACHE[str(character_id)] = {"ts": time.time(), "data": result}
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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


# Plex endpoint cache
_PLEX_CACHE: dict = {}
_PLEX_CACHE_TS: float = 0
_PLEX_CACHE_TTL = 60  # 1 min

@app.route("/api/plex", methods=["GET"])
def api_plex():
    global _PLEX_CACHE, _PLEX_CACHE_TS
    if _PLEX_CACHE and (time.time() - _PLEX_CACHE_TS) < _PLEX_CACHE_TTL:
        # Update days_remaining live
        from datetime import datetime, timezone
        import calendar
        now = datetime.now(timezone.utc)
        _PLEX_CACHE["days_remaining"] = calendar.monthrange(now.year, now.month)[1] - now.day
        return jsonify(_PLEX_CACHE)

    balance    = _get_wallet()
    if balance > 0:
        try:
            record_wallet_snapshot(balance)
        except Exception:
            pass
    plex_price = _get_plex_price({})

    accounts         = PLEX_CONFIG["accounts"]
    plex_per_account = PLEX_CONFIG["plex_per_account"]
    monthly_target   = accounts * plex_per_account * plex_price

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    import calendar
    days_in_month   = calendar.monthrange(now.year, now.month)[1]
    days_remaining  = days_in_month - now.day

    _PLEX_CACHE = {
        "accounts":        accounts,
        "plex_price":      plex_price,
        "plex_per_account":plex_per_account,
        "monthly_target":  monthly_target,
        "current_balance": balance,
        "plex_count":      None,
        "plex_value":      None,
        "days_remaining":  days_remaining,
    }
    _PLEX_CACHE_TS = time.time()
    return jsonify(_PLEX_CACHE)


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
            structure_id - exact structure id used to resolve SCI via structure -> system
            facility_tax_rate - override install tax rate (decimal, e.g. 0.10 for NPC)
            rig_bonus_mfg - additive manufacturing rig bonus on gross SCI component
            force_recalc - if '1', ignore fresh cache and recompute
      sell_loc  - sell location: 'jita', 'amarr', 'dodixie', 'rens', 'hek'
      buy_loc   - buy location: same options
    """
    pass  # request already imported at top
    try:
        from pricer import get_prices_bulk

        # ── Parse query params ────────────────────────────────────────────────
        system_param   = request.args.get("system", "").strip()
        facility_param = request.args.get("facility", "station").strip().lower()
        sell_loc       = request.args.get("sell_loc", "jita").strip().lower()
        buy_loc        = request.args.get("buy_loc",  "jita").strip().lower()

        # ── Return from cache if fresh ────────────────────────────────────────
        structure_id_param = request.args.get("structure_id", "").strip()
        facility_tax_param = request.args.get("facility_tax_rate", "").strip()
        rig_bonus_mfg_param = request.args.get("rig_bonus_mfg", "").strip()
        force_recalc = request.args.get("force_recalc", "0").strip() in ("1", "true", "yes")
        cache_key = _calc_cache_key(
            system_param,
            facility_param,
            structure_id_param,
            facility_tax_param,
            rig_bonus_mfg_param,
        )
        if _calc_is_fresh(cache_key) and not force_recalc:
            _upgrade_calc_payload_formula(_calc_cache[cache_key])
            return jsonify(_calc_cache[cache_key])

        # ── Dedup: if another thread is already computing this key, wait ──────
        with _calc_computing_lock:
            already_running = cache_key in _calc_computing
            if not already_running:
                _calc_computing.add(cache_key)
        if already_running:
            deadline = time.time() + 300
            while cache_key in _calc_computing and not _calc_is_fresh(cache_key):
                if time.time() > deadline:
                    break
                time.sleep(0.5)
            if _calc_is_fresh(cache_key) and not force_recalc:
                _upgrade_calc_payload_formula(_calc_cache[cache_key])
                return jsonify(_calc_cache[cache_key])
            # Timed out or failed — become the new worker
            with _calc_computing_lock:
                _calc_computing.add(cache_key)

        # ── Resolve SCI (prefer structure_id -> system -> SCI) ───────────────
        structure_meta = None
        sci_source = "system"
        if structure_id_param:
            sci, structure_meta, sci_source = _resolve_sci_for_structure(structure_id_param)
        else:
            sci = _resolve_sci(system_param)

        # ── Resolve structure bonuses ─────────────────────────────────────────
        facility_cfg = _facility_config(facility_param)

        # Optional user overrides for owner-set fees/rigs.
        try:
            facility_tax_rate = float(facility_tax_param) if facility_tax_param != "" else float(facility_cfg.get("facility_tax_rate", 0.001) or 0.001)
        except Exception:
            facility_tax_rate = float(facility_cfg.get("facility_tax_rate", 0.001) or 0.001)
        try:
            rig_bonus_mfg = float(rig_bonus_mfg_param) if rig_bonus_mfg_param != "" else 0.0
        except Exception:
            rig_bonus_mfg = 0.0
        try:
            rig_bonus_copy = float(request.args.get("rig_bonus_copy", "") or 0.0)
        except Exception:
            rig_bonus_copy = 0.0

        structure_type_id = facility_cfg.get("structure_type_id")
        if structure_meta and structure_meta.get("type_id"):
            structure_type_id = structure_meta.get("type_id")

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

        # Include datacore type IDs for invention cost calculation
        from invention import _all_datacore_type_ids
        all_type_ids.update(_all_datacore_type_ids())

        _broadcast_progress(cache_key, {"stage": "prices", "msg": "Fetching Jita market data…", "done": 0, "total": total_bps})

        # Only fetch volume history for outputs — skips thousands of material IDs
        prices = get_prices_bulk(list(all_type_ids), history_ids=list(output_ids))

        # Load sell-time history once, share across all blueprint calculations
        _sell_days_by_type: dict = {}
        try:
            from database import get_avg_days_to_sell_by_type
            _sell_days_by_type = get_avg_days_to_sell_by_type()
        except Exception:
            pass

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
                "sales_tax":                  facility_cfg["sales_tax"],
                "facility_tax_rate":          facility_tax_rate,
                "structure_type_id":          structure_type_id,
                "rig_bonus_mfg":              rig_bonus_mfg,
                "rig_bonus_copy":             rig_bonus_copy,
            }
            result = calculate_profit(bp, prices, config_override=cfg_override,
                                      invention_prices=prices,
                                      sell_days_by_type=_sell_days_by_type)
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

            # Resolve material names — name already set by calculator from blueprint_materials.
            # For anything still missing (minerals, datacores, PI mats not in crest.db)
            # fall back to the mineral_names dict; genuinely unknown IDs get a temp placeholder
            # that is resolved in bulk after the loop.
            for mat in result.get("material_breakdown", []):
                if not mat.get("name"):
                    mat["name"] = mineral_names.get(mat["type_id"], f"__UNKNOWN_{mat['type_id']}__")

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
            # ISK/hr accounts for manufacture time + avg time sitting on market
            avg_sell_days  = result.get("avg_sell_days", 3.0)
            total_cycle_s  = time_s + avg_sell_days * 86400.0
            duration_h     = total_cycle_s / 3600.0 if total_cycle_s else 0
            result["roi"]          = (profit / cost * 100) if cost > 0 else 0
            result["isk_per_hour"] = (profit / duration_h) if duration_h > 0 else None
            result["isk_per_m3"]   = (profit / result["volume"]) if result.get("volume", 0) > 0 else 0

            # Break-even sell price: minimum price per unit at which net profit = 0
            # Formula: P * output_qty * (1 − fee_rate) = material_cost + job_cost
            #          fee_rate = (sales_tax + broker_fee) / gross_revenue
            _gross = result.get("gross_revenue", 0)
            _fees  = result.get("sales_tax", 0) + result.get("broker_fee", 0)
            _oqty  = result.get("output_qty", 1) or 1
            _costs = result.get("material_cost", 0) + result.get("job_cost", 0)
            _fee_frac = (_fees / _gross) if _gross > 0 else 0
            result["break_even_price"] = round(
                _costs / (_oqty * (1.0 - _fee_frac)), 2
            ) if _fee_frac < 1.0 else None

            # Annotate which facility/system was used
            result["resolved_sci"]      = sci
            result["facility_label"]    = facility_cfg["label"]
            result["structure_id"]      = structure_id_param or None
            result["structure_type_id"] = structure_type_id
            result["structure_meta"]    = structure_meta
            result["facility_tax_rate"] = facility_tax_rate
            result["sci_source"]        = sci_source

            results.append(result)

        results.sort(key=lambda x: x["net_profit"], reverse=True)

        # ── Bulk-resolve any remaining __UNKNOWN_N__ material names ──────────
        # Collect all type_ids still needing a name
        unknown_ids: set[int] = set()
        for r in results:
            for mat in r.get("material_breakdown", []):
                n = mat.get("name", "")
                if n.startswith("__UNKNOWN_"):
                    try:
                        unknown_ids.add(int(n.split("_")[3]))
                    except Exception:
                        pass

        resolved_names: dict[int, str] = {}
        if unknown_ids:
            # Stage 1: query crest.db invTypes (or blueprint_materials) for names
            try:
                import sqlite3 as _sq
                _sde = os.path.join(_HERE, "sqlite-latest.sqlite")
                if os.path.exists(_sde):
                    _c = _sq.connect(_sde)
                    _c.row_factory = _sq.Row
                    _ph = ",".join("?" * len(unknown_ids))
                    _rows = _c.execute(
                        f"SELECT typeID, typeName FROM invTypes WHERE typeID IN ({_ph})",
                        list(unknown_ids),
                    ).fetchall()
                    _c.close()
                    for row in _rows:
                        resolved_names[row["typeID"]] = row["typeName"]
            except Exception:
                pass

            # Stage 2: any still-unknown → ESI universe/names bulk call (≤1000 per batch)
            still_missing = [tid for tid in unknown_ids if tid not in resolved_names]
            if still_missing:
                try:
                    for i in range(0, len(still_missing), 1000):
                        chunk = still_missing[i:i+1000]
                        nr = requests.post(
                            "https://esi.evetech.net/latest/universe/names/",
                            json=chunk,
                            timeout=10,
                        )
                        if nr.ok:
                            for item in nr.json():
                                resolved_names[item["id"]] = item["name"]
                except Exception:
                    pass

            # Apply resolved names back; fall back to "Type N" only if ESI also fails
            for r in results:
                for mat in r.get("material_breakdown", []):
                    n = mat.get("name", "")
                    if n.startswith("__UNKNOWN_"):
                        try:
                            tid = int(n.split("_")[3])
                            mat["name"] = resolved_names.get(tid, f"Type {tid}")
                        except Exception:
                            mat["name"] = n  # leave as-is

        # Inject volume_m3 into every material_breakdown entry
        # Bulk-preload volumes for all type_ids in one query to avoid N db opens
        _vol_type_ids = set()
        for r in results:
            for mat in r.get("material_breakdown", []):
                if mat["type_id"] not in _PACKAGED_VOLUMES:
                    _vol_type_ids.add(mat["type_id"])
        if _vol_type_ids:
            try:
                import sqlite3 as _sq
                _vids = list(_vol_type_ids)
                conn = _sq.connect(os.path.join(_HERE, "crest.db"))
                ph = ",".join("?" * len(_vids))
                for row in conn.execute(
                    f"SELECT output_id, volume_m3 FROM blueprints WHERE output_id IN ({ph}) AND volume_m3 IS NOT NULL",
                    _vids
                ).fetchall():
                    _PACKAGED_VOLUMES[row[0]] = float(row[1])
                conn.close()
                # For any still missing, try SDE in bulk
                still_missing = [t for t in _vids if t not in _PACKAGED_VOLUMES]
                if still_missing:
                    sde_path = os.path.join(_HERE, "sqlite-latest.sqlite")
                    if os.path.exists(sde_path):
                        conn2 = _sq.connect(sde_path)
                        ph2 = ",".join("?" * len(still_missing))
                        for row in conn2.execute(
                            f"SELECT typeID, volume FROM invTypes WHERE typeID IN ({ph2}) AND volume IS NOT NULL",
                            still_missing
                        ).fetchall():
                            _PACKAGED_VOLUMES[row[0]] = float(row[1])
                        conn2.close()
            except Exception:
                pass
        for r in results:
            for mat in r.get("material_breakdown", []):
                if "volume_m3" not in mat:
                    mat["volume_m3"] = _PACKAGED_VOLUMES.get(mat["type_id"], 0.01)

        # Optional post-calculation filters (query params)
        min_volume = float(request.args.get("min_volume", "0") or 0)
        if min_volume > 0:
            results = [r for r in results if (r.get("avg_daily_volume") or 0) >= min_volume]

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
            "structure_id": structure_id_param or None,
            "structure_meta": structure_meta,
            "sci_source":   sci_source,
            "job_formula_version": 2,
        }
        _calc_cache[cache_key] = payload
        # Evict oldest entries — keep only the 8 most-recently-computed keys
        if len(_calc_cache) > 8:
            oldest_keys = sorted(_calc_cache, key=lambda k: _calc_cache[k].get("generated_at", 0))
            for _old in oldest_keys[:len(_calc_cache) - 8]:
                del _calc_cache[_old]
        # Signal done to all SSE subscribers
        _broadcast_progress(cache_key, {"stage": "done", "msg": "Ready", "done": total_bps, "total": total_bps})
        return jsonify(payload)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        with _calc_computing_lock:
            _calc_computing.discard(cache_key)


@app.route("/api/top-performers", methods=["GET"])
def api_top_performers():
    """
    Return up to 20 manufacturing items where the player/corp owns a BP,
    ranked by a smart composite score that factors in:
      - ISK/hr × log(market depth) × sqrt(ROI)   — base efficiency
      - Urgency: supply_days vs avg_daily_volume   — deprioritize overstocked items
      - BPO copy overhead penalty                 — BPOs need copying, reducing real profitability
      - Active job penalty                        — items already in the build queue need less urgency
      - Capital lock penalty                      — penalise very long sell cycles

    Uses the most recently computed calculator cache; also cross-references the
    ESI orders and industry jobs caches for live signals.
    """
    import math, sqlite3 as _sq
    from calculator import calculate_industry_job_cost

    # ── Auto-refresh ESI blueprint cache if stale ─────────────────────────────
    # The BP cache is only refreshed when BpFinder is visited; top-performers
    # reads it directly so needs to ensure it's current.
    if not _ESI_BP_CACHE or (time.time() - _ESI_BP_CACHE_TS) >= _ESI_BP_TTL:
        try:
            api_blueprints_esi()
        except Exception as _e:
            print(f"[top-performers] BP cache refresh failed: {_e}")

    # ── Auto-refresh assets cache if stale ───────────────────────────────────
    # Assets contain BPCs tracked via is_blueprint_copy; refresh so we pick
    # up BPCs that the ESI blueprints endpoint may not have returned.
    if not _ASSETS_CACHE or (time.time() - _ASSETS_CACHE_TS) >= _ASSETS_TTL:
        try:
            api_assets()
        except Exception as _e:
            print(f"[top-performers] Assets cache refresh failed: {_e}")

    # ── Find freshest calc cache entry ────────────────────────────────────────
    best_key: str | None = None
    best_ts: float = 0
    for key, entry in _calc_cache.items():
        ts = entry.get("generated_at", 0)
        if ts > best_ts:
            best_ts = ts
            best_key = key

    if not best_key:
        return jsonify({"items": [], "status": "no_data"})

    best_payload = _calc_cache[best_key]
    _upgrade_calc_payload_formula(best_payload)
    all_results = best_payload.get("results", [])

    # ── Build owned blueprint_id sets (BPO vs BPC tracked separately) ─────────
    personal_bpo_bp_ids: set = set()   # personal BPOs — original, need copying
    personal_bpc_bp_ids: set = set()   # personal BPCs — ready to manufacture
    corp_bp_ids: set         = set()

    for bp in _ESI_BP_CACHE.get("blueprints", []):
        tid = bp.get("type_id")
        if not tid:
            continue
        if bp.get("owner") == "personal":
            if bp.get("bp_type") == "BPO" or bp.get("runs", -1) == -1:
                personal_bpo_bp_ids.add(tid)
            else:
                personal_bpc_bp_ids.add(tid)
        else:
            corp_bp_ids.add(tid)

    # Also treat any blueprint type found as a BPC in the assets cache as a personal BPC.
    # This catches BPCs the ESI blueprints endpoint may miss (e.g. location_flag edge cases).
    for tid in _ASSETS_CACHE.get("bpc_type_ids", []):
        personal_bpc_bp_ids.add(tid)
        personal_bpo_bp_ids.discard(tid)  # asset BPCs are never BPOs

    corp_bp_ids.update(CORP_BPO_TYPE_IDS)
    personal_bp_ids = personal_bpo_bp_ids | personal_bpc_bp_ids
    all_bp_ids = personal_bp_ids | corp_bp_ids
    if not all_bp_ids:
        return jsonify({"items": [], "status": "no_blueprints"})

    # ── Map blueprint_id → output_id (+ ownership + bp_type) via crest.db ────
    personal_bpo_output_ids: set = set()
    personal_bpc_output_ids: set = set()
    corp_output_ids: set         = set()

    try:
        db_path = os.path.join(os.path.dirname(__file__), "crest.db")
        conn = _sq.connect(db_path)
        ph   = ",".join("?" * len(all_bp_ids))
        rows = conn.execute(
            f"SELECT blueprint_id, output_id FROM blueprints WHERE blueprint_id IN ({ph})",
            list(all_bp_ids),
        ).fetchall()
        conn.close()
        for bp_id, out_id in rows:
            if bp_id in personal_bpo_bp_ids:
                personal_bpo_output_ids.add(out_id)
            if bp_id in personal_bpc_bp_ids:
                personal_bpc_output_ids.add(out_id)
            if bp_id in corp_bp_ids:
                corp_output_ids.add(out_id)
    except Exception as e:
        print(f"[top-performers] DB error: {e}")

    personal_output_ids = personal_bpo_output_ids | personal_bpc_output_ids
    owned_output_ids    = personal_output_ids | corp_output_ids

    # ── Load copy times (blueprinting activityID=5) ─────────────────────────────────
    copy_time_by_output: dict[int, int] = {}
    blueprint_id_by_output: dict[int, int] = {}
    if owned_output_ids:
        try:
            _ct_db = _sq.connect(os.path.join(os.path.dirname(__file__), "crest.db"))
            _ct_ph = ",".join("?" * len(owned_output_ids))
            for _ct_row in _ct_db.execute(
                f"SELECT output_id, copy_time_secs, blueprint_id FROM blueprints WHERE output_id IN ({_ct_ph})",
                list(owned_output_ids),
            ).fetchall():
                copy_time_by_output[_ct_row[0]]    = int(_ct_row[1] or 0)
                blueprint_id_by_output[_ct_row[0]] = int(_ct_row[2] or 0)
            _ct_db.close()
        except Exception:
            pass  # Column not yet seeded — frontend uses 68400s fallback

    # ── Live signal 1: sell order inventory (supply coverage) ─────────────────
    # Aggregate volume_remain per type_id across all open sell orders.
    # Also detect stale orders: an order >2 days old that has sold <20% of its
    # volume is effectively stuck.  Track the maximum stale-order age per type;
    # we'll use it to override supply_days so urgency reflects reality.
    sell_qty_by_type: dict[int, int] = {}
    stale_order_age_by_type: dict[int, float] = {}  # type_id → max stale age (days)
    from datetime import datetime, timezone
    _now_dt = datetime.now(timezone.utc)
    for o in _ESI_ORDERS_CACHE.get("sell", []):
        tid = o.get("type_id")
        if not tid:
            continue
        sell_qty_by_type[tid] = sell_qty_by_type.get(tid, 0) + (o.get("volume_remain") or 0)
        # Stale-order check
        issued_str = o.get("issued", "")
        v_total    = o.get("volume_total") or 0
        v_remain   = o.get("volume_remain") or 0
        if issued_str and v_total > 0:
            try:
                issued_dt   = datetime.fromisoformat(issued_str.rstrip("Z")).replace(tzinfo=timezone.utc)
                order_age_d = (_now_dt - issued_dt).total_seconds() / 86400.0
                fill_pct    = (v_total - v_remain) / v_total
                # Stale = open >2 days and less than 20% has sold
                if order_age_d > 2.0 and fill_pct < 0.20:
                    stale_order_age_by_type[tid] = max(
                        stale_order_age_by_type.get(tid, 0.0), order_age_d
                    )
            except Exception:
                pass

    # ── Live signal 2: items actively being manufactured or queued ─────────────
    now_ts = int(time.time())
    actively_producing: dict[int, int] = {}   # output type_id → runs in flight
    for j in _ESI_JOBS_CACHE.get("jobs", []):
        if j.get("activity_id") in (1, 9, 11):  # Manufacturing / Reactions
            pid   = j.get("product_type_id")
            secs  = max(0, j.get("end_ts", 0) - now_ts)
            if pid and secs > 0:
                actively_producing[pid] = actively_producing.get(pid, 0) + (j.get("runs") or 1)

    # ── Score and filter results ───────────────────────────────────────────────
    URGENCY_HORIZON_DAYS = 7    # >7 days supply → near-zero urgency
    BPO_COPY_PENALTY     = 0.70 # BPOs score 30% lower (copy overhead, 40-day waits)
    MIN_DAILY_VOLUME     = 0.5  # hard gate — items selling <0.5/day are dropped entirely

    candidates = []
    for r in all_results:
        out_id = r.get("output_id")
        if out_id not in owned_output_ids:
            continue
        profit  = r.get("net_profit", 0)
        isk_hr  = r.get("isk_per_hour") or 0
        vol     = r.get("avg_daily_volume") or 0
        roi     = r.get("roi", 0)

        if profit <= 0 or isk_hr <= 0:
            continue

        if vol < MIN_DAILY_VOLUME:
            continue

        # ── Urgency: how urgently do we need to produce more? ─────────────────
        sell_qty    = sell_qty_by_type.get(out_id, 0)
        supply_days = (sell_qty / vol) if vol > 0 else 0
        # If an open sell order for this item is stale (old + barely filling),
        # treat the order's actual age as the effective supply window.
        # A 10-day-old unsold order means we already have 10 days of stuck supply.
        stale_age = stale_order_age_by_type.get(out_id, 0.0)
        if stale_age > supply_days:
            supply_days = stale_age
        # sigmoid-style: urgency=1.0 at 0d coverage, ~0.5 at horizon/2, ~0.05 at horizon+
        urgency = max(0.05, 1.0 - (supply_days / URGENCY_HORIZON_DAYS) ** 0.8)
        # Boost: if already critically low (<1 day supply) signal very urgent
        if supply_days < 1.0:
            urgency = min(2.0, urgency * 1.5)

        # Also factor in units already being produced vs supply gap
        producing_qty = actively_producing.get(out_id, 0)
        if vol > 0 and producing_qty > 0:
            days_in_flight = producing_qty / vol
            # Treat in-flight production as partial coverage
            urgency = urgency * max(0.2, 1.0 - days_in_flight / URGENCY_HORIZON_DAYS)

        # ── BPO copy overhead — adjust isk/hr and profit for true cycle time ──
        # needs_copy = no personal BPC in hand; must copy BPO before manufacturing.
        # The calculator's isk_per_hour only covers (manufacture_time + sell_time).
        # For BPO items the copy job adds days/weeks to the effective cycle, and
        # the copy job installation fee (≈2% of mfg install cost) is an extra
        # cost not reflected in net_profit.
        needs_copy  = out_id not in personal_bpc_output_ids
        is_corp_bp  = out_id in corp_output_ids and out_id not in personal_output_ids

        copy_time_secs_item = copy_time_by_output.get(out_id, 0) if needs_copy else 0
        copy_job_cost_total = 0.0
        copy_job_cost_per_run = 0.0
        copy_breakdown      = None
        adj_isk_hr          = isk_hr
        adj_profit          = profit

        if needs_copy:
            _pre_rec  = r.get("recommended_runs")
            _pre_runs = int(_pre_rec.get("runs", 1)) if isinstance(_pre_rec, dict) else 1

            # Resolve the copying-activity SCI for the same system as the mfg job.
            # structure_meta carries solar_system_id; fall back to mfg SCI if unknown.
            _meta     = r.get("structure_meta") or {}
            _sys_id   = str(_meta.get("solar_system_id") or "")
            _copy_sci = _resolve_sci(_sys_id, activity="copying") if _sys_id else float(r.get("resolved_sci") or 0)

            # Copy job install cost — always calculated when needs_copy is True.
            # Formula: base = EIV * 0.02, gross = base * copy_SCI, taxes on base.
            copy_breakdown = calculate_industry_job_cost(
                activity="copying",
                eiv=float(r.get("estimated_item_value", r.get("material_cost", 0)) or 0),
                sci=_copy_sci,
                cfg={
                    "facility_tax_rate": float(r.get("facility_tax_rate") or 0.001),
                    "structure_type_id": r.get("structure_type_id"),
                    "rig_bonus_copy":    0.0,
                    "scc_surcharge_rate": 0.04,
                },
            )
            copy_job_cost_total = float(copy_breakdown.get("total_job_cost") or 0.0)
            copy_job_cost_per_run = copy_job_cost_total / max(1, _pre_runs)
            adj_profit    = profit - copy_job_cost_per_run

            # Adjust isk/hr for copy-time overhead — only when copy time is known.
            if copy_time_secs_item > 0:
                duration_s    = float(r.get("duration", 0) or 0)
                avg_sell_s    = (float(r.get("avg_sell_days") or 3.0)) * 86400.0
                current_cycle = duration_s + avg_sell_s
                copy_overhead_per_run = copy_time_secs_item / max(1, _pre_runs)
                adj_cycle = current_cycle + copy_overhead_per_run
                if current_cycle > 0 and adj_cycle > 0:
                    adj_isk_hr = isk_hr * (current_cycle / adj_cycle)

        if adj_profit <= 0 or adj_isk_hr <= 0:
            continue

        # ── BPO copy penalty (additional scoring signal after isk_hr fix) ─────
        copy_penalty = BPO_COPY_PENALTY if needs_copy else 1.0

        # ── Capital lock penalty: penalise very slow-selling items ────────────
        # 7d → 1.0, 14d → 0.70, 21d → 0.39, 30d → 0.10 (floor)
        days_to_sell = 0
        rec = r.get("recommended_runs")
        if isinstance(rec, dict):
            days_to_sell = rec.get("days_to_sell", 0) or 0
        capital_penalty = max(0.1, 1.0 - max(0, days_to_sell - 7) / 23)

        # ── Final composite score (uses copy-adjusted isk/hr) ─────────────────
        adj_roi   = (adj_profit / max(1.0, float(r.get("material_cost") or 0) + float(r.get("job_cost") or 0))) * 100.0
        liquidity = min(1.0, vol)  # near-zeros items selling <1/day
        base      = adj_isk_hr * math.log1p(max(1.0, vol)) * math.sqrt(max(0.0, adj_roi)) * liquidity
        score     = base * urgency * copy_penalty * capital_penalty

        ownership = []
        if out_id in personal_output_ids:
            ownership.append("personal")
        if out_id in corp_output_ids:
            ownership.append("corp")

        # ── Material shortfall vs hangar inventory ───────────────────────────
        _assets  = _ASSETS_CACHE.get("assets", {})
        _rec_r   = r.get("recommended_runs")
        rec_runs = int(_rec_r.get("runs", 1)) if isinstance(_rec_r, dict) else 1
        duration_secs = int(r.get("duration", 0) or 0)
        mats_ready            = True
        missing_mats_est_cost = 0.0
        for _m in r.get("material_breakdown", []):
            _needed = (_m.get("quantity") or 0) * rec_runs
            _have   = _assets.get(_m["type_id"], _assets.get(str(_m["type_id"]), 0)) or 0
            if _have < _needed:
                mats_ready = False
                _unit = (_m.get("line_cost") or 0) / max(1, _m.get("quantity") or 1)
                missing_mats_est_cost += _unit * (_needed - _have)

        candidates.append({
            "name":              r["name"],
            "output_id":         out_id,
            "tech":              r.get("tech", "I"),
            "category":          r.get("category", ""),
            "roi":               round(r.get("roi", 0), 1),
            "net_profit":        round(r.get("net_profit", 0)),
            "isk_per_hour":      round(r.get("isk_per_hour", 0)),
            "avg_daily_volume":  round(vol, 1),
            "recommended_runs":  r.get("recommended_runs"),
            "rec_runs":          rec_runs,
            "duration_secs":     duration_secs,
            "ownership":         ownership,
            # ── live signals exposed to frontend ──
            "supply_qty":        sell_qty,
            "supply_days":       round(supply_days, 1),
            "producing_qty":     producing_qty,
            "is_bpo_only":       needs_copy and not is_corp_bp,
            "urgency":           round(urgency, 2),
            "needs_copy":        needs_copy,
            "copy_time_secs":    copy_time_secs_item,
            "blueprint_id":      blueprint_id_by_output.get(out_id) if needs_copy else None,
            # Display full copy install fee to match in-game job window.
            "copy_job_cost":     round(copy_job_cost_total),
            # Keep amortized value for per-run economics and debugging.
            "copy_job_cost_per_run": round(copy_job_cost_per_run),
            "copy_job_breakdown": copy_breakdown,
            "adj_net_profit":    round(adj_profit),
            "adj_isk_per_hour":  round(adj_isk_hr),
            "mats_ready":        mats_ready,
            "missing_mats_est_cost": round(missing_mats_est_cost),
            "_score":            score,
            # ── calc detail for queue planner inline breakdown ──────────────
            "material_cost":       r.get("material_cost", 0),
            "job_cost":            r.get("job_cost", 0),
            "job_cost_breakdown":  r.get("job_cost_breakdown"),
            "sales_tax":           r.get("sales_tax", 0),
            "broker_fee":          r.get("broker_fee", 0),
            "gross_revenue":       r.get("gross_revenue", 0),
            "output_qty":          r.get("output_qty", 1),
            "estimated_item_value": r.get("estimated_item_value", 0),
            "job_formula_version": r.get("job_formula_version", 2),
            "duration":            r.get("time_seconds", 0) or r.get("duration", 0),
            "material_breakdown":  r.get("material_breakdown", []),
        })

    candidates.sort(key=lambda x: x["_score"], reverse=True)

    # ── Slot timeline from active ESI manufacturing jobs ──────────────────────
    mfg_end_times = sorted(
        int(j["end_ts"]) for j in _ESI_JOBS_CACHE.get("jobs", [])
        if j.get("activity_id") in (1, 9, 11) and j.get("end_ts", 0) > now_ts
    )
    running_mfg  = len(mfg_end_times)
    max_jobs     = _get_max_jobs(running_fallback=running_mfg)
    free_slots   = max(0, max_jobs - running_mfg)
    slot_free_at = mfg_end_times[:max_jobs]

    # ── Science (research) slots ───────────────────────────────────────────────
    running_science  = sum(
        1 for j in _ESI_JOBS_CACHE.get("jobs", [])
        if j.get("activity_id") in (3, 4, 5, 8) and j.get("end_ts", 0) > now_ts
    )
    max_science      = _get_max_science_jobs(running_fallback=running_science)
    free_science     = max(0, max_science - running_science)

    # ── Assign action_type + start_at per ranked item ─────────────────────────
    items = []
    mfg_queue_pos = 0
    for r in candidates[:20]:
        r.pop("_score", None)
        if r.get("needs_copy"):
            r["action_type"]    = "copy_first"
            r["start_at"]       = now_ts
            _copy_secs               = int((r.get("copy_time_secs") or 68400) * r.get("rec_runs", 1) * _COPY_TIME_MODIFIER)
            r["manufacture_at"]      = now_ts + _copy_secs
            r["estimated_copy_secs"] = _copy_secs
        else:
            r["action_type"] = "manufacture"
            if mfg_queue_pos < free_slots:
                r["start_at"] = now_ts
            elif (mfg_queue_pos - free_slots) < len(slot_free_at):
                r["start_at"] = int(slot_free_at[mfg_queue_pos - free_slots])
            else:
                r["start_at"] = now_ts
            r["manufacture_at"] = r["start_at"]
            mfg_queue_pos += 1
        items.append(r)

    # ── Persist displayed queue items so footer mirrors Queue Planner exactly ─
    global _QUEUE_PLANNER_CANDIDATES_CACHE, _QUEUE_PLANNER_CANDIDATES_TS
    _QUEUE_PLANNER_CANDIDATES_CACHE = list(items)
    _QUEUE_PLANNER_CANDIDATES_TS    = time.time()
    _QUEUE_SUMMARY_CACHE_TS         = 0  # force footer to rebuild from fresh queue items

    return jsonify({
        "items":            items,
        "generated_at":     int(best_ts),
        "total_owned":      len(candidates),
        "cache_key":        best_key,
        "max_jobs":         max_jobs,
        "running_jobs":     running_mfg,
        "free_slots":       free_slots,
        "slot_free_at":     slot_free_at,
        "max_science":      max_science,
        "running_science":  running_science,
        "free_science":     free_science,
    })


@app.route("/api/invention/costs", methods=["GET"])
def api_invention_costs():
    """
    Return invention cost breakdown for all T2 blueprints in INVENTION_DATA.
    Uses live Jita datacore prices.

    Response:
    {
      "costs": {
        "Hammerhead II": {
          "cost_per_bpc": 12345678.0,
          "cost_per_run": 1234567.8,
          "success_chance": 0.34,
          "output_runs_per_bpc": 10,
          "datacore_costs": { ... }
        },
        ...
      },
      "generated_at": 1234567890
    }
    """
    import time
    try:
        from invention import calculate_all_invention_costs
        costs = calculate_all_invention_costs()
        return jsonify({
            "costs":        costs,
            "generated_at": int(time.time()),
        })
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
    pass  # request already imported at top
    system_param   = request.args.get("system",   "").strip()
    facility_param = request.args.get("facility", "station").strip().lower()
    structure_id_param = request.args.get("structure_id", "").strip()
    facility_tax_param = request.args.get("facility_tax_rate", "").strip()
    rig_bonus_mfg_param = request.args.get("rig_bonus_mfg", "").strip()
    cache_key = _calc_cache_key(
        system_param,
        facility_param,
        structure_id_param,
        facility_tax_param,
        rig_bonus_mfg_param,
    )

    # If already cached, immediately send a "done" event and close
    if _calc_is_fresh(cache_key):
        def instant():
            yield f"data: {json.dumps({'stage':'done','msg':'Ready','done':1,'total':1})}\n\n"
        return Response(instant(), mimetype="text/event-stream",
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

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/api/calculator/recalculate_cache", methods=["POST"])
def api_calculator_recalculate_cache():
    """
    Recalculate/upgrade all in-memory calculator cache payloads to the latest
    job-cost formula version.
    """
    upgraded = 0
    for _k, payload in list(_calc_cache.items()):
        before = int(payload.get("job_formula_version", 0) or 0)
        _upgrade_calc_payload_formula(payload)
        after = int(payload.get("job_formula_version", 0) or 0)
        if after > before:
            upgraded += 1
    return jsonify({
        "ok": True,
        "upgraded_payloads": upgraded,
        "cache_entries": len(_calc_cache),
        "formula_version": 2,
        "ts": int(time.time()),
    })


# ── System Cost Index + structure metadata lookup ────────────────────────────
_SCI_CACHE: dict = {}        # system_id_str -> {activity_str: float}
_SCI_NAME_CACHE: dict = {}   # lowercase_name -> system_id_str
_SCI_CACHE_TS: float = 0
_SCI_TTL = 6 * 3600          # 6h primary TTL (heavy cache)
_SCI_STALE_TTL = 72 * 3600   # allow stale usage up to 72h if ESI fails
_SCI_LOCK = threading.Lock()

_STRUCTURE_META_CACHE: dict = {}   # structure_id_str -> meta dict
_STRUCTURE_META_TS: dict = {}      # structure_id_str -> last_refresh_ts
_STRUCTURE_META_TTL = 24 * 3600    # 24h cache
_STRUCTURE_META_LOCK = threading.Lock()

_SCI_SNAPSHOT_PATH = os.path.join(_HERE, "esi_sci_cache.json")
_STRUCTURE_SNAPSHOT_PATH = os.path.join(_HERE, "esi_structure_meta_cache.json")

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

def _load_sci_snapshot() -> None:
    global _SCI_CACHE, _SCI_NAME_CACHE, _SCI_CACHE_TS
    if not os.path.exists(_SCI_SNAPSHOT_PATH):
        return
    try:
        with open(_SCI_SNAPSHOT_PATH, "r", encoding="utf-8") as f:
            payload = json.load(f)
        sci = payload.get("sci", {}) or {}
        # Migration: old format stored float values; new format requires dicts.
        # If any value is a float, discard the snapshot and force a fresh fetch.
        if sci and isinstance(next(iter(sci.values())), (int, float)):
            return
        _SCI_CACHE = sci
        _SCI_NAME_CACHE = payload.get("names", {}) or {}
        _SCI_CACHE_TS = float(payload.get("ts", 0) or 0)
    except Exception:
        pass


def _save_sci_snapshot() -> None:
    try:
        payload = {
            "sci": _SCI_CACHE,
            "names": _SCI_NAME_CACHE,
            "ts": _SCI_CACHE_TS,
        }
        with open(_SCI_SNAPSHOT_PATH, "w", encoding="utf-8") as f:
            json.dump(payload, f)
    except Exception:
        pass


def _load_structure_snapshot() -> None:
    global _STRUCTURE_META_CACHE, _STRUCTURE_META_TS
    if not os.path.exists(_STRUCTURE_SNAPSHOT_PATH):
        return
    try:
        with open(_STRUCTURE_SNAPSHOT_PATH, "r", encoding="utf-8") as f:
            payload = json.load(f)
        _STRUCTURE_META_CACHE = payload.get("meta", {}) or {}
        _STRUCTURE_META_TS = {k: float(v or 0) for k, v in (payload.get("ts", {}) or {}).items()}
    except Exception:
        pass


def _save_structure_snapshot() -> None:
    try:
        payload = {
            "meta": _STRUCTURE_META_CACHE,
            "ts": _STRUCTURE_META_TS,
        }
        with open(_STRUCTURE_SNAPSHOT_PATH, "w", encoding="utf-8") as f:
            json.dump(payload, f)
    except Exception:
        pass


def _refresh_sci_cache(force: bool = False):
    """Fetch ESI industry/systems and rebuild SCI/name caches."""
    global _SCI_CACHE, _SCI_NAME_CACHE, _SCI_CACHE_TS
    now = time.time()
    if not force and _SCI_CACHE and (now - _SCI_CACHE_TS) <= _SCI_TTL:
        return
    with _SCI_LOCK:
        now = time.time()
        if not force and _SCI_CACHE and (now - _SCI_CACHE_TS) <= _SCI_TTL:
            return
        try:
            resp = requests.get(
                "https://esi.evetech.net/latest/industry/systems/",
                timeout=15
            )
            if not resp.ok:
                return
            data = resp.json()
            _TRACKED_ACTIVITIES = {
                "manufacturing", "copying",
                "researching_material_efficiency", "researching_time_efficiency",
                "invention", "reaction",
            }
            new_sci: dict = {}
            for entry in data:
                sid = str(entry.get("solar_system_id", ""))
                activities: dict = {}
                for cost in entry.get("cost_indices", []):
                    act = cost.get("activity", "")
                    if act in _TRACKED_ACTIVITIES:
                        activities[act] = float(cost.get("cost_index", 0.0))
                if activities:
                    new_sci[sid] = activities

            # Build name -> id map from known systems + bulk ESI names for IDs
            name_map: dict = {}
            for sid, name in _KNOWN_SYSTEMS.items():
                name_map[name.lower()] = sid

            all_ids = [int(sid) for sid in new_sci.keys() if sid.isdigit()]
            batch_size = 1000
            for i in range(0, min(len(all_ids), 5000), batch_size):
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

            _SCI_CACHE = new_sci
            _SCI_NAME_CACHE = name_map
            _SCI_CACHE_TS = now
            _save_sci_snapshot()
            print(f"  SCI cache refreshed: {len(_SCI_CACHE)} systems, {len(_SCI_NAME_CACHE)} names")
        except Exception as e:
            print(f"  SCI cache refresh failed: {e}")


def _ensure_sci_cache():
    """Ensure SCI cache exists; refresh when stale."""
    if not _SCI_CACHE:
        _load_sci_snapshot()
    if not _SCI_CACHE or (time.time() - _SCI_CACHE_TS) > _SCI_TTL:
        _refresh_sci_cache()


def _name_to_system_id(name: str) -> str | None:
    """Resolve a system name (case-insensitive) to its system_id string."""
    _ensure_sci_cache()
    return _SCI_NAME_CACHE.get(name.strip().lower())


_ACTIVITY_MAP = {
    "manufacturing":  "manufacturing",
    "me_research":    "researching_material_efficiency",
    "te_research":    "researching_time_efficiency",
    "copying":        "copying",
    "invention":      "invention",
    "reaction":       "reaction",
}


def _resolve_sci(system_name_or_id: str, activity: str = "manufacturing") -> float:
    """
    Look up the SCI for a solar system and activity type.
    Falls back to the CONFIG default if not found.
    """
    from calculator import CONFIG as CALC_CONFIG
    default_sci = CALC_CONFIG["system_cost_index"]

    if not system_name_or_id:
        return default_sci

    esi_activity = _ACTIVITY_MAP.get(activity, activity)

    _ensure_sci_cache()

    def _lookup(sid: str) -> float | None:
        entry = _SCI_CACHE.get(sid)
        if isinstance(entry, dict):
            return entry.get(esi_activity)
        return None

    # Lookup by numeric ID
    if system_name_or_id.isdigit():
        val = _lookup(system_name_or_id)
        return val if val is not None else default_sci

    # Lookup by name
    sid = _name_to_system_id(system_name_or_id)
    if sid:
        val = _lookup(sid)
        return val if val is not None else default_sci

    return default_sci


def _load_structure_meta_cached(structure_id: str) -> dict | None:
    sid = str(structure_id or "").strip()
    if not sid or not sid.isdigit():
        return None
    if not _STRUCTURE_META_CACHE:
        _load_structure_snapshot()

    now = time.time()
    with _STRUCTURE_META_LOCK:
        cached = _STRUCTURE_META_CACHE.get(sid)
        ts = _STRUCTURE_META_TS.get(sid, 0)
        if cached and (now - ts) <= _STRUCTURE_META_TTL:
            return cached

    # Refresh from ESI on miss/expired
    try:
        tried_headers = [None]
        try:
            from characters import get_all_auth_headers
            tried_headers = [h for _, h in get_all_auth_headers()] + [None]
        except Exception:
            tried_headers = [None]

        for _headers in tried_headers:
            r = requests.get(
                f"https://esi.evetech.net/latest/universe/structures/{sid}/",
                headers=_headers,
                timeout=12,
            )
            if not r.ok:
                continue
            j = r.json()
            meta = {
                "name": j.get("name", ""),
                "solar_system_id": j.get("solar_system_id"),
                "type_id": j.get("type_id"),
            }
            with _STRUCTURE_META_LOCK:
                _STRUCTURE_META_CACHE[sid] = meta
                _STRUCTURE_META_TS[sid] = now
                _save_structure_snapshot()
            return meta
    except Exception:
        pass

    # Fallback: stale cache is better than failure
    with _STRUCTURE_META_LOCK:
        return _STRUCTURE_META_CACHE.get(sid)


def _resolve_sci_for_structure(structure_id: str) -> tuple[float, dict | None, str]:
    """
    Resolve manufacturing SCI via structure_id -> solar_system_id -> SCI cache.
    Returns (sci, structure_meta_or_none, sci_source).
    """
    from calculator import CONFIG as CALC_CONFIG
    default_sci = CALC_CONFIG["system_cost_index"]

    meta = _load_structure_meta_cached(structure_id)
    if not meta:
        return default_sci, None, "default"

    system_id = str(meta.get("solar_system_id") or "")
    _ensure_sci_cache()
    entry = _SCI_CACHE.get(system_id)
    if isinstance(entry, dict) and "manufacturing" in entry:
        return float(entry["manufacturing"]), meta, "esi_cache"

    # If cache is very stale and still missing, attempt forced refresh once.
    if (time.time() - _SCI_CACHE_TS) > _SCI_STALE_TTL:
        _refresh_sci_cache(force=True)
        entry = _SCI_CACHE.get(system_id)
        if isinstance(entry, dict) and "manufacturing" in entry:
            return float(entry["manufacturing"]), meta, "esi_refresh"

    return default_sci, meta, "default"


# ── Facility configuration ─────────────────────────────────────────────────────
_FACILITY_PRESETS = {
    "station":  {"label": "NPC Station",         "me_bonus": 0.00, "sales_tax": 0.036, "structure_type_id": None,  "facility_tax_rate": 0.001},
    "medium":   {"label": "Medium Eng. Complex", "me_bonus": 0.01, "sales_tax": 0.036, "structure_type_id": 35825, "facility_tax_rate": 0.001},
    "large":    {"label": "Large Eng. Complex",  "me_bonus": 0.01, "sales_tax": 0.036, "structure_type_id": 35826, "facility_tax_rate": 0.001},
    "xl":       {"label": "XL Eng. Complex",     "me_bonus": 0.01, "sales_tax": 0.036, "structure_type_id": 35827, "facility_tax_rate": 0.001},
    "raitaru":  {"label": "Raitaru",             "me_bonus": 0.01, "sales_tax": 0.036, "structure_type_id": 35825, "facility_tax_rate": 0.001},
    "azbel":    {"label": "Azbel",               "me_bonus": 0.01, "sales_tax": 0.036, "structure_type_id": 35826, "facility_tax_rate": 0.001},
    "sotiyo":   {"label": "Sotiyo",              "me_bonus": 0.01, "sales_tax": 0.036, "structure_type_id": 35827, "facility_tax_rate": 0.001},
}

def _facility_config(key: str) -> dict:
    return _FACILITY_PRESETS.get(key, _FACILITY_PRESETS["station"])


@app.route("/api/systems/search", methods=["GET"])
def api_systems_search():
    """
    Search for solar systems by name prefix and return SCI for each.
    Query param: q=<search string>
    """
    pass  # request already imported at top
    q = request.args.get("q", "").strip()
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
    GET /api/sci?system_name=Korsiki[&activity=manufacturing]
    Returns { system, activity, cost_index } for the given system and activity.
    Returns 404 { error: "System not found" } if the name doesn't match.
    """
    system_name = request.args.get("system_name", "").strip()
    activity    = request.args.get("activity", "manufacturing").strip()
    if not system_name:
        return jsonify({"error": "system_name is required"}), 400

    try:
        _ensure_sci_cache()

        sid = _name_to_system_id(system_name)
        if not sid:
            return jsonify({"error": "System not found"}), 404

        if _SCI_CACHE.get(sid) is None:
            return jsonify({"error": "System not found"}), 404

        cost_index = _resolve_sci(system_name, activity=activity)

        return jsonify({
            "system":     system_name,
            "activity":   activity,
            "cost_index": cost_index,
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

        pass  # request already imported at top
        system   = request.args.get("system",   "Korsiki")
        facility = request.args.get("facility", "large")
        sell_loc = request.args.get("sell_loc", "jita")
        buy_loc  = request.args.get("buy_loc",  "jita")
        limit    = int(request.args.get("limit", 50))

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

        _upgrade_calc_payload_formula(_calc_cache[cache_key])
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
    """Non-streaming scan endpoint for blueprint contracts (all SDE blueprints)."""
    try:
        region_id = int(request.args.get("region_id", 10000002))
        system = request.args.get("system", "Korsiki")
        facility = request.args.get("facility", "large")

        # Load full SDE blueprint set — scanner no longer gates on calculator
        all_bp_ids, bp_info = _load_all_bp_info()
        if not all_bp_ids:
            return jsonify({
                "results": [],
                "not_ready": True,
                "message": "Blueprint database (crest.db) not found — run seeder.py first.",
            })

        # Calculator data is optional enrichment
        calc_results = _get_scan_calc_results(system, facility)
        bpid_to_calc = _build_scan_bpid_map(calc_results) if calc_results else {}

        personal_bp_ids, corp_bp_ids = _load_owned_bp_ids()

        # ── Use local contract cache (instant SQL query, no ESI calls) ─────────
        stats = _cc.get_stats(region_id)
        if stats["items_fetched"] == 0:
            return jsonify({
                "results": [],
                "not_ready": True,
                "message": "Contract cache is still warming up — please wait.",
                "cache_stats": stats,
            })

        raw_matches   = _cc.query_bp_contracts(all_bp_ids, region_id=region_id)
        best_by_bpid  = {}
        for row in raw_matches:
            match = {
                "contract": {
                    "contract_id":       row["contract_id"],
                    "title":             row["title"],
                    "price":             row["price"],
                    "volume":            row["volume"],
                    "date_issued":       row["date_issued"],
                    "date_expired":      row["date_expired"],
                    "start_location_id": None,
                    "issuer_id":         None,
                },
                "type_id": row["type_id"],
                "me":       row["material_efficiency"],
                "te":       row["time_efficiency"],
                "quantity": row["quantity"],
                "is_bpc":   bool(row["is_blueprint_copy"]),
                "runs":     row["runs"],
            }
            result_row = _build_scan_result_row(
                match, bpid_to_calc, personal_bp_ids, corp_bp_ids, bp_info
            )
            bpid     = result_row["blueprint_id"]
            existing = best_by_bpid.get(bpid)
            if existing is None:
                result_row["listing_count"]  = 1
                result_row["cheapest_price"] = result_row["price"]
                best_by_bpid[bpid] = result_row
            else:
                existing["listing_count"] = existing.get("listing_count", 1) + 1
                if result_row["price"] < existing["price"]:
                    result_row["listing_count"]  = existing["listing_count"]
                    result_row["cheapest_price"] = result_row["price"]
                    best_by_bpid[bpid] = result_row

        results = sorted(
            best_by_bpid.values(),
            key=lambda x: x.get("price", 0),
        )
        return jsonify({
            "results":           results,
            "matched":           len(results),
            "raw_matches":       len(raw_matches),
            "contracts_checked": stats["items_fetched"],
            "pages_scanned":     0,
            "bp_candidates":     stats["outstanding"],
            "cache_stats":       stats,
            "from_cache":        True,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e), "results": []}), 200


@app.route("/api/bpo_market_scan_benchmark", methods=["GET"])
def api_bpo_market_scan_benchmark():
    """
    Run the shared blueprint contract scan N times and return timing stats.
    Query params:
      - region_id (default 10000002)
      - max_pages (default 10, capped at 40)
      - runs (default 2, capped at 5)
      - system (default Korsiki)
      - facility (default large)
      - include_results (default 0): include final run result rows
    """
    try:
        import statistics as _stats

        region_id = int(request.args.get("region_id", 10000002))
        max_pages = min(int(request.args.get("max_pages", 10)), 40)
        runs = min(max(int(request.args.get("runs", 2)), 1), 5)
        system = request.args.get("system", "Korsiki")
        facility = request.args.get("facility", "large")
        include_results = str(request.args.get("include_results", "0")).lower() in ("1", "true", "yes")
        min_rps = float(request.args.get("min_rps", SCAN_MIN_RPS_DEFAULT))
        max_rps = float(request.args.get("max_rps", SCAN_MAX_RPS_DEFAULT))

        calc_results = _get_scan_calc_results(system, facility)
        if calc_results is None:
            return jsonify({
                "ok": False,
                "not_ready": True,
                "message": "Open the Calculator tab first to load market prices, then benchmark.",
            })

        bpid_to_calc = _build_scan_bpid_map(calc_results)
        wanted_bp_ids = set(bpid_to_calc.keys())
        if not wanted_bp_ids:
            return jsonify({
                "ok": False,
                "message": "No calc data found — open the Calculator tab first.",
                "runs": [],
            })

        owned_t0 = time.perf_counter()
        personal_bp_ids, corp_bp_ids = _load_owned_bp_ids()
        owned_ms = round((time.perf_counter() - owned_t0) * 1000, 1)

        run_rows = []
        payload_for_include = None
        for i in range(runs):
            t0 = time.perf_counter()
            payload = _run_blueprint_contract_scan(
                region_id=region_id,
                max_pages=max_pages,
                wanted_bp_ids=wanted_bp_ids,
                bpid_to_calc=bpid_to_calc,
                personal_bp_ids=personal_bp_ids,
                corp_bp_ids=corp_bp_ids,
                progress_cb=None,
                min_rps=min_rps,
                max_rps=max_rps,
            )
            elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
            payload_for_include = payload
            run_rows.append({
                "run": i + 1,
                "elapsed_ms": elapsed_ms,
                "matched": payload.get("matched", 0),
                "raw_matches": payload.get("raw_matches", 0),
                "contracts_checked": payload.get("contracts_checked", 0),
                "bp_candidates": payload.get("bp_candidates", 0),
                "retries": payload.get("retries", 0),
                "request_errors": payload.get("request_errors", 0),
                "pages_scanned": payload.get("pages_scanned", 0),
                "item_requests": payload.get("item_requests", 0),
                "item_cache_hits": payload.get("item_cache_hits", 0),
            })

        elapsed_values = [r["elapsed_ms"] for r in run_rows]
        contracts_values = [max(r["contracts_checked"], 1) for r in run_rows]
        candidates_values = [max(r["bp_candidates"], 1) for r in run_rows]

        summary = {
            "runs": runs,
            "region_id": region_id,
            "max_pages": max_pages,
            "min_rps": min_rps,
            "max_rps": max_rps,
            "owned_lookup_ms": owned_ms,
            "elapsed_ms_avg": round(sum(elapsed_values) / len(elapsed_values), 1),
            "elapsed_ms_min": min(elapsed_values),
            "elapsed_ms_max": max(elapsed_values),
            "elapsed_ms_p50": round(_stats.median(elapsed_values), 1),
            "contracts_per_sec_avg": round(sum((r["contracts_checked"] / (r["elapsed_ms"] / 1000.0)) for r in run_rows) / len(run_rows), 2),
            "candidates_per_sec_avg": round(sum((r["bp_candidates"] / (r["elapsed_ms"] / 1000.0)) for r in run_rows) / len(run_rows), 2),
            "retries_total": sum(r["retries"] for r in run_rows),
            "request_errors_total": sum(r["request_errors"] for r in run_rows),
            "item_requests_total": sum(r["item_requests"] for r in run_rows),
            "item_cache_hits_total": sum(r["item_cache_hits"] for r in run_rows),
            "matched_avg": round(sum(r["matched"] for r in run_rows) / len(run_rows), 2),
            "raw_matches_avg": round(sum(r["raw_matches"] for r in run_rows) / len(run_rows), 2),
            "contracts_checked_avg": round(sum(contracts_values) / len(contracts_values), 2),
            "bp_candidates_avg": round(sum(candidates_values) / len(candidates_values), 2),
        }

        out = {"ok": True, "summary": summary, "runs_data": run_rows}
        if include_results and payload_for_include is not None:
            out["final_run_results"] = payload_for_include.get("results", [])
        return jsonify(out)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 200


@app.route("/api/bpo_market_scan_stream", methods=["GET"])
def api_bpo_market_scan_stream():
    """
    Streaming SSE version of /api/bpo_market_scan.
    Emits progress events as contracts and items are fetched so the frontend
    can show a live progress bar.

    Events (all JSON in the `data` field):
        {"type":"status",    "msg": str}
        {"type":"contracts", "page": int, "total_pages": int, "contracts": int}
        {"type":"scanning",  "done": int, "total": int, "matched": int}
        {"type":"done",      "results": [...], "matched": int,
                             "pages_scanned": int, "contracts_checked": int}
        {"type":"error",     "msg": str}
    """
    region_id = int(request.args.get("region_id", 10000002))
    max_pages  = min(int(request.args.get("max_pages", 20)), 40)
    min_rps = float(request.args.get("min_rps", SCAN_MIN_RPS_DEFAULT))
    max_rps = float(request.args.get("max_rps", SCAN_MAX_RPS_DEFAULT))

    def _sse(data):
        return f"data: {json.dumps(data)}\n\n"

    def generate():
        import queue as _q
        import threading as _th
        _msg_q = _q.Queue()

        def _worker():
            try:
                _msg_q.put(_sse({"type": "status", "msg": "Loading blueprint database…"}))
                all_bp_ids, bp_info = _load_all_bp_info()
                if not all_bp_ids:
                    _msg_q.put(_sse({"type": "error", "msg": "Blueprint database (crest.db) not found — run seeder.py first."}))
                    return

                # Calculator data is optional enrichment
                calc_results = _get_scan_calc_results("Korsiki", "large")
                bpid_to_calc = _build_scan_bpid_map(calc_results) if calc_results else {}

                _msg_q.put(_sse({"type": "status", "msg": "Loading owned blueprint data…"}))
                personal_bp_ids, corp_bp_ids = _load_owned_bp_ids()

                # ── Use local cache when warm ──────────────────────────────────
                stats = _cc.get_stats(region_id)
                if stats["items_fetched"] > 0:
                    _msg_q.put(_sse({"type": "status", "msg": "Querying local contract cache…"}))
                    raw_matches  = _cc.query_bp_contracts(all_bp_ids, region_id=region_id)
                    best_by_bpid: dict = {}
                    for row in raw_matches:
                        match = {
                            "contract": {
                                "contract_id":       row["contract_id"],
                                "title":             row["title"],
                                "price":             row["price"],
                                "volume":            row["volume"],
                                "date_issued":       row["date_issued"],
                                "date_expired":      row["date_expired"],
                                "start_location_id": None,
                                "issuer_id":         None,
                            },
                            "type_id": row["type_id"],
                            "me":       row["material_efficiency"],
                            "te":       row["time_efficiency"],
                            "quantity": row["quantity"],
                            "is_bpc":   bool(row["is_blueprint_copy"]),
                            "runs":     row["runs"],
                        }
                        rrow     = _build_scan_result_row(
                            match, bpid_to_calc, personal_bp_ids, corp_bp_ids, bp_info
                        )
                        bpid     = rrow["blueprint_id"]
                        existing = best_by_bpid.get(bpid)
                        if existing is None:
                            rrow["listing_count"]  = 1
                            rrow["cheapest_price"] = rrow["price"]
                            best_by_bpid[bpid] = rrow
                        else:
                            existing["listing_count"] = existing.get("listing_count", 1) + 1
                            if rrow["price"] < existing["price"]:
                                rrow["listing_count"]  = existing["listing_count"]
                                rrow["cheapest_price"] = rrow["price"]
                                best_by_bpid[bpid]     = rrow
                    results = sorted(
                        best_by_bpid.values(),
                        key=lambda x: x.get("price", 0),
                    )
                    payload = {
                        "type":              "done",
                        "results":           results,
                        "matched":           len(results),
                        "raw_matches":       len(raw_matches),
                        "contracts_checked": stats["items_fetched"],
                        "pages_scanned":     0,
                        "bp_candidates":     stats["outstanding"],
                        "cache_stats":       stats,
                        "from_cache":        True,
                    }
                    _msg_q.put(_sse(payload))
                else:
                    # Cache still warming up — return empty done
                    _msg_q.put(_sse({
                        "type": "done",
                        "results": [],
                        "matched": 0,
                        "contracts_checked": 0,
                        "pages_scanned": 0,
                        "from_cache": True,
                        "cache_stats": stats,
                        "message": "Contract cache is still warming up — please wait.",
                    }))

            except Exception as e:
                import traceback
                traceback.print_exc()
                _msg_q.put(_sse({"type": "error", "msg": str(e)}))
            finally:
                _msg_q.put(None)

        _th.Thread(target=_worker, daemon=True).start()

        while True:
            try:
                item = _msg_q.get(timeout=20)
                if item is None:
                    break
                yield item
            except _q.Empty:
                yield ": keepalive\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":    "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def _get_scan_calc_results(system: str, facility: str):
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
            return None
    payload = _calc_cache.get(cache_key, {})
    _upgrade_calc_payload_formula(payload)
    return payload.get("results", [])


def _build_scan_bpid_map(calc_results: list) -> dict:
    bpid_to_calc = {}
    for row in calc_results:
        bpid = row.get("blueprint_id")
        if bpid:
            bpid_to_calc[bpid] = row
    return bpid_to_calc


def _load_owned_bp_ids() -> tuple[set, set]:
    with _OWNED_BP_CACHE_LOCK:
        age = time.time() - _OWNED_BP_CACHE.get("ts", 0.0)
        if age < _OWNED_BP_CACHE_TTL:
            return set(_OWNED_BP_CACHE.get("personal", set())), set(_OWNED_BP_CACHE.get("corp", set()))

    personal_bp_ids = set()
    corp_bp_ids = set(CORP_BPO_TYPE_IDS)
    try:
        from characters import get_all_auth_headers
        import requests as _req

        seen_corp_ids = set()
        for cid, headers in get_all_auth_headers():
            resp_p = _req.get(
                f"https://esi.evetech.net/latest/characters/{cid}/blueprints/",
                headers=headers,
                timeout=10,
            )
            if resp_p.ok:
                for bp in resp_p.json():
                    tid = bp.get("type_id")
                    if tid:
                        personal_bp_ids.add(tid)
            try:
                corp_resp = _req.get(
                    f"https://esi.evetech.net/latest/characters/{cid}/",
                    headers=headers,
                    timeout=8,
                )
                if not corp_resp.ok:
                    continue
                corp_id = corp_resp.json().get("corporation_id")
                if not corp_id or corp_id in seen_corp_ids:
                    continue
                seen_corp_ids.add(corp_id)
                page = 1
                while True:
                    cr = _req.get(
                        f"https://esi.evetech.net/latest/corporations/{corp_id}/blueprints/",
                        headers=headers,
                        params={"page": page},
                        timeout=15,
                    )
                    if not cr.ok:
                        break
                    page_bps = cr.json()
                    if not page_bps:
                        break
                    for bp in page_bps:
                        tid = bp.get("type_id")
                        if tid:
                            corp_bp_ids.add(tid)
                    if len(page_bps) < 1000:
                        break
                    page += 1
            except Exception:
                pass
    except Exception:
        pass
    with _OWNED_BP_CACHE_LOCK:
        _OWNED_BP_CACHE["ts"] = time.time()
        _OWNED_BP_CACHE["personal"] = set(personal_bp_ids)
        _OWNED_BP_CACHE["corp"] = set(corp_bp_ids)
    return personal_bp_ids, corp_bp_ids


# ── All-SDE blueprint info cache ──────────────────────────────────────────────
_ALL_BP_INFO_CACHE: dict | None = None

def _load_all_bp_info() -> tuple[set, dict]:
    """Return (all_bp_ids, bp_info) from crest.db blueprints table.

    bp_info maps blueprint_id → {name, output_id, category, tech, item_group}.
    Cached after the first call.
    """
    global _ALL_BP_INFO_CACHE
    if _ALL_BP_INFO_CACHE is not None:
        return _ALL_BP_INFO_CACHE

    import sqlite3 as _sql
    db_path = os.path.join(os.path.dirname(__file__), "crest.db")
    if not os.path.exists(db_path):
        _ALL_BP_INFO_CACHE = (set(), {})
        return _ALL_BP_INFO_CACHE

    conn = _sql.connect(db_path)
    conn.row_factory = _sql.Row
    rows = conn.execute(
        "SELECT blueprint_id, output_id, output_name, category, tech_level, item_group "
        "FROM blueprints"
    ).fetchall()
    conn.close()

    bp_info: dict = {}
    all_ids: set  = set()
    for r in rows:
        bpid = r["blueprint_id"]
        all_ids.add(bpid)
        bp_info[bpid] = {
            "name":      r["output_name"],
            "output_id": r["output_id"],
            "category":  r["category"] or "",
            "tech":      r["tech_level"] or "",
            "item_group": r["item_group"] or "",
        }
    _ALL_BP_INFO_CACHE = (all_ids, bp_info)
    return _ALL_BP_INFO_CACHE


def _build_scan_result_row(match: dict, bpid_to_calc: dict, personal_bp_ids: set, corp_bp_ids: set, bp_info: dict | None = None) -> dict:
    import math

    contract = match["contract"]
    bpid = match["type_id"]
    calc_row = bpid_to_calc.get(bpid, {})
    has_calc = bool(calc_row)
    sde_row = (bp_info or {}).get(bpid, {})
    output_id = calc_row.get("output_id") or sde_row.get("output_id")
    is_bpc = match.get("is_bpc", False)
    runs = match.get("runs", -1)
    price = contract.get("price", 0)
    net_profit_1r = calc_row.get("net_profit", 0)
    mat_cost_1r = calc_row.get("material_cost", 0)
    gross_rev_1r = calc_row.get("gross_revenue", 0)

    if has_calc and is_bpc and runs > 0:
        cost_per_run = price / runs
        adj_net_profit_1r = net_profit_1r - cost_per_run
        total_cost_1r = mat_cost_1r + cost_per_run
        adj_roi = (adj_net_profit_1r / total_cost_1r * 100) if total_cost_1r > 0 else 0
        total_adj_profit = adj_net_profit_1r * runs
        can_breakeven = adj_net_profit_1r > 0
        breakeven_runs = math.ceil(price / net_profit_1r) if net_profit_1r > 0 else None
        bpc_feasible = (breakeven_runs is not None and breakeven_runs <= runs)
    elif has_calc:
        adj_net_profit_1r = net_profit_1r
        adj_roi = calc_row.get("roi", 0)
        total_adj_profit = None
        can_breakeven = True
        breakeven_runs = math.ceil(price / net_profit_1r) if net_profit_1r > 0 else None
        bpc_feasible = True
        runs = -1
    else:
        # No calculator data — show listing info only
        adj_net_profit_1r = 0
        adj_roi = 0
        total_adj_profit = None
        can_breakeven = True
        breakeven_runs = None
        bpc_feasible = True
        if not is_bpc:
            runs = -1

    return {
        "blueprint_id": bpid,
        "output_id": output_id,
        "name": calc_row.get("name") or sde_row.get("name", "?"),
        "me": match.get("me", 0),
        "te": match.get("te", 0),
        "is_bpc": is_bpc,
        "runs": runs,
        "contract_id": contract.get("contract_id"),
        "price": price,
        "location_id": contract.get("start_location_id"),
        "issuer_id": contract.get("issuer_id"),
        "expires": contract.get("date_expired", ""),
        "already_owned": bpid in corp_bp_ids or bpid in personal_bp_ids,
        "net_profit": net_profit_1r,
        "roi": calc_row.get("roi", 0),
        "isk_per_hour": calc_row.get("isk_per_hour", 0),
        "material_cost": mat_cost_1r,
        "gross_revenue": gross_rev_1r,
        "category": calc_row.get("category") or sde_row.get("category", ""),
        "tech": calc_row.get("tech") or sde_row.get("tech", ""),
        "adj_net_profit": round(adj_net_profit_1r, 2),
        "adj_roi": round(adj_roi, 2),
        "total_adj_profit": round(total_adj_profit, 2) if total_adj_profit is not None else None,
        "can_breakeven": can_breakeven,
        "bpc_feasible": bpc_feasible,
        "breakeven_runs": breakeven_runs,
        "has_calc_data": has_calc,
    }


def _run_blueprint_contract_scan(
    *,
    region_id: int,
    max_pages: int,
    wanted_bp_ids: set,
    bpid_to_calc: dict,
    personal_bp_ids: set,
    corp_bp_ids: set,
    progress_cb=None,
    min_rps: float | None = None,
    max_rps: float | None = None,
) -> dict:
    import requests as _req
    from concurrent.futures import ThreadPoolExecutor, as_completed

    ESI_BASE = "https://esi.evetech.net/latest"
    session = _req.Session()
    adapter = _req.adapters.HTTPAdapter(pool_connections=24, pool_maxsize=24, max_retries=0)
    session.mount("https://", adapter)
    session.mount("http://", adapter)

    retry_count = 0
    error_count = 0
    cache_hits = 0
    item_requests = 0
    backoff_until = [0.0]
    backoff_lock = threading.Lock()
    rate_lock = threading.Lock()
    next_slot = [time.time()]
    _min_rps = float(min_rps if min_rps is not None else SCAN_MIN_RPS_DEFAULT)
    _max_rps = float(max_rps if max_rps is not None else SCAN_MAX_RPS_DEFAULT)
    _min_rps = max(SCAN_MIN_RPS_LIMITS[0], min(SCAN_MIN_RPS_LIMITS[1], _min_rps))
    _max_rps = max(SCAN_MAX_RPS_LIMITS[0], min(SCAN_MAX_RPS_LIMITS[1], _max_rps))
    if _max_rps <= _min_rps:
        _max_rps = min(SCAN_MAX_RPS_LIMITS[1], _min_rps + 1.0)
    min_interval = 1.0 / _max_rps
    max_interval = 1.0 / _min_rps
    slot_interval = [1.0 / ((2 * _min_rps + _max_rps) / 3.0)]

    def _emit(msg: dict):
        if progress_cb:
            progress_cb(msg)

    def _wait_rate_slot():
        while True:
            with rate_lock:
                now = time.time()
                if now >= next_slot[0]:
                    next_slot[0] = now + slot_interval[0]
                    return
                wait_for = max(0.01, next_slot[0] - now)
            time.sleep(wait_for)

    def _request_get(url: str, *, params=None, timeout=(6, 12), allow_404=False):
        nonlocal retry_count, error_count
        max_attempts = 4
        for attempt in range(max_attempts):
            while backoff_until[0] > time.time():
                time.sleep(0.5)
            _wait_rate_slot()
            try:
                resp = session.get(url, params=params, timeout=timeout)
                try:
                    remain = int(resp.headers.get("X-ESI-Error-Limit-Remain", 100))
                except Exception:
                    remain = 100
                if remain < 15:
                    slot_interval[0] = max_interval
                elif remain < 30:
                    slot_interval[0] = min(max_interval, max(min_interval, slot_interval[0] * 1.4))
                elif remain > 60:
                    slot_interval[0] = min_interval

                if resp.status_code in (420, 429):
                    retry_count += 1
                    reset = resp.headers.get("X-ESI-Error-Limit-Reset") or resp.headers.get("Retry-After") or "8"
                    try:
                        wait_s = min(max(float(reset), 1.0) + 1.0, 60.0)
                    except Exception:
                        wait_s = 8.0
                    with backoff_lock:
                        backoff_until[0] = max(backoff_until[0], time.time() + wait_s)
                    continue

                if resp.status_code == 404 and allow_404:
                    return None, 404

                if resp.status_code >= 500 and attempt < max_attempts - 1:
                    retry_count += 1
                    time.sleep(1.3 * (2 ** attempt))
                    continue

                if not resp.ok:
                    error_count += 1
                    return None, resp.status_code
                return resp, resp.status_code
            except Exception:
                if attempt < max_attempts - 1:
                    retry_count += 1
                    time.sleep(1.3 * (2 ** attempt))
                    continue
                error_count += 1
                return None, 0
        return None, 0

    first_resp, first_status = _request_get(
        f"{ESI_BASE}/contracts/public/{region_id}/",
        params={"page": 1},
        timeout=(6, 14),
        allow_404=True,
    )
    if first_status not in (200, 404) or first_resp is None:
        raise RuntimeError("Failed to load contracts from ESI.")

    total_pages = min(int(first_resp.headers.get("X-Pages", 1)), max_pages)
    all_contracts = [c for c in first_resp.json() if c.get("type") == "item_exchange"]
    _emit({"type": "contracts", "page": 1, "total_pages": total_pages, "contracts": len(all_contracts)})

    def _fetch_page(page: int):
        resp, status = _request_get(
            f"{ESI_BASE}/contracts/public/{region_id}/",
            params={"page": page},
            timeout=(6, 12),
            allow_404=True,
        )
        if status == 404 or resp is None:
            return page, []
        return page, [c for c in resp.json() if c.get("type") == "item_exchange"]

    if total_pages > 1:
        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = {pool.submit(_fetch_page, p): p for p in range(2, total_pages + 1)}
            for fut in as_completed(futures):
                page, page_data = fut.result()
                all_contracts.extend(page_data)
                _emit({"type": "contracts", "page": page, "total_pages": total_pages, "contracts": len(all_contracts)})

    contracts_checked = len(all_contracts)

    # ── Build a set of known blueprint item names for title matching ────────
    # Load once per scan from crest.db: all output_names get " Blueprint" suffix
    # appended to match typical EVE contract titles (e.g. "Hammerhead II Blueprint").
    _bp_title_keywords: set[str] = set()
    try:
        import sqlite3 as _sq
        _cdb = os.path.join(_HERE, "crest.db")
        if os.path.exists(_cdb):
            _c = _sq.connect(_cdb)
            for (nm,) in _c.execute("SELECT LOWER(output_name) FROM blueprints").fetchall():
                _bp_title_keywords.add(nm + " blueprint")
            _c.close()
    except Exception:
        pass

    # Retrieve the timestamp of the previous completed scan so we can skip
    # contracts that were already fetched and cached.
    global _LAST_CONTRACT_SCAN_TS
    with _LAST_CONTRACT_SCAN_LOCK:
        _prev_scan_ts = _LAST_CONTRACT_SCAN_TS
    scan_started_ts = time.time()

    def _is_new_contract(c: dict) -> bool:
        """Return True if the contract was issued after the last completed scan."""
        if _prev_scan_ts == 0.0:
            return True
        issued_str = c.get("date_issued", "")
        if not issued_str:
            return True
        try:
            from datetime import datetime, timezone
            issued_ts = datetime.fromisoformat(issued_str.rstrip("Z")).replace(
                tzinfo=timezone.utc
            ).timestamp()
            return issued_ts >= _prev_scan_ts
        except Exception:
            return True

    def _title_looks_like_bp(title: str) -> bool:
        """Return True when a contract title looks like a blueprint listing."""
        if not title:
            return True   # untitled contracts are uncategorised — keep them
        tl = title.lower()
        # Direct keyword hit
        if "blueprint" in tl or " bpo" in tl or " bpc" in tl:
            return True
        # Check against known BP names loaded from crest.db
        if _bp_title_keywords and tl in _bp_title_keywords:
            return True
        return False

    # Keep full profitable coverage while reducing unnecessary item calls.
    # Filters applied in order of cheapness:
    #   1. Volume ≤ 1 000 m3  (blueprints are small; ships / freighters are huge)
    #   2. Status outstanding  (expired / deleted contracts waste an item call)
    #   3. Price floor > 1 M ISK  (zero-cost gifts and junk; no BP costs less)
    #   4. Title looks like a blueprint (eliminates implants, PLEX, modules, etc.)
    bp_candidates = [
        c for c in all_contracts
        if c.get("volume", 9999) <= 1000
        and c.get("status", "outstanding") == "outstanding"
        and (c.get("price") or 0) >= 1_000_000
        and _title_looks_like_bp(c.get("title", ""))
    ]
    # Sort newest first so the most actionable listings are processed first.
    bp_candidates.sort(key=lambda x: x.get("date_issued", ""), reverse=True)

    # Split into new (never seen) vs. previously-cached contracts.
    new_candidates  = [c for c in bp_candidates if _is_new_contract(c)]
    seen_candidates = [c for c in bp_candidates if not _is_new_contract(c)]
    # Seen contracts are very likely already in _CONTRACT_ITEMS_CACHE; process
    # them last so new listings are surfaced first and progress looks snappy.
    ordered_candidates = new_candidates + seen_candidates

    _emit({"type": "scanning", "done": 0, "total": len(ordered_candidates), "matched": 0})

    def _fetch_contract_matches(contract: dict):
        contract_id = contract.get("contract_id")
        if not contract_id:
            return []
        nonlocal cache_hits, item_requests
        now_ts = time.time()

        # Calculate per-entry TTL from the contract's expiry date.
        # A contract that expires in 3 days only needs to stay cached for 3 days;
        # once expired the cache entry naturally becomes unreachable anyway.
        def _entry_ttl(c: dict) -> float:
            expiry_str = c.get("date_expired", "")
            if expiry_str:
                try:
                    from datetime import datetime, timezone
                    expiry_ts = datetime.fromisoformat(expiry_str.rstrip("Z")).replace(
                        tzinfo=timezone.utc
                    ).timestamp()
                    return max(60.0, expiry_ts - now_ts)
                except Exception:
                    pass
            return float(_CONTRACT_ITEMS_CACHE_TTL)  # 24 h fallback

        with _CONTRACT_ITEMS_CACHE_LOCK:
            cached = _CONTRACT_ITEMS_CACHE.get(contract_id)
            if cached:
                entry_ttl = cached.get("ttl", _CONTRACT_ITEMS_CACHE_TTL)
                if (now_ts - cached.get("ts", 0.0)) < entry_ttl:
                    cache_hits += 1
                    return list(cached.get("matches", []))

        item_requests += 1
        resp, _ = _request_get(
            f"{ESI_BASE}/contracts/public/items/{contract_id}/",
            timeout=(5, 10),
            allow_404=True,
        )
        if resp is None:
            return []
        out = []
        for item in (resp.json() or []):
            tid = item.get("type_id")
            if tid in wanted_bp_ids and item.get("is_included", True):
                out.append({
                    "contract": contract,
                    "type_id": tid,
                    "me": item.get("material_efficiency", 0),
                    "te": item.get("time_efficiency", 0),
                    "quantity": item.get("quantity", 1),
                    "is_bpc": item.get("is_blueprint_copy", False),
                    "runs": item.get("runs", -1),
                })
        with _CONTRACT_ITEMS_CACHE_LOCK:
            _CONTRACT_ITEMS_CACHE[contract_id] = {
                "ts":      now_ts,
                "ttl":     _entry_ttl(contract),
                "matches": list(out),
            }
        return out

    best_by_bpid = {}
    raw_match_count = 0
    done_count = 0
    report_every = max(1, len(ordered_candidates) // 100) if ordered_candidates else 1

    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = [pool.submit(_fetch_contract_matches, c) for c in ordered_candidates]
        for fut in as_completed(futures):
            done_count += 1
            matches = fut.result()
            for match in matches:
                raw_match_count += 1
                row = _build_scan_result_row(match, bpid_to_calc, personal_bp_ids, corp_bp_ids)
                bpid = row["blueprint_id"]
                current = best_by_bpid.get(bpid)
                if current is None:
                    row["listing_count"] = 1
                    row["cheapest_price"] = row.get("price", 0)
                    best_by_bpid[bpid] = row
                else:
                    listing_count = current.get("listing_count", 1) + 1
                    if row.get("price", 0) < current.get("price", 0):
                        row["listing_count"] = listing_count
                        row["cheapest_price"] = row.get("price", 0)
                        best_by_bpid[bpid] = row
                    else:
                        current["listing_count"] = listing_count
            if done_count % report_every == 0 or done_count == len(ordered_candidates):
                _emit({
                    "type": "scanning",
                    "done": done_count,
                    "total": len(ordered_candidates),
                    "matched": raw_match_count,
                })

    # Record this scan's start time so the next scan can skip already-seen contracts.
    with _LAST_CONTRACT_SCAN_LOCK:
        _LAST_CONTRACT_SCAN_TS = scan_started_ts

    results = list(best_by_bpid.values())
    results.sort(key=lambda x: (
        0 if x.get("can_breakeven", True) else 1,
        -(x.get("adj_net_profit", 0)),
    ))
    return {
        "results":          results,
        "matched":          len(results),
        "pages_scanned":    total_pages,
        "contracts_checked": contracts_checked,
        "bp_candidates":    len(ordered_candidates),
        "bp_new":           len(new_candidates),
        "bp_cached":        len(seen_candidates),
        "raw_matches":      raw_match_count,
        "retries":          retry_count,
        "request_errors":   error_count,
        "item_requests":    item_requests,
        "item_cache_hits":  cache_hits,
        "min_rps":          round(_min_rps, 2),
        "max_rps":          round(_max_rps, 2),
    }


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

        pass  # request already imported at top2
        body     = request.get_json(force=True, silent=True) or {}
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


# ── ESI response caches (TTL-based, avoid hammering ESI on every page load) ──
_ESI_BP_CACHE:      dict  = {}
_ESI_BP_CACHE_TS:   float = 0
_ESI_BP_TTL               = 300   # 5 min

_ESI_JOBS_CACHE:    dict  = {}
_ESI_JOBS_CACHE_TS: float = 0
_ESI_JOBS_TTL             = 120   # 2 min

_QUEUE_SUMMARY_CACHE:    dict  = {}
_QUEUE_SUMMARY_CACHE_TS: float = 0
_QUEUE_SUMMARY_TTL             = 120  # 2 min

# Scored queue-planner candidates — written by /api/queue, read by /api/queue-summary
# so the footer always reflects exactly the items the queue planner scored/filtered.
_QUEUE_PLANNER_CANDIDATES_CACHE: list  = []
_QUEUE_PLANNER_CANDIDATES_TS:    float = 0

# max_jobs (character skill fetch) cached longer — skills barely change
_MAX_JOBS_CACHE:    int   = 0
_MAX_JOBS_CACHE_TS: float = 0.0
_MAX_JOBS_TTL             = 1800  # 30 min

# science/research slots cached alongside mfg slots
_MAX_SCIENCE_JOBS_CACHE:    int   = 0
_MAX_SCIENCE_JOBS_CACHE_TS: float = 0.0
_COPY_TIME_MODIFIER:        float = 1.0   # best copy-time skill modifier across all characters
_TYPE_VOLUME_CACHE: dict       = {}   # type_id → packaged volume m³, persistent until restart

_ESI_ORDERS_CACHE:    dict  = {}
_ESI_ORDERS_CACHE_TS: float = 0
_ESI_ORDERS_TTL             = 120   # 2 min
_LAST_SELL_POS_BY_ORDER: dict[int, int] = {}


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
    Cached for 5 minutes. Personal blueprint fetches are parallelised across characters.
    """
    global _ESI_BP_CACHE, _ESI_BP_CACHE_TS
    try:
        pass  # request already imported at top
        force = request.args.get("force", "0") == "1"
        if not force and _ESI_BP_CACHE and (time.time() - _ESI_BP_CACHE_TS) < _ESI_BP_TTL:
            return jsonify(_ESI_BP_CACHE)

        from characters import get_all_auth_headers, load_characters
        from concurrent.futures import ThreadPoolExecutor, as_completed
        import requests as req

        char_records = load_characters()
        auth_headers = get_all_auth_headers()

        # ── Parallel fetch: personal BPs + character info for all chars at once ──
        def _fetch_personal(cid, headers):
            char_name = char_records.get(cid, {}).get("character_name", f"Char {cid}")
            bps_out = []
            corp_id = None
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
                        bps_out.append(bp)
            except Exception as e:
                print(f"  [esi-bps] personal failed for {char_name}: {e}")
            try:
                cr = req.get(f"https://esi.evetech.net/latest/characters/{cid}/", timeout=10)
                if cr.ok:
                    corp_id = cr.json().get("corporation_id")
            except Exception:
                pass
            return cid, char_name, headers, bps_out, corp_id

        all_bps = []
        char_corp_info = []  # [(cid, char_name, headers, corp_id), ...]

        with ThreadPoolExecutor(max_workers=len(auth_headers)) as pool:
            futures = [pool.submit(_fetch_personal, cid, h) for cid, h in auth_headers]
            for f in as_completed(futures):
                cid, char_name, headers, bps, corp_id = f.result()
                all_bps.extend(bps)
                if corp_id:
                    char_corp_info.append((cid, char_name, headers, corp_id))

        # ── Corp blueprints (deduplicated by corp_id) ──
        seen_corp_ids = set()
        for cid, char_name, headers, corp_id in char_corp_info:
            if corp_id in seen_corp_ids:
                continue
            seen_corp_ids.add(corp_id)
            esi_corp_ok = False
            page = 1
            while True:
                try:
                    cr = req.get(
                        f"https://esi.evetech.net/latest/corporations/{corp_id}/blueprints/",
                        headers=headers, params={"page": page}, timeout=15
                    )
                except Exception:
                    break
                if not cr.ok:
                    break
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
            if not esi_corp_ok and CORP_BPO_TYPE_IDS:
                print(f"  [esi-bps] ESI corp fetch failed for {char_name} — using static corp_BPOs fallback ({len(CORP_BPO_TYPE_IDS)} BPOs)")
                for tid in CORP_BPO_TYPE_IDS:
                    all_bps.append({
                        "type_id": tid, "material_efficiency": 10, "time_efficiency": 20,
                        "runs": -1, "location_id": None, "quantity": 1,
                        "_character_id": cid, "_character_name": char_name,
                        "_owner": "corp", "_corp_id": corp_id,
                    })

        if not all_bps:
            return jsonify({"blueprints": []})

        # Resolve type names — try crest.db first (instant), ESI for remainder
        type_ids = list({bp["type_id"] for bp in all_bps})
        names = {}
        try:
            import sqlite3 as _sq
            conn = _sq.connect(os.path.join(os.path.dirname(__file__), "crest.db"))
            ph = ",".join("?" * len(type_ids))
            for row in conn.execute(f"SELECT blueprint_id, output_name FROM blueprints WHERE blueprint_id IN ({ph})", type_ids).fetchall():
                names[row[0]] = row[1] + " Blueprint"
            conn.close()
        except Exception:
            pass

        missing = [tid for tid in type_ids if tid not in names]
        if missing:
            for i in range(0, len(missing), 1000):
                chunk = missing[i:i+1000]
                try:
                    nr = req.post("https://esi.evetech.net/latest/universe/names/", json=chunk, timeout=10)
                    if nr.ok:
                        for item in nr.json():
                            names[item["id"]] = item["name"]
                except Exception:
                    pass

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
        _ESI_BP_CACHE = {"blueprints": result, "count": len(result)}
        _ESI_BP_CACHE_TS = time.time()
        return jsonify(_ESI_BP_CACHE)

    except Exception as e:
        return jsonify({"error": str(e), "blueprints": []}), 200


# ── Character Assets ──────────────────────────────────────────────────────────
_ASSETS_CACHE:    dict  = {}
_ASSETS_CACHE_TS: float = 0
_ASSETS_TTL = 300  # 5 minutes

@app.route("/api/assets", methods=["GET"])
def api_assets():
    """
    Return assets for ALL authenticated characters as { type_id: total_quantity } plus name map.
    Aggregates quantities across all characters in parallel.
    Response: { assets: {type_id: qty}, names: {type_id: name}, cached_at: ts }
    """
    global _ASSETS_CACHE, _ASSETS_CACHE_TS
    try:
        pass  # request already imported at top
        force = request.args.get("force", "0") == "1"
        if not force and _ASSETS_CACHE and (time.time() - _ASSETS_CACHE_TS) < _ASSETS_TTL:
            return jsonify(_ASSETS_CACHE)

        from characters import get_all_auth_headers, load_characters
        from concurrent.futures import ThreadPoolExecutor, as_completed
        import requests as req

        char_records = load_characters()
        auth_headers = get_all_auth_headers()

        def _fetch_char_assets(cid, headers):
            char_name = char_records.get(cid, {}).get("character_name", f"Char {cid}")
            items = []
            page = 1
            while True:
                try:
                    resp = req.get(
                        f"https://esi.evetech.net/latest/characters/{cid}/assets/",
                        headers=headers, params={"page": page}, timeout=15
                    )
                    if not resp.ok:
                        print(f"  [assets] ESI {resp.status_code} for {char_name} page {page}: {resp.text[:200]}")
                        break
                    page_items = resp.json()
                    if not page_items:
                        break
                    items.extend(page_items)
                    if len(page_items) < 1000:
                        break
                    page += 1
                except Exception as e:
                    print(f"  [assets] Failed for {char_name}: {e}")
                    break
            return items

        from collections import defaultdict
        inventory: dict = defaultdict(int)

        bpc_type_ids: set = set()  # blueprint type_ids that exist as BPCs in character assets

        with ThreadPoolExecutor(max_workers=max(1, len(auth_headers))) as pool:
            futures = [pool.submit(_fetch_char_assets, cid, h) for cid, h in auth_headers]
            for f in as_completed(futures):
                for item in f.result():
                    inventory[item["type_id"]] += item["quantity"]
                    if item.get("is_blueprint_copy"):
                        bpc_type_ids.add(item["type_id"])

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
            "bpc_type_ids": list(bpc_type_ids),
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
    Cached for 2 minutes. Personal + corp job fetches parallelised across characters.
    """
    global _ESI_JOBS_CACHE, _ESI_JOBS_CACHE_TS
    try:
        pass  # request already imported at top
        force = request.args.get("force", "0") == "1"
        if not force and _ESI_JOBS_CACHE and (time.time() - _ESI_JOBS_CACHE_TS) < _ESI_JOBS_TTL:
            # Update seconds_remaining in-place for cached results
            now_ts = int(time.time())
            for j in _ESI_JOBS_CACHE.get("jobs", []):
                j["seconds_remaining"] = max(0, j["end_ts"] - now_ts)
            return jsonify(_ESI_JOBS_CACHE)

        from characters import get_all_auth_headers, load_characters
        from concurrent.futures import ThreadPoolExecutor, as_completed
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

        char_records = load_characters()
        auth_headers = get_all_auth_headers()
        our_char_ids = {int(k) for k in char_records.keys()}

        # ── Parallel fetch: personal jobs + char info for corp_id ──
        def _fetch_char_jobs(cid, headers):
            char_name = char_records.get(cid, {}).get("character_name", f"Char {cid}")
            personal = []
            corp_id = None
            try:
                resp = req.get(
                    f"https://esi.evetech.net/latest/characters/{cid}/industry/jobs/",
                    headers=headers, params={"include_completed": False}, timeout=15,
                )
                if resp.ok:
                    for j in resp.json():
                        j["_character_id"]   = cid
                        j["_character_name"] = char_name
                        personal.append(j)
            except Exception as e:
                print(f"  [jobs] Failed for {char_name}: {e}")
            try:
                cr = req.get(f"https://esi.evetech.net/latest/characters/{cid}/", timeout=10)
                if cr.ok:
                    corp_id = cr.json().get("corporation_id")
            except Exception:
                pass
            return cid, char_name, headers, personal, corp_id

        all_jobs = []
        seen_job_ids = set()
        char_corp_info = []

        with ThreadPoolExecutor(max_workers=len(auth_headers)) as pool:
            futures = [pool.submit(_fetch_char_jobs, cid, h) for cid, h in auth_headers]
            for f in as_completed(futures):
                cid, char_name, headers, personal, corp_id = f.result()
                for j in personal:
                    jid = j.get("job_id")
                    if jid and jid not in seen_job_ids:
                        seen_job_ids.add(jid)
                        all_jobs.append(j)
                if corp_id:
                    char_corp_info.append((cid, char_name, headers, corp_id))

        # ── Corp jobs (deduplicated by corp_id) ──
        seen_corp_ids_jobs = set()
        for cid, char_name, headers, corp_id in char_corp_info:
            if corp_id in seen_corp_ids_jobs:
                continue
            try:
                cresp = req.get(
                    f"https://esi.evetech.net/latest/corporations/{corp_id}/industry/jobs/",
                    headers=headers, params={"include_completed": False}, timeout=15,
                )
                if cresp.ok:
                    seen_corp_ids_jobs.add(corp_id)
                    for j in cresp.json():
                        installer_id = j.get("installer_id")
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

        # ── Name resolution ──
        product_ids = list({j.get("product_type_id") for j in all_jobs if j.get("product_type_id")})
        names = {}
        if product_ids:
            for i in range(0, len(product_ids), 1000):
                try:
                    nr = req.post("https://esi.evetech.net/latest/universe/names/",
                                  json=product_ids[i:i+1000], timeout=10)
                    if nr.ok:
                        for item in nr.json():
                            names[item["id"]] = item["name"]
                except Exception:
                    pass

        # ── Market prices for manufacturing/reaction outputs ──
        mfg_activity_ids = {1, 11}
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

        # ── Material cost lookup (single pass, batched queries) ──
        material_cost_per_unit: dict[int, float] = {}
        if mfg_product_ids:
            try:
                import sqlite3 as _sqlite3
                _cdb = _sqlite3.connect(os.path.join(os.path.dirname(__file__), "crest.db"))
                _cdb.row_factory = _sqlite3.Row

                # 1) Bulk-fetch bp_id → output_id mapping
                ph = ",".join("?" * len(mfg_product_ids))
                bp_map = {}  # output_id → blueprint_id
                for row in _cdb.execute(
                    f"SELECT output_id, blueprint_id FROM blueprints WHERE output_id IN ({ph})",
                    mfg_product_ids
                ).fetchall():
                    bp_map[row["output_id"]] = row["blueprint_id"]

                # 2) Bulk-fetch all materials for those blueprints
                bp_ids = list(set(bp_map.values()))
                bp_mats: dict[int, list] = {}  # blueprint_id → [(mat_type_id, qty), ...]
                if bp_ids:
                    ph2 = ",".join("?" * len(bp_ids))
                    for row in _cdb.execute(
                        f"SELECT blueprint_id, material_type_id, base_quantity FROM blueprint_materials WHERE blueprint_id IN ({ph2})",
                        bp_ids
                    ).fetchall():
                        bp_mats.setdefault(row["blueprint_id"], []).append(
                            (row["material_type_id"], row["base_quantity"])
                        )
                _cdb.close()

                # 3) Collect all unique material type_ids and fetch any missing prices
                all_mat_ids = set()
                for mats in bp_mats.values():
                    for mid, _ in mats:
                        all_mat_ids.add(mid)
                missing_mat_ids = all_mat_ids - set(market_prices.keys())
                if missing_mat_ids:
                    from pricer import get_prices_bulk as _gpb
                    market_prices.update(_gpb(list(missing_mat_ids)))

                # 4) Compute costs in one pass
                for pid in mfg_product_ids:
                    bpid = bp_map.get(pid)
                    if not bpid or bpid not in bp_mats:
                        continue
                    cost = 0.0
                    for mid, qty in bp_mats[bpid]:
                        mp = market_prices.get(mid)
                        if mp and mp.get("sell"):
                            cost += mp["sell"] * qty
                        else:
                            cost = None
                            break
                    if cost is not None:
                        material_cost_per_unit[pid] = cost

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
            pid = j.get("product_type_id") or (j.get("blueprint_type_id") if activity_id == 5 else None)
            runs = j.get("runs", 1)
            p = market_prices.get(pid) if pid else None
            sell_price = p["sell"] if p and p.get("sell") else None
            result.append({
                "job_id":            j.get("job_id"),
                "activity":          ACTIVITY_NAMES.get(activity_id, f"Activity {activity_id}"),
                "activity_id":       activity_id,
                "product_type_id":   pid,
                "blueprint_type_id": j.get("blueprint_type_id"),
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

        result.sort(key=lambda x: x["seconds_remaining"])
        _ESI_JOBS_CACHE = {"jobs": result, "count": len(result)}
        _ESI_JOBS_CACHE_TS = time.time()
        return jsonify(_ESI_JOBS_CACHE)

    except Exception as e:
        return jsonify({"error": str(e), "jobs": []}), 200


# ── Craft Log ─────────────────────────────────────────────────────────────────
@app.route("/api/craft-log", methods=["GET"])
def api_craft_log():
    """
    Fetch delivered manufacturing jobs from ESI (last 90 days), enrich with
    material cost + est profit, upsert into craft_log, and return all rows.
    """
    try:
        pass  # request already imported at top
        from characters import get_all_auth_headers, load_characters
        from concurrent.futures import ThreadPoolExecutor, as_completed
        import requests as req
        from datetime import datetime, timezone

        days = int(request.args.get("days", 90))
        force = request.args.get("force", "0") == "1"

        # Only re-fetch from ESI when forced (expensive); otherwise just return DB
        if force:
            char_records = load_characters()
            auth_headers = get_all_auth_headers()
            our_char_ids = {int(k) for k in char_records.keys()}

            ACTIVITY_NAMES = {
                1: "Manufacturing", 3: "TE Research", 4: "ME Research",
                5: "Copying", 8: "Invention", 9: "Reactions", 11: "Reaction",
            }

            def _fetch_completed(cid, headers):
                char_name = char_records.get(cid, {}).get("character_name", f"Char {cid}")
                jobs = []
                try:
                    r = req.get(
                        f"https://esi.evetech.net/latest/characters/{cid}/industry/jobs/",
                        headers=headers, params={"include_completed": True}, timeout=20,
                    )
                    if r.ok:
                        for j in r.json():
                            if j.get("status") == "delivered" and j.get("activity_id") in (1, 9, 11):
                                j["_char_id"] = cid
                                j["_char_name"] = char_name
                                jobs.append(j)
                except Exception as e:
                    print(f"  [craft-log] ESI failed for {char_name}: {e}")
                return jobs

            raw_jobs = []
            seen_ids = set()
            with ThreadPoolExecutor(max_workers=len(auth_headers)) as pool:
                futures = [pool.submit(_fetch_completed, cid, h) for cid, h in auth_headers]
                for f in as_completed(futures):
                    for j in f.result():
                        jid = j.get("job_id")
                        if jid and jid not in seen_ids:
                            seen_ids.add(jid)
                            raw_jobs.append(j)

            if raw_jobs:
                # Name + price resolution (reuse active-jobs logic)
                product_ids = list({j.get("product_type_id") for j in raw_jobs if j.get("product_type_id")})
                names, market_prices = {}, {}
                if product_ids:
                    for i in range(0, len(product_ids), 1000):
                        try:
                            nr = req.post("https://esi.evetech.net/latest/universe/names/",
                                          json=product_ids[i:i+1000], timeout=10)
                            if nr.ok:
                                for item in nr.json():
                                    names[item["id"]] = item["name"]
                        except Exception:
                            pass
                    try:
                        from pricer import get_prices_bulk
                        market_prices = get_prices_bulk(product_ids)
                    except Exception:
                        pass

                # Material costs
                mat_cost_per_unit: dict[int, float] = {}
                try:
                    import sqlite3 as _sq
                    _cdb = _sq.connect(os.path.join(os.path.dirname(__file__), "crest.db"))
                    _cdb.row_factory = _sq.Row
                    ph = ",".join("?" * len(product_ids))
                    bp_map = {row["output_id"]: row["blueprint_id"] for row in _cdb.execute(
                        f"SELECT output_id, blueprint_id FROM blueprints WHERE output_id IN ({ph})",
                        product_ids).fetchall()}
                    bp_ids = list(set(bp_map.values()))
                    bp_mats: dict = {}
                    if bp_ids:
                        ph2 = ",".join("?" * len(bp_ids))
                        for row in _cdb.execute(
                            f"SELECT blueprint_id, material_type_id, base_quantity FROM blueprint_materials WHERE blueprint_id IN ({ph2})",
                            bp_ids).fetchall():
                            bp_mats.setdefault(row["blueprint_id"], []).append(
                                (row["material_type_id"], row["base_quantity"]))
                    _cdb.close()
                    all_mat_ids = {mid for mats in bp_mats.values() for mid, _ in mats}
                    missing = all_mat_ids - set(market_prices.keys())
                    if missing:
                        from pricer import get_prices_bulk as _gpb
                        market_prices.update(_gpb(list(missing)))
                    for pid in product_ids:
                        bpid = bp_map.get(pid)
                        if not bpid or bpid not in bp_mats:
                            continue
                        cost = 0.0
                        for mid, qty in bp_mats[bpid]:
                            mp = market_prices.get(mid)
                            if mp and mp.get("sell"):
                                cost += mp["sell"] * qty
                            else:
                                cost = None
                                break
                        if cost is not None:
                            mat_cost_per_unit[pid] = cost
                except Exception as _e:
                    print(f"  [craft-log] mat cost failed: {_e}")

                to_store = []
                for j in raw_jobs:
                    pid   = j.get("product_type_id")
                    runs  = j.get("runs", 1)
                    p     = market_prices.get(pid) if pid else None
                    sell  = p["sell"] if p and p.get("sell") else None
                    cpu   = mat_cost_per_unit.get(pid)
                    mat   = round(cpu * runs, 2) if cpu is not None else None
                    rev   = round(sell * runs, 2) if sell is not None else None
                    prof  = round(rev - mat, 2) if (rev is not None and mat is not None) else None
                    mgn   = round(prof / mat * 100, 2) if (prof is not None and mat and mat > 0) else None
                    to_store.append({
                        "job_id":          j.get("job_id"),
                        "char_id":         j["_char_id"],
                        "char_name":       j["_char_name"],
                        "product_type_id": pid,
                        "product_name":    names.get(pid, f"Type {pid}") if pid else "—",
                        "activity_id":     j.get("activity_id"),
                        "activity":        ACTIVITY_NAMES.get(j.get("activity_id"), "Unknown"),
                        "runs":            runs,
                        "material_cost":   mat,
                        "sell_price":      sell,
                        "est_profit":      prof,
                        "margin_pct":      mgn,
                        "completed_at":    j.get("end_date", ""),
                    })
                upsert_craft_jobs(to_store)

        log = get_craft_log(days=days)
        return jsonify({"log": log, "count": len(log)})

    except Exception as e:
        return jsonify({"error": str(e), "log": []}), 200


@app.route("/api/craft-stats", methods=["GET"])
def api_craft_stats():
    """Return aggregated craft profitability stats from the local DB."""
    try:
        pass  # request already imported at top
        days = int(request.args.get("days", 90))
        return jsonify(get_craft_stats(days=days))
    except Exception as e:
        return jsonify({"error": str(e)}), 200


# ── Shared max manufacturing slots (cached 30 min, used by queue-summary + top-performers) ──
def _get_max_jobs(running_fallback: int = 0) -> int:
    """Return sum of manufacturing slots across all characters, refreshed every 30 min."""
    global _MAX_JOBS_CACHE, _MAX_JOBS_CACHE_TS
    if _MAX_JOBS_CACHE > 0 and (time.time() - _MAX_JOBS_CACHE_TS) < _MAX_JOBS_TTL:
        return _MAX_JOBS_CACHE
    MASS_PROD     = 3387
    ADV_MASS_PROD = 24625
    max_jobs = 0
    try:
        import requests as _req
        from characters import get_all_auth_headers
        from concurrent.futures import ThreadPoolExecutor

        def _fetch_slots(cid, headers):
            try:
                r = _req.get(
                    f"https://esi.evetech.net/latest/characters/{cid}/skills/",
                    headers=headers, timeout=10,
                )
                if not r.ok:
                    return 1
                skill_map = {s["skill_id"]: s["trained_skill_level"] for s in r.json().get("skills", [])}
                return 1 + skill_map.get(MASS_PROD, 0) + skill_map.get(ADV_MASS_PROD, 0)
            except Exception:
                return 1

        auth_headers = get_all_auth_headers()
        if auth_headers:
            with ThreadPoolExecutor(max_workers=len(auth_headers)) as pool:
                for slots in pool.map(lambda x: _fetch_slots(*x), auth_headers):
                    max_jobs += slots
        else:
            max_jobs = max(1, running_fallback + 1)
    except Exception:
        max_jobs = max(1, running_fallback + 1)

    if max_jobs > 0:
        _MAX_JOBS_CACHE    = max_jobs
        _MAX_JOBS_CACHE_TS = time.time()
    return max_jobs


def _get_max_science_jobs(running_fallback: int = 0) -> int:
    """Return sum of science/research slots across all characters (Lab Op + Adv Lab Op).
    Also updates _COPY_TIME_MODIFIER with the best copy-time reduction across all characters."""
    global _MAX_SCIENCE_JOBS_CACHE, _MAX_SCIENCE_JOBS_CACHE_TS, _COPY_TIME_MODIFIER
    if _MAX_SCIENCE_JOBS_CACHE > 0 and (time.time() - _MAX_SCIENCE_JOBS_CACHE_TS) < _MAX_JOBS_TTL:
        return _MAX_SCIENCE_JOBS_CACHE
    LAB_OP       = 3406   # Lab Operation          — +1 slot per level, base 1
    ADV_LAB_OP   = 24624  # Advanced Lab Operation — +1 slot per level
    SCIENCE      = 3402   # Science skill          — −5% copy time per level (max −25%)
    ADV_INDUSTRY = 3388   # Advanced Industry      — −3% all job time per level (max −15%)
    max_sci = 0
    best_modifier = 1.0
    try:
        import requests as _req
        from characters import get_all_auth_headers
        from concurrent.futures import ThreadPoolExecutor

        def _fetch_sci_slots(cid, headers):
            try:
                r = _req.get(
                    f"https://esi.evetech.net/latest/characters/{cid}/skills/",
                    headers=headers, timeout=10,
                )
                if not r.ok:
                    return 1, 1.0
                skill_map = {s["skill_id"]: s["trained_skill_level"] for s in r.json().get("skills", [])}
                slots    = 1 + skill_map.get(LAB_OP, 0) + skill_map.get(ADV_LAB_OP, 0)
                modifier = (1.0 - 0.05 * skill_map.get(SCIENCE, 0)) * (1.0 - 0.03 * skill_map.get(ADV_INDUSTRY, 0))
                return slots, modifier
            except Exception:
                return 1, 1.0

        auth_headers = get_all_auth_headers()
        if auth_headers:
            with ThreadPoolExecutor(max_workers=len(auth_headers)) as pool:
                for slots, modifier in pool.map(lambda x: _fetch_sci_slots(*x), auth_headers):
                    max_sci += slots
                    best_modifier = min(best_modifier, modifier)
        else:
            max_sci = max(1, running_fallback + 1)
    except Exception:
        max_sci = max(1, running_fallback + 1)

    if max_sci > 0:
        _MAX_SCIENCE_JOBS_CACHE    = max_sci
        _MAX_SCIENCE_JOBS_CACHE_TS = time.time()
        _COPY_TIME_MODIFIER        = best_modifier
    return max_sci


# ── Queue Summary (footer stats) ───────────────────────────────────────────────
@app.route("/api/queue-summary", methods=["GET"])
def api_queue_summary():
    """
    Aggregate stats for the overview page footer.
    Returns:
      running_jobs, max_jobs, queue_count, needs_shopping, total_cost_isk, haul_m3
    Cached 2 minutes. Fetches character mfg skill levels for max_jobs.
    """
    global _QUEUE_SUMMARY_CACHE, _QUEUE_SUMMARY_CACHE_TS
    try:
        pass  # request already imported at top
        force = request.args.get("force", "0") == "1"
        if not force and _QUEUE_SUMMARY_CACHE and (time.time() - _QUEUE_SUMMARY_CACHE_TS) < _QUEUE_SUMMARY_TTL:
            # Return cached stats but always recompute running_jobs+free_slots
            # from the live jobs cache so the footer never shows stale counts.
            now_ts       = int(time.time())
            jobs         = _ESI_JOBS_CACHE.get("jobs", [])
            running_jobs = sum(1 for j in jobs if j.get("end_ts", 0) > now_ts)
            max_j        = _QUEUE_SUMMARY_CACHE.get("max_jobs", 1)
            patched      = dict(_QUEUE_SUMMARY_CACHE)
            patched["running_jobs"] = running_jobs
            patched["free_slots"]   = max(0, max_j - running_jobs)
            return jsonify(patched)

        import requests as req
        from concurrent.futures import ThreadPoolExecutor, as_completed

        now_ts = int(time.time())

        # ── 1. Running jobs ────────────────────────────────────────────────────
        jobs = _ESI_JOBS_CACHE.get("jobs", [])
        running_jobs = sum(1 for j in jobs if j.get("end_ts", 0) > now_ts)

        # ── 2. Max manufacturing slots (skill-cached, 30 min TTL) ─────────────
        max_jobs = _get_max_jobs(running_fallback=running_jobs)

        # ── 3. Queue planner items (owned BPs, profitable, from calc cache) ────
        best_key = max(
            _calc_cache.keys(),
            key=lambda k: _calc_cache[k].get("generated_at", 0),
            default=None,
        )
        queue_items = []
        total_cost_isk = 0.0
        haul_m3 = 0.0

        if best_key:
            # Use scored queue-planner candidates when available — this guarantees
            # the footer reflects exactly the same items (and same filters/gates)
            # as the Queue Planner page.  Falls back to a loose filter only when
            # the queue endpoint hasn't been called yet in this server session.
            if _QUEUE_PLANNER_CANDIDATES_CACHE:
                queue_items = list(_QUEUE_PLANNER_CANDIDATES_CACHE)
            else:
                all_results = _calc_cache[best_key].get("results", [])

                # Build owned output_id set (same as top-performers)
                personal_bp_ids: set = set()
                corp_bp_ids: set     = set()
                for bp in _ESI_BP_CACHE.get("blueprints", []):
                    tid = bp.get("type_id")
                    if not tid:
                        continue
                    if bp.get("owner") == "personal":
                        personal_bp_ids.add(tid)
                    else:
                        corp_bp_ids.add(tid)
                corp_bp_ids.update(CORP_BPO_TYPE_IDS)
                all_bp_ids = personal_bp_ids | corp_bp_ids

                owned_output_ids: set = set()
                if all_bp_ids:
                    try:
                        import sqlite3 as _sq
                        _db = _sq.connect(os.path.join(os.path.dirname(__file__), "crest.db"))
                        ph = ",".join("?" * len(all_bp_ids))
                        for bp_id, out_id in _db.execute(
                            f"SELECT blueprint_id, output_id FROM blueprints WHERE blueprint_id IN ({ph})",
                            list(all_bp_ids),
                        ).fetchall():
                            owned_output_ids.add(out_id)
                        _db.close()
                    except Exception:
                        pass

                for r in all_results:
                    if r.get("output_id") not in owned_output_ids:
                        continue
                    if (r.get("net_profit") or 0) <= 0:
                        continue
                    queue_items.append(r)

            # ── 4. Fetch packaged volumes for materials (cached per process) ───
            mat_type_ids: set = set()
            for r in queue_items:
                for m in r.get("material_breakdown", []):
                    mat_type_ids.add(m["type_id"])

            missing_ids = mat_type_ids - set(_TYPE_VOLUME_CACHE.keys())
            if missing_ids:
                def _fetch_vol(tid):
                    try:
                        rv = req.get(
                            f"https://esi.evetech.net/latest/universe/types/{tid}/",
                            timeout=8,
                        )
                        if rv.ok:
                            d = rv.json()
                            return tid, float(d.get("packaged_volume") or d.get("volume") or 1.0)
                    except Exception:
                        pass
                    return tid, 1.0

                with ThreadPoolExecutor(max_workers=20) as pool:
                    for tid, vol in pool.map(_fetch_vol, missing_ids):
                        _TYPE_VOLUME_CACHE[tid] = vol

            # ── 5. Aggregate cost, revenue + haul ─────────────────────────────
            total_revenue_isk = 0.0
            for r in queue_items:
                rec  = r.get("recommended_runs") or {}
                runs = rec.get("runs", 1) if isinstance(rec, dict) else 1
                total_cost_isk    += (r.get("material_cost") or 0) * runs
                # Net revenue = gross revenue minus sales tax and broker fee
                gross_rev  = float(r.get("gross_revenue") or 0)
                sales_tax  = float(r.get("sales_tax")     or 0)
                broker_fee = float(r.get("broker_fee")    or 0)
                total_revenue_isk += (gross_rev - sales_tax - broker_fee) * runs
                for m in r.get("material_breakdown", []):
                    qty = (m.get("quantity") or 0) * runs
                    vol = _TYPE_VOLUME_CACHE.get(m["type_id"], 1.0)
                    haul_m3 += qty * vol

        queue_count = len(queue_items)

        # Slim item list for the footer shopping modal.
        def _slim_run_count(r):
            rr = r.get("recommended_runs")
            if isinstance(rr, dict):
                return rr.get("runs", 1)
            return r.get("rec_runs", 1)

        queue_items_slim = [
            {
                "name":               r.get("name", ""),
                "output_id":          r.get("output_id"),
                "rec_runs":           _slim_run_count(r),
                "material_breakdown": [
                    {
                        "type_id":    m.get("type_id"),
                        "name":       m.get("name", f"Type {m.get('type_id')}"),
                        "quantity":   m.get("quantity", 0),
                        "unit_price": m.get("unit_price", 0),
                    }
                    for m in r.get("material_breakdown", [])
                ],
            }
            for r in queue_items
        ]

        result = {
            "running_jobs":      running_jobs,
            "max_jobs":          max_jobs,
            "queue_count":       queue_count,
            "needs_shopping":    queue_count,
            "total_cost_isk":    round(total_cost_isk, 2),
            "total_revenue_isk": round(total_revenue_isk, 2),
            "haul_m3":           round(haul_m3, 1),
            "queue_items":       queue_items_slim,
        }
        _QUEUE_SUMMARY_CACHE    = result
        _QUEUE_SUMMARY_CACHE_TS = time.time()
        return jsonify(result)

    except Exception as e:
        return jsonify({"error": str(e)}), 200


# ── Character Market Orders ────────────────────────────────────────────────────
@app.route("/api/orders", methods=["GET"])
def api_orders():
    """
    Return active sell and buy orders for ALL characters combined.
    Cached for 2 minutes. Character order fetches parallelised.
    Also diffs against the previously stored orders to detect fulfilled
    (sold) sell orders and records them in sell_order_history.
    """
    global _ESI_ORDERS_CACHE, _ESI_ORDERS_CACHE_TS, _LAST_SELL_POS_BY_ORDER
    try:
        pass  # request already imported at top
        force = request.args.get("force", "0") == "1"
        if not force and _ESI_ORDERS_CACHE and (time.time() - _ESI_ORDERS_CACHE_TS) < _ESI_ORDERS_TTL:
            return jsonify(_ESI_ORDERS_CACHE)

        from characters import get_all_auth_headers, load_characters
        from concurrent.futures import ThreadPoolExecutor, as_completed
        import requests as req

        char_records = load_characters()
        auth_headers = get_all_auth_headers()

        # ── Parallel fetch: orders for all chars at once ──
        def _fetch_char_orders(cid, headers):
            char_name = char_records.get(cid, {}).get("character_name", f"Char {cid}")
            orders = []
            try:
                resp = req.get(
                    f"https://esi.evetech.net/latest/characters/{cid}/orders/",
                    headers=headers, timeout=15,
                )
                if resp.ok:
                    for o in resp.json():
                        o["_character_id"]   = cid
                        o["_character_name"] = char_name
                        orders.append(o)
            except Exception as e:
                print(f"  [orders] Failed for {char_name}: {e}")
            return orders

        all_orders = []
        with ThreadPoolExecutor(max_workers=len(auth_headers)) as pool:
            futures = [pool.submit(_fetch_char_orders, cid, h) for cid, h in auth_headers]
            for f in as_completed(futures):
                all_orders.extend(f.result())

        if not all_orders:
            return jsonify({"sell": [], "buy": [], "newly_fulfilled": []})

        # Resolve type names
        type_ids = list({o["type_id"] for o in all_orders})
        names = {}
        try:
            for i in range(0, len(type_ids), 1000):
                nr = req.post(
                    "https://esi.evetech.net/latest/universe/names/",
                    json=type_ids[i:i+1000], timeout=10,
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
                    json=region_ids[:100], timeout=10,
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

        # ── Enrich sell orders with market position + competitor count ─────────
        # market_position   = cheaper sell orders ahead (0 = best price)
        # competitor_count  = ALL sell listings for the type (supply depth)
        try:
            import sqlite3 as _sq
            db_path = os.path.join(_HERE, "market_cache.db")
            if os.path.exists(db_path):
                conn = _sq.connect(db_path)
                new_pos_by_order: dict[int, int] = {}
                for o in sell:
                    tid   = o["type_id"]
                    price = o["price"]
                    cheaper_row = conn.execute(
                        "SELECT COUNT(*) FROM market_orders WHERE type_id=? AND is_buy_order=0 AND price < ?",
                        (tid, price),
                    ).fetchone()
                    total_row = conn.execute(
                        "SELECT COUNT(*) FROM market_orders WHERE type_id=? AND is_buy_order=0",
                        (tid,),
                    ).fetchone()
                    pos = int(cheaper_row[0]) if cheaper_row else None
                    o["market_position"]  = pos
                    o["competitor_count"] = int(total_row[0])   if total_row   else 0

                    oid = o.get("order_id")
                    prev_pos = _LAST_SELL_POS_BY_ORDER.get(oid) if oid else None
                    o["market_position_prev"] = prev_pos
                    if pos is None or prev_pos is None or pos == prev_pos:
                        o["market_position_trend"] = None
                    else:
                        o["market_position_trend"] = "increasing" if pos > prev_pos else "decreasing"

                    if oid and pos is not None:
                        new_pos_by_order[oid] = pos
                _LAST_SELL_POS_BY_ORDER = new_pos_by_order
                conn.close()
        except Exception as _e:
            print(f"  [orders] market_position lookup failed: {_e}")

        # ── Diff sell orders against stored snapshot ───────────────────────────
        # Only track sell orders — buy orders don't generate revenue events.
        newly_fulfilled = []
        try:
            newly_fulfilled = sync_open_orders(sell)
        except Exception as e:
            print(f"  [orders] sync_open_orders failed: {e}")

        _ESI_ORDERS_CACHE = {"sell": sell, "buy": buy, "newly_fulfilled": newly_fulfilled}
        _ESI_ORDERS_CACHE_TS = time.time()
        return jsonify(_ESI_ORDERS_CACHE)

    except Exception as e:
        return jsonify({"error": str(e), "sell": [], "buy": [], "newly_fulfilled": []}), 200


# ── Smart Buy Sourcing ─────────────────────────────────────────────────────────

# Hub definitions: name, system_id, region_id, station_id
_MARKET_HUBS_SMART = [
    {"name": "Jita",    "system_id": 30000142, "region_id": 10000002, "station_id": 60003760},
    {"name": "Amarr",   "system_id": 30002187, "region_id": 10000043, "station_id": 60008494},
    {"name": "Dodixie", "system_id": 30002659, "region_id": 10000032, "station_id": 60011866},
    {"name": "Rens",    "system_id": 30002510, "region_id": 10000030, "station_id": 60004588},
    {"name": "Hek",     "system_id": 30002053, "region_id": 10000042, "station_id": 60005686},
]

# Per-unit packaged volumes for common materials (m³).
# Values from EVE SDE — used when the item is not in crest.db.
_PACKAGED_VOLUMES: dict[int, float] = {
    # Minerals
    34:    0.01,   # Tritanium
    35:    0.01,   # Pyerite
    36:    0.01,   # Mexallon
    37:    0.01,   # Isogen
    38:    0.01,   # Nocxium
    39:    0.01,   # Zydrine
    40:    0.01,   # Megacyte
    11399: 0.01,   # Morphite
    # PI materials (T1–T4) typically 0.01 – 1.5 m³
    2073:  0.01,   # Lustering Alloy
    2390:  0.01,   # Sheen Compound
    2389:  0.01,   # Gleaming Alloy
    2392:  0.01,   # Motley Compound
    2397:  0.01,   # Fiber Composite
    2395:  0.01,   # Lucent Compound
    2396:  0.01,   # Opulent Compound
    2398:  0.01,   # Glossy Compound
    2393:  0.01,   # Crystal Compound
    2394:  0.01,   # Dark Compound
    9828:  0.01,   # Neo Mercurite
    2399:  0.01,   # Base Metals
    2400:  0.01,   # Heavy Metals
    2401:  0.01,   # Noble Metals
    2402:  0.01,   # Reactive Metals
    2403:  0.01,   # Precious Metals
    2404:  0.01,   # Toxic Metals
    2405:  0.01,   # Industrial Fibers
    2406:  0.01,   # Supertensile Plastics
    2407:  0.01,   # Polyaramids
    2408:  0.01,   # Coolant
    2409:  0.01,   # Condensates
    2410:  0.01,   # Construction Blocks
    2411:  0.01,   # Nanites
    2412:  0.01,   # Silicate Glass
    2413:  0.01,   # Smartfab Units
    # T2 components (roughly 1 m³ each)
    11530: 1.0,    # Radar Sensor Cluster
    11538: 1.0,    # Magnetometric Sensor Cluster
    11544: 1.0,    # Gravimetric Sensor Cluster
    11548: 1.0,    # Ladar Sensor Cluster
    11552: 1.0,    # Multispectral Sensor Cluster
}

_SMART_BUY_CACHE: dict = {}
_SMART_BUY_CACHE_TTL = 180  # 3 minutes — market data is good for a bit


def _get_jumps(origin_system_id: int, dest_system_id: int) -> int | None:
    """
    Query ESI /route/ for the number of jumps between two solar systems.
    Returns None on error or same-system (0 jumps).
    """
    if origin_system_id == dest_system_id:
        return 0
    try:
        resp = requests.get(
            f"https://esi.evetech.net/latest/route/{origin_system_id}/{dest_system_id}/",
            params={"flag": "shortest"},
            timeout=8,
        )
        if resp.ok:
            route = resp.json()
            # route is a list of system IDs including origin and destination
            return max(0, len(route) - 1)
    except Exception:
        pass
    return None


def _resolve_system_id(name_or_id: str) -> int | None:
    """Resolve a system name or numeric string to a system_id integer."""
    if not name_or_id:
        return None
    if name_or_id.isdigit():
        return int(name_or_id)
    # Use the SCI name cache (already populated by _ensure_sci_cache)
    _ensure_sci_cache()
    sid_str = _SCI_NAME_CACHE.get(name_or_id.strip().lower())
    if sid_str:
        return int(sid_str)
    # Fallback: ESI search
    try:
        resp = requests.get(
            "https://esi.evetech.net/latest/search/",
            params={"categories": "solar_system", "search": name_or_id, "strict": "true"},
            timeout=8,
        )
        if resp.ok:
            ids = resp.json().get("solar_system", [])
            if ids:
                return int(ids[0])
    except Exception:
        pass
    return None


def _fetch_hub_sell_prices(hub: dict, type_ids: list[int]) -> dict[int, float]:
    """
    Fetch best sell (lowest) prices for a list of type_ids at a specific hub.

    Jita  → instant SQLite query against local market_cache.db.
    Others → ESI /markets/{region}/orders/?type_id=X&order_type=sell per item,
             filtered to the hub's main station.  Parallelised with a thread pool
             so the total latency is ~1 ESI round-trip regardless of item count.
    Returns { type_id: best_sell_price } — missing entries mean no stock.
    """
    result: dict[int, float] = {}

    if hub["name"] == "Jita":
        # Fast path: local SQLite cache (populated by pricer._fetch_all_orders)
        try:
            import sqlite3 as _sq
            conn = _sq.connect(os.path.join(_HERE, "market_cache.db"))
            conn.row_factory = _sq.Row
            placeholders = ",".join("?" * len(type_ids))
            rows = conn.execute(
                f"SELECT type_id, MIN(price) as best_sell FROM market_orders "
                f"WHERE type_id IN ({placeholders}) AND is_buy_order=0 "
                f"GROUP BY type_id",
                type_ids,
            ).fetchall()
            conn.close()
            for row in rows:
                if row["best_sell"] is not None:
                    result[row["type_id"]] = row["best_sell"]
        except Exception:
            pass
        return result

    # Non-Jita: use the ESI per-type endpoint — one call per item, parallelised.
    # GET /markets/{region_id}/orders/?order_type=sell&type_id={type_id}
    # Returns only orders for that type across the region; we filter to the hub station.
    region_id  = hub["region_id"]
    station_id = hub["station_id"]

    def _fetch_one(tid: int) -> tuple[int, float | None]:
        try:
            resp = requests.get(
                f"https://esi.evetech.net/latest/markets/{region_id}/orders/",
                params={"order_type": "sell", "type_id": tid},
                timeout=10,
            )
            if not resp.ok:
                return tid, None
            best = None
            for o in resp.json():
                if o.get("location_id") != station_id:
                    continue
                p = o["price"]
                if best is None or p < best:
                    best = p
            return tid, best
        except Exception:
            return tid, None

    from concurrent.futures import ThreadPoolExecutor as _TPE, as_completed as _ac
    # Cap workers at 15 — ESI allows ~20 req/s; stay polite
    with _TPE(max_workers=15) as pool:
        futures = {pool.submit(_fetch_one, tid): tid for tid in type_ids}
        for fut in _ac(futures):
            tid, price = fut.result()
            if price is not None:
                result[tid] = price

    return result


def _get_volume_m3(type_id: int, fallback: float = 0.01) -> float:
    """
    Look up the packaged volume (m³) for a type_id.
    Checks: (1) in-memory lookup table, (2) crest.db, (3) ESI, (4) fallback.
    """
    if type_id in _PACKAGED_VOLUMES:
        return _PACKAGED_VOLUMES[type_id]
    # Try crest.db blueprint materials volume
    try:
        import sqlite3 as _sq
        conn = _sq.connect(os.path.join(_HERE, "crest.db"))
        row = conn.execute(
            "SELECT volume_m3 FROM blueprints WHERE output_id=? LIMIT 1", (type_id,)
        ).fetchone()
        conn.close()
        if row and row[0]:
            v = float(row[0])
            _PACKAGED_VOLUMES[type_id] = v
            return v
    except Exception:
        pass
    # Try sqlite-latest.sqlite (SDE)
    try:
        import sqlite3 as _sq
        sde_path = os.path.join(_HERE, "sqlite-latest.sqlite")
        if os.path.exists(sde_path):
            conn = _sq.connect(sde_path)
            row = conn.execute(
                "SELECT volume FROM invTypes WHERE typeID=? LIMIT 1", (type_id,)
            ).fetchone()
            conn.close()
            if row and row[0]:
                v = float(row[0])
                _PACKAGED_VOLUMES[type_id] = v
                return v
    except Exception:
        pass
    return fallback


@app.route("/api/shopping/optimal_sources", methods=["POST"])
def api_shopping_optimal_sources():
    """
    Smart Buy: find the cheapest combination of market hubs to source all materials,
    taking into account jump distance from the player's current system.

    POST body (JSON):
    {
        "items": [{"type_id": 34, "name": "Tritanium", "quantity": 10000}, ...],
        "player_system": "Korsiki"   // system name or numeric ID; optional
    }

    Response:
    {
        "per_material": [
            {
                "type_id": 34,
                "name": "Tritanium",
                "quantity": 10000,
                "volume_m3": 100.0,
                "sources": [
                    {"hub": "Jita", "price": 5.12, "total_cost": 51200, "jumps": 2, "has_stock": true},
                    ...
                ],
                "best_hub":          "Jita",
                "best_price":        5.12,
                "best_total_cost":   51200,
                "jita_price":        5.12,
                "jita_total_cost":   51200,
                "in_hangar":         false,
                "hangar_qty":        0
            },
            ...
        ],
        "summary": {
            "total_optimal_cost":  1234567.0,
            "total_jita_cost":     1345678.0,
            "total_savings":       111111.0,
            "total_haul_m3":       450.0,
            "local_trips":         [{"hub": "Amarr", "jumps": 6, "items": 3, "cost": 123456.0}],
            "materials_in_hangar": ["Tritanium", ...],
            "materials_no_stock":  ["Rare Ore", ...]
        },
        "hub_jumps": {"Jita": 2, "Amarr": 6, ...}
    }
    """
    pass  # request already imported at top
    try:
        body          = request.get_json(force=True) or {}
        items         = body.get("items", [])          # [{type_id, name, quantity}]
        player_system = str(body.get("player_system", "")).strip()

        if not items:
            return jsonify({"error": "No items provided"}), 400

        # ── Cache key ──────────────────────────────────────────────────────────
        import hashlib, json as _json
        cache_key = hashlib.md5(
            _json.dumps({"items": sorted(items, key=lambda x: x["type_id"]),
                         "player_system": player_system}, sort_keys=True).encode()
        ).hexdigest()
        cached = _SMART_BUY_CACHE.get(cache_key)
        if cached and (time.time() - cached["_ts"]) < _SMART_BUY_CACHE_TTL:
            return jsonify({k: v for k, v in cached.items() if k != "_ts"})

        # ── Resolve player system ID ───────────────────────────────────────────
        player_sys_id: int | None = _resolve_system_id(player_system) if player_system else None

        # ── Resolve hub jump distances from player system (sequential — fast) ──
        hub_jumps: dict[str, int | None] = {}
        if player_sys_id:
            for h in _MARKET_HUBS_SMART:
                hub_jumps[h["name"]] = _get_jumps(player_sys_id, h["system_id"])
        else:
            for h in _MARKET_HUBS_SMART:
                hub_jumps[h["name"]] = None

        # ── Ensure Jita market cache is fresh (fast path for Jita lookups) ────
        try:
            from pricer import _ensure_orders_fresh
            _ensure_orders_fresh()
        except Exception:
            pass

        # ── Build type_id list ─────────────────────────────────────────────────
        all_type_ids = [int(it["type_id"]) for it in items]
        type_id_set  = set(all_type_ids)

        # ── Fetch prices for all hubs in a single flat thread pool ─────────────
        # Each (hub, type_id) pair is one ESI call.  Jita uses local DB — instant.
        # Flatten into one pool to avoid nested ThreadPoolExecutors (which can
        # deadlock in Flask's threaded server).
        from concurrent.futures import ThreadPoolExecutor as _TPE, as_completed as _ac

        # Jita is resolved synchronously via SQLite (fast, no threading needed)
        jita_hub = next(h for h in _MARKET_HUBS_SMART if h["name"] == "Jita")
        hub_prices: dict[str, dict[int, float]] = {
            "Jita": _fetch_hub_sell_prices(jita_hub, all_type_ids)
        }
        for h in _MARKET_HUBS_SMART:
            if h["name"] != "Jita":
                hub_prices[h["name"]] = {}

        # Non-Jita: flatten (hub, type_id) → one pool
        def _fetch_one_hub_type(hub: dict, tid: int) -> tuple[str, int, float | None]:
            region_id  = hub["region_id"]
            station_id = hub["station_id"]
            try:
                resp = requests.get(
                    f"https://esi.evetech.net/latest/markets/{region_id}/orders/",
                    params={"order_type": "sell", "type_id": tid},
                    timeout=10,
                )
                if not resp.ok:
                    return hub["name"], tid, None
                best = None
                for o in resp.json():
                    if o.get("location_id") != station_id:
                        continue
                    p = o["price"]
                    if best is None or p < best:
                        best = p
                return hub["name"], tid, best
            except Exception:
                return hub["name"], tid, None

        non_jita_hubs = [h for h in _MARKET_HUBS_SMART if h["name"] != "Jita"]
        tasks = [(h, tid) for h in non_jita_hubs for tid in all_type_ids]

        with _TPE(max_workers=20) as pool:
            futures = [pool.submit(_fetch_one_hub_type, h, tid) for h, tid in tasks]
            for fut in _ac(futures):
                try:
                    hub_name, tid, price = fut.result()
                    if price is not None:
                        if tid not in hub_prices[hub_name] or price < hub_prices[hub_name][tid]:
                            hub_prices[hub_name][tid] = price
                except Exception:
                    pass

        # ── Load hangar quantities ─────────────────────────────────────────────
        hangar_qty: dict[int, int] = {}
        try:
            if _ASSETS_CACHE and _ASSETS_CACHE.get("assets"):
                for k, v in _ASSETS_CACHE["assets"].items():
                    hangar_qty[int(k)] = int(v)
        except Exception:
            pass

        # ── Per-material analysis ──────────────────────────────────────────────
        per_material = []
        total_optimal_cost = 0.0
        total_jita_cost    = 0.0
        haul_m3_from_jita  = 0.0
        materials_in_hangar: list[str] = []
        materials_no_stock:  list[str] = []

        # Accumulate per-hub totals for "local_trips" summary
        hub_trip_costs:  dict[str, float] = {h["name"]: 0.0 for h in _MARKET_HUBS_SMART}
        hub_trip_counts: dict[str, int]   = {h["name"]: 0   for h in _MARKET_HUBS_SMART}

        for it in items:
            tid      = int(it["type_id"])
            name     = it.get("name", f"Type {tid}")
            qty      = int(it.get("quantity", 0))
            vol_unit = _get_volume_m3(tid)
            vol_m3   = round(vol_unit * qty, 4)
            h_qty    = hangar_qty.get(tid, 0)

            # Build per-hub source info
            sources = []
            for hub in _MARKET_HUBS_SMART:
                hub_name   = hub["name"]
                price      = hub_prices.get(hub_name, {}).get(tid)
                has_stock  = price is not None
                total_cost = round(price * qty, 2) if price is not None else None
                jumps      = hub_jumps.get(hub_name)
                sources.append({
                    "hub":        hub_name,
                    "price":      price,
                    "total_cost": total_cost,
                    "jumps":      jumps,
                    "has_stock":  has_stock,
                })

            # Choose best hub (cheapest available; None = no stock anywhere)
            available = [s for s in sources if s["has_stock"]]
            if available:
                # Sort by price; if jumps known, break ties by jumps
                best = min(
                    available,
                    key=lambda s: (
                        s["total_cost"],
                        s["jumps"] if s["jumps"] is not None else 999,
                    ),
                )
            else:
                best = None

            jita_source = next((s for s in sources if s["hub"] == "Jita"), None)
            jita_price       = jita_source["price"]      if jita_source else None
            jita_total_cost  = jita_source["total_cost"] if jita_source else None

            # Hangar coverage
            in_hangar = h_qty >= qty

            if in_hangar:
                materials_in_hangar.append(name)
            elif not available:
                materials_no_stock.append(name)

            if best and not in_hangar:
                total_optimal_cost += best["total_cost"] or 0.0
                hub_trip_costs[best["hub"]]  += best["total_cost"] or 0.0
                hub_trip_counts[best["hub"]] += 1

            if not in_hangar:
                total_jita_cost += jita_total_cost or 0.0
                if jita_source and jita_source["has_stock"]:
                    # If best hub is Jita (or no stock elsewhere), count haul volume
                    if best is None or best["hub"] == "Jita":
                        haul_m3_from_jita += vol_m3

            per_material.append({
                "type_id":       tid,
                "name":          name,
                "quantity":      qty,
                "volume_m3":     vol_m3,
                "sources":       sources,
                "best_hub":      best["hub"]        if best else None,
                "best_price":    best["price"]      if best else None,
                "best_total_cost": best["total_cost"] if best else None,
                "jita_price":    jita_price,
                "jita_total_cost": jita_total_cost,
                "in_hangar":     in_hangar,
                "hangar_qty":    h_qty,
            })

        # ── Build local_trips list (non-Jita hubs that are best for ≥1 material) ─
        local_trips = []
        for hub in _MARKET_HUBS_SMART:
            hn = hub["name"]
            if hn == "Jita":
                continue
            if hub_trip_counts[hn] > 0:
                local_trips.append({
                    "hub":    hn,
                    "jumps":  hub_jumps.get(hn),
                    "items":  hub_trip_counts[hn],
                    "cost":   round(hub_trip_costs[hn], 2),
                })
        local_trips.sort(key=lambda x: (x["jumps"] or 999, x["hub"]))

        result_payload = {
            "per_material": per_material,
            "summary": {
                "total_optimal_cost": round(total_optimal_cost, 2),
                "total_jita_cost":    round(total_jita_cost, 2),
                "total_savings":      round(total_jita_cost - total_optimal_cost, 2),
                "total_haul_m3":      round(haul_m3_from_jita, 4),
                "local_trips":        local_trips,
                "materials_in_hangar": materials_in_hangar,
                "materials_no_stock":  materials_no_stock,
            },
            "hub_jumps": {k: v for k, v in hub_jumps.items()},
        }

        _SMART_BUY_CACHE[cache_key] = {**result_payload, "_ts": time.time()}
        return jsonify(result_payload)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/sell_history", methods=["GET"])
def api_sell_history():
    """
    Return sell-time statistics derived from sell_order_history.

    Response:
    {
        "overall": {
            "avg_days_to_sell": float | null,
            "total_sales":      int,
            "total_revenue":    float
        },
        "by_item": {
            "<item_name>": {
                "type_id":          int,
                "avg_days_to_sell": float | null,
                "total_sold":       int,
                "total_revenue":    float,
                "fastest_sale":     float | null,
                "slowest_sale":     float | null
            },
            ...
        }
    }
    """
    try:
        stats = get_sell_history_stats()
        return jsonify(stats)
    except Exception as e:
        return jsonify({"error": str(e), "overall": {}, "by_item": {}}), 200


@app.route("/api/sell_history/fill_rate", methods=["GET"])
def api_sell_history_fill_rate():
    """
    Return 7-day sell-order fill rate.
    Response: { fulfilled_7d, live_7d, total_7d, rate_pct }
    """
    try:
        from database import get_fill_rate_7d
        return jsonify(get_fill_rate_7d())
    except Exception as e:
        return jsonify({"error": str(e)}), 200


@app.route("/api/unrealized_value", methods=["GET"])
def api_unrealized_value():
    """
    Return the total ISK value of all character assets at current Jita sell prices.
    Auto-fetches assets from ESI if the cache is cold.
    Response: { total_isk, item_count, items: [{type_id, name, qty, sell_price, total_isk}] }
    """
    global _ASSETS_CACHE, _ASSETS_CACHE_TS
    try:
        # Auto-populate asset cache if cold or stale
        if not _ASSETS_CACHE or (time.time() - _ASSETS_CACHE_TS) >= _ASSETS_TTL:
            from characters import get_all_auth_headers, load_characters as _lc_uv
            from concurrent.futures import ThreadPoolExecutor as _TPE_uv, as_completed as _ac_uv
            from collections import defaultdict as _dd_uv
            _char_records_uv = _lc_uv()
            _auth_headers_uv = get_all_auth_headers()

            def _fetch_uv(cid, hdrs):
                _cname = _char_records_uv.get(cid, {}).get("character_name", f"Char {cid}")
                _items, _page = [], 1
                while True:
                    try:
                        _r = requests.get(
                            f"https://esi.evetech.net/latest/characters/{cid}/assets/",
                            headers=hdrs, params={"page": _page}, timeout=15,
                        )
                        if not _r.ok:
                            print(f"  [assets] ESI {_r.status_code} for {_cname} page {_page}: {_r.text[:200]}")
                            break
                        _pg = _r.json()
                        if not _pg:
                            break
                        _items.extend(_pg)
                        if len(_pg) < 1000:
                            break
                        _page += 1
                    except Exception as _e:
                        print(f"  [assets] fetch failed for {_cname}: {_e}")
                        break
                return _items

            _inv = _dd_uv(int)
            if _auth_headers_uv:
                with _TPE_uv(max_workers=max(1, len(_auth_headers_uv))) as _pool:
                    for _f in _ac_uv([_pool.submit(_fetch_uv, c, h) for c, h in _auth_headers_uv]):
                        for _it in _f.result():
                            _inv[_it["type_id"]] += _it["quantity"]

            _ASSETS_CACHE = {"assets": dict(_inv), "names": {}, "cached_at": int(time.time())}
            _ASSETS_CACHE_TS = time.time()

        from pricer import get_prices_bulk

        assets = _ASSETS_CACHE.get("assets", {})   # { int_type_id: qty }
        names  = _ASSETS_CACHE.get("names", {})    # { str_type_id: name }

        type_ids = [tid for tid, qty in assets.items() if qty > 0]
        prices   = get_prices_bulk(type_ids)

        total_isk = 0.0
        items     = []
        for tid, qty in assets.items():
            if qty <= 0:
                continue
            p    = prices.get(tid, {})
            sell = p.get("sell") or 0
            if sell <= 0:
                continue
            val = sell * qty
            total_isk += val
            items.append({
                "type_id":    tid,
                "name":       names.get(str(tid), f"Type {tid}"),
                "qty":        qty,
                "sell_price": sell,
                "total_isk":  round(val, 0),
            })

        items.sort(key=lambda x: x["total_isk"], reverse=True)
        return jsonify({
            "total_isk":  round(total_isk, 0),
            "item_count": len(items),
            "items":      items[:50],
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 200


@app.route("/api/bp_utilization", methods=["GET"])
def api_bp_utilization():
    """
    Return blueprint utilization rate: how many owned BPs generated at least one
    manufacturing job in the last 30 days.
    Response: { owned, active_30d, rate_pct }
    """
    try:
        import sqlite3 as _sq
        from database import get_craft_log

        # Total owned blueprints — ESI cache if warm, otherwise static corp BPO list
        owned_bp_ids = {bp["type_id"] for bp in _ESI_BP_CACHE.get("blueprints", [])}
        if not owned_bp_ids:
            owned_bp_ids = set(CORP_BPO_TYPE_IDS)
        owned_count = len(owned_bp_ids)

        if owned_count == 0:
            return jsonify({"owned": 0, "active_30d": 0, "rate_pct": None})

        # Active product type_ids from craft_log in last 30 days
        log_rows     = get_craft_log(days=30)
        active_pids  = {r["product_type_id"] for r in log_rows if r.get("product_type_id")}

        # Map product_type_id → blueprint_id via crest.db
        active_count = 0
        if active_pids:
            conn = _sq.connect(os.path.join(os.path.dirname(__file__), "crest.db"))
            ph   = ",".join("?" * len(active_pids))
            rows = conn.execute(
                f"SELECT blueprint_id FROM blueprints WHERE output_id IN ({ph})",
                list(active_pids),
            ).fetchall()
            conn.close()
            active_bp_ids = {r[0] for r in rows}
            active_count  = len(active_bp_ids & owned_bp_ids)

        rate_pct = round(active_count / owned_count * 100, 1) if owned_count > 0 else None
        return jsonify({
            "owned":      owned_count,
            "active_30d": active_count,
            "rate_pct":   rate_pct,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 200


@app.route("/api/alerts/status", methods=["GET"])
def api_alerts_status():
    """Return the current status of the background alert scanner."""
    return jsonify(_alert_scanner.status)


# ─── Bot / Telegram settings ──────────────────────────────────────────────────

_SETTINGS_ALLOW = {
    "TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID",
    "ROI_THRESHOLD", "BREAKEVEN_MAX_RUNS", "MIN_NET_PROFIT",
    "ALERT_COOLDOWN_HOURS", "CONTRACT_SCAN_INTERVAL", "JOB_SCAN_INTERVAL",
    "MAX_PAGES", "REGION_ID", "BLUEPRINT_TYPE",
}
_SETTINGS_NUMERIC = {
    "ROI_THRESHOLD", "BREAKEVEN_MAX_RUNS", "MIN_NET_PROFIT",
    "ALERT_COOLDOWN_HOURS", "CONTRACT_SCAN_INTERVAL", "JOB_SCAN_INTERVAL",
    "MAX_PAGES", "REGION_ID",
}
_BLUEPRINT_TYPE_VALUES = {"bpo", "bpc", "both"}


def _rewrite_env(updates: dict) -> None:
    """Write or update key=value pairs in the .env file for the given keys."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    lines = []
    if os.path.exists(env_path):
        with open(env_path, "r") as f:
            lines = f.readlines()
    written = set()
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            new_lines.append(line)
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in updates:
            new_lines.append(f"{key}={updates[key]}\n")
            written.add(key)
        else:
            new_lines.append(line)
    for key, val in updates.items():
        if key not in written:
            new_lines.append(f"{key}={val}\n")
    with open(env_path, "w") as f:
        f.writelines(new_lines)


@app.route("/api/settings/bot", methods=["GET"])
def api_settings_bot_get():
    """Return the current bot/alert config (token partially masked)."""
    return jsonify({**_alert_scanner.get_public_config(), **_alert_scanner.status})


@app.route("/api/settings/bot", methods=["POST"])
async def api_settings_bot_post():
    """Save bot/alert settings to .env and hot-reload in-memory config."""
    try:
        body = (await request.get_json(force=True, silent=True)) or {}
    except Exception:
        return jsonify({"ok": False, "error": "Invalid JSON"}), 400
    # Validate and sanitise — strict allow-list, no dynamic key names
    # Blank/empty values are skipped (keep existing in-memory value)
    validated = {}
    for key in _SETTINGS_ALLOW:
        if key not in body:
            continue
        val = body[key]
        if val == "" or val is None:
            continue  # leave existing value intact
        if key in _SETTINGS_NUMERIC:
            try:
                validated[key] = float(val) if "." in str(val) else int(val)
            except (TypeError, ValueError):
                return jsonify({"ok": False, "error": f"Invalid value for {key}"}), 400
        elif key == "BLUEPRINT_TYPE":
            if str(val) not in _BLUEPRINT_TYPE_VALUES:
                return jsonify({"ok": False, "error": "BLUEPRINT_TYPE must be bpo, bpc, or both"}), 400
            validated[key] = str(val)
        else:
            validated[key] = str(val)
    # Persist strings to .env (token + chat_id + blueprint_type)
    env_updates = {k: str(v) for k, v in validated.items()}
    _rewrite_env({k: v for k, v in env_updates.items() if k in {"TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID", "BLUEPRINT_TYPE"}})
    # Hot-reload scanner memory
    _alert_scanner.update_config(validated)
    return jsonify({"ok": True, **_alert_scanner.get_public_config()})


@app.route("/api/settings/bot/test", methods=["POST"])
async def api_settings_bot_test():
    """Send a test Telegram message using the current config."""
    ok = _alert_scanner._tg_send("🤖 <b>CREST</b> — test message. Bot is connected.")
    if ok:
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "Send failed — check token and chat ID"}), 200


@app.route("/api/contracts/status", methods=["GET"])
def api_contracts_status():
    """Return the current state of the local contract cache."""
    try:
        region_id = int(request.args.get("region_id", _CC_REGION_ID))
        stats = _cc.get_stats(region_id)
        return jsonify({"ok": True, **stats})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 200


@app.before_serving
async def _startup():
    """
    Quart before_serving hook — runs once when Hypercorn starts accepting connections.
    Launches all background tasks onto the running event loop.
    """
    await _esi.esi.start()
    from pricer import orders_refresh_loop
    asyncio.get_event_loop().create_task(orders_refresh_loop(), name="pricer-refresh")
    asyncio.get_event_loop().create_task(_prewarm_task(), name="prewarm")
    asyncio.get_event_loop().create_task(_wealth_snapshot_task(), name="wealth-snapshot")
    _alert_scanner.start_alert_scanner(_calc_cache, CALC_CACHE_TTL, warmup_event=_warmup_done)
    # Start contract cache background refresher
    _t = threading.Thread(
        target=_contract_cache_refresher, daemon=True, name="contract-cache"
    )
    _t.start()
    print("  [contract-cache] background refresher started")


@app.after_serving
async def _shutdown():
    await _esi.esi.close()


async def _prewarm_task():
    global _skill_id_names, _server_ready

    def _load_skill_names():
        global _skill_id_names
        if (os.path.exists(_SKILL_NAMES_PATH) and
                time.time() - os.path.getmtime(_SKILL_NAMES_PATH) < _SKILL_NAMES_MAX_AGE):
            try:
                with open(_SKILL_NAMES_PATH, "r", encoding="utf-8") as _f:
                    _skill_id_names = {int(k): v for k, v in json.load(_f).items()}
                print(f"  [prewarm] Skill names loaded from cache ({len(_skill_id_names)} types)")
                return
            except Exception as _e:
                print(f"  [prewarm] Skill name cache read failed, re-downloading: {_e}")
        try:
            import bz2 as _bz2, urllib.request as _ur
            _req = _ur.Request(
                "https://www.fuzzwork.co.uk/dump/latest/invTypes.csv.bz2",
                headers={"User-Agent": "CREST-Server/1.0"}
            )
            with _ur.urlopen(_req, timeout=30) as _r:
                _raw = _bz2.decompress(_r.read())
            _tmp: dict[int, str] = {}
            for _line in _raw.decode("utf-8").splitlines()[1:]:
                _parts = _line.split(",")
                try:
                    _tmp[int(_parts[0])] = _parts[2]
                except (ValueError, IndexError):
                    pass
            _skill_id_names = _tmp
            with open(_SKILL_NAMES_PATH, "w", encoding="utf-8") as _f:
                json.dump({str(k): v for k, v in _tmp.items()}, _f)
            print(f"  [prewarm] Skill names downloaded and cached ({len(_skill_id_names)} types)")
        except Exception as _e:
            print(f"  [prewarm] Skill names download failed: {_e}")

    def _warmup_scan_sync():
        """Directly populate scan cache — no HTTP round-trip needed."""
        try:
            from pricer import get_prices_bulk
            results = calculate_all()
            all_type_ids = set(MINERALS.values())
            for r in results:
                for mat in r.get("material_breakdown", []):
                    all_type_ids.add(mat["type_id"])
            prices = get_prices_bulk(list(all_type_ids))
            for r in results:
                r.pop("material_breakdown", None)
            seen, deduped = set(), []
            for r in results:
                oid = r.get("output_id")
                if oid not in seen:
                    seen.add(oid)
                    deduped.append(r)
            global _scan_cache
            _scan_cache = {
                "scanned_at": int(time.time()),
                "results":    deduped[:50],
                "minerals":   _mineral_prices(prices),
            }
            print("  [prewarm] Scan cache ready.")
        except Exception as _e:
            print(f"  [prewarm] Scan warmup failed: {_e}")

    def _warmup_calculator_sync():
        """Directly populate calculator cache for default params (Korsiki / Large Eng. Complex).

        Mirrors the full api_calculator pipeline so the cached result includes all
        derived fields (roi, me_level, category, break_even_price, …) and is
        indistinguishable from a user-triggered calculation.
        """
        try:
            _cache_key = _calc_cache_key("Korsiki", "large")
            if _calc_is_fresh(_cache_key):
                return

            from calculator import calculate_profit, CONFIG
            from pricer import get_prices_bulk

            _all_blueprints = load_blueprints()

            sci          = _resolve_sci("Korsiki")
            facility_cfg = _facility_config("large")

            all_type_ids: set = set()
            output_ids:   set = set()
            for bp in _all_blueprints:
                output_ids.add(bp["output_id"])
                all_type_ids.add(bp["output_id"])
                for mat in bp["materials"]:
                    all_type_ids.add(mat["type_id"])
            all_type_ids.update(MINERALS.values())
            from invention import _all_datacore_type_ids
            all_type_ids.update(_all_datacore_type_ids())

            prices = get_prices_bulk(list(all_type_ids), history_ids=list(output_ids))

            _sell_days: dict = {}
            try:
                from database import get_avg_days_to_sell_by_type
                _sell_days = get_avg_days_to_sell_by_type()
            except Exception:
                pass

            cfg_override = {
                **CONFIG,
                "system_cost_index":           sci,
                "structure_me_bonus":          facility_cfg["me_bonus"],
                "sales_tax":                   facility_cfg["sales_tax"],
                "facility_tax_rate":           facility_cfg.get("facility_tax_rate", 0.001),
                "structure_type_id":           facility_cfg.get("structure_type_id"),
            }

            results = []
            for bp in _all_blueprints:
                result = calculate_profit(bp, prices, config_override=cfg_override,
                                          invention_prices=prices,
                                          sell_days_by_type=_sell_days)
                if not result:
                    continue

                # Blueprint metadata (mirrors api_calculator)
                result["me_level"]        = bp.get("me_level", 0)
                result["te_level"]        = bp.get("te_level", 0)
                result["category"]        = _normalize_category(bp.get("category", "Other"))
                result["tech"]            = bp.get("tech", "I")
                result["size"]            = bp.get("size", "U")
                result["bp_type"]         = bp.get("bp_type", "BPO")
                result["duration"]        = result.get("time_seconds") or bp.get("time_seconds", 0)
                result["volume"]          = bp.get("volume", 0)
                result["required_skills"] = bp.get("required_skills", [])
                result["blueprint_id"]    = bp.get("blueprint_id")
                result["resolved_sci"]    = sci
                result["facility_label"]  = facility_cfg["label"]
                result["facility_tax_rate"] = facility_cfg.get("facility_tax_rate", 0.001)
                result["structure_type_id"] = facility_cfg.get("structure_type_id")
                result["sci_source"]      = "warmup"

                # Derived metrics (same formulas as api_calculator)
                cost           = (result.get("material_cost", 0) + result.get("job_cost", 0)
                                  + result.get("sales_tax", 0) + result.get("broker_fee", 0))
                profit         = result.get("net_profit", 0)
                time_s         = result.get("time_seconds") or bp.get("time_seconds", 0)
                avg_sell_days  = result.get("avg_sell_days", 3.0)
                total_cycle_s  = time_s + avg_sell_days * 86400.0
                duration_h     = total_cycle_s / 3600.0 if total_cycle_s else 0
                result["roi"]          = (profit / cost * 100) if cost > 0 else 0
                result["isk_per_hour"] = (profit / duration_h) if duration_h > 0 else None
                result["isk_per_m3"]   = (profit / result["volume"]) if result.get("volume", 0) > 0 else 0

                _gross    = result.get("gross_revenue", 0)
                _fees     = result.get("sales_tax", 0) + result.get("broker_fee", 0)
                _oqty     = result.get("output_qty", 1) or 1
                _costs    = result.get("material_cost", 0) + result.get("job_cost", 0)
                _fee_frac = (_fees / _gross) if _gross > 0 else 0
                result["break_even_price"] = round(
                    _costs / (_oqty * (1.0 - _fee_frac)), 2
                ) if _fee_frac < 1.0 else None

                result["resolved_sci"]   = sci
                result["facility_label"] = facility_cfg["label"]

                results.append(result)

            results.sort(key=lambda x: x["net_profit"], reverse=True)

            seen: set = set()
            deduped = []
            for r in results:
                oid = r.get("output_id")
                if oid not in seen:
                    seen.add(oid)
                    deduped.append(r)

            _calc_cache[_cache_key] = {
                "generated_at": int(time.time()),
                "results":      deduped,
                "sci":          sci,
                "facility":     facility_cfg,
            }
            print("  [prewarm] Calculator cache ready.")
        except Exception as _e:
            print(f"  [prewarm] Calculator warmup failed: {_e}")

    print("  [prewarm] Background warmup starting (skill names + scan cache in parallel)...")
    await asyncio.gather(
        asyncio.to_thread(_load_skill_names),
        asyncio.to_thread(_warmup_scan_sync),
    )

    _server_ready = True
    _warmup_done.set()
    print("  [prewarm] Server ready — /api/ready will return true.")
    asyncio.get_event_loop().create_task(
        asyncio.to_thread(_warmup_calculator_sync), name="calc-prewarm"
    )


async def _wealth_snapshot_task():
    await asyncio.sleep(60)  # wait for auth tokens to be ready
    while True:
        try:
            balance = _get_wallet()
            if balance and balance > 0:
                record_wealth_snapshot(balance)
                print(f"  [snapshot] Wealth recorded: {balance:,.0f} ISK")
        except Exception as e:
            print(f"  [snapshot] Failed: {e}")
        await asyncio.sleep(7200)


if __name__ == "__main__":
    import hypercorn.asyncio
    import hypercorn.config

    cfg = hypercorn.config.Config()
    cfg.bind = ["0.0.0.0:5001"]
    cfg.use_reloader = False

    print()
    print("  CREST - API Server - http://localhost:5001")
    print()
    asyncio.run(hypercorn.asyncio.serve(app, cfg))



