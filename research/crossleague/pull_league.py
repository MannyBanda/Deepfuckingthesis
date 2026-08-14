#!/usr/bin/env python3
"""Cross-league scan puller (T1: EuroLeague). Resumable chunked pull: index + per-game timelines -> compact states.
Usage: pull_league.py KEY1,KEY2 season_urn out.json.gz LABEL [max_games_this_run]"""
import json, gzip, sys, time, urllib.request, os, threading

BASE = "https://api.sportradar.com/basketball/trial/v2/en"

def get(url, retries=2):
    for a in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=25) as r:
                return json.loads(r.read())
        except Exception:
            if a == retries-1: raise
            time.sleep(2)

def pull_index(season_urn, key):
    games, offset = [], 0
    while True:
        d = get(f"{BASE}/seasons/{season_urn.replace(':','%3A')}/summaries.json?api_key={key}&offset={offset}&limit=200")
        s = d.get('summaries', [])
        for it in s:
            ev, st = it['sport_event'], it.get('sport_event_status', {})
            if st.get('status') != 'closed': continue
            comps = ev.get('competitors', [])
            if len(comps) != 2: continue
            home = next((c for c in comps if c.get('qualifier')=='home'), comps[0])
            away = next((c for c in comps if c.get('qualifier')=='away'), comps[1])
            games.append({
                'gid': ev['id'], 'start': ev.get('start_time'),
                'home_id': home['id'], 'home': home['name'],
                'away_id': away['id'], 'away': away['name'],
                'fh': st.get('home_score'), 'fa': st.get('away_score'),
                'winner': st.get('winner_id'),
                'ps': [{'n':p.get('number'),'t':p.get('type'),'h':p.get('home_score'),'a':p.get('away_score')} for p in st.get('period_scores',[])]
            })
        if len(s) < 200: break
        offset += 200
        time.sleep(1.15)
    games.sort(key=lambda g: g['start'] or '')
    return games

def clock_to_sec(c):
    if not c: return None
    try:
        parts = c.split(':'); return int(parts[0])*60 + int(parts[1])
    except Exception: return None

def fetch_one(g, key):
    url = f"{BASE}/sport_events/{g['gid'].replace(':','%3A')}/timeline.json?api_key={key}"
    try:
        d = get(url)
    except Exception as e:
        return {**g, 'err': str(e)[:80], 'ev': []}
    period, evs = 0, []
    for e in d.get('timeline', []):
        t = e.get('type')
        if t == 'period_start':
            p = e.get('period')
            period = p if isinstance(p, int) else period+1
        elif t == 'score_change':
            evs.append({'p': period, 'c': clock_to_sec(e.get('match_clock')),
                        'mt': e.get('match_time'), 'h': e.get('home_score'), 'a': e.get('away_score')})
    return {**g, 'ev': evs}

def main():
    keys = sys.argv[1].split(',')
    season_urn, out, label = sys.argv[2], sys.argv[3], sys.argv[4]
    max_run = int(sys.argv[5]) if len(sys.argv) > 5 else 10**9
    idx_path = out.replace('.json.gz', '.index.json')
    if os.path.exists(idx_path):
        idx = json.load(open(idx_path))
    else:
        idx = pull_index(season_urn, keys[0])
        json.dump(idx, open(idx_path, 'w'))
    done = {}
    if os.path.exists(out):
        for s in json.load(gzip.open(out, 'rt')):
            if 'err' not in s: done[s['gid']] = s   # errored rows retry next run
    todo = [g for g in idx if g['gid'] not in done][:max_run]
    print(f"[{label}] index {len(idx)} | done {len(done)} | this run {len(todo)}", flush=True)
    results, lock = dict(done), threading.Lock()
    def worker(key, mygames):
        for g in mygames:
            r = fetch_one(g, key)
            with lock: results[g['gid']] = r
            time.sleep(1.1)
    threads = [threading.Thread(target=worker, args=(k, todo[i::len(keys)])) for i, k in enumerate(keys)]
    t0 = time.time()
    for t in threads: t.start()
    for t in threads: t.join()
    ordered = [results[g['gid']] for g in idx if g['gid'] in results]
    with gzip.open(out, 'wt') as f: json.dump(ordered, f)
    errs = sum(1 for s in ordered if 'err' in s)
    print(f"[{label}] saved {len(ordered)}/{len(idx)} ({errs} err) in {time.time()-t0:.0f}s -> {out}", flush=True)

if __name__ == '__main__': main()
