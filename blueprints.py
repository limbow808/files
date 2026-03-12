"""
blueprints.py - Your manufacturing blueprint library
=====================================================
This is your personal blueprint database.
Add every BPO/BPC you own here.

Structure for each blueprint:
  "name":        Display name
  "output_id":   Type ID of the finished product (look up on https://www.fuzzwork.co.uk/api/)
  "output_qty":  How many units one job produces
  "me_level":    Your blueprint's Material Efficiency research level (0-10)
                 Higher ME = fewer materials needed per job
  "materials":   List of { "type_id": int, "quantity": int } at ME0
                 CREST will automatically apply your ME level discount

HOW TO FIND TYPE IDs:
  - https://www.fuzzwork.co.uk/api/typeid.php?typename=Hammerhead+II
  - Or search on https://everef.net

MATERIAL EFFICIENCY FORMULA:
  actual_qty = ceil( base_qty * (1 - me_level / 100) )
  At ME10, you use ~10% fewer materials than ME0.
"""

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

# ─── Your Blueprint Library ───────────────────────────────────────────────────
# START SMALL: these are 5 starter items to prove the system works.
# Verify each profit number manually in-game, then expand this list.

BLUEPRINTS = [
    {
        "name": "Hammerhead II",
        "output_id": 2185,
        "output_qty": 1,
        "me_level": 0,      # UPDATE THIS to your actual ME level
        "materials": [
            {"type_id": MINERALS["Tritanium"], "quantity": 26667},
            {"type_id": MINERALS["Pyerite"],   "quantity": 6667},
            {"type_id": MINERALS["Mexallon"],  "quantity": 1667},
            {"type_id": MINERALS["Isogen"],    "quantity": 333},
            {"type_id": MINERALS["Nocxium"],   "quantity": 83},
            {"type_id": MINERALS["Zydrine"],   "quantity": 17},
            {"type_id": MINERALS["Megacyte"],  "quantity": 4},
            # T2 items also need components - add those here as you expand
            # {"type_id": 11530, "quantity": 1},  # Drone Endoframe, for example
        ]
    },
    {
        "name": "Hobgoblin II",
        "output_id": 2456,
        "output_qty": 1,
        "me_level": 0,
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
        "name": "Hobgoblin I",       # T1 baseline - useful to compare T1 vs T2 margins
        "output_id": 2454,
        "output_qty": 10,            # T1 BPOs produce in batches
        "me_level": 0,
        "materials": [
            {"type_id": MINERALS["Tritanium"], "quantity": 10400},
            {"type_id": MINERALS["Pyerite"],   "quantity": 2600},
            {"type_id": MINERALS["Mexallon"],  "quantity": 650},
        ]
    },
]
