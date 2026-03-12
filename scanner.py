"""
scanner.py - Full market scan and display
==========================================
Orchestrates the full CREST scan:
  1. Load your blueprints
  2. Fetch all prices
  3. Calculate all margins
  4. Display ranked results

This is what runs when you call: python main.py
"""

from blueprints import BLUEPRINTS
from calculator import calculate_all
from database import save_scan


def format_isk(value: float) -> str:
    """Format ISK values cleanly. e.g. 420,000,000 -> '420.0M ISK'"""
    if abs(value) >= 1_000_000_000:
        return f"{value / 1_000_000_000:.2f}B ISK"
    elif abs(value) >= 1_000_000:
        return f"{value / 1_000_000:.1f}M ISK"
    elif abs(value) >= 1_000:
        return f"{value / 1_000:.1f}K ISK"
    else:
        return f"{value:.0f} ISK"


def print_header():
    print()
    print("╔══════════════════════════════════════════════════════════════╗")
    print("║          CREST  ·  Capsuleer Resource & Economic            ║")
    print("║               Strategy Tool  ·  v0.1                       ║")
    print("╚══════════════════════════════════════════════════════════════╝")
    print()


def print_results_table(results: list, top_n: int):
    """Print a formatted table of manufacturing opportunities."""

    profitable = [r for r in results if r["is_profitable"]]
    unprofitable = [r for r in results if not r["is_profitable"]]

    print(f"  {'RANK':<5} {'ITEM':<25} {'REVENUE':>14} {'MAT COST':>14} {'PROFIT':>14} {'MARGIN':>8} {'VOLUME':>10}")
    print("  " + "─" * 83)

    shown = 0
    for i, r in enumerate(results[:top_n]):
        rank     = f"#{i+1}"
        name     = r["name"][:24]
        revenue  = format_isk(r["gross_revenue"])
        mat_cost = format_isk(r["material_cost"])
        profit   = format_isk(r["net_profit"])
        margin   = f"{r['margin_pct']:.1f}%"
        volume   = f"{int(r.get('avg_daily_volume') or 0):,}"

        # Visual indicator
        if r["net_profit"] > 0:
            indicator = "▲" if r["margin_pct"] > 10 else "►"
        else:
            indicator = "▼"

        print(f"  {rank:<5} {name:<25} {revenue:>14} {mat_cost:>14} {profit:>14} {margin:>7} {volume:>10}  {indicator}")
        shown += 1

    print("  " + "─" * 83)
    print(f"\n  {len(profitable)} profitable  ·  {len(unprofitable)} unprofitable  ·  {len(results)} total scanned")


def print_detail(result: dict):
    """Print a full cost breakdown for one item."""
    print(f"\n  ── {result['name']} ──────────────────────────────")
    print(f"  Revenue ({result['output_qty']}x at buy price): {format_isk(result['gross_revenue'])}")
    print()
    print(f"  Costs:")
    print(f"    Materials:    {format_isk(result['material_cost'])}")
    print(f"    Job install:  {format_isk(result['job_cost'])}")
    print(f"    Sales tax:    {format_isk(result['sales_tax'])}")
    print(f"    Broker fee:   {format_isk(result['broker_fee'])}")
    print(f"                  {'─' * 18}")
    print(f"    Total cost:   {format_isk(result['material_cost'] + result['job_cost'] + result['sales_tax'] + result['broker_fee'])}")
    print()
    print(f"  NET PROFIT:     {format_isk(result['net_profit'])}  ({result['margin_pct']:.1f}% margin)")


def run_scan(top_n: int = 10, min_volume: float = 0.0):
    print_header()

    print(f"  Scanning {len(BLUEPRINTS)} blueprints...\n")
    results = calculate_all(BLUEPRINTS, min_volume=min_volume)

    if not results:
        print("  No results. Check your blueprints.py and API connection.")
        return

    print("  ── TOP MANUFACTURING OPPORTUNITIES ─────────────────────────────────────────────\n")
    print_results_table(results, top_n)

    # Save scan to DB for history
    try:
        save_scan(results)
    except Exception:
        # Non-fatal if DB saving fails
        pass

    # Show full breakdown for top item
    if results:
        print("\n  ── FULL BREAKDOWN: TOP OPPORTUNITY ─────────────────────────────────────────────")
        print_detail(results[0])

    print("\n  ── NEXT STEPS ───────────────────────────────────────────────────────────────────")
    print("  1. Verify top item profit against what you see in-game manually")
    print("  2. Update ME levels in blueprints.py for your researched BPOs")
    print("  3. Update system_cost_index in calculator.py with your actual system")
    print("  4. Add more blueprints to blueprints.py")
    print()
