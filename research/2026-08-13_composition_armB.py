import json, gzip
from datetime import datetime
rows=json.load(open("/tmp/ss_rows.json"))
odds_by={g["id"]:g["odds"] for g in json.load(gzip.open("/tmp/g26.json.gz","rt"))}
finals={g["id"]:g for g in json.load(gzip.open("/tmp/g26.json.gz","rt"))}
def ts(x): return datetime.fromisoformat(x.replace("Z","+00:00")).timestamp()
def pct(k,n): return round(100*k/n,1) if n else None
def ml_ret(ml):  # per $1 staked, win return
    ml=int(ml)
    return ml/100 if ml>0 else 100/abs(ml)

res=[r for r in rows if r.get("resolved") and r.get("trailer_won") is not None
     and r.get("alert_subtype") not in ("GAME_BRIEF",)]
print("resolved non-brief rows:",len(res))
out=[]
for r in res:
    g=finals.get(r["game_id"])
    if not g: continue
    odds=odds_by.get(r["game_id"],[])
    for o in odds:
        if "t" not in o: o["t"]=ts(o["ts"])
    tt=ts(r["created_at"])
    j=next((o for o in odds if o["sp"] is not None and o["t"]>=tt and o["t"]-tt<=240),None)
    if not j: continue
    tr=r["trailer_alias"]
    tr_home = (tr==g["home"]) or (tr==r.get("home_alias"))
    tsp=j["sp"] if tr_home else -j["sp"]
    trF=g["hs"] if tr_home else g["as"]
    opF=g["as"] if tr_home else g["hs"]
    cov=(trF-opF)+tsp
    out.append({"sub":r["alert_subtype"],"tier":r.get("alert_tier"),"won":bool(r["trailer_won"]),
                "cover":cov>0,"push":cov==0,"tsp":tsp,"ml":r.get("line_used"),
                "deficit":r.get("deficit"),"game":g["away"]+"@"+g["home"],"date":r["game_date"]})
print("joined to spread at fire:",len(out),"| unjoined:",len(res)-len(out))
print()
def block(name,rs):
    rs=[r for r in rs if not r["push"]]
    n=len(rs)
    if not n: return
    kc=sum(1 for r in rs if r["cover"]); kw=sum(1 for r in rs if r["won"])
    roi_sp=sum((0.909 if r["cover"] else -1) for r in rs)/n
    withml=[r for r in rs if r["ml"] is not None]
    roi_ml=sum((ml_ret(r["ml"]) if r["won"] else -1) for r in withml)/len(withml) if withml else None
    print(f"{name:28} n={n:3} | ML: {kw}-{n-kw} ({pct(kw,n)}%) ROI {round(100*roi_ml,1) if roi_ml is not None else '—'}%/$"
          f" | SPREAD@fire: {kc}-{n-kc} ({pct(kc,n)}%) ROI {round(100*roi_sp,1)}%/$ | avg spread +{sum(r['tsp'] for r in rs)/n:.1f}")
groups={}
for r in out: groups.setdefault(r["sub"],[]).append(r)
order=["EFG_FADE","EFG_FADE_SOFT","B1","B2","B3","WATCHLIST","GAP_BASE","Q4_COLLAPSE"]
for s in order:
    if s in groups: block(s,groups[s])
for s in sorted(groups):
    if s not in order: block(s,groups[s])
print()
atier=[r for r in out if r["sub"] in ("EFG_FADE","EFG_FADE_SOFT")]
block("A-tier pooled",atier)
plus=[r for r in out if r["ml"] is not None and int(r["ml"])>0]
minus=[r for r in out if r["ml"] is not None and int(r["ml"])<0]
block("all plus-money fires",plus)
block("all minus-money fires",minus)
print("\nA-tier row detail:")
for r in atier:
    print(f"  {r['date']} {r['game']:9} | ML {r['ml']:>5} won={r['won']} | spread +{r['tsp']} cover={r['cover']}")
