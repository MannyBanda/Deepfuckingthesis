// ═══════════════════════════════════════════════════════════
// AUTO-BATCH BACKTEST SNAPSHOT RE-RUN
// Follows the nextStep chain automatically, then runs compute
// Paste in browser console on the live site
// ═══════════════════════════════════════════════════════════
void 0; {

const BATCH_SIZE = 8;
const START_OFFSET = 0;
const BASE = '/.netlify/functions/backtest-nba-snapshots';
const OPTS = { credentials: 'include' };
const PAUSE_MS = 2000;

(async () => {
  console.log('%c═══ AUTO-BATCH SNAPSHOT RE-RUN ═══', 'color: gold; font-size: 16px; font-weight: bold');

  let nextUrl = `${BASE}?phase=snapshot&force=1&n=${BATCH_SIZE}&offset=${START_OFFSET}`;
  let totalDone = 0;
  let totalFailed = 0;
  let batchNum = 0;
  let retries = 0;
  const MAX_RETRIES = 3;

  while (nextUrl && nextUrl.includes('phase=snapshot')) {
    batchNum++;

    try {
      const start = Date.now();
      console.log(`  Batch ${batchNum}: ${nextUrl.split('?')[1]}`);
      const resp = await fetch(nextUrl, OPTS);

      if (!resp.ok) {
        retries++;
        console.log(`%c  ❌ HTTP ${resp.status}`, 'color: red');
        if (retries >= MAX_RETRIES) {
          console.log('%c  Max retries hit — stopping', 'color: red');
          break;
        }
        await new Promise(r => setTimeout(r, 5000));
        continue; // retry same URL
      }

      retries = 0;
      const data = await resp.json();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      if (data.message === 'No more games to snapshot') {
        console.log(`%c  ✅ All games done!`, 'color: lime; font-weight: bold');
        nextUrl = null;
        break;
      }

      totalDone += data.gamesDone || 0;
      totalFailed += data.failed || 0;

      console.log(
        `  ✅ ${data.gamesDone} done, ${data.failed} failed (${elapsed}s) | ` +
        `Remaining: ${data.remainingGames} | Total: ${totalDone}`
      );

      // Follow the nextStep chain
      if (data.nextStep && data.nextStep.includes('phase=snapshot')) {
        nextUrl = `${BASE}${data.nextStep}`;
      } else {
        console.log(`%c  ✅ Snapshot phase complete — next: ${data.nextStep}`, 'color: lime; font-weight: bold');
        nextUrl = null;
      }

      await new Promise(r => setTimeout(r, PAUSE_MS));

    } catch (err) {
      retries++;
      console.log(`%c  ❌ ${err.message}`, 'color: red');
      if (retries >= MAX_RETRIES) {
        console.log('%c  Max retries hit — stopping', 'color: red');
        break;
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log(`%c\n═══ SNAPSHOT PHASE COMPLETE ═══`, 'color: gold; font-size: 14px; font-weight: bold');
  console.log(`Processed: ${totalDone} | Failed: ${totalFailed} | Batches: ${batchNum}`);

  // Now run compute phase automatically
  console.log('%c\nStarting compute phase...', 'color: cyan; font-weight: bold');

  let computeUrl = `${BASE}?phase=compute&force=1`;
  let computeBatch = 0;

  while (computeUrl && computeUrl.includes('phase=compute')) {
    computeBatch++;
    try {
      console.log(`  Compute batch ${computeBatch}...`);
      const resp = await fetch(computeUrl, OPTS);
      if (!resp.ok) {
        console.log(`%c  ❌ Compute HTTP ${resp.status}`, 'color: red');
        break;
      }
      const data = await resp.json();
      console.log(`  ✅ Computed: ${data.computed || data.gamesComputed || '?'} games`);

      if (data.remaining === 0 || data.message === 'Nothing to compute') {
        console.log('%c  ✅ Compute complete!', 'color: lime; font-weight: bold');
        break;
      }

      // Follow nextStep if available
      if (data.nextStep && data.nextStep.includes('phase=compute')) {
        computeUrl = `${BASE}${data.nextStep}`;
      } else {
        break;
      }

      await new Promise(r => setTimeout(r, PAUSE_MS));
    } catch (err) {
      console.log(`%c  ❌ Compute error: ${err.message}`, 'color: red');
      break;
    }
  }

  console.log(`%c\n═══ ALL DONE ═══`, 'color: gold; font-size: 16px; font-weight: bold');
  console.log('Run the report:');
  console.log(`${window.location.origin}${BASE}?phase=report_tier_journey&close=1`);
})();

}
