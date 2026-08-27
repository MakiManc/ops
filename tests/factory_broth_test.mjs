// Fixture test for the factory broth score on the Quality & Broth tab
// (27/08/2026). Ross asked for a factory-level broth score by batch, scored on
// the AFTER-ICE reading, so the assertions below are mostly about that one
// word: the score column must be the after-ice number, the before-ice number
// must be visible but never scored, and a response with no after-ice reading
// must be excluded and disclosed rather than counted as a zero.
//
// Pattern (same as supply_orders_otif_test.mjs): load command/index.html in
// headless Chromium via file://, call window.render(fixtureSnap) directly, then
// assert on the DOM. The base is a REAL baked snapshot with only
// snap.quality.factory replaced per scenario, so the rest of the page still
// renders realistic data and a regression elsewhere still surfaces.
//
// The readings below are REAL rows out of bake_ops_command.py run against the
// refractometer form's own responses - including the two traps the builder
// claims to handle (a percent-formatted reading, a typo'd form date that falls
// back to the submission timestamp) - trimmed, not hand-invented.
//
// Run: node tests/factory_broth_test.mjs   (exits non-zero on any failure)

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

const BASIS = 'one row per refractometer form submission at the factory; score = the ' +
  'reading taken AFTER adding ice, graded against its spec band; test basis string';
const TONKOTSU = [8.0, 9.0];   // Ross, 27/08/2026
const CHICKEN  = [5.0, 6.0];

function factoryFixture() {
  return {
    // newest first, exactly as the builder emits them
    readings: [
      { d: '2025-10-20', ts: '20/10/2025 09:15:00', batch: '2010GA1', product: 'Tonkotsu Broth',
        score: 9.0, before: 12.0, date_source: 'timestamp', repeat: false, band: TONKOTSU, grade: 'in' },
      { d: '2025-10-19', ts: '19/10/2025 16:26:38', batch: '1910GA3', product: 'Tonkotsu Broth',
        score: 8.0, before: 11.6, date_source: 'form', repeat: false, band: TONKOTSU, grade: 'in' },
      { d: '2025-10-19', ts: '19/10/2025 11:13:41', batch: '1910GA1', product: 'Tonkotsu Broth',
        score: 8.7, before: 11.9, date_source: 'form', repeat: false, band: TONKOTSU, grade: 'in' },
      // the same batch read twice in one day - both rows kept, both marked
      { d: '2025-08-21', ts: '21/08/2025 18:45:46', batch: '210825B', product: 'Tonkotsu Broth',
        score: 9.0, before: 12.0, date_source: 'form', repeat: true, band: TONKOTSU, grade: 'in' },
      { d: '2025-08-21', ts: '21/08/2025 15:24:24', batch: '210825B', product: 'Tonkotsu Broth',
        score: 7.0, before: 11.0, date_source: 'form', repeat: true, band: TONKOTSU, grade: 'low' },
      { d: '2025-10-16', ts: '16/10/2025 19:26:24', batch: '1610GA3', product: 'Chicken Broth',
        score: 5.0, before: 6.0, date_source: 'form', repeat: false, band: CHICKEN, grade: 'in' },
      // a real mis-keyed reading: 8.7 entered as 87, against a before-ice of
      // 12.2. Kept and flagged, never repaired or dropped - and the summary
      // and the colour scale both have to survive it.
      { d: '2026-02-19', ts: '19/02/2026 20:10:00', batch: '190226GA2', product: 'Tonkotsu Broth',
        score: 87.0, before: 12.2, date_source: 'form', repeat: false, suspect: true, band: TONKOTSU, grade: 'high' },
    ],
    scored: 7, responses: 10, truncated: false, median: 8.7, suspect: 1,
    bands: { 'Tonkotsu Broth': TONKOTSU, 'Chicken Broth': CHICKEN },
    grades: { in: 5, low: 1, high: 1, ungraded: 0, out_suspect: 1 },
    excluded: { no_after_ice: 3, undated: 0, non_numeric: 0 },
    source_feed: 'Factory Broth Readings', pull_date: '2026-08-27',
    basis: BASIS,
  };
}

const pinnedChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(
  existsSync(pinnedChromium) ? { executablePath: pinnedChromium } : {});
const page = await browser.newPage();
await page.goto(pageUrl);
// The page's own bootstrap fetches the live snapshot from GitHub Pages on load;
// that has no route out of this sandbox and fails loudly (expected, unrelated
// to this feature) - only start listening for errors AFTER that settles.
await page.waitForTimeout(1500);
// Network noise is not a page error: the bootstrap tries several BASES and each
// unreachable one logs a failed resource load from this sandbox, sometimes after
// the settle above. Those are filtered by text; anything else - a real exception,
// a bad property read in render() - still fails the run.
const NETWORK_NOISE = /Failed to load resource|net::ERR_|ERR_CERT/;
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));
page.on('console', msg => {
  if (msg.type() === 'error' && !NETWORK_NOISE.test(msg.text())) consoleErrors.push(msg.text());
});

// ------------------------------------------------------------ populated ---
{
  const snap = { ...baseSnap,
    quality: { ...baseSnap.quality, factory: factoryFixture() } };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-qual'); }, snap);

  // -- by-batch table -----------------------------------------------------
  const head = (await page.locator('#fb-tbl table thead th').allInnerTexts())
    .map(t => t.toLowerCase());
  assert(head.join('|') === 'date|batch|product|after ice|before ice|notes',
    `batch table columns are date/batch/product/after ice/before ice/notes (got ${JSON.stringify(head)})`);
  const rows = await page.locator('#fb-tbl table tbody tr').count();
  assert(rows === 7, `one row per reading, not per batch (got ${rows})`);
  const first = await page.locator('#fb-tbl table tbody tr').first().locator('td').allInnerTexts();
  assert(first[0] === '2025-10-20', `newest reading first (got "${first[0]}")`);
  assert(first[1] === '2010GA1', `the batch number is on the row - Ross asked for it by name (got "${first[1]}")`);
  // THE feature: the scored column is after-ice, and before-ice is the other one.
  assert(first[3] === '9' && first[4] === '12',
    `after ice 9 is the score, before ice 12 sits beside it (got after "${first[3]}", before "${first[4]}")`);
  const chicken = await page.locator('#fb-tbl table tbody tr', { hasText: '1610GA3' }).locator('td').allInnerTexts();
  assert(chicken[3] === '5' && chicken[4] === '6',
    `a chicken batch scores its after-ice 5, not its before-ice 6 (got "${chicken[3]}"/"${chicken[4]}")`);

  // -- the two rows that would otherwise look like bugs --------------------
  const dupRows = await page.locator('#fb-tbl table tbody tr', { hasText: '210825B' }).count();
  assert(dupRows === 2, `a batch read twice in a day keeps both readings (got ${dupRows})`);
  const dupHtml = await page.locator('#fb-tbl table tbody tr', { hasText: '210825B' }).first().innerHTML();
  assert(/2nd reading this day/.test(dupHtml),
    'the repeated reading is marked, so two rows read as two readings and not a duplicate');
  const tsRow = await page.locator('#fb-tbl table tbody tr', { hasText: '2010GA1' }).innerHTML();
  assert(/Dated from submission/.test(tsRow),
    'a reading dated from the submission timestamp says so on the row');

  // -- the disclosure line: exclusions are counted, never scored as zero ----
  const prov = await page.locator('#fb-tbl .prov').innerText();
  assert(/7 reading\(s\)/.test(prov) && /6 batch\(es\)/.test(prov),
    `the batch count is distinct batches, not rows (got "${prov}")`);
  assert(/observed after-ice range 5–87/.test(prov),
    `the observed range is still stated (got "${prov}")`);
  assert(/graded against the after-ice spec: Tonkotsu 8–9, Chicken 5–6/.test(prov),
    `the disclosure names the spec each product is graded against (got "${prov}")`);
  assert(/5 of 7 in spec \(71\.4%\), 1 below and 1 above/.test(prov),
    `the disclosure counts in spec, below and above (got "${prov}")`);
  assert(!/not an official spec band/.test(prov),
    'the old "no spec band exists" disclaimer is gone from the factory card - one exists now');
  assert(/3 with no after-ice reading/.test(prov) && /never scored as zero/.test(prov),
    `responses with no after-ice reading are disclosed as excluded (got "${prov}")`);
  const scoreCells = await page.locator('#fb-tbl table tbody td .fbscore').count();
  assert(scoreCells === 7, `every score cell is shaded (got ${scoreCells})`);
  assert(!/\b0\b/.test(await page.locator('#fb-tbl table tbody').innerText()),
    'no reading renders as a zero - an unscored response is absent, never a 0');

  // -- the mis-keyed reading: kept, flagged, and not allowed to set the scale
  const susRow = await page.locator('#fb-tbl table tbody tr', { hasText: '190226GA2' });
  const susCells = await susRow.locator('td').allInnerTexts();
  // '87 ▲' - the number exactly as entered, plus the out-of-spec glyph. Not
  // repaired to 8.7, not dropped, not silently rescaled.
  assert(susCells[3] === '87 ▲',
    `the mis-keyed reading is shown as entered and graded (got "${susCells[3]}")`);
  assert(/Check this reading/.test(await susRow.innerHTML()),
    'the mis-keyed reading is flagged for someone to fix at source');
  assert(/Still shown, still graded and still counted/.test(prov),
    'the flagged reading is disclosed as kept, not dropped or repaired');
  assert(/rather than a batch that missed spec/.test(prov),
    'a keying slip is distinguished from a genuine out-of-spec batch');
  // -- the grading itself ---------------------------------------------------
  const classOf = async (batch) => (await page.locator('#fb-tbl table tbody tr',
    { hasText: batch }).first().locator('td .fbscore').getAttribute('class'));
  const inClass = await classOf('1910GA3');   // 8.0, the bottom of the 8-9 band
  assert(/fb-in/.test(inClass),
    `a reading ON the lower bound is in spec - the band is inclusive (got "${inClass}")`);
  const lowRow = page.locator('#fb-tbl table tbody tr', { hasText: '210825B' }).last();
  const lowCell = await lowRow.locator('td .fbscore').getAttribute('class');
  const lowText = await lowRow.locator('td .fbscore').innerText();
  assert(/fb-out/.test(lowCell), `a 7.0 against a 8-9 spec grades out (got "${lowCell}")`);
  assert(/▼/.test(lowText), `a below-spec cell carries a down glyph, not colour alone (got "${lowText}")`);
  assert(/Below spec \(8\)/.test(await lowRow.innerHTML()),
    'a below-spec row says in words which bound it missed');
  const hiRow = page.locator('#fb-tbl table tbody tr', { hasText: '190226GA2' });
  assert(/▲/.test(await hiRow.locator('td .fbscore').innerText()),
    'an above-spec cell carries an up glyph');
  assert(/Above spec \(9\)/.test(await hiRow.innerHTML()),
    'an above-spec row says in words which bound it missed');
  // the chicken band is its own: 5.0 passes at 5-6 where it would fail at 8-9
  const chickCell = await page.locator('#fb-tbl table tbody tr', { hasText: '1610GA3' })
    .locator('td .fbscore').getAttribute('class');
  assert(/fb-in/.test(chickCell),
    `a chicken 5.0 is graded against 5-6, not the tonkotsu band (got "${chickCell}")`);

  // -- by-product card -----------------------------------------------------
  const prodBars = await page.locator('#fb-prod .brow').count();
  assert(prodBars === 2, `one bar per product with readings in range (got ${prodBars})`);
  const prodFirst = await page.locator('#fb-prod .brow').first().innerText();
  // tonkotsu mean of 9.0, 8.0, 8.7, 9.0, 7.0 = 8.34 -> 8.3
  // tonkotsu: 7.0 8.0 8.7 9.0 9.0 87.0 -> median 8.85, rendered 8.8 (8.85 is
  // 8.8499… in binary floating point, so toFixed(1) rounds down - deterministic,
  // not a bug). The MEAN would be 21.5: one typo would become the product's score.
  assert(/Tonkotsu Broth/.test(prodFirst) && /8\.8/.test(prodFirst),
    `products are ranked by MEDIAN after-ice score, tonkotsu 8.8 first (got "${prodFirst.replace(/\s+/g, ' ')}")`);
  const prodProv = await page.locator('#fb-prod .prov').innerText();
  assert(/not a pass mark/.test(prodProv) && /Median/.test(prodProv),
    `the per-product figures are medians and disclaim being a pass mark (got "${prodProv}")`);

  // -- KPI strip -----------------------------------------------------------
  const kpiLabels = (await page.locator('#qual-kpis .kpi .lb').allInnerTexts()).map(t => t.toLowerCase());
  assert(kpiLabels.slice(0, 3).join('|') === 'factory batches scored|factory readings in spec|median factory score',
    `the factory tiles lead the quality KPI strip (got ${JSON.stringify(kpiLabels)})`);
  const kpiVals = await page.locator('#qual-kpis .kpi .vl').allInnerTexts();
  assert(kpiVals[0] === '6', `batches scored counts distinct batches, 6 (got "${kpiVals[0]}")`);
  assert(kpiVals[1] === '71.4%',
    `the in-spec tile is 5 of 7 graded readings (got "${kpiVals[1]}")`);
  // 5.0 7.0 8.0 8.7 9.0 9.0 87.0 -> the middle one is 8.7. A mean would be
  // 19.1 here: one mis-keyed row would become the headline number.
  assert(kpiVals[2] === '8.7',
    `the factory score is the MEDIAN, unmoved by the mis-keyed 87 (got "${kpiVals[2]}")`);

  // -- the two levels are never conflated ----------------------------------
  const note = await page.locator('#p-qual .note').innerText();
  assert(/never averaged/.test(note) && /after/.test(note),
    `the page says factory readings and site checks are separate measurements (got "${note.replace(/\s+/g, ' ')}")`);
}

