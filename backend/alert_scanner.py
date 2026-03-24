"""
alert_scanner.py - Automatic background scanner with Telegram alerts
=====================================================================
Runs two kinds of scans periodically:

  1. ROI scan  — Checks the latest calculator results every 30 min.
                 Alerts when a blueprint has ROI >= ROI_THRESHOLD (default 50%).

  2. Contract scan — Scans ESI public contracts in Jita / The Forge every hour.
                     Alerts when a BPO is listed at <= CHEAP_THRESHOLD (default 50%)
                     of its median contract price (i.e. it's unusually cheap).

Alerts are sent via Telegram bot. Each unique deal is only alerted ONCE per
ALERT_COOLDOWN_HOURS (default 6h) to avoid repeat spam.

Configuration (edit the CONFIG dict below):
    TELEGRAM_TOKEN      — bot token from @BotFather
    TELEGRAM_CHAT_ID    — your personal / group chat ID
    ROI_THRESHOLD       — minimum ROI % to trigger alert (default 50)
    CHEAP_THRESHOLD     — contract price / median price to trigger (default 0.50 = 50% off)
    ROI_SCAN_INTERVAL   — seconds between ROI scans (default 1800 = 30 min)
    CONTRACT_SCAN_INTERVAL — seconds between contract scans (default 3600 = 1 hour)
    ALERT_COOLDOWN_HOURS — hours before the same deal is re-alerted (default 6)
    MIN_NET_PROFIT      — minimum net profit in ISK to bother alerting (default 5M)
    MAX_PAGES           — max ESI contract pages to fetch per scan (default 10)
"""

import time
import threading
import requests
import os

