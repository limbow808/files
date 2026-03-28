"""
auth.py - EVE ESI OAuth2 Authentication
=======================================
Handles login, token storage, and refresh for EVE SSO.

Reads credentials from .env file (never hardcode them).
Create a .env file in your CREST folder with:

    ESI_CLIENT_ID=your_client_id_here
    ESI_CLIENT_SECRET=your_client_secret_here
    ESI_CALLBACK_URL=http://localhost:8080/callback

Steps:
1. Opens browser to EVE SSO login page
2. Handles OAuth2 callback on localhost:8080
3. Stores token in esi_token.json
4. Auto-refreshes token when expired
"""

import webbrowser
import base64
import requests
import json
import os
import time
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

# ─── Load credentials from .env ──────────────────────────────────────────────
def _load_env():
    env = {}
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        raise FileNotFoundError(
            "\n\n  .env file not found!\n"
            "  Create a .env file in your CREST folder with:\n\n"
            "    ESI_CLIENT_ID=your_client_id_here\n"
            "    ESI_CLIENT_SECRET=your_client_secret_here\n"
            "    ESI_CALLBACK_URL=http://localhost:8080/callback\n"
        )
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                env[key.strip()] = val.strip()
    return env

_ENV = _load_env()

CLIENT_ID     = _ENV.get("ESI_CLIENT_ID", "")
CLIENT_SECRET = _ENV.get("ESI_CLIENT_SECRET", "")
REDIRECT_URI  = _ENV.get("ESI_CALLBACK_URL", "http://localhost:8080/callback")

if not CLIENT_ID or not CLIENT_SECRET:
    raise ValueError("ESI_CLIENT_ID and ESI_CLIENT_SECRET must be set in your .env file")

# ─── Constants ────────────────────────────────────────────────────────────────
ESI_SSO_URL   = "https://login.eveonline.com/v2/oauth/authorize"
ESI_TOKEN_URL = "https://login.eveonline.com/v2/oauth/token"
TOKEN_FILE    = os.path.join(os.path.dirname(__file__), "esi_token.json")

SCOPES = " ".join([
    "esi-assets.read_assets.v1",
    "esi-assets.read_corporation_assets.v1",
    "esi-wallet.read_character_wallet.v1",
    "esi-wallet.read_corporation_wallets.v1",
    "esi-industry.read_character_jobs.v1",
    "esi-industry.read_character_mining.v1",
    "esi-industry.read_corporation_jobs.v1",
    "esi-characters.read_blueprints.v1",
    "esi-corporations.read_blueprints.v1",
    "esi-skills.read_skills.v1",
    "esi-markets.read_character_orders.v1",
])


def _format_sso_error(error: str | None, description: str | None = None) -> str:
    error_code = str(error or "unknown").strip() or "unknown"
    detail = str(description or "").strip()
    if error_code == "invalid_scope":
        requested_scope = None
        for scope_name in (
            "esi-wallet.read_corporation_wallets.v1",
            "esi-assets.read_corporation_assets.v1",
            "esi-corporations.read_blueprints.v1",
            "esi-industry.read_corporation_jobs.v1",
        ):
            if scope_name in detail:
                requested_scope = scope_name
                break
        if requested_scope:
            guidance = (
                f"Enable {requested_scope} on your EVE developer app at developers.eveonline.com, "
                "save the application, then retry the login."
            )
        else:
            guidance = (
                "Enable the requested scope on your EVE developer app at developers.eveonline.com, "
                "save the application, then retry the login."
            )
        return f"{error_code}: {detail}. {guidance}" if detail else f"{error_code}. {guidance}"
    return f"{error_code}: {detail}" if detail else error_code

