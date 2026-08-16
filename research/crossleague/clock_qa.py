#!/usr/bin/env python3
"""Prereg step zero: clock-coverage QA per league-season states file."""
import json, gzip, sys

def qa(path, label):
    states = json.load(gzip.open(path, 'rt'))
    tot_ev = with_clock = repairable = 0
    dir_up = dir_down = 0
    over600 = 0
    finals_ok = finals_bad = 0
    games_no_events = 0
    per_period_max = {}
    for s in states:
        evs = s.get('ev', [])
        if not evs:
            games_no_events += 1
            continue
        # final-score cross-check: last event score vs recorded final
        le = evs[-1]
        if le['h'] == s['fh'] and le['a'] == s['fa']: finals_ok += 1
        else: finals_bad += 1
        prev = {}
        for e in evs:
            tot_ev += 1
            c, p = e.get('c'), e.get('p')
            if c is None:
                if e.get('mt') is not None: repairable += 1
                continue
            with_clock += 1
            if c > 600: over600 += 1
            per_period_max[p] = max(per_period_max.get(p, 0), c)
            if p in prev:
                if c > prev[p]: dir_up += 1
                elif c < prev[p]: dir_down += 1
            prev[p] = c
    n = len(states)
    print(f"[{label}] games {n} | no-event games {games_no_events}")
    print(f"  score_changes {tot_ev} | with clock {with_clock} ({100*with_clock/max(tot_ev,1):.1f}%) | clockless-but-repairable {repairable}")
    print(f"  clock direction: up {dir_up} vs down {dir_down} -> {'COUNTING UP (elapsed)' if dir_up>dir_down else 'COUNTING DOWN (remaining)'}")
    print(f"  clocks >600s: {over600} | max clock by period: { {k: per_period_max[k] for k in sorted(per_period_max)} }")
    print(f"  final-score cross-check: {finals_ok} ok / {finals_bad} mismatch")
    return finals_bad, games_no_events

for path, label in [("/tmp/el_2425_states.json.gz","EL24-25"), ("/tmp/el_2526_states.json.gz","EL25-26")]:
    qa(path, label)
