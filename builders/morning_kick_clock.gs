/**
 * Ops Command morning-kick clock (Google Apps Script).
 *
 * Why this exists (16/11/2026): GitHub starts the MakiManc repos' scheduled
 * workflows hours late, and the Claude scheduled task that replaced it as
 * the clock (09/11) stopped landing dispatches after 11/11 while still
 * reporting success. Apps Script time-driven triggers fire within the
 * chosen hour, every day, for free, on Ross's own Google account - the same
 * place the Slerp webhooks already run.
 *
 * What it does: one POST to GitHub that creates a workflow_dispatch run of
 * morning_kick.yml on MakiManc/ops. morning_kick.py then does the rest
 * (waits to 08:12 UK, dispatches the export, Monday deep pull, retries).
 * Nothing else: no pushes, no secrets read, no data touched.
 *
 * SET-UP (Ross, ~5 minutes, once):
 *   1. script.google.com -> New project -> paste this file -> save as
 *      "Ops Command morning kick clock".
 *   2. Project Settings -> Script Properties -> add
 *        GITHUB_TOKEN = <fine-grained PAT: Resource owner MakiManc, Only
 *        select repositories: MakiManc/ops, Repository permissions:
 *        Actions = Read and write. Nothing else. Note its expiry date.>
 *      (This is a SEPARATE token from the repo's ETL_DISPATCH_TOKEN, which
 *      is scoped to maki-hospitality-etl, not ops.)
 *   3. Run `kickOnce` once from the editor to grant the UrlFetch permission
 *      and confirm it returns 204; check a workflow_dispatch run appears at
 *      https://github.com/MakiManc/ops/actions/workflows/morning_kick.yml
 *   4. Run `installTrigger` once. It schedules kickOnce daily in the
 *      06:00-07:00 Europe/London window (Apps Script picks the minute).
 *      morning_kick.py sleeps until 08:12 UK regardless of when it starts,
 *      so anything before 08:00 is fine.
 *   5. Optional: Triggers page -> the trigger -> Failure notification
 *      settings -> "Notify me immediately", so a 401 (token expired) emails
 *      you the same morning.
 */

const OWNER = 'MakiManc';
const REPO = 'ops';
const WORKFLOW = 'morning_kick.yml';
const REF = 'main';

function kickOnce() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('Script Property GITHUB_TOKEN is not set');
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    payload: JSON.stringify({ ref: REF }),
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  console.log(`dispatch ${WORKFLOW}: HTTP ${code} ${resp.getContentText().slice(0, 200)}`);
  // 204 = run created. Throwing on anything else makes the trigger's own
  // failure notification fire, which is the alert path.
  if (code !== 204) throw new Error(`GitHub dispatch failed: HTTP ${code} ${resp.getContentText().slice(0, 200)}`);
  return code;
}

function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'kickOnce')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('kickOnce')
    .timeBased()
    .everyDays(1)
    .atHour(6)              // 06:00-07:00 in the script's time zone
    .inTimezone('Europe/London')
    .create();
  console.log('daily trigger installed: kickOnce, 06:00-07:00 Europe/London');
}
