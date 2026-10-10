#!/usr/bin/env python3
"""Weekly price reports are dated by their EMAIL, not by our pull (10/10/2026).

The review of the 2-8 Oct back-bakes found OO3 KR2 counting the price report
Kobas emailed on Monday 28/09 as OCTOBER: the 21-30/09 outage meant the first
pull to carry it was 01/10, and reports were dated by the first pull that
carried them. With the count already past its tolerance, that one September
report made October "ALREADY BREACHED" on 2-4 Oct and put Operations at 0%.
House rule: event dates, not pull dates.

The export records each report's email Date header in its run receipt
(run_log/etl_run_log.jsonl, feeds[...].report_sent_at). This pins:
  * load_report_receipts / report_event_date - as-of, row-count matched,
    unambiguous, never later than the first pull that carried the report;
  * okr_incomplete_variant - a closed month with a hole keeps a 0 the hole
    cannot rescue, and leaves any other count unscored;
  * the real builder over a hand-built archive + receipts:
      - as of 02/10 the 28/09 report counts in SEPTEMBER, October is unknown
        ("-", 0 days) and nothing is scored from it;
      - the report expected around 21/09 is named as never pulled, and
        September's variant says UNDERCOUNT;
      - as of 05/10 October holds only the 05/10 report;
      - unattributed rises are bucketed per month;
      - with no receipts the builder falls back to the first pull, and says so.

  python3 tests/event_dated_reports_test.py      (exit 1 on any failure)
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
import bake_ops_command as bake  # noqa: E402

PRICE_FEED = "Kobas Report - Weekly Ingredient Price Changes Report"
PRICE_SLUG = "Kobas_Report_Weekly_Ingredient_Price_Changes_Report"
failures = 0


def check(cond, msg):
    global failures
    print(("ok  : " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


print("-- receipts: the report's own date, as of the bake --")
tmp = tempfile.mkdtemp(prefix="evdate-")
rl = os.path.join(tmp, "receipts.jsonl")
with open(rl, "w") as fh:
    for pd_, sent, n in [("2026-09-14", "2026-09-14T07:02:09+00:00", 3),
                         ("2026-10-01", "2026-09-28T07:01:59+00:00", 8),
                         ("2026-10-02", "2026-09-28T07:01:59+00:00", 8),
                         ("2026-10-05", "2026-10-04T23:30:00+00:00", 2)]:
        fh.write(json.dumps({"pull_date": pd_, "run_kind": "daily-export",
                             "feeds": {PRICE_FEED: {"report_sent_at": sent, "rows_fetched": n}}}) + "\n")
    fh.write("not json\n")
    fh.write(json.dumps({"pull_date": "2026-10-03", "feeds": {PRICE_FEED: {"rows_fetched": 8}}}) + "\n")
r = bake.load_report_receipts(rl, PRICE_FEED, "2026-10-02")
check(set(r) == {"2026-09-14", "2026-10-01", "2026-10-02"},
      f"only receipts for pulls on or before the bake date are read (got {sorted(r)})")
check(r["2026-10-01"] == [("2026-09-28", 8)], "the sent time becomes a UK calendar date with its row count")
r5 = bake.load_report_receipts(rl, PRICE_FEED, "2026-10-05")
check(r5["2026-10-05"] == [("2026-10-05", 2)],
      "23:30 UTC on 04/10 is 00:30 on 05/10 in London - the UK date, not the UTC one")
check(bake.load_report_receipts(None, PRICE_FEED, "2026-10-05") == {}, "no receipts file: an empty map, not a crash")
E = bake.report_event_date
check(E(["2026-10-01", "2026-10-02"], 8, r) == "2026-09-28", "a report first pulled 01/10 is dated 28/09, its email")
check(E(["2026-10-01"], 9, r) is None, "a receipt whose row count does not match is not this report's")
check(E(["2026-09-13"], 3, {"2026-09-13": [("2026-09-14", 3)]}) is None,
      "an email date AFTER the first pull that carried the report is impossible - fall back")
check(E(["2026-10-01"], 8, {"2026-10-01": [("2026-09-28", 8), ("2026-09-21", 8)]}) is None,
      "two different email dates for one report - ambiguous, fall back")
check(bake.run_log_path(os.path.join(tmp, "nowhere")) is None, "no receipts beside the archive: None")

print("\n-- a closed month with a hole (okr_incomplete_variant) --")
I = bake.okr_incomplete_variant
v = {"m": "2026-09", "value": 71, "display": "71", "score": 0, "rag": "red", "basis": "b"}
o = I(v, "spikes", "the weekly report expected around 2026-09-21 was never pulled")
check(o["score"] == 0 and o["incomplete"] and o["basis"].startswith("UNDERCOUNT, but already past the last tolerance (5)"),
      "a count already past its last tolerance keeps 0: a missing day can only add to it")
v = {"m": "2026-09", "value": 4, "display": "4", "score": 50, "rag": "amber", "basis": "b"}
o = I(v, "spikes", "x was never pulled")
check(o["score"] is None and o["rag"] is None and o["display"] == "4+" and "INCOMPLETE month" in o["basis"],
      "any other count is a lower bound - unscored, shown as '4+'")
v = {"m": "2026-09", "value": 94.6, "display": "94.6%", "score": 80, "rag": "amber", "basis": "b"}
check(I(v, "pct95", "y") is v, "a rate passes through - it is computed over the days that were covered")

print("\n-- the real builder: four reports, one emailed in September and pulled in October --")


def line(i, old, new, sup="ACME FOODS"):
    return {"Parent ID": str(1000 + i), "Ingredient Name": f"ITEM {i}", "Pack Size": "1",
            "Unit Volume": "1000", "Measurement": "Grams", "Old Price": old, "New Price": new,
            "Supplier": sup}


# Each report is distinct content. R_sep14: 1 spike. R_sep28 (pulled 01/10): 6
# spikes, one with no supplier. R_oct05: 2 spikes.
R_SEP14 = [line(1, "1.00", "1.20"), line(2, "1.00", "1.01"), line(3, "2.00", "2.02")]
R_SEP28 = ([line(10 + k, "1.00", "1.25") for k in range(6)]
           + [line(20, "1.00", "1.30", sup=""), line(21, "1.00", "1.00")])
R_OCT05 = [line(30, "1.00", "1.50"), line(31, "2.00", "2.40")]
PULLS = {"2026-09-07": [line(40, "1.00", "1.02")], "2026-09-14": R_SEP14,
         "2026-10-01": R_SEP28, "2026-10-02": R_SEP28, "2026-10-05": R_OCT05}
root = os.path.join(tmp, "etl")
for d, rows in PULLS.items():
    pdir = os.path.join(root, "warehouse_direct", d)
    os.makedirs(pdir)
    with gzip.open(os.path.join(pdir, PRICE_SLUG + ".jsonl.gz"), "wt") as fh:
        for i, row in enumerate(rows):
            fh.write(json.dumps({"row_num": i, "data": row}) + "\n")
    json.dump({PRICE_SLUG: PRICE_FEED}, open(os.path.join(pdir, "_feeds.json"), "w"))
os.makedirs(os.path.join(root, "run_log"))
with open(os.path.join(root, "run_log", "etl_run_log.jsonl"), "w") as fh:
    for d, sent in [("2026-09-07", "2026-09-07T07:02:12+00:00"), ("2026-09-14", "2026-09-14T07:02:09+00:00"),
                    ("2026-10-01", "2026-09-28T07:01:59+00:00"), ("2026-10-02", "2026-09-28T07:01:59+00:00"),
                    ("2026-10-05", "2026-10-05T07:01:55+00:00")]:
        fh.write(json.dumps({"pull_date": d, "run_kind": "daily-export",
                             "feeds": {PRICE_FEED: {"report_sent_at": sent,
                                                    "rows_fetched": len(PULLS[d])}}}) + "\n")


def run(date, with_receipts=True):
    out = os.path.join(tmp, f"out-{date}-{int(with_receipts)}")
    os.makedirs(out)
    shutil.copy(os.path.join(REPO, "data", "ops_command", "feeds_manifest.json"), out)
    env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive",
               OPS_ARCHIVE_DIR=os.path.join(root, "warehouse_direct"), OPS_OUT_DIR=out)
    env.pop("OPS_RUN_LOG", None)
    if not with_receipts:
        env["OPS_RUN_LOG"] = os.path.join(tmp, "no-such-file.jsonl")
    p = subprocess.run([sys.executable, BUILDER, "--date", date], env=env, capture_output=True, text=True)
    check(p.returncode == 0, f"the real builder bakes as of {date}" + ("" if with_receipts else " with no receipts"))
    if p.returncode != 0:
        print(p.stdout[-1500:], p.stderr[-2500:])
        sys.exit(1)
    return json.load(open(os.path.join(out, f"snapshot_{date}.json")))


def kr2(snap):
    return next(r for r in snap["scorecard"]["rows"] if (r["objective"], r["kr"]) == ("OO3", "KR2"))


s2 = run("2026-10-02")
sp = s2["supply"]["price_spikes"]
reps = s2["supply"]["price_reports"]
check([(x["date"], x["first_seen"], x["dated_by"]) for x in reps] ==
      [("2026-09-07", "2026-09-07", "email"), ("2026-09-14", "2026-09-14", "email"),
       ("2026-09-28", "2026-10-01", "email")],
      f"price_reports carry the email date, the first pull and how each was dated (got {reps})")
months = {m["month"]: m["spikes"] for m in sp["months"]}
check(months == {"2026-09": 7}, f"all seven attributed September spikes count in September (got {months})")
check(sp["missing_reports"] == ["2026-09-21"], f"the report expected around 21/09 is named as never pulled (got {sp['missing_reports']})")
check(any("never pulled (expected around 2026-09-21)" in g for g in s2["gaps"]), "and listed in the snapshot's gaps")
check(sp["unattributed_by_month"] == {"2026-09": 1}, f"the rise with no supplier is September's (got {sp['unattributed_by_month']})")
k = kr2(s2)
check(k["value"] is None and k["score"] is None and k["mtd"] and k["coverage_days"] == 0,
      f"October KR2 as of 02/10 is unknown - no value, no score, 0 days (got {k['value']}, {k['score']}, {k['coverage_days']})")
check("no weekly ingredient price report emailed in October 2026 yet" in (k["basis"] or "")
      and "emailed 2026-09-28, is counted in September 2026" in k["basis"],
      "and says the newest report was emailed 28/09 and counts in September")
sep = next(v for v in k["months"] if v["m"] == "2026-09")
check(sep["value"] == 7 and sep["score"] == 0 and sep.get("incomplete")
      and sep["basis"].startswith("UNDERCOUNT, but already past the last tolerance (5)")
      and "expected around 2026-09-21 was never pulled" in sep["basis"],
      f"September: 7, past the tolerance so 0 stands, and named an UNDERCOUNT (got {sep['value']}, {sep['score']})")
oo3 = next(o for o in s2["scorecard"]["objectives"] if o["objective"] == "OO3")
check(oo3["pct"] is None and s2["scorecard"]["operations"]["pct"] is None,
      "nothing in October is scored, so OO3 and Operations read '-', not 0%")

s5 = run("2026-10-05")
sp5 = s5["supply"]["price_spikes"]
check({m["month"]: m["spikes"] for m in sp5["months"]} == {"2026-09": 7, "2026-10": 2},
      "as of 05/10 October holds only the 05/10 report's two spikes")
k5 = kr2(s5)
check(k5["value"] == 2 and k5["mtd"] and k5["score"] is None and k5["coverage_days"] == 5,
      f"two spikes on five days: under the tolerance, so MTD (got {k5['value']}, {k5['mtd']}, {k5['coverage_days']})")
check(sp5["unattributed_by_month"].get("2026-10") is None and "qualifying rise(s) in" not in (k5["basis"] or ""),
      "October's basis does not quote September's unattributed rise as its own")

sn = run("2026-10-02", with_receipts=False)
rn = sn["supply"]["price_reports"]
check([x["dated_by"] for x in rn] == ["first_pull"] * 3 and rn[-1]["date"] == "2026-10-01",
      "no receipts: each report falls back to the first pull that carried it")
kn = kr2(sn)
check(kn["value"] == 6 and kn["score"] == 0,
      "and then the 01/10 pull counts in October, as before - the fallback, not a silent change")
octn = next(v for v in kn["months"] if v["m"] == "2026-10")
check("dated by the first pull that carried them" in (octn["basis"] or ""),
      "and the month's basis says its reports are dated by first pull")

print("\n-- wording (m5) --")
src = open(BUILDER).read() + open(os.path.join(REPO, "builders", "verify_ops_data.py")).read()
check("Supply KR2 stays unmeasured" not in src and "KR2 stays unmeasured" not in src,
      "neither the bake nor the verifier says 'Supply KR2 stays unmeasured' while OO3 KR2 is scored")

shutil.rmtree(tmp, ignore_errors=True)
print()
if failures:
    print(f"{failures} assertion(s) FAILED")
    sys.exit(1)
print("all assertions passed")
