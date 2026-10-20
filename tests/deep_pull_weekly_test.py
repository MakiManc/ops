#!/usr/bin/env python3
"""The Flow deep pull on Mondays only, from 11/10/2026 - for good.

Ross, 11/10/2026: the private repo's 2,000 Actions minutes ran out around
26/10 at the daily rate, so the deep pull went to Mondays only until 1 Nov.
Ross, 20/10/2026, verbatim: "2,000 is the limit" and "Weekly deep pull yes" -
so it stays weekly, with no end date. This pins that the verifier neither
cries wolf on the days off nor goes quiet when a pull is genuinely due, and
that the bake says the training figures are older:

  * no receipt on a day off is ok; on a Monday it is the usual critical
  * a failed Monday is due again from the next day until a clean pull lands
  * the Deep Flow feeds carry a 7-day cadence from DEEP_PULL_WEEKLY_FROM, 1 day before
  * November is still weekly - nothing goes back to daily on 1 Nov
  * the 12:03 recheck, which the October budget also switched off, still
    comes back on 1 Nov: Ross kept only the deep pull weekly
  * the bake names the deep pull's date in a gap while it lags the pull

Runs the real check functions against a tiny synthetic archive.

  python3 tests/deep_pull_weekly_test.py      (exit 1 on any failure)
"""
from __future__ import annotations

import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "builders"))
import archive_source  # noqa: E402
import bake_ops_command as bake  # noqa: E402
import verify_ops_data as vod  # noqa: E402
import morning_kick as kick  # noqa: E402

failures = 0


