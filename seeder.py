"""
seeder.py - Seed crest.db from the EVE Static Data Export (SDE)
================================================================
Reads ./sqlite-latest.sqlite (Fuzzwork SDE) and writes all
manufacturable blueprints + their materials into ./crest.db.

Usage:
    python seeder.py

Re-running is safe — uses INSERT OR REPLACE throughout.

SDE tables used:
    industryActivityProducts  — blueprint_type_id → output type_id + qty
    industryActivityMaterials — blueprint_type_id → required materials
    invTypes                  — type names, volumes, group membership
    invGroups                 — group → category mapping
    invCategories             — category names
    dgmTypeAttributes         — tech level, size class, slot type per type
"""

import sqlite3
import os
import sys
import json

# ─── Paths ────────────────────────────────────────────────────────────────────
SDE_PATH   = os.path.join(os.path.dirname(__file__), "sqlite-latest.sqlite")
CREST_PATH = os.path.join(os.path.dirname(__file__), "crest.db")

# ─── dgmTypeAttributes attribute IDs we care about ───────────────────────────
ATTR_TECH_LEVEL  = 422   # tech level (1 = T1, 2 = T2, 3 = T3)
ATTR_SIZE        = 128   # rig/module size: 1=S 2=M 3=L 4=XL
ATTR_SLOT_HIGH   = 331   # high slot
ATTR_SLOT_MID    = 332   # mid slot
ATTR_SLOT_LOW    = 333   # low slot
ATTR_SLOT_RIG    = 1178  # rig slot

SIZE_MAP = {1: "S", 2: "M", 3: "L", 4: "XL"}


def _connect_sde() -> sqlite3.Connection:
    """Open SDE in read-only mode."""
    if not os.path.exists(SDE_PATH):
        print(f"\n  ERROR: SDE file not found at {SDE_PATH}")
        print("  Download it from https://www.fuzzwork.co.uk/dump/sqlite-latest.sqlite.bz2")
        print("  Decompress and place it as sqlite-latest.sqlite in this folder.\n")
        sys.exit(1)
    uri = f"file:{SDE_PATH}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _connect_crest() -> sqlite3.Connection:
    """Open (or create) crest.db read-write."""
    conn = sqlite3.connect(CREST_PATH)
    conn.row_factory = sqlite3.Row
    # Enable WAL for safer concurrent access with the server
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _init_crest(conn: sqlite3.Connection) -> None:
    """Create schema in crest.db if it doesn't already exist."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS blueprints (
            blueprint_id  INTEGER PRIMARY KEY,
            output_id     INTEGER NOT NULL,
            output_name   TEXT    NOT NULL,
            output_qty    INTEGER NOT NULL DEFAULT 1,
            category      TEXT    NOT NULL DEFAULT 'Other',
            item_group    TEXT    NOT NULL DEFAULT '',
            tech_level    INTEGER NOT NULL DEFAULT 1,
            volume_m3     REAL    NOT NULL DEFAULT 0.01,
            size_class    TEXT    NOT NULL DEFAULT 'U',
            slot_type     TEXT,
            me_level      INTEGER NOT NULL DEFAULT 0,
            te_level      INTEGER NOT NULL DEFAULT 0,
            time_seconds  INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS blueprint_materials (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            blueprint_id      INTEGER NOT NULL REFERENCES blueprints(blueprint_id),
            material_type_id  INTEGER NOT NULL,
            material_name     TEXT    NOT NULL,
            base_quantity     INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS blueprint_skills (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            blueprint_id INTEGER NOT NULL REFERENCES blueprints(blueprint_id),
            skill_name   TEXT    NOT NULL,
            skill_level  INTEGER NOT NULL,
            sort_order   INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_bp_output    ON blueprints(output_id);
        CREATE INDEX IF NOT EXISTS idx_bp_category  ON blueprints(category);
        CREATE INDEX IF NOT EXISTS idx_bp_tech      ON blueprints(tech_level);
        CREATE INDEX IF NOT EXISTS idx_bp_size      ON blueprints(size_class);
        CREATE INDEX IF NOT EXISTS idx_mat_bp       ON blueprint_materials(blueprint_id);
        CREATE INDEX IF NOT EXISTS idx_skill_bp     ON blueprint_skills(blueprint_id);
    """)
    conn.commit()


