# Step 2 — OOS Validation + Agent-Cited-Number n-Register

**Date:** May 29, 2026
**Purpose:** (1) Put fresh-game numbers on the corrected framing. (2) Enumerate the sample size behind
every quantitative claim the agent prompt feeds the model, so cutoffs for the "no precision in underpowered
regions" rule can be set from evidence, not in the abstract.
**Status:** Findings. No code changed.

---

## Part 1 — Out-of-sample validation (May 18–28, 27 WNBA games, post-lockin)

### H1 — failure-profile / mcOnlyFailure (trailing, floor≥0.65)
| Bucket | OOS | n (games) | Prompt | OOF doc |
|---|---|---|---|---|
| XGB≥0.60 & MC<0.60 (literal "72%") | 42.9% | 7 (2) | 72% | 38.8–40.6% |
| XGB≥0.50 & MC<0.60 (**as wired**) | 65.2% | 23 (8) | (72%) | — |
| └ implied 0.50–0.60 sub-band | **75%** | 16 | — | — |
| XGB<0.50 & MC<0.60 ("44%") | 40.0% | 35 (10) | 44% | — |
| baseline trailing floor≥0.65 | 50.8% | 59 (13) | — | 34.8% (all-trailing) |

**Verdict: region is structurally under-powered, not "72 should be 40."** Note the non-monotonicity — the
0.50–0.60 band (75%) beats the ≥0.60 band (43%). A lower-XGB band outscoring a higher one is a noise
signature, not signal. Structurally dominant teams rarely trail, so even a full OOS season yields only
~7–23 checkpoints in the decision buckets. No realistic data volume tightens this. The "44%" suppress
bucket did replicate cleanly (40%); the "72%" did not (and can't be confirmed either way at this n).

### H3 — graduation blowout contamination (526-game backtest, MC reconstructed)
Confirmation = first Q3+ checkpoint MC_cum≥0.80 & floor≥0.65.

| State | Slice | WR | n |
|---|---|---|---|
| CONFIRMED | ALL (headline) | **85.7%** | 517 |
| CONFIRMED | actionable (margin ≤10) | **81.0%** | 300 |
| CONFIRMED | close (≤8) | 77.0% | 217 |
| CONFIRMED | tight (≤5) | 68.4% | 57 |
| CONFIRMED | blowout (>10) | 92.2% | 217 |
| LOCKED (3+ holds) | ALL | 94.4% | 373 |
| LOCKED | actionable (≤10) | 88.5% | 122 |

42% of "confirmed" games are blowouts (>10). **Prompt asserts CONFIRMED 90.9%, LOCKED 94.8%.**
Corrected, well-powered numbers for the spec: CONFIRMED headline 85.7%, **actionable 81%, close 77%**;
LOCKED 94.4% headline / 88.5% actionable. (OOS actionable was 61.5% n=13 — consistent direction, but
underpowered; do NOT use it. Use the n=300 figure.)

### H2 — MC informativeness (trailing)
Single-checkpoint MC *level* did not separate winners among trailing floor≥0.65 (MC<0.40 → 48.8%,
0.40–0.60 → 53.3%, MC≥0.60 → n=1). This does NOT test the canary's *movement* claim (validated separately
at n=531 in `2026-05-28-wnba-canary-profitability.md`). H2 remains open; lives in the detection-side build.

---

## Part 2 — n-Register: every number the agent is fed

Power column uses **provisional** thresholds for discussion (HIGH ≥300 · MED 100–300 · LOW <100 ·
ORPHAN = no traceable n). **The cutoffs are Manny's call** — this table is the evidence to set them.

### Trust hierarchy / signal AUC
| Claim (line) | Value | n | Source | Power |
|---|---|---|---|---|
| Both-high consensus (829, 484) | 91.4% | 2,440 | 05-17 F4 | HIGH |
| Q4 all-3-high NBA (840) | 95.9% | 2,213 | NBA/05-17 | HIGH |
| MC underestimate Q4 0.7–0.8 (823) | 89.2% | 300 | 05-17 F5 | HIGH |
| MC underestimate Q4 0.8–0.9 (823) | 93.3% | 423 | 05-17 F5 | HIGH |
| Q4 MC≫XGB disagreement (822) | 78% | 299 | 05-17 F3 | MED |
| WNBA AUC MC 0.801 / XGB 0.802 (816–817) | — | 5,260 | 05-17 F1 | HIGH |
| Q3 "XGB wins 65% vs MC 60%" (821) | 65/60 | **unknown** | — | ORPHAN |
| XGB OOF "0.798/0.871" (817) | 0.798 | 5,260 | (should be 0.807) | ORPHAN-drift |
| ALIGNED 83% / Q4 90% (825) | 83/90 | **unknown** | 05-08? | ORPHAN |
| Floor "wrong 80%" (818) | 80% | unknown | 05-08/05-17 | VERIFY |

