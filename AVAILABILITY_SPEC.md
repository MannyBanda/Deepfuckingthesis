# AVAILABILITY_SPEC.md

**Status:** PROPOSED (not built) · **Date:** 2026-08-11 · **Author:** Claude / PM Manny
**Evidence:** `research/2026-08-11_availability_gap.md` (pre-reg `04b1882`) — all four
hypotheses FAILED their bars. This spec ships **display-only context**, the
pre-registered fallback for a failed bar.

---

## §0 — AUTHORITY (read first)

Availability has **NO GATE AUTHORITY**. It MUST NOT:

- suppress, downgrade, upgrade, or delay any alert
- alter `kelly_size`, tier assignment, or any threshold
- enter agent prompts as a directive, or enter narration as a recommendation
- appear anywhere as a conversion percentage, points-of-edge, or impact estimate

It MAY: appear as **facts on a surface** (who is out, how many, what share of minutes),
and be **stamped on rows** for future study.

Rationale: top-8 headcount reached p=0.013 pooled but is carried by 2024 (−22.3pp) and is
n.s. in 2025 (−3.2pp, CI [−3.5,+9.9]); it reverses sign inside gap band .15–.30
(−19.7pp); and absent teams already carry a worse gap (mean −0.096 vs −0.028), so part of
the effect is the gap double-counted. Displaying a number would launder that instability
into false precision. **PM decision 2026-08-11: facts only, no estimated impact.**

---

## §1 — ROTATION DEFINITION CONTRACT

One definition, all surfaces — mirrors the KILLER_FLAG_SPEC §7 one-consumer contract.

```
window     = trailing 10 TEAM games (played, date < game date), min 5 required
mpg[p]     = total minutes over window / number of TEAM games in window
             (absences count as 0 — expected contribution, not per-appearance rate)
rotation   = { p : mpg[p] >= 8.0 }
top5/top8  = 5 / 8 highest mpg within rotation
share      = sum(mpg[p] for p in OUT) / 200.0     (200 = WNBA team-minutes/regulation)
```

This is byte-for-byte the definition validated in the study
(`2026-08-11_availability_gap.py`, primary spec). It MUST NOT drift — the whole value of
the 2026 arm is that it is comparable to the 2024/25 arm.

**Also stored, never displayed:** `mpg_played` (minutes ÷ games actually played). It was
the best-behaved variant in the sensitivity battery (monotone in 2025) but was not the
basis of any reported headline. Storing it costs nothing and preserves the head-to-head
without a re-ingest.

**Headline tier is top-8.** Top-5 was flat (+1.1pp); top-7 was non-monotone (20.3% at 2
out, 36.5% at 3 out). Top-8 is the least unstable of the three. Top-5 is stored and shown
as a sub-count because "how many *starters*" is the natural human question.

---

## §2 — DATA SOURCES

| Need | Source | When | Cost |
|---|---|---|---|
| Rotation baseline | `team_game_players` (new) → profile JSONB | nightly | **0 new API calls** |
| Confirmed OUT | BDL `/wnba/v1/player_injuries` | poll, TTL-cached | 1 call / 15 min |
| Observed OUT | live box already in `pctx.modelSummary` | fire-site | 0 |

**Rotation is free.** `pullTeamGameLines` (team-profiles-nightly:299) already fetches
per-player `player_stats` for every finalized game and throws the per-player rows away
after aggregating to team totals. We capture minutes on the way past.

**Injury feed verified live** (2026-08-11): 38 league-wide rows, statuses `Out` /
`Out For Season` / `Day To Day`, carries `player.id` — joins to `player_stats` player IDs
directly, **no name matching**. `dates[]` on this endpoint is a **no-op** (returns
identical current-state rows for any date) — there is no injury history, which is why the
retro study had to reconstruct absence from box scores.

---

## §3 — SCHEMA

**New table `team_game_players`** — raw per-player minutes, the 2026 arm's substrate.

```sql
CREATE TABLE IF NOT EXISTS team_game_players (
  game_id TEXT, league TEXT, season INT, date DATE,
  team_alias TEXT, player_id INT, player_name TEXT,
  min NUMERIC, pts INT,
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX IF NOT EXISTS tgp_team_date ON team_game_players (league, season, team_alias, date);
```

