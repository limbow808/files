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

SUCCESS CHANCE:
  success_chance = base_chance
                * (1 + (science_skill_1 + science_skill_2) / 30
                    + encryption_skill / 40)
                * decryptor_probability_multiplier

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

import json
import os
import sqlite3
import threading

import requests
from pricer import get_prices_bulk

# ── DB-backed invention data (loaded lazily from crest.db) ───────────────────
# Cached in-process; cleared by setting to None (e.g. after re-seeding).
_DB_INVENTION: dict[str, dict] | None = None
_DB_INVENTION_LOCK = threading.Lock()
_CREST_DB = os.path.join(os.path.dirname(__file__), "crest.db")
_SDE_DB = os.path.join(os.path.dirname(__file__), "sqlite-latest.sqlite")
_SKILL_NAMES_PATH = os.path.join(os.path.dirname(__file__), "skill_names.json")

_TYPE_NAMES: dict[int, str] | None = None
_TYPE_NAMES_LOCK = threading.Lock()

_INVENTION_SKILL_REQUIREMENTS: dict[str, dict] | None = None
_INVENTION_SKILL_REQUIREMENTS_LOCK = threading.Lock()

_CHARACTER_SKILL_CACHE = {"profiles": [], "aggregated": {}, "ts": 0.0}
_CHARACTER_SKILL_CACHE_TTL = 300.0
_CHARACTER_SKILL_CACHE_LOCK = threading.Lock()


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
                    SELECT bi.t2_blueprint_id, bi.t1_blueprint_id,
                           bi.datacore_1_type_id, bi.datacore_1_qty,
                           bi.datacore_2_type_id, bi.datacore_2_qty,
                           bi.base_success_chance, bi.output_runs_per_bpc,
                           b.output_name
                    FROM   blueprint_invention bi
                    JOIN   blueprints b ON b.blueprint_id = bi.t2_blueprint_id
                """).fetchall()
                conn.close()
                for r in rows:
                    pool[r["output_name"]] = {
                        "t2_blueprint_id":     r["t2_blueprint_id"],
                        "t1_blueprint_id":     r["t1_blueprint_id"],
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


def _load_type_names() -> dict[int, str]:
    global _TYPE_NAMES
    with _TYPE_NAMES_LOCK:
        if _TYPE_NAMES is not None:
            return _TYPE_NAMES
        try:
            with open(_SKILL_NAMES_PATH, encoding="utf-8") as fh:
                raw = json.load(fh)
            _TYPE_NAMES = {int(key): value for key, value in raw.items()}
        except Exception:
            _TYPE_NAMES = {}
        return _TYPE_NAMES


def _science_skill_name_for_datacore(type_id: int | None) -> str | None:
    if not type_id:
        return None
    type_name = _load_type_names().get(int(type_id))
    if not type_name or not type_name.startswith("Datacore - "):
        return None
    skill_name = type_name.replace("Datacore - ", "", 1)
    skill_name = skill_name.replace("Gallentean ", "Gallente ")
    skill_name = skill_name.replace("Amarrian ", "Amarr ")
    skill_name = skill_name.replace("Caldarian ", "Caldari ")
    return skill_name


def _load_invention_skill_requirements() -> dict[str, dict]:
    global _INVENTION_SKILL_REQUIREMENTS
    with _INVENTION_SKILL_REQUIREMENTS_LOCK:
        if _INVENTION_SKILL_REQUIREMENTS is not None:
            return _INVENTION_SKILL_REQUIREMENTS

        requirements: dict[str, dict] = {}
        if not os.path.exists(_SDE_DB):
            _INVENTION_SKILL_REQUIREMENTS = requirements
            return requirements

        db_invention = _load_invention_from_db()
        if not db_invention:
            _INVENTION_SKILL_REQUIREMENTS = requirements
            return requirements

        try:
            sde = sqlite3.connect(f"file:{_SDE_DB}?mode=ro", uri=True)
            sde.row_factory = sqlite3.Row
            type_names = {
                row["typeID"]: row["typeName"]
                for row in sde.execute("SELECT typeID, typeName FROM invTypes")
            }
            t1_blueprint_ids = sorted({
                int(entry.get("t1_blueprint_id") or 0)
                for entry in db_invention.values()
                if int(entry.get("t1_blueprint_id") or 0)
            })
            if t1_blueprint_ids:
                placeholders = ",".join("?" for _ in t1_blueprint_ids)
                skill_rows = sde.execute(
                    f"SELECT typeID, skillID, level FROM industryActivitySkills WHERE activityID = 8 AND typeID IN ({placeholders}) ORDER BY typeID, skillID",
                    t1_blueprint_ids,
                ).fetchall()
            else:
                skill_rows = []
            sde.close()

            skills_by_t1: dict[int, list[dict]] = {}
            for row in skill_rows:
                skills_by_t1.setdefault(int(row["typeID"]), []).append({
                    "name": type_names.get(int(row["skillID"]), f"Skill {row['skillID']}"),
                    "level": int(row["level"] or 0),
                })

            for blueprint_name, entry in db_invention.items():
                invention_skills = skills_by_t1.get(int(entry.get("t1_blueprint_id") or 0), [])
                encryption_skill_name = next(
                    (skill["name"] for skill in invention_skills if skill["name"].endswith("Encryption Methods")),
                    None,
                )
                requirements[blueprint_name] = {
                    "encryption_skill_name": encryption_skill_name,
                    "invention_skills": invention_skills,
                }
        except Exception:
            requirements = {}

        _INVENTION_SKILL_REQUIREMENTS = requirements
        return requirements


def _get_character_skill_profiles() -> list[dict]:
    with _CHARACTER_SKILL_CACHE_LOCK:
        import time as _time

        if (_time.time() - float(_CHARACTER_SKILL_CACHE.get("ts") or 0.0)) < _CHARACTER_SKILL_CACHE_TTL:
            return [dict(profile) for profile in (_CHARACTER_SKILL_CACHE.get("profiles") or [])]

        try:
            from characters import get_all_auth_headers, load_characters

            characters = load_characters()
            type_names = _load_type_names()
            profiles: list[dict] = []
            aggregated: dict[str, int] = {}

            for character_id, headers in get_all_auth_headers():
                response = requests.get(
                    f"https://esi.evetech.net/latest/characters/{character_id}/skills/",
                    headers=headers,
                    timeout=10,
                )
                response.raise_for_status()
                skill_levels = {
                    type_names.get(int(skill.get("skill_id") or 0), f"Skill {skill.get('skill_id')}"): int(skill.get("active_skill_level") or 0)
                    for skill in response.json().get("skills", [])
                    if type_names.get(int(skill.get("skill_id") or 0))
                }
                for skill_name, level in skill_levels.items():
                    aggregated[skill_name] = max(int(aggregated.get(skill_name, 0) or 0), int(level or 0))
                profiles.append({
                    "character_id": str(character_id),
                    "character_name": characters.get(str(character_id), {}).get("character_name", f"Char {character_id}"),
                    "skills": skill_levels,
                })

            _CHARACTER_SKILL_CACHE.update({"profiles": profiles, "aggregated": aggregated, "ts": _time.time()})
            return [dict(profile) for profile in profiles]
        except Exception:
            return [dict(profile) for profile in (_CHARACTER_SKILL_CACHE.get("profiles") or [])]


def _get_aggregated_character_skill_levels() -> dict[str, int]:
    profiles = _get_character_skill_profiles()
    aggregated: dict[str, int] = {}
    for profile in profiles:
        for skill_name, level in (profile.get("skills") or {}).items():
            aggregated[skill_name] = max(int(aggregated.get(skill_name, 0) or 0), int(level or 0))
    return aggregated


def _select_invention_character_profile(
    invention_skills: list[dict],
    science_skill_1_name: str | None,
    science_skill_2_name: str | None,
    encryption_skill_name: str | None,
) -> tuple[dict[str, int], dict | None, bool, list[dict], list[dict]]:
    profiles = _get_character_skill_profiles()
    required_skills = [
        {
            "name": str(skill.get("name") or ""),
            "level": int(skill.get("level") or 0),
        }
        for skill in (invention_skills or [])
        if skill.get("name")
    ]

    def _missing_for_profile(profile: dict) -> list[dict]:
        skill_levels = profile.get("skills") or {}
        missing = []
        for required in required_skills:
            actual = int(skill_levels.get(required["name"], 0) or 0)
            if actual < required["level"]:
                missing.append({
                    "name": required["name"],
                    "required_level": required["level"],
                    "actual_level": actual,
                })
        return missing

    if not profiles:
        aggregated = _get_aggregated_character_skill_levels()
        missing = []
        for required in required_skills:
            actual = int(aggregated.get(required["name"], 0) or 0)
            if actual < required["level"]:
                missing.append({
                    "name": required["name"],
                    "required_level": required["level"],
                    "actual_level": actual,
                })
            return aggregated, None, len(missing) == 0, missing, []

    eligible_profiles = []
    for profile in profiles:
        missing = _missing_for_profile(profile)
        if not missing:
            eligible_profiles.append(profile)

    relevant_names = [name for name in (science_skill_1_name, science_skill_2_name, encryption_skill_name) if name]

    def _profile_score(profile: dict) -> tuple[int, int]:
        skill_levels = profile.get("skills") or {}
        relevant_total = sum(int(skill_levels.get(name, 0) or 0) for name in relevant_names)
        required_total = sum(int(skill_levels.get(required["name"], 0) or 0) for required in required_skills)
        return relevant_total, required_total

    if eligible_profiles:
        best_profile = max(eligible_profiles, key=_profile_score)
        return dict(best_profile.get("skills") or {}), dict(best_profile), True, [], [dict(profile) for profile in eligible_profiles]

    best_profile = max(profiles, key=_profile_score)
    return dict(best_profile.get("skills") or {}), dict(best_profile), False, _missing_for_profile(best_profile), []


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
    skill_levels: dict[str, int] | None = None,
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
            "success_chance":  float,  # effective success chance (after skills + decryptor)
            "base_success_chance": float,
            "skill_formula":  { ... },
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

    science_skill_1_name = _science_skill_name_for_datacore(dc1_id)
    science_skill_2_name = _science_skill_name_for_datacore(dc2_id)
    skill_requirements = _load_invention_skill_requirements().get(blueprint_name) or {}
    encryption_skill_name = skill_requirements.get("encryption_skill_name")

    invention_skills = skill_requirements.get("invention_skills") or []
    selected_profile = None
    can_start_invention = True
    missing_required_skills: list[dict] = []
    eligible_profiles: list[dict] = []

    if skill_levels is None:
        skill_levels, selected_profile, can_start_invention, missing_required_skills, eligible_profiles = _select_invention_character_profile(
            invention_skills,
            science_skill_1_name,
            science_skill_2_name,
            encryption_skill_name,
        )

    science_skill_1_level = int((skill_levels or {}).get(science_skill_1_name, 0) or 0) if science_skill_1_name else 0
    science_skill_2_level = int((skill_levels or {}).get(science_skill_2_name, 0) or 0) if science_skill_2_name else 0
    encryption_skill_level = int((skill_levels or {}).get(encryption_skill_name, 0) or 0) if encryption_skill_name else 0

    # Apply decryptor modifier if given
    decryptor_multiplier = 1.0
    if decryptor:
        decryptor_multiplier = DECRYPTOR_MODIFIERS.get(decryptor.lower(), 1.0)

    skill_multiplier = 1.0 + ((science_skill_1_level + science_skill_2_level) / 30.0) + (encryption_skill_level / 40.0)
    success_chance = inv["base_success_chance"] * skill_multiplier * decryptor_multiplier
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
        "base_success_chance": inv["base_success_chance"],
        "output_runs_per_bpc": runs_per_bpc,
        "skill_formula": {
            "science_skill_1_name": science_skill_1_name,
            "science_skill_1_level": science_skill_1_level,
            "science_skill_2_name": science_skill_2_name,
            "science_skill_2_level": science_skill_2_level,
            "encryption_skill_name": encryption_skill_name,
            "encryption_skill_level": encryption_skill_level,
            "skill_multiplier": skill_multiplier,
            "decryptor_multiplier": decryptor_multiplier,
        },
        "required_skills": invention_skills,
        "can_start_invention": can_start_invention,
        "missing_required_skills": missing_required_skills,
        "selected_character_id": selected_profile.get("character_id") if selected_profile else None,
        "selected_character_name": selected_profile.get("character_name") if selected_profile else None,
        "eligible_character_ids": [str(profile.get("character_id")) for profile in eligible_profiles if profile.get("character_id")],
        "eligible_characters": [
            {
                "character_id": str(profile.get("character_id")),
                "character_name": profile.get("character_name"),
            }
            for profile in eligible_profiles
            if profile.get("character_id")
        ],
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
