import json, gzip, glob, os
rows=[]
for f in sorted(glob.glob("*_states.json.gz")):
    idxf=f.replace('.json.gz','.index.json')
    n_idx=len(json.load(open(idxf))) if os.path.exists(idxf) else None
    s=json.load(gzip.open(f,'rt'))
    errs=sum(1 for g in s if 'err' in g)
    noev=sum(1 for g in s if not g.get('ev'))
    status="COMPLETE" if (n_idx and len(s)==n_idx and errs==0) else "INCOMPLETE"
    rows.append((f, n_idx, len(s), errs, noev, status))
print("%-42s %6s %6s %5s %5s  %s" % ("file","index","pulled","err","noev","status"))
for r in rows: print("%-42s %6s %6s %5s %5s  %s" % r)
tot=sum(r[2] for r in rows)
print("\ntotal games pulled: %d" % tot)