def _load_attributes(sde: sqlite3.Connection) -> tuple[dict, dict, dict]:
    """
    Bulk-load the three dgmTypeAttributes lookups we need.
    Returns:
        tech_map  : { type_id: tech_level_int }
        size_map  : { type_id: size_letter }
        slot_map  : { type_id: slot_name_str }
    """
    print("  Loading dgmTypeAttributes...", end="", flush=True)

    tech_map: dict[int, int]  = {}
    size_map: dict[int, str]  = {}
    slot_map: dict[int, str]  = {}

    cur = sde.cursor()
    cur.execute("""
        SELECT typeID, attributeID, valueInt, valueFloat
        FROM   dgmTypeAttributes
        WHERE  attributeID IN (?, ?, ?, ?, ?, ?)
    """, (ATTR_TECH_LEVEL, ATTR_SIZE,
          ATTR_SLOT_HIGH, ATTR_SLOT_MID, ATTR_SLOT_LOW, ATTR_SLOT_RIG))

    for row in cur.fetchall():
        tid  = row["typeID"]
        attr = row["attributeID"]
        val  = int(row["valueInt"] or row["valueFloat"] or 0)

        if attr == ATTR_TECH_LEVEL:
            tech_map[tid] = val
        elif attr == ATTR_SIZE:
            size_map[tid] = SIZE_MAP.get(val, "U")
        elif attr == ATTR_SLOT_HIGH and val:
            slot_map[tid] = "High"
        elif attr == ATTR_SLOT_MID and val:
            slot_map.setdefault(tid, "Mid")
        elif attr == ATTR_SLOT_LOW and val:
            slot_map.setdefault(tid, "Low")
        elif attr == ATTR_SLOT_RIG and val:
            slot_map.setdefault(tid, "Rig")

    print(f" {len(tech_map)} tech / {len(size_map)} size / {len(slot_map)} slot entries loaded")
    return tech_map, size_map, slot_map


def _load_materials(sde: sqlite3.Connection) -> dict[int, list[dict]]:
    """
    Load all manufacturing materials (activityID=1) from the SDE.
    Returns { blueprint_type_id: [ {type_id, name, quantity}, ... ] }
    """
    print("  Loading industryActivityMaterials...", end="", flush=True)

    # First build a name lookup for all material types
    name_cur = sde.cursor()
    name_cur.execute("SELECT typeID, typeName FROM invTypes")
    names: dict[int, str] = {r["typeID"]: r["typeName"] for r in name_cur.fetchall()}

    mat_cur = sde.cursor()
    mat_cur.execute("""
        SELECT typeID AS blueprint_id, materialTypeID, quantity
        FROM   industryActivityMaterials
        WHERE  activityID = 1
    """)

    mats: dict[int, list] = {}
    for row in mat_cur.fetchall():
        bp_id = row["blueprint_id"]
        entry = {
            "type_id":  row["materialTypeID"],
            "name":     names.get(row["materialTypeID"], f"Type {row['materialTypeID']}"),
            "quantity": row["quantity"],
        }
        mats.setdefault(bp_id, []).append(entry)

    print(f" {sum(len(v) for v in mats.values())} material rows across {len(mats)} blueprints")
    return mats


def _load_times(sde: sqlite3.Connection) -> dict[int, int]:
    """
    Load manufacturing time (activityID=1) for all blueprints from the SDE.
    Returns { blueprint_type_id: time_in_seconds }
    """
    print("  Loading industryActivityTimes...", end="", flush=True)
    cur = sde.cursor()
    cur.execute("""
        SELECT typeID, time
        FROM   industryActivity
        WHERE  activityID = 1
    """)
    times = {row["typeID"]: row["time"] for row in cur.fetchall()}
    print(f" {len(times)} entries loaded")
    return times


