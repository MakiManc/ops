#!/usr/bin/env python3
"""
Fixture test for supplier attribution and the KR2 spike count (16/09/2026).

Runs the REAL builder over a hand-built archive of two price reports and two
pack-price exports, and asserts the per-supplier spike count that must come out
of it. Synthetic on purpose: against live data every number moves when an
export lands, so the exclusions - which are the whole point of the measure -
could only be spot-checked, never pinned.

Every row below exists to exercise one branch, and the comment on it says
which. If you change a threshold, this file is where the change announces
itself.

  python3 tests/price_spike_attribution_test.py      (exit 1 on any failure)
"""
from __future__ import annotations

import gzip
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BUILDER = os.path.join(REPO, "builders", "bake_ops_command.py")

PRICE_FEED = "Kobas Report - Weekly Ingredient Price Changes Report"
PACK_FEED = "Kobas Pack Prices"
PRICE_SLUG = "Kobas_Report_Weekly_Ingredient_Price_Changes_Report"
PACK_SLUG = "Kobas_Pack_Prices"

failures = 0


def check(cond, msg):
    global failures
    if cond:
        print("ok  :", msg)
    else:
        failures += 1
        print("FAIL:", msg)


def pack(iid, sup, name, ps, uv, price, code=None, cat="DRY STORE"):
    return {"Ingredient Id": iid, "Supplier Name": sup,
            "Ingredient Category Name": cat, "Ingredient Name": name,
            "Supplier Code": code or "", "Pack Size": ps, "Unit Volume": uv,
            "Current Price": price, "New Price": ""}


def change(pid, name, ps, uv, old, new, ms="Grams"):
    return {"Parent ID": pid, "Ingredient Name": name, "Pack Size": float(ps),
            "Unit Volume": uv, "Measurement": ms,
            "Old Price": old, "New Price": new}


# -- the pack-price export, 05/01 ----------------------------------------
# Note the ids are nowhere near the Parent IDs below, on purpose: the two are
# different namespaces in the real data and a fixture that let them line up
# would quietly re-admit the join that does not exist.
EXPORT_A = [
    pack(101, "Alpha Foods", "WIDGET", 1, 1000, "10.00", "A1"),    # sole supplier
    pack(102, "Beta Supply", "GADGET", 2, 500, "20.00", "B1"),     # shared pack...
    pack(103, "Alpha Foods", "GADGET", 2, 500, "10.00", "A2"),     # ...price tells them apart
    pack(104, "Gamma Ltd", "DOODAD", 1, 250, "5.00", "G1"),        # a real duplicate:
    pack(105, "Gamma Ltd", "DOODAD", 1, 250, "6.00", "G2"),        # two live lines, two codes
    pack(106, "Alpha Foods", "SPROCKET", 1, 50, "8.00", "A3"),     # moves between exports
    pack(107, "Alpha Foods", "TRINKET", 1, 100, "3.00", "A4"),     # shared pack, and neither
    pack(108, "Beta Supply", "TRINKET", 1, 100, "4.00", "B2"),     # is at either price
    pack(109, "Alpha Foods", "COG", 1, 10, "2.00", "A5"),
    pack(110, "Alpha Foods", "BOLT", 1, 20, "1.00", "A6"),
    pack(111, "Beta Supply", "SPANNER", 1, 5, "7.00", "S100"),     # punctuated code twins
    pack(112, "Beta Supply", "SPANNER", 1, 5, "7.00", "S100."),    # -> collapsed, not a dupe
    pack(113, "Alpha Foods", "GROMMET", 1, 2, "0", "A7"),          # 0.00 placeholder line
]
# -- the same export a week later: SPROCKET is the only thing that moved --
EXPORT_B = [dict(r, **({"Current Price": "10.00"} if r["Ingredient Id"] == 106 else {}))
            for r in EXPORT_A]

