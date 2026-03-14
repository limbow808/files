"""
characters.py - Multi-character token store for CREST
======================================================
Manages a set of authenticated EVE characters.
Each character has its own OAuth2 token stored in characters.json.

characters.json format:
{
  "2123568748": {
    "character_id":   "2123568748",
    "character_name": "Varggg",
    "portrait_url":   "https://images.evetech.net/characters/2123568748/portrait?size=64",
    "access_token":   "...",
    "refresh_token":  "...",
    "expires_in":     1200,
    "obtained_at":    1710000000
  },
  ...
}
"""

import json
import os
import time
import base64
import threading
import webbrowser
import secrets
import requests
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs, urlencode

# ── Load credentials from .env ────────────────────────────────────────────────
def _load_env():
    env = {}
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    return env

_ENV = _load_env()
CLIENT_ID     = _ENV.get("ESI_CLIENT_ID", "")
CLIENT_SECRET = _ENV.get("ESI_CLIENT_SECRET", "")
REDIRECT_URI  = _ENV.get("ESI_CALLBACK_URL", "http://localhost:8080/callback")

ESI_SSO_URL   = "https://login.eveonline.com/v2/oauth/authorize"
ESI_TOKEN_URL = "https://login.eveonline.com/v2/oauth/token"
ESI_VERIFY    = "https://esi.evetech.net/verify/"
ESI_BASE      = "https://esi.evetech.net/latest"

SCOPES = " ".join([
    "esi-assets.read_assets.v1",
    "esi-wallet.read_character_wallet.v1",
    "esi-industry.read_character_jobs.v1",
    "esi-industry.read_character_mining.v1",
    "esi-characters.read_blueprints.v1",
    "esi-corporations.read_blueprints.v1",
    "esi-skills.read_skills.v1",
    "esi-markets.read_character_orders.v1",
])

CHARS_FILE = os.path.join(os.path.dirname(__file__), "characters.json")

# ── Persistence ───────────────────────────────────────────────────────────────
_lock = threading.RLock()  # Reentrant — load_characters can call _save_characters without deadlock

def load_characters() -> dict:
    """Return dict of character_id → character record."""
    with _lock:
        if os.path.exists(CHARS_FILE):
            with open(CHARS_FILE) as f:
                return json.load(f)
        # Migrate from legacy esi_token.json if present
        return _migrate_legacy()

def _save_characters(chars: dict):
    with _lock:
        with open(CHARS_FILE, "w") as f:
            json.dump(chars, f, indent=2)

def _decode_jwt_payload(token_str: str) -> dict:
    """Decode JWT payload without verification — just to read character ID/name."""
    try:
        parts = token_str.split(".")
        if len(parts) < 2:
            return {}
        # Add padding
        payload = parts[1] + "=" * (4 - len(parts[1]) % 4)
        import base64 as _b64
        decoded = json.loads(_b64.urlsafe_b64decode(payload))
        return decoded
    except Exception:
        return {}


def _migrate_legacy() -> dict:
    """If old single-character esi_token.json exists, import it without any ESI calls."""
    legacy_path = os.path.join(os.path.dirname(__file__), "esi_token.json")
    if not os.path.exists(legacy_path):
        return {}
    try:
        with open(legacy_path) as f:
            token = json.load(f)

        # Decode JWT to get character id/name — no network call needed
        payload   = _decode_jwt_payload(token.get("access_token", ""))
        # EVE JWT subject is "CHARACTER:EVE:<id>"
        sub       = payload.get("sub", "")
        char_id   = sub.split(":")[-1] if ":" in sub else ""
        char_name = payload.get("name", "Unknown")

        if not char_id:
            print("  [characters] Legacy migration: could not parse character ID from JWT")
            return {}

        record = {
            "character_id":   char_id,
            "character_name": char_name,
            "portrait_url":   f"https://images.evetech.net/characters/{char_id}/portrait?size=64",
            "access_token":   token.get("access_token", ""),
            "refresh_token":  token.get("refresh_token", ""),
            "expires_in":     token.get("expires_in", 1200),
            "obtained_at":    token.get("obtained_at", int(time.time())),
        }
        chars = {char_id: record}
        _save_characters(chars)
        print(f"  [characters] Migrated legacy token → {char_name} ({char_id})")
        return chars
    except Exception as e:
        print(f"  [characters] Legacy migration failed: {e}")
        return {}

