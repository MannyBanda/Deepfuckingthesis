import json, gzip, math
from datetime import datetime
games=json.load(gzip.open("/tmp/g26_box.json.gz","rt"))
odds_by={g["id"]:g["odds"] for g in json.load(gzip.open("/tmp/g26.json.gz","rt"))}
def ts(x): return datetime.fromisoformat(x.replace("Z","+00:00")).timestamp()
def pct(k,n): return round(100*k/n,1) if n else None
def wilson(k,n):
    if not n: return (None,None)
    p=k/n; z=1.96; den=1+z*z/n; c=p+z*z/(2*n)
    ad=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))
    return (round(100*(c-ad)/den,1),round(100*(c+ad)/den,1))
def efg(b):
    if not b or (b.get("fga") or 0)<12: return None
    return ((b.get("fgm") or 0)+0.5*(b.get("fg3m") or 0))/b["fga"]*100

print("=== STAGE 2 VALIDATION — survivor cells on 2026 spread tape ===")
for D in (15,25):
    rows=[]
    for g in games:
        snaps=sorted(g["snaps"],key=lambda s:s["sec"])
        if len(snaps)<20: continue
        odds=odds_by.get(g["id"],[])
        for o in odds:
            if "t" not in o: o["t"]=ts(o["ts"])
        for side in ("home","away"):
            fire=None
            for s in snaps:
                own=s["h"] if side=="home" else s["a"]
                op =s["a"] if side=="home" else s["h"]
                if op-own>=D: fire=s; break
            if not fire: continue
            Lb=fire.get("hb") if side=="away" else fire.get("ab")
            le=efg(Lb)
            if le is None or le<=55: continue   # survivor cell: leader eFG >55
            ownF=g["hs"] if side=="home" else g["as"]
            oppF=g["as"] if side=="home" else g["hs"]
            finald=oppF-ownF
            d0=(fire["a"]-fire["h"]) if side=="home" else (fire["h"]-fire["a"])
            tt=ts(fire["ts"])
            j=next((o for o in odds if o["sp"] is not None and o["t"]>=tt and o["t"]-tt<=240),None)
            row={"tight":finald<d0,"d0":d0,"sec":fire["sec"],"lefg":round(le,1)}
            if j:
                tsp=j["sp"] if side=="home" else -j["sp"]
                cov=(ownF-oppF)+tsp
                row["cover"]=cov>0; row["push"]=cov==0; row["cushion"]=tsp-d0
            rows.append(row)
    joined=[r for r in rows if "cover" in r and not r.get("push")]
    k=sum(1 for r in joined if r["cover"])
    lo,hi=wilson(k,len(joined))
    tn=len(rows); tk=sum(1 for r in rows if r["tight"])
    print(f"D={D} leader-eFG>55 [this season]: fired={tn} | TIGHTEN {pct(tk,tn)}% | joined={len(joined)} pushes={sum(1 for r in rows if r.get('push'))}")
    print(f"   COVER {k}/{len(joined)} = {pct(k,len(joined))}%  Wilson95 [{lo},{hi}]  vs 52.38 | avg cushion {sum(r['cushion'] for r in joined)/len(joined):+.1f} | avg fire sec {sum(r['sec'] for r in joined)/len(joined):.0f}")
