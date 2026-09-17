// Fixture test for the Quality broth rows on the OKR scorecard (16/09/2026).
// Ross: "Broth conformance OKR is based on factory broth readings not site". So
// the Quality KR is now the FACTORY after-ice reading graded against its product
// band (tonkotsu 8-9, chicken 5-6), and the per-site GetCompliant checks of broth
// AS SERVED (chicken 5-7, tonkotsu 6-7) stay on the scorecard as a second row
// that is reported and NOT judged - it has no agreed target, and the refractometer
// form has no site field, so it is the only per-site broth signal there is.
//
// This is the first test of renderScorecard() in this repo, so the assertions are
// deliberately split in two:
//   1. the SHELL paints what the builder decided and decides nothing itself -
//      the RAG chip follows row.rag, "not set" + rag:null renders as Reported,
//      and a row with no value renders the blocker rather than 0.0%;
//   2. the two Quality rows are NEVER CONFLATED - each basis names its own band
//      and its own feed, and neither quotes the other's numbers. That is the one
//      mistake the whole Quality & Broth page is built to prevent, and a
//      scorecard that puts 96.0% and 82.0% two rows apart is where it would
//      happen first.
//
// The KR is scored per CALENDAR MONTH (Ross, 17/09/2026) while the sparkline
// beside it is the last four ISO weeks - two different windows on one row, the
// same shape Supply KR1 uses. The fixtures keep that mismatch rather than
// tidying it away, because a row whose headline and sparkline disagree is
// exactly what a reader will query.
//
// The scorecard.rows fixtures below are REAL rows out of bake_ops_command.py run
// against the live warehouse (snapshot_2026-09-16.json: factory September to
// date 97 of 101 = 96.0% GREEN, August 121 of 129 = 93.8% RED, site 1331 of
// 1624 = 82.0% reported), trimmed, not hand-invented.
//
// Pattern (same as factory_broth_test.mjs): load command/index.html in headless
// Chromium via file://, call window.render(fixtureSnap), then assert on the DOM.
// The base is a REAL baked snapshot with only snap.scorecard replaced per
// scenario. Note we do NOT call gotoPage('p-qual') - the scorecard lives on the
// default Overview page, and switching pages would hide it.
//
// Run: node tests/scorecard_broth_okr_test.mjs   (exits non-zero on any failure)

import { chromium } from 'playwright';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

const WEEKS = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14'];

// The real factory basis, as the builder emits it. Trimmed of the trailing
// clauses that do not vary, kept verbatim where a clause is asserted below.
const FACTORY_BASIS =
  "97 of 101 graded after-ice refractometer readings inside their product's factory " +
  'band (tonkotsu 8-9, chicken 5-6) in September 2026, across 15 production day(s), ' +
  "from 'Factory Broth Readings' as at its own pull 2026-09-16. MONTH TO DATE - the " +
  'month is not finished, so this figure is still moving. The KR is scored per calendar ' +
  "month (Ross, 17/09/2026), NOT over the feed's whole history; August 2026 read 121 of " +
  '129 (93.8%). The sparkline is the last four ISO WEEKS, a different window that ' +
  'crosses the month boundary - it reads 138 of 145 (95.2%). The Quality tab\'s factory ' +
  "cards are sliced by that page's own date-range picker and default to All, so they " +
  'will not match this row unless the picker is set to this month - this KR is always ' +
  'the calendar month and never follows that picker. Readings for a product ' +
  'with no agreed band are not graded and not counted; across the feed 58 with no ' +
  'after-ice reading are excluded, never scored as zero. The form carries no site ' +
  'field, so this is one group-wide figure and cannot name the line to visit';

// August, a COMPLETE month that missed the target - the red scenario below.
const FACTORY_BASIS_AUG =
  "121 of 129 graded after-ice refractometer readings inside their product's factory " +
  'band (tonkotsu 8-9, chicken 5-6) in August 2026, across 29 production day(s), from ' +
  "'Factory Broth Readings' as at its own pull 2026-08-31. A complete month. The KR is " +
  "scored per calendar month (Ross, 17/09/2026), NOT over the feed's whole history; " +
  'July 2026 read 117 of 119 (98.3%). The form carries no site field, so this is one ' +
  'group-wide figure and cannot name the line to visit';

