import json, gzip, math
from datetime import datetime
from collections import defaultdict
games=json.load(gzip.open("/tmp/g26.json.gz","rt"))
def ts(x): return datetime.fromisoformat(x.replace("Z","+00:00")).timestamp()
def pct(k,n): return round(100*k/n,1) if n else None
def wilson(k,n):
    if not n: return (None,None)
    p=k/n; z=1.96; den=1+z*z/n; c=p+z*z/(2*n)
    ad=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))
    return (round(100*(c-ad)/den,1),round(100*(c+ad)/den,1))
# as-of records for conditioner
games_s=sorted(games,key=lambda g:(g["date"],g["id"]))
rec=defaultdict(lambda:[0,0]); asof={}
for g in games_s:
    for t in (g["home"],g["away"]):
        w,l=rec[t]; asof[(g["id"],t)]=(w/(w+l)) if (w+l)>0 else None
    lose=g["away"] if g["winner"]==g["home"] else g["home"]
    rec[g["winner"]][0]+=1; rec[lose][1]+=1

rows=[]
for g in games:
    snaps=sorted(g["snaps"],key=lambda s:s["sec"])
    if len(snaps)<20: continue
    odds=g["odds"]
    for o in odds: o["t"]=ts(o["ts"])
    for side in ("home","away"):
        own=lambda s: s["h"] if side=="home" else s["a"]
        opp=lambda s: s["a"] if side=="home" else s["h"]
        ownF=g["hs"] if side=="home" else g["as"]
        oppF=g["as"] if side=="home" else g["hs"]
        finald=oppF-ownF
        mx=-99; fire=None
        for s in snaps:
            d=opp(s)-own(s)
            if d>mx: mx=d
            if mx>=20 and d<=mx-5: fire=(s,d,mx); break
        if not fire: continue
        s0,d0,mx0=fire
        tt=ts(s0["ts"])
        j=next((o for o in odds if o["sp"] is not None and o["t"]>=tt and o["t"]-tt<=240),None)
        tr=g["home"] if side=="home" else g["away"]
        ld=g["away"] if side=="home" else g["home"]
        twp,lwp=asof.get((g["id"],tr)),asof.get((g["id"],ld))
        row={"game":g["away"]+"@"+g["home"],"date":g["date"],"trailer":tr,"d":d0,"mx":mx0,
             "sec":s0["sec"],"final":finald,"tight":finald<d0,
             "gap":(twp-lwp) if (twp is not None and lwp is not None) else None}
        if j:
            tsp=j["sp"] if side=="home" else -j["sp"]
            row["tsp"]=tsp; row["cushion"]=tsp-d0
            cov=(ownF-oppF)+tsp
            row["cover"]=cov>0; row["push"]=cov==0
        rows.append(row)

print("=== STAGE 2 VALIDATION — PB-5@20 on the 2026 live-spread tape ===")
fired=len(rows); joined=[r for r in rows if "cover" in r and not r.get("push")]
k=sum(1 for r in joined if r["cover"])
lo,hi=wilson(k,len(joined))
print(f"fired={fired} joined={len(joined)} pushes={sum(1 for r in rows if r.get('push'))}")
print(f"COVER {k}/{len(joined)} = {pct(k,len(joined))}%  Wilson95 [{lo},{hi}]  vs breakeven 52.38  (naive T20 ref: 39.2%)")
print(f"price-free TIGHTEN rate: {pct(sum(1 for r in rows if r['tight']),fired)}%  (Stage-1 hist: 56.0%)")
cs=[r["cushion"] for r in joined]
print(f"avg deficit at fire: {sum(r['d'] for r in joined)/len(joined):.1f} | avg trailer spread: +{sum(r['tsp'] for r in joined)/len(joined):.1f} | avg cushion {sum(cs)/len(cs):+.1f} (naive T20 ref cushion ~-2.7)")
print(f"avg fire sec: {sum(r['sec'] for r in joined)/len(joined):.0f}")
print("\nby fire time:")
for b,lo_,hi_ in (("<=Q3",0,1800),("Q4e",1800,2100),("Q4l",2100,9999)):
    cell=[r for r in joined if lo_<r["sec"]<=hi_]
    kk=sum(1 for r in cell if r["cover"])
    print(f"  {b:4}: cover {pct(kk,len(cell))}% (n={len(cell)})")
print("\nconditioners (report-only, LOW):")
for lab,f in (("gap>=+.15",lambda r:r["gap"] is not None and r["gap"]>=.15),
              ("middle",lambda r:r["gap"] is not None and -.15<r["gap"]<.15),
              ("gap<=-.15",lambda r:r["gap"] is not None and r["gap"]<=-.15)):
    cell=[r for r in joined if f(r)]
    kk=sum(1 for r in cell if r["cover"])
    print(f"  {lab:10}: cover {pct(kk,len(cell))}% (n={len(cell)})")
json.dump(rows,open("/tmp/pb5_rows_2026.json","w"))