### Divergence (810)
| Claim | Value | n | Source | Power |
|---|---|---|---|---|
| WNBA MC-leads | 66% | unknown/cell | 526g? (spec said 64%/312g) | VERIFY |
| WNBA XGB-leads | 57% | unknown/cell | (spec said 42.9%) | VERIFY-drift |
| NBA MC-leads / XGB-leads | 92% / 50% | unknown/cell | 1,233 close subset | VERIFY |

### Failure profile (772/828) — the Class A epicenter
| Claim | Value | n | Source | Power |
|---|---|---|---|---|
| XGB≥0.60+MC<0.60 → win | 72% | 18 | 05-16 | **LOW** |
| XGB<0.50+MC<0.60 → win | 44% | 25 | 05-16 | **LOW** |

### WNBA BUY calibration (775–779, 897–899)
| Claim | Value | n | Power |
|---|---|---|---|
| Q2 XGB≥0.55 | 41.0% | 39 | LOW |
| Q3 XGB≥0.55 | 53.3% | 60 | LOW |
| Q3 XGB<0.35 | 27.4% | 124 | MED |
| Q4 XGB≥0.70 | 58.8% | **17** | **LOW** |
| Q4 XGB 0.45–0.70 | 42.9% | 49 | LOW |
| Q4 XGB<0.45 (suppress) | 20.5% | 117 | MED |
| "Q4 0.55+ viable 63.6%" | 63.6% | **none** | ORPHAN |

### WNBA BUY structure (892–896)
| Claim | Value | n | Power |
|---|---|---|---|
| trail 1–4 | 38.6% | ~197 | MED |
| trail 5–9 | 23.8% | 63 | LOW |
| trail 10+ | 0% | **2** | **LOW** |
| I2+I3 anchor | 44.8% | 67 | LOW |
| I1+I3 trap | 26.1% | 23 | **LOW** |
| ctrl I3 won | 39.2% | 166 | MED |
| ctrl I3 lost | 17.6% | **17** | **LOW** |
| opp I2 kill | 27.9% | 61 | LOW |
| opp I1 | 39.1% | 87 | LOW |
| XGB≥0.70 deepest trailing | 62.5% | **16** | **LOW** |

### Graduation tiers (852–861)
| Claim | Value (prompt) | Corrected (this session) | n | Power |
|---|---|---|---|---|
| WNBA CONFIRMED | 90.9% | 85.7% all / **81% actionable** | 517 / 300 | HIGH |
| WNBA LOCKED | 94.8% | 94.4% all / 88.5% actionable | 373 / 122 | HIGH |
| WNBA Q2-early | 89.6% | — | 278 (NBA-derived?) | VERIFY |
| WNBA close ≤8 | ~70% | 77.0% | 217 | HIGH |
| NBA CONFIRMED | 86% | (=actionable 86.6%) | 1,234g | HIGH |
| NBA LOCKED / Q2-early | 92% / 95.5% | — | 1,234g | HIGH |

### EXIT confirmation
| Claim | Value | n | Power |
|---|---|---|---|
| WNBA floor<0.55 at EXIT | 100% | **8** | **LOW** |
| WNBA floor 0.70+ at EXIT | 66.7% | 24 | LOW |
| WNBA EXIT overall | 70.1% | 67 | LOW |
| NBA MC<0.45 confirms EXIT | 84% | unknown | VERIFY |

---

## Summary for cutoff-setting
- **Clearly HIGH (keep numbers, agent may lean):** consensus 91.4%, Q4 all-3 95.9%, MC-underestimate buckets,
  WNBA AUCs, graduation tiers (corrected), NBA graduation.
- **Clearly LOW (strip the point estimate, qualitative + caution only):** failure-profile 72%/44%, XGB≥0.70
  trailing 62.5%, trail 10+ 0%, I3-lost 17.6%, I1+I3 26.1%, EXIT floor<0.55 100% (n=8), Q4 XGB≥0.70 58.8%.
- **MED (cite with explicit CI):** trail 1–4, ctrl I3 won, Q4 XGB<0.45 suppress, Q4 MC≫XGB 78%.
- **ORPHAN (purge or re-derive before citing):** 63.6%, Q3 65/60, ALIGNED 83/90, divergence cells, 0.798 drift.

Manny sets the HIGH/MED/LOW boundaries; the spec applies them mechanically per claim.
