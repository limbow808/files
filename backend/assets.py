"""
assets.py - EVE Character Assets, Wallet, and Jobs
=======================================================
Uses ESI OAuth2 token to retrieve:
- Wallet balance
- Hangar assets (type_id, quantity)
- Active industry jobs
"""

import requests
import auth

ESI_BASE = "https://esi.evetech.net/latest"


def _primary_character_id() -> str:
    """Return the first character ID from characters.json, falling back to the
    legacy hardcoded ID so CLI tools (main.py, scanner.py) never break."""
    try:
        from characters import load_characters
        chars = load_characters()
        if chars:
            return next(iter(chars))
    except Exception:
        pass
    return "2123568748"


# Module-level convenience — resolves at import time; use _primary_character_id()
# when you need the current value after characters may have been added.
CHARACTER_ID = _primary_character_id()


def get_auth_header():
    token = auth.authenticate()
    return {"Authorization": f"Bearer {token['access_token']}"}


def get_wallet_balance():
    url = f"{ESI_BASE}/characters/{CHARACTER_ID}/wallet/"
    headers = get_auth_header()
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    return response.json()


def get_assets():
    url = f"{ESI_BASE}/characters/{CHARACTER_ID}/assets/"
    headers = get_auth_header()
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    return response.json()


def get_industry_jobs():
    url = f"{ESI_BASE}/characters/{CHARACTER_ID}/industry/jobs/"
    headers = get_auth_header()
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    return response.json()

if __name__ == "__main__":
    print("Wallet balance:", get_wallet_balance())
    print("Assets:", get_assets())
    print("Industry jobs:", get_industry_jobs())
