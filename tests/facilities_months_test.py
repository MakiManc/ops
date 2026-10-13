#!/usr/bin/env python3
"""OO2 KR1 and KR4 by month, and grease traps out of KR4 (Phase 4.1, 12/10/2026).

WHY THIS TEST EXISTS
  Ross, 12/10/2026: a CLOSED month's OO2 KR1 and KR4 figure is "the last
  reading of the month" - the Facilities app as read on the month's last day;
  if nothing was read that day the month is grey and says so. The app keeps no
  history, so the bake keeps one (data/ops_command/facilities_readings.jsonl).
  The traps, each a plausible wrong number rather than an error:

    * a reading from the 1st of the next month, or the 29th, standing in for
      the 31st (an item due on the 31st is in date on the 31st and overdue on
      the 1st);
    * a back-bake quoting a reading pulled after its own date, or writing one;
    * a re-baked day appending the same reading twice;
    * grease traps (Ross, 09/10/2026: out of KR4) quietly left in when the
      app's block is malformed, or the app's rounded all-item figure compared
      against the ex-grease one and flagged as drift.

WHAT IT CHECKS
  1. record_facilities_readings / load_facilities_readings directly.
  2. facilities_months: closed months from last-day readings only, grey
     otherwise with the day, the unused reading and the failed pull named.
  3. Grease traps in facilities_block: absent, usable, malformed, all items.
  4. The REAL builder, dated 02/11/2026 over a seeded history: October is
     scored from the 31/10 reading, a line pulled after the bake's date is
     ignored, nothing is written, November is month-to-date and unscored.

Run: python3 tests/facilities_months_test.py   (needs duckdb for part 4)
"""

from __future__ import annotations

import copy
import datetime
import gzip
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BAKE = os.path.join(REPO, "builders", "bake_ops_command.py")
FIXTURE = os.path.join(HERE, "fixtures", "facilities_ppm.json")
MANIFEST = os.path.join(REPO, "data", "ops_command", "feeds_manifest.json")


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        pass
    return mod


bake = _load("bake", BAKE)
failures = 0


def check(cond, msg):
    global failures
    if cond:
        print("ok  :", msg)
    else:
        failures += 1
        print("FAIL:", msg)


with open(FIXTURE, encoding="utf-8") as fh:
    FEED = json.load(fh)
KR1, KR4 = "KR1 PPM on time", "KR4 statutory compliance"
tmpd = tempfile.mkdtemp(prefix="facmonths-")


def feed_at(as_of, pulled_at, **group):
    f = copy.deepcopy(FEED)
    f["as_of"], f["pulled_at"], f["generated_at"] = as_of, pulled_at, pulled_at
    f["group"].update(group)
    return f


def lines(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(x) for x in fh if x.strip()]


# ---- 1. writing and reading the history -------------------------------------
d1 = os.path.join(tmpd, "hist")
os.makedirs(d1)
H = os.path.join(d1, bake.FACILITIES_READINGS_FILE)
f31 = feed_at("2026-10-31", "2026-10-31T18:40:00Z", tasks=208, current=200, due30=4,
              overdue=4, no_evidence=0, kr4_pct=98, kr1_pct=90, kr1_n=10, kr1_ok=9)
n = bake.record_facilities_readings(d1, [(f31, "facilities_ppm.json"), (None, "facilities_ppm_pushed.json")],
                                    None, "2026-10-31")
check(n == 1 and len(lines(H)) == 1, "a live bake records its usable copy once; an absent pushed copy adds nothing")
rec = lines(H)[0]
check(set(rec) == {"as_of", "pulled_at", "pulled_by", "copy", "generated_at", "group", "grease_traps"}
      and set(rec["group"]) == set(bake.FACILITIES_GROUP_COUNTS) | {"kr4_pct", "kr1_pct", "kr1_n", "kr1_ok"},
      "the line holds group counts and KR1's fields only - no site, company or contractor names")
check(not any(k in json.dumps(rec) for k in ("Ikigai", "Ltd", "IDES", "contractor")),
      "nothing from the site or contractor rows reaches the public history")
n = bake.record_facilities_readings(d1, [(f31, "facilities_ppm.json")], None, "2026-10-31")
check(n == 0 and len(lines(H)) == 1, "a re-run of the same day adds no duplicate (same as_of and pulled_at)")
fail = {"attempted_at": "2026-10-31T20:00:00Z", "ok": False, "cause": "timeout", "http_status": None}
check(bake.record_facilities_readings(d1, [], fail, "2026-10-31") == 1, "today's failed pull is recorded")
check(bake.record_facilities_readings(d1, [], fail, "2026-10-31") == 0, "...once")
check(bake.record_facilities_readings(d1, [], dict(fail, attempted_at="2026-10-30T20:00:00Z"),
                                      "2026-10-31") == 0,
      "a failure from another day is not recorded as today's")
