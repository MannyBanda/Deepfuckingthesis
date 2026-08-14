import json, gzip
games=json.load(gzip.open("/tmp/hist_marks.json.gz","rt"))
def pct(k,n): return round(100*k/n,1) if n else None

def series(g, side):
    out=[]
    for c in g["cps"]:
        own=c["h"]["pts"] if side=="home" else c["a"]["pts"]
        op =c["a"]["pts"] if side=="home" else c["h"]["pts"]
        out.append((c["s"], op-own))
    return out

def fire_PB(ser, D, k):
    mx=-99
    for s,d in ser:
        if d>mx: mx=d
        if mx>=D and d<=mx-k: return (s,d,mx)
    return None
def fire_ST(ser, D, m):
    mx=-99; mx_at=None
    for s,d in ser:
        if d>mx: mx=d; mx_at=s
        if mx>=D and mx_at is not None and s-mx_at>=m*60 and d>=mx-2: return (s,d,mx)
    return None
def fire_TB(ser, D):
    for s,d in ser:
        if d>=D:
            return (s,d,d) if s<=1800 else None
    return None
def fire_naive(ser, D):
    for s,d in ser:
        if d>=D: return (s,d,d)
    return None

VARIANTS=[("PB-3",lambda ser,D:fire_PB(ser,D,3)),("PB-5",lambda ser,D:fire_PB(ser,D,5)),
          ("PB-7",lambda ser,D:fire_PB(ser,D,7)),("ST-3",lambda ser,D:fire_ST(ser,D,3)),
          ("ST-5",lambda ser,D:fire_ST(ser,D,5)),("TB",fire_TB),("naive(ref)",fire_naive)]

results={}
for D in (15,20):
    for name,fn in VARIANTS:
        rows=[]
        for g in games:
            for side in ("home","away"):
                ser=series(g,side)
                if not ser: continue
                mxall=max(d for _,d in ser)
                if mxall<D: continue  # eligible
                ownF=g["hs"] if side=="home" else g["as"]
                oppF=g["as"] if side=="home" else g["hs"]
                finald=oppF-ownF
                f=fn(ser,D)
                row={"season":g["season"],"eligible":True,"fired":f is not None}
                if f:
                    s0,d0,mx0=f
                    fut=[d for s,d in ser if s>s0]+[finald]
                    row.update({"sec":s0,"d":d0,"net":finald-d0,"tight":finald<d0,
                                "fut_exp":max(fut)-d0 if fut else 0,"no_new_max":(max(fut) if fut else d0)<=mx0})
                rows.append(row)
        results[(D,name)]=rows

print("=== STAGE 1 DISCOVERY (2024-25) — advance bar: tighten>=55 pooled, >=52 both seasons, n>=80 ===")
for D in (15,20):
    print(f"--- depth D={D} ---")
    for name,_ in VARIANTS:
        rows=results[(D,name)]
        elig=len(rows); fired=[r for r in rows if r["fired"]]
        n=len(fired)
        if n==0: print(f"  {name:10} fired 0"); continue
        tight=sum(1 for r in fired if r["tight"])
        t24=[r for r in fired if r["season"]==2024]; t25=[r for r in fired if r["season"]==2025]
        k24=sum(1 for r in t24 if r["tight"]); k25=sum(1 for r in t25 if r["tight"])
        netm=sum(r["net"] for r in fired)/n
        nomax=sum(1 for r in fired if r["no_new_max"])
        exp=sum(r["fut_exp"] for r in fired)/n
        clock=sum(r["sec"] for r in fired)/n
        p_pool=pct(tight,n); p24=pct(k24,len(t24)); p25=pct(k25,len(t25))
        adv = (p_pool or 0)>=55 and (p24 or 0)>=52 and (p25 or 0)>=52 and n>=80
        print(f"  {name:10} cov={pct(n,elig):5}% n={n:3} | TIGHTEN pooled {p_pool}% (24: {p24}% n={len(t24)} | 25: {p25}% n={len(t25)}) | mean net {netm:+.1f} | peak-captured {pct(nomax,n)}% | mean fut-exp +{exp:.1f} | avg fire sec {clock:.0f} {'<<< ADVANCES' if adv else ''}")
