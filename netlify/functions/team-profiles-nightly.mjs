// ══════════════════════════════════════════════════════════════════════════════
// team-profiles-nightly.mjs — TEAM_PROFILES_SPEC.md §4 (nightly compute) + §5 (metrics)
//
// Runs 1:30am MST (8:30am UTC) daily, after WNBA finals settle. WNBA-only v1.
//   1. DISCOVER finalized games missing from team_game_stats (BDL /games, trailing
//      4-day window — self-healing: a missed night is picked up next run)
//   2. PULL missing games via /wnba/v1/player_stats (batched, cursor-paginated),
//      aggregate player rows → team-game lines. Number()-wrapped (BDL nulls/strings).
//   3. INSERT rows (ON CONFLICT DO NOTHING). Finality = status 'post'/'final' AND
//      both teams' player_stats pts sums > 0 (BDL WNBA games endpoint returns NULL
//      scores — [FACT:prod 2026-07-11] — so the sums ARE the nonzero-score check).
//   4. RECOMPUTE all profiles for the league-season in memory, UPSERT team_profiles.
//      Full recompute is deliberate: opponent win% moves nightly, retroactively
//      re-tiering past games (best current estimate of opponent quality).
//   5. ntfy one-liner (ASCII Title — hotfix learning #2).
//
// Modes: default incremental · ?backfill=1&from=YYYY-MM-DD&to=YYYY-MM-DD ·
//        ?recompute=1 (skip ingestion) · ?dry=1 (no writes)
// Concurrency: job_locks row (PENDING-sentinel pattern, hotfix learning #11)
//   before ingestion; stale locks (>10 min) are taken over.
//
// Alias discipline (§3a): everything here is BDL-canonical (LV, NY, GS, WSH, LA,
// POR, TOR). cfg.aliasMap / SR forms NEVER enter these tables. The only alias
// translation is READ-side when matching legacy (pre-May-16) games-table rows
// for the nullable dft_game_id join key.
//
// computeProfiles() is a PURE function over row arrays, exported for the fixture
// harness (research/team_profiles_fixtures.mjs) — the ATL golden fixture runs it
// over rows filtered to date <= 2026-07-04 and must reproduce spec §2 exactly.
// ══════════════════════════════════════════════════════════════════════════════

// neon imported lazily inside handler() so the pure compute exports
// (computeProfiles, classifyArchetype) are importable dependency-free by
// research/team_profiles_fixtures.mjs.

function log(msg) { console.log(`[team-profiles] ${msg}`); }
const N = (x) => Number(x) || 0; // BDL returns null for zero values + stats-as-strings

// ── Constants (spec §5) ──────────────────────────────────────────────────────
export const TIER_CUTOFF = 0.600;          // opponent win% for "top" tier — STRICT > (settled D1; fixture-adjudicated Jul 14)
export const TIER_MIN_GAMES = 8;           // tiers INSUFFICIENT until every team has ≥8 finals
export const FORM_TAG_PP = 4.0;            // COLD/HOT at ±4.0pp eFG delta
export const ARCH = {                      // archetype lever thresholds (pp / per-game)
  EFG_EDGE: 1.5, EFG_STRONG: 2.0, EFG_DEFICIT: -2.0, EFG_SOFT: -1.0,
  TO_EDGE: 2.0, TO_BULLY: 2.5, FTA_EDGE: 3.0, OREB_EDGE: 1.5,
};

// ── Archetype (spec §5, mechanical v1 heuristic) ─────────────────────────────
// Label is push compression; prompts always get the underlying numbers.
export function classifyArchetype(efgDiffPP, toMargin) {
  const e = efgDiffPP, t = toMargin;
  if (e >= ARCH.EFG_EDGE && t >= ARCH.TO_EDGE) return 'DUAL_EDGE';
  if (e >= ARCH.EFG_STRONG && t < ARCH.TO_EDGE) return 'SHOTMAKER';
  if (t >= ARCH.TO_BULLY && e <= ARCH.EFG_SOFT) return 'POSSESSION_BULLY';   // ATL
  if (t >= ARCH.TO_EDGE && e > ARCH.EFG_SOFT && e < ARCH.EFG_EDGE) return 'POSSESSION_LEAN';
  if (e <= ARCH.EFG_DEFICIT && t < ARCH.TO_EDGE) return 'SHOT_DEFICIT';
  return 'FLAT';
}

// ── Pure compute core (spec §5) ──────────────────────────────────────────────
// rows: team_game_stats rows for ONE league-season (any subset — the fixture
// passes an as-of-date filter). Returns { [team_alias]: { w, l, archetype, profile } }.
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const r1 = (x) => x == null ? null : Math.round(x * 10) / 10;
const r3 = (x) => x == null ? null : Math.round(x * 1000) / 1000;

