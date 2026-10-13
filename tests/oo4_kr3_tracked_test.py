#!/usr/bin/env python3
"""OO4 KR3 - supplier orders tracked to a goods-in (Phase 4.2, 12/10/2026).

WHY THIS TEST EXISTS
  Ross, 12/10/2026, verbatim: "Kobas goods in from suppliers use the orders
  that come in through email and the deliveries report to track all orders
  are delivered". The deliveries report carries no order number, so orders
  and goods-ins are PAIRED by site, supplier and a day window - and every trap
  here produces a plausible wrong percentage, not an error:

    * one goods-in counted for two orders (a rate above the truth);
    * the LWC depots merged into one supplier (a London goods-in "receiving"
      a Doncaster order);
    * a goods-in the latest copy marks Deleted still counting;
    * an order judged "not received" when the report never covered the days
      its goods-in could have been booked (a rate below the truth);
    * a supplier whose order emails began mid-month scored on half a month;
    * a month SCORED on a pairing window nobody has agreed (it is PROPOSED);
    * a rate rounded UP into a better band (94.97 must not read 95.0).

WHAT IT CHECKS
  1. delivery_tracking's pure functions: goods_in, coverage, match, kr3_months.
  2. The REAL builder over a synthetic archive (order emails, a daily
     "Kobas Report - Daily Ops Deliveries" feed and the export's receipts),
     dated 04/11/2026, and the verifier's recompute of it (check 4b).

Run: python3 tests/oo4_kr3_tracked_test.py   (needs duckdb for part 2)
"""

from __future__ import annotations

import datetime as dt
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
import delivery_tracking as T  # noqa: E402

failures = 0


def check(cond, msg):
    global failures
    if cond:
        print("ok  :", msg)
    else:
        failures += 1
        print("FAIL:", msg)


def days(a, b):
    x, y = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
    while x <= y:
        yield x.isoformat()
        x += dt.timedelta(days=1)


def add(iso, n):
    return (dt.date.fromisoformat(iso) + dt.timedelta(days=n)).isoformat()


def mvar(m, **kw):
    return {"m": m, "value": None, "display": None, "rag": None, "basis": None,
            "not_measured": None, **kw}


def score(v):
    return next((s for t, s in ((95, 100), (90, 80), (85, 50)) if v is not None and v >= t), 0)


def rag(s):
    return {100: "green", 80: "amber", 50: "amber", 0: "red"}.get(s)


# ---- 1a. goods_in: dedupe, Deleted, spans ------------------------------------
F = "Kobas Report - Daily Ops Deliveries"
g1 = {"Venue": "Maki A", "Supplier": "Brakes", "Kobas ID": 1, "Delivery Date": "2026-10-05",
      "Invoice Number": None, "Last Modified": "2026-10-05 10:00:00", "status": "Active"}
rows = [("2026-10-06", F, g1),
        ("2026-10-07", F, dict(g1, **{"Last Modified": "2026-10-06 09:00:00"})),
        ("2026-10-06", F, dict(g1, **{"Kobas ID": 2})),
        ("2026-10-07", F, dict(g1, **{"Kobas ID": 2, "status": "Deleted"})),
        ("2026-10-07", F, dict(g1, **{"Kobas ID": 3, "Venue": ""})),
        ("2026-10-07", F, dict(g1, **{"Kobas ID": None}))]
goods, pulls, deleted = T.goods_in(rows)
check([g["id"] for g in goods] == ["1"], "one goods-in per Kobas ID; the latest copy marking it Deleted drops it; "
      "a row with no site or no ID is not a goods-in")
check(deleted == 1, "the Deleted goods-in is counted, for the basis")
check(pulls[("2026-10-06", F)]["lm_min"] == "2026-10-05 10:00:00" and pulls[("2026-10-07", F)]["rows"] == 4,
      "each pull's Last Modified span and row count are kept")

