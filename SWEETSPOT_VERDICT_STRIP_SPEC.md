# SWEETSPOT VERDICT STRIP — Always-On Gate Synthesis, Trap Flags & Wording Fix

**Date:** 2026-07-12 · **Status:** PROPOSED — awaiting PM decisions D-1..D-6 + build go-ahead
**Baseline:** `f015c2b` · **Motivating incidents (same night):** (1) IND@LV — no alert fired and
no on-screen explanation of why; Manny bet the tested-and-killed structural-underdog shape at
+380 (−$200, graded C). (2) The scoring-comp fade card rendered "STRUCTURAL" (about IND's
scoring mix) directly above a lead-attribution card rendering "VOLATILE" (about the margin) —
one word, two meanings, colliding on screen.

## 1. Problem

The system's silence carries information ("no gates aligned") but the dashboard doesn't say it.
In the moment, Manny must hold gap thresholds, collapse gates, fade cells, band windows, and the
kill-list in his head. The dashboard's fade card (`divergenceRead`, wnba-bdl.html ~3644) is also
a **client-side parallel implementation** of fade logic with independently coded thresholds —
it can disagree with the server gates that actually fire alerts (aliasMap-class drift risk).

## 2. What ships

One **VERDICT box** at the top of the SCORING COMP section (Manny's placement call — it's where
eFG, structural/variance split, and rate trends already live). It **replaces** the
`divergenceRead` fade card (D-1) and absorbs both old cards as labeled evidence lines. The
verdict itself is **server-authoritative**: rendered from the latest snapshot's ss_ gate fields,
never recomputed client-side. Client keeps its real-time PBP scoring-comp bars; the two absorbed
evidence lines are relabeled so "structural" can never again be read ambiguously (D-2).

### Box anatomy (top → bottom)
1. **VERDICT line** — colored headline + one plain-English sentence (states in §3)
2. **TRAP line** (only when a trap matches) — ⚠ + kill-doc citation (catalog in §4)
3. **Evidence lines** (always, from client PBP comp — relabeled):
   - `LEADER'S ENGINE: {STRUCTURAL|VARIANCE|MIXED}` — the leader's own scoring mix
   - `THE LEAD: {STRUCTURAL|VARIANCE-CARRIED|MIXED|EVEN}` — the margin's composition
     (e.g., "LV +6 structure, IND +11 variance")
4. **as-of stamp** — "server read as of Q3 3:26" (verdict data is poll-cadence, ~60-90s behind
   the live PBP bars; the stamp makes that visible instead of confusing)

## 3. Verdict states (server ss_ fields; priority top-down, first match wins) — copy verbatim

- **V0 GATES CLOSED** (period <2): `Gates open in Q2 — no verdict yet.` (neutral gray)
- **V1 BET SIGNAL** (sweetspot_alerts row, subtype EFG_FADE/EFG_FADE_SOFT): `SWEET SPOT {A|B}
  LIVE — see the push for price and size.` (green/amber)
- **V2 REVIEW** (WATCHLIST row exists, game not V1): `REVIEW — {TRAILER} is the much better team
  ({gap} quality gap{, above your .20 bar|, below your .20 bar}) trailing by {N}. Bet gates
  haven't aligned; your read decides.` (blue)
- **V3 COLLECTING** (GAP_BASE shape live this poll, no V1/V2 push): `GAP SPOT, UNPROVEN — base
  gates pass but the fade reads don't. The ledger is collecting this shape ({n}/30 resolved so
  far). Not a validated bet.` (gray-blue)
- **V4 NO SPOT — THIN GAP** (gap null or <.15): `NO SPOT — quality gap ({gap|no standings gap})
  is below the review line (.15). Anything taken here is the speculative stream — size like it.`
  (gray)
- **V5 NO SPOT — LEADER TOO GOOD** (gap ≥.15, collapse NO_EDGE): `NO SPOT — {LEADER} wins too
  much to be a fade target, whatever the heat says. Anything taken here is the speculative
  stream — size like it.` (gray)