const SITE_BASIS =
  '1331 of 1624 graded site readings inside the SITE band (chicken 5-7, tonkotsu 6-7); ' +
  'readings for a check type with no agreed band are not graded and not counted. A ' +
  'DIFFERENT MEASUREMENT from the row above - GetCompliant checks of broth as served, ' +
  "not the factory's after-ice reading of the batch - so the two are never averaged and " +
  'the gap between them is not an error. NO TARGET HAS BEEN SET for broth as served: the ' +
  "Manual's >=95% belongs to the factory reading (Ross, 16/09/2026), so this figure is " +
  'reported, not judged. It is kept because the refractometer form has no site field, ' +
  'which makes this the only per-site broth signal there is - use it to pick a site, the ' +
  'row above to judge the KR.';

function factoryRow(over = {}) {
  return {
    function: 'Quality', kr: 'Broth conformance (factory, after ice)',
    target: '>=95% in band', tab: 'p-qual',
    value: 96.0, display: '96.0%', rag: 'green', basis: FACTORY_BASIS,
    trend: [{ w: WEEKS[0], v: 94.7, n: 38, days: 7 }, { w: WEEKS[1], v: 97.8, n: 46, days: 7 },
            { w: WEEKS[2], v: 93.3, n: 45, days: 6 }, { w: WEEKS[3], v: 93.8, n: 16, days: 3 }],
    trend_unit: '% in band / week', trend_note: null, not_measured: null, ...over,
  };
}
function siteRow(over = {}) {
  return {
    function: 'Quality', kr: 'Broth as served, by site (reported)',
    target: 'not set', tab: 'p-qual',
    value: 82.0, display: '82.0%', rag: null, basis: SITE_BASIS,
    trend: [{ w: WEEKS[0], v: 81.2, n: 271, days: 7 }, { w: WEEKS[1], v: 81.7, n: 273, days: 7 },
            { w: WEEKS[2], v: 84.2, n: 273, days: 7 }, { w: WEEKS[3], v: 80.0, n: 80, days: 2 }],
    trend_unit: '% in band / week', trend_note: null, not_measured: null, ...over,
  };
}
// Only the two Quality rows, so a locator by row text cannot collide with
// another function's row and the assertions stay about this change.
function scorecardOf(rows) {
  return {
    weeks: WEEKS, rows,
    measured: rows.filter(r => r.value != null).length, total: rows.length,
    basis: 'one row per KR/KPI in the Master Operating Manual; test basis string',
  };
}
const qualRow = (page, text) =>
  page.locator('#scorecard table tbody tr', { hasText: text }).first();

const pinnedChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(
  existsSync(pinnedChromium) ? { executablePath: pinnedChromium } : {});
const page = await browser.newPage();
await page.goto(pageUrl);
// The page's own bootstrap fetches the live snapshot from GitHub Pages on load;
// that has no route out of this sandbox and fails loudly (expected, unrelated
// to this feature) - only start listening for errors AFTER that settles.
await page.waitForTimeout(1500);
const NETWORK_NOISE = /Failed to load resource|net::ERR_|ERR_CERT/;
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));
page.on('console', msg => {
  if (msg.type() === 'error' && !NETWORK_NOISE.test(msg.text())) consoleErrors.push(msg.text());
});

