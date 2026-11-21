# NBA JUICE threshold replay — OUTPUT (2026-11-21; descriptive, outcome-aware, LOW power)

Script: `research/2026-11-21_nba_juice_threshold_replay.py` · first run at the WNBA cap/re-arm (6 / .035), second at the recommended NBA cap/re-arm (3 / .05). Tape = poll `odds-api` stamps, ~1 min, best of ALL books the Odds API returns (us+us2, which includes offshore books) — an upper bound on what a legal-book roster would show. See NBA_JUICE_SPEC.md §2.

## cap 6 / re-arm .035
```
NBA JUICE threshold replay — DESCRIPTIVE, outcome-aware, LOW power · fires with a cue price on tape: 45 of 45 (37 replay Nov 5–18 + 8 live Nov 19+)
Alert cap 6/arm · re-arm needs a 0.035 implied drop.
Tape: poll odds-api stamps (~1 min, best of all us/us2 books — an UPPER bound on what the 6-book JUICE roster would show).

Baseline (enter at the cue price, every fire): trailer WON 31/45 · flat $100 +1343

── window: Q2–Q3 only (alerts stop at Q4 start) ──
option                                    fires alerted  alerts  won|alerted  $ at 1st alert  $ at cue, same  median 1st alert  in Q4
A  plus money (+100 or better)                 30/45         71    17/30               +1132            +830              +120      0
B  10pp better than the cue price              22/45         56    12/22                +599            -158              +105      0
C  15pp better than the cue price              16/45         38     7/16                +377            -330              +130      0
D  at/under ESPN fair (value vs ESPN)          37/45         67    25/37               +1416           +1357              -111      0

── window: through Q4 2:00 (WNBA parity) ──
option                                    fires alerted  alerts  won|alerted  $ at 1st alert  $ at cue, same  median 1st alert  in Q4
A  plus money (+100 or better)                 32/45        101    18/32               +1157            +755              +120      2
B  10pp better than the cue price              27/45         86    14/27                +574            -310              +120      5
C  15pp better than the cue price              22/45         67     9/22                +316            -582              +155      6
D  at/under ESPN fair (value vs ESPN)          38/45         77    25/38               +1316           +1257              +100      1

Drift split (option B, Q2–Q3): drifted 10pp+ → trailer WON 12/22 · held → WON 19/23 · flat $100 at cue: drifted -158 / held +1502

── per-fire detail, option B (10pp better than cue), Q2–Q3 ──
2026-11-05 MIA@GSW  GSW  cue Q2 12:00 at +105   → no alert · WON
2026-11-06 UTA@DAL  DAL  cue Q2 12:00 at -180  → 1st alert -105 Q2 8:24 down 8 (ESPN 38%) · 1 alert(s) · WON
2026-11-06 TOR@MIL  TOR  cue Q2 10:09 at +115   → 1st alert +180 Q2 7:13 down 8 (ESPN 29%) · 2 alert(s) · WON
2026-11-07 BKN@ATL  ATL  cue Q2 8:21  at +123   → no alert · WON
2026-11-07 HOU@PHX  HOU  cue Q2 5:35  at +200   → no alert · lost
2026-11-08 PHI@CHI  PHI  cue Q2 11:20 at -400  → no alert · WON
2026-11-08 BOS@MIL  BOS  cue Q2 12:00 at -380  → no alert · WON
2026-11-08 NOP@LAC  NOP  cue Q2 11:01 at -105  → 1st alert +150 Q2 8:13 down 6 (ESPN 37%) · 3 alert(s) · lost
2026-11-08 MIA@SAC  MIA  cue Q2 4:08  at -400  → no alert · WON
2026-11-09 CLE@CHA  CLE  cue Q2 9:55  at -210  → 1st alert -129 Q2 7:40 down 8 (ESPN 62%) · 2 alert(s) · lost
2026-11-09 WAS@DET  DET  cue Q2 12:00 at -280  → no alert · WON
2026-11-09 IND@DAL  DAL  cue Q2 12:00 at -120  → 1st alert +130 Q2 3:33 down 7 (ESPN 50%) · 3 alert(s) · WON
2026-11-11 BOS@TOR  BOS  cue Q2 12:00 at -105  → 1st alert +335 Q2 2:25 down 6 (ESPN 40%) · 1 alert(s) · WON
2026-11-11 BKN@NOP  NOP  cue Q2 10:02 at +265   → no alert · lost
2026-11-11 SAS@CHI  SAS  cue Q3 10:19 at -113  → no alert · WON
2026-11-11 ORL@UTA  ORL  cue Q2 12:00 at +105   → no alert · WON
2026-11-12 DET@WAS  DET  cue Q2 10:34 at -182  → no alert · WON
2026-11-12 TOR@PHI  PHI  cue Q2 11:32 at +195   → no alert · WON
2026-11-13 NYK@IND  NYK  cue Q2 6:55  at -180  → 1st alert +130 Q2 5:35 down 9 (ESPN 43%) · 3 alert(s) · lost
2026-11-13 ATL@CHI  ATL  cue Q2 5:32  at +134   → no alert · lost
2026-11-13 UTA@HOU  HOU  cue Q3 5:33  at -140  → no alert · WON
2026-11-14 DET@MIA  DET  cue Q2 7:32  at -145  → 1st alert +105 Q2 5:14 down 2 (ESPN 46%) · 5 alert(s) · lost
2026-11-14 CHI@MIN  MIN  cue Q3 2:34  at -105  → no alert · lost
2026-11-15 IND@PHI  PHI  cue Q2 12:00 at -133  → no alert · WON
2026-11-15 SAS@UTA  SAS  cue Q2 12:00 at -400  → no alert · WON
2026-11-15 ATL@MIL  ATL  cue Q2 4:41  at +125   → no alert · WON
2026-11-15 OKC@SAC  OKC  cue Q2 7:48  at -525  → no alert · WON
2026-11-16 CHI@CLE  CLE  cue Q2 12:00 at -160  → no alert · WON
2026-11-16 MEM@WAS  MEM  cue Q2 12:00 at -140  → 1st alert +120 Q2 9:44 down 6 (ESPN 40%) · 4 alert(s) · WON
2026-11-16 PHX@DEN  DEN  cue Q2 3:07  at -278  → 1st alert -160 Q3 11:48 down 3 (ESPN 53%) · 5 alert(s) · lost
2026-11-17 NYK@TOR  NYK  cue Q2 12:00 at +120   → 1st alert +230 Q2 5:37 down 11 (ESPN 31%) · 1 alert(s) · WON
2026-11-17 DET@SAS  SAS  cue Q3 3:59  at -195  → 1st alert -125 Q3 3:59 down 4 (ESPN 52%) · 3 alert(s) · lost
2026-11-17 UTA@LAC  LAC  cue Q2 12:00 at -115  → 1st alert +140 Q2 10:18 down 11 (ESPN 31%) · 1 alert(s) · lost
2026-11-18 MEM@CLE  MEM  cue Q2 12:00 at +255   → no alert · WON
2026-11-18 PHI@ORL  PHI  cue Q2 7:21  at +425   → no alert · WON
2026-11-18 DET@NOP  DET  cue Q2 10:51 at -166  → no alert · WON
2026-11-18 UTA@LAL  LAL  cue Q2 4:48  at -320  → 1st alert -190 Q2 1:26 down 4 (ESPN 65%) · 3 alert(s) · lost
2026-11-20 SAC@LAL  LAL  cue Q2 1:18  at -180  → 1st alert -110 Q3 4:34 down 9 (ESPN 41%) · 1 alert(s) · WON
2026-11-20 NOP@OKC  OKC  cue Q2 12:00 at -285  → 1st alert -154 Q2 6:39 down 8 (ESPN 68%) · 6 alert(s) · WON
2026-11-20 TOR@DET  DET  cue Q2 12:00 at -210  → 1st alert -120 Q2 5:51 down 8 (ESPN 47%) · 5 alert(s) · lost
2026-11-20 IND@CLE  CLE  cue Q2 11:21 at -200  → 1st alert -111 Q2 10:20 down 2 (ESPN 69%) · 2 alert(s) · WON
2026-11-20 CHA@ATL  ATL  cue Q2 12:00 at -125  → 1st alert +135 Q2 4:50 down 9 (ESPN 40%) · 1 alert(s) · WON
2026-11-19 LAC@SAS  SAS  cue Q3 9:48  at -430  → 1st alert -245 Q3 6:56 down 5 (ESPN 66%) · 1 alert(s) · WON
2026-11-19 POR@MIL  POR  cue Q2 4:23  at -175  → 1st alert -115 Q2 3:16 down 8 (ESPN 45%) · 1 alert(s) · WON
2026-11-19 NYK@MIN  MIN  cue Q2 12:00 at +180   → 1st alert +330 Q2 2:28 down 11 (ESPN 20%) · 2 alert(s) · lost

Power: LOW (<80). Outcome-aware (results already known) — informs an attention-routing policy only; never a gate, never a size.
```

