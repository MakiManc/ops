#!/usr/bin/env python3
"""The October 2026 minutes budget: the Flow deep pull on Mondays only (11/10/2026).

Ross, 11/10/2026: the private repo's 2,000 Actions minutes run out around
26/10 at the daily rate, so until DEEP_PULL_WEEKLY_UNTIL the deep pull runs on
Mondays only and then goes back to daily by itself. This pins that the
verifier neither cries wolf on the days off nor goes quiet when a pull is
genuinely due, and that the bake says the training figures are older:

  * no receipt on a day off is ok; on a Monday it is the usual critical
  * a failed Monday is due again every day until a clean pull lands
  * the Deep Flow feeds carry a 7-day cadence until the date, 1 day after
  * from 1 Nov everything is daily again, with nothing to revert
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
check(vod.deep_pull_due("2026-10-14", None) is True, "no clean receipt at all: due")
check(vod.deep_pull_due("2026-11-03", "2026-11-02") is True, "from 1 Nov: daily again, nothing to revert")
check(bake.DEEP_PULL_WEEKLY_UNTIL == vod.DEEP_PULL_WEEKLY_UNTIL == "2026-11-01",
      "the bake and the verifier carry the same end date")

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
    ("Tue 03/11, back to daily", "2026-11-03", ["2026-11-02"],
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
            check("Mondays only until 2026-11-01" in det and "2026-10-12" in det,
                  f"[{label}] ...and says why, naming the last clean pull")
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
    p = subprocess.run([sys.executable, os.path.join(REPO, "builders", "bake_ops_command.py")],
                       env=env, capture_output=True, text=True)
    check(p.returncode == 0, "the real bake runs on the synthetic archive"
          + ("" if p.returncode == 0 else ": " + p.stderr[-600:]))
    if p.returncode == 0:
        sn = json.load(open(os.path.join(out, "snapshot_2026-10-14.json")))
        g = [x for x in sn["gaps"] if "Deep Flow feeds" in x]
        check(len(g) == 1 and "deep pull of 2026-10-12" in g[0] and "Mondays only" in g[0],
              "BAKED 14/10: a gap says the per-module training figures are from the 12/10 deep pull")
finally:
    shutil.rmtree(tmp)

print(f"\n{'FAILED' if failures else 'passed'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
