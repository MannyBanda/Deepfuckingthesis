#!/usr/bin/env python3
# PHASE 1 — outcomes. H1 verdict as pre-declared in research/2026-10-31_mc_trailer_buy_PREREG.md §8; H2-H4 report-only.
# Usage: python3 research/2026-10-31_mc_trailer_buy_phase1.py [fires.json.gz] [canary_fires.json.gz]
import gzip, json, collections, sys, os, math
HERE = os.path.dirname(__file__)
P = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '2026-10-31_mc_trailer_buy_fires.json.gz')
C = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, '2026-10-23_fine_nba_canary_fires.json.gz')
d = json.load(gzip.open(P)); rows = d['rows']
BAR = 0.08; NMIN = 40
def tag(n): return 'HIGH' if n >= 200 else 'MED' if n >= 80 else 'LOW'
def cell(R):
    n = len(R)
    if n == 0: return dict(n=0)
    w = sum(r['trailer_won'] for r in R) / n; f = sum(r['fair'] for r in R) / n
    se = math.sqrt(w * (1 - w) / n) if 0 < w < 1 else 0
    return dict(n=n, win=w, fair=f, edge=w - f, se=se, tag=tag(n))
def fmt(label, R):
    c = cell(R)
    if c['n'] == 0: return f"  {label:46s} n=0"
    return f"  {label:46s} n={c['n']:4d} {c['tag']:4s} trailer-WIN {100*c['win']:5.1f}%  fair {100*c['fair']:5.1f}%  edge {100*c['edge']:+6.1f}pp  (±{100*1.96*c['se']:.1f} 95%)"
PRI = [r for r in rows if r['threshold'] == 0.55]
SEC = [r for r in rows if r['threshold'] == 0.70]

print("══ H1 — PRIMARY STRATUM: trailer windowed MC ≥ .55 at first perception, Q3+, deficit 1-9, one row/game ══")
print(fmt('all', PRI))
for h in ('H1', 'H2'): print(fmt(f'half {h} (split {d["config"]["halves_split"]})', [r for r in PRI if r['half'] == h]))
print(" deficit bands:")
bands = {}
for b in ('1-3', '4-6', '7-9'):
    R = [r for r in PRI if r['deficit_band'] == b]; bands[b] = cell(R); print(fmt(f'  deficit {b}', R))
c_all = cell(PRI); c_h1 = cell([r for r in PRI if r['half'] == 'H1']); c_h2 = cell([r for r in PRI if r['half'] == 'H2'])
clauses = {
    'edge ≥ +8pp on primary stratum': c_all['edge'] >= BAR,
    'edge ≥ +8pp in H1': c_h1['edge'] >= BAR,
    'edge ≥ +8pp in H2': c_h2['edge'] >= BAR,
    'n ≥ 40 per half': c_h1['n'] >= NMIN and c_h2['n'] >= NMIN,
    '7-9 band is the lowest-edge band': bands['7-9']['edge'] <= min(bands['1-3']['edge'], bands['4-6']['edge']),
}
print("\n H1 clauses:")
for k, v in clauses.items(): print(f"   [{'PASS' if v else 'FAIL'}] {k}")
print(f"\n ▶ H1 VERDICT: {'PROMOTED (PASS)' if all(clauses.values()) else 'NOT PROMOTED'}")

print("\n── Secondary (ordering only): MC ≥ .70 first perception ──")
print(fmt('all', SEC))
for h in ('H1', 'H2'): print(fmt(f'half {h}', [r for r in SEC if r['half'] == h]))
for b in ('1-3', '4-6', '7-9'): print(fmt(f'deficit {b}', [r for r in SEC if r['deficit_band'] == b]))

