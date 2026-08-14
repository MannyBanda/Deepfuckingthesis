import json, gzip, math
from collections import defaultdict

games=json.load(gzip.open("/tmp/hist_marks.json.gz","rt"))

# ---- as-of records (strict < date, season-scoped) ----
recs=defaultdict(lambda: defaultdict(lambda: [0,0]))  # season -> team -> [w,l]
rows=[]
FUELTEMP={"POT_MIN":6,"THREE_SHARE":40,"MIN_FGA":12}
EFG_BANDS={1:[54,61],2:[56,63],3:[58,66],4:[60,69]}
def efg(s):
    fga=s.get("fga") or 0
    if fga<FUELTEMP["MIN_FGA"]: return None
    return ((s.get("fgm") or 0)+0.5*(s.get("f3m") or 0))/fga*100
def band(e,p):
    b=EFG_BANDS.get(p,EFG_BANDS[4])
    return "green" if e<=b[0] else ("orange" if e<=b[1] else "red")
def fuel(L,T,p):
    le,te=efg(L),efg(T)
    if le is None or te is None: return None
    lPts=2*(L.get("fgm") or 0)+(L.get("f3m") or 0)+(L.get("ftm") or 0)
    ts=(3*(L.get("f3m") or 0))/lPts*100 if lPts>0 else 0
    heat = band(le,p)=="red" or ts>=FUELTEMP["THREE_SHARE"]
    ta=(L.get("pot") or 0)>=FUELTEMP["POT_MIN"]
    return "TRANSIENT" if (heat or ta) else "EARNED"

def tbucket(sec):
    if sec<=600: return "Q1"
    if sec<=1200: return "Q2"
    if sec<=1500: return "Q3e"
    if sec<=1800: return "Q3l"
    if sec<=2100: return "Q4e"
    return "Q4l"

games.sort(key=lambda g:(g["season"],g["date"],g["id"]))
for g in games:
    sw=recs[g["season"]]
    def wp(t):
        w,l=sw[t]; return (w/(w+l)) if (w+l)>0 else None
    hwp,awp=wp(g["home"]),wp(g["away"])
    for side,opp,swp,owp in (("home","away",hwp,awp),("away","home",awp,hwp)):
        # deficit series for this side
        dpk=-99; pk=None
        for c in g["cps"]:
            own=c["h"]["pts"] if side=="home" else c["a"]["pts"]
            op =c["a"]["pts"] if side=="home" else c["h"]["pts"]
            d=op-own
            if d>dpk: dpk=d; pk=c
        if dpk<12 or pk is None: continue
        ownF=g["hs"] if side=="home" else g["as"]
        oppF=g["as"] if side=="home" else g["hs"]
        finald=oppF-ownF
        C=dpk-finald
        L=pk["h"] if side=="away" else pk["a"]  # leader box (the opp) at peak... careful:
        # leader = the side inflicting the deficit = opp of `side`
        Lb=pk["h"] if opp=="home" else pk["a"]
        Tb=pk["h"] if side=="home" else pk["a"]
        gap=(swp-owp) if (swp is not None and owp is not None) else None
        rows.append({"season":g["season"],"date":g["date"],"game":g["away"]+"@"+g["home"],
                     "side":g[side] if side in g else (g["home"] if side=="home" else g["away"]),
                     "trailer":(g["home"] if side=="home" else g["away"]),
                     "leader":(g["home"] if opp=="home" else g["away"]),
                     "dpk":dpk,"pksec":pk["s"],"pkper":pk["p"],"tb":tbucket(pk["s"]),
                     "final_def":finald,"C":C,"win":finald<0,
                     "gap":gap,"leader_wp":owp,"fuel":fuel(Lb,Tb,pk["p"])})
    # update records AFTER processing (strict as-of)
    win=g["winner"]
    lose=g["away"] if win==g["home"] else g["home"]
    sw[win][0]+=1; sw[lose][1]+=1

json.dump(rows,open("/tmp/hist_rows.json","w"))
print("game-sides with D_peak>=12:",len(rows),"| by season:",
      {s:sum(1 for r in rows if r['season']==s) for s in (2024,2025)})

def dbk(d):
    if d<16: return "12-15"
    if d<20: return "16-19"
    if d<25: return "20-24"
    return "25+"
