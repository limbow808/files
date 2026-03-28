"""
blueprints.py - Blueprint library with SDE-backed dynamic loading
=================================================================
`load_blueprints()` reads from crest.db (seeded by seeder.py).
Falls back to the hardcoded BLUEPRINTS list if crest.db is absent
so development still works without the full SDE.

Run `python seeder.py` once after downloading sqlite-latest.sqlite
to populate crest.db with all EVE manufacturables.
"""

import sqlite3
import os
import threading

# ─── Mineral Type IDs (these never change) ───────────────────────────────────
MINERALS = {
    "Tritanium":   34,
    "Pyerite":     35,
    "Mexallon":    36,
    "Isogen":      37,
    "Nocxium":     38,
    "Zydrine":     39,
    "Megacyte":    40,
    "Morphite":    11399,
}

CREST_DB = os.path.join(os.path.dirname(__file__), "crest.db")
_BLUEPRINT_LOOKUP_CACHE: dict | None = None
_BLUEPRINT_LOOKUP_LOCK = threading.Lock()


# ─── Categories excluded from profit calculations ─────────────────────────────
# These categories contain SDE entries that technically have blueprints but
# are NOT player-obtainable BPOs (legacy POS structures, event/gift ships, etc.)
EXCLUDED_CATEGORIES = {
    "Starbase",             # Legacy POS Control Towers — removed from EVE years ago
    "Special Edition Assets",  # Gift/event ships (Praxis, Gnosis, etc.) — not craftable
    "Asteroid",             # Ore compression blueprints
    "Orbitals",             # PI-only planetary structures
}

# ─── Item groups excluded from profit calculations ────────────────────────────
# More granular than category — groups within otherwise valid categories that
# represent faction/pirate items only available as loot drops (not BPO/BPC).
EXCLUDED_ITEM_GROUPS = {
    "Control Tower",              # Legacy POS towers
    "Control Tower Medium",
    "Control Tower Small",
    "POS Module",
    "Sovereignty Blockade Unit",
    "Infrastructure Hub",
    "Station Improvement Platform",
    "Station Modification Platform",
}


