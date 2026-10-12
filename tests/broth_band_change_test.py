#!/usr/bin/env python3
"""The factory's tonkotsu band moves to 6-7 (Ross, 12/10/2026).

Ross, verbatim: "The new factory score for tonkotsu is between 6 and 7 as of
today onwards". Until then it was 8-9 (Ross, 27/08/2026); chicken stays 5-6.
What this pins:
  * a reading is graded against the band IN FORCE ON ITS OWN DATE - an 8.4 on
    09/10 is in band, an 8.5 on 15/10 is above it, a 6.5 on 12/10 is in band;
  * OO5 KR1's monthly mean is SPLIT at the change: October's two parts are
    each averaged against their own band and the month is scored on the
    reading-weighted distance outside band; September (one band) is untouched;
  * the row's target names the band in force and the one it replaced, while
    the KR text stays Matthew's verbatim;
  * the Quality KR's basis names October's bands with their dates;
  * a back-bake from before 12/10 never names 6-7 anywhere.

Runs the REAL builder over a hand-built archive (the okr_mtd_rule_test pattern).

  python3 tests/broth_band_change_test.py      (exit 1 on any failure)
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


print("-- the band in force on a day --")
T, C = "Tonkotsu Broth", "Chicken Broth"
check(bake.fb_band(T, "2026-10-11") == (8.0, 9.0), "tonkotsu on 11/10: 8-9")
check(bake.fb_band(T, "2026-10-12") == (6.0, 7.0), "tonkotsu from 12/10: 6-7 ('as of today onwards')")
check(bake.fb_band(T, "2025-08-20") == (8.0, 9.0), "tonkotsu before the 27/08 band: still 8-9 (FB_BAND_SET discloses it)")
check(bake.fb_band(C, "2026-10-12") == (5.0, 6.0) and bake.fb_band(C, "2025-01-01") == (5.0, 6.0),
      "chicken unchanged, 5-6")
check(bake.fb_band("Ikigai Chicken Broth", "2026-10-12") is None, "a product with no band still has none")
check([bake.fb_grade(T, v, d) for v, d in ((8.4, "2026-10-11"), (8.4, "2026-10-12"), (6.0, "2026-10-12"),
                                           (7.0, "2026-10-12"), (5.9, "2026-10-12"), (6.5, "2026-10-11"))]
      == ["in", "high", "in", "in", "low", "low"],
      "graded against the day's band, bounds inclusive")
check(bake.fb_bands_text("2026-10-01", "2026-10-31") == "tonkotsu 8-9 to 11/10/2026, 6-7 from 12/10/2026, chicken 5-6",
      "October's bands, dated")
check(bake.fb_bands_text("2026-09-01", "2026-09-30") == "tonkotsu 8-9, chicken 5-6", "September's: one band each")
check(bake.fb_bands_text("2026-11-01", "2026-11-30") == "tonkotsu 6-7, chicken 5-6", "November's: the new band only")
check("6-7" not in bake.fb_bands_text(None, "2026-10-11", sources=True),
      "as at 11/10 the 6-7 band does not exist yet")
check(bake.fb_bands_text(None, "2026-10-12", sources=True)
      == "tonkotsu 8-9 to 11/10/2026 (Ross, 27/08/2026), 6-7 from 12/10/2026 (Ross, 12/10/2026), "
         "chicken 5-6 (Ross, 27/08/2026)", "with who set each band")


def reading(day, product, after, batch="B"):
    dd, mm, yyyy = day[8:10], day[5:7], day[:4]
    return {"Timestamp": f"{dd}/{mm}/{yyyy} 18:00:00", "Date": f"{dd}/{mm}/{yyyy}",
            "Batch Number": batch + day.replace("-", ""), "Product Name": product,
            "Reading Before Adding Ice": "9", "Reading After Adding Ice": after}


ROWS = (
    [reading(d, T, "8.5") for d in ("2026-09-08", "2026-09-15", "2026-09-22")]
    # October to 11/10, against 8-9: all in band, mean 8.4
    + [reading(d, T, "8.4") for d in ("2026-10-01", "2026-10-05", "2026-10-09")]
    # October from 12/10, against 6-7: three in, two above; mean 7.3, 0.3 outside
    + [reading(d, T, v) for d, v in (("2026-10-12", "6.5"), ("2026-10-13", "6.5"), ("2026-10-14", "6.5"),
                                     ("2026-10-15", "8.5"), ("2026-10-16", "8.5"))]
    + [reading(f"2026-10-0{i}", C, "5.5") for i in range(1, 9)]
)


def bake_at(asof, rows):
    tmp = tempfile.mkdtemp(prefix="bandchg-")
    arch = os.path.join(tmp, "warehouse_direct", asof)
    os.makedirs(arch)
    with gzip.open(os.path.join(arch, "Factory_Broth_Readings.jsonl.gz"), "wt") as fh:
        for i, r in enumerate(rows):
            fh.write(json.dumps({"row_num": i, "data": r}) + "\n")
    json.dump({"Factory_Broth_Readings": "Factory Broth Readings"}, open(os.path.join(arch, "_feeds.json"), "w"))
    out = os.path.join(tmp, "out")
    os.makedirs(out)
    shutil.copy(os.path.join(REPO, "data", "ops_command", "feeds_manifest.json"), out)
    env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive",
               OPS_ARCHIVE_DIR=os.path.join(tmp, "warehouse_direct"), OPS_OUT_DIR=out)
    p = subprocess.run([sys.executable, BUILDER, "--date", asof], env=env, capture_output=True, text=True)
    check(p.returncode == 0, f"the real builder bakes the fixture as of {asof}")
    if p.returncode != 0:
        print(p.stdout[-2000:], p.stderr[-2000:])
        sys.exit(1)
    snap = json.load(open(os.path.join(out, f"snapshot_{asof}.json")))
    shutil.rmtree(tmp)
    return snap


print("\n-- a bake after the change (20/10/2026) --")
s = bake_at("2026-10-20", ROWS)
fac = s["quality"]["factory"]
by = {(r["d"], r["score"]): r for r in fac["readings"]}
check(by[("2026-10-09", 8.4)]["band"] == [8.0, 9.0] and by[("2026-10-09", 8.4)]["grade"] == "in",
      "09/10's 8.4 carries the 8-9 band it was read against, and is in band")
check(by[("2026-10-12", 6.5)]["band"] == [6.0, 7.0] and by[("2026-10-12", 6.5)]["grade"] == "in",
      "12/10's 6.5 carries 6-7 and is in band")
check(by[("2026-10-15", 8.5)]["grade"] == "high", "15/10's 8.5 is ABOVE the 6-7 band in force that day")
check(by[("2026-09-08", 8.5)]["grade"] == "in", "September is graded on 8-9 as before - never re-graded")
check(fac["bands"] == {T: [6.0, 7.0], C: [5.0, 6.0]}, "snapshot 'bands' is the band in force on the bake's date")
check([p["band"] for p in fac["band_history"][T]] == [[8.0, 9.0], [6.0, 7.0]]
      and fac["band_history"][T][0]["to"] == "2026-10-11" and fac["band_history"][T][1]["from"] == "2026-10-12",
      "band_history carries both tonkotsu bands with their dates")
check("6-7 from 12/10/2026 (Ross, 12/10/2026)" in fac["basis"], "the factory basis names the new band and who set it")

rows = {(r["objective"], r["kr"]): r for r in s["scorecard"]["rows"]}
k1, k2 = rows[("OO5", "KR1")], rows[("OO5", "KR2")]
V1 = {v["m"]: v for v in k1["months"]}
sep, octo = V1["2026-09"], V1["2026-10"]
check(sep["value"] == 8.5 and sep["score"] == 100 and "against a band of 8-9, inside band" in sep["basis"]
      and "CHANGED" not in sep["basis"] and "Matthew's sheet" not in sep["basis"],
      "September: one band, scored exactly as before")
check(octo["value"] == 7.3, f"October's value is the newest part's mean, 7.3 (got {octo['value']})")
check(octo["score"] == 80 and octo["rag"] == bake.OKR_RAG[80],
      f"October: weighted distance (0*3 + 0.3*5)/8 = 0.1875 outside band -> 80 (got {octo['score']})")
check(octo["display"] == "8.4 avg to 11/10 (band 8-9) · 7.3 avg from 12/10 (band 6-7) - 75.0% of 8 readings in band",
      f"the display names both parts (got {octo['display']!r})")
check("CHANGED during October 2026 - 8-9 to 11/10/2026 (Ross, 27/08/2026), 6-7 from 12/10/2026 (Ross, 12/10/2026)"
      in octo["basis"] and "0.1875" in octo["basis"] and "chicken" not in octo["basis"].lower(),
      "the basis says the band changed, how the month was split, and names only tonkotsu's bands")
check("('KR1: Maintain Pork broth density within 8-9')" in octo["basis"],
      "the basis quotes Matthew's KR text verbatim and says the band moved")
check(k1["text"] == "KR1: Maintain Pork broth density within 8-9", "the KR text is untouched")
check(k1["target"] == "6-7 from 12/10/2026 (8-9 before)", f"the target names both bands (got {k1['target']!r})")
check(k2["target"] == "5-6" and "CHANGED" not in k2["basis"], "chicken's KR2 is untouched")
check(octo.get("coverage_days") == 8 and octo.get("mtd") is False,
      "October holds 8 production days, so the month-to-date rule scores it")

qual = next(r for r in s["scorecard"]["operating_kpis"] if str(r.get("kr", "")).startswith("Broth conformance"))
Q = {v["m"]: v for v in qual["months"]}
check("(tonkotsu 8-9 to 11/10/2026, 6-7 from 12/10/2026, chicken 5-6) in October 2026" in Q["2026-10"]["basis"],
      "the Quality KR's October basis names the bands with their dates")
check("(tonkotsu 8-9, chicken 5-6) in September 2026" in Q["2026-09"]["basis"], "...and September's, one each")
check(Q["2026-10"]["display"] == "87.5%", f"October: 14 of 16 readings in their own day's band (got {Q['2026-10']['display']})")

print("\n-- a back-bake from before the change (11/10/2026) --")
early = [r for r in ROWS if r["Date"][6:] + r["Date"][3:5] + r["Date"][:2] <= "20261011"]
s0 = bake_at("2026-10-11", early)
f0 = s0["quality"]["factory"]
r0 = {(r["objective"], r["kr"]): r for r in s0["scorecard"]["rows"]}
blob = json.dumps({"factory": {k: f0[k] for k in ("bands", "band_history", "basis")},
                   "kr1": r0[("OO5", "KR1")]})
check("6-7" not in blob and "12/10/2026" not in blob, "no trace of the 6-7 band before it existed")
check(r0[("OO5", "KR1")]["target"] == "8-9", "the target is the sheet's own, 8-9")
check(f0["bands"] == {T: [8.0, 9.0], C: [5.0, 6.0]}, "bands as they stood on 11/10")

print(f"\n{failures} failure(s)")
sys.exit(1 if failures else 0)
