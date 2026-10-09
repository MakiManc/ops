#!/usr/bin/env python3
"""Get Ops Command ready by 10:00 UK: start the private pipeline on time.

WHY (Ross, 09/10/2026: "change it so that the dashboard is ready by 10am")
--------------------------------------------------------------------------
The data pipeline lives in the private repo MakiManc/maki-hospitality-etl,
and GitHub creates that repo's SCHEDULED runs 3-12 hours late (measured since
27/08/2026; see the header of its daily-export.yml). The 08:17 UTC export
cron therefore fires anywhere from 12:30 to 17:00 UTC, the bake and verifier
chain off it, and the dashboard is current mid-afternoon at best. Dispatched
runs, by contrast, start within seconds. daily-export.yml says it outright:
"an external clock is still the better answer (dispatch creates the run in
the same second) and still needs a PAT Ross must mint". This is that clock.

It runs from THIS public repo, whose own cron is 1-53 minutes late (median
27, measured by scheduler_probe), early enough that the lateness does not
matter, and then keeps time itself:

  1. if the Flow deep pull has not run today (UK), dispatch it now;
  2. wait until 08:12 UK - the Kobas report emails land 08:0x UK, and the
     export's own gate 3 (kobas_ready.py) refuses to parse them before they
     exist, exiting green having written nothing;
  3. dispatch the export; the bake and the verifier chain off it as always;
  4. watch snapshot_index.json on raw.githubusercontent.com. If today's date
     has not landed and nothing is running, dispatch the export again, at
     most every 20 minutes and at most 3 times (gate 3 may have said "not
     yet"; gate 2 makes a repeat after a good run a 20-second no-op);
  5. done the moment `latest` is today. If it is not by 09:55 UK, fail
     loudly - an ::error::, a red run (GitHub's failure email), and an ntfy
     push when NTFY_TOPIC is set on this repo.

It never pushes, never changes data, and dispatches only the two workflows
named below, on `main`, with no inputs (never `force`).

THE SECRET IT NEEDS (Ross adds it; this script never prints it)
    ETL_DISPATCH_TOKEN  on MakiManc/ops -> Settings -> Secrets -> Actions.
        A fine-grained PAT: Resource owner MakiManc; Only select repositories:
        MakiManc/maki-hospitality-etl; Repository permissions: Actions = Read
        and write (Metadata read is implied). Nothing else. It can start and
        list workflow runs in the private repo and cannot read its code or
        data. It expires - put the date in your calendar.
    NTFY_TOPIC (optional) on MakiManc/ops - the same topic as the ETL repo's,
        for the 09:55 "not ready" push.

Exit codes: 0 ready (or nothing to do), 1 not ready by the deadline, 2 the
token is missing or rejected.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

UK = ZoneInfo("Europe/London")
ETL = "MakiManc/maki-hospitality-etl"
EXPORT_WF = "daily-export.yml"
DEEP_WF = "deep-pull.yml"
BAKE_WF = "ops_command_bake.yml"
INDEX_URL = ("https://raw.githubusercontent.com/MakiManc/ops/main/"
             "data/ops_command/snapshot_index.json")
EXPORT_AT = dt.time(8, 12)       # Kobas emails land 08:0x UK
DEADLINE = dt.time(9, 55)        # ready by 10:00 UK, with time to say so
RETRY_MIN = 20
# After an export run finishes, the bake and the verifier chain off it and
# raw.githubusercontent.com can lag a few minutes; a re-dispatch inside this
# window would start a second export while the first one's snapshot lands.
GRACE_MIN = 10
MAX_DISPATCHES = 3
POLL_S = 120
ACTIVE = {"queued", "in_progress", "waiting", "requested", "pending"}


def log(msg: str) -> None:
    print(f"{dt.datetime.now(UK):%H:%M:%S} UK  {msg}", flush=True)


class Api:
    """The three calls this needs. Swapped for a fake in tests."""

    def __init__(self, token: str):
        self.token = token

    def _req(self, method, url, body=None, auth=True):
        h = {"Accept": "application/vnd.github+json", "User-Agent": "ops-morning-kick",
             "X-GitHub-Api-Version": "2022-11-28"}
        if auth:
            h["Authorization"] = f"Bearer {self.token}"
        data = json.dumps(body).encode() if body is not None else None
        if data:
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})

    def runs(self, wf: str) -> list[dict]:
        _, d = self._req("GET", f"https://api.github.com/repos/{ETL}/actions/workflows/{wf}/runs?per_page=10")
        return d.get("workflow_runs") or []

    def dispatch(self, wf: str) -> int:
        st, _ = self._req("POST", f"https://api.github.com/repos/{ETL}/actions/workflows/{wf}/dispatches",
                          {"ref": "main"})
        return st

    def latest(self) -> str | None:
        _, d = self._req("GET", f"{INDEX_URL}?cb={int(time.time())}", auth=False)
        return d.get("latest")


def uk_date_of(iso: str) -> str:
    return dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(UK).date().isoformat()


def ran_today(runs: list[dict], today: str) -> bool:
    return any(uk_date_of(r.get("created_at", "1970-01-01T00:00:00Z")) == today for r in runs)


def active(runs: list[dict]) -> bool:
    return any(r.get("status") in ACTIVE for r in runs)


def minutes_since_finish(runs: list[dict], now: dt.datetime) -> float | None:
    """Minutes since the newest COMPLETED run last changed (≈ finished)."""
    done = [r for r in runs if r.get("status") == "completed" and r.get("updated_at")]
    if not done:
        return None
    t = max(dt.datetime.fromisoformat(r["updated_at"].replace("Z", "+00:00")) for r in done)
    return (now - t).total_seconds() / 60


def ntfy(title: str, msg: str) -> None:
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if not topic:
        log("NTFY_TOPIC not set on MakiManc/ops - the red run and GitHub's failure email are the alert")
        return
    subprocess.run(["curl", "-fsS", "-m", "15", "--retry", "3", "-H", f"Title: {title}",
                    "-H", "Priority: high", "-H", "Tags: hourglass", "-d", msg,
                    f"https://ntfy.sh/{topic}"], check=False)


def main(api=None, now=lambda: dt.datetime.now(UK), sleep=time.sleep) -> int:
    if api is None:
        tok = os.environ.get("ETL_DISPATCH_TOKEN", "").strip()
        if not tok:
            print("::error title=ETL_DISPATCH_TOKEN missing::The morning kick cannot start the "
                  "private pipeline without ETL_DISPATCH_TOKEN on MakiManc/ops (a fine-grained PAT, "
                  "maki-hospitality-etl only, Actions: read and write). See builders/morning_kick.py.")
            return 2
        api = Api(tok)
    today = now().date().isoformat()
    run_url = (f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/"
               f"{os.environ.get('GITHUB_REPOSITORY', 'MakiManc/ops')}/actions/runs/"
               f"{os.environ.get('GITHUB_RUN_ID', '')}")
    try:
        if api.latest() == today:
            log(f"snapshot_index.latest is already {today} - nothing to do")
            return 0
        deep = api.runs(DEEP_WF)
        if not ran_today(deep, today):
            st = api.dispatch(DEEP_WF)
            log(f"no Flow deep pull today yet - dispatched {DEEP_WF} (HTTP {st})")
        else:
            log("Flow deep pull already ran today")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            print(f"::error title=ETL_DISPATCH_TOKEN rejected::GitHub answered {e.code}: the token "
                  "has expired, been revoked, or lacks Actions: read and write on "
                  "maki-hospitality-etl. Regenerate it - see builders/morning_kick.py.")
            ntfy("Morning kick: ETL_DISPATCH_TOKEN rejected",
                 f"GitHub refused the token ({e.code}), so the export will start late "
                 f"(GitHub's own cron) and the dashboard will miss 10:00. {run_url}")
            return 2
        raise

    start = dt.datetime.combine(now().date(), EXPORT_AT, tzinfo=UK)
    deadline = dt.datetime.combine(now().date(), DEADLINE, tzinfo=UK)
    if now() < start:
        wait = (start - now()).total_seconds()
        log(f"waiting {wait / 60:.0f} min until {EXPORT_AT:%H:%M} UK for the Kobas emails")
        sleep(wait)

    dispatched, last = 0, None
    while True:
        latest = None
        try:
            latest = api.latest()
        except Exception as e:  # noqa: BLE001 - raw blip: keep going
            log(f"could not read snapshot_index.json ({type(e).__name__}) - retrying")
        if latest == today:
            log(f"READY: snapshot_index.latest = {today}")
            return 0
        if now() >= deadline:
            break
        try:
            ex_runs = api.runs(EXPORT_WF)
            fin = minutes_since_finish(ex_runs, now())
            busy = (active(ex_runs) or active(api.runs(BAKE_WF))
                    or (fin is not None and fin < GRACE_MIN))
        except Exception as e:  # noqa: BLE001
            log(f"could not list runs ({type(e).__name__}) - retrying")
            busy = True
        due = last is None or (now() - last).total_seconds() >= RETRY_MIN * 60
        if not busy and due and dispatched < MAX_DISPATCHES:
            try:
                st = api.dispatch(EXPORT_WF)
                dispatched, last = dispatched + 1, now()
                log(f"dispatched {EXPORT_WF} ({dispatched}/{MAX_DISPATCHES}, HTTP {st}); "
                    f"latest is {latest}")
            except Exception as e:  # noqa: BLE001
                log(f"dispatch failed ({type(e).__name__}) - will retry")
        else:
            log(f"latest {latest}; {'export or bake running' if busy else 'waiting'} "
                f"({dispatched} dispatch(es) so far)")
        sleep(POLL_S)

    msg = (f"Ops Command is NOT ready at {DEADLINE:%H:%M} UK: snapshot_index.latest is still "
           f"{latest or 'unreadable'}, after {dispatched} export dispatch(es). Check the Daily "
           f"Hospitality Export and Ops Command bake runs in maki-hospitality-etl. {run_url}")
    print(f"::error title=Dashboard not ready by 10:00::{msg}")
    ntfy("Ops Command not ready by 10:00", msg)
    return 1


if __name__ == "__main__":
    sys.exit(main())
