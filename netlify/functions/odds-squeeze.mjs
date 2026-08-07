// ═══════════════════════════════════════════════════════════════════
// SQUEEZE WATCH — SQUEEZE_WATCH_SPEC.md v1.2
// Stalks live prices on armed sweet-spot rows; pushes plain-English
// price alerts when the best book crosses a cell-aware threshold.
// Isolated module: never touches poll-live-bdl. Direct Neon + direct
// external APIs only (internal Netlify HTTP returns 401).
// Cadence: double-sample per invocation (t=0, sleep 30s, t=30) = 30s.
// ═══════════════════════════════════════════════════════════════════
import { neon } from '@neondatabase/serverless';

const LEAGUE = 'wnba';
const ROSTER = ['williamhill_us', 'espnbet', 'fanduel', 'betrivers', 'hardrockbet', 'draftkings'];
const BOOK_NAMES = { williamhill_us: 'Caesars', espnbet: 'ESPN Bet', fanduel: 'FanDuel', betrivers: 'BetRivers', hardrockbet: 'Hard Rock', draftkings: 'DraftKings' };
const DEFAULT_BOOK = 'williamhill_us'; // Caesars = tie-break / fallback (PM decision Jul 22)
const BOOK_LINKS = { // universal-link fallbacks (open installed app) when API link absent
  williamhill_us: 'https://sportsbook.caesars.com/us/az/bet/basketball',
  fanduel: 'https://sportsbook.fanduel.com/navigation/wnba',
  draftkings: 'https://sportsbook.draftkings.com/leagues/basketball/wnba',
  espnbet: 'https://espnbet.com/sport/basketball/organization/united-states/competition/wnba',
  hardrockbet: 'https://app.hardrock.bet/',
  betrivers: 'https://az.betrivers.com/',
};
// Odds API full names + ESPN names → canonical alias (nickname keyed; survives city renames)
const NICK = { Lynx: 'MIN', Storm: 'SEA', Fire: 'POR', Wings: 'DAL', Sky: 'CHI', Liberty: 'NY', Aces: 'LV', Mystics: 'WSH', Sun: 'CON', Fever: 'IND', Sparks: 'LA', Mercury: 'PHX', Valkyries: 'GS', Dream: 'ATL', Tempo: 'TOR' };
const PUSHED_SUBTYPES = ['EFG_FADE', 'EFG_FADE_SOFT', 'B1', 'B2', 'B3', 'WATCHLIST'];
const KILLER_THRESHOLD = -150; // policy (PM Jul 22): implied 60% vs killer cell 67% [PRIOR n=45]
const A_TIER_THRESHOLD = -200; // policy (PM Jul 28): implied 66.7% vs .70 anchor breakeven -233; wide-net eyes, breakeven check decides
const NONKILLER_THRESHOLD = 117; // derived: pre-registered 46% breakeven on no-scalp cells [PRIOR]
const REARM_IMPLIED_DROP = 0.035; // ~25 cents around +140; implied-prob scale crosses zero cleanly
const MAX_ALERTS_PER_ARM = 6;
const TTL_HOURS = 3; // arm expiry (fire + full game window)

const log = (m) => console.log(`[squeeze] ${m}`);
export const implied = (a) => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
const fmtOdds = (a) => (a > 0 ? `+${a}` : `${a}`);
const fixLink = (l) => (l ? l.replace('{state}', process.env.SQUEEZE_STATE || 'az')
  .replace('{pickType}', 'single').replace('{wagerAmount}', '') : l); // Odds API link templates: state/pickType/wagerAmount tokens
export const probToAmerican = (p) => {
  const c = Math.min(0.90, Math.max(0.35, p)); // clamp: no absurd thresholds from bad inputs
  return c >= 0.5 ? Math.round(-100 * c / (1 - c)) : Math.round(100 * (1 - c) / c);
};
// per-row threshold (flat policy, PM Jul 28 — dynamic mode retired):
// A-tier -200 regardless of flag; killer -150 on review tiers; +117 breakeven otherwise
export const pickThreshold = (row) => {
  // tier trumps killer: A-tier gets the widest net regardless of flag (PM Jul 28);
  // killer only differentiates the review tiers (B/WATCHLIST)
  if (row.alert_subtype === 'EFG_FADE') return A_TIER_THRESHOLD;
  if (row.leader_killer) return KILLER_THRESHOLD;
  return NONKILLER_THRESHOLD;
};
// eFG definitions — MIRRORS of poll-live-bdl (one-consumer-definition contract;
// source-equality pinned in research/2026-07-23_squeeze_fixtures.mjs). The old static
// bandOf (56/65) drifted from the engine's period-adjusted bands — retired Aug 6.
const EFG_BANDS = { 1:[54,61], 2:[56,63], 3:[58,66], 4:[60,69] };
const TEMP_ABS = { COLD: 45, HOT: 55 }; // F4 trailer-temp absolute bands (= FUELTEMP_TH.TEMP_ABS_*)
export const leaderBandOf = (efg, period) => {
  if (efg == null || isNaN(efg)) return null;
  const b = EFG_BANDS[period] || EFG_BANDS[4];
  return efg >= b[1] ? 'red' : efg >= b[0] ? 'orange' : 'green';
};
export const trailerTempOf = (efg) => (efg == null || isNaN(efg) ? null : efg < TEMP_ABS.COLD ? 'cold' : efg > TEMP_ABS.HOT ? 'hot' : 'warm');
// ═══ MIRRORS of poll-live-bdl (ACA P2b — one-consumer-definition; source-equality
//     pinned in research/2026-07-23_squeeze_fixtures.mjs). Netlify bundles functions
//     separately (no cross-require) — verbatim copies + fixture contract instead.

