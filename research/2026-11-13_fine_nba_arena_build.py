#!/usr/bin/env python3
# FINE NBA ARENA — chunk walker + assembler (FINE_NBA_ARENA_SPEC Amendment 1).
# Walks backtest-nba-snapshots?phase=export_fine&season=S&grain=30 chunk by chunk (nextStep), caches every
# chunk to disk (resume-safe), assembles the committed states-file shape with the walk-integrity block, and
# in --regress mode compares the re-export against a committed file (states byte-equal + walk block equal).
#
#   build:   DFT_AUTH=manny:... python3 research/2026-11-13_fine_nba_arena_build.py --season 2024 --out research/2026-11-13_fine_nba_states_2024.json.gz --cache /tmp/arena2024 --phase-sha <sha>
#   regress: python3 research/2026-11-13_fine_nba_arena_build.py --season 2025 --limit 64 --regress research/2026-10-23_fine_nba_states.json.gz --cache /tmp/arena2025reg
import os, sys, json, gzip, time, base64, argparse, urllib.request, urllib.error, datetime
ap = argparse.ArgumentParser()
ap.add_argument('--season', type=int, required=True); ap.add_argument('--grain', type=int, default=30)
ap.add_argument('--n', type=int, default=16); ap.add_argument('--c', type=int, default=8)
ap.add_argument('--limit', type=int, default=None, help='stop after this many games (regression)')
ap.add_argument('--out', default=None); ap.add_argument('--cache', required=True)
ap.add_argument('--regress', default=None, help='committed states file to compare against')
ap.add_argument('--phase-sha', default=None); ap.add_argument('--base', default='https://poetic-starlight-aa8938.netlify.app/.netlify/functions/backtest-nba-snapshots')
a = ap.parse_args(); os.makedirs(a.cache, exist_ok=True)
AUTH = 'Basic ' + base64.b64encode(os.environ.get('DFT_AUTH', 'manny:DFT2025!').encode()).decode()

def call(q, tries=4):
    for t in range(tries):
        try:
            r = urllib.request.Request(f'{a.base}{q}', headers={'Authorization': AUTH})
            with urllib.request.urlopen(r, timeout=120) as f: return json.loads(f.read().decode())
        except Exception as e:
            print(f'  retry {t+1}: {e}', file=sys.stderr); time.sleep(5 * (t + 1))
    raise SystemExit('chunk failed repeatedly: ' + q)

# ── walk integrity (FINE_NBA_ARENA_SPEC §1.3 rule, reproduced): ok = no 0-0 state in Q2+ AND |walked Q4_END − final| ≤ 4 total points (ties at Q4_END = OT, exempt)
def walk_block(g):
    S = g['states']
    q4 = next((s for s in S if s['l'] == 'Q4_END'), None)
    periods = {s['p'] for s in S}
    missing = any(p not in periods for p in (1, 2, 3, 4))
    zero = any(s['p'] >= 2 and s['h']['pts'] == 0 and s['a']['pts'] == 0 for s in S)
    tied = bool(q4) and q4['h']['pts'] == q4['a']['pts']
    # exempt (tied at Q4_END = OT) records final_dev = 0, matching the committed 2025-26 file's convention
    final_dev = None if not q4 else (0 if tied else abs((q4['h']['pts'] + q4['a']['pts']) - (g['home_pts'] + g['away_pts'])))
    ok = (not missing) and (not zero) and (tied or (final_dev is not None and final_dev <= 4))
    return {'q4end_tied_ot': tied, 'final_dev': final_dev, 'missing_period': missing, 'ok': ok}

# ── walk chunks ─────────────────────────────────────────────────────────────
games, failed, offset, chunk = [], [], 0, 0
q = f'?phase=export_fine&grain={a.grain}&season={a.season}&n={a.n}&c={a.c}&offset=0'
t0 = time.time()
while True:
    cf = f'{a.cache}/chunk_{offset:05d}.json'
    if os.path.exists(cf): d = json.load(open(cf))
    else:
        d = call(q); json.dump(d, open(cf, 'w'))
    if d.get('status') != 'ok': raise SystemExit('bad chunk: ' + json.dumps(d)[:300])
    if d.get('season') != a.season: raise SystemExit(f"season drift: asked {a.season}, got {d.get('season')}")
    games += d['games']; failed += d.get('failed', [])
    chunk += 1
    if chunk % 10 == 0: print(f'  {chunk} chunks, {len(games)} games, {len(failed)} failed, {time.time()-t0:.0f}s', file=sys.stderr)
    if d['nextStep'] == 'COMPLETE' or (a.limit and len(games) >= a.limit): break
    offset += d['processed']; q = d['nextStep']
print(f'walked {len(games)} games ({len(failed)} failed) in {time.time()-t0:.0f}s, {chunk} chunks', file=sys.stderr)

# ── assemble ────────────────────────────────────────────────────────────────
for g in games: g['walk'] = walk_block(g)
RULE = 'ok = no 0-0 state in Q2+ AND |walked Q4_END - final| <= 4 total points (ties at Q4_END = OT, exempt)'
out = {'generated': datetime.date.today().isoformat(), 'spec': 'FINE_NBA_ARENA_SPEC.md (Amendment 1)', 'phase_sha': a.phase_sha, 'grain': a.grain, 'season': a.season,
       'games': games, 'failed': failed, 'walk_integrity_rule': RULE}
ok_n = sum(1 for g in games if g['walk']['ok'])
print(f'walk integrity: {ok_n}/{len(games)} ok | dates {min(g["date"] for g in games)} → {max(g["date"] for g in games)}', file=sys.stderr)

if a.regress:
    ref = {g['gid']: g for g in json.load(gzip.open(a.regress))['games']}
    same_states = same_walk = cmp = 0; diffs = []
    for g in games:
        r = ref.get(g['gid'])
        if not r: continue
        cmp += 1
        if json.dumps(g['states'], sort_keys=True) == json.dumps(r['states'], sort_keys=True): same_states += 1
        else:
            # locate first differing state/key for the report
            for i, (x, y) in enumerate(zip(g['states'], r['states'])):
                if json.dumps(x, sort_keys=True) != json.dumps(y, sort_keys=True):
                    keys = [k for k in ('h', 'a', 'pd', 'floor', 'ctrl') if json.dumps(x.get(k), sort_keys=True) != json.dumps(y.get(k), sort_keys=True)]
                    diffs.append((g['gid'], g['date'], x['l'], keys)); break
        if g['walk'] == r['walk']: same_walk += 1
        elif not diffs or diffs[-1][0] != g['gid']: diffs.append((g['gid'], g['date'], 'WALK', [g['walk'], r['walk']]))
    print(f'REGRESSION vs {os.path.basename(a.regress)}: compared {cmp} | states byte-equal {same_states}/{cmp} | walk block equal {same_walk}/{cmp}', file=sys.stderr)
    for dd in diffs[:12]: print('   diff:', dd, file=sys.stderr)
    sys.exit(0 if (same_states == cmp and same_walk == cmp) else 2)

if a.out:
    with gzip.open(a.out, 'wb') as f: f.write(json.dumps(out).encode())
    print(f'wrote {a.out} ({os.path.getsize(a.out)/1e6:.1f} MB)', file=sys.stderr)
