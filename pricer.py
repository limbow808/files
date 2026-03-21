"""
pricer.py - Live market data from EVE ESI API
==============================================
Fetches the FULL Jita (The Forge) market order dump once, caches it
locally in SQLite, and answers price queries from that local cache.

WHY BULK INSTEAD OF PER-ITEM:
  The old approach called ESI once per item type. With 12 items that's
  12 API calls + 12 history calls = 24 round trips per scan. As you add
  more blueprints this gets slow and hammers ESI unnecessarily.

  The bulk approach pulls all ~500k orders for The Forge in one sweep
  (typically 5-10 pages), stores them in SQLite, and all price lookups
  are instant local queries. The dump refreshes every 5 minutes.

KEY PRICING RULE (never change this):
  SELL price = what YOU PAY for materials (use for inputs)
  BUY  price = what YOU RECEIVE when selling finished goods (use for outputs)
  Conservative in both directions = no nasty surprises.
"""

import asyncio
import sqlite3
import time
import os
import json as _json
from statistics import mean
import urllib.request as _urllib_req
import aiohttp

# ─── Config ───────────────────────────────────────────────────────────────────
REGION_THE_FORGE = 10000002   # Contains Jita 4-4
JITA_STATION_ID  = 60003760   # Jita 4-4 Caldari Navy Assembly Plant
ESI_BASE         = "https://esi.evetech.net/latest"

CACHE_DB         = os.path.join(os.path.dirname(__file__), "market_cache.db")
CACHE_TTL        = 600        # Refresh market dump every 10 minutes (was 5 — halves ESI + CPU load)
STARTUP_TTL      = 1800       # On the first call after a restart, reuse data up to 30 min old
HISTORY_TTL      = 21600      # Refresh volume history every 6 hours (was 1 hour — data doesn't change that fast)
REFERENCE_PRICE_TTL = 86400   # Refresh adjusted prices daily

# Set to True after the first successful _ensure_orders_fresh() call so subsequent
# requests use the shorter CACHE_TTL rather than the lenient STARTUP_TTL.
_startup_done: bool = False

# ── In-memory order store ──────────────────────────────────────────────────────
# { type_id: {'sell': float, 'buy': float} }
_ORDERS: dict = {}
_orders_fetched_at: float = 0.0
_REFERENCE_PRICES: dict = {}   # { type_id: {'adjusted_price': float|None, 'average_price': float|None} }
_reference_prices_fetched_at: float = 0.0


# ─── DB setup ─────────────────────────────────────────────────────────────────
def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(CACHE_DB)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db():
    conn = _get_conn()
    cur = conn.cursor()
    cur.executescript("""
        CREATE TABLE IF NOT EXISTS market_history (
            type_id          INTEGER PRIMARY KEY,
            avg_daily_volume REAL,
            fetched_at       INTEGER
        );

        CREATE TABLE IF NOT EXISTS market_reference_prices (
            type_id         INTEGER PRIMARY KEY,
            adjusted_price  REAL,
            average_price   REAL,
            fetched_at      INTEGER
        );
    """)
    conn.commit()
    conn.close()


_init_db()  # ensure SQLite history table exists at import time


# ─── Bulk order dump ──────────────────────────────────────────────────────────
def _orders_are_fresh(ttl: int = CACHE_TTL) -> bool:
    """Check if our in-memory order dict is still within `ttl` seconds."""
    return (time.time() - _orders_fetched_at) < ttl


def get_market_age() -> float:
    """Return seconds since the last market dump was fetched (or float('inf') if never)."""
    if _orders_fetched_at == 0.0:
        return float("inf")
    return time.time() - _orders_fetched_at


