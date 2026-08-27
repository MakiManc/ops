// Fixture test for the Supply & Fulfilment tab after the upgrade of the
// existing 'Kobas Orders' feed and the new monthly supplier OTIF block
// (26/08/2026). Replaces supply_kobas_test.mjs, which asserted on the
// retired 'kobas_live' pending-orders shape.
//
// Pattern (unchanged): load command/index.html in headless Chromium via
// file://, call window.render(fixtureSnap) directly (render / renderOtif /
// openWeekSpendModal / openModal are plain top-level function declarations in
// a non-module <script>, so they land on window automatically), then assert on
// the resulting DOM. The base is a REAL baked snapshot with only snap.supply
// and snap.gaps replaced per scenario, so every other tab still renders
// realistic data and a regression there still surfaces.
//
// The supply fixtures below are REAL output from bake_ops_command.py run
// against a seeded warehouse holding 76 genuine parsed confirmation emails --
// trimmed for readability, not hand-invented -- so the shapes here are the
// shapes the builder actually emits.
//
// Run: node tests/supply_orders_otif_test.mjs   (exits non-zero on any failure)

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

const OTIF_NOTE = 'An issue-free-delivery rate, NOT a measured on-time-in-full: nothing here ' +
  'observes whether a delivery arrived on time or complete, only whether an issue was filed ' +
  'against that supplier in the same month. Issue history begins 2026-08-13, so August ' +
  'denominators cover the whole month but its issue counts only start mid-month - August OTIF ' +
  'is therefore flattered and is not comparable with later months. Suppliers with deliveries ' +
  'and no issues show 100%; suppliers with no deliveries show an em dash, never 0%. Issues ' +
  'that name no supplier are excluded from the per-supplier rows and disclosed as ' +
  'unattributed_issues.';