**`team_profiles.profile` JSONB** gains `rotation` (written only by team-profiles-nightly):

```json
"rotation": {
  "asof": "2026-08-10", "window": 10, "floor": 8.0,
  "players": [ {"pid":733,"name":"Angel Reese","mpg":31.4,"mpg_played":31.4,"rank":1}, ... ],
  "top5_pids": [...], "top8_pids": [...]
}
```

**`sweetspot_alerts`** — new columns, `ADD COLUMN IF NOT EXISTS`, then `?action=init`:

```
trailer_out_top8 INT      leader_out_top8 INT
trailer_out_top5 INT      leader_out_top5 INT
trailer_out_share NUMERIC leader_out_share NUMERIC
avail_json JSONB          -- names, mpg, rank, source per player; both teams; asof
```

All NULL-degrading. No new columns on `snapshots`, `games`, or any polling-path SELECT
(engineering rule: never widen an existing critical-path SELECT).

---

## §4 — PURE FUNCTION + THE OUT RULE

`computeAvailability(rotation, injuryRows, liveBox, period)` — pure, exported, fixtured.
Same pattern as `computeKillerFields` / `ssVerdictCompose`.

```
confirmed(p)  = p.id in injuryRows with status starting "Out"        → any period, works PREGAME
observed(p)   = p in rotation AND liveBox minutes == 0 AND period >= 3
OUT           = confirmed ∪ observed        (per-player source tag retained)
```

**Why `period >= 3` for observed.** At Q2 a healthy 8th man may legitimately have 0
minutes. The study's construction was zero minutes for a *whole* game; Q3+ is the earliest
point that approximates it. Before Q3 the count is `confirmed`-only and `avail_json.provisional = true`.

**Why both sources.** The feed catches injuries but not rest/DNP-CD/suspension; the box
catches everything but only once the game is underway. Union covers both; the source tag
keeps them separable for the season-close re-run.

Returns per team: `{out_top5, out_top8, out_share, out_share_played, players[], provisional, asof}`.
Missing rotation or missing feed → returns `null`, everything downstream NULL-degrades.

---

## §5 — PIPELINE

**5a. Nightly** (`team-profiles-nightly.mjs`) — capture minutes in `pullTeamGameLines`,
insert `team_game_players`, compute `rotation` in a new pure `computeRotation(rows)`, merge
into profile JSONB alongside `computeKillerFields`. Backfill 2026 season on first run
(one-shot `?backfill=1`, ~250 games — reuses the existing chunked pull, no new endpoint).

**5b. Poll** (`poll-live-bdl.mjs`) — `ensureInjuryCtx(sql)`, modelled exactly on
`ensureTeamCtx` (line 1406): `var` module global, 15-min TTL, **never cache empty**, keep
last-good on failed reload. One BDL call per 15 min, league-wide.

**5c. Fire-site stamp** — in the SS insert block (~line 876), beside the killer stamp:

```js
await ensureInjuryCtx(sql);
const _avT = computeAvailability(rot(ss.trailerAl), _injMap, box(ss.trailerAl), ss.period);
const _avL = computeAvailability(rot(ss.leaderAl),  _injMap, box(ss.leaderAl),  ss.period);
```

Stamped on **every** subtype including GAP_BASE and WATCHLIST — the ledger streams are the
forward sample. Wrapped in try/catch; any throw → NULL stamp, alert still fires.

**5d. Push body** — one block appended after the existing team-ctx line, same mechanism as
`ssFuelTempLines`. Omitted entirely when both teams are clean:

```
AVAILABILITY
CHI  2 of top-8 out · 19% of minutes
     Taylor 20.9 · Stevens 17.3
SEA  2 of top-8 out · 21% of minutes
     Samuelson 22.4 · Mair 18.2
```

Both sides always, never trailer-only. On CHI@SEA that symmetry is the finding: SEA was
the more depleted team.

---

## §6 — DASHBOARD (`wnba-bdl.html`)

**6a. Matchup sheet — AVAILABILITY block**, below the schedule-inflation badge. Pregame-visible
(the feed posts 1–2 days ahead, so this is live before tip). Two columns, one per team:
count, minutes share, then each OUT player with mpg and a source marker (`◆` confirmed
injury, `○` observed zero-minutes). Clean team renders "Full rotation" — never a blank.

