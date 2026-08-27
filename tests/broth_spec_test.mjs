// Fixture test for the broth spec band on the Quality & Broth tab (27/08/2026).
//
// Ross set the factory standard: the refractometer reading taken AFTER ice is
// 8.0-9.0 for tonkotsu and 5.0-6.0 for chicken, and anything outside its band
// is a flag. Before this the heatmaps coloured against whatever range the
// snapshot happened to hold, so a whole estate sitting two points under spec
// looked perfectly normal. These assertions pin the parts that are easy to
// regress: the band is INCLUSIVE at both ends, colour keys off the band rather
// than the observed range, a snapshot's own band beats the page's fallback,
// and a snapshot baked before the band existed still gets flagged.
//
// Pattern (as supply_orders_otif_test.mjs): load command/index.html in
// headless Chromium via file://, call window.render(fixtureSnap) directly,
// assert on the resulting DOM. The base is a REAL baked snapshot with only
// snap.quality replaced, so every other tab still renders realistic data.
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

const TASKS = { 'Chicken Broth Check': 'chicken', 'Tonkotsu Broth Check': 'tonkotsu' };
const SPEC = { tonkotsu: { min: 8.0, max: 9.0 }, chicken: { min: 5.0, max: 6.0 } };

// chicken: 1 in / 1 low / 1 high / 1 not registered
// tonkotsu: 2 in (one of them exactly on the 8.0 floor) / 1 low / 1 high
function brothCells() {
  return [
    { site: 'Maki Alpha', kind: 'chicken',  d: '2026-08-20', value: 5.5,  spec: 'in',   checks: 1, checks_missed: 0 },
    { site: 'Maki Alpha', kind: 'chicken',  d: '2026-08-21', value: 4.2,  spec: 'low',  checks: 1, checks_missed: 0 },
    { site: 'Maki Beta',  kind: 'chicken',  d: '2026-08-20', value: 6.4,  spec: 'high', checks: 1, checks_missed: 0 },
    { site: 'Maki Beta',  kind: 'chicken',  d: '2026-08-21', value: null, spec: null,   checks: 1, checks_missed: 1 },
    { site: 'Maki Alpha', kind: 'tonkotsu', d: '2026-08-20', value: 8.5,  spec: 'in',   checks: 1, checks_missed: 0 },
    { site: 'Maki Alpha', kind: 'tonkotsu', d: '2026-08-21', value: 6.0,  spec: 'low',  checks: 1, checks_missed: 0 },
    { site: 'Maki Beta',  kind: 'tonkotsu', d: '2026-08-20', value: 9.6,  spec: 'high', checks: 1, checks_missed: 0 },
    // exactly on the floor - "between 8 and 9" includes 8
    { site: 'Maki Beta',  kind: 'tonkotsu', d: '2026-08-21', value: 8.0,  spec: 'in',   checks: 1, checks_missed: 0 },
  ];
}

function brothFixture() {
  return {
    broth: {
      cells: brothCells(),
      deviations: [
        { site: 'Maki Alpha', kind: 'tonkotsu', d: '2026-08-21', value: 6.0, spec: 'low', open: true },
        { site: 'Maki Beta',  kind: 'chicken',  d: '2026-08-20', value: 5.5, spec: 'in',  open: false },
      ],
      tasks: TASKS, spec: SPEC,
      spec_summary: {
        tonkotsu: { min: 8.0, max: 9.0, n: 4, in: 2, low: 1, high: 1 },
        chicken:  { min: 5.0, max: 6.0, n: 3, in: 1, low: 1, high: 1 },
      },
      spec_basis: 'test spec basis',
      basis: 'test broth basis',
    },
  };
}

// baked before the band existed: no snap-level spec block, no per-cell flag
function legacyBrothFixture() {
  const cells = brothCells().map(({ spec, ...rest }) => rest);
  return { broth: { cells, deviations: [], tasks: TASKS, basis: 'legacy broth basis' } };
}

// a snapshot carrying a DIFFERENT band: the page must follow the snapshot,
// never the fallback baked into the page
function rebandedBrothFixture() {
  const cells = brothCells().map(({ spec, ...rest }) => rest);
  return {
    broth: {
      cells, deviations: [], tasks: TASKS,
      spec: { tonkotsu: { min: 5.0, max: 6.0 }, chicken: { min: 1.0, max: 2.0 } },
      basis: 'rebanded broth basis',
    },
  };
}

const pinnedChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(
  existsSync(pinnedChromium) ? { executablePath: pinnedChromium } : {});
const page = await browser.newPage();
await page.goto(pageUrl);
// The page's own bootstrap fetches the live snapshot from GitHub Pages on
// load; that has no route out of this sandbox and fails loudly (expected,
// unrelated to this feature) - only start listening for errors AFTER that
// settles.
await page.waitForTimeout(1500);
const consoleErrors = [];
// The bootstrap fetch above can still be in flight when the wait expires and
// then logs a network error of its own. render() itself fetches nothing, so a
// failed resource load can never be the regression this assertion is for -
// drop those and keep every other console error and every page error.
const bootNoise = m => /net::ERR_|Failed to load resource|no data source reachable/.test(m);
page.on('pageerror', e => consoleErrors.push(String(e)));
page.on('console', msg => {
  if (msg.type() === 'error' && !bootNoise(msg.text())) consoleErrors.push(msg.text());
});

const cellData = host => page.evaluate(h => [...document.querySelectorAll(h + ' td.hcell')]
  .map(td => ({ v: td.textContent, title: td.getAttribute('title'),
                oos: td.classList.contains('hoos'), ins: td.classList.contains('hins'),
                bg: getComputedStyle(td).backgroundColor })), host);

