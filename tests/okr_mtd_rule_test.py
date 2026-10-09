#!/usr/bin/env python3
"""The month-to-date rule on the OKR scorecard (Ross, 09/10/2026).

A per-month KR scores ONLY when its month is closed OR the month already holds
>= OKR_MTD_MIN_DAYS (7) days of the KR's own source data. Otherwise its value is
shown with an "MTD" suffix, score and RAG are null, the basis says
"month-to-date, not yet scored (n days of data)", and the objective % leaves
the row out. On 01/10/2026 OO3 KR4 read 100% / score 100 / green from one day
of October; this is the rule that stops that.

Runs the REAL builder over a hand-built archive of factory broth readings -
the cleanest monthly KR to drive, because its "days of data" is the number of
production days with a graded reading:
  * Tonkotsu: September (closed, 3 production days) and October (3 days)
  * Chicken:  October only, 8 production days
baked as of 2026-10-09. So:
  * Tonkotsu September is CLOSED  -> scored despite only 3 days
  * Tonkotsu October has 3 days   -> MTD, unscored, value still shown
  * Chicken October has 8 days    -> scored
  * the OO5 objective % for October is Chicken's score alone, "1 of 5"
And the fallback this replaces: a monthly KR with no figure at all for the
pull month must not wear the previous month's figure under this month's name.

  python3 tests/okr_mtd_rule_test.py      (exit 1 on any failure)
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

failures = 0


def check(cond, msg):
    global failures
    print(("ok  : " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


def reading(day, product, after, batch="B"):
    dd, mm, yyyy = day[8:10], day[5:7], day[:4]
    return {"Timestamp": f"{dd}/{mm}/{yyyy} 18:00:00", "Date": f"{dd}/{mm}/{yyyy}",
            "Batch Number": batch + day.replace("-", ""), "Product Name": product,
            "Reading Before Adding Ice": "9", "Reading After Adding Ice": after}


ROWS = (
    # Tonkotsu, band 8-9: September 3 days in band; October 3 days OUT of band
    [reading(d, "Tonkotsu Broth", "8.5") for d in ("2026-09-08", "2026-09-15", "2026-09-22")]
    + [reading(d, "Tonkotsu Broth", "6.0") for d in ("2026-10-01", "2026-10-02", "2026-10-05")]
    # Chicken, band 5-6: 8 production days in October, in band
    + [reading(f"2026-10-0{i}", "Chicken Broth", "5.5") for i in range(1, 9)]
)

check(bake.OKR_MTD_MIN_DAYS == 7, "the threshold is 7 days")

tmp = tempfile.mkdtemp(prefix="okrmtd-")
arch = os.path.join(tmp, "warehouse_direct", "2026-10-09")
os.makedirs(arch)
with gzip.open(os.path.join(arch, "Factory_Broth_Readings.jsonl.gz"), "wt") as fh:
    for i, r in enumerate(ROWS):
        fh.write(json.dumps({"row_num": i, "data": r}) + "\n")
json.dump({"Factory_Broth_Readings": "Factory Broth Readings"}, open(os.path.join(arch, "_feeds.json"), "w"))
out = os.path.join(tmp, "out")
os.makedirs(out)
shutil.copy(os.path.join(REPO, "data", "ops_command", "feeds_manifest.json"), out)
env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive",
           OPS_ARCHIVE_DIR=os.path.join(tmp, "warehouse_direct"), OPS_OUT_DIR=out)
p = subprocess.run([sys.executable, BUILDER, "--date", "2026-10-09"], env=env,
                   capture_output=True, text=True)
check(p.returncode == 0, "the real builder bakes the fixture")
if p.returncode != 0:
    print(p.stdout[-2000:], p.stderr[-2000:])
    sys.exit(1)
snap = json.load(open(os.path.join(out, "snapshot_2026-10-09.json")))
sc = snap["scorecard"]
rows = {(r["objective"], r["kr"]): r for r in sc["rows"]}
tonk, chick = rows[("OO5", "KR1")], rows[("OO5", "KR2")]
tv = {v["m"]: v for v in tonk["months"]}
cv = {v["m"]: v for v in chick["months"]}

print("\n-- a closed month is always scored --")
check(tv["2026-09"]["score"] == 100 and tv["2026-09"]["rag"] == "green",
      f"Tonkotsu September, 3 production days but CLOSED: scored 100 (got {tv['2026-09']['score']})")
check(not tv["2026-09"].get("mtd"), "and not flagged MTD")

print("\n-- an open month under 7 days of data: shown, not scored --")
t10 = tv["2026-10"]
check(t10["value"] == 6.0, f"Tonkotsu October keeps its value, 6.0 (got {t10['value']})")
check(t10["score"] is None and t10["rag"] is None,
      f"score and RAG are null - an out-of-band 6.0 is NOT scored 0 on 3 days (got {t10['score']}, {t10['rag']})")
check(t10.get("mtd") is True and t10.get("coverage_days") == 3, "flagged mtd, with 3 days of data")
check(t10["display"].endswith(" MTD"), f"display carries the MTD suffix (got {t10['display']!r})")
check(t10["basis"].startswith("month-to-date, not yet scored (3 days of data)"),
      f"basis opens with the rule's own words (got {t10['basis'][:60]!r})")
check(tonk["value"] == 6.0 and tonk["score"] is None and tonk.get("mtd") is True,
      "the row's default (October) figure is the MTD one")

print("\n-- an open month with >= 7 days: scored --")
c10 = cv["2026-10"]
check(c10["score"] == 100 and c10.get("mtd") is False and c10.get("coverage_days") == 8,
      f"Chicken October, 8 production days: scored 100, not MTD (got {c10['score']}, {c10.get('mtd')}, {c10.get('coverage_days')})")
check(not c10["display"].endswith("MTD"), "no MTD suffix once scored")

print("\n-- the objective % leaves the MTD row out --")
oo5 = next(o for o in sc["objectives"] if o["objective"] == "OO5")
o10 = next(x for x in oo5["months"] if x["m"] == "2026-10")
check(o10["pct"] == 100.0 and o10["scored"] == 1,
      f"OO5 October = Chicken alone, 100% over 1 scored (got {o10['pct']} over {o10['scored']})")
o09 = next(x for x in oo5["months"] if x["m"] == "2026-09")
check(o09["pct"] == 100.0 and o09["scored"] == 1, "OO5 September = Tonkotsu's closed month")
check(sc["scored"] == sum(1 for r in sc["rows"] if r["score"] is not None),
      "scorecard.scored counts only rows that carry a score")
check(sc.get("mtd_min_days") == 7 and "SCORED only once it holds 7" in sc.get("month_basis", ""),
      "the rule is published with the scorecard")

print("\n-- no month borrows another month's figure --")
# Chicken has no September at all: the picker month must read empty, not October's.
check("2026-09" not in cv, "Chicken has no September variant to borrow from")
check(all(v["m"] <= "2026-10" for v in tonk["months"]), "no variant after the bake month")
# Rebake with the clock moved into November and no November readings: the
# default month (November) has no variant, and the row must say so rather than
# showing October's figure as November's (the old months[-1] fallback).
arch2 = os.path.join(tmp, "warehouse_direct", "2026-11-03")
shutil.copytree(arch, arch2)
p = subprocess.run([sys.executable, BUILDER, "--date", "2026-11-03"], env=env,
                   capture_output=True, text=True)
check(p.returncode == 0, "rebakes as of 2026-11-03")
if p.returncode == 0:
    s2 = json.load(open(os.path.join(out, "snapshot_2026-11-03.json")))["scorecard"]
    ch2 = next(r for r in s2["rows"] if (r["objective"], r["kr"]) == ("OO5", "KR2"))
    check(ch2["value"] is None and ch2["score"] is None,
          f"November with no readings: no value, no score - not October's 5.5 (got {ch2['value']}, {ch2['score']})")
    check(ch2.get("mtd") is True and "0 days of data" in (ch2.get("basis") or ""),
          "and it says 0 days of data")
    nov = next((v for v in ch2["months"] if v["m"] == "2026-11"), None)
    check(nov is not None and nov["value"] is None,
          "the picker's November entry exists and is empty")
    o2 = next(o for o in s2["objectives"] if o["objective"] == "OO5")
    check(o2["pct"] is None and o2["scored"] == 0, "OO5 November: nothing scored, so '—', never 0")
    oct_ = next(v for v in ch2["months"] if v["m"] == "2026-10")
    check(oct_["score"] == 100 and not oct_.get("mtd"), "October, now closed, is scored")

shutil.rmtree(tmp, ignore_errors=True)
print()
if failures:
    print(f"{failures} assertion(s) FAILED")
    sys.exit(1)
print("all assertions passed")
