#!/usr/bin/env python3
"""WNBA Data Layer v3 — Phase 4a backfill.
Pulls BDL team_game_advanced_stats for all 2026 WNBA games -> wnba_official_stats via db-api.
Run from Claude sandbox. Idempotent (upsert)."""
import urllib.request, json, base64, time, sys

BDL_KEY = 'ee78e074-2f89-4ee5-807a-181fc324398c'
AUTH = 'Basic ' + base64.b64encode(b'manny:DFT2025!').decode()
API = 'https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api'

def bdl(path, t=45, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request('https://api.balldontlie.io' + path)
            req.add_header('Authorization', BDL_KEY)
            return json.loads(urllib.request.urlopen(req, timeout=t).read())
        except Exception as e:
            if i == retries - 1: raise
            time.sleep(2 * (i + 1))

def api_post(action, payload, t=90):
    req = urllib.request.Request(f'{API}?action={action}', data=json.dumps(payload).encode(),
                                 headers={'Authorization': AUTH, 'Content-Type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(req, timeout=t).read())

def main():
    # 1. All 2026 WNBA games (finished only)
    games, cursor = [], None
    while True:
        q = '/wnba/v1/games?seasons[]=2026&per_page=100' + (f'&cursor={cursor}' if cursor else '')
        resp = bdl(q)
        games += resp.get('data', [])
        cursor = (resp.get('meta') or {}).get('next_cursor')
        if not cursor: break
    finished = [g for g in games if g.get('status') == 'post']
    print(f'2026 games: {len(games)} total, {len(finished)} finished')

    # 2. Advanced stats, batched 10 game_ids per call
    rows, missing = [], []
    ids = [g['id'] for g in finished]
    meta = {g['id']: g for g in finished}
    for i in range(0, len(ids), 10):
        batch = ids[i:i+10]
        q = '/wnba/v1/team_game_advanced_stats?' + '&'.join(f'game_ids[]={x}' for x in batch) + '&per_page=100'
        resp = bdl(q)
        data = resp.get('data', [])
        got = set()
        for r in data:
            gid = r['game']['id']; got.add(gid)
            g = meta.get(gid, {})
            home_abbr = (g.get('home_team') or {}).get('abbreviation')
            away_abbr = (g.get('visitor_team') or {}).get('abbreviation')
            abbr = r['team']['abbreviation']
            s = r.get('stats', {})
            rows.append({
                'bdl_game_id': gid, 'team_abbr': abbr,
                'is_home': abbr == home_abbr,
                'opponent_abbr': away_abbr if abbr == home_abbr else home_abbr,
                'game_date': (g.get('date') or '')[:10],
                'misc': s.get('misc', {}), 'advanced': s.get('advanced', {}),
                'four_factors': s.get('four_factors', {}), 'scoring': s.get('scoring', {}),
                'usage_stats': s.get('usage', {}),
            })
        missing += [x for x in batch if x not in got]
        print(f'  batch {i//10+1}: +{len(data)} rows', flush=True)
        time.sleep(0.3)
    print(f'rows: {len(rows)} | games missing advanced: {len(missing)} {missing[:10]}')

    # 3. Upsert in chunks of 40
    total = 0
    for i in range(0, len(rows), 40):
        out = api_post('upsert_wnba_official', {'rows': rows[i:i+40]})
        total += out.get('upserted', 0)
    print('upserted:', total)

if __name__ == '__main__':
    main()