later = feed_at("2026-11-01", "2026-11-01T18:40:00Z")
check(bake.record_facilities_readings(d1, [(later, "facilities_ppm.json")], None, "2026-10-31") == 0,
      "a copy pulled after the bake's date is never recorded")
bake.record_facilities_readings(d1, [(later, "facilities_ppm.json")], None, "2026-11-01")
early31 = feed_at("2026-10-31", "2026-10-31T06:30:00Z", current=150)
bake.record_facilities_readings(d1, [(early31, "facilities_ppm_pushed.json")], None, "2026-10-31")
by_day, fails = bake.load_facilities_readings(d1, "2026-10-31")
check(sorted(by_day) == ["2026-10-31"] and by_day["2026-10-31"]["pulled_at"] == "2026-10-31T18:40:00Z",
      "of two readings of the 31st the later pulled wins; the 01/11 one does not exist for a 31/10 bake")
check(fails.get("2026-10-31", {}).get("cause") == "timeout", "the day's failed pull is read back")
by_day, _ = bake.load_facilities_readings(d1, "2026-11-05")
check(sorted(by_day) == ["2026-10-31", "2026-11-01"], "a later bake sees both days")
with open(H, "a", encoding="utf-8") as fh:
    fh.write("not json\n[1,2]\n")
check(sorted(bake.load_facilities_readings(d1, "2026-11-05")[0]) == ["2026-10-31", "2026-11-01"],
      "a broken line is skipped, never fatal")
check(bake.record_facilities_readings(os.path.join(tmpd, "no-such-dir"), [(f31, "x")], None,
                                      "2026-10-31") == 0,
      "an unwritable history costs the line, never the bake")

# ---- 2. the month variants --------------------------------------------------
readings = {"2026-09-25": {"as_of": "2026-09-25", "pulled_at": "2026-09-25T09:47:06Z", "copy": "facilities_ppm.json",
                           "group": {"tasks": 227, "current": 70, "due30": 14, "overdue": 37, "no_evidence": 106,
                                     "kr1_pct": None, "kr1_n": 0, "kr1_ok": 0}, "grease_traps": None},
            "2026-10-30": dict(rec, as_of="2026-10-30", pulled_at="2026-10-30T18:00:00Z"),
            "2026-10-31": rec}
open_kr4 = {"value": 80.0, "display": "80% (160 of 200)", "basis": "today's row.", "source_kind": "facilities_app"}
mv = bake.facilities_months("KR4", open_kr4, readings, {}, "2026-11")
check([v["m"] for v in mv] == ["2026-08", "2026-09", "2026-10", "2026-11"], "months run from August to the pull month")
check(mv[0]["not_measured"] and "first read on 25/09/2026" in mv[0]["not_measured"],
      "August: grey, the app was first read on 25/09/2026")
check(mv[1].get("value") is None and "30/09/2026" in mv[1]["not_measured"]
      and "no bake read the app that day" in mv[1]["not_measured"]
      and "25/09/2026, is not its last day and is not used" in mv[1]["not_measured"],
      "September: grey, naming 30/09 and the 25/09 reading it did not use")
o = mv[2]
check(o["value"] == 98.0 and o["display"] == "98% (204 of 208)",
      f"October: scored from the 31/10 reading - 204 of 208 is 98.0% (got {o.get('display')})")
check("read 31/10/2026" in o["basis"] and "the month's last day" in o["basis"]
      and "Ross, 12/10/2026" in o["basis"] and "still INCLUDES grease-trap servicing" in o["basis"],
      "October's basis names the reading, Ross's rule and the grease-trap caveat")
check(mv[3]["value"] == 80.0 and "source_kind" not in mv[3]
      and "its figure will be the reading taken on 30/11/2026" in mv[3]["basis"]
      and mv[3]["basis"].count("today's row") == 1 and ".." not in mv[3]["basis"],
      "November (open): today's row, saying the month's figure will be the 30/11 reading")
mv1 = bake.facilities_months("KR1", {"not_measured": "stale"}, readings, {}, "2026-11")
check(mv1[2]["value"] == 90 and mv1[2]["display"] == "90% (9 of 10)"
      and "CUMULATIVE from 25 Sep 2026" in mv1[2]["basis"],
      "KR1 October from the 31/10 reading, saying plainly it is cumulative, not October's jobs alone")
