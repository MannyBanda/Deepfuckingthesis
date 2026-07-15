# TEAM_CTX_SURFACING_SPEC — dashboard briefing block (A) + ⚡ Analyze injection (B)

**Status:** DRAFT — awaiting PM go
**Date:** 2026-07-15
**Depends on:** TEAM_PROFILES §6 (live), NARRATION_V2 (live), teamCtx cache fix `6d01d8c`

## 1. Purpose

Agents receive the TEAM CONTEXT block (verified live); Manny cannot reference it anywhere in
the product. Requirement: visible on the WNBA dashboard and woven into on-demand analysis.
Mechanical SS push bodies stay jargon-free (PM decision Jul 14) — no change there.

## 2. Part A — dashboard BRIEFING block (wnba-bdl.html only)

**Placement:** collapsible section on the WNBA card, directly under the verdict strip.
Header: `BRIEFING` + age chip (e.g. `pregame · 2h ago`). Collapsed by default on mobile.

**Data:** existing `db-api?action=get_sweetspot_alerts&league=wnba&limit=50` → client-side
filter by `game_id`. Render `narration_text` of: (1) the `GAME_BRIEF` row (D-9b seed or
on-demand), (2) the newest fired-alert narration if present (A/B tier), newest first, max 2
entries. No new db-api action required. *(Optional later: `game_id` param on the action to
trim payload — not blocking.)*

**Refresh:** piggyback the existing 60s SS-state timer; also fetch once on card open.
**Degradation:** no rows → single muted line `No brief yet`. Fetch error → hide section
(never block card render).

**Size/risk:** ~70 lines in wnba-bdl.html. Zero poll risk, zero schema change.

## 3. Part B — ⚡ Analyze context injection (client-composed)

**Constraint (verified Jul 15):** analyze.js has NO DB access — server-side SELECT is not an
option without new plumbing. Injection is therefore client-composed and payload-carried.

**Client (wnba-bdl.html):** fetch `get_team_profiles&league=wnba&season=2026` once per
15 min (module cache, mirrors server TTL). Compose a compact block for the two aliases —
same field set and conventions as the server block: `W-L ARCHETYPE — eFG diff, TO margin
(+ = forces more than commits), FTA, OREB | vs top(>.600) W-L (eFG), vs rest W-L | L5 W-L +
eFG deltas + tags | H2H`. Include the small-n framing header. Pass as `payload.teamCtx`
(string) in the analyze request.

**Server (analyze.js):** ~8 lines — if `payload.teamCtx` is a string, length-cap at 1,200
chars and insert verbatim above the GROUND TRUTH section of the user prompt. Absent/invalid →
prompt unchanged (silent degradation, same convention as server-side).

**Drift note (accepted):** client block is an independent implementation of the same
conventions, not byte-identical to the server block. Anti-drift = shared fixture (below).

## 4. Cascading implications

- Prompt length +~450 chars on ⚡ Analyze — negligible vs 20K+ prompts.
- No state machines, alerts, learning agent, or poll paths touched.
- Subscriber UX: one new collapsible block; verdict strip untouched.
- Fable 5 on analyze.js (b53a3c5) already folds context tags well (smoke-test finding:
  Fable used the OPPONENTS_HOT tag unprompted).

## 5. Test plan (Claude owns)

- New `research/team_ctx_client_fixtures.mjs`: full block, missing team row, empty profiles,
  TO-margin convention present, length cap. Mirror server harness style.
- Part A manual acceptance: brief visible on card for a game with a GAME_BRIEF row; `No brief
  yet` on a game without; collapsed default on mobile.
- Part B acceptance: ⚡ Analyze on a live game references records/form/H2H appropriately.

## 6. Build order & estimate

A first (independent, pure UI, ~70 lines) → B (reuses A's profile cache; ~45 lines html +
~8 lines analyze.js + fixture file). Both are slate-safe deploys (no poll function changes;
analyze.js redeploy is instant-cutover and user-initiated only).

## 7. PM amendments (Jul 15) + revised phasing — SHIPPED THROUGH PHASE 1

- **Triggers:** persistent micro-strip (always visible, pregame through final) + verdict strip
  tap. NO team-name/logo trigger. Verdict strip copy untouched — tap target only.
- **Rank → record:** score-row `team-rank` span now renders W-L from the profile store
  (standings confRank removed from display; standingsCache fetch retained, now a dead-code
  candidate for cleanup).
- **Phase 1 (SHIPPED b8d91f3):** client profile store (15-min TTL, never-cache-empty),
  micro-strip, Matchup Sheet (records, archetype + inflation badge ±.10 with small-n
  fallback, identity levers w/ TO-margin convention in footer, tier splits, L5 + tags,
  cross-referenced H2H w/ perspective label, staleness age), verdict-strip tap, rank→record,
  tc() direct-first fix. Fixtures: research/matchup_sheet_fixtures.mjs (marker-extracted
  from html, 18/18).
- **Phase 2 (next):** BRIEFING block (§2) + ⚡ Analyze injection (§3) — both consume the
  Phase 1 profile store; §3's fetch section superseded by the shared store.
- **Phase 3 (optional, PM call):** archetype/record chips on the pregame slate list.
- **Registered forward levers (vs-Rest / inflation deltas):** inflation badge ships now as
  a *descriptive* label; the registered small-gap hypothesis remains under OOS validation
  (research/2026-07-14_forward_eval_smallgap.py) and gets no predictive framing in UI until
  it passes.
