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
check(set(rec) == {"as_of", "pulled_at", "pulled_by", "copy", "generated_at", "group", "grease_traps", "kr2"}
      and set(rec["group"]) == set(bake.FACILITIES_GROUP_COUNTS) | {"kr4_pct", "kr1_pct", "kr1_n", "kr1_ok"},
      "the line holds group counts, KR1's fields and KR2's counts only - no site, company or contractor names")
check(rec["kr2"] is None or (set(rec["kr2"]) == {"rule", "chasers", "months", "pairs", "by_site"}
      and all(set(m) == {"month", "repeats", "sites", "per_site"} for m in rec["kr2"]["months"])
      and all(set(p) == {"second"} for p in rec["kr2"]["pairs"])
      and all(set(b) == {"repeats"} for b in rec["kr2"]["by_site"])),
      "KR2's stored counts: months, re-report dates and by-site repeat counts - never a site or asset name")
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
mv = bake.facilities_months("KR4", open_kr4, readings, {}, "2026-11", "2026-11-05", open_as_of="2026-11-05")
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
check("the reading of 31/10/2026" in o["basis"] and "the month's last day" in o["basis"]
      and "Ross, 12/10/2026" in o["basis"] and "still INCLUDES grease-trap servicing" in o["basis"],
      "October's basis names the reading, Ross's rule and the grease-trap caveat")
check(mv[3]["value"] == 80.0 and "source_kind" not in mv[3] and mv[3]["coverage_days"] == 5
      and "its figure will be the reading taken on 30/11/2026" in mv[3]["basis"]
      and mv[3]["basis"].count("today's row") == 1 and ".." not in mv[3]["basis"],
      "November (open): today's row, 5 days in for the MTD rule, saying the month's figure will be the 30/11 reading")
check(o["coverage_days"] == 31, "a closed month's figure counts the whole month for the MTD rule")
mv1 = bake.facilities_months("KR1", {"not_measured": "stale"}, readings, {}, "2026-11", "2026-11-05")
check(mv1[2]["value"] == 90 and mv1[2]["display"] == "90% (9 of 10)"
      and "CUMULATIVE from 25 Sep 2026" in mv1[2]["basis"],
      "KR1 October from the 31/10 reading, saying plainly it is cumulative, not October's jobs alone")
check(mv1[3] == {"m": "2026-11", "not_measured": "stale"}, "an open month that is grey stays grey, unchanged")
r30 = {k: v for k, v in readings.items() if k != "2026-10-31"}
mv = bake.facilities_months("KR4", open_kr4, r30, {"2026-10-31": fail}, "2026-11", "2026-11-05",
                            open_as_of="2026-11-05")
check(mv[2].get("value") is None and "31/10/2026" in mv[2]["not_measured"]
      and "did not answer in time" in mv[2]["not_measured"]
      and "30/10/2026, is not its last day and is not used" in mv[2]["not_measured"],
      "October with no 31/10 reading: grey, naming the failed pull and the unused 30/10 reading - never the 30th's figure")
nov1 = {"2026-11-01": dict(rec, as_of="2026-11-01", pulled_at="2026-11-01T00:05:00Z")}
mv = bake.facilities_months("KR4", open_kr4, nov1, {}, "2026-11", "2026-11-05", open_as_of="2026-11-05")
check(mv[2].get("value") is None, "a reading dated 01/11 never stands in for October")

# review, 13/10/2026 - the month split follows the bake's OWN date, not the
# archive's newest pull: a live bake on 01/11 over an archive still at 31/10
# reads the app on 01/11 (72.1%). October is closed - it takes the 31/10
# reading, never the 1st's.
o1 = {"value": 72.1, "display": "72.1% (150 of 208)", "basis": "the 01/11 reading."}
mv = bake.facilities_months("KR4", o1, readings, {}, "2026-10", "2026-11-01", open_as_of="2026-11-01")
check([v["m"] for v in mv][-1] == "2026-10" and mv[-1]["value"] == 98.0 and mv[-1]["coverage_days"] == 31
      and "the month's last day" in mv[-1]["basis"],
      "pull month October, bake date 01/11: October is CLOSED and takes the 31/10 reading (98.0), not 01/11's 72.1")
