#!/usr/bin/env python3
"""Cross-league walker v2 (uniform instrument, per prereg 2026-08-14 tranche discipline).

Fixes over v1, applied uniformly to ALL leagues incl. EuroLeague re-run:
  1. DUAL CONSTRUCTION - emits both:
       STATE-weighted : every 30s in-band state (production-transfer-correct; game-clustered)
       GAME-weighted  : first perception per (game, trailing team) (independent observations)
  2. TRUE per-state deficit cells (each state assigned its own band) - replaces v1's
     nested "deepest depth reached" bands.
  3. COMMON WINDOW 750-1800s so SR leagues and the WNBA fine arena are measured
     on one instrument (WNBA arena spans 750-2250; EL v1 walked 30-1800).

Window: 750 <= t < 1800 (pre-Q4 both formats). Deficit 1-9. >=5 GP guard both teams.
Gap = trailer win% - leader win%; cells worse <=-.15 / even / better >=+.15. Rate = trailer WINS.
"""
import json, gzip, glob, os, sys
from statistics import pstdev

W_LO, W_HI, STEP = 750, 1800, 30


def gapcell(g):
    return 'better' if g >= .15 else ('worse' if g <= -.15 else 'even')


def band(d):
    return '1-3' if d <= 3 else ('4-6' if d <= 6 else '7-9')


def rate(v):
    return (len(v), round(100 * sum(v) / len(v), 1)) if v else (0, None)


def tbl(d):
    return {k: rate(v) for k, v in sorted(d.items())}


def power(n):
    return 'HIGH' if n >= 200 else ('MED' if n >= 80 else 'LOW')


# ---------- SR league adapter ----------

def sr_states(path):
    """Yield (gid, season_label, t, trail_id, lead_id, deficit, gap, won) from SR trajectories."""
    games = json.load(gzip.open(path, 'rt'))
    games = [g for g in games if g.get('ev') and g.get('winner')]
    # as-of win% from prior completed games in feed order (feed is chronologically sorted)
    rec, out = {}, []
    for g in games:
        h, a = g['home_id'], g['away_id']
        hw, hn = rec.get(h, (0, 0))
        aw, an = rec.get(a, (0, 0))
        if hn >= 5 and an >= 5:
            out.append((g, {h: hw / hn, a: aw / an}))
        for t in (h, a):
            w, n = rec.get(t, (0, 0))
            rec[t] = (w + (1 if g['winner'] == t else 0), n + 1)
    disp = pstdev([w / n for (w, n) in rec.values() if n >= 5]) if rec else 0.0

    rows = []
    for g, wp in out:
        ev = sorted([e for e in g['ev'] if e.get('c') is not None], key=lambda e: e['c'])
        if not ev:
            continue
        i, h, a = 0, 0, 0
        for t in range(W_LO, W_HI, STEP):
            while i < len(ev) and ev[i]['c'] <= t:
                h, a = ev[i]['h'], ev[i]['a']
                i += 1
            if h == a:
                continue
            d = abs(h - a)
            if not (1 <= d <= 9):
                continue
            lead_id, trail_id = (g['home_id'], g['away_id']) if h > a else (g['away_id'], g['home_id'])
            rows.append((g['gid'], t, trail_id, d, wp[trail_id] - wp[lead_id], g['winner'] == trail_id))
    return rows, disp, len(out)


# ---------- WNBA fine-arena adapter ----------

def wnba_states(path):
    st = json.load(gzip.open(path, 'rt'))
    rows, legs = [], {}
    for x in st:
        if not (W_LO <= x['gameSec'] < W_HI):
            continue
        d = abs(x['margin'])
        if not (1 <= d <= 9):
            continue
        if x['lgp'] < 5 or x['tgp'] < 5:
            continue
        rows.append((x['gid'], x['gameSec'], x['trailer'], d, x['gap'], bool(x['won'])))
        legs.setdefault(x['season'], []).append(rows[-1])
    return rows, legs


# ---------- shared reducer ----------

def reduce_rows(rows):
    """rows: (gid, t, trail, deficit, gap, won) -> both constructions."""
    st_cells, st_bands = {}, {}
    for gid, t, tr, d, gap, won in rows:
        st_cells.setdefault(gapcell(gap), []).append(won)
        if gap >= .15:
            st_bands.setdefault(band(d), []).append(won)

    first = {}
    for gid, t, tr, d, gap, won in rows:
        k = (gid, tr)
        if k not in first or t < first[k][0]:
            first[k] = (t, d, gap, won)
    gm_cells, gm_bands = {}, {}
    for (gid, tr), (t, d, gap, won) in first.items():
        gm_cells.setdefault(gapcell(gap), []).append(won)
        if gap >= .15:
            gm_bands.setdefault(band(d), []).append(won)

    def pack(cells, bands):
        c = tbl(cells)
        b_n, b_r = c.get('better', (0, None))
        e_n, e_r = c.get('even', (0, None))
        w_n, w_r = c.get('worse', (0, None))
        mono = None
        if None not in (b_r, e_r, w_r):
            mono = w_r < e_r < b_r
        prem = round(b_r - e_r, 1) if None not in (b_r, e_r) else None
        return dict(staircase=c, deficit=tbl(bands), premium=prem, monotone=mono,
                    better_n=b_n, better_power=power(b_n))

    return dict(state=pack(st_cells, st_bands), game=pack(gm_cells, gm_bands))


