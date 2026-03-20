"""
invention.py - T2 invention cost engine
=========================================
Calculates the expected ISK cost to invent a T2 BPC from a T1 BPO copy.

HOW INVENTION WORKS (simplified):
  1. You copy a T1 BPO → T1 BPC
  2. You run the invention job using datacores (+ optional decryptor)
  3. On success you get a T2 BPC with a fixed number of runs
  4. On failure you lose the datacores (and copy)
  5. Expected cost accounts for the success chance:
       cost_per_bpc = datacore_cost_per_attempt / success_chance

DECRYPTORS:
  Decryptors modify success_chance, runs per BPC, and ME/TE of the result.
  Only the success_chance modifier is currently modelled here.

DATACORES (EVE type IDs — from SDE via ref-data.everef.net):
  20419  Datacore - Graviton Physics
  20418  Datacore - Electronic Engineering
  20416  Datacore - Nanite Engineering
  20415  Datacore - Molecular Engineering
  20424  Datacore - Mechanical Engineering
  20411  Datacore - High Energy Physics
  20412  Datacore - Plasma Physics
  20414  Datacore - Quantum Physics
  20420  Datacore - Rocket Science
  20423  Datacore - Nuclear Physics
  20417  Datacore - Electromagnetic Physics

BASE SUCCESS CHANCES (from EVE SDE, manufacturing activity):
  Most T2 module/drone inventions: 0.34 (34%)
  T2 frigate/destroyer:            0.30 (30%)
"""

import os
import sqlite3
import threading
from pricer import get_prices_bulk

# ── DB-backed invention data (loaded lazily from crest.db) ───────────────────
# Cached in-process; cleared by setting to None (e.g. after re-seeding).
_DB_INVENTION: dict[str, dict] | None = None
_DB_INVENTION_LOCK = threading.Lock()
_CREST_DB = os.path.join(os.path.dirname(__file__), "crest.db")


def _load_invention_from_db() -> dict[str, dict]:
    """
    Load invention data from crest.db blueprint_invention table, keyed by
    output_name (same format as INVENTION_DATA so callers work with both).
    Returns an empty dict if crest.db is absent or the table doesn’t exist yet.
    """
    global _DB_INVENTION
    with _DB_INVENTION_LOCK:
        if _DB_INVENTION is not None:
            return _DB_INVENTION
        pool: dict[str, dict] = {}
        if os.path.exists(_CREST_DB):
            try:
                conn = sqlite3.connect(_CREST_DB)
                conn.row_factory = sqlite3.Row
                rows = conn.execute("""
                    SELECT bi.datacore_1_type_id, bi.datacore_1_qty,
                           bi.datacore_2_type_id, bi.datacore_2_qty,
                           bi.base_success_chance, bi.output_runs_per_bpc,
                           b.output_name
                    FROM   blueprint_invention bi
                    JOIN   blueprints b ON b.blueprint_id = bi.t2_blueprint_id
                """).fetchall()
                conn.close()
                for r in rows:
                    pool[r["output_name"]] = {
                        "datacore_1_type_id":  r["datacore_1_type_id"],
                        "datacore_1_qty":      r["datacore_1_qty"],
                        "datacore_2_type_id":  r["datacore_2_type_id"],
                        "datacore_2_qty":      r["datacore_2_qty"] or 0,
                        "base_success_chance": r["base_success_chance"],
                        "output_runs_per_bpc": r["output_runs_per_bpc"],
                    }
            except Exception as e:
                print(f"[invention] Could not load from crest.db: {e}")
        _DB_INVENTION = pool
        return pool


def invalidate_invention_cache() -> None:
    """Force a reload from crest.db on next call (call after re-seeding)."""
    global _DB_INVENTION
    with _DB_INVENTION_LOCK:
        _DB_INVENTION = None


# ── Invention data per T2 blueprint ──────────────────────────────────────────
# Key = product name (matches blueprint output_name / calculator result name)
# All success chances are base — before skills or decryptors.
#
# Standard T2 drone invention:
#   2× datacores × 8 qty each, 34% base chance, 10 runs per BPC
#
# Standard T2 module invention:
#   2× datacores × 8 qty each, 34% base chance, 10 runs per BPC
#
INVENTION_DATA: dict[str, dict] = {
    # ── Combat Drones ────────────────────────────────────────────────────────
    # Source: EVE SDE via ref-data.everef.net/blueprints/<T1_bp_id>
    "Hammerhead II": {
        "datacore_1_type_id": 20419,  # Datacore - Graviton Physics
        "datacore_1_qty":     2,
        "datacore_2_type_id": 20418,  # Datacore - Electronic Engineering
        "datacore_2_qty":     2,
        "base_success_chance": 0.34,
        "output_runs_per_bpc": 10,
    },
    "Hobgoblin II": {
        "datacore_1_type_id": 20419,  # Datacore - Graviton Physics
        "datacore_1_qty":     1,
        "datacore_2_type_id": 20418,  # Datacore - Electronic Engineering
        "datacore_2_qty":     1,
        "base_success_chance": 0.34,
        "output_runs_per_bpc": 10,
    },
    "Warrior II": {
        "datacore_1_type_id": 20419,  # Datacore - Graviton Physics
        "datacore_1_qty":     1,
        "datacore_2_type_id": 20418,  # Datacore - Electronic Engineering
        "datacore_2_qty":     1,
        "base_success_chance": 0.34,
        "output_runs_per_bpc": 10,
    },
    # ── Electronics Upgrades ─────────────────────────────────────────────────
    "Damage Control II": {
        "datacore_1_type_id": 20416,  # Datacore - Nanite Engineering
        "datacore_1_qty":     2,
        "datacore_2_type_id": 20415,  # Datacore - Molecular Engineering
        "datacore_2_qty":     2,
        "base_success_chance": 0.34,
        "output_runs_per_bpc": 10,
    },
}

