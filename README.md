# CREST
*Capsuleer Resource & Economic Strategy Tool — EVE Online Industry Dashboard*

Personal web app that connects to your EVE accounts via ESI, pulls live Jita market data, and shows manufacturing profitability across all your characters and corp BPs.

**Features**
- Manufacturing calculator — profit, ROI, ISK/hr per blueprint accounting for ME/TE, system cost index, facility bonuses, taxes
- Blueprint Finder — scans ESI public contracts, matches against profitable items, flags already-owned BPs
- Industry jobs — active jobs across all characters and corp facilities
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


---

## What is CREST?

CREST is a personal EVE Online industry dashboard. It connects to your EVE accounts via ESI OAuth2, pulls live Jita market data, and tells you exactly what to build, what to buy, and what's worth your time — all in one place running locally on your machine.

It started as a command-line profit scanner and has grown into a full web app with a React frontend and a Flask backend.

---

## What it can do

| Feature | Description |
|---|---|
| **Manufacturing Calculator** | Calculates net profit, ROI, and ISK/hr for every blueprint in your corp and character hangars. Accounts for ME/TE research, system cost index, structure bonuses, sales tax, and broker fees. |
| **Live Jita Prices** | Bulk-fetches the entire Forge market order book once every 5 minutes and answers all price queries from a local SQLite cache — no per-item API spam. |
| **Blueprint Finder** | Scans thousands of live ESI public contracts and matches them against your known blueprints. Shows contract price, ME/TE, profit stats, and flags BPOs you already own. |
| **Industry Jobs (CREST tab)** | Pulls active manufacturing, research, copying, invention, and reaction jobs for all connected characters, including corp facility jobs. Filter by activity type. |
| **Characters** | Connect multiple EVE characters via OAuth2. Tokens are stored locally and auto-refreshed. All scans and jobs are aggregated across all connected accounts. |
| **Overview** | Wallet balance, wealth history chart, PLEX progress tracker, mineral prices, and open market orders across all characters. |
| **Telegram Alerts** | Background scanner that fires Telegram messages when a blueprint hits ≥ 50% ROI, or when a BPO contract appears at ≥ 50% below its median market price. |

---

## How it works

```
┌─────────────────────────────────────────────────────┐
│                   React Frontend                    │
│   Overview · Calculator · BP Finder · CREST · Chars │
│              runs on localhost:3000                  │
└───────────────────┬─────────────────────────────────┘
                    │ HTTP (fetch)
┌───────────────────▼─────────────────────────────────┐
│                  Flask Backend                      │
│              server.py · port 5001                   │
│                                                     │
│  /api/calculator  → profit engine (calculator.py)   │
│  /api/bpo_market_scan → ESI contract scanner        │
│  /api/industry/jobs  → char + corp job aggregator   │
│  /api/wallet, /api/orders, /api/minerals, …         │
└──────┬────────────────────────┬────────────────────┘
       │                        │
┌──────▼──────┐        ┌────────▼────────┐
│  ESI API    │        │  SQLite Cache   │
│ evetech.net │        │ market_cache.db │
│             │        │ crest_history.db│
│ Market data │        │ crest.db        │
│ Auth tokens │        │ (blueprints,    │
│ Corp/char   │        │  scan history,  │
│ assets/jobs │        │  wallet snaps)  │
└─────────────┘        └─────────────────┘
```

**Data flow for the Calculator:**
1. Backend loads all blueprints from `crest.db` (SDE-sourced)
2. Fetches your characters' actual ME/TE levels via ESI blueprints endpoint
3. Pulls the full Jita order book in one bulk request, caches in SQLite
4. Calculates profit for every blueprint: revenue (buy price) − materials (sell price) − job cost − tax − broker fee
5. Returns sorted results; frontend renders with dynamic ROI colour scaling

**Data flow for Telegram Alerts:**
- ROI scanner runs every 30 min — reads the live calc cache, fires an alert per blueprint above the threshold
- Contract scanner runs every hour — fetches ESI contracts, compares each BPO price to the median of all current listings, fires when a listing is ≥ 50% below median
- Each deal has a 6-hour cooldown so you don't get spammed

---

## Project Structure

```
files/
├── server.py          ← Flask API server (all endpoints)
├── calculator.py      ← Profit margin engine
├── pricer.py          ← Jita market data fetcher + SQLite cache
├── blueprints.py      ← Blueprint loader (reads from crest.db)
├── characters.py      ← Multi-character OAuth2 token management
├── auth.py            ← ESI OAuth2 flow
├── alert_scanner.py   ← Background Telegram alert scanner
├── database.py        ← Wallet/wealth history persistence
├── scanner.py         ← CLI scan formatter (legacy)
├── hangar.py          ← ESI hangar/assets helpers
├── assets.py          ← Character asset fetching
├── .env               ← Secrets (gitignored) — ESI + Telegram credentials
├── .env.example       ← Template for the above
├── crest.db           ← Blueprint library + scan history (SQLite)
├── market_cache.db    ← Jita order book cache (SQLite, auto-rebuilt)
├── crest_history.db   ← Wallet snapshots (SQLite)
└── src/               ← React frontend (Vite)
    ├── pages/
    │   ├── OverviewPage.jsx
    │   ├── CalculatorPage.jsx
    │   ├── BpFinderPage.jsx
    │   └── CharactersPage.jsx
    └── components/    ← ManufacturingJobs, BpFinderPanel, KPIBar, …
```

---

## Quick Start

```bash
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. Copy the env template and fill in your credentials
cp .env.example .env

# 3. Start the backend
python server.py

# 4. In a second terminal, start the frontend
npx vite --port 3000

# 5. Open http://localhost:3000
#    Go to Characters tab → Add Character to connect your EVE accounts
```

---

## Configuration

Secrets live in `.env` (never committed):

```
ESI_CLIENT_ID=...
ESI_CLIENT_SECRET=...
ESI_CALLBACK_URL=http://localhost:8080/callback
TELEGRAM_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Key tunable values in `calculator.py`:

| Setting | Default | What it controls |
|---|---|---|
| `system_cost_index` | `0.0714` | Manufacturing system SCI — find yours at fuzzwork.co.uk/industry/ |
| `sales_tax` | `0.036` | 8% base reduced by Accounting skill (L5 = 3.6%) |
| `broker_fee` | `0.03` | 3% base, reduced by Broker Relations skill |
| `structure_me_bonus` | `0.01` | Structure ME reduction (1% for E-UNI Engineering Complex) |

Alert thresholds in `alert_scanner.py`:

| Setting | Default | What it controls |
|---|---|---|
| `ROI_THRESHOLD` | `50.0` | Min ROI % to trigger a Telegram alert |
| `CHEAP_THRESHOLD` | `0.50` | Contract price must be ≤ 50% of median to alert |
| `MIN_NET_PROFIT` | `5,000,000` | Min net profit in ISK to bother alerting |
| `ALERT_COOLDOWN_HOURS` | `6` | Hours before re-alerting the same deal |

---

## Useful Resources

| Resource | URL |
|---|---|
| ESI API docs | esi.evetech.net/ui/ |
| Fuzzwork Industry (SCI lookup) | fuzzwork.co.uk/industry/ |
| Fuzzwork Type ID lookup | fuzzwork.co.uk/api/ |
| Adam4Eve profitability rankings | adam4eve.eu/manu_rank.php |
| Ravworks production planner | ravworks.com |
| EVERef item database | everef.net |
