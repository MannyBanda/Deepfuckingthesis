# 2026-08-11 — SENSITIVITY BATTERY (pre-registered in 04b1882 §"Sensitivity runs")
# Variants: core tier top5/top7/top8 | window K=10/6 | mpg per-team-game vs per-game-played
import json
from collections import defaultdict

ALIAS = {'LVA':'LV','NYL':'NY','GSV':'GS','WAS':'WSH','LAS':'LA','PDX':'POR','TOY':'TOR'}
al = lambda a: ALIAS.get(a, a)
TEAM_MIN = 200.0

raw = json.load(open('/tmp/hist_checkpoints_raw.json'))
bdl = json.load(open('/tmp/bdl_games_2425.json'))
ps  = json.load(open('/tmp/wnba_playerstats_2425.json'))

def mins(v):
    if v in (None, ''): return 0.0
    s = str(v)
    if ':' in s:
        p = s.split(':'); return float(p[0]) + float(p[1])/60.0
    try: return float(s)
    except: return 0.0

gtp = defaultdict(dict)
for r in ps: gtp[(r['gid'], al(r['team']))][r['pid']] = mins(r['min'])

bkey = {(g['date'][:10], al(g['visitor_team']['abbreviation']), al(g['home_team']['abbreviation'])): g['id'] for g in bdl}
gid2bdl = {g['game_id']: bkey[(str(g['date'])[:10], al(g['away']), al(g['home']))]
           for g in raw if (str(g['date'])[:10], al(g['away']), al(g['home'])) in bkey}

tsched = defaultdict(list)
for g in bdl:
    d = g['date'][:10]
    tsched[al(g['visitor_team']['abbreviation'])].append((d, g['id']))
    tsched[al(g['home_team']['abbreviation'])].append((d, g['id']))
for t in tsched: tsched[t].sort()

