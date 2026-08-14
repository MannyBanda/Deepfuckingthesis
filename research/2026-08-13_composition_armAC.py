import json, gzip
from collections import defaultdict
games=json.load(gzip.open("/tmp/hist_marks_v2.json.gz","rt"))
def pct(k,n): return round(100*k/n,1) if n else None

def efg(s):
    fga=s.get("fga") or 0
    return None if fga<12 else ((s.get("fgm") or 0)+0.5*(s.get("f3m") or 0))/fga*100
def vpct(s):
    fgm,f3m,pntm,ftm=(s.get("fgm") or 0),(s.get("f3m") or 0),(s.get("pntm") or 0),(s.get("ftm") or 0)
    tot=2*fgm+f3m+ftm
    if tot<=0: return None
    var=3*f3m+2*max(0,fgm-f3m-pntm)
    return var/tot*100
def wefg(pre,post):  # windowed efg from box diff, guard >=5 FGA
    dfga=(post.get("fga") or 0)-(pre.get("fga") or 0)
    if dfga<5: return None
    dfgm=(post.get("fgm") or 0)-(pre.get("fgm") or 0)
    df3m=(post.get("f3m") or 0)-(pre.get("f3m") or 0)
    return (dfgm+0.5*df3m)/dfga*100

# as-of records
recs=defaultdict(lambda: defaultdict(lambda: [0,0]))
games.sort(key=lambda g:(g["season"],g["date"],g["id"]))
rows=[]
for g in games:
    sw=recs[g["season"]]
    def wp(t):
        w,l=sw[t]; return (w/(w+l)) if (w+l)>0 else None
    for side,opp in (("home","away"),("away","home")):
        cps=g["cps"]
        ownF=g["hs"] if side=="home" else g["as"]
        oppF=g["as"] if side=="home" else g["hs"]
        finald=oppF-ownF
        tr=g["home"] if side=="home" else g["away"]
        ld=g["home"] if opp=="home" else g["away"]
        for D in (10,15,20,25):
            fire=None
            for i,c in enumerate(cps):
                own=c["h"]["pts"] if side=="home" else c["a"]["pts"]
                op =c["a"]["pts"] if side=="home" else c["h"]["pts"]
                if op-own>=D: fire=(i,c,op-own); break
            if not fire: continue
            i,c,d0=fire
            L=c["h"] if opp=="home" else c["a"]
            T=c["h"] if side=="home" else c["a"]
            # 5-min window back (10 marks) for rates
            j=i-10
            pre=cps[j] if j>=0 else None
            preL=pre["h"] if (pre and opp=="home") else (pre["a"] if pre else None)
            preT=pre["h"] if (pre and side=="home") else (pre["a"] if pre else None)
            lc,tc=efg(L),efg(T)
            lw=wefg(preL,L) if preL else None
            tw=wefg(preT,T) if preT else None
            potg=((L.get("pot") or 0)-(preL.get("pot") or 0)) if preL else None
            # 6-min-later net margin (12 marks fwd)
            k=i+12
            if k<len(cps):
                cf=cps[k]
                own6=cf["h"]["pts"] if side=="home" else cf["a"]["pts"]
                op6 =cf["a"]["pts"] if side=="home" else cf["h"]["pts"]
                net6=(op6-own6)-d0
            else: net6=None
            twp,lwp=wp(tr),wp(ld)
            rows.append({"season":g["season"],"D":D,"d0":d0,"final":finald,"tight":finald<d0,"net6":net6,
                "lefg":lc,"tefg":tc,"lvp":vpct(L),"lpot":L.get("pot") or 0,
                "lw":lw,"tw":tw,"potg":potg,
                "gap":(twp-lwp) if (twp is not None and lwp is not None) else None})
    win=g["winner"]; lose=g["away"] if win==g["home"] else g["home"]
    sw[win][0]+=1; sw[lose][1]+=1

json.dump(rows,open("/tmp/armAC_rows.json","w"))

CELLS=[
 ("A: leader eFG <45",   lambda r: r["lefg"] is not None and r["lefg"]<45),
 ("A: leader eFG 45-55", lambda r: r["lefg"] is not None and 45<=r["lefg"]<=55),
 ("A: leader eFG >55",   lambda r: r["lefg"] is not None and r["lefg"]>55),
 ("A: leader vShare >55",lambda r: r["lvp"] is not None and r["lvp"]>55),
 ("A: leader vShare<=55",lambda r: r["lvp"] is not None and r["lvp"]<=55),
 ("A: leader POT >=6",   lambda r: r["lpot"]>=6),
 ("A: leader POT <6",    lambda r: r["lpot"]<6),
 ("A: trailer eFG <45",  lambda r: r["tefg"] is not None and r["tefg"]<45),
 ("A: trailer eFG 45-55",lambda r: r["tefg"] is not None and 45<=r["tefg"]<=55),
 ("A: trailer eFG >55",  lambda r: r["tefg"] is not None and r["tefg"]>55),
 ("C: ldr decel any",    lambda r: r["lw"] is not None and r["lefg"] is not None and r["lw"]<r["lefg"]),
 ("C: ldr decel >=10pp", lambda r: r["lw"] is not None and r["lefg"] is not None and r["lw"]<=r["lefg"]-10),
 ("C: trl accel >=10pp", lambda r: r["tw"] is not None and r["tefg"] is not None and r["tw"]>=r["tefg"]+10),
 ("C: ldr POT-gain >=4", lambda r: r["potg"] is not None and r["potg"]>=4),
]
print("=== ARMS A+C DISCOVERY (2024-25) — bar: tighten>=58 pooled, >=52 both seasons, n>=60 ===")
survivors=[]
for D in (10,15,20,25):
    base=[r for r in rows if r["D"]==D]
    bt=pct(sum(1 for r in base if r["tight"]),len(base))
    print(f"--- crossing D={D} (baseline all: tighten {bt}% n={len(base)}) ---")
    for name,f in CELLS:
        cell=[r for r in base if f(r)]
        n=len(cell)
        if n<20: continue
        k=sum(1 for r in cell if r["tight"])
        c24=[r for r in cell if r["season"]==2024]; c25=[r for r in cell if r["season"]==2025]
        p,p4,p5=pct(k,n),pct(sum(1 for r in c24 if r["tight"]),len(c24)),pct(sum(1 for r in c25 if r["tight"]),len(c25))
        n6=[r["net6"] for r in cell if r["net6"] is not None]
        m6=sum(n6)/len(n6) if n6 else None
        adv=(p or 0)>=58 and (p4 or 0)>=52 and (p5 or 0)>=52 and n>=60
        if adv: survivors.append((D,name,p,n))
        print(f"  {name:22} tighten {p:5}% (24:{p4:5}% n={len(c24):3} | 25:{p5:5}% n={len(c25):3}) n={n:3} | net6m {m6:+.2f}" + ("  <<< ADVANCES" if adv else ""))
print("\nSURVIVORS:",survivors if survivors else "NONE")