// ── Killer/Elite layer (KILLER_FLAG_SPEC §1+§8) ──────────────────────────────
// Same purity contract as computeProfiles: rows for ONE league-season, any as-of
// subset. `elite` = HYSTERESIS state machine — ENTER wp≥.600 at ≥15 GP, DEMOTE on
// crossing <.550, RE-ENTER at ≥.600 (PM decision Jul 16; validated identical cells).
// killer/scalps/tiers_elite all use EVALUATION-DATE membership (one elite set per
// recompute) — validated 66%/n=59 vs 50%/n=62 on the 2024-25 pool; causal at fire
// time. Side effect (accepted): scalp counts can move when OPPONENTS enter/demote.
// Merged into profile JSONB by the handler; computeProfiles untouched (ATL golden
// cannot break). Goldens (research/team_profiles_fixtures.mjs layer 3): as-of
// 2026-07-15 killers = POR(5) LA(3) CHI(2) SEA(2) PHX(2); WSH excluded (.545).
export function computeKillerFields(rows) {
  const byTeam = {};
  for (const r of rows) (byTeam[r.team_alias] = byTeam[r.team_alias] || []).push(r);
  const elite = {};
  for (const [team, gamesRaw] of Object.entries(byTeam)) {
    const games = [...gamesRaw].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let w = 0, n = 0, el = false;
    for (const g of games) {
      if (N(g.pts) > N(g.opp_pts)) w++;
      n++;
      const wp = w / n;
      if (!el && n >= 15 && wp >= 0.600) el = true;
      else if (el && wp < 0.550) el = false;
    }
    elite[team] = el;
  }
  const out = {};
  for (const [team, games] of Object.entries(byTeam)) {
    const w = games.filter((g) => N(g.pts) > N(g.opp_pts)).length;
    const wp = games.length ? w / games.length : 0;
    const te = games.filter((g) => elite[g.opp_alias]);
    const re = games.filter((g) => !elite[g.opp_alias]);
    const scalps = te.filter((g) => N(g.pts) > N(g.opp_pts)).length;
    const wl = (a) => ({ w: a.filter((g) => N(g.pts) > N(g.opp_pts)).length,
                         l: a.filter((g) => N(g.pts) <= N(g.opp_pts)).length });
    const efgd = (a) => a.length
      ? r1((aggEfg(a, 'fgm', 'fga', 'fg3m') - aggEfg(a, 'opp_fgm', 'opp_fga', 'opp_fg3m')) * 100)
      : null;
    out[team] = {
      elite: elite[team],
      killer: { flag: wp < 0.450 && scalps >= 2, scalps },
      tiers_elite: { top: { ...wl(te), efg_diff: efgd(te) }, rest: { ...wl(re), efg_diff: efgd(re) } },
    };
  }
  return out;
}

// ── Rotation layer (AVAILABILITY_SPEC §1 + §5a) ──────────────────────────────
// Byte-for-byte port of research/2026-08-11_availability_gap.py `availability()`
// rotation construction (the primary spec). MUST NOT drift — the whole value of
// the 2026 arm is comparability with the validated 2024/25 arm.
//   window   = trailing 10 TEAM games (date < asof when given), min 5 required
//   mpg      = total minutes over window / TEAM games in window (absence = 0)
//   rotation = mpg >= 8.0; top5/top8 = highest mpg within rotation
// Also stored, never displayed: mpg_played (minutes / games actually appeared) —
// best-behaved sensitivity variant, preserved so season-close re-runs need no re-ingest.
export const ROT_WINDOW = 10;
export const ROT_MPG_FLOOR = 8.0;
export const ROT_MIN_GAMES = 5;

// Study mins(): null/'' -> 0; "MM:SS" -> MM + SS/60; else float or 0.
export function parseMin(v) {
  if (v == null || v === '') return 0;
  const s = String(v);
  if (s.includes(':')) {
    const p = s.split(':');
    return (Number(p[0]) || 0) + (Number(p[1]) || 0) / 60;
  }
  const f = Number(s);
  return Number.isFinite(f) ? f : 0;
}

// rows: team_game_players rows for ONE team-season (any subset), each
// { game_id, date, player_id, player_name, min }. asof (optional 'YYYY-MM-DD'):
// STRICT date < asof, matching the study's `d < date` — omitted = all rows (nightly).
// Returns rotation JSONB (spec §3) or null (insufficient window / empty rotation).
// Neon returns DATE columns as JS Date objects — String() yields locale text
// ("Wed May 27...") which made window ordering ALPHABETICAL (caught Aug 11 on the
// first prod recompute). Normalize to ISO before any comparison.
const normDate = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

