# CREST
*Capsuleer Resource & Economic Strategy Tool — EVE Online Industry Dashboard*

Personal web app that connects to your EVE accounts via ESI, pulls live Jita market data, and shows manufacturing profitability across all your characters and corp BPs.

**Features**
- Industry: profit, ROI, ISK/hr per blueprint accounting for ME/TE, system cost index, facility bonuses, taxes
- Blueprint Finder: scans ESI public contracts, matches against profitable items, flags already-owned BPs
- Industry jobs — track active jobs across all characters and corp facilities
- Overview — wallet history, PLEX tracker, mineral prices, open orders

---

## Project Structure

```
files/
├── backend/            # Python API server + runtime data
│   ├── server.py       # Quart API (port 5001)
│   ├── main.py         # CLI scanner
│   ├── calculator.py   # Profit/ROI engine
│   ├── blueprints.py   # SDE blueprint library
│   ├── pricer.py       # Market price cache (Jita)
│   ├── invention.py    # T2 invention costs
│   ├── scanner.py      # Full market scan orchestrator
│   ├── database.py     # SQLite history & scan storage
│   ├── esi_client.py   # Async ESI HTTP client
│   ├── characters.py   # Multi-character OAuth tokens
│   ├── auth.py         # EVE SSO OAuth2 flow
│   ├── assets.py       # Character assets & wallet
│   ├── hangar.py       # Hangar inventory & buildability
│   ├── alert_scanner.py# Background Telegram alerts
│   ├── contracts_cache.py # Contract cache DB
│   ├── seeder.py       # SDE → crest.db importer
│   ├── *.db, *.json    # Runtime data (gitignored)
│   └── .env            # Secrets (gitignored)
│
├── frontend/           # React + Vite dashboard
│   ├── src/
│   │   ├── App.jsx     # Root component + tab routing
│   │   ├── components/ # Reusable UI components
│   │   ├── pages/      # Tab pages
│   │   ├── hooks/      # Custom React hooks
│   │   ├── utils/      # Formatting helpers
│   │   └── styles/     # CSS (Space Grotesk, EVE theme)
│   ├── fonts/          # Local variable font
│   ├── images/         # Logo assets
│   ├── index.html      # SPA entry point
│   ├── vite.config.js  # Dev server + backend launcher
│   └── package.json
│
├── requirements.txt    # Python dependencies
├── README.md
└── .gitignore
```

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
cd frontend
npm install
```

**2. Create a `.env` file** in `backend/`:
```
ESI_CLIENT_ID=your_client_id
ESI_CLIENT_SECRET=your_client_secret
ESI_CALLBACK_URL=http://localhost:8080/callback
TELEGRAM_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

`TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID` are optional — alerts simply won't fire if omitted.

Note: if VS Code shows `An environment file is configured but terminal environment injection is disabled`, that warning is about VS Code terminal sessions, not CREST itself. This backend reads `backend/.env` directly at startup, so `python server.py` still picks up `TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID` from that file. Enable the VS Code setting `python.terminal.useEnvFile` only if you also want `.env` values injected into new integrated terminal sessions and debug launches.

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

**4. Seed the database** (first time only, re-run to update)
```bash
cd backend
python seeder.py
```

The seeder auto-downloads the EVE SDE from Fuzzwork (~80 MB compressed, ~550 MB uncompressed) and skips the download if it's already up to date. Use `python seeder.py --force` to re-download regardless.

**5. Start the servers**
```bash
# backend (port 5001)
cd backend
python server.py

# frontend (port 3000, auto-proxies /api → backend)
cd frontend
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), go to **Characters** and add your EVE account(s).

---

## Configuration

Key tunables are at the top of each file (in `backend/`):

| File | Setting | Default | Notes |
|---|---|---|---|
| `calculator.py` | `sales_tax` | `0.036` | Accounting L5 = 3.6% |
| `calculator.py` | `broker_fee` | `0.03` | Broker Relations L5 = 3% |
| `alert_scanner.py` | `ROI_THRESHOLD` | `50.0` | Min ROI % for Telegram alert |
| `alert_scanner.py` | `BREAKEVEN_MAX_RUNS` | `1000` | Max breakeven runs for contract alerts |
| `alert_scanner.py` | `ALERT_COOLDOWN_HOURS` | `6` | Re-alert cooldown per deal |