def _load_skills(sde: sqlite3.Connection) -> dict[int, list[dict]]:
    """
    Load required skills for all manufactured output types from the SDE.
    Skill requirements live in dgmTypeAttributes on the *output* type:
        Attribute 182–187 → required skill type IDs
        Attribute 277–282 → required skill levels (matched by index)

    Returns { output_type_id: [ {name, level}, ... ] }
    """
    print("  Loading skill requirements from dgmTypeAttributes...", end="", flush=True)

    # Attribute ID pairs: (skillID_attr, levelID_attr)
    SKILL_PAIRS = [(182, 277), (183, 278), (184, 279), (185, 280), (186, 281), (187, 282)]
    SKILL_ATTR_IDS = [a for pair in SKILL_PAIRS for a in pair]

    # Build a name lookup for skill types (category 16 = Skills)
    name_cur = sde.cursor()
    name_cur.execute("SELECT typeID, typeName FROM invTypes")
    type_names: dict[int, str] = {r["typeID"]: r["typeName"] for r in name_cur.fetchall()}

    # Pull all relevant dgmTypeAttributes rows in one query
    placeholders = ",".join("?" * len(SKILL_ATTR_IDS))
    attr_cur = sde.cursor()
    attr_cur.execute(
        f"SELECT typeID, attributeID, valueInt, valueFloat FROM dgmTypeAttributes WHERE attributeID IN ({placeholders})",
        SKILL_ATTR_IDS,
    )

    # Build per-type maps: { type_id: { attr_id: value } }
    type_attrs: dict[int, dict[int, int]] = {}
    for row in attr_cur.fetchall():
        val = int(row["valueInt"] or row["valueFloat"] or 0)
        if val:
            type_attrs.setdefault(row["typeID"], {})[row["attributeID"]] = val

    # Assemble skill lists per output type
    skills_by_type: dict[int, list] = {}
    for type_id, attrs in type_attrs.items():
        entries = []
        for skill_attr, level_attr in SKILL_PAIRS:
            skill_type_id = attrs.get(skill_attr)
            skill_level   = attrs.get(level_attr)
            if skill_type_id and skill_level:
                name = type_names.get(skill_type_id, f"Skill {skill_type_id}")
                entries.append({"name": name, "level": skill_level})
        if entries:
            skills_by_type[type_id] = entries

    total = sum(len(v) for v in skills_by_type.values())
    print(f" {total} skill requirements across {len(skills_by_type)} types")
    return skills_by_type