# ...and the reverse: the copy on disk is still 31/10's when November opens
o2 = {"value": 98.0, "display": "98% (204 of 208)", "basis": "the 31/10 reading."}
mv = bake.facilities_months("KR4", o2, readings, {"2026-11-01": fail}, "2026-11", "2026-11-01",
                            open_as_of="2026-10-31")
nv = mv[-1]
check(nv["m"] == "2026-11" and nv.get("value") is None
      and "no reading of the Facilities app is dated in Nov 2026 yet" in nv["not_measured"]
      and "belongs to Oct 2026" in nv["not_measured"] and "did not answer in time" in nv["not_measured"],
      "November opens on a 31/10 copy: grey naming why - never October's closing reading under November's name")
check(mv[-2]["value"] == 98.0, "...while October takes that reading as its own")
# a back-bake whose copy on disk was pulled after its date takes the month
# so far from the history
mv = bake.facilities_months("KR4", {"not_measured": "pulled after this snapshot's date"}, readings, {},
                            "2026-10", "2026-10-30", history_open=True)
check(mv[-1]["value"] == 98.0 and "the month so far" in mv[-1]["basis"] and mv[-1]["coverage_days"] == 30,
      "back-bake of 30/10: the 30/10 reading from the history, as the month so far")
mv = bake.facilities_months("KR4", {"not_measured": "pulled after"}, {}, {}, "2026-10", "2026-10-30",
                            history_open=True)
check(mv[-1] == {"m": "2026-10", "not_measured": "pulled after"}, "...and with none, the block's own reason")
# re-review, 13/10/2026: the live stale gate holds for a back-bake too
mv = bake.facilities_months("KR4", {"not_measured": "pulled after"}, readings, {}, "2026-09", "2026-09-30",
                            history_open=True)
check(mv[-1].get("value") is None and "25/09/2026, was pulled 5 days before this snapshot's date" in mv[-1]["not_measured"]
      and "the limit is 3" in mv[-1]["not_measured"],
      "back-bake of 30/09 whose only reading is 25/09: grey - 5 days old, past the live limit of 3")
# a stored reading is held to the live gate: kr4_pct missing -> grey; drift kept
r_bad = dict(rec, group=dict(rec["group"], kr4_pct=None))
check(bake.facilities_month_figure("KR4", r_bad).get("not_measured", "").count("no usable group.kr4_pct") == 1,
      "a stored reading without kr4_pct is grey for its month, as the live row would be")
r_ov = dict(rec, group=dict(rec["group"], overdue=None))
check("group.overdue" in (bake.facilities_month_figure("KR4", r_ov).get("not_measured") or ""),
      "a stored reading missing a count is grey, naming it")
r_dr = dict(rec, group=dict(rec["group"], kr4_pct=60))
check("does not match its counts" in bake.facilities_month_figure("KR4", r_dr)["basis"],
      "a stored reading whose kr4_pct drifts from its counts keeps the NOTE")
r_in = dict(rec, group=dict(rec["group"], current=210, due30=4))
check("current+due30 exceeds tasks" in bake.facilities_month_figure("KR4", r_in)["not_measured"]
      and "the reading read" not in bake.facilities_month_figure("KR4", r_in)["not_measured"],
      "inconsistent stored counts: grey naming the real blocker")

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
check("is still in these figures: the app does not separate it yet" in b["tab"]["notes"]["kr4"],
      "the site table's note says so too")
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
check("the Group row and every site with a Grease traps figure are computed here without those items"
      in b["tab"]["notes"]["kr4"], "the site note says which figures are ex grease")
