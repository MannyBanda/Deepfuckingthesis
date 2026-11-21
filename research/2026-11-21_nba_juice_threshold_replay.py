#!/usr/bin/env python3
# NBA JUICE threshold replay — DESCRIPTIVE, outcome-aware, LOW power (NBA_JUICE_SPEC §6 support).
# Question: if a JUICE-style price watch had been armed on every NBA WATCHLIST cue (Nov 5–20),
# how often would each candidate threshold have alerted, when, at what price — and what did the
# trailer do afterwards? Thresholds are ATTENTION ROUTING (SQUEEZE_WATCH_SPEC precedent), never a
# gate or a size; this informs a PM policy choice, it does not promote anything.
#
# Fires: the 37 replayed cues in research/2026-11-19_nba_cue_replay_2wk_OUTPUT.md (Nov 5–18) +
# every live WATCHLIST row in sweetspot_alerts (Nov 19+). Tape: odds_history source 'odds-api'
# (poll's ~1-min best-of-all-books stamp, us+us2 — at least as generous as the JUICE roster, so
# alert counts here are an UPPER bound) joined to the latest snapshot at or before each quote.
# Guards mirrored from the spec: band 1–9 (+ tie / 10–11 grace on strikes 1–2, suspend at 3),
# ESPN stale guard (|implied − ESPN trailer WP| > .25 ⇒ quote ignored), Q4 ≤2:00 terminal,
# re-arm ≥ .035 implied drop, 6-alert cap.
# Usage: python3 -I research/2026-11-21_nba_juice_threshold_replay.py
import json, re, sys, datetime as dt, urllib.request, base64, argparse
ap = argparse.ArgumentParser(); ap.add_argument('--max', type=int, default=6); ap.add_argument('--rearm', type=float, default=0.035)
ARGS = ap.parse_args()
from concurrent.futures import ThreadPoolExecutor

B = 'https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api'
AUTH = 'Basic ' + base64.b64encode(b'manny:DFT2025!').decode()
def get(q):
    req = urllib.request.Request(f'{B}?{q}', headers={'Authorization': AUTH})
    with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read())
def P(s): return dt.datetime.fromisoformat(str(s).replace('Z', '+00:00'))
def imp(ml): ml = float(ml); return 100 / (ml + 100) if ml > 0 else -ml / (-ml + 100)
def to_ml(p):
    p = min(0.95, max(0.05, p)); return round(-100 * p / (1 - p)) if p >= 0.5 else round(100 * (1 - p) / p)
def cs(c):
    m = re.match(r'^(\d+):(\d+)', str(c or '')); return int(m[1]) * 60 + int(m[2]) if m else None
def pnl(ml, won): ml = float(ml); return (ml if ml > 0 else 10000 / -ml) if won else -100.0

games = get('action=get_games&league=nba')['games']
G = {(str(g['date'])[:10], g['matchup']): g for g in games}
# ── fire list ──
fires = []
txt = open('research/2026-11-19_nba_cue_replay_2wk_OUTPUT.md').read()
for m in re.finditer(r'^(2026-\d\d-\d\d) (\S+)\s+Q(\d) (\d+:\d\d)\s+(\w+) \(', txt, re.M):
    d, mu, p, c, tr = m.groups(); g = G.get((d, mu))
    if g: fires.append({'src': 'replay', 'date': d, 'matchup': mu, 'gid': g['id'], 'period': int(p), 'clock': c, 'trailer': tr, 'ts': None, 'line': None})
rows = get('action=get_sweetspot_alerts&league=nba&limit=500')['sweetspot_alerts']
for r in rows:
    if r['alert_subtype'] != 'WATCHLIST' or not r.get('resolved'): continue
    fires.append({'src': 'live', 'date': str(r['game_date'])[:10], 'matchup': f"{r['away_alias']}@{r['home_alias']}", 'gid': r['game_id'],
                  'period': r['period'], 'clock': r['clock'], 'trailer': r['trailer_alias'], 'ts': r['created_at'], 'line': r.get('line_used')})