function efgTier(efg, period) {
  if (efg == null || isNaN(efg)) return { tier:'na', color:'var(--fg-dim)' };
  var b = EFG_BANDS[period] || EFG_BANDS[4];
  if (efg <= b[0]) return { tier:'green', color:'var(--green)' };
  if (efg <= b[1]) return { tier:'orange', color:'var(--amber)' };
  return { tier:'red', color:'var(--coral)' };
}
var FUELTEMP_TH = { POT_MIN: 6, THREE_SHARE: 40, VSHARE: 45, TO_CLEAN: 4, MIN_FGA: 12, TEMP_ABS_COLD: 45, TEMP_ABS_HOT: 55 };
function computeFuelTemp(leaderStats, trailerStats, period) {
  function _n(v) { v = Number(v); return isNaN(v) ? 0 : v; }
  function _efg(s) { var fga = _n(s && s.fga); if (fga < FUELTEMP_TH.MIN_FGA) return null; return (_n(s.fgm) + 0.5 * _n(s.fg3m)) / fga * 100; }
  var L = leaderStats || {}, T = trailerStats || {};
  var lEfg = _efg(L), tEfg = _efg(T);
  if (lEfg == null || tEfg == null) return { insufficient: true };
  var lBand = efgTier(lEfg, period).tier, tBand = efgTier(tEfg, period).tier;
  var lPts = 2 * _n(L.fgm) + _n(L.fg3m) + _n(L.ftm);
  var threeShare = lPts > 0 ? (3 * _n(L.fg3m)) / lPts * 100 : 0;
  var vShare = (L.vShare != null && !isNaN(Number(L.vShare))) ? Number(L.vShare) : null;
  var heat = lBand === 'red' || threeShare >= FUELTEMP_TH.THREE_SHARE || (vShare != null && vShare > FUELTEMP_TH.VSHARE);
  var takeaway = _n(L.pot) >= FUELTEMP_TH.POT_MIN;
  var fuel = heat && takeaway ? 'TRANSIENT (heat + takeaway)' : heat ? 'TRANSIENT (heat)' : takeaway ? 'TRANSIENT (takeaway)' : 'EARNED';
  // F4 (Aug 6): displayed temp = ABSOLUTE bands (period bands made "59% eFG" read
  // cold at Q4). STICKY keeps its v1 period-band-cold input by design - the abs-cold
  // sticky failed its pre-registered re-cut bar (research/2026-08-06 map addendum).
  var temp = tEfg < FUELTEMP_TH.TEMP_ABS_COLD ? 'cold' : tEfg > FUELTEMP_TH.TEMP_ABS_HOT ? 'hot' : 'warm';
  var sticky = fuel === 'EARNED' && tBand === 'green' && _n(T.to) < FUELTEMP_TH.TO_CLEAN;
  return { insufficient: false, fuel: fuel, heat: heat, takeaway: takeaway, temp: temp, sticky: sticky,
    leaderEfg: Math.round(lEfg * 10) / 10, leaderBand: lBand, trailerEfg: Math.round(tEfg * 10) / 10, trailerBand: tBand,
    threeShare: Math.round(threeShare), vShare: vShare != null ? Math.round(vShare) : null,
    pot: _n(L.pot), trailerTo: _n(T.to), period: period };
}
function ssCautionLines(ft, row, regime) {
  if (!ft || ft.insufficient) return '';
  var t = '';
  // ACA P1 — trap parity: framework rules pinned here render on ALL surfaces (mechanical
  // push, narration prompt, post-model append). Copy kernel mirrors the dashboard trap.
  if (row && row.lead_class === 'STRUCTURAL') t += '- \u26a0 STRUCTURAL-LEADER TRAP: Structural leader = the pass shape (POR@CHI rule). Conscious override territory only \u2014 probe size (CHI@DAL convention).\n';
  // ACA P3 — regime tripwire: INVERTED suspends the numeric (2026) season-stat lines
  // (client STICKY chip precedent). Traps above are framework rules — regime-independent.
  if (regime === 'INVERTED') {
    if (ft.sticky) t += '- LEAD SHAPE: earned + cold, clean trailer (' + ft.trailerTo + ' turnovers). (2026 season-stat lines suspended: regime pulse INVERTED.)\n';
    else if (ft.fuel === 'EARNED') t += '- LEAD NOTE: earned lead \u2014 no transient feed to regress. (2026 season-stat lines suspended: regime pulse INVERTED.)\n';
    if (ft.takeaway) t += '- CHANNEL NOTE: takeaway feed present. (2026 season-stat lines suspended: regime pulse INVERTED.)\n';
    return t;
  }
  if (ft.sticky) t += '- STICKY LEAD SHAPE (2026): earned lead against a cold, clean trailer (' + ft.trailerTo + ' turnovers) — this season\'s toughest comeback shape. Context only, never a gate.\n';
  // Copy v1.2 (Aug 6, PM-approved): season-stat context lines. Numbers are
  // cross-cut-converged (see research/2026-08-06_fuel_temp_gap_map.md); a regime
  // flip (monthly pulse INVERTED) triggers a copy revisit for all (2026) lines.
  else if (ft.fuel === 'EARNED') t += '- EARNED-LEAD CAUTION (2026): no transient feed to regress — earned leads vs in-band better trailers converted only ~37% across three independent 2026 cuts, below what the live line charges. This season\'s pass shape. Context only, never a gate.\n';
  if (ft.takeaway) t += '- CHANNEL NOTE (2026): the takeaway feed is the market-blind transient — the live line has under-priced takeaway-fed collapse all season (trailers converted ~85%, two independent cuts). Context only, never a gate.\n';
  return t;
}
export const efgFromRaw = (t) => {
  const fga = Number(t?.fga) || 0; if (fga < 1) return null;
  return ((Number(t?.fgm) || 0) + 0.5 * (Number(t?.fg3m) || 0)) / fga * 100;
};