# ─── Configuration ────────────────────────────────────────────────────────────
def _load_env_file():
    """Load .env file from the project root into os.environ (fallback if python-dotenv absent)."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip())

_load_env_file()

CONFIG = {
    "TELEGRAM_TOKEN":          os.environ.get("TELEGRAM_TOKEN", ""),
    "TELEGRAM_CHAT_ID":        os.environ.get("TELEGRAM_CHAT_ID", ""),

    # Minimum manufacturing ROI % for a blueprint to be worth alerting on
    "ROI_THRESHOLD":           10.0,

    # Max runs to break even on the contract purchase price (ceil(price/profit_per_run))
    # e.g. 50 = you recover the BP cost within 50 manufacturing runs
    "BREAKEVEN_MAX_RUNS":      1000,

    # How many hours before the same contract fires again (avoids spam)
    "ALERT_COOLDOWN_HOURS":    6,

    # Minimum net ISK profit per run (filters junk items)
    "MIN_NET_PROFIT":          1_000_000,   # 1M ISK

    # Scan interval (seconds)
    "CONTRACT_SCAN_INTERVAL":  900,    # 15 minutes — fast enough to snipe new listings

    # How often to check industry job timers (seconds)
    "JOB_SCAN_INTERVAL":       300,    # 5 minutes

    # Max ESI contract pages to scan (each page = 1000 contracts)
    "MAX_PAGES":               10,   # was 20 — newest BPO listings always appear on pages 1-10

    # ESI region to scan contracts in (10000002 = The Forge / Jita, 0 = all major hubs)
    "REGION_ID":               10000002,

    # Which blueprint types to watch for in contracts: "bpo", "bpc", or "both"
    "BLUEPRINT_TYPE":          os.environ.get("BLUEPRINT_TYPE", "bpo"),
}

# ─── State (in-memory) ────────────────────────────────────────────────────────
# Maps alert_key → last_alerted_timestamp
_alerted: dict[str, float] = {}
_alerted_lock = threading.Lock()

# Job notification state — persists for the process lifetime (job_ids are unique)
_warned_5min: set = set()    # job_ids that received the 5-min warning
_warned_done: set = set()    # job_ids that received the completion notice

# Public status for the /api/alerts/status endpoint
status = {
    "running":              False,
    "last_contract_scan":   None,   # ISO timestamp string
    "last_job_scan":        None,
    "last_alert_sent":      None,
    "alerts_sent":          0,
    "contract_deals_found": 0,
    "last_error":           None,
}


# ─── Telegram helpers ─────────────────────────────────────────────────────────

def _tg_send(text: str) -> bool:
    """Send a message to the configured Telegram chat. Returns True on success."""
    token   = CONFIG["TELEGRAM_TOKEN"]
    chat_id = CONFIG["TELEGRAM_CHAT_ID"]
    url     = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        resp = requests.post(
            url,
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            timeout=10,
        )
        ok = resp.ok and resp.json().get("ok")
        if not ok:
            print(f"  [alerts] Telegram error: {resp.text[:200]}")
        return bool(ok)
    except Exception as e:
        print(f"  [alerts] Telegram send failed: {e}")
        return False


# ─── Public config helpers (used by /api/settings/bot) ───────────────────────

def get_public_config() -> dict:
    """Return a copy of CONFIG suitable for the UI. Token is partially masked."""
    token = CONFIG.get("TELEGRAM_TOKEN", "")
    masked = (token[:4] + "*" * max(0, len(token) - 4)) if len(token) > 4 else ("*" * len(token))
    return {
        "TELEGRAM_TOKEN":         masked,
        "TELEGRAM_CHAT_ID":       CONFIG.get("TELEGRAM_CHAT_ID", ""),
        "ROI_THRESHOLD":          CONFIG.get("ROI_THRESHOLD"),
        "BREAKEVEN_MAX_RUNS":     CONFIG.get("BREAKEVEN_MAX_RUNS"),
        "MIN_NET_PROFIT":         CONFIG.get("MIN_NET_PROFIT"),
        "ALERT_COOLDOWN_HOURS":   CONFIG.get("ALERT_COOLDOWN_HOURS"),
        "CONTRACT_SCAN_INTERVAL": CONFIG.get("CONTRACT_SCAN_INTERVAL"),
        "JOB_SCAN_INTERVAL":      CONFIG.get("JOB_SCAN_INTERVAL"),
        "MAX_PAGES":              CONFIG.get("MAX_PAGES"),
        "REGION_ID":              CONFIG.get("REGION_ID"),
        "BLUEPRINT_TYPE":         CONFIG.get("BLUEPRINT_TYPE", "bpo"),
    }


_NUMERIC_KEYS = {
    "ROI_THRESHOLD", "BREAKEVEN_MAX_RUNS", "MIN_NET_PROFIT",
    "ALERT_COOLDOWN_HOURS", "CONTRACT_SCAN_INTERVAL", "JOB_SCAN_INTERVAL",
    "MAX_PAGES", "REGION_ID",
}
_ALLOWED_KEYS = _NUMERIC_KEYS | {"TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID", "BLUEPRINT_TYPE"}


def update_config(updates: dict) -> None:
    """Apply validated updates to the in-memory CONFIG dict (takes effect immediately)."""
    for key, val in updates.items():
        if key not in _ALLOWED_KEYS:
            continue
        if key in _NUMERIC_KEYS:
            CONFIG[key] = float(val) if isinstance(val, float) else int(val)
        else:
            CONFIG[key] = str(val)


def _should_alert(key: str) -> bool:
    """Return True if this deal hasn't been alerted within the cooldown window."""
    cooldown = CONFIG["ALERT_COOLDOWN_HOURS"] * 3600
    with _alerted_lock:
        last = _alerted.get(key, 0)
        if time.time() - last >= cooldown:
            _alerted[key] = time.time()
            return True
    return False


def _fmt_isk(v: float) -> str:
    if abs(v) >= 1_000_000_000:
        return f"{v / 1_000_000_000:.2f}B"
    if abs(v) >= 1_000_000:
        return f"{v / 1_000_000:.1f}M"
    if abs(v) >= 1_000:
        return f"{v / 1_000:.0f}K"
    return f"{v:.0f}"


# ─── Contract scan ────────────────────────────────────────────────────────────