gids = sorted({f['gid'] for f in fires})
def pull(gid): return gid, get(f'action=history&game_id={gid}&league=nba')['snapshots'], get(f'action=get_odds&game_id={gid}&league=nba').get('odds', [])
with ThreadPoolExecutor(8) as ex: data = {gid: (h, o) for gid, h, o in ex.map(pull, gids)}
gm = {g['id']: g for g in games}

def walk(f):
    h, od = data[f['gid']]; g = gm[f['gid']]; home = g['home_alias']; trH = f['trailer'] == home
    snaps = sorted([s for s in h if s.get('ts')], key=lambda s: P(s['ts']))
    if f['ts']: fire_ts = P(f['ts'])
    else:
        cand = [s for s in snaps if s.get('period') == f['period'] and str(s.get('clock')) == str(f['clock'])]
        if not cand: return None
        fire_ts = P(cand[0]['ts'])
    quotes = sorted([o for o in od if (o.get('source') or 'odds-api') == 'odds-api' and o.get('ts')], key=lambda o: P(o['ts']))
    ml = lambda o: o['home_ml'] if trH else o['away_ml']
    pre = [o for o in quotes if P(o['ts']) <= fire_ts and ml(o) is not None]
    fire_ml = f['line'] if f['line'] is not None else (ml(pre[-1]) if pre else None)
    seq, si = [], 0
    for o in quotes:
        t = P(o['ts'])
        if t <= fire_ts or ml(o) is None: continue
        while si + 1 < len(snaps) and P(snaps[si + 1]['ts']) <= t: si += 1
        s = snaps[si]
        if P(s['ts']) > t: continue
        hp, ap = s.get('home_pts') or 0, s.get('away_pts') or 0
        deficit = (ap - hp) if trH else (hp - ap)   # >0 = trailer still behind
        e = s.get('espn_wp_home'); e = None if e is None else (e / 100 if e > 1 else e); eT = None if e is None else (e if trH else 1 - e)
        seq.append({'t': t, 'ml': ml(o), 'p': s.get('period') or 0, 'clk': cs(s.get('clock')), 'clock': s.get('clock'), 'def': deficit, 'espn': eT})
    return {'fire_ml': fire_ml, 'seq': seq, 'won': g.get('winner') == f['trailer'], 'fire_ts': fire_ts}

def simulate(w, thr_fn, window):
    """thr_fn(fire_ml, quote) -> threshold implied or None; window 'Q2Q3' or 'Q4_2'."""
    st = {'oob': 0, 'susp': False}; alerts = []; last = None
    for q in w['seq']:
        if q['p'] >= 4 and (window == 'Q2Q3' or (q['clk'] is not None and q['clk'] <= 120)): break  # terminal
        d = q['def']; inband = 1 <= d <= 9
        if st['susp']:
            if not inband: continue
            st = {'oob': 0, 'susp': False}
        elif not inband:
            st['oob'] += 1
            if st['oob'] >= 3: st['susp'] = True; continue
            if not (d == 0 or 10 <= d <= 11): continue
        else: st['oob'] = 0
        if q['espn'] is not None and abs(imp(q['ml']) - q['espn']) > 0.25: continue          # stale guard
        thr = thr_fn(w['fire_ml'], q)
        if thr is None or imp(q['ml']) > thr: continue
        if last is not None and imp(last) - imp(q['ml']) < ARGS.rearm: continue
        alerts.append(q); last = q['ml']
        if len(alerts) >= ARGS.max: break
    return alerts

OPTIONS = {
    'A  plus money (+100 or better)':        lambda f, q: imp(100),
    'B  10pp better than the cue price':     lambda f, q: None if f is None else imp(f) - 0.10,
    'C  15pp better than the cue price':     lambda f, q: None if f is None else imp(f) - 0.15,
    'D  at/under ESPN fair (value vs ESPN)': lambda f, q: q['espn'],
}
walks = []
for f in fires:
    w = walk(f)
    if w and w['fire_ml'] is not None: walks.append((f, w))
print(f"NBA JUICE threshold replay — DESCRIPTIVE, outcome-aware, LOW power · fires with a cue price on tape: {len(walks)} of {len(fires)} "
      f"({sum(1 for f,_ in walks if f['src']=='replay')} replay Nov 5–18 + {sum(1 for f,_ in walks if f['src']=='live')} live Nov 19+)")
