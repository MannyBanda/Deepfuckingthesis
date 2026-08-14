import urllib.request, base64, json, gzip, time
from concurrent.futures import ThreadPoolExecutor
B="https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api"
auth=base64.b64encode(b"manny:DFT2025!").decode()
def get(url, tries=4):
    for i in range(tries):
        try:
            req=urllib.request.Request(url, headers={"Authorization":"Basic "+auth})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:
            if i==tries-1: return None
            time.sleep(1+i)
games=[g for g in json.load(open("/tmp/g.json"))["games"] if g.get("winner")]
print("finished 2026 games:",len(games),"| dates",min(str(g["date"])[:10] for g in games),"->",max(str(g["date"])[:10] for g in games))
def clock_to_sec(period,clock):
    try:
        m,s=str(clock).split(":")[:2]; rem=int(m)*60+int(float(s))
    except: return None
    p=int(period or 0)
    if p<1: return None
    if p<=4: return (p-1)*600+(600-rem)
    return 2400+(p-5)*300+(300-rem)
def pull(g):
    gid=g["id"]
    sn=get(B+f"?action=get_snapshot_timeline&league=wnba&game_id={gid}")
    od=get(B+f"?action=get_odds&league=wnba&game_id={gid}")
    snaps=[]
    for s in (sn or {}).get("snapshots",[]):
        sec=clock_to_sec(s.get("period"),s.get("clock"))
        if sec is None or s.get("home_pts") is None: continue
        snaps.append({"ts":s["ts"],"sec":sec,"p":s.get("period"),"h":s["home_pts"],"a":s["away_pts"]})
    odds=[{"ts":o["ts"],"sp":o.get("home_spread"),"hml":o.get("home_ml"),"aml":o.get("away_ml")}
          for o in (od or {}).get("odds",[])]
    return {"id":gid,"date":str(g["date"])[:10],"home":g["home_alias"],"away":g["away_alias"],
            "hs":g["home_pts"],"as":g["away_pts"],"winner":g["winner"],"snaps":snaps,"odds":odds}
t0=time.time(); out=[]
with ThreadPoolExecutor(max_workers=8) as ex:
    for i,r in enumerate(ex.map(pull,games)):
        out.append(r)
        if (i+1)%50==0: print(i+1,"%.0fs"%(time.time()-t0),flush=True)
with gzip.open("/tmp/g26.json.gz","wt") as f: json.dump(out,f)
print("done",len(out),"in %.0fs"%(time.time()-t0))
print("with snaps>=20:",sum(1 for g in out if len(g["snaps"])>=20),"| with any spread rows:",sum(1 for g in out if any(o["sp"] is not None for o in g["odds"])))
