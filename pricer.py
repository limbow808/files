"""
pricer.py - Live market data from EVE ESI API
==============================================
Fetches Jita (The Forge) buy and sell prices for any item.

KEY RULE (never change this):
  - SELL price = what YOU PAY when buying materials (input cost)
  - BUY  price = what YOU RECEIVE when selling finished goods (guaranteed revenue)
  Using sell price for outputs inflates profit. Using buy price for inputs understates cost.
  Always be conservative: assume worst-case prices in both directions.
"""

import requests
import time
from statistics import mean

# The Forge region (contains Jita 4-4) - the main EVE trade hub
REGION_THE_FORGE = 10000002

# ESI base URL - public endpoints, no auth needed for market data
ESI_BASE = "https://esi.evetech.net/latest"

# Simple in-memory cache so we don't hammer the API
# Format: { type_id: { 'sell': float, 'buy': float, 'fetched_at': float } }
_price_cache = {}
CACHE_TTL_SECONDS = 300  # 5 minutes


def get_price(type_id: int) -> dict | None:
    """
    Fetch the best Jita sell and buy price for a given item type ID.

    Returns:
        { 'sell': float, 'buy': float }  or  None if fetch failed

    Args:
        type_id: EVE item type ID (e.g. 2454 for Hammerhead II)
    """
    now = time.time()

    # Return cached value if still fresh
    if type_id in _price_cache:
        cached = _price_cache[type_id]
        if now - cached["fetched_at"] < CACHE_TTL_SECONDS:
            return {"sell": cached["sell"], "buy": cached["buy"]}

    url = f"{ESI_BASE}/markets/{REGION_THE_FORGE}/orders/"
    params = {
        "type_id": type_id,
        "order_type": "all"
    }

    try:
        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()
        orders = response.json()
    except requests.RequestException as e:
        print(f"  [!] ESI fetch failed for type_id {type_id}: {e}")
        return None

    if not orders:
        return None

    # Separate buy and sell orders
    sell_orders = [o for o in orders if not o["is_buy_order"]]
    buy_orders  = [o for o in orders if o["is_buy_order"]]

    if not sell_orders or not buy_orders:
        return None

    # Best sell = lowest price (cheapest you can buy materials for)
    best_sell = min(o["price"] for o in sell_orders)

    # Best buy  = highest price (most ISK you're guaranteed when selling)
    best_buy  = max(o["price"] for o in buy_orders)

    # Also fetch 7-day history for volume (daily volume entries) to calculate avg daily volume
    # We'll call the history endpoint and compute 7-day avg volume if available.
    history_url = f"{ESI_BASE}/markets/{REGION_THE_FORGE}/history/"
    history_params = {"type_id": type_id}
    avg_daily_volume = None
    try:
        hresp = requests.get(history_url, params=history_params, timeout=10)
        hresp.raise_for_status()
        hist = hresp.json()
        # hist is list of {date, avg, volume, highest, lowest, order_count}
        if hist and isinstance(hist, list):
            volumes = [int(day.get("volume", 0)) for day in hist[:7]]
            if volumes:
                avg_daily_volume = mean(volumes)
    except requests.RequestException:
        # History is optional; ignore failures silently
        avg_daily_volume = None

    result = {"sell": best_sell, "buy": best_buy, "avg_daily_volume": avg_daily_volume}

    # Cache the result
    _price_cache[type_id] = {**result, "fetched_at": now}

    return result


def get_prices_bulk(type_ids: list[int]) -> dict:
    """
    Fetch prices for multiple items. Returns a dict of { type_id: price_dict }.
    Skips items that fail to fetch (they simply won't appear in results).
    """
    results = {}
    for type_id in type_ids:
        price = get_price(type_id)
        if price:
            results[type_id] = price
        # Small delay to be a good API citizen
        time.sleep(0.1)
    return results