# -- price report, 08/01 -------------------------------------------------
REPORT_1 = [
    change(9001, "WIDGET", 1, 1000, 10.00, 12.00),    # +20%  -> Alpha, route 'unique'
    change(9002, "GADGET", 2, 500, 20.00, 24.00),     # +20%  -> Beta, route 'price'
    change(9003, "DOODAD", 1, 250, 5.00, 7.00),       # +40%  -> Gamma, but DUPLICATE: dropped
    change(9004, "TRINKET", 1, 100, 9.00, 11.00),     # +22%  -> nobody: unattributed
    change(9005, "COG", 1, 10, 2.00, 2.40),           # +20%  -> Alpha
    change(9006, "BOLT", 1, 20, 1.00, 1.10),          # +10.0% exactly - the boundary counts
    change(9007, "SPANNER", 1, 5, 7.00, 9.00),        # +28.6% -> Beta (twins collapsed to one)
    change(9008, "GROMMET", 1, 2, 0.00, 4.00),        # priced 0.00 either side: dropped
]
# -- price report, 15/01 -------------------------------------------------
REPORT_2 = [
    change(9009, "SPROCKET", 1, 50, 8.00, 10.00),     # +25%  -> Alpha, route 'diff'
    change(9001, "WIDGET", 1, 1000, 12.00, 12.60),    # +5%   - under the bar, not a spike
    change(9002, "GADGET", 2, 500, 24.00, 60.00),     # +150% - suspect band, dropped
    change(9010, "NEWTHING", 1, 1, "New", 5.00, "Items"),   # a first price is not a rise
]

PULLS = {
    "2026-01-05": {PACK_SLUG: EXPORT_A},
    "2026-01-08": {PRICE_SLUG: REPORT_1},
    "2026-01-12": {PACK_SLUG: EXPORT_B},
    "2026-01-15": {PRICE_SLUG: REPORT_2},
}


