// The staleness banner reads snapshot_index.latest against today FIRST (09/10/2026).
//
// 01/10 - 09/10/2026 the bake ran daily and died on the push (expired token),
// so nothing new reached the site - and command/index.html could not say so:
// its banner read health_latest.json (frozen with the bake) and
// feed_health.age_days (measured from the snapshot's own pull date, so the
// last snapshot to land reads age 0 for ever). It showed 01/10 for eight days.
//
// The rule now, same as the OKR wall (command/okr.html render()):
//   1. latest in snapshot_index.json vs today's (UTC) date - red at >= 1 day;
//   2. the verifier's verdict overlaid UNDER it, never instead of it.
//
// Both pages are booted for real against served fixtures (window.OPS_BASE +
// route interception) with the clock pinned, so this exercises the actual
// fetch -> render path, not a hand call to render().
import { chromium } from 'playwright';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

const health = (overall, generated_at, extra = {}) => ({
  verifier_version: 2, generated_at, verified_date: generated_at.slice(0, 10), mode: 'recheck', overall,
  counts: { criticals: overall === 'red' ? 2 : 0, warnings: overall === 'amber' ? 3 : 0 },
  criticals: overall === 'red' ? [{ check: '0-receipts', level: 'critical', feed: 'daily-export', detail: 'fixture critical' }] : [],
  warnings: [], ...extra,
});

const pinnedChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(pinnedChromium) ? { executablePath: pinnedChromium } : {});

// Boot a page at `now` against an index whose dates are `dates` (newest first),
// with health_latest.json = `h` (null -> 404). Returns the page.
async function boot(url, { now, dates, h }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.clock.setFixedTime(new Date(now));
  await page.addInitScript(() => { window.OPS_BASE = 'http://fixtures.test/'; });
  await page.route('http://fixtures.test/**', route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === 'snapshot_index.json')
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ latest: dates[0], dates, generated_at: now }) });
    if (name === 'health_latest.json')
      return h ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(h) })
               : route.fulfill({ status: 404, body: 'not found' });
    const m = name.match(/^snapshot_(\d{4}-\d{2}-\d{2})\.json$/);
    if (m && dates.includes(m[1]))
      return route.fulfill({ status: 200, contentType: 'application/json',
        // feed_health pinned to age 0: the base snapshot is whatever was baked
        // last, and on a day the pull is dead its ages would make the banner's
        // OTHER check (pipelineAgeDays) fire and fail every verdict case here
        body: JSON.stringify({ ...baseSnap, pull_date: m[1], generated_at: m[1] + 'T15:00:00Z',
          feed_health: (baseSnap.feed_health || []).map(r => ({ ...r, age_days: 0 })),
          scorecard: { ...baseSnap.scorecard, month: m[1].slice(0, 7) } }) });
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await page.goto(url);
  await page.waitForTimeout(1200);
  page._errors = errors;
  return page;
}
const bannerParts = async page => page.locator('#banner > div').evaluateAll(ds => ds.map(d => ({ cls: d.className, text: d.innerText })));

// ---- 1. the outage this exists for: latest 01/10, today 09/10 ------------
{
  const page = await boot(indexUrl, { now: '2026-10-09T09:00:00Z', dates: ['2026-10-01', '2026-09-21'],
    h: health('red', '2026-10-01T08:14:30Z') });
  const b = await bannerParts(page);
  assert(b.length >= 1 && b[0].cls === 'err' && /^DATA IS 8 DAYS OLD/.test(b[0].text),
    `first line is red "DATA IS 8 DAYS OLD" (got ${JSON.stringify(b[0])})`);
  assert(/last bake 2026-10-01/.test(b[0].text) && /Ops Command bake/.test(b[0].text) && /maki-hospitality-etl/.test(b[0].text),
    'it names the last bake and where to look');
  assert(b.length === 2 && /hasn't reported since 2026-10-01/.test(b[1].text),
    `the verifier's own line is overlaid underneath, not dropped (got ${JSON.stringify(b.map(x => x.text.slice(0, 50)))})`);
  assert(page._errors.length === 0, `no page errors (got ${JSON.stringify(page._errors)})`);
  await page.close();
}

