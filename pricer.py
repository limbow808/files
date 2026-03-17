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

import requests
import sqlite3
import time
import os
from statistics import mean
from concurrent.futures import ThreadPoolExecutor, as_completed

# ─── Config ───────────────────────────────────────────────────────────────────
REGION_THE_FORGE = 10000002   # Contains Jita 4-4
JITA_STATION_ID  = 60003760   # Jita 4-4 Caldari Navy Assembly Plant
ESI_BASE         = "https://esi.evetech.net/latest"

CACHE_DB         = os.path.join(os.path.dirname(__file__), "market_cache.db")
CACHE_TTL        = 300        # Refresh market dump every 5 minutes (during normal operation)
STARTUP_TTL      = 1800       # On the first call after a restart, reuse data up to 30 min old
HISTORY_TTL      = 21600      # Refresh volume history every 6 hours (was 1 hour — data doesn't change that fast)

# Set to True after the first successful _ensure_orders_fresh() call so subsequent
# requests use the shorter CACHE_TTL rather than the lenient STARTUP_TTL.
_startup_done: bool = False

# ─── DB setup ─────────────────────────────────────────────────────────────────
def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(CACHE_DB)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db():
    conn = _get_conn()
    cur = conn.cursor()
    cur.executescript("""
        CREATE TABLE IF NOT EXISTS market_orders (
            type_id       INTEGER NOT NULL,
            is_buy_order  INTEGER NOT NULL,
            price         REAL    NOT NULL,
            volume        INTEGER NOT NULL,
            location_id   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_orders_type ON market_orders(type_id);

        CREATE TABLE IF NOT EXISTS market_meta (
            key   TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS market_history (
            type_id          INTEGER PRIMARY KEY,
            avg_daily_volume REAL,
            fetched_at       INTEGER
        );
    """)
    conn.commit()
    conn.close()


# ─── Bulk order dump ──────────────────────────────────────────────────────────
def _orders_are_fresh(ttl: int = CACHE_TTL) -> bool:
    """Check if our cached order dump is still within `ttl` seconds."""
    conn = _get_conn()
    cur  = conn.cursor()
    cur.execute("SELECT value FROM market_meta WHERE key='orders_fetched_at'")
    row = cur.fetchone()
    conn.close()
    if not row:
        return False
    return (time.time() - float(row["value"])) < ttl


def get_market_age() -> float:
    """Return seconds since the last market dump was fetched (or float('inf') if never)."""
    try:
        conn = _get_conn()
        cur  = conn.cursor()
        cur.execute("SELECT value FROM market_meta WHERE key='orders_fetched_at'")
        row = cur.fetchone()
        conn.close()
        if not row:
            return float("inf")
        return time.time() - float(row["value"])
    except Exception:
        return float("inf")


def _fetch_all_orders():
    """
    Pull every order in The Forge from ESI, filter to Jita station only,
    and store in SQLite. Replaces previous data entirely.
    Pages are fetched in parallel (20 workers) for ~20× speedup.
    """
    print("  Refreshing Jita market data from ESI...", end="", flush=True)
    url    = f"{ESI_BASE}/markets/{REGION_THE_FORGE}/orders/"

    # First request to discover total pages
    try:
        resp = requests.get(url, params={"order_type": "all", "page": 1}, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"\n  [!] ESI market fetch failed on page 1: {e}")
        return

    total_pages = int(resp.headers.get("X-Pages", 1))
    all_orders = [o for o in resp.json() if o["location_id"] == JITA_STATION_ID]
    print(f" {total_pages} pages", end="", flush=True)

    if total_pages > 1:
        def _fetch_page(page_num):
            try:
                r = requests.get(url, params={"order_type": "all", "page": page_num}, timeout=15)
                r.raise_for_status()
                return [o for o in r.json() if o["location_id"] == JITA_STATION_ID]
            except Exception:
                return []

        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(_fetch_page, p): p for p in range(2, total_pages + 1)}
            done = 0
            for f in as_completed(futures):
                all_orders.extend(f.result())
                done += 1
                if done % 50 == 0:
                    print(".", end="", flush=True)

    if not all_orders:
        print(" FAILED (no orders returned)")
        return

    # Write to DB — replace all existing orders
    conn = _get_conn()
    cur  = conn.cursor()
    cur.execute("DELETE FROM market_orders")
    cur.executemany(
        "INSERT INTO market_orders (type_id, is_buy_order, price, volume, location_id) VALUES (?,?,?,?,?)",
        [(o["type_id"], int(o["is_buy_order"]), o["price"], o["volume_remain"], o["location_id"])
         for o in all_orders]
    )
    cur.execute(
        "INSERT OR REPLACE INTO market_meta (key, value) VALUES ('orders_fetched_at', ?)",
        (str(time.time()),)
    )
    conn.commit()
    conn.close()
    print(f" done ({len(all_orders):,} Jita orders cached)")