def check(cond, msg):
    global failures
    print(("ok  : " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


DEEP, DEEP_SLUG = "Deep Flow Modules", "Deep_Flow_Modules"
DAILY, DAILY_SLUG = "Flow Trainees", "Flow_Trainees"
MANIFEST = {"version": 1, "feeds": [
    {"name": DEEP, "workflow": "deep-pull", "cadence_days": 1, "min_rows": 1, "status": "expected"},
    {"name": DAILY, "workflow": "daily-export", "cadence_days": 1, "min_rows": 1, "status": "expected"},
]}


def receipt(kind, day, ok=True):
    return {"run_kind": kind, "started_at": f"{day}T01:10:00", "finished_at": f"{day}T01:40:00",
            "pull_date": day, "github_run_id": "1", "feeds_attempted": 5,
            "feeds_ok": 5 if ok else 4, "feeds_failed": 0 if ok else 1,
            "rows_written": 100, "exit_code": 0 if ok else 1, "failures": []}


def build(root, deep_days, daily_days, receipts):
    arc = os.path.join(root, "arc")
    for slug, name, days in ((DEEP_SLUG, DEEP, deep_days), (DAILY_SLUG, DAILY, daily_days)):
        for d in days:
            p = os.path.join(arc, d)
            os.makedirs(p, exist_ok=True)
            with gzip.open(os.path.join(p, slug + ".jsonl.gz"), "wt") as fh:
                for i in range(3):
                    fh.write(json.dumps({"row_num": i, "data": {"x": i, "trainee_id": str(i)}}) + "\n")
            fp = os.path.join(p, "_feeds.json")
            fm = json.load(open(fp)) if os.path.exists(fp) else {}
            fm[slug] = name
            json.dump(fm, open(fp, "w"))
    rl = os.path.join(root, "etl_run_log.jsonl")
    with open(rl, "w") as fh:
        for r in receipts:
            fh.write(json.dumps(r) + "\n")
    mp = os.path.join(root, "feeds_manifest.json")
    json.dump(MANIFEST, open(mp, "w"))
    return arc, rl, mp


def run_checks(root, today, deep_days, daily_days, receipts):
    arc, rl, mp = build(root, deep_days, daily_days, receipts)
    conn = archive_source.connect(arc, manifest=mp, run_log=rl)
    vod.RESULTS.clear()
    with conn.cursor() as cur:
        states = vod.check_receipts(cur, today)
        vod.check_feeds(cur, MANIFEST, today, states)
    conn.close()
    out = {}
    for r in vod.RESULTS:
        out.setdefault((r["check"], r.get("feed")), []).append((r["level"], r["detail"]))
    return out


def lvl(res, check_, feed):
    return [x[0] for x in res.get((check_, feed), [])]


# ---- the date rule on its own ---------------------------------------------
check(vod.deep_pull_due("2026-10-12", "2026-10-05") is True, "Monday 12/10: due")
check(vod.deep_pull_due("2026-10-14", "2026-10-12") is False, "Wednesday after a clean Monday: not due")
check(vod.deep_pull_due("2026-10-20", "2026-10-12") is True,
      "Tuesday after a FAILED Monday (newest clean 8 days old): due again")
check(vod.deep_pull_due("2026-10-13", "2026-10-10") is True,
      "REVIEW: week 1 - Tuesday after a failed Monday 12/10 (newest clean Sat 10/10): due the next day, not a week later")
check(vod.deep_pull_due("2026-10-11", "2026-10-10") is False,
      "Sunday 11/10 (the budget's first day), newest clean Saturday: not due")
check(vod.deep_pull_due("2026-10-18", "2026-10-12") is False, "Sunday after a clean Monday: not due")
_days = ([f"2026-10-{d:02d}" for d in range(5, 32)] + [f"2026-11-{d:02d}" for d in range(1, 31)]
         + [f"2026-12-{d:02d}" for d in range(1, 8)])
check(all(bake.deep_pull_due(t, l) == vod.deep_pull_due(t, l)
          for t in _days for l in [None] + _days if not l or l <= t),
      "the bake's deep_pull_due agrees with the verifier's on every day 05/10-07/12 and last-pull date")
check(vod.deep_pull_due("2026-10-14", None) is True, "no clean receipt at all: due")
check(vod.deep_pull_due("2026-10-08", "2026-10-07") is True, "before 11/10 (daily then): due every day")
check(vod.deep_pull_due("2026-11-04", "2026-11-02") is False,
      "Wednesday 04/11 after a clean Monday: NOT due - still weekly after 1 Nov")
check(vod.deep_pull_due("2026-11-09", "2026-11-02") is True, "Monday 09/11: due")
check(vod.deep_pull_due("2026-11-10", "2026-11-02") is True, "Tuesday 10/11 after a failed Monday: due again")
check(vod.deep_pull_due("2026-12-02", "2026-11-30") is False, "and in December: Wednesday after a clean Monday, not due")
check(bake.DEEP_PULL_WEEKLY_FROM == vod.DEEP_PULL_WEEKLY_FROM == kick.DEEP_PULL_WEEKLY_FROM == "2026-10-11",
      "the bake, the verifier and the morning kick carry the same start date")
check(not any(hasattr(m, "DEEP_PULL_WEEKLY_UNTIL") for m in (bake, vod, kick)),
      "...and none of them carries an end date any more")
check(vod.RECHECK_OFF_UNTIL == "2026-11-01",
      "the 12:03 recheck still comes back on 1 Nov - decoupled from the deep pull")

# ---- the verifier on a synthetic archive -----------------------------------
for label, today, deep_days, receipts, want_rc, want_land in (
    ("Wed 14/10, Monday clean", "2026-10-14", ["2026-10-12"],
     [receipt("deep-pull", "2026-10-12")], "ok", "ok"),
    # a Monday is a pull day: the 12/10 copy is 7 days old, so it is due today
    ("Mon 19/10, no pull yet", "2026-10-19", ["2026-10-12"],
     [receipt("deep-pull", "2026-10-12")], "critical", "warning"),
    ("Tue 20/10, Monday failed", "2026-10-20", ["2026-10-12"],
     [receipt("deep-pull", "2026-10-12"), receipt("deep-pull", "2026-10-19", ok=False)],
     "critical", "warning"),
    ("Wed 04/11, still weekly", "2026-11-04", ["2026-11-02"],
     [receipt("deep-pull", "2026-11-02")], "ok", "ok"),
    ("Mon 09/11, no pull yet", "2026-11-09", ["2026-11-02"],
     [receipt("deep-pull", "2026-11-02")], "critical", "warning"),
):
    tmp = tempfile.mkdtemp(prefix="deepweekly_")
    try:
        res = run_checks(tmp, today, deep_days, [today], receipts + [receipt("daily-export", today)])
        rc = lvl(res, "0-receipts", "deep-pull")
        land = lvl(res, "1-landed", DEEP)
        check(want_rc in rc, f"[{label}] deep-pull receipt check is {want_rc} (got {rc})")
        check(want_land in land, f"[{label}] Deep Flow Modules landing check is {want_land} (got {land})")
        if want_rc == "ok":
            det = res[("0-receipts", "deep-pull")][0][1]
            check("Mondays only" in det and deep_days[-1] in det and "until" not in det,
                  f"[{label}] ...and says why, naming the last clean pull and no end date")
            rows = lvl(res, "2-rows", DEEP)
            check(rows == ["ok"], f"[{label}] no rows today is inside the 7-day cadence, not 'below floor'")
        check("ok" in lvl(res, "1-landed", DAILY),
              f"[{label}] a daily feed is still held to its daily cadence")
    finally:
        shutil.rmtree(tmp)

# ---- the bake names the deep pull's date while it lags ----------------------
tmp = tempfile.mkdtemp(prefix="deepweekly_bake_")
try:
    arc, rl, mp = build(tmp, ["2026-10-12"], ["2026-10-12", "2026-10-14"], [])
    out = os.path.join(tmp, "out")
    os.makedirs(out)
    env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=arc, OPS_OUT_DIR=out)
    # dated, so ages are measured from 14/10 and not from the wall clock
    p = subprocess.run([sys.executable, os.path.join(REPO, "builders", "bake_ops_command.py"),
                        "--date", "2026-10-14"], env=env, capture_output=True, text=True)
    check(p.returncode == 0, "the real bake runs on the synthetic archive"
          + ("" if p.returncode == 0 else ": " + p.stderr[-600:]))
    if p.returncode == 0:
        sn = json.load(open(os.path.join(out, "snapshot_2026-10-14.json")))
        g = [x for x in sn["gaps"] if "Deep Flow feeds" in x]
        check(len(g) == 1 and "deep pull of 2026-10-12" in g[0] and "Mondays only" in g[0],
              "BAKED 14/10: a gap says the per-module training figures are from the 12/10 deep pull")
        fhd = next((r for r in sn["feed_health"] if r["feed"] == DEEP), {})
        check(fhd.get("verdict") == "OK" and fhd.get("age_days") == 2,
              f"BAKED 14/10: the Data Health tab shows the 2-day-old weekly deep feed as OK, not WATCH (got {fhd.get('verdict')})")
finally:
    shutil.rmtree(tmp)

# ---- November: still weekly ---------------------------------------------------
tmp = tempfile.mkdtemp(prefix="deepweekly_bake_nov_")
try:
    arc, rl, mp = build(tmp, ["2026-11-02"], ["2026-11-02", "2026-11-04"], [])
    out = os.path.join(tmp, "out")
    os.makedirs(out)
    env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=arc, OPS_OUT_DIR=out)
    p = subprocess.run([sys.executable, os.path.join(REPO, "builders", "bake_ops_command.py"),
                        "--date", "2026-11-04"], env=env, capture_output=True, text=True)
    check(p.returncode == 0, "the real bake runs on a November archive"
          + ("" if p.returncode == 0 else ": " + p.stderr[-600:]))
    if p.returncode == 0:
        sn = json.load(open(os.path.join(out, "snapshot_2026-11-04.json")))
        g = [x for x in sn["gaps"] if "Deep Flow feeds" in x]
        check(len(g) == 1 and "deep pull of 2026-11-02" in g[0] and "Mondays only" in g[0]
              and "2,000" in g[0] and "back to daily" not in g[0],
              "BAKED 04/11: the gap says Mondays only, for the 2,000-minute limit, with no 'back to daily'")
        fhd = next((r for r in sn["feed_health"] if r["feed"] == DEEP), {})
        check(fhd.get("verdict") == "OK" and fhd.get("age_days") == 2,
              f"BAKED 04/11: the 2-day-old weekly deep feed is OK, not WATCH (got {fhd.get('verdict')})")
