# -*- coding: utf-8 -*-

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
import copy
import os
import hashlib
import tempfile
import threading
import requests
import esi_client as _esi

from blueprints import load_blueprints, MINERALS
from calculator import calculate_all, CONFIG as CALC_CONFIG
from database import (
    save_scan, record_wallet_snapshot, record_wealth_snapshot, get_wallet_history,
    sync_open_orders, get_sell_history_stats,
    upsert_craft_jobs, get_craft_log, get_craft_stats, get_craft_timeline,
    get_sell_velocity_by_type_id,
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
                # Return the current status of the background alert scanner.
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
    """Parse corp_BPOs and return a set of blueprint type_ids via crest.db lookup."""
    result = set()
    try:
        import sqlite3 as _sq
        _base = os.path.dirname(__file__)
        _txt  = os.path.join(_base, "corp_BPOs")
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
_PLANNER_REFRESH_NONCES: dict[str, str] = {}
_PLANNER_REFRESH_NONCES_LOCK = threading.Lock()

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
_server_ready: bool           = False
_warmup_done: threading.Event = threading.Event()
_warmup_stage: str            = "starting"  # "starting" | "scan" | "ready"
_calc_ready:  bool            = False       # True after calculator cache prewarm

# ── Calculator disk cache ─────────────────────────────────────────────────────
# Persists across server restarts so the first user request is always instant.
_CALC_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "calc_cache.json")
_MIN_OUTPUT_PRICE_COVERAGE_RATIO = 0.5
_MIN_OUTPUT_PRICE_COVERAGE_COUNT = 500


def _load_calc_cache_from_disk() -> None:
    """Load persisted calculator cache from disk.

    Fresh entries remain eligible for normal calculator responses. Older entries
    are still restored as last-known-good planner fallbacks when a live
    recalculation is temporarily unavailable after restart.
    """
    global _calc_cache, _calc_ready
    try:
        if not os.path.exists(_CALC_CACHE_PATH):
            return
        with open(_CALC_CACHE_PATH, "r", encoding="utf-8") as _f:
            saved: dict = json.load(_f)
        now   = time.time()
        fresh_count = 0
        stale_count = 0
        for key, entry in saved.items():
            generated_at = float(entry.get("generated_at", 0) or 0)
            if (now - generated_at) < CALC_CACHE_TTL:
                fresh_count += 1
            else:
                stale_count += 1
            _calc_cache[key] = entry
        if _calc_cache:
            _calc_ready = True
            print(
                f"  [cache] Restored {len(_calc_cache)} calculator result(s) from disk "
                f"({fresh_count} fresh, {stale_count} stale fallback)."
            )
    except Exception as _e:
        print(f"  [cache] Could not load disk cache: {_e}")


def _save_calc_cache_to_disk() -> None:
    """Persist current calculator cache to disk (call from a daemon thread)."""
    try:
        _dir = os.path.dirname(_CALC_CACHE_PATH)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=_dir, delete=False) as _f:
            json.dump(_calc_cache, _f)
            _tmp_path = _f.name
        os.replace(_tmp_path, _CALC_CACHE_PATH)
    except Exception as _e:
        print(f"  [cache] Could not save disk cache: {_e}")


# ── ESI state disk cache ─────────────────────────────────────────────────────
# Persists blueprint ownership, industry jobs, and character slot details so the
# Queue Planner can assign items immediately after a server restart — even if
# the live ESI refresh hasn't completed yet.
_ESI_STATE_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "esi_state_cache.json")
_ESI_STATE_CACHE_LOCK = threading.RLock()


def _snapshot_esi_state() -> dict:
    """Capture a stable copy of the persisted ESI state under lock."""
    with _ESI_STATE_CACHE_LOCK:
        return {
            "bp": {
                "data": copy.deepcopy(_ESI_BP_CACHE),
                "ts": float(_ESI_BP_CACHE_TS),
            },
            "jobs": {
                "data": copy.deepcopy(_ESI_JOBS_CACHE),
                "ts": float(_ESI_JOBS_CACHE_TS),
            },
            "slots": {
                "data": copy.deepcopy(_CHAR_SLOT_DETAILS_CACHE),
                "ts": float(_CHAR_SLOT_DETAILS_CACHE_TS),
            },
        }


def _save_esi_state_to_disk() -> None:
    """Persist current ESI blueprint, jobs, and slot caches to a single file."""
    try:
        payload = _snapshot_esi_state()
        _dir = os.path.dirname(_ESI_STATE_CACHE_PATH)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=_dir, delete=False) as _f:
            json.dump(payload, _f)
            _tmp_path = _f.name
        os.replace(_tmp_path, _ESI_STATE_CACHE_PATH)
    except Exception as _e:
        print(f"  [esi-cache] Could not save ESI state to disk: {_e}")


def _load_esi_state_from_disk() -> None:
    """Restore ESI caches from disk so the planner works immediately after restart."""
    global _ESI_BP_CACHE, _ESI_BP_CACHE_TS
    global _ESI_JOBS_CACHE, _ESI_JOBS_CACHE_TS
    global _CHAR_SLOT_DETAILS_CACHE, _CHAR_SLOT_DETAILS_CACHE_TS
    global _MAX_JOBS_CACHE, _MAX_JOBS_CACHE_TS, _MAX_SCIENCE_JOBS_CACHE, _MAX_SCIENCE_JOBS_CACHE_TS
    global _MFG_TIME_MODIFIER, _COPY_TIME_MODIFIER, _INVENT_TIME_MODIFIER
    try:
        if not os.path.exists(_ESI_STATE_CACHE_PATH):
            return
        with open(_ESI_STATE_CACHE_PATH, "r", encoding="utf-8") as _f:
            saved = json.load(_f)

        bp_section    = saved.get("bp") or {}
        jobs_section  = saved.get("jobs") or {}
        slots_section = saved.get("slots") or {}

        bp_data   = bp_section.get("data") or {}
        bp_ts     = float(bp_section.get("ts") or 0)
        jobs_data = jobs_section.get("data") or {}
        jobs_ts   = float(jobs_section.get("ts") or 0)
        slots_data = slots_section.get("data") or {}
        slots_ts   = float(slots_section.get("ts") or 0)

        parts = []

        with _ESI_STATE_CACHE_LOCK:
            if bp_data and bp_data.get("blueprints"):
                _ESI_BP_CACHE    = bp_data
                _ESI_BP_CACHE_TS = bp_ts
                parts.append(f"{len(bp_data['blueprints'])} blueprints")

            if jobs_data and isinstance(jobs_data.get("jobs"), list):
                _ESI_JOBS_CACHE    = jobs_data
                _ESI_JOBS_CACHE_TS = jobs_ts
                parts.append(f"{len(jobs_data['jobs'])} jobs")

            # Do not restore slot details from disk. Those cached values can drift
            # from the current authenticated-skill state and they also carry the
            # planner time modifiers, so correctness is better if job-planner
            # refreshes them live on demand.

        if parts:
            print(f"  [esi-cache] Restored ESI state from disk ({', '.join(parts)}).")
    except Exception as _e:
        print(f"  [esi-cache] Could not load ESI state from disk: {_e}")


def _output_price_coverage(prices: dict, output_ids: set) -> tuple[int, int, float]:
    total_outputs = len(output_ids)
    if total_outputs == 0:
        return 0, 0, 1.0
    priced_outputs = sum(1 for output_id in output_ids if output_id in prices)
    return priced_outputs, total_outputs, priced_outputs / total_outputs


def _prices_look_unhealthy(prices: dict, output_ids: set) -> bool:
    priced_outputs, total_outputs, coverage_ratio = _output_price_coverage(prices, output_ids)
    if total_outputs < _MIN_OUTPUT_PRICE_COVERAGE_COUNT:
        return False
    return priced_outputs == 0 or coverage_ratio < _MIN_OUTPUT_PRICE_COVERAGE_RATIO

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


def _consume_planner_refresh_nonce(cache_key: str, refresh_nonce: str) -> bool:
    nonce = (refresh_nonce or "").strip()
    if not nonce:
        return False
    with _PLANNER_REFRESH_NONCES_LOCK:
        previous = _PLANNER_REFRESH_NONCES.get(cache_key)
        if previous == nonce:
            return False
        _PLANNER_REFRESH_NONCES[cache_key] = nonce
        if len(_PLANNER_REFRESH_NONCES) > 32:
            oldest_key = next(iter(_PLANNER_REFRESH_NONCES))
            if oldest_key != cache_key:
                _PLANNER_REFRESH_NONCES.pop(oldest_key, None)
        return True


def _upgrade_calc_payload_formula(payload: dict) -> None:
    """
    Retroactively correct cached calculator results to the latest job/invention metadata.
    Updates payload in place.
    """
    if not payload:
        return
    try:
        from calculator import calculate_industry_job_cost
        from invention import calculate_invention_cost
    except Exception:
        return

    results = payload.get("results") or []
    if not results:
        payload["job_formula_version"] = 2
        return

    facility = payload.get("facility") or {}
    payload_sci = payload.get("sci", 0)
    payload_invention_sci = payload.get("facility", {}).get("invention_system_cost_index", payload_sci)

    for r in results:
        invention_detail = dict(r.get("invention_detail") or {})
        needs_invention_upgrade = bool(invention_detail) and (
            invention_detail.get("can_start_invention") is None
            or invention_detail.get("required_skills") is None
            or invention_detail.get("missing_required_skills") is None
            or invention_detail.get("eligible_character_ids") is None
        )

        if int(r.get("job_formula_version", 0) or 0) >= 2 and r.get("job_cost_breakdown") and not needs_invention_upgrade:
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

        invention_cost = float(r.get("invention_cost", 0) or 0)
        upgraded_invention_detail = invention_detail if invention_detail else None
        if invention_detail:
            inv_result = calculate_invention_cost(str(r.get("name") or ""))
            if inv_result:
                success_chance = max(float(inv_result.get("success_chance") or 0.0), 1e-9)
                runs_per_bpc = max(1, int(inv_result.get("output_runs_per_bpc") or 1))
                invention_job_breakdown = calculate_industry_job_cost(
                    activity="invention",
                    eiv=float(r.get("estimated_item_value", r.get("material_cost", 0)) or 0),
                    sci=float(r.get("resolved_invention_sci") or payload_invention_sci or sci),
                    cfg=cfg,
                )
                invention_job_cost_per_run = float(invention_job_breakdown.get("total_job_cost") or 0.0) / success_chance / runs_per_bpc
                invention_cost = float(inv_result.get("cost_per_run") or 0.0) + invention_job_cost_per_run
                upgraded_invention_detail = dict(inv_result)
                upgraded_invention_detail.update({
                    "job_cost_per_attempt": float(invention_job_breakdown.get("total_job_cost") or 0.0),
                    "job_cost_breakdown_per_attempt": invention_job_breakdown,
                    "job_cost_per_successful_bpc": float(invention_job_breakdown.get("total_job_cost") or 0.0) / success_chance,
                    "job_cost_per_run": invention_job_cost_per_run,
                    "total_cost_per_run": invention_cost,
                })

        job_cost = breakdown["total_job_cost"]
        gross_revenue = float(r.get("gross_revenue", 0) or 0)
        material_cost = float(r.get("material_cost", 0) or 0)
        sales_tax = float(r.get("sales_tax", 0) or 0)
        broker_fee = float(r.get("broker_fee", 0) or 0)

        total_cost = material_cost + job_cost + sales_tax + broker_fee + invention_cost
        net_profit = gross_revenue - total_cost

        # Keep duration semantics aligned with calculator output
        time_s = float(r.get("time_seconds") or r.get("duration") or 0)
        avg_sell_days = float(r.get("avg_sell_days", 3.0) or 3.0)
        cycle_h = (time_s + avg_sell_days * 86400.0) / 3600.0 if (time_s or avg_sell_days) else 0.0

        r["job_cost"] = job_cost
        r["job_cost_breakdown"] = breakdown
        r["invention_cost"] = invention_cost
        r["invention_detail"] = upgraded_invention_detail
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
    """Return server readiness state and warmup stage for the BootScreen."""
    age: float | None = None
    try:
        from pricer import get_market_age as _gma
        raw = _gma()
        age = round(raw, 1) if raw != float("inf") else None
    except Exception:
        pass
    return jsonify({
        "ready":              _server_ready,
        "calc_ready":         _calc_ready,
        "stage":              _warmup_stage,
        "market_age_seconds": age,
    })


_FRONTEND = os.path.join(_HERE, "..", "frontend")

@app.route("/", methods=["GET"])
async def dashboard():
    dist = os.path.join(_FRONTEND, "dist", "index.html")
    if os.path.exists(dist):
        return await send_file(dist)
    return await send_file(os.path.join(_FRONTEND, "dashboard.html"))

@app.route("/assets/<path:filename>")
async def serve_assets(filename):
    return await send_from_directory(os.path.join(_FRONTEND, "dist", "assets"), filename)


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


@app.route("/api/characters/<character_id>/corp-bp-access", methods=["PUT"])
async def api_character_corp_bp_access(character_id):
    """Update org blueprint access override for a character."""
    try:
        from characters import set_corp_bp_access
        global _ESI_BP_CACHE, _ESI_BP_CACHE_TS

        payload = await request.get_json(silent=True) or {}
        mode = payload.get("mode")
        updated = set_corp_bp_access(character_id, mode)
        with _ESI_STATE_CACHE_LOCK:
            _ESI_BP_CACHE = {}
            _ESI_BP_CACHE_TS = 0
        return jsonify({"ok": True, "character": updated})
    except ValueError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/characters/<character_id>/bp-permissions", methods=["PUT"])
async def api_character_bp_permissions(character_id):
    """Update detailed blueprint permission overrides for a character."""
    try:
        from characters import set_bp_permissions
        global _ESI_BP_CACHE, _ESI_BP_CACHE_TS

        payload = await request.get_json(silent=True) or {}
        updated = set_bp_permissions(character_id, payload.get("permissions"))
        with _ESI_STATE_CACHE_LOCK:
            _ESI_BP_CACHE = {}
            _ESI_BP_CACHE_TS = 0
        return jsonify({"ok": True, "character": updated})
    except ValueError as e:
        return jsonify({"error": str(e)}), 404
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

    if not results:
        stale_results = _scan_cache.get("results") or []
        if stale_results:
            return jsonify(_scan_cache)
        return jsonify({"error": "manufacturing scan returned no results"}), 503

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
    global _calc_ready
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
            _calc_ready = True
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
                _calc_ready = True
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
        sci_lookup_source = str((structure_meta or {}).get("solar_system_id") or system_param or "")
        copy_sci = _resolve_sci(sci_lookup_source, activity="copying") if sci_lookup_source else sci
        invention_sci = _resolve_sci(sci_lookup_source, activity="invention") if sci_lookup_source else sci

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
        if _prices_look_unhealthy(prices, output_ids):
            priced_outputs, total_outputs, coverage_ratio = _output_price_coverage(prices, output_ids)
            return jsonify({
                "error": "market price cache unavailable",
                "detail": {
                    "priced_outputs": priced_outputs,
                    "total_outputs": total_outputs,
                    "coverage_ratio": coverage_ratio,
                },
            }), 503

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
                "copying_system_cost_index":  copy_sci,
                "invention_system_cost_index": invention_sci,
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
            result["resolved_sci_copying"] = copy_sci
            result["resolved_sci_invention"] = invention_sci

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
        _calc_ready = True
        # Evict oldest entries — keep only the 8 most-recently-computed keys
        if len(_calc_cache) > 8:
            oldest_keys = sorted(_calc_cache, key=lambda k: _calc_cache[k].get("generated_at", 0))
            for _old in oldest_keys[:len(_calc_cache) - 8]:
                del _calc_cache[_old]
        # Persist to disk so the next server restart loads instantly
        threading.Thread(target=_save_calc_cache_to_disk, daemon=True).start()
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


