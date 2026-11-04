import sys, json, subprocess, urllib.parse, re
sys.path.insert(0, sys.argv[1]); from games import G
REPO = {"gb":"Nintendo_-_Game_Boy","gbc":"Nintendo_-_Game_Boy_Color","gba":"Nintendo_-_Game_Boy_Advance","nds":"Nintendo_-_Nintendo_DS"}
def fn(n): return re.sub(r'[&*/:`<>?\\|"]', '_', n)
def url(s, kind, n): return f"https://raw.githubusercontent.com/libretro-thumbnails/{REPO[s]}/master/{kind}/{urllib.parse.quote(fn(n))}.png"
def ok(u):
    r = subprocess.run(["curl","-sI","-o","/dev/null","-w","%{http_code}",u],capture_output=True,text=True); return r.stdout.strip()
res = {}
for g in G:
    gid, s, n = g[0], g[3], g[6]
    out = {}
    for kind in ("Named_Boxarts","Named_Titles"):
        u = url(s, kind, n); c = ok(u); out[kind] = (c, u)
    res[gid] = out
    print(gid, out["Named_Boxarts"][0], out["Named_Titles"][0])
json.dump(res, open(sys.argv[2],"w"), indent=1)
