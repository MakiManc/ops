// Fixture test for the two price-report flags added 01/09/2026 (Ross: "flag
// ... when items have had a price increase and stayed at that price for more
// than 2 weeks and second when prices keep fluctuating").
//
// Same pattern as the other suites: load command/index.html in headless
// Chromium via file://, call window.render(snap) directly, assert on the DOM.
// The base is a REAL baked snapshot with only snap.supply replaced, so every
// other tab still renders and a regression there still surfaces.
//
// The fixtures are trimmed REAL output from bake_ops_command.py against the
// committed archive - Sea Bream really does bounce 11.95-16.26, and the two
// Sweet potatoes rows really are two different packs. That last one is the
// case worth protecting: without the pack shown the card lists one ingredient
// twice at different prices and reads as a bug.
//
// Run: node tests/price_flags_test.mjs   (exits non-zero on any failure)

import { chromium } from 'playwright';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pageUrl = 'file://' + path.join(repoRoot, 'command', 'index.html');
const snapDir = path.join(repoRoot, 'data', 'ops_command');
const latestSnap = readdirSync(snapDir)
  .filter(f => /^snapshot_\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().pop();
const baseSnap = JSON.parse(readFileSync(path.join(snapDir, latestSnap), 'utf-8'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); }
  else console.log('ok  :', msg);
}

const THRESHOLDS = { settled_days: 14, flux_reports: 2, flux_reversals: 2,
                     suspect_up: 100.0, suspect_down: -50.0, stale_days: 10 };

function supplyFixture(over = {}) {
  return {
    ...baseSnap.supply,
    price_newest_report: '2026-08-31',
    price_reports: [{ date: '2026-08-13', rows: 223 }, { date: '2026-08-17', rows: 141 },
                    { date: '2026-08-24', rows: 465 }, { date: '2026-08-31', rows: 136 }],
    price_items: 457,
    price_thresholds: THRESHOLDS,
    price_watch: [],
    price_suspect: [],
    price_settled: [
      { item: 'CARROTS', pack: '1000 Grams', old_price: 0.98, new_price: 1.5,
        pct_change: 53.1, since: '2026-08-13', age_days: 19, held_days: 18,
        changes: 1, reports: 1, suspect: false },
      // Two packs of ONE ingredient. Both rows are correct and both must be
      // distinguishable on screen.
      { item: 'Sweet potatoes', pack: '2 Items', old_price: 2.031, new_price: 2.705,
        pct_change: 33.2, since: '2026-08-17', age_days: 15, held_days: 14,
        changes: 1, reports: 1, suspect: false },
      { item: 'Sweet potatoes', pack: '1 Items', old_price: 3.0, new_price: 3.49,
        pct_change: 16.3, since: '2026-08-17', age_days: 15, held_days: 14,
        changes: 1, reports: 1, suspect: false },
    ],
    price_flux: [
      { item: 'SEA BREAM LARGE', pack: '1000 Grams', old_price: 16.26, new_price: 12.53,
        pct_change: -22.9, since: '2026-08-31', age_days: 1, held_days: 0,
        changes: 33, reports: 4, reversals: 29, low: 11.95, high: 16.26,
        swing_pct: 36.1, distinct_prices: 4, suspect: false, trail: [] },
      { item: 'Tenderstem Broccoli', pack: '1000 Grams', old_price: 0.01, new_price: 2.13,
        pct_change: 19806.5, since: '2026-08-31', age_days: 1, held_days: 0,
        changes: 6, reports: 4, reversals: 5, low: 0.01, high: 2.13,
        swing_pct: 19806.5, distinct_prices: 4, suspect: true, trail: [] },
    ],
    ...over,
  };
}