# review, 13/10/2026 (G2): a GROUP block only - the note must not say grease
# traps are still in the figures while the Group row leaves them out
go = copy.deepcopy(FEED)
go["group"]["grease_traps"] = {"tasks": 6, "current": 1, "due30": 1, "overdue": 3, "no_evidence": 1}
nb = block(go)["tab"]["notes"]["kr4"]
check("Group row's Compliant figure - the one the Overview scores - is computed here without" in nb
      and "site rows still include them" in nb and "is still in these figures" not in nb,
      "group block only: the note says the Group row leaves them out and the site rows do not")
# (G1): a site's block that cannot be used is named, never dropped silently
gu = copy.deepcopy(FEED)
gu["sites"][0]["grease_traps"] = {"tasks": "two"}
bu = block(gu)
su = next(x for x in bu["tab"]["sites"] if x["code"] == gu["sites"][0]["code"])
check(su["grease_traps"] is None and su["grease_traps_unusable"] == "lacks a usable tasks, current, due30"
      and f"{gu['sites'][0]['code']} (lacks a usable tasks, current, due30)" in bu["tab"]["notes"]["kr4"]
      and "keeps the app's all-item figure" in bu["tab"]["notes"]["kr4"],
      "an unusable site block: the site keeps the app's figure and the note names the site and why")
# re-review: KR4 grey with a usable group block - the note describes no Group
# row, column or Overview figure that is not on the page
gk = copy.deepcopy(FEED)
gk["group"]["grease_traps"] = {"tasks": 6, "current": 1, "due30": 1, "overdue": 3, "no_evidence": 1}
gk["group"]["kr4_pct"] = None
bk = block(gk)
nk = bk["tab"]["notes"]["kr4"]
check(bk["rows"][KR4].get("value") is None and "The Overview's KR4 is not quoted" in nk
      and "Group row's Compliant figure" not in nk and bk["tab"]["group"]["grease_traps"] is None,
      "KR4 grey for another reason: the note says it is not quoted and describes only the site rows")
# whole counts only: a fractional block is not a count of items
gf = copy.deepcopy(FEED)
gf["group"]["grease_traps"] = {"tasks": 5.5, "current": 1, "due30": 1}
check("lacks a usable tasks" in (block(gf)["rows"][KR4].get("not_measured") or ""),
      "a fractional grease-trap count: grey, naming it")
gn = copy.deepcopy(FEED)
gn["group"]["grease_traps"] = {"tasks": 6, "current": 1, "due30": 1, "overdue": "x", "no_evidence": -9}
bn = block(gn)
check(bn["rows"][KR4].get("value") == 37.1 and bn["tab"]["group"]["grease_traps"]["overdue"] is None
      and bn["tab"]["group"]["grease_traps"]["no_evidence"] is None,
      "unusable overdue/no_evidence in the block (KR4 does not use them) are published as null, never as sent")
# (G3): the basis no longer says "over every item" once grease traps are out
check("over every item except the grease traps" in r4["basis"], "the KR4 basis says the figure excludes grease traps")
# (G5): more out-of-date grease-trap items than the register has: grey, named
gx = copy.deepcopy(FEED)
gx["group"]["grease_traps"] = {"tasks": 200, "current": 0, "due30": 0}
r = block(gx)["rows"][KR4]
check(r.get("value") is None and "more out-of-date items than the whole register" in r["not_measured"],
      "a block with more out-of-date items than the register: grey with that reason")
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

# ---- 3b. OO2 KR2's closed months from the history (review, 15/10/2026) -----
# The app sends a rolling six months, and a stale or back-dated copy is not
# quoted at all: either would make a published closed month disappear. A
# stored reading keeps KR2's counts, and a month the row lacks comes from the
# newest reading that lists it, judged as of THAT reading's as_of.
h1 = feed_at("2026-10-01", "2026-10-01T07:00:00Z")
h1["kr2_repeat_issues"]["months"].append(
    {"label": "Oct 2026", "month": "2026-10", "per_site": 0.0, "repeats": 0, "sites": 19})
r1 = bake.facilities_reading(h1, "facilities_ppm.json")
check(any(m["month"] == "2026-09" and m["repeats"] == 0 and m["sites"] == 19 for m in r1["kr2"]["months"]),
      "a stored reading keeps KR2's months (counts only)")
