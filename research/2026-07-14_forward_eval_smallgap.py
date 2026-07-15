# ═══════════════════════════════════════════════════════════════════════════
# FORWARD OOS EVALUATION — small-gap lever registration (frozen 2026-07-14)
# Companion to research/2026-07-14_honest_gap_rejected.md Addendum 2.
#
# REGISTERED HYPOTHESIS: in small-gap spots (|g0| < .15), L_vsrest > 0 and
# L_infl > 0 predict elevated trailer-win in the 2026 expansion environment.
# PASS BAR (frozen, no tuning): forward AUC >= 0.58, n >= 60, on spots from
# games dated STRICTLY AFTER 2026-07-14 (never seen by derivation).
#
# Frame (identical to derivation): first snapshot per quarter in {Q2, Q3}
# where a team trails 1-9 -> one spot per game-quarter; both teams >= 4 GP
# entering (strictly pre-game as-of); outcome = trailer won the game.
#
# Usage:  python3 research/2026-07-14_forward_eval_smallgap.py
# Interim runs are monitoring only; the registered pass decision is at
# n >= 60 (season end preferred). Other levers are printed as UNREGISTERED
# context and cannot pass regardless of value.
# Self-contained: pulls everything live (db-api), no cache dependencies.
# ═══════════════════════════════════════════════════════════════════════════
import urllib.request, json, base64, bisect
from collections import defaultdict

CUTOFF = '2026-07-14'   # registration date — spots must be AFTER this
BASE = 'https://poetic-starlight-aa8938.netlify.app/.netlify/functions'
AUTH = 'Basic ' + base64.b64encode(b'manny:DFT2025!').decode()

def api(path, timeout=60):
    req = urllib.request.Request(f'{BASE}{path}', headers={'Authorization': AUTH})
    return json.load(urllib.request.urlopen(req, timeout=timeout))

SR2BDL = {'LVA':'LV','NYL':'NY','GSV':'GS','WAS':'WSH','LAS':'LA','PDX':'POR','TOY':'TOR'}
b = lambda a: SR2BDL.get(a, a)

# ── ledgers (as-of source) ───────────────────────────────────────────────────
tgs = api('/db-api?action=get_team_game_stats&league=wnba&season=2026')['team_game_stats']
led = defaultdict(list)
for r in tgs:
    led[r['team_alias']].append(dict(date=str(r['date'])[:10], opp=r['opp_alias'],
        won=float(r['pts']) > float(r['opp_pts']), pts=float(r['pts']), opp_pts=float(r['opp_pts'])))
for k in led: led[k].sort(key=lambda x: x['date'])
asof = lambda t, d: [g for g in led[t] if g['date'] < d]
wp = lambda gs: sum(g['won'] for g in gs) / len(gs) if gs else None

def vals(team, date, oppwp):
    gs = asof(team, date)
    top  = [g for g in gs if (oppwp.get(g['opp']) or 0) >  0.600]
    rest = [g for g in gs if (oppwp.get(g['opp']) or 0) <= 0.600]
    ov = wp(gs)
    wt = wp(top)  if len(top)  >= 2 else ov
    wr = wp(rest) if len(rest) >= 2 else ov
    return dict(vsrest=wr, infl=ov - (0.5 * wt + 0.5 * wr), wp=ov)

# ── spots from post-cutoff games ─────────────────────────────────────────────
games = [g for g in api('/db-api?action=get_games&league=wnba')['games']
         if g.get('winner') and str(g['date'])[:10] > CUTOFF]
print(f'post-{CUTOFF} finalized games: {len(games)}')

spots = []
for g in games:
    home, away, winner, date = b(g['home_alias']), b(g['away_alias']), b(g['winner']), str(g['date'])[:10]
    try:
        snaps = api(f"/db-api?action=history&game_id={g['id']}", timeout=30).get('snapshots', [])
    except Exception:
        continue
    states = {}
    for s in sorted(snaps, key=lambda x: x['ts']):
        q = s.get('period')
        if q not in (2, 3) or q in states: continue
        h, a = s.get('home_pts'), s.get('away_pts')
        if h is None or a is None: continue
        m = h - a
        if 1 <= abs(m) <= 9: states[q] = m
    for q, m in states.items():
        trailer, leader = (home, away) if m < 0 else (away, home)
        if len(asof(trailer, date)) < 4 or len(asof(leader, date)) < 4: continue
        oppwp = {t: wp(asof(t, date)) for t in led}
        vt, vl = vals(trailer, date, oppwp), vals(leader, date, oppwp)
        if None in vt.values() or None in vl.values(): continue
        spots.append(dict(won=trailer == winner, g0=vt['wp'] - vl['wp'],
            L_vsrest=vt['vsrest'] - vl['vsrest'], L_infl=vl['infl'] - vt['infl']))

pool = [s for s in spots if abs(s['g0']) < 0.15]
print(f'forward spots: {len(spots)} total, {len(pool)} small-gap (|g0|<.15)')
if not pool:
    print('n=0 — nothing to evaluate yet.'); raise SystemExit

def auc(pairs):
    pos = sorted(x for x, y in pairs if y); neg = sorted(x for x, y in pairs if not y)
    if not pos or not neg: return None
    w = t = 0
    for p in pos:
        lo = bisect.bisect_left(neg, p); hi = bisect.bisect_right(neg, p); w += lo; t += hi - lo
    return (w + 0.5 * t) / (len(pos) * len(neg))

base = sum(s['won'] for s in pool) / len(pool)
n = len(pool)
print(f'base trailer-win: {base*100:.1f}%  (pass bar: AUC>=0.58 at n>=60)\n')
for k in ('L_vsrest', 'L_infl'):
    a = auc([(s[k], s['won']) for s in pool])
    verdict = 'PASS' if (a is not None and a >= 0.58 and n >= 60) else ('pending n' if n < 60 else 'FAIL')
    print(f'REGISTERED {k:10} AUC={a:.4f}  n={n}  -> {verdict}')
a0 = auc([(s['g0'], s['won']) for s in pool])
print(f'unregistered g0 residual (context only): AUC={a0:.4f}')
