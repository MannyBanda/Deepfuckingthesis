# WP-FRESHNESS — GAP UNTRUSTED veto REJECTED (2026-07-23)

**Registered hypothesis (pre-data, 2026-07-23):** in-band better-team-trailer spots convert
WORSE when (H1) trailer L10 wp runs materially below season wp (NY class) or (H2) leader L10 wp
runs materially above season wp (WSH class). Design: mechanical veto flag, not a blend (D-1).
Thresholds ±.10/.15/.20 pre-committed (D-3). L10 primary, L5 sensitivity (D-2).

**Verdict: REJECTED in both samples. No veto power exists. Season-to-date wp remains the
operative quality estimator — "MC wants volume" extends to team quality.**

## Frame

Identical to the registered forward-eval frame: first checkpoint per quarter in {Q2,Q3}
(WNBA) / Q2_END+Q3_END (NBA), trailer down 1-9, better-team trailers only (gap>0), both
teams ≥4 GP as-of (strictly pre-game), divergence defined at GP ≥12 (L10 a proper subset).
Divergence = L10 wp − season wp, both as-of game date, within-season ledgers.

Samples: WNBA 2024-25 historical — 576 BDL games, 5,260 checkpoint rows → 250 spots, 214
with both divergences [PRIOR]. NBA 2025-26 deficit-controlled — 1,233 games → Q3_END n=201,
Q2_END n=233 [PRIOR-HIGH]. Live 2026 forward — 20 resolved SS-stream spots [FACT-prod, LOW].
Baseline sanity: WNBA better-trailer 52.8%, gap≥.15 bands ~60% (replicates known ordering);
NBA Q3_END baseline 47.3% (vs 58% published — frame here is all better-trailers incl. small
gaps, not the published gap-conditioned cut; ordering consistent).

## Results

WNBA historical (thr ±.10 / ±.15): UNTRUSTED 64.5% (60/93, MED) / 62.0% (31/50) vs neutral
45.3% / 51.5%. H1 alone 72.0% / 63.0%. Direction stable across L5 window (64.7 vs 48.4) and
RS-only (61.2 vs 50.0). **Sign is OPPOSITE the registered veto — flagged spots converted
BETTER, consistent with divergence itself being reversion-loaded variance.** At ±.20 the
sign flips (33.3%, n=21 LOW) — unstable tail, no claim.

NBA transfer (the mandatory check): **NULL.** Q3_END untrusted 44.7/47.1% vs neutral
50.8/50.5%; Q2_END 52.2/48.6% vs 53.4/55.5%. H1 ≈ baseline everywhere. No elevation, no
veto, both thresholds, both checkpoints.

Live 2026 forward (n=20, ordering only): UNTRUSTED 2/3, neutral 7/9, FAVORABLE 5/8 — flat.

**Classification:** the WNBA-historical elevation carries the exact eFG-heat signature —
WNBA-only appearance, MED-at-best power, dies under NBA deficit control, no forward-stream
ordering support. Classified league/sample artifact per the Jun-9 standard. NOT promoted,
NOT registered forward. The reversal direction was itself unregistered.

## Killer robustness byproduct (WNBA, <.400 leaders in band, LOW — ordering)

Independent frame replication: killer leaders 71.4% (40/56) vs no-scalp 44.7% (21/47) —
matches the 67/53 evidence via a different spot construction. Divergence-clean killers still
71.7% → **the killer effect is NOT explained by form divergence; the flag survives this cut
as an independent discriminator.** (No-scalp+untrusted 69.2%, n=13: non-transferring, ignore.)

## What this changes (triage decomposition — the operative output)

Two staleness classes were conflated in manual gap-distrust:

1. **Roster staleness** (Bueckers class — personnel changed, season wp measured a different
   team): VALIDATED independently (row 545), out of scope here (D-5). Remains a legitimate
   gap-distrust strike.
2. **Form staleness** (NY/WSH class — same roster, recent results diverge): **no veto power
   in either league.** A trailer in a form slump is not a worse buy; a form-hot leader is
   not a reliably different fade.

Triage rule sharpened: **distrust gaps on roster news, never on form slumps.** Applied to
Jul 22: the injury component of the NY skip stands; the "losing to the rest lately"
component gets no support; the +400 re-entry was right on price regardless. Row 704 itself
was double-flagged (t_div −.16, l_div +.15) and converted.

## Disposition

Dead: GAP UNTRUSTED veto (both legs, both leagues). Dead: form-divergence as a gap
adjustment input (do not revisit without a genuinely new mechanism). Alive & untouched:
roster-staleness strike (row-545 class), killer flag (robustness strengthened), season-wp
gap as specced. Trailer-side killer cut (D-4) remains a separate open item on this data
pull. No production changes; zero code shipped.