# Decryptor success-chance multipliers (optional — only chance modifier modelled)
DECRYPTOR_MODIFIERS: dict[str, float] = {
    "accelerant":   1.20,
    "attainment":   1.80,
    "augmentation": 0.60,
    "parity":       1.50,
    "process":      1.10,
    "symmetry":     1.00,
}


def _all_datacore_type_ids() -> list[int]:
    """Return every datacore type ID from both the DB and the hardcoded fallback."""
    ids: set[int] = set()
    # DB-seeded data (covers all T2 blueprints after running seeder.py)
    for entry in _load_invention_from_db().values():
        ids.add(entry["datacore_1_type_id"])
        if entry.get("datacore_2_type_id"):
            ids.add(entry["datacore_2_type_id"])
    # Hardcoded fallback (used when crest.db has no invention table yet)
    for entry in INVENTION_DATA.values():
        ids.add(entry["datacore_1_type_id"])
        ids.add(entry["datacore_2_type_id"])
    return list(ids)


def calculate_invention_cost(
    blueprint_name: str,
    decryptor: str | None = None,
    prices: dict | None = None,
) -> dict | None:
    """
    Calculate the expected invention cost for one T2 BPC.

    Args:
        blueprint_name:  Product name as it appears in the calculator
                         (e.g. "Hammerhead II")
        decryptor:       Optional decryptor name (key in DECRYPTOR_MODIFIERS)
                         e.g. "parity", "attainment"
        prices:          Optional pre-fetched price dict from pricer.get_prices_bulk().
                         If None, prices are fetched live.

    Returns:
        {
            "cost_per_bpc":    float,  # expected ISK to get one successful BPC
            "cost_per_run":    float,  # cost_per_bpc / output_runs_per_bpc
            "success_chance":  float,  # effective success chance (after decryptor)
            "datacore_costs":  {       # breakdown of datacore prices
                "dc1_type_id": int,
                "dc1_qty":     int,
                "dc1_price":   float,
                "dc1_total":   float,
                "dc2_type_id": int,
                "dc2_qty":     int,
                "dc2_price":   float,
                "dc2_total":   float,
            },
            "output_runs_per_bpc": int,
        }
        Returns None if blueprint_name is not found in any source or prices missing.
    """
    # DB-seeded data takes precedence; fall back to hardcoded INVENTION_DATA.
    inv = _load_invention_from_db().get(blueprint_name) or INVENTION_DATA.get(blueprint_name)
    if inv is None:
        return None

    # Fetch prices if not provided
    if prices is None:
        dc_ids = [inv["datacore_1_type_id"], inv["datacore_2_type_id"]]
        prices = get_prices_bulk(dc_ids, history_ids=[])

    dc1_id  = inv["datacore_1_type_id"]
    dc2_id  = inv["datacore_2_type_id"]
    dc1_qty = inv["datacore_1_qty"]
    dc2_qty = inv["datacore_2_qty"]

    dc1_price_entry = prices.get(dc1_id)
    dc2_price_entry = prices.get(dc2_id)

    if dc1_price_entry is None or dc2_price_entry is None:
        return None

    # Use sell price (what you pay to buy datacores)
    dc1_unit = dc1_price_entry["sell"]
    dc2_unit = dc2_price_entry["sell"]

    dc1_total = dc1_unit * dc1_qty
    dc2_total = dc2_unit * dc2_qty

    cost_per_attempt = dc1_total + dc2_total

    # Apply decryptor modifier if given
    chance_modifier = 1.0
    if decryptor:
        chance_modifier = DECRYPTOR_MODIFIERS.get(decryptor.lower(), 1.0)

    success_chance = inv["base_success_chance"] * chance_modifier
    success_chance = min(success_chance, 1.0)   # cap at 100%

    # Expected number of attempts to get one successful BPC
    expected_attempts = 1.0 / success_chance

    cost_per_bpc  = cost_per_attempt * expected_attempts
    runs_per_bpc  = inv["output_runs_per_bpc"]
    cost_per_run  = cost_per_bpc / runs_per_bpc

    return {
        "cost_per_bpc":        cost_per_bpc,
        "cost_per_run":        cost_per_run,
        "success_chance":      success_chance,
        "output_runs_per_bpc": runs_per_bpc,
        "datacore_costs": {
            "dc1_type_id": dc1_id,
            "dc1_qty":     dc1_qty,
            "dc1_price":   dc1_unit,
            "dc1_total":   dc1_total,
            "dc2_type_id": dc2_id,
            "dc2_qty":     dc2_qty,
            "dc2_price":   dc2_unit,
            "dc2_total":   dc2_total,
        },
    }


def calculate_all_invention_costs(
    prices: dict | None = None,
) -> dict[str, dict]:
    """
    Calculate invention costs for every blueprint in INVENTION_DATA.

    Args:
        prices: Optional pre-fetched price dict. If None, fetches live.

    Returns:
        { blueprint_name: calculate_invention_cost(...) result | None }
    """
    if prices is None:
        dc_ids = _all_datacore_type_ids()
        prices = get_prices_bulk(dc_ids, history_ids=[])

    return {
        name: calculate_invention_cost(name, prices=prices)
        for name in INVENTION_DATA
    }