export function computeRotation(rows, asof) {
  const byGame = {}; // gid -> { date, players: { pid: { min, name } } }
  for (const r of rows) {
    const d = normDate(r.date);
    if (asof && !(d < asof)) continue;
    const g = (byGame[r.game_id] = byGame[r.game_id] || { date: d, players: {} });
    g.players[r.player_id] = { min: parseMin(r.min), name: r.player_name };
  }
  const sched = Object.entries(byGame)
    .map(([gid, g]) => ({ gid, date: g.date }))
    .sort((a, b) => a.date === b.date ? String(a.gid).localeCompare(String(b.gid)) : a.date.localeCompare(b.date));
  const prior = sched.slice(-ROT_WINDOW);
  if (prior.length < ROT_MIN_GAMES) return null;
  const tot = {}, appear = {}, nameOf = {};
  for (const { gid } of prior) {
    for (const [pid, p] of Object.entries(byGame[gid].players)) {
      tot[pid] = (tot[pid] || 0) + p.min;
      if (p.min > 0) appear[pid] = (appear[pid] || 0) + 1;
      nameOf[pid] = p.name || nameOf[pid];
    }
  }
  const denom = prior.length;
  const players = [];
  for (const pid of Object.keys(tot)) {
    const mpg = tot[pid] / denom;                          // absences count as 0
    if (mpg >= ROT_MPG_FLOOR) {
      players.push({
        pid: Number(pid), name: nameOf[pid] || '?',
        mpg: r1(mpg),
        mpg_played: r1(appear[pid] ? tot[pid] / appear[pid] : 0),
        _raw: mpg,
      });
    }
  }
  if (players.length === 0) return null;
  players.sort((a, b) => b._raw - a._raw);
  players.forEach((p, i) => { p.rank = i + 1; delete p._raw; });
  return {
    asof: prior[prior.length - 1].date,   // newest game date in window (staleness-honest)
    window: ROT_WINDOW, floor: ROT_MPG_FLOOR,
    players,
    top5_pids: players.slice(0, 5).map((p) => p.pid),
    top8_pids: players.slice(0, 8).map((p) => p.pid),
  };
}

export function computeProfiles(rows) {
  const byTeam = {};
  for (const r of rows) {
    (byTeam[r.team_alias] = byTeam[r.team_alias] || []).push(r);
  }
  // Opponent-quality tiers use CURRENT overall win% from the same row set
  const winPct = {};
  for (const [team, games] of Object.entries(byTeam)) {
    const w = games.filter((g) => N(g.pts) > N(g.opp_pts)).length;
    winPct[team] = games.length ? w / games.length : 0;
  }
  const minGames = Math.min(...Object.values(byTeam).map((g) => g.length));
  const tiersInsufficient = !(minGames >= TIER_MIN_GAMES);

  const out = {};
  for (const [team, gamesRaw] of Object.entries(byTeam)) {
    const games = [...gamesRaw].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const g = games.length;
    const won = (x) => N(x.pts) > N(x.opp_pts);
    const w = games.filter(won).length, l = g - w;

    // identity — per-game means for counts; eFG is ATTEMPT-WEIGHTED AGGREGATE over the
    // slice (fixture-adjudicated Jul 14: the Jul 4 session numbers are aggregates —
    // per-game mean gave −5.43 where the golden is −5.20 exact). aggEfg falls back to
    // per-row efg mean if fgm/fga primitives are missing (pre-amendment rows).
    const efg = aggEfg(games, 'fgm', 'fga', 'fg3m');
    const oppEfg = aggEfg(games, 'opp_fgm', 'opp_fga', 'opp_fg3m');
    const toPg = mean(games.map((x) => N(x.to_ct)));
    const oppToPg = mean(games.map((x) => N(x.opp_to_ct)));
    const identity = {
      g,
      ppg: r1(mean(games.map((x) => N(x.pts)))),
      opp_ppg: r1(mean(games.map((x) => N(x.opp_pts)))),
      margin_pg: r1(mean(games.map((x) => N(x.pts) - N(x.opp_pts)))),
      efg: r3(efg), opp_efg: r3(oppEfg),
      efg_diff: r1((efg - oppEfg) * 100),
      to_pg: r1(toPg), opp_to_pg: r1(oppToPg),
      to_margin: r1(oppToPg - toPg),           // + = forces more than it commits
      fta_diff: r1(mean(games.map((x) => N(x.fta) - N(x.opp_fta)))),
      oreb_diff: r1(mean(games.map((x) => N(x.oreb) - N(x.opp_oreb)))),
      fg3_pct: r3(sumRatio(games, 'fg3m', 'fg3a')),
      opp_fg3_pct: r3(sumRatio(games, 'opp_fg3m', 'opp_fg3a')),
    };

    // tiers — split by opponent's current overall win%
    const tierSlice = (subset) => ({
      n: subset.length,
      w: subset.filter(won).length,
      l: subset.length - subset.filter(won).length,
      efg_diff: subset.length ? r1((aggEfg(subset, 'fgm', 'fga', 'fg3m') - aggEfg(subset, 'opp_fgm', 'opp_fga', 'opp_fg3m')) * 100) : null,
      to_margin: subset.length ? r1(mean(subset.map((x) => N(x.opp_to_ct))) - mean(subset.map((x) => N(x.to_ct)))) : null,
      fta_diff: subset.length ? r1(mean(subset.map((x) => N(x.fta) - N(x.opp_fta)))) : null,
      ppg: subset.length ? r1(mean(subset.map((x) => N(x.pts)))) : null,
      opp_ppg: subset.length ? r1(mean(subset.map((x) => N(x.opp_pts)))) : null,
    });
    const topGames = games.filter((x) => (winPct[x.opp_alias] ?? 0) > TIER_CUTOFF);   // STRICT > (fixture-adjudicated: DAL at exactly .600 is REST)
    const restGames = games.filter((x) => (winPct[x.opp_alias] ?? 0) <= TIER_CUTOFF);
    const tiers = {
      cutoff: TIER_CUTOFF,
      insufficient: tiersInsufficient,
      top: tierSlice(topGames),
      rest: tierSlice(restGames),
    };

    // form — L5/L10 deltas vs season-EXCLUDING-window (spec §5)
    const formSlice = (k) => {
      if (g < k + 1) return null;              // need at least one baseline game
      const win = games.slice(-k);
      const base = games.slice(0, g - k);
      const d = (arr, f) => mean(arr.map(f));
      const ownDelta = (aggEfg(win, 'fgm', 'fga', 'fg3m') - aggEfg(base, 'fgm', 'fga', 'fg3m')) * 100;
      const oppDelta = (aggEfg(win, 'opp_fgm', 'opp_fga', 'opp_fg3m') - aggEfg(base, 'opp_fgm', 'opp_fga', 'opp_fg3m')) * 100;
      return {
        w: win.filter(won).length,
        l: k - win.filter(won).length,
        own_efg_delta: r1(ownDelta),
        opp_efg_delta: r1(oppDelta),
        margin_delta: r1(d(win, (x) => N(x.pts) - N(x.opp_pts)) - d(base, (x) => N(x.pts) - N(x.opp_pts))),
        own_tag: ownDelta <= -FORM_TAG_PP ? 'COLD' : ownDelta >= FORM_TAG_PP ? 'HOT' : null,
        opp_tag: oppDelta >= FORM_TAG_PP ? 'OPPONENTS_HOT' : oppDelta <= -FORM_TAG_PP ? 'OPPONENTS_COLD' : null,
      };
    };
    const form = { l5: formSlice(5), l10: formSlice(10) };

    // h2h — this season, per opponent (settled D5)
    const h2h = {};
    for (const x of games) {
      const o = x.opp_alias || '?';
      if (!h2h[o]) h2h[o] = { w: 0, l: 0, margins: [] };
      h2h[o][won(x) ? 'w' : 'l']++;
      h2h[o].margins.push(N(x.pts) - N(x.opp_pts));
    }
    for (const o of Object.keys(h2h)) {
      h2h[o] = { w: h2h[o].w, l: h2h[o].l, avg_margin: r1(mean(h2h[o].margins)) };
    }

    // schedule — rest/B2B computed at CONSUMPTION time, not stored
    const last = games[games.length - 1];
    let roadStreak = 0;
    for (let i = games.length - 1; i >= 0 && games[i].is_home === false; i--) roadStreak++;
    const schedule = { last_game_date: last ? last.date : null, road_streak: roadStreak };

    out[team] = {
      w, l,
      archetype: classifyArchetype(identity.efg_diff, identity.to_margin),
      profile: { identity, tiers, form, h2h, schedule },
    };
  }
  return out;
}

