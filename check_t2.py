import sqlite3

con = sqlite3.connect('crest.db')
cur = con.cursor()

# Check if there's a market_cache with datacore prices we can reference
# Also confirm output_ids match what we found
for name in ['Hammerhead II', 'Hobgoblin II', 'Warrior II', 'Damage Control II']:
    cur.execute("SELECT output_name, blueprint_id, output_id, tech_level FROM blueprints WHERE output_name=?", (name,))
    print(cur.fetchone())

# Check blueprints.py to see how tech/name fields are named when loaded
con.close()

import blueprints as bp_mod
bps = bp_mod.load_blueprints()
t2 = [b for b in bps if b.get('tech') == 'II']
print(f"\nTotal T2 blueprints loaded: {len(t2)}")
sample = [b for b in t2 if b['name'] in ['Hammerhead II','Hobgoblin II','Warrior II','Damage Control II']]
for b in sample:
    print(b['name'], 'output_id:', b['output_id'], 'tech:', b.get('tech'))
