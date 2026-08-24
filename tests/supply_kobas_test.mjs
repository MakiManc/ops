// Fixture test for the Supply & Fulfilment "Projected spend this week" card
// after the Kobas live pending-orders switch (24/08/2026).
//
// Pattern: load command/index.html in headless Chromium via file://, call
// window.render(fixtureSnap) directly (render/openWeekSpendModal/openModal
// are plain top-level function declarations in a non-module <script>, so
// they land on window automatically), then assert on the resulting DOM.
// The fixture is a REAL baked snapshot (data/ops_command/snapshot_2026-08-24.json)
// with only snap.supply replaced per scenario, so every other tab's render
// path gets realistic data and any real regression there still surfaces.
//
// Run: node tests/supply_kobas_test.mjs   (exits non-zero on any failure)

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pageUrl = 'file://' + path.join(repoRoot, 'command', 'index.html');
const baseSnap = JSON.parse(
  readFileSync(path.join(repoRoot, 'data', 'ops_command', 'snapshot_2026-08-24.json'), 'utf-8'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); }
  else console.log('ok  :', msg);
}

function liveSupplyFixture() {
  return {
    week_spend: [
      { site: 'Maki Metro', supplier: 'HARRO', orders: 3, value_gbp: 300,
        delivered_value_gbp: 100, pending_value_gbp: 200, supplier_canon: 'HARRO' },
      { site: 'Maki Metro', supplier: 'JFC', orders: 1, value_gbp: 50,
        delivered_value_gbp: 0, pending_value_gbp: 50, supplier_canon: 'JFC' },
      { site: 'Maki SJQ', supplier: 'LYNAS FOODSERVICE', orders: 2, value_gbp: 400,
        delivered_value_gbp: 400, pending_value_gbp: 0, supplier_canon: 'LYNAS FOODSERVICE' },
    ],
    week_start: '2026-08-24', week_end: '2026-08-30',
    week_spend_source: 'kobas_live',
    week_spend_basis: 'Kobas Pending Orders (live daily pull, pull_date=2026-08-24): test basis string',
    week_totals: { orders: 6, delivered_orders: 3, pending_orders: 3,
      value_gbp: 750, delivered_value_gbp: 500, pending_value_gbp: 250 },
    week_days: [
      { d: '2026-08-24', orders: 2, value_gbp: 350 },
      { d: '2026-08-25', orders: 4, value_gbp: 400 },
    ],
    week_drill: [
      { site: 'Maki Metro', order_no: '3031/1001', supplier: 'HARRO', d: '2026-08-24',
        value_gbp: 150, status: 'delivered', staff: 'Alex' },
      { site: 'Maki Metro', order_no: '3031/1002', supplier: 'HARRO', d: '2026-08-25',
        value_gbp: 150, status: 'pending', staff: 'Sam' },
      { site: 'Maki Metro', order_no: '3031/1003', supplier: 'JFC', d: '2026-08-25',
        value_gbp: 50, status: 'pending', staff: 'Sam' },
      { site: 'Maki SJQ', order_no: '3031/1004', supplier: 'LYNAS FOODSERVICE', d: '2026-08-24',
        value_gbp: 200, status: 'delivered', staff: 'Jo' },
      { site: 'Maki SJQ', order_no: '3031/1005', supplier: 'LYNAS FOODSERVICE', d: '2026-08-24',
        value_gbp: 200, status: 'delivered', staff: 'Jo' },
    ],
    week_drill_total: 5, week_drill_truncated: false,
    price_watch: [], price_watch_basis: 'test',
  };
}

function fallbackSupplyFixture() {
  return {
    week_spend: [
      { site: 'Maki Metro', supplier: 'HARRO', orders: 4, value_gbp: 500, supplier_canon: 'HARRO' },
    ],
    week_start: '2026-08-24', week_end: '2026-08-30',
    week_spend_source: 'weekly_report_fallback',
    week_spend_basis: 'Kobas Pending Orders feed missing - projected spend falling back to the weekly outstanding-orders report',
    week_totals: null, week_days: [], week_drill: [], week_drill_total: 0, week_drill_truncated: false,
    price_watch: [], price_watch_basis: 'test',
  };
}

function emptySupplyFixture() {
  return {
    week_spend: [], week_start: '2026-08-24', week_end: '2026-08-30',
    week_spend_source: 'kobas_live',
    week_spend_basis: 'Kobas Pending Orders (live daily pull, pull_date=2026-08-24): no supplier orders due this week',
    week_totals: { orders: 0, delivered_orders: 0, pending_orders: 0,
      value_gbp: 0, delivered_value_gbp: 0, pending_value_gbp: 0 },
    week_days: [], week_drill: [], week_drill_total: 0, week_drill_truncated: false,
    price_watch: [], price_watch_basis: 'test',
  };
}

// This container pins an older Chromium revision than the installed
// playwright npm package expects (see repo CI notes) - launch it by
// explicit path rather than letting Playwright resolve its own (newer,
// not-downloaded) revision.
const pinnedChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(
  existsSync(pinnedChromium) ? { executablePath: pinnedChromium } : {});
const page = await browser.newPage();
await page.goto(pageUrl);
// The page's own bootstrap fetches the live snapshot from GitHub Pages on
// load; that has no route out of this sandbox and fails loudly (expected,
// unrelated to this feature) - only start listening for errors AFTER that
// settles, so the assertions below cover render()/openWeekSpendModal()
// exceptions, not pre-existing offline noise.
await page.waitForTimeout(1500);
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