**6b. Card chip** — `AV` chip beside the existing EK chip, amber, shown only when either
team has ≥2 of top-8 out. Tooltip lists names. Deliberately **no** conversion number in
the tooltip (contrast: the EK chip at line 1508 does quote "67% vs 53%" — EK earned that
through a passed promotion bar; availability has not).

**6c. Client mirror** — `composeClientAvailability` extracted between
`AVAIL_PURE_BEGIN/END` markers with its own fixture file, exactly as
`team_ctx_client_fixtures.mjs` mirrors `prepMatchupData` / `composeClientTeamCtx`. Server
and client must not drift on a definitional surface.

**6d. GAME_BRIEF** — availability line joins the pregame season-lens reason, so the Aug 12
(MIN@POR, CHI@GS) and Aug 13 (LA@NY, ATL@CON) briefs carry it.

**Data path:** dashboard reads `get_team_profiles` (rotation now in JSONB, already an
existing action) + a thin `bdl-data` injury proxy. No new db-api action, no new table
read, `get_ss_state` untouched.

---

## §7 — TEST PLAN

| Harness | Cases |
|---|---|
| `research/availability_fixtures.mjs` | `computeRotation` golden (CHI as-of Aug 9 → Diggins 0.0 mpg excluded, Taylor 20.9 in) + `computeAvailability`: confirmed-only, observed-only, union, Q2 provisional, null rotation, null feed, empty box |
| `research/availability_client_fixtures.mjs` | client mirror parity vs server on the same 8 inputs |
| Replay | re-stamp all 51 resolved 2026 SS rows offline; assert CHI@SEA → `t_out5=1, share=.104, l_share=.206` (matches study reconstruction exactly) |

`node -c` on every touched file. Fixture harness green before push.

---

## §8 — CASCADING IMPLICATIONS

1. **Nightly runtime** — `team_game_players` adds ~13k rows/season, ~25 per game. Insert
   is in the existing loop. Backfill is the only long run (one-shot).
2. **`SELECT * FROM team_game_stats`** (line 510) is untouched — new data is in a
   separate table, so the profile recompute's memory profile is unchanged.
3. **Poll latency** — one extra BDL call per 15 min, off the per-game path. Netlify's ~60s
   effective timeout is not threatened.
4. **Agent context** — availability enters as facts only. Prompt copy must not acquire a
   directive verb (known blindspot #1: prompt text gets less rigor than code).
5. **Post-game agent** — no change v1. The resolver already handles NULL columns.
6. **`ss_ledger_summary`** — unchanged. An availability split is deliberately NOT added:
   at n=51/season it would be a LOW-power cell inviting exactly the over-reading this
   spec is built to avoid.
7. **Alias handling** — injury feed returns BDL abbreviations; `WNBA_SR2BDL` normalization
   applies on read, same as everywhere else.
8. **Dead code** — none introduced. `ssPlayerDigest`'s `benchShare` stays permanently
   null (no lineups endpoint); this spec does not fix that and does not depend on it.

---

## §9 — ROLLOUT & THE ONE THING THIS BUYS

Single phase. Display + stamp, no gates, no promotion bar, no graduation path.

**Prod cannot settle the 2024-vs-2025 split.** Detecting 6.8pp at 80% power needs ~713
states per arm; the SS ledger produced 51 resolved rows all season. Forward accumulation
will never adjudicate it.

What can: re-running the study's reconstruction on the **2026 season at close** (~300
games → ~1,500 states) and seeing which season 2026 resembles. `team_game_players` is what
makes that a query instead of a re-ingest. That is the real deliverable of the stamp — the
push block is the deliverable of the display.

If 2026 resembles 2024, availability comes back with a pre-registered promotion bar and a
real n. If it resembles 2025, this stays a context block forever, which is a fine outcome.

---

## §10 — OUT OF SCOPE (v1)

- Mid-game exits (Leite-type reads) — the feed does not update in-game; that is a
  minutes-stall detector, a separate item
- Star-quality weighting (usage/scoring share rather than minutes) — untested hypothesis,
  needs its own pre-registration
- Any impact estimate on any surface (§0)
- Recency-weighted quality gap — the successor study, separately pre-registered
