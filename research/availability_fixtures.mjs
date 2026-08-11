// ══════════════════════════════════════════════════════════════════════════════
// availability_fixtures.mjs — AVAILABILITY_SPEC §7 harness, §5a slice
// Covers parseMin + computeRotation. computeAvailability cases join this file
// when §5b/5c ship. Run: node research/availability_fixtures.mjs
//
// Golden layer 2 (real data): research/fixtures_rotation_chi.json — CHI rows
// as-of 2026-08-09 extracted from prod team_game_players post-backfill. Asserts
// the spec §7 golden: Taylor 20.9 mpg IN, Diggins 0.0 mpg EXCLUDED. If the file
// is absent (fresh clone before backfill) the layer is SKIPPED with a warning,
// never silently passed.
// ══════════════════════════════════════════════════════════════════════════════
import { computeRotation, parseMin, ROT_WINDOW, ROT_MPG_FLOOR, ROT_MIN_GAMES } from '../netlify/functions/team-profiles-nightly.mjs';
import { readFileSync, existsSync } from 'fs';

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// ── parseMin (study mins() port) ─────────────────────────────────────────────
eq(parseMin(null), 0, 'parseMin null');
eq(parseMin(''), 0, 'parseMin empty');
eq(parseMin('34'), 34, 'parseMin plain string');
eq(parseMin(34), 34, 'parseMin number');
ok(Math.abs(parseMin('31:30') - 31.5) < 1e-9, 'parseMin MM:SS', parseMin('31:30'));
eq(parseMin('DNP'), 0, 'parseMin garbage -> 0');
eq(parseMin('0:00'), 0, 'parseMin 0:00');

// ── helpers to build synthetic team_game_players rows ────────────────────────
// games: [{gid, date, players: {pid: min}}]
const rowsOf = (games, names = {}) => {
  const out = [];
  for (const g of games) for (const [pid, min] of Object.entries(g.players)) {
    out.push({ game_id: g.gid, date: g.date, player_id: Number(pid), player_name: names[pid] || `P${pid}`, min });
  }
  return out;
};
const day = (i) => `2026-06-${String(i).padStart(2, '0')}`;

// ── window mechanics ─────────────────────────────────────────────────────────
// 12 games; pid 1 plays 30 in the first 2 only, 0 after -> trailing-10 mpg = 0,
// excluded. pid 2 plays 20 every game -> in. Absences count as 0 (pid 3 plays
// 16 min in 5 of the last 10 -> mpg 8.0 exactly, INCLUDED at the floor;
// mpg_played = 16).
{
  const games = [];
  for (let i = 1; i <= 12; i++) {
    const p = { 2: 20 };
    if (i <= 2) p[1] = 30;
    if (i >= 3) p[1] = 0;                       // present with 0 min (box row exists)
    if (i >= 8 && i % 2 === 0) p[3] = 16;       // games 8,10,12 -> only 3 appearances... fix below
    games.push({ gid: `g${i}`, date: day(i), players: p });
  }
  // give pid 3 exactly 5 appearances in the trailing 10 (games 3..12): 4,6,8,10,12
  for (const g of games) delete g.players[3];
  for (const i of [4, 6, 8, 10, 12]) games[i - 1].players[3] = 16;
  const rot = computeRotation(rowsOf(games));
  ok(rot != null, 'window: rotation exists');
  eq(rot.window, ROT_WINDOW, 'window: constant');
  eq(rot.asof, day(12), 'window: asof = newest game in window');
  const pids = rot.players.map((p) => p.pid);
  ok(!pids.includes(1), 'window: stale player excluded (trailing-10 mpg 0)');
  ok(pids.includes(2), 'window: everyday player included');
  const p3 = rot.players.find((p) => p.pid === 3);
  ok(!!p3, 'floor: mpg exactly 8.0 is INCLUDED (>= floor)');
  eq(p3 && p3.mpg, 8, 'floor: absences-as-0 mpg (80/10)');
  eq(p3 && p3.mpg_played, 16, 'floor: mpg_played divergence (80/5)');
  eq(rot.players[0].pid, 2, 'ranking: highest mpg rank 1');
  eq(rot.players[0].rank, 1, 'ranking: rank field');
}

// ── min-5 window guard ───────────────────────────────────────────────────────
{
  const games = [];
  for (let i = 1; i <= 4; i++) games.push({ gid: `g${i}`, date: day(i), players: { 1: 30 } });
  eq(computeRotation(rowsOf(games)), null, 'guard: <5 team games -> null');
  games.push({ gid: 'g5', date: day(5), players: { 1: 30 } });
  ok(computeRotation(rowsOf(games)) != null, 'guard: exactly 5 games -> rotation');
}

// ── empty rotation guard ─────────────────────────────────────────────────────
{
  const games = [];
  for (let i = 1; i <= 6; i++) games.push({ gid: `g${i}`, date: day(i), players: { 1: 5, 2: 7.9 } });
  eq(computeRotation(rowsOf(games)), null, 'guard: nobody at floor -> null');
}

