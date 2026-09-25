// Fixture test for the Facilities app on the dashboard (25/09/2026): OO2 KR1,
// KR2 and KR4 on the Overview scorecard, and the Facilities cards on the
// Maintenance tab that those rows drill into.
//
// Pattern (same as factory_broth_test.mjs): load command/index.html in
// headless Chromium via file://, call window.render(snap) directly, assert on
// the DOM. The base is the newest REAL baked snapshot; only snap.scorecard and
// snap.maintenance are replaced, and those come from running the REAL builder
// (bake_ops_command.py over a one-row archive) on tests/fixtures/
// facilities_ppm.json - a trimmed copy of the real 25/09/2026 pull. Nothing on
// the Facilities side is hand-built here, so the builder and the shell cannot
// drift apart without this failing. Needs python3 + duckdb, which the
// dashboard-tests workflow installs before `npm test`.
//
// Run: node tests/facilities_maintenance_test.mjs   (exits non-zero on any failure)

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pageUrl = 'file://' + path.join(repoRoot, 'command', 'index.html');
const snapDir = path.join(repoRoot, 'data', 'ops_command');
const latestSnap = readdirSync(snapDir)
  .filter(f => /^snapshot_\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().pop();
const baseSnap = JSON.parse(readFileSync(path.join(snapDir, latestSnap), 'utf-8'));
const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'facilities_ppm.json'), 'utf-8'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); }
  else console.log('ok  :', msg);
}

/* Bake the fixture with pulled_at `daysAgo` days before now (the bake judges
   staleness on the wall clock), and return the baked snapshot.

   The real fixture's fault queue is all zeros, its pairs / by_site are empty
   and it carries 8 contractors - none of which could catch two fields swapped
   in the wiring or the >25-row scroll wrapper. So the COPY written here gets
   distinct values for those (the fixture file itself stays as the app sent
   it), padded with 20 synthetic contractors to reach 28 rows. */
const overlay = {
  faults: { open: 3, open_over_14d: 1, assets_down: 2 },
  kr2_repeat_issues: {
    ...fixture.kr2_repeat_issues,
    by_site: [{ site: 'Maki 9', repeats: 1 }, { site: 'Maki 3', repeats: 2 }],
    pairs: [{ site: 'Maki 3', asset: 'Fryer 2', first: '2026-09-02', fix_date: '2026-09-04',
              second: '2026-09-20', days: 18, note: 'x' }],
  },
  contractors: [...fixture.contractors, ...Array.from({ length: 20 }, (_, i) => ({
    name: `Synthetic contractor ${i + 1}`, tasks: 1, overdue: 0, no_evidence: 0,
    ontime_pct_12m: null, avg_days_late: null, last_cert: null }))],
};
const tmp = mkdtempSync(path.join(os.tmpdir(), 'facmjs-'));
function bakeWith(daysAgo) {
  const out = path.join(tmp, 'd' + daysAgo);
  const arch = path.join(out, 'arch', '2026-09-25');
  mkdirSync(arch, { recursive: true });
  writeFileSync(path.join(arch, 'Dummy.jsonl.gz'),
    gzipSync(JSON.stringify({ row_num: 0, data: { x: 1 } }) + '\n'));
  copyFileSync(path.join(snapDir, 'feeds_manifest.json'), path.join(out, 'feeds_manifest.json'));
  const pulled = new Date(Date.now() - daysAgo * 86400e3).toISOString().slice(0, 19) + 'Z';
  writeFileSync(path.join(out, 'facilities_ppm.json'), JSON.stringify({ ...fixture, ...overlay, pulled_at: pulled }));
  const p = spawnSync('python3', [path.join(repoRoot, 'builders', 'bake_ops_command.py'), '--date', '2026-09-25'], {
    env: { ...process.env, OPS_WAREHOUSE_SOURCE: 'archive', OPS_ARCHIVE_DIR: path.join(out, 'arch'), OPS_OUT_DIR: out },
    encoding: 'utf-8',
  });
  if (p.status !== 0) {
    console.error('builder failed:', (p.stdout || '').slice(-1500), (p.stderr || '').slice(-1500));
    process.exit(1);
  }
  const baked = JSON.parse(readFileSync(path.join(out, 'snapshot_2026-09-25.json'), 'utf-8'));
  return { ...baseSnap, scorecard: baked.scorecard, maintenance: baked.maintenance };
}
const fresh = bakeWith(0);
const stale = bakeWith(10);

const pinnedChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(pinnedChromium) ? { executablePath: pinnedChromium } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.goto(pageUrl);
await page.waitForTimeout(1500);
const NETWORK_NOISE = /Failed to load resource|net::ERR_|ERR_CERT/;
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));
page.on('console', msg => {
  if (msg.type() === 'error' && !NETWORK_NOISE.test(msg.text())) consoleErrors.push(msg.text());
});

const okrRow = kr => page.locator('#scorecard table tbody tr', { hasText: kr }).first();

// ---- fresh: KR4 measured, KR1 / KR2 grey with their reasons ---------------
{
  await page.evaluate(s => window.render(s), fresh);
  const k4 = await okrRow('KR4: Maintain 100% statutory compliance').locator('td').allInnerTexts();
  assert(k4[2] === '37% (84 of 227)', `Overview OO2 KR4 shows 37% (84 of 227) (got ${JSON.stringify(k4[2])})`);
  assert(k4[3].trim() === '0' && /Off target/.test(k4[4]), 'OO2 KR4 scores 0, Off target');
  assert(/from the Facilities app/.test(k4[0]), 'OO2 KR4 is labelled "from the Facilities app"');
  assert(/84 of 227 tracked statutory items across 19 sites current or due within 30 days/.test(k4[0])
    && /106 with no certificate on file/.test(k4[0]) && /as of 2026-09-25/.test(k4[0]),
    'OO2 KR4 basis line is on the row');
  assert(/open →/.test(k4[4]), 'OO2 KR4 drills to its tab');
  const k1 = await okrRow('KR1: Complete ≥95% of planned preventative').locator('td').allInnerTexts();
  assert(/Not measured/.test(k1[4]) && /Needs: no PPM completion has been logged with a due date yet/.test(k1[0])
    && /25 Sep 2026 onwards/.test(k1[0]), 'OO2 KR1 grey with its reason');
  const k2 = await okrRow('KR2: Reduce repeat maintenance issues').locator('td').allInnerTexts();
  assert(/Not measured/.test(k2[4]) && /baseline needs Jun–Aug; the app's fault log starts Sep 2026/.test(k2[0])
    && /January re-baseline/.test(k2[0]), 'OO2 KR2 grey with its reason');
  assert(/PROPOSED BAND/.test(k2[0]), 'OO2 KR2 still shows its PROPOSED band chip');
}

