import json, os
exec(open('freetests.py').read().split('print("="*78)')[0])

print("="*72); print("H3 — RECORD MATURITY (better-cell premium by GP guard, game-weighted)"); print("="*72)
print("%-18s %-13s %-13s %-13s %-13s  stability" % ("league","GP>=5","GP>=8","GP>=12","GP>=15"))
h3={}
for lg,seasons in sorted(CACHE.items()):
    prem={}
    for g in (5,8,12,15):
        rows=[]
        for out in seasons: rows+=gameweight(walk(out,750,1800,gpguard=g))
        p,n,_=premium(rows); prem[g]=(p,n)
    vals=[prem[g][0] for g in (5,8,12,15)]
    stab=None
    for i,g in enumerate((5,8,12)):
        if all(abs(vals[j+1]-vals[j])<3 for j in range(i,3) if None not in (vals[j],vals[j+1])):
            stab=g; break
    h3[lg]={str(g):prem[g] for g in prem}; h3[lg]['stability']=stab
    print("%-18s %-13s %-13s %-13s %-13s  %s" % (lg,
        *["%+.1f(%d)"%(prem[g][0],prem[g][1]) if prem[g][0] is not None else "-" for g in (5,8,12,15)],
        ("GP>=%d"%stab) if stab else "unstable"))

print(); print("="*72); print("H4a — GAP THRESHOLD SWEEP (premium vs even-cell, deficit 1-9)"); print("="*72)
print("%-18s %-11s %-11s %-11s %-11s %-11s" % ("league",".05",".10",".15",".25",".35"))
h4={}
for lg,seasons in sorted(CACHE.items()):
    rows=[]
    for out in seasons: rows+=gameweight(walk(out,750,1800))
    line=[]
    for th in (.05,.10,.15,.25,.35):
        b=[r[5] for r in rows if r[4]>=th]; e=[r[5] for r in rows if -th<r[4]<th]
        rb,re_=rate(b),rate(e)
        line.append((round(rb[1]-re_[1],1),rb[0]) if None not in (rb[1],re_[1]) else (None,0))
    h4[lg]={'gap_sweep':line}
    print("%-18s %-11s %-11s %-11s %-11s %-11s" % (lg,
        *["%+.1f(%d)"%(v[0],v[1]) if v[0] is not None else "-" for v in line]))

print(); print("="*72); print("H4b — DEFICIT BAND WIDTH (better-cell rate, gap>=.15)"); print("="*72)
print("%-18s %-13s %-13s %-13s %-13s" % ("league","1-6","1-9","1-12","1-15"))
for lg,seasons in sorted(CACHE.items()):
    line=[]
    for dmax in (6,9,12,15):
        rows=[]
        for out in seasons: rows+=gameweight(walk(out,750,1800,dmax=dmax))
        p,n,br=premium(rows); line.append((br,n))
    h4[lg]['band_sweep']=line
    print("%-18s %-13s %-13s %-13s %-13s" % (lg,
        *["%.1f(%d)"%(v[0],v[1]) if v[0] is not None else "-" for v in line]))

print(); print("="*72); print("H5 — PLAYOFF PROXY (final 10% of season dates) — ORDERING ONLY, LOW power"); print("="*72)
h5={}
for lg,seasons in sorted(CACHE.items()):
    reg,po=[],[]
    for out in seasons:
        rows=gameweight(walk(out,750,1800))
        if not rows: continue
        ds=sorted(r[7] for r in rows); cut=ds[int(len(ds)*.9)]
        reg+=[r for r in rows if r[7]<cut]; po+=[r for r in rows if r[7]>=cut]
    pr,pn,_=premium(reg); qr,qn,_=premium(po)
    h5[lg]={'regular':(pr,pn),'playoff_proxy':(qr,qn)}
    print("  %-18s regular %+6s (n=%-3d) | playoff-window %+6s (n=%-3d) %s" % (lg,
        pr if pr is not None else "-",pn, qr if qr is not None else "-",qn, power(qn)))

json.dump({'h3':h3,'h4':h4,'h5':h5}, open('freetests_h3h5.json','w'), indent=1, default=str)
print("\nsaved freetests_h3h5.json")