async def _fetch_all_orders_async():
    """
    Pull every order in The Forge from ESI using aiohttp (fully async).
    Filters to Jita station only and stores results in the _ORDERS in-memory dict.
    All pages are fetched concurrently — typically <2 seconds for ~40 pages.
    """
    global _ORDERS, _orders_fetched_at

    print("  Refreshing Jita market data from ESI...", end="", flush=True)
    url = f"{ESI_BASE}/markets/{REGION_THE_FORGE}/orders/"
    params = {"order_type": "all", "page": 1}

    timeout = aiohttp.ClientTimeout(total=20, connect=8)
    connector = aiohttp.TCPConnector(limit=20, ssl=True, enable_cleanup_closed=True)

    try:
        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            # Page 1 to discover total_pages
            async with session.get(url, params=params) as resp:
                if resp.status != 200:
                    print(f"\n  [!] ESI market fetch failed (status {resp.status})")
                    return
                total_pages = int(resp.headers.get("X-Pages", 1))
                page1_data = await resp.json(content_type=None)

            all_orders = [o for o in page1_data if o.get("location_id") == JITA_STATION_ID]
            print(f" {total_pages} pages", end="", flush=True)

            if total_pages > 1:
                async def _fetch_page(page_num):
                    try:
                        async with session.get(url, params={"order_type": "all", "page": page_num}) as r:
                            if r.status != 200:
                                return []
                            data = await r.json(content_type=None)
                            return [o for o in data if o.get("location_id") == JITA_STATION_ID]
                    except Exception:
                        return []

                pages = await asyncio.gather(*[_fetch_page(p) for p in range(2, total_pages + 1)])
                for page_orders in pages:
                    all_orders.extend(page_orders)

    except Exception as e:
        print(f"\n  [!] ESI market session error: {e}")
        return

    if not all_orders:
        print(" FAILED (no orders returned)")
        return

    # Build in-memory dict: type_id -> {sell: min_sell_price, buy: max_buy_price}
    sell_prices: dict = {}
    buy_prices: dict = {}
    for o in all_orders:
        tid = o["type_id"]
        price = o["price"]
        if o["is_buy_order"]:
            if tid not in buy_prices or price > buy_prices[tid]:
                buy_prices[tid] = price
        else:
            if tid not in sell_prices or price < sell_prices[tid]:
                sell_prices[tid] = price

    new_orders = {}
    for tid in set(sell_prices) | set(buy_prices):
        s = sell_prices.get(tid)
        b = buy_prices.get(tid)
        if s is not None and b is not None:
            new_orders[tid] = {"sell": s, "buy": b}

    _ORDERS = new_orders
    _orders_fetched_at = time.time()
    print(f" done ({len(all_orders):,} Jita orders, {len(_ORDERS):,} priced types)")


async def _ensure_orders_fresh_async():
    """Async: refresh order dump if stale. Called from the background refresh loop."""
    global _startup_done
    ttl = CACHE_TTL if _startup_done else STARTUP_TTL
    if (time.time() - _orders_fetched_at) >= ttl:
        await _fetch_all_orders_async()
    _startup_done = True


def _ensure_orders_fresh_sync():
    """Sync bridge: used by get_prices_bulk() which is called from sync calculator code.
    If orders are stale and there is a running event loop, schedules a refresh and
    waits for it.  Falls back to a new event loop when called outside of asyncio
    (e.g. during prewarm via asyncio.to_thread).
    """
    global _startup_done
    ttl = CACHE_TTL if _startup_done else STARTUP_TTL
    if (time.time() - _orders_fetched_at) < ttl:
        _startup_done = True
        return
    # Run the async fetch.  asyncio.to_thread wraps us in a thread that may
    # or may not have a running loop — create_task if loop running, else run.
    try:
        loop = asyncio.get_running_loop()
        # We're already in a thread (called via asyncio.to_thread from the prewarm).
        # Use run_coroutine_threadsafe to schedule on the running loop and block.
        import concurrent.futures as _cf
        fut = asyncio.run_coroutine_threadsafe(_fetch_all_orders_async(), loop)
        fut.result(timeout=120)
    except RuntimeError:
        # No running loop — we're in a plain thread (e.g. test or prewarm thread).
        asyncio.run(_fetch_all_orders_async())
    _startup_done = True


# ─── Price lookup ─────────────────────────────────────────────────────────────
def _get_price_from_db(type_id: int) -> dict | None:
    """Look up best buy/sell from the in-memory order dict."""
    return _ORDERS.get(type_id)


def _get_prices_bulk_from_db(type_ids: list) -> dict:
    """Look up best buy/sell for many type_ids from the in-memory order dict."""
    return {tid: _ORDERS[tid] for tid in type_ids if tid in _ORDERS}


