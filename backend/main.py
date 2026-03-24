"""
CREST - Capsuleer Resource & Economic Strategy Tool
====================================================
EVE Online Industry Intelligence System

Usage:
    python main.py                   # Full market scan
    python main.py --hangar          # Scan + check what you can build right now
    python main.py --item 34         # Check a single item by type ID
    python main.py --top 20          # Show top 20 opportunities (default: 10)
    python main.py --min-volume 100  # Only show items trading 100+ units/day
    python main.py --history         # Show last 7 days of scan history
"""

import argparse
from scanner import run_scan
from pricer import get_price
from database import get_history

def main():
    parser = argparse.ArgumentParser(description="CREST - EVE Industry Intelligence")
    parser.add_argument("--item",       type=int,   help="Check a single item by type ID")
    parser.add_argument("--top",        type=int,   default=10, help="How many top opportunities to show")
    parser.add_argument("--min-volume", type=float, default=0.0, help="Minimum average daily volume to include")
    parser.add_argument("--history",    action="store_true", help="Show the last 7 days of scan history")
    parser.add_argument("--hangar",     action="store_true", help="Check hangar inventory and flag missing materials")
    args = parser.parse_args()

    if args.item:
        result = get_price(args.item)
        if result:
            print(f"\nItem ID {args.item}")
            print(f"  Sell (you pay):  {result['sell']:>15,.2f} ISK")
            print(f"  Buy  (you get):  {result['buy']:>15,.2f} ISK")
        else:
            print(f"Could not fetch price for item {args.item}")

    elif args.history:
        scans = get_history(days=7)
        if not scans:
            print("No history found. Run a scan first to populate the database.")
            return
        for s in scans:
            from datetime import datetime
            results = s["results"]
            if not results:
                continue
            top = results[0]
            dt = datetime.fromtimestamp(s["ts"]).strftime("%Y-%m-%d %H:%M")
            print(f"{dt}  ·  TOP: {top['name'][:30]:30}  NET: {top['net_profit']:>12,.0f} ISK  MARGIN: {top['margin_pct']:.1f}%")

    else:
        run_scan(top_n=args.top, min_volume=args.min_volume, check_hangar=args.hangar)

if __name__ == "__main__":
    main()