// Unknowns stay unknown, and a rolled-back day says so (10/10/2026).
//
// The review of the 2-8 Oct back-bakes found, in the shell:
//   M3  the Maintenance tab summed a withheld sheet (tasks:[]) into a green
//       "Outstanding/ongoing 0" on every back-baked day;
//   M4  the "Delivery issues this month" tile and the Supplier Issues card
//       painted an unscored month-to-date count green "On target", beside a
//       scorecard row calling the same count "MTD - not yet scored";
//   m7  the 7/30/90-day buttons counted back from TODAY on a rolled-back day,
//       so "7 days" on 2 Oct meant 3-10 Oct;
//   m8  nothing said the day on screen was not the latest, or back-baked;
//   m4  the Supply tab quoted every report's unattributed rises as the month's;
//   m9  the OKR wall's legend said MTD meant "under 7 days of data", while a
//       count stays MTD until the month closes.
// Each is booted for real against served fixtures (window.OPS_BASE + route
// interception, clock pinned), patched from the newest committed snapshot.
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
const clone = o => JSON.parse(JSON.stringify(o));
const pinnedChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(pinnedChromium) ? { executablePath: pinnedChromium } : {});

// A snapshot for `date`, with feed ages pinned to 0 (the base snapshot's own
// ages would trip the banner's pipeline check) and `patch` applied.
function snapFor(date, patch = s => s, generated = date + 'T15:00:00Z') {
  const s = clone(baseSnap);
  s.pull_date = date; s.generated_at = generated;
  s.feed_health = (s.feed_health || []).map(r => ({ ...r, age_days: 0 }));
  if (s.scorecard) s.scorecard.month = date.slice(0, 7);
  return patch(s);
}

// snaps: {date: snapshot}; the index lists them newest first.
async function boot(url, { now, snaps }) {
  const dates = Object.keys(snaps).sort().reverse();
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
    const m = name.match(/^snapshot_(\d{4}-\d{2}-\d{2})\.json$/);
    if (m && snaps[m[1]])
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snaps[m[1]]) });
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await page.goto(url);
  await page.waitForTimeout(1200);
  page._errors = errors;
  return page;
}
const kpis = (page, sel) => page.locator(sel + ' .kpi').evaluateAll(ds => ds.map(d => ({
  cls: d.className, lb: d.querySelector('.lb')?.innerText, vl: d.querySelector('.vl')?.innerText,
  sb: d.querySelector('.sb')?.innerText })));
const NOW = '2026-10-10T08:00:00Z';   // 09:00 UK

// ---- M3: a withheld maintenance sheet is grey dashes, never a green 0 -------
{
  const why = "back-baked snapshot: the maintenance sheet copy on file was pulled on 2026-10-10, after this snapshot's date (2026-10-02), so it is not shown here";
  const withheld = s => ({ ...s, maintenance: { ...(s.maintenance || {}), tasks: null, by_site: null,
    unavailable: why, gaps: [why], basis: 'not available in a back-baked snapshot - the sheet is stored as current state only, so there is no copy as it stood on 2026-10-02' } });
  const page = await boot(indexUrl, { now: NOW, snaps: { '2026-10-09': snapFor('2026-10-09', withheld) } });
  const k = await kpis(page, '#maint-kpis');
  assert(k.length === 4 && k.every(x => x.vl === '—' && /k-n/.test(x.cls)),
    `all four maintenance tiles are grey '—' (got ${JSON.stringify(k.map(x => [x.vl, x.cls]))})`);
  assert(k[0].sb === why, 'the first tile names the reason');
  const bars = await page.locator('#maint-bars').innerText(), tbl = await page.locator('#maint-tbl').innerText();
  assert(bars.includes('back-baked snapshot') && tbl.includes('back-baked snapshot') && !/No maintenance tasks dated/.test(tbl),
    'the bars and the table say why there is nothing, not "no tasks in range"');
  assert(page._errors.length === 0, `no page errors (got ${JSON.stringify(page._errors)})`);
  await page.close();
}
{
  // a snapshot published before the fix: tasks [] with the withheld basis
  const old = s => ({ ...s, maintenance: { ...(s.maintenance || {}), tasks: [], by_site: [],
    gaps: ['back-baked snapshot: the maintenance sheet copy on file was pulled on 2026-10-10'],
    basis: 'not available in a back-baked snapshot - the sheet is stored as current state only' } });
  const page = await boot(indexUrl, { now: NOW, snaps: { '2026-10-09': snapFor('2026-10-09', old) } });
  const k = await kpis(page, '#maint-kpis');
  assert(k.length === 4 && k[0].vl === '—' && !k.some(x => /k-g/.test(x.cls)),
    'an already-published back-bake (tasks []) is grey too, not a green 0');
  await page.close();
}
{
  const live = s => ({ ...s, maintenance: { ...(s.maintenance || {}), unavailable: undefined,
    tasks: [{ site: 'Maki Test', d: '2026-10-08', status: 'ongoing', issue: 'leak' },
            { site: 'Maki Test', d: '2026-10-07', status: 'done', issue: 'door' }],
    by_site: [{ site: 'Maki Test', ongoing: 1, done: 1 }], gaps: [], basis: 'sheet' } });
  const page = await boot(indexUrl, { now: NOW, snaps: { '2026-10-09': snapFor('2026-10-09', live) } });
  const k = await kpis(page, '#maint-kpis');
  assert(k[0] && k[0].vl === '1' && /k-a/.test(k[0].cls), `a real sheet still renders its counts (got ${JSON.stringify(k[0])})`);
  await page.close();
}