# ─── OAuth2 callback server ───────────────────────────────────────────────────
class _CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/callback":
            params = parse_qs(parsed.query)
            code     = params.get("code",  [None])[0]
            error    = params.get("error", [None])[0]
            error_description = params.get("error_description", [None])[0]
            returned_state = params.get("state", [None])[0]

            # Verify state matches to prevent CSRF
            if returned_state != getattr(self.server, "expected_state", None):
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"State mismatch - possible CSRF. Try again.")
                self.server.auth_error = "state_mismatch"
                return
            if code:
                self.server.auth_code = code
                self.send_response(200)
                self.end_headers()
                self.wfile.write(
                    b"<html><body style='font-family:monospace;background:#000;color:#c8c8b7;padding:40px'>"
                    b"<h2 style='color:#ff4700'>CREST // Authentication Successful</h2>"
                    b"<p>You may close this window and return to your terminal.</p>"
                    b"</body></html>"
                )
            else:
                self.server.auth_code = None
                self.server.auth_error = _format_sso_error(error, error_description)
                self.send_response(400)
                self.end_headers()
                self.wfile.write(("Authentication failed: " + self.server.auth_error).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress noisy HTTP logs


def _get_auth_code() -> str:
    """Open browser to EVE SSO, wait for callback, return auth code."""
    import secrets
    from urllib.parse import urlencode

    state = secrets.token_urlsafe(16)  # Random string EVE SSO echoes back for CSRF protection

    params = urlencode({
        "response_type": "code",
        "redirect_uri":  REDIRECT_URI,
        "client_id":     CLIENT_ID,
        "scope":         SCOPES,
        "state":         state,
    })
    url = f"{ESI_SSO_URL}?{params}"

    server = HTTPServer(("localhost", 8080), _CallbackHandler)
    server.auth_code = None
    server.auth_error = None
    server.expected_state = state

    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    print("\n  Opening EVE SSO login in your browser...")
    print("  If it doesn't open, visit this URL manually:")
    print(f"  {url}\n")
    webbrowser.open(url)

    # Wait for callback (timeout after 5 minutes)
    timeout = time.time() + 300
    while server.auth_code is None and server.auth_error is None:
        if time.time() > timeout:
            server.shutdown()
            raise TimeoutError("Login timed out after 5 minutes.")
        time.sleep(0.1)

    server.shutdown()

    if server.auth_error:
        raise RuntimeError(f"EVE SSO returned error: {server.auth_error}")

    return server.auth_code


# ─── Token exchange and refresh ───────────────────────────────────────────────
def _auth_header() -> dict:
    """EVE SSO requires credentials as Base64-encoded Authorization header."""
    credentials = base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
    return {
        "Authorization": f"Basic {credentials}",
        "Content-Type": "application/x-www-form-urlencoded",
    }


def _exchange_code(code: str) -> dict:
    resp = requests.post(
        ESI_TOKEN_URL,
        headers=_auth_header(),
        data={"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI},
    )
    if not resp.ok:
        try:
            payload = resp.json()
        except ValueError:
            print("EVE raw:", resp.text[:300])
        else:
            print("EVE error:", payload)
            raise RuntimeError(_format_sso_error(payload.get("error"), payload.get("error_description")))
    resp.raise_for_status()
    token = resp.json()
    token["obtained_at"] = int(time.time())
    return token


def _do_refresh(refresh_tok: str) -> dict:
    resp = requests.post(
        ESI_TOKEN_URL,
        headers=_auth_header(),
        data={"grant_type": "refresh_token", "refresh_token": refresh_tok},
    )
    if not resp.ok:
        try:
            payload = resp.json()
            raise RuntimeError(_format_sso_error(payload.get("error"), payload.get("error_description")))
        except ValueError:
            pass
    resp.raise_for_status()
    token = resp.json()
    token["obtained_at"] = int(time.time())
    return token


# ─── Token persistence ────────────────────────────────────────────────────────
def _save_token(token: dict):
    with open(TOKEN_FILE, "w") as f:
        json.dump(token, f, indent=2)


def _load_token() -> dict | None:
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            return json.load(f)
    return None


def _is_expired(token: dict) -> bool:
    """Return True if the access token is expired (or expires within 60s)."""
    obtained_at = token.get("obtained_at", 0)
    expires_in  = token.get("expires_in", 1200)   # ESI tokens are 20 min by default
    return time.time() >= (obtained_at + expires_in - 60)


# ─── Public interface ─────────────────────────────────────────────────────────
def authenticate() -> dict:
    """
    Return a valid token dict with access_token ready to use.
    - Loads from disk if available
    - Refreshes automatically if expired
    - Runs full login flow if no token exists
    """
    token = _load_token()

    if token:
        if _is_expired(token):
            print("  Token expired — refreshing...")
            try:
                token = _do_refresh(token["refresh_token"])
                _save_token(token)
                print("  Token refreshed successfully.\n")
            except Exception as e:
                print(f"  Refresh failed ({e}), re-authenticating...")
                token = None

    if not token:
        code  = _get_auth_code()
        token = _exchange_code(code)
        _save_token(token)
        print("  Token saved. You won't need to log in again until the refresh token expires.\n")

    return token


def get_auth_header() -> dict:
    """Convenience: returns the Authorization header dict for ESI requests."""
    token = authenticate()
    return {"Authorization": f"Bearer {token['access_token']}"}


if __name__ == "__main__":
    token = authenticate()
    print("Access token obtained successfully.")
    print(f"Expires in: {token.get('expires_in', '?')}s")