// ── DS v1.1 C3 — CASH surge watch (DECISION_SUPPORT_V1_SPEC + v1.1 addendum; SHADOW).
//    Validated §11 Aug 5: profit-locked surge rule +$2.7-3.2K vs +$1.3K hold in-sample;
//    first-flip cashing REFUTED (−$113). Cold-at-fire positions only — warm rides.
//    v1.1 (PM, Aug 5, amended at n=0 forward — pre-registration restarts clean):
//    gate is the RAW PRICE line Manny reads at the window, not de-vig; de-vig p is
//    still stamped every fire for calibration. Constants pinned; spec amendment to change.
const SURGE_PRICE = -400;    // trigger: trailer best price at/inside this line (implied >= .80)
const SURGE_HAIRCUT = 0.93;  // 7% cash-out haircut assumption; recalibrated from real bet365 offers at n≥8
const SURGE_MIN_LEAD = 1;    // copy asserts a lead; also kills any t=0 / tied-game artifact
// de-vig two-sided prob from the same best-price pair the tape stores (§11 recipe)
export const devigProb = (trailerPrice, leaderPrice) => {
  if (trailerPrice == null || leaderPrice == null) return null;
  const t = implied(trailerPrice), l = implied(leaderPrice);
  return (t + l) > 0 ? t / (t + l) : null;
};
// pure trigger — every leg must clear; caller evaluates the profit-lock leg (dual
// path: $ when a bet row exists, % vs fire price otherwise) and passes lockOk.
export function surgeCheck({ coldAtFire, price, lead, lockOk, alreadyFired }) {
  if (alreadyFired) return { fire: false, why: 'one-shot' };
  if (!coldAtFire) return { fire: false, why: 'not-cold-at-fire' };
  if (price == null || implied(price) < implied(SURGE_PRICE)) return { fire: false, why: 'price-above' };
  if (lead == null || lead < SURGE_MIN_LEAD) return { fire: false, why: 'no-lead' };
  if (!lockOk) return { fire: false, why: 'no-profit-lock' };
  return { fire: true };
}
// tip copy — Manny-amended template (spec §3 + v1.1 dual path). A PROMPT, never an
// imperative. dollars = { estCash, payout } when a bet is logged; null → % framing
// (fireLine = the row's fire price for the breakeven clause; omitted when absent).
export function composeCashout({ trailer, elite, lead, p, frac, dollars, fireLine, fireEfg }) {
  const pR = Math.round(p * 100);
  const title = `CASHOUT CHECK: ${trailer} leads by ${lead}`;
  const because = `${trailer} was cold at entry (${Math.round(fireEfg)}% eFG) and cold-start comebacks have given leads back`;
  let mid;
  if (dollars) {
    mid = `Market has ${trailer} ~${pR}%. Cash-out locks ~$${Math.round(dollars.estCash)} of $${Math.round(dollars.payout)} payout; riding risks a loss because ${because}.`;
  } else {
    const fracR = Math.round(frac * 100);
    const be = fireLine != null ? `; a ${fireLine > 0 ? '+' + fireLine : fireLine} entry breaks even at ~${Math.round(implied(fireLine) * 100)}%` : '';
    mid = `Market has ${trailer} ~${pR}% - a fair cash-out is ~${fracR}% of your full payout${be}. Riding risks a loss because ${because}.`;
  }
  const body = `Cashout check: ${trailer}${elite ? ' (elite)' : ''} now leads by ${lead}. ${mid} Your read - not a directive.`;
  return { title, body };
}

// ── v1.3 band decision (SQUEEZE_WATCH_SPEC v1.3 §3-§4). Pure — golden fixtures
//    in research/2026-07-23_squeeze_fixtures.mjs (row-1148 replay).
//    Band 1-9. Grace evals price on oob strikes 1-2 when deficit is 0 (tie:
//    market's neutral-WP read, juice can persist) or 10-11 (band+2 collar:
//    sampler lag around fires). deficit < 0 = trailer leads, entry juice dead:
//    strike, no eval. 3 consecutive oob → SUSPEND (not terminal); band
//    re-entry → RESUME same pass, oob reset. modes:
//    in_band | grace | strike_skip | suspend | suspended | resume
export function bandStep(prevState, deficit) {
  const st = prevState || {};
  const inBand = deficit >= 1 && deficit <= 9;
  if (st.suspended) {
    if (inBand) return { mode: 'resume', oob: 0, suspended: false };
    return { mode: 'suspended', oob: st.oob_count || 0, suspended: true };
  }
  if (inBand) return { mode: 'in_band', oob: 0, suspended: false };
  const oob = (st.oob_count || 0) + 1;
  if (oob >= 3) return { mode: 'suspend', oob, suspended: true };
  const graceEval = deficit === 0 || (deficit >= 10 && deficit <= 11);
  return { mode: graceEval ? 'grace' : 'strike_skip', oob, suspended: false };
}

function aliasFromName(name) {
  if (!name) return null;
  for (const nick of Object.keys(NICK)) if (name.includes(nick)) return NICK[nick];
  return null;
}

async function sendNtfy(title, body, priority = 4, clickUrl = null) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    const asciiTitle = title.replace(/\u2014/g, '-').replace(/[^\x00-\x7F]/g, '').replace(/\s+/g, ' ').trim();
    const h = { Title: asciiTitle || 'DFT Squeeze', Priority: String(priority), Tags: 'chart_with_upwards_trend' };
    if (clickUrl) h.Click = clickUrl;
    await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', headers: h, body });
    log(`ntfy sent: ${asciiTitle}`);
  } catch (e) { log(`ntfy FAILED: ${e.message}`); }
}

// ── Odds API: one call covers every armed game (2 credits: us,us2 × h2h) ──
async function fetchOdds() {
  const key = process.env.ODDS_API_KEY;
  if (!key) { log('no ODDS_API_KEY'); return null; }
  const url = `https://api.the-odds-api.com/v4/sports/basketball_wnba/odds?apiKey=${key}&regions=us,us2&markets=h2h&oddsFormat=american&includeLinks=true`;
  const r = await fetch(url);
  if (!r.ok) { log(`odds api ${r.status}`); return null; }
  const events = await r.json();
  log(`odds ok, ${events.length} events, credits used ${r.headers.get('x-requests-used')}`);
  return events;
}

// best price for one team-alias across the roster; returns {price, book, link}
function bestPrice(event, alias) {
  let best = null;
  for (const bk of event.bookmakers || []) {
    if (!ROSTER.includes(bk.key)) continue;
    for (const m of bk.markets || []) {
      if (m.key !== 'h2h') continue;
      for (const o of m.outcomes || []) {
        if (aliasFromName(o.name) !== alias) continue;
        const link = fixLink(o.link || m.link || bk.link) || BOOK_LINKS[bk.key] || BOOK_LINKS[DEFAULT_BOOK];
        if (!best || implied(o.price) < implied(best.price) ||
            (o.price === best.price && bk.key === DEFAULT_BOOK)) {
          best = { price: o.price, book: bk.key, link };
        }
      }
    }
  }
  return best;
}

