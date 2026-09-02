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

// -------------------------------------------------- drill-down (02/09/2026)
// Ross: "a tab when open that shows each supplier's price point for that
// product and the supplier that prices have changed". The supplier half is
// DATA-GATED - the price report carries no supplier column - so the two states
// are both pinned here: what it says when there is no supplier, and what it
// renders the day one appears.
// A fixture shaped like what the builder now emits: rows carry id + trail.
// (supplyFixture() deliberately does NOT, so the legacy case below still
// exercises a snapshot baked before the drill-down existed.)
const withTrail = supplyFixture({});
withTrail.price_settled = withTrail.price_settled.map((r, ix) => ix ? r : {
  ...r, id: '1637|1.0|1000|Grams',
  trail: [{ d: '2026-08-13', old: 0.98, new: 1.5, pct: 53.1, dir: 1, supplier: null }],
});
await page.evaluate(s => { window.render(s); window.gotoPage('p-supp'); },
  { ...baseSnap, supply: withTrail });

const clkSettled = await page.locator('#ps-tbl tbody tr.clk').count();
const clkFlux = await page.locator('#pf-tbl tbody tr.clk').count();
assert(clkSettled > 0 && clkFlux > 0,
  `rows on both price cards open (${clkSettled} settled, ${clkFlux} flux)`);

await page.locator('#ps-tbl tbody tr').first().click();
assert(await page.locator('#task-modal-ov.on').count() === 1,
  'opening a flagged row opens the drill-down');
const drillTitle = await page.locator('#task-modal-t').innerText();
assert(/CARROTS/.test(drillTitle) && /1000 Grams/.test(drillTitle),
  'the drill-down names the ingredient AND the pack, not just the ingredient');
const drillBody = await page.locator('#task-modal-b').innerText();
assert(/£0\.98/.test(drillBody) && /£1\.50/.test(drillBody) && /\+53\.1%/.test(drillBody),
  'the drill-down shows every change event behind the headline number');

// The no-supplier state must EXPLAIN itself. An empty table here reads as a
// broken card, and the explanation is the difference between "Kobas does not
// send it" and "the ETL is dropping it" - which is the actual next action.
assert(/no supplier/i.test(drillBody) && /Kobas/.test(drillBody),
  'with no supplier in the feed the panel says so instead of showing an empty table');
assert(/keeps every column/.test(drillBody),
  'it says the ETL is not the thing dropping the supplier - the report never had it');
await page.evaluate(() => document.getElementById('task-modal-ov').classList.remove('on'));

// Now the same page with a supplier column present, which is exactly the shape
// bake_ops_command.py emits once the report carries one (verified by baking a
// synthetic archive through the real builder).
const withSup = supplyFixture({});
withSup.price_has_supplier = true;
withSup.price_supplier_names = ['Big Dipper', 'Lynas'];
withSup.price_settled = [{
  item: 'SEAWEED NORI', pack: '10000 Grams', old_price: 4.1, new_price: 5.6,
  pct_change: 36.6, since: '2026-08-15', age_days: 28, held_days: 14,
  changes: 3, reports: 3, suspect: false, id: '9002|1.0|10000|Grams',
  suppliers: [
    { supplier: 'Big Dipper', price: 4.1, last_change: '2026-08-08', changes: 1, dir: -1 },
    { supplier: 'Lynas', price: 5.6, last_change: '2026-08-15', changes: 2, dir: 1 }],
  trail: [
    { d: '2026-08-01', old: 4.0, new: 5.2, pct: 30.0, dir: 1, supplier: 'Lynas' },
    { d: '2026-08-08', old: 5.2, new: 4.1, pct: -21.2, dir: -1, supplier: 'Big Dipper' },
    { d: '2026-08-15', old: 4.1, new: 5.6, pct: 36.6, dir: 1, supplier: 'Lynas' }],
}];
await page.evaluate(s => { window.render(s); window.gotoPage('p-supp'); },
  { ...baseSnap, supply: withSup });
await page.locator('#ps-tbl tbody tr').first().click();
const supBody = await page.locator('#task-modal-b').innerText();
assert(/Big Dipper/.test(supBody) && /Lynas/.test(supBody),
  'each supplier that priced the product is listed');
assert(/£4\.10/.test(supBody) && /£5\.60/.test(supBody),
  "each supplier's own latest price point is shown");
assert(/2026-08-08/.test(supBody) && /2026-08-15/.test(supBody),
  'the drill-down shows WHICH supplier changed and when');
// The honest caveat: this report only logs changes, so a supplier sitting on a
// steady quote is absent. Without this line the table reads as a full price
// comparison across the supply base, which it is not.
assert(/log of changes/.test(supBody) && /steady quote/.test(supBody),
  'it says the list is who moved, not a full comparison across the supply base');
await page.evaluate(() => document.getElementById('task-modal-ov').classList.remove('on'));

// An item can be flagged by BOTH cards, and ids are not unique across the two
// lists - the click must open the row it belongs to, not whichever list was
// searched first.
const both = supplyFixture({});
both.price_settled = [withSup.price_settled[0]];
both.price_flux = [{ ...withSup.price_settled[0], reversals: 2, low: 4.1, high: 5.6,
                     swing_pct: 36.6, distinct_prices: 3 }];
await page.evaluate(s => { window.render(s); window.gotoPage('p-supp'); },
  { ...baseSnap, supply: both });
await page.locator('#pf-tbl tbody tr').first().click();
const dupTitle = await page.locator('#task-modal-t').innerText();
assert(/SEAWEED NORI/.test(dupTitle),
  'an item flagged on both cards opens from the fluctuating card too');
await page.evaluate(() => document.getElementById('task-modal-ov').classList.remove('on'));

// ------------------------------------------- a snapshot baked before this
const legacy = { ...baseSnap, supply: { ...baseSnap.supply } };
delete legacy.supply.price_settled; delete legacy.supply.price_flux;
delete legacy.supply.price_thresholds; delete legacy.supply.price_reports;
delete legacy.supply.price_newest_report;
await page.evaluate(s => { window.render(s); window.gotoPage('p-supp'); }, legacy);
const legacySettled = await page.locator('#ps-tbl').innerText();
assert(/No rise has held for 14 days/.test(legacySettled),
  'a snapshot predating these flags falls back to the default threshold, not a crash');

// A snapshot baked before the drill-down: rows have no id, trail or suppliers.
// They must still render and still open, showing the headline with an empty
// history rather than throwing.
const noTrail = { ...baseSnap, supply: supplyFixture() };
await page.evaluate(s => { window.render(s); window.gotoPage('p-supp'); }, noTrail);
await page.locator('#ps-tbl tbody tr').first().click();
const noTrailBody = await page.locator('#task-modal-b').innerText();
assert(/No change events recorded/.test(noTrailBody),
  'a pre-drill-down snapshot opens and says it has no history, rather than crashing');
await page.evaluate(() => document.getElementById('task-modal-ov').classList.remove('on'));

assert(consoleErrors.length === 0,
  `no console/page errors during any render() call (got ${consoleErrors.length}: ${consoleErrors.join(' | ')})`);

await browser.close();
console.log(failures ? `\n${failures} assertion(s) FAILED` : '\nall assertions passed');
process.exit(failures ? 1 : 0);
