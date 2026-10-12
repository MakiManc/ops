// Phase 3 in both shells (11/10/2026): OO5 KR3, OO5 KR5 and the scheduled-task target.
//
// No shell code changed in Phase 3 - the rows are built by the bake
// (builders/factory_kpis.py) and rendered by the existing scorecard and OKR
// wall. This pins that they render as the bake means them:
//   * OO5 KR3 for a scored month: the mean with its worst week, scored; for a
//     short month: the value, "3 of 4 weeks", and NOT scored; for the open
//     month with nothing entered: month to date, no number, never 0;
//   * OO5 KR5 for a closed month with a source missing: the count shown, not
//     scored, with the reason; never a score chip;
//   * the Operating KPIs: "Scheduled task on-time" carries its >=95% target and
//     a green or red chip; the Production "Stock variance" placeholder is gone.
// Booted for real against served fixtures (window.OPS_BASE + route
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

const DATE = '2026-10-11';
const v = (m, kw) => ({ m, label: m, value: null, display: null, score: null, rag: null, basis: null,
  trend: null, trend_unit: null, trend_note: null, not_measured: null, ...kw });
const NOTE = "From the factory's Weekly Report workbook, tab 'STOCK TAKE VARIANCE - WEEKLY' (read 2026-10-11)";

function fixture() {
  const s = clone(baseSnap);
  s.pull_date = DATE; s.generated_at = DATE + 'T15:00:00Z';
  s.feed_health = (s.feed_health || []).map(r => ({ ...r, age_days: 0 }));
  const sc = s.scorecard;
  sc.month = '2026-10';
  for (const m of ['2026-08', '2026-09', '2026-10']) if (!sc.months.includes(m)) sc.months.push(m);
  sc.months.sort().reverse();
  const row = (o, k) => sc.rows.find(r => r.objective === o && r.kr === k);
  const k3oct = v('2026-10', { mtd: true, coverage_days: 0,
    basis: 'month-to-date, not yet scored (0 weeks entered) - no week commencing in October 2026 is entered on the sheet yet; the newest entry is w/c 21/09/2026. ' + NOTE });
  Object.assign(row('OO5', 'KR3'), {
    source_kind: 'computed', tab: '—', not_measured: null, value: null, display: null, score: null,
    rag: null, mtd: true, coverage_days: 0, basis: k3oct.basis,
    months: [
      v('2026-08', { value: 3.18, display: '3.18% (worst -5.80%)', score: 100, rag: 'green',
        basis: 'Mean ABSOLUTE weekly stocktake variance over the 5 week(s) commencing in August 2026. Worst week: w/c 03/08/2026 at -5.80%. ' + NOTE }),
      v('2026-09', { value: 4.23, display: '4.23% (worst -4.70%) - 3 of 4 weeks', incomplete: true,
        basis: 'not scored - an INCOMPLETE month: w/c 28/09/2026 is not entered, so 3 of 4 weeks are known - ' + NOTE }),
      k3oct],
  });
  Object.assign(row('OO5', 'KR5'), {
    source_kind: 'computed', tab: '—', not_measured: null, value: null, display: null, score: null,
    rag: null, mtd: true,
    basis: "month-to-date, not yet scored - the site-orders table is not counted. So far: 100.0% (2 of 2)",
    months: [
      v('2026-09', { value: 75.0, display: '75.0% (3 of 4)', incomplete: true,
        basis: 'not scored - an INCOMPLETE month: no pull of the issue-form feed covers 20/09, 21/09, 22/09, so 75.0% is an upper bound - (a) PO UK 16238 (collected 17/09) NOT IN FULL - short MR005 1 carton' }),
      v('2026-10', { mtd: true, basis: 'month-to-date, not yet scored - the site-orders table is not counted. So far: 100.0% (2 of 2)' })],
  });
  s.scorecard.operating_kpis = (sc.operating_kpis || []).filter(k => k.kr !== 'Stock variance');
  const st = sc.operating_kpis.find(k => k.kr === 'Scheduled task on-time');
  if (st) Object.assign(st, { target: '>=95%', value: 98.7, display: '98.7%', rag: 'green',
    basis: '38478 on time of 38985 scheduled task instances in this pull\'s window. Target >=95% (Ross, 09/10/2026)' });
  else sc.operating_kpis.push({ function: 'Compliance', kr: 'Scheduled task on-time', target: '>=95%',
    tab: 'p-tasks', value: 98.7, display: '98.7%', rag: 'green', basis: 'Target >=95% (Ross, 09/10/2026)',
    not_measured: null, months: null, trend: null });
  for (const o of sc.objectives)
    for (const m of ['2026-08', '2026-09', '2026-10'])
      if (!o.months.find(x => x.m === m)) o.months.push({ m, pct: null, scored: 0, total: 5 });
  return s;
}

