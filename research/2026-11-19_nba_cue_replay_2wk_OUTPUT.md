# NBA WATCHLIST cue — 2-week replay of the SHIPPED predicate (declared cut, no bars, LOW power)

**Script:** `research/2026-11-19_nba_cue_replay_2wk.py --from 2026-11-05 --to 2026-11-18` · **Tape:** production snapshots (2026-11-19 pull), `odds_history` price nearest the fire snapshot, finals from `games` · **Predicate:** `SS_CFG.nba.cue` as shipped in `c01a4d0` (gap ≥ .15 strict as-of ≥5 GP · Q2–Q3 · deficit 1–9 · leader eFG ≥ 57 · first qualifying moment per game).

**Selection note (matters):** production fires at the FIRST moment all clauses hold. The Nov 19 exploratory (`aaf0ec8`, n=39 over Oct 20–Nov 18) took the first in-band moment per game-trailer (any heat) and then classified it hot/not-hot — a stricter, smaller population. The shipped cue therefore fires more often (37 in 14 days) and converts a few points lower (+16pp vs ESPN here, +24pp there). Both LOW. The forward ledger measures the shipped population, which is the right one.

```
NBA WATCHLIST cue replay — shipped predicate (gap>=.15, Q2-Q3, deficit 1-9, leader eFG>=57, first perception/game) · finals 2026-11-05..2026-11-18
games on tape in window: 99 · GAP_BASE rows (silent): 44 · WATCHLIST fires (push): 37

date       game     fire      trailer (rec)    leader (rec)     gap   down ldr eFG price  impl  ESPN  stale touch result  final    P&L     
2026-11-05 MIA@GSW  Q2 12:00  GSW (0.625)      MIA (0.375)      0.25  3     60.9   +105   49%   46%   no    yes   WON     120-100  +105     
2026-11-06 UTA@DAL  Q2 12:00  DAL (0.500)      UTA (0.125)      0.38  2     58.3   -180   64%   58%   no    yes   WON     112-100  +56      
2026-11-06 TOR@MIL  Q2 10:09  TOR (0.500)      MIL (0.125)      0.38  8     57.7   +115   47%   30%   no    yes   WON     107-121  +115     
2026-11-07 BKN@ATL  Q2 8:21   ATL (0.600)      BKN (0.250)      0.35  9     77.3   +123   45%   44%   no    yes   WON     124-121  +123     
2026-11-07 HOU@PHX  Q2 5:35   HOU (0.778)      PHX (0.286)      0.49  9     71.0   +200   33%   35%   no    yes   lost    102-99   -100     
2026-11-08 PHI@CHI  Q2 11:20  PHI (0.800)      CHI (0.125)      0.68  1     57.1   -400   80%   74%   no    yes   WON     121-127  +25      
2026-11-08 BOS@MIL  Q2 12:00  BOS (0.778)      MIL (0.111)      0.67  2     62.5   -380   79%   77%   no    yes   WON     97-117   +26      
2026-11-08 NOP@LAC  Q2 11:01  NOP (0.444)      LAC (0.125)      0.32  3     60.0   -105   51%   44%   no    yes   lost    139-123  -100     
2026-11-08 MIA@SAC  Q2 4:08   MIA (0.333)      SAC (0.111)      0.22  1     66.2   -360   78%   73%   no    yes   WON     108-114  +28      
2026-11-09 CLE@CHA  Q2 9:55   CLE (0.500)      CHA (0.300)      0.20  7     60.3   -210   68%   66%   no    no    lost    124-112  -100     
2026-11-09 WAS@DET  Q2 12:00  DET (0.667)      WAS (0.400)      0.27  1     63.0   -280   74%   70%   no    yes   WON     122-111  +36      
2026-11-09 IND@DAL  Q2 12:00  DAL (0.600)      IND (0.300)      0.30  5     65.0   -120   55%   56%   no    yes   WON     125-122  +83      
2026-11-11 BOS@TOR  Q2 12:00  BOS (0.818)      TOR (0.500)      0.32  9     79.2   -105   51%   45%   no    yes   WON     93-98    +95      
2026-11-11 BKN@NOP  Q2 10:02  NOP (0.364)      BKN (0.200)      0.16  9     69.6   +265   27%   29%   no    no    lost    111-145  -100     
2026-11-11 SAS@CHI  Q3 10:19  SAS (0.818)      CHI (0.111)      0.71  9     74.4   -113   53%   46%   no    yes   WON     119-124  +88      
2026-11-11 ORL@UTA  Q2 12:00  ORL (0.300)      UTA (0.091)      0.21  5     68.2   +105   49%   48%   no    yes   WON     108-123  +105     
2026-11-12 DET@WAS  Q2 10:34  DET (0.700)      WAS (0.333)      0.37  2     62.5   -182   65%   60%   no    yes   WON     140-144  +55      
2026-11-12 TOR@PHI  Q2 11:32  PHI (0.750)      TOR (0.455)      0.30  9     58.0   +195   34%   45%   no    yes   WON     123-112  +195     
2026-11-13 NYK@IND  Q2 6:55   NYK (0.545)      IND (0.333)      0.21  5     57.4   -180   64%   61%   no    no    lost    106-104  -100     
2026-11-13 ATL@CHI  Q2 5:32   ATL (0.583)      CHI (0.100)      0.48  9     66.2   +134   43%   38%   no    yes   lost    125-117  -100     
2026-11-13 UTA@HOU  Q3 5:33   HOU (0.750)      UTA (0.083)      0.67  8     57.0   -140   58%   49%   no    yes   WON     125-118  +71      
2026-11-14 DET@MIA  Q2 7:32   DET (0.727)      MIA (0.500)      0.23  2     62.1   -145   59%   49%   no    no    lost    137-117  -100     
2026-11-14 CHI@MIN  Q3 2:34   MIN (0.750)      CHI (0.182)      0.57  8     57.4   -105   51%   40%   no    no    lost    106-117  -100     
2026-11-15 IND@PHI  Q2 12:00  PHI (0.769)      IND (0.385)      0.38  6     68.8   -133   57%   62%   no    yes   WON     131-124  +75      
2026-11-15 SAS@UTA  Q2 12:00  SAS (0.846)      UTA (0.077)      0.77  2     71.7   -400   80%   83%   no    yes   WON     102-110  +25      
2026-11-15 ATL@MIL  Q2 4:41   ATL (0.538)      MIL (0.077)      0.46  9     61.8   +125   44%   38%   no    yes   WON     106-113  +125     
2026-11-15 OKC@SAC  Q2 7:48   OKC (0.615)      SAC (0.083)      0.53  2     59.1   -525   84%   77%   no    yes   WON     103-125  +19      
2026-11-16 CHI@CLE  Q2 12:00  CLE (0.500)      CHI (0.250)      0.25  6     67.4   -160   62%   59%   no    yes   WON     126-115  +62      
2026-11-16 MEM@WAS  Q2 12:00  MEM (0.692)      WAS (0.286)      0.41  2     65.9   -140   58%   51%   no    yes   WON     120-136  +71      
2026-11-16 PHX@DEN  Q2 3:07   DEN (0.636)      PHX (0.417)      0.22  1     57.7   -278   74%   58%   no    yes   lost    105-117  -100     
2026-11-17 NYK@TOR  Q2 12:00  NYK (0.538)      TOR (0.385)      0.15  6     68.4   +120   45%   49%   no    yes   WON     102-111  +120     
2026-11-17 DET@SAS  Q3 3:59   SAS (0.857)      DET (0.667)      0.19  4     58.0   -195   66%   52%   no    no    lost    93-105   -100     
2026-11-17 UTA@LAC  Q2 12:00  LAC (0.333)      UTA (0.071)      0.26  6     70.5   -115   53%   43%   no    yes   lost    107-132  -100     
2026-11-18 MEM@CLE  Q2 12:00  MEM (0.714)      CLE (0.533)      0.18  7     58.0   +255   28%   16%   no    yes   WON     121-124  +255     
2026-11-18 PHI@ORL  Q2 7:21   PHI (0.800)      ORL (0.462)      0.34  8     74.2   +425   19%   31%   no    yes   WON     116-121  +425     
2026-11-18 DET@NOP  Q2 10:51  DET (0.692)      NOP (0.333)      0.36  3     66.7   -166   62%   70%   no    yes   WON     109-122  +60      
2026-11-18 UTA@LAL  Q2 4:48   LAL (0.917)      UTA (0.133)      0.78  3     69.4   -320   76%   69%   no    yes   lost    97-109   -100     

FIRES: 37 · trailer WON 25/37 (68%) · ESPN fair avg 52% · took the lead later 31/37 (84%)
P&L at the observed price, flat $100/fire: +1245 on 37 priced fires (+34% ROI) · stale-flagged prices: 0 · clean-price subset: 25/37 won, +1245 (+34% ROI)
GAP_BASE (silent ledger, same window): 44 rows · trailer WON 27/44 (61%) · ESPN fair avg 55%
  of which leader NOT hot (eFG<57): 15 · trailer WON 4/15 (27%) · ESPN fair avg 58%

Power: LOW (<80). Prices are the Odds API stamp nearest the fire moment — the NBA tape's stamps are often the PREGAME line (season audit); 'stale YES' = implied disagrees with ESPN's live fair by >25pp, the shipped flag. Read ordering, not precision.
```