// ── asof strictness (study d < date) ─────────────────────────────────────────
{
  const games = [];
  for (let i = 1; i <= 7; i++) games.push({ gid: `g${i}`, date: day(i), players: { 1: 30 } });
  const rot = computeRotation(rowsOf(games), day(6));
  eq(rot.asof, day(5), 'asof: strict < excludes the asof date itself');
  const rot2 = computeRotation(rowsOf(games), day(6).replace('06-06', '06-30'));
  eq(rot2.asof, day(7), 'asof: later cutoff sees all games');
  eq(computeRotation(rowsOf(games), day(5)), null, 'asof: cutoff shrinking window below 5 -> null');
}

// ── top5/top8 ────────────────────────────────────────────────────────────────
{
  const players = {};
  for (let pid = 1; pid <= 10; pid++) players[pid] = 40 - pid * 2; // 38..20, all >= floor
  const games = [];
  for (let i = 1; i <= 10; i++) games.push({ gid: `g${i}`, date: day(i), players });
  const rot = computeRotation(rowsOf(games));
  eq(rot.top5_pids, [1, 2, 3, 4, 5], 'top5 ordering');
  eq(rot.top8_pids, [1, 2, 3, 4, 5, 6, 7, 8], 'top8 ordering');
  eq(rot.players.length, 10, 'all floor-clearing players kept in players[]');
}

// ── small rotation: top8 = everyone ──────────────────────────────────────────
{
  const games = [];
  for (let i = 1; i <= 6; i++) games.push({ gid: `g${i}`, date: day(i), players: { 1: 30, 2: 25, 3: 20 } });
  const rot = computeRotation(rowsOf(games));
  eq(rot.top8_pids, [1, 2, 3], 'top8 with 3-player rotation = all 3');
  eq(rot.top5_pids, [1, 2, 3], 'top5 with 3-player rotation = all 3');
}

// ── MM:SS rows flow through ──────────────────────────────────────────────────
{
  const games = [];
  for (let i = 1; i <= 5; i++) games.push({ gid: `g${i}`, date: day(i), players: {} });
  const rows = [];
  for (let i = 1; i <= 5; i++) rows.push({ game_id: `g${i}`, date: day(i), player_id: 9, player_name: 'MMSS Test', min: '20:30' });
  const rot = computeRotation(rows);
  eq(rot.players[0].mpg, 20.5, 'MM:SS strings parsed inside computeRotation');
}

// ── Date-object regression (Aug 11 prod bug) ─────────────────────────────────
// Neon returns DATE columns as JS Date objects; String(Date) is locale text and
// made window ordering alphabetical ("Wed May 27" sorted after "Thu Aug 06").
// Pin: Date-typed rows must produce the identical rotation as ISO-string rows.
{
  const mkRows = (dateFn) => {
    const rows = [];
    for (let i = 1; i <= 12; i++) {
      const iso = `2026-0${i <= 9 ? 5 : 6}-${String(i <= 9 ? i + 10 : i - 9).padStart(2, '0')}`; // May 11..19, Jun 1..3 — weekday names shuffle alphabetically
      rows.push({ game_id: `g${i}`, date: dateFn(iso), player_id: 1, player_name: 'A', min: i <= 2 ? 30 : 10 });
      rows.push({ game_id: `g${i}`, date: dateFn(iso), player_id: 2, player_name: 'B', min: 20 });
    }
    return rows;
  };
  const rStr = computeRotation(mkRows((iso) => iso));
  const rDat = computeRotation(mkRows((iso) => new Date(iso + 'T00:00:00Z')));
  eq(rDat, rStr, 'Date-object rows identical to ISO-string rows');
  eq(rDat.asof, '2026-06-03', 'Date-object rows: asof chronological, not alphabetical');
}

// ── Golden layer 2: CHI as-of 2026-08-09 (spec §7) ───────────────────────────
const chiPath = new URL('./fixtures_rotation_chi.json', import.meta.url).pathname;
if (existsSync(chiPath)) {
  const chi = JSON.parse(readFileSync(chiPath, 'utf8'));
  const rot = computeRotation(chi.rows, '2026-08-09');
  ok(rot != null, 'CHI golden: rotation exists');
  const taylor = rot.players.find((p) => /taylor/i.test(p.name));
  ok(!!taylor, 'CHI golden: Taylor in rotation');
  eq(taylor && taylor.mpg, 20.9, 'CHI golden: Taylor mpg 20.9');
  const diggins = rot.players.find((p) => /diggins/i.test(p.name));
  ok(!diggins, 'CHI golden: Diggins excluded (0.0 mpg in window)');
  for (const [k, v] of Object.entries(chi.expect || {})) {
    const got = rot.players.find((p) => p.pid === Number(k));
    eq(got && got.mpg, v, `CHI golden: pid ${k} mpg ${v}`);
  }
} else {
  console.log('  SKIP CHI golden — research/fixtures_rotation_chi.json not present (pin after backfill)');
}

console.log(`availability_fixtures: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