grey = {"not_measured": "the feed is stale"}
got = bake.facilities_kr2_months(grey, {"2026-10-01": r1}, datetime.date(2026, 10, 6))
gm_ = {v["m"]: v for v in got.get("months") or []}
check(gm_.get("2026-09", {}).get("score_fixed") == 100 and "stored on 01/10/2026" in gm_["2026-09"]["basis"]
      and gm_.get("2026-10") == {"m": "2026-10", "not_measured": "the feed is stale"}
      and got["not_measured"] == "the feed is stale" and got["source_kind"] == "facilities_app",
      "a stale copy: September's 100 comes from the 01/10 reading, saying so; October (open) is never "
      "from history and keeps the row's own blocker - no invented month-to-date line (round 2)")
live = {"value": 0, "display": "x", "basis": "b", "source_kind": "facilities_app",
        "months": [{"m": "2026-09", "not_measured": "live says grey"}]}
got = bake.facilities_kr2_months(live, {"2026-10-01": r1}, datetime.date(2026, 10, 6))
check([v.get("not_measured") for v in got["months"]] == ["live says grey"],
      "a month today's copy lists is today's copy's answer - the history never overrides it")
r30 = bake.facilities_reading(feed_at("2026-09-30", "2026-09-30T18:00:00Z"), "facilities_ppm.json")
got = bake.facilities_kr2_months(grey, {"2026-09-30": r30}, datetime.date(2026, 10, 6))
check("is not final" in ({v["m"]: v for v in got["months"]}["2026-09"].get("not_measured") or ""),
      "a stored reading from inside the month: that month is not final there either")
got = bake.facilities_kr2_months(grey, {"2026-09-30": r30, "2026-10-01": r1}, datetime.date(2026, 10, 6))
check({v["m"]: v for v in got["months"]}["2026-09"].get("score_fixed") == 100,
      "...the NEWEST reading listing the month decides it")
# round 2: the NEWEST reading of a closed month wins - the quoted copy is one
# reading among the stored ones (a back-bake can quote an older copy)
r31 = bake.facilities_reading(feed_at("2026-10-31", "2026-10-31T18:00:00Z"), "facilities_ppm.json")
r02 = bake.facilities_reading(feed_at("2026-11-02", "2026-11-02T07:00:00Z"), "facilities_ppm.json")
for r_ in (r31, r02):
    r_["kr2"]["months"].append({"month": "2026-10", "repeats": 0, "sites": 19, "per_site": 0.0})
live_old = bake.fac_kr2_row({**r31["kr2"]}, "2026-10-31", datetime.date(2026, 10, 31), datetime.date(2026, 11, 3))
o_live = {v["m"]: v for v in live_old["months"]}["2026-10"]
check("is not final" in (o_live.get("not_measured") or ""), "(the 31/10 copy cannot finalise October)")
got = bake.facilities_kr2_months(live_old, {"2026-10-31": r31, "2026-11-02": r02}, datetime.date(2026, 11, 3),
                                 live_as_of="2026-10-31")
o_ = {v["m"]: v for v in got["months"]}["2026-10"]
check(o_.get("score_fixed") == 100 and "stored on 02/11/2026" in o_["basis"],
      "an older quoted copy (as of 31/10) is outranked by a newer stored reading (02/11): October scores 100")
got = bake.facilities_kr2_months(live_old, {"2026-10-31": r31}, datetime.date(2026, 11, 3), live_as_of="2026-10-31")
check({v["m"]: v for v in got["months"]}["2026-10"] == o_live,
      "...while a stored reading no newer than the quoted copy changes nothing")
bad_line = dict(r1, kr2={"months": "not a list", "pairs": 3})
got = bake.facilities_kr2_months(grey, {"2026-10-01": r1, "2026-10-02": bad_line}, datetime.date(2026, 10, 6))
check({v["m"]: v for v in got["months"]}["2026-09"].get("score_fixed") == 100,
      "a stored line that cannot be judged is skipped, never fatal - the next one still answers")
