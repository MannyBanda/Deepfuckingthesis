import json, subprocess, sys
keys=open('alive_keys.txt').read().strip()
urns=json.load(open('season_urns.json'))
for league in sys.argv[1:]:
    for s in urns[league]:
        tag=s['name'].replace(' ','').replace('/','')
        out=league+"_"+s['id'].split(':')[-1]+"_states.json.gz"
        subprocess.run(["python3","pull_league.py",keys,s['id'],out,league+" "+s['name']])