@app.route("/api/calculator/audit", methods=["GET"])
def api_calculator_audit():
    """
    Return count breakdowns for the manufacturing calculator pipeline.
    Baseline for "missing" is the raw /api/calculator response before UI filters.
    """
    try:
        from pricer import get_prices_bulk
        from calculator import CONFIG, apply_me
        import sqlite3 as _sq

        system_param = request.args.get("system", "").strip()
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

        # Ensure calculator cache exists for this exact parameter set.
        if not _calc_is_fresh(cache_key):
            api_calculator()

        payload = _calc_cache.get(cache_key)
        if not payload:
            fresh_key = next(
                (k for k, v in _calc_cache.items() if (time.time() - v.get("generated_at", 0)) < CALC_CACHE_TTL),
                None,
            )
            if fresh_key:
                cache_key = fresh_key
                payload = _calc_cache.get(cache_key)

        if not payload:
            return jsonify({"error": "calculator cache unavailable"}), 503

        _upgrade_calc_payload_formula(payload)

        # Source totals from DB (when present).
        source_blueprints_total = None
        source_after_hard_exclusions = 0
        hard_excluded_total = None
        try:
            _db = os.path.join(_HERE, "crest.db")
            if os.path.exists(_db):
                _con = _sq.connect(_db)
                _cur = _con.cursor()
                source_blueprints_total = int(_cur.execute("SELECT COUNT(*) FROM blueprints").fetchone()[0])
                _con.close()
        except Exception:
            source_blueprints_total = None

        # Reproduce pre-check gates used by calculate_profit to expose counts by reason.
        all_blueprints = load_blueprints()
        source_after_hard_exclusions = len(all_blueprints)
        if source_blueprints_total is None:
            source_blueprints_total = source_after_hard_exclusions
        hard_excluded_total = max(0, source_blueprints_total - source_after_hard_exclusions)

        all_type_ids = set()
        output_ids = set()
        for bp in all_blueprints:
            oid = bp.get("output_id")
            if oid:
                output_ids.add(oid)
                all_type_ids.add(oid)
            for mat in bp.get("materials", []):
                tid = mat.get("type_id")
                if tid:
                    all_type_ids.add(tid)
        all_type_ids.update(MINERALS.values())

        try:
            from invention import _all_datacore_type_ids
            all_type_ids.update(_all_datacore_type_ids())
        except Exception:
            pass

        prices = get_prices_bulk(list(all_type_ids), history_ids=list(output_ids))

        facility_cfg = _facility_config(facility_param)
        try:
            structure_me_bonus = float(facility_cfg.get("me_bonus", 0) or 0)
        except Exception:
            structure_me_bonus = 0.0

        min_material_cost = float(CONFIG.get("min_material_cost", 10_000) or 10_000)
        max_rev_mat_ratio = float(CONFIG.get("max_rev_mat_ratio", 5.0) or 5.0)

        no_materials = 0
        missing_output_price = 0
        missing_input_price = 0
        low_material_cost = 0
        high_rev_mat_ratio = 0
        pass_prechecks = 0
        seen_passed_output_ids = set()

        for bp in all_blueprints:
            mats = bp.get("materials") or []
            if not mats:
                no_materials += 1
                continue

            output_id = bp.get("output_id")
            if output_id not in prices:
                missing_output_price += 1
                continue

            me_level = int(bp.get("me_level", 0) or 0)
            output_qty = int(bp.get("output_qty", 1) or 1)

            material_cost = 0.0
            has_missing_input = False
            for mat in mats:
                tid = mat.get("type_id")
                if tid not in prices:
                    has_missing_input = True
                    break
                actual_qty = apply_me(int(mat.get("quantity", 0) or 0), me_level, structure_me_bonus)
                material_cost += float(prices[tid].get("sell") or 0) * actual_qty

            if has_missing_input:
                missing_input_price += 1
                continue

            if material_cost < min_material_cost:
                low_material_cost += 1
                continue

            gross_revenue = float(prices[output_id].get("buy") or 0) * output_qty
            rev_mat_ratio = (gross_revenue / material_cost) if material_cost > 0 else 9999.0
            if rev_mat_ratio > max_rev_mat_ratio:
                high_rev_mat_ratio += 1
                continue

            pass_prechecks += 1
            seen_passed_output_ids.add(output_id)

        pre_dedupe_candidates = pass_prechecks
        estimated_unique_outputs_pre_dedupe = len(seen_passed_output_ids)
        estimated_dedupe_removed = max(0, pre_dedupe_candidates - estimated_unique_outputs_pre_dedupe)

        calc_rows_returned = len(payload.get("results") or [])

        min_volume = float(request.args.get("min_volume", "0") or 0)
        if min_volume > 0:
            after_min_volume = len([
                r for r in (payload.get("results") or [])
                if (r.get("avg_daily_volume") or 0) >= min_volume
            ])
        else:
            after_min_volume = calc_rows_returned

        return jsonify({
            "counts": {
                "source_blueprints_total": source_blueprints_total,
                "source_after_hard_exclusions": source_after_hard_exclusions,
                "hard_excluded_total": hard_excluded_total,
                "failed_no_materials": no_materials,
                "failed_missing_output_price": missing_output_price,
                "failed_missing_input_price": missing_input_price,
                "failed_min_material_cost": low_material_cost,
                "failed_high_rev_mat_ratio": high_rev_mat_ratio,
                "passed_profit_prechecks": pass_prechecks,
                "estimated_pre_dedupe_rows": pre_dedupe_candidates,
                "estimated_unique_outputs_pre_dedupe": estimated_unique_outputs_pre_dedupe,
                "estimated_dedupe_removed": estimated_dedupe_removed,
                "calc_rows_returned": calc_rows_returned,
                "calc_rows_after_min_volume": after_min_volume,
                "min_volume_filter": min_volume,
            },
            "meta": {
                "cache_key": cache_key,
                "generated_at": int(payload.get("generated_at") or time.time()),
                "formula_version": int(payload.get("job_formula_version", 0) or 0),
            },
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/job-planner", methods=["GET"])
@app.route("/api/top-performers", methods=["GET"])
def api_job_planner():
    global _ESI_BP_CACHE, _ESI_BP_CACHE_TS
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
    
    Query params for cycle-based recommendations:
      - cycle_duration_hours: float (default 12) — job cycle window in hours
      - min_profit_per_cycle: float (default 100M ISK) — filter threshold
    - max_sell_days_tolerance: float (default 7) — saturation limit in days
    - include_below_threshold_items: bool (default true) — allow low-profit filler instead of leaving slots idle
    - target_isk_per_m3: float (default 0) — soft haul-density preference, 0 disables it
    - count_corp_original_blueprints_as_own: bool (default false) — allow corp BPOs in direct manufacturing queue
    """
    import math, sqlite3 as _sq
    from calculator import calculate_industry_job_cost, calculate_profit, score_inventory_by_cycle, CONFIG as CALC_CONFIG
    from characters import load_characters, normalize_bp_permissions

    # ── Parse cycle configuration from query params ───────────────────────────
    try:
        cycle_duration_hours = float(request.args.get("cycle_duration_hours", CALC_CONFIG["default_cycle_duration_hours"]))
        structure_job_time_bonus_pct = max(0.0, min(95.0, float(request.args.get("structure_job_time_bonus_pct", 0) or 0)))
        min_profit_per_cycle = float(request.args.get("min_profit_per_cycle", CALC_CONFIG["default_min_profit_per_cycle"]))
        include_below_threshold_items = request.args.get("include_below_threshold_items", "true").lower() == "true"
        max_sell_days_tolerance = float(request.args.get("max_sell_days_tolerance", CALC_CONFIG["default_max_sell_days_tolerance"]))
        target_isk_per_m3 = max(0.0, float(request.args.get("target_isk_per_m3", 0) or 0))
        success_warn_threshold = float(request.args.get("success_warn_threshold", CALC_CONFIG["default_success_warn_threshold"]))
        weight_by_velocity = request.args.get("weight_by_velocity", "true").lower() == "true"
        count_corp_original_blueprints_as_own = request.args.get("count_corp_original_blueprints_as_own", "false").lower() == "true"
    except ValueError:
        # Fallback to defaults if invalid params
        cycle_duration_hours = CALC_CONFIG["default_cycle_duration_hours"]
        structure_job_time_bonus_pct = 0.0
        min_profit_per_cycle = CALC_CONFIG["default_min_profit_per_cycle"]
        include_below_threshold_items = True
        max_sell_days_tolerance = CALC_CONFIG["default_max_sell_days_tolerance"]
        target_isk_per_m3 = 0.0
        success_warn_threshold = CALC_CONFIG["default_success_warn_threshold"]
        weight_by_velocity = True
        count_corp_original_blueprints_as_own = False

    calc_system_param = request.args.get("system", "Korsiki").strip() or "Korsiki"
    calc_facility_param = request.args.get("facility", "large").strip().lower() or "large"
    calc_facility_tax_param = request.args.get("facility_tax_rate", "").strip()

    char_records = load_characters()
    _default_bp_permissions = normalize_bp_permissions()
    character_bp_permissions = {
        str(cid): normalize_bp_permissions(rec.get("bp_permissions"), rec.get("corp_bp_access"))
        for cid, rec in char_records.items()
    }

    def _bp_permissions_for(character_id) -> dict:
        return dict(character_bp_permissions.get(str(character_id or ""), _default_bp_permissions))

    def _bp_permission_enabled(character_id, permission_key: str) -> bool:
        return bool(_bp_permissions_for(character_id).get(permission_key))
    calc_rig_bonus_mfg_param = request.args.get("rig_bonus_mfg", "").strip()
    planner_refresh_nonce = request.args.get("refresh_nonce", "").strip()
    
    cycle_config = {
        "cycle_duration_hours": cycle_duration_hours,
        "structure_job_time_bonus_pct": structure_job_time_bonus_pct,
        "min_profit_per_cycle": min_profit_per_cycle,
        "include_below_threshold_items": include_below_threshold_items,
        "max_sell_days_tolerance": max_sell_days_tolerance,
        "target_isk_per_m3": target_isk_per_m3,
        "success_warn_threshold": success_warn_threshold,
        "count_corp_original_blueprints_as_own": count_corp_original_blueprints_as_own,
    }

    # ── Parse structure + rig configuration ───────────────────────────────────
    _structure_type = request.args.get("structure_type", "npc_station")
    _rig_1          = request.args.get("rig_1", "none")
    _rig_2          = request.args.get("rig_2", "none")
    _RIG_BONUSES = {
        "engineering_complex": {"me_t1": 1.0, "me_t2": 2.0, "te_t1": 2.0, "te_t2": 4.0},
        "azbel":               {"me_t1": 1.5, "me_t2": 3.0, "te_t1": 3.0, "te_t2": 6.0},
        "sotiyo":              {"me_t1": 2.0, "me_t2": 4.0, "te_t1": 4.0, "te_t2": 8.0},
        "npc_station":         {},
    }
    _struct_rigs  = _RIG_BONUSES.get(_structure_type, {})
    _structure_job_time_mod = max(0.01, 1.0 - (structure_job_time_bonus_pct / 100.0))
    _me_bonus_pct = (
        (_struct_rigs.get(_rig_1, 0.0) if isinstance(_rig_1, str) and _rig_1.startswith("me") else 0.0)
        + (_struct_rigs.get(_rig_2, 0.0) if isinstance(_rig_2, str) and _rig_2.startswith("me") else 0.0)
    )
    _te_bonus_pct = (
        (_struct_rigs.get(_rig_1, 0.0) if isinstance(_rig_1, str) and _rig_1.startswith("te") else 0.0)
        + (_struct_rigs.get(_rig_2, 0.0) if isinstance(_rig_2, str) and _rig_2.startswith("te") else 0.0)
    )
    _structure_name = {
        "npc_station":         "NPC Station",
        "engineering_complex": "Engineering Complex",
        "azbel":               "Azbel",
        "sotiyo":              "Sotiyo",
    }.get(_structure_type, "NPC Station")

    # ── Auto-refresh ESI blueprint cache if stale ─────────────────────────────
    # The BP cache is only refreshed when BpFinder is visited; job-planner
    # reads it directly so needs to ensure it's current.
    if not _ESI_BP_CACHE or (time.time() - _ESI_BP_CACHE_TS) >= _ESI_BP_TTL:
        try:
            api_blueprints_esi()
        except Exception as _e:
            print(f"[job-planner] BP cache refresh failed: {_e}")

    # ── Auto-refresh assets cache if stale ───────────────────────────────────
    # Assets contain BPCs tracked via is_blueprint_copy; refresh so we pick
    # up BPCs that the ESI blueprints endpoint may not have returned.
    if not _ASSETS_CACHE or (time.time() - _ASSETS_CACHE_TS) >= _ASSETS_TTL:
        try:
            api_assets()
        except Exception as _e:
            print(f"[job-planner] Assets cache refresh failed: {_e}")

    # ── Auto-refresh industry jobs cache if stale ────────────────────────────
    # The planner reads slot occupancy directly from the jobs cache, so after
    # a server restart it must hydrate that cache itself instead of waiting for
    # the Active Jobs page to be visited first.
    if not _ESI_JOBS_CACHE or (time.time() - _ESI_JOBS_CACHE_TS) >= _ESI_JOBS_TTL:
        try:
            api_industry_jobs()
        except Exception as _e:
            print(f"[job-planner] Jobs cache refresh failed: {_e}")

    # ── Auto-refresh orders cache if stale ───────────────────────────────────
    # Planner urgency and supply coverage depend on live sell-order state.
    if not _ESI_ORDERS_CACHE or (time.time() - _ESI_ORDERS_CACHE_TS) >= _ESI_ORDERS_TTL:
        try:
            api_orders()
        except Exception as _e:
            print(f"[job-planner] Orders cache refresh failed: {_e}")

    # ── Ensure calculator cache exists for this exact planner context ───────
    preferred_key_exact = _calc_cache_key(
        calc_system_param,
        calc_facility_param,
        "",
        calc_facility_tax_param,
        calc_rig_bonus_mfg_param,
    )
    if _consume_planner_refresh_nonce(preferred_key_exact, planner_refresh_nonce):
        _calc_cache.pop(preferred_key_exact, None)
        with _ESI_STATE_CACHE_LOCK:
            _ESI_BP_CACHE.clear()
            _ESI_BP_CACHE_TS = 0
        try:
            from invention import invalidate_invention_cache
            invalidate_invention_cache()
        except Exception as _e:
            print(f"[job-planner] Invention cache refresh failed: {_e}")
    if not _calc_is_fresh(preferred_key_exact):
        try:
            api_calculator()
        except Exception as _e:
            print(f"[job-planner] Calculator cache refresh failed: {_e}")

    # ── Prefer the planner's default calculator context, then fall back ─────
    planner_facility_key = {
        "npc_station": "station",
        "engineering_complex": "large",
        "azbel": "azbel",
        "sotiyo": "sotiyo",
    }.get(_structure_type, "large")

    best_key: str | None = None
    best_ts: float = 0
    preferred_key = preferred_key_exact
    if _calc_is_fresh(preferred_key):
        best_key = preferred_key
        best_ts = float(_calc_cache[preferred_key].get("generated_at", 0) or 0)
    else:
        facility_fallback_key = _calc_cache_key("Korsiki", planner_facility_key)
        if _calc_is_fresh(facility_fallback_key):
            best_key = facility_fallback_key
            best_ts = float(_calc_cache[facility_fallback_key].get("generated_at", 0) or 0)
        else:
            fallback_key = _calc_cache_key("Korsiki", "large")
            if _calc_is_fresh(fallback_key):
                best_key = fallback_key
                best_ts = float(_calc_cache[fallback_key].get("generated_at", 0) or 0)
            else:
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

    # ── Personal sell-velocity (percentile-based weighting) ──────────────────
    personal_vel: dict = {}
    try:
        personal_vel = get_sell_velocity_by_type_id()
    except Exception:
        pass

    # ── Build owned blueprint_id sets (BPO vs BPC tracked separately) ─────────
    #    Guard: if ESI blueprint data is still empty after auto-refresh + disk
    #    restore, return a clear status rather than generating idle-only output.
    if not _ESI_BP_CACHE or not _ESI_BP_CACHE.get("blueprints"):
        return jsonify({
            "items": [],
            "status": "esi_loading",
            "message": "Waiting for blueprint data from ESI — please retry in a few seconds.",
            "blueprint_debug": _get_esi_bp_fetch_info(),
            "blueprint_cache_age_s": round(max(0.0, time.time() - _ESI_BP_CACHE_TS), 2) if _ESI_BP_CACHE_TS else None,
        })

    personal_bpo_bp_ids: set = set()   # personal BPOs — original, need copying
    personal_bpc_bp_ids: set = set()   # personal BPCs — ready to manufacture
    corp_bp_ids: set         = set()
    corp_copy_bp_ids: set    = set()
    corp_manufacture_bp_ids: set = set()
    # Per-type counts tracked separately so max_dups uses the correct pool
    personal_bpo_count: dict[int, int] = {}  # type_id → # of personal BPOs in ESI
    personal_bpc_count: dict[int, int] = {}  # type_id → # of personal BPCs in ESI
    personal_bpc_runs_by_bp_id: dict[int, list[int]] = {}  # bp type_id → individual BPC run counts
    corp_bpo_count:     dict[int, int] = {}  # type_id → # of corp BPOs in ESI
    corp_bpo_copy_count: dict[int, int] = {}
    corp_bpo_manufacture_count: dict[int, int] = {}
    # Per-type character tracking: type_id → set of (character_id, character_name)
    _char_owners_by_tid: dict[int, set] = {}
    personal_bpo_count_by_tid_character: dict[int, dict[str, int]] = {}
    personal_bpc_count_by_tid_character: dict[int, dict[str, int]] = {}

    for bp in _ESI_BP_CACHE.get("blueprints", []):
        tid = bp.get("type_id")
        if not tid:
            continue
        _cid = bp.get("character_id")
        _cname = bp.get("character_name")
        # Track which authenticated characters can access this blueprint.
        access_characters = list(bp.get("access_characters") or [])
        permitted_access_characters = []
        if access_characters:
            for access in access_characters:
                access_cid = str(access.get("character_id") or "")
                access_cname = access.get("character_name") or f"Char {access_cid}"
                if access_cid and (
                    _bp_permission_enabled(access_cid, "corp_bpo_copy")
                    or _bp_permission_enabled(access_cid, "corp_bpo_manufacture")
                    or _bp_permission_enabled(access_cid, "corp_bpc")
                ):
                    permitted_access_characters.append({"character_id": access_cid, "character_name": access_cname})
                    _char_owners_by_tid.setdefault(tid, set()).add((access_cid, access_cname))
        elif bp.get("owner") != "corp" and _cid and _cname:
            _char_owners_by_tid.setdefault(tid, set()).add((_cid, _cname))
        if bp.get("owner") == "personal":
            if bp.get("bp_type") == "BPO" or bp.get("runs", -1) == -1:
                if not _bp_permission_enabled(_cid, "personal_bpo"):
                    continue
                personal_bpo_bp_ids.add(tid)
                personal_bpo_count[tid] = personal_bpo_count.get(tid, 0) + 1
                if _cid:
                    _cid_str = str(_cid)
                    per_char = personal_bpo_count_by_tid_character.setdefault(tid, {})
                    per_char[_cid_str] = per_char.get(_cid_str, 0) + 1
            else:
                if not _bp_permission_enabled(_cid, "personal_bpc"):
                    continue
                personal_bpc_bp_ids.add(tid)
                personal_bpc_count[tid] = personal_bpc_count.get(tid, 0) + 1
                if _cid:
                    _cid_str = str(_cid)
                    per_char = personal_bpc_count_by_tid_character.setdefault(tid, {})
                    per_char[_cid_str] = per_char.get(_cid_str, 0) + 1
                try:
                    personal_bpc_runs_by_bp_id.setdefault(tid, []).append(max(0, int(bp.get("runs") or 0)))
                except Exception:
                    personal_bpc_runs_by_bp_id.setdefault(tid, []).append(0)
        else:
            copy_access = any(
                _bp_permission_enabled(access.get("character_id"), "corp_bpo_copy")
                for access in permitted_access_characters
            )
            manufacture_access = any(
                _bp_permission_enabled(access.get("character_id"), "corp_bpo_manufacture")
                for access in permitted_access_characters
            )
            if not permitted_access_characters:
                continue
            if not copy_access and not manufacture_access:
                continue
            corp_bp_ids.add(tid)
            corp_bpo_count[tid] = corp_bpo_count.get(tid, 0) + 1
            if copy_access:
                corp_copy_bp_ids.add(tid)
                corp_bpo_copy_count[tid] = corp_bpo_copy_count.get(tid, 0) + 1
            if manufacture_access:
                corp_manufacture_bp_ids.add(tid)
                corp_bpo_manufacture_count[tid] = corp_bpo_manufacture_count.get(tid, 0) + 1

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
    corp_copy_output_ids: set    = set()
    corp_manufacture_output_ids: set = set()
    output_id_by_blueprint_id: dict[int, int] = {}
    # Per-output counts for duplicate cap — BPOs and BPCs tracked separately
    bpo_count_by_output: dict[int, int] = {}  # output_id → # of copyable BPOs owned
    personal_bpo_count_by_output: dict[int, int] = {}
    corp_bpo_count_by_output: dict[int, int] = {}
    corp_bpo_count_by_output_copy: dict[int, int] = {}
    corp_bpo_count_by_output_manufacture: dict[int, int] = {}
    bpc_count_by_output: dict[int, int] = {}  # output_id → # of BPCs in hand
    bpc_runs_by_output: dict[int, list[int]] = {}  # output_id → individual BPC run counts
    personal_bpo_count_by_output_character: dict[int, dict[str, int]] = {}
    personal_bpc_count_by_output_character: dict[int, dict[str, int]] = {}

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
            output_id_by_blueprint_id[int(bp_id)] = int(out_id)
            if bp_id in personal_bpo_bp_ids:
                personal_bpo_output_ids.add(out_id)
                _count = personal_bpo_count.get(bp_id, 0)
                personal_bpo_count_by_output[out_id] = personal_bpo_count_by_output.get(out_id, 0) + _count
                bpo_count_by_output[out_id] = bpo_count_by_output.get(out_id, 0) + _count
                for _char_id, _char_count in personal_bpo_count_by_tid_character.get(bp_id, {}).items():
                    per_char = personal_bpo_count_by_output_character.setdefault(out_id, {})
                    per_char[_char_id] = per_char.get(_char_id, 0) + int(_char_count or 0)
            if bp_id in personal_bpc_bp_ids:
                personal_bpc_output_ids.add(out_id)
                bpc_count_by_output[out_id] = bpc_count_by_output.get(out_id, 0) + personal_bpc_count.get(bp_id, 0)
                bpc_runs_by_output.setdefault(out_id, []).extend(personal_bpc_runs_by_bp_id.get(bp_id, []))
                for _char_id, _char_count in personal_bpc_count_by_tid_character.get(bp_id, {}).items():
                    per_char = personal_bpc_count_by_output_character.setdefault(out_id, {})
                    per_char[_char_id] = per_char.get(_char_id, 0) + int(_char_count or 0)
            if bp_id in corp_bp_ids:
                corp_output_ids.add(out_id)
                _count = corp_bpo_count.get(bp_id, 1)
                corp_bpo_count_by_output[out_id] = corp_bpo_count_by_output.get(out_id, 0) + _count
            if bp_id in corp_copy_bp_ids:
                corp_copy_output_ids.add(out_id)
                _count = corp_bpo_copy_count.get(bp_id, 1)
                corp_bpo_count_by_output_copy[out_id] = corp_bpo_count_by_output_copy.get(out_id, 0) + _count
                bpo_count_by_output[out_id] = bpo_count_by_output.get(out_id, 0) + _count
            if bp_id in corp_manufacture_bp_ids:
                corp_manufacture_output_ids.add(out_id)
                _count = corp_bpo_manufacture_count.get(bp_id, 1)
                corp_bpo_count_by_output_manufacture[out_id] = corp_bpo_count_by_output_manufacture.get(out_id, 0) + _count
    except Exception as e:
        print(f"[job-planner] DB error: {e}")

    # Build output_id → list of characters who own the blueprint
    characters_by_output: dict[int, list[dict]] = {}
    for bp_tid, char_set in _char_owners_by_tid.items():
        out_id = output_id_by_blueprint_id.get(bp_tid)
        if not out_id:
            continue
        for cid, cname in char_set:
            chars = characters_by_output.setdefault(out_id, [])
            if not any(c["character_id"] == cid for c in chars):
                chars.append({"character_id": cid, "character_name": cname})

    personal_output_ids = personal_bpo_output_ids | personal_bpc_output_ids
    owned_output_ids    = personal_output_ids | corp_output_ids
    manufacture_owned_output_ids = set(personal_output_ids)
    if count_corp_original_blueprints_as_own:
        manufacture_owned_output_ids.update(corp_manufacture_output_ids)

    existing_result_output_ids = {
        int(result.get("output_id") or 0)
        for result in all_results
        if result.get("output_id")
    }
    missing_owned_output_ids = sorted(
        int(out_id)
        for out_id in manufacture_owned_output_ids
        if int(out_id or 0) not in existing_result_output_ids
    )
    if missing_owned_output_ids:
        try:
            from database import get_avg_days_to_sell_by_type
            from pricer import get_prices_bulk

            planner_facility = dict(best_payload.get("facility") or {})
            sample_result = next((result for result in all_results if isinstance(result, dict)), {})
            planner_sci = float(best_payload.get("sci") or sample_result.get("resolved_sci") or 0.0)
            planner_copy_sci = float(sample_result.get("resolved_sci_copying") or planner_sci or 0.0)
            planner_invention_sci = float(sample_result.get("resolved_sci_invention") or planner_sci or 0.0)
            try:
                planner_facility_tax_rate = float(calc_facility_tax_param) if calc_facility_tax_param != "" else float(
                    sample_result.get("facility_tax_rate")
                    if sample_result.get("facility_tax_rate") is not None
                    else planner_facility.get("facility_tax_rate", 0.001)
                )
            except Exception:
                planner_facility_tax_rate = float(planner_facility.get("facility_tax_rate", 0.001) or 0.001)
            try:
                planner_rig_bonus_mfg = float(calc_rig_bonus_mfg_param) if calc_rig_bonus_mfg_param != "" else 0.0
            except Exception:
                planner_rig_bonus_mfg = 0.0
            try:
                planner_rig_bonus_copy = float(request.args.get("rig_bonus_copy", "") or 0.0)
            except Exception:
                planner_rig_bonus_copy = 0.0

            cfg_override = {
                **CALC_CONFIG,
                "system_cost_index": planner_sci,
                "copying_system_cost_index": planner_copy_sci,
                "invention_system_cost_index": planner_invention_sci,
                "structure_me_bonus": float(planner_facility.get("me_bonus", 0.0) or 0.0),
                "sales_tax": float(planner_facility.get("sales_tax", CALC_CONFIG.get("sales_tax", 0.036)) or 0.036),
                "facility_tax_rate": planner_facility_tax_rate,
                "structure_type_id": sample_result.get("structure_type_id") or planner_facility.get("structure_type_id"),
                "rig_bonus_mfg": planner_rig_bonus_mfg,
                "rig_bonus_copy": planner_rig_bonus_copy,
                # Owned BPO/BPC inventory is authoritative, so allow these rows even when
                # their SDE material list looks too cheap for the generic anti-junk filter.
                "max_rev_mat_ratio": max(float(CALC_CONFIG.get("max_rev_mat_ratio", 5.0) or 5.0), 9999.0),
            }
            sell_days_by_type = get_avg_days_to_sell_by_type()
            mineral_names = {v: k for k, v in MINERALS.items()}

            missing_blueprints_by_output: dict[int, dict] = {}
            for blueprint in load_blueprints():
                out_id = int(blueprint.get("output_id") or 0)
                if out_id <= 0 or out_id not in missing_owned_output_ids or out_id in missing_blueprints_by_output:
                    continue
                missing_blueprints_by_output[out_id] = blueprint

            if missing_blueprints_by_output:
                price_type_ids: set[int] = set()
                history_type_ids: set[int] = set()
                for blueprint in missing_blueprints_by_output.values():
                    out_id = int(blueprint.get("output_id") or 0)
                    if out_id > 0:
                        price_type_ids.add(out_id)
                        history_type_ids.add(out_id)
                    for material in blueprint.get("materials", []):
                        mat_id = int(material.get("type_id") or 0)
                        if mat_id > 0:
                            price_type_ids.add(mat_id)

                prices = get_prices_bulk(list(price_type_ids), history_ids=list(history_type_ids))
                for out_id, blueprint in missing_blueprints_by_output.items():
                    result = calculate_profit(
                        blueprint,
                        prices,
                        config_override=cfg_override,
                        invention_prices=prices,
                        sell_days_by_type=sell_days_by_type,
                    )
                    if not result:
                        continue

                    for material in result.get("material_breakdown", []):
                        if not material.get("name"):
                            material["name"] = mineral_names.get(material["type_id"], f"Type {material['type_id']}")

                    result["me_level"] = blueprint.get("me_level", 0)
                    result["te_level"] = blueprint.get("te_level", 0)
                    result["category"] = _normalize_category(blueprint.get("category", "Other"))
                    result["tech"] = blueprint.get("tech", "I")
                    result["size"] = blueprint.get("size", "U")
                    result["bp_type"] = blueprint.get("bp_type", "BPO")
                    result["duration"] = result.get("time_seconds") or blueprint.get("time_seconds", 0)
                    result["volume"] = blueprint.get("volume", 0)
                    result["required_skills"] = blueprint.get("required_skills", [])
                    result["blueprint_id"] = blueprint.get("blueprint_id")
                    result["planner_owned_override"] = True

                    total_cost = (
                        float(result.get("material_cost", 0) or 0.0)
                        + float(result.get("job_cost", 0) or 0.0)
                        + float(result.get("sales_tax", 0) or 0.0)
                        + float(result.get("broker_fee", 0) or 0.0)
                    )
                    profit = float(result.get("net_profit", 0) or 0.0)
                    time_s = float(result.get("time_seconds") or blueprint.get("time_seconds", 0) or 0.0)
                    avg_sell_days = float(result.get("avg_sell_days", 3.0) or 3.0)
                    total_cycle_s = time_s + (avg_sell_days * 86400.0)
                    duration_h = total_cycle_s / 3600.0 if total_cycle_s > 0 else 0.0
                    result["roi"] = (profit / total_cost * 100.0) if total_cost > 0 else 0.0
                    result["isk_per_hour"] = (profit / duration_h) if duration_h > 0 else None
                    result["isk_per_m3"] = (profit / float(result.get("volume", 0) or 0.0)) if float(result.get("volume", 0) or 0.0) > 0 else 0.0
                    result["resolved_sci"] = planner_sci
                    result["facility_label"] = planner_facility.get("label", sample_result.get("facility_label"))
                    result["structure_id"] = sample_result.get("structure_id")
                    result["structure_type_id"] = cfg_override.get("structure_type_id")
                    result["structure_meta"] = sample_result.get("structure_meta")
                    result["facility_tax_rate"] = planner_facility_tax_rate
                    result["sci_source"] = best_payload.get("sci_source", sample_result.get("sci_source", "system"))
                    result["resolved_sci_copying"] = planner_copy_sci
                    result["resolved_sci_invention"] = planner_invention_sci
                    all_results.append(result)
        except Exception as _e:
            print(f"[job-planner] Owned blueprint supplement failed: {_e}")

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

    # ── Load invention metadata (blueprint_invention table) ───────────────────
    invention_t2_bp_ids: set[int]      = set()
    invention_t1_by_t2: dict[int, int] = {}
    invention_meta: dict[int, dict]    = {}
    try:
        _inv_db = _sq.connect(os.path.join(os.path.dirname(__file__), "crest.db"))
        for _inv_row in _inv_db.execute(
            "SELECT t2_blueprint_id, t1_blueprint_id, base_success_chance, output_runs_per_bpc "
            "FROM blueprint_invention"
        ).fetchall():
            invention_t2_bp_ids.add(int(_inv_row[0]))
            if _inv_row[1]:
                invention_t1_by_t2[int(_inv_row[0])] = int(_inv_row[1])
            invention_meta[int(_inv_row[0])] = {
                "success_chance":      float(_inv_row[2] or 0.34),
                "output_runs_per_bpc": int(_inv_row[3] or 10),
            }
        _inv_db.close()
    except Exception:
        pass  # blueprint_invention table may not exist yet

    invention_time_by_blueprint_id: dict[int, int] = {}
    invention_time_source_ids = sorted({int(bp_id or 0) for bp_id in invention_t1_by_t2.values() if int(bp_id or 0) > 0})
    if invention_time_source_ids:
        try:
            _time_db = _sq.connect(os.path.join(os.path.dirname(__file__), "sqlite-latest.sqlite"))
            for _time_source_chunk_start in range(0, len(invention_time_source_ids), 900):
                _time_source_chunk = invention_time_source_ids[_time_source_chunk_start:_time_source_chunk_start + 900]
                _time_ph = ",".join("?" * len(_time_source_chunk))
                for _time_row in _time_db.execute(
                    f"SELECT typeID, time FROM industryActivity WHERE activityID = 8 AND typeID IN ({_time_ph})",
                    _time_source_chunk,
                ).fetchall():
                    invention_time_by_blueprint_id[int(_time_row[0])] = int(_time_row[1] or 0)
            _time_db.close()
        except Exception:
            pass

    def _get_invention_time_secs(blueprint_id: int) -> int:
        source_blueprint_id = int(blueprint_id or 0)
        if source_blueprint_id <= 0:
            return 0
        cached_secs = int(invention_time_by_blueprint_id.get(source_blueprint_id) or 0)
        if cached_secs > 0:
            return cached_secs
        try:
            _time_db = _sq.connect(os.path.join(os.path.dirname(__file__), "sqlite-latest.sqlite"))
            _time_row = _time_db.execute(
                "SELECT time FROM industryActivity WHERE activityID = 8 AND typeID = ?",
                (source_blueprint_id,),
            ).fetchone()
            _time_db.close()
            cached_secs = int((_time_row or [0])[0] or 0)
        except Exception:
            cached_secs = 0
        invention_time_by_blueprint_id[source_blueprint_id] = cached_secs
        return cached_secs

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

    # ── Slot timeline from active ESI manufacturing jobs ──────────────────────
    _PLAN_HORIZON_SECS = 12 * 3600   # 12-hour slot projection window
    _horizon_ts = now_ts + _PLAN_HORIZON_SECS
    # Build type_id → item name from calc results for slot-reason labels
    _type_id_to_name: dict[int, str] = {
        int(r.get("output_id", 0)): r.get("name", "")
        for r in all_results if r.get("output_id")
    }
    mfg_end_times = sorted(
        int(j["end_ts"]) for j in _ESI_JOBS_CACHE.get("jobs", [])
        if j.get("activity_id") in (1, 9, 11) and j.get("end_ts", 0) > now_ts
    )
    # Within-horizon list carries job names for the "slot freed after X" reason
    _mfg_slots_with_info: list = sorted(
        (
            int(j["end_ts"]),
            _type_id_to_name.get(int(j.get("product_type_id") or 0)) or None,
        )
        for j in _ESI_JOBS_CACHE.get("jobs", [])
        if j.get("activity_id") in (1, 9, 11)
        and now_ts < int(j.get("end_ts", 0)) <= _horizon_ts
    )
    _science_slots_with_info: list = sorted(
        (
            int(j["end_ts"]),
            _type_id_to_name.get(int(j.get("product_type_id") or 0)) or None,
            str(j.get("character_id") or ""),
        )
        for j in _ESI_JOBS_CACHE.get("jobs", [])
        if j.get("activity_id") in (3, 4, 5, 8)
        and now_ts < int(j.get("end_ts", 0)) <= _horizon_ts
    )
    future_personal_bpc_jobs_by_output_character: dict[int, dict[str, list[tuple[int, str | None]]]] = {}
    for job in _ESI_JOBS_CACHE.get("jobs", []):
        activity_id = int(job.get("activity_id") or 0)
        if activity_id not in (5, 8):
            continue
        end_ts = int(job.get("end_ts") or 0)
        if not (now_ts < end_ts <= _horizon_ts):
            continue
        if activity_id == 8:
            bp_tid = int(job.get("product_type_id") or job.get("blueprint_type_id") or 0)
        else:
            bp_tid = int(job.get("blueprint_type_id") or job.get("product_type_id") or 0)
        out_id = int(output_id_by_blueprint_id.get(bp_tid) or 0)
        char_id = str(job.get("character_id") or "")
        if not out_id or not char_id:
            continue
        if not _bp_permission_enabled(char_id, "personal_bpc"):
            continue
        ready_jobs = future_personal_bpc_jobs_by_output_character.setdefault(out_id, {}).setdefault(char_id, [])
        ready_jobs.append((
            end_ts,
            _type_id_to_name.get(out_id) or job.get("product_name") or None,
        ))
    for per_char_jobs in future_personal_bpc_jobs_by_output_character.values():
        for jobs in per_char_jobs.values():
            jobs.sort(key=lambda item: (int(item[0] or 0), str(item[1] or "")))
    future_personal_bpc_jobs_by_output: dict[int, list[tuple[int, str | None, str]]] = {}
    for out_id, per_char_jobs in future_personal_bpc_jobs_by_output_character.items():
        flat_jobs: list[tuple[int, str | None, str]] = []
        for char_id, jobs in per_char_jobs.items():
            for end_ts, freed_by_name in jobs:
                flat_jobs.append((int(end_ts or 0), freed_by_name, str(char_id or "")))
        flat_jobs.sort(key=lambda item: (int(item[0] or 0), str(item[1] or ""), str(item[2] or "")))
        future_personal_bpc_jobs_by_output[int(out_id)] = flat_jobs
    character_slot_details = _get_character_slot_details()
    running_mfg_by_character: dict[str, int] = {}
    running_science_by_character: dict[str, int] = {}
    for job in _ESI_JOBS_CACHE.get("jobs", []):
        if int(job.get("end_ts") or 0) <= now_ts:
            continue
        char_id = str(job.get("character_id") or "")
        if not char_id:
            continue
        if job.get("activity_id") in (1, 9, 11):
            running_mfg_by_character[char_id] = running_mfg_by_character.get(char_id, 0) + 1
        elif job.get("activity_id") in (3, 4, 5, 8):
            running_science_by_character[char_id] = running_science_by_character.get(char_id, 0) + 1
    running_mfg  = len(mfg_end_times)
    max_jobs     = _get_max_jobs(running_fallback=running_mfg)
    free_slots   = max(0, max_jobs - running_mfg)
    free_mfg_slots_by_character: dict[str, dict] = {}
    for char_id, details in character_slot_details.items():
        total_slots = int(details.get("mfg_slots", 0) or 0)
        free_count = max(0, total_slots - running_mfg_by_character.get(char_id, 0))
        if free_count <= 0:
            continue
        free_mfg_slots_by_character[char_id] = {
            "character_id": char_id,
            "character_name": details.get("character_name", f"Char {char_id}"),
            "remaining": free_count,
        }

    # ── Science (research) slots ───────────────────────────────────────────────
    sci_end_times = sorted(
        int(j["end_ts"]) for j in _ESI_JOBS_CACHE.get("jobs", [])
        if j.get("activity_id") in (3, 4, 5, 8) and j.get("end_ts", 0) > now_ts
    )
    running_science = len(sci_end_times)
    max_science     = _get_max_science_jobs(running_fallback=running_science)
    free_science    = max(0, max_science - running_science)
    free_science_slots_by_character: dict[str, dict] = {}
    for char_id, details in character_slot_details.items():
        total_slots = int(details.get("science_slots", 0) or 0)
        free_count = max(0, total_slots - running_science_by_character.get(char_id, 0))
        if free_count <= 0:
            continue
        free_science_slots_by_character[char_id] = {
            "character_id": char_id,
            "character_name": details.get("character_name", f"Char {char_id}"),
            "remaining": free_count,
        }
    science_slot_openings_by_character: dict[str, list[tuple[int, str | None]]] = {}
    for char_id, slot_info in free_science_slots_by_character.items():
        science_slot_openings_by_character[char_id] = [
            (now_ts, None) for _ in range(int(slot_info.get("remaining", 0) or 0))
        ]
    for end_ts, freed_by_name, char_id in _science_slots_with_info:
        if not char_id:
            continue
        openings = science_slot_openings_by_character.setdefault(char_id, [])
        openings.append((int(end_ts), freed_by_name))
    for openings in science_slot_openings_by_character.values():
        openings.sort(key=lambda item: (int(item[0] or 0), str(item[1] or "")))

    planner_character_slots = {
        "science": {
            str(char_id): {
                "character_id": str(char_id),
                "character_name": details.get("character_name", f"Char {char_id}"),
                "running": int(running_science_by_character.get(char_id, 0) or 0),
                "total": int(details.get("science_slots", 0) or 0),
                "free": max(0, int(details.get("science_slots", 0) or 0) - int(running_science_by_character.get(char_id, 0) or 0)),
            }
            for char_id, details in character_slot_details.items()
        },
        "manufacturing": {
            str(char_id): {
                "character_id": str(char_id),
                "character_name": details.get("character_name", f"Char {char_id}"),
                "running": int(running_mfg_by_character.get(char_id, 0) or 0),
                "total": int(details.get("mfg_slots", 0) or 0),
                "free": max(0, int(details.get("mfg_slots", 0) or 0) - int(running_mfg_by_character.get(char_id, 0) or 0)),
            }
            for char_id, details in character_slot_details.items()
        },
    }

    # ── Planner opportunity model ─────────────────────────────────────────────
    cycle_seconds = max(3600, int(cycle_duration_hours * 3600))
    wallet_total = _get_wallet()
    URGENCY_HORIZON_DAYS   = 7.0
    MIN_PREMIUM_DAILY_VOL  = 20.0
    MIN_FALLBACK_DAILY_VOL = 50.0
    MIN_ROI_PCT            = 5.0
    MIN_SCORE_RATIO        = 0.08
    DUPLICATE_DECAY        = 0.82
    META_VARIANT_TOKENS = (
        " enduring ", " compact ", " scoped ", " restrained ", " experimental ",
        " prototype ", " limited ", " monoproellant ", " monopropellant ",
        " i-a ", " y-s8 ", " malkuth ", " limos ", " arbalest ",
    )

    results_by_output_id: dict[int, dict] = {
        int(r.get("output_id")): r for r in all_results if r.get("output_id")
    }
    results_by_blueprint_id: dict[int, dict] = {
        int(r.get("blueprint_id")): r for r in all_results if r.get("blueprint_id")
    }

    def _clamp(value: float, lo: float, hi: float) -> float:
        return max(lo, min(hi, value))

    def _usable_bpc_parallel(run_list: list[int] | None, needed_runs: int) -> int:
        runs_required = max(1, int(needed_runs or 1))
        return sum(1 for runs in (run_list or []) if int(runs or 0) >= runs_required)

    def _total_bpc_runs(run_list: list[int] | None) -> int:
        return sum(max(0, int(runs or 0)) for runs in (run_list or []))

    blocked_recommendations: dict[str, dict] = {}

    def _record_blocked(reason_key: str, name: str, action_type: str, reason: str, score: float = 0.0, extra: dict | None = None) -> None:
        existing = blocked_recommendations.get(reason_key)
        if existing and float(existing.get("score", 0) or 0) >= float(score or 0):
            return
        payload = {
            "reason_key": reason_key,
            "name": name,
            "action_type": action_type,
            "reason": reason,
            "score": float(score or 0),
        }
        if extra:
            payload.update(extra)
        blocked_recommendations[reason_key] = payload

    def _slot_is_reaction(result: dict) -> bool:
        return "reaction" in str(result.get("slot_type") or "").lower()

    def _looks_like_meta_variant(result: dict) -> bool:
        if str(result.get("category") or "").lower() != "modules":
            return False
        if int(result.get("tech_level") or 1) != 1:
            return False
        _name = f" {str(result.get('name') or '').lower()} "
        return any(token in _name for token in META_VARIANT_TOKENS)

    def _estimate_invention_secs(copy_secs_item: int, downstream_secs: int) -> int:
        seed = max(
            3600,
            int(copy_secs_item * 0.35) if copy_secs_item else 0,
            int(downstream_secs * 0.18) if downstream_secs else 0,
        )
        return max(3600, int(min(int(cycle_seconds * 0.5), seed) * _structure_job_time_mod))

    def _nearest_cycle_count(job_secs: int, minimum: int = 1, maximum: int | None = None) -> int:
        min_count = max(1, int(math.ceil(minimum or 1)))
        if job_secs <= 0:
            return min_count
        raw_count = cycle_seconds / max(1, job_secs)
        candidate_counts = {
            min_count,
            max(min_count, int(math.floor(raw_count))),
            max(min_count, int(math.ceil(raw_count))),
        }
        if maximum is not None:
            max_count = max(min_count, int(maximum or min_count))
            candidate_counts = {
                max(min_count, min(candidate, max_count))
                for candidate in candidate_counts
            }
        best_count = min_count
        best_delta = None
        for candidate in sorted(candidate_counts):
            delta = abs((candidate * job_secs) - cycle_seconds)
            if best_delta is None or delta < best_delta or (delta == best_delta and candidate < best_count):
                best_count = candidate
                best_delta = delta
        return max(min_count, best_count)

    def _nearest_cycle_runs(job_secs: int, output_qty: int, volume: float) -> int:
        safe_cap = max(1, int((max_sell_days_tolerance * max(volume, 1.0)) / max(1, output_qty)))
        return _nearest_cycle_count(job_secs, minimum=1, maximum=safe_cap)

    def _sell_velocity_factor(output_id: int, avg_daily_volume: float) -> tuple[float, bool]:
        if not weight_by_velocity:
            return 1.0, output_id in personal_vel
        if output_id in personal_vel:
            avg_days = float(personal_vel[output_id].get("avg_days_to_sell") or 0.0)
            factor = _clamp(1.45 - (avg_days / max(1.0, max_sell_days_tolerance * 1.25)), 0.60, 1.45)
            return factor, True
        factor = _clamp(0.75 + math.log1p(max(1.0, avg_daily_volume)) / 4.0, 0.75, 1.20)
        return factor, False

    def _copy_job_cost(result: dict) -> tuple[float, dict | None]:
        try:
            _meta     = result.get("structure_meta") or {}
            _sys_id   = str(_meta.get("solar_system_id") or "")
            _copy_sci = (
                float(result.get("resolved_sci_copying") or 0)
                if result.get("resolved_sci_copying") is not None
                else (_resolve_sci(_sys_id, activity="copying") if _sys_id else float(result.get("resolved_sci") or 0))
            )
            breakdown = calculate_industry_job_cost(
                activity="copying",
                eiv=float(result.get("estimated_item_value", result.get("material_cost", 0)) or 0),
                sci=_copy_sci,
                cfg={
                    "facility_tax_rate": float(result.get("facility_tax_rate") or 0.001),
                    "structure_type_id": result.get("structure_type_id"),
                    "rig_bonus_copy": 0.0,
                    "scc_surcharge_rate": 0.04,
                },
            )
            return float(breakdown.get("total_job_cost") or 0.0), breakdown
        except Exception:
            return 0.0, None

    _planner_facility_cfg = _facility_config(planner_facility_key)
    _planner_structure_type_id = _planner_facility_cfg.get("structure_type_id")
    _planner_facility_tax_rate = float(_planner_facility_cfg.get("facility_tax_rate", 0.001) or 0.001)

    def _scale_job_cost_breakdown(breakdown: dict | None, multiplier: int) -> dict | None:
        if not breakdown:
            return None
        scale = max(1, int(multiplier or 1))
        scaled = dict(breakdown)
        for key in (
            "eiv",
            "base_cost",
            "gross",
            "gross_bonus_amount",
            "gross_after_bonus",
            "facility_tax",
            "scc_surcharge",
            "taxes_total",
            "total_job_cost",
        ):
            if scaled.get(key) is not None:
                scaled[key] = float(scaled.get(key) or 0.0) * scale
        return scaled

    def _planner_job_cost_breakdown(result: dict, run_count: int) -> tuple[dict | None, dict | None]:
        scale = max(1, int(run_count or 1))
        per_run = None
        try:
            per_run_eiv = float(result.get("estimated_item_value", result.get("material_cost", 0)) or 0.0)
            per_run_sci = float(result.get("resolved_sci") or best_payload.get("resolved_sci") or 0.0)
            if per_run_eiv > 0:
                per_run = calculate_industry_job_cost(
                    activity="manufacturing",
                    eiv=per_run_eiv,
                    sci=per_run_sci,
                    cfg={
                        "facility_tax_rate": _planner_facility_tax_rate,
                        "structure_type_id": _planner_structure_type_id,
                        "rig_bonus_mfg": 0.0,
                        "scc_surcharge_rate": 0.04,
                        "job_formula_version": int(result.get("job_formula_version", 2) or 2),
                    },
                )
        except Exception:
            per_run = None

        if per_run is None:
            cached = result.get("job_cost_breakdown")
            if isinstance(cached, dict):
                per_run = dict(cached)

        return per_run, _scale_job_cost_breakdown(per_run, scale)

    def _scaled_batch_profit(base_item: dict, run_count: float, extra_cost: float = 0.0) -> float:
        base_runs = max(1.0, float(base_item.get("rec_runs", 1) or 1))
        base_profit = float(base_item.get("profit_per_cycle", 0) or 0.0)
        scaled_profit = (base_profit / base_runs) * max(0.0, float(run_count or 0.0))
        return scaled_profit - float(extra_cost or 0.0)

    def _datacore_type_name(type_id: int) -> str:
        try:
            from invention import _load_type_names
            return _load_type_names().get(int(type_id), f"Type {type_id}")
        except Exception:
            return f"Type {type_id}"

    def _build_invention_material_breakdown(inv_detail: dict | None, attempt_count: int) -> tuple[list[dict], bool, float, float, float]:
        datacore_costs = dict((inv_detail or {}).get("datacore_costs") or {})
        attempts = max(1, int(attempt_count or 1))
        breakdown = []
        mats_ready = True
        missing_cost = 0.0
        inbound_total_m3 = 0.0
        inbound_missing_m3 = 0.0

        for idx in (1, 2):
            type_id = int(datacore_costs.get(f"dc{idx}_type_id") or 0)
            qty_per_attempt = int(datacore_costs.get(f"dc{idx}_qty") or 0)
            unit_price = float(datacore_costs.get(f"dc{idx}_price") or 0.0)
            if type_id <= 0 or qty_per_attempt <= 0:
                continue
            needed_qty_total = qty_per_attempt * attempts
            have_qty = float(_assets.get(type_id, _assets.get(str(type_id), 0)) or 0)
            covered_qty = min(have_qty, needed_qty_total)
            missing_qty = max(0.0, needed_qty_total - covered_qty)
            volume_m3 = _get_volume_m3(type_id)
            inbound_total_m3 += volume_m3 * needed_qty_total
            inbound_missing_m3 += volume_m3 * missing_qty
            line_cost_total = unit_price * needed_qty_total
            line_missing_cost = unit_price * missing_qty
            if missing_qty > 0:
                mats_ready = False
                missing_cost += line_missing_cost
            breakdown.append({
                "type_id": type_id,
                "name": _datacore_type_name(type_id),
                "quantity": qty_per_attempt,
                "needed_qty_total": needed_qty_total,
                "have_qty": have_qty,
                "covered_qty": covered_qty,
                "missing_qty": missing_qty,
                "unit_price": unit_price,
                "total_line_cost": line_cost_total,
                "missing_line_cost": line_missing_cost,
                "volume_m3": volume_m3,
                "group": "datacore",
            })

        return breakdown, mats_ready, missing_cost, inbound_total_m3, inbound_missing_m3

    _assets = _ASSETS_CACHE.get("assets", {})

    def _build_downstream(result: dict) -> dict | None:
        out_id = int(result.get("output_id") or 0)
        if out_id <= 0:
            return None

        profit = float(result.get("net_profit") or 0)
        isk_hr = float(result.get("isk_per_hour") or 0)
        volume = float(result.get("avg_daily_volume") or 0)
        roi    = float(result.get("roi") or 0)
        if profit <= 0 or isk_hr <= 0 or volume < MIN_PREMIUM_DAILY_VOL or roi < MIN_ROI_PCT:
            return None
        if _looks_like_meta_variant(result):
            return None

        sell_qty = int(sell_qty_by_type.get(out_id, 0) or 0)
        producing_qty = int(actively_producing.get(out_id, 0) or 0)
        supply_days = (sell_qty / volume) if volume > 0 else 0.0
        stale_age = float(stale_order_age_by_type.get(out_id, 0.0) or 0.0)
        if stale_age > supply_days:
            supply_days = stale_age

        urgency = max(0.08, 1.0 - (supply_days / URGENCY_HORIZON_DAYS) ** 0.8)
        if supply_days < 1.0:
            urgency = min(1.8, urgency * 1.35)
        if volume > 0 and producing_qty > 0:
            urgency *= max(0.25, 1.0 - (producing_qty / volume) / URGENCY_HORIZON_DAYS)

        adj_profit = profit
        if _me_bonus_pct > 0:
            adj_profit += float(result.get("material_cost", 0) or 0) * (_me_bonus_pct / 100.0)

        _te_mod = max(0.01, 1.0 - (_te_bonus_pct / 100.0))
        _combined_time_mod = _MFG_TIME_MODIFIER * _structure_job_time_mod * _te_mod
        raw_duration_secs = int(result.get("time_seconds", 0) or result.get("duration", 0) or 0)
        effective_duration_secs = max(1, int(raw_duration_secs * _combined_time_mod))
        output_qty = max(1, int(result.get("output_qty") or 1))
        direct_bpo_count = int(personal_bpo_count_by_output.get(out_id, 0) or 0)
        if count_corp_original_blueprints_as_own:
            direct_bpo_count += int(corp_bpo_count_by_output_manufacture.get(out_id, 0) or 0)
        direct_bpc_runs = list(bpc_runs_by_output.get(out_id, []) or [])
        direct_bpc_run_cap = max((max(0, int(runs or 0)) for runs in direct_bpc_runs), default=0)
        rec_runs = _nearest_cycle_runs(effective_duration_secs, output_qty, volume)
        if direct_bpo_count < 1 and direct_bpc_run_cap > 0:
            rec_runs = min(rec_runs, direct_bpc_run_cap)
        total_duration_secs = max(1, effective_duration_secs * rec_runs)
        total_output_units = rec_runs * output_qty
        material_cost_per_run = float(result.get("material_cost", 0) or 0.0)
        sales_tax_per_run = float(result.get("sales_tax", 0) or 0.0)
        broker_fee_per_run = float(result.get("broker_fee", 0) or 0.0)
        gross_revenue_per_run = float(result.get("gross_revenue", 0) or 0.0)
        estimated_item_value_per_run = float(result.get("estimated_item_value", 0) or 0.0)
        job_cost_breakdown_per_run, job_cost_breakdown_total = _planner_job_cost_breakdown(result, rec_runs)
        job_cost_per_run = float((job_cost_breakdown_per_run or {}).get("total_job_cost") or result.get("job_cost", 0) or 0.0)
        material_cost_total = material_cost_per_run * rec_runs
        job_cost_total = float((job_cost_breakdown_total or {}).get("total_job_cost") or (job_cost_per_run * rec_runs))
        sales_tax_total = sales_tax_per_run * rec_runs
        broker_fee_total = broker_fee_per_run * rec_runs
        gross_revenue_total = gross_revenue_per_run * rec_runs
        estimated_item_value_total = estimated_item_value_per_run * rec_runs
        days_to_sell = (total_output_units / volume) if volume > 0 else 999.0
        market_saturation_pct = round((total_output_units / volume) * 100.0, 1) if volume > 0 else 0.0
        profit_per_cycle = adj_profit * rec_runs
        cycle_fit = "fits" if total_duration_secs <= int(cycle_seconds * 1.15) else "exceeds"
        passes_profit = profit_per_cycle >= min_profit_per_cycle
        passes_saturation = days_to_sell <= max_sell_days_tolerance

        mats_ready = True
        missing_mats_est_cost = 0.0
        inbound_total_m3 = 0.0
        inbound_missing_m3 = 0.0
        planner_material_breakdown = []
        for material in result.get("material_breakdown", []):
            needed = (material.get("quantity") or 0) * rec_runs
            unit_volume = float(material.get("volume_m3") or 0.0)
            inbound_total_m3 += unit_volume * needed
            have = _assets.get(material["type_id"], _assets.get(str(material["type_id"]), 0)) or 0
            covered = min(have, needed)
            missing = max(0, needed - have)
            unit_cost = (material.get("line_cost") or 0) / max(1, material.get("quantity") or 1)
            planner_material_breakdown.append({
                **dict(material),
                "have_qty": have,
                "covered_qty": covered,
                "needed_qty_total": needed,
                "missing_qty": missing,
                "total_line_cost": unit_cost * needed,
                "missing_line_cost": unit_cost * missing,
            })
            if have < needed:
                mats_ready = False
                missing_mats_est_cost += unit_cost * missing
                inbound_missing_m3 += unit_volume * missing

        output_volume_m3 = float(result.get("volume") or 0.0)
        outbound_volume_m3 = output_volume_m3 * total_output_units
        haul_volume_m3 = inbound_missing_m3 + outbound_volume_m3
        haul_isk_per_m3 = (profit_per_cycle / haul_volume_m3) if haul_volume_m3 > 0 else 0.0
        direct_bpc_total_runs = _total_bpc_runs(direct_bpc_runs)
        direct_bpc_usable_parallel = _usable_bpc_parallel(direct_bpc_runs, rec_runs)
        direct_parallel_cap = direct_bpo_count + direct_bpc_usable_parallel

        locked_isk = material_cost_total
        capital_share = (locked_isk / wallet_total) if wallet_total > 0 else 0.0
        capital_factor = 1.0 if capital_share <= 0.25 else _clamp(1.0 - ((capital_share - 0.25) * 1.6), 0.12, 1.0)
        roi_factor = _clamp(roi / 15.0, 0.45, 1.65)
        volume_factor = _clamp(math.log1p(max(1.0, volume)) / math.log1p(250.0), 0.45, 1.25)
        sell_factor = _clamp(max_sell_days_tolerance / max(0.35, days_to_sell), 0.30, 1.35)
        timing_factor = _clamp(1.15 - (abs(total_duration_secs - cycle_seconds) / max(1.0, cycle_seconds)), 0.45, 1.15)
        velocity_factor, has_sell_history = _sell_velocity_factor(out_id, volume)
        haul_density_factor = 1.0
        if target_isk_per_m3 > 0 and haul_volume_m3 > 0:
            haul_density_factor = _clamp(haul_isk_per_m3 / target_isk_per_m3, 0.18, 1.2)
        selection_score = profit_per_cycle * roi_factor * volume_factor * sell_factor * timing_factor * urgency * capital_factor * velocity_factor * haul_density_factor
        if not passes_saturation:
            selection_score *= 0.35

        ownership = []
        if out_id in personal_bpo_output_ids:
            ownership.append("personal_bpo")
        if out_id in personal_bpc_output_ids:
            ownership.append("personal_bpc")
        if out_id in corp_manufacture_output_ids:
            ownership.append("corp_bpo")

        return {
            "name":              result["name"],
            "output_id":         out_id,
            "blueprint_id":      int(result.get("blueprint_id") or 0) or None,
            "tech":              result.get("tech", "I"),
            "tech_level":        int(result.get("tech_level") or 1),
            "category":          result.get("category", ""),
            "item_group":        result.get("item_group", ""),
            "slot_type":         result.get("slot_type", ""),
            "job_kind":          "reaction" if _slot_is_reaction(result) else "manufacturing",
            "roi":               round(roi, 1),
            "net_profit":        round(result.get("net_profit", 0)),
            "adj_net_profit":    round(adj_profit),
            "isk_per_hour":      round(result.get("isk_per_hour", 0)),
            "adj_isk_per_hour":  round((adj_profit / max(1.0, effective_duration_secs / 3600.0))),
            "avg_daily_volume":  round(volume, 1),
            "recommended_runs":  result.get("recommended_runs"),
            "rec_runs":          rec_runs,
            "runs_per_cycle":    rec_runs,
            "duration_secs":     total_duration_secs,
            "effective_run_secs": effective_duration_secs,
            "cycle_window_fit":  cycle_fit,
            "profit_per_cycle":  round(profit_per_cycle),
            "days_to_sell":      round(days_to_sell, 1),
            "market_saturation_pct": market_saturation_pct,
            "passes_profit_filter": passes_profit,
            "passes_saturation_filter": passes_saturation,
            "cycle_flags": {
                "has_below_min_profit": not passes_profit,
                "success_risky": False,
                "exceeds_cycle": cycle_fit == "exceeds",
            },
            "ownership":         ownership,
            "characters":        characters_by_output.get(out_id, []),
            "character_personal_bpo_counts": dict(personal_bpo_count_by_output_character.get(out_id, {}) or {}),
            "character_personal_bpc_counts": dict(personal_bpc_count_by_output_character.get(out_id, {}) or {}),
            "corp_bpo_count":    int(corp_bpo_count_by_output_manufacture.get(out_id, 0) or 0),
            "supply_qty":        sell_qty,
            "supply_days":       round(supply_days, 1),
            "producing_qty":     producing_qty,
            "urgency":           round(urgency, 2),
            "mats_ready":        mats_ready,
            "missing_mats_est_cost": round(missing_mats_est_cost),
            "inbound_total_m3":  round(inbound_total_m3, 1),
            "inbound_missing_m3": round(inbound_missing_m3, 1),
            "haul_volume_m3":    round(haul_volume_m3, 1),
            "haul_isk_per_m3":   round(haul_isk_per_m3, 2),
            "direct_bpo_count":  direct_bpo_count,
            "direct_bpc_count":  len(direct_bpc_runs),
            "direct_bpc_total_runs": direct_bpc_total_runs,
            "direct_bpc_usable_parallel": direct_bpc_usable_parallel,
            "direct_parallel_cap": direct_parallel_cap,
            "material_cost":     round(material_cost_total),
            "material_cost_per_run": round(material_cost_per_run),
            "job_cost":          round(job_cost_total),
            "job_cost_per_run":  round(job_cost_per_run),
            "job_cost_breakdown": job_cost_breakdown_total,
            "job_cost_breakdown_per_run": job_cost_breakdown_per_run,
            "sales_tax":         round(sales_tax_total),
            "sales_tax_per_run": round(sales_tax_per_run),
            "broker_fee":        round(broker_fee_total),
            "broker_fee_per_run": round(broker_fee_per_run),
            "invention_cost":    round(float(result.get("invention_cost", 0) or 0) * rec_runs),
            "invention_cost_per_run": round(float(result.get("invention_cost", 0) or 0)),
            "invention_detail":  result.get("invention_detail"),
            "gross_revenue":     round(gross_revenue_total),
            "gross_revenue_per_run": round(gross_revenue_per_run),
            "output_qty":        output_qty,
            "total_output_qty":  total_output_units,
            "output_volume_m3":  round(output_volume_m3, 3),
            "outbound_volume_m3": round(outbound_volume_m3, 1),
            "estimated_item_value": round(estimated_item_value_total),
            "estimated_item_value_per_run": round(estimated_item_value_per_run),
            "job_formula_version": result.get("job_formula_version", 2),
            "duration":          result.get("time_seconds", 0) or result.get("duration", 0),
            "material_breakdown": planner_material_breakdown,
            "skill_time_bonus_pct": round((1.0 - _MFG_TIME_MODIFIER) * 100, 1),
            "structure_job_time_bonus_pct": round(structure_job_time_bonus_pct, 1),
            "structure_name":    _structure_name,
            "me_bonus_pct":      _me_bonus_pct,
            "te_bonus_pct":      _te_bonus_pct,
            "capital_share_pct": round(capital_share * 100.0, 1),
            "capital_warning":   wallet_total > 0 and capital_share > 0.40,
            "copy_time_secs":    0,
            "copy_job_cost":     0,
            "copy_job_cost_per_run": 0,
            "copy_job_breakdown": None,
            "invention_success_chance": 1.0,
            "inv_output_runs_per_bpc": None,
            "estimated_copy_secs": 0,
            "estimated_invent_secs": 0,
            "science_total_secs": 0,
            "timeline_steps": [],
            "why": f"{rec_runs} runs lands near the {int(cycle_duration_hours)}h target, with {volume:.0f}/day market volume, {roi:.1f}% ROI, and ~{days_to_sell:.1f}d sell-through.",
            "is_fallback": False,
            "_has_sell_history": has_sell_history,
            "_haul_density_factor": round(haul_density_factor, 3),
            "_velocity_factor": round(velocity_factor, 3),
            "_selection_score": selection_score,
        }

    downstream_cache: dict[int, dict | None] = {}

    def _get_downstream(result: dict) -> dict | None:
        out_id = int(result.get("output_id") or 0)
        if out_id not in downstream_cache:
            downstream_cache[out_id] = _build_downstream(result)
        return downstream_cache[out_id]

    def _build_copy_candidate(base_item: dict) -> dict | None:
        out_id = int(base_item["output_id"])
        if out_id not in bpo_count_by_output or _slot_is_reaction(base_item):
            return None
        copy_secs_per_run = int((copy_time_by_output.get(out_id, 0) or 68400) * _COPY_TIME_MODIFIER * _structure_job_time_mod)
        safe_run_cap = max(1, int((max_sell_days_tolerance * max(float(base_item.get("avg_daily_volume", 0) or 1.0), 1.0)) / max(1, int(base_item.get("output_qty", 1) or 1))))
        copy_runs = _nearest_cycle_count(copy_secs_per_run, minimum=1, maximum=safe_run_cap)
        copy_time_secs_item = copy_secs_per_run * copy_runs
        downstream_run_secs = max(1.0, float(base_item.get("effective_run_secs") or 0.0) or (float(base_item.get("duration_secs", 0) or 0.0) / max(1.0, float(base_item.get("rec_runs", 1) or 1))))
        downstream_duration_secs = max(1, int(round(downstream_run_secs * copy_runs)))
        copy_job_cost_total, copy_breakdown = _copy_job_cost(results_by_output_id.get(out_id, {}))
        pipeline_factor = _clamp(cycle_seconds / max(cycle_seconds, copy_time_secs_item + downstream_duration_secs), 0.35, 1.0)
        base_profit = float(base_item.get("profit_per_cycle", 0) or 0.0)
        adjusted_profit = _scaled_batch_profit(base_item, copy_runs, copy_job_cost_total)
        profit_scale = _clamp((adjusted_profit / base_profit) if base_profit > 0 else 0.0, 0.0, 1.25)
        materials_ready = True
        missing_mats_est_cost = 0.0
        inbound_total_m3 = 0.0
        inbound_missing_m3 = 0.0
        planner_material_breakdown = []
        for material in (base_item.get("material_breakdown") or []):
            quantity_per_run = float(material.get("quantity") or 0)
            needed = quantity_per_run * copy_runs
            unit_volume = float(material.get("volume_m3") or 0.0)
            inbound_total_m3 += unit_volume * needed
            have = float(_assets.get(material.get("type_id"), _assets.get(str(material.get("type_id")), 0)) or 0)
            covered = min(have, needed)
            missing = max(0.0, needed - have)
            unit_cost = float(material.get("line_cost") or 0.0) / max(1.0, quantity_per_run)
            planner_material_breakdown.append({
                **dict(material),
                "have_qty": have,
                "covered_qty": covered,
                "needed_qty_total": needed,
                "missing_qty": missing,
                "total_line_cost": unit_cost * needed,
                "missing_line_cost": unit_cost * missing,
            })
            if missing > 0:
                materials_ready = False
                missing_mats_est_cost += unit_cost * missing
                inbound_missing_m3 += unit_volume * missing

        output_qty = max(1, int(base_item.get("output_qty", 1) or 1))
        total_output_units = output_qty * copy_runs
        output_volume_m3 = float(base_item.get("output_volume_m3") or 0.0)
        outbound_volume_m3 = output_volume_m3 * total_output_units
        haul_volume_m3 = inbound_missing_m3 + outbound_volume_m3
        haul_isk_per_m3 = (adjusted_profit / haul_volume_m3) if haul_volume_m3 > 0 else 0.0
        cycle_fit = "fits" if copy_time_secs_item <= int(cycle_seconds * 1.15) else "exceeds"
        candidate = dict(base_item)
        candidate.update({
            "action_type": "copy_first",
            "copy_time_secs": copy_time_secs_item,
            "copy_job_cost": round(copy_job_cost_total),
            "copy_job_cost_per_run": round(copy_job_cost_total / max(1, copy_runs)),
            "copy_job_breakdown": copy_breakdown,
            "estimated_copy_secs": copy_time_secs_item,
            "estimated_invent_secs": 0,
            "science_total_secs": copy_time_secs_item,
            "time_until_manufactured_secs": copy_time_secs_item + downstream_duration_secs,
            "science_cycle_runs": copy_runs,
            "science_cycle_label": "copy runs",
            "start_at": now_ts,
            "manufacture_at": now_ts + copy_time_secs_item,
            "recommended_runs": copy_runs,
            "rec_runs": copy_runs,
            "runs_per_cycle": copy_runs,
            "duration_secs": downstream_duration_secs,
            "cycle_window_fit": cycle_fit,
            "profit_per_cycle": round(adjusted_profit),
            "passes_profit_filter": adjusted_profit >= min_profit_per_cycle,
            "passes_saturation_filter": (total_output_units / max(0.0001, float(base_item.get("avg_daily_volume", 0) or 0.0))) <= max_sell_days_tolerance if float(base_item.get("avg_daily_volume", 0) or 0.0) > 0 else False,
            "days_to_sell": round((total_output_units / max(0.0001, float(base_item.get("avg_daily_volume", 0) or 0.0))) if float(base_item.get("avg_daily_volume", 0) or 0.0) > 0 else 999.0, 1),
            "market_saturation_pct": round((total_output_units / max(0.0001, float(base_item.get("avg_daily_volume", 0) or 0.0))) * 100.0, 1) if float(base_item.get("avg_daily_volume", 0) or 0.0) > 0 else 0.0,
            "mats_ready": materials_ready,
            "missing_mats_est_cost": round(missing_mats_est_cost),
            "inbound_total_m3": round(inbound_total_m3, 1),
            "inbound_missing_m3": round(inbound_missing_m3, 1),
            "haul_volume_m3": round(haul_volume_m3, 1),
            "haul_isk_per_m3": round(haul_isk_per_m3, 2),
            "material_cost": round(float(base_item.get("material_cost_per_run", 0) or 0.0) * copy_runs),
            "job_cost": round(float(base_item.get("job_cost_per_run", 0) or 0.0) * copy_runs),
            "job_cost_breakdown": _scale_job_cost_breakdown(base_item.get("job_cost_breakdown_per_run"), copy_runs),
            "sales_tax": round(float(base_item.get("sales_tax_per_run", 0) or 0.0) * copy_runs),
            "broker_fee": round(float(base_item.get("broker_fee_per_run", 0) or 0.0) * copy_runs),
            "gross_revenue": round(float(base_item.get("gross_revenue_per_run", 0) or 0.0) * copy_runs),
            "estimated_item_value": round(float(base_item.get("estimated_item_value_per_run", 0) or 0.0) * copy_runs),
            "total_output_qty": total_output_units,
            "outbound_volume_m3": round(outbound_volume_m3, 1),
            "material_breakdown": planner_material_breakdown,
            "cycle_flags": {
                **dict(base_item.get("cycle_flags") or {}),
                "has_below_min_profit": adjusted_profit < min_profit_per_cycle,
                "exceeds_cycle": cycle_fit == "exceeds",
            },
            "timeline_steps": [
                f"Copy {copy_runs} manufacturing runs",
                f"Manufacture {copy_runs} runs when the BPC completes",
            ],
            "why": f"Copy this now to land about {copy_runs} copy run{'s' if copy_runs != 1 else ''} this cycle, so the downstream {base_item['name']} manufacturing batch is ready when you need another slot filler.",
            "max_parallel": max(1, int(bpo_count_by_output.get(out_id, 1) or 1)),
            "source_bpo_count": int(bpo_count_by_output.get(out_id, 0) or 0),
            "_selection_score": base_item["_selection_score"] * 0.62 * pipeline_factor * profit_scale,
        })
        return candidate

    def _build_invention_candidate(result: dict, base_item: dict) -> dict | None:
        bp_id = int(result.get("blueprint_id") or 0)
        t1_bp_id = int(invention_t1_by_t2.get(bp_id) or 0)
        if not t1_bp_id:
            return None
        if t1_bp_id not in personal_bpo_bp_ids and t1_bp_id not in personal_bpc_bp_ids and t1_bp_id not in corp_copy_bp_ids:
            return None

        inv_meta = invention_meta.get(bp_id, {})
        inv_detail = dict(result.get("invention_detail") or {})
        if inv_detail and not bool(inv_detail.get("can_start_invention", True)):
            missing_required_skills = list(inv_detail.get("missing_required_skills") or [])
            missing_skill_text = ", ".join(
                f"{skill.get('name', 'Unknown')} {int(skill.get('actual_level', 0) or 0)}/{int(skill.get('required_level', 0) or 0)}"
                for skill in missing_required_skills
            ) or "required invention skills missing"
            _record_blocked(
                f"skill_invent:{base_item['output_id']}",
                str(base_item.get("name") or result.get("name") or "Unknown"),
                "invent_first",
                f"Blocked: no authenticated character can start invention yet. Missing skill levels: {missing_skill_text}.",
                float(base_item.get("_selection_score", 0) or 0),
                {
                    "output_id": int(base_item.get("output_id") or 0),
                    "block_kind": "skills",
                    "estimated_profit": round(float(base_item.get("profit_per_cycle", 0) or 0)),
                    "unlock_path": f"Missing: {missing_skill_text}",
                    "missing_skills": missing_required_skills,
                },
            )
            return None
        success_chance = float(inv_meta.get("success_chance") or 0.34)
        if inv_detail.get("success_chance") is not None:
            success_chance = float(inv_detail.get("success_chance") or success_chance)
        runs_per_bpc = max(1, int(inv_meta.get("output_runs_per_bpc") or 10))
        if inv_detail.get("output_runs_per_bpc") is not None:
            runs_per_bpc = max(1, int(inv_detail.get("output_runs_per_bpc") or runs_per_bpc))
        has_t1_bpc = t1_bp_id in personal_bpc_bp_ids
        t1_bpc_runs = list(personal_bpc_runs_by_bp_id.get(t1_bp_id, []) or [])
        t1_bpc_total_runs = _total_bpc_runs(t1_bpc_runs)
        t1_bpc_usable_parallel = _usable_bpc_parallel(t1_bpc_runs, 1)

        t1_output_id = output_id_by_blueprint_id.get(t1_bp_id)
        future_t1_bpc_jobs = future_personal_bpc_jobs_by_output_character.get(int(t1_output_id or 0), {}) if t1_output_id else {}
        future_t1_bpc_count = sum(len(jobs) for jobs in future_t1_bpc_jobs.values())
        future_t1_bpc_ready_at = min((int(job[0] or 0) for jobs in future_t1_bpc_jobs.values() for job in jobs), default=0)
        future_t1_bpc_job_name = next((job[1] for jobs in future_t1_bpc_jobs.values() for job in jobs if job[1]), None)
        seed_copy_secs = int(copy_time_by_output.get(t1_output_id, 0) or 68400) if t1_output_id else 68400
        downstream_run_secs = max(1.0, float(base_item.get("effective_run_secs") or 0.0) or (float(base_item.get("duration_secs", 0) or 0.0) / max(1.0, float(base_item.get("rec_runs", 1) or 1))))
        base_invention_secs = _get_invention_time_secs(t1_bp_id)
        if base_invention_secs > 0:
            invent_secs_per_attempt = max(1, int(base_invention_secs * _INVENT_TIME_MODIFIER * _structure_job_time_mod))
        else:
            invent_secs_per_attempt = _estimate_invention_secs(seed_copy_secs, int(downstream_run_secs * runs_per_bpc))
        available_attempt_cap = None
        if has_t1_bpc and t1_bpc_total_runs > 0:
            available_attempt_cap = t1_bpc_total_runs
        elif (not has_t1_bpc) and future_t1_bpc_count > 0:
            available_attempt_cap = future_t1_bpc_count
        invent_jobs_needed = _nearest_cycle_count(invent_secs_per_attempt, minimum=1, maximum=available_attempt_cap)
        copy_secs_total = 0
        copy_job_cost_total = 0.0
        copy_breakdown = None
        action_type = "invent_first"
        max_parallel = max(0, int(t1_bpc_usable_parallel or 0))
        expected_successful_bpcs = max(0.01, float(invent_jobs_needed) * max(0.01, success_chance))
        expected_runs_covered = max(1, int(round(expected_successful_bpcs * runs_per_bpc)))
        timeline_steps = [f"Run {invent_jobs_needed} invention attempt{'s' if invent_jobs_needed != 1 else ''}", f"Manufacture {expected_runs_covered} runs"]

        if not has_t1_bpc and future_t1_bpc_count < 1:
            action_type = "copy_then_invent"
            copy_secs_total = int(seed_copy_secs * invent_jobs_needed * _COPY_TIME_MODIFIER * _structure_job_time_mod)
            copy_source = results_by_output_id.get(t1_output_id) if t1_output_id else None
            copy_job_cost_total, copy_breakdown = _copy_job_cost(copy_source or {})
            copy_job_cost_total *= invent_jobs_needed
            copy_breakdown = _scale_job_cost_breakdown(copy_breakdown, invent_jobs_needed)
            max_parallel = max(1, int(personal_bpo_count.get(t1_bp_id, 0) + corp_bpo_count.get(t1_bp_id, 0) or 1))
            timeline_steps = [
                f"Copy {invent_jobs_needed} T1 BPC run{'s' if invent_jobs_needed != 1 else ''}",
                f"Run {invent_jobs_needed} invention attempt{'s' if invent_jobs_needed != 1 else ''}",
                f"Manufacture {expected_runs_covered} runs",
            ]
        elif not has_t1_bpc and future_t1_bpc_count > 0:
            action_type = "invent_first"
            max_parallel = max(1, int(future_t1_bpc_count))
            timeline_steps = [
                "Wait for active T1 copy to complete",
                f"Run {invent_jobs_needed} invention attempt{'s' if invent_jobs_needed != 1 else ''}",
                f"Manufacture {expected_runs_covered} runs",
            ]
        elif max_parallel < 1 or t1_bpc_total_runs < 1:
            _record_blocked(
                f"invent:{base_item['output_id']}",
                str(base_item.get("name") or result.get("name") or "Unknown"),
                "invent_first",
                f"Blocked: existing T1 BPCs cannot support invention yet. Need at least 1 T1 BPC run, have {t1_bpc_total_runs} total BPC run{'s' if t1_bpc_total_runs != 1 else ''} across {len(t1_bpc_runs)} cop{'ies' if len(t1_bpc_runs) != 1 else 'y'}.",
                float(base_item.get("_selection_score", 0) or 0),
                {
                    "output_id": int(base_item.get("output_id") or 0),
                    "block_kind": "blueprint_runs",
                    "estimated_profit": round(float(base_item.get("profit_per_cycle", 0) or 0)),
                    "unlock_path": f"Needs: at least 1 invention run · Have: {t1_bpc_total_runs}",
                    "required_runs": 1,
                    "available_runs": t1_bpc_total_runs,
                    "available_copies": len(t1_bpc_runs),
                },
            )
            return None

        invent_secs_total = invent_secs_per_attempt * invent_jobs_needed
        science_total_secs = copy_secs_total + invent_secs_total
        downstream_duration_secs = max(1, int(round(downstream_run_secs * expected_runs_covered)))
        manufacture_ready_at = max(now_ts, int(future_t1_bpc_ready_at or now_ts)) + science_total_secs
        time_until_manufactured_secs = (manufacture_ready_at - now_ts) + downstream_duration_secs
        pipeline_factor = _clamp(cycle_seconds / max(cycle_seconds, science_total_secs + downstream_duration_secs), 0.25, 1.0)
        base_profit = float(base_item.get("profit_per_cycle", 0) or 0.0)
        adjusted_profit = _scaled_batch_profit(base_item, expected_runs_covered, copy_job_cost_total)
        profit_scale = _clamp((adjusted_profit / base_profit) if base_profit > 0 else 0.0, 0.0, 1.25)

        materials_ready = True
        missing_mats_est_cost = 0.0
        inbound_total_m3 = 0.0
        inbound_missing_m3 = 0.0
        planner_material_breakdown = []
        for material in (base_item.get("material_breakdown") or []):
            quantity_per_run = float(material.get("quantity") or 0)
            needed = quantity_per_run * expected_runs_covered
            unit_volume = float(material.get("volume_m3") or 0.0)
            inbound_total_m3 += unit_volume * needed
            have = float(_assets.get(material.get("type_id"), _assets.get(str(material.get("type_id")), 0)) or 0)
            covered = min(have, needed)
            missing = max(0.0, needed - have)
            unit_cost = float(material.get("line_cost") or 0.0) / max(1.0, quantity_per_run)
            planner_material_breakdown.append({
                **dict(material),
                "have_qty": have,
                "covered_qty": covered,
                "needed_qty_total": needed,
                "missing_qty": missing,
                "total_line_cost": unit_cost * needed,
                "missing_line_cost": unit_cost * missing,
            })
            if missing > 0:
                materials_ready = False
                missing_mats_est_cost += unit_cost * missing
                inbound_missing_m3 += unit_volume * missing

        invention_material_breakdown, datacores_ready, datacore_missing_cost, datacore_inbound_total_m3, datacore_inbound_missing_m3 = _build_invention_material_breakdown(inv_detail, invent_jobs_needed)
        planner_material_breakdown.extend(invention_material_breakdown)
        materials_ready = materials_ready and datacores_ready
        missing_mats_est_cost += datacore_missing_cost
        inbound_total_m3 += datacore_inbound_total_m3
        inbound_missing_m3 += datacore_inbound_missing_m3

        output_qty = max(1, int(base_item.get("output_qty", 1) or 1))
        total_output_units = expected_runs_covered * output_qty
        output_volume_m3 = float(base_item.get("output_volume_m3") or 0.0)
        outbound_volume_m3 = output_volume_m3 * total_output_units
        haul_volume_m3 = inbound_missing_m3 + outbound_volume_m3
        haul_isk_per_m3 = (adjusted_profit / haul_volume_m3) if haul_volume_m3 > 0 else 0.0
        gross_revenue = float(base_item.get("gross_revenue_per_run", 0) or 0.0) * expected_runs_covered
        estimated_item_value = float(base_item.get("estimated_item_value_per_run", 0) or 0.0) * expected_runs_covered
        material_cost = float(base_item.get("material_cost_per_run", 0) or 0.0) * expected_runs_covered
        job_cost = float(base_item.get("job_cost_per_run", 0) or 0.0) * expected_runs_covered
        sales_tax = float(base_item.get("sales_tax_per_run", 0) or 0.0) * expected_runs_covered
        broker_fee = float(base_item.get("broker_fee_per_run", 0) or 0.0) * expected_runs_covered
        invention_cost = float(base_item.get("invention_cost_per_run", 0) or 0.0) * expected_runs_covered
        days_to_sell = (total_output_units / max(0.0001, float(base_item.get("avg_daily_volume", 0) or 0.0))) if float(base_item.get("avg_daily_volume", 0) or 0.0) > 0 else 999.0
        market_saturation_pct = round((total_output_units / max(0.0001, float(base_item.get("avg_daily_volume", 0) or 0.0))) * 100.0, 1) if float(base_item.get("avg_daily_volume", 0) or 0.0) > 0 else 0.0
        cycle_fit = "fits" if science_total_secs <= int(cycle_seconds * 1.15) else "exceeds"

        candidate = dict(base_item)
        source_ownership = []
        if t1_output_id in personal_bpo_output_ids:
            source_ownership.append("personal_bpo")
        if t1_output_id in personal_bpc_output_ids:
            source_ownership.append("personal_bpc")
        if t1_output_id in corp_copy_output_ids:
            source_ownership.append("corp_bpo")
        invention_eligible_character_ids = list(inv_detail.get("eligible_character_ids") or [])
        if not invention_eligible_character_ids and inv_detail.get("selected_character_id"):
            invention_eligible_character_ids = [str(inv_detail.get("selected_character_id"))]
        invention_eligible_characters = list(inv_detail.get("eligible_characters") or [])
        if not invention_eligible_characters and inv_detail.get("selected_character_id"):
            invention_eligible_characters = [{
                "character_id": str(inv_detail.get("selected_character_id")),
                "character_name": inv_detail.get("selected_character_name") or f"Char {inv_detail.get('selected_character_id')}",
            }]
        candidate.update({
            "action_type": action_type,
            "t1_blueprint_id": t1_bp_id,
            "source_output_id": t1_output_id,
            "has_t1_bpc": has_t1_bpc,
            "invention_eligible_character_ids": invention_eligible_character_ids,
            "invention_eligible_characters": invention_eligible_characters,
            "preferred_invention_character_id": str(inv_detail.get("selected_character_id")) if inv_detail.get("selected_character_id") else None,
            "preferred_invention_character_name": inv_detail.get("selected_character_name"),
            "invention_success_chance": success_chance,
            "inv_output_runs_per_bpc": runs_per_bpc,
            "science_cycle_runs": invent_jobs_needed,
            "science_cycle_label": "attempts",
            "invention_attempts": invent_jobs_needed,
            "expected_successful_bpcs": round(expected_successful_bpcs, 2),
            "expected_runs_covered": expected_runs_covered,
            "source_bpc_count": len(t1_bpc_runs),
            "source_bpc_total_runs": t1_bpc_total_runs + future_t1_bpc_count,
            "source_bpc_usable_parallel": t1_bpc_usable_parallel,
            "source_bpo_count": int(personal_bpo_count.get(t1_bp_id, 0) + corp_bpo_copy_count.get(t1_bp_id, 0) or 0),
            "characters": characters_by_output.get(t1_output_id, []) if t1_output_id else [],
            "ownership": source_ownership,
            "character_personal_bpo_counts": dict(personal_bpo_count_by_output_character.get(t1_output_id, {}) or {}),
            "character_personal_bpc_counts": dict(personal_bpc_count_by_output_character.get(t1_output_id, {}) or {}),
            "corp_bpo_count": int(corp_bpo_count_by_output_copy.get(t1_output_id, 0) or 0) if t1_output_id else 0,
            "copy_time_secs": copy_secs_total,
            "copy_job_cost": round(copy_job_cost_total),
            "copy_job_cost_per_run": round(copy_job_cost_total / max(1, invent_jobs_needed)),
            "copy_job_breakdown": copy_breakdown,
            "estimated_copy_secs": copy_secs_total,
            "estimated_invent_secs": invent_secs_total,
            "science_total_secs": science_total_secs,
            "time_until_manufactured_secs": time_until_manufactured_secs,
            "future_t1_bpc_ready_at": future_t1_bpc_ready_at or None,
            "future_t1_bpc_job_name": future_t1_bpc_job_name,
            "future_t1_bpc_count": future_t1_bpc_count,
            "start_at": now_ts,
            "manufacture_at": manufacture_ready_at,
            "timeline_steps": timeline_steps,
            "recommended_runs": expected_runs_covered,
            "rec_runs": expected_runs_covered,
            "runs_per_cycle": invent_jobs_needed,
            "duration_secs": downstream_duration_secs,
            "cycle_window_fit": cycle_fit,
            "profit_per_cycle": round(adjusted_profit),
            "passes_saturation_filter": days_to_sell <= max_sell_days_tolerance,
            "days_to_sell": round(days_to_sell, 1),
            "market_saturation_pct": market_saturation_pct,
            "mats_ready": materials_ready,
            "missing_mats_est_cost": round(missing_mats_est_cost),
            "inbound_total_m3": round(inbound_total_m3, 1),
            "inbound_missing_m3": round(inbound_missing_m3, 1),
            "haul_volume_m3": round(haul_volume_m3, 1),
            "haul_isk_per_m3": round(haul_isk_per_m3, 2),
            "material_cost": round(material_cost),
            "job_cost": round(job_cost),
            "job_cost_breakdown": _scale_job_cost_breakdown(base_item.get("job_cost_breakdown_per_run"), expected_runs_covered),
            "sales_tax": round(sales_tax),
            "broker_fee": round(broker_fee),
            "invention_cost": round(invention_cost),
            "gross_revenue": round(gross_revenue),
            "estimated_item_value": round(estimated_item_value),
            "total_output_qty": total_output_units,
            "outbound_volume_m3": round(outbound_volume_m3, 1),
            "material_breakdown": planner_material_breakdown,
            "cycle_flags": {
                **dict(base_item.get("cycle_flags") or {}),
                "has_below_min_profit": adjusted_profit < min_profit_per_cycle,
                "success_risky": success_chance <= success_warn_threshold,
                "exceeds_cycle": cycle_fit == "exceeds",
            },
            "passes_profit_filter": adjusted_profit >= min_profit_per_cycle,
            "why": (
                f"Copy then invent {base_item['name']} to land about {invent_jobs_needed} invention attempt{'s' if invent_jobs_needed != 1 else ''} this cycle, covering roughly {expected_runs_covered} manufacturing run{'s' if expected_runs_covered != 1 else ''}."
                if action_type == "copy_then_invent" else
                f"Invent {base_item['name']} as soon as the active T1 copy completes; about {invent_jobs_needed} attempt{'s' if invent_jobs_needed != 1 else ''} should cover roughly {expected_runs_covered} manufacturing run{'s' if expected_runs_covered != 1 else ''}."
                if future_t1_bpc_count > 0 and not has_t1_bpc else
                f"Invent {base_item['name']} now; {invent_jobs_needed} attempt{'s' if invent_jobs_needed != 1 else ''} at {success_chance * 100:.0f}% expected success should cover roughly {expected_runs_covered} downstream run{'s' if expected_runs_covered != 1 else ''}."
            ),
            "max_parallel": max_parallel,
            "_selection_score": base_item["_selection_score"] * pipeline_factor * profit_scale * (0.78 if action_type == "copy_then_invent" else 0.88),
        })
        return candidate

    mfg_candidates: list[dict] = []
    fallback_mfg_candidates: list[dict] = []
    science_candidates: list[dict] = []

    for result in all_results:
        out_id = int(result.get("output_id") or 0)
        base_item = _get_downstream(result)
        if not base_item:
            continue

        if out_id in manufacture_owned_output_ids:
            direct_parallel_cap = int(base_item.get("direct_parallel_cap", 0) or 0)
            direct_bpo_count = int(base_item.get("direct_bpo_count", 0) or 0)
            direct_bpc_total_runs = int(base_item.get("direct_bpc_total_runs", 0) or 0)
            required_runs = max(1, int(base_item.get("rec_runs", 1) or 1))
            if direct_parallel_cap < 1 and direct_bpo_count < 1:
                _record_blocked(
                    f"manufacture:{out_id}",
                    str(base_item.get("name") or result.get("name") or "Unknown"),
                    "manufacture",
                    "Blocked: no eligible blueprint is available to start this manufacturing batch right now.",
                    float(base_item.get("_selection_score", 0) or 0),
                    {
                        "output_id": out_id,
                        "block_kind": "blueprint_access",
                        "estimated_profit": round(float(base_item.get("profit_per_cycle", 0) or 0)),
                        "unlock_path": "Missing: eligible BPO/BPC",
                        "required_runs": required_runs,
                        "available_runs": direct_bpc_total_runs,
                        "available_copies": int(base_item.get("direct_bpc_count", 0) or 0),
                    },
                )
                continue
            if direct_bpo_count < 1 and direct_bpc_total_runs < required_runs:
                _record_blocked(
                    f"manufacture:{out_id}",
                    str(base_item.get("name") or result.get("name") or "Unknown"),
                    "manufacture",
                    f"Blocked: manufacturing batch needs {required_runs} BPC run{'s' if required_runs != 1 else ''}, but only {direct_bpc_total_runs} run{'s' if direct_bpc_total_runs != 1 else ''} remain across {int(base_item.get('direct_bpc_count', 0) or 0)} cop{'ies' if int(base_item.get('direct_bpc_count', 0) or 0) != 1 else 'y'}.",
                    float(base_item.get("_selection_score", 0) or 0),
                    {
                        "output_id": out_id,
                        "block_kind": "blueprint_runs",
                        "estimated_profit": round(float(base_item.get("profit_per_cycle", 0) or 0)),
                        "unlock_path": f"Needs: {required_runs} run{'s' if required_runs != 1 else ''} · Have: {direct_bpc_total_runs}",
                        "required_runs": required_runs,
                        "available_runs": direct_bpc_total_runs,
                        "available_copies": int(base_item.get("direct_bpc_count", 0) or 0),
                    },
                )
                continue
            mfg_item = dict(base_item)
            mfg_item.update({
                "action_type": "manufacture",
                "start_at": now_ts,
                "manufacture_at": now_ts,
                "max_parallel": max(1, direct_parallel_cap),
                "rec_id": f"manufacture:{out_id}:1",
            })
            mfg_candidates.append(mfg_item)

            if float(mfg_item.get("avg_daily_volume") or 0) >= MIN_FALLBACK_DAILY_VOL:
                fb_item = dict(mfg_item)
                fb_item["is_fallback"] = True
                fb_item["why"] = (
                    f"Fallback filler: {fb_item['name']} is not the top-margin pick, but {fb_item['avg_daily_volume']:.0f}/day volume keeps the slot busy with lower market risk."
                )
                fb_item["_selection_score"] *= 0.86
                fallback_mfg_candidates.append(fb_item)

            if out_id in bpo_count_by_output and not _slot_is_reaction(result):
                copy_candidate = _build_copy_candidate(base_item)
                if copy_candidate:
                    science_candidates.append(copy_candidate)

        if int(result.get("blueprint_id") or 0) in invention_t2_bp_ids:
            invention_candidate = _build_invention_candidate(result, base_item)
            if invention_candidate:
                science_candidates.append(invention_candidate)

    def _dedupe_candidate_pool(pool: list[dict]) -> list[dict]:
        deduped: dict[tuple, dict] = {}
        for candidate in pool:
            key = (
                str(candidate.get("action_type") or ""),
                bool(candidate.get("is_fallback")),
                int(candidate.get("output_id") or 0),
                int(candidate.get("t1_blueprint_id") or 0),
                bool(candidate.get("has_t1_bpc")),
            )
            existing = deduped.get(key)
            if existing is None or float(candidate.get("_selection_score", 0) or 0) > float(existing.get("_selection_score", 0) or 0):
                deduped[key] = candidate
        return list(deduped.values())

    mfg_candidates = _dedupe_candidate_pool(mfg_candidates)
    fallback_mfg_candidates = _dedupe_candidate_pool(fallback_mfg_candidates)
    science_candidates = _dedupe_candidate_pool(science_candidates)

    def _expand_candidates(pool: list[dict], target: int) -> list[dict]:
        expanded: list[dict] = []
        planned_units: dict[int, int] = {}
        for candidate in sorted(pool, key=lambda item: item.get("_selection_score", 0), reverse=True):
            out_id = int(candidate["output_id"])
            cap = max(1, int(candidate.get("max_parallel", 1) or 1))
            units = max(1, int(candidate.get("rec_runs", 1) or 1)) * max(1, int(candidate.get("output_qty", 1) or 1))
            safe_units = max(units, int(float(candidate.get("avg_daily_volume", 0) or 0) * max(1.0, max_sell_days_tolerance)))
            for dup_idx in range(cap):
                projected_units = planned_units.get(out_id, 0) + units
                if dup_idx > 0 and projected_units > int(safe_units * 1.15):
                    break
                dup = dict(candidate)
                dup["duplicate_rank"] = dup_idx + 1
                dup["_selection_score"] = float(candidate.get("_selection_score", 0) or 0) * (DUPLICATE_DECAY ** dup_idx)
                dup["rec_id"] = f"{dup['action_type']}:{out_id}:{dup_idx + 1}"
                planned_units[out_id] = projected_units
                expanded.append(dup)
                if len(expanded) >= max(target * 3, target):
                    break
            if len(expanded) >= max(target * 3, target):
                break
        expanded.sort(key=lambda item: item.get("_selection_score", 0), reverse=True)
        if expanded:
            floor = float(expanded[0].get("_selection_score", 0) or 0) * MIN_SCORE_RATIO
            preferred = [item for item in expanded if float(item.get("_selection_score", 0) or 0) >= floor]
            if len(preferred) < min(target, len(expanded)):
                seen_rec_ids = {str(item.get("rec_id") or "") for item in preferred}
                for item in expanded:
                    rec_id = str(item.get("rec_id") or "")
                    if rec_id in seen_rec_ids:
                        continue
                    preferred.append(item)
                    seen_rec_ids.add(rec_id)
                    if len(preferred) >= target:
                        break
            expanded = preferred
        return expanded[:target]

    premium_mfg_pool = [
        item for item in mfg_candidates
        if item.get("passes_profit_filter") and item.get("passes_saturation_filter")
    ]
    mfg_items_raw = _expand_candidates(premium_mfg_pool, max_jobs)
    if len(mfg_items_raw) < max_jobs:
        seen_rec_ids = {item["rec_id"] for item in mfg_items_raw}
        fallback_pool = [
            item for item in fallback_mfg_candidates
            if item["rec_id"] not in seen_rec_ids
            and (include_below_threshold_items or item.get("passes_profit_filter"))
        ]
        mfg_items_raw.extend(_expand_candidates(fallback_pool, max_jobs - len(mfg_items_raw)))
    if len(mfg_items_raw) < max_jobs:
        seen_rec_ids = {item["rec_id"] for item in mfg_items_raw}
        emergency_pool: list[dict] = []
        for item in mfg_candidates:
            if item["rec_id"] in seen_rec_ids:
                continue
            if not include_below_threshold_items and not item.get("passes_profit_filter"):
                continue
            emergency_item = dict(item)
            emergency_item["is_fallback"] = True
            emergency_item["is_emergency_fill"] = True
            emergency_item["why"] = (
                f"Emergency filler: {emergency_item['name']} was pulled in to avoid leaving a manufacturing slot idle under the current planner filters."
            )
            emergency_item["_selection_score"] = float(emergency_item.get("_selection_score", 0) or 0) * 0.72
            emergency_pool.append(emergency_item)
        mfg_items_raw.extend(_expand_candidates(emergency_pool, max_jobs - len(mfg_items_raw)))
    mfg_items_raw = mfg_items_raw[:max_jobs]

    science_pool = [
        item for item in science_candidates
        if item.get("passes_profit_filter") and float(item.get("profit_per_cycle", 0) or 0) > 0
    ]
    sci_items_raw = _expand_candidates(science_pool, max_science)[:max_science]

    # ── Fallback science tier: fill remaining science slots with lower-profit  ─
    # items rather than leaving them idle.  These are items that didn't pass the
    # min-profit filter but are still net-positive, or items already placed that
    # have additional BPO copies we haven't used yet.
    if len(sci_items_raw) < max_science:
        sci_seen_rec_ids = {str(item.get("rec_id") or "") for item in sci_items_raw}
        sci_seen_output_ids = {int(item.get("output_id") or 0) for item in sci_items_raw}
        emergency_sci_pool: list[dict] = []
        for item in science_candidates:
            if str(item.get("rec_id") or "") in sci_seen_rec_ids:
                continue
            if not include_below_threshold_items and not item.get("passes_profit_filter"):
                continue
            emergency_item = dict(item)
            emergency_item["is_fallback"] = True
            emergency_item["why"] = (
                f"Fallback filler: {emergency_item['name']} keeps a science slot busy rather than idle."
            )
            # Deprioritise items whose output is already queued
            _output_already_queued = int(emergency_item.get("output_id") or 0) in sci_seen_output_ids
            emergency_item["_selection_score"] = (
                float(emergency_item.get("_selection_score", 0) or 0) * (0.55 if _output_already_queued else 0.72)
            )
            emergency_sci_pool.append(emergency_item)
        sci_items_raw.extend(
            _expand_candidates(emergency_sci_pool, max_science - len(sci_items_raw))
        )
        sci_items_raw = sci_items_raw[:max_science]

    planned_future_personal_bpc_jobs_by_output_character: dict[int, dict[str, list[tuple[int, str | None]]]] = {}
    for item in sci_items_raw:
        if item.get("action_type") not in ("invent_first", "copy_then_invent"):
            continue
        ready_at = int(item.get("manufacture_at") or 0)
        if not (now_ts < ready_at <= _horizon_ts):
            continue
        char_id = str(item.get("preferred_invention_character_id") or "")
        if not char_id:
            eligible_ids = [str(candidate_id) for candidate_id in (item.get("invention_eligible_character_ids") or []) if candidate_id]
            char_id = eligible_ids[0] if eligible_ids else ""
        if not char_id:
            continue
        out_id = int(item.get("output_id") or 0)
        if not out_id:
            continue
        ready_jobs = planned_future_personal_bpc_jobs_by_output_character.setdefault(out_id, {}).setdefault(char_id, [])
        ready_jobs.append((ready_at, str(item.get("name") or "") or None))
    for per_char_jobs in planned_future_personal_bpc_jobs_by_output_character.values():
        for jobs in per_char_jobs.values():
            jobs.sort(key=lambda item: (int(item[0] or 0), str(item[1] or "")))

    def _attach_runner_up(selected: list[dict], pool: list[dict]) -> None:
        for item in selected:
            alt = next(
                (
                    candidate for candidate in pool
                    if candidate.get("rec_id") != item.get("rec_id")
                    and candidate.get("output_id") != item.get("output_id")
                ),
                None,
            )
            if not alt:
                continue
            item["runner_up_name"] = alt.get("name")
            item["runner_up_action_type"] = alt.get("action_type")
            item["runner_up_profit_per_cycle"] = round(float(alt.get("profit_per_cycle", 0) or 0))
            item["runner_up_ready_at"] = int(alt.get("manufacture_at") or alt.get("start_at") or now_ts)

    _attach_runner_up(mfg_items_raw, sorted(mfg_candidates, key=lambda item: item.get("_selection_score", 0), reverse=True))
    _attach_runner_up(sci_items_raw, sorted(science_candidates, key=lambda item: item.get("_selection_score", 0), reverse=True))

    candidates = mfg_candidates + science_candidates

    # ── MFG slot pool: free slots first, then by release time (within 12h) ────
    # Each entry is (timestamp, freed_by_job_name); free slots get name = None
    _mfg_pool: list = sorted(
        [(now_ts, None)] * free_slots + list(_mfg_slots_with_info)
    )

    # ── Assign action_type + start_at per item ────────────────────────────────
    items = []

    for r in sci_items_raw:
        out_id         = r["output_id"]
        bp_id          = r.get("blueprint_id") or blueprint_id_by_output.get(out_id)
        if not r.get("action_type") and bp_id and bp_id in invention_t2_bp_ids:
            inv_meta = invention_meta.get(bp_id, {})
            r["action_type"]              = "invent_first"
            r["t1_blueprint_id"]          = invention_t1_by_t2.get(bp_id)
            r["has_t1_bpc"]               = bool(
                r.get("t1_blueprint_id") and r["t1_blueprint_id"] in personal_bpc_bp_ids
            )
            r["invention_success_chance"] = inv_meta.get("success_chance", 0.34)
            r["inv_output_runs_per_bpc"]  = inv_meta.get("output_runs_per_bpc", 10)
        elif not r.get("action_type"):
            r["action_type"] = "copy_first"

        copy_secs = int(r.get("estimated_copy_secs") or r.get("copy_time_secs") or 0)
        invent_secs = int(r.get("estimated_invent_secs") or 0)
        science_secs = int(r.get("science_total_secs") or (copy_secs + invent_secs) or 0)

        r["start_at"] = int(r.get("start_at") or now_ts)
        if not r.get("estimated_copy_secs"):
            r["estimated_copy_secs"] = copy_secs
        if not r.get("science_total_secs"):
            r["science_total_secs"] = science_secs
        if not r.get("manufacture_at"):
            r["manufacture_at"] = r["start_at"] + science_secs
        items.append(r)

    scheduled_mfg_items = list(mfg_items_raw)
    if len(scheduled_mfg_items) < max_jobs:
        pipeline_fill_candidates: list[dict] = []
        for sci_idx, source in enumerate(sorted(sci_items_raw, key=lambda item: item.get("_selection_score", 0), reverse=True), start=1):
            ready_at = int(source.get("manufacture_at") or 0)
            if ready_at <= now_ts or ready_at > _horizon_ts:
                continue
            pipeline_item = dict(source)
            pipeline_item["action_type"] = "manufacture"
            pipeline_item["is_fallback"] = True
            pipeline_item["is_pipeline_fill"] = True
            pipeline_item["pipeline_source_action"] = source.get("action_type")
            pipeline_item["_selection_score"] = float(source.get("_selection_score", 0) or 0) * 0.8
            pipeline_item["why"] = (
                f"Pipeline fill: {pipeline_item['name']} becomes manufacturable after {str(source.get('action_type') or 'science prep').replace('_', ' ')} completes, so it can backfill an otherwise idle manufacturing slot inside the planning horizon."
            )
            pipeline_item["rec_id"] = f"pipeline-manufacture:{int(pipeline_item['output_id'])}:{sci_idx}"
            pipeline_fill_candidates.append(pipeline_item)

        seen_output_ids = {int(item.get("output_id") or 0) for item in scheduled_mfg_items}
        for future_idx, (out_id, jobs) in enumerate(sorted(future_personal_bpc_jobs_by_output.items()), start=1):
            if len(scheduled_mfg_items) + len(pipeline_fill_candidates) >= max_jobs:
                break
            if int(out_id or 0) in seen_output_ids:
                continue
            if int(out_id or 0) in manufacture_owned_output_ids:
                continue
            if not jobs:
                continue
            result = results_by_output_id.get(int(out_id))
            if not result:
                continue
            pipeline_item = _get_downstream(result)
            if not pipeline_item:
                continue
            ready_at, ready_by, _ready_char_id = jobs[0]
            if int(ready_at or 0) <= now_ts or int(ready_at or 0) > _horizon_ts:
                continue
            pipeline_item = dict(pipeline_item)
            pipeline_item["action_type"] = "manufacture"
            pipeline_item["is_fallback"] = True
            pipeline_item["is_pipeline_fill"] = True
            pipeline_item["pipeline_source_action"] = "active_invent"
            pipeline_item["_selection_score"] = float(pipeline_item.get("_selection_score", 0) or 0) * 0.76
            pipeline_item["start_at"] = int(ready_at)
            pipeline_item["manufacture_at"] = int(ready_at)
            pipeline_item["slot_freed_by"] = ready_by
            pipeline_item["timeline_steps"] = [
                "Wait for active invention to complete",
                f"Manufacture {pipeline_item.get('rec_runs', 1)} runs",
            ]
            pipeline_item["why"] = (
                f"Pipeline fill: {pipeline_item['name']} becomes manufacturable when an active invention job completes, so it can backfill an otherwise idle manufacturing slot inside the planning horizon."
            )
            pipeline_item["rec_id"] = f"future-manufacture:{int(pipeline_item['output_id'])}:{future_idx}"
            pipeline_fill_candidates.append(pipeline_item)
            seen_output_ids.add(int(out_id or 0))

        seen_rec_ids = {str(item.get("rec_id") or "") for item in scheduled_mfg_items}
        for pipeline_item in pipeline_fill_candidates:
            rec_id = str(pipeline_item.get("rec_id") or "")
            if rec_id in seen_rec_ids:
                continue
            scheduled_mfg_items.append(pipeline_item)
            seen_rec_ids.add(rec_id)
            if len(scheduled_mfg_items) >= max_jobs:
                break

    for i, r in enumerate(scheduled_mfg_items[:max_jobs]):
        r["action_type"] = "manufacture"
        if i < len(_mfg_pool):
            _slot_ts, _slot_job  = _mfg_pool[i]
            if r.get("is_pipeline_fill"):
                r["start_at"] = max(int(_slot_ts), int(r.get("manufacture_at") or _slot_ts))
            else:
                r["start_at"] = int(_slot_ts)
            r["slot_freed_by"]   = _slot_job   # None = start now; str = freed after that job
        else:
            if r.get("is_pipeline_fill"):
                r["start_at"] = int(r.get("manufacture_at") or now_ts)
            else:
                r["start_at"] = now_ts
            r["slot_freed_by"]   = None
        r["manufacture_at"] = r["start_at"]
        items.append(r)

    shared_personal_bpo_remaining = {
        int(out_id): {str(char_id): int(count or 0) for char_id, count in (per_char or {}).items()}
        for out_id, per_char in personal_bpo_count_by_output_character.items()
    }
    shared_personal_bpc_remaining = {
        int(out_id): {str(char_id): int(count or 0) for char_id, count in (per_char or {}).items()}
        for out_id, per_char in personal_bpc_count_by_output_character.items()
    }
    shared_corp_bpo_remaining = {
        int(out_id): int(count or 0)
        for out_id, count in corp_bpo_count_by_output.items()
    }
    combined_future_personal_bpc_jobs_by_output_character: dict[int, dict[str, list[tuple[int, str | None]]]] = {}
    for source in (future_personal_bpc_jobs_by_output_character, planned_future_personal_bpc_jobs_by_output_character):
        for out_id, per_char in source.items():
            merged_per_char = combined_future_personal_bpc_jobs_by_output_character.setdefault(int(out_id), {})
            for char_id, jobs in (per_char or {}).items():
                merged_jobs = merged_per_char.setdefault(str(char_id), [])
                merged_jobs.extend(list(jobs or []))
    for per_char in combined_future_personal_bpc_jobs_by_output_character.values():
        for jobs in per_char.values():
            jobs.sort(key=lambda item: (int(item[0] or 0), str(item[1] or "")))
    combined_future_personal_bpc_jobs_by_output: dict[int, list[tuple[int, str | None, str]]] = {}
    for out_id, per_char in combined_future_personal_bpc_jobs_by_output_character.items():
        flat_jobs: list[tuple[int, str | None, str]] = []
        for char_id, jobs in per_char.items():
            for end_ts, ready_name in jobs:
                flat_jobs.append((int(end_ts or 0), ready_name, str(char_id or "")))
        flat_jobs.sort(key=lambda item: (int(item[0] or 0), str(item[1] or ""), str(item[2] or "")))
        combined_future_personal_bpc_jobs_by_output[int(out_id)] = flat_jobs
    shared_future_personal_bpc_jobs = {
        int(out_id): {
            str(char_id): list(jobs)
            for char_id, jobs in (per_char or {}).items()
        }
        for out_id, per_char in combined_future_personal_bpc_jobs_by_output_character.items()
    }
    shared_future_personal_bpc_jobs_global = {
        int(out_id): list(jobs)
        for out_id, jobs in combined_future_personal_bpc_jobs_by_output.items()
    }
    slot_maps = {
        "science": free_science_slots_by_character,
        "manufacturing": free_mfg_slots_by_character,
    }
    idle_blockers = {
        "science": {},
        "manufacturing": {},
    }

    def _record_idle_blocker(slot_kind: str, char_id: str, reason_key: str) -> None:
        slot_blockers = idle_blockers.setdefault(slot_kind, {})
        blocked = slot_blockers.setdefault(char_id, {"blueprint_busy": 0, "blueprint_missing": 0})
        blocked[reason_key] = int(blocked.get(reason_key, 0) or 0) + 1

    def _mark_candidate_blockers(item: dict, slot_kind: str, reason_key: str) -> None:
        slot_map = slot_maps.get(slot_kind, {})
        personal_bpo_chars = set((item.get("character_personal_bpo_counts") or {}).keys())
        personal_bpc_chars = set((item.get("character_personal_bpc_counts") or {}).keys())
        known_access_chars = {str(c.get("character_id") or "") for c in (item.get("characters") or []) if c.get("character_id")}
        candidate_ids = set()
        if slot_kind == "manufacturing":
            candidate_ids.update(personal_bpo_chars)
            candidate_ids.update(personal_bpc_chars)
            if "corp_bpo" in (item.get("ownership") or []):
                candidate_ids.update(known_access_chars)
        elif item.get("action_type") in ("copy_first", "copy_then_invent"):
            candidate_ids.update(personal_bpo_chars)
            if "corp_bpo" in (item.get("ownership") or []):
                candidate_ids.update(known_access_chars)
        else:
            candidate_ids.update(known_access_chars)
        for char_id in candidate_ids:
            if not char_id or int(slot_map.get(char_id, {}).get("remaining", 0) or 0) <= 0:
                continue
            _record_idle_blocker(slot_kind, char_id, reason_key)

    def _candidate_options_for_item(item: dict, slot_kind: str) -> list[dict]:
        slot_map = slot_maps.get(slot_kind, {})
        access_output_id = int(item.get("source_output_id") or item.get("output_id") or 0)
        ownership = item.get("ownership") or []
        action_type = item.get("action_type")
        invention_eligible_ids = {str(char_id) for char_id in (item.get("invention_eligible_character_ids") or []) if char_id}
        known_access_chars = {str(c.get("character_id") or "") for c in (item.get("characters") or []) if c.get("character_id")}
        options = []

        if slot_kind == "science":
            candidate_char_ids = sorted({
                str(char_id) for char_id in science_slot_openings_by_character.keys()
                if char_id
            })
        else:
            candidate_char_ids = list(slot_map.keys())

        for char_id in candidate_char_ids:
            slot_info = slot_map.get(char_id) or character_slot_details.get(char_id) or {
                "character_id": char_id,
                "character_name": f"Char {char_id}",
                "remaining": 0,
            }
            char_permissions = _bp_permissions_for(char_id)
            can_use_personal_bpo = bool(char_permissions.get("personal_bpo"))
            can_use_personal_bpc = bool(char_permissions.get("personal_bpc"))
            can_use_corp_copy = bool(char_permissions.get("corp_bpo_copy"))
            can_use_corp_manufacture = bool(char_permissions.get("corp_bpo_manufacture"))
            if slot_kind == "science":
                slot_openings = science_slot_openings_by_character.get(char_id, [])
                if not slot_openings:
                    continue
                next_slot_ts, next_slot_freed_by = slot_openings[0]
                remaining = len(slot_openings)
            else:
                remaining = int(slot_info.get("remaining", 0) or 0)
                if remaining <= 0:
                    continue
                next_slot_ts, next_slot_freed_by = now_ts, None
            future_bpc_jobs = ((shared_future_personal_bpc_jobs.get(access_output_id, {}) or {}).get(char_id) or [])
            future_bpc_jobs_global = shared_future_personal_bpc_jobs_global.get(access_output_id, []) or []
            future_bpc_ready_at = int(future_bpc_jobs[0][0] or 0) if future_bpc_jobs else now_ts
            future_bpc_ready_by = future_bpc_jobs[0][1] if future_bpc_jobs else None
            global_future_bpc_ready_at = int(future_bpc_jobs_global[0][0] or 0) if future_bpc_jobs_global else now_ts
            global_future_bpc_ready_by = future_bpc_jobs_global[0][1] if future_bpc_jobs_global else None
            access_kind = None
            access_priority = 9
            bp_ready_at = now_ts
            bp_ready_by = None
            if slot_kind == "manufacturing":
                if can_use_personal_bpc and int((shared_personal_bpc_remaining.get(access_output_id, {}) or {}).get(char_id, 0) or 0) > 0:
                    access_kind = "personal_bpc"
                    access_priority = 0
                elif can_use_personal_bpo and int((shared_personal_bpo_remaining.get(access_output_id, {}) or {}).get(char_id, 0) or 0) > 0:
                    access_kind = "personal_bpo"
                    access_priority = 1
                elif can_use_corp_manufacture and "corp_bpo" in ownership and char_id in known_access_chars and int(shared_corp_bpo_remaining.get(access_output_id, 0) or 0) > 0:
                    access_kind = "corp_bpo"
                    access_priority = 2
                elif can_use_personal_bpc and future_bpc_jobs:
                    access_kind = "future_personal_bpc"
                    access_priority = 3
                    bp_ready_at = future_bpc_ready_at
                    bp_ready_by = future_bpc_ready_by
                elif can_use_personal_bpc and future_bpc_jobs_global:
                    access_kind = "future_personal_bpc"
                    access_priority = 3
                    bp_ready_at = global_future_bpc_ready_at
                    bp_ready_by = global_future_bpc_ready_by
            elif action_type == "copy_first":
                if can_use_personal_bpo and int((shared_personal_bpo_remaining.get(access_output_id, {}) or {}).get(char_id, 0) or 0) > 0:
                    access_kind = "personal_bpo"
                    access_priority = 0
                elif can_use_corp_copy and "corp_bpo" in ownership and char_id in known_access_chars and int(shared_corp_bpo_remaining.get(access_output_id, 0) or 0) > 0:
                    access_kind = "corp_bpo"
                    access_priority = 1
            elif action_type == "copy_then_invent":
                if can_use_personal_bpo and int((shared_personal_bpo_remaining.get(access_output_id, {}) or {}).get(char_id, 0) or 0) > 0:
                    access_kind = "personal_bpo"
                    access_priority = 0
                elif can_use_corp_copy and "corp_bpo" in ownership and char_id in known_access_chars and int(shared_corp_bpo_remaining.get(access_output_id, 0) or 0) > 0:
                    access_kind = "corp_bpo"
                    access_priority = 1
            else:
                if invention_eligible_ids and char_id not in invention_eligible_ids:
                    access_kind = None
                elif can_use_personal_bpc and int((shared_personal_bpc_remaining.get(access_output_id, {}) or {}).get(char_id, 0) or 0) > 0:
                    access_kind = "personal_bpc"
                    access_priority = 0
                elif can_use_personal_bpc and future_bpc_jobs:
                    access_kind = "future_personal_bpc"
                    access_priority = 1
                    bp_ready_at = future_bpc_ready_at
                    bp_ready_by = future_bpc_ready_by
                elif can_use_personal_bpc and future_bpc_jobs_global:
                    access_kind = "future_personal_bpc"
                    access_priority = 1
                    bp_ready_at = global_future_bpc_ready_at
                    bp_ready_by = global_future_bpc_ready_by

            if access_kind is None:
                continue

            options.append({
                "character_id": char_id,
                "character_name": slot_info.get("character_name", f"Char {char_id}"),
                "remaining": remaining,
                "slot_open_ts": int(next_slot_ts or 0),
                "slot_freed_by": next_slot_freed_by,
                "bp_ready_at": int(bp_ready_at or now_ts),
                "bp_ready_by": bp_ready_by,
                "effective_start_ts": max(int(next_slot_ts or 0), int(bp_ready_at or now_ts)),
                "access_kind": access_kind,
                "access_priority": access_priority,
            })

        options.sort(key=lambda option: (
            int(option.get("access_priority", 9) or 9),
            int(option.get("effective_start_ts", 0) or 0),
            -int(option.get("remaining", 0) or 0),
            str(option.get("character_name", "")),
        ))
        return options

    def _consume_access(item: dict, chosen: dict) -> None:
        access_output_id = int(item.get("source_output_id") or item.get("output_id") or 0)
        char_id = str(chosen.get("character_id") or "")
        access_kind = chosen.get("access_kind")
        if access_kind == "personal_bpo":
            per_char = shared_personal_bpo_remaining.setdefault(access_output_id, {})
            per_char[char_id] = max(0, int(per_char.get(char_id, 0) or 0) - 1)
        elif access_kind == "personal_bpc":
            per_char = shared_personal_bpc_remaining.setdefault(access_output_id, {})
            per_char[char_id] = max(0, int(per_char.get(char_id, 0) or 0) - 1)
        elif access_kind == "future_personal_bpc":
            per_char_jobs = shared_future_personal_bpc_jobs.setdefault(access_output_id, {}).setdefault(char_id, [])
            consumed_job = None
            if per_char_jobs:
                consumed_end_ts, consumed_name = per_char_jobs.pop(0)
                consumed_job = (int(consumed_end_ts or 0), consumed_name, char_id)
                global_jobs = shared_future_personal_bpc_jobs_global.setdefault(access_output_id, [])
                for job_idx, (job_end_ts, job_name, job_char_id) in enumerate(list(global_jobs)):
                    if (
                        int(job_end_ts or 0) == int(consumed_job[0] or 0)
                        and str(job_name or "") == str(consumed_job[1] or "")
                        and str(job_char_id or "") == str(consumed_job[2] or "")
                    ):
                        global_jobs.pop(job_idx)
                        break
            else:
                global_jobs = shared_future_personal_bpc_jobs_global.setdefault(access_output_id, [])
                if global_jobs:
                    consumed_end_ts, consumed_name, consumed_char_id = global_jobs.pop(0)
                    consumed_per_char_jobs = shared_future_personal_bpc_jobs.setdefault(access_output_id, {}).setdefault(str(consumed_char_id or ""), [])
                    if consumed_per_char_jobs:
                        consumed_per_char_jobs.pop(0)
        elif access_kind == "corp_bpo":
            shared_corp_bpo_remaining[access_output_id] = max(0, int(shared_corp_bpo_remaining.get(access_output_id, 0) or 0) - 1)

    def _consume_science_slot(chosen: dict) -> tuple[int, str | None]:
        char_id = str(chosen.get("character_id") or "")
        slot_openings = science_slot_openings_by_character.get(char_id, [])
        if slot_openings:
            slot_open_ts, slot_freed_by = slot_openings.pop(0)
        else:
            slot_open_ts, slot_freed_by = now_ts, None
        slot_info = free_science_slots_by_character.get(char_id)
        if slot_info and int(slot_open_ts or 0) <= now_ts:
            slot_info["remaining"] = max(0, int(slot_info.get("remaining", 0) or 0) - 1)
        return int(slot_open_ts or now_ts), slot_freed_by

    def _choose_invention_character(item: dict) -> dict | None:
        eligible_ids = [str(char_id) for char_id in (item.get("invention_eligible_character_ids") or []) if char_id]
        if not eligible_ids:
            return None
        preferred_id = str(item.get("preferred_invention_character_id") or "")
        eligible_chars = {
            str(char.get("character_id") or ""): {
                "character_id": str(char.get("character_id") or ""),
                "character_name": char.get("character_name") or f"Char {char.get('character_id')}",
            }
            for char in (item.get("invention_eligible_characters") or [])
            if char.get("character_id")
        }
        if preferred_id and preferred_id in eligible_chars:
            return dict(eligible_chars[preferred_id])
        if preferred_id and preferred_id in eligible_ids:
            return {
                "character_id": preferred_id,
                "character_name": item.get("preferred_invention_character_name") or f"Char {preferred_id}",
            }
        for char_id in eligible_ids:
            if char_id in eligible_chars:
                return dict(eligible_chars[char_id])
            slot_info = free_science_slots_by_character.get(char_id) or free_mfg_slots_by_character.get(char_id) or {}
            return {
                "character_id": char_id,
                "character_name": slot_info.get("character_name") or f"Char {char_id}",
            }
        return None

    assignment_priority = {
        "manufacture": 0,
        "invent_first": 1,
        "copy_then_invent": 2,
        "copy_first": 3,
    }
    assignable_items = sorted(
        list(items),
        key=lambda item: (
            -float(item.get("_selection_score", 0) or 0),
            assignment_priority.get(str(item.get("action_type") or ""), 9),
            str(item.get("name") or ""),
        ),
    )
    for item in assignable_items:
        slot_kind = "manufacturing" if item.get("action_type") == "manufacture" else "science"
        item["assigned_character"] = None
        item["slot_assignment_kind"] = slot_kind
        item["copy_character"] = None
        item["invent_character"] = None
        if item.get("action_type") == "copy_then_invent":
            options = _candidate_options_for_item(item, slot_kind)
            inventor = _choose_invention_character(item)
            if not inventor:
                _mark_candidate_blockers(item, slot_kind, "blueprint_missing")
                item["characters"] = []
                continue
            if not options:
                _mark_candidate_blockers(item, slot_kind, "blueprint_busy")
                item["characters"] = []
                continue
            chosen = options[0]
            science_start_at, science_slot_freed_by = _consume_science_slot(chosen)
            _consume_access(item, chosen)
            item["assigned_character"] = {
                "character_id": chosen["character_id"],
                "character_name": chosen["character_name"],
            }
            item["copy_character"] = dict(item["assigned_character"])
            item["invent_character"] = dict(inventor)
            item["characters"] = [dict(item["assigned_character"])]
            item["assignment_access_kind"] = chosen.get("access_kind")
            item["start_at"] = science_start_at
            item["slot_freed_by"] = science_slot_freed_by
            item["manufacture_at"] = science_start_at + int(item.get("science_total_secs") or 0)
            continue
        options = _candidate_options_for_item(item, slot_kind)
        if not options:
            _mark_candidate_blockers(item, slot_kind, "blueprint_busy")
            item["characters"] = []
            continue
        chosen = options[0]
        if slot_kind == "science":
            science_start_at, science_slot_freed_by = _consume_science_slot(chosen)
        else:
            slot_maps[slot_kind][chosen["character_id"]]["remaining"] = max(
                0,
                int(slot_maps[slot_kind][chosen["character_id"]].get("remaining", 0) or 0) - 1,
            )
            science_start_at, science_slot_freed_by = now_ts, None
        _consume_access(item, chosen)
        item["assigned_character"] = {
            "character_id": chosen["character_id"],
            "character_name": chosen["character_name"],
        }
        if item.get("action_type") == "copy_first":
            item["copy_character"] = dict(item["assigned_character"])
            science_ready_at = max(science_start_at, int(chosen.get("bp_ready_at") or now_ts))
            item["start_at"] = science_ready_at
            item["slot_freed_by"] = chosen.get("bp_ready_by") if int(chosen.get("bp_ready_at") or now_ts) > science_start_at else science_slot_freed_by
            item["manufacture_at"] = science_ready_at + int(item.get("science_total_secs") or 0)
        elif item.get("action_type") == "invent_first":
            item["invent_character"] = dict(item["assigned_character"])
            science_ready_at = max(science_start_at, int(chosen.get("bp_ready_at") or now_ts))
            item["start_at"] = science_ready_at
            item["slot_freed_by"] = chosen.get("bp_ready_by") if int(chosen.get("bp_ready_at") or now_ts) > science_start_at else science_slot_freed_by
            item["manufacture_at"] = science_ready_at + int(item.get("science_total_secs") or 0)
        elif item.get("action_type") == "manufacture":
            manufacture_ready_at = max(int(item.get("start_at") or now_ts), int(chosen.get("bp_ready_at") or now_ts))
            if int(chosen.get("bp_ready_at") or now_ts) > int(item.get("start_at") or now_ts):
                item["slot_freed_by"] = chosen.get("bp_ready_by")
            item["start_at"] = manufacture_ready_at
            item["manufacture_at"] = manufacture_ready_at
        item["characters"] = [dict(item["assigned_character"])]
        item["assignment_access_kind"] = chosen.get("access_kind")

    def _build_idle_items(slot_kind: str, slot_map: dict[str, dict]) -> list[dict]:
        idle_items: list[dict] = []
        for char_id, slot_info in sorted(slot_map.items(), key=lambda item: str(item[1].get("character_name", ""))):
            remaining = int(slot_info.get("remaining", 0) or 0)
            if remaining <= 0:
                continue
            blocker = idle_blockers.get(slot_kind, {}).get(char_id, {}) or {}
            if int(blocker.get("blueprint_busy", 0) or 0) > 0:
                reason = "Only usable blueprint is already reserved by another queued job."
            else:
                reason = (
                    "No eligible science job remains for this character."
                    if slot_kind == "science"
                    else "No eligible manufacturing job remains for this character."
                )
            action_type = "idle_science" if slot_kind == "science" else "idle_manufacture"
            for idle_idx in range(remaining):
                idle_items.append({
                    "rec_id": f"{action_type}:{char_id}:{idle_idx}",
                    "action_type": action_type,
                    "is_idle": True,
                    "name": "IDLE",
                    "why": reason,
                    "idle_reason": reason,
                    "profit_per_cycle": 0,
                    "runs_per_cycle": 0,
                    "characters": [{
                        "character_id": char_id,
                        "character_name": slot_info.get("character_name", f"Char {char_id}"),
                    }],
                    "assigned_character": {
                        "character_id": char_id,
                        "character_name": slot_info.get("character_name", f"Char {char_id}"),
                    },
                    "slot_assignment_kind": slot_kind,
                    "ownership": [],
                    "start_at": now_ts if slot_kind == "manufacturing" else None,
                    "slot_freed_by": None,
                })
        return idle_items

    items = [item for item in items if item.get("assigned_character")]
    items = _build_idle_items("science", free_science_slots_by_character) + items + _build_idle_items("manufacturing", free_mfg_slots_by_character)

    # ── Wallet capital risk ───────────────────────────────────────────────────
    CAPITAL_WARN_THRESHOLD = 0.40
    for r in items:
        if r.get("action_type") == "manufacture":
            _item_cost = float(r.get("material_cost", 0) or 0) * max(1, r.get("rec_runs", 1))
            r["capital_warning"]   = wallet_total > 0 and (_item_cost / wallet_total) > CAPITAL_WARN_THRESHOLD
            r["capital_share_pct"] = round((_item_cost / wallet_total * 100) if wallet_total > 0 else 0.0, 1)
        else:
            r["capital_warning"]   = False
            r["capital_share_pct"] = 0.0

    # ── Persist displayed queue items so footer mirrors Queue Planner exactly ─
    global _QUEUE_PLANNER_CANDIDATES_CACHE, _QUEUE_PLANNER_CANDIDATES_TS
    _QUEUE_PLANNER_CANDIDATES_CACHE = list(items)
    _QUEUE_PLANNER_CANDIDATES_TS    = time.time()
    _QUEUE_SUMMARY_CACHE_TS         = 0  # force footer to rebuild from fresh queue items
    _record_utilization_snapshot(
        running_jobs=running_mfg,
        max_jobs=max_jobs,
        running_science=running_science,
        max_science=max_science,
        source="top_performers",
    )

    return jsonify({
        "items":            items,
        "blocked_items":    [
            {
                key: value
                for key, value in blocked.items()
                if key != "score"
            }
            for blocked in sorted(
                blocked_recommendations.values(),
                key=lambda item: float(item.get("score", 0) or 0),
                reverse=True,
            )[:8]
        ],
        "generated_at":     int(best_ts),
        "total_owned":      len(candidates),
        "cache_key":        best_key,
        "max_jobs":         max_jobs,
        "running_jobs":     running_mfg,
        "free_slots":       free_slots,
        "slot_free_at":     sorted(mfg_end_times[:max_jobs]),
        "max_science":      max_science,
        "running_science":  running_science,
        "free_science":     free_science,
        "science_slot_free_at": sorted(sci_end_times[:max_science]),
        "character_slots":  planner_character_slots,
        # Skill + structure bonus summary
        "skill_time_bonus_pct": round((1.0 - _MFG_TIME_MODIFIER) * 100, 1),
        "structure_job_time_bonus_pct": round(structure_job_time_bonus_pct, 1),
        "structure_name":       _structure_name,
        "me_bonus_pct":         _me_bonus_pct,
        "te_bonus_pct":         _te_bonus_pct,
        "wallet_total_isk":     round(wallet_total),
        # Echo back cycle config for UI sync
        "cycle_config":     cycle_config,
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
    """Return ranked market-priced BPO investment opportunities."""
    try:
        system = request.args.get("system", "Korsiki")
        facility = request.args.get("facility", "large")

        all_bp_ids, bp_info = _load_all_bp_info()
        if not all_bp_ids:
            return jsonify({
                "results": [],
                "not_ready": True,
                "message": "Blueprint database (crest.db) not found — run seeder.py first.",
            })

        calc_results = _get_scan_calc_results(system, facility)
        if calc_results is None:
            return jsonify({
                "results": [],
                "not_ready": True,
                "message": "Open the Calculator tab first to load profitability data, then try again.",
            })

        bpid_to_calc = _build_scan_bpid_map(calc_results)
        personal_bp_ids, corp_bp_ids = _load_owned_bp_ids()
        wallet_total_isk = round(_get_wallet(), 2)

        wanted_bp_ids: set[int] = set()
        for row in calc_results:
            blueprint_id = int(row.get("blueprint_id") or 0)
            if blueprint_id <= 0:
                continue
            if float(row.get("net_profit", 0) or 0) <= 0:
                continue
            wanted_bp_ids.add(blueprint_id)

        if not wanted_bp_ids:
            return jsonify({
                "results": [],
                "matched": 0,
                "market_matches": 0,
                "wallet_total_isk": wallet_total_isk,
                "message": "No profitable blueprint originals found in the current calculator context.",
            })

        from pricer import get_prices_bulk
        market_prices = get_prices_bulk(list(wanted_bp_ids), history_ids=[])

        results = []
        market_match_count = 0
        for blueprint_id in wanted_bp_ids:
            calc_row = bpid_to_calc.get(blueprint_id, {})
            market_row = market_prices.get(blueprint_id) or {}
            market_price = float(market_row.get("sell") or 0)
            if market_price > 0:
                market_match_count += 1
            if market_price <= 0:
                continue
            results.append(_build_bpo_acquisition_row(
                blueprint_id=blueprint_id,
                calc_row=calc_row,
                personal_bp_ids=personal_bp_ids,
                corp_bp_ids=corp_bp_ids,
                bp_info=bp_info,
                market_row=market_row,
                wallet_total_isk=wallet_total_isk,
            ))

        results.sort(key=lambda x: (
            x.get("payback_days") is None,
            float(x.get("payback_days") or 10**9),
            -float(x.get("expected_daily_profit") or 0),
            -float(x.get("score") or 0),
        ))

        return jsonify({
            "results": results,
            "matched": len(results),
            "market_matches": market_match_count,
            "bp_candidates": len(wanted_bp_ids),
            "market_only": True,
            "wallet_total_isk": wallet_total_isk,
            "message": None if results else "No live Jita market listings found for profitable blueprint originals.",
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
        try:
            api_calculator()
        except Exception:
            pass
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


def _build_bpo_acquisition_row(
    *,
    blueprint_id: int,
    calc_row: dict,
    personal_bp_ids: set,
    corp_bp_ids: set,
    bp_info: dict | None = None,
    market_row: dict | None = None,
    wallet_total_isk: float | None = None,
) -> dict:
    import math

    sde_row = (bp_info or {}).get(blueprint_id, {})
    output_id = calc_row.get("output_id") or sde_row.get("output_id")
    net_profit_1r = float(calc_row.get("net_profit", 0) or 0)
    roi = float(calc_row.get("roi", 0) or 0)
    isk_per_hour = float(calc_row.get("isk_per_hour", 0) or 0)
    mat_cost_1r = float(calc_row.get("material_cost", 0) or 0)
    gross_rev_1r = float(calc_row.get("gross_revenue", 0) or 0)
    avg_daily_volume = float(calc_row.get("avg_daily_volume", 0) or 0)
    output_qty = max(1, int(calc_row.get("output_qty") or 1))
    duration_secs = max(1, int(calc_row.get("duration") or calc_row.get("time_seconds") or 0) or 1)

    market_sell_price = float((market_row or {}).get("sell") or 0)
    market_buy_price = float((market_row or {}).get("buy") or 0)
    acquisition_price = market_sell_price
    adjusted_price = (market_row or {}).get("adjusted_price")
    average_price = (market_row or {}).get("average_price")

    build_runs_per_day = 86400.0 / max(1, duration_secs)
    demand_runs_per_day = (avg_daily_volume / output_qty) if output_qty > 0 and avg_daily_volume > 0 else 0.0
    expected_runs_per_day = min(build_runs_per_day, demand_runs_per_day) if demand_runs_per_day > 0 else build_runs_per_day
    expected_daily_profit = net_profit_1r * expected_runs_per_day
    payback_days = (acquisition_price / expected_daily_profit) if acquisition_price > 0 and expected_daily_profit > 0 else None
    breakeven_runs = math.ceil(acquisition_price / net_profit_1r) if acquisition_price > 0 and net_profit_1r > 0 else None
    acquisition_score = 0.0
    if acquisition_price > 0 and expected_daily_profit > 0:
        acquisition_score = (expected_daily_profit * max(roi, 0.0)) / max(math.sqrt(acquisition_price), 1.0)
    daily_yield_pct = ((expected_daily_profit / acquisition_price) * 100.0) if acquisition_price > 0 and expected_daily_profit > 0 else None
    market_spread_pct = ((market_sell_price - market_buy_price) / market_sell_price * 100.0) if market_sell_price > 0 and market_buy_price > 0 else None

    personal_owned = blueprint_id in personal_bp_ids
    corp_owned = blueprint_id in corp_bp_ids
    already_owned = personal_owned or corp_owned
    affordable = acquisition_price > 0 and wallet_total_isk is not None and wallet_total_isk >= acquisition_price

    return {
        "blueprint_id": blueprint_id,
        "output_id": output_id,
        "name": calc_row.get("name") or sde_row.get("name", "?"),
        "source": "market",
        "source_label": "JITA MARKET",
        "available_sources": ["market"],
        "market_available": market_sell_price > 0,
        "contract_available": False,
        "market_price": round(market_sell_price, 2) if market_sell_price > 0 else None,
        "market_buy_price": round(market_buy_price, 2) if market_buy_price > 0 else None,
        "contract_price": None,
        "price": round(acquisition_price, 2),
        "me": 0,
        "te": 0,
        "is_bpc": False,
        "runs": -1,
        "contract_id": None,
        "listing_count": 0,
        "already_owned": already_owned,
        "personal_owned": personal_owned,
        "corp_owned": corp_owned,
        "net_profit": round(net_profit_1r, 2),
        "roi": round(roi, 2),
        "isk_per_hour": round(isk_per_hour, 2),
        "material_cost": round(mat_cost_1r, 2),
        "gross_revenue": round(gross_rev_1r, 2),
        "avg_daily_volume": round(avg_daily_volume, 2),
        "output_qty": output_qty,
        "duration": duration_secs,
        "expected_runs_per_day": round(expected_runs_per_day, 2),
        "expected_daily_profit": round(expected_daily_profit, 2),
        "daily_yield_pct": round(daily_yield_pct, 2) if daily_yield_pct is not None else None,
        "payback_days": round(payback_days, 2) if payback_days is not None else None,
        "breakeven_runs": breakeven_runs,
        "category": calc_row.get("category") or sde_row.get("category", ""),
        "tech": calc_row.get("tech") or sde_row.get("tech", ""),
        "item_group": sde_row.get("item_group", ""),
        "adj_net_profit": round(net_profit_1r, 2),
        "adj_roi": round(roi, 2),
        "total_adj_profit": None,
        "can_breakeven": net_profit_1r > 0,
        "bpc_feasible": True,
        "has_calc_data": bool(calc_row),
        "cheapest_price": round(acquisition_price, 2) if acquisition_price > 0 else None,
        "adjusted_price": round(float(adjusted_price), 2) if adjusted_price not in (None, "") else None,
        "average_price": round(float(average_price), 2) if average_price not in (None, "") else None,
        "market_spread_pct": round(market_spread_pct, 2) if market_spread_pct is not None else None,
        "score": round(acquisition_score, 4),
        "wallet_total_isk": round(wallet_total_isk, 2) if wallet_total_isk is not None else None,
        "affordable": affordable,
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
_ESI_BP_LAST_FETCH_INFO: dict = {"status": "never"}
_ESI_BP_LAST_FETCH_LOCK = threading.Lock()

_ESI_JOBS_CACHE:    dict  = {}
_ESI_JOBS_CACHE_TS: float = 0
_ESI_JOBS_TTL             = 120   # 2 min
_ESI_JOBS_SIGNAL_TTL      = 20    # planner change-detection cadence

_QUEUE_SUMMARY_CACHE:    dict  = {}
_QUEUE_SUMMARY_CACHE_TS: float = 0
_QUEUE_SUMMARY_TTL             = 120  # 2 min


def _set_esi_bp_fetch_info(info: dict) -> None:
    with _ESI_BP_LAST_FETCH_LOCK:
        _ESI_BP_LAST_FETCH_INFO.clear()
        _ESI_BP_LAST_FETCH_INFO.update(info)


def _get_esi_bp_fetch_info() -> dict:
    with _ESI_BP_LAST_FETCH_LOCK:
        return dict(_ESI_BP_LAST_FETCH_INFO)


def _industry_jobs_signature(cache: dict | None) -> str:
    jobs = list((cache or {}).get("jobs") or [])
    if not jobs:
        return "empty"

    signal_rows = []
    for job in jobs:
        signal_rows.append((
            int(job.get("job_id") or 0),
            int(job.get("activity_id") or 0),
            int(job.get("product_type_id") or 0),
            int(job.get("blueprint_type_id") or 0),
            int(job.get("runs") or 0),
            int(job.get("end_ts") or 0),
            int(job.get("character_id") or 0),
            str(job.get("status") or ""),
        ))

    payload = json.dumps(sorted(signal_rows), separators=(",", ":"))
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()

_UTILIZATION_HISTORY_FILE = os.path.join(os.path.dirname(__file__), "utilization_history.json")
_UTILIZATION_HISTORY_TTL  = 300  # 5 min between persisted samples
_UTILIZATION_HISTORY_KEEP = 45 * 86400
_UTILIZATION_HISTORY_MAX  = 5000
_UTILIZATION_HISTORY_LOCK = threading.Lock()

# Scored queue-planner candidates — written by /api/queue, read by /api/queue-summary
# so the footer always reflects exactly the items the queue planner scored/filtered.
_QUEUE_PLANNER_CANDIDATES_CACHE: list  = []
_QUEUE_PLANNER_CANDIDATES_TS:    float = 0

# max_jobs (character skill fetch) cached longer — skills barely change
_MAX_JOBS_CACHE:    int   = 0
_MAX_JOBS_CACHE_TS: float = 0.0
_MAX_JOBS_TTL             = 1800  # 30 min
_CHAR_SLOT_DETAILS_CACHE: dict  = {}
_CHAR_SLOT_DETAILS_CACHE_TS: float = 0.0

# science/research slots cached alongside mfg slots
_MAX_SCIENCE_JOBS_CACHE:    int   = 0
_MAX_SCIENCE_JOBS_CACHE_TS: float = 0.0
_COPY_TIME_MODIFIER:        float = 1.0   # best copy-time skill modifier across all characters
_INVENT_TIME_MODIFIER:      float = 1.0   # best invention-time skill modifier across all characters
_MFG_TIME_MODIFIER:         float = 1.0   # best mfg-time skill modifier across all characters
_TYPE_VOLUME_CACHE: dict       = {}   # type_id → packaged volume m³, persistent until restart

_ESI_ORDERS_CACHE:    dict  = {}
_ESI_ORDERS_CACHE_TS: float = 0
_ESI_ORDERS_TTL             = 120   # 2 min
_LAST_SELL_POS_BY_ORDER: dict[int, int] = {}


def _load_utilization_history() -> list[dict]:
    try:
        if not os.path.exists(_UTILIZATION_HISTORY_FILE):
            return []
        with open(_UTILIZATION_HISTORY_FILE, "r", encoding="utf-8") as _f:
            data = json.load(_f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _write_utilization_history(points: list[dict]) -> None:
    with open(_UTILIZATION_HISTORY_FILE, "w", encoding="utf-8") as _f:
        json.dump(points, _f)


def _record_utilization_snapshot(
    *,
    running_jobs: int,
    max_jobs: int,
    running_science: int,
    max_science: int,
    source: str,
) -> None:
    now_ts = int(time.time())
    snapshot = {
        "ts": now_ts,
        "running_jobs": int(running_jobs),
        "max_jobs": int(max_jobs),
        "running_science": int(running_science),
        "max_science": int(max_science),
        "source": source,
    }

    try:
        with _UTILIZATION_HISTORY_LOCK:
            points = _load_utilization_history()
            last = points[-1] if points else None
            if last:
                same_counts = (
                    int(last.get("running_jobs", 0)) == snapshot["running_jobs"]
                    and int(last.get("max_jobs", 0)) == snapshot["max_jobs"]
                    and int(last.get("running_science", 0)) == snapshot["running_science"]
                    and int(last.get("max_science", 0)) == snapshot["max_science"]
                )
                if same_counts and (now_ts - int(last.get("ts", 0) or 0)) < _UTILIZATION_HISTORY_TTL:
                    return

            cutoff = now_ts - _UTILIZATION_HISTORY_KEEP
            points = [p for p in points if int(p.get("ts", 0) or 0) >= cutoff]
            points.append(snapshot)
            if len(points) > _UTILIZATION_HISTORY_MAX:
                points = points[-_UTILIZATION_HISTORY_MAX:]
            _write_utilization_history(points)
    except Exception:
        pass


@app.route("/api/planner/utilization-history", methods=["GET"])
def api_planner_utilization_history():
    try:
        hours = max(24, min(24 * 30, int(request.args.get("hours", 24 * 7) or 24 * 7)))
        bucket_minutes = max(5, min(240, int(request.args.get("bucket_minutes", 60) or 60)))
        cutoff_ts = int(time.time()) - (hours * 3600)

        with _UTILIZATION_HISTORY_LOCK:
            points = [p for p in _load_utilization_history() if int(p.get("ts", 0) or 0) >= cutoff_ts]

        return jsonify({
            "snapshots": points,
            "hours": hours,
            "bucket_minutes": bucket_minutes,
            "generated_at": int(time.time()),
        })
    except Exception as e:
        return jsonify({"error": str(e), "snapshots": []}), 200


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


@app.route("/api/blueprints/stats", methods=["GET"])
def api_blueprints_stats():
    """
    Returns aggregate blueprint statistics:
      - total_bpos_in_game: count of all BPOs in the SDE (blueprints table)
      - owned_bpos:         count of BPOs currently owned (from ESI cache)
      - owned_pct:          percentage owned
    """
    try:
        db_path = os.path.join(os.path.dirname(__file__), "crest.db")
        conn = _get_db(db_path)
        total_in_game = int(conn.execute("SELECT COUNT(*) FROM blueprints").fetchone()[0])
        conn.close()

        owned_bpos = sum(1 for bp in (_ESI_BP_CACHE.get("blueprints") or []) if bp.get("bp_type") == "BPO")
        owned_pct  = round(owned_bpos / total_in_game * 100, 2) if total_in_game else 0

        return jsonify({
            "total_bpos_in_game": total_in_game,
            "owned_bpos":         owned_bpos,
            "owned_pct":          owned_pct,
        })
    except Exception as e:
        return jsonify({"error": str(e), "total_bpos_in_game": 0, "owned_bpos": 0, "owned_pct": 0}), 200


@app.route("/api/blueprints/esi", methods=["GET"])
def api_blueprints_esi():
    """
    Return character AND corporation blueprints from ESI for ALL authenticated characters.
    Cached for 5 minutes. Personal blueprint fetches are parallelised across characters.
    """
    global _ESI_BP_CACHE, _ESI_BP_CACHE_TS
    try:
        pass  # request already imported at top
        fetch_started = time.time()
        personal_fetch_started = None
        personal_fetch_done = None
        corp_probe_started = None
        corp_probe_done = None
        corp_pages_started = None
        corp_pages_done = None
        name_resolution_started = None
        name_resolution_done = None
        force = request.args.get("force", "0") == "1"
        if not force and _ESI_BP_CACHE and (time.time() - _ESI_BP_CACHE_TS) < _ESI_BP_TTL:
            _set_esi_bp_fetch_info({
                "status": "cache_hit",
                "force": False,
                "duration_ms": round((time.time() - fetch_started) * 1000, 1),
                "blueprint_count": int(_ESI_BP_CACHE.get("count") or len(_ESI_BP_CACHE.get("blueprints") or [])),
                "cache_age_s": round(max(0.0, time.time() - _ESI_BP_CACHE_TS), 2),
                "fetched_at": time.time(),
            })
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
        char_corp_info = []  # [(cid, char_name, headers, corp_id, corp_bp_access), ...]

        personal_fetch_started = time.time()
        with ThreadPoolExecutor(max_workers=len(auth_headers)) as pool:
            futures = [pool.submit(_fetch_personal, cid, h) for cid, h in auth_headers]
            for f in as_completed(futures):
                cid, char_name, headers, bps, corp_id = f.result()
                all_bps.extend(bps)
                if corp_id:
                    corp_bp_access = str(char_records.get(cid, {}).get("corp_bp_access") or "auto").strip().lower()
                    if corp_bp_access not in {"auto", "allow", "block"}:
                        corp_bp_access = "auto"
                    char_corp_info.append((cid, char_name, headers, corp_id, corp_bp_access))
        personal_fetch_done = time.time()

        corp_access_by_corp_id: dict[int, list[dict]] = {}
        corp_fetch_seed_by_corp_id: dict[int, tuple[str, str, dict, list]] = {}
        corp_allow_overrides_by_corp_id: dict[int, list[dict]] = {}
        corp_esi_reachable_any = False

        corp_probe_started = time.time()
        for cid, char_name, headers, corp_id, corp_bp_access in char_corp_info:
            if not corp_id:
                continue
            if corp_bp_access == "allow":
                allow_chars = corp_allow_overrides_by_corp_id.setdefault(corp_id, [])
                if not any(str(member.get("character_id") or "") == str(cid) for member in allow_chars):
                    allow_chars.append({"character_id": str(cid), "character_name": char_name})
            try:
                cr = req.get(
                    f"https://esi.evetech.net/latest/corporations/{corp_id}/blueprints/",
                    headers=headers, params={"page": 1}, timeout=15
                )
            except Exception:
                continue
            if not cr.ok:
                continue

            corp_esi_reachable_any = True
            if corp_bp_access != "block":
                access_chars = corp_access_by_corp_id.setdefault(corp_id, [])
                if not any(str(member.get("character_id") or "") == str(cid) for member in access_chars):
                    access_chars.append({"character_id": str(cid), "character_name": char_name})

            if corp_id not in corp_fetch_seed_by_corp_id:
                try:
                    first_page = list(cr.json() or [])
                except Exception:
                    first_page = []
                corp_fetch_seed_by_corp_id[corp_id] = (str(cid), char_name, headers, first_page)
        corp_probe_done = time.time()

        for corp_id, allow_chars in corp_allow_overrides_by_corp_id.items():
            access_chars = corp_access_by_corp_id.setdefault(corp_id, [])
            for allow_char in allow_chars:
                allow_cid = str(allow_char.get("character_id") or "")
                if allow_cid and not any(str(member.get("character_id") or "") == allow_cid for member in access_chars):
                    access_chars.append(dict(allow_char))

        # ── Corp blueprints (deduplicated by corp_id) ──
        corp_esi_loaded_any = False
        corp_pages_started = time.time()
        for corp_id, (cid, char_name, headers, first_page_bps) in corp_fetch_seed_by_corp_id.items():
            access_characters = list(corp_access_by_corp_id.get(corp_id, []))
            page = 1
            page_bps = list(first_page_bps or [])
            while True:
                if page > 1:
                    try:
                        cr = req.get(
                            f"https://esi.evetech.net/latest/corporations/{corp_id}/blueprints/",
                            headers=headers, params={"page": page}, timeout=15
                        )
                    except Exception:
                        break
                    if not cr.ok:
                        break
                    page_bps = cr.json()

                if not page_bps:
                    break

                corp_esi_loaded_any = True
                for bp in page_bps:
                    bp["_character_id"] = cid
                    bp["_character_name"] = char_name
                    bp["_owner"] = "corp"
                    bp["_corp_id"] = corp_id
                    bp["_access_characters"] = access_characters
                    all_bps.append(bp)
                if len(page_bps) < 1000:
                    break
                page += 1
        corp_pages_done = time.time()

        if not corp_esi_reachable_any and CORP_BPO_TYPE_IDS:
            fallback_cid = char_corp_info[0][0] if char_corp_info else None
            fallback_name = char_corp_info[0][1] if char_corp_info else "corp"
            fallback_corp_id = char_corp_info[0][3] if char_corp_info else None
            fallback_access_characters = list(corp_access_by_corp_id.get(fallback_corp_id, []))
            print(f"  [esi-bps] No corp ESI blueprint data available - using static corp_BPOs fallback once ({len(CORP_BPO_TYPE_IDS)} BPOs)")
            for tid in CORP_BPO_TYPE_IDS:
                all_bps.append({
                    "type_id": tid,
                    "material_efficiency": 10,
                    "time_efficiency": 20,
                    "runs": -1,
                    "location_id": None,
                    "quantity": 1,
                    "_character_id": fallback_cid,
                    "_character_name": fallback_name,
                    "_owner": "corp",
                    "_corp_id": fallback_corp_id,
                    "_access_characters": fallback_access_characters,
                })

        if not all_bps:
            _set_esi_bp_fetch_info({
                "status": "empty",
                "force": bool(force),
                "duration_ms": round((time.time() - fetch_started) * 1000, 1),
                "auth_character_count": len(auth_headers),
                "personal_fetch_ms": round(((personal_fetch_done or time.time()) - (personal_fetch_started or fetch_started)) * 1000, 1),
                "corp_probe_ms": round(((corp_probe_done or time.time()) - (corp_probe_started or time.time())) * 1000, 1),
                "corp_pages_ms": round(((corp_pages_done or time.time()) - (corp_pages_started or time.time())) * 1000, 1),
                "corp_reachable": bool(corp_esi_reachable_any),
                "corp_loaded": bool(corp_esi_loaded_any),
                "fetched_at": time.time(),
            })
            return jsonify({"blueprints": []})

        # Resolve type names — try crest.db first (instant), ESI for remainder
        name_resolution_started = time.time()
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
        name_resolution_done = time.time()

        result = []
        for bp in all_bps:
            access_characters = list(bp.get("_access_characters") or [])
            if not access_characters and bp.get("_owner") != "corp" and bp.get("_character_id"):
                access_characters = [{
                    "character_id": str(bp["_character_id"]),
                    "character_name": bp.get("_character_name") or f"Char {bp['_character_id']}",
                }]
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
                "corp_id":        bp.get("_corp_id"),
                "access_characters": access_characters,
            })

        result.sort(key=lambda x: x["name"])
        with _ESI_STATE_CACHE_LOCK:
            _ESI_BP_CACHE = {"blueprints": result, "count": len(result)}
            _ESI_BP_CACHE_TS = time.time()
        fetch_info = {
            "status": "ok",
            "force": bool(force),
            "duration_ms": round((time.time() - fetch_started) * 1000, 1),
            "auth_character_count": len(auth_headers),
            "personal_fetch_ms": round(((personal_fetch_done or time.time()) - (personal_fetch_started or fetch_started)) * 1000, 1),
            "corp_probe_ms": round(((corp_probe_done or time.time()) - (corp_probe_started or time.time())) * 1000, 1),
            "corp_pages_ms": round(((corp_pages_done or time.time()) - (corp_pages_started or time.time())) * 1000, 1),
            "name_resolution_ms": round(((name_resolution_done or time.time()) - (name_resolution_started or time.time())) * 1000, 1),
            "corp_reachable": bool(corp_esi_reachable_any),
            "corp_loaded": bool(corp_esi_loaded_any),
            "blueprint_count": len(result),
            "fetched_at": time.time(),
        }
        _set_esi_bp_fetch_info(fetch_info)
        print(
            "  [esi-bps] loaded "
            f"{len(result)} blueprints in {fetch_info['duration_ms'] / 1000:.2f}s "
            f"(personal {fetch_info['personal_fetch_ms'] / 1000:.2f}s, "
            f"corp probe {fetch_info['corp_probe_ms'] / 1000:.2f}s, "
            f"corp pages {fetch_info['corp_pages_ms'] / 1000:.2f}s, "
            f"names {fetch_info['name_resolution_ms'] / 1000:.2f}s, "
            f"chars {len(auth_headers)})"
        )
        threading.Thread(target=_save_esi_state_to_disk, daemon=True).start()
        return jsonify(_ESI_BP_CACHE)

    except Exception as e:
        _set_esi_bp_fetch_info({
            "status": "error",
            "force": bool(request.args.get("force", "0") == "1"),
            "duration_ms": round((time.time() - fetch_started) * 1000, 1),
            "error": str(e),
            "fetched_at": time.time(),
        })
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
            with _ESI_STATE_CACHE_LOCK:
                for j in _ESI_JOBS_CACHE.get("jobs", []):
                    j["seconds_remaining"] = max(0, j["end_ts"] - now_ts)
                cached_jobs = copy.deepcopy(_ESI_JOBS_CACHE)
            return jsonify(cached_jobs)

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
        with _ESI_STATE_CACHE_LOCK:
            _ESI_JOBS_CACHE = {"jobs": result, "count": len(result)}
            _ESI_JOBS_CACHE_TS = time.time()
        threading.Thread(target=_save_esi_state_to_disk, daemon=True).start()
        running_jobs = sum(1 for j in result if j.get("activity_id") in (1, 9, 11) and (j.get("end_ts") or 0) > now_ts)
        running_science = sum(1 for j in result if j.get("activity_id") in (3, 4, 5, 8) and (j.get("end_ts") or 0) > now_ts)
        _record_utilization_snapshot(
            running_jobs=running_jobs,
            max_jobs=_get_max_jobs(running_fallback=running_jobs),
            running_science=running_science,
            max_science=_get_max_science_jobs(running_fallback=running_science),
            source="industry_jobs",
        )
        return jsonify(_ESI_JOBS_CACHE)

    except Exception as e:
        return jsonify({"error": str(e), "jobs": []}), 200


@app.route("/api/industry/jobs/signal", methods=["GET"])
def api_industry_jobs_signal():
    global _ESI_JOBS_CACHE, _ESI_JOBS_CACHE_TS

    refreshed = False
    cache_age = time.time() - _ESI_JOBS_CACHE_TS if _ESI_JOBS_CACHE_TS else None

    if not _ESI_JOBS_CACHE or cache_age is None or cache_age >= _ESI_JOBS_SIGNAL_TTL:
        try:
            prev_jobs_cache_ts = _ESI_JOBS_CACHE_TS
            _ESI_JOBS_CACHE_TS = 0
            api_industry_jobs()
            refreshed = True
        except Exception as _e:
            _ESI_JOBS_CACHE_TS = prev_jobs_cache_ts
            return jsonify({
                "error": str(_e),
                "signature": _industry_jobs_signature(_ESI_JOBS_CACHE),
                "count": len((_ESI_JOBS_CACHE or {}).get("jobs") or []),
                "cache_age_seconds": round(cache_age or 0.0, 1),
                "refreshed": refreshed,
            }), 200

    effective_age = time.time() - _ESI_JOBS_CACHE_TS if _ESI_JOBS_CACHE_TS else None
    return jsonify({
        "signature": _industry_jobs_signature(_ESI_JOBS_CACHE),
        "count": len((_ESI_JOBS_CACHE or {}).get("jobs") or []),
        "cache_age_seconds": round(effective_age or 0.0, 1),
        "refreshed": refreshed,
    })


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

                # ── T2 overhead: datacores + invention job + copy job, amortised per run ─
                t2_inv_data: dict[int, dict] = {}
                try:
                    from invention import calculate_invention_cost as _calc_inv
                    from calculator import calculate_industry_job_cost as _calc_job_cost
                    _cdb2 = _sq.connect(os.path.join(os.path.dirname(__file__), "crest.db"))
                    _cdb2.row_factory = _sq.Row
                    ph_t2 = ",".join("?" * len(product_ids))
                    t2_rows = _cdb2.execute(
                        f"""
                        SELECT b.output_id,
                               bi.base_success_chance, bi.output_runs_per_bpc
                        FROM blueprints b
                        JOIN blueprint_invention bi ON bi.t2_blueprint_id = b.blueprint_id
                        WHERE b.output_id IN ({ph_t2})
                        """,
                        product_ids,
                    ).fetchall()
                    _cdb2.close()
                    for row in t2_rows:
                        pid2     = row["output_id"]
                        pname    = names.get(pid2, f"Type {pid2}")
                        inv_res  = _calc_inv(pname, prices=market_prices)
                        if inv_res is None:
                            continue
                        t2_inv_data[pid2] = {
                            "success_chance":        float(inv_res.get("success_chance") or float(row["base_success_chance"] or 0.34)),
                            "runs_per_bpc":          max(1, int(row["output_runs_per_bpc"] or 10)),
                            "datacore_cost_per_run": float(inv_res.get("cost_per_run") or 0.0),
                        }
                except Exception as _t2e:
                    print(f"  [craft-log] T2 overhead lookup failed: {_t2e}")

                to_store = []
                for j in raw_jobs:
                    pid   = j.get("product_type_id")
                    runs  = j.get("runs", 1)
                    p     = market_prices.get(pid) if pid else None
                    sell  = p["sell"] if p and p.get("sell") else None
                    cpu   = mat_cost_per_unit.get(pid)
                    mat   = round(cpu * runs, 2) if cpu is not None else None
                    rev   = round(sell * runs, 2) if sell is not None else None

                    # T2 overhead: invention datacores + inv job fee + copy job fee
                    overhead_cost = None
                    t2 = t2_inv_data.get(pid) if pid else None
                    if t2:
                        try:
                            from calculator import calculate_industry_job_cost as _calc_job_cost
                            _eiv     = float(mat_cost_per_unit.get(pid) or 0.0)
                            _sys_id  = str(j.get("solar_system_id") or "")
                            _inv_sci = _resolve_sci(_sys_id, activity="invention")
                            _cpy_sci = _resolve_sci(_sys_id, activity="copying")
                            _sc      = max(t2["success_chance"], 1e-9)
                            _rpb     = t2["runs_per_bpc"]
                            _inv_job = float((_calc_job_cost(
                                activity="invention", eiv=_eiv, sci=_inv_sci,
                                cfg={"facility_tax_rate": 0.001, "scc_surcharge_rate": 0.04,
                                     "invention_activity_multiplier": 0.02},
                            ).get("total_job_cost") or 0.0)) / _sc / _rpb
                            _cpy_job = float((_calc_job_cost(
                                activity="copying", eiv=_eiv, sci=_cpy_sci,
                                cfg={"facility_tax_rate": 0.001, "scc_surcharge_rate": 0.04,
                                     "copying_activity_multiplier": 0.02},
                            ).get("total_job_cost") or 0.0)) / _rpb
                            overhead_per_run = t2["datacore_cost_per_run"] + _inv_job + _cpy_job
                            overhead_cost = round(overhead_per_run * runs, 2)
                        except Exception:
                            overhead_cost = None

                    total_mat_run = (cpu or 0.0) * runs
                    total_cost_run = total_mat_run + (overhead_cost or 0.0)
                    prof  = round(rev - total_cost_run, 2) if (rev is not None and mat is not None) else None
                    mgn   = round(prof / total_cost_run * 100, 2) if (prof is not None and total_cost_run > 0) else None
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
                        "overhead_cost":   overhead_cost,
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
        # Sync orders first so sold-out listings are recorded before we read revenue.
        _refresh_orders_if_stale()
        days = int(request.args.get("days", 90))
        return jsonify(get_craft_stats(days=days))
    except Exception as e:
        return jsonify({"error": str(e)}), 200


@app.route("/api/craft-timeline", methods=["GET"])
def api_craft_timeline():
    """Return per-week craft profitability for the Trends chart."""
    try:
        days = int(request.args.get("days", 90))
        return jsonify(get_craft_timeline(days=days))
    except Exception as e:
        return jsonify({"error": str(e)}), 200


# ── Shared max manufacturing slots (cached 30 min, used by queue-summary + job-planner) ──
def _get_character_slot_details() -> dict[str, dict]:
    """Return per-character manufacturing/science slot details, refreshed every 30 min."""
    global _CHAR_SLOT_DETAILS_CACHE, _CHAR_SLOT_DETAILS_CACHE_TS
    global _MAX_JOBS_CACHE, _MAX_JOBS_CACHE_TS, _MAX_SCIENCE_JOBS_CACHE, _MAX_SCIENCE_JOBS_CACHE_TS
    global _MFG_TIME_MODIFIER, _COPY_TIME_MODIFIER, _INVENT_TIME_MODIFIER

    if _CHAR_SLOT_DETAILS_CACHE and (time.time() - _CHAR_SLOT_DETAILS_CACHE_TS) < _MAX_JOBS_TTL:
        return dict(_CHAR_SLOT_DETAILS_CACHE)

    MASS_PROD     = 3387
    ADV_MASS_PROD = 24625
    INDUSTRY      = 3380   # Manufacturing: −4% build time per level
    ADV_INDUSTRY  = 3388   # Advanced Industry: −3% build time per level
    LAB_OP        = 3406   # Lab Operation          — +1 slot per level, base 1
    ADV_LAB_OP    = 24624  # Advanced Lab Operation — +1 slot per level
    SCIENCE       = 3402   # Science skill          — −5% copy time per level

    slot_details: dict[str, dict] = {}
    best_mfg_modifier = 1.0
    best_copy_modifier = 1.0
    best_invent_modifier = 1.0
    try:
        import requests as _req
        from characters import get_all_auth_headers, load_characters
        from concurrent.futures import ThreadPoolExecutor

        char_records = load_characters()

        def _fetch_slots(cid, headers):
            char_id = str(cid)
            char_name = char_records.get(char_id, {}).get("character_name", f"Char {char_id}")
            try:
                r = _req.get(
                    f"https://esi.evetech.net/latest/characters/{char_id}/skills/",
                    headers=headers, timeout=10,
                )
                if not r.ok:
                    return char_id, {
                        "character_id": char_id,
                        "character_name": char_name,
                        "mfg_slots": 1,
                        "science_slots": 1,
                        "mfg_time_modifier": 1.0,
                        "copy_time_modifier": 1.0,
                        "invention_time_modifier": 1.0,
                    }
                skill_map = {s["skill_id"]: s["trained_skill_level"] for s in r.json().get("skills", [])}
                mfg_slots = 1 + skill_map.get(MASS_PROD, 0) + skill_map.get(ADV_MASS_PROD, 0)
                science_slots = 1 + skill_map.get(LAB_OP, 0) + skill_map.get(ADV_LAB_OP, 0)
                mfg_mod = (
                    (1.0 - 0.04 * skill_map.get(INDUSTRY, 0))
                    * (1.0 - 0.03 * skill_map.get(ADV_INDUSTRY, 0))
                )
                copy_mod = (
                    (1.0 - 0.05 * skill_map.get(SCIENCE, 0))
                    * (1.0 - 0.03 * skill_map.get(ADV_INDUSTRY, 0))
                )
                invent_mod = (1.0 - 0.03 * skill_map.get(ADV_INDUSTRY, 0))
                return char_id, {
                    "character_id": char_id,
                    "character_name": char_name,
                    "mfg_slots": mfg_slots,
                    "science_slots": science_slots,
                    "mfg_time_modifier": mfg_mod,
                    "copy_time_modifier": copy_mod,
                    "invention_time_modifier": invent_mod,
                }
            except Exception:
                return char_id, {
                    "character_id": char_id,
                    "character_name": char_name,
                    "mfg_slots": 1,
                    "science_slots": 1,
                    "mfg_time_modifier": 1.0,
                    "copy_time_modifier": 1.0,
                    "invention_time_modifier": 1.0,
                }

        auth_headers = get_all_auth_headers()
        if auth_headers:
            with ThreadPoolExecutor(max_workers=len(auth_headers)) as pool:
                for char_id, details in pool.map(lambda x: _fetch_slots(*x), auth_headers):
                    slot_details[char_id] = details
                    best_mfg_modifier = min(best_mfg_modifier, float(details.get("mfg_time_modifier", 1.0) or 1.0))
                    best_copy_modifier = min(best_copy_modifier, float(details.get("copy_time_modifier", 1.0) or 1.0))
                    best_invent_modifier = min(best_invent_modifier, float(details.get("invention_time_modifier", 1.0) or 1.0))
    except Exception:
        slot_details = {}

    with _ESI_STATE_CACHE_LOCK:
        _CHAR_SLOT_DETAILS_CACHE = dict(slot_details)
        _CHAR_SLOT_DETAILS_CACHE_TS = time.time()

        total_mfg_slots = sum(int(details.get("mfg_slots", 0) or 0) for details in slot_details.values())
        total_science_slots = sum(int(details.get("science_slots", 0) or 0) for details in slot_details.values())
        if total_mfg_slots > 0:
            _MAX_JOBS_CACHE = total_mfg_slots
            _MAX_JOBS_CACHE_TS = _CHAR_SLOT_DETAILS_CACHE_TS
            _MFG_TIME_MODIFIER = best_mfg_modifier
        if total_science_slots > 0:
            _MAX_SCIENCE_JOBS_CACHE = total_science_slots
            _MAX_SCIENCE_JOBS_CACHE_TS = _CHAR_SLOT_DETAILS_CACHE_TS
            _COPY_TIME_MODIFIER = best_copy_modifier
            _INVENT_TIME_MODIFIER = best_invent_modifier
    if slot_details:
        threading.Thread(target=_save_esi_state_to_disk, daemon=True).start()
    return dict(slot_details)


def _get_max_jobs(running_fallback: int = 0) -> int:
    """Return sum of manufacturing slots across all characters, refreshed every 30 min."""
    if _MAX_JOBS_CACHE > 0 and (time.time() - _MAX_JOBS_CACHE_TS) < _MAX_JOBS_TTL:
        return _MAX_JOBS_CACHE
    slot_details = _get_character_slot_details()
    total_mfg_slots = sum(int(details.get("mfg_slots", 0) or 0) for details in slot_details.values())
    if total_mfg_slots > 0:
        return total_mfg_slots
    return max(1, running_fallback + 1)


def _get_max_science_jobs(running_fallback: int = 0) -> int:
    """Return sum of science/research slots across all characters (Lab Op + Adv Lab Op).
    Also updates _COPY_TIME_MODIFIER with the best copy-time reduction across all characters."""
    if _MAX_SCIENCE_JOBS_CACHE > 0 and (time.time() - _MAX_SCIENCE_JOBS_CACHE_TS) < _MAX_JOBS_TTL:
        return _MAX_SCIENCE_JOBS_CACHE
    slot_details = _get_character_slot_details()
    total_science_slots = sum(int(details.get("science_slots", 0) or 0) for details in slot_details.values())
    if total_science_slots > 0:
        return total_science_slots
    return max(1, running_fallback + 1)


# ── Queue Summary (footer stats) ───────────────────────────────────────────────
@app.route("/api/queue-summary", methods=["GET"])
def api_queue_summary():
    global _QUEUE_SUMMARY_CACHE, _QUEUE_SUMMARY_CACHE_TS

    def _run_count(row: dict) -> int:
        rec = row.get("recommended_runs")
        if isinstance(rec, dict):
            return max(1, int(rec.get("runs") or 1))
        return max(1, int(row.get("rec_runs") or 1))

    try:
        force = request.args.get("force", "0") == "1"
        now_ts = int(time.time())
        jobs = _ESI_JOBS_CACHE.get("jobs", [])
        running_jobs = sum(
            1 for job in jobs
            if int(job.get("activity_id") or 0) == 1 and job.get("end_ts", 0) > now_ts
        )
        running_science = sum(
            1 for job in jobs
            if int(job.get("activity_id") or 0) in (3, 4, 5, 8) and job.get("end_ts", 0) > now_ts
        )
        max_jobs = _get_max_jobs(running_fallback=running_jobs)

        if not force and _QUEUE_SUMMARY_CACHE and (time.time() - _QUEUE_SUMMARY_CACHE_TS) < _QUEUE_SUMMARY_TTL:
            cached = dict(_QUEUE_SUMMARY_CACHE)
            cached["running_jobs"] = running_jobs
            cached["max_jobs"] = max_jobs
            _record_utilization_snapshot(
                running_jobs=running_jobs,
                max_jobs=max_jobs,
                running_science=running_science,
                max_science=_get_max_science_jobs(running_fallback=running_science),
                source="queue_summary",
            )
            return jsonify(cached)

        queue_items = list(_QUEUE_PLANNER_CANDIDATES_CACHE or [])
        total_cost_isk = 0.0
        total_revenue_isk = 0.0
        haul_m3 = 0.0

        for row in queue_items:
            runs = _run_count(row)
            total_cost_isk += float(row.get("material_cost") or 0) * runs

            gross_revenue = float(row.get("gross_revenue") or 0)
            sales_tax = float(row.get("sales_tax") or 0)
            broker_fee = float(row.get("broker_fee") or 0)
            total_revenue_isk += (gross_revenue - sales_tax - broker_fee) * runs

            for material in row.get("material_breakdown", []) or []:
                quantity = float(material.get("quantity") or 0) * runs
                unit_volume = float(
                    _TYPE_VOLUME_CACHE.get(material.get("type_id"))
                    or material.get("volume_m3")
                    or 1.0
                )
                haul_m3 += quantity * unit_volume

        queue_items_slim = [
            {
                "name": row.get("name", ""),
                "output_id": row.get("output_id"),
                "rec_runs": _run_count(row),
                "material_breakdown": [
                    {
                        "type_id": material.get("type_id"),
                        "name": material.get("name", f"Type {material.get('type_id')}"),
                        "quantity": material.get("quantity", 0),
                        "unit_price": material.get("unit_price", 0),
                        "have_qty": material.get("have_qty"),
                        "covered_qty": material.get("covered_qty"),
                        "needed_qty_total": material.get("needed_qty_total"),
                        "missing_qty": material.get("missing_qty"),
                        "total_line_cost": material.get("total_line_cost"),
                        "missing_line_cost": material.get("missing_line_cost"),
                    }
                    for material in (row.get("material_breakdown", []) or [])
                ],
            }
            for row in queue_items
        ]

        result = {
            "running_jobs": running_jobs,
            "max_jobs": max_jobs,
            "queue_count": len(queue_items),
            "needs_shopping": len(queue_items),
            "total_cost_isk": round(total_cost_isk, 2),
            "total_revenue_isk": round(total_revenue_isk, 2),
            "haul_m3": round(haul_m3, 1),
            "queue_items": queue_items_slim,
        }

        _record_utilization_snapshot(
            running_jobs=running_jobs,
            max_jobs=max_jobs,
            running_science=running_science,
            max_science=_get_max_science_jobs(running_fallback=running_science),
            source="queue_summary",
        )
        _QUEUE_SUMMARY_CACHE = result
        _QUEUE_SUMMARY_CACHE_TS = time.time()
        return jsonify(result)

    except Exception as e:
        return jsonify({"error": str(e)}), 200


# ── Character Market Orders ────────────────────────────────────────────────────
def _refresh_orders() -> dict:
    """
    Fetch fresh orders from ESI for all characters, enrich with market position,
    run sync_open_orders to record fulfilled sales, and update the cache.
    Returns the new cache dict {sell, buy, newly_fulfilled}.
    """
    global _ESI_ORDERS_CACHE, _ESI_ORDERS_CACHE_TS, _LAST_SELL_POS_BY_ORDER

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
            if not resp.ok:
                return orders

            total_pages = max(1, min(int(resp.headers.get("X-Pages", 1) or 1), 50))
            page_payloads = [resp.json()]
            for page in range(2, total_pages + 1):
                page_resp = req.get(
                    f"https://esi.evetech.net/latest/characters/{cid}/orders/",
                    headers=headers,
                    params={"page": page},
                    timeout=15,
                )
                if not page_resp.ok:
                    break
                page_payloads.append(page_resp.json())

            for page_orders in page_payloads:
                for o in page_orders:
                    o["_character_id"]   = cid
                    o["_character_name"] = char_name
                    orders.append(o)
        except Exception as e:
            print(f"  [orders] Failed for {char_name}: {e}")
        return orders

    all_orders = []
    with ThreadPoolExecutor(max_workers=max(1, len(auth_headers))) as pool:
        futures = [pool.submit(_fetch_char_orders, cid, h) for cid, h in auth_headers]
        for f in as_completed(futures):
            all_orders.extend(f.result())

    if not all_orders:
        return {"sell": [], "buy": [], "newly_fulfilled": []}

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
            "region_id":      o.get("region_id"),
            "location_id":    o.get("location_id"),
            "character_id":   o["_character_id"],
            "character_name": o["_character_name"],
        }
        (buy if o.get("is_buy_order") else sell).append(enriched)

    sell.sort(key=lambda x: x["price"] * x["volume_remain"], reverse=True)
    buy.sort(key=lambda x: x["escrow"], reverse=True)

    # ── Enrich sell orders with market position + competitor count ─────────
    # market_position   = 1-based sell rank at the order's known hub
    # competitor_count  = ALL visible sell listings for that hub/type
    try:
        sell_orders = [o for o in sell if o.get("type_id")]
        hub_type_ids: dict[str, set[int]] = {}
        order_hubs: dict[int, dict] = {}
        for o in sell_orders:
            oid = o.get("order_id")
            hub = _market_hub_for_location(o.get("location_id"))
            if not oid or not hub:
                continue
            order_hubs[int(oid)] = hub
            hub_type_ids.setdefault(hub["name"], set()).add(int(o["type_id"]))

        market_books: dict[str, dict[int, dict]] = {}
        for hub in _MARKET_HUBS_SMART:
            tids = sorted(hub_type_ids.get(hub["name"], set()))
            if tids:
                market_books[hub["name"]] = _fetch_hub_sell_books(hub, tids)

        new_pos_by_order: dict[int, int] = {}
        for o in sell:
            o["market_position"] = None
            o["competitor_count"] = None
            o["market_position_prev"] = None
            o["market_position_trend"] = None
            o["market_hub"] = None

            oid = o.get("order_id")
            tid = o.get("type_id")
            if not oid or not tid:
                continue
            hub = order_hubs.get(int(oid))
            if not hub:
                continue
            book = (market_books.get(hub["name"]) or {}).get(int(tid))
            if not book:
                continue

            prices = book.get("prices") or []
            if not prices:
                continue
            position = sum(1 for price in prices if price < float(o.get("price") or 0)) + 1
            o["market_position"] = position
            o["competitor_count"] = int(book.get("order_count") or 0)
            o["market_hub"] = hub["name"]

            prev_pos = _LAST_SELL_POS_BY_ORDER.get(oid)
            o["market_position_prev"] = prev_pos
            if prev_pos is not None and position != prev_pos:
                o["market_position_trend"] = "up" if position < prev_pos else "down"

            new_pos_by_order[int(oid)] = position

        _LAST_SELL_POS_BY_ORDER = new_pos_by_order
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
    return _ESI_ORDERS_CACHE


def _refresh_orders_if_stale() -> None:
    # Trigger a fresh ESI order sync if the cache is stale. Silently ignore
    # errors so this helper stays best-effort.
    if not _ESI_ORDERS_CACHE or (time.time() - _ESI_ORDERS_CACHE_TS) >= _ESI_ORDERS_TTL:
        try:
            _refresh_orders()
        except Exception as _e:
            print(f"  [orders] background sync failed: {_e}")


@app.route("/api/orders", methods=["GET"])
def api_orders():
    # Return active sell and buy orders for all characters combined.
    # Cached for 2 minutes. Character order fetches are parallelized, and sold
    # orders are diffed against the previous snapshot to update history.
    global _ESI_ORDERS_CACHE, _ESI_ORDERS_CACHE_TS, _LAST_SELL_POS_BY_ORDER
    try:
        force = request.args.get("force", "0") == "1"
        if not force and _ESI_ORDERS_CACHE and (time.time() - _ESI_ORDERS_CACHE_TS) < _ESI_ORDERS_TTL:
            return jsonify(_ESI_ORDERS_CACHE)
        return jsonify(_refresh_orders())
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
_SELL_RECOMMENDATION_CACHE: dict = {}
_SELL_RECOMMENDATION_CACHE_TTL = 180


def _market_price_tick(price: float | None) -> float:
    # Cheap heuristic for a small undercut / price-step without hard-coding the
    # full EVE tick ladder. Keeps recommendations human-sized across scales.
    if not price or price <= 0:
        return 0.01
    return max(0.01, round(price * 0.0005, 2))


def _market_hub_for_location(location_id: int | None) -> dict | None:
    if not location_id:
        return None
    for hub in _MARKET_HUBS_SMART:
        if int(hub["station_id"]) == int(location_id):
            return hub
    return None


def _build_sell_book(entries: list[tuple[float, int]]) -> dict | None:
    prices = sorted(price for price, _volume in entries if price and price > 0)
    if not prices:
        return None
    return {
        "prices": prices,
        "best_sell": prices[0],
        "second_sell": prices[1] if len(prices) > 1 else None,
        "order_count": len(prices),
        "visible_volume": sum(max(0, volume) for _price, volume in entries),
    }


def _get_jumps(origin_system_id: int, dest_system_id: int) -> int | None:
    # Query ESI /route/ for the number of jumps between two solar systems.
    # Returns None on error or same-system (0 jumps).
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
    # Resolve a system name or numeric string to a system_id integer.
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
    # Fetch best sell (lowest) prices for a list of type_ids at a specific hub.
    # Jita uses the local market_cache.db fast path.
    # Other hubs query the regional ESI sell-order endpoint per type_id,
    # filtered to the hub station and parallelised with a thread pool.
    # Returns { type_id: best_sell_price }; missing entries mean no stock.
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

    # Non-Jita: use the ESI per-type endpoint, one call per item, parallelised.
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
    # Cap workers at 15; ESI allows about 20 req/s, so stay polite.
    with _TPE(max_workers=15) as pool:
        futures = {pool.submit(_fetch_one, tid): tid for tid in type_ids}
        for fut in _ac(futures):
            tid, price = fut.result()
            if price is not None:
                result[tid] = price

    return result


def _fetch_hub_sell_books(hub: dict, type_ids: list[int]) -> dict[int, dict]:
    # Fetch sorted sell books for one hub. Used by orders POS logic and by the
    # sell recommendation endpoint to derive best/second prices and counts.
    result: dict[int, dict] = {}
    if not type_ids:
        return result

    if hub["name"] == "Jita":
        try:
            import sqlite3 as _sq
            conn = _sq.connect(os.path.join(_HERE, "market_cache.db"))
            conn.row_factory = _sq.Row
            placeholders = ",".join("?" * len(type_ids))
            rows = conn.execute(
                f"SELECT type_id, price, volume_remain FROM market_orders "
                f"WHERE type_id IN ({placeholders}) AND is_buy_order=0 "
                f"ORDER BY type_id ASC, price ASC",
                type_ids,
            ).fetchall()
            conn.close()

            grouped: dict[int, list[tuple[float, int]]] = {}
            for row in rows:
                grouped.setdefault(int(row["type_id"]), []).append((
                    float(row["price"] or 0),
                    int(row["volume_remain"] or 0),
                ))

            for tid, entries in grouped.items():
                book = _build_sell_book(entries)
                if book:
                    result[tid] = book
        except Exception:
            pass
        return result

    region_id = hub["region_id"]
    station_id = hub["station_id"]

    def _fetch_one(tid: int) -> tuple[int, dict | None]:
        try:
            resp = requests.get(
                f"https://esi.evetech.net/latest/markets/{region_id}/orders/",
                params={"order_type": "sell", "type_id": tid},
                timeout=10,
            )
            if not resp.ok:
                return tid, None

            entries = [
                (
                    float(order.get("price") or 0),
                    int(order.get("volume_remain") or 0),
                )
                for order in resp.json()
                if order.get("location_id") == station_id
            ]
            return tid, _build_sell_book(entries)
        except Exception:
            return tid, None

    from concurrent.futures import ThreadPoolExecutor as _TPE, as_completed as _ac

    with _TPE(max_workers=15) as pool:
        futures = {pool.submit(_fetch_one, tid): tid for tid in type_ids}
        for fut in _ac(futures):
            tid, book = fut.result()
            if book:
                result[tid] = book

    return result


def _fetch_hub_sell_overview(hub: dict, type_ids: list[int]) -> dict[int, dict]:
    # Fetch the sell-side shape for a hub: best price, second price, listing
    # count, and total visible volume. This is enough for a pricing heuristic.
    result: dict[int, dict] = {}
    for tid, book in _fetch_hub_sell_books(hub, type_ids).items():
        result[tid] = {
            "best_sell": book.get("best_sell"),
            "second_sell": book.get("second_sell"),
            "order_count": book.get("order_count"),
            "visible_volume": book.get("visible_volume"),
        }
    return result


def _recommend_sell_price(goal: str, best_sell: float | None, second_sell: float | None,
                          fallback_price: float | None, floor_price: float) -> float | None:
    anchor = best_sell or fallback_price
    if not anchor or anchor <= 0:
        return None

    tick = _market_price_tick(anchor)

    if best_sell:
        if goal == "fast":
            target = best_sell - tick
        elif goal == "max":
            if second_sell and second_sell > best_sell:
                target = second_sell - tick
            else:
                target = best_sell * 1.015
        else:
            if second_sell and second_sell > best_sell * 1.004:
                target = min(second_sell - tick, best_sell + ((second_sell - best_sell) * 0.4))
            else:
                target = best_sell - tick
    else:
        if goal == "fast":
            target = anchor * 0.995
        elif goal == "max":
            target = anchor * 1.035
        else:
            target = anchor * 1.015

    return round(max(floor_price, target), 2)


def _estimate_sell_days(goal: str, quantity: int, recommended_price: float | None,
                        best_sell: float | None, daily_volume: float | None,
                        order_count: int, personal_avg_days: float | None,
                        overall_avg_days: float | None, existing_listed_qty: int) -> float | None:
    if not recommended_price or recommended_price <= 0 or quantity <= 0:
        return None

    daily_units = max(float(daily_volume or 0), 0.0)
    market_days = None
    if daily_units > 0:
        market_days = max(0.25, quantity / max(daily_units * 0.65, 1.0))

    baseline = personal_avg_days or market_days or overall_avg_days or 7.0
    if market_days is not None:
        baseline = max(baseline, market_days)

    competition_mult = 1.0 + min(max(order_count, 0), 20) * 0.03
    quantity_mult = 1.0 + (existing_listed_qty / max(quantity, 1)) * 0.15
    goal_mult = {
        "fast": 0.72,
        "balanced": 1.0,
        "max": 1.45,
    }.get(goal, 1.0)

    premium_ratio = 0.0
    if best_sell and best_sell > 0:
        premium_ratio = max(0.0, (recommended_price - best_sell) / best_sell)
    premium_mult = 1.0 + (premium_ratio * 12.0)

    estimate = baseline * competition_mult * quantity_mult * goal_mult * premium_mult
    return round(max(0.25, estimate), 2)


def _get_volume_m3(type_id: int, fallback: float = 0.01) -> float:
    # Look up the packaged volume in m3 for a type_id.
    # Checks: (1) in-memory lookup table, (2) crest.db, (3) ESI, (4) fallback.
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
    # Smart Buy: choose the cheapest set of market hubs for the requested items,
    # taking jump distance from the player's current system into account.
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


@app.route("/api/haul/sell-recommendations", methods=["GET"])
def api_haul_sell_recommendations():
    # Recommend listing prices for inventory that looks worth selling.
    global _SELL_RECOMMENDATION_CACHE
    try:
        goal = (request.args.get("goal") or "balanced").strip().lower()
        if goal not in {"fast", "balanced", "max"}:
            goal = "balanced"

        requested_hub = (request.args.get("hub") or "Jita").strip()
        limit = max(1, min(int(request.args.get("limit", 30) or 30), 100))
        min_total_value = max(float(request.args.get("min_total_value", 1000000) or 0), 0.0)

        target_hub = next(
            (hub for hub in _MARKET_HUBS_SMART if hub["name"].lower() == requested_hub.lower()),
            _MARKET_HUBS_SMART[0],
        )

        cache_key = json.dumps({
            "goal": goal,
            "hub": target_hub["name"],
            "limit": limit,
            "min_total_value": min_total_value,
        }, sort_keys=True)
        cached = _SELL_RECOMMENDATION_CACHE.get(cache_key)
        if cached and (time.time() - cached["_ts"]) < _SELL_RECOMMENDATION_CACHE_TTL:
            return jsonify({k: v for k, v in cached.items() if k != "_ts"})

        if not _ASSETS_CACHE or (time.time() - _ASSETS_CACHE_TS) >= _ASSETS_TTL:
            api_assets()

        assets = _ASSETS_CACHE.get("assets", {}) if _ASSETS_CACHE else {}
        names = _ASSETS_CACHE.get("names", {}) if _ASSETS_CACHE else {}

        if not assets:
            payload = {
                "goal": goal,
                "selected_hub": target_hub["name"],
                "hubs": [hub["name"] for hub in _MARKET_HUBS_SMART],
                "summary": {
                    "item_count": 0,
                    "total_units": 0,
                    "total_recommended_value": 0.0,
                    "items_with_better_hub": 0,
                },
                "items": [],
            }
            _SELL_RECOMMENDATION_CACHE[cache_key] = {**payload, "_ts": time.time()}
            return jsonify(payload)

        try:
            from pricer import get_prices_bulk
            asset_type_ids = [int(type_id) for type_id, qty in assets.items() if int(qty or 0) > 0]
            reference_prices = get_prices_bulk(asset_type_ids, history_ids=[])
        except Exception:
            reference_prices = {}

        candidate_rows = []
        for raw_type_id, raw_qty in assets.items():
            type_id = int(raw_type_id)
            quantity = int(raw_qty or 0)
            if quantity <= 0:
                continue

            name = names.get(str(type_id)) or names.get(type_id) or f"Type {type_id}"
            if "blueprint" in name.lower():
                continue

            ref_price = reference_prices.get(type_id)
            if not ref_price:
                continue

            rough_unit_price = (
                ref_price.get("sell")
                or ref_price.get("average_price")
                or ref_price.get("adjusted_price")
                or ref_price.get("buy")
            )
            if not rough_unit_price or rough_unit_price <= 0:
                continue

            rough_total_value = float(rough_unit_price) * quantity
            if rough_total_value < min_total_value:
                continue

            candidate_rows.append({
                "type_id": type_id,
                "name": name,
                "quantity": quantity,
                "rough_total_value": round(rough_total_value, 2),
            })

        candidate_rows.sort(key=lambda row: row["rough_total_value"], reverse=True)
        fetch_cap = min(len(candidate_rows), max(limit, 40))
        scoped_candidates = candidate_rows[:fetch_cap]
        scoped_type_ids = [row["type_id"] for row in scoped_candidates]

        if not scoped_type_ids:
            payload = {
                "goal": goal,
                "selected_hub": target_hub["name"],
                "hubs": [hub["name"] for hub in _MARKET_HUBS_SMART],
                "summary": {
                    "item_count": 0,
                    "total_units": 0,
                    "total_recommended_value": 0.0,
                    "items_with_better_hub": 0,
                },
                "items": [],
            }
            _SELL_RECOMMENDATION_CACHE[cache_key] = {**payload, "_ts": time.time()}
            return jsonify(payload)

        from pricer import get_prices_bulk
        scoped_prices = get_prices_bulk(scoped_type_ids, history_ids=scoped_type_ids)

        _refresh_orders_if_stale()
        live_sell_orders = (_ESI_ORDERS_CACHE or {}).get("sell", [])
        active_sell_by_type: dict[int, int] = {}
        for order in live_sell_orders:
            type_id = int(order.get("type_id") or 0)
            if not type_id:
                continue
            active_sell_by_type[type_id] = active_sell_by_type.get(type_id, 0) + int(order.get("volume_remain") or 0)

        sell_velocity = get_sell_velocity_by_type_id()
        sell_history = get_sell_history_stats()
        overall_avg_days = (sell_history.get("overall") or {}).get("avg_days_to_sell")

        hub_overviews = {
            hub["name"]: _fetch_hub_sell_overview(hub, scoped_type_ids)
            for hub in _MARKET_HUBS_SMART
        }

        fee_fraction = float(CALC_CONFIG.get("sales_tax", 0.0)) + float(CALC_CONFIG.get("broker_fee", 0.0))
        items = []

        for row in scoped_candidates:
            type_id = row["type_id"]
            quantity = row["quantity"]
            price_row = scoped_prices.get(type_id) or {}
            selected_overview = (hub_overviews.get(target_hub["name"]) or {}).get(type_id, {})

            best_sell = selected_overview.get("best_sell")
            second_sell = selected_overview.get("second_sell")
            fallback_price = (
                price_row.get("sell")
                or price_row.get("average_price")
                or price_row.get("adjusted_price")
                or price_row.get("buy")
            )
            if not best_sell and not fallback_price:
                continue

            floor_price = max(
                float(price_row.get("buy") or 0) * 1.01,
                float(price_row.get("adjusted_price") or 0) * 0.9,
                float(price_row.get("average_price") or 0) * 0.88,
                0.01,
            )
            recommended_price = _recommend_sell_price(
                goal,
                best_sell,
                second_sell,
                fallback_price,
                floor_price,
            )
            if not recommended_price:
                continue

            personal_velocity = sell_velocity.get(type_id) or {}
            daily_volume = price_row.get("avg_daily_volume")
            order_count = int(selected_overview.get("order_count") or 0)
            existing_listed_qty = int(active_sell_by_type.get(type_id) or 0)
            estimated_days = _estimate_sell_days(
                goal,
                quantity,
                recommended_price,
                best_sell,
                daily_volume,
                order_count,
                personal_velocity.get("avg_days_to_sell"),
                overall_avg_days,
                existing_listed_qty,
            )

            hub_prices = []
            for hub in _MARKET_HUBS_SMART:
                overview = (hub_overviews.get(hub["name"]) or {}).get(type_id, {})
                hub_best_sell = overview.get("best_sell")
                if hub_best_sell:
                    hub_prices.append({
                        "hub": hub["name"],
                        "best_sell": round(float(hub_best_sell), 2),
                        "order_count": int(overview.get("order_count") or 0),
                    })

            best_elsewhere = None
            for hub_price in sorted(hub_prices, key=lambda entry: entry["best_sell"], reverse=True):
                if hub_price["hub"] == target_hub["name"]:
                    continue
                delta_per_unit = hub_price["best_sell"] - recommended_price
                delta_total = delta_per_unit * quantity
                if delta_per_unit > max(recommended_price * 0.05, 10000) and delta_total > 1000000:
                    best_elsewhere = {
                        "hub": hub_price["hub"],
                        "best_sell": hub_price["best_sell"],
                        "delta_per_unit": round(delta_per_unit, 2),
                        "delta_total": round(delta_total, 2),
                    }
                    break

            net_after_fees_per_unit = round(recommended_price * (1.0 - fee_fraction), 2)
            total_net_after_fees = round(net_after_fees_per_unit * quantity, 2)
            total_recommended_value = round(recommended_price * quantity, 2)

            items.append({
                "type_id": type_id,
                "name": row["name"],
                "quantity": quantity,
                "selected_hub": target_hub["name"],
                "goal": goal,
                "recommended_price": round(recommended_price, 2),
                "price_floor": round(floor_price, 2),
                "selected_hub_best_sell": round(float(best_sell), 2) if best_sell else None,
                "selected_hub_second_sell": round(float(second_sell), 2) if second_sell else None,
                "selected_hub_order_count": order_count,
                "selected_hub_visible_volume": int(selected_overview.get("visible_volume") or 0),
                "jita_best_sell": round(float(price_row.get("sell")), 2) if price_row.get("sell") else None,
                "jita_best_buy": round(float(price_row.get("buy")), 2) if price_row.get("buy") else None,
                "daily_volume": round(float(daily_volume), 2) if daily_volume is not None else None,
                "estimated_days_to_sell": estimated_days,
                "existing_listed_qty": existing_listed_qty,
                "history_avg_days_to_sell": personal_velocity.get("avg_days_to_sell"),
                "history_total_sold": personal_velocity.get("total_sold"),
                "net_after_fees_per_unit": net_after_fees_per_unit,
                "total_net_after_fees": total_net_after_fees,
                "total_recommended_value": total_recommended_value,
                "better_hub": best_elsewhere,
                "hub_prices": hub_prices,
            })

        items.sort(
            key=lambda item: (
                item["better_hub"]["delta_total"] if item.get("better_hub") else 0,
                item["total_recommended_value"],
            ),
            reverse=True,
        )
        items = items[:limit]

        payload = {
            "goal": goal,
            "selected_hub": target_hub["name"],
            "hubs": [hub["name"] for hub in _MARKET_HUBS_SMART],
            "summary": {
                "item_count": len(items),
                "total_units": sum(item["quantity"] for item in items),
                "total_recommended_value": round(sum(item["total_recommended_value"] for item in items), 2),
                "total_net_after_fees": round(sum(item["total_net_after_fees"] for item in items), 2),
                "items_with_better_hub": sum(1 for item in items if item.get("better_hub")),
                "asset_candidates_considered": len(scoped_candidates),
            },
            "items": items,
        }

        _SELL_RECOMMENDATION_CACHE[cache_key] = {**payload, "_ts": time.time()}
        return jsonify(payload)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e), "items": [], "summary": {}}), 500


@app.route("/api/sell_history", methods=["GET"])
def api_sell_history():
    # Return sell-time statistics derived from sell_order_history.
    try:
        stats = get_sell_history_stats()
        return jsonify(stats)
    except Exception as e:
        return jsonify({"error": str(e), "overall": {}, "by_item": {}}), 200


@app.route("/api/sell_history/fill_rate", methods=["GET"])
def api_sell_history_fill_rate():
    # Return 7-day sell-order fill rate.
    try:
        from database import get_fill_rate_7d
        return jsonify(get_fill_rate_7d())
    except Exception as e:
        return jsonify({"error": str(e)}), 200


@app.route("/api/unrealized_value", methods=["GET"])
def api_unrealized_value():
    # Return the total ISK value of all character assets at current Jita sell
    # prices. Auto-fetches assets from ESI if the cache is cold.
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
    # Return blueprint utilization rate: how many owned blueprints generated at
    # least one manufacturing job in the last 30 days.
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
    # Return the current status of the background alert scanner.
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
    # Write or update key=value pairs in the .env file for the given keys.
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
    # Return the current bot/alert config with the token partially masked.
    return jsonify({**_alert_scanner.get_public_config(), **_alert_scanner.status})


@app.route("/api/settings/bot", methods=["POST"])
async def api_settings_bot_post():
    # Save bot/alert settings to .env and hot-reload the in-memory config.
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
            string_val = str(val).strip()
            if key == "TELEGRAM_TOKEN":
                masked_token = _alert_scanner.get_public_config().get("TELEGRAM_TOKEN", "")
                if "*" in string_val and ":" not in string_val:
                    if string_val == masked_token:
                        continue
                    return jsonify({"ok": False, "error": "Bot token looks masked. Paste the full token from @BotFather."}), 400
                token_error = _alert_scanner.validate_telegram_config(
                    token=string_val,
                    chat_id=_alert_scanner.CONFIG.get("TELEGRAM_CHAT_ID", ""),
                )
                if token_error and "chat ID" not in token_error:
                    return jsonify({"ok": False, "error": token_error}), 400
            elif key == "TELEGRAM_CHAT_ID" and any(ch.isspace() for ch in string_val):
                return jsonify({"ok": False, "error": "Telegram chat ID cannot contain whitespace."}), 400
            validated[key] = string_val
    # Persist strings to .env (token + chat_id + blueprint_type)
    env_updates = {k: str(v) for k, v in validated.items()}
    _rewrite_env({k: v for k, v in env_updates.items() if k in {"TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID", "BLUEPRINT_TYPE"}})
    # Hot-reload scanner memory
    _alert_scanner.update_config(validated)
    return jsonify({"ok": True, **_alert_scanner.get_public_config()})


@app.route("/api/settings/bot/test", methods=["POST"])
async def api_settings_bot_test():
    # Send a test Telegram message using the current config.
    config_error = _alert_scanner.validate_telegram_config()
    if config_error:
        return jsonify({"ok": False, "error": config_error}), 200
    ok = _alert_scanner._tg_send("<b>CREST</b> - test message. Bot is connected.")
    if ok:
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": _alert_scanner.status.get("last_error") or "Send failed - check token and chat ID"}), 200


@app.route("/api/contracts/status", methods=["GET"])
def api_contracts_status():
    # Return the current state of the local contract cache.
    try:
        region_id = int(request.args.get("region_id", _CC_REGION_ID))
        stats = _cc.get_stats(region_id)
        return jsonify({"ok": True, **stats})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 200


@app.before_serving
async def _startup():
    # Quart before_serving hook. Runs once when Hypercorn starts accepting
    # connections and launches the background tasks on the active event loop.
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
    global _skill_id_names, _server_ready, _warmup_stage, _calc_ready

    # Restore any cached calculator results from the previous run immediately
    # so /api/calculator hits are instant even before the prewarm completes.
    await asyncio.to_thread(_load_calc_cache_from_disk)

    # Restore ESI blueprint/jobs/slot data so the planner can assign items
    # immediately — before the first live ESI refresh has a chance to run.
    await asyncio.to_thread(_load_esi_state_from_disk)

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
        # Directly populate the scan cache without an HTTP round trip.
        try:
            from pricer import get_prices_bulk
            results = calculate_all()
            if not results:
                print("  [prewarm] Scan warmup skipped: calculator returned no results.")
                return
            all_type_ids = set(MINERALS.values())
            for r in results:
                for mat in r.get("material_breakdown", []):
                    all_type_ids.add(mat["type_id"])
            prices = get_prices_bulk(list(all_type_ids))
            output_ids = {r.get("output_id") for r in results if r.get("output_id")}
            if _prices_look_unhealthy(prices, output_ids):
                priced_outputs, total_outputs, coverage_ratio = _output_price_coverage(prices, output_ids)
                print(
                    "  [prewarm] Scan warmup skipped: unhealthy market coverage "
                    f"({priced_outputs}/{total_outputs}, {coverage_ratio:.1%})."
                )
                return
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
        # Directly populate the calculator cache for default params
        # (Korsiki / Large Eng. Complex).
        # Mirrors the full api_calculator pipeline so the cached result includes
        # all derived fields and is indistinguishable from a user-triggered
        # calculation.
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
            if _prices_look_unhealthy(prices, output_ids):
                priced_outputs, total_outputs, coverage_ratio = _output_price_coverage(prices, output_ids)
                print(
                    "  [prewarm] Calculator warmup skipped: unhealthy market coverage "
                    f"({priced_outputs}/{total_outputs}, {coverage_ratio:.1%})."
                )
                return

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
            _calc_ready = True
            threading.Thread(target=_save_calc_cache_to_disk, daemon=True).start()
            print("  [prewarm] Calculator cache ready.")
        except Exception as _e:
            print(f"  [prewarm] Calculator warmup failed: {_e}")

    _warmup_stage = "scan"
    print("  [prewarm] Background warmup starting (skill names + scan cache in parallel)...")
    await asyncio.gather(
        asyncio.to_thread(_load_skill_names),
        asyncio.to_thread(_warmup_scan_sync),
    )

    _warmup_stage = "ready"
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



