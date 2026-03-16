"""
database.py - Simple SQLite storage for scan results and sell order history
===========================================================================
Saves each scan's results (JSON) with a timestamp and exposes a small
history API for the --history feature.

Also tracks open market orders and detects when they disappear (= sold),
recording the sale in sell_order_history for accurate ISK/hr calculations.
"""
import sqlite3
import json
import time
import threading
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

DB_PATH = "crest_history.db"

# Per-thread connection cache — avoids opening a new connection on every call
_local = threading.local()


def _get_conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        _local.conn = conn
    return conn


def init_db() -> None:
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS scans (
            id INTEGER PRIMARY KEY,
            ts INTEGER NOT NULL,
            results TEXT NOT NULL
        )
        """
    )
    # ── Open orders snapshot (one row per order_id, updated each poll) ────────
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS open_orders (
            order_id       INTEGER PRIMARY KEY,
            type_id        INTEGER NOT NULL,
            item_name      TEXT,
            character_id   INTEGER,
            quantity       INTEGER,
            price          REAL,
            issued         TEXT,
            first_seen_ts  INTEGER NOT NULL
        )
        """
    )
    # ── Sell order history (written when an open order disappears) ─────────────
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS sell_order_history (
            order_id      INTEGER PRIMARY KEY,
            type_id       INTEGER NOT NULL,
            item_name     TEXT,
            character_id  INTEGER,
            quantity      INTEGER,
            price         REAL,
            issued        TEXT,
            fulfilled     TEXT,
            days_to_sell  REAL,
            revenue       REAL
        )
        """
    )
    conn.commit()


def save_scan(results: List[Dict[str, Any]]) -> None:
    """Save a scan's results as JSON with current timestamp."""
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("INSERT INTO scans (ts, results) VALUES (?, ?)", (int(time.time()), json.dumps(results)))
    conn.commit()


def get_history(days: int = 7) -> List[Dict[str, Any]]:
    """Return list of scans (as dicts) from the last `days` days, newest first."""
    init_db()
    cutoff = int(time.time()) - days * 86400
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT ts, results FROM scans WHERE ts >= ? ORDER BY ts DESC", (cutoff,))
    rows = cur.fetchall()
    return [{"ts": r["ts"], "results": json.loads(r["results"])} for r in rows]


# ─── Open order tracking ──────────────────────────────────────────────────────

def _parse_iso(ts_str: str) -> float:
    """Parse an ISO 8601 timestamp string to a Unix timestamp (float)."""
    if not ts_str:
        return time.time()
    ts_str = ts_str.rstrip("Z")
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            dt = datetime.strptime(ts_str, fmt).replace(tzinfo=timezone.utc)
            return dt.timestamp()
        except ValueError:
            continue
    return time.time()