def load_blueprints(
    category:   "str | list | None" = None,
    tech_level: "int | list | None" = None,
    size_class: "str | list | None" = None,
    limit:      "int | None"        = None,
) -> list:
    """
    Load blueprints from crest.db with optional AND-combined filters.

    Args:
        category:   e.g. "Drones" or ["Drones","Ships"] — matches invCategories.categoryName
        tech_level: e.g. 2 or [1, 2]
        size_class: e.g. "S" or ["S","M"]
        limit:      cap result count (useful for development)

    Returns:
        List of blueprint dicts compatible with calculator.calculate_profit():
        {
            name, output_id, output_qty, me_level, te_level,
            category, item_group, tech_level, size_class, slot_type,
            volume,
            materials: [ {type_id, quantity} ]
        }

    Falls back to hardcoded BLUEPRINTS if crest.db is missing.
    """
    if not os.path.exists(CREST_DB):
        # Graceful degradation — SDE not seeded yet
        print("[blueprints] crest.db not found — using hardcoded fallback list.")
        print("[blueprints] Run `python seeder.py` to seed the full blueprint database.")
        return _apply_filters(BLUEPRINTS, category, tech_level, size_class, limit)

    conn = sqlite3.connect(CREST_DB)
    conn.row_factory = sqlite3.Row

    # ── Build WHERE clause ────────────────────────────────────────────────────
    conditions: list[str] = []
    params:     list      = []

    def _add_filter(column: str, value):
        if value is None:
            return
        if isinstance(value, (list, tuple)):
            placeholders = ",".join("?" * len(value))
            conditions.append(f"{column} IN ({placeholders})")
            params.extend(value)
        else:
            conditions.append(f"{column} = ?")
            params.append(value)

    _add_filter("b.category",   category)
    _add_filter("b.tech_level", tech_level)
    _add_filter("b.size_class", size_class)

    # Always exclude known non-craftable categories and item groups
    excl_cats = list(EXCLUDED_CATEGORIES)
    excl_groups = list(EXCLUDED_ITEM_GROUPS)
    conditions.append(f"b.category NOT IN ({','.join('?' * len(excl_cats))})")
    params.extend(excl_cats)
    conditions.append(f"b.item_group NOT IN ({','.join('?' * len(excl_groups))})")
    params.extend(excl_groups)

    where_sql = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    limit_sql = f"LIMIT {int(limit)}" if limit else ""

    bp_sql = f"""
        SELECT
            b.blueprint_id, b.output_id, b.output_name, b.output_qty,
            b.category, b.item_group, b.tech_level, b.volume_m3,
            b.size_class, b.slot_type, b.me_level, b.te_level,
            b.time_seconds
        FROM blueprints b
        {where_sql}
        ORDER BY b.output_name
        {limit_sql}
    """
    cur = conn.cursor()
    cur.execute(bp_sql, params)
    bp_rows = cur.fetchall()

    if not bp_rows:
        conn.close()
        return []

    # ── Load all materials for this result set in one query ───────────────────
    bp_ids = [r["blueprint_id"] for r in bp_rows]
    placeholders = ",".join("?" * len(bp_ids))
    mat_sql = f"""
        SELECT blueprint_id, material_type_id AS type_id, material_name AS name, base_quantity AS quantity
        FROM   blueprint_materials
        WHERE  blueprint_id IN ({placeholders})
    """
    cur.execute(mat_sql, bp_ids)
    mat_rows = cur.fetchall()

    # Load skills for this result set
    skill_sql = f"""
        SELECT blueprint_id, skill_name, skill_level
        FROM   blueprint_skills
        WHERE  blueprint_id IN ({placeholders})
        ORDER  BY sort_order
    """
    try:
        cur.execute(skill_sql, bp_ids)
        skill_rows = cur.fetchall()
    except Exception:
        skill_rows = []  # table may not exist yet — run seeder to populate

    conn.close()

    # Group materials by blueprint_id
    mats_by_bp: dict[int, list] = {}
    for m in mat_rows:
        entry = {"type_id": m["type_id"], "quantity": m["quantity"], "name": m["name"]}
        mats_by_bp.setdefault(m["blueprint_id"], []).append(entry)

    # Group skills by blueprint_id
    skills_by_bp: dict[int, list] = {}
    for s in skill_rows:
        entry = {"name": s["skill_name"], "level": s["skill_level"]}
        skills_by_bp.setdefault(s["blueprint_id"], []).append(entry)

    # ── Assemble result dicts ─────────────────────────────────────────────────
    results = []
    for row in bp_rows:
        bp_id = row["blueprint_id"]
        results.append({
            "name":         row["output_name"],
            "blueprint_id": bp_id,
            "output_id":    row["output_id"],
            "output_qty":   row["output_qty"],
            "me_level":     row["me_level"],
            "te_level":     row["te_level"],
            "category":     row["category"],
            "item_group":   row["item_group"],
            "tech_level":   row["tech_level"],
            "tech":         f"{'II' if row['tech_level'] == 2 else 'III' if row['tech_level'] == 3 else 'I'}",
            "size":         row["size_class"],
            "size_class":   row["size_class"],
            "slot_type":    row["slot_type"],
            "volume":       row["volume_m3"],
            "time_seconds": row["time_seconds"] or 0,
            "materials":        mats_by_bp.get(bp_id, []),
            "required_skills":  skills_by_bp.get(bp_id, []),
        })

    return results


def _apply_filters(blueprints: list, category, tech_level, size_class, limit) -> list:
    """Apply filters to the hardcoded fallback list."""
    def _matches(val, filt):
        if filt is None:
            return True
        if isinstance(filt, (list, tuple)):
            return val in filt
        return val == filt

    out = [
        bp for bp in blueprints
        if _matches(bp.get("category"), category)
        and _matches(bp.get("tech_level", 1 if bp.get("tech") != "II" else 2), tech_level)
        and _matches(bp.get("size_class", bp.get("size", "U")), size_class)
    ]
    return out[:limit] if limit else out


