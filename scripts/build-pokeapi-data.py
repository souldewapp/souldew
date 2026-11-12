import csv, json, sys, os
from collections import defaultdict

CSV = sys.argv[1]
OUT = sys.argv[2]
MAX_SPECIES = int(sys.argv[3]) if len(sys.argv) > 3 else 1025
MAX_MOVE = 742  # Gen 7 (Ultra Sun/Ultra Moon, Let's Go)

def rows(name):
    with open(os.path.join(CSV, name + '.csv'), newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))

lang_ids = {r['identifier']: int(r['id']) for r in rows('languages')}
# output lang key -> list of PokeAPI language identifiers in priority order
LANGS = {'en': ['en'], 'de': ['de'], 'fr': ['fr'], 'es': ['es'], 'it': ['it'],
         'ja': ['ja-hrkt', 'ja'], 'ko': ['ko'], 'zh-Hans': ['zh-hans']}
MOVE_LANGS = ['en', 'de', 'fr', 'es', 'it']

def localized(table, idcol, n_or_ids, langs, fallback_en=True):
    """Return lang -> list indexed by id (index 0 = '')."""
    by = defaultdict(dict)  # lang_id -> {id: name}
    for r in rows(table):
        by[int(r['local_language_id'])][int(r[idcol])] = r['name']
    ids = n_or_ids
    out, gaps = {}, {}
    for key in langs:
        arr = [''] * (max(ids) + 1)
        missing = []
        for i in ids:
            name = ''
            for ident in LANGS[key]:
                name = by[lang_ids[ident]].get(i, '')
                if name:
                    break
            if not name and fallback_en:
                missing.append(i)
                name = by[lang_ids['en']].get(i, '')
            arr[i] = name
        out[key] = arr
        if missing:
            gaps[key] = missing
    return out, gaps

species = {int(r['id']): r for r in rows('pokemon_species')}
S = range(1, MAX_SPECIES + 1)
data = {'meta': {'source': 'PokeAPI (github.com/PokeAPI/pokeapi data/v2/csv)', 'maxSpecies': MAX_SPECIES,
                 'maxMove': MAX_MOVE, 'built': '2026-10-17',
                 'notes': 'Arrays are indexed by national dex / move / ability id; index 0 is a placeholder. '
                          'typesGen/baseStatsGen: {id:{gen:value}} - value applies to all generations <= gen; '
                          'pick the smallest key >= target gen, else use current value. '
                          'Stats order: hp,atk,def,spa,spd,spe. gen1Special: Gen 1 Special stat.'}}
gaps = {}

data['names'], g = localized('pokemon_species_names', 'pokemon_species_id', S, list(LANGS))
if g: gaps['names'] = g

# types
types = {int(r['id']): r['identifier'] for r in rows('types')}
cur = defaultdict(list)
for r in rows('pokemon_types'):
    pid = int(r['pokemon_id'])
    if pid <= MAX_SPECIES:
        cur[pid].append((int(r['slot']), types[int(r['type_id'])]))
data['types'] = [[]] + [[t for _, t in sorted(cur[i])] for i in S]
past = defaultdict(lambda: defaultdict(list))
for r in rows('pokemon_types_past'):
    pid = int(r['pokemon_id'])
    if pid <= MAX_SPECIES:
        past[pid][int(r['generation_id'])].append((int(r['slot']), types[int(r['type_id'])]))
data['typesGen'] = {str(p): {str(gn): [t for _, t in sorted(v)] for gn, v in sorted(d.items())}
                    for p, d in sorted(past.items())}

# type names (18 battle types)
tn = defaultdict(dict)
for r in rows('type_names'):
    tn[int(r['local_language_id'])][int(r['type_id'])] = r['name']
data['typeNames'] = {}
for key in LANGS:
    m = {}
    for tid in range(1, 19):
        name = ''
        for ident in LANGS[key]:
            name = tn[lang_ids[ident]].get(tid, '')
            if name: break
        if not name:
            gaps.setdefault('typeNames', {}).setdefault(key, []).append(types[tid])
            name = tn[lang_ids['en']].get(tid, types[tid])
        m[types[tid]] = name
    data['typeNames'][key] = m

data['evolutionChain'] = [0] + [int(species[i]['evolution_chain_id'] or 0) for i in S]
data['evolvesFrom'] = [0] + [int(species[i]['evolves_from_species_id'] or 0) for i in S]
data['genOf'] = [0] + [int(species[i]['generation_id']) for i in S]

# base stats
st = defaultdict(lambda: [0] * 6)
for r in rows('pokemon_stats'):
    pid, sid = int(r['pokemon_id']), int(r['stat_id'])
    if pid <= MAX_SPECIES and 1 <= sid <= 6:
        st[pid][sid - 1] = int(r['base_stat'])
data['baseStats'] = [[]] + [st[i] for i in S]
pst = defaultdict(dict)  # pid -> {(gen, sid): val}
special = {}
for r in rows('pokemon_stats_past'):
    pid, gn, sid = int(r['pokemon_id']), int(r['generation_id']), int(r['stat_id'])
    if pid > MAX_SPECIES: continue
    if sid == 9:
        special[pid] = int(r['base_stat'])
    elif 1 <= sid <= 6:
        pst[pid][(gn, sid)] = int(r['base_stat'])
