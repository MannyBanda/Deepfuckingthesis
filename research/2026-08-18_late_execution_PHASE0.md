# LATE-EXECUTION — PHASE 0 (feasibility + motivating case)

**Prereg:** 492e0fd. No hypothesis tested; no per-team rankings computed.

**Feasibility 2026: PASS.** 461/472 team-games (97.7%) yield full quarter-boundary TO with a DIRECT `poss` denominator from snapshot cumulative diffs; `unforced_to`/`forced_to` split present at 100% coverage. Substrate cached (quarter TO/poss/FGA/FTA/OREB/unforced per team-game).

**Feasibility 2024–25: OPEN.** Committed arena states carry cumulative TO but no poss/oreb. One diagnostic call on `export_checkpoints` field coverage decides at Phase A start; the pre-registered minutes-based fallback denominator is the escape hatch. No code change assumed.

**Motivating case (NY) — comes back MILD, reported honestly:** NY late (Q3+Q4) TO = 17.1/100 poss vs league 16.2; NY M2 delta +0.1 (loosens trivially) vs league −0.1 (tightens trivially); unforced late 4.3 vs 3.8. NY is modestly sloppier late than league, not atrocious — row 42 was an extreme draw from a modestly-worse distribution. This lowers the Phase B prior somewhat; it does not touch Phase A's actual question (is the CROSS-TEAM spread stable), which per-team computation will answer under the prereg.

**Pre-data amendment proposals (PM decision pending):**
- **A1:** prefer the direct `poss` field as denominator on surfaces that carry it (production's own counter); formula fallback otherwise; surface's denominator declared, never mixed.
- **A2:** add `unforced_to` rate as **M3, named descriptive only** — conceptually closest to "execution," but 2026-only (no historical split), so it gets no adjudication authority; M1/M2 keep the gate.