def sync_open_orders(current_orders: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Compare `current_orders` (fresh from ESI) against the stored open_orders table.

    - Orders present in the DB but absent from current = fulfilled (sold).
      These are written to sell_order_history and removed from open_orders.
    - Orders not yet in the DB are inserted into open_orders.

    Args:
        current_orders: List of enriched order dicts from /api/orders (sell side only).
                        Each must have: order_id, type_id, item_name, character_id,
                        quantity (volume_remain), price, issued.

    Returns:
        List of newly-recorded sell history dicts (one per fulfilled order).
    """
    init_db()
    conn = _get_conn()
    cur  = conn.cursor()
    now_ts   = int(time.time())
    now_iso  = datetime.fromtimestamp(now_ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

    # Build lookup of currently-live order IDs
    live_ids = {o["order_id"] for o in current_orders if o.get("order_id")}

    # ── 1. Detect fulfilled orders ────────────────────────────────────────────
    cur.execute("SELECT order_id, type_id, item_name, character_id, quantity, price, issued FROM open_orders")
    stored_rows = cur.fetchall()

    fulfilled = []
    for row in stored_rows:
        oid = row["order_id"]
        if oid in live_ids:
            continue  # still open

        issued_ts    = _parse_iso(row["issued"])
        days_to_sell = (now_ts - issued_ts) / 86400.0
        revenue      = (row["price"] or 0) * (row["quantity"] or 0)

        cur.execute(
            """
            INSERT OR REPLACE INTO sell_order_history
              (order_id, type_id, item_name, character_id, quantity,
               price, issued, fulfilled, days_to_sell, revenue)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (oid, row["type_id"], row["item_name"], row["character_id"],
             row["quantity"], row["price"], row["issued"],
             now_iso, round(days_to_sell, 4), round(revenue, 2))
        )
        cur.execute("DELETE FROM open_orders WHERE order_id = ?", (oid,))
        fulfilled.append({
            "order_id":    oid,
            "type_id":     row["type_id"],
            "item_name":   row["item_name"],
            "days_to_sell": round(days_to_sell, 4),
            "revenue":     round(revenue, 2),
            "fulfilled":   now_iso,
        })

    # ── 2. Upsert currently-live orders ───────────────────────────────────────
    for o in current_orders:
        oid = o.get("order_id")
        if not oid:
            continue
        cur.execute(
            """
            INSERT OR IGNORE INTO open_orders
              (order_id, type_id, item_name, character_id, quantity,
               price, issued, first_seen_ts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (oid, o.get("type_id"), o.get("item_name") or o.get("type_name"),
             o.get("character_id"), o.get("volume_remain") or o.get("quantity"),
             o.get("price"), o.get("issued"), now_ts)
        )

    conn.commit()
    return fulfilled


def get_sell_history_stats() -> Dict[str, Any]:
    """
    Return per-item and overall sell-time statistics from sell_order_history.

    Response shape:
    {
        "overall": { "avg_days_to_sell": float, "total_sales": int, "total_revenue": float },
        "by_item": {
            "<item_name>": {
                "type_id":          int,
                "avg_days_to_sell": float,
                "total_sold":       int,
                "total_revenue":    float,
                "fastest_sale":     float,
                "slowest_sale":     float,
            },
            ...
        }
    }
    """
    init_db()
    conn = _get_conn()
    cur  = conn.cursor()

    cur.execute(
        """
        SELECT
            type_id,
            item_name,
            COUNT(*)               AS total_sold,
            AVG(days_to_sell)      AS avg_days,
            SUM(revenue)           AS total_revenue,
            MIN(days_to_sell)      AS fastest_sale,
            MAX(days_to_sell)      AS slowest_sale
        FROM sell_order_history
        GROUP BY type_id
        ORDER BY total_sold DESC
        """
    )
    rows = cur.fetchall()

    by_item: Dict[str, Any] = {}
    for r in rows:
        key = r["item_name"] or f"Type {r['type_id']}"
        by_item[key] = {
            "type_id":          r["type_id"],
            "avg_days_to_sell": round(r["avg_days"], 4) if r["avg_days"] is not None else None,
            "total_sold":       r["total_sold"],
            "total_revenue":    round(r["total_revenue"] or 0, 2),
            "fastest_sale":     round(r["fastest_sale"], 4) if r["fastest_sale"] is not None else None,
            "slowest_sale":     round(r["slowest_sale"], 4) if r["slowest_sale"] is not None else None,
        }

    # Overall average across all recorded sales
    cur.execute("SELECT AVG(days_to_sell) AS avg_days, COUNT(*) AS n, SUM(revenue) AS rev FROM sell_order_history")
    overall_row = cur.fetchone()
    overall = {
        "avg_days_to_sell": round(overall_row["avg_days"], 4) if overall_row["avg_days"] else None,
        "total_sales":      overall_row["n"] or 0,
        "total_revenue":    round(overall_row["rev"] or 0, 2),
    }

    return {"overall": overall, "by_item": by_item}


def get_avg_days_to_sell_by_type() -> Dict[int, float]:
    """
    Return a mapping of { type_id: avg_days_to_sell } for all items in history.
    Used by calculator.py to improve ISK/hr estimates.
    """
    init_db()
    conn = _get_conn()
    cur  = conn.cursor()
    cur.execute(
        "SELECT type_id, AVG(days_to_sell) AS avg_days FROM sell_order_history GROUP BY type_id"
    )
    return {r["type_id"]: r["avg_days"] for r in cur.fetchall() if r["avg_days"] is not None}


def _ensure_wallet_table(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS wallet_snapshots (
            ts         INTEGER NOT NULL,
            balance    REAL    NOT NULL,
            plex_count INTEGER DEFAULT 0
        )
    """)
    # Migrate existing tables that lack plex_count
    try:
        conn.execute("ALTER TABLE wallet_snapshots ADD COLUMN plex_count INTEGER DEFAULT 0")
        conn.commit()
    except Exception:
        pass  # Column already exists