# ---- 1b. coverage ----------------------------------------------------------
P = {("2026-10-10", F): {"rows": 5, "lm_min": "2026-10-02 08:00:00", "lm_max": "2026-10-10 06:00:00"},
     ("2026-10-11", F): {"rows": 0, "lm_min": None, "lm_max": None}}
check(T.coverage(P, {}) == list(days("2026-10-03", "2026-10-09")),
      "no receipt: from the day after the oldest Last Modified to the day before the newest (both edges may be cut)")
check(T.coverage(P, {("2026-10-10", F): "2026-10-10"}) == list(days("2026-10-03", "2026-10-09")),
      "with the email's send date: up to the day before it was sent")
P2 = {**P, ("2026-10-20", F): {"rows": 2, "lm_min": "2026-10-15 10:00", "lm_max": "2026-10-19 10:00"}}
cv = T.coverage(P2, {("2026-10-20", F): "2026-10-20"})
check(cv == list(days("2026-10-03", "2026-10-09")) + list(days("2026-10-16", "2026-10-19")),
      "pulls are unioned and the days between them stay uncovered; an empty pull covers nothing")

# ---- 1c. match ---------------------------------------------------------------
def o(ref, dd, sup="Brakes", site="Maki A", em=None):
    return {"ref": ref, "site": site, "sup": sup, "dd": dd, "emailed": em or add(dd, -1)}


def g(gid, date, sup="Brakes", site="Maki A", ref=None):
    return {"id": gid, "site": site, "sup": sup, "date": date, "ref": ref}


m = T.match([o("A", "2026-10-10"), o("B", "2026-10-11")], [g("x", "2026-10-11"), g("y", "2026-10-12")], k=2)
check(m == {"A": ("y", "window"), "B": ("x", "window")},
      "closest first: B takes its own-day goods-in (11/10) and A the one booked two days late (12/10) - both pair")
run = [o(f"L{d}", d) for d in days("2026-10-01", "2026-10-10")]
m = T.match(run, [g(f"g{d}", d) for d in days("2026-10-01", "2026-10-10") if d != "2026-10-05"], k=2)
check(set(r["ref"] for r in run) - set(m) == {"L2026-10-05"},
      "a missed delivery in a daily run stays on ITS day - the next day's goods-in is not slid back to it "
      "(which would move the miss to the end of the run, into a later month)")
m = T.match([o("A", "2026-10-07"), o("B", "2026-10-09")],
            [g("x", "2026-10-09"), g("x2", "2026-10-09")], k=2)
check(set(m) == {"A", "B"}, "a split delivery (two goods-ins on one day) can receive an earlier open order "
      "inside its window")
m = T.match([o("A", "2026-10-10"), o("B", "2026-10-10")], [g("x", "2026-10-10")], k=2)
check(len(m) == 1, "one goods-in never receives two orders")
m = T.match([o("A", "2026-10-10", sup="LWC Doncaster")], [g("x", "2026-10-10", sup="LWC London")])
check(m == {}, "Kobas's own supplier names: an LWC London goods-in does not receive an LWC Doncaster order")
m = T.match([o("A", "2026-10-10")], [g("x", "2026-10-10", site="Maki B")])
check(m == {}, "a goods-in at another site does not count")
m = T.match([o("A", "2026-10-10", em="2026-10-08")], [g("x", "2026-10-07"), g("y", "2026-10-13")], k=2)
check(m == {}, "booked before the order was emailed, or later than due + 2 days: no pair")
m = T.match([o("3031/77", "2026-10-10")], [g("x", "2026-10-20", ref="3031/77")], k=2)
check(m == {"3031/77": ("x", "ref")}, "the order ref typed on a goods-in is an exact link, whatever the date")
m = T.match([o("3031/77", "2026-10-10")], [g("x", "2026-10-10", ref="3031/77", site="Maki B")], k=2)
check(m == {}, "...but not when the site differs (a mistyped ref is not a link)")