def seed_from_sde() -> tuple[int, int]:
    """
    Main seeding function. Connects to both databases, reads the SDE,
    and writes all manufacturable blueprints + materials into crest.db.

    Returns (blueprint_count, material_row_count).
    """
    print("\n  ╔══════════════════════════════════════════╗")
    print("  ║   CREST SDE Seeder                       ║")
    print("  ╚══════════════════════════════════════════╝\n")

    sde   = _connect_sde()
    crest = _connect_crest()
    _init_crest(crest)

    # ── 1. Pre-load attribute lookups (single pass, much faster than per-item) ─
    tech_map, size_map, slot_map = _load_attributes(sde)

    # ── 2. Pre-load all material rows ─────────────────────────────────────────
    materials_by_bp = _load_materials(sde)

    # ── 2b. Pre-load manufacturing times ──────────────────────────────────────
    times_by_bp = _load_times(sde)

    # ── 2c. Pre-load skill requirements (keyed by OUTPUT type id) ─────────────
    skills_by_output = _load_skills(sde)

    # ── 3. Query all manufacturable blueprint outputs ─────────────────────────
    print("  Querying manufacturable blueprints...", end="", flush=True)
    bp_cur = sde.cursor()
    bp_cur.execute("""
        SELECT
            iap.typeID          AS blueprint_id,
            iap.productTypeID   AS output_id,
            iap.quantity        AS output_qty,
            t.typeName          AS output_name,
            t.volume            AS volume_m3,
            g.groupName         AS item_group,
            c.categoryName      AS category
        FROM   industryActivityProducts  iap
        JOIN   invTypes     t  ON t.typeID    = iap.productTypeID
        JOIN   invGroups    g  ON g.groupID   = t.groupID
        JOIN   invCategories c ON c.categoryID = g.categoryID
        WHERE  iap.activityID = 1
          AND  t.typeName IS NOT NULL
          AND  t.typeName != ''
          AND  t.published  = 1
        ORDER  BY iap.productTypeID
    """)

    rows = bp_cur.fetchall()
    total = len(rows)
    print(f" {total} found\n")

    # ── 4. Insert into crest.db ───────────────────────────────────────────────
    bp_count  = 0
    mat_count = 0

    bp_insert = """
        INSERT OR REPLACE INTO blueprints
            (blueprint_id, output_id, output_name, output_qty,
             category, item_group, tech_level, volume_m3,
             size_class, slot_type, me_level, te_level, time_seconds)
        VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?)
    """
    mat_insert = """
        INSERT INTO blueprint_materials
            (blueprint_id, material_type_id, material_name, base_quantity)
        VALUES (?,?,?,?)
    """
    skill_insert = """
        INSERT INTO blueprint_skills (blueprint_id, skill_name, skill_level, sort_order)
        VALUES (?,?,?,?)
    """

    for row in rows:
        bp_id      = row["blueprint_id"]
        output_id  = row["output_id"]
        name       = row["output_name"]

        # Resolve attributes for the *output* type (not the blueprint item)
        tech  = tech_map.get(output_id, 1)
        size  = size_map.get(output_id, "U")
        slot  = slot_map.get(output_id)
        vol   = row["volume_m3"] or 0.01
        time_s = times_by_bp.get(bp_id, 0)

        # Normalise category string for dashboard filter chips
        raw_cat   = row["category"] or "Other"
        raw_group = row["item_group"] or ""

        crest.execute(bp_insert, (
            bp_id,
            output_id,
            name,
            row["output_qty"],
            raw_cat,
            raw_group,
            tech,
            vol,
            size,
            slot,
            time_s,
        ))

        # Insert materials — delete old rows first so re-runs stay clean
        mats = materials_by_bp.get(bp_id, [])
        if mats:
            crest.execute(
                "DELETE FROM blueprint_materials WHERE blueprint_id = ?",
                (bp_id,)
            )
            crest.executemany(mat_insert,
                [(bp_id, m["type_id"], m["name"], m["quantity"]) for m in mats]
            )
            mat_count += len(mats)

        # Insert skill requirements (keyed by output type, not blueprint_id)
        skills = skills_by_output.get(output_id, [])
        if skills:
            crest.execute(
                "DELETE FROM blueprint_skills WHERE blueprint_id = ?",
                (bp_id,)
            )
            crest.executemany(skill_insert,
                [(bp_id, s["name"], s["level"], i) for i, s in enumerate(skills)]
            )

        bp_count += 1

        # Progress every 100 rows
        if bp_count % 100 == 0:
            print(f"  Seeded {bp_count:>5} / {total} blueprints...")
            crest.commit()  # Commit in batches to stay memory-friendly

    crest.commit()

    # ── 5. Summary ────────────────────────────────────────────────────────────
    skill_count = crest.execute("SELECT COUNT(*) FROM blueprint_skills").fetchone()[0]
    print(f"\n  Seeding complete.")
    print(f"  {bp_count} blueprints, {mat_count} material rows, {skill_count} skill rows saved to crest.db\n")

    sde.close()
    crest.close()
    return bp_count, mat_count


