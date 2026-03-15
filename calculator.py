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
from blueprints import load_blueprints
from invention import INVENTION_DATA, calculate_invention_cost

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

    # ── Sanity filter thresholds ─────────────────────────────────────────────
    # Items where total raw material cost is below this are skipped.
    # Catches gift ships / LP-store items whose SDE blueprint has trivial mats.
    "min_material_cost":   10_000,   # ISK

    # Items where (sell revenue / material cost) exceeds this are skipped.
    # Real manufacturing has tight margins; faction/officer items show up here
    # because their SDE mats are wrong / they're not player-craftable BPOs.
    # 5.0 = materials must be ≥20% of sale price. Increase cautiously.
    "max_rev_mat_ratio":   5.0,
}


def apply_me(base_qty: int, me_level: int, structure_bonus: float = 0.0) -> int:
    """
    Apply material efficiency research to a base material quantity.
    Formula: ceil( base * (1 - me_level/100) * (1 - structure_bonus) )
    """
    reduction = 1 - (me_level / 100) - structure_bonus
    return max(1, math.ceil(base_qty * reduction))


def calculate_profit(blueprint: dict, prices: dict, config_override: dict = None,
                     invention_prices: dict | None = None,
                     sell_days_by_type: dict | None = None) -> dict | None:
    """
    Calculate profit for one blueprint run given a price dictionary.

    Args:
        blueprint:          One entry from blueprints.BLUEPRINTS
        prices:             Dict of { type_id: { 'sell': float, 'buy': float } }
        config_override:    Optional dict to override CONFIG values for this call
        invention_prices:   Optional pre-fetched prices dict covering datacores,
                            used to calculate invention cost for T2 blueprints.
                            If None and blueprint is T2, invention cost is skipped.
        sell_days_by_type:  Optional dict of { type_id: avg_days_to_sell } from
                            sell_order_history.  When provided the ISK/hr figure
                            accounts for the time the item sits on the market
                            before selling.  Falls back to DEFAULT_SELL_DAYS.

    Returns:
        Dict with full profit breakdown, or None if prices missing
    """
    cfg = {**CONFIG, **(config_override or {})}

    output_id  = blueprint["output_id"]
    output_qty = blueprint["output_qty"]
    me_level   = blueprint["me_level"]
    te_level   = blueprint.get("te_level", 0)
    base_time  = blueprint.get("time_seconds", 0)

    # Skip blueprints with no materials — not real player-obtainable BPOs
    if not blueprint.get("materials"):
        return None

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
            cfg["structure_me_bonus"]
        )

        # Use SELL price for inputs (conservative - what you actually pay)
        unit_price = prices[tid]["sell"]
        line_cost  = unit_price * actual_qty

        material_cost += line_cost
        material_breakdown.append({
            "type_id":    tid,
            "name":       mat.get("name", ""),
            "quantity":   actual_qty,
            "unit_price": unit_price,
            "line_cost":  line_cost
        })

    # ── Sanity checks — filter out SDE blueprints that aren't real player BPOs ─
    # 1. Material cost must be meaningful (gift ships / LP items have ~0 material cost)
    if material_cost < cfg.get("min_material_cost", 10_000):
        return None

    # 2. Revenue-to-material-cost ratio must be reasonable.
    #    Real manufacturing items have margins driven by labour/tax/SCI, not 10-1000x free profit.
    #    Faction/officer items technically have blueprints in SDE but are loot drops, not crafted.
    #    Threshold of 5x: materials must cover at least ~20% of the sale price.
    rev_mat_ratio = gross_revenue / material_cost if material_cost > 0 else 9999
    if rev_mat_ratio > cfg.get("max_rev_mat_ratio", 5.0):
        return None

    # ── Job installation cost (System Cost Index) ─────────────────────────────
    # SCI is applied to the estimated job cost (sum of material values at sell price)
    job_cost = material_cost * cfg["system_cost_index"] * (1 - cfg["job_cost_structure_discount"])

    # ── Taxes and fees ────────────────────────────────────────────────────────
    sales_tax   = gross_revenue * cfg["sales_tax"]
    broker_fee  = gross_revenue * cfg["broker_fee"]
    total_tax   = sales_tax + broker_fee

    # ── Invention cost (T2 blueprints only) ───────────────────────────────────
    invention_cost     = 0.0
    invention_cost_per_run = None
    invention_detail   = None

    bp_name = blueprint.get("name", "")
    is_t2   = blueprint.get("tech") == "II" or blueprint.get("tech_level") == 2

    if is_t2 and bp_name in INVENTION_DATA:
        if invention_prices is not None:
            inv_result = calculate_invention_cost(bp_name, prices=invention_prices)
            if inv_result:
                invention_cost_per_run = inv_result["cost_per_run"]
                invention_cost         = invention_cost_per_run * output_qty
                invention_detail       = inv_result

    # ── Final profit ──────────────────────────────────────────────────────────
    total_cost   = material_cost + job_cost + total_tax + invention_cost
    net_profit   = gross_revenue - total_cost
    margin_pct   = (net_profit / gross_revenue * 100) if gross_revenue > 0 else 0

    # ── Duration with TE applied ──────────────────────────────────────────────
    # Formula: base_time * (1 - te_level/100)
    te_reduction  = 1 - (te_level / 100)
    time_seconds  = max(1, round(base_time * te_reduction)) if base_time else 0

    # ── ISK/hr — manufacture time + time sitting on market ────────────────────
    # DEFAULT_SELL_DAYS: assumed sell time when no history exists yet (3 days).
    # When sell_days_by_type contains data for this output the real avg is used,
    # giving a more accurate picture of capital turnover.
    DEFAULT_SELL_DAYS = 3.0
    if sell_days_by_type is not None:
        avg_sell_days = sell_days_by_type.get(output_id, DEFAULT_SELL_DAYS)
    else:
        avg_sell_days = DEFAULT_SELL_DAYS
    sell_seconds   = avg_sell_days * 86400.0
    total_cycle_s  = time_seconds + sell_seconds   # manufacture + wait to sell
    isk_per_hour   = (net_profit / total_cycle_s * 3600.0) if total_cycle_s > 0 else None

    return {
        "name":               blueprint["name"],
        "output_id":          output_id,
        "output_qty":         output_qty,
        "gross_revenue":      gross_revenue,
        "material_cost":      material_cost,
        "job_cost":           job_cost,
        "sales_tax":          sales_tax,
        "broker_fee":         broker_fee,
        "invention_cost":     invention_cost,
        "invention_detail":   invention_detail,
        "net_profit":         net_profit,
        "margin_pct":         margin_pct,
        "time_seconds":       time_seconds,
        "avg_sell_days":      round(avg_sell_days, 4),
        "isk_per_hour":       isk_per_hour,
        "material_breakdown": material_breakdown,
        "is_profitable":      net_profit > 0,
        # Propagate any avg_daily_volume for the output (if present)
        "avg_daily_volume":   prices.get(output_id, {}).get("avg_daily_volume")
    }


