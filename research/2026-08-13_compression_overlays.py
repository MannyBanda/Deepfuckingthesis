import json, gzip
from collections import defaultdict
games=json.load(gzip.open("/tmp/g26.json.gz","rt"))
trig=json.load(open("/tmp/trig_rows_2026.json"))
# as-of records 2026 (strict < date)
games.sort(key=lambda g:(g["date"],g["id"]))
rec=defaultdict(lambda:[0,0]); asof={}
for g in games:
    for t in (g["home"],g["away"]):
        w,l=rec[t]; asof[(g["id"],t)]=(w/(w+l)) if (w+l)>0 else None
    lose=g["away"] if g["winner"]==g["home"] else g["home"]
    rec[g["winner"]][0]+=1; rec[lose][1]+=1
gid_by=lambda r: next(g for g in games if g["away"]+"@"+g["home"]==r["game"] and g["date"]==r["date"])
def pct(k,n): return round(100*k/n,1) if n else None
print("=== H2 overlay (report-only, post-hoc cells LOW power): cover% by quality gap at trigger ===")
for th in ("15","20"):
    rows=[r for r in trig[th] if r.get("joined") and not r.get("push")]
    for r in rows:
        g=gid_by(r)
        tr=r["trailer"]; ld=g["home"] if tr==g["away"] else g["away"]
        twp,lwp=asof.get((g["id"],tr)),asof.get((g["id"],ld))
        r["gap"]=(twp-lwp) if (twp is not None and lwp is not None) else None
    print(f"--- T{th} ---")
    for lab,f in (("gap>=+.15",lambda r:r["gap"] is not None and r["gap"]>=.15),
                  ("middle",lambda r:r["gap"] is not None and -.15<r["gap"]<.15),
                  ("gap<=-.15",lambda r:r["gap"] is not None and r["gap"]<=-.15)):
        cell=[r for r in rows if f(r)]
        k=sum(1 for r in cell if r["cover"])
        print(f"  {lab:10} cover={pct(k,len(cell))}% (n={len(cell)})")
    # leader-side mirror
    k=sum(1 for r in rows if not r["cover"])
    print(f"  MIRROR (leader -spread, post-hoc): {pct(k,len(rows))}% (n={len(rows)})")
print()
print("=== H1 confound check (hist): time-of-peak distribution by gap cell, D_peak>=15 ===")
hist=json.load(open("/tmp/hist_rows.json"))
hs=[r for r in hist if r["dpk"]>=15 and r["gap"] is not None]
for lab,f in (("gap>=+.15",lambda r:r["gap"]>=.15),("gap<=-.15",lambda r:r["gap"]<=-.15)):
    cell=[r for r in hs if f(r)]
    from collections import Counter
    c=Counter(r["tb"] for r in cell); n=len(cell)
    print(f"  {lab}: n={n} |", {k:f"{100*v/n:.0f}%" for k,v in sorted(c.items())})
    print(f"    mean D_peak={sum(r['dpk'] for r in cell)/n:.1f}")