// --------------------------------------------------- spec-band colouring ---
{
  const snap = { ...baseSnap, quality: brothFixture() };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-qual'); }, snap);

  const chick = await cellData('#qh-chicken');
  assert(chick.length === 3, `chicken: 3 numeric cells rendered (got ${chick.length})`);
  const miss = await page.locator('#qh-chicken td.hmiss').count();
  assert(miss === 1, `chicken: the unregistered check stays a hatched × cell, not a flag (got ${miss})`);
  assert(chick.filter(c => c.ins).length === 1 && chick.filter(c => c.oos).length === 2,
    'chicken: 5.5 reads in spec, 4.2 and 6.4 read out');

  const inCell = chick.find(c => c.ins), lowCell = chick.find(c => c.v === '4.2');
  assert(/rgba?\(5, *150, *105/.test(inCell.bg), `chicken: in-spec cell is green (got ${inCell.bg})`);
  assert(/rgba?\(220, *38, *38/.test(lowCell.bg), `chicken: out-of-spec cell is red (got ${lowCell.bg})`);
  assert(/— 4\.2 · 0\.8 below spec 5\.0–6\.0/.test(lowCell.title),
    `chicken: tooltip names the distance and the band (got "${lowCell.title}")`);
  assert(/in spec 5\.0–6\.0/.test(inCell.title),
    `chicken: in-spec tooltip names the band (got "${inCell.title}")`);

  const tonk = await cellData('#qh-tonkotsu');
  const onFloor = tonk.find(c => c.v === '8.0');
  assert(onFloor && onFloor.ins,
    'tonkotsu: a reading exactly on 8.0 is IN spec - the band is inclusive at both ends');
  const worst = tonk.find(c => c.v === '6.0');
  const other = tonk.find(c => c.v === '9.6');
  const alpha = bg => Number((bg.match(/rgba?\([^)]*?,\s*([\d.]+)\)/) || [])[1] || 1);
  assert(alpha(worst.bg) > alpha(other.bg),
    `tonkotsu: red deepens with distance out of band (2.0 below ${worst.bg} vs 0.6 above ${other.bg})`);

  // -- KPIs ---------------------------------------------------------------
  const kpis = await page.locator('#qual-kpis .kpi').allInnerTexts();
  const chickKpi = kpis.find(k => /CHICKEN OUT OF SPEC/i.test(k));
  const tonkKpi = kpis.find(k => /TONKOTSU OUT OF SPEC/i.test(k));
  assert(/\b67%/.test(chickKpi), `chicken KPI is 2 of 3 readings out = 67% (got "${chickKpi}")`);
  assert(/2 of 3 readings outside 5\.0–6\.0 after ice/.test(chickKpi),
    `chicken KPI sub names the count and the band (got "${chickKpi}")`);
  assert(/\b50%/.test(tonkKpi) && /2 of 4 readings outside 8\.0–9\.0 after ice/.test(tonkKpi),
    `tonkotsu KPI is 2 of 4 out = 50% against its own band (got "${tonkKpi}")`);

  // -- provenance ---------------------------------------------------------
  const prov = await page.locator('#qh-tonkotsu .prov').innerText();
  assert(/spec band 8\.0–9\.0 after ice/.test(prov) && /2 of 4 readings outside it/.test(prov),
    `tonkotsu prov states the band and the miss count (got "${prov}")`);
  assert(!/observed range/i.test(prov),
    'prov no longer claims the colours are scaled to the observed range');

  // -- out of spec by site ------------------------------------------------
  const bars = await page.locator('#qh-oos .brow').allInnerTexts();
  const alphaBar = bars.find(b => /Maki Alpha/.test(b));
  assert(/\b50%/.test(alphaBar), `by-site bar pools both broths: Alpha 2 of 4 = 50% (got "${alphaBar}")`);

  // -- flagged, by site & broth -------------------------------------------
  const rows = await page.locator('#qh-oos-tbl tbody tr').allInnerTexts();
  assert(rows.length === 4, `flagged table has one row per flagged site x broth (got ${rows.length})`);
  assert(rows[0].includes('Maki Alpha') && rows[0].includes('tonkotsu') && /6\.0 \(2\.0 below\)/.test(rows[0]),
    `flagged table leads with the worst gap - Alpha tonkotsu 6.0, 2.0 below (got "${rows[0]}")`);
  assert(rows.some(r => /Maki Beta/.test(r) && /tonkotsu/.test(r) && /1 of 2/.test(r)),
    'flagged table counts flags against that site\'s readings for that broth, not the estate');
  assert(!rows.some(r => /Below spec/.test(r) && /Above spec/.test(r)),
    'each flagged row carries one direction, low or high, never both');

  // -- deviations keep their own meaning ----------------------------------
  const devRows = await page.locator('#qh-dev tbody tr').allInnerTexts();
  assert(devRows.some(r => /Maki Alpha/.test(r) && /Below spec/.test(r) && /Open/.test(r)),
    'deviations table shows spec alongside GetCompliant\'s own open/closed state');
  assert(devRows.some(r => /Maki Beta/.test(r) && /In spec/.test(r)),
    'a GetCompliant deviation can sit inside the spec band - the two are different questions');
}

// -------------------------------------------------- pre-band snapshots ---
{
  const snap = { ...baseSnap, quality: legacyBrothFixture() };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-qual'); }, snap);
  const chick = await cellData('#qh-chicken');
  assert(chick.filter(c => c.oos).length === 2 && chick.filter(c => c.ins).length === 1,
    'legacy: a snapshot with no per-cell flag is still judged against the band');
  const kpis = await page.locator('#qual-kpis .kpi').allInnerTexts();
  assert(/2 of 3 readings outside 5\.0–6\.0/.test(kpis.find(k => /CHICKEN OUT OF SPEC/i.test(k))),
    'legacy: the KPI recomputes rather than reporting nothing');
}

// ------------------------------------------- the snapshot owns the band ---
{
  const snap = { ...baseSnap, quality: rebandedBrothFixture() };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-qual'); }, snap);
  const chick = await cellData('#qh-chicken');
  assert(chick.every(c => c.oos),
    'rebanded: every chicken reading is above a 1.0-2.0 band - the page follows the snapshot, not its own fallback');
  const tonk = await cellData('#qh-tonkotsu');
  assert(tonk.find(c => c.v === '6.0').ins,
    'rebanded: 6.0 tonkotsu is in spec under a 5.0-6.0 band');
  const prov = await page.locator('#qh-chicken .prov').innerText();
  assert(/spec band 1\.0–2\.0/.test(prov), `rebanded: prov quotes the snapshot's band (got "${prov}")`);
}

assert(consoleErrors.length === 0,
  `no console/page errors during any render() call (got ${consoleErrors.length}: ${consoleErrors.join(' | ')})`);

await browser.close();
console.log(failures ? `\n${failures} assertion(s) failed` : '\nall assertions passed');
process.exit(failures ? 1 : 0);