// ---- M4: the KR1 tile and card follow the builder's judgement ---------------
async function kr1Case(month, label, check) {
  const p = s => { s.suppliers = { ...(s.suppliers || {}), kr1: { ...((s.suppliers || {}).kr1 || {}), target: 10,
    months: [{ month: '2026-09', issues: 74, rag: 'red', target: 10, suppliers: [] }, month] } }; return s; };
  const page = await boot(indexUrl, { now: NOW, snaps: { '2026-10-09': snapFor('2026-10-09', p) } });
  const tile = (await kpis(page, '#kpis')).find(x => /Delivery issues this month/i.test(x.lb || ''));
  const card = await page.locator('#sq-kr1').innerText();
  check(tile, card, label);
  assert(page._errors.length === 0, `${label}: no page errors (got ${JSON.stringify(page._errors)})`);
  await page.close();
}
await kr1Case({ month: '2026-10', issues: 9, rag: null, mtd: true, undercount: false, target: 10, suppliers: [],
  coverage_note: 'month to date - the answer feed reaches 2026-10-08' }, 'open month under target',
  (t, c, l) => {
    assert(t && /k-n/.test(t.cls) && t.vl === '9' && /month to date, not judged yet/.test(t.sb),
      `${l}: the tile is grey, '9', "month to date, not judged yet" (got ${JSON.stringify(t)})`);
    assert(/MTD · not judged yet/.test(c) && !/On target/.test(c), `${l}: the card says MTD, not "On target"`);
  });
await kr1Case({ month: '2026-10', issues: 12, rag: 'red', mtd: true, target: 10, suppliers: [] }, 'open month over target',
  (t, c, l) => {
    assert(t && /k-r/.test(t.cls) && t.vl === '12', `${l}: red - over the target is final (got ${JSON.stringify(t)})`);
    assert(/Off target/.test(c), `${l}: the card says Off target`);
  });
await kr1Case({ month: '2026-10', issues: null, rag: null, mtd: true, target: 10, suppliers: [],
  coverage_note: 'the GC answer feed does not reach 2026-10 yet (it reaches 2026-09-30), so nothing can be counted for it' },
  'month the feed has not reached', (t, c, l) => {
    assert(t && /k-n/.test(t.cls) && t.vl === '—' && /does not reach 2026-10 yet/.test(t.sb),
      `${l}: '—', grey, and why (got ${JSON.stringify(t)})`);
    assert(/Not reached yet/.test(c), `${l}: the card says so too`);
  });
await kr1Case({ month: '2026-09', issues: 7, rag: null, mtd: false, incomplete: true, undercount: true, target: 10,
  suppliers: [], coverage_note: 'no pull of the answer feed covers 20-22 Sep 2026' }, 'closed month with a hole',
  (t, c, l) => {
    assert(t && /k-n/.test(t.cls) && /incomplete month, not judged/.test(t.sb), `${l}: grey, "incomplete month" (got ${JSON.stringify(t)})`);
    assert(/Incomplete · not judged/.test(c) && /undercounted/.test(c) && !/month to date/.test(c),
      `${l}: the card says incomplete and undercounted - not "month to date" for a closed month`);
  });
await kr1Case({ month: '2026-10', issues: 4, rag: 'green', target: 10, suppliers: [] }, 'a snapshot from before the fix',
  (t, c, l) => {
    assert(t && /k-g/.test(t.cls), `${l}: an older snapshot's green still renders green (got ${JSON.stringify(t)})`);
    assert(/On target/.test(c), `${l}: and its card still says On target`);
  });