def calculate_all(blueprints: list = None, min_volume: float = 0.0) -> list:
    """
    Run profit calculation for every blueprint.
    Fetches all required prices in one batch, then calculates.
    Returns list of results sorted by net_profit descending.

    If `blueprints` is None, loads all blueprints from crest.db
    (or the hardcoded fallback list if crest.db is absent).
    """
    from invention import _all_datacore_type_ids

    if blueprints is None:
        blueprints = load_blueprints()
    # Collect all unique type IDs we need prices for
    all_type_ids = set()
    for bp in blueprints:
        all_type_ids.add(bp["output_id"])
        for mat in bp["materials"]:
            all_type_ids.add(mat["type_id"])

    # Include datacore IDs so invention costs can be calculated
    for dc_id in _all_datacore_type_ids():
        all_type_ids.add(dc_id)

    print(f"  Fetching prices for {len(all_type_ids)} items from Jita...")
    prices = get_prices_bulk(list(all_type_ids))
    print(f"  Got prices for {len(prices)} items.\n")

    # Load historical sell-time data to improve ISK/hr accuracy
    sell_days_by_type: dict = {}
    try:
        from database import get_avg_days_to_sell_by_type
        sell_days_by_type = get_avg_days_to_sell_by_type()
        if sell_days_by_type:
            print(f"  Loaded sell-time history for {len(sell_days_by_type)} item types.\n")
    except Exception as _e:
        print(f"  [calculator] Could not load sell history: {_e}")

    results = []
    for bp in blueprints:
        result = calculate_profit(bp, prices, invention_prices=prices,
                                  sell_days_by_type=sell_days_by_type)
        if result:
            # Apply min_volume filter if set
            avg_vol = result.get("avg_daily_volume") or 0
            if min_volume and avg_vol < min_volume:
                # Skip low-volume items
                continue
            results.append(result)
        # silently skip items with missing price data — expected for
        # discontinued/special-edition items with no Jita market

    # Sort by net profit, best first
    results.sort(key=lambda x: x["net_profit"], reverse=True)
    return results
