# 2026-08-10 - SPEC CUTS 1-5, regime-stratified (pre-registered in chat, PM go)
# Arena: checkpoint reconstruction, 2024+2025 (cached PBP, zero external calls).
# Unit: per-bucket dedupe (one state per leader|game|timebucket) = 2026 study recipe.
# Regime = fuel pulse (league-wide TRANSIENT-lead collapse rate), per season,
# defined independently of the cells under test. RULE: a cut is "structural"
# only if it holds in BOTH seasons; sign-flips = regime-contingent, pulse-gated.
import json
from collections import Counter

EB = {2:(56,63), 3:(58,66), 4:(60,69)}
raw = {g['game_id']: g for g in json.load(open('/tmp/hist_checkpoints_raw.json'))}
sched = json.load(open('/tmp/games_2024.json')) + json.load(open('/tmp/games_2025.json'))
ALIAS = {'LVA':'LV','NYL':'NY','GSV':'GS','WAS':'WSH','LAS':'LA','PDX':'POR','TOY':'TOR'}
al = lambda a: ALIAS.get(a, a)
tl = {}
for g in sched:
    for t, won in ((al(g['home']), g['winner']==g['home']), (al(g['away']), g['winner']==g['away'])):
        tl.setdefault(t, []).append((g['date'], won))
for t in tl: tl[t].sort()
def rec(t, d):
    gs = [w for dd, w in tl.get(t, []) if dd < d]
    return (len(gs), sum(gs)/len(gs) if gs else None)

def tbucket(lbl):
    q, part = lbl.split('_')
    return f"{q}-{'early' if part in ('7.5','5') else 'late'}"

seen, S = set(), []
for g in raw.values():
    hA, aA = al(g['home']), al(g['away'])
    for c in sorted(g['checkpoints'], key=lambda x: x['gameSec']):
        p = c['period']
        if p not in EB: continue
        h, a = c['home'], c['away']
        hp, ap = h['pts'] or 0, a['pts'] or 0
        m = abs(hp - ap)
        if m < 1 or m > 15: continue
        ldH = hp > ap
        L, T = (h, a) if ldH else (a, h)
        ldAl, trAl = (hA, aA) if ldH else (aA, hA)
        key = (g['game_id'], ldAl, tbucket(c['label']))
        if key in seen: continue
        if (L['fga'] or 0) < 12 or (T['fga'] or 0) < 12: continue
        seen.add(key)
        lEfg = (L['fgm'] + 0.5*L['f3m'])/L['fga']*100
        tEfg = (T['fgm'] + 0.5*T['f3m'])/T['fga']*100
        lPts = hp if ldH else ap
        three = 3*(L['f3m'] or 0)/lPts*100 if lPts else 0
        lBand = 'red' if lEfg > EB[p][1] else ('orange' if lEfg > EB[p][0] else 'green')
        earned = not (lBand=='red' or three >= 40 or (L['pot'] or 0) >= 6)
        gl, gt = rec(ldAl, g['date']), rec(trAl, g['date'])
        if gl[0] < 10 or gt[0] < 10: continue
        S.append(dict(season=g['season'], date=g['date'], gid=g['game_id'],
            tb=tbucket(c['label']), period=p, margin=m, leader=ldAl, trailer=trAl,
            lwp=gl[1], twp=gt[1], lgp=gl[0], tgp=gt[0], gap=gt[1]-gl[1],
            lefg=lEfg, tefg=tEfg, lband=lBand, earned=earned,
            ttemp=('cold' if tEfg < 45 else 'hot' if tEfg > 55 else 'warm'),
            won=(g['winner']==trAl)))

conv = lambda a: (100*sum(1 for s in a if s['won'])/len(a)) if a else None
def fmt(a):
    c = conv(a)
    return f"{c:5.1f}% (n={len(a):4d})" if c is not None else "   -  (n=   0)"
def bys(pop, f):
    return " | ".join(f"{yr}: {fmt([s for s in pop if s['season']==yr and f(s)])}" for yr in (2024, 2025))
def row(label, pop, f):
    sub = [s for s in pop if f(s)]
    print(f"  {label:24s} POOLED {fmt(sub)}   ||  {bys(pop, f)}")

print(f"ARENA: {len(S)} deduped states | seasons {Counter(s['season'] for s in S)}")

# ── REGIME METRIC (independent): transient-lead collapse rate, gap-qualified ──
print("\n=== REGIME PULSE (independent metric): transient-lead collapse rate ===")
for yr in (2024, 2025):
    tr = [s for s in S if s['season']==yr and s['gap']>=0.15 and s['margin']<=9 and not s['earned']]
    print(f"  {yr}: transient dog-lead collapse {fmt(tr)}")

BAND = [s for s in S if s['margin'] <= 9]
OP = [s for s in BAND if s['gap'] >= 0.15]

print("\n=== CUT 1 — GAP MAGNITUDE (in-band, pre-Q4+Q4) ===")
for lo, hi, lbl in [(-9,0.05,'gap <.05'),(0.05,0.15,'gap .05-.15'),(0.15,0.25,'gap .15-.25'),(0.25,0.35,'gap .25-.35'),(0.35,9,'gap .35+')]:
    row(lbl, BAND, lambda s, lo=lo, hi=hi: lo <= s['gap'] < hi)

print("\n=== CUT 2 — DEFICIT GEOMETRY (gap>=.15) ===")
allm = [s for s in S if s['gap'] >= 0.15]
for lo, hi in [(1,3),(4,6),(7,9),(10,12),(13,15)]:
    row(f"deficit {lo}-{hi}", allm, lambda s, lo=lo, hi=hi: lo <= s['margin'] <= hi)

print("\n=== CUT 3 — TIME GEOMETRY (gap>=.15, in-band) ===")
for tb in ('Q2-early','Q2-late','Q3-early','Q3-late','Q4-early','Q4-late'):
    row(tb, OP, lambda s, tb=tb: s['tb'] == tb)

print("\n=== CUT 4 — TEMP x LEAD TYPE (gap>=.15, in-band) ===")
for temp in ('cold','warm','hot'):
    for e, lbl in ((True,'EARNED'), (False,'TRANSIENT')):
        row(f"trailer {temp} / {lbl}", OP, lambda s, t=temp, e=e: s['ttemp']==t and s['earned']==e)

print("\n=== CUT 5 — LEADER/TRAILER QUALITY STRATA (in-band) ===")
print("  [leader strata, trailer gap>=.15]")
for lo, hi, lbl in [(0,0.40,'leader <.400'),(0.40,0.550,'leader .400-.550'),(0.550,9,'leader >=.550')]:
    row(lbl, OP, lambda s, lo=lo, hi=hi: lo <= s['lwp'] < hi)
print("  [trailer eliteness within each leader stratum — research-elite = wp>=.600 & GP>=15]")
elite = lambda s: s['twp'] >= 0.600 and s['tgp'] >= 15
for lo, hi, lbl in [(0,0.40,'ldr<.400'),(0.40,0.550,'ldr.400-.550'),(0.550,9,'ldr>=.550')]:
    sub = [s for s in OP if lo <= s['lwp'] < hi]
    row(f"{lbl} + ELITE trailer", sub, elite)
    row(f"{lbl} + non-elite trailer", sub, lambda s: not elite(s))
print("  [MIN@DAL shape isolated: elite trailer, leader >=.550]")
row("elite tr / ldr>=.550", OP, lambda s: elite(s) and s['lwp'] >= 0.550)
json.dump(S, open('/tmp/spec_cut_states.json','w'))
