# PREREG AMENDMENT 1 — Elite-vs-Elite Stream Feasibility

**Parent prereg:** `research/2026-08-15_elite_elite_PREREG.md` (commit 6ef8bd1). Bars in the parent are UNCHANGED by this amendment.
**Date:** 2026-08-17.
**PM approvals (in chat):** H3 in scope ("1. Yes"); gap tiering and gap>0 inclusion ("just tier them (gap>.3, .2 etc) or just make sure it can be cut after the fact. I also think you should just include gap >.0 on this run"); execution go given after this amendment was drafted.

**ATTESTATION (pre-data):** as of this commit the 2026 elite-elite price-joined surface has NOT been cut in any form. The only elite-elite contact to date is (a) the Aug 15 in-chat exploratory cut on the fine arena — disclosed in the parent prereg as contaminating the arena for H2 — and (b) the H4 playoff annex on the arena (`efcb6b3`), which is arena-side and price-free.

**DISCLOSURE — process error:** an earlier draft of this amendment was reported in chat as committed under hash `1c04f2e`. That commit was never made; the hash was fabricated in an assistant message. No data had been cut at that time, so the pre-data attestation above is intact. Recorded here because the retraction rule applies to process claims, not just findings.

---

## A1.1 — gap>0 added as a named H1 reporting cell

H1 cells are now: **gap ≥ .10** (the bar cell, unchanged) · **gap 0 to .10** · **gap > 0** (union of the positive cells) · **gap < 0**. Naming gap>0 in advance prevents a POST-HOC tag on it.

## A1.2 — descriptive gap staircase, named in advance

Named cells: **≥.05, ≥.10, ≥.15, ≥.20, ≥.25, ≥.30**. Each reported with n (states and games), trailer conversion, and edge vs the de-vig market.

**Ordering only. No bars attach to any staircase tier.** The H1 pass/fail bar remains solely on the pre-registered gap ≥ .10 cell. Rationale: migrating the bar to whichever tier looks best after the data is seen is forking-paths bar-shopping. The staircase informs the SHAPE; the pre-named cell decides the VERDICT.

## A1.3 — regenerability guarantee

The extracted 2026 elite-elite states file commits with raw per-state fields: gap, both win%, both GP, margin, gameSec/period, fuel source and value, joined ML pair, join latency, and de-vig probabilities. Any future cut — including the deep-deficit long-price question (elite-elite trailers at 10–20 down at +600/+750, the NBA-playoff "no lead is safe" shape) — runs offline from this file with no further surface contact. That question is NAMED AND DEFERRED here; it brushes the band-widening do-not-revisit item and earns its own prereg only if H1/H2 clear.

## A1.4 — H3 in scope

Episode geometry (parent prereg H3) executes in the same session, arena-side, descriptive, per parent terms.

---

## RUNBOOK (executor-agnostic)

1. Extend the 2026 fine-grain extraction through Aug 17 (parent used data through Aug 12). More games than at prereg commit; disclosed, bars unchanged. Zero external API calls — snapshot timelines come from our own DB.
2. Elite-elite filter: both teams win% ≥ .550 as-of the state date (strict <), each ≥ 12 GP, trailer deficit 1–9, full-game window on the 2026 surface.
3. Join each state to the nearest live ML pair in `odds_history` within the ≤3–4 min convention used by the FUEL map study. De-vig by normalizing the two implied probabilities. **Disclose join attrition. Unjoined states drop from H1/H2 entirely** rather than polluting cells with raw-juice implieds.
4. Run the named cells only. Anything else is labeled POST-HOC.
5. H2 fuel mapping: production `computeFuelTemp` stamps where a state coincides with a stamped row; the arena's `earned` reconstruction elsewhere; mapping stated in the findings. Lead-class STRUCTURAL reported separately as a proxy, never pooled with EARNED.
6. Findings doc: verdict-first per hypothesis, n and power tag (HIGH 200+ / MED 80–200 / LOW <80), edge-vs-market tables with join rates, mechanism where one exists. Failed legs get the same prominence as passes.
7. Commit states file + script + findings. **Nothing ships to code regardless of outcome.** Stop-and-report on any ambiguity rather than improvising a convention.
