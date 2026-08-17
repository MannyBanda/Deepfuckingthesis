#!/usr/bin/env python3
"""T5 free characterization tests — prereg 2026-08-17 (07ab416).
On-disk corpus only. Zero API calls."""
import json, gzip, glob, os
from statistics import pstdev

def gapcell(g): return 'better' if g >= .15 else ('worse' if g <= -.15 else 'even')
def rate(v): return (len(v), round(100*sum(v)/len(v),1)) if v else (0,None)
def power(n): return 'HIGH' if n>=200 else ('MED' if n>=80 else 'LOW')

BUCKETS = [('Q1',30,600),('Q2',600,1200),('Q3',1200,1800),('Q4e',1800,2100),('Q4l',2100,2400)]

def load(path):
    """Return (games_with_asof, dates). Each: (g, wp, gp) with as-of wp and GP counts."""
    games = json.load(gzip.open(path,'rt'))
    games = [g for g in games if g.get('ev') and g.get('winner')]
    rec, out = {}, []
    for g in games:
        h,a = g['home_id'], g['away_id']
        hw,hn = rec.get(h,(0,0)); aw,an = rec.get(a,(0,0))
        if hn>=1 and an>=1:
            out.append((g, {h:hw/hn, a:aw/an}, {h:hn, a:an}))
        for t in (h,a):
            w,n = rec.get(t,(0,0))
            rec[t] = (w + (1 if g['winner']==t else 0), n+1)
    return out

def walk(out, lo, hi, step=30, dmin=1, dmax=9, gpguard=5):
    """Yield states: (gid, t, trail_id, deficit, gap, won, trailer_is_home, start)"""
    rows=[]
    for g, wp, gp in out:
        if gp[g['home_id']] < gpguard or gp[g['away_id']] < gpguard: continue
        ev = sorted([e for e in g['ev'] if e.get('c') is not None], key=lambda e:e['c'])
        if not ev: continue
        i,h,a = 0,0,0
        for t in range(lo,hi,step):
            while i < len(ev) and ev[i]['c'] <= t:
                h,a = ev[i]['h'], ev[i]['a']; i+=1
            if h==a: continue
            d = abs(h-a)
            if not (dmin<=d<=dmax): continue
            lead,trail = (g['home_id'],g['away_id']) if h>a else (g['away_id'],g['home_id'])
            rows.append((g['gid'], t, trail, d, wp[trail]-wp[lead], g['winner']==trail,
                         trail==g['home_id'], g['start']))
    return rows

def gameweight(rows):
    first={}
    for gid,t,tr,d,gap,won,hm,st in rows:
        k=(gid,tr)
        if k not in first or t<first[k][0]: first[k]=(t,d,gap,won,hm,st)
    return [(k[0],v[0],k[1],v[1],v[2],v[3],v[4],v[5]) for k,v in first.items()]

def premium(rows):
    c={}
    for r in rows: c.setdefault(gapcell(r[4]),[]).append(r[5])
    b=rate(c.get('better',[])); e=rate(c.get('even',[]))
    return (round(b[1]-e[1],1) if b[1] is not None and e[1] is not None else None, b[0], b[1])

LEAGUES={}
base=os.path.dirname(os.path.abspath(__file__))
for f in sorted(glob.glob(os.path.join(base,'*_states.json.gz'))):
    b=os.path.basename(f)
    lg='EuroLeague' if b.startswith('el_') else b.split('_')[0]
    LEAGUES.setdefault(lg,[]).append(f)

CACHE={lg:[load(p) for p in sorted(ps)] for lg,ps in LEAGUES.items()}

print("="*78); print("H1 — TIME DECAY PER LEAGUE (gap>=.15, deficit 1-9, game-weighted per bucket)"); print("="*78)
print("%-18s %-11s %-11s %-11s %-11s %-11s  mono" % ("league","Q1","Q2","Q3","Q4-early","Q4-late"))
h1={}
for lg,seasons in sorted(CACHE.items()):
    cells={}; legmono=[]
    for si,out in enumerate(seasons):
        segs={}
        for nm,lo,hi in BUCKETS:
            rr=[r for r in gameweight(walk(out,lo,hi)) if r[4]>=.15]
            segs[nm]=[r[5] for r in rr]
            cells.setdefault(nm,[]).extend(segs[nm])
        vals=[rate(segs[nm])[1] for nm,_,_ in BUCKETS]
        ok=[v for v in vals if v is not None]
        legmono.append(all(ok[i]>=ok[i+1] for i in range(len(ok)-1)) if len(ok)>2 else None)
    vals=[rate(cells[nm]) for nm,_,_ in BUCKETS]
    ok=[v[1] for v in vals if v[1] is not None]
    pooled=all(ok[i]>=ok[i+1] for i in range(len(ok)-1))
    both=all(x is True for x in legmono)
    h1[lg]={'buckets':{nm:vals[i] for i,(nm,_,_) in enumerate(BUCKETS)},'pooled_mono':pooled,'both_seasons':both}
    print("%-18s %-11s %-11s %-11s %-11s %-11s  %s" % (lg,
        *["%.1f(%d)"%(v[1],v[0]) if v[1] is not None else "-" for v in vals],
        "STRUCT" if both else ("pooled" if pooled else "no")))

print(); print("="*78); print("H2 — HOME-COURT CONFOUND (better-cell premium by trailer venue, 750-1800s)"); print("="*78)
print("%-18s %-16s %-16s %8s  verdict" % ("league","home-trailer","away-trailer","diff"))
h2={}
for lg,seasons in sorted(CACHE.items()):
    allrows=[]; legdiff=[]
    for out in seasons:
        rr=gameweight(walk(out,750,1800)); allrows+=rr
        hp=premium([r for r in rr if r[6]])[0]; ap=premium([r for r in rr if not r[6]])[0]
        legdiff.append(hp-ap if None not in (hp,ap) else None)
    hp,hn,_=premium([r for r in allrows if r[6]]); ap,an,_=premium([r for r in allrows if not r[6]])
    diff=round(hp-ap,1) if None not in (hp,ap) else None
    signhold=all(d is not None and d>0 for d in legdiff)
    flag='FLAGGED' if (diff is not None and diff>=10 and signhold) else 'clean'
    h2[lg]={'home':(hp,hn),'away':(ap,an),'diff':diff,'flag':flag,'legs':legdiff}
    print("%-18s %-16s %-16s %8s  %s" % (lg,"%+.1f (n=%d)"%(hp,hn),"%+.1f (n=%d)"%(ap,an),
          "%+.1f"%diff if diff is not None else "-", flag))

json.dump({'h1':h1,'h2':{k:{kk:(list(vv) if isinstance(vv,tuple) else vv) for kk,vv in v.items()} for k,v in h2.items()}},
          open(os.path.join(base,'freetests_h1h2.json'),'w'), indent=1, default=str)
print("\nsaved freetests_h1h2.json")
