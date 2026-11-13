#!/usr/bin/env python3
# research/2026-10-31_paint_touch_PREREG.md — Phase 0b (counts only, no outcomes) and Phase 1 (H1–H3).
#   python3 research/2026-10-31_paint_touch_phases.py --phase 0 --fires <fires.json.gz> --states <states.json.gz>
#   python3 research/2026-10-31_paint_touch_phases.py --phase 1 --fires ... --states ...   [--label "2024-25 (Instrument A)"]
# TOUCH = trailer leads at any later regulation state. Cell base keyed period × 2-min bucket × deficit bucket (1-3/4-8/9-15),
# built over ALL Q3+ states of the same states file (same keys as the win proxy). Edge = rate − cell base.
import gzip, json, math, argparse, collections, statistics, sys
ap = argparse.ArgumentParser(); ap.add_argument('--phase', type=int, required=True); ap.add_argument('--fires', required=True); ap.add_argument('--states', required=True); ap.add_argument('--label', default='')
a = ap.parse_args()
F = json.load(gzip.open(a.fires)); rows = [r for r in F['rows'] if r['threshold'] == 0.55]
D = json.load(gzip.open(a.states)); G = {g['gid']: g for g in D['games'] if g['walk']['ok']}
mB = lambda m: '1-3' if m <= 3 else '4-8' if m <= 8 else '9-15' if m <= 15 else '16+'
key = lambda st: f"Q{st['p']}|{(720 - st['c']) // 120 * 2}-{(720 - st['c']) // 120 * 2 + 2}min|{mB(abs(st['h']['pts'] - st['a']['pts']))}"
mins = lambda st: (4 - st['p']) * 12 + st['c'] / 60
# touch base table over all Q3+ states (deficit 1-9, Q4 >= 1:00)
base = collections.defaultdict(lambda: [0, 0, 0]); touch_of = {}
for gid, g in G.items():
    S = g['states']; w = g['winner']
    for i, st in enumerate(S):
        if st['p'] < 3 or st['p'] > 4: continue
        m = st['h']['pts'] - st['a']['pts']
        if m == 0 or abs(m) > 9 or (st['p'] == 4 and st['c'] < 60): continue
        tr = 'a' if m > 0 else 'h'; touched = False; tmin = None; p_touch = None
        for t in S[i + 1:]:
            mm = t['h']['pts'] - t['a']['pts']; lead = (-mm) if tr == 'a' else mm
            if lead > 0: touched = True; tmin = mins(st) - mins(t); p_touch = t; break
        touch_of[(gid, i)] = (touched, tmin, p_touch)
        b = base[key(st)]; b[0] += 1; b[1] += touched; b[2] += (w == (g['home'] if tr == 'h' else g['away']))
for r in rows:
    g = G.get(r['gid']); st = g['states'][r['idx']]
    t = touch_of.get((r['gid'], r['idx']), (None, None, None))
    r['touched'], r['mins_to_touch'] = t[0], t[1]
    b = base[key(st)]; r['fair_touch'] = b[1] / b[0] if b[0] else None; r['fair_win'] = b[2] / b[0] if b[0] else None
    # cash-out: cell-base WIN prob at the touch state (the fair price a book would show there)
    r['p_entry'] = r['fair_win']
    if t[2] is not None:
        bt = base.get(key(t[2])) if (t[2]['p'] >= 3 and 1 <= abs(t[2]['h']['pts'] - t[2]['a']['pts']) <= 9) else None
        # at the touch state the former trailer LEADS by ≥1 → its win prob = leader-holds = 1 − trailer-win of that cell
        r['p_touch'] = (1 - bt[2] / bt[0]) if bt and bt[0] else None
    else: r['p_touch'] = None
