# PREREG — Cross-League Free Characterization Tests (T5)
**Date:** 2026-08-17 · **Status:** committed BEFORE data contact for all hypotheses below
**Data:** existing committed corpus only — `research/crossleague/*_states.json.gz` (6,372 games, 13 leagues × 2 seasons) + `research/fixtures_fine_states_matched.json.gz` (WNBA). **Zero API calls.**
**Instrument:** walker2.py reducer, extended window where stated. Game-weighted = ranking instrument; state-weighted reported alongside.
**Standing rules inherited:** both-seasons rule; power tags HIGH ≥200 / MED 80–199 / LOW <80; no directive language below MED; edge-vs-market unavailable (no prices exist for 11 of 13 — see FINDINGS 2026-08-14).

## PROMOTION RULE (all hypotheses)
**Nothing ships. Nothing enters any engine.** These are characterization tests for a possible future global build. Any per-league constant produced here is a CANDIDATE only, never auto-applied, and would require its own forward-validation prereg. WNBA production is untouched.

## H1 — TIME DECAY PER LEAGUE
**Q:** does the edge decay over game time as it does in the WNBA (pre-Q4 55.3 → Q4-early 44.7 → Q4-late 31.5)?
**Population:** window extended to full regulation, 30 ≤ t < 2400s, deficit 1–9, gap ≥ .15, ≥5 GP.
**Buckets:** Q1 (30–600) · Q2 (600–1200) · Q3 (1200–1800) · Q4-early (1800–2100) · Q4-late (2100–2400).
**Metric:** trailer-WIN rate per bucket per league.
**Bar:** STRUCTURAL decay = monotone non-increasing across buckets in BOTH seasons independently. Otherwise ordering-only.

## H2 — HOME-COURT CONFOUND (primary confound test)
**Q:** is the better-cell premium partly home advantage wearing a quality costume? Gap is win%-based and home-blind; several scan leaders have extreme home environments.
**Population:** scan population (750–1800s, deficit 1–9, ≥5 GP), split by whether the TRAILING team is home or away.
**Metric:** better-cell premium (better − even) computed separately for home-trailers and away-trailers.
**Bar:** CONFOUND FLAGGED for a league if home-trailer premium exceeds away-trailer premium by ≥10pp AND the sign holds in both seasons. CLEAN if |difference| <10pp. Leagues flagged get their scan rank annotated as home-inflated.

## H3 — RECORD MATURITY
**Q:** the ≥5 GP guard was inherited from a 40-game WNBA season; European seasons run 26–34 games, so as-of win% matures differently.
**Population:** scan population, guard swept at GP ≥ 5 / 8 / 12 / 15 (both teams).
**Metric:** better-cell premium and better-cell n at each guard.
**Bar:** STABILITY POINT = lowest guard beyond which premium moves <3pp with each further step. Reported per league; no pass/fail.

## H4 — GAP THRESHOLD & BAND WIDTH SWEEP
**Q:** the .15 gap bar and the 1–9 deficit band are WNBA-fitted. ABA holds 46% at 7–9 and may support a wider band.
**Population:** scan population/window.
**Sweeps:** gap threshold ∈ {.05, .10, .15, .20, .25, .35}; deficit band ∈ {1–6, 1–9, 1–12, 1–15}.
**Metric:** premium and n at each setting.
**Bar:** report curves only. A per-league candidate setting is named ONLY where it beats the WNBA-default setting by ≥5pp premium at n ≥ 80 in both seasons. Named candidates are candidates, not constants.

## H5 — PLAYOFF vs REGULAR SEASON
**Q:** bracket dynamics differ from regular season.
**Population:** scan population, split by a DATE PROXY — final 10% of each season's date range flagged as playoff-window. **Proxy is crude and disclosed**; stage data was not pulled (would cost API calls).
**Metric:** better-cell premium each side.
**Bar:** ordering only; LOW power expected. No structural claims from a proxy split.

## H6 — POINT-DIFFERENTIAL TIEBREAKER CONFOUND (exploratory, no bar)
**Q:** several of these competitions use point differential as a standings tiebreaker, which systematically changes late-game behavior (trailing teams press in decided games; leaders hold starters). This could inflate comeback-adjacent activity for non-comeback reasons, especially in group-stage formats (EuroLeague, Eurocup, BCL, ABA).
**Approach:** descriptive only — compare late-game (t ≥ 2100) scoring rate and lead-volatility in blowout-decided games across group-format vs pure-domestic leagues.
**Bar:** NONE. Exploratory. Flags a hypothesis for a future prereg; produces no claim.

## OUTPUTS
`research/crossleague/2026-08-17_freetests_FINDINGS.md` + script, committed with the numbers regenerable. Retractions, if any, stated as prominently as findings.
