// MTD rows on the Overview scorecard and the OKR wall (Ross, 09/10/2026).
//
// The builder now leaves a month-in-progress KR UNSCORED until it holds 7 days
// of its own source data (tests/okr_mtd_rule_test.py pins that). This pins how
// both pages show such a row: the value, suffixed "MTD", a grey chip that says
// it is not yet scored, an em dash where the score goes - never a 0, never a
// blue "Reported", never a colour - and an objective % that leaves it out.
//
// The fixture is BAKED, not hand-written: the real builder runs over a tiny
// archive of factory broth readings (Tonkotsu: 3 production days in October,
// so MTD; Chicken: 8, so scored), so a change to the snapshot shape that the
// pages cannot render fails here. Needs python3 + duckdb, like the other
// baked-fixture tests.
import { chromium } from 'playwright';
import { readFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const indexUrl = 'file://' + path.join(repoRoot, 'command', 'index.html');
const okrUrl = 'file://' + path.join(repoRoot, 'command', 'okr.html');
const snapDir = path.join(repoRoot, 'data', 'ops_command');
const latestSnap = readdirSync(snapDir)
  .filter(f => /^snapshot_\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().pop();
const baseSnap = JSON.parse(readFileSync(path.join(snapDir, latestSnap), 'utf-8'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); }
  else console.log('ok  :', msg);
}

// ---- bake the fixture -----------------------------------------------------
const reading = (day, product, after) => {
  const [y, m, d] = day.split('-');
  return { Timestamp: `${d}/${m}/${y} 18:00:00`, Date: `${d}/${m}/${y}`, 'Batch Number': 'B' + day,
    'Product Name': product, 'Reading Before Adding Ice': '9', 'Reading After Adding Ice': after };
};
const rows = [
  ...['2026-09-08', '2026-09-15', '2026-09-22'].map(d => reading(d, 'Tonkotsu Broth', '8.5')),
  ...['2026-10-01', '2026-10-02', '2026-10-05'].map(d => reading(d, 'Tonkotsu Broth', '6.0')),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(i => reading(`2026-10-0${i}`, 'Chicken Broth', '5.5')),
];
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mtdmjs-'));
const arch = path.join(tmp, 'warehouse_direct', '2026-10-09');
mkdirSync(arch, { recursive: true });
writeFileSync(path.join(arch, 'Factory_Broth_Readings.jsonl.gz'),
  gzipSync(rows.map((r, i) => JSON.stringify({ row_num: i, data: r })).join('\n') + '\n'));
writeFileSync(path.join(arch, '_feeds.json'), JSON.stringify({ Factory_Broth_Readings: 'Factory Broth Readings' }));
const out = path.join(tmp, 'out');
mkdirSync(out);
copyFileSync(path.join(snapDir, 'feeds_manifest.json'), path.join(out, 'feeds_manifest.json'));
const p = spawnSync('python3', [path.join(repoRoot, 'builders', 'bake_ops_command.py'), '--date', '2026-10-09'], {
  env: { ...process.env, OPS_WAREHOUSE_SOURCE: 'archive', OPS_ARCHIVE_DIR: path.join(tmp, 'warehouse_direct'), OPS_OUT_DIR: out },
  encoding: 'utf-8',
});
if (p.status !== 0) {
  console.error('builder failed:', (p.stdout || '').slice(-1500), (p.stderr || '').slice(-1500));
  process.exit(1);
}
const baked = JSON.parse(readFileSync(path.join(out, 'snapshot_2026-10-09.json'), 'utf-8'));
rmSync(tmp, { recursive: true, force: true });
const snap = { ...baseSnap, pull_date: '2026-10-09', scorecard: baked.scorecard };
const tonk = baked.scorecard.rows.find(r => r.objective === 'OO5' && r.kr === 'KR1');
assert(tonk && tonk.mtd === true && tonk.score === null && tonk.value === 6,
  'fixture: OO5 KR1 (Tonkotsu) is baked MTD - value 6, no score');

const pinnedChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(pinnedChromium) ? { executablePath: pinnedChromium } : {});
const NETWORK_NOISE = /Failed to load resource|net::ERR_|ERR_CERT/;

