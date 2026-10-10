#!/usr/bin/env python3
"""A back-bake sees the archive exactly as it stood on its own date (09/10/2026).

`bake_ops_command.py --date D` used to name the output file and do nothing
else: every "newest pull of this feed" query, the feed-health ages, the current
Mon-Sun week, the Facilities age and the trend history all came from TODAY. So
back-baking 2 October on the 9th - which is what recovering the 02/10-08/10 gap
left by the dead OPS_REPO_TOKEN needs - would have written a file called
snapshot_2026-10-02.json full of 9 October's data. Nothing would have failed;
the month picker would just have shown the wrong numbers under the right date.

This runs the REAL builder over a hand-built archive with pulls on both sides
of the bake date and pins what a dated bake may and may not see. Synthetic and
tiny on purpose: it must run in seconds with no network and no warehouse.

  python3 tests/backbake_asof_test.py      (exit 1 on any failure)
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
BUILDER = os.path.join(REPO, "builders", "bake_ops_command.py")
sys.path.insert(0, os.path.join(REPO, "builders"))
import archive_source  # noqa: E402

PRICE_FEED = "Kobas Report - Weekly Ingredient Price Changes Report"
PRICE_SLUG = "Kobas_Report_Weekly_Ingredient_Price_Changes_Report"

failures = 0


def check(cond, msg):
    global failures
    print(("ok  : " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


def change(pid, name, old, new):
    return {"Parent ID": pid, "Ingredient Name": name, "Pack Size": 1.0,
            "Unit Volume": 1000, "Measurement": "Grams",
            "Old Price": old, "New Price": new}


# Two weekly reports: one pulled before the bake date, one after it. The second
# carries a distinctive ingredient so its presence anywhere is easy to spot.
PULLS = {
    "2026-01-05": [change(1, "EARLY WIDGET", "1.00", "1.10")],
    "2026-01-12": [change(2, "LATE GADGET FROM THE FUTURE", "1.00", "9.00")],
}


def write_archive(root):
    for pull_date, rows in PULLS.items():
        d = os.path.join(root, pull_date)
        os.makedirs(d, exist_ok=True)
        with gzip.open(os.path.join(d, PRICE_SLUG + ".jsonl.gz"), "wt") as fh:
            for i, r in enumerate(rows):
                fh.write(json.dumps({"row_num": i, "data": r}) + "\n")
        with open(os.path.join(d, "_feeds.json"), "w") as fh:
            json.dump({PRICE_SLUG: PRICE_FEED}, fh)


def bake(archive, out, date=None):
    env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=archive,
               OPS_OUT_DIR=out)
    args = [sys.executable, BUILDER] + (["--date", date] if date else [])
    p = subprocess.run(args, env=env, capture_output=True, text=True)
    if p.returncode != 0:
        print("builder failed:\n", p.stdout[-3000:], p.stderr[-3000:])
    return p


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="asof-")
    archive = os.path.join(tmp, "warehouse_direct")
    write_archive(archive)

    print("-- archive_source.resolve_files --")
    files, _ = archive_source.resolve_files(archive)
    check(len(files) == 2, f"undated: both pulls are read (got {len(files)})")
    files, _ = archive_source.resolve_files(archive, "2026-01-08")
    check(len(files) == 1 and "2026-01-05" in files[0],
          f"as of 01-08: only the 01-05 pull is read (got {[os.path.basename(os.path.dirname(f)) for f in files]})")
    files, _ = archive_source.resolve_files(archive, "2026-01-12")
    check(len(files) == 2, "the bake date's own pull is included (on or before, not before)")

    out = os.path.join(tmp, "out")
    os.makedirs(out)
    shutil.copy(os.path.join(REPO, "data", "ops_command", "feeds_manifest.json"), out)
    # an index that already has a NEWER date - the back-bake must not become latest
    json.dump({"latest": "2026-01-12", "dates": ["2026-01-12"]},
              open(os.path.join(out, "snapshot_index.json"), "w"))
    # trend history: one row the verifier recorded before the bake date, one
    # after - keyed on when it was RECORDED (updated_at), not its metric_date
    with open(os.path.join(out, "ops_daily_aggregates.jsonl"), "w") as fh:
        for d, upd in (("2026-01-06", "2026-01-07T09:00:00Z"), ("2026-01-07", "2026-01-11T09:00:00Z")):
            fh.write(json.dumps({"metric_date": d, "site": "Maki Test", "metric": "tasks",
                                 "v1": 1, "v2": 0, "v3": None, "updated_at": upd}) + "\n")
    # the Facilities pull record from a pull made AFTER the bake date, and a
    # bake-pulled copy from before it beside a push made after it
    json.dump({"attempted_at": "2026-01-12T08:00:00Z", "ok": False, "cause": "timeout",
               "detail": "fixture", "http_status": None},
              open(os.path.join(out, "facilities_pull_status.json"), "w"))
    _fac = json.load(open(os.path.join(REPO, "tests", "fixtures", "facilities_ppm.json")))
    json.dump(dict(_fac, pulled_at="2026-01-07T08:00:00Z"),
              open(os.path.join(out, "facilities_ppm.json"), "w"))
    json.dump(dict(_fac, pulled_at="2026-01-12T06:30:00Z", pulled_by="pythonanywhere"),
              open(os.path.join(out, "facilities_ppm_pushed.json"), "w"))
    # side files pulled AFTER the bake date (they are current-state only)
    json.dump({"pulled_at": "2026-01-12T08:00:00Z", "source_as_of": "2026-01-12",
               "source": "fixture sheet", "tasks": [{"site": "Maki Test",
               "status": "ongoing"}]}, open(os.path.join(out, "maintenance_source.json"), "w"))

    print("\n-- a dated bake, 2026-01-08 --")
    p = bake(archive, out, "2026-01-08")
    check(p.returncode == 0, "the dated bake succeeds")
    if p.returncode != 0:
        return 1
    snap = json.load(open(os.path.join(out, "snapshot_2026-01-08.json")))
    blob = json.dumps(snap)
    check("LATE GADGET FROM THE FUTURE" not in blob,
          "nothing from the 01-12 pull appears anywhere in the 01-08 snapshot")
    # Later dates may appear only where they are NOT data: the end of the
    # current Mon-Sun week (a calendar fact as of 01-08), the trend's week
    # labels, and the sentence saying the maintenance sheet was pulled later.
    late = []

    def _walk(x, path):
        if isinstance(x, dict):
            for k, v in x.items():
                _walk(v, path + "/" + k)
        elif isinstance(x, list):
            for v in x:
                _walk(v, path + "[]")
        elif isinstance(x, str) and ("2026-01-12" in x or "2026-01-11" in x):
            late.append(path)
    _walk(snap, "")
    allowed = {"/supply/week_end", "/maintenance/gaps[]"}
    stray = sorted(set(late) - allowed)
    check(not stray, f"no data dated after 01-08 appears in it (stray: {stray[:6]})")
    fh_ = {f["feed"]: f for f in snap["feed_health"]}
    pr = fh_.get(PRICE_FEED) or {}
    check(pr.get("latest_pull") == "2026-01-05",
          f"feed health: the price feed's newest pull is 01-05 as of 01-08 (got {pr.get('latest_pull')})")
    check(pr.get("age_days") == 3,
          f"and its age is measured from 01-08, not from today (got {pr.get('age_days')})")
    check((snap["supply"]["week_start"], snap["supply"]["week_end"]) == ("2026-01-05", "2026-01-11"),
          f"the 'current week' is the Mon-Sun week of 01-08 (got "
          f"{snap['supply']['week_start']}..{snap['supply']['week_end']})")
    m = snap["maintenance"]
    check(not m["tasks"] and any("after this snapshot's date" in g for g in m["gaps"]),
          "a maintenance sheet pulled after the date is not shown, and the tab says why")
    fac = m.get("facilities") or {}
    check(fac.get("file", "").endswith("facilities_ppm.json") and fac.get("status") == "ok",
          f"Facilities: the copy pulled BEFORE the date is used, not the push made after it "
          f"(got {fac.get('file')}, {fac.get('status')})")
    check(fac.get("pull") is None and not fac.get("pull_note"),
          "Facilities: a pull attempt recorded after the date is not quoted as today's reason")
    idx = json.load(open(os.path.join(out, "snapshot_index.json")))
    check(idx["latest"] == "2026-01-12" and idx["dates"] == ["2026-01-12", "2026-01-08"],
          f"the back-bake is recorded but does not become latest (got {idx['latest']}, {idx['dates']})")

    print("\n-- an undated bake is unchanged --")
    os.remove(os.path.join(out, "maintenance_source.json"))
    p = bake(archive, out)
    check(p.returncode == 0, "the undated bake succeeds")
    snap = json.load(open(os.path.join(out, "snapshot_2026-01-12.json")))
    fh_ = {f["feed"]: f for f in snap["feed_health"]}
    check((fh_.get(PRICE_FEED) or {}).get("latest_pull") == "2026-01-12",
          "undated: the newest pull is read as before")

    print("\n-- --date is validated --")
    for bad in ("08/01/2026", "20260108", "2026-W02-4", "2026-1-8"):
        p = bake(archive, out, bad)
        check(p.returncode != 0 and "YYYY-MM-DD" in (p.stderr + p.stdout),
              f"--date {bad!r} is refused - it would skip the archive cut and sort above every real date")
    idx = json.load(open(os.path.join(out, "snapshot_index.json")))
    check(all(len(d) == 10 and d[4] == "-" for d in idx["dates"]), "and nothing odd reached the index")

    shutil.rmtree(tmp, ignore_errors=True)
    print()
    if failures:
        print(f"{failures} assertion(s) FAILED")
        return 1
    print("all assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
