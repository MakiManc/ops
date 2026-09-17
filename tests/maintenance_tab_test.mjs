// Fixture test for the Maintenance tab's three-state status (17/09/2026).
//
// WHY: the tab had no test of any kind, and the drill-down's status column was
// a two-way ternary whose ELSE branch was a green '✓ Resolved' chip. Every
// status that was not the exact string 'ongoing' therefore rendered as work
// that had been done — so introducing a third status without touching this
// page would have swapped one wrong answer for another, and silently dropped
// those rows out of both per-site counters at the same time.
//
// The companion tests/maintenance_status_test.py pins the CLASSIFICATION (a
// pure function, no browser). This file pins what the page DOES with it.
//
// Pattern, as in the other suites: load command/index.html in headless
// Chromium via file://, call window.render(fixtureSnap) directly, assert on the
// DOM. The base is a REAL baked snapshot with only snap.maintenance replaced,
// so every other tab still renders realistic data.
//
// Assertions here are looked up BY LABEL, not by tile position. This file adds
// a tile, and a positional test would have to be rewritten by anyone who adds
// another — which is how a test stops being run and starts being edited.
//
// Run: node tests/maintenance_tab_test.mjs   (exits non-zero on any failure)

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

// Every row exists to exercise one branch and the comment says which.
// Renfield: a site with all three states at once — the only way to prove the
// three counters are independent rather than one of them absorbing another.
function maintenanceFixture() {
  return {
    source_as_of: '2026-09-16',
    pulled_at: '2026-09-16T20:06:42Z',
    gaps: [],
    basis: 'test maintenance basis',
    by_site: [],   // the page re-derives from tasks and never reads this
    tasks: [
      { site: 'Renfield Good Food Ltd', raw_site: 'Maki 8', d: '2026-09-01',
        issue: 'Ice machine leaking', comment: 'KRIS', status: 'ongoing',
        status_raw: 'Ongoing', completed_on: null, urgency: 'High Priority' },
      { site: 'Renfield Good Food Ltd', raw_site: 'Maki 8', d: '2026-08-30',
        issue: 'Fryer thermostat replaced', comment: 'KRIS', status: 'done',
        status_raw: 'Completed', completed_on: '2026-09-02', urgency: 'High Priority' },
      { site: 'Renfield Good Food Ltd', raw_site: 'Maki 8', d: '2026-08-28',
        issue: 'Duplicate of the ice machine ticket', comment: 'duplicated',
        status: 'cancelled', status_raw: 'Cancelled', completed_on: null,
        urgency: 'Low Priority' },
      // A site whose ONLY task in range is cancelled. It must still appear —
      // and must read 0 outstanding, not vanish and not read 1.
      { site: 'Maki Soho', raw_site: 'Maki 18', d: '2026-08-11',
        issue: 'Repaint the wall', comment: 'duplicated', status: 'cancelled',
        status_raw: 'Cancelled', completed_on: null, urgency: 'Low Priority' },
      // A status this page has never been taught. It must NOT be claimed as
      // resolved, and it must not disappear from the counts without a word.
      { site: 'Maki Soho', raw_site: 'Maki 18', d: '2026-08-10',
        issue: 'Awaiting landlord', comment: '', status: 'escalated',
        status_raw: 'Escalated', completed_on: null, urgency: 'Medium Priority' },
    ],
  };
}

// The container pins an older Chromium revision than the installed playwright
// package expects — launch by explicit path when it is there, as the other
// suites do, and let Playwright resolve its own when it is not.
const pinned = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium'].find(p => existsSync(p));
const browser = await chromium.launch(pinned ? { executablePath: pinned } : {});
const page = await browser.newPage();
await page.goto(pageUrl);
// The page's own bootstrap fetches the live snapshot from GitHub Pages on load;
// that has no route out of this sandbox and fails loudly (expected, unrelated).
// Only start listening for errors AFTER that settles.
await page.waitForTimeout(1500);
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