function topThreeLine(event, alias) {
  const all = [];
  for (const bk of event.bookmakers || []) {
    if (!ROSTER.includes(bk.key)) continue;
    for (const m of bk.markets || []) if (m.key === 'h2h')
      for (const o of m.outcomes || []) if (aliasFromName(o.name) === alias)
        all.push({ book: BOOK_NAMES[bk.key], price: o.price });
  }
  all.sort((a, b) => implied(a.price) - implied(b.price));
  return all.slice(0, 3).map((x) => `${x.book} ${fmtOdds(x.price)}`).join(' | ');
}

// ── ESPN state gate (free, ~10s fresh): clock/period/score per alias-pair ──
async function fetchEspnState() {
  try {
    const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard');
    if (!r.ok) return {};
    const d = await r.json();
    const out = {};
    for (const ev of d.events || []) {
      const comp = (ev.competitions || [])[0];
      if (!comp) continue;
      const teams = {};
      for (const c of comp.competitors || []) {
        const al = aliasFromName(c.team?.name || c.team?.displayName || '') || c.team?.abbreviation;
        teams[c.homeAway] = { alias: al, score: Number(c.score) || 0 };
      }
      const st = ev.status || comp.status || {};
      const key = [teams.home?.alias, teams.away?.alias].sort().join('|');
      out[key] = {
        period: st.period || 0, clock: st.displayClock || '0:00',
        state: st.type?.state || 'pre', // pre | in | post
        home: teams.home, away: teams.away,
      };
    }
    return out;
  } catch (e) { log(`espn fail ${e.message}`); return {}; }
}

const clockToSec = (c) => { const m = /^(\d+):(\d+)/.exec(c || ''); return m ? +m[1] * 60 + +m[2] : null; };

