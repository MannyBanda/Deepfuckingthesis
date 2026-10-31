#!/usr/bin/env python3
# PHASE 0 — counts only. Reads research/2026-10-31_mc_trailer_buy_fires.json.gz and prints coverage and cell n's.
# Deliberately never touches winner / trailer_won / final_margin. Usage: python3 research/2026-10-31_mc_trailer_buy_phase0.py
import gzip, json, collections, sys, os
P = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '2026-10-31_mc_trailer_buy_fires.json.gz')
d = json.load(gzip.open(P))
FORBIDDEN = {'winner', 'trailer_won', 'final_margin'}
rows = [{k: v for k, v in r.items() if k not in FORBIDDEN} for r in d['rows']]
c = d['counts']; cfg = d['config']
print(f"instrument: {d['states']} | sims {cfg['sims']} seed {cfg['seed']} | halves split {cfg['halves_split']}")
print(f"coverage: games {c['games']} | Q3+ states {c['q3plus_states']} | eligible (deficit 1-9, clock ok) {c['eligible_states']} | evals {c['evals']} | window unavailable {c['window_unavailable']} | FGA<5 {c['fga_unavailable']} | games with no eligible state {c['games_no_eligible']}")
for thr, lbl in ((0.55, 'PRIMARY mc >= .55'), (0.70, 'SECONDARY mc >= .70 (ordering only)')):
    R = [r for r in rows if r['threshold'] == thr]
    n = len(R)
    print(f"\n{lbl}: first-perception rows n={n} ({100*n/c['games']:.0f}% of games)")
    print("  by half:        ", dict(sorted(collections.Counter(r['half'] for r in R).items())))
    print("  by period:      ", dict(sorted(collections.Counter(f"Q{r['p']}" for r in R).items())))
    print("  by deficit band:", dict(sorted(collections.Counter(r['deficit_band'] for r in R).items())))
    print("  by half × band: ", {h: dict(sorted(collections.Counter(r['deficit_band'] for r in R if r['half'] == h).items())) for h in ('H1', 'H2')})
    print("  floor holder:   ", {'trailer_holds_floor': sum(r['floor_is_trailer'] for r in R), 'leader_holds': sum((not r['floor_is_trailer']) and r['ctrl'] is not None for r in R), 'no_ctrl': sum(r['ctrl'] is None for r in R)})
    print("  ctrl floor band (leader holds):", dict(sorted(collections.Counter(r['ctrl_floor_band'] for r in R if r['ctrl_floor_band']).items())))
    print("  persistence:    ", {'persisted': sum(r['persisted'] is True for r in R), 'faded': sum(r['persisted'] is False for r in R), 'next_unavailable': sum(r['persisted'] is None for r in R)})
    mins = sorted(r['mins_left'] for r in R); mc = sorted(r['mc'] for r in R); wp = sorted(r['window_poss'] for r in R)
    q = lambda a, f: a[int(f * (len(a) - 1))] if a else None
    print(f"  mins-left at fire: median {q(mins,.5)} (p10 {q(mins,.1)} p90 {q(mins,.9)}) | mc at fire: median {q(mc,.5)} p90 {q(mc,.9)} | window poss median {q(wp,.5)}")
    pn = sorted(r['proxy_n'] for r in R)
    print(f"  proxy cell n at fire: median {q(pn,.5)} min {pn[0] if pn else None} | rows with proxy n < 30: {sum(1 for x in pn if x < 30)}")
print("\nH1 n-clause check (n >= 40 per half, primary):", {h: sum(1 for r in rows if r['threshold'] == 0.55 and r['half'] == h) for h in ('H1', 'H2')})
print("Phase 0 complete — no outcome field read.")
