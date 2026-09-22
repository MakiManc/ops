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
// Ross, 21/09/2026: THERE ARE NOW FOUR BROTH ROWS ON THIS PAGE, and keeping
// them apart is the whole job of this file.
//
//   OO5 KR1  Maintain Pork broth density within 8-9     <- OKR, scored on the
//   OO5 KR2  Maintain Chicken broth density within 5-6     MONTHLY MEAN
//   Broth conformance (factory, after ice)              <- Operating KPI, the
//   Broth as served, by site (reported)                    pooled % in band
//
// The first two are Matthew's KRs and are scored. The second two are not on
// his sheet, so they moved to Operating KPIs and carry no band and no score.
// All four read the same refractometer feed and none of them is a check on any
// other. A reader who averages any two of these numbers has been misled by
// this page, so every basis below must name its own band, its own product and
// its own denominator, and quote nobody else's.
function okrBrothRow(over = {}) {
  return {
    objective: 'OO5', kr: 'KR1', text: 'KR1: Maintain Pork broth density within 8-9',
    owner: 'Operations', target: '8-9', band: 'density', band_status: 'proposed',
    tab: 'p-qual', source_kind: 'computed',
    value: 8.35, display: '8.35 avg - 94.7% of 94 readings in band',
    score: 100, rag: 'green',
    basis: 'Mean after-ice refractometer reading for Tonkotsu Broth in August 2026: ' +
      '8.35 against a band of 8-9, inside band. 89 of 94 reading(s) were individually ' +
      'in band (94.7%), across 29 production day(s). THE SCORE IS ON THE MEAN, which ' +
      'is what the band was agreed against; the in-band percentage is shown beside it ' +
      'because a mean can sit inside band while individual batches miss it in both ' +
      'directions.',
    trend: null, trend_unit: null, trend_note: null, not_measured: null,
    months: null, ...over,
  };
}
// Only the rows under test, so a locator by row text cannot collide with
// another row and the assertions stay about this change.
function scorecardOf(kpis, okrRows) {
  const rows = okrRows || [
    okrBrothRow(),
    okrBrothRow({ kr: 'KR2', text: 'KR2: Maintain Chicken broth density within 5-6',
      target: '5-6', value: 5.34, score: 100, rag: 'green',
      display: '5.34 avg - 91.4% of 35 readings in band',
      basis: 'Mean after-ice refractometer reading for Chicken Broth in August 2026: ' +
        '5.34 against a band of 5-6, inside band. 32 of 35 reading(s) were individually ' +
        'in band (91.4%), across 24 production day(s).' }),
  ];
  const scored = rows.filter(r => r.score != null).map(r => r.score);
  const pct = scored.length
    ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10 : null;
  return {
    weeks: WEEKS, rows, operating_kpis: kpis,
    objectives: [{ objective: 'OO5', label: 'Production', pct,
                   scored: scored.length, total: rows.length, months: [] }],
    operations: { pct, scored: pct == null ? 0 : 1, total: 5, months: [] },
    bands: { density: { direction: 'le', table: [[0, 100], [0.5, 80], [1, 50]],
                        status: 'proposed' } },
    measured: rows.filter(r => r.value != null).length,
    scored: scored.length, total: rows.length,
    months: [], month: '2026-09',
    basis: 'one row per KR on the 2026 Operations Input sheet; test basis string',
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

  // The two pooled broth rows are NOT OKRs and must not be rendered as if they
  // were. They live in the Operating KPIs table, which carries no Score column
  // at all - there is no band for them, so there must be nowhere to show one.
  const kpiHead = await page.locator('#scorecard table').nth(1).locator('thead th').allInnerTexts();
  assert(!kpiHead.some(h => /score/i.test(h)),
    `the Operating KPIs table has no Score column (got ${JSON.stringify(kpiHead)})`);
  assert(await page.locator('#scorecard table').nth(1).locator('tbody tr').count() === 2,
    'both pooled broth rows sit in the Operating KPIs table');
  // The objective headings above use colspan 6, one per objective, never per
  // Manual "function" - the row list is Matthew's sheet now.
  const heads = await page.locator('#scorecard table tbody tr td[colspan="6"]').allInnerTexts();
  assert(heads.length === 1 && /OO5/.test(heads[0]) && /Production/.test(heads[0]),
    `the OKR rows sit under one OO5 objective heading (got ${JSON.stringify(heads)})`);

  // Both rows drill through to the page that carries both measurements.
  const gos = await page.locator('#scorecard button[data-go]').evaluateAll(
    bs => bs.map(b => b.dataset.go));
  assert(gos.filter(g => g === 'p-qual').length === 4,
    `all four broth rows - two OKRs and two KPIs - open the Quality & Broth page (got ${JSON.stringify(gos)})`);

  // And that page still teaches the distinction the two rows depend on.
  const note = await page.locator('#p-qual .note').innerText();
  assert(/never averaged/.test(note),
    `the Quality page still says the two measurements are never averaged (got "${note.slice(0, 60)}…")`);

  assert(await page.locator('#scorecard .prov').last().innerText()
    .then(t => /2 of 2 measured, 2 scored/.test(t)),
    'the footer counts the OKR rows, measured and scored, not the Operating KPIs');
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
  // This row moved to Operating KPIs on 21/09/2026, so it is no longer in the
  // OKR footer's count at all. That separation is the assertion worth making:
  // an Operating KPI going dark must not move the OKR numbers, because the two
  // lists answer to different documents.
  assert(await page.locator('#scorecard .prov').last().innerText()
    .then(t => /2 of 2 measured, 2 scored/.test(t)),
    'an unmeasured Operating KPI does not change the OKR measured/scored counts');
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


// =========================== the month picker ==============================
// Ross, 17/09/2026: let the reader pick the month the scorecard shows. The
// house rule is that the shell decides nothing (command/index.html carries no
// numbers and no thresholds), so the builder scores EVERY month up front and
// the picker only chooses between finished answers. These assertions exist to
// pin that: the figure and the chip for an earlier month must be the ones the
// builder emitted for THAT month, never recomputed here and never the current
// month's figure wearing an earlier month's heading.
const MONTHS = ['2026-09', '2026-08', '2026-07'];
function monthVar(m, over = {}) {
  const L = { '2026-09': 'September 2026', '2026-08': 'August 2026', '2026-07': 'July 2026' }[m];
  return {
    m, label: L, value: null, display: null, rag: null, basis: null,
    trend: null, trend_unit: null, trend_note: null, not_measured: null, ...over,
  };
}
// Real figures out of the builder for the broth KR, month by month.
const BROTH_MONTHS = [
  monthVar('2026-07', { value: 98.3, display: '98.3%', rag: 'green',
    basis: '117 of 119 graded after-ice refractometer readings inside their product\'s ' +
      'factory band (tonkotsu 8-9, chicken 5-6) in July 2026. A complete month.' }),
  monthVar('2026-08', { value: 93.8, display: '93.8%', rag: 'red',
    basis: '121 of 129 graded after-ice refractometer readings inside their product\'s ' +
      'factory band (tonkotsu 8-9, chicken 5-6) in August 2026. A complete month.' }),
  monthVar('2026-09', { value: 96.0, display: '96.0%', rag: 'green', basis: FACTORY_BASIS }),
];
// KR1's source only reaches back to August, so July must read as absent FOR
// JULY rather than silently showing August's count.
const KR1_MONTHS = [
  monthVar('2026-08', { value: 46, display: '46', rag: 'red', basis: 'issues raised in August' }),
  monthVar('2026-09', { value: 31, display: '31', rag: 'red', basis: 'issues raised in September' }),
];
function kr1Row(over = {}) {
  return {
    function: 'Supply', kr: 'KR1 delivery issues / month', target: '≤10', tab: 'p-supi',
    value: 31, display: '31', rag: 'red', basis: 'issues raised in September',
    trend: null, trend_unit: null, trend_note: null, not_measured: null,
    months: KR1_MONTHS, ...over,
  };
}
// A row with NO monthly form - current state, must not follow the picker.
function trainingRow(over = {}) {
  return {
    function: 'People', kr: 'Mandatory training complete', target: '>=90%', tab: 'p-train',
    value: 71.4, display: '71.4%', rag: 'red', basis: 'current state across sites',
    trend: null, trend_unit: null, trend_note: null, not_measured: null, months: null, ...over,
  };
}
// The picker scenarios are about OKR ROW behaviour, so these fixtures go in
// `rows`, not in the Operating KPIs - the KPI table has no month variants and
// no off-month warning, which is exactly the behaviour under test. The rows
// keep their Manual labels as `text` so the locators below still find them by
// name; what they gain is the objective identity the OKR layout needs.
function asOkr(r, i) {
  return { ...r, objective: 'OO3', kr: 'KR' + (i + 1), text: r.kr,
    owner: 'Operations', band: null, band_status: null,
    source_kind: r.value != null ? 'computed' : 'not_measured', score: null,
    months: r.months ? r.months.map(v => ({ ...v, score: null })) : null };
}
function monthlyScorecard(rows) {
  const okrRows = rows.map(asOkr);
  return { ...scorecardOf([], okrRows), months: MONTHS, month: '2026-09',
    monthly: rows.filter(r => r.months && r.months.length).length,
    month_basis: 'the month picker moves the rows whose KR is a per-month measure; every ' +
      'month it offers was scored in the builder.' };
}

{
  const snap = { ...baseSnap, scorecard: monthlyScorecard(
    [kr1Row(), factoryRow({ months: BROTH_MONTHS }), siteRow(), trainingRow()]) };
  await page.evaluate((s) => window.render(s), snap);

  // -- the picker exists and defaults to the snapshot's own month ----------
  assert(await page.locator('#sc-month').count() === 1, 'the scorecard carries a month picker');
  assert(await page.locator('#sc-month').inputValue() === '2026-09',
    'the picker defaults to the month the snapshot was baked in');
  const opts = await page.locator('#sc-month option').allInnerTexts();
  assert(opts.length === 3 && /September 2026/.test(opts[0]) && /current/.test(opts[0]),
    `the picker lists the months and marks the current one (got ${JSON.stringify(opts)})`);
  assert(/July 2026/.test(opts[2]),
    `the picker reaches back as far as the builder scored (got ${JSON.stringify(opts)})`);

  const facNow = await qualRow(page, 'Broth conformance (factory, after ice)')
    .locator('td').allInnerTexts();
  assert(/96\.0%/.test(facNow[2]) && /On target/.test(facNow[4]),
    `the default month shows September's figure (got "${facNow[2]}")`);

  // -- selecting August swaps in AUGUST's pre-judged answer ----------------
  await page.selectOption('#sc-month', '2026-08');
  const facAug = await qualRow(page, 'Broth conformance (factory, after ice)')
    .locator('td').allInnerTexts();
  assert(/93\.8%/.test(facAug[2]),
    `selecting August shows August's figure (got "${facAug[2]}")`);
  assert(/Off target/.test(facAug[4]),
    `August's chip is the builder's red, not recomputed in the shell (got "${facAug[4]}")`);
  assert(/August 2026/.test(facAug[0]) && !/in September 2026/.test(facAug[0]),
    'the basis shown is the one written for August, not September\'s re-pointed at it');

  const kr1Aug = await page.locator('#scorecard table tbody tr', { hasText: 'KR1 delivery issues' })
    .first().locator('td').allInnerTexts();
  assert(/\b46\b/.test(kr1Aug[2]),
    `every monthly row moves together, not just the broth KR (got "${kr1Aug[2]}")`);

  // -- a row with no monthly form says so, rather than lying --------------
  const trAug = await page.locator('#scorecard table tbody tr', { hasText: 'Mandatory training' })
    .first().locator('td').allInnerTexts();
  assert(/71\.4%/.test(trAug[2]),
    `a current-state row keeps its figure (got "${trAug[2]}")`);
  assert(/Not August 2026/.test(trAug[0]) && /does not follow the month picker/.test(trAug[0]),
    `a row with no monthly form is marked as not following the picker (got "${trAug[0].replace(/\s+/g, ' ').slice(0, 130)}…")`);

  // -- the footer says which month, and how much of the card it covers ----
  const prov = await page.locator('#scorecard .prov').last().innerText();
  assert(/showing/.test(prov) && /August 2026/.test(prov),
    `the footer names the month on show (got "${prov.slice(0, 120)}…")`);
  assert(/2 of 4 rows/.test(prov),
    `the footer says how many rows the month actually covers (got "${prov.slice(0, 160)}…")`);

  // -- a monthly row whose source cannot reach that month -----------------
  await page.selectOption('#sc-month', '2026-07');
  const kr1Jul = await page.locator('#scorecard table tbody tr', { hasText: 'KR1 delivery issues' })
    .first().locator('td').allInnerTexts();
  // td indices differ between the two tables: the OKR table carries a Score
  // column (KR, Target, Now, Score, Status, Trend) and the Operating KPIs
  // table does not (KPI, Target, Now, Status, Trend). These are OKR rows.
  assert(kr1Jul[2].trim() === '—' && /Not measured/.test(kr1Jul[4]),
    `a monthly row with no July figure reads absent for July (got "${kr1Jul[2]}" / "${kr1Jul[4]}")`);
  assert(/no figure for July 2026/.test(kr1Jul[0]) &&
         /scored August 2026 to September 2026 only/.test(kr1Jul[0]),
    `and names the span its source actually covers, rather than assuming the gap runs backwards (got "${kr1Jul[0].replace(/\s+/g, ' ').slice(0, 150)}…")`);
  assert(!/\b46\b|\b31\b/.test(kr1Jul[2]),
    'an unreachable month never shows another month\'s number');
  const facJul = await qualRow(page, 'Broth conformance (factory, after ice)')
    .locator('td').allInnerTexts();
  assert(/98\.3%/.test(facJul[2]),
    `a row that CAN reach July still shows July (got "${facJul[2]}")`);

  // -- getting back to the current month ----------------------------------
  assert(await page.locator('#sc-month-now').count() === 1,
    'an off-current month offers a way back');
  await page.locator('#sc-month-now').click();
  assert(await page.locator('#sc-month').inputValue() === '2026-09',
    'the way back returns to the snapshot\'s own month');
  assert(await page.locator('#sc-month-now').count() === 0,
    'and the way back disappears once there is nowhere to go back to');
  const trBack = await page.locator('#scorecard table tbody tr', { hasText: 'Mandatory training' })
    .first().locator('td').allInnerTexts();
  assert(!/Not September/.test(trBack[0]),
    'a current-state row carries no off-month warning on the current month');
}

// ------------- a snapshot baked before the picker renders unchanged ---------
// Every snapshot already committed carries no scorecard.months. Those must
// render exactly as before - no picker, and certainly not an empty one.
{
  const snap = { ...baseSnap, scorecard: scorecardOf([factoryRow(), siteRow()]) };
  await page.evaluate((s) => window.render(s), snap);
  assert(await page.locator('#sc-month').count() === 0,
    'a snapshot predating the picker draws no picker');
  const tds = await qualRow(page, 'Broth conformance (factory, after ice)')
    .locator('td').allInnerTexts();
  assert(/96\.0%/.test(tds[2]) && /On target/.test(tds[3]),
    `and still renders its row exactly as before (got "${tds[2]}")`);
  const prov = await page.locator('#scorecard .prov').last().innerText();
  assert(!/showing/.test(prov),
    `with no month language in the footer (got "${prov.slice(0, 80)}…")`);
}

assert(consoleErrors.length === 0,
  `no console/page errors during any render() call (got ${consoleErrors.length}: ${consoleErrors.slice(0,3).join(' | ')})`);

await browser.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nall assertions passed');
