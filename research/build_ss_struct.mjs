// ══════════════════════════════════════════════════════════════════════════════
// build_ss_struct.mjs — SS_STRUCT structural numbers module.
// SOURCE (PM decisions 1+2, Aug 11): the FINE ARENA — 30s-grain checkpoint
// reconstruction, coarse-comparable window 750-2250s, committed at
// research/fixtures_fine_states_matched.json.gz (3,113 states, 576 games,
// 2024+2025). Rationale: production perceives at ~26s median game time; the
// fine instrument samples first-perception like production fires do. The
// coarse 2.5-min arena (fixtures_spec_cut_states.json) remains committed as
// the persistence-instrument reference. Findings: 2026-08-11_fine_arena_findings.md.
//
// Verifies BOTH embedded copies (poll-live-bdl.mjs + wnba-bdl.html):
//   (1) byte-identical between SS_STRUCT_BEGIN/END markers
//   (2) value-identical to numbers computed here from the committed states
// Run: node research/build_ss_struct.mjs   (exit 1 on mismatch — pre-push gate)
//
// POPULATIONS (identical recipe to the coarse arena, fine states):
//   BAND = margin<=9 · OP = BAND+gap>=.15 · preQ4 = OP+period<4
//   deficit: gap>=.15 all margins, buckets 1-3/4-6/7-9 (trailer-WIN)
//   time: OP by bucket; preQ4 pooled · gap: BAND .15-.35 / .35+
//   leader: OP lwp<.400 / .400-.550 / elite-trailer & lwp>=.550
//   holds: gap<0 AND earned — lead-HOLD rate
//   greenVeto: preQ4, lwp<.400, leader eFG <45 / 45-55
//   deficit26: 2026 live tape, fine granularity, COMMITTED derivation —
//     research/2026-08-11_granularity_replay.mjs (fixtures_gran_states.json).
//     Replaces the spec-v3 transcribed values that had no committed script.
//   riders26: hotCell = eFG bar sensitivity Aug 9 (2026 operative pop >55 cell);
//     killer = KILLER_FLAG_SPEC evidence pool (HIST — why it never rides CELL READ).
// ══════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';

const S = JSON.parse(gunzipSync(readFileSync('research/fixtures_fine_states_matched.json.gz')).toString());
const conv = (a) => a.length ? Math.round(1000 * a.filter((s) => s.won).length / a.length) / 10 : null;
const hold = (a) => a.length ? Math.round(1000 * a.filter((s) => !s.won).length / a.length) / 10 : null;

const BAND = S.filter((s) => s.margin <= 9);
const OP = BAND.filter((s) => s.gap >= 0.15);
const preQ4 = OP.filter((s) => s.period < 4);
const allGap = S.filter((s) => s.gap >= 0.15);
const pb = preQ4.filter((s) => s.lwp < 0.40);
const elite = (s) => s.twp >= 0.600 && s.tgp >= 15;
const cell = (a, rate) => ({ p: rate(a), n: a.length });

const computed = {
  deficit: {
    d13: cell(allGap.filter((s) => s.margin >= 1 && s.margin <= 3), conv),
    d46: cell(allGap.filter((s) => s.margin >= 4 && s.margin <= 6), conv),
    d79: cell(allGap.filter((s) => s.margin >= 7 && s.margin <= 9), conv),
  },
  time: {
    preQ4: cell(preQ4, conv),
    q4e: cell(OP.filter((s) => s.tb === 'Q4-early'), conv),
    q4l: cell(OP.filter((s) => s.tb === 'Q4-late'), conv),
  },
  gap: {
    qual: cell(BAND.filter((s) => s.gap >= 0.15 && s.gap < 0.35), conv),
    strong: cell(BAND.filter((s) => s.gap >= 0.35), conv),
  },
  leader: {
    bad: cell(OP.filter((s) => s.lwp < 0.40), conv),
    mid: cell(OP.filter((s) => s.lwp >= 0.40 && s.lwp < 0.550), conv),
    qual: cell(OP.filter((s) => elite(s) && s.lwp >= 0.550), conv),
  },
  holds: { quality_lead: cell(S.filter((s) => s.gap < 0 && s.earned), hold) },
  greenVeto: {
    sub45: cell(pb.filter((s) => s.lefg < 45), conv),
    warm: cell(pb.filter((s) => s.lefg >= 45 && s.lefg <= 55), conv),
  },
};
// 2026 pins — committed derivations only (provenance in header).
const PINNED26 = {
  deficit26: { d13: { p: 62.9, n: 105 }, d46: { p: 60.0, n: 55 }, d79: { p: 40.7, n: 27 } },
  riders26: { hotCell: { p: 72.0, n: 50 }, killer: { p: 67, n: 45 } },
};

let fail = 0;
const err = (m) => { fail++; console.log('  MISMATCH: ' + m); };

const files = ['netlify/functions/poll-live-bdl.mjs', 'wnba-bdl.html'];
const blocks = files.map((f) => {
  const src = readFileSync(f, 'utf8');
  const a = src.indexOf('// SS_STRUCT_BEGIN'), b = src.indexOf('// SS_STRUCT_END');
  if (a < 0 || b < 0) { err(`${f}: SS_STRUCT markers missing`); return null; }
  return src.slice(a, b);
});
if (blocks[0] != null && blocks[1] != null) {
  if (blocks[0] === blocks[1]) console.log('  byte-equality: poll-live-bdl.mjs === wnba-bdl.html  OK');
  else err('SS_STRUCT blocks differ between files (byte-compare failed)');
}
if (blocks[0] != null) {
  const embedded = new Function(blocks[0].split('\n').filter((l) => !l.trim().startsWith('//')).join('\n') + '; return SS_STRUCT;')();
  const flat = (o, pre = '') => Object.entries(o).flatMap(([k, v]) =>
    (v && typeof v === 'object' && v.p === undefined) ? flat(v, pre + k + '.') : [[pre + k, v]]);
  const want = Object.fromEntries([...flat(computed), ...flat(PINNED26)]);
  const got = Object.fromEntries(flat(embedded));
  for (const [k, w] of Object.entries(want)) {
    const g = got[k];
    if (!g) { err(`${k}: missing from embedded block`); continue; }
    if (Number(g.p) !== Number(w.p) || Number(g.n) !== Number(w.n)) err(`${k}: embedded {p:${g.p},n:${g.n}} vs computed {p:${w.p},n:${w.n}}`);
  }
  for (const k of Object.keys(got)) if (!want[k]) err(`${k}: embedded but not computed/pinned`);
  if (!fail) console.log(`  value-verify: ${Object.keys(want).length} cells match computed/pinned (FINE arena source)  OK`);
}
console.log('\nCANONICAL VALUES (fine arena, computed ' + new Date().toISOString().slice(0, 10) + '):');
console.log(JSON.stringify({ ...computed, ...PINNED26 }, null, 1));
console.log(fail ? `\nbuild_ss_struct: ${fail} MISMATCH(ES)` : '\nbuild_ss_struct: ALL OK');
process.exit(fail ? 1 : 0);