// ------------------------------------- a product with no band is not graded ---
// Ross gave bands for tonkotsu and chicken. 'Ikigai Chicken Broth' is in the
// form and was not given one, so it must not be coloured pass or fail, and it
// must not sit in the in-spec denominator either - a product nobody has speced
// cannot drag the compliance number in either direction.
{
  const snap = { ...baseSnap, quality: { ...baseSnap.quality, factory: {
    readings: [
      { d: '2026-08-26', ts: '26/08/2026 20:00:00', batch: '2608IK1', product: 'Ikigai Chicken Broth',
        score: 4.6, before: 6.0, date_source: 'form', repeat: false, band: null, grade: null },
      { d: '2026-08-26', ts: '26/08/2026 19:00:00', batch: '2608GA1', product: 'Tonkotsu Broth',
        score: 8.4, before: 11.5, date_source: 'form', repeat: false, band: TONKOTSU, grade: 'in' },
    ],
    scored: 2, responses: 2, truncated: false, median: 6.5, suspect: 0,
    bands: { 'Tonkotsu Broth': TONKOTSU, 'Chicken Broth': CHICKEN },
    grades: { in: 1, low: 0, high: 0, ungraded: 1, out_suspect: 0 },
    excluded: { no_after_ice: 0, undated: 0, non_numeric: 0 },
    source_feed: 'Factory Broth Readings', pull_date: '2026-08-27', basis: BASIS } } };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-qual'); }, snap);
  const ikRow = page.locator('#fb-tbl table tbody tr', { hasText: '2608IK1' });
  const ikClass = await ikRow.locator('td .fbscore').getAttribute('class');
  assert(/fb-none/.test(ikClass) && !/fb-in|fb-out/.test(ikClass),
    `an unspeced product is neither pass nor fail (got "${ikClass}")`);
  assert(!/▼|▲/.test(await ikRow.locator('td .fbscore').innerText()),
    'an unspeced reading gets no direction glyph - there is no bound to miss');
  assert(/No band for this product/.test(await ikRow.innerHTML()),
    'the row says why it is not graded');
  const prov = await page.locator('#fb-tbl .prov').innerText();
  assert(/1 of 1 in spec \(100\.0%\)/.test(prov),
    `the unspeced reading is outside the in-spec denominator (got "${prov}")`);
  assert(/1 not graded \(no band for that product\)/.test(prov),
    `the ungraded count is disclosed rather than hidden (got "${prov}")`);
  const inSpecKpi = (await page.locator('#qual-kpis .kpi .vl').allInnerTexts())[1];
  assert(inSpecKpi === '100.0%',
    `the in-spec KPI counts only graded readings (got "${inSpecKpi}")`);
}

