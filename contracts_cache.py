"""
contracts_cache.py - Persistent local cache for ESI public contract data
=========================================================================
A background thread (started in server.py) continuously fills this DB so
that blueprint contract scans are instant local SQL queries rather than
blocking live ESI requests.

Schema:
    contracts       — one row per item_exchange contract (header only)
    contract_items  — all items inside each fetched contract.
                      type_id = 0 is a sentinel: "fetched successfully,
                      but contained nothing of interest."
"""

import sqlite3
import os
import threading
import time
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(__file__), "contracts_cache.db")

_local      = threading.local()
_write_lock = threading.Lock()   # serialise all writes to avoid WAL conflicts


# ─── Connection ───────────────────────────────────────────────────────────────

def _get_conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=10000")
        _local.conn = conn
    return conn


# ─── Schema ───────────────────────────────────────────────────────────────────

def init_db() -> None:
    conn = _get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS contracts (
            contract_id   INTEGER PRIMARY KEY,
            region_id     INTEGER NOT NULL,
            title         TEXT    NOT NULL DEFAULT '',
            price         REAL    NOT NULL DEFAULT 0,
            volume        REAL    NOT NULL DEFAULT 0,
            date_issued   TEXT    NOT NULL DEFAULT '',
            date_expired  TEXT    NOT NULL DEFAULT '',
            status        TEXT    NOT NULL DEFAULT 'outstanding',
            inserted_at   REAL    NOT NULL DEFAULT 0
        );

        -- One row per item inside a fetched contract.
        -- type_id = 0 sentinel means "fetched OK but held nothing relevant".
        CREATE TABLE IF NOT EXISTS contract_items (
            contract_id         INTEGER NOT NULL,
            type_id             INTEGER NOT NULL,
            is_blueprint_copy   INTEGER NOT NULL DEFAULT 0,
            material_efficiency INTEGER NOT NULL DEFAULT 0,
            time_efficiency     INTEGER NOT NULL DEFAULT 0,
            quantity            INTEGER NOT NULL DEFAULT 1,
            runs                INTEGER NOT NULL DEFAULT -1,
            fetched_at          REAL    NOT NULL,
            PRIMARY KEY (contract_id, type_id)
        );

        CREATE INDEX IF NOT EXISTS idx_ci_type   ON contract_items(type_id);
        CREATE INDEX IF NOT EXISTS idx_c_region  ON contracts(region_id);
        CREATE INDEX IF NOT EXISTS idx_c_expired ON contracts(date_expired);
        CREATE INDEX IF NOT EXISTS idx_c_status  ON contracts(status);
    """)
    conn.commit()


# ─── Writes ───────────────────────────────────────────────────────────────────

def upsert_contracts(region_id: int, contracts: list) -> int:
    """
    Bulk-insert contract header rows (INSERT OR IGNORE — once a contract is
    stored its header never changes).
    Returns the count of newly-inserted rows.
    """
    now = time.time()
    rows = [
        (
            c["contract_id"],
            region_id,
            (c.get("title") or "").strip(),
            c.get("price", 0) or 0,
            c.get("volume", 0) or 0,
            c.get("date_issued",  "") or "",
            c.get("date_expired", "") or "",
            c.get("status", "outstanding"),
            now,
        )
        for c in contracts
        if c.get("type") == "item_exchange"
        and c.get("status", "outstanding") == "outstanding"
        and c.get("contract_id")
    ]
    if not rows:
        return 0
    with _write_lock:
        conn = _get_conn()
        cur = conn.executemany(
            """
            INSERT OR IGNORE INTO contracts
                (contract_id, region_id, title, price, volume,
                 date_issued, date_expired, status, inserted_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            """,
            rows,
        )
        conn.commit()
        return cur.rowcount


def store_items(contract_id: int, items: list, fetched_at: float) -> None:
    """
    Persist the item list for one contract.
    An empty `items` list writes a type_id=0 sentinel so we never re-fetch.
    Only items with is_included=True are stored; items already filtered to
    type_ids that matter are stored as-is.
    """
    with _write_lock:
        conn = _get_conn()
        if not items:
            conn.execute(
                "INSERT OR REPLACE INTO contract_items "
                "(contract_id, type_id, fetched_at) VALUES (?, 0, ?)",
                (contract_id, fetched_at),
            )
        else:
            conn.executemany(
                """
                INSERT OR REPLACE INTO contract_items
                    (contract_id, type_id, is_blueprint_copy,
                     material_efficiency, time_efficiency,
                     quantity, runs, fetched_at)
                VALUES (?,?,?,?,?,?,?,?)
                """,
                [
                    (
                        contract_id,
                        item.get("type_id", 0),
                        1 if item.get("is_blueprint_copy") else 0,
                        item.get("material_efficiency", 0),
                        item.get("time_efficiency", 0),
                        item.get("quantity", 1),
                        item.get("runs", -1),
                        fetched_at,
                    )
                    for item in items
                    if item.get("is_included", True) and item.get("type_id")
                ],
            )
        conn.commit()


# ─── Queries ──────────────────────────────────────────────────────────────────

def get_ids_needing_items(region_id: int, limit: int = 10_000) -> list[int]:
    """
    Return contract_ids that have no row in contract_items yet — contents not
    fetched.  Filters:
      • still outstanding and not expired
      • price ≥ 1 M ISK  (real BPs never cost less; eliminates most junk)
    """
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT c.contract_id
        FROM   contracts c
        LEFT JOIN contract_items ci ON ci.contract_id = c.contract_id
        WHERE  ci.contract_id IS NULL
          AND  c.region_id    = ?
          AND  c.date_expired > ?
          AND  c.status       = 'outstanding'
          AND  c.price        >= 1000000
        ORDER  BY c.volume ASC
        LIMIT  ?
        """,
        (region_id, now_iso, limit),
    ).fetchall()
    return [r[0] for r in rows]