# ---- 1d. kr3_months ----------------------------------------------------------
e, gp = T.kr3_months([], [], [], "2026-10", mvar, score, rag)
check(e["months"] is None and "Ops Deliveries" in e["not_measured"] and "[TEST]" in e["not_measured"]
      and gp and gp[0].startswith("OO4 KR3"), "no deliveries report at all: grey, saying what Kobas must send")
e, gp = T.kr3_months([], [], [], "2026-10", mvar, score, rag, feeds=[F], orders_why="no ISO dates")
check(e["months"] is None and "order emails cannot be used" in e["not_measured"], "unusable order emails: grey")

SEP = list(days("2026-09-01", "2026-09-30"))
orders = [o(f"S{d}", d) for d in SEP] + [o(f"T{d}", d, sup="TWF") for d in SEP[14:]]
goods_s = [g(f"g{d}", d) for d in SEP[1:]]          # 1 September order never booked in
cov = list(days("2026-08-25", "2026-10-05"))
first = {"Brakes": "2026-08-03", "TWF": "2026-09-15"}
e, gp = T.kr3_months(orders, goods_s, cov, "2026-10", mvar, score, rag, first_dd=first, feeds=[F])
sv = next(v for v in e["months"] if v["m"] == "2026-09")
check(sv["value"] == 96.6 and sv["display"].startswith("96.6% (29 of 30)"),
      f"September: 29 of 30 Brakes orders received = 96.6%, cut down (got {sv['display']})")
check(sv["score"] is None and sv["incomplete"] and "proposed, not agreed" in sv["basis"]
      and sv["display"].endswith("not scored"),
      "...and NOT scored: the pairing window is proposed")
check("Left out: TWF" in sv["basis"] and "Not received: Brakes 1" in sv["basis"],
      "...TWF, whose emails begin on 15/09, is left out and named; the miss is named by supplier")
check(any("proposed, not agreed" in x for x in gp), "a gap says the window awaits Ross")
e, gp = T.kr3_months(orders, goods_s, cov, "2026-10", mvar, score, rag, first_dd=first, feeds=[F],
                     status="agreed")
sv = next(v for v in e["months"] if v["m"] == "2026-09")
check(sv["score"] == 100 and sv["rag"] == "green" and not sv.get("incomplete"),
      "once agreed: September scores 100 on pct95")
check(not any("proposed" in x for x in gp), "...and the gap goes")
o199 = [o(f"R{i}", "2026-09-10") for i in range(199)]
g189 = [g(f"r{i}", "2026-09-10") for i in range(189)]
e, _ = T.kr3_months(o199, g189, cov, "2026-10", mvar, score, rag, first_dd=first, feeds=[F], status="agreed")
sv = next(v for v in e["months"] if v["m"] == "2026-09")
check(sv["value"] == 94.9 and sv["score"] == 80, "189 of 199 is 94.97%: shown 94.9 and scored 80 - never rounded up into 95")
cov_hole = [d for d in cov if d not in ("2026-09-20", "2026-09-21")]
e, _ = T.kr3_months(orders, goods_s, cov_hole, "2026-10", mvar, score, rag, first_dd=first, feeds=[F],
                    status="agreed")
sv = next(v for v in e["months"] if v["m"] == "2026-09")
check(sv["score"] is None and sv["incomplete"] and "INCOMPLETE" in sv["basis"]
      and "5 order(s) not judged: the report does not cover every day" in sv["basis"]
      and sv["display"].startswith("96% (24 of 25)"),
      f"a 2-day hole in the report: the 5 orders whose 4-day window it touches are left out of the "
      f"rate (never counted as not received) and the month is INCOMPLETE, unscored (got {sv['display']})")
cov_short = list(days("2026-08-25", "2026-09-29"))
e, gp = T.kr3_months(orders, goods_s, cov_short, "2026-10", mvar, score, rag, first_dd=first, feeds=[F],
                     status="agreed")
sv = next(v for v in e["months"] if v["m"] == "2026-09")
check(sv["score"] is None and sv["incomplete"] and "window runs past 29/09/2026" in sv["basis"],
      "a report that stops before due + 2 for the month's last orders: INCOMPLETE, unscored")