// -------------------------------------------------- feed has not landed ---
{
  const snap = { ...baseSnap, quality: { ...baseSnap.quality, factory: {
    readings: [], scored: 0, responses: 0, truncated: false,
    excluded: { no_after_ice: 0, undated: 0, non_numeric: 0 },
    source_feed: 'Factory Broth Readings', pull_date: null, basis: BASIS } } };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-qual'); }, snap);
  const empty = await page.locator('#fb-tbl .empty').innerText();
  assert(/has not landed/.test(empty) && /Factory Broth Readings/.test(empty),
    `an empty block names the feed that has not landed (got "${empty}")`);
  assert(await page.locator('#fb-tbl table').count() === 0,
    'no headers-only table is drawn when there is nothing to show');
  const kpiVals = await page.locator('#qual-kpis .kpi .vl').allInnerTexts();
  assert(kpiVals[1] === '—' && kpiVals[2] === '—',
    `in-spec and median are em dashes with no readings, never 0 (got ${JSON.stringify(kpiVals.slice(1,3))})`);
}

// ------------------------------------------------------------- legacy ----
{
  const quality = { ...baseSnap.quality };
  delete quality.factory;
  const snap = { ...baseSnap, quality };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-qual'); }, snap);
  const empty = await page.locator('#fb-tbl .empty').innerText();
  assert(/predates/.test(empty),
    `a snapshot baked before this block says it predates it (got "${empty}")`);
  assert(await page.locator('#fb-prod .brow').count() === 0,
    'legacy: no product bars are drawn for a snapshot that predates the block');
  const kpiVals = await page.locator('#qual-kpis .kpi .vl').allInnerTexts();
  assert(kpiVals[0] === '—' && kpiVals[1] === '—' && kpiVals[2] === '—',
    `legacy: all three factory tiles are em dashes (got ${JSON.stringify(kpiVals.slice(0, 3))})`);
  // the site-level cards must still render off the same snapshot
  assert(await page.locator('#qh-tonkotsu table.heat').count() === 1,
    'legacy: the per-site broth heatmaps are untouched by the factory block');
}