{
  const snap = { ...baseSnap, maintenance: maintenanceFixture() };
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-maint'); }, snap);

  // -- KPI tiles: three numbers that must not absorb one another -----------
  const tiles = {};
  for (const [lb, vl] of await page.$$eval('#maint-kpis .kpi',
      ks => ks.map(k => [k.querySelector('.lb')?.innerText.trim().toLowerCase(),
                         k.querySelector('.vl')?.innerText.trim()]))) tiles[lb] = vl;

  assert(tiles['outstanding/ongoing'] === '1',
    `outstanding counts ONLY the ongoing row — not the 2 cancelled (got "${tiles['outstanding/ongoing']}")`);
  assert(tiles['resolved'] === '1',
    `resolved counts ONLY the done row — cancelled is not folded in (got "${tiles['resolved']}")`);
  assert(tiles['cancelled'] === '2',
    `cancelled has its own tile and its own number (got "${tiles['cancelled']}")`);
  assert('cancelled' in tiles, 'a Cancelled tile exists at all');
  assert(/without the work/i.test(await page.locator('#maint-kpis').innerText()),
    'the tab says in words what cancelled means, rather than leaving it to be guessed');
  assert(tiles['sites affected'] === '1',
    `sites affected counts sites with OUTSTANDING work — Maki Soho has only cancelled/unknown (got "${tiles['sites affected']}")`);
  assert(tiles['oldest open'] === '2026-09-01',
    `oldest open is the ongoing row, not the older cancelled one (got "${tiles['oldest open']}")`);

  // -- by-site table: a column of its own, between the two it is not ------
  const heads = await page.$$eval('#maint-tbl thead th', ts => ts.map(t => t.innerText.trim().toLowerCase()));
  assert(heads.includes('cancelled'), `the table has a Cancelled column (got ${JSON.stringify(heads)})`);
  assert(heads.indexOf('cancelled') > heads.indexOf('resolved'),
    'Cancelled sits beside Resolved, so the two can be read against each other');

  const rows = await page.$$eval('#maint-tbl tbody tr',
    trs => trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim())));
  const renfield = rows.find(r => r[0].startsWith('Renfield'));
  const soho = rows.find(r => r[0].startsWith('Maki Soho'));
  assert(renfield && renfield[1] === '1' && renfield[2] === '1' && renfield[3] === '1',
    `one site with all three states reports 1/1/1, independently (got ${JSON.stringify(renfield)})`);
  assert(!!soho, 'a site whose only tasks are cancelled/unknown still appears in the table');
  assert(soho && soho[1] === '0' && soho[2] === '0' && soho[3] === '1',
    `that site reads 0 outstanding, 0 resolved, 1 cancelled (got ${JSON.stringify(soho)})`);
  assert(soho && /Clear/.test(soho[4]),
    `a site with nothing outstanding reads Clear — the Cancelled column is what says why (got "${soho && soho[4]}")`);

  // -- the bar tip reconciles with the drill-down -------------------------
  // bars() puts the hover text in data-t (read by hover()), not title.
  const tip = await page.$eval('#maint-bars .brow', el => el.dataset.t || '');
  assert(/cancelled/i.test(tip), `the bar hover names the cancelled count (got "${tip}")`);

  // -- THE DANGEROUS LINE: the drill-down status column -------------------
  await page.evaluate(() => window.openMaintModal('Renfield Good Food Ltd'));
  await page.waitForTimeout(300);
  const modal = await page.locator('#task-modal-b').innerText();
  const cancelledRow = modal.split('\n').find(l => /Duplicate of the ice machine/.test(l))
    || modal.slice(modal.indexOf('Duplicate of the ice machine'), modal.indexOf('Duplicate of the ice machine') + 200);
  assert(/Cancelled/.test(cancelledRow),
    `the cancelled task is labelled Cancelled in the drill-down (got "${cancelledRow.replace(/\s+/g, ' ').slice(0, 90)}")`);
  assert(!/Resolved/.test(cancelledRow),
    'the cancelled task is NOT labelled Resolved — the regression this file exists for');
  assert(/Ice machine leaking[\s\S]{0,80}Outstanding/.test(modal),
    'the ongoing task is still labelled Outstanding/Ongoing');
  assert(/Fryer thermostat[\s\S]{0,80}Resolved/.test(modal),
    'the genuinely completed task is still labelled Resolved');
  assert(/1 outstanding, 1 resolved, 1 cancelled/.test(modal),
    `the modal's count line breaks down all three states (got "${modal.split('\n').pop()}")`);
  await page.locator('#task-modal-x').click();

  // -- an unknown status must not be claimed as done ----------------------
  await page.evaluate(() => window.openMaintModal('Maki Soho'));
  await page.waitForTimeout(300);
  const sohoModal = await page.locator('#task-modal-b').innerText();
  const unknownRow = sohoModal.slice(sohoModal.indexOf('Awaiting landlord'),
                                    sohoModal.indexOf('Awaiting landlord') + 200);
  assert(!/Resolved/.test(unknownRow),
    'a status this page does not know is NOT rendered as Resolved — no catch-all done branch');
  assert(/Escalated/i.test(unknownRow),
    `an unknown status prints itself instead of claiming something untrue (got "${unknownRow.replace(/\s+/g, ' ').slice(0, 90)}")`);
  await page.locator('#task-modal-x').click();
}

// -- a snapshot with no cancelled rows at all still reads correctly --------
// The overwhelmingly common case, and the one a three-state change is most
// likely to break by making a zero look like missing data.
{
  const fx = maintenanceFixture();
  fx.tasks = fx.tasks.filter(t => t.status === 'ongoing' || t.status === 'done');
  await page.evaluate((s) => { window.render(s); window.gotoPage('p-maint'); },
                      { ...baseSnap, maintenance: fx });
  const tiles = {};
  for (const [lb, vl] of await page.$$eval('#maint-kpis .kpi',
      ks => ks.map(k => [k.querySelector('.lb')?.innerText.trim().toLowerCase(),
                         k.querySelector('.vl')?.innerText.trim()]))) tiles[lb] = vl;
  assert(tiles['cancelled'] === '0',
    `with no cancelled rows the tile reads 0, not an em dash (got "${tiles['cancelled']}") — zero cancellations is a real reading`);
  assert(tiles['outstanding/ongoing'] === '1' && tiles['resolved'] === '1',
    'the other two tiles are unchanged by the third state existing');
}

assert(consoleErrors.length === 0,
  `no console/page errors during any render() call (got ${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')})`);

await browser.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nall assertions passed');
