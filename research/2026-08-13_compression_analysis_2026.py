import json, gzip
from datetime import datetime
games=json.load(gzip.open("/tmp/g26.json.gz","rt"))
def ts(x): return datetime.fromisoformat(x.replace("Z","+00:00")).timestamp()

def pct(k,n): return round(100*k/n,1) if n else None
def wilson(k,n):
    if not n: return (None,None)
    import math
    p=k/n; z=1.96
    den=1+z*z/n; c=p+z*z/(2*n)
    ad=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))
    return (round(100*(c-ad)/den,1),round(100*(c+ad)/den,1))

trig_rows={15:[],20:[],25:[]}
h0_rows=[]  # 2026 H0 comparison, Q2+ restricted like hist
h3=[]
for g in games:
    snaps=sorted(g["snaps"],key=lambda s:s["sec"])
    if len(snaps)<20: continue
    odds=[o for o in g["odds"]]
    for o in odds: o["t"]=ts(o["ts"])
    # dead boundary: first spread-tape row where both MLs null and never non-null after
    dead_t=None
    lastml=None
    for o in odds:
        if o["hml"] is not None or o["aml"] is not None: lastml=o["t"]
    for o in odds:
        if o["hml"] is None and o["aml"] is None and (lastml is None or o["t"]>lastml):
            dead_t=o["t"]; break
    for side in ("home","away"):
        own=lambda s: s["h"] if side=="home" else s["a"]
        opp=lambda s: s["a"] if side=="home" else s["h"]
        ownF=g["hs"] if side=="home" else g["as"]
        oppF=g["as"] if side=="home" else g["hs"]
        finald=oppF-ownF
        # H0 comparable (Q2+ marks only)
    	# peak over sec>=630
        q2=[s for s in snaps if s["sec"]>=630]
        if q2:
            dpk=max(opp(s)-own(s) for s in q2)
            if dpk>=12:
                pk=next(s for s in q2 if opp(s)-own(s)==dpk)
                h0_rows.append({"dpk":dpk,"sec":pk["sec"],"C":dpk-finald,"win":finald<0})
        # triggers on FULL timeline
        for th in (15,20,25):
            trig=next((s for s in snaps if opp(s)-own(s)>=th),None)
            if not trig: continue
            tt=ts(trig["ts"])
            # first odds row with spread at ts>=trigger, dt<=240s
            j=next((o for o in odds if o["sp"] is not None and o["t"]>=tt and o["t"]-tt<=240),None)
            row={"game":g["away"]+"@"+g["home"],"date":g["date"],"side":side,
                 "trailer":(g["home"] if side=="home" else g["away"]),
                 "d_at":opp(trig)-own(trig),"sec":trig["sec"],"p":trig["p"],
                 "final_def":finald,"joined":j is not None}
            if j:
                tsp = j["sp"] if side=="home" else -j["sp"]
                cov=(ownF-oppF)+tsp
                row["tspread"]=tsp; row["cover"]=cov>0; row["push"]=cov==0
                if dead_t:
                    pre=[s for s in snaps if ts(s["ts"])<=dead_t]
                    if pre:
                        db=opp(pre[-1])-own(pre[-1])
                        row["d_dead"]=db
            trig_rows[th].append(row)

print("=== H2: ex-ante triggers, trailer vs live spread ===")
for th in (15,20,25):
    rs=trig_rows[th]; joined=[r for r in rs if r["joined"]]
    played=[r for r in joined if not r.get("push")]
    k=sum(1 for r in played if r["cover"])
    lo,hi=wilson(k,len(played))
    print(f"T{th}: triggers={len(rs)} joined={len(joined)} pushes={sum(1 for r in joined if r.get('push'))} | COVER {k}/{len(played)} = {pct(k,len(played))}%  Wilson95 [{lo},{hi}] | breakeven 52.38")
    # by trigger time bucket
    for b,lo_,hi_ in (("<=Q3",0,1800),("Q4e",1800,2100),("Q4l",2100,9999)):
        cell=[r for r in played if lo_<r["sec"]<=hi_]
        kk=sum(1 for r in cell if r["cover"])
        print(f"   trigger {b:4}: {pct(kk,len(cell))}% (n={len(cell)})")
    # avg spread at entry
    sps=[r["tspread"] for r in played]
    if sps: print(f"   avg trailer spread at entry: +{sum(sps)/len(sps):.1f}")

print("\n=== H2 predictor overlay (report-only): T20 by margin-at-trigger and by spread cushion ===")
rs=[r for r in trig_rows[20] if r["joined"] and not r.get("push")]
for lab,f in (("cushion sp-d >= +4",lambda r: r["tspread"]-r["d_at"]>=4),
              ("cushion +1..+3", lambda r: 1<=r["tspread"]-r["d_at"]<=3),
              ("cushion <= 0", lambda r: r["tspread"]-r["d_at"]<=0)):
    cell=[r for r in rs if f(r)]
    k=sum(1 for r in cell if r["cover"])
    print(f"  {lab:20} cover={pct(k,len(cell))}% (n={len(cell)})")

print("\n=== H3: live vs dead-time decomposition (T20, joined, dead boundary exists) ===")
rs=[r for r in trig_rows[20] if r["joined"] and "d_dead" in r and not r.get("push")]
if rs:
    tot=[r["d_at"]-r["final_def"] for r in rs]
    live=[r["d_at"]-r["d_dead"] for r in rs]
    dead=[r["d_dead"]-r["final_def"] for r in rs]
    n=len(rs)
    print(f"n={n} | mean compression post-trigger: total {sum(tot)/n:+.1f} = live {sum(live)/n:+.1f} + after-ML-pulled {sum(dead)/n:+.1f}")
    cov=[r for r in rs if r["cover"]]
    if cov:
        print(f"among COVERS (n={len(cov)}): live {sum(r['d_at']-r['d_dead'] for r in cov)/len(cov):+.1f} + dead {sum(r['d_dead']-r['final_def'] for r in cov)/len(cov):+.1f}")
else:
    print("no rows with dead boundary")
nd=[r for r in trig_rows[20] if r["joined"] and "d_dead" not in r]
print(f"T20 joined rows with NO dead boundary (ML never pulled): {len(nd)}")

print("\n=== 2026 H0 comparison (Q2+ marks, [this season] tag) ===")
def dbk(d): return "12-15" if d<16 else ("16-19" if d<20 else ("20-24" if d<25 else "25+"))
def med(xs):
    xs=sorted(xs); n=len(xs); return xs[n//2] if n%2 else (xs[n//2-1]+xs[n//2])/2
from collections import defaultdict
bk=defaultdict(list)
for r in h0_rows: bk[dbk(r["dpk"])].append(r)
for b in ("12-15","16-19","20-24","25+"):
    cell=bk[b]; n=len(cell)
    if not n: continue
    print(f"  D_peak {b:5} n={n:3} | median C={med([r['C'] for r in cell]):4.1f} | P(C>=8)={pct(sum(1 for r in cell if r['C']>=8),n)}% | P(C>=12)={pct(sum(1 for r in cell if r['C']>=12),n)}% | trailer-WINS={pct(sum(1 for r in cell if r['win']),n)}%")
json.dump({str(k):v for k,v in trig_rows.items()},open("/tmp/trig_rows_2026.json","w"))
