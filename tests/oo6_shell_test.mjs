// OO6 (Frozen Ramen, Ross 21/10/2026) in both shells and the OKR pack's data.
//
// Two things the shells had never drawn:
//   * a REFERENCE figure beside a KR that is never scored (OO6 KR1's
//     frozen-ramen issue forms) - shown even while the KR itself is grey,
//     never in the Now or Score column, and moving with the month picker
//     (October's forms never appear under September);
//   * two new source labels: Matthew's typed figure, and Ross's weekly stock
//     count report.
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

const DATE = '2026-11-04';
const v = (m, kw) => ({ m, label: m, value: null, display: null, score: null, rag: null, basis: null,
  trend: null, trend_unit: null, trend_note: null, not_measured: null, ...kw });
const BLOCK = 'the 2026 Operations Input sheet has not been read into this repository yet - HTTP 403';
const REF = (n, disp, basis) => ({ label: 'Frozen ramen on issue forms (reference, not scored)',
  value: n, display: disp, basis });

function fixture() {
  const s = clone(baseSnap);
  s.pull_date = DATE; s.generated_at = DATE + 'T15:00:00Z';
  s.feed_health = (s.feed_health || []).map(r => ({ ...r, age_days: 0 }));
  const sc = s.scorecard;
  sc.month = '2026-11';
  sc.months = ['2026-11', '2026-10', '2026-09'];
  const row = (o, k) => sc.rows.find(r => r.objective === o && r.kr === k);
  // OO6 KR1: GREY (the sheet is 403) - but its reference is known, per month
  const nov = REF(1, '1 so far', '1 delivery/supplier issue form(s) answered in November 2026 mention frozen ramen: 02/11 Maki Leeds (JFC)');
  Object.assign(row('OO6', 'KR1'), {
    band: 'full', target: '100%', source_kind: 'not_measured', value: null, display: null,
    score: null, rag: null, basis: null, not_measured: BLOCK, reference: nov,
    months: [
      v('2026-10', { not_measured: BLOCK, reference: REF(4, '4',
        '4 delivery/supplier issue form(s) answered in October 2026 mention frozen ramen: 08/10 Fountain Good Food Ltd (Lynas); 09/10 Maki NE1 Ltd (Lynas); 12/10 <b>Bold</b> & "Quoted" Ltd') }),
      v('2026-11', { not_measured: BLOCK, reference: nov }),
    ],
  });
  // OO6 KR2: October scored from JFC's POs and the invoiced cell
  Object.assign(row('OO6', 'KR2'), {
    band: 'prod', source_kind: 'computed', value: null, display: null, score: null, rag: null, mtd: true,
    basis: 'month-to-date, not yet scored - the month is in progress, and its invoicing is typed after it closes.',
    not_measured: null,
    months: [
      v('2026-10', { value: 100, display: '100.0% (4 of 4)', score: 100, rag: 'green',
        basis: '4 of 4 JFC PO(s) collected in October 2026 passed.' }),
      v('2026-11', { mtd: true, basis: 'month-to-date, not yet scored - the month is in progress, and its invoicing is typed after it closes.' }),
    ],
  });
  // OO6 KR3: Ross's weekly stock count
  Object.assign(row('OO6', 'KR3'), {
    band: 'full', target: '100%', source_kind: 'stock_report', value: null, display: null, score: null,
    rag: null, mtd: true, not_measured: null,
    basis: 'month-to-date, not yet scored (3 days of data)',
    months: [
      v('2026-10', { value: 95, display: '95.0% (76 of 80 location-weeks, 4 weeks)', score: 0, rag: 'red',
        basis: '76 of 80 location-weeks counted in October 2026: w/c 05/10: 19 of 20 (not counted: Maki Soho)' }),
      v('2026-11', { mtd: true, basis: 'month-to-date, not yet scored (3 days of data)' }),
    ],
  });
  for (const o of sc.objectives) {
    o.months = sc.months.map(m => o.months.find(x => x.m === m) || { m, pct: null, scored: 0, total: 5 });
  }
  const o6 = sc.objectives.find(o => o.objective === 'OO6');
  Object.assign(o6.months.find(x => x.m === '2026-10'), { pct: 50, scored: 2, total: 5 });
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
const kr = (rows, re) => rows.find(r => re.test(r.text));

// ---- index.html --------------------------------------------------------------
{
  const page = await boot(indexUrl, fixture());
  let rows = await rowsOf(page);
  let k1 = kr(rows, /Supply Chain availibility/);
  assert(k1 && /opacity:\s*\.72/.test(k1.style) && /Needs:.*HTTP 403/s.test(k1.text),
    'November: OO6 KR1 is grey with the 403 named');
  assert(k1 && /Frozen ramen on issue forms \(reference, not scored\):\s*1 so far/.test(k1.text),
    'November: beside the grey KR, its reference figure (1 so far) and what it counts');
  assert(k1 && k1.cells[2] === '—' && k1.cells[3] === '—',
    'the reference is never in the Now or the Score column');
  await page.selectOption('#sc-month', '2026-10');
  await page.waitForTimeout(300);
  rows = await rowsOf(page);
  k1 = kr(rows, /Supply Chain availibility/);
  assert(k1 && /reference, not scored\):\s*4\b/.test(k1.text) && /Maki NE1 Ltd/.test(k1.text),
    'October: the reference moves with the picker - 4 forms, listed');
  assert(k1 && /<b>Bold<\/b> & "Quoted" Ltd/.test(k1.text)
    && await page.locator('#scorecard td b:text-is("Bold")').count() === 0,
    'the reference text is escaped - a site name with markup is shown as text, never rendered');
  await page.selectOption('#sc-month', '2026-09');
  await page.waitForTimeout(300);
  rows = await rowsOf(page);
  k1 = kr(rows, /Supply Chain availibility/);
  assert(k1 && !/reference, not scored/.test(k1.text) && /no figure for September 2026/.test(k1.text),
    'September: no OO6 month - the row says so, and October\'s forms are NOT shown under it');
  await page.selectOption('#sc-month', '2026-10');
  await page.waitForTimeout(300);
  rows = await rowsOf(page);
  const k2 = kr(rows, /On time demand creation/);
  assert(k2 && k2.cells[2] === '100.0% (4 of 4)' && k2.cells[3] === '100' && /On target/.test(k2.cells[4]),
    'October: OO6 KR2 shows its figure, score and chip from the builder');
  const k3 = kr(rows, /forzen ramen/);
  assert(k3 && k3.cells[3] === '0' && /Off target/.test(k3.cells[4])
    && /from Ross's weekly stock count report/.test(k3.text),
    'October: OO6 KR3 scores 0 on one missed location and says where it comes from');
  const head = kr(rows, /^OO6/);
  assert(head && /50%/.test(head.text) && /2 of 5 scored/.test(head.text), 'the OO6 heading: 50%, 2 of 5 scored');
  assert(page._errors.length === 0, 'no page errors' + (page._errors.length ? ': ' + page._errors.join('; ') : ''));
  await page.close();
}
{
  // a typed OO6 KR1 (the sheet read) is labelled as Matthew's, not Finance's
  const s = fixture();
  const r = s.scorecard.rows.find(x => x.objective === 'OO6' && x.kr === 'KR1');
  Object.assign(r, { source_kind: 'sheet_input', not_measured: null });
  r.months[0] = { ...r.months[0], not_measured: null, value: 99, display: '99%', score: 80, rag: 'amber',
    basis: '99% supply chain availability in October 2026, as typed by Matthew' };
  const page = await boot(indexUrl, s);
  await page.selectOption('#sc-month', '2026-10');
  await page.waitForTimeout(300);
  const k1 = kr(await rowsOf(page), /Supply Chain availibility/);
  assert(k1 && /typed on the sheet by Matthew/.test(k1.text) && !/Finance, from sheet/.test(k1.text)
    && k1.cells[2] === '99%' && k1.cells[3] === '80' && /reference, not scored\):\s*4\b/.test(k1.text),
    'a typed OO6 KR1: "typed on the sheet by Matthew", 99% -> 80 - and the reference still beside it');
  await page.close();
}