def load_blueprint_lookup(force_refresh: bool = False) -> dict:
    """
    Return cached blueprint lookup tables for planner-side dependency resolution.

    Keys:
      - blueprints: raw blueprint list from load_blueprints()
      - by_output_id: output type_id -> blueprint dict
      - by_blueprint_id: blueprint_id -> blueprint dict
      - by_material_type_id: material type_id -> list[blueprint dict]
    """
    global _BLUEPRINT_LOOKUP_CACHE

    with _BLUEPRINT_LOOKUP_LOCK:
        if _BLUEPRINT_LOOKUP_CACHE is not None and not force_refresh:
            return _BLUEPRINT_LOOKUP_CACHE

        blueprints = list(load_blueprints())
        by_output_id: dict[int, dict] = {}
        by_blueprint_id: dict[int, dict] = {}
        by_material_type_id: dict[int, list[dict]] = {}

        for blueprint in blueprints:
            output_id = int(blueprint.get("output_id") or 0)
            blueprint_id = int(blueprint.get("blueprint_id") or 0)
            if output_id > 0 and output_id not in by_output_id:
                by_output_id[output_id] = blueprint
            if blueprint_id > 0:
                by_blueprint_id[blueprint_id] = blueprint
            for material in blueprint.get("materials") or []:
                material_type_id = int(material.get("type_id") or 0)
                if material_type_id <= 0:
                    continue
                by_material_type_id.setdefault(material_type_id, []).append(blueprint)

        for material_type_id in list(by_material_type_id.keys()):
            by_material_type_id[material_type_id] = sorted(
                by_material_type_id[material_type_id],
                key=lambda blueprint: (
                    int(blueprint.get("tech_level") or 1),
                    str(blueprint.get("name") or ""),
                    int(blueprint.get("blueprint_id") or 0),
                ),
            )

        _BLUEPRINT_LOOKUP_CACHE = {
            "blueprints": blueprints,
            "by_output_id": by_output_id,
            "by_blueprint_id": by_blueprint_id,
            "by_material_type_id": by_material_type_id,
        }
        return _BLUEPRINT_LOOKUP_CACHE


# ─────────────────────────────────────────────────────────────────────────────
# HARDCODED FALLBACK BLUEPRINTS
# Used when crest.db has not been seeded yet.
# Run `python seeder.py` to replace this with the full SDE dataset.
# ─────────────────────────────────────────────────────────────────────────────
# ─── Your Blueprint Library ───────────────────────────────────────────────────
# START SMALL: these are 5 starter items to prove the system works.
# Verify each profit number manually in-game, then expand this list.

