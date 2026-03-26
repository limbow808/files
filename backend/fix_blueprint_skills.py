"""
fix_blueprint_skills.py
=======================
Re-seeds blueprint_skills in crest.db using the correct data source:
- industryActivitySkills from zzeve.com SDE mirror (keyed by blueprint typeID)
- Skill names resolved via ESI /universe/names/ bulk endpoint

The old data was derived from dgmTypeAttributes on the *output* item type,
which gives item-use requirements (e.g. "Anchoring" to anchor a structure),
NOT manufacturing requirements. This script fixes that.

Usage:
    python fix_blueprint_skills.py
"""

import sqlite3
import os
import sys
import requests
import time

CREST_PATH = os.path.join(os.path.dirname(__file__), "crest.db")
ZZEVE_SKILLS_URL = "https://sde.zzeve.com/industryActivitySkills.json"
ESI_NAMES_URL    = "https://esi.evetech.net/latest/universe/names/"
ACTIVITY_MFG     = 1


def _fetch_industry_skills() -> list[dict]:
    """Download the full industryActivitySkills table from the zzeve SDE mirror."""
    print("  Fetching industryActivitySkills from zzeve.com...", end="", flush=True)
    r = requests.get(ZZEVE_SKILLS_URL, timeout=120)
    r.raise_for_status()
    data = r.json()
    print(f" {len(data)} rows")
    return data


def _resolve_skill_names(skill_ids: set[int]) -> dict[int, str]:
    """Resolve skill type IDs to names via ESI /universe/names/ (max 1000 per call)."""
    print(f"  Resolving {len(skill_ids)} skill names via ESI...", end="", flush=True)
    id_list = sorted(skill_ids)
    names: dict[int, str] = {}
    chunk_size = 1000
    for i in range(0, len(id_list), chunk_size):
        chunk = id_list[i:i + chunk_size]
        r = requests.post(ESI_NAMES_URL, json=chunk, timeout=30)
        r.raise_for_status()
        for item in r.json():
            names[item["id"]] = item["name"]
        if i + chunk_size < len(id_list):
            time.sleep(0.1)
    print(f" resolved {len(names)}")
    return names


def main():
    print("\n  ╔══════════════════════════════════════════╗")
    print("  ║   blueprint_skills repair                ║")
    print("  ╚══════════════════════════════════════════╝\n")

    # 1. Load all blueprint_ids we care about
    crest = sqlite3.connect(CREST_PATH)
    crest.row_factory = sqlite3.Row
    bp_ids: set[int] = {r[0] for r in crest.execute("SELECT blueprint_id FROM blueprints")}
    print(f"  Blueprints in crest.db: {len(bp_ids)}")

    # 2. Fetch industry activity skills
    raw = _fetch_industry_skills()

    # 3. Filter to manufacturing activity for blueprints we have
    skill_rows = [
        row for row in raw
        if row["activityID"] == ACTIVITY_MFG and row["typeID"] in bp_ids
    ]
    print(f"  Relevant manufacturing skill rows: {len(skill_rows)}")

    # 4. Resolve all unique skill type IDs to names
    unique_skill_ids = {row["skillID"] for row in skill_rows}
    skill_names = _resolve_skill_names(unique_skill_ids)

    # 5. Re-populate blueprint_skills
    print("  Writing new blueprint_skills...", end="", flush=True)
    crest.execute("DELETE FROM blueprint_skills")

    insert_sql = """
        INSERT INTO blueprint_skills (blueprint_id, skill_name, skill_level, sort_order)
        VALUES (?, ?, ?, ?)
    """

    # Group by blueprint_id to assign sort_order
    from collections import defaultdict
    by_bp: dict[int, list] = defaultdict(list)
    for row in skill_rows:
        name = skill_names.get(row["skillID"], f"Skill {row['skillID']}")
        by_bp[row["typeID"]].append((name, row["level"]))

    total_inserted = 0
    for bp_id, skills in by_bp.items():
        for sort_idx, (skill_name, skill_level) in enumerate(skills):
            crest.execute(insert_sql, (bp_id, skill_name, skill_level, sort_idx))
            total_inserted += 1

    crest.commit()
    print(f" {total_inserted} rows across {len(by_bp)} blueprints")

    # 6. Verify spot check: MMJU
    mmju_bp_id = 33592
    rows = crest.execute(
        "SELECT skill_name, skill_level FROM blueprint_skills WHERE blueprint_id=? ORDER BY sort_order",
        (mmju_bp_id,)
    ).fetchall()
    print(f"\n  ✓ Mobile Micro Jump Unit BP skills ({mmju_bp_id}):")
    for r in rows:
        print(f"      {r['skill_name']} {r['skill_level']}")
    if not rows:
        print("    (no skills — check blueprint_id)")

    print("\n  Done! Restart the server to load updated skills.\n")
    crest.close()


if __name__ == "__main__":
    main()