# round 2: the stored KR2 block never carries a name, even when the app sends them
fn = feed_at("2026-10-01", "2026-10-01T07:00:00Z")
fn["kr2_repeat_issues"]["pairs"] = [{"site": "Maki 3", "asset": "Fryer 2", "first": "2026-09-02",
                                     "fix_date": "2026-09-04", "second": "2026-09-20", "days": 18,
                                     "note": "J. Smith reported"},
                                    {"second": "re-reported by J. Smith"}]
fn["kr2_repeat_issues"]["by_site"] = [{"site": "Maki 3", "repeats": 2}, {"site": "Maki 9", "repeats": "two"}]
fn["kr2_repeat_issues"]["months"][-1]["repeats"] = "Fryer at Maki 3"
rn = bake.facilities_reading(fn, "facilities_ppm.json")["kr2"]
check(rn["pairs"] == [{"second": "2026-09-20"}, {"second": "invalid"}]
      and rn["by_site"] == [{"repeats": 2}, {"repeats": "invalid"}]
      and rn["months"][-1]["repeats"] == "invalid"
      and not any(x in json.dumps(rn) for x in ("Maki", "Fryer", "Smith")),
      "the public history keeps counts and dates only - a name the app put anywhere is never stored")
old_line = {k: v for k, v in r1.items() if k != "kr2"}
check(bake.facilities_kr2_months(grey, {"2026-10-01": old_line}, datetime.date(2026, 10, 6)) == grey,
      "a line written before KR2 was stored adds nothing")


def bake_at(name, date, feed, seed=()):
    """The real builder, --date `date`, over `feed` and a seeded history."""
    o_ = os.path.join(tmpd, name)
    a_ = os.path.join(o_, "arch", date)
    os.makedirs(a_)
    with gzip.open(os.path.join(a_, "Dummy.jsonl.gz"), "wt") as fh_:
        fh_.write(json.dumps({"row_num": 0, "data": {"x": 1}}) + "\n")
    shutil.copy(MANIFEST, o_)
    with open(os.path.join(o_, "facilities_ppm.json"), "w", encoding="utf-8") as fh_:
        json.dump(feed, fh_)
    if seed:
        with open(os.path.join(o_, bake.FACILITIES_READINGS_FILE), "w", encoding="utf-8") as fh_:
            for r_ in seed:
                fh_.write(json.dumps(r_, sort_keys=True) + "\n")
    env_ = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=os.path.join(o_, "arch"),
                OPS_OUT_DIR=o_)
    p_ = subprocess.run([sys.executable, BAKE, "--date", date], env=env_, capture_output=True, text=True)
    if p_.returncode != 0:
        print(p_.stdout[-2000:], p_.stderr[-2000:])
        return None
    with open(os.path.join(o_, f"snapshot_{date}.json"), encoding="utf-8") as fh_:
        return json.load(fh_)


def kr2_and_oo2(snap_, m):
    r_ = next(r for r in snap_["scorecard"]["rows"] if r["objective"] == "OO2" and r["kr"] == "KR2")
    v_ = next((v for v in r_["months"] or [] if v["m"] == m), {})
    o_ = next(o for o in snap_["scorecard"]["objectives"] if o["objective"] == "OO2")
    return r_, v_, next((x for x in o_["months"] if x["m"] == m), {})


# the guards end to end, through main()'s scoring and the roll-up
sn = bake_at("notfinal", "2026-10-02", feed_at("2026-09-30", "2026-09-30T18:00:00Z"))
if sn:
    r_, v_, o_ = kr2_and_oo2(sn, "2026-09")
    check(v_.get("value") is None and v_.get("score") is None and "is not final" in (v_.get("not_measured") or "")
          and o_.get("scored") == 0 and o_.get("pct") is None and r_["source_kind"] == "facilities_app",
          f"real builder 02/10, newest copy as of 30/09: KR2 September grey, OO2 September 0 scored (got {o_})")