// ── one sample pass over all armed watches ──
async function samplePass(sql, watches, espn, events, dry, openBets) {
  const results = [];
  let odds = events; // fetched lazily only if some game passes the state gate
  for (const w of watches) {
    const st = w.squeeze_state || {};
    const key = [w._home, w._away].sort().join('|');
    const g = espn[key];
    const res = { id: w.id, game: `${w._away}@${w._home}`, action: 'skip', reason: '' };
    results.push(res);

    if (!g) { res.reason = 'no-espn'; continue; }
    if (g.state === 'post') { await disarm(sql, w, 'final'); res.action = 'disarm'; res.reason = 'final'; continue; }
    const q4sec = clockToSec(g.clock);
    if (g.period >= 4 && q4sec != null && q4sec <= 120) { await disarm(sql, w, 'q4-2:00'); res.action = 'disarm'; res.reason = 'q4-late'; continue; }

    // clock gate: frozen ⇒ skip odds pull, EXCEPT one catch-up when period increments
    const frozen = g.state === 'in' && st.last_clock === g.clock && st.last_period === g.period;
    const periodFlip = st.last_period != null && g.period > st.last_period;
    if (g.state === 'pre') { res.reason = 'pregame'; continue; }
    if (frozen && !periodFlip) { res.reason = 'clock-frozen'; await saveState(sql, w, { ...st, last_clock: g.clock, last_period: g.period }); continue; }

    // trailer + band via ESPN score (leader/trailer roles are the ROW's anchors)
    const scores = { [g.home.alias]: g.home.score, [g.away.alias]: g.away.score };
    const deficit = (scores[w.leader_alias] ?? 0) - (scores[w.trailer_alias] ?? 0);
    const step = bandStep(st, deficit);

    // ── DS v1.1 C3 — CASH surge watch (SHADOW MODE). Evaluated BEFORE the band-mode
    // branches: the surge condition (trailer leading at ≤ −400) lives almost entirely
    // out of band, where entry logic continues without an odds pull. NEVER writes the
    // price tape on oob paths (research dataset unchanged); one-shot per position.
    // % path is the DEFAULT (no bet row required); a logged bet upgrades to $ copy at
    // the next 30s sample. Warm-at-fire rides — cold-at-fire is the only gate in.
    try {
      if (w._fuelTemp && w._fuelTemp.temp === 'cold' && !st.surge_fired && (-deficit) >= SURGE_MIN_LEAD) {
        if (!odds) odds = await fetchOdds();
        if (odds) {
          const ev2 = odds.find((e) => [aliasFromName(e.home_team), aliasFromName(e.away_team)].sort().join('|') === key);
          const tb = ev2 && bestPrice(ev2, w.trailer_alias), lb = ev2 && bestPrice(ev2, w.leader_alias);
          const p = tb && lb ? devigProb(tb.price, lb.price) : null;
          const frac = p != null ? p * SURGE_HAIRCUT : null;
          const posn = openBets && openBets[w.game_id] && openBets[w.game_id][w.trailer_alias];
          const fireLine = w.line_used != null ? Number(w.line_used) : null;
          // profit-lock leg, dual path: $ when logged; % vs fire price otherwise.
          // Neither evaluable (no bet AND no fire price) → no fire (no fake reads).
          const lockOk = frac != null && (posn
            ? frac * posn.payout >= posn.stake
            : (fireLine != null && frac >= implied(fireLine)));
          const chk = surgeCheck({ coldAtFire: true, price: tb ? tb.price : null, lead: -deficit, lockOk, alreadyFired: !!st.surge_fired });
          if (chk.fire) {
            // cross-row one-shot guard: a newer watch superseding the elder must not re-tip
            let dupe = false;
            try {
              const d = await sql`SELECT 1 FROM sweetspot_alerts WHERE game_id = ${w.game_id} AND league = ${LEAGUE}
                AND squeeze_state->>'surge_fired' = ${'true'} AND id <> ${w.id} LIMIT 1`;
              dupe = d.length > 0;
            } catch (e) { /* guard degrades — per-watch one-shot still holds */ }
            let elite = false;
            try {
              const pr = await sql`SELECT profile FROM team_profiles WHERE league = ${LEAGUE} AND season = 2026 AND team_alias = ${w.trailer_alias} LIMIT 1`;
              const pj = pr[0] && (typeof pr[0].profile === 'string' ? JSON.parse(pr[0].profile) : pr[0].profile);
              elite = !!(pj && pj.elite === true); // CONSUMER hysteresis flag ONLY — never internal def-A (KILLER_FLAG_SPEC §7)
            } catch (e) { /* no tag */ }
            if (!dupe) {
              const tip = composeCashout({ trailer: w.trailer_alias, elite, lead: -deficit, p, frac,
                dollars: posn ? { estCash: frac * posn.payout, payout: posn.payout } : null,
                fireLine, fireEfg: w._fuelTemp.trailerEfg });
              res.surge = dry ? 'WOULD-CASHTIP' : 'CASHTIP';
              if (!dry) await sendNtfy(tip.title, tip.body, 5, null);
              log(`surge tip row ${w.id}: ${w.trailer_alias} leads ${-deficit} at ${fmtOdds(tb.price)}, p=${p.toFixed(3)}, frac=${frac.toFixed(3)}${posn ? ` [$ path, stake $${posn.stake}]` : ' [% path]'}${dry ? ' [dry]' : ''}`);
            }
            if (!dry) {
              Object.assign(st, { surge_fired: true, surge_at: new Date().toISOString(),
                surge_p: Math.round(p * 1000) / 1000, surge_frac: Math.round(frac * 1000) / 1000,
                surge_lead: -deficit, surge_price: tb.price,
                ...(posn ? { surge_est_cash: Math.round(frac * posn.payout), surge_stake: posn.stake } : {}) });
              await saveState(sql, w, st);
            }
          }
        }
      }
    } catch (e) { log(`surge check row ${w.id}: ${e.message}`); }

    if (step.mode === 'suspend') {
      // v1.3: band-exit is no longer terminal — watch sleeps (ESPN-only), resumes on band re-entry
      res.action = 'suspend'; res.reason = `band-exit(${deficit})`;
      log(`suspend row ${w.id}: band-exit (deficit ${deficit})`);
      await saveState(sql, w, { ...st, last_clock: g.clock, last_period: g.period, oob_count: step.oob, suspended: true });
      continue;
    }
    if (step.mode === 'suspended') {
      res.reason = `suspended(${deficit})`;
      await saveState(sql, w, { ...st, last_clock: g.clock, last_period: g.period });
      continue;
    }
    if (step.mode === 'strike_skip') {
      res.reason = `oob(${deficit}) strike ${step.oob}`;
      await saveState(sql, w, { ...st, last_clock: g.clock, last_period: g.period, oob_count: step.oob });
      continue;
    }
    // in_band | grace | resume → full price pipeline
    const oobGrace = step.mode === 'grace';
    if (step.mode === 'resume') log(`resume row ${w.id}: back in band (deficit ${deficit})`);
    const resumedAt = step.mode === 'resume' ? { period: g.period, clock: g.clock } : (st.resumed_at || null);
    if (oobGrace) res.reason = `grace(${deficit}) strike ${step.oob}`;

    if (!odds) odds = await fetchOdds();
    if (!odds) { res.reason = 'odds-fail'; continue; }
    const ev = odds.find((e) => {
      const k = [aliasFromName(e.home_team), aliasFromName(e.away_team)].sort().join('|');
      return k === key;
    });
    if (!ev) { res.reason = 'no-odds-event'; continue; }

    const best = bestPrice(ev, w.trailer_alias);
    if (!best) { res.reason = 'no-trailer-price'; continue; }

    // tape: every live sample writes odds_history (30s price tape on armed windows).
    // v1.3 §4a: deficit stamped — tape doubles as a price-by-deficit dataset
    // (deficit=0 rows = market's neutral-WP reads; feeds honest-gap + E4-class price work)
    const homeBest = bestPrice(ev, w._home), awayBest = bestPrice(ev, w._away);
    if (!dry) await sql`INSERT INTO odds_history (game_id, home_ml, away_ml, deficit, source)
      VALUES (${w.game_id}, ${homeBest?.price ?? null}, ${awayBest?.price ?? null}, ${deficit}, ${'squeeze:' + best.book})`;

    res.best = `${fmtOdds(best.price)} ${best.book}`;
    const crossed = implied(best.price) <= implied(w.squeeze_threshold);
    const rearmOk = w.squeeze_last_alert_price == null ||
      implied(w.squeeze_last_alert_price) - implied(best.price) >= REARM_IMPLIED_DROP;
    let alerted = false;
    if (!crossed) { res.reason = 'below-threshold'; }
    else if (!rearmOk) { res.reason = 'rearm-wait'; }
    else if ((w.squeeze_alert_count || 0) >= MAX_ALERTS_PER_ARM) { await disarm(sql, w, 'max-alerts'); res.action = 'disarm'; res.reason = 'max-alerts'; }
    else {
      res.action = dry ? 'WOULD-ALERT' : 'ALERT';
      if (!dry) {
        await pushSqueezeAlert(sql, w, g, deficit, best, topThreeLine(ev, w.trailer_alias), oobGrace, resumedAt);
        await sql`UPDATE sweetspot_alerts SET squeeze_last_alert_price = ${best.price},
          squeeze_alert_count = COALESCE(squeeze_alert_count,0) + 1 WHERE id = ${w.id}`;
        alerted = true;
      }
    }
    // resume breadcrumb persists until it rides an alert, then clears
    const nextState = { ...st, last_clock: g.clock, last_period: g.period, oob_count: step.oob, suspended: false };
    if (resumedAt && !alerted) nextState.resumed_at = resumedAt; else delete nextState.resumed_at;
    await saveState(sql, w, nextState);
  }
  return { results, odds };
}