print(f"Alert cap {ARGS.max}/arm · re-arm needs a {ARGS.rearm:.3f} implied drop.")
print("Tape: poll odds-api stamps (~1 min, best of all us/us2 books — an UPPER bound on what the 6-book JUICE roster would show).\n")
base_w = sum(1 for _, w in walks if w['won']); base_pnl = sum(pnl(w['fire_ml'], w['won']) for _, w in walks)
print(f"Baseline (enter at the cue price, every fire): trailer WON {base_w}/{len(walks)} · flat $100 {base_pnl:+.0f}\n")
for window in ('Q2Q3', 'Q4_2'):
    print(f"── window: {'Q2–Q3 only (alerts stop at Q4 start)' if window=='Q2Q3' else 'through Q4 2:00 (WNBA parity)'} ──")
    print(f"{'option':40s} {'fires alerted':>14s} {'alerts':>7s} {'won|alerted':>12s} {'$ at 1st alert':>15s} {'$ at cue, same':>15s} {'median 1st alert':>17s} {'in Q4':>6s}")
    for name, fn in OPTIONS.items():
        hit = []; nal = 0
        for f, w in walks:
            a = simulate(w, fn, window); nal += len(a)
            if a: hit.append((f, w, a))
        if not hit:
            print(f"{name:40s} {0:>14d}"); continue
        won = sum(1 for _, w, _ in hit if w['won'])
        p1 = sum(pnl(a[0]['ml'], w['won']) for _, w, a in hit); p0 = sum(pnl(w['fire_ml'], w['won']) for _, w, _ in hit)
        firsts = sorted(a[0]['ml'] for _, _, a in hit); med = firsts[len(firsts) // 2]
        q4 = sum(1 for _, _, a in hit if a[0]['p'] >= 4)
        print(f"{name:40s} {len(hit):>8d}/{len(walks):<5d} {nal:>7d} {won:>5d}/{len(hit):<6d} {p1:>+15.0f} {p0:>+15.0f} {('+' if med>0 else '')+str(med):>17s} {q4:>6d}")
    print()
# drift split for option B, Q2–Q3: cues whose price improved 10pp+ vs cues that held
_hit = [(f, w) for f, w in walks if simulate(w, OPTIONS['B  10pp better than the cue price'], 'Q2Q3')]
_held = [(f, w) for f, w in walks if not simulate(w, OPTIONS['B  10pp better than the cue price'], 'Q2Q3')]
print(f"Drift split (option B, Q2–Q3): drifted 10pp+ → trailer WON {sum(w['won'] for _,w in _hit)}/{len(_hit)} · held → WON {sum(w['won'] for _,w in _held)}/{len(_held)} "
      f"· flat $100 at cue: drifted {sum(pnl(w['fire_ml'],w['won']) for _,w in _hit):+.0f} / held {sum(pnl(w['fire_ml'],w['won']) for _,w in _held):+.0f}\n")
# per-fire detail for the recommended option (B, Q2–Q3) — the reader can audit every alert
print("── per-fire detail, option B (10pp better than cue), Q2–Q3 ──")
for f, w in walks:
    a = simulate(w, OPTIONS['B  10pp better than the cue price'], 'Q2Q3')
    fm = w['fire_ml']; first = a[0] if a else None
    print(f"{f['date']} {f['matchup']:8s} {f['trailer']:4s} cue Q{f['period']} {str(f['clock']):5s} at {('+' if fm>0 else '')}{int(fm):<5d} → "
          + (f"1st alert {('+' if first['ml']>0 else '')}{int(first['ml'])} Q{first['p']} {first['clock']} down {first['def']} (ESPN {'—' if first['espn'] is None else round(100*first['espn'])}%) · {len(a)} alert(s)" if first else "no alert")
          + f" · {'WON' if w['won'] else 'lost'}")
print("\nPower: LOW (<80). Outcome-aware (results already known) — informs an attention-routing policy only; never a gate, never a size.")
