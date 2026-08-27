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
  'reading taken AFTER adding ice; test basis string';

function factoryFixture() {
  return {
    // newest first, exactly as the builder emits them
    readings: [
      { d: '2025-10-20', ts: '20/10/2025 09:15:00', batch: '2010GA1', product: 'Tonkotsu Broth',
        score: 9.0, before: 12.0, date_source: 'timestamp', repeat: false },
      { d: '2025-10-19', ts: '19/10/2025 16:26:38', batch: '1910GA3', product: 'Tonkotsu Broth',
        score: 8.0, before: 11.6, date_source: 'form', repeat: false },
      { d: '2025-10-19', ts: '19/10/2025 11:13:41', batch: '1910GA1', product: 'Tonkotsu Broth',
        score: 8.7, before: 11.9, date_source: 'form', repeat: false },
      // the same batch read twice in one day - both rows kept, both marked
      { d: '2025-08-21', ts: '21/08/2025 18:45:46', batch: '210825B', product: 'Tonkotsu Broth',
        score: 9.0, before: 12.0, date_source: 'form', repeat: true },
      { d: '2025-08-21', ts: '21/08/2025 15:24:24', batch: '210825B', product: 'Tonkotsu Broth',
        score: 7.0, before: 11.0, date_source: 'form', repeat: true },
      { d: '2025-10-16', ts: '16/10/2025 19:26:24', batch: '1610GA3', product: 'Chicken Broth',
        score: 5.0, before: 6.0, date_source: 'form', repeat: false },
    ],
    scored: 6, responses: 9, truncated: false,
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
  assert(rows === 6, `one row per reading, not per batch (got ${rows})`);
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
  assert(/6 reading\(s\)/.test(prov) && /5 batch\(es\)/.test(prov),
    `the batch count is distinct batches, not rows (got "${prov}")`);
  assert(/observed after-ice range 5–9/.test(prov),
    `the colour scale states its observed range (got "${prov}")`);
  assert(/not an official spec band/.test(prov),
    'the scale disclaims being a spec band - no target exists in the source');
  assert(/3 with no after-ice reading/.test(prov) && /never scored as zero/.test(prov),
    `responses with no after-ice reading are disclosed as excluded (got "${prov}")`);
  const scoreCells = await page.locator('#fb-tbl table tbody td .fbscore').count();
  assert(scoreCells === 6, `every score cell is shaded to the observed range (got ${scoreCells})`);
  assert(!/\b0\b/.test(await page.locator('#fb-tbl table tbody').innerText()),
    'no reading renders as a zero - an unscored response is absent, never a 0');

  // -- by-product card -----------------------------------------------------
  const prodBars = await page.locator('#fb-prod .brow').count();
  assert(prodBars === 2, `one bar per product with readings in range (got ${prodBars})`);
  const prodFirst = await page.locator('#fb-prod .brow').first().innerText();
  // tonkotsu mean of 9.0, 8.0, 8.7, 9.0, 7.0 = 8.34 -> 8.3
  assert(/Tonkotsu Broth/.test(prodFirst) && /8\.3/.test(prodFirst),
    `products are ranked by mean after-ice score, tonkotsu 8.3 first (got "${prodFirst.replace(/\s+/g, ' ')}")`);
  const prodProv = await page.locator('#fb-prod .prov').innerText();
  assert(/not a pass mark/.test(prodProv),
    `the per-product means disclaim being a pass mark (got "${prodProv}")`);

  // -- KPI strip -----------------------------------------------------------
  const kpiLabels = (await page.locator('#qual-kpis .kpi .lb').allInnerTexts()).map(t => t.toLowerCase());
  assert(kpiLabels.slice(0, 2).join('|') === 'factory batches scored|avg factory score',
    `the factory tiles lead the quality KPI strip (got ${JSON.stringify(kpiLabels)})`);
  const kpiVals = await page.locator('#qual-kpis .kpi .vl').allInnerTexts();
  assert(kpiVals[0] === '5', `batches scored counts distinct batches, 5 (got "${kpiVals[0]}")`);
  // 9.0 + 8.0 + 8.7 + 9.0 + 7.0 + 5.0 = 46.7 over 6 readings = 7.78
  assert(kpiVals[1] === '7.8', `avg factory score is the after-ice mean, 7.8 (got "${kpiVals[1]}")`);

  // -- the two levels are never conflated ----------------------------------
  const note = await page.locator('#p-qual .note').innerText();
  assert(/never averaged/.test(note) && /after/.test(note),
    `the page says factory readings and site checks are separate measurements (got "${note.replace(/\s+/g, ' ')}")`);
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
  assert(kpiVals[1] === '—', `the average is an em dash with no readings, never 0 (got "${kpiVals[1]}")`);
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
  assert(kpiVals[0] === '—' && kpiVals[1] === '—',
    `legacy: both factory tiles are em dashes (got ${JSON.stringify(kpiVals.slice(0, 2))})`);
  // the site-level cards must still render off the same snapshot
  assert(await page.locator('#qh-tonkotsu table.heat').count() === 1,
    'legacy: the per-site broth heatmaps are untouched by the factory block');
}

assert(consoleErrors.length === 0,
  `no console/page errors during any render() call (got ${consoleErrors.length}: ${consoleErrors.slice(0,3).join(' | ')})`);

await browser.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nall assertions passed');
