// Records research/fixtures_squeeze_wnba_goldens.json from the CURRENT odds-squeeze module.
// Run ONCE against the untouched module (Commit A); never re-run after the refactor —
// research/squeeze_league_fixtures.mjs replays and compares instead (NBA_JUICE_SPEC §10 [0]).
import { writeFileSync } from 'fs';
import * as mod from '../netlify/functions/odds-squeeze.mjs';
import { runAll } from './squeeze_trace_runner.mjs';
const g = await runAll(mod);
writeFileSync('research/fixtures_squeeze_wnba_goldens.json', JSON.stringify(g, null, 1));
const n = Object.keys(g.samplePass).length;
const pushes = Object.values(g.samplePass).reduce((a, s) => a + s.trace.filter((t) => t.fetch && t.fetch.includes('ntfy')).length, 0);
const writes = Object.values(g.samplePass).reduce((a, s) => a + s.trace.filter((t) => t.sql && /^(INSERT|UPDATE)/.test(t.sql)).length, 0);
console.log(`goldens: ${n} samplePass scenarios (${pushes} pushes, ${writes} writes), armLoad ${g.armLoad.trace.length} queries, pure ${Object.keys(g.pure).length} groups`);