def _reference_prices_are_fresh(ttl: int = REFERENCE_PRICE_TTL) -> bool:
    return (time.time() - _reference_prices_fetched_at) < ttl and bool(_REFERENCE_PRICES)


def _load_reference_prices_from_db() -> bool:
    global _REFERENCE_PRICES, _reference_prices_fetched_at
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT type_id, adjusted_price, average_price, fetched_at FROM market_reference_prices")
    rows = cur.fetchall()
    conn.close()
    if not rows:
        return False
    latest_ts = 0.0
    ref = {}
    for row in rows:
        ref[row["type_id"]] = {
            "adjusted_price": row["adjusted_price"],
            "average_price": row["average_price"],
        }
        latest_ts = max(latest_ts, float(row["fetched_at"] or 0))
    _REFERENCE_PRICES = ref
    _reference_prices_fetched_at = latest_ts
    return True


def _refresh_reference_prices_sync():
    """Fetch all ESI market reference prices (adjusted/average) and cache locally."""
    global _REFERENCE_PRICES, _reference_prices_fetched_at
    try:
        _url = f"{ESI_BASE}/markets/prices/"
        _req = _urllib_req.Request(_url, headers={'User-Agent': 'CREST-Dashboard/2.0'})
        with _urllib_req.urlopen(_req, timeout=20) as _r:
            data = _json.loads(_r.read())
        now = int(time.time())
        ref = {}
        rows = []
        for item in data or []:
            tid = item.get("type_id")
            if tid is None:
                continue
            adj = item.get("adjusted_price")
            avg = item.get("average_price")
            ref[int(tid)] = {
                "adjusted_price": adj,
                "average_price": avg,
            }
            rows.append((int(tid), adj, avg, now))

        if rows:
            conn = _get_conn()
            cur = conn.cursor()
            cur.execute("DELETE FROM market_reference_prices")
            cur.executemany(
                "INSERT OR REPLACE INTO market_reference_prices (type_id, adjusted_price, average_price, fetched_at) VALUES (?,?,?,?)",
                rows,
            )
            conn.commit()
            conn.close()
            _REFERENCE_PRICES = ref
            _reference_prices_fetched_at = float(now)
    except Exception:
        # Keep old cached data on failure
        pass


def _ensure_reference_prices_fresh_sync():
    if _reference_prices_are_fresh():
        return
    if not _REFERENCE_PRICES:
        _load_reference_prices_from_db()
    if not _reference_prices_are_fresh():
        _refresh_reference_prices_sync()


# ─── Volume history ───────────────────────────────────────────────────────────
def _get_avg_volume(type_id: int) -> float | None:
    """
    Get 7-day average daily volume from local cache,
    fetching from ESI if stale or missing.
    """
    conn = _get_conn()
    cur  = conn.cursor()
    cur.execute("SELECT avg_daily_volume, fetched_at FROM market_history WHERE type_id=?", (type_id,))
    row = cur.fetchone()
    conn.close()

    if row and (time.time() - row["fetched_at"]) < HISTORY_TTL:
        return row["avg_daily_volume"]

    # Fetch from ESI (sync urllib — keeps volume history simple, low-frequency)
    try:
        import json as _json
        _url = f"{ESI_BASE}/markets/{REGION_THE_FORGE}/history/?type_id={type_id}"
        _req = _urllib_req.Request(_url, headers={'User-Agent': 'CREST-Dashboard/2.0'})
        with _urllib_req.urlopen(_req, timeout=10) as _r:
            hist = _json.loads(_r.read())
        if hist and isinstance(hist, list):
            recent = sorted(hist, key=lambda x: x["date"], reverse=True)[:7]
            avg_vol = mean(int(d.get("volume", 0)) for d in recent)
        else:
            avg_vol = 0.0
    except Exception:
        avg_vol = None

    # Cache it
    conn = _get_conn()
    cur  = conn.cursor()
    cur.execute(
        "INSERT OR REPLACE INTO market_history (type_id, avg_daily_volume, fetched_at) VALUES (?,?,?)",
        (type_id, avg_vol, int(time.time()))
    )
    conn.commit()
    conn.close()

    return avg_vol