// Same pinned build the other suites use; fall back to whatever Playwright
// has if this image ever stops shipping it.
const pinnedChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(
  existsSync(pinnedChromium) ? { executablePath: pinnedChromium } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const consoleErrors = [];
const NETWORK_NOISE = /Failed to load resource|net::ERR_|ERR_CERT/;
page.on('console', m => { if (m.type() === 'error' && !NETWORK_NOISE.test(m.text()))
  consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(String(e)));
await page.goto(pageUrl);
await page.waitForFunction(() => typeof window.render === 'function');

// ---------------------------------------------------------------- populated
await page.evaluate(s => { window.render(s); window.gotoPage('p-supp'); },
  { ...baseSnap, supply: supplyFixture() });

const settledText = await page.locator('#ps-tbl').innerText();
assert(/CARROTS/.test(settledText) && /\+53\.1%/.test(settledText),
  'a rise that has held is listed with its size');
assert(/£0\.98/.test(settledText) && /£1\.50/.test(settledText),
  'the settled row shows what the price was and is');
assert(/19d/.test(settledText), 'the settled row shows how long the rise has held');

// The pack is what tells the two Sweet potatoes rows apart.
const sweetRows = await page.locator('#ps-tbl tbody tr', { hasText: 'Sweet potatoes' }).count();
assert(sweetRows === 2, `both packs of one ingredient are listed (got ${sweetRows})`);
assert(/2 Items/.test(settledText) && /1 Items/.test(settledText),
  'each pack is named, so two rows for one ingredient do not read as a duplicate');

// age vs evidence must both be stated - they are different claims.
const settledProv = await page.locator('#ps-tbl .prov').innerText();
assert(/calendar days since the rise/.test(settledProv) && /2026-08-31/.test(settledProv),
  `the note separates calendar age from what the reports evidence (got "${settledProv.slice(0,90)}...")`);
assert(/4 distinct report/.test(settledProv),
  'the note says how many distinct reports it was built from');

const fluxText = await page.locator('#pf-tbl').innerText();
assert(/SEA BREAM LARGE/.test(fluxText) && /29/.test(fluxText),
  'a fluctuating item is listed with its reversal count');
assert(/£11\.95–£16\.26/.test(fluxText), 'the fluctuating row shows the price band');

// A £0.01-£2.13 "swing" is a keying slip, not a market. It must be marked and
// must not lead a list meant for supplier conversations.
assert(/check data/.test(fluxText), 'an implausible move is marked rather than hidden');
const firstFlux = await page.locator('#pf-tbl tbody tr').first().innerText();
assert(/SEA BREAM/.test(firstFlux) && !/check data/.test(firstFlux),
  `the real signal leads and the data-quality row sorts last (got "${firstFlux.split('\n')[0]}")`);
const fluxProv = await page.locator('#pf-tbl .prov').innerText();
assert(/log of changes, not a daily price/.test(fluxProv),
  'the note says a report is a change log, so "changes" is not a per-day count');
assert(/1 row\(s\) are marked "check data"/.test(fluxProv),
  `the note counts the flagged rows (got "${fluxProv.slice(-160)}")`);

// ------------------------------------------------------------------- empty
await page.evaluate(s => { window.render(s); window.gotoPage('p-supp'); },
  { ...baseSnap, supply: supplyFixture({ price_settled: [], price_flux: [] }) });
const emptySettled = await page.locator('#ps-tbl').innerText();
const emptyFlux = await page.locator('#pf-tbl').innerText();
assert(/No rise has held for 14 days/.test(emptySettled),
  `an empty settled list says why, naming the threshold (got "${emptySettled.slice(0,70)}")`);
assert(/No ingredient has changed direction/.test(emptyFlux),
  `an empty flux list says why (got "${emptyFlux.slice(0,70)}")`);
assert(!/\b0\b/.test(emptySettled.split('\n')[0]),
  'an empty list is a sentence, never a zero pretending to be a measurement');

// ------------------------------------------- a snapshot baked before this
const legacy = { ...baseSnap, supply: { ...baseSnap.supply } };
delete legacy.supply.price_settled; delete legacy.supply.price_flux;
delete legacy.supply.price_thresholds; delete legacy.supply.price_reports;
delete legacy.supply.price_newest_report;
await page.evaluate(s => { window.render(s); window.gotoPage('p-supp'); }, legacy);
const legacySettled = await page.locator('#ps-tbl').innerText();
assert(/No rise has held for 14 days/.test(legacySettled),
  'a snapshot predating these flags falls back to the default threshold, not a crash');

assert(consoleErrors.length === 0,
  `no console/page errors during any render() call (got ${consoleErrors.length}: ${consoleErrors.join(' | ')})`);

await browser.close();
console.log(failures ? `\n${failures} assertion(s) FAILED` : '\nall assertions passed');
process.exit(failures ? 1 : 0);
