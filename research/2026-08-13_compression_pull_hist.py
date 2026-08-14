import urllib.request, base64, json, gzip, time
B="https://poetic-starlight-aa8938.netlify.app/.netlify/functions/backtest-wnba"
auth=base64.b64encode(b"manny:DFT2025!").decode()
def get(url, tries=5):
    for i in range(tries):
        try:
            req=urllib.request.Request(url, headers={"Authorization":"Basic "+auth})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read())
        except Exception as e:
            if i==tries-1: raise
            time.sleep(2+2*i)
games=[]; off=0
t0=time.time()
while True:
    d=get(B+f"?phase=export_checkpoints&grain=30&offset={off}&limit=12")
    for g in d["games"]:
        cps=[{"s":c["gameSec"],"p":c["period"],
              "h":{k:c["home"].get(k) for k in ("pts","fgm","fga","f3m","ftm","to","pot")},
              "a":{k:c["away"].get(k) for k in ("pts","fgm","fga","f3m","ftm","to","pot")}} for c in g["checkpoints"]]
        games.append({"id":g["game_id"],"season":g["season"],"date":str(g["date"])[:10],
                      "home":g["home"],"away":g["away"],"hs":g["home_score"],"as":g["away_score"],
                      "winner":g["winner"],"cps":cps})
    off+=d["returned"]
    if off>=d["total"] or d["returned"]==0: break
    if off % 60 == 0: print(f"{off}/{d['total']} {time.time()-t0:.0f}s", flush=True)
print("pulled",len(games),"games in %.0fs"%(time.time()-t0))
with gzip.open("/tmp/hist_marks.json.gz","wt") as f: json.dump(games,f)
from collections import Counter
print(Counter(g["season"] for g in games))
