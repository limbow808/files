"""
hangar.py - Hangar inventory and buildability checker
======================================================
Fetches your character's personal hangar assets from ESI
and checks how many runs of each blueprint you can build
right now with what you have.

Used by scanner.py to add a HANGAR column to the output
and flag items where you're short on materials.
"""

import requests
from collections import defaultdict

ESI_BASE = "https://esi.evetech.net/latest"


def get_hangar(character_id: str, auth_header: dict) -> dict[int, int]:
    """
    Fetch all assets for a character and return a flat dict of
    { type_id: total_quantity } across all personal hangar locations.

    Note: This includes everything in your personal hangar across all
    stations. If you want to filter to a specific station, you'd need
    to check location_id — we keep it simple for now and sum everything.
    """
    url = f"{ESI_BASE}/characters/{character_id}/assets/"
    all_items = []
    page = 1

    while True:
        resp = requests.get(url, headers=auth_header, params={"page": page})
        resp.raise_for_status()
        page_items = resp.json()
        if not page_items:
            break
        all_items.extend(page_items)
        # ESI paginates at 1000 items per page
        if len(page_items) < 1000:
            break
        page += 1

    # Sum quantities by type_id
    inventory = defaultdict(int)
    for item in all_items:
        # location_flag "Hangar" = personal station hangar
        # We include all flags for now (covers hangar + containers in hangar)
        inventory[item["type_id"]] += item["quantity"]

    return dict(inventory)


def check_buildability(blueprint: dict, inventory: dict[int, int]) -> dict:
    """
    Check if a blueprint's materials can be covered by current inventory.

    Returns a dict with:
      can_build       - True if you have ALL materials for at least 1 run
      max_runs        - How many full runs you can do with current stock
      missing         - List of { type_id, name, have, need, short_by } for missing materials
      coverage_pct    - What % of total material value you have available
    """
    from blueprints import MINERALS
    import math
    from calculator import apply_me, CONFIG

    # Build a reverse lookup: type_id -> mineral name
    mineral_names = {v: k for k, v in MINERALS.items()}

    me_level  = blueprint.get("me_level", 0)
    structure = CONFIG.get("structure_me_bonus", 0.0)

    missing = []
    max_runs_list = []

    for mat in blueprint["materials"]:
        tid      = mat["type_id"]
        base_qty = mat["quantity"]
        need_qty = apply_me(base_qty, me_level, structure)
        have_qty = inventory.get(tid, 0)

        if have_qty < need_qty:
            missing.append({
                "type_id":  tid,
                "name":     mineral_names.get(tid, f"TypeID {tid}"),
                "have":     have_qty,
                "need":     need_qty,
                "short_by": need_qty - have_qty,
            })
            if need_qty > 0:
                max_runs_list.append(have_qty / need_qty)
            else:
                max_runs_list.append(0)
        else:
            if need_qty > 0:
                max_runs_list.append(have_qty / need_qty)

    can_build = len(missing) == 0
    max_runs  = int(min(max_runs_list)) if max_runs_list else 0

    return {
        "can_build":   can_build,
        "max_runs":    max_runs,
        "missing":     missing,
    }


def enrich_results_with_hangar(results: list, blueprints: list, character_id: str, auth_header: dict) -> list:
    """
    Fetch hangar inventory once, then annotate each result with
    hangar availability data.

    Adds to each result dict:
      can_build   - bool
      max_runs    - int
      missing     - list of missing materials
    """
    print("  Fetching hangar inventory from ESI...")
    try:
        inventory = get_hangar(character_id, auth_header)
        total_types = len([v for v in inventory.values() if v > 0])
        print(f"  Found {total_types} item types in your hangar.\n")
    except Exception as e:
        print(f"  [!] Could not fetch hangar: {e}")
        print("      Skipping buildability check — run without --hangar flag to suppress this.\n")
        for r in results:
            r["can_build"] = None
            r["max_runs"]  = None
            r["missing"]   = []
        return results

    # Build a lookup: output_id -> blueprint definition
    bp_lookup = {bp["output_id"]: bp for bp in blueprints}

    for result in results:
        bp = bp_lookup.get(result["output_id"])
        if bp:
            check = check_buildability(bp, inventory)
            result["can_build"] = check["can_build"]
            result["max_runs"]  = check["max_runs"]
            result["missing"]   = check["missing"]
        else:
            result["can_build"] = None
            result["max_runs"]  = None
            result["missing"]   = []

    return results