check(any("covers goods-ins to 29/09/2026 only" in x for x in gp), "...and a gap says how far the report reaches")
ov = next(v for v in e["months"] if v["m"] == "2026-10")
check(ov["value"] is None and ov.get("mtd") and ov["score"] is None and ov["coverage_days"] == 0,
      "October, open, with no day covered: month to date, 0 orders judged - never 0%")
check(next(v for v in e["months"] if v["m"] == "2026-08").get("not_measured"),
      "August with no order judged: grey with its reason, never 0")
check(sv["basis"].count("Left out: TWF") == 1 and sv["basis"].count("not judged: their window") == 1,
      "an incomplete month's basis says each reason once (review, 13/10/2026)")
OCT = list(days("2026-10-01", "2026-10-12"))
e, _ = T.kr3_months([o(f"O{d}", d) for d in OCT], [g(f"h{d}", d) for d in OCT], list(days("2026-09-25", "2026-10-12")),
                    "2026-10", mvar, score, rag, first_dd=first, feeds=[F], status="agreed")
ov = next(v for v in e["months"] if v["m"] == "2026-10")
check(ov["value"] == 100 and ov["coverage_days"] == 12 and ov["display"] == "100% (10 of 10)",
      f"October, open: the 10 orders whose window has closed are judged; 12 days covered for the MTD rule (got {ov['display']}, {ov['coverage_days']})")

# review, 13/10/2026: the ORDER side has gaps too. An export outage that
# missed a week of order emails shrinks the month's denominator; the month
# must say so and never be scored as complete.
pulls_all = list(days("2026-08-20", "2026-10-06"))
pulls_gap = [p_ for p_ in pulls_all if not ("2026-09-10" <= p_ <= "2026-09-30")]
e, _ = T.kr3_months(orders, goods_s, cov, "2026-10", mvar, score, rag, first_dd=first, feeds=[F],
                    status="agreed", order_pulls=pulls_all, asof="2026-10-06")
check(next(v for v in e["months"] if v["m"] == "2026-09")["score"] == 100,
      "every day's order emails read: September still scores")
e, _ = T.kr3_months(orders, goods_s, cov, "2026-10", mvar, score, rag, first_dd=first, feeds=[F],
                    status="agreed", order_pulls=pulls_gap, asof="2026-10-06")
sv = next(v for v in e["months"] if v["m"] == "2026-09")
check(sv["score"] is None and sv["incomplete"] and "order emails of 9 day(s) were never read (09/09, 10/09" in sv["basis"],
      f"no pull of 'Kobas Orders' 10-30/09: each pull reads 14 days back, so the 01/10 pull reaches 18/09 "
      f"and the emails of 09-17/09 were never read - September is INCOMPLETE and unscored")
# the stale gap compares with the BAKE's date, not the month: a daily report
# read on 01/11 (covering to 31/10) is not stale; one that stopped mid-month is
cov_oct = list(days("2026-09-20", "2026-10-31"))
_, gp = T.kr3_months(orders, goods_s, cov_oct, "2026-11", mvar, score, rag, first_dd=first, feeds=[F],
                     status="agreed", asof="2026-11-01")
check(not any("covers goods-ins to" in x for x in gp), "01/11, report covering to 31/10: no stale gap")
_, gp = T.kr3_months(orders, goods_s, list(days("2026-09-20", "2026-10-15")), "2026-10", mvar, score, rag,
                     first_dd=first, feeds=[F], status="agreed", asof="2026-10-25")
check(any("covers goods-ins to 15/10/2026 only" in x and "rolling window of at least 7 days" in x for x in gp),
      "25/10, report stopped at 15/10: the gap names it and what Kobas must send")