check(mv1[3] == {"m": "2026-11", "not_measured": "stale"}, "an open month that is grey stays grey, unchanged")
r30 = {k: v for k, v in readings.items() if k != "2026-10-31"}
mv = bake.facilities_months("KR4", open_kr4, r30, {"2026-10-31": fail}, "2026-11")
check(mv[2].get("value") is None and "31/10/2026" in mv[2]["not_measured"]
      and "did not answer in time" in mv[2]["not_measured"]
      and "30/10/2026, is not its last day and is not used" in mv[2]["not_measured"],
      "October with no 31/10 reading: grey, naming the failed pull and the unused 30/10 reading - never the 30th's figure")
nov1 = {"2026-11-01": dict(rec, as_of="2026-11-01", pulled_at="2026-11-01T00:05:00Z")}
mv = bake.facilities_months("KR4", open_kr4, nov1, {}, "2026-11")
check(mv[2].get("value") is None, "a reading dated 01/11 never stands in for October")

# ---- 3. grease traps --------------------------------------------------------
TODAY = datetime.date(2026, 9, 25)
FEED_FRESH = copy.deepcopy(FEED)


def block(feed):
    return bake.facilities_block(copy.deepcopy(feed), None, TODAY)


b = block(FEED_FRESH)
check("still INCLUDES grease-trap servicing" in b["rows"][KR4]["basis"]
      and b["tab"]["group"]["grease_traps"] is None
      and not any(s["grease_traps"] is not None for s in b["tab"]["sites"]),
      "no block in the feed: KR4 scored on every item and says grease traps are still in")
check("not separate it per site yet" in b["tab"]["notes"]["kr4"], "the site table's note says so too")
g = copy.deepcopy(FEED)
# 84 of 227 in date; say 6 grease-trap items, 2 of them in date
g["group"]["grease_traps"] = {"tasks": 6, "current": 1, "due30": 1, "overdue": 3, "no_evidence": 1}
s0 = g["sites"][0]
s0_t, s0_ok = s0["tasks"], s0["current"] + s0["due30"]
s0["grease_traps"] = {"tasks": 2, "current": 1, "due30": 0, "overdue": 1, "no_evidence": 0}
b = block(g)
r4 = b["rows"][KR4]
check(r4.get("value") == 37.1 and r4.get("display") == "37.1% (82 of 221)",
      f"usable block: KR4 = (84-2)/(227-6) = 37.1%, rounded down (got {r4.get('display')})")
check("LEFT OUT (Ross, 09/10/2026)" in r4["basis"] and "6 grease-trap items (2 in date)" in r4["basis"]
      and "221 of the register's 227" in r4["basis"],
      "the basis says how many items came out and why")
check("does not match" not in r4["basis"] and "grease traps included" in r4["basis"],
      "the app's own 37 is checked against ALL items (no false drift) and called the all-item figure")
check(b["tab"]["group"]["kr4_pct"] == 37.1 and b["tab"]["group"]["kr4_pct_app"] == 37
      and b["tab"]["group"]["kr4_pct_all_items"] == 37.0
      and b["tab"]["group"]["grease_traps"]["tasks"] == 6,
      "the tab's group row carries the ex-grease figure, the app's, and the block")
site = next(x for x in b["tab"]["sites"] if x["code"] == s0["code"])
want = int(100 * (s0_ok - 1) / (s0_t - 2) * 10) / 10
check(site["kr4_ex_grease"] and site["grease_traps"] == 2 and site["kr4_pct"] == want,
      f"a site with its own block: its figure computed here without grease traps ({want})")
check(all(x["grease_traps"] is None and not x["kr4_ex_grease"] for x in b["tab"]["sites"]
          if x["code"] != s0["code"]), "sites without a block keep the app's figure")
check("computed here without them" in b["tab"]["notes"]["kr4"], "the site note says which figures are ex grease")
for what, blk in (("not an object", 6), ("a missing count", {"tasks": 6, "current": 1}),
                  ("current+due30 above tasks", {"tasks": 1, "current": 1, "due30": 1}),
                  ("more than the register", {"tasks": 300, "current": 0, "due30": 0}),
                  ("a negative count", {"tasks": -1, "current": 0, "due30": 0}),
                  ("a bool", {"tasks": True, "current": 0, "due30": 0})):
    gb = copy.deepcopy(FEED)
    gb["group"]["grease_traps"] = blk
    r = block(gb)["rows"][KR4]
    check(r.get("value") is None and "grease_traps" in (r.get("not_measured") or ""),
          f"malformed block ({what}): KR4 grey naming the field, never a fall-back to the total")
ga = copy.deepcopy(FEED)
ga["group"]["grease_traps"] = {"tasks": 227, "current": 70, "due30": 14}
r = block(ga)["rows"][KR4]
check(r.get("value") is None and "no statutory item to score" in r["not_measured"],
      "every item a grease trap: grey, not 0% or a divide by zero")