function sumRatio(games, mKey, aKey) {
  let m = 0, a = 0;
  for (const g of games) { m += N(g[mKey]); a += N(g[aKey]); }
  return a > 0 ? m / a : null;
}

// Attempt-weighted aggregate eFG over a slice: (Σfgm + 0.5·Σfg3m) / Σfga.
// Falls back to per-row efg mean when fgm/fga primitives are absent.
function aggEfg(games, fgmKey, fgaKey, fg3mKey) {
  let fgm = 0, fga = 0, fg3m = 0, haveAll = true;
  for (const g of games) {
    if (g[fgmKey] == null || g[fgaKey] == null) { haveAll = false; break; }
    fgm += N(g[fgmKey]); fga += N(g[fgaKey]); fg3m += N(g[fg3mKey]);
  }
  if (haveAll && fga > 0) return (fgm + 0.5 * fg3m) / fga;
  const efgKey = fgmKey.startsWith('opp_') ? 'opp_efg' : 'efg';
  const vals = games.map((x) => N(x[efgKey]));
  return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null;
}

// ── BDL ingestion (spec §4 steps 1-3) ────────────────────────────────────────
const BDL = 'https://api.balldontlie.io';
function bdlHeaders() { return { Authorization: process.env.BDL_API_KEY }; }

// AZ slate date from BDL tip timestamp (UTC-7, no DST) — matches games.date convention,
// which makes the dft_game_id match a single-date lookup. Late-ET games that land on the
// next UTC day (BDL date-boundary quirk) resolve correctly under the shift.
function slateDateFromBdl(dateVal) {
  const s = String(dateVal || '');
  if (!s.includes('T')) return s.slice(0, 10);
  const t = new Date(new Date(s).getTime() - 7 * 60 * 60 * 1000);
  return t.toISOString().slice(0, 10);
}

function* dateRange(from, to) {
  const d = new Date(from + 'T12:00:00Z'), end = new Date(to + 'T12:00:00Z');
  while (d <= end) { yield d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + 1); }
}