# ─── Public API ───────────────────────────────────────────────────────────────
def get_price(type_id: int) -> dict | None:
    """
    Get best Jita buy and sell price for one item.
    Uses local SQLite cache — call get_prices_bulk() first to ensure
    the cache is populated.

    Returns { 'sell': float, 'buy': float, 'avg_daily_volume': float,
              'adjusted_price': float|None, 'average_price': float|None } or None
    """
    _ensure_orders_fresh_sync()
    _ensure_reference_prices_fresh_sync()
    price = _get_price_from_db(type_id)
    if not price:
        return None
    price["avg_daily_volume"] = _get_avg_volume(type_id)
    ref = _REFERENCE_PRICES.get(type_id, {})
    price["adjusted_price"] = ref.get("adjusted_price")
    price["average_price"] = ref.get("average_price")
    return price


def get_prices_bulk(type_ids: list[int], history_ids: list[int] | None = None) -> dict:
    """
    Get prices for a list of type IDs.
    Ensures the market dump is fresh ONCE, then answers all queries locally.
    No per-item API calls for orders — all order lookups are SQLite queries.
    Volume history calls are parallelised across a thread pool.

    Args:
        type_ids:    All type IDs to fetch buy/sell prices for.
        history_ids: Subset to fetch avg_daily_volume for (defaults to all).
                     Pass only output item IDs to avoid fetching history for
                     thousands of raw materials.

    Returns { type_id: { 'sell', 'buy', 'avg_daily_volume', 'adjusted_price', 'average_price' } }
    """
    # One freshness check for the whole batch
    _ensure_orders_fresh_sync()
    _ensure_reference_prices_fresh_sync()

    # Bulk-query all prices in two SQL queries (instead of N × 2 per-item queries)
    results = _get_prices_bulk_from_db(list(type_ids))

    # Fetch volume history only for the requested subset (or all if not specified)
    ids_to_fetch = [tid for tid in (history_ids if history_ids is not None else list(results.keys())) if tid in results]

    for tid, row in results.items():
        ref = _REFERENCE_PRICES.get(tid, {})
        row["adjusted_price"] = ref.get("adjusted_price")
        row["average_price"] = ref.get("average_price")

    # Pre-load all cached volume history in one query to avoid N individual DB opens
    cached_vols: dict[int, float | None] = {}
    stale_ids: list[int] = []
    if ids_to_fetch:
        conn = _get_conn()
        cur  = conn.cursor()
        ph   = ",".join("?" * len(ids_to_fetch))
        cur.execute(
            f"SELECT type_id, avg_daily_volume, fetched_at FROM market_history WHERE type_id IN ({ph})",
            ids_to_fetch,
        )
        now = time.time()
        seen = set()
        for row in cur.fetchall():
            tid = row["type_id"]
            seen.add(tid)
            if (now - row["fetched_at"]) < HISTORY_TTL:
                cached_vols[tid] = row["avg_daily_volume"]
            else:
                stale_ids.append(tid)
        conn.close()
        # IDs not in the DB at all also need fetching
        stale_ids.extend(tid for tid in ids_to_fetch if tid not in seen)

    # Apply cached volumes immediately
    for tid, vol in cached_vols.items():
        if tid in results:
            results[tid]["avg_daily_volume"] = vol

    # Only hit ESI for stale/missing volume histories
    if stale_ids:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        with ThreadPoolExecutor(max_workers=10) as pool:
            futures = {pool.submit(_get_avg_volume, tid): tid for tid in stale_ids}
            for future in as_completed(futures):
                tid = futures[future]
                try:
                    results[tid]["avg_daily_volume"] = future.result()
                except Exception:
                    results[tid]["avg_daily_volume"] = None

    return results


async def orders_refresh_loop():
    """
    Background asyncio task — keeps the in-memory order dict fresh.
    Called once at app startup via asyncio.create_task().
    """
    while True:
        try:
            await _ensure_orders_fresh_async()
        except Exception as e:
            print(f"  [pricer] Order refresh error: {e}")
        await asyncio.sleep(CACHE_TTL)