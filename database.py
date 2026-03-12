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
