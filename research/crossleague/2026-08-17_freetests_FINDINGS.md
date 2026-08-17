# T5 FREE CHARACTERIZATION TESTS — FINDINGS
**Prereg:** 2026-08-17_freetests_PREREG.md (07ab416, sha 84053a11, committed before data contact)
**Data:** on-disk corpus, 6,372 games / 13 leagues / 2 seasons. Zero API calls.
**Promotion rule (unchanged):** nothing ships; all per-league values are CANDIDATES for a future global build.

## H1 — TIME DECAY: UNIVERSAL. STRUCTURAL in 9 of 13.
Monotone non-increasing pooled in ALL 13 leagues; both-seasons independent in 9 (BCL, France, BBL, Greek, Israel, Italy, ACB, NBL, Turkish). ABA/EuroLeague/Eurocup/LKL pooled-only.
Q1 60-77% -> Q4-late 17-42%. WNBA shape (55.3/44.7/31.5 pre-Q4/Q4e/Q4l) sits mid-pack; EuroLeague near-identical (45.5/40.5/31.6).
**Read:** decay is the most portable property found so far. Q4-late is a death zone everywhere. LKL steepest (68.8->17.4, LOW power).

## H2 — HOME-COURT CONFOUND: TOP TIER CLEAN. Four leagues FLAGGED.
Bar: home-trailer premium exceeds away-trailer by >=10pp AND sign holds both seasons.
FLAGGED (rank annotated home-inflated): EuroLeague +16.8 | Italy Serie A +18.1 | Eurocup +16.0 | Turkish BSL +13.6.
CLEAN: **Greek A1 -16.4 | ABA -5.7 | Liga ACB -0.1** — the three scan winners are NOT home-inflated. ACB is near-perfectly venue-symmetric.
**Inverse tell:** Greek A1 (+37.1 away vs +20.7 home) and Israel (+25.0 vs +9.3) show AWAY better-trailers converting harder. Unexplained; candidate for its own prereg.
**Consequence:** the scan ranking SURVIVES its primary confound test. Turkish BSL drops in credibility (mid-tier, flagged).

## H3 — RECORD MATURITY: >=5 GP guard holds. Two exceptions.
Premium stable from GP>=5 in 9 leagues. **Greek A1 and Israel stabilize only at GP>=12.** Eurocup DEGRADES with maturity (+13.6 -> +4.7); BCL unstable (n collapses, group format too short).
**Candidate:** GP>=12 guard for Greek A1/Israel in any future build; GP>=5 elsewhere. BCL/Eurocup group formats may be too short to mature records at all.

## H4a — GAP THRESHOLD: premium RISES with threshold nearly everywhere.
At gap>=.35: Greek +47.8 (n=42) | ABA +46.0 (n=36) | Israel +37.7 (n=53) | ACB +31.7 (n=65) | LKL +54.8 (n=15, LOW).
Named candidates (beat WNBA-default .15 by >=5pp at n>=80 both seasons): **Greek A1 .25 (+47.4, n=57)** — n<80, so candidate NOT named under bar; **ACB .25 (+25.3, n=123) qualifies**; **Turkish .25 (+22.9, n=119) qualifies**; **BBL .25 (+22.0, n=90) qualifies**.
**Read:** the WNBA .15 bar is CONSERVATIVE in most leagues. Selectivity pays across the board.

## H4b — DEFICIT BAND: 1-6 >= 1-9 EVERYWHERE. No league supports widening.
Prior hypothesis (ABA's 46% at 7-9 might support a wider band) is REJECTED: ABA 1-6 = 69.8 vs 1-9 = 67.2 vs 1-15 = 66.2 — widening monotonically dilutes. Same in all 13.
**Read:** tighter is better everywhere; 1-9 is already generous. Band-widening is now a do-not-revisit item cross-league.

## H5 — PLAYOFF PROXY: UNUSABLE. n=1-17 per league.
Date-proxy cut yields LOW power in every league (max n=17). Directionally playoff-window premiums run higher in 9 of 13, but nothing is claimable. **Requires real stage data (API call) to test properly.**

## H6 — TIEBREAKER CONFOUND: not run.
Deprioritized after H2 cleared the top tier. Remains an open exploratory question for group-format leagues (EuroLeague, Eurocup, BCL, ABA).

## WHAT CHANGES
Nothing ships. WNBA production untouched. Scan ranking stands, with Turkish BSL and Italy annotated home-inflated, and EuroLeague/Eurocup home-inflated (already bottom-tier).
