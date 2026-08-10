# 2026-08-10 - STICKY HOLD Phase 3b: checkpoint granularity (2.5-min), 576 games
# 2024+2025 full-population PBP reconstruction (cached, zero external calls).
# Same pre-registered definitions (computeFuelTemp parity, PBP-approx POT).
# Season split 2024 vs 2025 = natural OOS. Calibration control required to pass
# at this granularity before sticky cells are read.
import json
from collections import Counter

EFG_BANDS = {2:(56,63), 3:(58,66), 4:(60,69)}
games = json.load(open('/tmp/hist_checkpoints_raw.json'))
sched = json.load(open('/tmp/games_2024.json')) + json.load(open('/tmp/games_2025.json'))
ALIAS = {'LVA':'LV','NYL':'NY','GSV':'GS','WAS':'WSH','LAS':'LA','PDX':'POR','TOY':'TOR'}
al = lambda a: ALIAS.get(a, a)
tl = {}
for g in sched:
    for t, won in ((al(g['home']), g['winner']==g['home']), (al(g['away']), g['winner']==g['away'])):
        tl.setdefault(t, []).append((g['date'], won))
for t in tl: tl[t].sort()
def asof(t, date):
    gs = [w for d, w in tl.get(t, []) if d < date]
    return (len(gs), sum(gs)/len(gs) if gs else None)

states = []
for g in games:
    hA, aA = al(g['home']), al(g['away'])
    for c in g['checkpoints']:
        p = c['period']
        if p not in EFG_BANDS: continue
        h, a = c['home'], c['away']
        hp, ap = h['pts'] or 0, a['pts'] or 0
        m = abs(hp - ap)
        if m < 1: continue
        ldH = hp > ap
        L, T = (h, a) if ldH else (a, h)
        ldAl, trAl = (hA, aA) if ldH else (aA, hA)
        if (L['fga'] or 0) < 12 or (T['fga'] or 0) < 12: continue
        lEfg = ((L['fgm'] + 0.5*L['f3m'])/L['fga'])*100
        tEfg = ((T['fgm'] + 0.5*T['f3m'])/T['fga'])*100
        lPts = hp if ldH else ap
        three = 3*(L['f3m'] or 0)/lPts*100 if lPts else 0
        lBand = 'red' if lEfg > EFG_BANDS[p][1] else ('orange' if lEfg > EFG_BANDS[p][0] else 'green')
        earned = not (lBand == 'red' or three >= 40 or (L['pot'] or 0) >= 6)
        sticky = earned and tEfg <= EFG_BANDS[p][0] and (T['to'] or 0) < 4
        gl, gt = asof(ldAl, g['date']), asof(trAl, g['date'])
        if gl[0] < 10 or gt[0] < 10: continue
        states.append(dict(gid=g['game_id'], season=g['season'], date=g['date'], label=c['label'],
            gameSec=c['gameSec'], period=p, margin=m, band=('1-9' if m <= 9 else '10+'),
            leader=ldAl, trailer=trAl, gap=round(gt[1]-gl[1],3),
            sticky=sticky, earned=earned, holds=(g['winner']==ldAl)))

hold = lambda a: f"HOLDS {100*sum(1 for s in a if s['holds'])/len(a):.1f}% (n={len(a)})" if a else "- (n=0)"
conv = lambda a: f"trailer WINS {100*sum(1 for s in a if not s['holds'])/len(a):.1f}% (n={len(a)})" if a else "- (n=0)"
def firstPer(pop):
    m = {}
    for s in sorted(pop, key=lambda x: x['gameSec']): m.setdefault(s['gid'], s)
    return list(m.values())

print(f"checkpoint states: {len(states)} across {len(set(s['gid'] for s in states))} games")
b19 = [s for s in states if s['band']=='1-9']
fAll = firstPer(b19)
print(f"\nCALIBRATION (first in-band state per game, n={len(fAll)}):")
print(f"  gap >= +.15: {conv([s for s in fAll if s['gap']>=0.15])}")
print(f"  gap -.15..+.15: {conv([s for s in fAll if -0.15<=s['gap']<0.15])}")
print(f"  gap <= -.15: {conv([s for s in fAll if s['gap']<-0.15])}")

fS = firstPer([s for s in b19 if s['sticky']])
fN = [s for s in firstPer([s for s in b19 if not s['sticky']]) if s['gid'] not in set(x['gid'] for x in fS)]
print(f"\nSTICKY (first sticky per game, band 1-9): games={len(fS)}")
print(f"  all sticky:            {hold(fS)}")
print(f"  dog leader (gap>=.15): {hold([s for s in fS if s['gap']>=0.15])}")
print(f"  gap < .15:             {hold([s for s in fS if s['gap']<0.15])}")
print(f"  non-sticky context:    {hold(fN)} | dog: {hold([s for s in fN if s['gap']>=0.15])}")
print(f"\nSEASON SPLIT (sticky dog cell): 2024 {hold([s for s in fS if s['gap']>=0.15 and s['season']==2024])} | 2025 {hold([s for s in fS if s['gap']>=0.15 and s['season']==2025])}")
print(f"\n10+ LEADS: sticky {hold([s for s in states if s['sticky'] and s['band']=='10+'])} | non-sticky {hold([s for s in states if not s['sticky'] and s['band']=='10+'])}")
print(f"sticky by period: {Counter(s['period'] for s in b19 if s['sticky'])}")
json.dump(states, open('/tmp/hist_cp_states.json','w'))
print("saved -> /tmp/hist_cp_states.json")
