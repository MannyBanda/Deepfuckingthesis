# Phase 0b — counts/cut points only on the FINE arena fires. No outcome fields are read.
import json, gzip, collections, statistics as st, sys
d=json.load(gzip.open('research/2026-10-23_fine_nba_canary_fires.json.gz','rt'))
rows=d['rows']; print("investigations",len(rows),"games",d['counts']['games'],"config deviations:",d['config'].get('deviations'))
print("pattern counts:",d['counts']['pattern'])
cl=[r for r in rows if r['pattern']=='CLEAN']; cl1=[r for r in cl if r['trigger']['margin']>=1]
# dedupe one row per game: prefer tracked_proxy, then earliest push
byg={}
for r in sorted(cl1,key=lambda r:(not r['tracked_proxy'], r['push']['idx'])):
    byg.setdefault(r['gid'],r)
ded=list(byg.values()); tr=[r for r in ded if r['tracked_proxy']]
print(f"CLEAN {len(cl)} | margin>=1 {len(cl1)} | one-per-game {len(ded)} | + tracked_proxy {len(tr)} | games with CLEAN on BOTH sides {sum(1 for g,c in collections.Counter(r['gid'] for r in cl1).items() if c>1)}")
def mb(m): return '1-3' if m<=3 else '4-8' if m<=8 else '9-15' if m<=15 else '16+'
for name,pop in [('CLEAN one-per-game m>=1',ded),('  ...tracked_proxy',tr)]:
    print(f"\n== {name} n={len(pop)}")
    print(" margin@trigger:",dict(sorted(collections.Counter(mb(r['trigger']['margin']) for r in pop).items())))
    pm=collections.Counter(('ctrl trailing/tied' if r['push']['ctrl_margin']<1 else mb(r['push']['ctrl_margin'])) for r in pop)
    print(" margin@push:",dict(sorted(pm.items())), f"-> still leading at push: {sum(v for k,v in pm.items() if k!='ctrl trailing/tied')}/{len(pop)}")
    lat=sorted(r['push']['game_min_after_trigger'] for r in pop); print(f" push latency (game-min): median {st.median(lat)} p25 {lat[len(lat)//4]} p75 {lat[3*len(lat)//4]}")
    print(" trigger period:",dict(sorted(collections.Counter(r['trigger']['p'] for r in pop).items()))," push period:",dict(sorted(collections.Counter(r['push']['p'] for r in pop).items())))
    print(" trigger reason:",dict(collections.Counter(r['trigger']['reason'] for r in pop))," prior_investigations:",dict(sorted(collections.Counter(r['prior_investigations'] for r in pop).items())))
    print(" floor@trigger >.75:",sum(1 for r in pop if (r['trigger']['floor'] or 0)>0.75))
    def feats(r):
        L=r['trigger'][r['ctrl_side']]; T=r['trigger']['a' if r['ctrl_side']=='h' else 'h']
        f1=L['pot']-T['pot']; f2=T['to']/T['poss'] if T['poss']>0 else None
        P=r['push']['a' if r['ctrl_side']=='h' else 'h']; dpos=P['poss']-T['poss']; f3=((P['to']-T['to'])/dpos - f2) if dpos>0 and f2 is not None else None
        return f1,f2,f3,L['fta']-T['fta'],(T['tou']/T['to']) if T['to']>0 else None,dpos
    F=[feats(r) for r in pop]
    def terc(xs):
        xs=sorted(x for x in xs if x is not None); n=len(xs); return (round(xs[n//3],3),round(xs[2*n//3],3),n) if n else None
    print(" F1 net POT:",terc([f[0] for f in F])," F2 trailer TO rate:",terc([f[1] for f in F])," F3 clean-up delta:",terc([f[2] for f in F])," F4 FTA edge:",terc([f[3] for f in F])," F5 trailer unforced share:",terc([f[4] for f in F]))
    print(" post-trigger trailer poss at push: median",round(st.median([f[5] for f in F]),1),"p25",round(sorted(f[5] for f in F)[len(F)//4],1))
    print(" chronological median date:",sorted(r['date'] for r in pop)[len(pop)//2])
print("\nbase_rates cells",len(d['base_rates']),"states",sum(v['n'] for v in d['base_rates'].values()))
