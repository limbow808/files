"""
queue_notifier.py - Telegram notifications for industry job queues
================================================================
Monitors authenticated character industry jobs and sends Telegram messages:

  1. A 5-minute warning when a job is about to finish.
  2. A completion notice when a job is ready to deliver.

Configuration:
    TELEGRAM_TOKEN      - bot token from @BotFather
    TELEGRAM_CHAT_ID    - your personal / group chat ID
    JOB_SCAN_INTERVAL   - seconds between industry job checks (default 300)
"""

import os
import threading
import time

import requests


def _load_env_file() -> None:
    """Load backend/.env into os.environ if it exists."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, _, value = stripped.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def _env_int(name: str, default: int) -> int:
    try:
        raw_value = str(os.environ.get(name, default)).strip()
        return int(raw_value or default)
    except Exception:
        return int(default)


_load_env_file()


CONFIG = {
    "TELEGRAM_TOKEN": os.environ.get("TELEGRAM_TOKEN", ""),
    "TELEGRAM_CHAT_ID": os.environ.get("TELEGRAM_CHAT_ID", ""),
    "JOB_SCAN_INTERVAL": _env_int("JOB_SCAN_INTERVAL", 300),
}


_warned_5min: set = set()
_warned_done: set = set()


status = {
    "running": False,
    "last_job_scan": None,
    "last_alert_sent": None,
    "alerts_sent": 0,
    "last_error": None,
}


def validate_telegram_config(token: str | None = None, chat_id: str | None = None) -> str | None:
    """Return a human-readable config error, or None when config looks sane."""
    token = CONFIG["TELEGRAM_TOKEN"] if token is None else str(token).strip()
    chat_id = CONFIG["TELEGRAM_CHAT_ID"] if chat_id is None else str(chat_id).strip()

    if not token:
        return "Telegram bot token is missing. Paste the full token from @BotFather."
    if any(char.isspace() for char in token):
        return "Telegram bot token cannot contain whitespace."
    if "*" in token:
        return "Telegram bot token looks masked. Paste the full token from @BotFather before saving."
    if token.count(":") != 1:
        return "Telegram bot token is invalid. Expected format like 123456789:ABCdef..."

    token_id, token_secret = token.split(":", 1)
    if not token_id.isdigit() or len(token_secret) < 10:
        return "Telegram bot token is invalid. Expected format like 123456789:ABCdef..."

    if not chat_id:
        return "Telegram chat ID is missing."
    if any(char.isspace() for char in chat_id):
        return "Telegram chat ID cannot contain whitespace."
    return None


def _tg_send(text: str) -> bool:
    """Send a message to the configured Telegram chat. Returns True on success."""
    token = CONFIG["TELEGRAM_TOKEN"]
    chat_id = CONFIG["TELEGRAM_CHAT_ID"]
    config_error = validate_telegram_config(token=token, chat_id=chat_id)
    if config_error:
        status["last_error"] = config_error
        print(f"  [queue-notifier] {config_error}")
        return False

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        response = requests.post(
            url,
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            timeout=10,
        )
        payload = response.json() if response.content else {}
        ok = response.ok and payload.get("ok")
        if not ok:
            description = payload.get("description") or response.text[:200]
            status["last_error"] = f"Telegram send failed: {description}"
            print(f"  [queue-notifier] Telegram error: {description}")
        else:
            status["last_error"] = None
        return bool(ok)
    except Exception as exc:
        status["last_error"] = f"Telegram send failed: {exc}"
        print(f"  [queue-notifier] Telegram send failed: {exc}")
        return False


def get_public_config() -> dict:
    """Return a copy of CONFIG suitable for the UI. Token is partially masked."""
    token = CONFIG.get("TELEGRAM_TOKEN", "")
    masked = (token[:4] + "*" * max(0, len(token) - 4)) if len(token) > 4 else ("*" * len(token))
    return {
        "TELEGRAM_TOKEN": masked,
        "TELEGRAM_CHAT_ID": CONFIG.get("TELEGRAM_CHAT_ID", ""),
        "JOB_SCAN_INTERVAL": CONFIG.get("JOB_SCAN_INTERVAL"),
    }


_NUMERIC_KEYS = {"JOB_SCAN_INTERVAL"}
_ALLOWED_KEYS = _NUMERIC_KEYS | {"TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID"}


def update_config(updates: dict) -> None:
    """Apply validated updates to the in-memory CONFIG dict immediately."""
    for key, value in updates.items():
        if key not in _ALLOWED_KEYS:
            continue
        if key in _NUMERIC_KEYS:
            CONFIG[key] = int(value)
        else:
            CONFIG[key] = str(value).strip()


def _run_job_scan() -> None:
    """
    Poll industry jobs for all characters and emit Telegram notifications for:
      - jobs finishing within five minutes
      - jobs ready to deliver
    """
    try:
        from concurrent.futures import ThreadPoolExecutor, as_completed as _as_completed
        from datetime import datetime, timezone

        from characters import get_all_auth_headers, load_characters
        import requests as _req

        char_records = load_characters()
        auth_headers = get_all_auth_headers()
        if not auth_headers:
            return

        activity_names = {
            1: "Manufacturing",
            3: "TE Research",
            4: "ME Research",
            5: "Copying",
            8: "Invention",
            9: "Reactions",
            11: "Reaction",
        }

        def _fetch(character_id, headers):
            char_name = char_records.get(character_id, {}).get("character_name", f"Char {character_id}")
            jobs = []
            try:
                response = _req.get(
                    f"https://esi.evetech.net/latest/characters/{character_id}/industry/jobs/",
                    headers=headers,
                    params={"include_completed": False},
                    timeout=15,
                )
                if response.ok:
                    for job in response.json():
                        job["_char_name"] = char_name
                        jobs.append(job)
            except Exception as exc:
                print(f"  [queue-notifier] Fetch failed for {char_name}: {exc}")
            return jobs

        all_jobs = []
        seen_ids: set = set()
        with ThreadPoolExecutor(max_workers=max(1, len(auth_headers))) as pool:
            futures = [pool.submit(_fetch, char_id, headers) for char_id, headers in auth_headers]
            for future in _as_completed(futures):
                for job in future.result():
                    job_id = job.get("job_id")
                    if job_id and job_id not in seen_ids:
                        seen_ids.add(job_id)
                        all_jobs.append(job)

        if not all_jobs:
            return

        product_ids = list({job.get("product_type_id") for job in all_jobs if job.get("product_type_id")})
        names: dict = {}
        if product_ids:
            try:
                for index in range(0, len(product_ids), 1000):
                    name_response = _req.post(
                        "https://esi.evetech.net/latest/universe/names/",
                        json=product_ids[index:index + 1000],
                        timeout=10,
                    )
                    if name_response.ok:
                        for item in name_response.json():
                            names[item["id"]] = item["name"]
            except Exception:
                pass

        now = time.time()
        for job in all_jobs:
            job_id = job.get("job_id")
            product_id = job.get("product_type_id")
            runs = job.get("runs", 1)
            job_status = job.get("status", "")
            activity = activity_names.get(job.get("activity_id"), "Job")
            char_name = job.get("_char_name", "?")
            name = names.get(product_id, f"Type {product_id}") if product_id else "Unknown"

            end_ts = 0
            end_str = job.get("end_date", "")
            if end_str:
                try:
                    dt_value = datetime.strptime(end_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                    end_ts = dt_value.timestamp()
                except Exception:
                    pass

            secs_left = end_ts - now

            if 0 < secs_left <= 300 and job_id not in _warned_5min:
                _warned_5min.add(job_id)
                mins = max(1, int(secs_left / 60))
                message = (
                    f"<b>{activity} finishing soon!</b>\n"
                    f"{name} x{runs}\n"
                    f"<i>{char_name}</i>  |  ~{mins} min left"
                )
                if _tg_send(message):
                    status["alerts_sent"] += 1
                    status["last_alert_sent"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    print(f"  [queue-notifier] 5-min warning: {name} x{runs} ({char_name})")

            if job_status == "ready" and job_id not in _warned_done:
                _warned_done.add(job_id)
                message = (
                    f"<b>{activity} complete!</b>\n"
                    f"{name} x{runs}\n"
                    f"<i>{char_name}</i>  |  Ready to deliver"
                )
                if _tg_send(message):
                    status["alerts_sent"] += 1
                    status["last_alert_sent"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    print(f"  [queue-notifier] Completed: {name} x{runs} ({char_name})")

    except Exception as exc:
        status["last_error"] = str(exc)
        print(f"  [queue-notifier] Error: {exc}")


def start_queue_notifier() -> None:
    """Start the background queue notification thread."""
    status["running"] = True

    def job_loop() -> None:
        time.sleep(30)
        while True:
            _run_job_scan()
            status["last_job_scan"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            time.sleep(CONFIG["JOB_SCAN_INTERVAL"])

    threading.Thread(target=job_loop, daemon=True, name="queue-notifier").start()
    print("  [queue-notifier] Background queue notifier started.")
    print(f"  [queue-notifier] Polling every {CONFIG['JOB_SCAN_INTERVAL']}s")