async function saveState(sql, w, st) {
  w.squeeze_state = st;
  await sql`UPDATE sweetspot_alerts SET squeeze_state = ${JSON.stringify(st)} WHERE id = ${w.id}`;
}
async function disarm(sql, w, why) {
  await sql`UPDATE sweetspot_alerts SET squeeze_armed = FALSE WHERE id = ${w.id}`;
  log(`disarm row ${w.id}: ${why}`);
}

// ── alert copy (pinned in fixtures; plain English; never a directive) ──
export function composeSqueeze({ trailer, leader, price, book, threshold, cellRate, cellName, deficit, period, clock, leaderEfg, leaderBand, leaderVar, trailerEfg, trailerTemp = null, asOf = null, capLine, shopLine, stale, oobGrace = false, resumedAt = null, posLine = null, shapeLine = null, cautionBlock = null }) {
  const imp = Math.round(implied(price) * 100);
  const cushion = cellRate ? `${cellRate - imp >= 0 ? '+' : ''}${cellRate - imp}pp` : 'n/a';
  const title = `JUICE: ${trailer} ${fmtOdds(price)} (${BOOK_NAMES[book] || book})`; // brand word (PM Jul 28); internals keep 'squeeze'
  // v1.3: honest state line — tie grace = market's neutral-WP read; oob grace tagged
  const stateLine = deficit === 0
    ? `${trailer} tied it, Q${period} ${clock} (grace read).`
    : oobGrace
      ? `${trailer} down ${deficit}, Q${period} ${clock} (out of band - grace read).`
      : `${trailer} down ${deficit}, Q${period} ${clock}.`;
  // ACA P2 / F5 — cushion provenance gate: fire-state cell rates are averages over all
  // continuations from the FIRE state; by Q4 the live path has spent most of that
  // information (LA@MIN row-1197 lesson: '+13pp cushion' quoted at Q4 2:22 was dishonest).
  const cushionLine = period >= 4
    ? `Price hit your ${fmtOdds(threshold)} line. Fire-state cell rates no longer apply this late - the market re-price is the honest read. Q4 re-entry recipe: down <=3, >=5:00 left, >=+200.`
    : `Price hit your ${fmtOdds(threshold)} line. Implied ${imp}% vs ${cellName} ${cellRate ?? '?'}% (${cushion}).`;
  const lines = [
    cushionLine,
    stateLine,
  ];
  if (posLine) lines.push(posLine);
  if (shapeLine) lines.push(shapeLine); // ACA P2b — live shape confirmation vs fire
  if (resumedAt) lines.push(`Back in band since Q${resumedAt.period} ${resumedAt.clock}.`);
  if (stale) lines.push('Live eFG read unavailable (no snapshot).');
  else {
    if (leaderEfg != null) lines.push(`${leader} lead: ${leaderEfg}% eFG (${leaderBand})${leaderVar != null ? ` - ${leaderVar}% from threes/midrange` : ''}${asOf ? ` (${asOf})` : ''}.`);
    if (trailerEfg != null && trailerTemp) {
      const read = trailerTemp === 'cold' ? 'cold - may not collect' : trailerTemp === 'warm' ? 'room to climb' : 'running hot themselves';
      lines.push(`${trailer} own: ${trailerEfg}% eFG (${trailerTemp}) - ${read}.`);
    }
  }
  if (cautionBlock) lines.push(cautionBlock.trim()); // ACA P2b — pinned kernels (one copy source)
  if (shopLine) lines.push(`Best: ${shopLine}.`);
  lines.push(`Tap opens: ${BOOK_NAMES[book] || book} slip.`);
  lines.push(`${capLine} Your read - not a directive.`);
  return { title, body: lines.join('\n') };
}