// ---- index.html: the Overview scorecard ------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !NETWORK_NOISE.test(m.text())) errors.push(m.text()); });
  await page.goto(indexUrl);
  await page.waitForTimeout(1500);
  await page.evaluate(s => window.render(s), snap);
  const row = page.locator('#scorecard table tbody tr', { hasText: 'KR1' }).filter({ hasText: /Pork|Tonkotsu|8-9|8 ?- ?9/ }).first();
  const cells = await row.locator('td').allInnerTexts();
  assert(/ MTD$/.test(cells[2].trim()), `Overview: the value is shown with "MTD" (got ${JSON.stringify(cells[2])})`);
  assert(cells[3].trim() === '—', `Overview: no score - an em dash, not 0 (got ${JSON.stringify(cells[3])})`);
  assert(/MTD · not yet scored/.test(cells[4]) && !/Reported|On target|Off target|Within tolerance/.test(cells[4]),
    `Overview: grey "MTD · not yet scored" chip, not "Reported" or a RAG (got ${JSON.stringify(cells[4])})`);
  const chipCls = await row.locator('td').nth(4).locator('.tag').first().getAttribute('class');
  assert(/\bt-n\b/.test(chipCls), `Overview: the chip is grey (class ${chipCls})`);
  assert(/month-to-date, not yet scored \(3 days of data\)/.test(cells[0]), 'Overview: the basis line says why, with the day count');
  const chick = await page.locator('#scorecard table tbody tr', { hasText: 'KR2' }).filter({ hasText: /Chicken|5-6|5 ?- ?6/ }).first().locator('td').allInnerTexts();
  assert(chick[3].trim() === '100' && /On target/.test(chick[4]), 'Overview: Chicken (8 days) is scored 100, On target');
  const head = await page.locator('#scorecard table tbody tr', { hasText: 'OO5' }).first().innerText();
  assert(/100%/.test(head) && /1 of 5 scored/.test(head), `Overview: OO5 reads 100%, 1 of 5 scored - the MTD row is left out (got ${JSON.stringify(head.slice(0, 120))})`);
  // the September picker month: Tonkotsu's closed month is scored, no MTD
  const opts = await page.locator('#sc-month option').evaluateAll(os => os.map(o => o.value));
  if (opts.includes('2026-09')) {
    await page.selectOption('#sc-month', '2026-09');
    const sep = await page.locator('#scorecard table tbody tr', { hasText: 'KR1' }).filter({ hasText: /Pork|Tonkotsu|8-9|8 ?- ?9/ }).first().locator('td').allInnerTexts();
    assert(sep[3].trim() === '100' && !/MTD/.test(sep[2]), 'Overview, September: the closed month is scored and carries no MTD');
  } else {
    assert(false, `the month picker offers September (got ${JSON.stringify(opts)})`);
  }
  assert(errors.length === 0, `Overview: no page errors (got ${JSON.stringify(errors)})`);
  await page.close();
}

// ---- okr.html: the wall ------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.clock.setFixedTime(new Date('2026-10-09T18:00:00Z'));
  await page.addInitScript(() => { window.OPS_BASE = 'http://fixtures.test/'; });
  await page.route('http://fixtures.test/**', route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === 'snapshot_index.json')
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ latest: '2026-10-09', dates: ['2026-10-09'] }) });
    if (name === 'snapshot_2026-10-09.json')
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snap) });
    return route.fulfill({ status: 404, body: 'nf' });
  });
  await page.goto(okrUrl);
  await page.waitForTimeout(1200);
  const kr = page.locator('.kr', { hasText: 'KR1' }).filter({ hasText: /Pork|Tonkotsu|8-9|8 ?- ?9/ }).first();
  const chipTxt = (await kr.locator('.chip').innerText()).trim();
  const chipCls = await kr.locator('.chip').getAttribute('class');
  assert(chipTxt === 'MTD' && /\bc-n\b/.test(chipCls), `wall: the chip reads MTD, grey (got ${JSON.stringify(chipTxt)}, ${chipCls})`);
  const val = await kr.locator('.v b').innerText();
  assert(/ MTD$/.test(val), `wall: the value is shown with MTD (got ${JSON.stringify(val)})`);
  assert(/month-to-date, not yet scored \(3 days of data\)/.test(await kr.locator('.why').innerText()), 'wall: the reason line has the day count');
  const tile = page.locator('.tile', { hasText: 'OO5' }).first();
  const tileTxt = await tile.innerText();
  assert(/100%/.test(tileTxt) && /1 of 5 scored/.test(tileTxt), `wall: OO5 tile reads 100%, 1 of 5 scored (got ${JSON.stringify(tileTxt.replace(/\s+/g, ' ').slice(0, 120))})`);
  assert(/MTD = month in progress/.test(await page.locator('body').innerText()), 'wall: the legend explains MTD');
  assert(errors.length === 0, `wall: no page errors (got ${JSON.stringify(errors)})`);
  await page.close();
}

await browser.close();
if (failures > 0) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log('\nall assertions passed');