def pct(k,n): return round(100*k/n,1) if n else None
def med(xs):
    xs=sorted(xs); n=len(xs)
    return xs[n//2] if n%2 else (xs[n//2-1]+xs[n//2])/2

print("\n=== H0: C by D_peak bucket (per season, then pooled) ===")
for seas in (2024,2025,"POOLED"):
    rs=[r for r in rows if seas=="POOLED" or r["season"]==seas]
    print(f"--- {seas} (n={len(rs)}) ---")
    for b in ("12-15","16-19","20-24","25+"):
        cell=[r for r in rs if dbk(r["dpk"])==b]
        n=len(cell)
        if not n: continue
        print(f"  D_peak {b:5} n={n:3} | median C={med([r['C'] for r in cell]):4.1f} | P(C>=8)={pct(sum(1 for r in cell if r['C']>=8),n):5}% | P(C>=12)={pct(sum(1 for r in cell if r['C']>=12),n):5}% | trailer-WINS={pct(sum(1 for r in cell if r['win']),n):4}%")

print("\n=== H0: by time-of-peak (pooled, D_peak>=15) ===")
rs=[r for r in rows if r["dpk"]>=15]
for tb in ("Q2","Q3e","Q3l","Q4e","Q4l"):
    cell=[r for r in rs if r["tb"]==tb]
    n=len(cell)
    if not n: continue
    print(f"  peak {tb:3} n={n:3} | median C={med([r['C'] for r in cell]):4.1f} | P(C>=8)={pct(sum(1 for r in cell if r['C']>=8),n):5}% | P(C>=12)={pct(sum(1 for r in cell if r['C']>=12),n):5}% | trailer-WINS={pct(sum(1 for r in cell if r['win']),n):4}%")

print("\n=== PM claim: 'straight blowouts are rare' — D_peak>=15 sides with C<5 ===")
for seas in (2024,2025):
    rs=[r for r in rows if r["season"]==seas and r["dpk"]>=15]
    n=len(rs); k=sum(1 for r in rs if r["C"]<5)
    print(f"  {seas}: {k}/{n} = {pct(k,n)}% stay within 5 of peak (i.e., {100-pct(k,n):.1f}% tighten by 5+)")

print("\n=== H1: gap staircase on P(C>=10), by D_peak bucket ===")
def gcell(r):
    if r["gap"] is None: return None
    if r["gap"]>=0.15: return "gap>=+.15"
    if r["gap"]<=-0.15: return "gap<=-.15"
    return "middle"
for seas in (2024,2025,"POOLED"):
    rs=[r for r in rows if (seas=="POOLED" or r["season"]==seas) and r["gap"] is not None]
    print(f"--- {seas} ---")
    for b in ("12-15","16-19","20-24","25+","ALL"):
        line=f"  {b:5}: "
        ns={}
        for gc in ("gap>=+.15","middle","gap<=-.15"):
            cell=[r for r in rs if gcell(r)==gc and (b=="ALL" or dbk(r["dpk"])==b)]
            n=len(cell); k=sum(1 for r in cell if r["C"]>=10)
            ns[gc]=(pct(k,n),n)
            line+=f"{gc} {pct(k,n)}% (n={n}) | "
        print(line)

print("\n=== H1 secondary (no bars): leader wp strata + fuel at peak, P(C>=10), D_peak>=15 pooled ===")
rs=[r for r in rows if r["dpk"]>=15]
for lo,hi,lab in ((0,.4,"ldr<.400"),(.4,.55,"ldr .400-.550"),(.55,1.01,"ldr>=.550")):
    cell=[r for r in rs if r["leader_wp"] is not None and lo<=r["leader_wp"]<hi]
    n=len(cell); k=sum(1 for r in cell if r["C"]>=10)
    print(f"  {lab:14} P(C>=10)={pct(k,n)}% (n={n}) | trailer-WINS={pct(sum(1 for r in cell if r['win']),n)}%")
for f in ("TRANSIENT","EARNED",None):
    cell=[r for r in rs if r["fuel"]==f]
    n=len(cell); k=sum(1 for r in cell if r["C"]>=10)
    print(f"  fuel {str(f):9} P(C>=10)={pct(k,n)}% (n={n})")