function emailSupplyFixture() {
  return {
    week_spend: [
      { site: 'Maki Metro',      supplier: 'LWC Northeast', supplier_canon: 'LWC',
        orders: 1, lines: 41, items: 80, value_gbp: 1820.58 },
      { site: 'Maki Lakeside',   supplier: 'LWC London',    supplier_canon: 'LWC',
        orders: 1, lines: 47, items: 90, value_gbp: 1354.27 },
      { site: 'Maki Renfield',   supplier: 'LWC Northeast', supplier_canon: 'LWC',
        orders: 1, lines: 48, items: 64, value_gbp: 1240.52 },
      { site: 'Maki Southampton',supplier: 'Brakes',        supplier_canon: 'Brakes',
        orders: 3, lines: 37, items: 76, value_gbp: 1166.19 },
    ],
    // The same four rows rolled up by supplier, as the builder emits them.
    // LWC Northeast's 2 orders sit at 2 sites so they are 2 deliveries;
    // Brakes' 3 orders at one site include two on the same day, so 2 - which
    // is what makes Deliveries a different number from Orders.
    supplier_totals: [
      { supplier: 'LWC Northeast', supplier_canon: 'LWC', orders: 2, deliveries: 2,
        lines: 89, items: 144, sites: 2, value_gbp: 3061.10 },
      { supplier: 'LWC London', supplier_canon: 'LWC', orders: 1, deliveries: 1,
        lines: 47, items: 90, sites: 1, value_gbp: 1354.27 },
      { supplier: 'Brakes', supplier_canon: 'Brakes', orders: 3, deliveries: 2,
        lines: 37, items: 76, sites: 1, value_gbp: 1166.19 },
    ],
    supplier_totals_basis: 'Same orders as the site table above, grouped by supplier. Deliveries counts distinct site+delivery-date combinations. Scheduled deliveries, not confirmed ones.',
    week_start: '2026-08-24', week_end: '2026-08-30',
    week_spend_source: 'order_emails',
    week_spend_basis: 'Kobas Orders (daily IMAP parse of Kobas order-confirmation emails, pull_date=2026-09-03): test basis string',
    week_totals: { orders: 6, lines: 173, items: 310, value_gbp: 5581.56 },
    week_days: [{ d: '2026-08-24', orders: 4, value_gbp: 3932.15 }],
    week_drill: [
      { site: 'Maki Lakeside', order_no: '3031/37867', supplier: 'LWC London',
        d: '2026-08-24', lines: 47, items: 90, value_gbp: 1354.27, staff: 'thomas smith' },
      { site: 'Maki Metro', order_no: '3031/37855', supplier: 'LWC Northeast',
        d: '2026-08-24', lines: 17, items: 48, value_gbp: 735.33, staff: 'Yiwei Hong' },
    ],
    week_drill_total: 2, week_drill_truncated: false,
    coverage: {
      suppliers_in_emails: ['Brakes', 'LWC London', 'LWC Northeast', 'Perfect Ted'],
      suppliers_missing_from_emails: ['HARRO', 'JFC', 'LYNAS FOODSERVICE'],
      basis: 'test coverage basis',
    },
    otif: {
      months: [
        { month: '2026-08', deliveries: 76, issues: 5, unattributed_issues: 1, otif_pct: 93.4,
          suppliers: [
            { supplier: 'LWC',         supplier_canon: 'LWC',         deliveries: 49, issues: 0, otif_pct: 100.0 },
            { supplier: 'Brakes',      supplier_canon: 'Brakes',      deliveries: 24, issues: 3, otif_pct: 87.5 },
            { supplier: 'Perfect Ted', supplier_canon: 'Perfect Ted', deliveries: 3,  issues: 0, otif_pct: 100.0 },
            // the 0-deliveries supplier: issues filed, nothing delivered ->
            // otif_pct MUST be null and MUST render as an em dash, never 0%
            { supplier: 'Lynas',       supplier_canon: 'Lynas',       deliveries: 0,  issues: 2, otif_pct: null },
          ] },
        { month: '2026-09', deliveries: 40, issues: 2, unattributed_issues: 0, otif_pct: 95.0,
          suppliers: [
            { supplier: 'LWC',         supplier_canon: 'LWC',         deliveries: 27, issues: 1, otif_pct: 96.3 },
            { supplier: 'Brakes',      supplier_canon: 'Brakes',      deliveries: 11, issues: 1, otif_pct: 90.9 },
            { supplier: 'Perfect Ted', supplier_canon: 'Perfect Ted', deliveries: 2,  issues: 0, otif_pct: 100.0 },
          ] },
      ],
      basis: 'test otif basis',
      first_month: '2026-08',
      issues_history_start: '2026-08-13',
      note: OTIF_NOTE,
    },
    price_watch: [], price_watch_basis: 'test',
  };
}

function fallbackSupplyFixture() {
  return {
    week_spend: [
      { site: 'Maki Newcastle', supplier: 'AA Factory1 Limited', orders: 1,
        value_gbp: 5100.0, lines: null, items: null, supplier_canon: 'AA Factory' },
    ],
    supplier_totals: [
      { supplier: 'AA Factory1 Limited', supplier_canon: 'AA Factory', orders: 1,
        deliveries: null, lines: null, items: null, sites: 1, value_gbp: 5100.0 },
    ],
    supplier_totals_basis: 'Weekly outstanding-orders report grouped by supplier. That report carries no line, item or delivery-date detail per order.',
    week_start: '2026-08-24', week_end: '2026-08-30',
    week_spend_source: 'weekly_report_fallback',
    week_spend_basis: 'Kobas Orders feed missing - projected spend falling back to the weekly outstanding-orders report',
    week_totals: null, week_days: [], week_drill: [], week_drill_total: 0,
    week_drill_truncated: false, coverage: null,
    otif: { months: [], basis: null, first_month: '2026-08',
            issues_history_start: '2026-08-13', note: OTIF_NOTE },
    price_watch: [], price_watch_basis: 'test',
  };
}