def write_archive(root: str) -> None:
    for pull_date, feeds in PULLS.items():
        d = os.path.join(root, pull_date)
        os.makedirs(d, exist_ok=True)
        for slug, rows in feeds.items():
            with gzip.open(os.path.join(d, slug + ".jsonl.gz"), "wt") as fh:
                for i, r in enumerate(rows):
                    fh.write(json.dumps({"row_num": i, "data": r},
                                        ensure_ascii=False) + "\n")
        with open(os.path.join(d, "_feeds.json"), "w", encoding="utf-8") as fh:
            json.dump({PRICE_SLUG: PRICE_FEED, PACK_SLUG: PACK_FEED}, fh)


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="spikefix-")
    archive = os.path.join(tmp, "warehouse_direct")
    write_archive(archive)
    out = os.path.join(tmp, "out")
    os.makedirs(out, exist_ok=True)
    # The builder reads its manifest from the repo's data dir; point OUT_DIR at
    # a temp dir so the test can never overwrite a real snapshot, and copy the
    # manifest in so the archive adapter still resolves feed names.
    import shutil
    shutil.copy(os.path.join(REPO, "data", "ops_command", "feeds_manifest.json"), out)
    env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=archive,
               OPS_OUT_DIR=out)
    p = subprocess.run([sys.executable, BUILDER, "--date", "2026-01-15"],
                       env=env, capture_output=True, text=True)
    if p.returncode != 0:
        print("builder failed:\n", p.stdout[-3000:], p.stderr[-3000:])
        return 1
    with open(os.path.join(out, "snapshot_2026-01-15.json"), encoding="utf-8") as fh:
        snap = json.load(fh)

    supply = snap["supply"]
    att = supply.get("price_attribution") or {}
    spikes = supply.get("price_spikes") or {}
    by_sup = {r["supplier"]: r for r in (supply.get("spikes_by_supplier") or [])}

    print("\n-- attribution --")
    check(att.get("total") == 12,
          f"every priced report row is counted, including the ones later "
          f"excluded (got {att.get('total')})")
    # Six, not four: attribution runs on EVERY row, including the ones that go
    # on to fail the spike test. WIDGET appears in both reports, and DOODAD
    # resolves cleanly to Gamma - being a duplicated line disqualifies it from
    # the spike count, not from being attributed.
    check(att.get("by_route", {}).get("unique") == 6,
          f"sole-supplier rows: WIDGET twice, COG, BOLT, SPANNER and DOODAD "
          f"(got {att.get('by_route', {}).get('unique')})")
    # One, not two. GADGET's first move 20.00 -> 24.00 names Beta, who is at
    # 20.00. Its second, 24.00 -> 60.00, matches neither supplier's current
    # price, so the route declines rather than picking the likelier one.
    check(att.get("by_route", {}).get("price") == 1,
          f"only GADGET's 20.00 -> 24.00 resolves on price; its 24.00 -> 60.00 "
          f"matches no current price and is left unattributed "
          f"(got {att.get('by_route', {}).get('price')})")
    check(att.get("by_route", {}).get("diff") == 1,
          f"SPROCKET is proved from the two exports (got "
          f"{att.get('by_route', {}).get('diff')})")
    check(att.get("code_twins_collapsed") == 1,
          f"the S100 / S100. pair is collapsed to one line, not reported as a "
          f"duplicate (got {att.get('code_twins_collapsed')})")
    check(att.get("duplicates") == 1,
          f"the one GENUINE duplicate is Gamma's two DOODAD lines "
          f"(got {att.get('duplicates')})")
    check(att.get("zero_priced_lines") == 1,
          f"the 0.00 placeholder line is counted and set aside "
          f"(got {att.get('zero_priced_lines')})")

    print("\n-- spikes --")
    check(sorted(by_sup) == ["Alpha Foods", "Beta Supply"],
          f"only the two attributable suppliers appear; Gamma's duplicate is "
          f"not a supplier row (got {sorted(by_sup)})")
    check(by_sup.get("Alpha Foods", {}).get("spikes") == 4,
          f"Alpha: WIDGET, COG, BOLT and SPROCKET (got "
          f"{by_sup.get('Alpha Foods', {}).get('spikes')})")
    check(by_sup.get("Beta Supply", {}).get("spikes") == 2,
          f"Beta: GADGET and SPANNER (got "
          f"{by_sup.get('Beta Supply', {}).get('spikes')})")
    check(by_sup.get("Alpha Foods", {}).get("rag") == "red"
          and by_sup.get("Beta Supply", {}).get("rag") == "green",
          "over 3 is red and 3 or fewer is green, with no band in between")
    check(by_sup.get("Alpha Foods", {}).get("worst_pct") == 25.0,
          f"Alpha's worst move is SPROCKET at +25% (got "
          f"{by_sup.get('Alpha Foods', {}).get('worst_pct')})")
    check(spikes.get("duplicate_skipped") == 1,
          f"DOODAD is excluded for being a duplicated export line, and the "
          f"exclusion is counted rather than silent (got "
          f"{spikes.get('duplicate_skipped')})")
    check(spikes.get("unattributed") == 1,
          f"TRINKET qualifies as a rise but names no supplier, and is disclosed "
          f"rather than assigned (got {spikes.get('unattributed')})")

    cur = spikes.get("current") or {}
    check(cur.get("month") == "2026-01",
          f"the month is the report's calendar month (got {cur.get('month')})")
    check(cur.get("over") == 1 and cur.get("worst") == "Alpha Foods 4",
          f"one supplier is over target, and it is named with its count "
          f"(got over={cur.get('over')}, worst={cur.get('worst')})")

    print("\n-- the scorecard row stays gated --")
    kr2 = next((r for r in snap["scorecard"]["rows"]
                if r["kr"].startswith("KR2 price")), None)
    check(kr2 is not None, "the KR2 row is present")
    check(att.get("rate", 0) < att.get("min_pct", 90),
          f"this fixture attributes {att.get('rate')}%, under the bar - so the "
          "gated branch is what gets exercised here")
    check(kr2 and kr2["value"] is None and kr2["not_measured"]
          and str(att.get("rate")) in kr2["not_measured"],
          "under the bar the row is unmeasured and quotes the live rate")

    print("\n" + ("all assertions passed" if not failures
                  else f"{failures} assertion(s) FAILED"))
    shutil.rmtree(tmp, ignore_errors=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
