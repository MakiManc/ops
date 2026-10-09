// Maintenance tab: the Facilities card says WHY the feed is stale, and warns
// before it is (09/10/2026).
//
// The builder now names the cause of a failed pull (refresh_facilities.py's
// facilities_pull_status.json) in the stale note, and - inside the 3-day grace
// period, while the last good copy is still quoted - sets
// maintenance.facilities.pull_note. It also says which route delivered the
// copy (the bake's own pull, or the push from PythonAnywhere). This pins how
// the card shows all three. Fixture: the newest real snapshot's facilities
// block, with each variant baked by the REAL facilities_block() over the
// committed fixture feed.
import { chromium } from 'playwright';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

// Three tabs from the real builder function: stale with a named cause; fresh
// but today's pull failed; fresh via the PythonAnywhere push.
const py = `
import json, sys, datetime
sys.path.insert(0, ${JSON.stringify(path.join(repoRoot, 'builders'))})
import bake_ops_command as b
feed = json.load(open(${JSON.stringify(path.join(repoRoot, 'tests', 'fixtures', 'facilities_ppm.json'))}))
today = datetime.date(2026, 10, 9)
st = {"attempted_at": "2026-10-09T15:00:00Z", "ok": False, "cause": "key_rejected",
      "detail": "HTTP 401 UNAUTHORIZED", "http_status": 401}
out = {
  "stale": b.facilities_block(dict(feed, pulled_at="2026-09-25T09:47:06Z"), None, today, pull_status=st)["tab"],
  "grace": b.facilities_block(dict(feed, pulled_at="2026-10-08T15:00:00Z"), None, today,
                              pull_status=dict(st, cause="timeout", detail="no answer within 40s"))["tab"],
  "pushed": b.facilities_block(dict(feed, pulled_at="2026-10-09T06:30:00Z"), None, today,
                               label="data/ops_command/" + b.FACILITIES_PUSHED_FILE)["tab"],
}
print(json.dumps(out))
`;
const p = spawnSync('python3', ['-c', py], { encoding: 'utf-8' });
if (p.status !== 0) { console.error('builder failed:', p.stderr.slice(-1500)); process.exit(1); }
const tabs = JSON.parse(p.stdout);

const pinnedChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(pinnedChromium) ? { executablePath: pinnedChromium } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(pageUrl);
await page.waitForTimeout(1500);
const show = async fac => {
  const snap = { ...baseSnap, maintenance: { ...baseSnap.maintenance, facilities: fac } };
  await page.evaluate(s => window.render(s), snap);
  await page.evaluate(() => window.gotoPage('p-maint'));
  return page.locator('#fac-head').innerText();
};

{
  const head = await show(tabs.stale);
  assert(/Read this first\./.test(head) && /REJECTED the API key/.test(head) && /config_secrets\.py/.test(head),
    `stale: the card says the app rejected the key, and where to fix it (got ${JSON.stringify(head.slice(0, 160))})`);
  assert(await page.locator('#fac-pull-note').count() === 0, 'stale: no second "pull failed" line on top of the stale one');
}
{
  const head = await show(tabs.grace);
  assert(!/Read this first/.test(head), 'inside the grace period: not "Read this first" - the figures are still quoted');
  const note = await page.locator('#fac-pull-note').innerText();
  assert(/failed/.test(note) && /asleep/.test(note) && /last good copy, pulled 2026-10-08/.test(note),
    `inside the grace period: a warning says the newest pull failed, why, and which copy is shown (got ${JSON.stringify(note.slice(0, 160))})`);
}
{
  const head = await show(tabs.pushed);
  assert(/pushed by the app's own daily task on PythonAnywhere/.test(head),
    `pushed copy: the header names the route (got ${JSON.stringify(head.slice(0, 200))})`);
  assert(await page.locator('#fac-pull-note').count() === 0 && !/Read this first/.test(head), 'pushed copy, fresh: no warnings');
}
assert(errors.length === 0, `no page errors (got ${JSON.stringify(errors)})`);
await browser.close();
if (failures > 0) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log('\nall assertions passed');
