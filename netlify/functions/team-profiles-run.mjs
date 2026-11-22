// ═══════════════════════════════════════════════════════════════════════════════
// team-profiles-run.mjs — manual trigger for the nightly team-profiles job (Nov 21).
// Netlify 403s external HTTP calls to SCHEDULED functions (hotfix #15), which turned every
// manual run into the comment-out-the-schedule drill. This UNSCHEDULED twin bundles the same
// handler, so a dry run or re-run is one URL. Same params as the nightly (?dry=1, ?nba_season=,
// ?wnba=1, ?backfill=1&from=…); tags the run trigger=manual. No config export → not scheduled.
// ═══════════════════════════════════════════════════════════════════════════════
import handler from './team-profiles-nightly.mjs';

export default async (req) => {
  const u = new URL(req.url, 'https://localhost');
  u.searchParams.set('trigger', 'manual');
  return handler(new Request(u.toString(), { method: 'GET' }));
};
