#!/usr/bin/env python3
"""Days no pull of the issue feed ever saw (10/10/2026).

The GC answer feed reaches back about eight days per pull, so the 21-30/09
outage left 20-22/09 covered by NO pull. The review of the 2-8 Oct back-bakes
found September scored as a full month regardless: OO3 KR4 divided issues
from 27 days by deliveries from 30 and read 95.1% (100, green), KR1 called
September complete, and - from the other side - KR1's coverage notes were
built from the newest supplier-ISSUE date, so a quiet day read as "missing".
The Overview tile and Supplier Issues card also showed a green "On target"
for an October count the scorecard called not yet scored.

This bakes a hand-built archive with exactly that shape and pins:
  * gc_feed_holes = 20-22/09, named in the gaps;
  * suppliers.kr1: September undercount/incomplete with its holes; a real
    October entry (MTD, rag None) even with no issue in it; coverage notes
    driven by the feed's reach, not by the newest issue;
  * over-target counts stay red (final), under-target open or incomplete
    months are rag None - never green early;
  * OO3 KR1 September unscored as an incomplete month (12 is under the last
    tolerance, so the hole could still change it); OO3 KR4 September a rate
    over the covered days only, with the left-out deliveries named;
  * coverage_days net of the hole;
  * the OO5 broth basis discloses readings taken before the band was agreed.

  python3 tests/issue_feed_holes_test.py      (exit 1 on any failure)
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
BUILDER = os.path.join(REPO, "builders", "bake_ops_command.py")
failures = 0


def check(cond, msg):
    global failures
    print(("ok  : " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


def days(a, b):
    x, y = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
    while x <= y:
        yield x.isoformat()
        x += dt.timedelta(days=1)


# Supplier issue forms (template names a supplier/delivery), answered on these
# days - 12 in September, none on 20-22/09 (nobody could see them), none in
# October so far.
ISSUE_DAYS = ["2026-09-02", "2026-09-03", "2026-09-05", "2026-09-08", "2026-09-10", "2026-09-12",
              "2026-09-15", "2026-09-17", "2026-09-19", "2026-09-24", "2026-09-26", "2026-09-29"]


def answers(lo, hi):
    """One pull of GC Form Task Answers: a routine form every day in [lo, hi],
    plus the supplier-issue forms answered in that window."""
    out = []
    for d in days(lo, hi):
        out.append({"FormId": f"R{d}", "TaskID": "1", "FormTemplateName": "Opening Checks",
                    "TaskName": "Fridge temp?", "Answer": "3", "LocationNameLabel": "Maki Test",
                    "AnsweredDateTime": d + "T09:00:00", "IsOpenDeviation": "false", "AnswerID": f"A{d}"})
        if d in ISSUE_DAYS:
            for t, (task, ans) in enumerate([("Supplier?", "Lynas"), ("Issue?", "short delivery")]):
                out.append({"FormId": f"I{d}", "TaskID": str(t), "FormTemplateName": "Delivery/Supplier Issue",
                            "TaskName": task, "Answer": ans, "LocationNameLabel": "Maki Test",
                            "AnsweredDateTime": d + "T11:00:00", "IsOpenDeviation": "true",
                            "AnswerID": f"I{d}-{t}"})
    return out


# pull date -> answer window (each ~8 days, like the real feed); 21-30/09 none.
GC_PULLS = {"2026-09-09": ("2026-09-01", "2026-09-08"), "2026-09-17": ("2026-09-09", "2026-09-16"),
            "2026-09-20": ("2026-09-12", "2026-09-19"), "2026-10-01": ("2026-09-23", "2026-09-30"),
            "2026-10-02": ("2026-09-24", "2026-10-01")}
# Lynas delivers every day in September and October; order emails reach back.
ORDERS = [{"Order Ref": f"O{d}", "Supplier": "Lynas", "Site": "Maki Test", "Delivery Date ISO": d,
           "Order Email Date": d, "Order Value GBP": "100", "Line Items": "3", "Items Ordered": "10",
           "Order Placed At": d + "T06:00:00"} for d in days("2026-09-01", "2026-10-04")]
BROTH = [{"Timestamp": f"{d[8:]}/{d[5:7]}/{d[:4]} 18:00:00", "Date": f"{d[8:]}/{d[5:7]}/{d[:4]}",
          "Batch Number": "B" + d, "Product Name": "Chicken Broth", "Reading Before Adding Ice": "7",
          "Reading After Adding Ice": "5.5"} for d in ("2026-08-20", "2026-08-25", "2026-08-26", "2026-09-03")]

tmp = tempfile.mkdtemp(prefix="holes-")
wd = os.path.join(tmp, "warehouse_direct")


def put(pull, slug, feed, rows):
    pdir = os.path.join(wd, pull)
    os.makedirs(pdir, exist_ok=True)
    with gzip.open(os.path.join(pdir, slug + ".jsonl.gz"), "wt") as fh:
        for i, r in enumerate(rows):
            fh.write(json.dumps({"row_num": i, "data": r}) + "\n")
    fp = os.path.join(pdir, "_feeds.json")
    m = json.load(open(fp)) if os.path.exists(fp) else {}
    m[slug] = feed
    json.dump(m, open(fp, "w"))


for p, (lo, hi) in GC_PULLS.items():
    put(p, "GC_Form_Task_Answers", "GC Form Task Answers", answers(lo, hi))
put("2026-10-02", "Kobas_Orders", "Kobas Orders", ORDERS)
put("2026-10-02", "Factory_Broth_Readings", "Factory Broth Readings", BROTH)
out = os.path.join(tmp, "out")
os.makedirs(out)
shutil.copy(os.path.join(REPO, "data", "ops_command", "feeds_manifest.json"), out)
env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=wd, OPS_OUT_DIR=out)
p = subprocess.run([sys.executable, BUILDER, "--date", "2026-10-02"], env=env, capture_output=True, text=True)
check(p.returncode == 0, "the real builder bakes the fixture as of 02/10")
if p.returncode != 0:
    print(p.stdout[-1500:], p.stderr[-2500:])
    sys.exit(1)
snap = json.load(open(os.path.join(out, "snapshot_2026-10-02.json")))

print("\n-- the hole --")
check(any("No pull of the GC answer feed covers 20-22 Sep 2026" in g for g in snap["gaps"]),
      "the gaps name the days no pull of the answer feed covers: 20-22 Sep 2026")

print("\n-- suppliers.kr1 (the tile and the Supplier Issues card) --")
km = {m["month"]: m for m in snap["suppliers"]["kr1"]["months"]}
sep, oct_ = km.get("2026-09"), km.get("2026-10")
check(sep and sep["issues"] == 12 and sep["holes"] == ["2026-09-20", "2026-09-21", "2026-09-22"]
      and sep["undercount"] and sep["incomplete"] and not sep["mtd"],
      f"September: 12 issues, its three uncovered days, an incomplete closed month (got {sep and {k: sep[k] for k in ('issues', 'holes', 'undercount', 'incomplete')}})")
check(sep["rag"] == "red", "12 is over the target of 10 - red, and final, hole or no hole")
check("no pull of the answer feed covers 20-22 Sep 2026" in (sep["coverage_note"] or "")
      and "first answer" not in (sep["coverage_note"] or ""),
      "its note names the hole - from the feed's reach, not from the first issue form")
check(sep["coverage_days"] == 27, f"September has 27 covered days (got {sep['coverage_days']})")
check(oct_ is not None and oct_["issues"] == 0 and oct_["mtd"] and oct_["rag"] is None
      and oct_["coverage_days"] == 1,
      f"October has its own entry - 0 so far, month to date, NOT green (got {oct_})")
check("the answer feed reaches 2026-10-01" in (oct_["coverage_note"] or "")
      and "nothing before it is in range" not in (oct_["coverage_note"] or ""),
      "and its note says how far the feed reaches; a quiet 1 Oct is not 'out of range'")
check(snap["suppliers"]["kr1"]["months"][-1]["month"] == "2026-10",
      "the newest month is the pull month, so 'this month' never shows September's figure")

print("\n-- OO3 KR1 and KR4 on the scorecard --")
rows = {(r["objective"], r["kr"]): r for r in snap["scorecard"]["rows"]}
k1 = {v["m"]: v for v in rows[("OO3", "KR1")]["months"]}
check(k1["2026-09"]["score"] is None and k1["2026-09"].get("incomplete")
      and k1["2026-09"]["display"] == "12+" and "INCOMPLETE month" in k1["2026-09"]["basis"],
      f"KR1 September (12, under the last tolerance of 40) is NOT scored - the hole could still change it (got {k1['2026-09'].get('score')}, {k1['2026-09'].get('display')})")
check(k1["2026-10"]["mtd"] and k1["2026-10"]["score"] is None and k1["2026-10"]["coverage_days"] == 1,
      "KR1 October: 0 on one day of data, MTD")
ot = {m["month"]: m for m in snap["supply"]["otif"]["months"]}
s_ot = ot["2026-09"]
check(s_ot["deliveries_in_feed_holes"] == 3 and s_ot["feed_holes"] == ["2026-09-20", "2026-09-21", "2026-09-22"],
      f"KR4: the three deliveries on 20-22/09 are left out and counted as such (got {s_ot.get('deliveries_in_feed_holes')})")
check(s_ot["deliveries"] == 27 and s_ot["issues"] == 12 and s_ot["otif_pct"] == round(100 * 15 / 27, 1),
      f"September's rate is 15 of the 27 covered days' deliveries (got {s_ot['deliveries']}, {s_ot['otif_pct']})")
k4 = {v["m"]: v for v in rows[("OO3", "KR4")]["months"]}
check("3 deliveries on 20-22 Sep 2026 are LEFT OUT" in (k4["2026-09"]["basis"] or ""),
      "and the KR4 September basis says which deliveries were left out and why")
check(k4["2026-09"]["score"] is not None, "a rate over the covered days is still scored (27 days >= 7)")

print("\n-- OO5: readings taken before the band was agreed --")
b5 = {v["m"]: v for v in rows[("OO5", "KR2")]["months"]}
check("ALL of this month's 3 reading(s) were taken before 2026-08-27" in (b5["2026-08"]["basis"] or ""),
      "August's chicken broth basis says every reading predates the band agreed on 27/08")
check("taken before 2026-08-27" not in (b5["2026-09"]["basis"] or ""),
      "September's does not - its readings follow the band")

shutil.rmtree(tmp, ignore_errors=True)
print()
if failures:
    print(f"{failures} assertion(s) FAILED")
    sys.exit(1)
print("all assertions passed")
