"""
scanner.py - Full market scan and display
==========================================
Orchestrates the full CREST scan:
  1. Load your blueprints
  2. Fetch all prices
  3. Calculate all margins
  4. Optionally check hangar inventory (--hangar flag)
  5. Display ranked results

Run modes:
  python main.py               # Market scan only
  python main.py --hangar      # Market scan + buildability check
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
    print("║               Strategy Tool  ·  v0.2                       ║")
    print("╚══════════════════════════════════════════════════════════════╝")
    print()


def _hangar_column(result: dict) -> str:
    """Return a short hangar status string for the table."""
    can_build = result.get("can_build")
    max_runs  = result.get("max_runs")

    if can_build is None:
        return "  —"          # hangar check not run
    elif can_build:
        return f"  ✓ {max_runs}x"
    else:
        return f"  ✗ {max_runs}x"


def print_results_table(results: list, top_n: int, show_hangar: bool = False):
    """Print a formatted table of manufacturing opportunities."""

    profitable   = [r for r in results if r["is_profitable"]]
    unprofitable = [r for r in results if not r["is_profitable"]]

    hangar_col = "  HANGAR" if show_hangar else ""
    print(f"  {'RANK':<5} {'ITEM':<25} {'REVENUE':>14} {'MAT COST':>14} {'PROFIT':>14} {'MARGIN':>8} {'VOLUME':>10}{hangar_col}")
    print("  " + "─" * (83 + (10 if show_hangar else 0)))

    for i, r in enumerate(results[:top_n]):
        rank     = f"#{i+1}"
        name     = r["name"][:24]
        revenue  = format_isk(r["gross_revenue"])
        mat_cost = format_isk(r["material_cost"])
        profit   = format_isk(r["net_profit"])
        margin   = f"{r['margin_pct']:.1f}%"
        volume   = f"{int(r.get('avg_daily_volume') or 0):,}"

        if r["net_profit"] > 0:
            indicator = "▲" if r["margin_pct"] > 10 else "►"
        else:
            indicator = "▼"

        hangar_str = _hangar_column(r) if show_hangar else ""
        print(f"  {rank:<5} {name:<25} {revenue:>14} {mat_cost:>14} {profit:>14} {margin:>7} {volume:>10}  {indicator}{hangar_str}")

    print("  " + "─" * (83 + (10 if show_hangar else 0)))
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


def print_missing_materials(result: dict):
    """Print a short missing-materials report for one item."""
    missing = result.get("missing", [])
    if not missing:
        return
    print(f"\n  ── MISSING MATERIALS: {result['name']}")
    print(f"  {'MATERIAL':<20} {'HAVE':>12} {'NEED':>12} {'SHORT BY':>12}")
    print("  " + "─" * 58)
    for m in missing:
        print(f"  {m['name']:<20} {m['have']:>12,} {m['need']:>12,} {m['short_by']:>12,}")


def run_scan(top_n: int = 10, min_volume: float = 0.0, check_hangar: bool = False):
    print_header()
    print(f"  Scanning {len(BLUEPRINTS)} blueprints...\n")

    results = calculate_all(BLUEPRINTS, min_volume=min_volume)

    if not results:
        print("  No results. Check your blueprints.py and API connection.")
        return

    # ── Optional hangar check ─────────────────────────────────────────────────
    if check_hangar:
        try:
            from hangar import enrich_results_with_hangar
            from assets import CHARACTER_ID
            from auth import get_auth_header
            results = enrich_results_with_hangar(results, BLUEPRINTS, CHARACTER_ID, get_auth_header())
        except Exception as e:
            print(f"  [!] Hangar check failed: {e}\n")

    # ── Results table ─────────────────────────────────────────────────────────
    print("  ── TOP MANUFACTURING OPPORTUNITIES ─────────────────────────────────────────────\n")
    print_results_table(results, top_n, show_hangar=check_hangar)

    # ── Missing materials for anything in top N that can't be built ───────────
    if check_hangar:
        cant_build = [r for r in results[:top_n] if r.get("can_build") is False]
        if cant_build:
            print("\n  ── MATERIAL SHORTFALLS ──────────────────────────────────────────────────────────")
            for r in cant_build:
                print_missing_materials(r)

    # ── Save to DB ────────────────────────────────────────────────────────────
    try:
        save_scan(results)
    except Exception:
        pass

    # ── Full breakdown for top item ───────────────────────────────────────────
    print("\n  ── FULL BREAKDOWN: TOP OPPORTUNITY ─────────────────────────────────────────────")
    print_detail(results[0])

    # ── Next steps hint ───────────────────────────────────────────────────────
    print("\n  ── TIPS ─────────────────────────────────────────────────────────────────────────")
    if not check_hangar:
        print("  Run with --hangar to see which items you can build right now.")
    print("  Update ME levels in blueprints.py for your researched BPOs.")
    print("  Update system_cost_index in calculator.py with your actual system.")
    print("  Add more blueprints to blueprints.py to find better opportunities.")
    print()