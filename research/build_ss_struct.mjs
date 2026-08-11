// ══════════════════════════════════════════════════════════════════════════════
// build_ss_struct.mjs — SS_STRUCT structural numbers module (PARITY_SPEC Amendment
// 1 v3 §1). Computes every structural (2024-25) cell from the committed states file
// and verifies BOTH embedded copies (poll-live-bdl.mjs + wnba-bdl.html):
//   (1) byte-identical to each other between SS_STRUCT_BEGIN/END markers
//   (2) value-identical to the numbers computed here from the states file
// Run: node research/build_ss_struct.mjs   (exit 1 on any mismatch — pre-push gate)
//
// POPULATIONS (verbatim from research/2026-08-10_spec_cuts_regime.py):
//   BAND = margin <= 9 · OP = BAND + gap >= .15 · preQ4 = OP + period < 4
//   deficit  : gap >= .15, ALL margins, buckets 1-3 / 4-6 / 7-9 (trailer-WIN)
//   time     : OP by time bucket; preQ4 = Q2e..Q3l pooled (trailer-WIN)
//   gap      : BAND, .15<=g<.35 (qual) / g>=.35 (strong) (trailer-WIN)
//   leader   : OP, lwp<.400 / .400-.550 / MIN@DAL shape = elite trailer & lwp>=.550
//   holds    : gap<0 AND earned, all periods+margins — lead-HOLD rate.
//              NOTE: spec v3 wrote 75.0/136 from the sticky Phase-3b instrument
//              (5,297-state set, not committed); regenerated here from the committed
//              arena = 74.2/264. p within 1pp, n larger. Population documented above.
//   greenVeto: preQ4, lwp<.400, leader ABSOLUTE eFG <45 (sub45) / 45-55 (warm) —
//              the no-heat-to-regress veto. Spec v3 wrote 42.2/45 + 65.3/101 from a
//              pre-committed arena build; regenerated = 43.2/44 + 66.7/93.
//   deficit26 + riders26: SPEC-PINNED 2026 live-archive values (no PIN slots in
//              spec; provenance: deficit26 = deficit-cliff 2026 arm (audit 372ae94),
//              hotCell = eFG bar sensitivity Aug 9 (>55 cell, operative pop),
//              killer = KILLER_FLAG_SPEC evidence pool. Transcribed once HERE;
//              embedded copies verified against these constants.
// ══════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';

const S = JSON.parse(readFileSync('research/fixtures_spec_cut_states.json', 'utf8'));
const conv = (a) => a.length ? Math.round(1000 * a.filter((s) => s.won).length / a.length) / 10 : null;
const hold = (a) => a.length ? Math.round(1000 * a.filter((s) => !s.won).length / a.length) / 10 : null;

const BAND = S.filter((s) => s.margin <= 9);
const OP = BAND.filter((s) => s.gap >= 0.15);
const preQ4 = OP.filter((s) => s.period < 4);
const allGap = S.filter((s) => s.gap >= 0.15);
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
    sub45: cell(preQ4.filter((s) => s.lwp < 0.40 && s.lefg < 45), conv),
    warm: cell(preQ4.filter((s) => s.lwp < 0.40 && s.lefg >= 45 && s.lefg <= 55), conv),
  },
};
// Spec-pinned 2026 values (provenance in header) — the single transcription point.
const PINNED26 = {
  deficit26: { d13: { p: 65.4, n: 104 }, d46: { p: 60.0, n: 55 }, d79: { p: 42.9, n: 35 } },
  riders26: { hotCell: { p: 72.0, n: 50 }, killer: { p: 67, n: 45 } },
};

let fail = 0;
const err = (m) => { fail++; console.log('  MISMATCH: ' + m); };

// ── extract embedded blocks and byte-compare ──
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

// ── evaluate one block and value-verify ──
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
  if (!fail) console.log(`  value-verify: ${Object.keys(want).length} cells match computed/pinned  OK`);
}

// ── canonical block print (for regeneration) ──
console.log('\nCANONICAL VALUES (computed ' + new Date().toISOString().slice(0, 10) + '):');
console.log(JSON.stringify({ ...computed, ...PINNED26 }, null, 1));
console.log(fail ? `\nbuild_ss_struct: ${fail} MISMATCH(ES)` : '\nbuild_ss_struct: ALL OK');
process.exit(fail ? 1 : 0);