# the history keeps the block and judges it when read back
gm = feed_at("2026-10-31", "2026-10-31T18:00:00Z")
gm["group"]["grease_traps"] = {"tasks": 6, "current": 1, "due30": 1, "overdue": 3, "no_evidence": 1}
gr = bake.facilities_reading(gm, "facilities_ppm.json")
o = bake.facilities_month_figure("KR4", gr)
check(o.get("value") == 37.1 and "LEFT OUT" in o["basis"], "a closed month's reading takes grease traps out too")
gm["group"]["grease_traps"] = "six"
o = bake.facilities_month_figure("KR4", bake.facilities_reading(gm, "facilities_ppm.json"))
check(o.get("value") is None and "grease_traps" in o["not_measured"],
      "a stored reading with an unusable block: that month is grey, naming the field")

# ---- 4. the real builder, dated 02/11/2026 over a seeded history -------------
out = os.path.join(tmpd, "bake")
arch = os.path.join(out, "arch", "2026-11-02")
os.makedirs(arch)
with gzip.open(os.path.join(arch, "Dummy.jsonl.gz"), "wt") as fh:
    fh.write(json.dumps({"row_num": 0, "data": {"x": 1}}) + "\n")
shutil.copy(MANIFEST, out)
cur = feed_at("2026-11-02", "2026-11-02T07:00:00Z", tasks=208, current=190, due30=10,
              overdue=8, no_evidence=0, kr4_pct=96, kr1_pct=95, kr1_n=20, kr1_ok=19)
with open(os.path.join(out, "facilities_ppm.json"), "w", encoding="utf-8") as fh:
    json.dump(cur, fh)
seed = [bake.facilities_reading(f31, "facilities_ppm.json"),
        bake.facilities_reading(feed_at("2026-10-31", "2026-11-03T09:00:00Z", current=1), "facilities_ppm.json"),
        bake.facilities_reading(cur, "facilities_ppm.json")]
with open(os.path.join(out, bake.FACILITIES_READINGS_FILE), "w", encoding="utf-8") as fh:
    for r in seed:
        fh.write(json.dumps(r, sort_keys=True) + "\n")
before = open(os.path.join(out, bake.FACILITIES_READINGS_FILE), encoding="utf-8").read()
env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=os.path.join(out, "arch"), OPS_OUT_DIR=out)
p = subprocess.run([sys.executable, BAKE, "--date", "2026-11-02"], env=env, capture_output=True, text=True)
check(p.returncode == 0, "the real builder bakes 02/11/2026 over the seeded history")
if p.returncode != 0:
    print(p.stdout[-3000:], p.stderr[-3000:])
else:
    with open(os.path.join(out, "snapshot_2026-11-02.json"), encoding="utf-8") as fh:
        snap = json.load(fh)
    check(open(os.path.join(out, bake.FACILITIES_READINGS_FILE), encoding="utf-8").read() == before,
          "a back-bake writes nothing to the history")
    row = {r["kr"]: r for r in snap["scorecard"]["rows"] if r["objective"] == "OO2"}
    k4 = {v["m"]: v for v in row["KR4"]["months"]}
    check(k4["2026-10"]["value"] == 98.0 and k4["2026-10"]["score"] == 50 and k4["2026-10"]["rag"] == "amber",
          "scorecard OO2 KR4 October: 98.0% from the 31/10 reading, 50 on 'full' - the line pulled 03/11 is ignored")
    k1 = {v["m"]: v for v in row["KR1"]["months"]}
    check(k1["2026-10"]["value"] == 90 and k1["2026-10"]["score"] == 80,
          "scorecard OO2 KR1 October: 90% (9 of 10) scores 80 on 'pct95'")
    check(k4["2026-11"]["value"] == 96.1 and k4["2026-11"]["mtd"] and k4["2026-11"]["score"] is None
          and k4["2026-11"]["coverage_days"] == 2,
          "November on its 2nd: today's reading shown MTD, unscored (2 days < 7)")
    check(row["KR4"]["mtd"] and row["KR4"]["score"] is None, "the row's default month is that MTD variant")
    oo2 = next(o for o in snap["scorecard"]["objectives"] if o["objective"] == "OO2")
    oct_ = next(m for m in oo2["months"] if m["m"] == "2026-10")
    check(oct_["scored"] == 2 and oct_["pct"] == 65.0,
          f"OO2 October rolls up KR1 80 and KR4 50: 65.0% from 2 scored (got {oct_})")
    check(k4["2026-09"]["value"] is None and k4["2026-09"]["score"] is None, "September stays grey")

shutil.rmtree(tmpd, ignore_errors=True)
print()
print("all assertions passed" if not failures else f"{failures} assertion(s) FAILED")
sys.exit(1 if failures else 0)