def query_bp_contracts(
    wanted_bp_ids: set[int],
    region_id: int = 10_000_002,
    bpo_only: bool = False,
) -> list[dict]:
    """
    Instant local SQL scan: return all outstanding contracts that contain at
    least one blueprint type_id from `wanted_bp_ids`.

    Returns a list of flat dicts — one row per (contract × matching type_id).
    """
    if not wanted_bp_ids:
        return []
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ph = ",".join("?" * len(wanted_bp_ids))
    bpc_clause = "AND ci.is_blueprint_copy = 0" if bpo_only else ""
    conn = _get_conn()
    rows = conn.execute(
        f"""
        SELECT
            c.contract_id, c.title, c.price, c.volume,
            c.date_issued, c.date_expired,
            ci.type_id, ci.is_blueprint_copy,
            ci.material_efficiency, ci.time_efficiency,
            ci.quantity, ci.runs
        FROM   contract_items ci
        JOIN   contracts c ON c.contract_id = ci.contract_id
        WHERE  ci.type_id    IN ({ph})
          AND  ci.type_id    > 0
          {bpc_clause}
          AND  c.region_id   = ?
          AND  c.status      = 'outstanding'
          AND  c.date_expired > ?
        ORDER  BY c.price ASC
        """,
        list(wanted_bp_ids) + [region_id, now_iso],
    ).fetchall()
    return [dict(r) for r in rows]


def purge_expired(region_id: int | None = None) -> int:
    """Delete contracts (and their items) whose expiry date has passed."""
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    region_clause = "AND region_id = ?" if region_id is not None else ""
    params: list = [now_iso] + ([region_id] if region_id is not None else [])
    conn = _get_conn()
    with _write_lock:
        expired_ids = [
            r[0] for r in conn.execute(
                f"SELECT contract_id FROM contracts "
                f"WHERE date_expired <= ? {region_clause}",
                params,
            ).fetchall()
        ]
        if not expired_ids:
            return 0
        ph = ",".join("?" * len(expired_ids))
        conn.execute(f"DELETE FROM contract_items WHERE contract_id IN ({ph})", expired_ids)
        conn.execute(f"DELETE FROM contracts      WHERE contract_id IN ({ph})", expired_ids)
        conn.commit()
    return len(expired_ids)


def get_stats(region_id: int = 10_000_002) -> dict:
    """Summary dict used by /api/contracts/status and warmup checks."""
    conn = _get_conn()
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    total = conn.execute(
        "SELECT COUNT(*) FROM contracts WHERE region_id = ?", (region_id,)
    ).fetchone()[0]
    outstanding = conn.execute(
        "SELECT COUNT(*) FROM contracts "
        "WHERE region_id=? AND status='outstanding' AND date_expired > ?",
        (region_id, now_iso),
    ).fetchone()[0]
    fetched = conn.execute(
        "SELECT COUNT(DISTINCT ci.contract_id) "
        "FROM contract_items ci "
        "JOIN contracts c ON c.contract_id = ci.contract_id "
        "WHERE c.region_id = ?",
        (region_id,),
    ).fetchone()[0]
    bp_found = conn.execute(
        "SELECT COUNT(DISTINCT ci.contract_id) "
        "FROM contract_items ci "
        "JOIN contracts c ON c.contract_id = ci.contract_id "
        "WHERE c.region_id = ? AND ci.type_id > 0",
        (region_id,),
    ).fetchone()[0]
    pending = max(0, outstanding - fetched)
    return {
        "total_contracts":    total,
        "outstanding":        outstanding,
        "items_fetched":      fetched,
        "items_pending":      pending,
        "bp_contracts_found": bp_found,
        "ready":              fetched > 0 and pending == 0,
        "warming_up":         fetched == 0,
    }
