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
import statistics
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

    # ROI alert: flag any blueprint where ROI >= this % (e.g. 50 = 50%)
    "ROI_THRESHOLD":           50.0,

    # Contract alert: flag a contract if its price <= this fraction of median (0.50 = 50% off)
    "CHEAP_THRESHOLD":         0.50,

    # How many hours before the same alert fires again (avoids spam)
    "ALERT_COOLDOWN_HOURS":    6,

    # Minimum net ISK profit for ROI alerts to fire
    "MIN_NET_PROFIT":          5_000_000,   # 5M ISK

    # Scan intervals (seconds)
    "ROI_SCAN_INTERVAL":       1800,   # 30 minutes
    "CONTRACT_SCAN_INTERVAL":  3600,   # 1 hour

    # Max ESI contract pages to scan (each page = 1000 contracts)
    "MAX_PAGES":               10,

    # ESI region to scan contracts in (10000002 = The Forge / Jita)
    "REGION_ID":               10000002,
}

# ─── State (in-memory) ────────────────────────────────────────────────────────
# Maps alert_key → last_alerted_timestamp
_alerted: dict[str, float] = {}
_alerted_lock = threading.Lock()

# Public status for the /api/alerts/status endpoint
status = {
    "running":            False,
    "last_roi_scan":      None,   # ISO timestamp string
    "last_contract_scan": None,
    "last_alert_sent":    None,
    "alerts_sent":        0,
    "roi_deals_found":    0,
    "contract_deals_found": 0,
    "last_error":         None,
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


# ─── ROI scan ─────────────────────────────────────────────────────────────────

def _run_roi_scan(calc_cache: dict, calc_cache_ttl: int):
    """
    Inspect the live calculator cache for high-ROI blueprints and alert.
    calc_cache is the server.py _calc_cache dict (passed by reference).
    """
    try:
        # Find the freshest cache entry
        now = time.time()
        fresh_entry = None
        for entry in calc_cache.values():
            gen = entry.get("generated_at", 0)
            if (now - gen) < calc_cache_ttl:
                if fresh_entry is None or gen > fresh_entry.get("generated_at", 0):
                    fresh_entry = entry

        if not fresh_entry:
            print("  [alerts/roi] No fresh calc data — skipping scan.")
            return

        results = fresh_entry.get("results", [])
        threshold = CONFIG["ROI_THRESHOLD"]
        min_profit = CONFIG["MIN_NET_PROFIT"]

        deals = [
            r for r in results
            if (r.get("roi") or 0) >= threshold
            and (r.get("net_profit") or 0) >= min_profit
        ]
        deals.sort(key=lambda x: x.get("roi", 0), reverse=True)

        status["roi_deals_found"] = len(deals)

        if not deals:
            print(f"  [alerts/roi] Scan complete. No blueprints above {threshold}% ROI.")
            return

        print(f"  [alerts/roi] {len(deals)} deal(s) above {threshold}% ROI found.")

        for deal in deals[:10]:   # cap at 10 alerts per scan cycle
            name    = deal.get("name", "?")
            roi     = deal.get("roi", 0)
            profit  = deal.get("net_profit", 0)
            iph     = deal.get("isk_per_hour")
            bpid    = deal.get("blueprint_id", "?")
            alert_key = f"roi|{bpid}"

            if not _should_alert(alert_key):
                continue

            iph_str = f"\n📈 ISK/hr: <b>{_fmt_isk(iph)} ISK/hr</b>" if iph else ""
            msg = (
                f"🟢 <b>High ROI Blueprint Alert</b>\n"
                f"━━━━━━━━━━━━━━━━━━━━\n"
                f"📦 <b>{name}</b>\n"
                f"💰 ROI: <b>{roi:.1f}%</b>\n"
                f"🪙 Net profit/run: <b>{_fmt_isk(profit)} ISK</b>"
                f"{iph_str}\n"
                f"━━━━━━━━━━━━━━━━━━━━\n"
                f"⚙️ Blueprint ID: {bpid}"
            )
            if _tg_send(msg):
                status["alerts_sent"] += 1
                status["last_alert_sent"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                print(f"  [alerts/roi] Alert sent: {name} ({roi:.1f}% ROI)")

    except Exception as e:
        status["last_error"] = str(e)
        print(f"  [alerts/roi] Error: {e}")


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
    Scan ESI public contracts for unusually cheap BPOs.
    A BPO is flagged if its contract price is <= CHEAP_THRESHOLD * median_price
    based on other listings found in the same scan.
    """
    try:
        from concurrent.futures import ThreadPoolExecutor, as_completed

        # ── Get wanted blueprint IDs from calc cache ──────────────────────────
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

        calc_results = fresh_entry.get("results", [])
        # Only alert on profitable blueprints (ROI > 0)
        bpid_to_calc = {
            r["blueprint_id"]: r
            for r in calc_results
            if r.get("blueprint_id") and (r.get("roi") or 0) > 0
        }
        wanted_bp_ids = set(bpid_to_calc.keys())

        if not wanted_bp_ids:
            print("  [alerts/contract] No profitable BP IDs to watch.")
            return

        region_id = CONFIG["REGION_ID"]
        max_pages = CONFIG["MAX_PAGES"]
        session   = requests.Session()

        # ── Fetch first page + total pages ────────────────────────────────────
        print(f"  [alerts/contract] Scanning ESI contracts (region {region_id})…")
        first_page, total_pages = _fetch_contract_page(session, region_id, 1)
        total_pages = min(total_pages, max_pages)

        all_contracts = [c for c in first_page if c.get("type") == "item_exchange"]

        # Fetch remaining pages concurrently
        if total_pages > 1:
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = {pool.submit(_fetch_contract_page, session, region_id, p): p
                           for p in range(2, total_pages + 1)}
                for fut in as_completed(futures):
                    page_data, _ = fut.result()
                    all_contracts.extend(
                        c for c in page_data if c.get("type") == "item_exchange"
                    )

        # Only look at tiny-volume contracts (BPs have volume ~0.01)
        candidates = [c for c in all_contracts if c.get("volume", 999) <= 1000]
        print(f"  [alerts/contract] {len(candidates)} candidate contracts from {total_pages} pages.")

        # ── Fetch items concurrently ───────────────────────────────────────────
        matched: list[dict] = []  # {contract, type_id, me, te, is_bpc}

        def check_contract(contract):
            items = _fetch_contract_items(session, contract["contract_id"])
            for item in items:
                tid = item.get("type_id")
                if tid in wanted_bp_ids and item.get("is_included", True):
                    return {
                        "contract": contract,
                        "type_id":  tid,
                        "me":       item.get("material_efficiency", 0),
                        "te":       item.get("time_efficiency", 0),
                        "is_bpc":   item.get("is_blueprint_copy", False),
                    }
            return None

        with ThreadPoolExecutor(max_workers=12) as pool:
            futures = [pool.submit(check_contract, c) for c in candidates]
            for fut in as_completed(futures):
                result = fut.result()
                if result:
                    matched.append(result)

        if not matched:
            print("  [alerts/contract] No matching BPOs found in contracts.")
            status["contract_deals_found"] = 0
            return

        # ── Group by blueprint_id to find median price ────────────────────────
        by_bpid: dict[int, list[float]] = {}
        for m in matched:
            bpid  = m["type_id"]
            price = m["contract"]["price"]
            if not m["is_bpc"]:   # BPOs only for median calculation
                by_bpid.setdefault(bpid, []).append(price)

        cheap_threshold = CONFIG["CHEAP_THRESHOLD"]
        deals_found = 0

        for bpid, prices_list in by_bpid.items():
            if len(prices_list) < 2:
                # Only one listing — can't determine "cheap" without a reference
                continue

            median_price = statistics.median(prices_list)
            calc_row     = bpid_to_calc.get(bpid, {})
            name         = calc_row.get("name", f"Type {bpid}")

            for price in prices_list:
                ratio = price / median_price if median_price > 0 else 1.0
                if ratio > cheap_threshold:
                    continue  # not cheap enough

                alert_key = f"contract|{bpid}|{int(price)}"
                if not _should_alert(alert_key):
                    continue

                deals_found += 1
                discount_pct = (1.0 - ratio) * 100
                roi          = calc_row.get("roi", 0)
                net_profit   = calc_row.get("net_profit", 0)

                msg = (
                    f"🔵 <b>Cheap BPO Contract Alert</b>\n"
                    f"━━━━━━━━━━━━━━━━━━━━\n"
                    f"📦 <b>{name}</b>\n"
                    f"💸 Contract price: <b>{_fmt_isk(price)} ISK</b>\n"
                    f"📊 Median market:  <b>{_fmt_isk(median_price)} ISK</b>\n"
                    f"🏷️ Discount: <b>{discount_pct:.0f}% off</b>\n"
                    f"💰 Blueprint ROI: <b>{roi:.1f}%</b>\n"
                    f"🪙 Mfg profit/run: <b>{_fmt_isk(net_profit)} ISK</b>\n"
                    f"━━━━━━━━━━━━━━━━━━━━\n"
                    f"🔎 Search Contracts in-game for: <i>{name}</i>"
                )
                if _tg_send(msg):
                    status["alerts_sent"] += 1
                    status["last_alert_sent"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    print(f"  [alerts/contract] Alert sent: {name} @ {_fmt_isk(price)} ISK ({discount_pct:.0f}% off median)")

        status["contract_deals_found"] = deals_found
        print(f"  [alerts/contract] Scan complete. {deals_found} deal alert(s) sent.")

    except Exception as e:
        status["last_error"] = str(e)
        print(f"  [alerts/contract] Error: {e}")


# ─── Background loop ──────────────────────────────────────────────────────────

def start_alert_scanner(calc_cache: dict, calc_cache_ttl: int):
    """
    Start the background alert scanner threads.
    Call this once from server.py __main__ after the other threads are started.

    calc_cache     — pass server.py's _calc_cache dict directly (shared reference)
    calc_cache_ttl — pass server.py's CALC_CACHE_TTL constant
    """
    status["running"] = True

    # Send a startup message so you know it's live
    _tg_send(
        "🚀 <b>CREST Alert Scanner started</b>\n"
        f"ROI threshold: {CONFIG['ROI_THRESHOLD']}%  |  "
        f"Cheap contract: ≤{int(CONFIG['CHEAP_THRESHOLD']*100)}% of median\n"
        f"ROI scan every {CONFIG['ROI_SCAN_INTERVAL']//60} min  |  "
        f"Contract scan every {CONFIG['CONTRACT_SCAN_INTERVAL']//60} min"
    )

    def roi_loop():
        # Stagger: wait 2 min before first run so prewarm calc cache has time to populate
        time.sleep(120)
        while True:
            print("  [alerts/roi] Running ROI scan…")
            _run_roi_scan(calc_cache, calc_cache_ttl)
            status["last_roi_scan"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            time.sleep(CONFIG["ROI_SCAN_INTERVAL"])

    def contract_loop():
        # Stagger: wait 3 min before first run
        time.sleep(180)
        while True:
            print("  [alerts/contract] Running contract scan…")
            _run_contract_scan(calc_cache, calc_cache_ttl)
            status["last_contract_scan"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            time.sleep(CONFIG["CONTRACT_SCAN_INTERVAL"])

    threading.Thread(target=roi_loop,      daemon=True, name="alert-roi").start()
    threading.Thread(target=contract_loop, daemon=True, name="alert-contract").start()
    print("  [alerts] Background alert scanner started.")
    print(f"  [alerts] ROI threshold: {CONFIG['ROI_THRESHOLD']}%  |  "
          f"Contract cheap threshold: ≤{int(CONFIG['CHEAP_THRESHOLD']*100)}% of median")