## cap 3 / re-arm .05 (recommended)
```
NBA JUICE threshold replay — DESCRIPTIVE, outcome-aware, LOW power · fires with a cue price on tape: 45 of 45 (37 replay Nov 5–18 + 8 live Nov 19+)
Alert cap 3/arm · re-arm needs a 0.050 implied drop.
Tape: poll odds-api stamps (~1 min, best of all us/us2 books — an UPPER bound on what the 6-book JUICE roster would show).

Baseline (enter at the cue price, every fire): trailer WON 31/45 · flat $100 +1343

── window: Q2–Q3 only (alerts stop at Q4 start) ──
option                                    fires alerted  alerts  won|alerted  $ at 1st alert  $ at cue, same  median 1st alert  in Q4
A  plus money (+100 or better)                 30/45         57    17/30               +1132            +830              +120      0
B  10pp better than the cue price              22/45         44    12/22                +599            -158              +105      0
C  15pp better than the cue price              16/45         31     7/16                +377            -330              +130      0
D  at/under ESPN fair (value vs ESPN)          37/45         61    25/37               +1416           +1357              -111      0

── window: through Q4 2:00 (WNBA parity) ──
option                                    fires alerted  alerts  won|alerted  $ at 1st alert  $ at cue, same  median 1st alert  in Q4
A  plus money (+100 or better)                 32/45         70    18/32               +1157            +755              +120      2
B  10pp better than the cue price              27/45         61    14/27                +574            -310              +120      5
C  15pp better than the cue price              22/45         51     9/22                +316            -582              +155      6
D  at/under ESPN fair (value vs ESPN)          38/45         69    25/38               +1316           +1257              +100      1

Drift split (option B, Q2–Q3): drifted 10pp+ → trailer WON 12/22 · held → WON 19/23 · flat $100 at cue: drifted -158 / held +1502

── per-fire detail, option B (10pp better than cue), Q2–Q3 ──
2026-11-05 MIA@GSW  GSW  cue Q2 12:00 at +105   → no alert · WON
```
