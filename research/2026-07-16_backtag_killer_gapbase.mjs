// KILLER_FLAG_SPEC §3 — one-off back-tag of resolved GAP_BASE rows with
// leader_killer/leader_scalps computed AS-OF each row's fire date (eval-date
// semantics: elite membership as of the fire date, scalps = leader's season
// wins vs that membership before the fire date). Run once post-§2 init.
//   node research/2026-07-16_backtag_killer_gapbase.mjs [--dry]
import { computeKillerFields } from '../netlify/functions/team-profiles-nightly.mjs';
const BASE = process.env.DFT_BASE || 'https://poetic-starlight-aa8938.netlify.app';
const AUTH = 'Basic ' + Buffer.from('manny:DFT2025!').toString('base64');
const DRY = process.argv.includes('--dry');
const api = async (p, opts = {}) => {
  const r = await fetch(`${BASE}/.netlify/functions/db-api?${p}`, { headers: { Authorization: AUTH, 'Content-Type': 'application/json' }, ...opts });
  return r.json();
};
const alerts = (await api('action=get_sweetspot_alerts&limit=100&league=wnba')).sweetspot_alerts || [];
const gaps = alerts.filter((a) => a.alert_subtype === 'GAP_BASE');
console.log(`GAP_BASE rows: ${gaps.length}`);
let tagged = 0;
for (const a of gaps) {
  const fireDate = String(a.created_at).slice(0, 10);
  const leader = a.leader_alias || a.leader;
  if (!leader) { console.log(`  row ${a.id}: no leader field — skipped`); continue; }
  const rows = (await api(`action=get_team_game_stats&league=wnba&season=2026&max_date=${fireDate}`)).team_game_stats || [];
  // exclude games ON the fire date (strictly before — matches spot-pool semantics)
  const kf = computeKillerFields(rows.filter((r) => String(r.date).slice(0, 10) < fireDate));
  const k = kf[leader] || { killer: { flag: null, scalps: null } };
  console.log(`  row ${a.id} ${fireDate} leader=${leader} -> killer=${k.killer.flag} scalps=${k.killer.scalps} (resolved=${a.resolved}, trailer_won=${a.trailer_won})`);
  if (!DRY) {
    const res = await api('action=update_ss_killer', { method: 'POST', body: JSON.stringify({ id: a.id, leader_killer: k.killer.flag, leader_scalps: k.killer.scalps }) });
    if (res.ok) tagged++;
  }
}
console.log(`${DRY ? '(dry) ' : ''}tagged ${tagged}/${gaps.length}`);
