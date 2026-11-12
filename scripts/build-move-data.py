"""Move types/power/damage class for the in-battle type helper (shared/data/moves.json).

Usage: python3 scripts/build-move-data.py <pokeapi data/v2/csv dir> shared/data/moves.json

PokeAPI's moves.csv holds the newest values; move_changelog.csv lists the OLD values a move had
before the version group in `changed_in_version_group_id`. Walking those changes from newest to
oldest gives every generation's values (Bite: Normal in Gen 1, Dark from Gen 2 …).
"""
import csv, json, os, sys

CSV, OUT = sys.argv[1], sys.argv[2]
MAX_MOVE = 742  # Gen 7 (Ultra Sun/Ultra Moon, Let's Go)
GENS = range(1, 8)


def rows(name):
    with open(os.path.join(CSV, name + '.csv'), newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


# A generation's values are those of its last main-series version group (Yellow, Crystal, FireRed/LeafGreen,
# HeartGold/SoulSilver, Black 2/White 2, Omega Ruby/Alpha Sapphire, Ultra Sun/Ultra Moon). move_changelog lists the
# values a move had before `changed_in_version_group_id`, in the order of version_groups.csv – Let's Go (between
# Ultra Sun and Sword) included, whose values must not leak into the main series.
VG_ORDER = {int(r['id']): int(r['order']) for r in rows('version_groups')}
LAST_VG = {1: 2, 2: 4, 3: 7, 4: 10, 5: 14, 6: 16, 7: 18}
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
    key=lambda r: VG_ORDER[int(r['changed_in_version_group_id'])], reverse=True)

by_gen = {}
for g in GENS:
    diff = {}
    for i, m in cur.items():
        t, p = m['type'], m['power']
        for r in changes:
            if int(r['move_id']) != i or VG_ORDER[int(r['changed_in_version_group_id'])] <= VG_ORDER[LAST_VG[g]]:
                continue
            if r['type_id']:
                t = types[int(r['type_id'])]
            if r['power']:
                p = int(r['power'])
        if t != m['type'] or p != m['power']:
            diff[i] = [t, p]
    by_gen[str(g)] = diff

out = {
    'meta': {'source': 'PokeAPI (github.com/PokeAPI/pokeapi data/v2/csv: moves, move_changelog, types, version_groups)', 'maxMove': MAX_MOVE,
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
