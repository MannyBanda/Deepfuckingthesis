// Find specific games — paste in console
(async () => {
  const BASE = '/.netlify/functions/db-api';
  const OPTS = { credentials: 'include' };
  const api = (p) => fetch(`${BASE}?${new URLSearchParams(p)}`, OPTS).then(r => r.json());

  const targets = ['SAC','GSW','POR','DEN','LAC','MIA','CHA','ORL','DET','MIN'];
  const { games } = await api({ action: 'get_games', league: 'nba' });
  const matches = games.filter(g => {
    const ha = g.home_alias, aa = g.away_alias;
    return (targets.includes(ha) && targets.includes(aa));
  });

  // Also get snapshot counts
  const diag = await api({ action: 'snapshot_diagnostic' });
  const diagMap = {};
  (diag.games || diag).forEach(d => { diagMap[d.game_id] = d; });

  console.log('%cTarget games found:', 'color: cyan; font-weight: bold');
  for (const g of matches) {
    const d = diagMap[g.id];
    const snaps = d ? `${d.server_snaps} server snaps` : 'no snap data';
    console.log(`  ${g.date} | ${g.away_alias}@${g.home_alias} | ${g.winner || '?'} won by ${Math.abs(g.margin || 0)} | ID: ${g.id} | ${snaps}`);
  }
})();
