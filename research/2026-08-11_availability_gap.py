# 2026-08-11 — AVAILABILITY-ADJUSTED QUALITY GAP
# Pre-registered: research/2026-08-11_availability_gap_PREREG.md (sha1 04b1882, locked before data cut)
# Arena: checkpoint reconstruction 2024+2025, per-bucket dedupe. Absence reconstructed
# from BDL player_stats box lines (rotation player with no row / 0 min = OUT).
import json
from collections import defaultdict

ALIAS = {'LVA':'LV','NYL':'NY','GSV':'GS','WAS':'WSH','LAS':'LA','PDX':'POR','TOY':'TOR'}
al = lambda a: ALIAS.get(a, a)
K_WINDOW, MPG_FLOOR, TEAM_MIN = 10, 8.0, 200.0

raw = json.load(open('/tmp/hist_checkpoints_raw.json'))
bdl = json.load(open('/tmp/bdl_games_2425.json'))
ps = json.load(open('/tmp/wnba_playerstats_2425.json'))

# ---- join checkpoint archive -> BDL game id via (date, away, home) ----
bkey = {}
for g in bdl:
    bkey[(g['date'][:10], al(g['visitor_team']['abbreviation']), al(g['home_team']['abbreviation']))] = g['id']
gid2bdl, miss = {}, 0
for g in raw:
    k = (str(g['date'])[:10], al(g['away']), al(g['home']))
    if k in bkey: gid2bdl[g['game_id']] = bkey[k]
    else: miss += 1
print(f"archive->BDL join: {len(gid2bdl)}/{len(raw)} matched, {miss} missed")

# ---- per-game team rosters + minutes ----
def mins(v):
    if v in (None, ''): return 0.0
    s = str(v)
    if ':' in s:
        p = s.split(':'); return float(p[0]) + float(p[1])/60.0
    try: return float(s)
    except: return 0.0

game_team_players = defaultdict(dict)     # (bdl_gid, team) -> {pid: minutes}
for r in ps:
    game_team_players[(r['gid'], al(r['team']))][r['pid']] = mins(r['min'])

pname = {r['pid']: r['name'] for r in ps}

# ---- team schedule (date-ordered BDL game ids) ----
tsched = defaultdict(list)
for g in bdl:
    d = g['date'][:10]
    tsched[al(g['visitor_team']['abbreviation'])].append((d, g['id']))
    tsched[al(g['home_team']['abbreviation'])].append((d, g['id']))
for t in tsched: tsched[t].sort()

def availability(team, date, bdl_gid, k=K_WINDOW, floor=MPG_FLOOR, per_team_game=True):
    """As-of rotation baseline from trailing k team games, then OUT set for this game."""
    prior = [gid for d, gid in tsched.get(team, []) if d < date][-k:]
    if len(prior) < 5: return None
    tot, appear = defaultdict(float), defaultdict(int)
    for pg in prior:
        for pid, m in game_team_players.get((pg, team), {}).items():
            tot[pid] += m
            if m > 0: appear[pid] += 1
    denom = len(prior)
    mpg = {pid: (tot[pid]/denom if per_team_game else (tot[pid]/appear[pid] if appear[pid] else 0.0))
           for pid in tot}
    rotation = {p: m for p, m in mpg.items() if m >= floor}
    if not rotation: return None
    top = sorted(rotation, key=lambda p: -rotation[p])
    top5, top8 = set(top[:5]), set(top[:8])
    today = game_team_players.get((bdl_gid, team), {})
    if not today: return None
    out = [p for p in rotation if today.get(p, 0.0) <= 0.0]
    return dict(out_core5=len(set(out) & top5), out_core8=len(set(out) & top8),
                out_n=len(out), out_min_share=sum(rotation[p] for p in out)/TEAM_MIN,
                names=[(pname.get(p, '?'), round(rotation[p], 1)) for p in
                       sorted(out, key=lambda p: -rotation[p])])

# ---- team season win% as-of (same recipe as spec_cuts_regime) ----
tl = defaultdict(list)
for g in raw:
    hA, aA = al(g['home']), al(g['away'])
    w = al(g['winner']) if g['winner'] else None
    tl[hA].append((str(g['date'])[:10], w == hA)); tl[aA].append((str(g['date'])[:10], w == aA))
for t in tl: tl[t].sort()
def rec(t, d):
    gs = [w for dd, w in tl.get(t, []) if dd < d]
    return (len(gs), sum(gs)/len(gs) if gs else None)

def tbucket(lbl):
    q, part = lbl.split('_'); return f"{q}-{'early' if part in ('7.5','5') else 'late'}"

# ---- build states ----
seen, S, dropped = set(), [], defaultdict(int)
for g in raw:
    gid = g['game_id']
    if gid not in gid2bdl: dropped['no_bdl_join'] += 1; continue
    bg = gid2bdl[gid]
    hA, aA, date = al(g['home']), al(g['away']), str(g['date'])[:10]
    avH, avA = availability(hA, date, bg), availability(aA, date, bg)
    if avH is None or avA is None: dropped['no_avail'] += 1; continue
    for c in sorted(g['checkpoints'], key=lambda x: x['gameSec']):
        p = c['period']
        if p not in (2, 3, 4): continue
        h, a = c['home'], c['away']
        hp, ap = h['pts'] or 0, a['pts'] or 0
        m = abs(hp - ap)
        if m < 1 or m > 15: continue
        ldH = hp > ap
        L, T = (h, a) if ldH else (a, h)
        ldAl, trAl = (hA, aA) if ldH else (aA, hA)
        key = (gid, ldAl, tbucket(c['label']))
        if key in seen: continue
        if (L['fga'] or 0) < 12 or (T['fga'] or 0) < 12: continue
        gl, gt = rec(ldAl, date), rec(trAl, date)
        if gl[0] < 10 or gt[0] < 10: continue
        seen.add(key)
        avL, avT = (avH, avA) if ldH else (avA, avH)
        S.append(dict(season=g['season'], date=date, gid=gid, period=p, margin=m,
                      leader=ldAl, trailer=trAl, gap=gt[1]-gl[1], lwp=gl[1], twp=gt[1],
                      t_out5=avT['out_core5'], t_share=avT['out_min_share'], t_names=avT['names'],
                      l_out5=avL['out_core5'], l_share=avL['out_min_share'], l_names=avL['names'],
                      net_share=avL['out_min_share']-avT['out_min_share'],
                      won=(al(g['winner']) == trAl if g['winner'] else None)))
S = [s for s in S if s['won'] is not None]
json.dump([{k: v for k, v in s.items() if k not in ('t_names', 'l_names')} for s in S],
          open('/tmp/avail_states.json', 'w'))
print(f"states: {len(S)} | dropped {dict(dropped)}")
print("by season:", {s: sum(1 for x in S if x['season'] == s) for s in (2024, 2025)})
json.dump([{'gid': s['gid'], 'date': s['date'], 'trailer': s['trailer'], 't_names': s['t_names'],
            'leader': s['leader'], 'l_names': s['l_names']} for s in S[:5]],
          open('/tmp/avail_sample.json', 'w'), indent=1)
