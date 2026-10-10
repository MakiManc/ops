// Sheet-fed KR rows in both shells (Phase 1, 10/10/2026).
//
// The Operations Input sheet brings two row shapes the shells had never drawn:
//   * SCORE-ONLY (OO1): Finance's own 0-100 score with NO value and NO display -
//     the figure behind it is never published. index.html used to dim such a
//     row and print "Needs: no source" beside its score; okr.html showed a grey
//     NOT MEASURED chip and hid the score.
//   * NOT ENTERED: a closed month left blank on the sheet - a grey month that
//     names why, never a 0.
// Plus OO2 KR5 from the Maintenance Contact List, and OO1's withheld objective
// percentage. Booted for real against served fixtures (window.OPS_BASE + route
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

const DATE = '2026-10-10';
const PCT_NOTE = "no objective percentage is published for OO1: its KRs show Finance's own 0-100 scores as chips only";
const v = (m, kw) => ({ m, label: m, value: null, display: null, score: null, rag: null, basis: null,
  trend: null, trend_unit: null, trend_note: null, not_measured: null, ...kw });

function fixture() {
  const s = clone(baseSnap);
  s.pull_date = DATE; s.generated_at = DATE + 'T15:00:00Z';
  s.feed_health = (s.feed_health || []).map(r => ({ ...r, age_days: 0 }));
  const sc = s.scorecard;
  sc.month = '2026-10';
  if (!sc.months.includes('2026-09')) sc.months.push('2026-09');
  sc.months.sort().reverse();
  const row = (o, k) => sc.rows.find(r => r.objective === o && r.kr === k);
  // OO1 KR1: Finance's score for September, October in progress
  Object.assign(row('OO1', 'KR1'), {
    source_kind: 'sheet_finance', value: null, display: null, score: null, rag: null, mtd: true,
    not_measured: null,
    basis: "month in progress - Finance's score for October 2026 is counted once the month closes",
    months: [
      v('2026-09', { score: 80, rag: 'amber',
        basis: "Finance's score for September 2026: 80 of 100, from the '2026 Summary' tab. Score only - the figure Finance scores is not published here, because this repository is public." }),
      v('2026-10', { mtd: true, basis: "month in progress - Finance's score for October 2026 is counted once the month closes" }),
    ],
  });
  // OO2 KR3: September NOT ENTERED on the log tab
  Object.assign(row('OO2', 'KR3'), {
    source_kind: 'sheet_log', value: null, display: null, score: null, rag: null, mtd: true,
    basis: 'month-to-date, not yet scored - nothing is entered for October 2026 in the closures log tab yet.',
    not_measured: null,
    months: [
      v('2026-09', { not_measured: 'not entered for September 2026 in the closures log tab of the 2026 Operations Input sheet (read 2026-10-10). A month left blank is not scored - it is never read as a zero' }),
      v('2026-10', { mtd: true, basis: 'month-to-date, not yet scored - nothing is entered for October 2026 in the closures log tab yet.' }),
    ],
  });
  // OO2 KR5: current state from the contact list
  Object.assign(row('OO2', 'KR5'), {
    source_kind: 'sheet_contacts', value: 0, display: '0 of 20 sites (0%)', score: 0, rag: 'red',
    not_measured: null, months: null, mtd: null,
    basis: "0 of the 20 corporate restaurants have at least one maintenance contact on their city tab.",
  });
  const oo1 = sc.objectives.find(o => o.objective === 'OO1');
  Object.assign(oo1, { pct: null, scored: 0, pct_note: PCT_NOTE,
    months: sc.months.map(m => ({ m, pct: null, scored: m === '2026-09' ? 1 : 0, total: 5 })) });
  for (const o of sc.objectives) {
    if (!o.months.find(x => x.m === '2026-09')) o.months.push({ m: '2026-09', pct: null, scored: 0, total: 5 });
  }
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

const rowsOf = page => page.locator('#scorecard tbody tr').evaluateAll(trs => trs.map(tr => ({
  text: tr.innerText, style: tr.getAttribute('style') || '',
  cells: [...tr.querySelectorAll('td')].map(td => td.innerText.trim()) })));

// ---- index.html --------------------------------------------------------------
{
  const page = await boot(indexUrl, fixture());
  await page.selectOption('#sc-month', '2026-09');
  await page.waitForTimeout(300);
  let rows = await rowsOf(page);
  const k1 = rows.find(r => /Actual W\/R%/.test(r.text));
  assert(k1 && !/opacity:\s*\.72/.test(k1.style), 'September: the score-only OO1 KR1 row is NOT dimmed');
  assert(k1 && k1.cells[2] === 'score only', `its Now cell says "score only", not a dash (got ${k1 && k1.cells[2]})`);
  assert(k1 && k1.cells[3] === '80' && /Within tolerance/.test(k1.cells[4]), 'it shows Finance\'s score 80 and the amber chip');
  assert(k1 && /Finance, from sheet/.test(k1.text) && /Finance's score for September 2026/.test(k1.text)
    && !/Needs:/.test(k1.text), 'its detail is the basis and its source - not "Needs: no source"');
  const head = rows.find(r => /^OO1/.test(r.text));
  assert(head && /—/.test(head.text) && /1 of 5 scored/.test(head.text) && head.text.includes('no objective percentage is published for OO1'),
    'the OO1 heading shows a dash, "1 of 5 scored", and why there is no percentage');
  const k3 = rows.find(r => /zero unplanned restaurant closures/.test(r.text));
  assert(k3 && /opacity:\s*\.72/.test(k3.style) && /Needs:.*not entered for September 2026/s.test(k3.text)
    && k3.cells[2] === '—' && k3.cells[3] === '—',
    'September: OO2 KR3 not entered is grey, names why, and carries no score - never 0');

  await page.selectOption('#sc-month', '2026-10');
  await page.waitForTimeout(300);
  rows = await rowsOf(page);
  const k5 = rows.find(r => /Maintenance Contact Sheets/.test(r.text));
  assert(k5 && k5.cells[2] === '0 of 20 sites (0%)' && k5.cells[3] === '0' && /Off target/.test(k5.cells[4])
    && /from the Maintenance Contact List/.test(k5.text), 'October: OO2 KR5 shows 0 of 20 sites, score 0, red, and its source');
  const k1o = rows.find(r => /Actual W\/R%/.test(r.text));
  assert(k1o && k1o.cells[3] === '—' && /counted once the month closes/.test(k1o.text),
    'October: OO1 KR1 in progress has no score and says when it will');
  const prov = await page.locator('#scorecard .prov').last().innerText();
  assert(/measured/.test(prov), 'the footer still renders');
  assert(page._errors.length === 0, 'no page errors on index.html' + (page._errors.length ? ': ' + page._errors.join(' | ') : ''));
  await page.close();
}

// ---- okr.html ----------------------------------------------------------------
{
  const snap = fixture();
  const page = await boot(okrUrl + '?m=2026-09', snap);
  const cards = await page.locator('.kr').evaluateAll(ds => ds.map(d => ({
    cls: d.className, chip: d.querySelector('.chip')?.innerText, t: d.querySelector('.t')?.innerText,
    v: d.querySelector('.v')?.innerText || '', why: d.querySelector('.why')?.innerText || '' })));
  const k1 = cards.find(c => /Actual W\/R%/.test(c.t || ''));
  assert(k1 && !/grey/.test(k1.cls) && k1.chip === '80', `the OO1 KR1 card is not grey and shows Finance's score 80 (got ${k1 && k1.chip})`);
  assert(k1 && /score only/.test(k1.v) && !/%/.test(k1.v), 'its value line says "score only" and carries no percentage');
  const k3 = cards.find(c => /zero unplanned restaurant closures/.test(c.t || ''));
  assert(k3 && /grey/.test(k3.cls) && k3.chip === 'NOT MEASURED' && /not entered for September 2026/.test(k3.why),
    'OO2 KR3 September is grey NOT MEASURED, naming the month as not entered');
  const tiles = await page.locator('.tile').evaluateAll(ds => ds.map(d => ({
    o: d.querySelector('.o')?.innerText, p: d.querySelector('.p')?.innerText,
    title: d.querySelector('.p')?.getAttribute('title') || '' })));
  const t1 = tiles.find(t => t.o === 'OO1');
  assert(t1 && /^—/.test(t1.p) && /1 of 5 scored/.test(t1.p) && t1.title.includes('no objective percentage'),
    'the OO1 tile shows a dash and "1 of 5 scored", with the reason on hover');
  assert(page._errors.length === 0, 'no page errors on okr.html' + (page._errors.length ? ': ' + page._errors.join(' | ') : ''));
  await page.close();
}

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall passed');
process.exit(failures ? 1 : 0);