finally:
    shutil.rmtree(tmp)

# ---- REVIEW: a lag that is NOT the budget's doing is not blamed on it --------
tmp = tempfile.mkdtemp(prefix="deepweekly_bake2_")
try:
    # Tuesday 13/10, the Monday pull failed: the newest deep pull is Saturday's
    arc, rl, mp = build(tmp, ["2026-10-10"], ["2026-10-10", "2026-10-13"], [])
    out = os.path.join(tmp, "out")
    os.makedirs(out)
    env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=arc, OPS_OUT_DIR=out)
    p = subprocess.run([sys.executable, os.path.join(REPO, "builders", "bake_ops_command.py"),
                        "--date", "2026-10-13"], env=env, capture_output=True, text=True)
    if p.returncode == 0:
        sn = json.load(open(os.path.join(out, "snapshot_2026-10-13.json")))
        g = [x for x in sn["gaps"] if "Deep Flow feeds" in x]
        check(len(g) == 1 and "is DUE" in g[0] and "not the Mondays-only cadence" in g[0],
              "BAKED 13/10 after a failed Monday: the gap says the pull is due, not 'Mondays only'")
    else:
        check(False, "the real bake runs (failed Monday case): " + p.stderr[-400:])
finally:
    shutil.rmtree(tmp)

print(f"\n{'FAILED' if failures else 'passed'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