BLUEPRINTS = [
    {
        "name": "Hammerhead II",
        "output_id": 2185,
        "output_qty": 1,
        "me_level": 0,      # UPDATE THIS to your actual ME level
        "te_level": 0,
        "category": "Drones",
        "tech": "II",
        "size": "M",
        "bp_type": "BPO",
        "duration": 7200,    # 2h base manufacturing time (seconds)
        "volume": 5,         # m3 per unit
        "required_skills": [
            {"name": "Drone Interfacing", "level": 5},
            {"name": "Medium Drone Operation", "level": 5},
            {"name": "Gallente Drone Specialization", "level": 1},
        ],
        "materials": [
            {"type_id": MINERALS["Tritanium"], "quantity": 26667},
            {"type_id": MINERALS["Pyerite"],   "quantity": 6667},
            {"type_id": MINERALS["Mexallon"],  "quantity": 1667},
            {"type_id": MINERALS["Isogen"],    "quantity": 333},
            {"type_id": MINERALS["Nocxium"],   "quantity": 83},
            {"type_id": MINERALS["Zydrine"],   "quantity": 17},
            {"type_id": MINERALS["Megacyte"],  "quantity": 4},
        ]
    },
    {
        "name": "Hobgoblin II",
        "output_id": 2456,
        "output_qty": 1,
        "me_level": 0,
        "te_level": 0,
        "category": "Drones",
        "tech": "II",
        "size": "S",
        "bp_type": "BPO",
        "duration": 3600,
        "volume": 2.5,
        "required_skills": [
            {"name": "Drone Interfacing", "level": 5},
            {"name": "Light Drone Operation", "level": 5},
            {"name": "Gallente Drone Specialization", "level": 1},
        ],
        "materials": [
            {"type_id": MINERALS["Tritanium"], "quantity": 14000},
            {"type_id": MINERALS["Pyerite"],   "quantity": 3500},
            {"type_id": MINERALS["Mexallon"],  "quantity": 875},
            {"type_id": MINERALS["Isogen"],    "quantity": 175},
            {"type_id": MINERALS["Nocxium"],   "quantity": 44},
            {"type_id": MINERALS["Zydrine"],   "quantity": 9},
            {"type_id": MINERALS["Megacyte"],  "quantity": 2},
        ]
    },
    {
        "name": "Warrior II",
        "output_id": 2488,
        "output_qty": 1,
        "me_level": 0,
        "te_level": 0,
        "category": "Drones",
        "tech": "II",
        "size": "S",
        "bp_type": "BPO",
        "duration": 3600,
        "volume": 2.5,
        "required_skills": [
            {"name": "Drone Interfacing", "level": 5},
            {"name": "Light Drone Operation", "level": 5},
            {"name": "Minmatar Drone Specialization", "level": 1},
        ],
        "materials": [
            {"type_id": MINERALS["Tritanium"], "quantity": 14000},
            {"type_id": MINERALS["Pyerite"],   "quantity": 3500},
            {"type_id": MINERALS["Mexallon"],  "quantity": 875},
            {"type_id": MINERALS["Isogen"],    "quantity": 175},
            {"type_id": MINERALS["Nocxium"],   "quantity": 44},
            {"type_id": MINERALS["Zydrine"],   "quantity": 9},
            {"type_id": MINERALS["Megacyte"],  "quantity": 2},
        ]
    },
    {
        "name": "Damage Control II",
        "output_id": 2048,
        "output_qty": 1,
        "me_level": 0,
        "te_level": 0,
        "category": "Modules",
        "tech": "II",
        "size": "U",
        "bp_type": "BPO",
        "duration": 5400,
        "volume": 5,
        "required_skills": [
            {"name": "Hull Upgrades", "level": 4},
            {"name": "Mechanics", "level": 5},
        ],
        "materials": [
            {"type_id": MINERALS["Tritanium"], "quantity": 21334},
            {"type_id": MINERALS["Pyerite"],   "quantity": 5334},
            {"type_id": MINERALS["Mexallon"],  "quantity": 1334},
            {"type_id": MINERALS["Isogen"],    "quantity": 267},
            {"type_id": MINERALS["Nocxium"],   "quantity": 67},
            {"type_id": MINERALS["Zydrine"],   "quantity": 13},
            {"type_id": MINERALS["Megacyte"],  "quantity": 3},
        ]
    },
    {
        "name": "Hobgoblin I",
        "output_id": 2454,
        "output_qty": 10,
        "me_level": 0,
        "te_level": 0,
        "category": "Drones",
        "tech": "I",
        "size": "S",
        "bp_type": "BPO",
        "duration": 1200,
        "volume": 2.5,
        "required_skills": [
            {"name": "Light Drone Operation", "level": 1},
        ],
        "materials": [
            {"type_id": MINERALS["Tritanium"], "quantity": 10400},
            {"type_id": MINERALS["Pyerite"],   "quantity": 2600},
            {"type_id": MINERALS["Mexallon"],  "quantity": 650},
        ]
    },
]