async function boot(url, snap) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.clock.setFixedTime(new Date(DATE + 'T14:00:00Z'));
  await page.addInitScript(() => { window.OPS_BASE = 'http://fixtures.test/'; });
  await page.route('http://fixtures.test/**', route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === 'snapshot_index.json')
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ latest: DATE, dates: [DATE], generated_at: DATE + 'T15:00:00Z' }) });
    if (name === `snapshot_${DATE}.json`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snap) });
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await page.goto(url);
  await page.waitForTimeout(1200);
  page._errors = errors;
  return page;
}

const rowsOf = page => page.locator('#scorecard tbody tr').evaluateAll(trs => trs.map(tr => tr.innerText));
const kr3 = t => /Stock|stocktake|variance/i.test(t) && /OO5|KR3/.test(t);

// ---- index.html: the scorecard --------------------------------------------------
{
  const page = await boot(indexUrl, fixture());
  for (const [m, want, label] of [
    ['2026-08', r => /3\.18% \(worst -5\.80%\)/.test(r) && /\b100\b/.test(r), 'August: 3.18% with its worst week, scored 100'],
    ['2026-09', r => /4\.23%/.test(r) && /3 of 4 weeks/.test(r) && /INCOMPLETE/.test(r), 'September: shown, 3 of 4 weeks, NOT scored, says why'],
    ['2026-10', r => /month-to-date/.test(r) && /w\/c 21\/09\/2026/.test(r) && !/\b0\.00%/.test(r), 'October: month to date, no number, how far the sheet reaches - never 0'],
  ]) {
    await page.selectOption('#sc-month', m);
    await page.waitForTimeout(250);
    const rows = await rowsOf(page);
    const r3 = rows.find(t => /KR3/.test(t) && /variance/i.test(t)) || rows.find(kr3);
    assert(r3 && want(r3), 'OO5 KR3 ' + label + (r3 ? '' : ' (row not found)'));
    assert(r3 && !/undefined|NaN|\bnull\b/.test(r3), `OO5 KR3 ${m}: no undefined/NaN/null on the page`);
  }
  await page.selectOption('#sc-month', '2026-09');
  await page.waitForTimeout(250);
  const r5 = (await rowsOf(page)).find(t => /KR5/.test(t) && /[Pp]roduction|in full/.test(t));
  assert(r5 && /75\.0% \(3 of 4\)/.test(r5) && /upper bound/.test(r5) && !/undefined|NaN/.test(r5),
    'OO5 KR5 September: the count shown, NOT scored, with the reason');
  const body = await page.locator('body').innerText();
  assert(/>=95%/.test(body.slice(body.indexOf('Scheduled task on-time'), body.indexOf('Scheduled task on-time') + 400)),
    'Operating KPIs: the scheduled-task row shows its >=95% target');
  const chip = await page.locator('tr', { hasText: 'Scheduled task on-time' }).last().innerHTML();
  assert(/green|Green|On target|on target|ok/.test(chip), 'and a green chip at 98.7%');
  assert(!/Stock variance/.test(body), 'the Production "Stock variance" placeholder is gone');
  assert(page._errors.length === 0, 'no page errors (scorecard)' + (page._errors.length ? ': ' + page._errors.join(' | ') : ''));
  await page.close();
}

// ---- okr.html -------------------------------------------------------------------
{
  const page = await boot(okrUrl + '?m=2026-08', fixture());
  const cards = await page.locator('.kr').evaluateAll(ds => ds.map(d => d.innerText));
  const c3 = cards.find(t => /KR3/.test(t) && /variance/i.test(t));
  assert(c3 && /3\.18% \(worst -5\.80%\)/.test(c3), 'the wall\'s OO5 KR3 card, August: the mean and its worst week');
  await page.close();
  const p2 = await boot(okrUrl + '?m=2026-10', fixture());
  const c3o = (await p2.locator('.kr').evaluateAll(ds => ds.map(d => d.innerText))).find(t => /KR3/.test(t) && /variance/i.test(t));
  assert(c3o && !/\b0\.00%/.test(c3o) && !/undefined|NaN/.test(c3o), 'October on the wall: no figure, never 0');
  assert(p2._errors.length === 0, 'no page errors on okr.html' + (p2._errors.length ? ': ' + p2._errors.join(' | ') : ''));
  await p2.close();
}

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall passed');
process.exit(failures ? 1 : 0);