# ── Token helpers ─────────────────────────────────────────────────────────────
def _auth_header_basic() -> dict:
    credentials = base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
    return {
        "Authorization": f"Basic {credentials}",
        "Content-Type": "application/x-www-form-urlencoded",
    }

def _verify_token(access_token: str) -> dict | None:
    """Verify JWT and return ESI character info dict."""
    try:
        r = requests.get(ESI_VERIFY, headers={"Authorization": f"Bearer {access_token}"}, timeout=10)
        if r.ok:
            return r.json()
    except Exception:
        pass
    return None

def _is_expired(record: dict) -> bool:
    return time.time() >= (record.get("obtained_at", 0) + record.get("expires_in", 1200) - 60)

def _refresh_token(record: dict) -> dict:
    """Refresh a single character's token. Returns updated record."""
    r = requests.post(
        ESI_TOKEN_URL,
        headers=_auth_header_basic(),
        data={"grant_type": "refresh_token", "refresh_token": record["refresh_token"]},
        timeout=15,
    )
    r.raise_for_status()
    new_tok = r.json()
    record = {**record,
              "access_token": new_tok["access_token"],
              "refresh_token": new_tok.get("refresh_token", record["refresh_token"]),
              "expires_in":    new_tok.get("expires_in", 1200),
              "obtained_at":   int(time.time())}
    return record

def get_auth_header(character_id: str) -> dict:
    """Return a valid Bearer auth header for the given character, refreshing if needed."""
    chars = load_characters()
    record = chars.get(str(character_id))
    if not record:
        raise ValueError(f"Character {character_id} not found in store")
    if _is_expired(record):
        record = _refresh_token(record)
        chars[str(character_id)] = record
        _save_characters(chars)
    return {"Authorization": f"Bearer {record['access_token']}"}

def get_all_auth_headers() -> list[dict]:
    """Return list of (character_id, auth_header) for all stored characters."""
    chars = load_characters()
    result = []
    updated = False
    for cid, record in chars.items():
        if _is_expired(record):
            try:
                record = _refresh_token(record)
                chars[cid] = record
                updated = True
            except Exception as e:
                print(f"  [characters] Refresh failed for {record.get('character_name')}: {e}")
                continue
        result.append((cid, {"Authorization": f"Bearer {record['access_token']}"}))
    if updated:
        _save_characters(chars)
    return result

# ── Public character list (safe for API response) ─────────────────────────────
def list_characters() -> list[dict]:
    """Return stored character info instantly — no live ESI calls."""
    chars = load_characters()
    return [
        {
            "character_id":   cid,
            "character_name": rec.get("character_name", "Unknown"),
            "portrait_url":   rec.get("portrait_url", f"https://images.evetech.net/characters/{cid}/portrait?size=64"),
        }
        for cid, rec in chars.items()
    ]


def get_character_stats(character_id: str) -> dict:
    """Fetch live wallet + job stats for a single character (called per-character by frontend)."""
    chars = load_characters()
    cid = str(character_id)
    rec = chars.get(cid)
    if not rec:
        return {"error": "not found"}

    # Refresh token if needed
    if _is_expired(rec):
        try:
            rec = _refresh_token(rec)
            chars[cid] = rec
            _save_characters(chars)
        except Exception as e:
            return {"error": f"token refresh failed: {e}"}

    headers = {"Authorization": f"Bearer {rec['access_token']}"}
    wallet = None
    job_count = None

    try:
        r = requests.get(f"{ESI_BASE}/characters/{cid}/wallet/", headers=headers, timeout=8)
        if r.ok:
            wallet = float(r.json())
    except Exception:
        pass

    try:
        r = requests.get(f"{ESI_BASE}/characters/{cid}/industry/jobs/?include_completed=false",
                         headers=headers, timeout=8)
        if r.ok:
            job_count = len([j for j in r.json() if j.get("status") == "active"])
    except Exception:
        pass

    return {"wallet": wallet, "active_jobs": job_count}

