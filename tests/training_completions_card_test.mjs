// Training tab: the completions-per-week card fills (09/10/2026).
//
// The verifier had been warning "no parseable module_completed_date values"
// and the card was reported blank. The warning was a DuckDB regex quirk in
// the verifier (see tests/deep_flow_dates_test.py) - the bake's dates were
// always fine - so this pins the other half: given the newest real snapshot,
// the card draws one point per completion week, the total it prints is the
// baked total, and a 30-day window on the snapshot's own day is not empty.
//
// Uses the newest committed snapshot as its fixture, like the other shell
// tests, with the clock pinned to that snapshot's pull date so "30 days" means
// the same thing on every run.
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
const snap = JSON.parse(readFileSync(path.join(snapDir, latestSnap), 'utf-8'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); }
  else console.log('ok  :', msg);
}

// What the card should show, computed independently of the page.
const monday = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
const comp = snap.training.completions || [];
const weeksMand = new Map();
for (const c of comp) { const w = monday(c.d); weeksMand.set(w, (weeksMand.get(w) || 0) + (c.nm || 0)); }
const totalMand = [...weeksMand.values()].reduce((a, b) => a + b, 0);
const newestWeek = [...weeksMand.keys()].sort().pop();
const totalAll = comp.reduce((a, c) => a + (c.n || 0), 0);
assert(comp.length > 0, `the newest snapshot (${latestSnap}) carries completion rows (got ${comp.length})`);

const pinnedChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(pinnedChromium) ? { executablePath: pinnedChromium } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.clock.setFixedTime(new Date(snap.pull_date + 'T12:00:00Z'));
const NETWORK_NOISE = /Failed to load resource|net::ERR_|ERR_CERT/;
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));
page.on('console', msg => {
  if (msg.type() === 'error' && !NETWORK_NOISE.test(msg.text())) consoleErrors.push(msg.text());
});
await page.goto(pageUrl);
await page.waitForTimeout(1500);
await page.evaluate(s => window.render(s), snap);
await page.evaluate(() => window.gotoPage('p-train'));
assert(await page.locator('#p-train').isVisible(), 'the Training tab opens');

const card = async () => ({
  title: await page.locator('#tr-comp-t').innerText(),
  sub: await page.locator('#tr-comp-sub').innerText(),
  dots: await page.locator('#tr-comp svg circle').count(),
  empty: await page.locator('#tr-comp .empty').count(),
  labels: await page.locator('#tr-comp svg circle').evaluateAll(cs => cs.map(c => c.dataset.t)),
});

// ---- default view: mandatory, all dates --------------------------------
{
  const c = await card();
  assert(c.empty === 0, 'the card is not on an empty state');
  assert(c.title === 'Mandatory completions per week', `default title (got ${JSON.stringify(c.title)})`);
  assert(c.dots === weeksMand.size, `one point per completion week: ${weeksMand.size} (got ${c.dots})`);
  const shown = Number((c.sub.match(/^([\d,]+)/) || [])[1]?.replace(/,/g, ''));
  assert(shown === totalMand, `the subtitle total is the baked mandatory total, ${totalMand} (got ${shown})`);
  assert(c.labels.some(t => t && t.startsWith('wk ' + newestWeek)),
    `the newest week (${newestWeek}) is plotted`);
}

// ---- all modules ---------------------------------------------------------
{
  await page.locator('#tr-mode button[data-k="all"]').click();
  const c = await card();
  assert(c.title === 'Completions per week (all modules)', 'the mode toggle switches to all modules');
  const shown = Number((c.sub.match(/^([\d,]+)/) || [])[1]?.replace(/,/g, ''));
  assert(shown === totalAll, `all-modules total is the baked total, ${totalAll} (got ${shown})`);
  await page.locator('#tr-mode button[data-k="mand"]').click();
}

// ---- 30 days on the snapshot's own day is not empty ----------------------
{
  // Set the range the way calcEV() does for the "30 days" button. Not a click:
  // boot() binds the range buttons only after it has fetched the live index,
  // which a sandbox without network never gets to.
  const from = new Date(Date.parse(snap.pull_date + 'T12:00:00Z') - 30 * 864e5).toISOString().slice(0, 10);
  await page.evaluate(f => { EV = { f, t: null }; }, from);
  await page.evaluate(s => window.render(s), snap);
  await page.evaluate(() => window.gotoPage('p-train'));
  const c = await card();
  const weeksIn = new Set(comp.filter(x => x.d >= from).map(x => monday(x.d))).size;
  const inRange = comp.filter(x => x.d >= from && (x.nm || 0) > 0).length;
  assert(inRange > 0 && c.empty === 0 && c.dots === weeksIn,
    `the last 30 days (from ${from}) draw their ${weeksIn} weeks from ${inRange} in-range rows (dots ${c.dots}, empty ${c.empty})`);
}

assert(consoleErrors.length === 0, `no console/page errors (got ${JSON.stringify(consoleErrors)})`);
await browser.close();
if (failures > 0) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log('\nall assertions passed');