// ------------------ the KR is the factory reading, scored over one month ---
{
  const snap = { ...baseSnap, scorecard: scorecardOf([factoryRow(), siteRow()]) };
  await page.evaluate((s) => window.render(s), snap);

  const fac = qualRow(page, 'Broth conformance (factory, after ice)');
  assert(await fac.count() === 1, 'the factory broth KR is on the scorecard');
  const facTds = await fac.locator('td').allInnerTexts();
  assert(/96\.0%/.test(facTds[2]),
    `the Now column is the factory figure for the month (got "${facTds[2]}")`);
  assert(/>=95% in band/.test(facTds[1]),
    `the factory row carries the KR target (got "${facTds[1]}")`);
  assert(/On target/.test(facTds[3]),
    `96.0% against >=95% paints green, and the builder decided that (got "${facTds[3]}")`);

  // The KR label itself must say which measurement it is. A bare "Broth
  // conformance" next to a second broth row is the ambiguity this guards.
  assert(/factory/i.test(facTds[0]) && /after ice/i.test(facTds[0]),
    `the KR label names the factory and the after-ice moment (got "${facTds[0].split('\n')[0]}")`);

  // -- the two rows are never conflated ------------------------------------
  const facBasis = facTds[0];
  assert(/8-9/.test(facBasis) && /5-6/.test(facBasis),
    'the factory basis quotes the FACTORY band');
  assert(!/5-7/.test(facBasis) && !/6-7/.test(facBasis),
    'the factory basis never quotes the SITE band');
  assert(!/as served/i.test(facBasis),
    'the factory basis never calls its readings broth as served');
  assert(/no site field/.test(facBasis),
    'the factory basis says the KR cannot name a site, because the form has no site field');
  assert(/97 of 101/.test(facBasis),
    'the factory basis carries its own numerator and denominator');

  // -- the window is a calendar month, and the row says so -----------------
  // The headline and the sparkline are deliberately different windows, so the
  // basis has to name the month AND reconcile the two, or the row reads as a
  // mis-calculation to anyone who checks it.
  assert(/September 2026/.test(facBasis),
    'the basis names the month the KR is scored over');
  assert(/per calendar month/.test(facBasis),
    'the basis says the KR is a monthly measure');
  assert(/MONTH TO DATE/.test(facBasis),
    'an unfinished month is labelled month to date, not presented as a closed result');
  assert(/August 2026 read 121 of 129/.test(facBasis),
    'the basis carries last month, so one green month is not read as a trend on its own');
  assert(/last four ISO WEEKS/.test(facBasis) && /138 of 145/.test(facBasis),
    'the basis reconciles the four-week sparkline against the monthly headline');
  // The "open →" button lands on a page whose cards default to the All range,
  // so they show a different figure than this row. Warned in words, the way
  // KR1 warns that it does not follow the picker either.
  assert(/date-range picker/.test(facBasis) && /never follows that picker/.test(facBasis),
    'the basis warns that the page it drills into uses a different, reader-controlled range');
  assert(!/whole history, 2025/.test(facBasis),
    'the basis no longer presents the feed\'s whole history as the KR');

  // -- the site row survives, reported and NOT judged ----------------------
  const site = qualRow(page, 'Broth as served, by site (reported)');
  assert(await site.count() === 1, 'the per-site figure stays on the scorecard');
  const siteTds = await site.locator('td').allInnerTexts();
  assert(/82\.0%/.test(siteTds[2]), `the site row still shows its figure (got "${siteTds[2]}")`);
  assert(/not set/.test(siteTds[1]),
    `the site row's Target column says no target is set (got "${siteTds[1]}")`);
  assert(/Reported/.test(siteTds[3]) && !/On target|Off target/.test(siteTds[3]),
    `82.0% is reported, never coloured against a target nobody set (got "${siteTds[3]}")`);
  assert(/5-7/.test(siteTds[0]) && !/8-9/.test(siteTds[0]),
    'the site basis quotes the SITE band and not the factory band');
  assert(/never averaged/.test(siteTds[0]),
    'the site basis says the two figures are not two attempts at one number');

  // Order matters: the KR is the row a reader judges, so it leads.
  const krTexts = await page.locator('#scorecard table tbody tr td:first-child').allInnerTexts();
  const iFac = krTexts.findIndex(t => /factory, after ice/.test(t));
  const iSite = krTexts.findIndex(t => /by site \(reported\)/.test(t));
  assert(iFac > -1 && iSite > -1 && iFac < iSite,
    `the judged KR row is listed above the reported site row (got ${iFac} then ${iSite})`);

  // One "Quality" heading for both rows - they must stay contiguous.
  const heads = await page.locator('#scorecard table tbody tr td[colspan="5"]').allInnerTexts();
  assert(heads.filter(t => t.trim() === 'Quality').length === 1,
    `both broth rows sit under one Quality heading (got ${JSON.stringify(heads)})`);

  // Both rows drill through to the page that carries both measurements.
  const gos = await page.locator('#scorecard button[data-go]').evaluateAll(
    bs => bs.map(b => b.dataset.go));
  assert(gos.filter(g => g === 'p-qual').length === 2,
    `both broth rows open the Quality & Broth page (got ${JSON.stringify(gos)})`);

  // And that page still teaches the distinction the two rows depend on.
  const note = await page.locator('#p-qual .note').innerText();
  assert(/never averaged/.test(note),
    `the Quality page still says the two measurements are never averaged (got "${note.slice(0, 60)}…")`);

  assert(await page.locator('#scorecard .prov').innerText()
    .then(t => /2 of 2 measured/.test(t)),
    'both Quality rows count as measured in the footer');
}