PRI = [r for r in rows if r['paint_gap'] is not None and r['paint_gap'] >= 2 and r['deficit'] <= 6]       # H1 stratum
AVOID = [r for r in rows if r['paint_gap'] is not None and r['paint_gap'] <= -6]                             # H2 mirror (deficit 1-9)
halves = sorted({r['half'] for r in rows})
def tag(n): return 'HIGH' if n >= 200 else 'MED' if n >= 80 else 'LOW'
print(f"instrument: {a.states.split('/')[-1]} {a.label} | fires file {a.fires.split('/')[-1]} | walk-ok games {len(G)} | primary mc≥.55 rows {len(rows)} | halves split {F['config']['halves_split']}")
if a.phase == 0:
    print("\nPHASE 0b — COUNTS ONLY (no outcome field read)")
    print(f"  H1 stratum (paint ≥ +2 × deficit 1-6): n={len(PRI)} | by half {dict(collections.Counter(r['half'] for r in PRI))} | by deficit band {dict(sorted(collections.Counter(r['deficit_band'] for r in PRI).items()))}")
    print(f"  H2 avoid cell (paint ≤ −6, deficit 1-9): n={len(AVOID)} | by half {dict(collections.Counter(r['half'] for r in AVOID))}")
    print(f"  paint_gap missing: {sum(1 for r in rows if r['paint_gap'] is None)} | paint bands (all rows): ≤−6 {sum(1 for r in rows if r['paint_gap'] is not None and r['paint_gap']<=-6)} · −5..+1 {sum(1 for r in rows if r['paint_gap'] is not None and -6<r['paint_gap']<2)} · ≥+2 {sum(1 for r in rows if r['paint_gap'] is not None and r['paint_gap']>=2)}")
    pn = sorted(base[key(G[r['gid']]['states'][r['idx']])][0] for r in PRI)
    print(f"  touch-base cell n at H1 fires: median {pn[len(pn)//2] if pn else None} min {pn[0] if pn else None} | cells <30: {sum(1 for x in pn if x<30)}")
    print(f"  H1 n-clause (≥40/half): {dict(collections.Counter(r['half'] for r in PRI))} → {'MET' if all(sum(1 for r in PRI if r['half']==h)>=40 for h in halves) else 'NOT MET'}")
    print("Phase 0b complete — no outcome field read.")
    sys.exit(0)
# ── Phase 1 ──
def cell(R, o, fa):
    n = len(R)
    if not n: return dict(n=0)
    w = sum(1 for x in R if x[o]) / n; f = sum(x[fa] for x in R) / n; se = math.sqrt(w * (1 - w) / n) if 0 < w < 1 else 0
    return dict(n=n, rate=w, fair=f, edge=w - f, se=se)
def fmt(l, R, o='touched', fa='fair_touch'):
    c = cell(R, o, fa)
    if not c['n']: return f"  {l:46s} n=0"
    return f"  {l:46s} n={c['n']:4d} {tag(c['n']):4s} rate {100*c['rate']:5.1f}%  fair {100*c['fair']:5.1f}%  edge {100*c['edge']:+6.1f}pp (±{100*1.96*c['se']:.1f})"
print("\n══ H1 — paint ≥ +2 × deficit 1-6 × MC-favored trailer (first perception) → TOUCH ══")
print(fmt('all', PRI))
cl = {}
for h in halves:
    R = [r for r in PRI if r['half'] == h]; c = cell(R, 'touched', 'fair_touch'); cl[h] = c; print(fmt(f'half {h}', R))