// Canonical BDL roster aliases (15 teams as of 2026). All-Star/exhibition sides
// (WNBASTARS/USA 2024, CLA/COL 2025 — Team Clark/Team Collier) arrive from BDL as
// status='post' games; one 1-game phantom alias drops minGames to 1 and flips
// tiers.insufficient=true on EVERY live profile, silently suppressing tier splits
// in composeTeamContext. Failure mode is deliberate: a future expansion alias
// missing here is EXCLUDED (filtered, data preserved) — never deleted.
export const CANONICAL_ALIASES = new Set(['ATL','CHI','CON','DAL','GS','IND','LA','LV','MIN','NY','PHX','POR','SEA','TOR','WSH']);

async function discoverFinalizedGames(dates) {
  // BDL /wnba/v1/games?dates[]=… — status 'post'/'Final' marks finalized; scores are NULL
  const found = {};
  for (let i = 0; i < dates.length; i += 5) {
    const qs = dates.slice(i, i + 5).map((d) => `dates[]=${d}`).join('&') + '&per_page=100';
    const r = await fetch(`${BDL}/wnba/v1/games?${qs}`, { headers: bdlHeaders() });
    if (!r.ok) { log(`games fetch ${r.status}`); continue; }
    const j = await r.json();
    for (const g of j.data || []) {
      if (!/post|final/i.test(String(g.status))) continue;
      const home = g.home_team?.abbreviation, away = g.visitor_team?.abbreviation;
      if (!CANONICAL_ALIASES.has(home) || !CANONICAL_ALIASES.has(away)) {
        log(`skip non-canonical ${away}@${home} (bdl ${g.id})`);   // All-Star / exhibition guard
        continue;
      }
      found[g.id] = {
        bdlId: g.id,
        season: N(g.season),
        date: slateDateFromBdl(g.date),
        home,
        away,
      };
    }
  }
  return found;
}

async function pullTeamGameLines(gameMeta) {
  // Batched player_stats, cursor-paginated, chunked to keep URLs and page counts sane.
  // Proven Jul 4: 21 games → 502 rows over ~6 pages.
  const ids = Object.keys(gameMeta);
  const agg = {}; // bdlId -> { ABBR: { pts,fgm,fga,fg3m,fg3a,fta,to,oreb } }
  const perPlayer = {}; // bdlId -> [ { team, pid, name, min, pts } ]  (AVAILABILITY_SPEC §5a — capture on the way past)
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    let cursor = null, pages = 0;
    do {
      const qs = chunk.map((x) => `game_ids[]=${x}`).join('&') + '&per_page=100' + (cursor ? `&cursor=${cursor}` : '');
      const r = await fetch(`${BDL}/wnba/v1/player_stats?${qs}`, { headers: bdlHeaders() });
      if (!r.ok) { log(`player_stats ${r.status} (chunk ${i / 10})`); break; }
      const j = await r.json();
      for (const ps of j.data || []) {
        const gid = ps.game?.id, team = ps.team?.abbreviation;
        if (gid == null || !team) continue;
        const t = ((agg[gid] = agg[gid] || {})[team] = agg[gid][team] || { pts: 0, fgm: 0, fga: 0, fg3m: 0, fg3a: 0, fta: 0, to: 0, oreb: 0 });
        t.pts += N(ps.pts); t.fgm += N(ps.fgm); t.fga += N(ps.fga);
        t.fg3m += N(ps.fg3m); t.fg3a += N(ps.fg3a); t.fta += N(ps.fta);
        t.to += N(ps.turnover); t.oreb += N(ps.oreb);
        const pid = ps.player?.id;
        if (pid != null) {
          (perPlayer[gid] = perPlayer[gid] || []).push({
            team, pid: N(pid),
            name: `${ps.player?.first_name || ''} ${ps.player?.last_name || ''}`.trim() || '?',
            min: parseMin(ps.min), pts: N(ps.pts),
          });
        }
      }
      cursor = j.meta?.next_cursor || null;
      pages++;
    } while (cursor && pages < 12);
  }

  // Assemble two rows per game (one per team side) + player rows for the same games
  const rows = [];
  const playerRows = []; // team_game_players rows — only for games passing the finality guard
  for (const [gid, meta] of Object.entries(gameMeta)) {
    const t = agg[gid];
    if (!t || !t[meta.home] || !t[meta.away]) continue;
    const H = t[meta.home], A = t[meta.away];
    if (!(H.pts > 0 && A.pts > 0)) continue;   // finality guard — the nonzero-score check
    for (const pp of perPlayer[gid] || []) {
      playerRows.push({
        game_id: String(gid), league: 'wnba', season: meta.season, date: meta.date,
        team_alias: pp.team, player_id: pp.pid, player_name: pp.name,
        min: pp.min, pts: pp.pts,
      });
    }
    const efg = (x) => (x.fga > 0 ? (x.fgm + 0.5 * x.fg3m) / x.fga : null);
    const poss = (x) => x.fga - x.oreb + x.to + 0.44 * x.fta;
    const mk = (self, opp, alias, oppAlias, isHome) => ({
      game_id: String(gid), team_alias: alias, league: 'wnba', season: meta.season,
      date: meta.date, opp_alias: oppAlias, is_home: isHome,
      pts: self.pts, opp_pts: opp.pts,
      efg: efg(self), opp_efg: efg(opp),
      to_ct: self.to, opp_to_ct: opp.to,
      fta: self.fta, opp_fta: opp.fta,
      oreb: self.oreb, opp_oreb: opp.oreb,
      fg3m: self.fg3m, fg3a: self.fg3a, opp_fg3m: opp.fg3m, opp_fg3a: opp.fg3a,
      fgm: self.fgm, fga: self.fga, opp_fgm: opp.fgm, opp_fga: opp.fga,
      poss: poss(self),
    });
    rows.push(mk(H, A, meta.home, meta.away, true), mk(A, H, meta.away, meta.home, false));
  }
  return { rows, playerRows };
}