def remove_character(character_id: str) -> bool:
    chars = load_characters()
    cid = str(character_id)
    if cid in chars:
        del chars[cid]
        _save_characters(chars)
        return True
    return False

# ── OAuth2 add-character flow (non-blocking, callback server) ─────────────────
_pending_oauth: dict = {}   # state → threading.Event + result

class _CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404); self.end_headers(); return

        params = parse_qs(parsed.query)
        code   = params.get("code",  [None])[0]
        state  = params.get("state", [None])[0]
        error  = params.get("error", [None])[0]

        entry = _pending_oauth.get(state)
        if not entry:
            self.send_response(400); self.end_headers()
            self.wfile.write(b"Unknown state"); return

        if code:
            entry["code"]  = code
            entry["error"] = None
            html = (b"<html><body style='font-family:monospace;background:#000;color:#c8c8b7;padding:40px'>"
                    b"<h2 style='color:#ff4700'>CREST // Character Added</h2>"
                    b"<p>Authentication successful. You may close this tab.</p>"
                    b"</body></html>")
        else:
            entry["code"]  = None
            entry["error"] = error or "unknown"
            html = b"<html><body>Authentication failed.</body></html>"

        self.send_response(200); self.end_headers(); self.wfile.write(html)
        entry["event"].set()

    def log_message(self, format, *args):
        pass

_callback_server: HTTPServer | None = None
_callback_lock = threading.Lock()

def _ensure_callback_server():
    global _callback_server
    with _callback_lock:
        if _callback_server is None:
            _callback_server = HTTPServer(("localhost", 8080), _CallbackHandler)
            t = threading.Thread(target=_callback_server.serve_forever, daemon=True)
            t.start()

def begin_add_character() -> str:
    """
    Start the OAuth flow. Opens browser to EVE SSO.
    Returns the state token so the caller can poll for completion.
    """
    _ensure_callback_server()
    state = secrets.token_urlsafe(16)
    event = threading.Event()
    _pending_oauth[state] = {"event": event, "code": None, "error": None}

    url = f"{ESI_SSO_URL}?" + urlencode({
        "response_type": "code",
        "redirect_uri":  REDIRECT_URI,
        "client_id":     CLIENT_ID,
        "scope":         SCOPES,
        "state":         state,
    })
    webbrowser.open(url)
    return state

def poll_add_character(state: str, timeout: float = 0.1) -> dict:
    """
    Poll the result of a pending OAuth flow.
    Returns: { "status": "pending"|"done"|"error", "character": {...}|None }
    """
    entry = _pending_oauth.get(state)
    if not entry:
        return {"status": "error", "message": "Unknown state"}

    if not entry["event"].wait(timeout=timeout):
        return {"status": "pending"}

    if entry["error"]:
        del _pending_oauth[state]
        return {"status": "error", "message": entry["error"]}

    # Exchange code for token
    try:
        r = requests.post(
            ESI_TOKEN_URL,
            headers=_auth_header_basic(),
            data={"grant_type": "authorization_code", "code": entry["code"], "redirect_uri": REDIRECT_URI},
            timeout=15,
        )
        r.raise_for_status()
        token = r.json()
        token["obtained_at"] = int(time.time())

        # Verify to get character name/id
        char_info = _verify_token(token["access_token"])
        if not char_info:
            raise ValueError("Could not verify token")

        char_id   = str(char_info["CharacterID"])
        char_name = char_info["CharacterName"]

        record = {
            "character_id":   char_id,
            "character_name": char_name,
            "portrait_url":   f"https://images.evetech.net/characters/{char_id}/portrait?size=64",
            "access_token":   token["access_token"],
            "refresh_token":  token["refresh_token"],
            "expires_in":     token.get("expires_in", 1200),
            "obtained_at":    token["obtained_at"],
        }

        chars = load_characters()
        chars[char_id] = record
        _save_characters(chars)

        del _pending_oauth[state]
        return {
            "status": "done",
            "character": {
                "character_id":   char_id,
                "character_name": char_name,
                "portrait_url":   record["portrait_url"],
            }
        }

    except Exception as e:
        del _pending_oauth[state]
        return {"status": "error", "message": str(e)}
