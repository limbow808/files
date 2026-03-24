import json
import os
import sqlite3


BASE = os.path.dirname(__file__)
crest = sqlite3.connect(os.path.join(BASE, 'crest.db'))
crest.row_factory = sqlite3.Row
sde = sqlite3.connect(os.path.join(BASE, 'sqlite-latest.sqlite'))
sde.row_factory = sqlite3.Row

type_names = {
    row['typeID']: row['typeName']
    for row in sde.execute('SELECT typeID, typeName FROM invTypes')
}

rows = crest.execute(
    'SELECT t2_blueprint_id, t1_blueprint_id FROM blueprint_invention LIMIT 8'
).fetchall()

result = []
for row in rows:
    t1_bp = row['t1_blueprint_id']
    t2_bp = row['t2_blueprint_id']
    skill_rows = sde.execute(
        'SELECT skillID, level FROM industryActivitySkills WHERE activityID = 8 AND typeID = ? ORDER BY skillID',
        (t1_bp,),
    ).fetchall()
    result.append({
        't1_blueprint_id': t1_bp,
        't2_blueprint_id': t2_bp,
        't2_name': crest.execute('SELECT output_name FROM blueprints WHERE blueprint_id = ?', (t2_bp,)).fetchone()['output_name'],
        'skills': [
            {'skill_id': skill['skillID'], 'skill_name': type_names.get(skill['skillID']), 'level': skill['level']}
            for skill in skill_rows
        ],
    })

with open(os.path.join(BASE, 'tmp_inspect_invention_skills.json'), 'w', encoding='utf-8') as fh:
    json.dump(result, fh, indent=2)