// Legacy SR→BDL alias map — READ-side only, for matching pre-May-16 games-table rows.
const WNBA_SR2BDL = { LVA: 'LV', NYL: 'NY', GSV: 'GS', WAS: 'WSH', LAS: 'LA', PDX: 'POR', TOY: 'TOR' };
const toBdl = (a) => WNBA_SR2BDL[a] || a;

async function matchDftGameIds(sql, rows) {
  // Nullable join key to internal games.id via date + alias match (spec §3a)
  const dates = [...new Set(rows.map((r) => r.date))];
  if (dates.length === 0) return;
  let dftGames = [];
  try {
    dftGames = await sql`SELECT id, date, home_alias, away_alias FROM games WHERE league = ${'wnba'} AND date = ANY(${dates})`;
  } catch (e) { log(`dft match query: ${e.message}`); return; }
  const key = (d, a, h) => `${d}|${a}@${h}`;
  const map = {};
  for (const g of dftGames) map[key(g.date, toBdl(g.away_alias), toBdl(g.home_alias))] = g.id;
  for (const r of rows) {
    const away = r.is_home ? r.opp_alias : r.team_alias;
    const home = r.is_home ? r.team_alias : r.opp_alias;
    r.dft_game_id = map[key(r.date, away, home)] || null;
  }
}

// ── Lock (hotfix learning #11) ───────────────────────────────────────────────
async function acquireLock(sql, job) {
  const ins = await sql`INSERT INTO job_locks (job, ts) VALUES (${job}, NOW()) ON CONFLICT (job) DO NOTHING RETURNING job`;
  if (ins.length > 0) return true;
  const stale = await sql`UPDATE job_locks SET ts = NOW() WHERE job = ${job} AND ts < NOW() - INTERVAL '10 minutes' RETURNING job`;
  return stale.length > 0;
}
async function releaseLock(sql, job) {
  try { await sql`DELETE FROM job_locks WHERE job = ${job}`; } catch (e) { log(`lock release: ${e.message}`); }
}

