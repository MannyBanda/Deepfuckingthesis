#!/usr/bin/env python3
"""Cross-league scan walker: 30s first-perception states + end-Q2/Q3 comparability staircase.
Per prereg 2026-08-14 (commit 1d83d13). Pre-Q4 = t < 1800s (FIBA 4x10min)."""
import json, gzip, sys
from statistics import pstdev

def load(path): return json.load(gzip.open(path, 'rt'))

def build_asof(index_games):
    """Chronological win%/GP tracker. Returns per-game dict gid -> {team_id: (wins, gp)} BEFORE that game."""
    rec, out = {}, {}
    for g in index_games:
        out[g['gid']] = {t: rec.get(t, (0,0)) for t in (g['home_id'], g['away_id'])}
        for t in (g['home_id'], g['away_id']):
            w, n = rec.get(t, (0,0))
            rec[t] = (w + (1 if g['winner']==t else 0), n+1)
    return rec, out

def traj(evs):
    e = sorted([x for x in evs if x.get('c') is not None], key=lambda x: x['c'])
    return e

def score_at(e, t):
    h = a = 0
    for x in e:
        if x['c'] <= t: h, a = x['h'], x['a']
        else: break
    return h, a

def gapcell(gap):
    return 'better' if gap >= .15 else ('worse' if gap <= -.15 else 'even')

def run(paths_labels):
    results = {}
    all_states = []
    for path, label in paths_labels:
        states = load(path)
        finals, asof = build_asof(states)
        # dispersion: SD of final win%
        disp = pstdev([w/n for (w,n) in finals.values() if n >= 5])
        cells = {}          # 30s first-perception 1-9
        subbands = {}       # deficit band first perception
        ckpt = {'Q2_END': {}, 'Q3_END': {}}
        dropped_gp = 0
        for s in states:
            rec = asof[s['gid']]
            hw, hn = rec[s['home_id']]; aw, an = rec[s['away_id']]
            if hn < 5 or an < 5: dropped_gp += 1; continue
            wp = {s['home_id']: hw/hn, s['away_id']: aw/an}
            e = traj(s['ev'])
            seen_q, seen_b = set(), set()
            for t in range(30, 1800, 30):
                h, a = score_at(e, t)
                if h == a: continue
                lead_id, trail_id = (s['home_id'], s['away_id']) if h > a else (s['away_id'], s['home_id'])
                d = abs(h - a)
                if not (1 <= d <= 9): continue
                band = '1-3' if d <= 3 else ('4-6' if d <= 6 else '7-9')
                gap = wp[trail_id] - wp[lead_id]
                won = s['winner'] == trail_id
                if trail_id not in seen_q:
                    seen_q.add(trail_id)
                    c = gapcell(gap)
                    cells.setdefault(c, []).append(won)
                    all_states.append((label, c, won))
                if (trail_id, band) not in seen_b:
                    seen_b.add((trail_id, band))
                    if gap >= .15:
                        subbands.setdefault(band, []).append(won)
            # comparability checkpoints from period_scores
            regs = [p for p in s['ps'] if p['t'] == 'regular_period']
            for nper, key in ((2,'Q2_END'), (3,'Q3_END')):
                if len(regs) < nper: continue
                h = sum(p['h'] for p in regs[:nper]); a = sum(p['a'] for p in regs[:nper])
                if h == a: continue
                lead_id, trail_id = (s['home_id'], s['away_id']) if h > a else (s['away_id'], s['home_id'])
                d = abs(h-a)
                if not (1 <= d <= 9): continue
                gap = wp[trail_id] - wp[lead_id]
                ckpt[key].setdefault(gapcell(gap), []).append(s['winner'] == trail_id)
        def tbl(d):
            return {k: (len(v), round(100*sum(v)/len(v),1)) for k,v in sorted(d.items())}
        results[label] = dict(games=len(states), dropped_lowGP=dropped_gp, dispersion=round(disp,4),
                              stair30=tbl(cells), sub_gap15=tbl(subbands),
                              q2=tbl(ckpt['Q2_END']), q3=tbl(ckpt['Q3_END']))
    # pooled 30s staircase
    pool = {}
    for _, c, w in all_states: pool.setdefault(c, []).append(w)
    results['POOLED_30s'] = {k: (len(v), round(100*sum(v)/len(v),1)) for k,v in sorted(pool.items())}
    return results

if __name__ == '__main__':
    r = run([("/tmp/el_2425_states.json.gz","EL24-25"), ("/tmp/el_2526_states.json.gz","EL25-26")])
    print(json.dumps(r, indent=1))