e, gp = T.kr3_months(orders, goods_s, [], "2026-10", mvar, score, rag, first_dd=first, feeds=[F], asof="2026-10-25")
check(any("no copy of the Kobas deliveries report covers a whole day" in x for x in gp)
      and "rolling window of at least 7 days" in next(v for v in e["months"] if v["m"] == "2026-09")["not_measured"],
      "a report that covers no whole day (e.g. a one-day window): the row and the gap say what is needed")
e, _ = T.kr3_months([o(f"O{d}", d) for d in OCT], [g(f"h{d}", d) for d in OCT], list(days("2026-09-25", "2026-10-12")),
                    "2026-10", mvar, score, rag, first_dd=first, feeds=[F], asof="2026-10-13")
ov = next(v for v in e["months"] if v["m"] == "2026-10")
check(ov["display"].endswith("- not scored") and ov["score"] is None,
      "the open month under a proposed window also reads '- not scored'")

# ---- 2. the real builder over a synthetic archive ----------------------------
btmp = tempfile.mkdtemp(prefix="oo4kr3-")
wd = os.path.join(btmp, "warehouse_direct")


def put(pull, slug, feed, rows_):
    pdir = os.path.join(wd, pull)
    os.makedirs(pdir, exist_ok=True)
    with gzip.open(os.path.join(pdir, slug + ".jsonl.gz"), "wt") as fh:
        for i, row in enumerate(rows_):
            fh.write(json.dumps({"row_num": i, "data": row}) + "\n")
    fp = os.path.join(pdir, "_feeds.json")
    mm = json.load(open(fp)) if os.path.exists(fp) else {}
    mm[slug] = feed
    json.dump(mm, open(fp, "w"))


SUPS = ("LWC London", "LWC Doncaster")
ORD = [{"Order Ref": f"3031/{s[4]}{d}", "Supplier": s, "Site": "Maki Test", "Delivery Date ISO": d,
        "Order Email Date": add(d, -1), "Order Value GBP": "100", "Line Items": "3",
        "Items Ordered": "10", "Order Placed At": add(d, -1) + "T08:00:00+00:00", "Created By": "A Person"}
       for d in days("2026-09-01", "2026-11-06") for s in SUPS]
MISSED = {"3031/L2026-10-07", "3031/D2026-10-14", "3031/L2026-10-21"}
GIN = []
for i, r in enumerate(ORD):
    if r["Order Ref"] in MISSED:
        continue
    d = r["Delivery Date ISO"]
    late = r["Order Ref"] == "3031/D2026-10-20"          # booked a week late, ref typed on it
    bd = add(d, 7) if late else d
    GIN.append({"Venue": "Maki Test", "Supplier": r["Supplier"], "Kobas ID": 50000 + i,
                "Delivery Date": bd, "Created": bd + " 10:00:00", "Last Modified": bd + " 10:00:00",
                "Invoice Number": r["Order Ref"] if late else None, "status": "Active",
                "Total (Net)": 100.0, "Total (Gross)": 120.0})
GIN.append(dict(GIN[0], **{"Kobas ID": 59999, "Delivery Date": "2026-10-28", "Created": "2026-10-28 10:00:00",
                           "Last Modified": "2026-10-28 11:00:00", "status": "Deleted",
                           "Supplier": "LWC London"}))
receipts = []
for p in days("2026-09-01", "2026-11-04"):
    put(p, "Kobas_Orders", "Kobas Orders", [r for r in ORD if add(p, -14) <= r["Order Email Date"] < p])
    win = [x for x in GIN if add(p, -8) <= x["Last Modified"][:10] <= add(p, -1)]
    if p == "2026-10-16":
        continue                          # no export that day: no report, no receipt
    put(p, "Kobas_Report_Daily_Ops_Deliveries", F, win)
    receipts.append({"pull_date": p, "feeds": {F: {"report_sent_at": p + "T07:02:00+00:00",
                                                   "rows_fetched": len(win)}}})
os.makedirs(os.path.join(btmp, "run_log"))
with open(os.path.join(btmp, "run_log", "etl_run_log.jsonl"), "w") as fh:
    for r in receipts:
        fh.write(json.dumps(r) + "\n")
