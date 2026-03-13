"""
database.py - Simple SQLite storage for scan results
====================================================
Saves each scan's results (JSON) with a timestamp and exposes a small
history API for the --history feature.
"""
import sqlite3
import json
import time
from typing import List, Dict, Any

DB_PATH = "crest_history.db"


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
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
    conn.close()


def save_scan(results: List[Dict[str, Any]]) -> None:
    """Save a scan's results as JSON with current timestamp."""
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("INSERT INTO scans (ts, results) VALUES (?, ?)", (int(time.time()), json.dumps(results)))
    conn.commit()
    conn.close()


def get_history(days: int = 7) -> List[Dict[str, Any]]:
    """Return list of scans (as dicts) from the last `days` days, newest first."""
    init_db()
    cutoff = int(time.time()) - days * 86400
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT ts, results FROM scans WHERE ts >= ? ORDER BY ts DESC", (cutoff,))
    rows = cur.fetchall()
    scans = []
    for r in rows:
        scans.append({"ts": r["ts"], "results": json.loads(r["results"])})
    conn.close()
    return scans


def _ensure_wallet_table(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS wallet_snapshots (
            ts      INTEGER NOT NULL,
            balance REAL    NOT NULL
        )
    """)


def record_wallet_snapshot(balance: float) -> None:
    """Record current wallet balance. Skips if last snapshot was < 5 minutes ago."""
    init_db()
    conn = _get_conn()
    _ensure_wallet_table(conn)
    cur = conn.cursor()
    cur.execute("SELECT ts FROM wallet_snapshots ORDER BY ts DESC LIMIT 1")
    row = cur.fetchone()
    if not row or (int(time.time()) - row["ts"]) >= 300:
        cur.execute(
            "INSERT INTO wallet_snapshots (ts, balance) VALUES (?, ?)",
            (int(time.time()), balance)
        )
        cur.execute(
            "DELETE FROM wallet_snapshots WHERE ts NOT IN "
            "(SELECT ts FROM wallet_snapshots ORDER BY ts DESC LIMIT 500)"
        )
    conn.commit()
    conn.close()


def get_wallet_history(days: int = 30) -> List[Dict[str, Any]]:
    """Return wallet balance snapshots from last N days, oldest first."""
    init_db()
    conn = _get_conn()
    _ensure_wallet_table(conn)
    cutoff = int(time.time()) - days * 86400
    cur = conn.cursor()
    cur.execute(
        "SELECT ts, balance FROM wallet_snapshots WHERE ts >= ? ORDER BY ts ASC",
        (cutoff,)
    )
    rows = cur.fetchall()
    conn.close()
    return [{"ts": r["ts"], "balance": r["balance"]} for r in rows]


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
