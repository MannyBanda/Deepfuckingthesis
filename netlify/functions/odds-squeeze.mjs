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
// per-row threshold: dynamic (row's own predicted p - 5pp) for non-killer A-tiers;
// killer cell -150 (wider net, PM Jul 22); +117 derived breakeven otherwise
export const pickThreshold = (row) => {
  if (row.leader_killer) return KILLER_THRESHOLD;
  if (row.alert_subtype === 'EFG_FADE' && row.line_used != null && row.edge != null) {
    const p = implied(Number(row.line_used)) + Number(row.edge);
    return probToAmerican(p - 0.05);
  }
  return NONKILLER_THRESHOLD;
};
export const bandOf = (efg) => (efg == null ? null : efg >= 65 ? 'red' : efg >= 56 ? 'orange' : 'green');

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
async function samplePass(sql, watches, espn, events, dry) {
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
    let oob = st.oob_count || 0;
    if (deficit < 1 || deficit > 9) { oob += 1; } else { oob = 0; }
    if (oob >= 3) { await disarm(sql, w, 'band-exit'); res.action = 'disarm'; res.reason = 'band-exit'; continue; }
    if (deficit < 1 || deficit > 9) {
      res.reason = `oob(${deficit}) strike ${oob}`;
      await saveState(sql, w, { ...st, last_clock: g.clock, last_period: g.period, oob_count: oob });
      continue;
    }

    if (!odds) odds = await fetchOdds();
    if (!odds) { res.reason = 'odds-fail'; continue; }
    const ev = odds.find((e) => {
      const k = [aliasFromName(e.home_team), aliasFromName(e.away_team)].sort().join('|');
      return k === key;
    });
    if (!ev) { res.reason = 'no-odds-event'; continue; }

    const best = bestPrice(ev, w.trailer_alias);
    if (!best) { res.reason = 'no-trailer-price'; continue; }

    // tape: every live sample writes odds_history (30s price tape on armed windows)
    const homeBest = bestPrice(ev, w._home), awayBest = bestPrice(ev, w._away);
    if (!dry) await sql`INSERT INTO odds_history (game_id, home_ml, away_ml, source)
      VALUES (${w.game_id}, ${homeBest?.price ?? null}, ${awayBest?.price ?? null}, ${'squeeze:' + best.book})`;

    res.best = `${fmtOdds(best.price)} ${best.book}`;
    const crossed = implied(best.price) <= implied(w.squeeze_threshold);
    const rearmOk = w.squeeze_last_alert_price == null ||
      implied(w.squeeze_last_alert_price) - implied(best.price) >= REARM_IMPLIED_DROP;
    if (!crossed) { res.reason = 'below-threshold'; }
    else if (!rearmOk) { res.reason = 'rearm-wait'; }
    else if ((w.squeeze_alert_count || 0) >= MAX_ALERTS_PER_ARM) { await disarm(sql, w, 'max-alerts'); res.action = 'disarm'; res.reason = 'max-alerts'; }
    else {
      res.action = dry ? 'WOULD-ALERT' : 'ALERT';
      if (!dry) {
        await pushSqueezeAlert(sql, w, g, deficit, best, topThreeLine(ev, w.trailer_alias));
        await sql`UPDATE sweetspot_alerts SET squeeze_last_alert_price = ${best.price},
          squeeze_alert_count = COALESCE(squeeze_alert_count,0) + 1 WHERE id = ${w.id}`;
      }
    }
    await saveState(sql, w, { ...st, last_clock: g.clock, last_period: g.period, oob_count: 0 });
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
export function composeSqueeze({ trailer, leader, price, book, threshold, cellRate, cellName, deficit, period, clock, leaderEfg, leaderBand, leaderVar, trailerEfg, capLine, shopLine, stale }) {
  const imp = Math.round(implied(price) * 100);
  const cushion = cellRate ? `${cellRate - imp >= 0 ? '+' : ''}${cellRate - imp}pp` : 'n/a';
  const title = `SQUEEZE: ${trailer} ${fmtOdds(price)} (${BOOK_NAMES[book] || book})`;
  const lines = [
    `Price hit your ${fmtOdds(threshold)} line. Implied ${imp}% vs ${cellName} ${cellRate ?? '?'}% (${cushion}).`,
    `${trailer} down ${deficit}, Q${period} ${clock}.`,
  ];
  if (stale) lines.push('Live eFG read unavailable (stale snapshot).');
  else {
    lines.push(`${leader} lead: ${leaderEfg}% eFG (${leaderBand})${leaderVar != null ? ` - ${leaderVar}% from threes/midrange` : ''}.`);
    if (trailerEfg != null) {
      const tb = bandOf(trailerEfg);
      const read = trailerEfg < 45 ? 'cold - may not collect' : tb === 'green' ? 'room to climb' : 'running hot themselves';
      lines.push(`${trailer} own: ${trailerEfg}% eFG (${tb}) - ${read}.`);
    }
  }
  if (shopLine) lines.push(`Best: ${shopLine}.`);
  lines.push(`Tap opens: ${BOOK_NAMES[book] || book} slip.`);
  lines.push(`${capLine} Your read - not a directive.`);
  return { title, body: lines.join('\n') };
}

async function pushSqueezeAlert(sql, w, g, deficit, best, shopLine) {
  // live eFG context from latest snapshot (NULL-degrade beyond 60s)
  let leaderEfg = null, leaderBand = null, leaderVar = null, trailerEfg = null, stale = true;
  try {
    const snap = (await sql`SELECT ts, ss_leader_alias, ss_leader_efg, ss_leader_efg_band, ss_variance_share, raw_stats_json
      FROM snapshots WHERE game_id = ${w.game_id} ORDER BY ts DESC LIMIT 1`)[0];
    if (snap && Date.now() - new Date(snap.ts).getTime() <= 90000) {
      stale = false;
      leaderEfg = snap.ss_leader_efg; leaderBand = snap.ss_leader_efg_band; leaderVar = snap.ss_variance_share;
      const raw = typeof snap.raw_stats_json === 'string' ? JSON.parse(snap.raw_stats_json) : snap.raw_stats_json;
      for (const side of ['home', 'away']) {
        const t = raw?.[side]; const stx = t?.statistics || t || {};
        if (t?.alias === w.trailer_alias) trailerEfg = Number(stx.effective_fg_pct) || null;
      }
    }
  } catch (e) { log(`snap ctx fail ${e.message}`); }
  const killer = !!w.leader_killer;
  const { title, body } = composeSqueeze({
    trailer: w.trailer_alias, leader: w.leader_alias, price: best.price, book: best.book,
    threshold: w.squeeze_threshold, cellRate: killer ? 67 : 53, cellName: killer ? 'killer cell' : 'no-scalp cell',
    deficit, period: g.period, clock: g.clock, leaderEfg, leaderBand, leaderVar, trailerEfg,
    capLine: `Cap per tier rules.`, shopLine, stale,
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
    SELECT sa.id, sa.game_id, sa.leader_alias, sa.trailer_alias, sa.leader_killer,
           sa.squeeze_threshold, sa.squeeze_last_alert_price, sa.squeeze_alert_count,
           sa.squeeze_expires_at, sa.squeeze_state,
           g.home_alias AS _home, g.away_alias AS _away
    FROM sweetspot_alerts sa JOIN games g ON g.id = sa.game_id
    WHERE sa.league = ${LEAGUE} AND sa.squeeze_armed IS TRUE AND (sa.resolved IS NOT TRUE)`;
  const live = [];
  for (const w of rows) {
    if (w.squeeze_expires_at && new Date(w.squeeze_expires_at) < new Date()) { await disarm(sql, w, 'ttl'); continue; }
    if (typeof w.squeeze_state === 'string') { try { w.squeeze_state = JSON.parse(w.squeeze_state); } catch { w.squeeze_state = {}; } }
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

  const espn1 = await fetchEspnState();
  const p1 = await samplePass(sql, watches, espn1, null, dry);
  if (dry) return Response.json({ ok: true, dry: true, pass1: p1.results });
  await new Promise((r) => setTimeout(r, 30000));
  const espn2 = await fetchEspnState();
  const p2 = await samplePass(sql, watches, espn2, null, dry);
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