async function pushSqueezeAlert(sql, w, g, deficit, best, shopLine, oobGrace = false, resumedAt = null) {
  // Live eFG context — LA@MIN Aug 6 post-mortem (row 1197) rewrote this block:
  //   (a) trailer eFG was DEAD CODE (matched `alias`/`effective_fg_pct` keys that don't
  //       exist in raw_stats_json) — now computed from real short keys, side-matched
  //       via the row's decorated aliases;
  //   (b) 90s freshness on a CUMULATIVE stat dropped the whole read into a poll gap at
  //       the exact fire moment — now: always use the latest snapshot, label age instead;
  //   (c) ss_leader_* consumed without checking ss_leader_alias against the row anchor
  //       (verdict-strip D-7/D-8 bug class) — now guarded, with raw-key fallback.
  let leaderEfg = null, leaderBand = null, leaderVar = null, trailerEfg = null, trailerTemp = null, asOf = null, stale = true, shapeLine = null, cautionBlock = null;
  try {
    const snap = (await sql`SELECT ts, period, clock, ss_leader_alias, ss_leader_efg, ss_leader_efg_band, ss_variance_share, raw_stats_json
      FROM snapshots WHERE game_id = ${w.game_id} ORDER BY ts DESC LIMIT 1`)[0];
    if (snap) {
      stale = false;
      if (Date.now() - new Date(snap.ts).getTime() > 90000) asOf = `read as of Q${snap.period}${snap.clock ? ' ' + snap.clock : ''}`;
      const raw = typeof snap.raw_stats_json === 'string' ? JSON.parse(snap.raw_stats_json) : snap.raw_stats_json;
      const sideOf = (alias) => (alias === w._home ? raw?.home : alias === w._away ? raw?.away : null);
      if (snap.ss_leader_alias === w.leader_alias && snap.ss_leader_efg != null) {
        leaderEfg = Math.round(Number(snap.ss_leader_efg)); leaderBand = snap.ss_leader_efg_band; leaderVar = snap.ss_variance_share;
      } else {
        const le = efgFromRaw(sideOf(w.leader_alias));
        if (le != null) { leaderEfg = Math.round(le); leaderBand = leaderBandOf(le, snap.period); }
      }
      const te = efgFromRaw(sideOf(w.trailer_alias));
      if (te != null) { trailerEfg = Math.round(te); trailerTemp = trailerTempOf(te); }
      // ACA P2b (PM Aug 6) — SHAPE CONFIRMATION: the shape is the decision variable and
      // it can flip between fire and juice (LA@MIN went earned-sticky -> two lead changes).
      // Live computeFuelTemp at juice time + fire-stamp comparison + pinned caution kernels.
      try {
        const _L = { ...(sideOf(w.leader_alias) || {}) };
        _L.pot = _L.pot_v2 != null ? _L.pot_v2 : _L.pot;
        if (snap.ss_leader_alias === w.leader_alias && snap.ss_variance_share != null) _L.vShare = Number(snap.ss_variance_share);
        const _T = { ...(sideOf(w.trailer_alias) || {}) };
        _T.pot = _T.pot_v2 != null ? _T.pot_v2 : _T.pot;
        const _ftNow = computeFuelTemp(_L, _T, Number(snap.period) || 4);
        if (_ftNow && !_ftNow.insufficient) {
          shapeLine = `SHAPE NOW (Q${snap.period} ${snap.clock || ''}): ${_ftNow.fuel} - trailer ${_ftNow.temp}${_ftNow.sticky ? ' [STICKY]' : ''}.`;
          const _ff = w._fuelTemp; // fire-time stamp (already parsed by the arm loop)
          if (_ff && !_ff.insufficient) {
            const _changed = _ff.fuel !== _ftNow.fuel || !!_ff.sticky !== !!_ftNow.sticky;
            shapeLine += _changed
              ? ` At fire: ${_ff.fuel} - trailer ${_ff.temp}${_ff.sticky ? ' [STICKY]' : ''} - SHAPE HAS CHANGED.`
              : ' Unchanged since fire.';
          }
          cautionBlock = ssCautionLines(_ftNow) || null;
        }
      } catch (e) { /* non-fatal — juice goes out without the shape read */ }
    }
  } catch (e) { log(`snap ctx fail ${e.message}`); }
  const killer = !!w.leader_killer;
  // ACA P2 — real tier caps at the decision point (was a literal placeholder), lane-aware
  const capLine = w.alert_subtype === 'EFG_FADE' ? '$1,400 cap (A-tier). Staged adds = one position vs cap.'
    : (w.alert_subtype === 'EFG_FADE_SOFT' || /^B\d$/.test(w.alert_subtype || '')) ? '$600 cap (B-tier). Staged adds = one position vs cap.'
    : w.trailer_lane ? '$300 cap - LANE team: $600 if declared before entry. Staged adds = one position vs cap.'
    : '$300 cap (WATCHLIST). Staged adds = one position vs cap.';
  // ACA P2 — open-position awareness (isolated SELECT; only sees bets logged at entry)
  let posLine = null;
  try {
    const _ob = (await sql`SELECT side, stake, odds FROM bets WHERE game_id = ${w.game_id} AND result = 'PENDING' ORDER BY id DESC LIMIT 1`)[0];
    if (_ob) posLine = `You hold ${_ob.side} $${_ob.stake} @ ${Number(_ob.odds) > 0 ? '+' + _ob.odds : _ob.odds} - this alert is an ADD against the same position cap.`;
  } catch (e) { /* non-fatal */ }
  const { title, body } = composeSqueeze({
    trailer: w.trailer_alias, leader: w.leader_alias, price: best.price, book: best.book,
    threshold: w.squeeze_threshold, cellRate: killer ? 67 : 53, cellName: killer ? 'killer cell' : 'no-scalp cell',
    deficit, period: g.period, clock: g.clock, leaderEfg, leaderBand, leaderVar, trailerEfg, trailerTemp, asOf,
    capLine, shopLine, stale, oobGrace, resumedAt, posLine, shapeLine, cautionBlock,
  });
  await sendNtfy(title, body, 5, best.link);
}

// ── auto-arm scan: every pushed tier arms itself; ledger/brief rows never do ──
async function autoArm(sql) {
  if (process.env.WNBA_SQUEEZE_AUTOARM === '0') return 0;
  const rows = await sql`
    SELECT id, alert_subtype, leader_killer, line_used, edge FROM sweetspot_alerts
    WHERE league = ${LEAGUE} AND alert_subtype = ANY(${PUSHED_SUBTYPES})
      AND ntfy_sent IS TRUE AND (resolved IS NOT TRUE)
      AND squeeze_armed IS NULL
      AND created_at > NOW() - INTERVAL '3 hours'`;
  for (const r of rows) {
    const thr = pickThreshold(r);
    await sql`UPDATE sweetspot_alerts SET squeeze_armed = TRUE,
      squeeze_threshold = ${thr}::int, squeeze_expires_at = NOW() + INTERVAL '3 hours'
      WHERE id = ${r.id}`;
    log(`auto-armed row ${r.id} (${r.alert_subtype}${r.leader_killer ? ' killer' : ''}) threshold ${thr}`);
  }
  return rows.length;
}

async function loadWatches(sql) {
  const rows = await sql`
    SELECT sa.id, sa.game_id, sa.leader_alias, sa.trailer_alias, sa.leader_killer, sa.alert_subtype, sa.trailer_lane,
           sa.squeeze_threshold, sa.squeeze_last_alert_price, sa.squeeze_alert_count,
           sa.squeeze_expires_at, sa.squeeze_state, sa.player_ctx_json, sa.line_used,
           g.home_alias AS _home, g.away_alias AS _away
    FROM sweetspot_alerts sa JOIN games g ON g.id = sa.game_id
    WHERE sa.league = ${LEAGUE} AND sa.squeeze_armed IS TRUE AND (sa.resolved IS NOT TRUE)`;
  const live = [];
  for (const w of rows) {
    if (w.squeeze_expires_at && new Date(w.squeeze_expires_at) < new Date()) { await disarm(sql, w, 'ttl'); continue; }
    if (typeof w.squeeze_state === 'string') { try { w.squeeze_state = JSON.parse(w.squeeze_state); } catch { w.squeeze_state = {}; } }
    // DS v1 C3 — fire-time fuel/temp stamp (C1). Cold-at-fire is the surge gate.
    try {
      const pcx = typeof w.player_ctx_json === 'string' ? JSON.parse(w.player_ctx_json) : w.player_ctx_json;
      w._fuelTemp = (pcx && pcx.fuelTemp && !pcx.fuelTemp.insufficient) ? pcx.fuelTemp : null;
    } catch { w._fuelTemp = null; }
    delete w.player_ctx_json; // parsed; keep watch objects lean
    live.push(w);
  }
  // max one watch per game: keep newest, disarm elders
  const byGame = {};
  for (const w of live.sort((a, b) => b.id - a.id)) {
    if (byGame[w.game_id]) { await disarm(sql, w, 'superseded'); continue; }
    byGame[w.game_id] = w;
  }
  return Object.values(byGame);
}

