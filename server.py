"""
server.py - CREST Flask API Server
====================================
Exposes CREST data over HTTP for the React dashboard.

Usage:
    python server.py

Endpoints:
    GET /api/scan     - Run a full manufacturing scan and return results
    GET /api/wallet   - Return current wallet balance
    GET /api/plex     - Return PLEX progress data
    GET /api/minerals - Return Jita mineral prices
"""

from flask import Flask, jsonify, send_file
from flask_cors import CORS
import time
import json
import os
import threading

from blueprints import BLUEPRINTS, MINERALS
from calculator import calculate_all
from database import save_scan, record_wallet_snapshot, get_wallet_history

app = Flask(__name__)
CORS(app)  # Allow React dev server (localhost:3000 / file://) to call the API

# ── PLEX config ───────────────────────────────────────────────────────────────
PLEX_CONFIG = {
    "accounts":         6,
    "plex_per_account": 500,
}

# ── In-memory scan cache (avoids re-running a long scan on every page load) ───
_scan_cache: dict = {}
SCAN_CACHE_TTL = 300  # 5 minutes


def _scan_is_fresh() -> bool:
    ts = _scan_cache.get("scanned_at", 0)
    return (time.time() - ts) < SCAN_CACHE_TTL


# ── Helpers ───────────────────────────────────────────────────────────────────
def _get_wallet() -> float:
    """Fetch character wallet balance from ESI."""
    try:
        from assets import get_wallet_balance
        return float(get_wallet_balance())
    except Exception:
        return 0.0


def _get_plex_price(prices: dict) -> float:
    """Return Jita sell price for PLEX (type_id 44992)."""
    try:
        from pricer import get_prices_bulk
        result = get_prices_bulk([44992])
        return result.get(44992, {}).get("sell", 4_300_000)
    except Exception:
        return 4_300_000  # Reasonable fallback


def _mineral_prices(prices: dict) -> dict:
    """Extract mineral prices from a prices dict keyed by type_id."""
    mineral_data = {}
    for name, tid in MINERALS.items():
        entry = prices.get(tid, {})
        mineral_data[name] = {
            "type_id":   tid,
            "sell":      entry.get("sell", 0),
            "buy":       entry.get("buy", 0),
        }
    return mineral_data


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/", methods=["GET"])
def dashboard():
    return send_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard.html"))


@app.route("/api/scan", methods=["GET"])
def api_scan():
    global _scan_cache

    if _scan_is_fresh():
        return jsonify(_scan_cache)

    try:
        results = calculate_all(BLUEPRINTS)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    # Try to add hangar data if ESI token is available
    try:
        from hangar import enrich_results_with_hangar
        from assets import CHARACTER_ID
        from auth import get_auth_header
        results = enrich_results_with_hangar(results, BLUEPRINTS, CHARACTER_ID, get_auth_header())
    except Exception:
        # No ESI token — hangar data will be absent (can_build = None)
        pass

    try:
        save_scan(results)
    except Exception:
        pass

    # Collect all type_ids we need for mineral pricing
    all_type_ids = set(MINERALS.values())
    for r in results:
        for mat in r.get("material_breakdown", []):
            all_type_ids.add(mat["type_id"])

    try:
        from pricer import get_prices_bulk
        prices = get_prices_bulk(list(all_type_ids))
    except Exception:
        prices = {}

    # Strip material_breakdown from results (internal detail – keep payload lean)
    # But save mineral price info first
    for r in results:
        r.pop("material_breakdown", None)

    _scan_cache = {
        "scanned_at": int(time.time()),
        "results":    results,
        "minerals":   _mineral_prices(prices),
    }
    return jsonify(_scan_cache)


@app.route("/api/wallet", methods=["GET"])
def api_wallet():
    balance = _get_wallet()
    return jsonify({"balance": balance})


@app.route("/api/plex", methods=["GET"])
def api_plex():
    balance    = _get_wallet()
    if balance > 0:
        try:
            record_wallet_snapshot(balance)
        except Exception:
            pass
    plex_price = _get_plex_price({})

    accounts         = PLEX_CONFIG["accounts"]
    plex_per_account = PLEX_CONFIG["plex_per_account"]
    monthly_target   = accounts * plex_per_account * plex_price

    # Days remaining: rough estimate — use current day-of-month
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    # Last day of current month
    import calendar
    days_in_month   = calendar.monthrange(now.year, now.month)[1]
    days_remaining  = days_in_month - now.day

    return jsonify({
        "accounts":        accounts,
        "plex_price":      plex_price,
        "plex_per_account":plex_per_account,
        "monthly_target":  monthly_target,
        "current_balance": balance,
        "days_remaining":  days_remaining,
    })


@app.route("/api/wallet/history", methods=["GET"])
def api_wallet_history():
    """Return wallet balance snapshots for the sparkline."""
    try:
        history = get_wallet_history(days=30)
        return jsonify(history)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/minerals", methods=["GET"])
def api_minerals():
    """Return current Jita prices for all 8 minerals."""
    try:
        from pricer import get_prices_bulk
        prices = get_prices_bulk(list(MINERALS.values()))
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    data = {}
    for name, tid in MINERALS.items():
        entry = prices.get(tid, {})
        data[name] = {
            "type_id": tid,
            "sell":    entry.get("sell", 0),
            "buy":     entry.get("buy", 0),
        }
    return jsonify(data)


if __name__ == "__main__":
    # Pre-warm the scan cache in the background so the first dashboard load is instant
    def _prewarm():
        print("  [prewarm] Background scan starting...")
        try:
            with app.app_context():
                from flask import Request
                import werkzeug.test
                client = app.test_client()
                client.get("/api/scan")
            print("  [prewarm] Cache ready.")
        except Exception as e:
            print(f"  [prewarm] Failed: {e}")

    threading.Thread(target=_prewarm, daemon=True).start()

    print()
    print("  ╔══════════════════════════════════════════════════╗")
    print("  ║   CREST  ·  API Server  ·  http://localhost:5000  ║")
    print("  ╚══════════════════════════════════════════════════╝")
    print()
    app.run(host="0.0.0.0", port=5000, debug=False)