print("\n── Descriptive splits on the primary stratum (report-only) ──")
print(" period of first perception:")
for p in (3, 4): print(fmt(f'  Q{p}', [r for r in PRI if r['p'] == p]))
print(" Q3-open vs later (Phase 0 instrument fact):")
print(fmt('  mins-left ≥ 23 (first two Q3 states)', [r for r in PRI if r['mins_left'] >= 23]))
print(fmt('  mins-left 17-23', [r for r in PRI if 17 <= r['mins_left'] < 23]))
print(fmt('  mins-left < 17', [r for r in PRI if r['mins_left'] < 17]))
print(" MC magnitude at the .55 crossing:")
for lo, hi in ((0.55, 0.70), (0.70, 0.90), (0.90, 1.01)): print(fmt(f'  mc {lo:.2f}-{min(hi,1):.2f}', [r for r in PRI if lo <= r['mc'] < hi]))

print("\n── H2 — persistence (report-only): next state (30s later) still ≥ .55? ──")
print(fmt('persisted', [r for r in PRI if r['persisted'] is True]))
print(fmt('faded', [r for r in PRI if r['persisted'] is False]))
print(fmt('next unavailable', [r for r in PRI if r['persisted'] is None]))

print("\n── H4 — floor reconciliation (report-only) ──")
print(fmt('trailer HOLDS floor (structural-control shape)', [r for r in PRI if r['floor_is_trailer']]))
print(fmt('leader holds floor', [r for r in PRI if not r['floor_is_trailer']]))
for b in ('<.60', '.60-.75', '>.75'): print(fmt(f'  leader holds, ctrl floor {b}', [r for r in PRI if r['ctrl_floor_band'] == b]))

print("\n── H3 — timing vs the Oct 23 canary CLEAN on the leader (report-only, mechanism test) ──")
cz = json.load(gzip.open(C))
clean = {}
for r in cz['rows']:
    if r.get('pattern') == 'CLEAN' and r.get('push') and r['gid'] not in clean: clean[r['gid']] = r
both = []
for r in PRI:
    k = clean.get(r['gid'])
    if not k: continue
    if k['trailer'] != r['trailer']: continue          # CLEAN must be on the same leader (its 'trailer' is our trailer)
    t_fp = r['mins_left']; t_cl = (4 - k['push']['p']) * 12 + k['push']['c'] / 60
    # fair at the CLEAN moment: same base-rate table, keyed at the CLEAN push state (period, clock bucket, leader margin)
    pc, cc, cm = k['push']['p'], k['push']['c'], abs(k['push']['ctrl_margin'])
    ck = f"Q{pc}|{int((720 - cc) // 120) * 2}-{int((720 - cc) // 120) * 2 + 2}min|{'1-3' if cm <= 3 else '4-8' if cm <= 8 else '9-15' if cm <= 15 else '16+'}"
    cb = d['base_rates'].get(ck)
    both.append(dict(r, clean_mins_left=t_cl, lead_min=t_fp - t_cl, clean_fair=(1 - cb['leader_won'] / cb['n']) if cb and cb['n'] else None))
print(f"  games with a same-leader CLEAN: {len(both)} of {len(PRI)} primary rows | CLEAN pool {len(clean)}")
if both:
    lm = sorted(b['lead_min'] for b in both); q = lambda f: lm[int(f * (len(lm) - 1))]
    print(f"  first perception precedes CLEAN by median {q(.5):.1f} game-min (p10 {q(.1):.1f}, p90 {q(.9):.1f}); first perception AFTER clean: {sum(1 for b in both if b['lead_min'] < 0)}")
    print(fmt('  these games at FIRST PERCEPTION', both))
    print(fmt('  same games at the CLEAN moment (fair at CLEAN cell)', [dict(b, fair=b['clean_fair']) for b in both if b['clean_fair'] is not None]))
    print(fmt('  FP ≥ 5 min before CLEAN', [b for b in both if b['lead_min'] >= 5]))
    print(fmt('  FP within 5 min of CLEAN', [b for b in both if 0 <= b['lead_min'] < 5]))
print(fmt('  primary rows with NO same-leader CLEAN', [r for r in PRI if not (clean.get(r['gid']) and clean[r['gid']]['trailer'] == r['trailer'])]))
