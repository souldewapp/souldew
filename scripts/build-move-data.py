"""Move types/power/damage class for the in-battle type helper (shared/data/moves.json).

Usage: python3 scripts/build-move-data.py <pokeapi data/v2/csv dir> shared/data/moves.json

PokeAPI's moves.csv holds the newest values; move_changelog.csv lists the OLD values a move had
before the version group in `changed_in_version_group_id`. Walking those changes from newest to
oldest gives every generation's values (Bite: Normal in Gen 1, Dark from Gen 2 …).
"""
import csv, json, os, sys

CSV, OUT = sys.argv[1], sys.argv[2]
MAX_MOVE = 559  # Gen 5
GENS = range(1, 6)
# version group id -> generation (PokeAPI version_groups.csv)
VG_GEN = {1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 3, 8: 4, 9: 4, 10: 4, 11: 5, 12: 3, 13: 3, 14: 5}


def rows(name):
    with open(os.path.join(CSV, name + '.csv'), newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


types = {int(r['id']): r['identifier'] for r in rows('types')}
classes = {1: 'status', 2: 'physical', 3: 'special'}
cur = {}
for r in rows('moves'):
    i = int(r['id'])
    if i > MAX_MOVE:
        continue
    cur[i] = {'type': types[int(r['type_id'])], 'power': int(r['power'] or 0), 'cls': classes.get(int(r['damage_class_id'] or 1), 'status')}

changes = sorted(
    (r for r in rows('move_changelog') if int(r['move_id']) <= MAX_MOVE),
    key=lambda r: VG_GEN.get(int(r['changed_in_version_group_id']), 9), reverse=True)

by_gen = {}
for g in GENS:
    diff = {}
    for i, m in cur.items():
        t, p = m['type'], m['power']
        for r in changes:
            if int(r['move_id']) != i or VG_GEN.get(int(r['changed_in_version_group_id']), 9) <= g:
                continue
            if r['type_id']:
                t = types[int(r['type_id'])]
            if r['power']:
                p = int(r['power'])
        if t != m['type'] or p != m['power']:
            diff[i] = [t, p]
    by_gen[str(g)] = diff

out = {
    'meta': {'source': 'PokeAPI (github.com/PokeAPI/pokeapi data/v2/csv: moves, move_changelog, types)', 'maxMove': MAX_MOVE,
             'notes': 'type/power/cls are indexed by move id (newest values). byGen[g][id] = [type, power] where Gen g differs. '
                      'Before Gen 4 the damage class follows the type, not cls.'},
    'type': [''] + [cur[i]['type'] if i in cur else '' for i in range(1, MAX_MOVE + 1)],
    'power': [0] + [cur[i]['power'] if i in cur else 0 for i in range(1, MAX_MOVE + 1)],
    'cls': [''] + [cur[i]['cls'] if i in cur else '' for i in range(1, MAX_MOVE + 1)],
    'byGen': by_gen,
}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f, separators=(',', ':'))
print('moves', len(cur), {g: len(d) for g, d in by_gen.items()})
