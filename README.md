# CREST
### Capsuleer Resource & Economic Strategy Tool
*EVE Online Industry Intelligence System*

---

## Quick Start

```bash
# 1. Install dependencies (only needed once)
pip install -r requirements.txt

# 2. Run a full market scan
python main.py

# 3. Check a single item by type ID
python main.py --item 2454

# 4. Show top 20 opportunities
python main.py --top 20
```

---

## Project Structure

```
crest/
├── main.py          ← Entry point, run this
├── pricer.py        ← Fetches live Jita prices from ESI API
├── blueprints.py    ← YOUR blueprint library (edit this constantly)
├── calculator.py    ← Profit margin engine
├── scanner.py       ← Formats and displays results
└── requirements.txt ← Python dependencies
```

---

## First Thing To Do After Running

1. Check the top item's profit number against what you see in-game
2. In EVE: open Market → search the output item → check buy orders
3. Open Industry window → check the material costs for that blueprint
4. If numbers don't match, the most common causes are:
   - Wrong ME level in `blueprints.py`
   - Wrong `system_cost_index` in `calculator.py`
   - Blueprint has T2 components not yet added to `blueprints.py`

---

## How To Expand CREST (Build Phases)

### Phase 2 — More Blueprints *(do this now)*
Add every blueprint you own to `blueprints.py`.
Find type IDs at: https://www.fuzzwork.co.uk/api/typeid.php?typename=Item+Name
Update `me_level` for each to match your researched BPOs.

### Phase 3 — Database (Week 1)
Store results over time so you can see margin trends.
Prompt to use:
> "Add a SQLite database to CREST that saves each scan's results with a timestamp.
> Create a new file database.py. After each scan in scanner.py, save all results
> to the database. Add a --history flag to main.py that shows the last 7 days of
> top items and whether margins have been trending up or down."

### Phase 4 — Trade Velocity Filter (Week 1)
High margin means nothing if an item sells once a month.
Prompt to use:
> "Add trade volume data to CREST. The ESI endpoint
> /markets/{region_id}/history/?type_id={type_id} returns daily trade volume.
> In pricer.py, also fetch the 7-day average daily volume for each item.
> In scanner.py, add a VOLUME column to the table and add a --min-volume flag
> that filters out items trading below a threshold per day."

### Phase 5 — Character Authentication (Week 2)
Connect your actual EVE accounts so CREST knows your real assets.
Prompt to use:
> "Add EVE ESI OAuth2 authentication to CREST. Create a new file auth.py that:
> 1. Opens a browser to the EVE SSO login page
> 2. Handles the OAuth2 callback on localhost
> 3. Stores the access token securely in a local file
> 4. Refreshes the token automatically when it expires
> Then create assets.py that uses the token to fetch my character's
> wallet balance, items in hangar (by type_id and quantity), and
> active industry jobs."

### Phase 6 — Smart Filters (Week 2)
Filter by what you can actually build right now.
Prompt to use:
> "Using the assets from assets.py, add a --buildable flag to scanner.py that
> only shows blueprints where I have all required materials in my hangar.
> Also add a --budget flag that shows what I could build if I spent X ISK
> buying missing materials at Jita sell prices."

### Phase 7 — Telegram Bot (Week 3)
Get your morning digest on your iPhone.
Prompt to use:
> "Create a Telegram bot for CREST. Create bot.py using the python-telegram-bot
> library. The bot should:
> 1. Send a morning digest at 8am with the top 5 manufacturing opportunities
> 2. Respond to /top command with current top 10
> 3. Respond to /plex command showing how many days until I can PLEX at
>    current ISK/day rate (read from database.py history)
> 4. Alert me if PLEX price drops below 4M ISK
> Store the bot token in a .env file, never hardcode it."

---

## Useful Resources

| Resource | URL | Use For |
|---|---|---|
| Fuzzwork Type ID lookup | fuzzwork.co.uk/api/ | Finding type IDs |
| Fuzzwork Industry | fuzzwork.co.uk/industry/ | System Cost Index lookup |
| Adam4Eve | adam4eve.eu/manu_rank.php | Weekly profitability rankings |
| Ravworks | ravworks.com | Full production tree calculator |
| ESI API docs | esi.evetech.net/ui/ | API reference |
| EVERef | everef.net | Item database |

---

## Key Numbers To Keep Updated

| Setting | File | Where To Find It |
|---|---|---|
| `system_cost_index` | calculator.py | fuzzwork.co.uk/industry/ → your system |
| `sales_tax` | calculator.py | In-game: 8% base, -0.4% per Accounting level |
| `broker_fee` | calculator.py | In-game: 3% base, reduced by Broker Relations |
| `structure_me_bonus` | calculator.py | Ask E-UNI what bonus their structures give |
| `me_level` per blueprint | blueprints.py | Check each BPO in your in-game industry window |