// ------------------------ a completed month that missed the target reads red ---
// The point of a monthly KR is that it can turn. August closed at 93.8% and
// September to date is 96.0%, so both verdicts have to render from the same row
// shape - and the shell must not decide for itself which direction is good.
{
  const snap = { ...baseSnap, scorecard: scorecardOf([factoryRow({
    value: 93.8, display: '93.8%', rag: 'red', basis: FACTORY_BASIS_AUG,
  }), siteRow()]) };
  await page.evaluate((s) => window.render(s), snap);
  const tds = await qualRow(page, 'Broth conformance (factory, after ice)')
    .locator('td').allInnerTexts();
  assert(/93\.8%/.test(tds[2]) && /Off target/.test(tds[3]),
    `a month below 95% paints red (got "${tds[2]}" / "${tds[3]}")`);
  assert(/August 2026/.test(tds[0]) && /A complete month/.test(tds[0]),
    `a finished month says so instead of "month to date" (got "${tds[0].replace(/\s+/g, ' ').slice(0, 120)}…")`);
  assert(!/MONTH TO DATE/.test(tds[0]),
    'a complete month is never labelled month to date');
  // the site row's chip is unchanged by the factory row's verdict
  const siteChip = (await qualRow(page, 'by site (reported)').locator('td').allInnerTexts())[3];
  assert(/Reported/.test(siteChip),
    `the site row stays Reported whatever the KR does (got "${siteChip}")`);
}

// -------------------- a month nobody has read a batch in is not a failure ---
// At the turn of a month the KR has nothing to score until the first batch is
// logged. That must read as an absent measurement, never as 0% red - the row
// would otherwise announce a total quality collapse every 1st of the month.
{
  const snap = { ...baseSnap, scorecard: scorecardOf([factoryRow({
    value: null, display: null, rag: null, trend: null, trend_unit: null, basis: null,
    not_measured: 'no graded reading yet for October 2026 - the KR is scored per calendar ' +
      'month, and this month has not been read yet (September 2026 read 97 of 101). Normal ' +
      'for the first day or two of a month; needs a batch reading logged',
  }), siteRow()]) };
  await page.evaluate((s) => window.render(s), snap);
  const tds = await qualRow(page, 'Broth conformance (factory, after ice)')
    .locator('td').allInnerTexts();
  assert(tds[2].trim() === '—' && /Not measured/.test(tds[3]),
    `an unread month is dashed and grey, not red (got "${tds[2]}" / "${tds[3]}")`);
  assert(!/0\.0%|\b0%/.test(tds.join(' ')),
    `an unread month is never rendered as 0% (got "${tds.join(' | ')}")`);
  assert(/September 2026 read 97 of 101/.test(tds[0]),
    'the blocker still carries last month, so the row is not information-free');
}