def record_wallet_snapshot(balance: float, min_interval: int = 300) -> None:
    """Record current wallet balance, skipping if the last snapshot is fresher than min_interval.

    min_interval defaults:
      300   (5 min)  — on-demand calls triggered by API requests
      7200  (2 h)    — background periodic thread (pass explicitly)
      0             — force-write regardless of recency
    """
    init_db()
    conn = _get_conn()
    _ensure_wallet_table(conn)
    cur = conn.cursor()
    cur.execute("SELECT ts FROM wallet_snapshots ORDER BY ts DESC LIMIT 1")
    row = cur.fetchone()
    now = int(time.time())
    if not row or (now - row["ts"]) >= min_interval:
        cur.execute(
            "INSERT INTO wallet_snapshots (ts, balance, plex_count) VALUES (?, ?, 0)",
            (now, balance)
        )
        cur.execute(
            "DELETE FROM wallet_snapshots WHERE ts NOT IN "
            "(SELECT ts FROM wallet_snapshots ORDER BY ts DESC LIMIT 500)"
        )
    conn.commit()


# Keep backward-compat alias used by the background wealth snapshot thread
def record_wealth_snapshot(balance: float) -> None:
    """Periodic 2-hour snapshot — thin alias for record_wallet_snapshot(min_interval=7200)."""
    record_wallet_snapshot(balance, min_interval=7200)


def get_wallet_history(days: int = 30) -> List[Dict[str, Any]]:
    """Return wallet balance snapshots from last N days, oldest first."""
    init_db()
    conn = _get_conn()
    _ensure_wallet_table(conn)
    cutoff = int(time.time()) - days * 86400
    cur = conn.cursor()
    cur.execute(
        "SELECT ts, balance, plex_count FROM wallet_snapshots WHERE ts >= ? ORDER BY ts ASC",
        (cutoff,)
    )
    rows = cur.fetchall()
    return [{"ts": r["ts"], "balance": r["balance"], "plex_count": r["plex_count"] or 0} for r in rows]


# ─── Craft log ───────────────────────────────────────────────────────────────

def _ensure_craft_log_table(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS craft_log (
            job_id          INTEGER PRIMARY KEY,
            char_id         INTEGER,
            char_name       TEXT,
            product_type_id INTEGER,
            product_name    TEXT,
            activity_id     INTEGER,
            activity        TEXT,
            runs            INTEGER,
            material_cost   REAL,
            sell_price      REAL,
            est_profit      REAL,
            margin_pct      REAL,
            completed_at    TEXT,
            recorded_at     INTEGER
        )
    """)
    conn.commit()


def upsert_craft_jobs(jobs: List[Dict[str, Any]]) -> int:
    """Insert-or-replace completed craft jobs. Returns number of new rows inserted."""
    conn = _get_conn()
    _ensure_craft_log_table(conn)
    cur = conn.cursor()
    inserted = 0
    for j in jobs:
        cur.execute(
            """
            INSERT OR REPLACE INTO craft_log
              (job_id, char_id, char_name, product_type_id, product_name,
               activity_id, activity, runs, material_cost, sell_price,
               est_profit, margin_pct, completed_at, recorded_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                j["job_id"], j.get("char_id"), j.get("char_name"),
                j.get("product_type_id"), j.get("product_name"),
                j.get("activity_id"), j.get("activity"),
                j.get("runs"), j.get("material_cost"), j.get("sell_price"),
                j.get("est_profit"), j.get("margin_pct"),
                j.get("completed_at"), int(time.time()),
            ),
        )
        if cur.rowcount:
            inserted += 1
    conn.commit()
    return inserted


