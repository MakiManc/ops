// Online orders tab (Slerp) - Phase 1 of the systems plan, 20/11/2026.
//
// snap.slerp is baked from the "Slerp Order Events" feed (see the block in
// bake_ops_command.py). This pins the page's three states: the real block
// renders KPIs, store bars and the two tables with reconciled totals; a
// snapshot WITHOUT the block (every snapshot before 20/11) shows the empty
// note and nothing else; and the lost-orders KPI goes red at 5%.
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

// Fixture in the bake's shape, small enough to reconcile by hand.
const slerp = {
  source_feed: 'Slerp Order Events', pull_date: '2026-11-20', events_read: 1194, orders_in_archive: 214,
  days: [
    { day: '2026-11-18', orders: 50, sales: 1560.10 },
    { day: '2026-11-19', orders: 54, sales: 1407.40 },
  ],
  stores: [
    { store: 'Manchester', orders: 35, sales: 940.30, items: 70, delivery: 20, pickup: 15, table: 0, guest: 2, rejected: 0, refunded: 0, by_day: {} },
    { store: 'Shoreditch', orders: 13, sales: 604.05, items: 30, delivery: 6, pickup: 5, table: 2, guest: 1, rejected: 1, refunded: 2, by_day: {} },
  ],
  status_counts: { FULFILLED: 45, REFUNDED: 2, REJECTED: 1 },
  note: 'Orders are order.created events; state is the newest event per reference.',
};

const pinnedChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(pinnedChromium) ? { executablePath: pinnedChromium } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
// The page loads the LIVE snapshot from GitHub Pages on open and re-renders when
// it arrives, which can land after the fixture render below and wipe it. Fixture
// tests must not depend on the network: abort every remote request.
await page.route(/^https?:\/\//, r => r.abort());
await page.goto(pageUrl);
await page.waitForTimeout(1500);
const show = async sl => {
  const snap = { ...baseSnap };
  if (sl === undefined) delete snap.slerp; else snap.slerp = sl;
  await page.evaluate(s => window.render(s), snap);
  await page.evaluate(() => window.gotoPage('p-slerp'));
};

{
  await show(slerp);
  const nav = await page.locator('#nav button[data-p="p-slerp"]').innerText();
  assert(/Online orders/.test(nav), 'the tab is in the nav as "Online orders"');
  const kpis = await page.locator('#sl-kpis').innerText();
  assert(/Orders 11-19\s+54/i.test(kpis.replace(/\n/g, ' ')) && /vs 50 the day before/.test(kpis),
    `latest-day orders KPI reads 54 vs 50 (got ${JSON.stringify(kpis.slice(0, 120))})`);
  assert(/Orders, 2 days\s+48/i.test(kpis.replace(/\n/g, ' ')) && /£1,544/.test(kpis),
    'window KPI totals the stores: 48 orders, £1,544');
  assert(/Rejected \+ refunded\s+3/i.test(kpis.replace(/\n/g, ' ')) && /6% of orders/.test(kpis),
    '3 lost orders = 6% of 48');
  const redKpi = await page.locator('#sl-kpis .kpi.k-r').count();
  assert(redKpi === 1, 'the lost-orders KPI is red at 6% (threshold 5%)');
  assert(/Delivery share\s+54%/i.test(kpis.replace(/\n/g, ' ')), '26 of 48 delivery = 54%');
  const bars = await page.locator('#sl-bars .brow').count();
  assert(bars === 2, 'one bar per store');
  const firstBar = await page.locator('#sl-bars .brow').first().innerText();
  assert(/Manchester/.test(firstBar) && /£940/.test(firstBar), 'bars are stores by sales, Manchester first at £940');
  const days = await page.locator('#sl-days tbody tr').allInnerTexts();
  assert(days.length === 2 && /2026-11-19/.test(days[0]) && /£26/.test(days[0]),
    `day table newest first with AOV (£1,407.40 / 54 = £26) (got ${JSON.stringify(days[0])})`);
  const tbl = await page.locator('#sl-tbl tbody tr').allInnerTexts();
  assert(tbl.length === 3 && /All stores/.test(tbl[2]) && /\b48\b/.test(tbl[2]) && /£1,544/.test(tbl[2]),
    'store table has a totals row that reconciles with the KPIs');
  assert(/Clean/.test(tbl[0]) && /23% lost/.test(tbl[1]),
    `state chips: Manchester clean, Shoreditch 3 of 13 lost = 23% (got ${JSON.stringify(tbl[1])})`);
  const note = await page.locator('#sl-note').innerText();
  assert(/1,194 events read/.test(note) && /214 orders/.test(note), 'the provenance note quotes events and orders read');
}
{
  // 5% exactly is red; 2% is amber; 0 is green
  const mk = (orders, bad) => ({ ...slerp, stores: [{ ...slerp.stores[0], orders, sales: 100, rejected: bad, refunded: 0 }] });
  await show(mk(100, 5)); assert(await page.locator('#sl-kpis .kpi.k-r').count() === 1, '5 of 100 lost -> red');
  await show(mk(100, 2)); assert(await page.locator('#sl-kpis .kpi.k-a').count() === 1 && await page.locator('#sl-kpis .kpi.k-r').count() === 0, '2 of 100 lost -> amber');
  await show(mk(100, 0)); assert(await page.locator('#sl-kpis .kpi.k-g').count() === 1, '0 lost -> green');
}
{
  await show(undefined);
  const note = await page.locator('#sl-note').innerText();
  assert(/has not landed yet/.test(note), 'a snapshot without the block says the feed has not landed');
  assert((await page.locator('#sl-kpis').innerText()).trim() === '', 'and shows no KPIs');
  assert(/No Slerp data/.test(await page.locator('#sl-tbl').innerText()), 'and an empty store table');
}
assert(errors.length === 0, `no page errors (got ${JSON.stringify(errors)})`);
await browser.close();
if (failures > 0) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log('\nall assertions passed');