out = os.path.join(btmp, "out")
os.makedirs(out)
shutil.copy(os.path.join(REPO, "data", "ops_command", "feeds_manifest.json"), out)
env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=wd, OPS_OUT_DIR=out)
env.pop("OPS_RUN_LOG", None)
p = subprocess.run([sys.executable, os.path.join(REPO, "builders", "bake_ops_command.py"),
                    "--date", "2026-11-04"], env=env, capture_output=True, text=True)
check(p.returncode == 0, "the real builder bakes the fixture as of 04/11/2026"
      + ("" if p.returncode == 0 else ": " + p.stderr[-2000:]))
if p.returncode == 0:
    snap = json.load(open(os.path.join(out, "snapshot_2026-11-04.json")))
    row = next(r for r in snap["scorecard"]["rows"] if (r["objective"], r["kr"]) == ("OO4", "KR3"))
    mv = {v["m"]: v for v in row["months"] or []}
    oc = mv.get("2026-10", {})
    check(oc.get("value") == 95.1 and (oc.get("display") or "").startswith("95.1% (59 of 62)"),
          f"OO4 KR3 October: 59 of 62 orders have a goods-in (3 never booked; the one booked a week "
          f"late pairs by the ref typed on it) (got {oc.get('display')})")
    check(oc.get("score") is None and oc.get("incomplete") and "proposed, not agreed" in (oc.get("basis") or ""),
          "...shown but not scored: the window is proposed")
    check("(1 by the order ref typed on the goods-in)" in (oc.get("basis") or "")
          and "LWC London 2" in oc["basis"] and "LWC Doncaster 1" in oc["basis"]
          and "1 goods-in is marked Deleted" in oc["basis"],
          "...its basis names the exact link, the misses per supplier and the Deleted goods-in")
    check("A Person" not in json.dumps(row), "no staff name from 'Created By' reaches the KR3 row")
    check(row["tab"] == "p-supp" and row["source_kind"] == "computed", "the row drills to the Supply tab")
    sp = mv.get("2026-09", {})
    check(sp.get("value") is None or sp.get("score") is None, "September is never scored either")
    nv = mv.get("2026-11", {})
    check(nv.get("mtd") and nv.get("score") is None, "November: month to date, unscored")
    oo4 = next(x for x in snap["scorecard"]["objectives"] if x["objective"] == "OO4")
    oct4 = next(x for x in oo4["months"] if x["m"] == "2026-10")
    check(all(r_["score"] is None for r_ in snap["scorecard"]["rows"]
              if (r_["objective"], r_["kr"]) == ("OO4", "KR3")) and oct4["scored"] <= 4,
          "an unscored KR3 never enters OO4's roll-up")

    print("\n-- the verifier's recompute (check 4b) --")
    import verify_ops_data as vod
    vod.OUT_DIR = out
    vod.RESULTS.clear()
    vod.fetch_json = lambda *a, **k: (_ for _ in ()).throw(OSError("offline in tests"))
    os.environ.update(OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=wd)
    os.environ.pop("OPS_RUN_LOG", None)
    rc = vod.check_consistency("2026-11-04", "2026-11-04")
    bad = [r["detail"] for r in vod.RESULTS if r["check"] == "4b-consistency"
           and ("recompute failed" in r["detail"] or "could not run" in r["detail"])]
    check(rc is not None and not bad, "the recompute runs with delivery_tracking.py copied" + (f": {bad}" if bad else ""))
    if rc:
        r3 = next(r for r in rc["scorecard"]["rows"] if (r["objective"], r["kr"]) == ("OO4", "KR3"))
        o3 = next((v for v in r3["months"] or [] if v["m"] == "2026-10"), {})
        check(o3.get("value") == 95.1, f"...and gets the same October figure (got {o3.get('value')})")

shutil.rmtree(btmp, ignore_errors=True)
print()
print("all assertions passed" if not failures else f"{failures} assertion(s) FAILED")
sys.exit(1 if failures else 0)
