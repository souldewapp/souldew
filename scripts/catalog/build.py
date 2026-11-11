import sys, json, re, urllib.parse, datetime
sys.path.insert(0, sys.argv[1])
from games import G
from hacks import H
dat = json.load(open(sys.argv[2])); cov = json.load(open(sys.argv[3]))
REPO = {"gb":"Nintendo_-_Game_Boy","gbc":"Nintendo_-_Game_Boy_Color","gba":"Nintendo_-_Game_Boy_Advance","nds":"Nintendo_-_Nintendo_DS"}
# UPR ZX supported CRCs (gen1-3, from gen*_offsets.ini) / game codes+version (gen4-5)
UPR_CRC = set(re.findall(r'CRC32=([0-9A-F]{8})', ''.join(open(f'{sys.argv[4]}/gen{i}.ini').read() for i in (1,2,3))))
GB_GAMECODE = {"pokemon-gold":"AAUE","pokemon-silver":"AAXE","pokemon-crystal":"BYTE","pokemon-gold-de":"AAUD","pokemon-silver-de":"AAXD","pokemon-crystal-de":"BYTD"}
games=[]
for (gid,title,titleDe,sysk,gen,region,nin,extra,hdr,year,color,variantOf) in G:
    names=[nin]+extra
    dumps=[]
    for n in names:
        d=dat[n]; rev=re.search(r'\(Rev (\d+)\)',n)
        dumps.append({"noIntroName":n,"crc32":d["crc"],"sizeBytes":d["size"],"revision":int(rev.group(1)) if rev else 0,
                      "uprSupported": (d["crc"] in UPR_CRC) if gen<=3 else True})
    d0=dat[nin]
    if sysk in ("gb","gbc"):
        serial=hdr.split(" / ")[0]
        gameCode=GB_GAMECODE.get(gid)
    else:
        serial=d0["serial"]; gameCode=d0["serial"]
    e={"id":gid,"title":title,"titleDe":titleDe,"system":sysk,"generation":gen,"region":region,
       "noIntroName":nin,"serial":serial}
    if sysk in ("gb","gbc"):
        e["headerTitle"]=serial; e["gameCode"]=gameCode
        if d0.get("serial"): e["productCode"]=d0["serial"]
    e["crc32"]=[x["crc32"] for x in dumps]
    e["dumps"]=dumps
    e["releaseYear"]=year
    e["color"]=color
    e["uprSupported"]=dumps[0]["uprSupported"]
    c=cov[gid]
    e["cover"]=c["Named_Boxarts"][1] if c["Named_Boxarts"][0]=="200" else None
    e["coverLocal"]=f"assets/covers/{gid}.png" if e["cover"] else None
    e["titleScreen"]=c["Named_Titles"][1] if c["Named_Titles"][0]=="200" else None
    if variantOf: e["variantOf"]=variantOf
    unc=[]
    if gid=="pokemon-crystal-de": unc.append("headerTitle")
    if gid=="pokemon-green-jp": e["notes"]="Japan-only release (Pocket Monsters Midori); titleDe is the common German name, not an official German release."; e["region"]="Japan"
    if unc: e["uncertain"]=True; e["uncertainFields"]=unc
    games.append(e)
ids={g["id"] for g in games}
hacks=[]
for h in H:
    assert h["baseGameId"] in ids, h["id"]
    out={k:h.get(k) for k in ["id","name","author","baseGameId","baseCrc32","system","patchFormat","latestVersion","descriptionEn","descriptionDe","features","difficulty","nuzlockeFriendly"]}
    out["uprCompatible"]=h["uprCompatible"]; out["uprNote"]=h["uprNote"]
    # No url/links on purpose: the app never links to ROM hacks or their download pages.
    out["color"]=h["color"]
    # how far souldew reads the hack live (docs/TESTED_GAMES.md) – shown in the library's hack details
    if h.get("live"): out["live"]=h["live"]
    if h.get("liveNote"): out["liveNote"]=h["liveNote"]
    if h.get("notes"): out["notes"]=h["notes"]
    if h.get("uncertainFields"): out["uncertain"]=True; out["uncertainFields"]=h["uncertainFields"]
    # sanity: baseCrc32 must be a dump of base game
    if out["baseCrc32"]:
        bg=[g for g in games if g["id"]==h["baseGameId"]][0]
        assert out["baseCrc32"] in bg["crc32"], (h["id"], out["baseCrc32"])
    hacks.append(out)
cat={"version":1,"generatedAt":datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00","Z"),
     "sources":{"titleList":"community popularity list (titles only, no links)","dats":"libretro-database metadat/no-intro (2026-10-07)","covers":"libretro-thumbnails","upr":"Universal Pokemon Randomizer ZX gen1-5 offsets INI"},
     "games":games,"hacks":hacks}
json.dump(cat, open(sys.argv[5],"w"), ensure_ascii=False, indent=2)
print(len(games), len(hacks))
