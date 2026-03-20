# CREST
*Capsuleer Resource & Economic Strategy Tool — EVE Online Industry Dashboard*

Personal web app that connects to your EVE accounts via ESI, pulls live Jita market data, and shows manufacturing profitability across all your characters and corp BPs.

**Features**
- Manufacturing calculator — profit, ROI, ISK/hr per blueprint accounting for ME/TE, system cost index, facility bonuses, taxes
- Blueprint Finder — scans ESI public contracts, matches against profitable items, flags already-owned BPs
- Industry jobs — track active jobs across all characters and corp facilities
- Overview — wallet history, PLEX tracker, mineral prices, open orders
- Telegram alerts — background scanner, fires on high-ROI items and below-median BPO contract prices

---

## Requirements

- Python 3.10+
- Node.js 18+
- An EVE developer app at [developers.eveonline.com](https://developers.eveonline.com) (free)
- Optional: a Telegram bot token for alerts

---

## Setup

**1. Clone and install dependencies**
```bash
pip install -r requirements.txt
npm install
```

**2. Create a `.env` file** in the project root:
```
ESI_CLIENT_ID=your_client_id
ESI_CLIENT_SECRET=your_client_secret
ESI_CALLBACK_URL=http://localhost:8080/callback
TELEGRAM_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

`TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID` are optional — alerts simply won't fire if omitted.

**3. Create your EVE app**

Go to [developers.eveonline.com](https://developers.eveonline.com) → Create New Application.
- Connection type: **Authentication & API Access**
- Callback URL: `http://localhost:8080/callback`
- Scopes (minimum required):
  ```
  esi-wallet.read_character_wallet.v1
  esi-characters.read_blueprints.v1
  esi-industry.read_character_jobs.v1
  esi-markets.read_character_orders.v1
  esi-assets.read_assets.v1
  esi-corporations.read_blueprints.v1
  esi-industry.read_corporation_jobs.v1
  ```

**4. Start the servers**
```bash
# Terminal 1 — backend
python server.py

# Terminal 2 — frontend
npx vite --port 3000
```

python seeder.py to populate blueprint_invention

Open [http://localhost:3000](http://localhost:3000), go to **Characters** and add your EVE account(s).

---

## Configuration

Key tunables are at the top of each file:

| File | Setting | Default | Notes |
|---|---|---|---|
| `calculator.py` | `sales_tax` | `0.036` | Accounting L5 = 3.6% |
| `calculator.py` | `broker_fee` | `0.03` | Broker Relations L5 = 3% |
| `alert_scanner.py` | `ROI_THRESHOLD` | `50.0` | Min ROI % for Telegram alert |
| `alert_scanner.py` | `BREAKEVEN_MAX_RUNS` | `1000` | Max breakeven runs for contract alerts |
| `alert_scanner.py` | `ALERT_COOLDOWN_HOURS` | `6` | Re-alert cooldown per deal |

