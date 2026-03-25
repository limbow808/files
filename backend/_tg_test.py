import os, requests, sys

env = {}
with open(os.path.join(os.path.dirname(__file__), '.env')) as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, _, v = line.partition('=')
            env[k.strip()] = v.strip()

token   = env.get('TELEGRAM_TOKEN', '')
chat_id = env.get('TELEGRAM_CHAT_ID', '')

print(f"token_prefix  : {token[:10]}...")
print(f"token_length  : {len(token)}")
print(f"chat_id       : {chat_id!r}")
print()

# Test 1: auth (getMe)
me = requests.get(f'https://api.telegram.org/bot{token}/getMe', timeout=10)
print(f"[getMe] status={me.status_code}")
try:
    j = me.json()
    if j.get('ok'):
        print(f"[getMe] bot username = @{j['result']['username']}")
    else:
        print(f"[getMe] error: {j.get('description', me.text[:200])}")
except Exception as e:
    print(f"[getMe] parse error: {e}, raw: {me.text[:200]}")

print()

# Test 2: send a test message
resp = requests.post(
    f'https://api.telegram.org/bot{token}/sendMessage',
    json={'chat_id': chat_id, 'text': 'CREST: Telegram connectivity test ✅', 'parse_mode': 'HTML'},
    timeout=10,
)
print(f"[sendMessage] status={resp.status_code}")
try:
    j = resp.json()
    if j.get('ok'):
        print(f"[sendMessage] SUCCESS — message_id={j['result']['message_id']}")
    else:
        print(f"[sendMessage] FAILED — {j.get('description', resp.text[:300])}")
        print(f"[sendMessage] error_code={j.get('error_code')}")
except Exception as e:
    print(f"[sendMessage] parse error: {e}, raw: {resp.text[:300]}")