// ------------------------------------------- site heatmap: spec grading ---
// Ross, 27/08/2026: "Chicken broth should be within 1 from 6 and the tonkotsu
// between 6-7". A different band from the factory's, on a different
// measurement - broth as served, not the batch after ice - so the two must
// never be conflated. In spec is UNFILLED: across 800+ cells the calm state
// has to be quiet or the misses do not stand out.
{
  const band = { chicken: [5.0, 7.0], tonkotsu: [6.0, 7.0] };
  const cell = (site, kind, d, value, grade, miss) =>
    ({ site, kind, d, value, checks: 1, checks_missed: 0, band: band[kind], grade, miss });
  const snap = { ...baseSnap, quality: { ...baseSnap.quality, broth: {
    ...baseSnap.quality.broth, bands: band,
    grades: { in: 3, low: 3, high: 2 },
    deviations: [],
    cells: [
      cell('Maki Soho',      'chicken', '2026-08-05', 5.0, 'in',   0.0),
      cell('Maki Soho',      'chicken', '2026-08-06', 4.6, 'low',  0.4),   // step 1
      cell('Maki Meadowhall','chicken', '2026-08-05', 4.2, 'low',  0.8),   // step 2
      cell('Maki Meadowhall','chicken', '2026-08-06', 3.0, 'low',  2.0),   // step 3
      cell('Maki Soho',      'tonkotsu','2026-08-05', 6.5, 'in',   0.0),
      cell('Maki Nottingham Ltd','tonkotsu','2026-08-05', 8.0, 'high', 1.0),
      cell('Maki Nottingham Ltd','tonkotsu','2026-08-06', 7.3, 'high', 0.3),
      cell('Maki Lakeside',  'tonkotsu','2026-08-06', 6.2, 'in',   0.0),
    ] } } };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-qual'); }, snap);

  const cls = async (host, txt) => (await page.locator(host + ' td', { hasText: txt })
    .first().getAttribute('class'));
  // in spec -> no ramp class at all, so the cell stays on the surface
  const inCls = await cls('#qh-chicken', '5');
  assert(inCls === 'hcell', `an in-spec cell is left unfilled (got "${inCls}")`);
  // the three steps deepen with distance past the bound
  assert(/hb1/.test(await cls('#qh-chicken', '4.6')), 'half a point below -> step 1');
  assert(/hb2/.test(await cls('#qh-chicken', '4.2')), 'nearly a point below -> step 2');
  assert(/hb3/.test(await cls('#qh-chicken', '3')),   'two points below -> step 3');
  assert(/ha1/.test(await cls('#qh-tonkotsu', '7.3')), 'just above -> step 1');
  assert(/ha2/.test(await cls('#qh-tonkotsu', '8')),   'a point above -> step 2');
  // direction is in the glyph too, not colour alone
  const lowTxt = await page.locator('#qh-chicken td', { hasText: '4.6' }).first().innerText();
  const hiTxt  = await page.locator('#qh-tonkotsu td', { hasText: '8' }).first().innerText();
  assert(/▼/.test(lowTxt), `a below-spec cell carries ▼ (got "${lowTxt}")`);
  assert(/▲/.test(hiTxt),  `an above-spec cell carries ▲ (got "${hiTxt}")`);
  assert(!/▼|▲/.test(await page.locator('#qh-chicken td', { hasText: '5' }).first().innerText()),
    'an in-spec cell carries no glyph');
  // the tooltip spells out the miss in words
  const tip = await page.locator('#qh-chicken td', { hasText: '3' }).first().getAttribute('title');
  assert(/spec 5–7/.test(tip) && /2 below spec/.test(tip),
    `the cell tooltip names the spec and the miss (got "${tip}")`);
  // a legend is present - a ramp without one is unreadable
  const leg = await page.locator('#qh-chicken .hleg').innerText();
  assert(/in spec 5–7/.test(leg) && /below spec/.test(leg) && /above spec/.test(leg),
    `the card carries a legend for the ramp (got "${leg.replace(/\s+/g,' ')}")`);
  // counts, and the finding a miss-only ramp cannot show
  const prov = await page.locator('#qh-chicken .prov').innerText();
  assert(/1 of 4 in spec \(25\.0%\), 3 below and 0 above/.test(prov),
    `the card counts in spec, below and above (got "${prov}")`);
  assert(/median 4.4/.test(prov), `the median is stated (got "${prov}")`);
  assert(/LOWER bound/.test(prov),
    `a band hugging its lower bound is called out in words (got "${prov}")`);
  const sub = await page.locator('#qh-tonkotsu-sub').innerText();
  assert(/spec 6–7, 2 out of spec/.test(sub),
    `the subline carries the spec and the miss count (got "${sub}")`);
  // and the factory band must NOT have leaked into the site cards
  assert(!/8–9/.test(await page.locator('#qh-tonkotsu .hleg').innerText()),
    'the factory after-ice band does not appear on the site card');
}

assert(consoleErrors.length === 0,
  `no console/page errors during any render() call (got ${consoleErrors.length}: ${consoleErrors.slice(0,3).join(' | ')})`);

await browser.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nall assertions passed');
