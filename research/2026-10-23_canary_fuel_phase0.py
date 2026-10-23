import json, collections, statistics as st
d=json.load(__import__('gzip').open('research/2026-10-23_canary_fuel_fires.json.gz','rt')); rows=d['rows']
print("games", d['totalAvailable'], "fires", len(rows))
dates=sorted(r['date'] for r in rows if r['date'])
print("date range", dates[0], "->", dates[-1])
print("season", collections.Counter(r['season'] for r in rows))
print("game_type", collections.Counter(r['game_type'] for r in rows))
print("pattern_prod", collections.Counter(r['pattern_prod'] or 'UNCLASSIFIED' for r in rows))
print("pattern_posthoc", collections.Counter(r['pattern_posthoc'] for r in rows))
xt=collections.Counter((r['pattern_prod'] or 'UNCLASS', r['pattern_posthoc']) for r in rows)
print("prod x posthoc:"); [print("  ",k,v) for k,v in sorted(xt.items())]
clean=[r for r in rows if r['pattern_prod']=='CLEAN']
print("\nCLEAN(prod) n", len(clean), "by season", collections.Counter(r['season'] for r in clean), "by game_type", collections.Counter(r['game_type'] for r in clean))
# chronological halves
cd=sorted(r['date'] for r in clean); mid=cd[len(cd)//2]; print("CLEAN chronological median date", mid)
print("trigger_cp", collections.Counter(r['trigger_cp'] for r in clean))
print("prod_cp (push moment)", collections.Counter(r['prod_cp'] for r in clean))
print("trigger_reason", collections.Counter(r['trigger_reason'] for r in clean))
def mb(m): return '1-3' if m<=3 else '4-8' if m<=8 else '9-15' if m<=15 else '16+'
print("CLEAN margin@trigger buckets (n only)", collections.Counter(mb(r['trigger_margin']) for r in clean))
print("CLEAN margin@push buckets (n only)", collections.Counter(mb(r['path'][r['prod_idx']]['ctrl_margin']) if r['path'][r['prod_idx']]['ctrl_margin']>=1 else 'ctrl trailing/tied' for r in clean))
print("POT non-null at trigger (CLEAN)", sum(1 for r in clean if r['trig']['h']['pot'] is not None and r['trig']['a']['pot'] is not None), "/", len(clean))
print("xgb non-null at trigger (CLEAN)", sum(1 for r in clean if r['trigger_xgb'] is not None), "/", len(clean))
print("floor@trigger >.75 (CLEAN)", sum(1 for r in clean if (r['trigger_floor'] or 0)>0.75), "/", len(clean))
# features
def feats(r):
    L = r['trig']['h'] if r['ctrl_is_home'] else r['trig']['a']
    T = r['trig']['a'] if r['ctrl_is_home'] else r['trig']['h']
    f1 = (L['pot'] - T['pot']) if (L['pot'] is not None and T['pot'] is not None) else None
    f2 = T['to']/T['poss'] if T['poss']>0 else None
    p = r['path'][r['prod_idx']]; Tp = p['a'] if r['ctrl_is_home'] else p['h']
    dpos = Tp['poss']-T['poss']; dto = Tp['to']-T['to']
    f3 = (dto/dpos - f2) if (dpos>0 and f2 is not None) else None
    f4 = L['fta']-T['fta']
    return f1,f2,f3,f4,dpos
F=[feats(r) for r in clean]
def terc(xs):
    xs=sorted(x for x in xs if x is not None); n=len(xs)
    return (xs[n//3], xs[2*n//3], n) if n else None
print("\nF1 net POT (leader-trailer) terciles (lo cut, hi cut, n):", terc([f[0] for f in F]))
print("F2 trailer TO rate terciles:", tuple(round(x,3) if isinstance(x,float) else x for x in terc([f[1] for f in F])))
print("F3 clean-up delta terciles:", tuple(round(x,3) if isinstance(x,float) else x for x in terc([f[2] for f in F])))
print("F4 FTA edge terciles:", terc([f[3] for f in F]))
print("post-trigger trailer poss at push: median", st.median([f[4] for f in F]), "min", min(f[4] for f in F))
print("F3 null (dpos<=0)", sum(1 for f in F if f[2] is None))
# WAVE secondary
print("\nWAVE(prod) n", sum(1 for r in rows if r['pattern_prod']=='WAVE'), "| posthoc CLEAN n", sum(1 for r in rows if r['pattern_posthoc']=='CLEAN'))
print("base_rates cells", len(d['base_rates']), "total checkpoint-states", sum(v['n'] for v in d['base_rates'].values()))