- **V6 OUT OF BAND** (deficit ≥10 pre-Q4): `OUT OF BAND — {TRAILER} down {N}: leads this size
  are banked (regression erases single digits, not {N}). No chasing from here.` (red)
- **V7 Q4 DEEP** (Q4, deficit 10-15): `Q4 DEEP — unproven ledger shape, collecting ({n}/30). Not
  a validated bet.` · (Q4, deficit >15): `DEAD — out of range at this stage.` (gray/red)
- **V8 FINAL** — verdict freezes with outcome appended: `Final {score} — {trailer} {completed
  the comeback | did not come back}.`
- **Garbage line** (±50K ML) at any state → append `Line dead.`

## 4. Trap-flag catalog (overlay on V2–V5; research corpus, citations verbatim)

- **T1 STRUCTURAL-UNDERDOG** (lead classed STRUCTURAL or trailer wins structural delta, AND gap
  <.20): `⚠ Trailer winning the structural battle below the gap bar is a tested-and-killed shape
  (Jun 21, 1-for-7 — the market prices visible structure).`
- **T4 STRUCTURAL LEADER, REAL GAP** (lead classed STRUCTURAL, gap ≥.20): `⚠ Structural leader =
  the pass shape (POR@CHI rule). Conscious override territory only — probe size (CHI@DAL
  convention).`
- **T5 HEAT WITHOUT GAP** (leader band red/orange, gap <.15): `⚠ Hot leader without a quality
  gap — the "hot = mirage" family is 3x killed (NBA n=1,200; player-level; team-level). Heat
  only matters ON TOP of a gap.`
One trap line max; priority T1 > T4 > T5.

## 5. Data flow (server-authoritative, isolated)

- **New db-api action `get_ss_state`** (`game_id`, `league`): latest snapshot's ss_* fields +
  period/clock + margin + which sweetspot_alerts subtypes exist for the game. One isolated
  query + one indexed EXISTS set — never added to existing SELECTs (house rule). ~20 lines.
- Client fetches on card select + every 60s for the visible card only (D-3). `ss_ledger_summary`
  fetched once per session for the {n}/30 counters (cached).
- **Pure composer `ssVerdictCompose(state)`** in wnba-bdl.html returns {headline, sentence,
  trap, color} — extraction-testable like ssComposePush; copy pinned by fixtures.
- Stale guard: snapshot older than 3 min during a live game → verdict dims to `updating…` with
  the last as-of stamp.

## 6. What this does NOT touch

Poll hot path: nothing. Alert types/thresholds: nothing. Server classifiers: nothing. NBA
dashboard: out of scope (D-6). The client's PBP scoring-comp computation stays (it feeds the
evidence lines + bars); only `divergenceRead`'s rendered card retires.

## 7. Tests

- `research/ss_verdict_fixtures.mjs`: extract `ssVerdictCompose` from the HTML script block;
  fixtures for every V-state + all 3 traps + priority collisions (V1 beats V2; T1 beats T4/T5) +
  the IND@LV regression case (gap .148, coll NO_EDGE, lead STRUCTURAL-favors-trailer → V4 + T1)
  + the SEA@WSH case (→ V2, no trap) + no-abbreviation sweep on all copy.
- Live validation: deploy → open dashboard on a live slate game → verify verdict matches
  `get_ss_state` → verify V8 freeze after a final.

## 8. Rollout

Spec approval → build (client ~150 lines + db-api ~20 + fixtures ~50) → deploy off-slate hours
→ live-slate observation next night → NBA parity decision later.

## 9. PM decisions

| # | Decision | Rec |
|---|---|---|
| D-1 | Retire `divergenceRead` card entirely (client fade impl absorbed by server verdict) | yes — kills the dual-implementation drift |
| D-2 | Evidence-line labels: `LEADER'S ENGINE:` / `THE LEAD:` | as written |
| D-3 | Verdict refresh: 60s, visible card only | yes |
| D-4 | Show V0 pregame/Q1 neutral state (vs hiding box) | show — silence was the original problem |
| D-5 | T4 includes the conscious-override/probe-size note | yes — codifies the CHI@DAL convention on-screen |
| D-6 | NBA dashboard parity | defer; WNBA is the active betting surface |
