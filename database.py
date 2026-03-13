"""
database.py - Simple SQLite storage for scan results
====================================================
Saves each scan's results (JSON) with a timestamp and exposes a small
history API for the --history feature.
"""
import sqlite3
import json
import time
import threading
from typing import List, Dict, Any

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