// ---- okr.html (the wall) ---------------------------------------------------------
{
  const page = await boot(okrUrl, fixture());
  // `ref` only when the reference is actually RENDERED: innerText of a hidden
  // element falls back to its text, which would pass a hidden reference
  const card = async () => page.locator('.kr').evaluateAll(ks => ks.map(k => {
    const r = k.querySelector('.ref');
    const shown = r && getComputedStyle(r).display !== 'none' && r.getClientRects().length > 0;
    return { text: k.innerText, grey: k.classList.contains('grey'),
      ref: shown ? r.innerText : null,
      value: (k.querySelector('.v') || {}).innerText || '',
      chip: (k.querySelector('.chip') || {}).innerText || null };
  }));
  let ks = await card();
  let k1 = ks.find(k => /Supply Chain availibility/.test(k.text));
  assert(k1 && k1.grey && k1.chip === 'NOT MEASURED' && /1 so far/.test(k1.ref || ''),
    'the wall, November: OO6 KR1 grey, NOT MEASURED - and its reference shown beside it');
  await page.selectOption('#msel', '2026-10');
  await page.waitForTimeout(300);
  ks = await card();
  k1 = ks.find(k => /Supply Chain availibility/.test(k.text));
  assert(k1 && /reference, not scored\): 4$/.test((k1.ref || '').trim()), 'the wall, October: the reference reads 4');
  assert(k1 && !/reference/i.test(k1.value) && k1.chip === 'NOT MEASURED',
    'the wall: the reference is never the value line or the chip');
  const refAttr = await page.locator('.kr .ref').evaluateAll(rs => rs.map(r => ({
    title: r.getAttribute('title'), bolds: r.querySelectorAll('b').length, text: r.innerText })));
  const oct = refAttr.find(r => /: 4$/.test(r.text.trim()));
  assert(oct && oct.title.endsWith('12/10 <b>Bold</b> & "Quoted" Ltd') && oct.bolds === 1,
    'the wall escapes the reference: a quote in a site name stays inside the title, and markup is text');
  await page.selectOption('#msel', '2026-09');
  await page.waitForTimeout(300);
  ks = await card();
  k1 = ks.find(k => /Supply Chain availibility/.test(k.text));
  assert(k1 && k1.ref === null, 'the wall, September: no reference (no OO6 month)');
  await page.close();
}
{
  // a SCORED KR1 on the wall: the reference is beside the value line, never in it
  const s = fixture();
  const r = s.scorecard.rows.find(x => x.objective === 'OO6' && x.kr === 'KR1');
  Object.assign(r, { source_kind: 'sheet_input', not_measured: null });
  r.months[0] = { ...r.months[0], not_measured: null, value: 99, display: '99%', score: 80, rag: 'amber',
    basis: '99% supply chain availability in October 2026, as typed by Matthew' };
  const page = await boot(okrUrl, s);
  await page.selectOption('#msel', '2026-10');
  await page.waitForTimeout(300);
  const k = (await page.locator('.kr').evaluateAll(ks => ks.map(k => ({
    text: k.innerText, chip: (k.querySelector('.chip') || {}).innerText,
    value: (k.querySelector('.v') || {}).innerText || '', ref: (k.querySelector('.ref') || {}).innerText || '' }))))
    .find(x => /Supply Chain availibility/.test(x.text));
  assert(k && k.chip === '80' && /^99%/.test(k.value) && !/4|reference/i.test(k.value.replace('99%', ''))
    && /reference, not scored\): 4$/.test(k.ref.trim()),
    'the wall, a scored KR1: chip 80, value 99% - and the reference only on its own line');
  await page.close();
}
{
  const page = await boot(okrUrl, fixture());
  const card = async () => page.locator('.kr').evaluateAll(ks => ks.map(k => {
    const r = k.querySelector('.ref');
    const shown = r && getComputedStyle(r).display !== 'none' && r.getClientRects().length > 0;
    return { text: k.innerText, ref: shown ? r.innerText : null };
  }));
  let ks, k1;
  await page.goto(okrUrl + '?tv=1');
  await page.waitForTimeout(1200);
  ks = await card();
  k1 = ks.find(k => /Supply Chain availibility/.test(k.text));
  assert(k1 && /1 so far/.test(k1.ref || ''), 'the TV view keeps the reference (it is short; the basis is hidden)');
  assert(page._errors.length === 0, 'no page errors on the wall' + (page._errors.length ? ': ' + page._errors.join('; ') : ''));
  await page.close();
}

await browser.close();
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall OO6 shell checks passed');