// ------------------------- no factory feed is a blocker, never a 0% failure ---
// The KR must never read 0.0% red because the export did not land: that is an
// absent measurement, not a factory that missed spec on every batch.
{
  const snap = { ...baseSnap, scorecard: scorecardOf([factoryRow({
    value: null, display: null, rag: null, trend: null, trend_unit: null,
    basis: null,
    not_measured: "'Factory Broth Readings' has not landed in the warehouse, so there is " +
      'no after-ice reading to grade. Needs the daily factory export',
  }), siteRow()]) };
  await page.evaluate((s) => window.render(s), snap);
  const tds = await qualRow(page, 'Broth conformance (factory, after ice)')
    .locator('td').allInnerTexts();
  assert(tds[2].trim() === '—', `an unmeasured KR shows a dash, not a number (got "${tds[2]}")`);
  assert(!/0\.0%|\b0%/.test(tds.join(' ')),
    `an absent feed is never rendered as 0% (got "${tds.join(' | ')}")`);
  assert(/Not measured/.test(tds[3]),
    `the chip says not measured rather than off target (got "${tds[3]}")`);
  assert(/Needs:/.test(tds[0]) && /has not landed/.test(tds[0]),
    `the blocker is named on the dashboard (got "${tds[0].replace(/\s+/g, ' ').slice(0, 80)}…")`);
  assert(await page.locator('#scorecard .prov').innerText()
    .then(t => /1 of 2 measured/.test(t)),
    'the unmeasured KR is excluded from the measured count');
}

// ----------------- a feed that landed but cannot be graded says so instead ---
// Different blocker, different sentence: the rows are here but no product in
// them has an agreed band, so the honest answer is "Ross has not speced it",
// not "the export is missing".
{
  const snap = { ...baseSnap, scorecard: scorecardOf([factoryRow({
    value: null, display: null, rag: null, trend: null, trend_unit: null, basis: null,
    not_measured: "'Factory Broth Readings' landed 120 response(s) but none is gradeable - " +
      'no after-ice reading, or no agreed band for the product. Needs the after-ice ' +
      'question answered at source, and a band from Ross for the products in the form',
  }), siteRow()]) };
  await page.evaluate((s) => window.render(s), snap);
  const kr = (await qualRow(page, 'Broth conformance (factory, after ice)')
    .locator('td').allInnerTexts())[0];
  assert(/none is gradeable/.test(kr) && /band from Ross/.test(kr),
    `an ungradeable feed names the spec as the blocker (got "${kr.replace(/\s+/g, ' ').slice(0, 90)}…")`);
  assert(!/has not landed/.test(kr),
    'a feed that landed is not reported as missing');
}

// ------------------------------- the site row can be absent on its own ------
// The site feed is a rolling window and has gone missing before. When it does,
// the KR must be unaffected - that is the point of moving it to the factory.
{
  const snap = { ...baseSnap, scorecard: scorecardOf([factoryRow(), siteRow({
    value: null, display: null, rag: null, trend: null, trend_unit: null, basis: null,
    not_measured: 'no graded site broth readings in this bake',
  })]) };
  await page.evaluate((s) => window.render(s), snap);
  const facTds = await qualRow(page, 'Broth conformance (factory, after ice)')
    .locator('td').allInnerTexts();
  assert(/96\.0%/.test(facTds[2]) && /On target/.test(facTds[3]),
    `the KR still reads and still judges with the site feed gone (got "${facTds[2]}")`);
  const siteTds = await qualRow(page, 'by site (reported)').locator('td').allInnerTexts();
  assert(/Not measured/.test(siteTds[3]) && siteTds[2].trim() === '—',
    `the absent site row is grey and dashed, not 0% (got "${siteTds[2]}" / "${siteTds[3]}")`);
}

assert(consoleErrors.length === 0,
  `no console/page errors during any render() call (got ${consoleErrors.length}: ${consoleErrors.slice(0,3).join(' | ')})`);

await browser.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nall assertions passed');
