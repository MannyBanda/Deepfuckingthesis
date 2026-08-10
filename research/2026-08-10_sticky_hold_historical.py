# 2026-08-10 - STICKY HOLD Phase 3: 2025 historical replication (pre-registered)
# Data: cached SR per-period stats (203-game stratified 2025 sample, zero SR hits)
# + full BDL 2025 schedule for unbiased as-of records. States at end-Q1/Q2/Q3
# boundaries; period bands mapped to the NEXT quarter (end-Qk ~ earliest Q(k+1)
# live state). Sticky = EARNED (no red band / 3share>=40 / POT>=6) + trailer
# period-green + trailer cum TO < 4 (exact computeFuelTemp parity; vShare leg
# absent historically = matches live nulls). Primary metric: sticky vs
# non-sticky SEPARATION in dog cells (stratified sample biases absolutes).
# Bar (pre-reg): pooled dog-cell sticky n>=40, hold >=55%, separation >=15pp.
# 10+ leads reported as separate cells per PM request.
import json

EFG_BANDS = {1:(54,61), 2:(56,63), 3:(58,66), 4:(60,69)}
games = json.load(open('/tmp/hist_states_raw.json'))
sched = json.load(open('/tmp/games_2025.json'))

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

def cum(periods, k, f):
    s = 0
    for p in periods[:k]:
        if p and p.get(f) is not None: s += p[f]
    return s

states = []
for g in games:
    hA, aA = al(g['home']), al(g['away'])
    for k in (1, 2, 3):
        band_p = k + 1
        hp_, ap_ = g['home_periods'], g['away_periods']
        if len(hp_) < k or len(ap_) < k: continue
        hpts, apts = cum(hp_,k,'pts'), cum(ap_,k,'pts')
        m = abs(hpts - apts)
        if m < 1: continue
        ldH = hpts > apts
        L, T = (hp_, ap_) if ldH else (ap_, hp_)
        ldAl, trAl = (hA, aA) if ldH else (aA, hA)
        lfgm, lfga, lf3 = cum(L,k,'fgm'), cum(L,k,'fga'), cum(L,k,'f3m')
        tfgm, tfga, tf3 = cum(T,k,'fgm'), cum(T,k,'fga'), cum(T,k,'f3m')
        if lfga < 12 or tfga < 12: continue
        lEfg = (lfgm + 0.5*lf3)/lfga*100
        tEfg = (tfgm + 0.5*tf3)/tfga*100
        lPts = hpts if ldH else apts
        three = 3*lf3/lPts*100 if lPts else 0
        lBand = 'red' if lEfg > EFG_BANDS[band_p][1] else ('orange' if lEfg > EFG_BANDS[band_p][0] else 'green')
        heat = lBand == 'red' or three >= 40
        takeaway = cum(L,k,'pot') >= 6
        earned = not heat and not takeaway
        tGreen = tEfg <= EFG_BANDS[band_p][0]
        clean = cum(T,k,'to') < 4
        gl, gt = asof(ldAl, g['date']), asof(trAl, g['date'])
        if gl[0] < 10 or gt[0] < 10: continue
        states.append(dict(gid=g['game_id'], date=g['date'], boundary=f"endQ{k}", margin=m,
            band=('1-9' if m <= 9 else '10+'), leader=ldAl, trailer=trAl,
            gap=round(gt[1]-gl[1],3), sticky=earned and tGreen and clean, earned=earned,
            holds=(g['winner']==ldAl)))

first = {}
for s in states:
    if s['sticky'] and (s['gid'] not in first or s['boundary'] < first[s['gid']]['boundary']):
        first[s['gid']] = s
firstS = list(first.values())
nsFirst = {}
for s in states:
    if not s['sticky'] and (s['gid'] not in nsFirst or s['boundary'] < nsFirst[s['gid']]['boundary']):
        nsFirst[s['gid']] = s
nsF = [s for gid, s in nsFirst.items() if gid not in first]

hold = lambda a: f"HOLDS {100*sum(1 for s in a if s['holds'])/len(a):.1f}% (n={len(a)})" if a else "- (n=0)"
print(f"2025 boundary states: {len(states)} | sticky: {sum(1 for s in states if s['sticky'])} | sticky games: {len(firstS)}")
print(f"\nPRIMARY (first sticky per game, band 1-9):")
b19 = [s for s in firstS if s['band']=='1-9']
print(f"  all sticky:            {hold(b19)}")
print(f"  dog leader (gap>=.15): {hold([s for s in b19 if s['gap']>=0.15])}")
print(f"  gap < .15:             {hold([s for s in b19 if s['gap']<0.15])}")
print(f"\nCONTEXT non-sticky first-state games (band 1-9):")
nb19 = [s for s in nsF if s['band']=='1-9']
print(f"  all: {hold(nb19)} | dog leader: {hold([s for s in nb19 if s['gap']>=0.15])}")
print(f"\n10+ LEADS (all states, per PM request):")
print(f"  sticky 10+:     {hold([s for s in states if s['sticky'] and s['band']=='10+'])}")
print(f"  non-sticky 10+: {hold([s for s in states if not s['sticky'] and s['band']=='10+'])}")
print(f"\nby boundary (sticky, band 1-9): ", {b: hold([s for s in b19 if s['boundary']==b]) for b in ('endQ1','endQ2','endQ3')})
json.dump(states, open('/tmp/hist_boundary_states.json','w'))
print("\nsaved -> /tmp/hist_boundary_states.json")