def seed_skills_from_esi() -> int:
    """
    Populate blueprint_skills in an existing crest.db using Fuzzwork's static
    SDE CSV dumps (dgmTypeAttributes + invTypes).  No SDE file required.

    Downloads two small compressed CSVs (~2 MB combined), parses skill
    requirement attributes (182/183/184 = skill type IDs, 277/278/279 = levels),
    resolves names via invTypes, then inserts rows for every blueprint whose
    output type has skill requirements.

    Returns the number of skill rows inserted.
    """
    import urllib.request
    import bz2

    SKILL_ID_ATTRS    = {182, 183, 184}   # requiredSkill1/2/3
    SKILL_LEVEL_ATTRS = {277, 278, 279}   # requiredSkill1/2/3Level
    # Pair them in order: 182↔277, 183↔278, 184↔279
    SKILL_PAIRS = [(182, 277), (183, 278), (184, 279)]

    def _fetch_csv(url: str) -> list[list[str]]:
        req = urllib.request.Request(url, headers={"User-Agent": "CREST-Seeder/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = bz2.decompress(r.read())
        lines = raw.decode("utf-8").splitlines()
        return [line.split(",") for line in lines[1:]]  # skip header

    crest = _connect_crest()
    _init_crest(crest)  # creates blueprint_skills if missing

    # ── Download & parse dgmTypeAttributes ───────────────────────────────────
    print("  Downloading dgmTypeAttributes from Fuzzwork...", end="", flush=True)
    attr_rows = _fetch_csv("https://www.fuzzwork.co.uk/dump/latest/dgmTypeAttributes.csv.bz2")
    print(f" {len(attr_rows):,} rows")

    # Build: { type_id: { attr_id: value } }
    type_attrs: dict[int, dict[int, int]] = {}
    ALL_SKILL_ATTRS = SKILL_ID_ATTRS | SKILL_LEVEL_ATTRS
    for parts in attr_rows:
        if len(parts) < 4:
            continue
        try:
            attr_id = int(parts[1])
            if attr_id not in ALL_SKILL_ATTRS:
                continue
            type_id = int(parts[0])
            # valueInt is parts[2], valueFloat is parts[3]
            val = parts[2] if parts[2] != "None" else parts[3]
            int_val = int(float(val))
            type_attrs.setdefault(type_id, {})[attr_id] = int_val
        except (ValueError, IndexError):
            continue

    # ── Download & parse invTypes for skill name lookup ───────────────────────
    print("  Downloading invTypes from Fuzzwork...", end="", flush=True)
    inv_rows = _fetch_csv("https://www.fuzzwork.co.uk/dump/latest/invTypes.csv.bz2")
    type_names: dict[int, str] = {}
    for parts in inv_rows:
        try:
            type_names[int(parts[0])] = parts[2]
        except (ValueError, IndexError):
            continue
    print(f" {len(type_names):,} type names loaded")

    # ── Build skill list for each output type ─────────────────────────────────
    skills_by_type: dict[int, list] = {}
    for type_id, attrs in type_attrs.items():
        entries = []
        for skill_attr, level_attr in SKILL_PAIRS:
            skill_type_id = attrs.get(skill_attr, 0)
            skill_level   = attrs.get(level_attr, 0)
            if skill_type_id and skill_level:
                name = type_names.get(skill_type_id, f"Skill {skill_type_id}")
                entries.append({"name": name, "level": skill_level})
        if entries:
            skills_by_type[type_id] = entries

    print(f"  {len(skills_by_type):,} types have skill requirements")

    # ── Insert into crest.db ──────────────────────────────────────────────────
    bp_rows = crest.execute("SELECT blueprint_id, output_id FROM blueprints").fetchall()

    skill_insert = """
        INSERT OR IGNORE INTO blueprint_skills (blueprint_id, skill_name, skill_level, sort_order)
        VALUES (?,?,?,?)
    """

    inserted = 0
    for bp_id, output_id in bp_rows:
        skills = skills_by_type.get(output_id, [])
        if skills:
            # Clear old rows and re-insert
            crest.execute("DELETE FROM blueprint_skills WHERE blueprint_id = ?", (bp_id,))
            crest.executemany(skill_insert,
                [(bp_id, s["name"], s["level"], i) for i, s in enumerate(skills)]
            )
            inserted += len(skills)

    crest.commit()
    crest.close()

    print(f"  Done — {inserted} skill requirement rows inserted into crest.db.")
    return inserted


# ─── Entry point ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if os.path.exists(SDE_PATH) and os.path.getsize(SDE_PATH) > 0:
        seed_from_sde()
    else:
        print("\n  SDE file not found or empty — running ESI skill seeder only.")
        print("  (Blueprint/material data must already be in crest.db)\n")
        _connect_crest()  # ensure db exists
        crest_tmp = _connect_crest()
        _init_crest(crest_tmp)  # creates blueprint_skills table if missing
        crest_tmp.close()
        seed_skills_from_esi()