// ---- m8 + m7: a rolled-back day says so, and its ranges end on that day -----
{
  const page = await boot(indexUrl, { now: NOW, snaps: {
    '2026-10-09': snapFor('2026-10-09'),
    '2026-10-02': snapFor('2026-10-02', s => s, '2026-10-10T03:33:20Z') } });
  let banner = await page.locator('#banner').innerText();
  assert(!/Viewing 2026/.test(banner), 'the latest day carries no roll-back note');
  await page.selectOption('#daysel', '2026-10-02');
  await page.waitForTimeout(800);
  banner = await page.locator('#banner').innerText();
  assert(/Viewing 2026-10-02, not the latest snapshot \(2026-10-09\)/.test(banner)
    && /back-baked on 2026-10-10 from the pull archive, as of 2026-10-02/.test(banner),
    `rolled back to 2 Oct: the banner names the day, the latest, and that it was back-baked (got ${JSON.stringify(banner.slice(0, 300))})`);
  await page.click('#range-btns [data-r="7"]');
  await page.waitForTimeout(400);
  let ev = await page.evaluate(() => EV);
  assert(ev.f === '2026-09-25' && ev.t === '2026-10-02',
    `"7 days" on 2 Oct is 25 Sep - 2 Oct, not a week back from today (got ${JSON.stringify(ev)})`);
  await page.selectOption('#daysel', '2026-10-09');
  await page.waitForTimeout(800);
  ev = await page.evaluate(() => EV);
  banner = await page.locator('#banner').innerText();
  assert(ev.f === '2026-10-03' && ev.t === null && !/Viewing 2026/.test(banner),
    `back on the latest day the window is today-relative again and the note goes (got ${JSON.stringify(ev)})`);
  assert(page._errors.length === 0, `no page errors (got ${JSON.stringify(page._errors)})`);
  await page.close();
}
{
  // a day baked on its own date (not back-baked) says only that it is older
  const page = await boot(indexUrl, { now: NOW, snaps: {
    '2026-10-09': snapFor('2026-10-09'), '2026-10-01': snapFor('2026-10-01', s => s, '2026-10-01T08:09:56Z') } });
  await page.selectOption('#daysel', '2026-10-01');
  await page.waitForTimeout(800);
  const banner = await page.locator('#banner').innerText();
  assert(/Viewing 2026-10-01, not the latest/.test(banner) && !/back-baked/.test(banner),
    'a day baked that morning is "not the latest" but not called back-baked');
  await page.close();
}

// ---- m4: the Supply tab's unattributed count is the month's -----------------
{
  const sk = (s, byMonth) => {
    const ps = { ...(s.supply.price_spikes || {}), unattributed: 62,
      current: { month: '2026-10', suppliers: [], spikes: 22 } };
    if (byMonth) ps.unattributed_by_month = { '2026-08': 29, '2026-09': 18, '2026-10': 15 };
    else delete ps.unattributed_by_month;
    s.supply = { ...s.supply, price_spikes: ps,
      spikes_by_supplier: [{ supplier: 'ACME', spikes: 3, lines: 9, worst_pct: 20, worst_item: 'X', rag: 'green' }] };
    return s;
  };
  let page = await boot(indexUrl, { now: NOW, snaps: { '2026-10-09': snapFor('2026-10-09', s => sk(s, true)) } });
  let t = await page.locator('#sp-tbl').innerText();
  assert(/15 qualifying rises in October 2026 could not be tied/.test(t) && !/62 qualifying rises? (could|across)/.test(t),
    'with per-month counts, the table quotes October\'s 15, not the all-history 62');
  await page.close();
  page = await boot(indexUrl, { now: NOW, snaps: { '2026-10-09': snapFor('2026-10-09', s => sk(s, false)) } });
  t = await page.locator('#sp-tbl').innerText();
  assert(/62 qualifying rises across every report held/.test(t),
    'an older snapshot without them says its figure covers every report held');
  await page.close();
}

// ---- nothing scored yet: the Operations line is a grey dash, not missing ------
{
  const none = s => { const sc = s.scorecard; sc.operations = { ...sc.operations, pct: null, scored: 0, total: 5,
    months: (sc.operations.months || []).map(x => x.m === '2026-10' ? { ...x, pct: null, scored: 0 } : x) }; return s; };
  const page = await boot(indexUrl, { now: NOW, snaps: { '2026-10-09': snapFor('2026-10-09', none) } });
  const t = await page.locator('body').innerText();
  assert(/—\s*Operations · no objective has a scored KR in October 2026 yet/.test(t) && !/0% Operations/.test(t),
    'with no objective scored, the Overview says "— Operations · no objective has a scored KR ... yet", never 0%');
  await page.close();
}

// ---- m9: the OKR wall's legend states both MTD rules --------------------------
{
  const page = await boot(okrUrl, { now: NOW, snaps: { '2026-10-09': snapFor('2026-10-09') } });
  const body = await page.locator('body').innerText();
  assert(/a rate or average until it has 7 days of data; a count until the month closes, unless it is already past its last tolerance/.test(body)
    && !/MTD = month in progress with under 7 days of data/.test(body),
    'the legend gives the 7-day rule for rates and the close-or-breach rule for counts');
  assert(page._errors.length === 0, `okr.html: no page errors (got ${JSON.stringify(page._errors)})`);
  await page.close();
}

await browser.close();
console.log(failures ? `\n${failures} assertion(s) FAILED` : '\nall assertions passed');
process.exit(failures ? 1 : 0);