fdis = feed_at("2026-10-01", "2026-10-01T07:00:00Z")
fdis["kr2_repeat_issues"]["months"][-1].update(repeats=0, per_site=0.2)
sn = bake_at("disagree", "2026-10-02", fdis)
if sn:
    r_, v_, o_ = kr2_and_oo2(sn, "2026-09")
    check(v_.get("score") is None and "the two disagree" in (v_.get("not_measured") or "") and o_.get("scored") == 0,
          "real builder: 0 repeats against 0.2 per site - grey, and OO2 September counts nothing")
# a back-bake whose copy on disk was pulled after its date: the copy is not
# quoted, and September comes from the reading stored on 01/10
sn = bake_at("histback", "2026-10-02", feed_at("2026-10-15", "2026-10-15T07:00:00Z"), seed=[r1])
if sn:
    r_, v_, o_ = kr2_and_oo2(sn, "2026-09")
    check(v_.get("score") == 100 and v_.get("rag") == "green" and "stored on 01/10/2026" in (v_.get("basis") or "")
          and o_.get("scored") == 1 and o_.get("pct") == 100.0 and r_.get("value") is None,
          f"real builder back-bake 02/10 over a copy pulled 15/10: September's 100 from the 01/10 reading, "
          f"OO2 September 100% (got {v_.get('score')}, {o_})")

# ---- 4. the real builder, dated 02/11/2026 over a seeded history -------------
out = os.path.join(tmpd, "bake")
arch = os.path.join(out, "arch", "2026-11-02")
os.makedirs(arch)
with gzip.open(os.path.join(arch, "Dummy.jsonl.gz"), "wt") as fh:
    fh.write(json.dumps({"row_num": 0, "data": {"x": 1}}) + "\n")
shutil.copy(MANIFEST, out)
cur = feed_at("2026-11-02", "2026-11-02T07:00:00Z", tasks=208, current=190, due30=10,
              overdue=8, no_evidence=0, kr4_pct=96, kr1_pct=95, kr1_n=20, kr1_ok=19)
# OO2 KR2 (Ross, 15/10/2026: 0 repeat issues is green 100%): September 0,
# October 2 repeats (no Jun-Aug baseline exists), November 0 so far
cur["kr2_repeat_issues"]["months"] += [
    {"label": "Oct 2026", "month": "2026-10", "per_site": 0.1, "repeats": 2, "sites": 19},
    {"label": "Nov 2026", "month": "2026-11", "per_site": 0.0, "repeats": 0, "sites": 19}]
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
    k2 = {v["m"]: v for v in row["KR2"]["months"]}
    check(k2["2026-09"]["value"] == 0 and k2["2026-09"]["score"] == 100 and k2["2026-09"]["rag"] == "green"
          and k2["2026-09"]["display"] == "0 repeats (19 sites)",
          "OO2 KR2 September, closed with 0 repeat issues: 100, green (Ross, 15/10/2026)")
    check(k2["2026-10"]["value"] is None and "a month WITH repeats" in (k2["2026-10"]["not_measured"] or ""),
          "OO2 KR2 October, 2 repeats and no Jun-Aug baseline: grey with why, never 0 or green")
    check(k2["2026-11"]["value"] == 0 and k2["2026-11"]["score"] is None and k2["2026-11"]["mtd"]
          and "0 so far can still become 1, so it is scored only when the month closes" in k2["2026-11"]["basis"]
          and "mtd_why" not in k2["2026-11"] and "unless it breaches" not in k2["2026-11"]["basis"],
          "OO2 KR2 November, 0 so far on its 2nd: MTD - never green before the month closes")
    sep_ = next(m for m in oo2["months"] if m["m"] == "2026-09")
    check(sep_["scored"] == 1 and sep_["pct"] == 100.0,
          f"OO2 September rolls up KR2's 100 - 1 of 5 scored (got {sep_})")

shutil.rmtree(tmpd, ignore_errors=True)
print()
print("all assertions passed" if not failures else f"{failures} assertion(s) FAILED")
sys.exit(1 if failures else 0)