// ---- 2. one day old in the morning, verifier red today -------------------
{
  const page = await boot(indexUrl, { now: '2026-10-09T09:00:00Z', dates: ['2026-10-08', '2026-10-07'],
    h: health('red', '2026-10-09T08:50:00Z') });
  const b = await bannerParts(page);
  assert(b[0] && b[0].cls === 'err' && /^DATA IS 1 DAY OLD/.test(b[0].text),
    `1 day old is already red, singular "DAY" (got ${JSON.stringify(b[0] && b[0].text.slice(0, 40))})`);
  assert(b[1] && b[1].cls === 'err' && /Data verification FAILED \(2026-10-09\)/.test(b[1].text),
    'and the verifier\'s red verdict is overlaid as the second line');
  await page.close();
}

// ---- 3. fresh today, verifier red -> only the verdict --------------------
{
  const page = await boot(indexUrl, { now: '2026-10-09T18:00:00Z', dates: ['2026-10-09', '2026-10-08'],
    h: health('red', '2026-10-09T17:59:30Z') });
  const b = await bannerParts(page);
  assert(b.length === 1 && /Data verification FAILED/.test(b[0].text) && !/DAYS? OLD/.test(b[0].text),
    `fresh data: no freshness line, the verdict alone (got ${JSON.stringify(b.map(x => x.text.slice(0, 40)))})`);
  assert(/maki-hospitality-etl Actions tab/.test(b[0].text),
    'the verdict points at the repo the verifier actually runs in');
  await page.close();
}

// ---- 4. fresh today, verifier green -> no banner at all ------------------
{
  const page = await boot(indexUrl, { now: '2026-10-09T18:00:00Z', dates: ['2026-10-09'],
    h: health('green', '2026-10-09T17:59:30Z') });
  const b = await bannerParts(page);
  assert(b.length === 0, `fresh and green: the banner is clear (got ${JSON.stringify(b)})`);
  await page.close();
}

// ---- 5. stale and no verdict published -> freshness line only ------------
{
  const page = await boot(indexUrl, { now: '2026-10-09T09:00:00Z', dates: ['2026-10-05'], h: null });
  const b = await bannerParts(page);
  assert(b.length === 1 && /^DATA IS 4 DAYS OLD/.test(b[0].text),
    `no verdict file: the freshness line still fires, and the old "snapshot is N days old" amber stands down (got ${JSON.stringify(b.map(x => x.text.slice(0, 40)))})`);
  await page.close();
}

// ---- 6. rolled back to an older snapshot while the index is fresh --------
{
  const page = await boot(indexUrl, { now: '2026-10-09T18:00:00Z', dates: ['2026-10-09', '2026-10-01'],
    h: health('green', '2026-10-09T17:59:30Z') });
  await page.selectOption('#daysel', '2026-10-01');
  await page.waitForTimeout(500);
  const b = await bannerParts(page);
  assert(!b.some(x => /DAYS? OLD/.test(x.text)),
    'viewing an older snapshot on purpose is not "stale" - freshness follows the index, not the selection');
  await page.close();
}

// ---- 7. parity with the OKR wall -----------------------------------------
{
  const now = '2026-10-09T09:00:00Z', dates = ['2026-10-01'];
  const a = await boot(indexUrl, { now, dates, h: null });
  const o = await boot(okrUrl, { now, dates, h: null });
  const ai = (await bannerParts(a))[0]?.text || '';
  const oi = (await o.locator('#stale').innerText()).trim();
  assert(ai.length > 0 && ai === oi,
    `index.html and okr.html say the same thing for the same index and clock (index ${JSON.stringify(ai.slice(0, 60))} vs okr ${JSON.stringify(oi.slice(0, 60))})`);
  await a.close(); await o.close();
}

await browser.close();
if (failures > 0) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log('\nall assertions passed');