bsg = {}
for pid, d in sorted(pst.items()):
    gens = sorted({gn for gn, _ in d})
    o = {}
    for G in gens:
        arr = []
        for sid in range(1, 7):
            cands = sorted(gn for gn, s in d if s == sid and gn >= G)
            arr.append(d[(cands[0], sid)] if cands else st[pid][sid - 1])
        if arr != st[pid]:
            o[str(G)] = arr
    if o: bsg[str(pid)] = o
data['baseStatsGen'] = bsg
data['gen1Special'] = [0] + [special.get(i, 0) for i in range(1, 152)]

data['moves'], g = localized('move_names', 'move_id', range(1, MAX_MOVE + 1), MOVE_LANGS)
if g: gaps['moves'] = g

abil = [int(r['id']) for r in rows('abilities') if int(r['id']) < 10000 and int(r['is_main_series'])]
data['abilities'], g = localized('ability_names', 'ability_id', range(1, max(abil) + 1), list(LANGS))
if g: gaps['abilities'] = g
data['meta']['maxAbility'] = max(abil)

nat = sorted(rows('natures'), key=lambda r: int(r['game_index']))
nn = defaultdict(dict)
for r in rows('nature_names'):
    nn[int(r['local_language_id'])][int(r['nature_id'])] = r['name']
data['natures'] = {}
for key in LANGS:
    arr = []
    for r in nat:
        nid = int(r['id'])
        name = ''
        for ident in LANGS[key]:
            name = nn[lang_ids[ident]].get(nid, '')
            if name: break
        if not name:
            gaps.setdefault('natures', {}).setdefault(key, []).append(r['identifier'])
            name = nn[lang_ids['en']][nid]
        arr.append(name)
    data['natures'][key] = arr
data['natureIds'] = [r['identifier'] for r in nat]
# stat effect per nature in game_index order: [increased stat index, decreased stat index] (1..5 = atk..spe order hp,atk,def,spa,spd,spe)
data['natureStats'] = [[int(r['increased_stat_id']) - 1, int(r['decreased_stat_id']) - 1] for r in nat]

# items: PokeAPI identifiers indexed by in-game item index for Gen 3–7, names keyed by identifier
items = {int(r['id']): r['identifier'] for r in rows('items')}
gi = defaultdict(lambda: defaultdict(list))
for r in rows('item_game_indices'):
    gi[int(r['generation_id'])][int(r['game_index'])].append(int(r['item_id']))
g4idx = {iid[0]: k for k, iid in gi[4].items()}
g4idx = {}
for k, iids in gi[4].items():
    for iid in iids: g4idx[iid] = k
itemsOut = {}
used = set()
collisions = []
for gen in (3, 4, 5, 6, 7):
    table = gi[gen]
    arr = [''] * (max(table) + 1)
    displaced = []
    for k in sorted(table):
        iids = sorted(table[k])
        if len(iids) > 1:
            pref = [i for i in iids if gen == 5 and g4idx.get(i) == k]
            pick = pref[0] if pref else iids[0]
            collisions.append((gen, k, [items[i] for i in iids], items[pick]))
            displaced += [i for i in iids if i != pick]
        else:
            pick = iids[0]
        arr[k] = items[pick]
    for i in displaced:
        k = g4idx.get(i) if gen == 5 else None
        if k is not None and k < len(arr) and not arr[k]:
            arr[k] = items[i]
            collisions.append((gen, 'moved', items[i], k))
    itemsOut['gen%d' % gen] = arr
    used.update(x for x in arr if x)
inames = defaultdict(dict)
for r in rows('item_names'):
    inames[int(r['local_language_id'])][int(r['item_id'])] = r['name']
rev = {v: k for k, v in items.items()}
# items PokeAPI has no names for (an empty name hides a team's held items in the app): the games' own names
ITEM_NAME_FALLBACK = {
    'roseli-berry': {'en': 'Roseli Berry', 'de': 'Hibisbeere', 'fr': 'Baie Selro', 'es': 'Baya Hibis', 'it': 'Baccarcadè'},
}
itemsOut['names'] = {}
for key in MOVE_LANGS:
    m = {}
    for ident in sorted(used, key=lambda x: rev[x]):
        nm = inames[lang_ids[key]].get(rev[ident]) or ITEM_NAME_FALLBACK.get(ident, {}).get(key) or inames[lang_ids['en']].get(rev[ident], '') or ITEM_NAME_FALLBACK.get(ident, {}).get('en', '')
        if not inames[lang_ids[key]].get(rev[ident]) and not ITEM_NAME_FALLBACK.get(ident, {}).get(key):
            gaps.setdefault('items', {}).setdefault(key, []).append(ident)
        m[ident] = nm
    itemsOut['names'][key] = m
data['items'] = itemsOut
print('item collisions', collisions)

with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
print('size', os.path.getsize(OUT))
print('gaps', json.dumps({k: {l: (len(v), v[:15]) for l, v in d.items()} for k, d in gaps.items()}, ensure_ascii=False))