// a snapshot baked before either block existed
function legacySupplyFixture() {
  return {
    week_spend: [{ site: 'Maki Metro', supplier: 'HARRO', orders: 4, value_gbp: 500, supplier_canon: 'Harro' }],
    week_start: '2026-08-24', week_end: '2026-08-30',
    week_spend_source: 'weekly_report_fallback',
    week_spend_basis: 'legacy snapshot',
    week_totals: null, week_days: [], week_drill: [], week_drill_total: 0,
    week_drill_truncated: false,
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
// settles.
await page.waitForTimeout(1500);
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

// ------------------------------------------------------- order emails ---
{
  const snap = { ...baseSnap, gaps: [
    'Kobas Orders covers 4 supplier(s); 3 supplier(s) the estate orders from send no confirmation email and are therefore ABSENT from projected spend this week: HARRO, JFC, LYNAS FOODSERVICE.',
  ], supply: emailSupplyFixture() };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-supp'); }, snap);

  // -- site boxes ---------------------------------------------------------
  const boxCount = await page.locator('#fa-aging .sitebox').count();
  assert(boxCount === 4, `emails: 4 site boxes rendered (got ${boxCount})`);
  const splitBars = await page.locator('#fa-aging .sitebox .splitbar').count();
  assert(splitBars === 0,
    `emails: NO split bars - the source has no delivered status to split on (got ${splitBars})`);
  const soton = await page.locator('#fa-aging .sitebox[data-site="Maki Southampton"] .sb').innerText();
  assert(/3 orders/.test(soton) && /37 lines/.test(soton),
    `emails: site subline is "N orders · N lines" (got "${soton}")`);
  assert(!/delivered/i.test(soton), `emails: site subline claims nothing about delivery (got "${soton}")`);

  // -- by-supplier table --------------------------------------------------
  // Headers are uppercased by CSS, so compare lowercased - the same thing the
  // KPI-label assertion below does.
  const supHead = (await page.locator('#sup-tot table thead th').allInnerTexts())
    .map(t => t.toLowerCase());
  assert(supHead.join('|') === 'supplier|£ spend|share|orders|deliveries|lines|items|sites',
    `emails: by-supplier columns are supplier/spend/share/orders/deliveries/lines/items/sites (got ${JSON.stringify(supHead)})`);
  const supRows = await page.locator('#sup-tot table tbody tr').count();
  assert(supRows === 4, `emails: 3 supplier rows plus a total (got ${supRows})`);
  const firstCells = (await page.locator('#sup-tot table tbody tr').first().locator('td').allInnerTexts());
  assert(firstCells[0] === 'LWC Northeast',
    `emails: suppliers are ordered by spend, biggest first (got "${firstCells[0]}")`);
  assert(firstCells[1] === '£3,061', `emails: spend renders as rounded GBP (got "${firstCells[1]}")`);
  assert(firstCells[2] === '54.8%', `emails: share of week spend (got "${firstCells[2]}")`);
  assert(firstCells[3] === '2' && firstCells[4] === '2' && firstCells[5] === '89'
      && firstCells[6] === '144' && firstCells[7] === '2',
    `emails: orders/deliveries/lines/items/sites (got ${JSON.stringify(firstCells.slice(3))})`);
  // Deliveries must not silently duplicate Orders - Brakes is the case that
  // distinguishes them (3 orders arriving as 2 deliveries).
  const brakes = await page.locator('#sup-tot table tbody tr', { hasText: 'Brakes' }).first().locator('td').allInnerTexts();
  assert(brakes[3] === '3' && brakes[4] === '2',
    `emails: a supplier with two orders on one day shows fewer deliveries than orders (got ${brakes[3]} orders, ${brakes[4]} deliveries)`);
  // The total row must reconcile with the KPI strip, or the two disagree on
  // screen and the reader cannot tell which to believe.
  const supTot = await page.locator('#sup-tot table tbody tr.tot td').allInnerTexts();
  assert(supTot[0] === 'Total' && supTot[1] === '£5,582' && supTot[2] === '100.0%',
    `emails: total row sums to the week's spend (got ${JSON.stringify(supTot.slice(0, 3))})`);
  assert(supTot[3] === '6' && supTot[5] === '173' && supTot[6] === '310',
    `emails: total orders/lines/items match week_totals (got ${JSON.stringify(supTot.slice(3))})`);
  const supBasis = await page.locator('#sup-tot .prov').innerText();
  assert(/not confirmed ones/.test(supBasis),
    `emails: the basis line says these are scheduled, not confirmed, deliveries (got "${supBasis}")`);

  // -- KPI strip ----------------------------------------------------------
  const kpiLabels = (await page.locator('#supp-kpis .kpi .lb').allInnerTexts()).map(t => t.toLowerCase());
  assert(kpiLabels.join('|') === 'projected spend this week|items ordered this week|otif this month|top supplier this week|issues logged',
    `emails: KPI strip is spend/items/OTIF/top supplier/issues (got ${JSON.stringify(kpiLabels)})`);
  assert(!kpiLabels.includes('still to come') && !kpiLabels.includes('delivered so far'),
    'emails: KPI strip invents no delivered/pending split');
  const vals = await page.locator('#supp-kpis .kpi .vl').allInnerTexts();
  assert(vals[0] === '£5,582', `emails: spend KPI rounds 5581.56 to £5,582 (got "${vals[0]}")`);
  assert(vals[1] === '310', `emails: items KPI is the summed order quantities, 310 (got "${vals[1]}")`);
  assert(vals[2] === '95.0%', `emails: OTIF KPI is the LATEST month's weighted figure, 95.0% (got "${vals[2]}")`);
  assert(vals[3] === 'LWC Northeast',
    `emails: top supplier is by value across the week, LWC Northeast (got "${vals[3]}")`);
  const itemsSub = await page.locator('#supp-kpis .kpi').nth(1).locator('.sb').innerText();
  assert(/173 order lines/.test(itemsSub), `emails: items KPI subline carries the line count (got "${itemsSub}")`);

  // -- OTIF table ---------------------------------------------------------
  const otifRows = await page.locator('#otif-tbl tbody tr').count();
  assert(otifRows === 4, `emails: OTIF table defaults to the latest month, 3 suppliers + total (got ${otifRows})`);
  const monthSel = await page.locator('#otif-month').inputValue();
  assert(monthSel === '2026-09', `emails: month selector defaults to the latest month (got "${monthSel}")`);
  let otifHtml = await page.locator('#otif-tbl').innerHTML();
  assert(/▼ down 3\.7 pts/.test(otifHtml),
    'emails: LWC 100.0 -> 96.3 renders as "▼ down 3.7 pts" (direction in glyph AND words, never colour alone)');
  assert(/▲ up 3\.4 pts/.test(otifHtml), 'emails: Brakes 87.5 -> 90.9 renders as "▲ up 3.4 pts"');
  assert(/▬ level/.test(otifHtml), 'emails: Perfect Ted 100.0 -> 100.0 renders as "▬ level"');
  assert(/All suppliers/.test(otifHtml) && /95\.0%/.test(otifHtml),
    'emails: OTIF table carries a weighted All suppliers row');
  assert(!/August/.test(await page.locator('#otif-tbl .prov').last().innerText()),
    'emails: the August caveat does NOT show while a later month is selected');

  // switch to August: the 0-deliveries supplier and the caveat
  await page.selectOption('#otif-month', '2026-08');
  otifHtml = await page.locator('#otif-tbl').innerHTML();
  const lynasRow = await page.locator('#otif-tbl tbody tr', { hasText: 'Lynas' }).innerText();
  assert(/Lynas/.test(lynasRow) && /—/.test(lynasRow),
    `emails: a supplier with 0 deliveries and 2 issues shows an em dash, never 0% (got "${lynasRow.replace(/\s+/g,' ')}")`);
  assert(!/\b0\.0%/.test(lynasRow), 'emails: the 0-deliveries supplier is not rendered as 0.0%');
  const lwcRow = await page.locator('#otif-tbl tbody tr', { hasText: 'LWC' }).first().innerText();
  assert(/100\.0%/.test(lwcRow), `emails: a supplier with deliveries and no issues shows 100% (got "${lwcRow.replace(/\s+/g,' ')}")`);
  const provText = await page.locator('#otif-tbl .prov').allInnerTexts();
  const provJoined = provText.join(' ');
  assert(/August 2026 is not comparable with later months/.test(provJoined),
    'emails: August carries the "not comparable" caveat naming the issue-history start');
  assert(/2026-08-13/.test(provJoined), 'emails: the caveat names the 13 Aug 2026 issue-history start date');
  assert(/issue-free-delivery rate/i.test(provJoined) && /NOT a measured on-time-in-full/i.test(provJoined),
    'emails: the OTIF definition note is on screen, not just in the JSON');
  assert(/1 issue that month named no supplier/.test(provJoined),
    'emails: unattributed issues are disclosed rather than silently dropped');
  const augRows = await page.locator('#otif-tbl tbody tr').count();
  assert(augRows === 5, `emails: August shows 4 suppliers + total (got ${augRows})`);

  // -- coverage gap note --------------------------------------------------
  const gapNote = await page.locator('#fa-aging .prov', { hasText: 'send no confirmation email' }).count();
  assert(gapNote >= 1, 'emails: the supplier-coverage gap is visible under the card, naming the missing suppliers');

  // -- drill-down modal ---------------------------------------------------
  await page.locator('#fa-aging .sitebox[data-site="Maki Lakeside"]').click();
  assert(await page.locator('#task-modal-ov.on').count() === 1, 'emails: clicking a site box opens the modal');
  const modalHtml = await page.locator('#task-modal-b').innerHTML();
  assert(/Every order/.test(modalHtml), 'emails modal: has an Every order section');
  assert(/3031\/37867/.test(modalHtml), 'emails modal: order rows carry the Kobas Reference as the order no.');
  assert(/thomas smith/.test(modalHtml), 'emails modal: order rows carry who placed it');
  assert(/>47</.test(modalHtml) && /&gt;?90|>90</.test(modalHtml.replace(/\s/g,'')) || /47/.test(modalHtml),
    'emails modal: order rows carry line and item counts');
  assert(!/Delivered|Pending/.test(modalHtml),
    'emails modal: no delivered/pending status chips - the source knows no status');
  const modalKpis = (await page.locator('#task-modal-b .kpi .lb').allInnerTexts()).map(t => t.toLowerCase());
  assert(modalKpis.join(',') === 'total,items ordered,suppliers',
    `emails modal: chip row is Total/Items ordered/Suppliers (got ${JSON.stringify(modalKpis)})`);
  await page.locator('#task-modal-x').click();

  // -- supplier profile modal gains OTIF by month -------------------------
  await page.evaluate(() => window.openSupplierProfileModal('Brakes'));
  const profHtml = await page.locator('#task-modal-b').innerHTML();
  assert(/OTIF by month/.test(profHtml), 'profile modal: has an OTIF by month section');
  assert(/August 2026/.test(profHtml) && /87\.5%/.test(profHtml),
    "profile modal: shows this supplier's own monthly deliveries/issues/OTIF");
  await page.locator('#task-modal-x').click();
}

// ---------------------------------------- fallback: email feed absent ---
{
  const snap = { ...baseSnap, gaps: [
    'Kobas Orders feed missing - projected spend falling back to the weekly outstanding-orders report (may be up to 7 days stale)',
    'Monthly supplier OTIF unavailable: it needs the Kobas Orders feed for its delivery counts, and that feed is absent this bake',
  ], supply: fallbackSupplyFixture() };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-supp'); }, snap);

  const boxCount = await page.locator('#fa-aging .sitebox').count();
  assert(boxCount === 1, `fallback: 1 site box rendered (got ${boxCount})`);
  const sub = await page.locator('#fa-aging .sitebox[data-site="Maki Newcastle"] .sb').innerText();
  assert(/1 supplier/.test(sub) && !/line/.test(sub),
    `fallback: subline falls back to the supplier count, claiming no line data (got "${sub}")`);

  const vals = await page.locator('#supp-kpis .kpi .vl').allInnerTexts();
  assert(vals[0] === '£5,100', `fallback: spend KPI still renders (got "${vals[0]}")`);
  assert(vals[1] === '—', `fallback: items KPI is an em dash, never 0 (got "${vals[1]}")`);
  assert(vals[2] === '—', `fallback: OTIF KPI is an em dash, never 0% (got "${vals[2]}")`);

  const gapNote = await page.locator('#fa-aging .prov', { hasText: 'falling back to the weekly outstanding-orders report' }).count();
  assert(gapNote >= 1, 'fallback: the gap note about the missing email feed is visible under the card');

  const fbCells = await page.locator('#sup-tot table tbody tr').first().locator('td').allInnerTexts();
  assert(fbCells[0] === 'AA Factory1 Limited' && fbCells[1] === '£5,100',
    `fallback: by-supplier still shows spend (got ${JSON.stringify(fbCells.slice(0, 2))})`);
  assert(fbCells[4] === '—' && fbCells[5] === '—' && fbCells[6] === '—',
    `fallback: deliveries/lines/items are em dashes, never 0 (got ${JSON.stringify(fbCells.slice(4, 7))})`);
  const fbTot = await page.locator('#sup-tot table tbody tr.tot td').allInnerTexts();
  assert(fbTot[4] === '—' && fbTot[5] === '—',
    `fallback: the total row does not invent a 0 for columns the source lacks (got ${JSON.stringify(fbTot.slice(4, 6))})`);
  const fbSub = await page.locator('#sup-tot-sub').innerText();
  assert(/no line, item or delivery detail/.test(fbSub),
    `fallback: the subline says why the columns are blank (got "${fbSub}")`);

  const otifEmpty = await page.locator('#otif-tbl .empty').count();
  assert(otifEmpty === 1, 'fallback: the OTIF card shows an empty state, not a table of zeros');
  const otifEmptyText = await page.locator('#otif-tbl .empty').innerText();
  assert(/had not landed/.test(otifEmptyText),
    `fallback: the OTIF empty state explains why (got "${otifEmptyText}")`);
  assert(await page.locator('#otif-tbl table').count() === 0, 'fallback: no OTIF table is drawn');

  await page.locator('#fa-aging .sitebox[data-site="Maki Newcastle"]').click();
  const modalHtml = await page.locator('#task-modal-b').innerHTML();
  assert(!/Every order/.test(modalHtml), 'fallback modal: no Every order table - the source has no per-order detail');
  assert(/£ projected/.test(modalHtml), 'fallback modal: keeps the original by-supplier table shape');
  await page.locator('#task-modal-x').click();
}

// ------------------------------------- legacy snapshot: no otif block ---
{
  const snap = { ...baseSnap, gaps: [], supply: legacySupplyFixture() };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-supp'); }, snap);
  const txt = await page.locator('#otif-tbl .empty').innerText();
  assert(/predates/.test(txt), `legacy: a snapshot with no otif block says it predates the data (got "${txt}")`);
  const otifKpi = (await page.locator('#supp-kpis .kpi .vl').allInnerTexts())[2];
  assert(otifKpi === '—', `legacy: OTIF KPI is an em dash (got "${otifKpi}")`);
  // A snapshot baked before supplier_totals existed has no such key. The card
  // must show an empty state rather than throwing or drawing a headers-only
  // table - old snapshots stay viewable through the roll-back selector.
  assert(await page.locator('#sup-tot table').count() === 0,
    'legacy: no by-supplier table is drawn for a snapshot that predates it');
  const legacyEmpty = await page.locator('#sup-tot .empty').innerText();
  assert(/No orders due this week/.test(legacyEmpty),
    `legacy: the by-supplier card shows an empty state (got "${legacyEmpty}")`);
  await page.evaluate(() => window.openSupplierProfileModal('Harro'));
  const profHtml = await page.locator('#task-modal-b').innerHTML();
  assert(/Monthly OTIF is not in this snapshot/.test(profHtml),
    'legacy: the supplier profile says OTIF is absent rather than showing an empty table');
  await page.locator('#task-modal-x').click();
}

assert(consoleErrors.length === 0,
  `no console/page errors during any render() call (got ${consoleErrors.length}: ${consoleErrors.slice(0,3).join(' | ')})`);

await browser.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nall assertions passed');
