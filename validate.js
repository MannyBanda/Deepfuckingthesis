#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// NBA Control Dashboard — Pre-Deploy Validation
// Run: node validate.js
// Checks index.html JS for syntax errors and backtick parity before deploy.
// ══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const INDEX = path.join(__dirname, 'index.html');
const FUNCTIONS_DIR = path.join(__dirname, 'netlify', 'functions');

let errors = 0;
let warnings = 0;

function pass(msg) { console.log('\x1b[32m  ✓\x1b[0m ' + msg); }
function fail(msg) { console.log('\x1b[31m  ✗\x1b[0m ' + msg); errors++; }
function warn(msg) { console.log('\x1b[33m  ⚠\x1b[0m ' + msg); warnings++; }

console.log('\n\x1b[1mNBA Control — Pre-Deploy Validation\x1b[0m\n');

// ── 1. Check index.html exists ──
if (!fs.existsSync(INDEX)) {
  fail('index.html not found');
  process.exit(1);
}
pass('index.html found');

const html = fs.readFileSync(INDEX, 'utf8');
const lines = html.split('\n');

// ── 2. Extract inline JS and check syntax ──
console.log('\n\x1b[1mJS Syntax Check\x1b[0m');

const scriptBlocks = [];
let inScript = false, scriptStart = 0, scriptLines = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === '<script>') {
    inScript = true;
    scriptStart = i + 1;
    scriptLines = [];
  } else if (lines[i].trim() === '</script>' && inScript) {
    inScript = false;
    scriptBlocks.push({ start: scriptStart, end: i, code: scriptLines.join('\n') });
  } else if (inScript) {
    scriptLines.push(lines[i]);
  }
}

let jsOk = true;
for (const block of scriptBlocks) {
  const tmp = '/tmp/nba_validate_' + block.start + '.js';
  fs.writeFileSync(tmp, block.code);
  try {
    execSync('node --check ' + tmp, { stdio: 'pipe' });
    pass('Script block L' + block.start + '-L' + block.end + ' (' + (block.end - block.start) + ' lines) — syntax OK');
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    // Parse the line number from node --check output and map to index.html line
    const match = stderr.match(/:(\d+)/);
    const jsLine = match ? parseInt(match[1]) : '?';
    const htmlLine = typeof jsLine === 'number' ? jsLine + block.start : '?';
    fail('Script block L' + block.start + '-L' + block.end + ' — SYNTAX ERROR at index.html L' + htmlLine);
    console.log('    ' + stderr.trim().split('\n').slice(0, 4).join('\n    '));
    jsOk = false;
  }
  try { fs.unlinkSync(tmp); } catch(e) {}
}

// ── 3. Backtick parity check ──
console.log('\n\x1b[1mBacktick Parity\x1b[0m');

// Check per script block (more useful than whole-file)
for (const block of scriptBlocks) {
  const ticks = (block.code.match(/`/g) || []).length;
  if (ticks % 2 !== 0) {
    fail('Script block L' + block.start + '-L' + block.end + ' — ' + ticks + ' backticks (ODD — unmatched template literal!)');
    // Try to find the problematic area
    const blockLines = block.code.split('\n');
    let depth = 0;
    for (let i = 0; i < blockLines.length; i++) {
      const lineTicks = (blockLines[i].match(/`/g) || []).length;
      depth += lineTicks;
      if (i === blockLines.length - 1 && depth % 2 !== 0) {
        warn('  Backtick imbalance begins around L' + (block.start + i) + ' in index.html');
      }
    }
  } else {
    pass('Script block L' + block.start + '-L' + block.end + ' — ' + ticks + ' backticks (even ✓)');
  }
}

// ── 4. Template literal ${} inside template literal check ──
console.log('\n\x1b[1mNested Template Literal Safety\x1b[0m');

let nestedCount = 0;
for (const block of scriptBlocks) {
  const blockLines = block.code.split('\n');
  for (let i = 0; i < blockLines.length; i++) {
    const line = blockLines[i];
    const ticks = (line.match(/`/g) || []).length;
    const interps = (line.match(/\$\{/g) || []).length;
    // Flag lines with 3+ backticks and interpolations as high-risk
    if (ticks >= 3 && interps >= 1) {
      nestedCount++;
      if (nestedCount <= 3) {
        warn('L' + (block.start + i) + ': ' + ticks + ' backticks + ' + interps + ' interpolation(s) — nested template literal risk');
      }
    }
  }
}
if (nestedCount > 3) warn('... and ' + (nestedCount - 3) + ' more similar lines');
if (nestedCount === 0) pass('No high-risk nested template literal lines found');

// ── 5. Netlify functions syntax check ──
console.log('\n\x1b[1mNetlify Functions\x1b[0m');

if (fs.existsSync(FUNCTIONS_DIR)) {
  const fns = fs.readdirSync(FUNCTIONS_DIR).filter(f => f.endsWith('.js'));
  for (const fn of fns) {
    const fnPath = path.join(FUNCTIONS_DIR, fn);
    try {
      execSync('node --check ' + fnPath, { stdio: 'pipe' });
      pass(fn + ' — syntax OK');
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString() : '';
      fail(fn + ' — SYNTAX ERROR');
      console.log('    ' + stderr.trim().split('\n').slice(0, 3).join('\n    '));
    }
  }
} else {
  warn('netlify/functions/ directory not found');
}

// ── 6. Critical function existence check ──
console.log('\n\x1b[1mCritical Functions\x1b[0m');

const criticalFns = ['loadSchedule', 'renderPills', 'renderCard', 'compute', 'computeBDL',
  'buildTrajectory', 'triggerAnalysis', 'fetchPBP', 'parsePBP', 'enrichFromBDL',
  'renderConfidenceTable', 'getState', 'mountCard', 'sr', 'fetchSummary'];

const mainBlock = scriptBlocks.find(b => b.end - b.start > 100);
if (mainBlock) {
  for (const fn of criticalFns) {
    const pattern = new RegExp('(function\\s+' + fn + '|const\\s+' + fn + '\\s*=|var\\s+' + fn + '\\s*=|let\\s+' + fn + '\\s*=)');
    if (pattern.test(mainBlock.code)) {
      pass(fn + '() defined');
    } else {
      fail(fn + '() NOT FOUND — dashboard will break');
    }
  }
} else {
  warn('Could not identify main script block');
}

// ── 7. Boot canary check ──
console.log('\n\x1b[1mBoot Diagnostics\x1b[0m');

if (html.includes('window.__nbaBooted')) pass('Boot canary present');
else warn('Boot canary (window.__nbaBooted) not found — silent failures possible');

if (html.includes('window.onerror')) pass('Global error handler present');
else warn('Global error handler (window.onerror) not found');

// ── Summary ──
console.log('\n' + '═'.repeat(50));
if (errors > 0) {
  console.log('\x1b[31m  ✗ FAILED: ' + errors + ' error(s), ' + warnings + ' warning(s)\x1b[0m');
  console.log('  DO NOT DEPLOY until errors are resolved.\n');
  process.exit(1);
} else if (warnings > 0) {
  console.log('\x1b[33m  ⚠ PASSED with ' + warnings + ' warning(s)\x1b[0m');
  console.log('  Review warnings before deploying.\n');
} else {
  console.log('\x1b[32m  ✓ ALL CHECKS PASSED\x1b[0m');
  console.log('  Safe to deploy.\n');
}
