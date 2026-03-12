"""
calculator.py - Profit margin engine
======================================
Takes a blueprint + live prices and returns profit figures.

COSTS ACCOUNTED FOR:
  1. Material cost    - minerals/components at Jita sell price
  2. Sales tax        - % of sale price taken by CCP (default 2%, reduced by Accounting skill)
  3. Broker fee       - % to list on market (default 3%, reduced by Broker Relations skill)
  4. System Cost Index - manufacturing job installation cost (varies by system activity)

WHAT'S NOT YET ACCOUNTED FOR (Phase 5 additions):
  - Your actual skill bonuses
  - Structure manufacturing bonuses (E-UNI structures may give ME bonus)
  - Invention cost for T2 (datacores, copy BPCs)
  - Transport costs if hauling to Jita

Update the CONFIG section below with your real values.
"""

import math
from pricer import get_prices_bulk

# ─── CONFIG: Update these to match your setup ────────────────────────────────
CONFIG = {
    # Tax/fee rates (as decimals, e.g. 0.02 = 2%)
    "sales_tax":          0.036,   # Base 8%, reduced by Accounting skill (L5 = 3.6%)
    "broker_fee":         0.03,    # Base 3%, reduced by Broker Relations skill
    
    # System Cost Index for your manufacturing system
    # Find yours at: https://www.fuzzwork.co.uk/industry/
    # Lower = better. Quiet highsec systems can be 0.003-0.01
    "system_cost_index":  0.0714,   # UPDATE with your actual system SCI
    
    # Structure manufacturing bonus (ME reduction as decimal)
    # E-UNI structures may offer 1% ME bonus = 0.01
    "structure_me_bonus": 0.01,    # UPDATE based on E-UNI structure
    "job_cost_structure_discount": 0.04,   # E-UNI Engingeering Complex
}


def apply_me(base_qty: int, me_level: int, structure_bonus: float = 0.0) -> int:
    """
    Apply material efficiency research to a base material quantity.
    Formula: ceil( base * (1 - me_level/100) * (1 - structure_bonus) )
    """
    reduction = 1 - (me_level / 100) - structure_bonus
    return max(1, math.ceil(base_qty * reduction))


def calculate_profit(blueprint: dict, prices: dict) -> dict | None:
    """
    Calculate profit for one blueprint run given a price dictionary.

    Args:
        blueprint:  One entry from blueprints.BLUEPRINTS
        prices:     Dict of { type_id: { 'sell': float, 'buy': float } }

    Returns:
        Dict with full profit breakdown, or None if prices missing
    """
    output_id  = blueprint["output_id"]
    output_qty = blueprint["output_qty"]
    me_level   = blueprint["me_level"]

    # Check we have the output price
    if output_id not in prices:
        return None

    # ── Revenue ──────────────────────────────────────────────────────────────
    # Use BUY price for output (conservative - guaranteed revenue)
    unit_revenue = prices[output_id]["buy"]
    gross_revenue = unit_revenue * output_qty

    # ── Material cost ─────────────────────────────────────────────────────────
    material_cost = 0
    material_breakdown = []

    for mat in blueprint["materials"]:
        tid = mat["type_id"]
        if tid not in prices:
            return None  # Missing price data - skip this blueprint

        # Apply ME research + structure bonus to get actual quantity needed
        actual_qty = apply_me(
            mat["quantity"],
            me_level,
            CONFIG["structure_me_bonus"]
        )

        # Use SELL price for inputs (conservative - what you actually pay)
        unit_price = prices[tid]["sell"]
        line_cost  = unit_price * actual_qty

        material_cost += line_cost
        material_breakdown.append({
            "type_id":    tid,
            "quantity":   actual_qty,
            "unit_price": unit_price,
            "line_cost":  line_cost
        })

    # ── Job installation cost (System Cost Index) ─────────────────────────────
    # SCI is applied to the estimated job cost (sum of material values at sell price)
    job_cost = material_cost * CONFIG["system_cost_index"] * (1 - CONFIG["job_cost_structure_discount"])

    # ── Taxes and fees ────────────────────────────────────────────────────────
    sales_tax   = gross_revenue * CONFIG["sales_tax"]
    broker_fee  = gross_revenue * CONFIG["broker_fee"]
    total_tax   = sales_tax + broker_fee

    # ── Final profit ──────────────────────────────────────────────────────────
    total_cost   = material_cost + job_cost + total_tax
    net_profit   = gross_revenue - total_cost
    margin_pct   = (net_profit / gross_revenue * 100) if gross_revenue > 0 else 0

    return {
        "name":               blueprint["name"],
        "output_id":          output_id,
        "output_qty":         output_qty,
        "gross_revenue":      gross_revenue,
        "material_cost":      material_cost,
        "job_cost":           job_cost,
        "sales_tax":          sales_tax,
        "broker_fee":         broker_fee,
        "net_profit":         net_profit,
        "margin_pct":         margin_pct,
        "material_breakdown": material_breakdown,
    "is_profitable":      net_profit > 0,
    # Propagate any avg_daily_volume for the output (if present)
    "avg_daily_volume":   prices.get(output_id, {}).get("avg_daily_volume")
    }


def calculate_all(blueprints: list, min_volume: float = 0.0) -> list:
    """
    Run profit calculation for every blueprint.
    Fetches all required prices in one batch, then calculates.
    Returns list of results sorted by net_profit descending.
    """
    # Collect all unique type IDs we need prices for
    all_type_ids = set()
    for bp in blueprints:
        all_type_ids.add(bp["output_id"])
        for mat in bp["materials"]:
            all_type_ids.add(mat["type_id"])

    print(f"  Fetching prices for {len(all_type_ids)} items from Jita...")
    prices = get_prices_bulk(list(all_type_ids))
    print(f"  Got prices for {len(prices)} items.\n")

    results = []
    for bp in blueprints:
        result = calculate_profit(bp, prices)
        if result:
            # Apply min_volume filter if set
            avg_vol = result.get("avg_daily_volume") or 0
            if min_volume and avg_vol < min_volume:
                # Skip low-volume items
                continue
            results.append(result)
        else:
            print(f"  [!] Skipped '{bp['name']}' - missing price data")

    # Sort by net profit, best first
    results.sort(key=lambda x: x["net_profit"], reverse=True)
    return results