def _fetch_contract_page(session, region_id: int, page: int):
    try:
        r = session.get(
            f"https://esi.evetech.net/latest/contracts/public/{region_id}/",
            params={"page": page},
            timeout=12,
        )
        if r.status_code == 404:
            return [], 1
        r.raise_for_status()
        total = int(r.headers.get("X-Pages", 1))
        return r.json(), total
    except Exception:
        return [], 1


def _fetch_contract_items(session, contract_id: int) -> list:
    try:
        r = session.get(
            f"https://esi.evetech.net/latest/contracts/public/items/{contract_id}/",
            timeout=10,
        )
        if not r.ok:
            return []
        return r.json()
    except Exception:
        return []


def _run_contract_scan(calc_cache: dict, calc_cache_ttl: int):
    """
    Scan ESI public contracts for BPOs worth sniping.
    A BPO is alerted when:
      - Manufacturing ROI >= ROI_THRESHOLD
      - net_profit >= MIN_NET_PROFIT per run
      - breakeven_runs = ceil(price / net_profit) <= BREAKEVEN_MAX_RUNS
    """
    import math as _math
    try:
        from concurrent.futures import ThreadPoolExecutor, as_completed

        # ── Pull fresh calc data ───────────────────────────────────────────────
        now = time.time()
        fresh_entry = None
        for entry in calc_cache.values():
            gen = entry.get("generated_at", 0)
            if (now - gen) < calc_cache_ttl:
                if fresh_entry is None or gen > fresh_entry.get("generated_at", 0):
                    fresh_entry = entry

        if not fresh_entry:
            print("  [alerts/contract] No fresh calc data — skipping scan.")
            return

        roi_threshold  = CONFIG["ROI_THRESHOLD"]
        min_profit     = CONFIG["MIN_NET_PROFIT"]
        breakeven_max  = CONFIG["BREAKEVEN_MAX_RUNS"]

        calc_results = fresh_entry.get("results", [])
        # Only watch BPOs that meet ROI + minimum profit thresholds
        bpid_to_calc = {
            r["blueprint_id"]: r
            for r in calc_results
            if r.get("blueprint_id")
            and (r.get("roi") or 0) >= roi_threshold
            and (r.get("net_profit") or 0) >= min_profit
        }
        wanted_bp_ids = set(bpid_to_calc.keys())

        if not wanted_bp_ids:
            print(f"  [alerts/contract] No BPs meet ROI >= {roi_threshold}% threshold — skipping.")
            return

        region_id = CONFIG["REGION_ID"]
        max_pages = CONFIG["MAX_PAGES"]

        # Resolve region IDs to scan: 0 = all five major trade hub regions
        _MAJOR_HUB_REGIONS = [10000002, 10000043, 10000032, 10000042, 10000030]
        regions_to_scan = _MAJOR_HUB_REGIONS if int(region_id) == 0 else [int(region_id)]
        session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(pool_connections=16, pool_maxsize=16, max_retries=0)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        retry_count = 0
        error_count = 0
        backoff_until = [0.0]
        backoff_lock = threading.Lock()
        rate_lock = threading.Lock()
        next_slot = [time.time()]
        slot_interval = [0.2]

        def _wait_rate_slot():
            while True:
                with rate_lock:
                    now = time.time()
                    if now >= next_slot[0]:
                        next_slot[0] = now + slot_interval[0]
                        return
                    wait_for = max(0.01, next_slot[0] - now)
                time.sleep(wait_for)

        def _esi_get(url: str, *, params=None, timeout=(6, 12), allow_404=False):
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
                        slot_interval[0] = 1.5
                    elif remain < 30:
                        slot_interval[0] = 0.6
                    elif remain > 60:
                        slot_interval[0] = 0.2

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

        # ── Fetch contract pages (iterates over all configured regions) ─────────
        region_label = "ALL MAJOR HUBS" if int(region_id) == 0 else str(region_id)
        print(f"  [alerts/contract] Scanning ESI contracts ({region_label}, up to {max_pages} pages/region)…")

        def _fetch_region_pages(rid: int) -> tuple[list, int]:
            """Fetch all item_exchange contracts from a single region."""
            fr, fstatus = _esi_get(
                f"https://esi.evetech.net/latest/contracts/public/{rid}/",
                params={"page": 1}, timeout=(6, 14), allow_404=True,
            )
            if fstatus not in (200, 404) or fr is None:
                print(f"  [alerts/contract] Failed to load initial page for region {rid}, skipping.")
                return [], 0
            found = [c for c in fr.json() if c.get("type") == "item_exchange"]
            total = min(int(fr.headers.get("X-Pages", 1)), max_pages)
            if total > 1:
                def _fetch_page(page: int, _rid=rid):
                    resp, code = _esi_get(
                        f"https://esi.evetech.net/latest/contracts/public/{_rid}/",
                        params={"page": page}, timeout=(6, 12), allow_404=True,
                    )
                    if code == 404 or resp is None:
                        return []
                    return resp.json()
                with ThreadPoolExecutor(max_workers=4) as pool:
                    futures = {pool.submit(_fetch_page, p): p for p in range(2, total + 1)}
                    for fut in as_completed(futures):
                        found.extend(c for c in fut.result() if c.get("type") == "item_exchange")
            return found, total

        all_contracts = []
        total_pages_scanned = 0
        for _rid in regions_to_scan:
            region_contracts, region_pages = _fetch_region_pages(_rid)
            all_contracts.extend(region_contracts)
            total_pages_scanned += region_pages

        # Blueprints have tiny volume — skip obviously non-BP contracts
        candidates = [c for c in all_contracts if c.get("volume", 999) <= 1000]
        print(f"  [alerts/contract] {len(candidates)} candidate contracts from {total_pages_scanned} pages.")

        # ── Match contracts to wanted BPOs ────────────────────────────────────
        bp_filter = CONFIG.get("BLUEPRINT_TYPE", "bpo")

        def check_contract(contract):
            resp, _ = _esi_get(
                f"https://esi.evetech.net/latest/contracts/public/items/{contract['contract_id']}/",
                timeout=(5, 10),
                allow_404=True,
            )
            if resp is None:
                return []
            items = resp.json() or []
            out = []
            for item in items:
                tid = item.get("type_id")
                is_copy = item.get("is_blueprint_copy", False)
                type_ok = (
                    bp_filter == "both"
                    or (bp_filter == "bpo" and not is_copy)
                    or (bp_filter == "bpc" and is_copy)
                )
                if tid in wanted_bp_ids and item.get("is_included", True) and type_ok:
                    out.append({
                        "contract":  contract,
                        "type_id":   tid,
                        "me":        item.get("material_efficiency", 0),
                        "te":        item.get("time_efficiency", 0),
                        "is_copy":   is_copy,
                    })
            return out

        matched: list[dict] = []
        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = [pool.submit(check_contract, c) for c in candidates]
            for fut in as_completed(futures):
                result = fut.result() or []
                matched.extend(result)

        if not matched:
            print("  [alerts/contract] No matching BPO contracts found.")
            status["contract_deals_found"] = 0
            print(f"  [alerts/contract] Request retries={retry_count}, request_errors={error_count}")
            return

        # ── Evaluate each match ───────────────────────────────────────────────
        deals_found = 0
        for m in matched:
            contract   = m["contract"]
            bpid       = m["type_id"]
            price      = contract.get("price", 0)
            calc_row   = bpid_to_calc.get(bpid, {})
            name       = calc_row.get("name", "Unknown")
            roi        = calc_row.get("roi", 0)
            net_profit = calc_row.get("net_profit", 0)
            isk_per_hr = calc_row.get("isk_per_hour", 0)
            me         = m["me"]
            te         = m["te"]
            bp_label   = "BPC" if m.get("is_copy") else "BPO"

            if net_profit <= 0:
                continue

            breakeven_runs = _math.ceil(price / net_profit)
            if breakeven_runs > breakeven_max:
                continue  # too many runs to recoup purchase cost

            # Alert key per contract so each listing fires once
            alert_key = f"{bp_label.lower()}|{contract['contract_id']}"
            if not _should_alert(alert_key):
                continue

            deals_found += 1
            iph_line = f"\nISK/hr: {_fmt_isk(isk_per_hr)}" if isk_per_hr else ""
            msg = (
                f"<b>{bp_label} CONTRACT: {name}</b>\n"
                f"Price: {_fmt_isk(price)}  |  ME{me} TE{te}\n"
                f"ROI: {roi:.1f}%  |  Profit: {_fmt_isk(net_profit)}/run"
                f"{iph_line}\n"
                f"Breakeven: {breakeven_runs} runs"
            )
            if _tg_send(msg):
                status["alerts_sent"] += 1
                status["last_alert_sent"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                print(f"  [alerts/contract] Alert sent: {name} @ {_fmt_isk(price)} — {roi:.1f}% ROI, {breakeven_runs} runs breakeven")

        status["contract_deals_found"] = deals_found
        print(f"  [alerts/contract] Request retries={retry_count}, request_errors={error_count}")
        print(f"  [alerts/contract] Scan complete. {deals_found} new deal alert(s) sent.")

    except Exception as e:
        status["last_error"] = str(e)
        print(f"  [alerts/contract] Error: {e}")


# ─── Job completion scan ─────────────────────────────────────────────────────

def _run_job_scan():
    """
    Poll industry jobs for all characters.
    Sends Telegram alerts:
      - ~5 minutes before a job finishes  (end_ts - now <= 300s, status "active")
      - When a job is complete and ready to deliver  (status "ready")
    """
    try:
        from characters import get_all_auth_headers, load_characters
        from concurrent.futures import ThreadPoolExecutor, as_completed as _ac
        from datetime import datetime, timezone
        import requests as _req

        char_records = load_characters()
        auth_headers = get_all_auth_headers()
        if not auth_headers:
            return

        ACTIVITY_NAMES = {
            1: "Manufacturing", 3: "TE Research", 4: "ME Research",
            5: "Copying", 8: "Invention", 9: "Reactions", 11: "Reaction",
        }

        def _fetch(cid, headers):
            char_name = char_records.get(cid, {}).get("character_name", f"Char {cid}")
            jobs = []
            try:
                r = _req.get(
                    f"https://esi.evetech.net/latest/characters/{cid}/industry/jobs/",
                    headers=headers, params={"include_completed": False}, timeout=15,
                )
                if r.ok:
                    for j in r.json():
                        j["_char_name"] = char_name
                        jobs.append(j)
            except Exception as e:
                print(f"  [alerts/jobs] Fetch failed for {char_name}: {e}")
            return jobs

        all_jobs = []
        seen_ids: set = set()
        with ThreadPoolExecutor(max_workers=max(1, len(auth_headers))) as pool:
            futures = [pool.submit(_fetch, cid, h) for cid, h in auth_headers]
            for f in _ac(futures):
                for j in f.result():
                    jid = j.get("job_id")
                    if jid and jid not in seen_ids:
                        seen_ids.add(jid)
                        all_jobs.append(j)

        if not all_jobs:
            return

        # Bulk-resolve product names
        product_ids = list({j.get("product_type_id") for j in all_jobs if j.get("product_type_id")})
        names: dict = {}
        if product_ids:
            try:
                for i in range(0, len(product_ids), 1000):
                    nr = _req.post(
                        "https://esi.evetech.net/latest/universe/names/",
                        json=product_ids[i:i+1000], timeout=10
                    )
                    if nr.ok:
                        for item in nr.json():
                            names[item["id"]] = item["name"]
            except Exception:
                pass

        now = time.time()

        for j in all_jobs:
            jid       = j.get("job_id")
            pid       = j.get("product_type_id")
            runs      = j.get("runs", 1)
            jstatus   = j.get("status", "")
            act       = ACTIVITY_NAMES.get(j.get("activity_id"), "Job")
            char_name = j.get("_char_name", "?")
            name      = names.get(pid, f"Type {pid}") if pid else "Unknown"

            # Parse ISO end_date → unix timestamp
            end_ts = 0
            end_str = j.get("end_date", "")
            if end_str:
                try:
                    dt = datetime.strptime(end_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                    end_ts = dt.timestamp()
                except Exception:
                    pass

            secs_left = end_ts - now

            # ── 5-minute warning ─────────────────────────────────────────────
            if 0 < secs_left <= 300 and jid not in _warned_5min:
                _warned_5min.add(jid)
                mins = max(1, int(secs_left / 60))
                msg = (
                    f"\u23f1 <b>{act} finishing soon!</b>\n"
                    f"{name}  \u00d7{runs}\n"
                    f"<i>{char_name}</i>  \u2022  ~{mins} min left"
                )
                if _tg_send(msg):
                    status["alerts_sent"] += 1
                    status["last_alert_sent"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    print(f"  [alerts/jobs] 5-min warning: {name} x{runs} ({char_name})")

            # ── Completion ───────────────────────────────────────────────────
            if jstatus == "ready" and jid not in _warned_done:
                _warned_done.add(jid)
                msg = (
                    f"\u2705 <b>{act} complete!</b>\n"
                    f"{name}  \u00d7{runs}\n"
                    f"<i>{char_name}</i>  \u2022  Ready to deliver"
                )
                if _tg_send(msg):
                    status["alerts_sent"] += 1
                    status["last_alert_sent"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    print(f"  [alerts/jobs] Completed: {name} x{runs} ({char_name})")

    except Exception as e:
        status["last_error"] = str(e)
        print(f"  [alerts/jobs] Error: {e}")


# ─── Background loop ──────────────────────────────────────────────────────────

def start_alert_scanner(calc_cache: dict, calc_cache_ttl: int, warmup_event=None):
    """
    Start the background alert scanner threads.
    Call this once from server.py __main__ after the other threads are started.

    calc_cache     — pass server.py's _calc_cache dict directly (shared reference)
    calc_cache_ttl — pass server.py's CALC_CACHE_TTL constant
    warmup_event   — optional threading.Event; contract scan waits on it before
                     firing its first scan (avoids CPU burst while server is booting)
    """
    status["running"] = True

    _tg_send(
        f"<b>BP alert scanner started</b>\n"
        f"ROI &gt;= {CONFIG['ROI_THRESHOLD']}%  |  "
        f"Breakeven &lt;= {CONFIG['BREAKEVEN_MAX_RUNS']} runs  |  "
        f"Scan every {CONFIG['CONTRACT_SCAN_INTERVAL']//60} min"
    )

    def contract_loop():
        # Wait until the server prewarm is complete before the first scan.
        # This prevents a large burst of HTTP threads competing with startup.
        # Falls back to a 3-min sleep if no event was passed (e.g. direct invocation).
        if warmup_event is not None:
            warmup_event.wait(timeout=300)
        else:
            time.sleep(180)
        while True:
            print("  [alerts/contract] Running contract scan…")
            _run_contract_scan(calc_cache, calc_cache_ttl)
            status["last_contract_scan"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            time.sleep(CONFIG["CONTRACT_SCAN_INTERVAL"])

    def job_loop():
        # Short initial delay so ESI tokens are ready
        time.sleep(30)
        while True:
            _run_job_scan()
            status["last_job_scan"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            time.sleep(CONFIG["JOB_SCAN_INTERVAL"])

    threading.Thread(target=contract_loop, daemon=True, name="alert-contract").start()
    threading.Thread(target=job_loop,     daemon=True, name="alert-jobs").start()
    print("  [alerts] Background alert scanner started.")
    print(f"  [alerts] ROI threshold: {CONFIG['ROI_THRESHOLD']}%  |  "
          f"Breakeven max: {CONFIG['BREAKEVEN_MAX_RUNS']} runs  |  "
          f"Scan every {CONFIG['CONTRACT_SCAN_INTERVAL']//60} min")
    print(f"  [alerts] Job monitor: 5-min warning + completion notice  |  "
          f"Polling every {CONFIG['JOB_SCAN_INTERVAL']}s")