// ---------------------------------------------------------------- live ---
{
  const snap = { ...baseSnap, gaps: baseSnap.gaps || [], supply: liveSupplyFixture() };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-supp'); }, snap);

  const boxCount = await page.locator('#fa-aging .sitebox').count();
  assert(boxCount === 2, `live: 2 site boxes rendered (got ${boxCount})`);

  const splitBarCount = await page.locator('#fa-aging .sitebox .splitbar').count();
  assert(splitBarCount === 2, `live: every site box has a split bar (got ${splitBarCount})`);

  const metroSub = await page.locator('#fa-aging .sitebox[data-site="Maki Metro"] .sb').innerText();
  assert(metroSub.includes('4 orders'), `live: Maki Metro subline shows order count (got "${metroSub}")`);
  assert(metroSub.includes('delivered'), `live: Maki Metro subline shows delivered note (got "${metroSub}")`);

  const kpiLabels = (await page.locator('#supp-kpis .kpi .lb').allInnerTexts()).map(t=>t.toLowerCase());
  assert(kpiLabels.includes('still to come'), `live KPI strip has "Still to come" (got ${JSON.stringify(kpiLabels)})`);
  assert(kpiLabels.includes('delivered so far'), `live KPI strip has "Delivered so far" (got ${JSON.stringify(kpiLabels)})`);
  assert(!kpiLabels.includes('top site this week'), 'live KPI strip does NOT show "Top site this week"');

  const totalVal = await page.locator('#supp-kpis .kpi').first().locator('.vl').innerText();
  assert(totalVal === '£750', `live: total KPI value is £750 (got ${totalVal})`);

  // drill-down modal
  await page.locator('#fa-aging .sitebox[data-site="Maki Metro"]').click();
  const modalOpen = await page.locator('#task-modal-ov.on').count();
  assert(modalOpen === 1, 'live: clicking a site box opens the modal');
  const modalTitle = await page.locator('#task-modal-t').innerText();
  assert(modalTitle === 'Maki Metro', `live: modal title is the site name (got "${modalTitle}")`);
  const modalHtml = await page.locator('#task-modal-b').innerHTML();
  assert(modalHtml.includes('By supplier'), 'live modal: has a By supplier section');
  assert(modalHtml.includes('Every order'), 'live modal: has an Every order section');
  assert(modalHtml.includes('3031/1001'), 'live modal: order rows include order_no');
  assert(modalHtml.includes('Delivered') && modalHtml.includes('Pending'),
    'live modal: status chips show both Delivered and Pending');
  const modalKpiLabels = (await page.locator('#task-modal-b .kpi .lb').allInnerTexts()).map(t=>t.toLowerCase());
  assert(modalKpiLabels.join(',') === 'total,still to come,delivered',
    `live modal: chip row is Total/Still to come/Delivered (got ${JSON.stringify(modalKpiLabels)})`);
  await page.locator('#task-modal-x').click();
}

// ----------------------------------------------------------- fallback ---
{
  const snap = {
    ...baseSnap,
    gaps: ['Kobas Pending Orders feed missing - projected spend falling back to the weekly outstanding-orders report (may be up to 7 days stale)'],
    supply: fallbackSupplyFixture(),
  };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-supp'); }, snap);

  const boxCount = await page.locator('#fa-aging .sitebox').count();
  assert(boxCount === 1, `fallback: 1 site box rendered (got ${boxCount})`);
  const splitBarCount = await page.locator('#fa-aging .sitebox .splitbar').count();
  assert(splitBarCount === 0, `fallback: no split bars (source has no delivered data, got ${splitBarCount})`);

  const kpiLabels = (await page.locator('#supp-kpis .kpi .lb').allInnerTexts()).map(t=>t.toLowerCase());
  assert(kpiLabels.includes('top site this week'), `fallback KPI strip keeps "Top site this week" (got ${JSON.stringify(kpiLabels)})`);
  assert(!kpiLabels.includes('still to come'), 'fallback KPI strip does NOT invent "Still to come"');
  assert(!kpiLabels.includes('delivered so far'), 'fallback KPI strip does NOT invent "Delivered so far"');

  const gapNoteCount = await page.locator('#fa-aging .prov', { hasText: 'falling back to the weekly outstanding-orders report' }).count();
  assert(gapNoteCount >= 1, 'fallback: gap note about the missing live feed is visible under the card');

  await page.locator('#fa-aging .sitebox[data-site="Maki Metro"]').click();
  const modalHtml = await page.locator('#task-modal-b').innerHTML();
  assert(!modalHtml.includes('Every order'), 'fallback modal: no Every order table (source has no per-order detail)');
  assert(modalHtml.includes('£ projected'), 'fallback modal: keeps the original by-supplier table shape');
  await page.locator('#task-modal-x').click();
}

// --------------------------------------------------------- empty week ---
{
  const snap = { ...baseSnap, gaps: baseSnap.gaps || [], supply: emptySupplyFixture() };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-supp'); }, snap);

  const emptyMsg = await page.locator('#fa-aging .empty').count();
  assert(emptyMsg === 1, 'empty week: site-box area shows the empty-state message');
  const totalVal = await page.locator('#supp-kpis .kpi').first().locator('.vl').innerText();
  assert(totalVal === '£0', `empty week: total KPI reads £0, not blank/NaN (got "${totalVal}")`);
}

assert(consoleErrors.length === 0,
  `no console/page errors during any render() call (got ${consoleErrors.length}: ${consoleErrors.slice(0,3).join(' | ')})`);

await browser.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nAll supply_kobas_test assertions passed');