def main():
    base = os.path.dirname(os.path.abspath(__file__))
    files = {}
    for f in sorted(glob.glob(os.path.join(base, '*_states.json.gz'))):
        b = os.path.basename(f)
        if b.startswith('el_'):
            lg = 'EuroLeague'
        else:
            lg = b.split('_')[0]
        files.setdefault(lg, []).append(f)

    out = {}
    for lg, paths in sorted(files.items()):
        allrows, disps, games, legs = [], [], 0, {}
        for p in sorted(paths):
            rows, disp, ng = sr_states(p)
            allrows += rows
            disps.append(disp)
            games += ng
            legs[os.path.basename(p).split('_')[1]] = reduce_rows(rows)
        r = reduce_rows(allrows)
        r['dispersion'] = round(sum(disps) / len(disps), 4)
        r['games_eligible'] = games
        r['season_legs'] = {k: {'state_mono': v['state']['monotone'],
                                'game_mono': v['game']['monotone'],
                                'state_prem': v['state']['premium'],
                                'game_prem': v['game']['premium']} for k, v in legs.items()}
        out[lg] = r

    # WNBA on identical code
    wpath = os.path.join(base, '..', 'fixtures_fine_states_matched.json.gz')
    if os.path.exists(wpath):
        rows, legs = wnba_states(wpath)
        r = reduce_rows(rows)
        r['dispersion'] = None
        r['games_eligible'] = len(set(x[0] for x in rows))
        r['season_legs'] = {str(k): {'state_mono': reduce_rows(v)['state']['monotone'],
                                     'game_mono': reduce_rows(v)['game']['monotone'],
                                     'state_prem': reduce_rows(v)['state']['premium'],
                                     'game_prem': reduce_rows(v)['game']['premium']}
                            for k, v in legs.items()}
        out['WNBA(fine arena)'] = r

    json.dump(out, open(os.path.join(base, 'walker2_results.json'), 'w'), indent=1)

    # ---- report ----
    print("COMMON WINDOW %d-%ds | deficit 1-9 | >=5 GP | gap cells worse/even/better\n" % (W_LO, W_HI))
    hdr = "%-20s %7s %6s | %-28s %6s %4s | %-28s %6s %4s"
    print(hdr % ("league", "games", "disp", "STATE-weighted w/e/b", "prem", "mono",
                 "GAME-weighted w/e/b", "prem", "mono"))
    print("-" * 150)

    def cells(p):
        s = p['staircase']
        f = lambda k: ("%.1f(%d)" % (s[k][1], s[k][0])) if k in s and s[k][1] is not None else "-"
        return "%-9s %-9s %-9s" % (f('worse'), f('even'), f('better'))

    order = sorted(out.items(), key=lambda kv: (kv[1]['game']['premium'] is None,
                                                -(kv[1]['game']['premium'] or 0)))
    for lg, r in order:
        print(hdr % (lg, r['games_eligible'],
                     ("%.3f" % r['dispersion']) if r['dispersion'] is not None else "-",
                     cells(r['state']), r['state']['premium'],
                     {True: 'Y', False: 'n', None: '?'}[r['state']['monotone']],
                     cells(r['game']), r['game']['premium'],
                     {True: 'Y', False: 'n', None: '?'}[r['game']['monotone']]))

    print("\n\nPER-STATE DEFICIT CELLS (gap >= .15, state-weighted, true non-nested)")
    print("%-20s %-14s %-14s %-14s" % ("league", "1-3", "4-6", "7-9"))
    print("-" * 66)
    for lg, r in order:
        d = r['state']['deficit']
        f = lambda k: ("%.1f (n=%d)" % (d[k][1], d[k][0])) if k in d and d[k][1] is not None else "-"
        print("%-20s %-14s %-14s %-14s" % (lg, f('1-3'), f('4-6'), f('7-9')))

    print("\n\nBOTH-SEASONS RULE (monotonicity per season leg)")
    for lg, r in order:
        legs = r['season_legs']
        s = " | ".join("%s: state %s / game %s" % (k,
                                                   {True: 'Y', False: 'n', None: '?'}[v['state_mono']],
                                                   {True: 'Y', False: 'n', None: '?'}[v['game_mono']])
                       for k, v in sorted(legs.items()))
        print("  %-20s %s" % (lg, s))


if __name__ == '__main__':
    main()