// ---- fresh: the Maintenance tab --------------------------------------------
{
  await page.evaluate(s => { window.render(s); window.gotoPage('p-maint'); }, fresh);
  const head = await page.locator('#fac-head').innerText();
  assert(/as of 2026-09-25/.test(head) && !/Read this first/.test(head), 'header: as-of date, no stale banner');
  const hrefs = await page.locator('#fac-head a').evaluateAll(as => as.map(a => [a.textContent.trim(), a.href, a.target]));
  assert(hrefs.length === 2
    && hrefs[0][1] === 'https://rossmward.eu.pythonanywhere.com/compliance'
    && hrefs[1][1] === 'https://rossmward.eu.pythonanywhere.com/insights'
    && hrefs.every(h => h[2] === '_blank'),
    `header links to the app's /compliance and /insights (got ${JSON.stringify(hrefs)})`);

  const rows = await page.locator('#fac-kr4 tbody tr').evaluateAll(trs =>
    trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())));
  assert(rows.length === 20, `KR4 drill-down: 19 sites + the group row (got ${rows.length})`);
  assert(rows[0][2] === '0%' && rows[18][0] === 'M15' && rows[18][2] === '79%', 'KR4 drill-down sorted worst first');
  const g = rows[19];
  assert(g[0] === 'Group' && /as scored on the Overview/.test(g[1]) && g[2] === '37%' && g[3] === '70' && g[4] === '14' && g[5] === '37' && g[6] === '106',
    `group row is the app's own figure (got ${JSON.stringify(g)})`);
  const m20 = rows.find(r => r[0] === 'M20');
  assert(m20 && m20[7] === '—', 'a site with nothing overdue shows no oldest-overdue age');
  const heads = await page.locator('#fac-kr4 thead th').allInnerTexts();
  assert(heads.map(h => h.toLowerCase()).join('|') ===
    'code|site|compliant|current|due ≤30d|overdue|no evidence|oldest overdue (days)', 'KR4 drill-down columns');

  const months = await page.locator('#fac-kr2-m tbody tr').evaluateAll(trs =>
    trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())));
  assert(months[0][0] === 'Sep 2026' && months[0][1] === '0', 'KR2: September is a logged month');
  const aug = months.find(r => r[0] === 'Aug 2026');
  assert(aug && aug[1] === 'no log' && /baseline/.test(aug[4]), 'KR2: August reads "no log", never 0, and is marked baseline');
  const cells = sel => page.locator(sel + ' tbody tr').evaluateAll(trs =>
    trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())));
  const bySite = await cells('#fac-kr2-s');
  assert(JSON.stringify(bySite) === JSON.stringify([['Maki 3', '2'], ['Maki 9', '1']]),
    `KR2 by site: most repeats first (got ${JSON.stringify(bySite)})`);
  const pairs = await cells('#fac-kr2-p');
  assert(JSON.stringify(pairs) === JSON.stringify([['Maki 3', 'Fryer 2', '2026-09-02', '2026-09-04', '2026-09-20', '18', 'x']]),
    `KR2 pairs: site · asset · first · fixed · re-reported · days · note (got ${JSON.stringify(pairs)})`);
  const kr2 = await page.locator('#fac-kr2').innerText();
  assert(/chaser/.test(kr2) && /reported→reported/.test(kr2), 'KR2: the rule and the chaser count are on the card');

  const faults = await page.locator('#fac-faults .kpi').allInnerTexts();
  assert(faults.length === 3 && /Open faults\s+3/i.test(faults[0]) && /Open over 14 days\s+1/i.test(faults[1])
    && /Assets down\s+2/i.test(faults[2]), `Open faults card: open 3 / over 14 days 1 / assets down 2 (got ${JSON.stringify(faults)})`);
  assert(!/franchise/i.test(await page.locator('#fac-faults').innerText()), 'Open faults card makes no franchise claim');

  const con = await cells('#fac-contractors');
  assert(con.length === 28 && con[0][0] === 'IDES' && con[0][1] === '50' && con[0][2] === '5' && con[0][3] === '33'
    && con[0][4] === '—' && con[0][5] === '2026-08-15', 'Contractor scorecard: name · items · overdue · no evidence · on-time · last cert');
  assert(await page.locator('#fac-contractors .tscroll table').count() === 1, 'more than 25 contractors: the table scrolls');
  assert(/have no contractor assigned/.test(await page.locator('#fac-contractors').innerText()),
    'Contractor scorecard says how many items have no contractor');
}

// ---- stale: the three KRs grey naming the file; the tab keeps its data -----
{
  await page.evaluate(s => window.render(s), stale);
  for (const kr of ['KR1: Complete', 'KR2: Reduce repeat', 'KR4: Maintain 100%']) {
    const t = await okrRow(kr).locator('td').allInnerTexts();
    assert(/Not measured/.test(t[4]) && /stale/.test(t[0]) && /facilities_ppm\.json/.test(t[0]) && t[2] === '—',
      `stale feed: ${kr.slice(0, 3)} grey, naming the file`);
  }
  await page.evaluate(s => { window.render(s); window.gotoPage('p-maint'); }, stale);
  const head = await page.locator('#fac-head').innerText();
  assert(/Read this first/.test(head) && /10 days ago/.test(head), 'stale feed: banner on the tab says how old');
  assert((await page.locator('#fac-kr4 tbody tr').count()) === 20, 'stale feed: the per-site table still shows');
}

// ---- a snapshot from before this existed renders without error -------------
{
  const old = { ...baseSnap, maintenance: { ...(baseSnap.maintenance || {}), facilities: undefined } };
  await page.evaluate(s => { window.render(s); window.gotoPage('p-maint'); }, old);
  assert(/predates the Facilities app feed/.test(await page.locator('#fac-head').innerText()),
    'an older snapshot says it predates the feed');
}

assert(consoleErrors.length === 0,
  `no console/page errors during any render() call (got ${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')})`);
await browser.close();
rmSync(tmp, { recursive: true, force: true });
if (failures > 0) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log('\nall assertions passed');
