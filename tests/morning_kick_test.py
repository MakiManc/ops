#!/usr/bin/env python3
"""The morning kick: Ops Command ready by 10:00 UK (Ross, 09/10/2026).

builders/morning_kick.py is the external clock for the private pipeline: it
dispatches the deep pull if it has not run, waits until 08:12 UK, dispatches
the export, retries if today's snapshot has not landed, and fails loudly at
09:55. Everything here runs against a fake GitHub and a fake clock - no
network, no token, no waiting.

  python3 tests/morning_kick_test.py      (exit 1 on any failure)
"""
from __future__ import annotations

import contextlib
import datetime as dt
import io
import os
import sys
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "builders"))
import morning_kick as K  # noqa: E402

UK = K.UK
failures = 0


def check(cond, msg):
    global failures
    print(("ok  : " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


class Clock:
    def __init__(self, start):
        self.t = start

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += dt.timedelta(seconds=s)


class FakeGH:
    """A pipeline: a dispatched export runs for `export_min`, then the bake for
    2 min, after which `latest` becomes today - unless `ready_after_attempt`
    says the Kobas reports were not there yet for the first attempts."""

    def __init__(self, clock, today, latest_start, deep_today=False, export_min=30,
                 ready_after_attempt=1, reject=None, never=False):
        self.c, self.today, self.latest_v = clock, today, latest_start
        self.deep_today, self.export_min = deep_today, export_min
        self.ready_after_attempt, self.reject, self.never = ready_after_attempt, reject, never
        self.dispatches = []          # (workflow, uk time)
        self.export_started = None
        self.attempts = 0

    def _err(self):
        raise urllib.error.HTTPError("x", self.reject, "no", {}, None)

    def latest(self):
        if self.reject:
            self._err()
        if (self.export_started and not self.never and self.attempts >= self.ready_after_attempt
                and self.c.now() >= self.export_started + dt.timedelta(minutes=self.export_min + 2)):
            self.latest_v = self.today
        return self.latest_v

    def runs(self, wf):
        if self.reject:
            self._err()
        if wf == K.DEEP_WF:
            return [{"created_at": f"{self.today}T05:50:00Z", "status": "completed"}] if self.deep_today else []
        if wf == K.EXPORT_WF and self.export_started:
            end = self.export_started + dt.timedelta(minutes=self.export_min)
            running = self.c.now() < end
            return [{"created_at": self.export_started.astimezone(dt.timezone.utc).isoformat(),
                     "status": "in_progress" if running else "completed",
                     "updated_at": (self.c.now() if running else end).astimezone(dt.timezone.utc).isoformat()}]
        return []

    def dispatch(self, wf):
        self.dispatches.append((wf, self.c.now().strftime("%H:%M")))
        if wf == K.EXPORT_WF:
            self.export_started = self.c.now()
            self.attempts += 1
            # gate 3 said "not yet": the run ends in a minute with nothing written
            if self.attempts < self.ready_after_attempt:
                self.export_min = 1
            else:
                self.export_min = 30
        return 204


def run(gh, clock):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = K.main(api=gh, now=clock.now, sleep=clock.sleep)
    return rc, out.getvalue()


print("-- a normal summer morning --")
c = Clock(dt.datetime(2026, 10, 12, 7, 31, tzinfo=UK))      # cron landed 26 min late
gh = FakeGH(c, "2026-10-12", "2026-10-11")
rc, out = run(gh, c)
ex = [t for w, t in gh.dispatches if w == K.EXPORT_WF]
check(rc == 0 and "READY" in out, f"exit 0, READY (got {rc})")
check((K.DEEP_WF, "07:31") in gh.dispatches, "the deep pull had not run, so it is dispatched at once")
check(ex == ["08:12"], f"the export is dispatched once, at 08:12 UK (got {ex})")
check(c.now().time() < dt.time(10, 0), f"and the dashboard is ready before 10:00 (at {c.now():%H:%M})")

print("\n-- winter: the same UK times --")
c = Clock(dt.datetime(2026, 11, 10, 6, 40, tzinfo=UK))
gh = FakeGH(c, "2026-11-10", "2026-11-09", deep_today=True)
rc, out = run(gh, c)
check(rc == 0 and [t for w, t in gh.dispatches if w == K.EXPORT_WF] == ["08:12"]
      and K.DEEP_WF not in [w for w, _ in gh.dispatches],
      "GMT: deep pull already ran (not re-dispatched); export at 08:12 UK, not 08:12 UTC+1")

print("\n-- the Kobas reports are late --")
c = Clock(dt.datetime(2026, 10, 12, 7, 31, tzinfo=UK))
gh = FakeGH(c, "2026-10-12", "2026-10-11", deep_today=True, ready_after_attempt=2)
rc, out = run(gh, c)
ex = [t for w, t in gh.dispatches if w == K.EXPORT_WF]
check(rc == 0 and len(ex) == 2, f"gate 3 said 'not yet': dispatched again, ready on the second (got {ex})")
gap = (dt.datetime.strptime(ex[1], "%H:%M") - dt.datetime.strptime(ex[0], "%H:%M")).seconds / 60 if len(ex) == 2 else 0
check(gap >= K.RETRY_MIN, f"no sooner than {K.RETRY_MIN} min apart (got {gap:.0f})")

print("\n-- never lands --")
c = Clock(dt.datetime(2026, 10, 12, 7, 31, tzinfo=UK))
gh = FakeGH(c, "2026-10-12", "2026-10-11", deep_today=True, never=True)
rc, out = run(gh, c)
ex = [t for w, t in gh.dispatches if w == K.EXPORT_WF]
check(rc == 1 and "::error title=Dashboard not ready by 10:00::" in out,
      "still not ready at 09:55: exit 1 with an annotation")
check(len(ex) <= K.MAX_DISPATCHES, f"and never more than {K.MAX_DISPATCHES} dispatches (got {len(ex)})")
check(c.now().time() < dt.time(10, 0), "it gives up before 10:00, so the alert is on time")

print("\n-- already done --")
c = Clock(dt.datetime(2026, 10, 12, 7, 31, tzinfo=UK))
gh = FakeGH(c, "2026-10-12", "2026-10-12")
rc, out = run(gh, c)
check(rc == 0 and gh.dispatches == [], "today's snapshot already landed: nothing dispatched")

print("\n-- the token --")
c = Clock(dt.datetime(2026, 10, 12, 7, 31, tzinfo=UK))
gh = FakeGH(c, "2026-10-12", "2026-10-11", reject=401)
rc, out = run(gh, c)
check(rc == 2 and "ETL_DISPATCH_TOKEN rejected" in out, "a 401: exit 2, naming the secret")
old = os.environ.pop("ETL_DISPATCH_TOKEN", None)
out = io.StringIO()
with contextlib.redirect_stdout(out):
    rc = K.main()
if old is not None:
    os.environ["ETL_DISPATCH_TOKEN"] = old
check(rc == 2 and "ETL_DISPATCH_TOKEN missing" in out.getvalue(), "no secret: exit 2 at once, naming it")

print()
if failures:
    print(f"{failures} assertion(s) FAILED")
    sys.exit(1)
print("all assertions passed")