for b in ('1-3', '4-6'): print(fmt(f'deficit {b}', [r for r in PRI if r['deficit_band'] == b]))
call = cell(PRI, 'touched', 'fair_touch')
clauses = {'edge ≥ +8pp on stratum': call['edge'] >= 0.08}
for h in halves: clauses[f'edge ≥ +8pp in {h}'] = cl[h]['edge'] >= 0.08
clauses['n ≥ 40 per half'] = all(cl[h]['n'] >= 40 for h in halves)
print(" H1 clauses:"); [print(f"   [{'PASS' if v else 'FAIL'}] {k}") for k, v in clauses.items()]
print(f"\n ▶ H1 VERDICT: {'PROMOTED (PASS)' if all(clauses.values()) else 'NOT PROMOTED'}")
print("\n── H1 stratum, WIN (report-only) ──"); print(fmt('all', PRI, 'trailer_won', 'fair_win'))
for h in halves: print(fmt(f'half {h}', [r for r in PRI if r['half'] == h], 'trailer_won', 'fair_win'))
print("\n── H2 — mirror avoid cell: paint ≤ −6 (deficit 1-9) → WIN (bar: ≤ −5pp each half, report-only) ──")
print(fmt('all', AVOID, 'trailer_won', 'fair_win'))
for h in halves: print(fmt(f'half {h}', [r for r in AVOID if r['half'] == h], 'trailer_won', 'fair_win'))
print(fmt('  TOUCH on the same cell', AVOID))
print("\n── Descriptives (report-only) ──")
print(fmt('MC ≥ .55 fires, all paint, deficit 1-6 — TOUCH', [r for r in rows if r['deficit'] <= 6]))
print(fmt('MC ≥ .55 fires, paint −5..+1, deficit 1-6', [r for r in rows if r['paint_gap'] is not None and -6 < r['paint_gap'] < 2 and r['deficit'] <= 6]))
print(fmt('MC ≥ .55 fires, paint ≤ −6, deficit 1-6', [r for r in rows if r['paint_gap'] is not None and r['paint_gap'] <= -6 and r['deficit'] <= 6]))
tt = [r['mins_to_touch'] for r in PRI if r['touched']]
if tt: print(f"  time to first lead (H1 touchers): median {statistics.median(tt):.1f} game-min, p25 {sorted(tt)[len(tt)//4]:.1f}, p75 {sorted(tt)[3*len(tt)//4]:.1f} | touched-then-LOST {sum(1 for r in PRI if r['touched'] and not r['trailer_won'])}/{len(tt)}")
# paint ≥ +2 WITHOUT MC: all Q3+ trailer states (first perception per game) with paint ≥ +2, deficit 1-6
seen = {}
for gid, g in G.items():
    for i, st in enumerate(g['states']):
        if (gid, i) not in touch_of: continue
        m = st['h']['pts'] - st['a']['pts']; tr = 'a' if m > 0 else 'h'; d = abs(m)
        if d > 6 or st['pd'].get('hPaint') is None: continue
        pg = (st['pd']['hPaint'] - st['pd']['aPaint']) if tr == 'h' else (st['pd']['aPaint'] - st['pd']['hPaint'])
        if pg >= 2 and gid not in seen:
            b = base[key(st)]; seen[gid] = dict(touched=touch_of[(gid, i)][0], fair_touch=b[1] / b[0], trailer_won=(g['winner'] == (g['home'] if tr == 'h' else g['away'])), fair_win=b[2] / b[0], half=next((r['half'] for r in rows if r['gid'] == gid), 'H1' if g['date'] < F['config']['halves_split'] else 'H2'))
NOMC = list(seen.values())
print(fmt('paint ≥ +2 × deficit 1-6, NO MC condition (first perception) — TOUCH', NOMC))
print(fmt('   same — WIN', NOMC, 'trailer_won', 'fair_win'))
print("\n── Cash-out EV (report-only, declared 5% vig haircut, 'buy at fire, cash at first lead, else hold') ──")
def ev(R):
    tot = 0; n = 0
    for r in R:
        if r['p_entry'] in (None, 0): continue
        if r['touched'] and r['p_touch']: ret = (r['p_touch'] / r['p_entry']) * 0.95 - 1
        else: ret = (1 / r['p_entry']) * 0.95 - 1 if r['trailer_won'] else -1
        tot += ret; n += 1
    return (tot / n, n) if n else (None, 0)
e1 = ev(PRI); e0 = ev(rows)
print(f"  H1 stratum: EV/unit {100*e1[0]:+.1f}% (n={e1[1]}) | all MC fires: {100*e0[0]:+.1f}% (n={e0[1]})")
