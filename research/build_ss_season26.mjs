// ══════════════════════════════════════════════════════════════════════════════
// build_ss_season26.mjs — SS_SEASON26 [this season] context block (PARITY Amendment 2).
// SOURCE: research/fixtures_fine26_states.json.gz (947 states, 140 games) — the
// FINE26 extraction (2026-08-13_fine26_extraction.mjs), selection recipe faithful
// to the committed deficit26 derivation (repro gate 3/3 exact at build).
// Computes every cell with the build_ss_struct population recipes VERBATIM and
// verifies the wnba-bdl.html block between SS_SEASON26_BEGIN/END value-matches.
// Run: node research/build_ss_season26.mjs   (exit 1 on mismatch — pre-push gate)
// ══════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';

const S = JSON.parse(gunzipSync(readFileSync('research/fixtures_fine26_states.json.gz')).toString());
const conv = (a) => a.length ? Math.round(1000 * a.filter((s) => s.won).length / a.length) / 10 : null;
const hold = (a) => a.length ? Math.round(1000 * a.filter((s) => !s.won).length / a.length) / 10 : null;
const cell = (a, rate) => ({ p: rate(a), n: a.length });

const BAND = S.filter((s) => s.margin <= 9);
const OP = BAND.filter((s) => s.gap >= 0.15);
const preQ4 = OP.filter((s) => s.period < 4);
const allGap = S.filter((s) => s.gap >= 0.15);
const pb = preQ4.filter((s) => s.lwp < 0.40);
const elite = (s) => s.twp >= 0.600 && s.tgp >= 15;

const computed = {
  asof: S.map((s) => s.date).sort().pop(),
  games: new Set(S.map((s) => s.gid)).size,
  deficit: {
    d13: cell(allGap.filter((s) => s.margin >= 1 && s.margin <= 3), conv),
    d46: cell(allGap.filter((s) => s.margin >= 4 && s.margin <= 6), conv),
    d79: cell(allGap.filter((s) => s.margin >= 7 && s.margin <= 9), conv),
  },
  time: {
    preQ4: cell(preQ4, conv),
    q4e: cell(OP.filter((s) => s.bucket === 'Q4-early'), conv),
    q4l: cell(OP.filter((s) => s.bucket === 'Q4-late'), conv),
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
    hot: cell(pb.filter((s) => s.lefg > 55), conv),
  },
};

let fail = 0;
const err = (m) => { fail++; console.log('  MISMATCH: ' + m); };

const html = readFileSync('wnba-bdl.html', 'utf8');
const b0 = html.indexOf('var SS_SEASON26'), b1 = html.indexOf('// SS_SEASON26_END');
if (b0 < 0 || b1 < 0) { console.log('SS_SEASON26 block not found'); process.exit(1); }
const embedded = new Function(html.slice(b0, b1) + '; return SS_SEASON26;')();

if (embedded.asof !== computed.asof) err(`asof ${embedded.asof} vs ${computed.asof}`);
if (embedded.games !== computed.games) err(`games ${embedded.games} vs ${computed.games}`);
for (const grp of ['deficit', 'time', 'gap', 'leader', 'holds', 'greenVeto']) {
  for (const k of Object.keys(computed[grp])) {
    const c = computed[grp][k], e = embedded[grp] && embedded[grp][k];
    if (!e) { err(`${grp}.${k} missing`); continue; }
    if (e.p !== c.p || e.n !== c.n) err(`${grp}.${k}: embedded ${e.p}/${e.n} vs computed ${c.p}/${c.n}`);
  }
}
console.log(fail ? `FAIL — ${fail} mismatches` : `SS_SEASON26 verify OK — ${computed.games} games, asof ${computed.asof}, all cells value-match`);
process.exit(fail ? 1 : 0);