def avail(team, date, bg, K, floor, per_team_game):
    prior = [x for dd, x in tsched.get(team, []) if dd < date][-K:]
    if len(prior) < max(4, K//2): return None
    tot, app = defaultdict(float), defaultdict(int)
    for pg in prior:
        for pid, m in gtp.get((pg, team), {}).items():
            tot[pid] += m
            if m > 0: app[pid] += 1
    mpg = {p: (tot[p]/len(prior) if per_team_game else (tot[p]/app[p] if app[p] else 0.0)) for p in tot}
    order = sorted([p for p in mpg if mpg[p] > 0], key=lambda p: -mpg[p])
    rot = {p: mpg[p] for p in mpg if mpg[p] >= floor}
    if not rot: return None
    today = gtp.get((bg, team), {})
    if not today: return None
    isout = lambda p: today.get(p, 0.0) <= 0.0
    out_rot = [p for p in rot if isout(p)]
    return dict(o5=sum(1 for p in order[:5] if isout(p)),
                o7=sum(1 for p in order[:7] if isout(p)),
                o8=sum(1 for p in order[:8] if isout(p)),
                share=sum(rot[p] for p in out_rot)/TEAM_MIN,
                share7=sum(mpg[p] for p in order[:7] if isout(p))/TEAM_MIN)

tl = defaultdict(list)
for g in raw:
    hA, aA = al(g['home']), al(g['away']); w = al(g['winner']) if g['winner'] else None
    tl[hA].append((str(g['date'])[:10], w == hA)); tl[aA].append((str(g['date'])[:10], w == aA))
for t in tl: tl[t].sort()
def rec(t, d):
    gs = [w for dd, w in tl.get(t, []) if dd < d]
    return (len(gs), sum(gs)/len(gs) if gs else None)
def tbucket(l):
    q, p = l.split('_'); return f"{q}-{'early' if p in ('7.5','5') else 'late'}"

def build(K=10, floor=8.0, per_team_game=True):
    seen, S = set(), []
    for g in raw:
        gid = g['game_id']
        if gid not in gid2bdl: continue
        bg = gid2bdl[gid]; hA, aA, date = al(g['home']), al(g['away']), str(g['date'])[:10]
        avH = avail(hA, date, bg, K, floor, per_team_game); avA = avail(aA, date, bg, K, floor, per_team_game)
        if not avH or not avA: continue
        for c in sorted(g['checkpoints'], key=lambda x: x['gameSec']):
            p = c['period']
            if p not in (2,3,4): continue
            h, a = c['home'], c['away']; hp, ap = h['pts'] or 0, a['pts'] or 0
            m = abs(hp-ap)
            if m < 1 or m > 15: continue
            ldH = hp > ap; L, T = (h,a) if ldH else (a,h)
            ldAl, trAl = (hA,aA) if ldH else (aA,hA)
            key = (gid, ldAl, tbucket(c['label']))
            if key in seen: continue
            if (L['fga'] or 0) < 12 or (T['fga'] or 0) < 12: continue
            gl, gt = rec(ldAl, date), rec(trAl, date)
            if gl[0] < 10 or gt[0] < 10: continue
            seen.add(key)
            avL, avT = (avH, avA) if ldH else (avA, avH)
            if g['winner'] is None: continue
            S.append(dict(season=g['season'], margin=m, gap=gt[1]-gl[1],
                          t5=avT['o5'], t7=avT['o7'], t8=avT['o8'],
                          tsh=avT['share'], tsh7=avT['share7'],
                          l7=avL['o7'], lsh=avL['share'],
                          won=(al(g['winner']) == trAl)))
    return S

def conv(a): return 100.0*sum(1 for s in a if s['won'])/len(a) if a else None
def pw(n): return 'HIGH' if n>=200 else ('MED' if n>=80 else 'LOW')

def headcount(S, field, label):
    IB = [s for s in S if 1 <= s['margin'] <= 9]
    print(f"\n  {label}  (in-band n={len(IB)})")
    print(f"    {'out':<8}{'n':>6}{'conv':>8}{'power':>7}   2024 / 2025")
    for k, f in (('0', lambda s: s[field]==0), ('1', lambda s: s[field]==1),
                 ('2', lambda s: s[field]==2), ('3+', lambda s: s[field]>=3)):
        c = [s for s in IB if f(s)]
        if not c: continue
        c24=[x for x in c if x['season']==2024]; c25=[x for x in c if x['season']==2025]
        f2 = lambda a: f"{conv(a):.0f}%(n={len(a)})" if a else "-"
        print(f"    {k:<8}{len(c):>6}{conv(c):>7.1f}%{pw(len(c)):>7}   {f2(c24)} / {f2(c25)}")
    lo=[s for s in IB if s[field]==0]; hi=[s for s in IB if s[field]>=2]
    if lo and hi: print(f"    spread 0 vs 2+ = {conv(lo)-conv(hi):+.1f}pp   (H4 bar 10.0pp, n={len(hi)} {pw(len(hi))})")

print("="*72); print("PRIMARY SPEC  K=10, floor 8.0, mpg per-team-game"); print("="*72)
S = build()
print(f"states {len(S)}")
for fld, lab in (('t5','CORE = top-5 by recent minutes'), ('t7','CORE = top-7 (rotation tier)'), ('t8','CORE = top-8')):
    headcount(S, fld, lab)

print("\n  top-7 minutes-share bands (in-band):")
IB=[s for s in S if 1<=s['margin']<=9]
for lab, f in (('0', lambda s: s['tsh7']<=0), ('(0,.10]', lambda s: 0<s['tsh7']<=.10),
               ('(.10,.20]', lambda s: .10<s['tsh7']<=.20), ('>.20', lambda s: s['tsh7']>.20)):
    c=[s for s in IB if f(s)]
    if c: print(f"    {lab:<11} n={len(c):>5} conv={conv(c):>5.1f}%  {pw(len(c))}")

print("\n  top-7 rule variants (in-band):")
for lab, f in (('t7>=2', lambda s: s['t7']>=2), ('t7>=3', lambda s: s['t7']>=3),
               ('t7>=2 OR sh>=.25', lambda s: s['t7']>=2 or s['tsh']>=.25),
               ('t7>=3 OR sh>=.30', lambda s: s['t7']>=3 or s['tsh']>=.30)):
    c=[s for s in IB if f(s)]; o=[s for s in IB if not f(s)]
    if c: print(f"    {lab:<18} flagged n={len(c):>5} conv={conv(c):>5.1f}% vs rest {conv(o):>5.1f}% = {conv(o)-conv(c):+5.1f}pp  {pw(len(c))}")

for K, ptg, lab in ((6, True, "K=6 window"), (10, False, "mpg among games PLAYED")):
    print("\n" + "="*72); print(f"SENSITIVITY — {lab}"); print("="*72)
    S2 = build(K=K, per_team_game=ptg)
    print(f"states {len(S2)}")
    headcount(S2, 't5', 'CORE top-5')
    headcount(S2, 't7', 'CORE top-7')