// ── DS v1 C3 — open positions map: game_id → side-first-token → {stake, payout}.
//    Staged entries sum into ONE position (tiered-sizing convention). One query per
//    invocation; the surge tip needs stake (profit-lock test) + payout (cash estimate).
async function loadOpenPositions(sql) {
  const out = {};
  try {
    const rows = await sql`SELECT game_id, side, stake, odds FROM bets
      WHERE league = ${LEAGUE} AND game_id IS NOT NULL AND result = ${'PENDING'}`;
    for (const b of rows) {
      const side = String(b.side || '').split(/\s+/)[0];
      if (!side) continue;
      const stk = Number(b.stake) || 0;
      const dec = b.odds != null ? (Number(b.odds) > 0 ? 1 + Number(b.odds) / 100 : 1 + 100 / (-Number(b.odds))) : 1;
      const g = (out[b.game_id] = out[b.game_id] || {});
      const p = (g[side] = g[side] || { stake: 0, payout: 0 });
      p.stake += stk; p.payout += stk * dec;
    }
  } catch (e) { log(`open positions: ${e.message}`); }
  return out;
}

// ── TEST MODE: real odds, real link, fixture alert. Prefers a Caesars deep link
//    per validation request; falls back to best-price book's link. ──
async function testAlert(sql) {
  const events = await fetchOdds();
  if (!events || !events.length) return { ok: false, error: 'no odds events (offseason/break gap?)' };
  const ev = events[0];
  const homeA = aliasFromName(ev.home_team), awayA = aliasFromName(ev.away_team);
  // pick the plus-money side as the fixture "trailer"
  const b1 = bestPrice(ev, homeA), b2 = bestPrice(ev, awayA);
  const dogAlias = implied(b1?.price ?? 0) < implied(b2?.price ?? 0) ? homeA : awayA;
  const favAlias = dogAlias === homeA ? awayA : homeA;
  const best = dogAlias === homeA ? b1 : b2;
  // Caesars link preference for the validation tap
  let caesars = null;
  for (const bk of ev.bookmakers || []) if (bk.key === 'williamhill_us')
    for (const m of bk.markets || []) if (m.key === 'h2h')
      for (const o of m.outcomes || []) if (aliasFromName(o.name) === dogAlias)
        caesars = { price: o.price, apiLink: fixLink(o.link || m.link || bk.link) || null };
  const link = caesars?.apiLink || best.link;
  const { title, body } = composeSqueeze({
    trailer: dogAlias, leader: favAlias, price: best.price, book: best.book,
    threshold: NONKILLER_THRESHOLD, cellRate: 53, cellName: 'no-scalp cell',
    deficit: 4, period: 3, clock: '6:45', leaderEfg: 61.2, leaderBand: 'orange', leaderVar: 55,
    trailerEfg: 51.4, capLine: 'TEST ALERT - fixture game state, live prices/link.',
    shopLine: topThreeLine(ev, dogAlias), stale: false,
  });
  await sendNtfy('TEST ' + title, body + '\n(tap to validate deep link)', 4, link);
  return {
    ok: true, event: `${ev.away_team} @ ${ev.home_team}`, dog: dogAlias,
    best: `${fmtOdds(best.price)} @ ${best.book}`,
    caesars_price: caesars ? fmtOdds(caesars.price) : 'absent',
    caesars_api_link: caesars?.apiLink || 'NONE - api returned no caesars link',
    link_used: link, link_source: caesars?.apiLink ? 'caesars-api' : (best.link === BOOK_LINKS[best.book] ? 'fallback-map' : 'best-book-api'),
  };
}

export default async (req) => {
  try {
  const url = new URL(req.url);
  const test = url.searchParams.get('test') === '1';
  const dry = url.searchParams.get('dry') === '1';
  const sql = neon(process.env.DATABASE_URL);
  if (process.env.WNBA_SQUEEZE_ON === '0' && !test && !dry)
    return Response.json({ ok: true, skipped: 'WNBA_SQUEEZE_ON=0' });
  if (test) return Response.json(await testAlert(sql));

  // cycle lock (concurrency rule: any await >1s needs a DB lock)
  const got = await sql`INSERT INTO job_locks (job, ts) VALUES ('odds_squeeze', NOW())
    ON CONFLICT (job) DO UPDATE SET ts = NOW() WHERE job_locks.ts < NOW() - INTERVAL '50 seconds'
    RETURNING job`;
  if (!got.length && !dry) return Response.json({ ok: true, skipped: 'locked' });

  await autoArm(sql);
  const watches = await loadWatches(sql);
  if (!watches.length) return Response.json({ ok: true, watches: 0 });

  const openBets = await loadOpenPositions(sql); // DS v1 C3 — one query per invocation
  const espn1 = await fetchEspnState();
  const p1 = await samplePass(sql, watches, espn1, null, dry, openBets);
  if (dry) return Response.json({ ok: true, dry: true, pass1: p1.results });
  await new Promise((r) => setTimeout(r, 30000));
  const espn2 = await fetchEspnState();
  const p2 = await samplePass(sql, watches, espn2, null, dry, openBets);
  return Response.json({ ok: true, watches: watches.length, pass1: p1.results, pass2: p2.results });
  } catch (e) {
    console.log('[squeeze] handler crash:', e.message, e.stack);
    return Response.json({ ok: false, crash: e.message, at: (e.stack || '').split('\n')[1] || '' });
  }
};

// ── SCHEDULE CONFIG ─────────────────────────────────────────────────────────
export const config = {
  schedule: "*/1 * * * *", // every 1 min; double-sample inside = true 30s cadence
};