def _ensure_orders_fresh():
    """Refresh the order dump if it's stale or missing.

    Uses STARTUP_TTL (30 min) on the very first call after a server restart so that
    a short-lived process restart does not immediately hammer ESI again.  After that
    first call, falls back to CACHE_TTL (5 min) for live-data accuracy.
    """
    global _startup_done
    _init_db()
    ttl = CACHE_TTL if _startup_done else STARTUP_TTL
    if not _orders_are_fresh(ttl):
        _fetch_all_orders()
    _startup_done = True


# ─── Price lookup ─────────────────────────────────────────────────────────────
def _get_price_from_db(type_id: int) -> dict | None:
    """Query best buy/sell from the local order cache."""
    conn = _get_conn()
    cur  = conn.cursor()

    cur.execute(
        "SELECT MIN(price) as best_sell FROM market_orders WHERE type_id=? AND is_buy_order=0",
        (type_id,)
    )
    sell_row = cur.fetchone()

    cur.execute(
        "SELECT MAX(price) as best_buy FROM market_orders WHERE type_id=? AND is_buy_order=1",
        (type_id,)
    )
    buy_row = cur.fetchone()
    conn.close()

    best_sell = sell_row["best_sell"] if sell_row else None
    best_buy  = buy_row["best_buy"]   if buy_row  else None

    if best_sell is None or best_buy is None:
        return None

    return {"sell": best_sell, "buy": best_buy}


def _get_prices_bulk_from_db(type_ids: list[int]) -> dict[int, dict]:
    """Query best buy/sell for many type_ids in one connection, two queries."""
    if not type_ids:
        return {}
    conn = _get_conn()
    cur  = conn.cursor()
    ph   = ",".join("?" * len(type_ids))

    cur.execute(
        f"SELECT type_id, MIN(price) as best_sell FROM market_orders "
        f"WHERE type_id IN ({ph}) AND is_buy_order=0 GROUP BY type_id",
        type_ids,
    )
    sells = {r["type_id"]: r["best_sell"] for r in cur.fetchall()}

    cur.execute(
        f"SELECT type_id, MAX(price) as best_buy FROM market_orders "
        f"WHERE type_id IN ({ph}) AND is_buy_order=1 GROUP BY type_id",
        type_ids,
    )
    buys = {r["type_id"]: r["best_buy"] for r in cur.fetchall()}
    conn.close()

    results = {}
    for tid in type_ids:
        s = sells.get(tid)
        b = buys.get(tid)
        if s is not None and b is not None:
            results[tid] = {"sell": s, "buy": b}
    return results


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

    # Fetch from ESI
    try:
        resp = requests.get(
            f"{ESI_BASE}/markets/{REGION_THE_FORGE}/history/",
            params={"type_id": type_id},
            timeout=10
        )
        resp.raise_for_status()
        hist = resp.json()
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

    Returns { 'sell': float, 'buy': float, 'avg_daily_volume': float } or None
    """
    _ensure_orders_fresh()
    price = _get_price_from_db(type_id)
    if not price:
        return None
    price["avg_daily_volume"] = _get_avg_volume(type_id)
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

    Returns { type_id: { 'sell', 'buy', 'avg_daily_volume' } }
    """
    # One freshness check for the whole batch
    _ensure_orders_fresh()

    # Bulk-query all prices in two SQL queries (instead of N × 2 per-item queries)
    results = _get_prices_bulk_from_db(list(type_ids))

    # Fetch volume history only for the requested subset (or all if not specified)
    ids_to_fetch = [tid for tid in (history_ids if history_ids is not None else list(results.keys())) if tid in results]

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
        with ThreadPoolExecutor(max_workers=10) as pool:
            futures = {pool.submit(_get_avg_volume, tid): tid for tid in stale_ids}
            for future in as_completed(futures):
                tid = futures[future]
                try:
                    results[tid]["avg_daily_volume"] = future.result()
                except Exception:
                    results[tid]["avg_daily_volume"] = None

    return results