def get_craft_log(days: int = 90) -> List[Dict[str, Any]]:
    conn = _get_conn()
    _ensure_craft_log_table(conn)
    cutoff = int(time.time()) - days * 86400
    rows = conn.execute(
        """
        SELECT * FROM craft_log
        WHERE recorded_at >= ?
        ORDER BY completed_at DESC
        """,
        (cutoff,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_craft_stats(days: int = 90) -> Dict[str, Any]:
    """Return per-item and overall craft profitability stats."""
    conn = _get_conn()
    _ensure_craft_log_table(conn)
    cutoff = int(time.time()) - days * 86400

    rows = conn.execute(
        """
        SELECT c.product_name, c.product_type_id, c.activity,
               SUM(c.runs)           AS total_runs,
               SUM(c.material_cost)  AS total_cost,
               SUM(c.sell_price * c.runs) AS est_revenue,
               SUM(c.est_profit)     AS est_profit,
               AVG(c.margin_pct)     AS avg_margin,
               COUNT(*)              AS job_count
        FROM craft_log c
        WHERE c.recorded_at >= ? AND c.material_cost IS NOT NULL
        GROUP BY c.product_type_id
        ORDER BY est_profit DESC
        """,
        (cutoff,),
    ).fetchall()

    items = [dict(r) for r in rows]

    # Join realized sales from sell_order_history (matched by type_id, no date filter —
    # an item manufactured 90 days ago may only have sold recently)
    try:
        type_ids = [r["product_type_id"] for r in items if r["product_type_id"]]
        if type_ids:
            ph = ",".join("?" * len(type_ids))
            realized = {
                row[0]: row[1]
                for row in conn.execute(
                    f"SELECT type_id, SUM(revenue) FROM sell_order_history WHERE type_id IN ({ph}) GROUP BY type_id",
                    type_ids,
                ).fetchall()
            }
            for item in items:
                item["realized_revenue"] = realized.get(item["product_type_id"])
                tc = item["total_cost"] or 0
                rr = item["realized_revenue"]
                item["realized_profit"] = round(rr - tc, 2) if rr is not None else None
    except Exception:
        for item in items:
            item["realized_revenue"] = None
            item["realized_profit"] = None

    totals = {
        "total_cost":        sum(r["total_cost"]    or 0 for r in items),
        "est_revenue":       sum(r["est_revenue"]   or 0 for r in items),
        "est_profit":        sum(r["est_profit"]    or 0 for r in items),
        "realized_revenue":  sum(r["realized_revenue"] or 0 for r in items if r["realized_revenue"] is not None),
        "realized_profit":   sum(r["realized_profit"]  or 0 for r in items if r["realized_profit"]  is not None),
        "total_runs":        sum(r["total_runs"]    or 0 for r in items),
        "job_count":         sum(r["job_count"]     or 0 for r in items),
    }
    return {"items": items, "totals": totals, "days": days}


# ─── SDE / crest.db seeding helper ───────────────────────────────────────────

def seed_from_sde(
    sde_path:   str = "sqlite-latest.sqlite",
    crest_path: str = "crest.db",
) -> tuple:
    """
    Thin wrapper that delegates to seeder.seed_from_sde() with custom paths.
    Kept here for backwards-compatibility so callers can do:
        from database import seed_from_sde; seed_from_sde()

    Returns (blueprint_count, material_row_count).
    Raises FileNotFoundError (via sys.exit in seeder.py) if SDE is absent.
    """
    import os, importlib, sys

    # Temporarily patch paths if non-default values supplied
    import seeder as _seeder
    original_sde   = _seeder.SDE_PATH
    original_crest = _seeder.CREST_PATH

    _seeder.SDE_PATH   = os.path.abspath(sde_path)
    _seeder.CREST_PATH = os.path.abspath(crest_path)
    try:
        result = _seeder.seed_from_sde()
    finally:
        _seeder.SDE_PATH   = original_sde
        _seeder.CREST_PATH = original_crest

    return result
