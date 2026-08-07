#!/usr/bin/env node
/* =============================================================================
 * bake_ec_budget_snapshot.js  —  AM Control Centre · Budget Burn tab
 * -----------------------------------------------------------------------------
 * Re-bakes  data/ec_budget_snapshot.json , the committed FALLBACK the Budget Burn
 * tab shows when the live EC ledger CSV is unreachable.
 *
 * CANONICAL COPY: github.com/makiramen/ops -> builders/bake_ec_budget_snapshot.js
 * (raw.githubusercontent is reachable from the sandbox, so a scheduled run can
 *  curl this file with no Mac and no Chrome. A mirror sits on the Mac at
 *  am_rebuild/builders/ for consistency with the other builders — the repo copy
 *  is the one that runs.)
 *
 * WHY IT IS SAFE
 * The tab's load chain is:   snapshot -> DATA ; applySheetRows(liveCSVrows) ;
 * renderBudget(). renderBudget's mutators (seedWeekBudgets / applyStandingBudgets /
 * applyBudgetOverride) run at RENDER time and are deliberately NOT baked in — the
 * snapshot is the state after applySheetRows and before any render. This script
 * reproduces exactly that point, so the committed fallback always equals what a
 * live load would have produced.
 *
 * ZERO-DRIFT GUARD
 * The parse + applySheetRows logic is NOT reimplemented here. It is extracted
 * verbatim from the live index.html at run time and evaluated, so the bake can
 * never diverge from what the tab itself does. The pinned hashes below only exist
 * so a human is TOLD when that logic moves; a hash change is a warning, not a
 * failure, and the run proceeds on the live logic.
 *
 * USAGE
 *   node bake_ec_budget_snapshot.js --csv <ledger.csv> [options]
 *     --csv       <path>  REQUIRED. EC Daily Spend Ledger exported as CSV.
 *     --index     <path>  live index.html (default: fetch from raw.githubusercontent)
 *     --seed      <path>  seed snapshot   (default: fetch from raw.githubusercontent)
 *     --out       <path>  output          (default: ./ec_budget_snapshot.json)
 *     --check             bake and DIFF against the seed, write nothing. Exit 0 if
 *                         identical (ignoring meta.generated_at), 20 if changed.
 * Exit codes: 0 ok/no-change · 20 --check found a change · 1 hard failure.
 * ========================================================================== */

process.env.TZ = 'UTC';
const fs = require('fs');
const vm = require('vm');

const RAW = 'https://raw.githubusercontent.com/makiramen/ops/main';
const PINNED = {
  parse:  'ebd2300d55e16c7a2ad7be9ca28b7d2f5314588cb5948698fb71d8986a24a623',
  apply:  '83d48d390346ff3c40693bf5018483ec6cb11e978d1f52e45f3afa69eb3168d7',
};
const MARKS = {
  weekSun: [ 'function weekSunISO(dateISO){', '\n' ],
  parse:   [ 'function parseCSVLine(line){', 'function applySheetRows(rows){' ],
  apply:   [ 'function applySheetRows(rows){', 'async function loadSheetData(){' ],
};

const sha = s => require('crypto').createHash('sha256').update(s).digest('hex');
const warn = [];

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
}
const flag = name => process.argv.includes('--' + name);

async function fetchText(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  return await r.text();
}

function slice(src, [start, end], label) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error('could not find start marker for ' + label + ' in index.html');
  const j = src.indexOf(end, i + start.length);
  if (j < 0) throw new Error('could not find end marker for ' + label + ' in index.html');
  return src.slice(i, j);
}

(async () => {
  const csvPath = arg('csv');
  if (!csvPath) { console.error('ERROR: --csv <path to EC ledger CSV> is required'); process.exit(1); }

  // ---- 1. logic, lifted verbatim from the live tab -------------------------
  const indexPath = arg('index');
  const indexSrc = indexPath ? fs.readFileSync(indexPath, 'utf8')
                             : await fetchText(RAW + '/index.html');
  const partWeek  = slice(indexSrc, MARKS.weekSun, 'weekSunISO');
  const partParse = slice(indexSrc, MARKS.parse,   'parseCSVLine/parseSheetCSV');
  const partApply = slice(indexSrc, MARKS.apply,   'applySheetRows');

  if (sha(partParse) !== PINNED.parse) warn.push('CSV-parse logic in index.html has CHANGED since this script was pinned (now ' + sha(partParse).slice(0, 16) + '). Bake used the LIVE logic; re-pin the hash.');
  if (sha(partApply) !== PINNED.apply) warn.push('applySheetRows in index.html has CHANGED since this script was pinned (now ' + sha(partApply).slice(0, 16) + '). Bake used the LIVE logic; re-pin the hash.');

  const sandbox = { DATA: null, console };
  vm.createContext(sandbox);
  vm.runInContext(partWeek + '\n' + partParse + '\n' + partApply, sandbox, { filename: 'ecb-logic.js' });

  // ---- 2. inputs ------------------------------------------------------------
  const seedPath = arg('seed');
  const seedTxt = seedPath ? fs.readFileSync(seedPath, 'utf8')
                           : await fetchText(RAW + '/data/ec_budget_snapshot.json');
  const seed = JSON.parse(seedTxt);
  if (!seed || !seed.daily_spend) throw new Error('seed snapshot has no daily_spend');

  const csv = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
  const rows = sandbox.parseSheetCSV(csv);
  if (!rows.length) throw new Error('ledger CSV parsed to 0 rows — refusing to bake');

  const seedThrough = seed.daily_spend.through || null;

  // ---- 3. bake: exactly the tab's post-applySheetRows state -----------------
  sandbox.DATA = seed;
  sandbox.applySheetRows(rows);
  const out = sandbox.DATA;

  const through = out.daily_spend.as_at || null;
  if (!through) throw new Error('bake produced no as_at date — refusing to write');
  if (seedThrough && through < seedThrough) {
    throw new Error('REFUSING TO WRITE: baked ledger_through ' + through +
      ' is EARLIER than the committed snapshot ' + seedThrough +
      ' — the CSV pull is stale or truncated.');
  }

  out.meta = {
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: 'EC ledger sheet (published CSV) applied over the EC control-centre baked data — committed fallback for the AM Budget Burn tab; the tab reads the same CSV live on every load',
    ledger_through: through,
  };

  // compact, matching the committed file — this is fetched by the browser on every load
  const json = JSON.stringify(out);

  // ---- 4. compare / write ---------------------------------------------------
  const strip = t => { const o = JSON.parse(t); if (o.meta) delete o.meta.generated_at; return JSON.stringify(o); };
  const changed = strip(json) !== strip(seedTxt);

  const filed = (out.daily_spend.sites || []).filter(s => s.hc_wtd != null).length;
  const total = (out.daily_spend.sites || []).length;
  const report = {
    ledger_rows: rows.length,
    ledger_through: through,
    seed_through: seedThrough,
    sites_filed: filed + '/' + total,
    non_filers: (out.daily_spend.sites || []).filter(s => s.hc_wtd == null).map(s => s.code).join(', ') || '—',
    changed_vs_committed: changed,
    warnings: warn,
  };

  if (flag('check')) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(changed ? 20 : 0);
  }

  const outPath = arg('out', './ec_budget_snapshot.json');
  fs.writeFileSync(outPath, json);
  report.out = outPath;
  report.bytes = Buffer.byteLength(json);
  report.sha256 = sha(json);
  console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error('BAKE FAILED: ' + e.message); process.exit(1); });
