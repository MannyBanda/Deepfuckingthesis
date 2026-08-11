# 2026-08-11 — H1..H4 against pre-registered bars (sha1 04b1882)
import json
S = json.load(open('/tmp/avail_states.json'))
IB = [s for s in S if 1 <= s['margin'] <= 9]          # operative band

def conv(a): return (100.0*sum(1 for s in a if s['won'])/len(a)) if a else None
def pw(n): return 'HIGH' if n >= 200 else ('MED' if n >= 80 else 'LOW')
def band(v):
    if v <= 0: return '0'
    if v <= .10: return '(0,.10]'
    if v <= .20: return '(.10,.20]'
    return '>.20'
BANDS = ['0', '(0,.10]', '(.10,.20]', '>.20']

def table(pop, keyf, label, bands=BANDS):
    print(f"\n{label}  (n={len(pop)})")
    print(f"  {'band':<11}{'n':>6}{'conv%':>8}{'power':>7}   2024        2025")
    rows = {}
    for b in bands:
        c = [s for s in pop if keyf(s) == b]
        if not c: continue
        c24 = [s for s in c if s['season'] == 2024]; c25 = [s for s in c if s['season'] == 2025]
        f = lambda a: f"{conv(a):.1f}%(n={len(a)})" if a else "-"
        rows[b] = (len(c), conv(c))
        print(f"  {b:<11}{len(c):>6}{conv(c):>7.1f}%{pw(len(c)):>7}   {f(c24):<12}{f(c25)}")
    return rows

print("="*74)
print(f"BASE: all states n={len(S)} conv={conv(S):.1f}% | in-band(1-9) n={len(IB)} conv={conv(IB):.1f}%")
print("="*74)

# ---------------- H1 ----------------
print("\n### H1 — trailer availability degrades conversion  [bar: >=10pp drop, both seasons, n>=80 high]")
r_all = table(S, lambda s: band(s['t_share']), "H1 all states, by TRAILER out_min_share")
r_ib = table(IB, lambda s: band(s['t_share']), "H1 in-band 1-9, by TRAILER out_min_share")
for nm, r in (('all', r_all), ('in-band', r_ib)):
    if '0' in r and '>.20' in r:
        d = r['0'][1] - r['>.20'][1]
        print(f"  [{nm}] drop band0 -> >.20 = {d:+.1f}pp   (bar 10.0pp, high-band n={r['>.20'][0]} {pw(r['>.20'][0])})")

# ---------------- H2 ----------------
print("\n### H2 — leader availability strengthens the fade  [bar: >=8pp lift, both seasons, n>=80 high]")
l_all = table(S, lambda s: band(s['l_share']), "H2 all states, by LEADER out_min_share")
l_ib = table(IB, lambda s: band(s['l_share']), "H2 in-band 1-9, by LEADER out_min_share")
for nm, r in (('all', l_all), ('in-band', l_ib)):
    if '0' in r and '>.20' in r:
        d = r['>.20'][1] - r['0'][1]
        print(f"  [{nm}] lift band0 -> >.20 = {d:+.1f}pp   (bar 8.0pp, high-band n={r['>.20'][0]} {pw(r['>.20'][0])})")

# ---------------- H3 ----------------
print("\n### H3 — additivity within gap strata  [bar: >=8pp clean-vs-any-out separation survives]")
def gstr(s):
    g = s['gap']
    return '<.15' if g < .15 else ('.15-.30' if g <= .30 else '>.30')
print(f"\n  in-band 1-9, trailer clean (share=0) vs any-out, within raw-gap strata")
print(f"  {'gap':<10}{'clean n':>9}{'clean%':>8}{'anyout n':>10}{'anyout%':>9}{'delta':>8}{'power':>7}")
for gs in ['<.15', '.15-.30', '>.30']:
    cell = [s for s in IB if gstr(s) == gs]
    cl = [s for s in cell if s['t_share'] <= 0]; ao = [s for s in cell if s['t_share'] > 0]
    if not cl or not ao: continue
    d = conv(cl) - conv(ao)
    print(f"  {gs:<10}{len(cl):>9}{conv(cl):>7.1f}%{len(ao):>10}{conv(ao):>8.1f}%{d:>+7.1f}pp{pw(min(len(cl),len(ao))):>7}")

# gap staircase control — must still be present (sanity that arena is intact)
print(f"\n  CONTROL — raw gap staircase on this arena (in-band):")
for gs in ['<.15', '.15-.30', '>.30']:
    c = [s for s in IB if gstr(s) == gs]
    print(f"    gap {gs:<9} n={len(c):>5}  conv={conv(c):.1f}%")

# ---------------- H4 ----------------
print("\n### H4 — operational PASS rule R  [bar: >=10pp below unflagged, both seasons, flagged n>=40]")
def R(s): return s['t_out5'] >= 2 or s['t_share'] >= .25
for nm, pop in (('all states', S), ('in-band 1-9', IB)):
    fl = [s for s in pop if R(s)]; un = [s for s in pop if not R(s)]
    d = conv(un) - conv(fl)
    print(f"\n  {nm}: flagged n={len(fl)} conv={conv(fl):.1f}% | unflagged n={len(un)} conv={conv(un):.1f}% | delta {d:+.1f}pp {pw(len(fl))}")
    for ss in (2024, 2025):
        f2 = [s for s in fl if s['season'] == ss]; u2 = [s for s in un if s['season'] == ss]
        if f2 and u2:
            print(f"      {ss}: flagged {conv(f2):.1f}%(n={len(f2)}) vs unflagged {conv(u2):.1f}%(n={len(u2)}) = {conv(u2)-conv(f2):+.1f}pp")

# component split
print("\n  rule components (in-band):")
for nm, f in (('out_core5>=2', lambda s: s['t_out5'] >= 2), ('share>=.25', lambda s: s['t_share'] >= .25),
              ('out_core5>=1', lambda s: s['t_out5'] >= 1), ('out_core5>=3', lambda s: s['t_out5'] >= 3)):
    c = [s for s in IB if f(s)]; o = [s for s in IB if not f(s)]
    if c: print(f"    {nm:<14} flagged n={len(c):>5} conv={conv(c):>5.1f}%  vs rest {conv(o):>5.1f}%  = {conv(o)-conv(c):+.1f}pp  {pw(len(c))}")
