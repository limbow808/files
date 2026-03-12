"""
CREST - Capsuleer Resource & Economic Strategy Tool
====================================================
EVE Online Industry Intelligence System

Run this file to start CREST.
Usage:
    python main.py              # Run full market scan
    python main.py --item 34    # Check a single item by type ID
    python main.py --top 20     # Show top 20 opportunities (default: 10)
"""

import argparse
from scanner import run_scan
from pricer import get_price
from database import get_history

def main():
    parser = argparse.ArgumentParser(
        description="CREST - EVE Industry Intelligence"
    )
    parser.add_argument("--item", type=int, help="Check a single item by type ID")
    parser.add_argument("--top", type=int, default=10, help="How many top opportunities to show")
    parser.add_argument("--min-volume", type=float, default=0.0, help="Minimum average daily volume to include")
    parser.add_argument("--history", action="store_true", help="Show the last 7 days of top items from the history DB")
    args = parser.parse_args()

    if args.item:
        # Single item lookup mode
        result = get_price(args.item)
        if result:
            print(f"\nItem ID {args.item}")
            print(f"  Sell (you pay):  {result['sell']:>15,.2f} ISK")
            print(f"  Buy  (you get):  {result['buy']:>15,.2f} ISK")
        else:
            print(f"Could not fetch price for item {args.item}")
    else:
        # Show history if requested
        if args.history:
            scans = get_history(days=7)
            if not scans:
                print("No history found. Run a scan first to populate the database.")
                return
            # Print a simple summary per day: top item and its margin
            for s in scans:
                ts = s["ts"]
                results = s["results"]
                if not results:
                    continue
                top = results[0]
                from datetime import datetime
                dt = datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
                print(f"{dt}  ·  TOP: {top['name'][:30]:30}  NET: {top['net_profit']:>12,.0f} ISK  MARGIN: {top['margin_pct']:.1f}%")
            return

        # Full scan mode
        run_scan(top_n=args.top, min_volume=args.min_volume)

if __name__ == "__main__":
    main()