// ── ntfy (ASCII Title — hotfix learning #2) ──────────────────────────────────
async function notify(title, body) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: { Title: String(title).replace(/[^\x00-\x7F]/g, '-'), Priority: '2' },
      body: String(body),
    });
  } catch (e) { log(`ntfy failed: ${e.message}`); }
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req) {
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  const url = new URL(req.url, 'https://localhost');
  const isDry = url.searchParams.get('dry') === '1';
  const isBackfill = url.searchParams.get('backfill') === '1';
  const isRecomputeOnly = url.searchParams.get('recompute') === '1';
  const isReingest = url.searchParams.get('reingest') === '1'; // ON CONFLICT DO UPDATE — schema-amendment migrations (e.g. fgm/fga primitives Jul 14)
  const isQuiet = url.searchParams.get('quiet') === '1';       // suppress ntfy — chunked historical backfills (Jul 14, 2024-25 Honest Gap substrate)
  const league = 'wnba'; // v1 WNBA-only (spec §4)

  const todayAz = slateDateFromBdl(new Date().toISOString());
  let dates;
  if (isBackfill) {
    const from = url.searchParams.get('from'), to = url.searchParams.get('to') || todayAz;
    if (!from) return new Response(JSON.stringify({ ok: false, error: 'backfill requires from=' }), { status: 400 });
    dates = [...dateRange(from, to)];
  } else {
    // trailing 4-day window (self-healing)
    dates = [];
    for (let i = 3; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000 - 7 * 3600000);
      dates.push(d.toISOString().slice(0, 10));
    }
  }

  let ingested = 0, discovered = 0, skippedExisting = 0;
  const lockName = `team-profiles-${league}`;

  if (!isRecomputeOnly) {
    if (!isDry) {
      const got = await acquireLock(sql, lockName);
      if (!got) {
        log('lock held by concurrent invocation — bailing');
        return new Response(JSON.stringify({ ok: false, error: 'locked' }), { status: 409 });
      }
    }
    try {
      const found = await discoverFinalizedGames(dates);
      discovered = Object.keys(found).length;

      // diff against existing rows (skipped in reingest mode — everything re-pulls)
      const ids = Object.keys(found);
      if (ids.length > 0 && !isReingest) {
        // §5a self-healing diff: a game is "existing" only if it has BOTH team rows AND
        // player rows — so games ingested pre-availability get their player rows on the
        // next pass (backfill or trailing window) with team rows deduped by DO NOTHING.
        const existing = await sql`SELECT DISTINCT s.game_id FROM team_game_stats s
          WHERE s.league = ${league} AND s.game_id = ANY(${ids})
          AND EXISTS (SELECT 1 FROM team_game_players p WHERE p.game_id = s.game_id)`;
        const have = new Set(existing.map((r) => r.game_id));
        skippedExisting = have.size;
        for (const id of ids) if (have.has(String(id))) delete found[id];
      }

      if (Object.keys(found).length > 0) {
        const { rows, playerRows } = await pullTeamGameLines(found);
        await matchDftGameIds(sql, rows);
        if (!isDry) {
          // §5a player-row inserts — batched via jsonb_to_recordset (one query per 500
          // rows; individual awaits would blow the timeout on season backfills)
          for (let b = 0; b < playerRows.length; b += 500) {
            const batch = JSON.stringify(playerRows.slice(b, b + 500));
            if (isReingest) {
              await sql`INSERT INTO team_game_players
                (game_id, league, season, date, team_alias, player_id, player_name, min, pts)
                SELECT x.game_id, x.league, x.season, x.date, x.team_alias, x.player_id, x.player_name, x.min, x.pts
                FROM jsonb_to_recordset(${batch}::jsonb)
                AS x(game_id text, league text, season int, date date, team_alias text, player_id int, player_name text, min numeric, pts int)
                ON CONFLICT (game_id, player_id) DO UPDATE SET
                  date = EXCLUDED.date, team_alias = EXCLUDED.team_alias,
                  player_name = EXCLUDED.player_name, min = EXCLUDED.min, pts = EXCLUDED.pts`;
            } else {
              await sql`INSERT INTO team_game_players
                (game_id, league, season, date, team_alias, player_id, player_name, min, pts)
                SELECT x.game_id, x.league, x.season, x.date, x.team_alias, x.player_id, x.player_name, x.min, x.pts
                FROM jsonb_to_recordset(${batch}::jsonb)
                AS x(game_id text, league text, season int, date date, team_alias text, player_id int, player_name text, min numeric, pts int)
                ON CONFLICT (game_id, player_id) DO NOTHING`;
            }
          }
          if (playerRows.length > 0) log(`player rows: ${playerRows.length} inserted/deduped`);
          for (const r of rows) {
            if (isReingest) {
              await sql`INSERT INTO team_game_stats
                (game_id, team_alias, league, season, date, opp_alias, is_home,
                 pts, opp_pts, efg, opp_efg, to_ct, opp_to_ct, fta, opp_fta,
                 oreb, opp_oreb, fg3m, fg3a, opp_fg3m, opp_fg3a,
                 fgm, fga, opp_fgm, opp_fga, poss, dft_game_id)
                VALUES (${r.game_id}, ${r.team_alias}, ${r.league}, ${r.season}, ${r.date},
                 ${r.opp_alias}, ${r.is_home}, ${r.pts}, ${r.opp_pts}, ${r.efg}, ${r.opp_efg},
                 ${r.to_ct}, ${r.opp_to_ct}, ${r.fta}, ${r.opp_fta}, ${r.oreb}, ${r.opp_oreb},
                 ${r.fg3m}, ${r.fg3a}, ${r.opp_fg3m}, ${r.opp_fg3a},
                 ${r.fgm}, ${r.fga}, ${r.opp_fgm}, ${r.opp_fga}, ${r.poss}, ${r.dft_game_id})
                ON CONFLICT (game_id, team_alias) DO UPDATE SET
                  date = EXCLUDED.date, opp_alias = EXCLUDED.opp_alias, is_home = EXCLUDED.is_home,
                  pts = EXCLUDED.pts, opp_pts = EXCLUDED.opp_pts, efg = EXCLUDED.efg, opp_efg = EXCLUDED.opp_efg,
                  to_ct = EXCLUDED.to_ct, opp_to_ct = EXCLUDED.opp_to_ct, fta = EXCLUDED.fta, opp_fta = EXCLUDED.opp_fta,
                  oreb = EXCLUDED.oreb, opp_oreb = EXCLUDED.opp_oreb,
                  fg3m = EXCLUDED.fg3m, fg3a = EXCLUDED.fg3a, opp_fg3m = EXCLUDED.opp_fg3m, opp_fg3a = EXCLUDED.opp_fg3a,
                  fgm = EXCLUDED.fgm, fga = EXCLUDED.fga, opp_fgm = EXCLUDED.opp_fgm, opp_fga = EXCLUDED.opp_fga,
                  poss = EXCLUDED.poss, dft_game_id = EXCLUDED.dft_game_id`;
            } else {
              await sql`INSERT INTO team_game_stats
                (game_id, team_alias, league, season, date, opp_alias, is_home,
                 pts, opp_pts, efg, opp_efg, to_ct, opp_to_ct, fta, opp_fta,
                 oreb, opp_oreb, fg3m, fg3a, opp_fg3m, opp_fg3a,
                 fgm, fga, opp_fgm, opp_fga, poss, dft_game_id)
                VALUES (${r.game_id}, ${r.team_alias}, ${r.league}, ${r.season}, ${r.date},
                 ${r.opp_alias}, ${r.is_home}, ${r.pts}, ${r.opp_pts}, ${r.efg}, ${r.opp_efg},
                 ${r.to_ct}, ${r.opp_to_ct}, ${r.fta}, ${r.opp_fta}, ${r.oreb}, ${r.opp_oreb},
                 ${r.fg3m}, ${r.fg3a}, ${r.opp_fg3m}, ${r.opp_fg3a},
                 ${r.fgm}, ${r.fga}, ${r.opp_fgm}, ${r.opp_fga}, ${r.poss}, ${r.dft_game_id})
                ON CONFLICT (game_id, team_alias) DO NOTHING`;
            }
          }
        }
        ingested = rows.length / 2;
        log(`${isDry ? '[DRY] would ingest' : 'ingested'} ${ingested} games (${rows.length} team rows)`);
      }
    } finally {
      if (!isDry) await releaseLock(sql, lockName);
    }
  }

  // One-time opt-in cleanup of phantom-alias rows (explicit param — never automatic,
  // so a forgotten future expansion alias can only be filtered, not destroyed)
  let purged = null;
  if (url.searchParams.get('purge_noncanonical') === '1' && !isDry) {
    const canon = [...CANONICAL_ALIASES];
    const d1 = await sql`DELETE FROM team_game_stats WHERE league = ${league}
      AND (NOT (team_alias = ANY(${canon})) OR NOT (opp_alias = ANY(${canon}))) RETURNING game_id`;
    const d2 = await sql`DELETE FROM team_profiles WHERE league = ${league}
      AND NOT (team_alias = ANY(${canon})) RETURNING team_alias`;
    purged = { team_game_stats: d1.length, team_profiles: d2.map((r) => r.team_alias) };
    log(`purged ${d1.length} team_game_stats rows, ${d2.length} team_profiles rows`);
  }

  // Recompute all profiles for the league-season (spec §4 step 4)
  let teamsUpdated = 0, season = Number(url.searchParams.get('season')) || 2026;
  const allRowsRaw = await sql`SELECT * FROM team_game_stats WHERE league = ${league} AND season = ${season}`;
  // Belt-and-suspenders: recompute never sees non-canonical aliases even if rows exist
  const allRows = allRowsRaw.filter((r) => CANONICAL_ALIASES.has(r.team_alias) && CANONICAL_ALIASES.has(r.opp_alias));
  if (allRows.length > 0) {
    const profiles = computeProfiles(allRows);
    const killerFields = computeKillerFields(allRows);   // KILLER_FLAG_SPEC §1+§8
    // AVAILABILITY_SPEC §5a — rotation baselines from team_game_players. Wrapped so a
    // failure here can NEVER block the core profile upsert (availability has no authority
    // over anything, including this function's success).
    const rotations = {};
    try {
      const tgpRows = await sql`SELECT game_id, date::text AS date, team_alias, player_id, player_name, min
        FROM team_game_players WHERE league = ${league} AND season = ${season}`;
      const byTeamP = {};
      for (const r of tgpRows) {
        if (!CANONICAL_ALIASES.has(r.team_alias)) continue;
        (byTeamP[r.team_alias] = byTeamP[r.team_alias] || []).push(r);
      }
      for (const [team, trs] of Object.entries(byTeamP)) rotations[team] = computeRotation(trs);
      log(`rotation computed for ${Object.keys(rotations).length} teams`);
    } catch (e) { log(`rotation stage failed (profiles unaffected): ${e.message}`); }
    if (!isDry) {
      for (const [team, p] of Object.entries(profiles)) {
        Object.assign(p.profile, killerFields[team] || {});
        p.profile.rotation = rotations[team] || null;     // NULL-degrading (spec §4)
        await sql`INSERT INTO team_profiles (team_alias, league, season, w, l, archetype, profile, updated_at)
          VALUES (${team}, ${league}, ${season}, ${p.w}, ${p.l}, ${p.archetype}, ${JSON.stringify(p.profile)}, NOW())
          ON CONFLICT (team_alias, league, season)
          DO UPDATE SET w = EXCLUDED.w, l = EXCLUDED.l, archetype = EXCLUDED.archetype,
            profile = EXCLUDED.profile, updated_at = NOW()`;
      }
    }
    teamsUpdated = Object.keys(profiles).length;
  }

  const summary = `${league} ${teamsUpdated} teams updated, ${ingested} games ingested` +
    (isDry ? ' (dry)' : '') + (isBackfill ? ' (backfill)' : '');
  log(summary);
  if (!isDry && !isQuiet && (ingested > 0 || isBackfill)) await notify('team-profiles', summary);

  return new Response(JSON.stringify({
    ok: true, league, season, dates: [dates[0], dates[dates.length - 1]],
    discovered, skippedExisting, ingested, teamsUpdated, purged, dry: isDry,
  }));
}

// NOTE (Aug 11): Netlify Edge now 403s external HTTP calls to scheduled functions
// (platform change since the Jul 14 backfill drill). Future backfills: comment this
// export, push, run chunks, restore, push.
export const config = {
  schedule: '30 8 * * *', // 8:30am UTC = 1:30am MST (Arizona) — after WNBA finals settle
};
