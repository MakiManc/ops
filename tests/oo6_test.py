#!/usr/bin/env python3
"""OO6, Frozen Ramen (Ross, 21/10/2026) - pinned.

Run:  python3 tests/oo6_test.py      (no network, no Google, no mailbox)

Part 1  frozen ramen by name (builders/frozen_ramen.py), and OO6 KR1's
        reference figure: the month's issue forms naming it, never scored.
Part 2  OO6 KR3: % of locations with a frozen-ramen count in the week, over
        EVERY location on the builder's list; a closed month with a week
        missing is shown, not scored; back-bakes; the copy's publication check.
Part 3  refresh_frozen_stock.py: the folder id, the header roles, CSV and xlsx
        parsed in memory, what is written (no quantity, no file name), fail
        soft, oldest-first batches, and Drive answers mapped to causes.
Part 4  the sheet: OO6 KR1's pinned cells and the invoiced yes/no - never
        requested until pinned, refused when the pin lands on another block.
Part 5  OO6 KR2: JFC's PO in full AND invoiced; a 'no' month is an upper bound.
Part 6  the real builder on a synthetic archive: OO6 scores, joins Operations,
        the verifier agrees, the NE1 label is Newcastle, a leak refuses the bake.
Part 7  Kobas's Stock Usage Comparison exported per restaurant (Ross,
        27/10/2026): the restaurant and the closing stock take's week from the
        file name, Closing Stock Units the count (0 counted), and closed months.
"""
import csv
import datetime as dt
import gzip
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import types

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "builders"))
import factory_kpis as fk  # noqa: E402
import frozen_ramen as fr  # noqa: E402
import refresh_frozen_stock as rfs  # noqa: E402
import refresh_okr_sources as ros  # noqa: E402
import refresh_factory_workbook as rfw  # noqa: E402
import bake_ops_command as bake  # noqa: E402

failures = 0


def check(cond, msg):
    global failures
    print(("ok  : " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


def mvar(m, **kw):
    return {"m": m, "label": fk.mlabel(m), "value": None, "display": None, "rag": None,
            "basis": None, "not_measured": None, **kw}


def score(band):
    return lambda v: bake.okr_score(band, v)


def rag(s):
    return {100: "green", 80: "amber", 50: "amber", 0: "red"}.get(s)


def by_m(entry):
    return {v["m"]: v for v in entry["months"] or []}


# ===========================================================================
print("== Part 1: frozen ramen by name, and KR1's reference ==")
for t in ("Frozen Ramen - Hell Ramen", "Frozen Ramen - Truffle Chicken Ramen",
          "Frozen Ramen - Black Garlic Tonkotsu Ramen", "Frozen Ramen - Laksa Ramen",
          "M&R Chicken Ramen", "M&R Black Garlic Tonkotsu", "M&R HELL RAMEN 5/700G",
          "lack of one box laksa frozen ramen", "M&R black tonkontsu ramen *1",
          "Sent half as much frozen ramen as on the invoice"):
    check(fr.is_frozen_ramen(t), f"frozen ramen: {t!r}")
for t in ("RAMEN NOODLES", "(VEGAN) TONKOTSU RAMEN SOUP", "ARIAKE RAMEN SOUP TONKOTSU",
          "SQUID FOR RAMEN", "Prawn use for seafood ramen", "RAMEN RUMP",
          "M&R CHICKEN BROTH FROZEN", "M&R TONKOTSU BROTH FROZEN", "M&R CHICKEN PASTE",
          "FROZEN COOKED OCTOPUS", "M&R Black Garlic Tonkotsu Broth", "missing 2 boxes ramen noodles",
          "take away ramen bowls plus lids", "", None):
    check(not fr.is_frozen_ramen(t), f"not frozen ramen: {t!r}")

ISS = [{"d": "2026-10-08", "site": "Fountain Good Food Ltd", "supplier": "Lynas",
        "issue_text": "Sent half as much frozen ramen as on the invoice"},
       {"d": "2026-10-09", "site": "Maki NE1 Ltd", "supplier": "Lynas",
        "issue_text": "lack of one box laksa frozen ramen"},
       {"d": "2026-10-09", "site": "Maki Leicester Ltd", "supplier": "JFC",
        "issue_text": "miss items: 2. M&R black tonkontsu ramen *1"},
       {"d": "2026-10-20", "site": "Maki Aberdeen Ltd", "supplier": "Lynas",
        "issue_text": "missing ramen noodles"},
       {"d": "2026-09-26", "site": "M1TOO Ltd", "supplier": "Lynas",
        "issue_text": "have to borrow ramen as well"}]
r = fr.forms_reference(ISS, "2026-10", (31, [], "2026-10-31"), False)
check(r["value"] == 3 and r["display"] == "3" and "not scored" in r["label"]
      and "09/10 Maki NE1 Ltd (Lynas)" in r["basis"] and "never scored" in r["basis"],
      f"October: 3 forms name frozen ramen, listed by date, site and supplier (got {r['display']})")
r = fr.forms_reference(ISS, "2026-10", (20, [], "2026-10-31"), True)
check(r["display"] == "3 so far" and "covers 20 day(s)" in r["basis"], "the open month says 'so far'")
r = fr.forms_reference(ISS, "2026-10", (28, ["2026-10-21", "2026-10-22", "2026-10-23"], "2026-10-31"), False)
check(r["display"] == "3+" and "lower bound" in r["basis"] and "21/10" in r["basis"],
      "a closed month the feed does not fully cover is a lower bound, and says where")
r = fr.forms_reference(ISS, "2026-10", None, False)
check(r["value"] is None and r["display"] == "—" and "absent" in r["basis"],
      "no issue feed: unknown, never 0")
r = fr.forms_reference(ISS, "2026-11", (0, [], "2026-11-30"), True)
check(r["value"] is None and r["display"] == "—" and "does not reach November 2026" in r["basis"],
      "the feed not reaching the month yet: unknown, never '0 so far'")
r = fr.forms_reference(ISS, "2026-09", (30, [], "2026-09-30"), False)
check(r["value"] == 0 and r["display"] == "0", "September: a measured 0 (bare 'ramen' is not frozen ramen)")

# ===========================================================================
print("\n== Part 2: OO6 KR3 - the weekly stock count ==")
SITES = [("Maki Aberdeen", ["Maki Aberdeen Ltd", "Maki Aberdeen"]),
         ("Maki Newcastle", ["Maki Newcastle Ltd", "Maki Newcastle", "Maki NE1 Ltd"]),
         ("Maki Leeds", ["Maki Leeds Ltd", "Maki Leeds"]),
         ("Maki Soho", ["Maki Soho", "Maki SOHO"])]


def week(wk, locs, read="2026-11-03T19:00:00Z", **kw):
    return {"week_commencing": wk, "week_from": kw.get("week_from", "column"),
            "report_modified_at": read, "read_at": read, "kind": "csv",
            "columns": {"location": "Venue", "item": "Item", "count": "Count"},
            "rows_read": 50, "frozen_lines": sum(v["lines"] for v in locs.values()),
            "items_matched": [fr.CANON_ITEMS[0]], "locations": locs,
            "unrecognised_locations": 0, "problems": []}


ALL4 = {"Maki & Ramen - Maki Aberdeen": {"lines": 4, "counted": 4},
        "Maki NE1 Ltd": {"lines": 4, "counted": 1},
        "maki leeds": {"lines": 2, "counted": 2},
        "Maki SOHO": {"lines": 4, "counted": 4}}
OCT = ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]


def stock(weeks):
    return {"pulled_at": "2026-11-03T19:00:00Z", "weeks": weeks, "_problems": []}


m = fr.site_matcher(SITES)
check(m("Maki & Ramen - Maki Aberdeen") == "Maki Aberdeen" and m("Maki NE1 Ltd") == "Maki Newcastle"
      and m("MAKI   leeds") == "Maki Leeds" and m("Maki West End") is None,
      "locations match by any name a site goes by - Kobas prefix, case, spacing; NE1 is Newcastle")
ex, gp = fr.kr3_months(stock({w: week(w, ALL4) for w in OCT}), None, None, SITES, "2026-10",
                       "2026-11", mvar, score("full"), rag, asof="2026-11-04")
o = by_m(ex)["2026-10"]
check(o["value"] == 100.0 and o["score"] == 100 and o["display"] == "100.0% (16 of 16 location-weeks, 4 weeks)",
      f"October: every location counted every week -> 100% -> 100 (got {o['display']})")
check("EVERY location" in o["basis"] and "Maki Soho" in o["basis"] and "0 included" in o["basis"]
      and "a negative is not" in o["basis"],
      "...and the basis names the rule and the location list")
n = by_m(ex)["2026-11"]
check(n.get("mtd") and n.get("score") is None and n.get("coverage_days") == 0,
      "November, no report yet: month to date, 0 days, unscored")
part = {w: week(w, ALL4) for w in OCT}
part["2026-10-19"] = week("2026-10-19", {k: v for k, v in ALL4.items() if k != "Maki SOHO"})
ex, _ = fr.kr3_months(stock(part), None, None, SITES, "2026-10", "2026-10", mvar, score("full"), rag,
                      asof="2026-10-31")
o = by_m(ex)["2026-10"]
check(o["value"] == 93.7 and o["score"] == 0 and "w/c 19/10: 3 of 4 (not counted: Maki Soho)" in o["basis"],
      f"a location the report LEAVES OUT is not counted: 15 of 16 = 93.75% cut to 93.7 -> 0 (got {o['display']})")
blank = {w: week(w, ALL4) for w in OCT}
blank["2026-10-12"] = week("2026-10-12", {**ALL4, "maki leeds": {"lines": 2, "counted": 0}})
o = by_m(fr.kr3_months(stock(blank), None, None, SITES, "2026-10", "2026-10", mvar, score("full"),
                       rag, asof="2026-10-31")[0])["2026-10"]
check(o["score"] == 0 and "listed with no count: Maki Leeds" in o["basis"],
      "a location listed with every frozen line blank is not counted - and is named as blank")
miss = {w: week(w, ALL4) for w in OCT if w != "2026-10-12"}
o = by_m(fr.kr3_months(stock(miss), None, None, SITES, "2026-10", "2026-11", mvar, score("full"),
                       rag, asof="2026-11-04")[0])["2026-10"]
check(o.get("score") is None and o.get("incomplete") and o["value"] == 100.0
      and "commencing 12/10" in o["basis"] and "3 of 4 weeks" in o["basis"],
      "a CLOSED month with a week missing is shown, not scored - and names the week")
o = by_m(fr.kr3_months(stock({"2026-10-05": week("2026-10-05", ALL4),
                              "2026-10-19": week("2026-10-19", ALL4)}), None, None, SITES,
                       "2026-10", "2026-10", mvar, score("full"), rag, asof="2026-10-21")[0])["2026-10"]
check(o.get("mtd") and o.get("score") is None and "12/10" in o["basis"],
      "the month in progress with a gap before its newest report cannot be complete: MTD, unscored")
o = by_m(fr.kr3_months(stock({"2026-10-05": week("2026-10-05", ALL4)}), None, None, SITES,
                       "2026-10", "2026-10", mvar, score("full"), rag, asof="2026-10-08")[0])["2026-10"]
check(o["value"] == 100.0 and o["score"] == 100 and o["coverage_days"] == 4,
      "the open month carries the days its reports cover (5-8/10 = 4) for the month-to-date rule")
check(bake.okr_mtd_variant(o, "full", "2026-10", o["coverage_days"])["score"] is None,
      "...which leaves 4 days unscored (the 7-day minimum)")
late = {w: week(w, ALL4, read="2026-10-31T19:00:00Z") for w in OCT}
late["2026-10-26"] = week("2026-10-26", ALL4, read="2026-11-02T19:00:00Z")
ex, gp = fr.kr3_months(stock(late), None, None, SITES, "2026-10", "2026-11", mvar, score("full"),
                       rag, asof="2026-11-01", dated="2026-11-01")
check(by_m(ex)["2026-10"].get("score") is None and by_m(ex)["2026-10"].get("incomplete")
      and any("read after 2026-11-01" in g for g in gp),
      "a back-bake never uses a week read after its date")
ex, gp = fr.kr3_months(None, "absent", {"ok": False, "cause": "not_shared", "detail": rfs.CAUSE_TEXT["not_shared"],
                                        "attempted_at": "2026-10-21T14:00:00Z"}, SITES, "2026-10",
                       "2026-10", mvar, score("full"), rag, asof="2026-10-21")
check(ex["months"] is None and "share the folder" in ex["not_measured"] and gp,
      "no copy: grey, naming the folder's failure")
ex, _ = fr.kr3_months(None, "absent", None, SITES, "2026-10", "2026-10", mvar, score("full"), rag,
                      asof="2026-10-21")
check("has not run" in ex["not_measured"], "no copy and no status: grey, 'has not run'")
odd = {w: week(w, ALL4) for w in OCT}
odd["2026-10-05"]["locations"]["Maki West End"] = {"lines": 3, "counted": 3}
o = by_m(fr.kr3_months(stock(odd), None, None, SITES, "2026-10", "2026-10", mvar, score("full"), rag,
                       asof="2026-10-31")[0])["2026-10"]
check(o["score"] == 100 and "Not on the location list, so not counted: Maki West End" in o["basis"],
      "a location not on the list is named, never counted")

full = {w: week(w, ALL4) for w in OCT}
full["2026-10-12"]["unrecognised_locations"] = 2
o = by_m(fr.kr3_months(stock(full), None, None, SITES, "2026-10", "2026-11", mvar, score("full"), rag,
                       asof="2026-11-04")[0])["2026-10"]
check(o["score"] == 100 and "cannot change a month in which every location is already counted" in o["basis"],
      "unplaced lines cannot raise a month where every location is already counted: 100% is exact, and scored")
unp = {w: week(w, ALL4) for w in OCT}
unp["2026-10-05"] = week("2026-10-05", {k: v for k, v in ALL4.items() if k != "Maki SOHO"})
unp["2026-10-12"]["unrecognised_locations"] = 2
o = by_m(fr.kr3_months(stock(unp), None, None, SITES, "2026-10", "2026-11", mvar, score("full"), rag,
                       asof="2026-11-04")[0])["2026-10"]
check(o.get("score") is None and o.get("incomplete") and "2 frozen-ramen line(s) in the w/c 12/10 report" in o["basis"]
      and "lower bound" in o["basis"],
      "lines with no usable location make the week a lower bound: the closed month is shown, NOT scored, and says why")
unp = {w: week(w, ALL4) for w in OCT}
unp["2026-10-05"] = week("2026-10-05", {k: v for k, v in ALL4.items() if k != "Maki SOHO"})
unp["2026-10-19"]["lines_unplaced"] = 3
o = by_m(fr.kr3_months(stock(unp), None, None, SITES, "2026-10", "2026-11", mvar, score("full"), rag,
                       asof="2026-11-04")[0])["2026-10"]
check(o.get("score") is None and o.get("incomplete") and "3 frozen-ramen line(s) in the w/c 19/10 report" in o["basis"],
      "...and so do lines with no readable date")
_ur = stock({w: week(w, ALL4) for w in OCT if w != "2026-10-12"})
_ur["unread"] = [{"modified_at": "2026-10-13T09:00:00.000Z", "cause": "header_missing",
                  "detail": rfs.CAUSE_TEXT["header_missing"] + " (missing: count)"}]
ex, gp = fr.kr3_months(_ur, None, None, SITES, "2026-10", "2026-11", mvar, score("full"), rag, asof="2026-11-04")
o = by_m(ex)["2026-10"]
check(any("saved 13/10/2026, could not be read" in g and "missing: count" in g for g in gp)
      and "could not be read may hold it" in o["basis"],
      "a report the refresher could not read is named in the gaps, and the month missing a week points to it")
o = by_m(fr.kr3_months(stock({"2026-10-05": week("2026-10-05", ALL4, read="2026-10-06T09:00:00Z")}),
                       None, None, SITES, "2026-10", "2026-10", mvar, score("full"), rag,
                       asof="2026-10-21")[0])["2026-10"]
check(o["score"] == 100 and "No report read yet for the week(s) commencing 12/10" in o["basis"]
      and "19/10" not in o["basis"].split("No report read yet")[1],
      "the month in progress names a week already over with no report (12/10) - the week in progress (19/10) is not overdue")

# the copy's publication check, and the loader
good = {"pulled_at": "2026-11-03T19:00:00Z", "basis": rfs.BASIS, "weeks": {w: week(w, ALL4) for w in OCT}}
check(fr.stock_leaks(json.dumps(good)) == [], "the refresher's own shape passes the publication check")
for lab, mut in (("an address", lambda d: d["weeks"]["2026-10-05"]["locations"].update({"a@b.co": {"lines": 1, "counted": 1}})),
                 ("money", lambda d: d["weeks"]["2026-10-05"]["items_matched"].append("Hell Ramen £4.20")),
                 ("a long number", lambda d: d["weeks"]["2026-10-05"]["problems"].append("row 1234567")),
                 ("a Drive id", lambda d: d["weeks"]["2026-10-05"]["columns"].update({"item": "1AbCdEfGhIjKlMnOpQrStUvWxYz"})),
                 ("a quantity field", lambda d: d["weeks"]["2026-10-05"]["locations"]["maki leeds"].update({"qty": 7})),
                 ("a new week field", lambda d: d["weeks"]["2026-10-05"].update({"file_name": "x"})),
                 ("a stamp that is not one", lambda d: d["weeks"]["2026-10-05"].update({"read_at": "07700 900123"}))):
    d_ = json.loads(json.dumps(good))
    mut(d_)
    check(bool(fr.stock_leaks(json.dumps(d_))), f"the publication check refuses {lab}")
_t = tempfile.mkdtemp(prefix="oo6-load-")
d_ = json.loads(json.dumps(good))
d_["weeks"]["2026-10-06"] = week("2026-10-06", ALL4)          # not a Monday
d_["weeks"]["2026-10-12"]["locations"]["Maki Soho"] = {"lines": 2, "counted": 3}
json.dump(d_, open(os.path.join(_t, fr.STOCK_FILE), "w"))
doc, err = fr.load_stock(_t)
check(err is None and "2026-10-06" not in doc["weeks"] and "Maki Soho" not in doc["weeks"]["2026-10-12"]["locations"]
      and len(doc["_problems"]) == 2, "the loader drops a week that is not a Monday and a count above its lines, naming both")
check(fr.load_stock(tempfile.mkdtemp())[1] == "absent", "no file: 'absent'")
shutil.rmtree(_t)

# ===========================================================================
print("\n== Part 3: refresh_frozen_stock.py ==")
_FID = "0ABcdEfGhIjKlMnOpQ"      # 18 characters, like a shared drive's root
check(rfs.folder_id("") is None and rfs.folder_id(_FID) == _FID
      and rfs.folder_id(f"https://drive.google.com/drive/folders/{_FID}?usp=sharing") == _FID
      and rfs.folder_id(f"https://drive.google.com/drive/u/0/folders/{_FID}") == _FID
      and rfs.folder_id("short") is False and rfs.folder_id("has spaces in it here") is False,
      "STOCK_COUNT_FOLDER_ID: the bare id (15+ characters), or the whole folder link; anything else is bad_folder_id")
hi, cols = rfs.find_header([["Weekly stock count"], [],
                            ["Venue", "Item", "Item Code", "Count Date", "Counted Quantity", "Unit",
                             "Value (£)", "User performing edit"]])
check(hi == 2 and cols == {"location": 0, "item": 1, "date": 3, "count": 4},
      "the header row is found below a title; code, unit, money and person columns are never a role")
try:
    rfs.find_header([["Venue", "Item", "Value"]])
    check(False, "a header with no count column is refused")
except rfs.DriveError as e:
    check(e.cause == "header_missing" and e.roles == ["count"], "a header with no count column names the missing role")
try:
    rfs.find_header([["Venue", "Item", "Quantity", "Count"]])
    check(False, "two count columns are refused")
except rfs.DriveError as e:
    check(e.cause == "header_ambiguous", "two equally good count columns are ambiguous, never guessed")

# the bake's own site map decides what a location may be
MATCH = fr.site_matcher(bake.stock_venues())
check(MATCH("Maki & Ramen - Maki Aberdeen") == "Maki Aberdeen" and MATCH("Maki NE1 Ltd") == "Maki Newcastle"
      and MATCH("Maki Manchester NQ") == "Maki Manchester NQ" and MATCH("Alice Example") is None,
      "the site map knows every venue by any of its names (Kobas, GetCompliant, label, NE1, the Kobas-only three) - and no person")
for hdr in (["Name of Venue", "Ingredient", "Quantity", "Site Supervisor"],
            ["Venue Name", "Ingredient", "Quantity", "Restaurant GM"],
            ["Outlet", "Ingredient", "Quantity", "Store Manager", "Location"]):
    _hi, c_ = rfs.find_header([hdr])
    check(hdr[c_["location"]] in ("Name of Venue", "Venue Name", "Location"),
          f"{hdr}: the location is {hdr[c_['location']]!r} - a person column is never a role")

CSV = ("Venue,Item,Count Date,Quantity,Value (£),User performing edit\r\n"
       "Maki & Ramen - Maki Aberdeen,Frozen Ramen - Hell Ramen,13/10/2026,12,48.00,Somebody Real\r\n"
       "Maki & Ramen - Maki Aberdeen,Frozen Ramen - Laksa Ramen,13/10/2026,0,0,Somebody Real\r\n"
       "Maki & Ramen - Maki Aberdeen,RAMEN NOODLES,13/10/2026,40,80.00,Somebody Real\r\n"
       "Maki NE1 Ltd,M&R Chicken Ramen,14/10/2026,,,Somebody Else\r\n"
       "Maki NE1 Ltd,M&R Black Garlic Tonkotsu,14/10/2026,three,,Somebody Else\r\n"
       "Maki Leeds,Frozen Ramen - Hell Ramen,20/10/2026,5,20.00,Third Person\r\n").encode("utf-8-sig")
w = rfs.parse_report(CSV, "stock.csv", "2026-10-21T09:00:00Z", MATCH)
check(sorted(w) == ["2026-10-12", "2026-10-19"], "weeks come from the date column's Mondays")
w12 = w["2026-10-12"]
check(w12["locations"] == {"Maki Aberdeen": {"lines": 2, "counted": 2},
                           "Maki Newcastle": {"lines": 2, "counted": 0}}
      and w12["frozen_lines"] == 4 and w12["week_from"] == "column",
      "per restaurant, as the site map labels it: frozen lines listed and how many carry a number "
      "(0 counts; a blank and 'three' do not)")
check(any("count is not a number" in p for p in w12["problems"]), "...and a text count is named by row")
_wtxt = json.dumps(w)
check(not any(x in _wtxt for x in ("Somebody", "Person", "48.00", "RAMEN NOODLES", "stock.csv", '"12"',
                                   "Maki & Ramen", "NE1"))
      and '"Quantity"' not in _wtxt.replace('"count": "Quantity"', ""),
      "no person, money, non-frozen line, file name, quantity or raw label is kept")
w = rfs.parse_report(b"Site,Product,Stock Count\nMaki Soho,Frozen Ramen - Hell Ramen,3\n",
                     "Stock count 2026-10-27.csv", "2026-11-02T09:00:00Z", MATCH)
check(list(w) == ["2026-10-26"] and w["2026-10-26"]["week_from"] == "file_name",
      "no date column: the week comes from a date in the file name")
w = rfs.parse_report(b"Site,Product,Stock Count\nMaki Soho,Frozen Ramen - Hell Ramen,3\n",
                     "stock.csv", "2026-10-18T23:30:00Z", MATCH)
check(list(w) == ["2026-10-19"] and w["2026-10-19"]["week_from"] == "created_time",
      "...else from Drive's createdTime on the UK clock (23:30 UTC on Sunday 18/10 is Monday 19/10 in BST)")
for data, want in ((b"Venue,Item,Count\nMaki Soho,RAMEN NOODLES,4\n", "no_frozen_lines"),
                   (b"just,some,cells\n1,2,3\n", "header_missing"),
                   (b"%PDF-1.4 ...", "not_a_table"),
                   (b"Location,Item,Count\nAlice Example,Frozen Ramen - Hell Ramen,1\n"
                    b"Bob Example,Frozen Ramen - Laksa Ramen,2\nMaki Soho,Frozen Ramen - Hell Ramen,1\n",
                    "locations_unknown")):
    try:
        rfs.parse_report(data, "x.csv", "2026-10-21T09:00:00Z", MATCH)
        check(False, f"{want} raises")
    except rfs.DriveError as e:
        check(e.cause == want and want in rfs.CAUSE_TEXT, f"{want}: a fixed cause, never a guess")
w = rfs.parse_report(b"Location,Item,Count Date,Count\nMaki Soho,Frozen Ramen - Hell Ramen,20/10/2026,1\n"
                     b"Maki Leeds,Frozen Ramen - Hell Ramen,20/10/2026,1\nMaki Leds,Frozen Ramen - Hell Ramen,20/10/2026,1\n"
                     b",Frozen Ramen - Hell Ramen,20/10/2026,1\n", "x.csv", "2026-10-21T09:00:00Z", MATCH)
check(sorted(w["2026-10-19"]["locations"]) == ["Maki Leeds", "Maki Soho"] and w["2026-10-19"]["unrecognised_locations"] == 2
      and "Leds" not in json.dumps(w),
      "a label on no site map (a typo) or a blank is COUNTED as unplaced, never written")
import openpyxl  # noqa: E402
_wb = openpyxl.Workbook()
_ws = _wb.active
_ws.append(["Stock count w/c 19/10"])
_ws.append(["Location", "Stock Item", "Date", "Closing Stock"])
_ws.append(["Maki Leeds", "Frozen Ramen - Laksa Ramen", dt.datetime(2026, 10, 20), 7])
_ws.append(["Maki Leeds", "Squid for ramen", dt.datetime(2026, 10, 20), 2])
_buf = io.BytesIO()
_wb.save(_buf)
XLSX = _buf.getvalue()
w = rfs.parse_report(XLSX, "x.xlsx", "2026-10-21T09:00:00Z", MATCH)
check(w["2026-10-19"]["locations"] == {"Maki Leeds": {"lines": 1, "counted": 1}},
      "an .xlsx is read in memory the same way (real date cells; squid for ramen is not frozen ramen)")
wide = ",".join(f"c{i}" for i in range(9)) + ",Venue,Item,Count\n"
wide += ",,,,,,,,,Maki Soho,Frozen Ramen - Hell Ramen,1\n\n"
wide += ",,,,,,,,,Maki Leeds,Frozen Ramen - Hell Ramen 1234567,2\n"
w = rfs.parse_report(wide.encode(), "x 20-10-2026.csv", "2026-10-21T09:00:00Z", MATCH)
_w = w["2026-10-19"]
check(sorted(_w["locations"]) == ["Maki Leeds", "Maki Soho"] and _w["items_matched"] == ["Frozen ramen - Hell"],
      "a wide report with a blank row reads (no IndexError); a product with a code in its cell is kept as its canonical name only")
# free text in an item cell or a header never reaches the copy (review, round 3)
w = rfs.parse_report(b"Site,Description,Counted (Jane Smith),Date\n"
                     b"Maki Soho,Frozen Ramen - Hell (Jane Smith counted),1,13/10/2026\n"
                     b"Maki Soho,Frozen ramen - truffle chicken 12.50 each,1,13/10/2026\n"
                     b"Maki Leeds,M&R Laksa Ramen 3 boxes left - Bob Jones to reorder,0,13/10/2026\n",
                     "x.csv", "2026-10-21T09:00:00Z", MATCH)
_wt = json.dumps(w)
check(w["2026-10-12"]["items_matched"] == ["Frozen ramen - Hell", "Frozen ramen - Truffle Chicken", "Frozen ramen - Laksa"]
      and w["2026-10-12"]["columns"] == {"location": "Site", "item": "Description", "count": "(column 3)"}
      and not any(x in _wt for x in ("Jane", "Bob", "12.50", "boxes")),
      "an annotated item cell is published only as its canonical product, and a header naming a person only as its position")
check(fr.stock_leaks(json.dumps({"weeks": {"2026-10-12": {**w["2026-10-12"], "items_matched": ["Hell (Jane counted)"]}}}))
      and fr.stock_leaks(json.dumps({"weeks": {"2026-10-12": {**w["2026-10-12"], "columns": {"count": "Counted (Jane)"}}}})),
      "...and the bake refuses a copy carrying either - its own check, not only the refresher's")


def rcsv(path, body):
    open(path, "w").write("Venue,Item,Count Date,Count\n" + body)
    return path


def run(tmp, files, mods, pulled):
    os.environ["PULLED_AT"] = pulled
    buf = io.StringIO()
    _o, sys.stdout = sys.stdout, buf
    try:
        rc = rfs.main(sum((["--from-file", f_] for f_ in files), [])
                      + sum((["--modified-at", m_] for m_ in mods), []) + ["--out-dir", tmp])
    finally:
        sys.stdout = _o
        os.environ.pop("PULLED_AT", None)
    st = json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))
    try:
        doc = json.load(open(os.path.join(tmp, fr.STOCK_FILE)))
    except (OSError, ValueError):
        doc = None
    return rc, st, doc, buf.getvalue()


# main(), end to end on local files (the folder's contents, every run)
tmp = tempfile.mkdtemp(prefix="oo6-rfs-")
try:
    p1 = os.path.join(tmp, "a.csv")
    open(p1, "wb").write(CSV)
    rc, st, doc, _out = run(tmp, [p1], ["2026-10-21T09:00:00.123Z"], "2026-10-21T13:00:00Z")
    check(rc == 0 and st["ok"] is True and st["cause"] == "ok" and sorted(doc["weeks"]) == ["2026-10-12", "2026-10-19"]
          and doc["weeks"]["2026-10-12"]["report_modified_at"] == "2026-10-21T09:00:00.123Z"
          and doc["weeks"]["2026-10-12"]["read_at"] == "2026-10-21T13:00:00Z",
          "a read writes the copy and an ok status")
    check(fr.stock_leaks(open(os.path.join(tmp, fr.STOCK_FILE)).read()) == [] and "a.csv" not in json.dumps(doc),
          "what it writes passes the bake's own publication check, and names no file")
    check(not [f for f in os.listdir(tmp) if f.endswith(".tmp")], "no .tmp is left behind")
    before = open(os.path.join(tmp, fr.STOCK_FILE)).read()
    rc, st, doc, _out = run(tmp, [p1], ["2026-10-21T09:00:00.123Z"], "2026-10-22T13:00:00Z")
    check(st["ok"] and open(os.path.join(tmp, fr.STOCK_FILE)).read() == before,
          "the folder unchanged: the copy is left byte for byte, and each week keeps the read_at it was first read with")
    p2 = os.path.join(tmp, "b.csv")
    open(p2, "wb").write(b"Venue,Item,Count\nMaki Soho,RAMEN NOODLES,4\n")
    rc, st, doc, _out = run(tmp, [p1, p2], ["2026-10-21T09:00:00.123Z", "2026-10-22T09:00:00Z"], "2026-10-22T14:00:00Z")
    check(rc == 0 and st["ok"] is True and st["unread_causes"] == ["no_frozen_lines"]
          and doc["unread_reports"] == [{"modified_at": "2026-10-22T09:00:00.000Z", "cause": "no_frozen_lines",
                                         "detail": rfs.CAUSE_TEXT["no_frozen_lines"]}]
          and doc["weeks"]["2026-10-12"]["read_at"] == "2026-10-21T13:00:00Z",
          "a report that cannot be read is listed in the copy by date and fixed cause - the readable weeks stand")
    rc, st, doc, _out = run(tmp, [p1], ["2026-10-21T09:00:00.123Z"], "2026-10-23T13:00:00Z")
    check(st["ok"] and "unread_reports" not in doc,
          "...and once it is gone from the folder it is no longer named (current state, never a growing ledger)")
    # a deterministic parse error is the REPORT'S: the others are still read
    p3 = os.path.join(tmp, "c.csv")
    open(p3, "w").write('Venue,Item,Count\nMaki Soho,"' + "x" * 200000 + "\n")
    rc, st, doc, _out = run(tmp, [p3, p1], ["2026-10-20T09:00:00Z", "2026-10-21T09:00:00.123Z"], "2026-10-23T14:00:00Z")
    check(st["unread_causes"] == ["report_unreadable"] and doc["unread_reports"][0]["cause"] == "report_unreadable"
          and "2026-10-12" in doc["weeks"],
          "a report the parser cannot read (an over-long field) is that report's fault - listed, and the rest still read")
    # thirteen unreadable reports never starve the good one
    bads = [rcsv(os.path.join(tmp, f"bad{i}.csv"), "Maki Soho,RAMEN NOODLES,1,1\n") for i in range(13)]
    rc, st, doc, _out = run(tmp, bads + [p1], [f"2026-10-1{i % 9}T0{i % 10}:00:00Z" for i in range(13)]
                            + ["2026-10-21T09:00:00.123Z"], "2026-10-23T15:00:00Z")
    check(st["reports_read"] == 1 and st["reports_unreadable"] == 13 and "2026-10-12" in doc["weeks"],
          "thirteen unreadable reports and one good one: the good one is read the same run")
    for f_ in os.listdir(tmp):
        os.remove(os.path.join(tmp, f_))

    # WEEKS SHARED BY TWO REPORTS ARE MERGED BY LOCATION (review, 21/10/2026)
    s1 = rcsv(os.path.join(tmp, "s1.csv"), "Maki Soho,Frozen Ramen - Hell Ramen,04/10/2026,2\n"
                                           "Maki Leeds,Frozen Ramen - Hell Ramen,05/10/2026,3\n")
    s2 = rcsv(os.path.join(tmp, "s2.csv"), "Maki Soho,Frozen Ramen - Hell Ramen,11/10/2026,2\n"
                                           "Maki Leeds,Frozen Ramen - Hell Ramen,12/10/2026,3\n")
    rc, st, doc, _out = run(tmp, [s1, s2], ["2026-10-06T09:00:00Z", "2026-10-13T09:00:00Z"], "2026-10-13T12:00:00Z")
    check(sorted(doc["weeks"]["2026-10-05"]["locations"]) == ["Maki Leeds", "Maki Soho"]
          and any("merged from more than one report" in p_ for p_ in doc["weeks"]["2026-10-05"]["problems"]),
          "a count that runs Sunday into Monday: w/c 05/10 keeps Monday's Leeds (report 1) AND Sunday's Soho (report 2)")
    s3 = rcsv(os.path.join(tmp, "s3.csv"), "Maki Leeds,Frozen Ramen - Hell Ramen,12/10/2026,\n")
    rc, st, doc, _out = run(tmp, [s1, s2, s3], ["2026-10-06T09:00:00Z", "2026-10-13T09:00:00Z", "2026-10-14T09:00:00Z"],
                            "2026-10-14T12:00:00Z")
    check(doc["weeks"]["2026-10-12"]["locations"]["Maki Leeds"] == {"lines": 1, "counted": 0},
          "the newer report wins a location both list (a re-issued Leeds line replaces the older one)")
    ra = rcsv(os.path.join(tmp, "ra.csv"), "Maki Leeds,Frozen Ramen - Hell Ramen,19/10/2026,1\n"
                                           "Maki Soho,Frozen Ramen - Hell Ramen,19/10/2026,1\n,Frozen Ramen - Hell Ramen,19/10/2026,1\n")
    rb = rcsv(os.path.join(tmp, "rb.csv"), "Maki Leeds,Frozen Ramen - Hell Ramen,19/10/2026,1\n"
                                           "Maki Soho,Frozen Ramen - Hell Ramen,19/10/2026,1\nMaki Bath Street,Frozen Ramen - Hell Ramen,19/10/2026,1\n")
    rc, st, doc, _out = run(tmp, [ra], ["2026-10-20T09:00:00Z"], "2026-10-20T12:00:00Z")
    check(doc["weeks"]["2026-10-19"]["unrecognised_locations"] == 1, "a blank location makes the week a lower bound")
    rc, st, doc, _out = run(tmp, [ra, rb], ["2026-10-20T09:00:00Z", "2026-10-21T09:00:00Z"], "2026-10-21T12:00:00Z")
    check(doc["weeks"]["2026-10-19"]["unrecognised_locations"] == 0
          and sorted(doc["weeks"]["2026-10-19"]["locations"]) == ["Maki Bath Street", "Maki Leeds", "Maki Soho"],
          "...and a CORRECTED re-issue (every location re-listed) clears it - the month can be scored again")
    rs = rcsv(os.path.join(tmp, "rs.csv"), "Maki Aberdeen,Frozen Ramen - Hell Ramen,19/10/2026,1\n,Frozen Ramen - Hell Ramen,19/10/2026,1\n")
    re_ = rcsv(os.path.join(tmp, "re.csv"), "Maki Leeds,Frozen Ramen - Hell Ramen,19/10/2026,1\n")
    rc, st, doc, _out = run(tmp, [rs, re_], ["2026-10-20T09:00:00Z", "2026-10-21T09:00:00Z"], "2026-10-21T13:00:00Z")
    check(doc["weeks"]["2026-10-19"]["unrecognised_locations"] == 1
          and sorted(doc["weeks"]["2026-10-19"]["locations"]) == ["Maki Aberdeen", "Maki Leeds"],
          "...but a report for OTHER restaurants (a region split) does not clear the first one's unplaced line")
    for f_ in os.listdir(tmp):
        os.remove(os.path.join(tmp, f_))

    # a stored copy of the wrong shape (or one the bake would refuse) is rebuilt, exit 0
    open(p1, "wb").write(CSV)
    for bad_prev in ('{"weeks": ["x"]}', '{"weeks": {"2026-10-05": {"locations": [], "read_at": "x"}}}',
                     '{"weeks": {"2026-10-05": {"x": "a@b.co"}}}', "not json"):
        open(os.path.join(tmp, fr.STOCK_FILE), "w").write(bad_prev)
        rc, st, doc, _out = run(tmp, [p1], ["2026-10-21T09:00:00Z"], "2026-10-21T13:00:00Z")
        check(rc == 0 and st["ok"] and sorted(doc["weeks"]) == ["2026-10-12", "2026-10-19"]
              and fr.stock_leaks(json.dumps(doc)) == [],
              f"a stored copy {bad_prev[:30]!r}... is never trusted: rebuilt from the folder, exit 0")
    # the window, the ceiling and the deadline: never a copy built from part of the folder
    for f_ in os.listdir(tmp):
        os.remove(os.path.join(tmp, f_))
    s1 = rcsv(os.path.join(tmp, "s1.csv"), "Maki Soho,Frozen Ramen - Hell Ramen,04/10/2026,2\n")
    s2 = rcsv(os.path.join(tmp, "s2.csv"), "Maki Soho,Frozen Ramen - Hell Ramen,11/10/2026,2\n")
    old_r = rcsv(os.path.join(tmp, "old.csv"), "Maki Soho,Frozen Ramen - Hell Ramen,03/08/2026,1\n")
    rc, st, doc, _out = run(tmp, [old_r, s1, s2], ["2026-08-04T09:00:00Z", "2026-10-06T09:00:00Z", "2026-10-13T09:00:00Z"],
                            "2026-10-13T12:00:00Z")
    check(st["reports_before_window"] == 1 and "2026-08-03" not in doc["weeks"] and st["reports_read"] == 2,
          "a report saved before the window (it can only hold weeks before October) is not read, and is counted")
    before = open(os.path.join(tmp, fr.STOCK_FILE)).read()
    _cap, rfs.MAX_REPORTS = rfs.MAX_REPORTS, 1
    try:
        rc, st, doc, _out = run(tmp, [s1, s2], ["2026-10-06T09:00:00Z", "2026-10-13T09:00:00Z"], "2026-10-14T12:00:00Z")
    finally:
        rfs.MAX_REPORTS = _cap
    check(rc == 0 and st["cause"] == "too_many_reports" and open(os.path.join(tmp, fr.STOCK_FILE)).read() == before,
          "more reports than the ceiling: NOTHING written (never a copy from part of the folder), and said so")
    _dl, rfs.RUN_DEADLINE_S = rfs.RUN_DEADLINE_S, -1
    try:
        rc, st, doc, _out = run(tmp, [s1, s2], ["2026-10-06T09:00:00Z", "2026-10-13T09:00:00Z"], "2026-10-14T13:00:00Z")
    finally:
        rfs.RUN_DEADLINE_S = _dl
    check(rc == 0 and st["cause"] == "timeout" and open(os.path.join(tmp, fr.STOCK_FILE)).read() == before,
          "a run past its time limit writes nothing - the last copy stands")
    # read_at follows the COUNTS, not the file: an identical re-save keeps it
    rc, st, doc, _out = run(tmp, [s1, s2], ["2026-10-06T09:00:00Z", "2026-10-15T09:00:00Z"], "2026-10-15T12:00:00Z")
    check(doc["weeks"]["2026-10-05"]["read_at"] == "2026-10-13T12:00:00Z"
          and doc["weeks"]["2026-10-05"]["report_modified_at"] == "2026-10-15T09:00:00.000Z",
          "a report re-saved with the same counts keeps its weeks' first read_at - a back-bake still sees them")
    # a report with no date anywhere stays in its own week when it is re-saved
    for f_ in (fr.STOCK_FILE, fr.STOCK_STATUS_FILE):
        os.remove(os.path.join(tmp, f_))       # (September, closed by now, would be carried)
    nd = os.path.join(tmp, "nodate.csv")
    open(nd, "w").write("Venue,Item,Count\nMaki Soho,Frozen Ramen - Hell Ramen,1\n")
    rc, st, doc, _out = run(tmp, [nd], ["2026-10-20T09:00:00Z"], "2026-10-20T12:00:00Z")
    os.environ["PULLED_AT"] = "2026-10-27T10:00:00Z"   # never the real clock: months close
    _rc = rfs.main(["--from-file", nd, "--modified-at", "2026-10-27T09:00:00Z", "--created-at",
                    "2026-10-06T09:00:00Z", "--out-dir", tmp])
    os.environ.pop("PULLED_AT", None)
    doc = json.load(open(os.path.join(tmp, fr.STOCK_FILE)))
    check(list(doc["weeks"]) == ["2026-10-05"],
          "a report with no date column, re-saved on 27/10, stays in the week it was CREATED in (w/c 05/10)")
    # an older report with NO placed location is never 'superseded'
    rz = rcsv(os.path.join(tmp, "rz.csv"), ",Frozen Ramen - Hell Ramen,19/10/2026,1\n"
                                           "Maki Soho,Frozen Ramen - Hell Ramen,26/10/2026,1\n")
    ry = rcsv(os.path.join(tmp, "ry.csv"), "Maki Leeds,Frozen Ramen - Hell Ramen,19/10/2026,1\n"
                                           "Maki Soho,Frozen Ramen - Hell Ramen,19/10/2026,1\n")
    w_ = rfs.build_weeks([("a", "csv", rfs.parse_report(open(rz, "rb").read(), "x", "2026-10-27T09:00:00Z", MATCH)),
                          ("b", "csv", rfs.parse_report(open(ry, "rb").read(), "y", "2026-10-28T09:00:00Z", MATCH))])
    check(w_["2026-10-19"]["unrecognised_locations"] == 1,
          "an older report whose only line had no location is not 'superseded' by a newer one - its line still counts")
    for f_ in os.listdir(tmp):
        os.remove(os.path.join(tmp, f_))
    os.environ.pop("STOCK_COUNT_FOLDER_ID", None)
    buf = io.StringIO()
    _o, sys.stdout = sys.stdout, buf
    try:
        rfs.main(["--out-dir", tmp])
    finally:
        sys.stdout = _o
    st = json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))
    check(st["cause"] == "no_folder_id" and "repository secret" in st["detail"],
          "STOCK_COUNT_FOLDER_ID unset: named, nothing asked of Drive")
finally:
    os.environ.pop("PULLED_AT", None)
    shutil.rmtree(tmp)

# Drive, faked: the folder is asked for first; every answer maps to a cause
_drive = {"calls": []}


class _Resp:
    def __init__(self, code, body=b"", js=None):
        self.status_code, self.content, self._js = code, body, js

    def json(self):
        return self._js

    def iter_content(self, n):
        yield self.content

    def close(self):
        pass


class _Sess:
    def __init__(self, creds):
        pass

    def get(self, url, params=None, **kw):
        _drive["calls"].append((url, dict(params or {})))
        return _drive["route"](url, params or {})


_fake = {"google": types.ModuleType("google"), "google.auth": types.ModuleType("google.auth"),
         "google.auth.transport": types.ModuleType("google.auth.transport"),
         "google.auth.transport.requests": types.ModuleType("google.auth.transport.requests"),
         "google.oauth2": types.ModuleType("google.oauth2"),
         "google.oauth2.service_account": types.ModuleType("google.oauth2.service_account")}
_fake["google.auth.transport.requests"].AuthorizedSession = _Sess
_fake["google.oauth2.service_account"].Credentials = types.SimpleNamespace(
    from_service_account_info=lambda info, scopes: object())
_saved = {k: sys.modules.get(k) for k in _fake}
_FILES = [{"id": "F" * 30, "name": "count 13-10-2026.csv", "mimeType": rfs.MIME_CSV,
           "modifiedTime": "2026-10-20T09:00:00.000Z", "size": "300"},
          {"id": "G" * 30, "name": "count.gsheet", "mimeType": rfs.MIME_GSHEET,
           "modifiedTime": "2026-10-21T09:00:00.000Z"}]


def route_ok(url, params):
    if url.endswith(_FID) and params.get("fields") == "id,mimeType":
        return _Resp(200, js={"id": _FID, "mimeType": rfs.MIME_FOLDER})
    if url == rfs.DRIVE_FILES:
        assert params.get("supportsAllDrives") == "true" and params.get("corpora") == "allDrives"
        return _Resp(200, js={"files": _FILES})
    if url.endswith("F" * 30) and params.get("alt") == "media":
        return _Resp(200, CSV)
    if url.endswith("G" * 30 + "/export") and params.get("mimeType") == rfs.MIME_XLSX:
        return _Resp(200, XLSX)
    return _Resp(500)


tmp = tempfile.mkdtemp(prefix="oo6-drive-")
_env = {k: os.environ.get(k) for k in ("GOOGLE_SA_JSON", "STOCK_COUNT_FOLDER_ID")}


def drive_run():
    buf = io.StringIO()
    _o, sys.stdout = sys.stdout, buf
    os.environ["PULLED_AT"] = "2026-10-22T10:00:00Z"    # never the real clock: months close
    try:
        rc = rfs.main(["--out-dir", tmp])
    finally:
        sys.stdout = _o
        os.environ.pop("PULLED_AT", None)
    st = json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))
    try:
        doc = json.load(open(os.path.join(tmp, fr.STOCK_FILE)))
    except OSError:
        doc = None
    return rc, st, doc, buf.getvalue()


try:
    sys.modules.update(_fake)
    os.environ["GOOGLE_SA_JSON"] = '{"client_email": "sa@x.iam.gserviceaccount.com"}'
    os.environ["STOCK_COUNT_FOLDER_ID"] = f"https://drive.google.com/drive/folders/{_FID}?usp=sharing"
    _drive["route"] = route_ok
    rc, st, doc, out_ = drive_run()
    check(rc == 0 and st["ok"] and sorted(doc["weeks"]) == ["2026-10-12", "2026-10-19"]
          and doc["weeks"]["2026-10-19"]["kind"] == "gsheet" and doc["weeks"]["2026-10-12"]["kind"] == "csv"
          and sorted(doc["weeks"]["2026-10-19"]["locations"]) == ["Maki Leeds"],
          "Drive: the folder is listed, the CSV downloaded and the Google Sheet EXPORTED; a shared week merged")
    check(_drive["calls"][0][1].get("fields") == "id,mimeType",
          "the folder itself is asked for before it is listed (an unshared folder lists empty)")
    _all = out_ + json.dumps(doc) + json.dumps(st)
    check(_FID not in _all and "F" * 30 not in _all and "count 13-10" not in _all and "sa@x" not in _all,
          "the folder id, file ids, file names and the service account appear in no output and no file")
    good_copy = open(os.path.join(tmp, fr.STOCK_FILE)).read()

    def route_flaky(u, p):
        if u.endswith("F" * 30) and p.get("alt") == "media":
            return _Resp(500)
        return route_ok(u, p)
    _drive["route"] = route_flaky
    rc, st, doc, out_ = drive_run()
    check(rc == 0 and st["cause"] == "http_error" and open(os.path.join(tmp, fr.STOCK_FILE)).read() == good_copy,
          "Google's error on one report writes NOTHING - the last good copy stands, and the next run reads again")
    for code, body in ((403, b'{"reason": "cannotDownloadFile"}'), (403, b'{"reason": "insufficientFilePermissions"}'),
                       (404, b"")):
        def route_block(u, p, code=code, body=body):
            if u.endswith("F" * 30) and p.get("alt") == "media":
                return _Resp(code, body)
            return route_ok(u, p)
        _drive["route"] = route_block
        rc, st, doc, out_ = drive_run()
        check(st["ok"] and st["unread_causes"] == ["download_blocked"]
              and [u["cause"] for u in doc["unread_reports"]] == ["download_blocked"]
              and "2026-10-19" in doc["weeks"],
              f"HTTP {code} on ONE file after the folder listed: that report is download_blocked (never 'share the "
              "folder'), and the rest is still read")
    for lab, route, want in (
            ("folder 404", lambda u, p: _Resp(404), "not_found"),
            ("folder 403 API off", lambda u, p: _Resp(403, b'{"reason": "accessNotConfigured"}'), "drive_api_disabled"),
            ("folder 403", lambda u, p: _Resp(403, b'{"reason": "forbidden"}'), "not_shared"),
            ("a file id, not a folder", lambda u, p: _Resp(200, js={"id": _FID, "mimeType": rfs.MIME_CSV}), "not_a_folder"),
            ("an empty folder", lambda u, p: _Resp(200, js={"id": _FID, "mimeType": rfs.MIME_FOLDER})
             if p.get("fields") == "id,mimeType" else _Resp(200, js={"files": []}), "no_report")):
        _drive["route"] = route
        if os.path.exists(os.path.join(tmp, fr.STOCK_FILE)):
            os.remove(os.path.join(tmp, fr.STOCK_FILE))
        rc, st, doc, out_ = drive_run()
        check(rc == 0 and st["cause"] == want and doc is None,
              f"Drive {lab} -> {want}, exit 0, nothing written")
    os.environ["STOCK_COUNT_FOLDER_ID"] = "not a folder id"
    rc, st, doc, out_ = drive_run()
    check(st["cause"] == "bad_folder_id", "a malformed STOCK_COUNT_FOLDER_ID is bad_folder_id, never a request")
finally:
    for k, v in _saved.items():
        if v is None:
            sys.modules.pop(k, None)
        else:
            sys.modules[k] = v
    for k, v in _env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    shutil.rmtree(tmp)
check(_FID not in open(os.path.join(REPO, "builders", "refresh_frozen_stock.py")).read(),
      "no folder id is written into the public source")

# ===========================================================================
print("\n== Part 4: the sheet - OO6 KR1's % and KR2's 'all POs invoiced' ==")
for raw, want in (("", None), ("A160:A172,C160:C172", ("A160:A172", "C160:C172", 160, "A160:A172 + C160:C172")),
                  (" a160:a172 , c160:c172 ", ("A160:A172", "C160:C172", 160, "A160:A172 + C160:C172")),
                  ("A160:A172", False), ("A160:B172,C160:C172", False), ("A160:A172,C161:C173", False),
                  ("A160:A172,A160:A172", False), ("A1:A40,C1:C40", False), ("A160:A172;C160:C172", False)):
    os.environ["OKR_CELLS_OO6_KR1"] = raw
    check(ros.oo6_cells("oo6_kr1") == want, f"OKR_CELLS_OO6_KR1={raw!r} -> {want}")
os.environ.pop("OKR_CELLS_OO6_KR1")
check([ros.parse_yes_no(x) for x in ("Yes", "y", "TRUE", "no", "N", "FALSE", "", "  ", "maybe", "0", "1")]
      == [True, True, True, False, False, False, None, None, None, None, None],
      "yes/no: a ticked or typed yes, a no - and a blank, a number or anything else is NOT ENTERED")
BLK = [["Month", "OO6 KR1 Supply chain availability %"], ["Jan-26", ""], ["Sep-26", "99%"],
       ["Oct-26", "100"], ["Nov-26", ""], ["Dec-26", "97"]]
check(ros.build_oo6_block("oo6_kr1", BLK, "2026-11") == ({"2026-09": 99, "2026-10": 100}, None),
      "OO6 KR1: 0-100 per month; a blank is not entered; a month after the pull is dropped")
check(ros.build_oo6_block("oo6_kr1", [["Month", "KR1 Efficiency"], ["Oct-26", "4"]], "2026-11")[1]
      == "layout_changed", "a pin that lands on another block (a Finance OO1 heading) is refused before any value is read")
check(ros.build_oo6_block("oo6_kr1", [["Month", "availability"], ["Total", "4"]], "2026-11")[1]
      == "layout_changed", "...and so is a block whose rows are not months")
INV = [["Month", "All POs invoiced?"], ["Sep-26", "Yes"], ["Oct-26", "no"], ["Nov-26", "tbc"]]
check(ros.build_oo6_block("oo6_kr2_invoiced", INV, "2026-11") == ({"2026-09": True, "2026-10": False}, None),
      "OO6 KR2 invoiced: JSON true/false; 'tbc' is not entered")


class RangeWS:
    """'2026 OKRs' answering only the ranges asked for."""
    def __init__(self, title, gid, cells):
        self.title, self.id, self.cells, self.calls = title, gid, cells, []

    def batch_get(self, ranges):
        self.calls.append(tuple(ranges))
        return [self.cells.get(r_, []) for r_ in ranges]

    def get_all_values(self):
        self.calls.append("ALL")
        return [["FINANCE"]]


OK4 = {"A144:A156": [["Month"], ["Jan-26"]], "G144:H156": [["Limit", "Actual"], ["100", "100"]],
       "A160:A172": [["Month"], ["Oct-26"]], "C160:C172": [["Supply chain availability"], ["100"]],
       "A160:A172 ": [], "E160:E172": [["All POs invoiced"], ["yes"]]}
_ws = RangeWS("2026 OKRs", 3, OK4)
_sheet = type("S", (), {"worksheets": lambda self: [_ws]})()
got, missing = ros.fetch("x", spreadsheet=_sheet)
check(_ws.calls == [ros.OO4_KR4_RANGES] and missing.get("oo6_kr1") == "not_located"
      and missing.get("oo6_kr2_invoiced") == "not_located",
      "UNPINNED: '2026 OKRs' is asked for the OO4 ranges only, and both OO6 series are 'not_located'")
os.environ["OKR_CELLS_OO6_KR1"] = "A160:A172,C160:C172"
os.environ["OKR_CELLS_OO6_KR2_INVOICED"] = "A160:A172,E160:E172"
_ws.calls = []
got, missing = ros.fetch("x", spreadsheet=_sheet)
check(_ws.calls == [ros.OO4_KR4_RANGES, ("A160:A172", "C160:C172"), ("A160:A172", "E160:E172")]
      and got["oo6_kr1"][2] == [["Month", "Supply chain availability"], ["Oct-26", "100"]]
      and "oo6_kr1" not in missing and "oo6_kr2_invoiced" not in missing,
      "PINNED: each OO6 figure's two columns are asked for, and nothing else of the tab")
os.environ["OKR_CELLS_OO6_KR2_INVOICED"] = "nonsense"
_ws.calls = []
got, missing = ros.fetch("x", spreadsheet=_sheet)
check(missing.get("oo6_kr2_invoiced") == "bad_cells" and len(_ws.calls) == 2,
      "a pin that is not a range is 'bad_cells' and is never requested")
os.environ["OKR_CELLS_OO6_KR2_INVOICED"] = "A1600:A1612,E1600:E1612"


class GridErr(Exception):
    def __init__(self):
        super().__init__("exceeds grid limits")
        self.response = type("R", (), {"status_code": 400})()


_bg = _ws.batch_get
_ws.batch_get = lambda ranges: (_ for _ in ()).throw(GridErr()) if ranges[0] == "A1600:A1612" else _bg(ranges)
got, missing = ros.fetch("x", spreadsheet=_sheet)
check(missing.get("oo6_kr2_invoiced") == "bad_cells" and "okrs" in got and "oo6_kr1" in got,
      "a pin outside the tab's grid (HTTP 400) is bad_cells for THAT figure - the rest of the pull still reads")
_ws.batch_get = _bg
os.environ.pop("OKR_CELLS_OO6_KR2_INVOICED")
tmp = tempfile.mkdtemp(prefix="oo6-ros-")
try:
    dump = {"okrs": [["Month ", "Limit", "Actual"], ["Jan-26", "100", "100"]],
            "oo6_kr1": [["Month", "OO6 KR1 availability"], ["Oct-26", "98"]],
            "oo2_kr3": [["Month", "Log"], ["January 2026", "0"]],
            "oo3_kr3": [["Month", "Log"], ["January 2026", "0"]],
            "oo4_kr1": [["Month", "Log"], ["January 2026", "0"]]}
    open(os.path.join(tmp, "dump.json"), "w").write(json.dumps(dump))
    os.environ["PULLED_AT"] = "2026-11-02T10:00:00Z"
    import logging
    _lb = io.StringIO()
    _lh = logging.StreamHandler(_lb)
    _lh.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    _root = logging.getLogger()
    _lvl = _root.level
    _root.setLevel(logging.INFO)
    _root.addHandler(_lh)
    try:
        ros.main(["--from-json", os.path.join(tmp, "dump.json"), "--out", os.path.join(tmp, "okr_sheet.json")])
    finally:
        _root.removeHandler(_lh)
        _root.setLevel(_lvl)
    check(not any("ERROR" in ln and "oo6_kr2_invoiced" in ln for ln in _lb.getvalue().splitlines())
          and "not_located" in _lb.getvalue(),
          "an unpinned OO6 cell is not logged as an ERROR - it is not a failed pull")
    check(any(ln.startswith(("INFO", "WARNING")) and "oo6_kr2_invoiced" in ln for ln in _lb.getvalue().splitlines()),
          "...it is logged at INFO/WARNING (the capture sees levels, so the check above can fail)")
    doc = json.load(open(os.path.join(tmp, "okr_sheet.json")))
    st = json.load(open(os.path.join(tmp, "okr_sheet_status.json")))
    check(doc["series"]["oo6_kr1"]["months"] == {"2026-10": 98}
          and doc["series"]["oo6_kr1"]["range"] == "A160:A172 + C160:C172"
          and st["ok"] is True and st["series_missing"] == {"oo6_kr2_invoiced": "not_located"},
          "the refresher writes OO6 KR1 with its pinned range; an unpinned invoiced cell is named, and the pull is ok")
    check(bake.okr_sheet_leaks(open(os.path.join(tmp, "okr_sheet.json")).read()) == [],
          "...and nothing in it trips the bake's Finance check")
    # a per-series 503 on a pinned OO6 cell is named as Google's, never 'tab_missing'
    _f0 = ros.fetch
    _okrs = [["Month ", "Limit", "Actual"], ["Jan-26", "100", "100"]]
    _lg = [["Month", "Log"], ["January 2026", "0"]]
    ros.fetch = lambda sid, spreadsheet=None: ({
        "okrs": ("2026 OKRs", 3, _okrs), "oo2_kr3": ("c", 1, _lg), "oo3_kr3": ("m", 2, _lg),
        "oo4_kr1": ("l", 4, _lg)}, {"oo6_kr1": "google_down", "oo6_kr2_invoiced": "not_located"})
    try:
        ros.main(["--out", os.path.join(tmp, "okr_sheet.json")])
    finally:
        ros.fetch = _f0
    st = json.load(open(os.path.join(tmp, "okr_sheet_status.json")))
    check(st["ok"] is False and st["cause"] == "google_down"
          and st["series_missing"] == {"oo6_kr1": "google_down", "oo6_kr2_invoiced": "not_located"},
          "a per-series Google failure on an OO6 cell is the status's cause as itself - never 'tab_missing'")
    ros.fetch = lambda sid, spreadsheet=None: ({
        "okrs": ("2026 OKRs", 3, _okrs), "oo2_kr3": ("c", 1, _lg), "oo3_kr3": ("m", 2, _lg),
        "oo4_kr1": ("l", 4, _lg)}, {"oo6_kr1": "not_shared", "oo6_kr2_invoiced": "not_located"})
    try:
        ros.main(["--out", os.path.join(tmp, "okr_sheet.json")])
    finally:
        ros.fetch = _f0
    check(json.load(open(os.path.join(tmp, "okr_sheet_status.json")))["cause"] == "not_shared",
          "...including a cause outside CAUSE_RANK (a per-series 403), which is named as itself too")
finally:
    os.environ.pop("PULLED_AT", None)
    os.environ.pop("OKR_CELLS_OO6_KR1", None)
    shutil.rmtree(tmp)

# the bake's side
doc, err, probs = bake._okr_sheet_clean({"series": {
    "oo6_kr1": {"pulled_at": "2026-11-02T10:00:00Z", "months": {"2026-10": 98, "2026-11": 101}},
    "oo6_kr2_invoiced": {"pulled_at": "2026-11-02T10:00:00Z", "months": {"2026-09": True, "2026-10": "yes", "2026-08": 1}},
    "oo7_new": {"pulled_at": "2026-11-02T10:00:00Z", "months": {}}}})
check(doc["series"]["oo6_kr1"]["months"] == {"2026-10": 98} and doc["series"]["oo6_kr2_invoiced"]["months"] == {"2026-09": True}
      and len(probs) == 4 and any("oo7_new" in p for p in probs),
      "the loader keeps 0-100 for OO6 KR1, ONLY true/false for invoiced (not 'yes', not 1), and names an unknown series")
SD = {"pulled_at": "2026-11-02T10:00:00Z", "series": {
    "oo6_kr1": {"tab": "2026 OKRs", "pulled_at": "2026-11-02T10:00:00Z", "months": {"2026-10": 99}},
    "oo6_kr2_invoiced": {"tab": "2026 OKRs", "pulled_at": "2026-11-02T10:00:00Z", "months": {"2026-10": True}}}}
ex, gp = bake.okr_sheet_extra(SD, None, None, "2026-11", today="2026-11-02")
k1 = by_m(ex[("OO6", "KR1")])
check(sorted(k1) == ["2026-10", "2026-11"] and k1["2026-10"]["score"] == 80 and k1["2026-10"]["display"] == "99%"
      and ex[("OO6", "KR1")]["source_kind"] == "sheet_input" and "typed by Matthew" in k1["2026-10"]["basis"]
      and "Finance" not in k1["2026-10"]["basis"],
      "OO6 KR1: from October only, 99% on 'full' scores 80, typed by Matthew - not labelled Finance's")
check(not any("OO6 KR1" in g and "Jan" in g for g in gp), "...and January-September are never 'not entered'")
fl = bake.okr_sheet_flags(SD, None, None, "oo6_kr2_invoiced", "2026-11")
check(fl["2026-10"][0] is True and "entered as yes" in fl["2026-10"][1] and fl["2026-11"][0] is None
      and sorted(fl) == ["2026-10", "2026-11"], "invoiced: October yes; November (read while in progress) unknown")
fl = bake.okr_sheet_flags(None, "absent", {"ok": False, "cause": "not_shared", "detail": ros.CAUSE_TEXT["not_shared"],
                                           "attempted_at": "2026-10-21T14:00:00Z"}, "oo6_kr2_invoiced", "2026-10")
check(fl["2026-10"][0] is None and "HTTP 403" in fl["2026-10"][1], "no sheet: unknown, naming the 403")
fl = bake.okr_sheet_flags({"pulled_at": "x", "series": {}}, None,
                          {"ok": True, "series_missing": {"oo6_kr2_invoiced": "not_located"}},
                          "oo6_kr2_invoiced", "2026-10")
check(fl["2026-10"][0] is None and "not pinned yet" in fl["2026-10"][1], "unpinned: unknown, and says why")
fl = bake.okr_sheet_flags(SD, None, None, "oo6_kr2_invoiced", "2026-11", dated="2026-11-01")
check(fl["2026-10"][0] is None and "after this snapshot's date" in fl["2026-10"][1],
      "a back-bake never uses a copy read after its date")

# ===========================================================================
print("\n== Part 5: OO6 KR2 - JFC's PO in full AND invoiced ==")


def po(n, coll, failed=False, unclear=0, lines=()):
    return {"po": f"UK {n}", "emailed": coll, "collection": coll, "how": "x", "failed": failed,
            "lines": list(lines), "extra": 0, "replies": 1, "unclear": unclear}


POS = [po(16501, "2026-10-01"), po(16502, "2026-10-08"), po(16503, "2026-10-15"), po(16504, "2026-10-22")]


def kr2(pos, inv, pull="2026-11", asof="2026-11-04", jfc_pull="2026-11-03"):
    return fk.oo6_kr2_months(pos=pos, jfc_pull=jfc_pull, invoiced=inv, pull_month=pull,
                             first_month="2026-10", mvar=mvar, score_fn=score("prod"), rag_fn=rag, asof=asof)


Y = {"2026-10": (True, "entered as yes"), "2026-11": (None, "not entered")}
o = by_m(kr2(POS, Y)[0])["2026-10"]
check(o["value"] == 100.0 and o["score"] == 100 and o["display"] == "100.0% (4 of 4)",
      f"October: 4 POs in full and invoiced -> 100 (got {o['display']})")
check("OO5 KR5's test" in o["basis"] and "'last week'" in o["basis"] and "Lynas" in o["basis"],
      "...and the basis states the test, the earlier-shortfall rule and that Lynas is not counted")
o = by_m(kr2(POS[:3] + [po(16504, "2026-10-22", failed=True, lines=["short MR005 1 carton"])], Y)[0])["2026-10"]
check(o["value"] == 75.0 and o["score"] == 0 and "NOT IN FULL - short MR005 1 carton" in o["basis"],
      "one PO short: 3 of 4 = 75% -> 0, naming the line")
o = by_m(kr2(POS, {"2026-10": (None, "not entered for October 2026")})[0])["2026-10"]
check(o["value"] is None and o.get("score") is None and "not entered for October 2026" in o["not_measured"]
      and "4 in full" in o["not_measured"],
      "invoicing not known: NOT SCORED, naming why - the fulfilment so far is still shown")
o = by_m(kr2(POS, {"2026-10": (False, "entered as no")})[0])["2026-10"]
check(o["score"] == 0 and o["display"] == "at most 75.0% (3 of 4)" and "even the best case" in o["basis"],
      "'not all invoiced': at most 3 of 4 pass, 75% at best - already 0 on 'prod', so scored 0")
mix = [po(16501, "2026-10-01"), po(16502, "2026-10-08", failed=True, lines=["short MR005 1 carton"]),
       po(16503, "2026-10-15", failed=True, lines=["damaged MR014 2 cartons"]), po(16504, "2026-10-22", unclear=1),
       po(16505, "2026-10-29")]
o = by_m(kr2(mix, {"2026-10": (False, "entered as no")}, asof="2026-11-10", jfc_pull="2026-11-10")[0])["2026-10"]
check(o["display"] == "at most 60.0% (3 of 5)" and o["score"] == 0,
      f"an unclear PO is counted once in the bound, not twice: 5 POs, 2 failed -> at most 3 of 5 (got {o['display']})")
many = [po(17000 + i, f"2026-10-{1 + i % 28:02d}") for i in range(25)]
o = by_m(kr2(many, {"2026-10": (False, "entered as no")})[0])["2026-10"]
check(o.get("score") is None and o.get("incomplete") and o["display"] == "at most 96.0% (24 of 25)",
      "...but with 25 POs the best case (96%) would still score, so it is an upper bound, unscored")
o = by_m(kr2(POS, Y, asof="2026-11-02", jfc_pull="2026-10-28", pull="2026-11")[0])["2026-10"]
check(o.get("score") is None and o.get("incomplete") and "not had 7 days" in o["basis"],
      "a closed month holding a PO JFC has not had 7 days to report on is not scored")
o = by_m(kr2(POS[:3] + [po(16504, "2026-10-22", unclear=1)], Y)[0])["2026-10"]
check(o.get("score") is None and "without naming a product or quantity" in o["basis"],
      "an unclear shortage reply leaves the month unscored")
o = by_m(kr2(POS, {"2026-10": (True, "entered as yes")}, pull="2026-10", asof="2026-10-31")[0])["2026-10"]
check(o.get("mtd") and o.get("score") is None and o["value"] is None and "typed after it closes" in o["basis"],
      "the month in progress is never scored - its invoicing is a typed figure")
ex, gp = kr2(None, Y)
check(ex["months"] is None and "absent" in ex["not_measured"] and gp, "no PO feed: grey, naming it")
o = by_m(kr2([], {"2026-10": (True, "y")})[0])["2026-10"]
check(o["value"] is None and o["not_measured"] == "no JFC PO collected in October 2026",
      "a closed month with no PO: not measured, never 100")
check(fk.published_leaks(kr2(POS, Y)[0]["months"]) == [], "the published text passes KR5's leak check")
# the shared rule: KR5 and KR2 judge the same POs the same way
kn, aw, seen = fk.jfc_known(POS + [po(16600, "2026-11-20")], "2026-10-28", "2026-11-04")
check([p["po"] for p in kn] == ["UK 16501", "UK 16502", "UK 16503"] and [p["po"] for p in aw] == ["UK 16504"]
      and seen == "2026-10-28", "jfc_known: known after 7 days in the replies read; awaiting before; future POs neither")

# ===========================================================================
print("\n== Part 6: the real builder ==")
btmp = tempfile.mkdtemp(prefix="oo6bake-")
wd = os.path.join(btmp, "warehouse_direct")


def put(pull, slug, feed, rows):
    pdir = os.path.join(wd, pull)
    os.makedirs(pdir, exist_ok=True)
    with gzip.open(os.path.join(pdir, slug + ".jsonl.gz"), "wt") as fh:
        for i, row in enumerate(rows):
            fh.write(json.dumps({"row_num": i, "data": row}) + "\n")
    fp = os.path.join(pdir, "_feeds.json")
    m_ = json.load(open(fp)) if os.path.exists(fp) else {}
    m_[slug] = feed
    json.dump(m_, open(fp, "w"))


def drange(a, b):
    x, y = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
    while x <= y:
        yield x.isoformat()
        x += dt.timedelta(days=1)


FORMS = {"F0": ("2026-10-14", "Maki NE1 Ltd", "AA Factory", "chilli oil short"),
         "F1": ("2026-10-09", "Maki NE1 Ltd", "Lynas", "lack of one box laksa frozen ramen"),
         "F2": ("2026-10-09", "Maki Leicester Ltd", "JFC", "M&R black tonkontsu ramen *1 missing"),
         "F3": ("2026-10-12", "Maki Lakeside", "JFC", "missing m&r hell ramen"),
         "F4": ("2026-10-20", "Maki Aberdeen Ltd", "Lynas", "missing ramen noodles")}


def answers(lo, hi):
    out = []
    for d in drange(lo, hi):
        out.append({"FormId": f"R{d}", "TaskID": "1", "FormTemplateName": "Opening Checks",
                    "TaskName": "Fridge temp?", "Answer": "3", "LocationNameLabel": "Maki SJQ Ltd",
                    "AnsweredDateTime": d + "T09:00:00", "IsOpenDeviation": "false", "AnswerID": f"A{d}"})
        for fid, (fd, site, sup, text) in FORMS.items():
            if fd == d:
                for t, (task, ans) in enumerate([("Supplier?", sup), ("Issue?", text)]):
                    out.append({"FormId": fid, "TaskID": str(t), "FormTemplateName": "Delivery/Supplier Issue Form",
                                "TaskName": task, "Answer": ans, "LocationNameLabel": site,
                                "AnsweredDateTime": d + "T11:00:00", "IsOpenDeviation": "true",
                                "AnswerID": f"{fid}-{t}"})
    return out


x = dt.date(2026, 9, 26)
while x <= dt.date(2026, 11, 4):
    put(x.isoformat(), "GC_Form_Task_Answers", "GC Form Task Answers",
        answers((x - dt.timedelta(days=8)).isoformat(), (x - dt.timedelta(days=1)).isoformat()))
    x += dt.timedelta(days=4)
# the newest pull, so the verifier's undated recompute bakes the same day
put("2026-11-03", "GC_Form_Task_Answers", "GC Form Task Answers", answers("2026-10-26", "2026-11-02"))


def msg(po_, kind, when, role, text):
    return {"PO": po_, "Kind": kind, "Message Date": when, "Sender Role": role, "Text": text}


put("2026-11-03", "JFC_Factory_POs", "JFC Factory POs",
    [msg("UK 16500", "po", "2026-10-09T08:00:00+00:00", "jfc", "collect the shipment on Thursday."),
     msg("UK 16500", "reply", "2026-10-16T09:00:00+00:00", "jfc", "all received, thanks"),
     msg("UK 16510", "po", "2026-10-16T08:00:00+00:00", "jfc", "collect the shipment next Thursday.")])
out = os.path.join(btmp, "out")
os.makedirs(out)
shutil.copy(os.path.join(REPO, "data", "ops_command", "feeds_manifest.json"), out)
json.dump({"pulled_at": "2026-11-03T19:00:00Z", "series": {
    "oo6_kr1": {"tab": "2026 OKRs", "gid": 3, "pulled_at": "2026-11-03T19:00:00Z", "range": "A160:A172 + C160:C172",
                "months": {"2026-10": 100}, "as_of": "2026-10"},
    "oo6_kr2_invoiced": {"tab": "2026 OKRs", "gid": 3, "pulled_at": "2026-11-03T19:00:00Z",
                         "range": "A160:A172 + E160:E172", "months": {"2026-10": True}, "as_of": "2026-10"}}},
          open(os.path.join(out, "okr_sheet.json"), "w"))
_labels = []
for gc_ in bake.OO6_KR3_SITES:
    k_ = next(k for k, v in bake.SITE_ALIASES.items() if v[0] == gc_)
    _labels.append("Maki NE1 Ltd" if k_ == "newcastle" else "Maki & Ramen - " + bake.SITE_ALIASES[k_][1])
json.dump({"pulled_at": "2026-11-03T19:00:00Z", "basis": rfs.BASIS, "reader": rfs.READER,
           "weeks": {w_: week(w_, {lb: {"lines": 4, "counted": 4} for lb in _labels})
                     for w_ in OCT + ["2026-11-02"]},
           # the shape the reader writes since 27/10/2026: closed months, and an
           # unreadable per-restaurant export carrying the week its name gives
           "closed_months": [{"month": "2026-09", "read_through_at": "2026-10-15T19:00:00.000Z",
                              "saved": ["2026-10-05T09:00:00.000Z"], "unknown": []}],
           "unread_reports": [{"modified_at": "2026-11-02T09:00:00.000Z", "cause": "venue_unknown",
                               "detail": rfs.CAUSE_TEXT["venue_unknown"], "week": "2026-11-02"}]},
          open(os.path.join(out, fr.STOCK_FILE), "w"))
NCL = "Maki & Ramen - Maki Newcastle"
json.dump({"pulled_at": "2026-11-03T19:00:00Z", "site_orders": {
    "tab": rfw.ORDERS_TAB, "read_at": "2026-11-03T19:00:00Z", "problems": [],
    "days": [{"date": d_, "sites": {NCL: {"lines": 1, "units": 2}}} for d_ in drange("2026-10-01", "2026-11-03")]}},
          open(os.path.join(out, "factory_workbook.json"), "w"))
env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=wd, OPS_OUT_DIR=out)
p = subprocess.run([sys.executable, os.path.join(REPO, "builders", "bake_ops_command.py"),
                    "--date", "2026-11-04"], env=env, capture_output=True, text=True)
check(p.returncode == 0, "the real builder bakes the fixture as of 04/11/2026"
      + ("" if p.returncode == 0 else ": " + p.stderr[-1500:]))
if p.returncode == 0:
    snap = json.load(open(os.path.join(out, "snapshot_2026-11-04.json")))
    sc = snap["scorecard"]
    rows = {(r["objective"], r["kr"]): r for r in sc["rows"]}

    def var(k, m_):
        return next((v for v in rows[k]["months"] or [] if v["m"] == m_), {})

    check([rows[("OO6", k)]["band"] for k in ("KR1", "KR2", "KR3", "KR4", "KR5")]
          == ["full", "prod", "full", None, None] and rows[("OO6", "KR3")]["target"] == "100%",
          "the bands Ross signed off: KR1 full, KR2 prod, KR3 full at 100%; KR4/KR5 none")
    k1 = var(("OO6", "KR1"), "2026-10")
    check(k1.get("score") == 100 and k1.get("display") == "100%"
          and (k1.get("reference") or {}).get("value") == 3 and (k1.get("reference") or {}).get("display") == "3",
          f"OO6 KR1 October: Matthew's 100% -> 100; beside it, 3 frozen-ramen forms, not scored (got {k1.get('reference')})")
    check("Maki NE1 Ltd" in k1["reference"]["basis"] and "ramen noodles" not in k1["reference"]["basis"],
          "...the forms are listed; 'ramen noodles' is not one")
    check("reference" in rows[("OO6", "KR1")], "the row carries the default month's reference too")
    k2 = var(("OO6", "KR2"), "2026-10")
    check(k2.get("score") == 100 and k2.get("display") == "100.0% (2 of 2)",
          f"OO6 KR2 October: 2 JFC POs in full and invoiced -> 100 (got {k2.get('display')}, {k2.get('not_measured')})")
    k3 = var(("OO6", "KR3"), "2026-10")
    check(k3.get("score") == 100 and k3.get("display") == "100.0% (80 of 80 location-weeks, 4 weeks)",
          f"OO6 KR3 October: all 20 restaurants counted in all 4 weeks -> 100 (got {k3.get('display')})")
    k3n = var(("OO6", "KR3"), "2026-11")
    check(k3n.get("mtd") and k3n.get("score") is None, "OO6 KR3 November: 3 days of data -> month to date, unscored")
    check(any("(for the w/c 02/11, by its file name), could not be read" in g_ for g_ in snap["gaps"]),
          "a copy with closed months and an unreadable export bakes - the gap names the export's week")
    check(rows[("OO6", "KR3")]["source_kind"] == "stock_report" and rows[("OO6", "KR1")]["source_kind"] == "sheet_input",
          "the rows say where they come from")
    ob = {o_["objective"]: o_ for o_ in sc["objectives"]}
    oct6 = next(x_ for x_ in ob["OO6"]["months"] if x_["m"] == "2026-10")
    check(oct6["pct"] == 100.0 and oct6["scored"] == 3, "OO6 October: 3 of 5 scored, 100%")
    opm = next(x_ for x_ in sc["operations"]["months"] if x_["m"] == "2026-10")
    check(opm["scored"] >= 1 and any(o_["objective"] == "OO6" for o_ in sc["objectives"]),
          "OO6 counts towards Operations in October")
    check(not any(v_.get("m") == "2026-09" for k in ("KR1", "KR2", "KR3")
                  for v_ in rows[("OO6", k)]["months"] or []), "no OO6 month before October")
    for k in ("KR4", "KR5"):
        check(rows[("OO6", k)]["score"] is None and "no agreed measure" in rows[("OO6", k)]["not_measured"],
              f"OO6 {k} stays grey with its blocker named")
    # NE1 is Newcastle wherever a join is made on GC names
    check(snap["site_regions"].get("Maki NE1 Ltd") == "scotland", "NE1 has Newcastle's region")
    ev = [e for e in snap["cross_ref"]["events"] if e["kind"] == "supplier_issue" and e["d"] == "2026-10-09"]
    check(any(e["site_key"] == "newcastle" for e in ev), "an NE1 issue form joins the cross-reference as Newcastle")
    check(not any("NE1" in g and "alias" in g for g in snap["gaps"]), "...and is not in the alias gap")
    check(snap["cross_ref"]["site_aliases"]["newcastle"].get("gc_also") == ["Maki NE1 Ltd"],
          "the alias map publishes the extra label")
    k5 = var(("OO5", "KR5"), "2026-10")
    check(f"{NCL} 14/10 (issue form naming the factory on 14/10)" in (k5.get("basis") or "")
          and "no order to charge" not in (k5.get("basis") or ""),
          "OO5 KR5: a form at 'Maki NE1 Ltd' naming the factory is charged to NEWCASTLE's site order, not left unmatched")

    import okr_pack
    pk = okr_pack.build(snap, "2026-10", "first", "2026-11-04")
    k1p = next(k for o_ in pk["objectives"] if o_["objective"] == "OO6" for k in o_["krs"] if k["kr"] == "KR1")
    md = okr_pack.to_md(pk)
    _row = next(ln for ln in md.splitlines() if ln.startswith("| KR1 Maintain 100% Supply Chain"))
    _cells = [c.strip() for c in _row.strip("|").split(" | ")]
    check(k1p["reference"]["value"] == 3 and _cells[2] == "100%" and _cells[3] == "100"
          and "REFERENCE, NOT SCORED - Frozen ramen on issue forms (reference, not scored): 3" in _cells[5]
          and "REFERENCE" not in " ".join(_cells[:5]),
          "the OKR pack carries the reference in the Basis cell - never in the Value or Score column")

    import verify_ops_data as vod
    vod.RESULTS.clear()
    vod.check_okr_scorecard(snap, "2026-11-04")
    crit = [r_ for r_ in vod.RESULTS if r_["level"] == "critical"]
    check(not crit, "the verifier's scorecard checks pass" + ("" if not crit else ": " + "; ".join(
        c["detail"][:200] for c in crit)))
    print("\n-- the verifier's recompute (check 4b) --")
    vod.OUT_DIR = out
    vod.OKR_SHEET_PATH = os.path.join(out, "okr_sheet.json")
    vod.OKR_SHEET_STATUS_PATH = os.path.join(out, "okr_sheet_status.json")
    vod.FROZEN_STOCK_PATH = os.path.join(out, fr.STOCK_FILE)
    vod.FROZEN_STOCK_STATUS_PATH = os.path.join(out, fr.STOCK_STATUS_FILE)
    vod.RESULTS.clear()
    vod.fetch_json = lambda *a, **k: (_ for _ in ()).throw(OSError("offline in tests"))
    os.environ.update(OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=wd)
    rc = vod.check_consistency("2026-11-03", "2026-11-03")
    bad = [r_["detail"] for r_ in vod.RESULTS if r_["check"] == "4b-consistency"
           and ("recompute failed" in r_["detail"] or "could not run" in r_["detail"])]
    check(rc is not None and not bad, "the recompute runs with frozen_ramen.py" + (f": {bad}" if bad else ""))
    if rc:
        r3 = next(r_ for r_ in rc["scorecard"]["rows"] if (r_["objective"], r_["kr"]) == ("OO6", "KR3"))
        check(next((v for v in r3["months"] or [] if v["m"] == "2026-10"), {}).get("score") == 100,
              "...and reads the stock count copy, as the live bake does")

    print("\n-- a back-bake before October --")
    p2 = subprocess.run([sys.executable, os.path.join(REPO, "builders", "bake_ops_command.py"),
                         "--date", "2026-09-30"], env=env, capture_output=True, text=True)
    if p2.returncode == 0:
        s9 = json.load(open(os.path.join(out, "snapshot_2026-09-30.json")))
        r9 = {(r_["objective"], r_["kr"]): r_ for r_ in s9["scorecard"]["rows"]}
        check(all(r9[("OO6", k)]["months"] is None and "measured from October 2026" in r9[("OO6", k)]["not_measured"]
                  for k in ("KR1", "KR2", "KR3")), "September: OO6 KR1-KR3 are grey - measured from October")
        check(not any("OO6" in g_ for g_ in s9["gaps"]),
              "...and no gap of that snapshot blames anything else for OO6 (the sheet, the PO feed, the stock count)")
    else:
        check(False, "the September back-bake runs: " + p2.stderr[-800:])

    print("\n-- a leak in the stock count copy refuses the bake --")
    d_ = json.load(open(os.path.join(out, fr.STOCK_FILE)))
    d_["weeks"]["2026-10-05"]["locations"]["someone@maki.co.uk"] = {"lines": 1, "counted": 1}
    json.dump(d_, open(os.path.join(out, fr.STOCK_FILE), "w"))
    p3 = subprocess.run([sys.executable, os.path.join(REPO, "builders", "bake_ops_command.py"),
                         "--date", "2026-11-04"], env=env, capture_output=True, text=True)
    check(p3.returncode == 1 and "REFUSING TO BAKE" in p3.stderr and "someone@" not in p3.stderr,
          "the bake refuses to publish it, naming where - never the value")
shutil.rmtree(btmp)


# ===========================================================================
print("\n== Part 7: Kobas's Stock Usage Comparison, one restaurant per file (Ross, 27/10/2026) ==")
# The header of the real export (26/10/2026); every value below is MADE UP -
# the real file carries revenue and GP, which never enter this public repo.
KOBAS_HEADER = [
    "Ingredient ID", "Ingredient Category", "Ingredient Name", "Unit Description", "Net Revenue",
    "Actual GP %", "Actual Units", "Actual Value", "Theory GP %", "Theory Units", "Theory Value",
    "Usage Variance Units", "Usage Variance Value", "Usage Variance %", "Control Gap", "Sales Units",
    "Sales Value", "Sales GP %", "Waste Units", "Waste Value", "Waste % of Theory", "Comp Units",
    "Comp Value", "Comp % of Theory", "Directors Units", "Directors Value", "Directors % of Theory",
    "Opening Stock Units", "Opening Stock Value", "Opening Stock Ingredient Units",
    "Opening Stock Ingredient Value", "Opening Stock Batch Units", "Opening Stock Batch Value",
    "Delivered Units", "Delivered Value", "Credit Notes Units", "Credit Notes Value",
    "Transferred In Units", "Transferred In Value", "Transferred Out Units", "Transferred Out Value",
    "Closing Stock Units", "Closing Stock Value", "Closing Stock Ingredient Units",
    "Closing Stock Ingredient Value", "Closing Stock Batch Units", "Closing Stock Batch Value"]
FROZEN4 = ["M&R Black Garlic Tonkotsu", "M&R Chicken Ramen", "M&R Hell Ramen", "M&R Laksa Ramen"]


def kobas_rows(lines):
    """[(ingredient, closing stock units)] -> rows under the real header, every
    other cell a made-up figure the copy must never carry."""
    out = [KOBAS_HEADER]
    for i, (name, closing) in enumerate(lines):
        row = []
        for h in KOBAS_HEADER:
            row.append({"Ingredient ID": str(7000 + i), "Ingredient Name": name,
                        "Ingredient Category": "FROZEN STORE" if fr.is_frozen_ramen(name) else "DRINKS",
                        "Unit Description": "750 grams", "Closing Stock Units": closing}.get(h, "4321.09"))
        out.append(row)
    return out


def kobas_csv(lines):
    buf = io.StringIO()
    csv.writer(buf).writerows(kobas_rows(lines))
    return buf.getvalue().encode("utf-8")


def kname(venue, frm, to, ext=".csv"):
    return f"KOBAS_Stock_Usage_Comparison_Report_{venue}_{frm}_{to}{ext}"


def kslug(kobas_venue):
    """How Kobas spells a restaurant in a file name ('Maki 1/2 (Nicolson St)' ->
    'Maki-12-Nicolson-St', as in the real export's name)."""
    return re.sub(r"[^A-Za-z0-9 -]", "", kobas_venue).strip().replace(" ", "-")


ALLZERO = [(n, "0") for n in FROZEN4] + [("Asahi Super Dry", "64"), ("RAMEN NOODLES", "40")]
check(kslug("Maki 1/2 (Nicolson St)") == "Maki-12-Nicolson-St", "(the test spells names as Kobas does)")
check(rfs.kobas_name(kname("Maki-12-Nicolson-St", "2026-10-17", "2026-10-24"))
      == ("Maki-12-Nicolson-St", "2026-10-24")
      and rfs.kobas_name(kname("Maki-12-Nicolson-St", "2026-10-17", "2026-10-24", " (1).csv"))
      == ("Maki-12-Nicolson-St", "2026-10-24")
      and rfs.kobas_name(kname("Maki-Leeds", "2026-10-17", "2026-10-24", "")) == ("Maki-Leeds", "2026-10-24")
      and rfs.kobas_name(kname("Maki-Leeds", "2026-10-17", "2026-10-24", ".xlsx")) == ("Maki-Leeds", "2026-10-24"),
      "Kobas's per-restaurant name: the restaurant and the period's END - a browser's ' (1)', an .xlsx "
      "and a Google Sheet's missing extension too")
check(rfs.kobas_name(kname("Maki-Leeds", "2026-10-24", "2026-10-17")) is None
      and rfs.kobas_name(kname("Maki-Leeds", "2026-10-17", "2026-13-24")) is None
      and rfs.kobas_name("Stock count Maki Leeds 2026-10-24.csv") is None
      and rfs.kobas_name("KOBAS_Stock_Usage_Comparison_Report_2026-10-17_2026-10-24.csv") is None,
      "...never a period that ends before it starts, an impossible date, another name, or no restaurant")
hi, cols = rfs.find_header(kobas_rows(ALLZERO), location_optional=True)
check(hi == 0 and cols == {"item": 2, "count": 41},
      "the real header: the item is 'Ingredient Name' and the count 'Closing Stock Units' - never the "
      "ID, the category, 'Unit Description', a value or the ingredient/batch split")
try:
    rfs.find_header(kobas_rows(ALLZERO))
    check(False, "without a restaurant from the name, the header has no location")
except rfs.DriveError as e:
    check(e.cause == "header_missing" and e.roles == ["location"], "...without the name, location is what is missing")
_hd = [h for h in KOBAS_HEADER if h != "Closing Stock Units"]
try:
    rfs.find_header([_hd], location_optional=True)
    check(False, "a Kobas export without Closing Stock Units has no count")
except rfs.DriveError as e:
    check(e.cause == "header_missing" and e.roles == ["count"],
          "an export without Closing Stock Units: missing the count (not the location the name gives)")

# the restaurant: spelled as a file name spells it, matched to the site map
for k_, (gc_, kob_, lab_) in bake.SITE_ALIASES.items():
    check(MATCH(kslug(kob_)) == lab_, f"Kobas's file-name spelling {kslug(kob_)!r} is {lab_}")
for v_ in bake.KOBAS_ONLY_VENUES:
    check(MATCH(kslug(v_)) == v_, f"...and the Kobas-only {v_}")
check(MATCH("Maki-Atlantis") is None and MATCH("OLD-Maki-Bath-Street") is None and MATCH("") is None,
      "a restaurant on no site map is not guessed - an 'OLD:' venue neither")
_amb = fr.site_matcher([("A", ["Maki Bath St"]), ("B", ["Maki BathSt"])])
check(_amb("Maki Bath St") == "A" and _amb("Maki BathSt") == "B" and _amb("MakiBath-St") is None
      and _amb("MAKIBATHST") is None,
      "two venues with one letters-only spelling: only an exact name matches, never a guess between them")

REAL = kname("Maki-12-Nicolson-St", "2026-10-17", "2026-10-24")
w = rfs.parse_report(kobas_csv(ALLZERO), REAL, "2026-10-26T17:57:52Z", MATCH)
w19 = w.get("2026-10-19") or {}
check(list(w) == ["2026-10-19"] and w19.get("week_from") == "period_end",
      "the week is the one the CLOSING stock take (24/10, the period's end) falls in - w/c 19/10, "
      "not the start date's 12/10")
check(w19.get("locations") == {"Maki 1/2 Nicolson St": {"lines": 4, "counted": 4}}
      and w19.get("frozen_lines") == 4 and w19.get("unrecognised_locations") == 0,
      "Ross, 27/10/2026: four frozen-ramen lines at 0 Closing Stock Units are FOUR COUNTS - Nicolson St is counted")
check(w19.get("columns") == {"item": "Ingredient Name", "count": "Closing Stock Units", "location": "(file name)"}
      and sorted(w19.get("items_matched") or []) == sorted(fr.CANON_ITEMS[i] for i in (0, 2, 3, 4)),
      "the copy says the restaurant came from the file name, and the products by their canonical names")
_wt = json.dumps(w)
check(not any(x in _wt for x in ("4321.09", "Nicolson-St", "KOBAS", "Asahi", "NOODLES", "7000", "750 grams",
                                 "2026-10-17")),
      "no figure, no file name or spelling of it, no other product, no ID or unit is kept")
check(fr.stock_leaks(json.dumps({"weeks": {"2026-10-19": {**w19, "read_at": "2026-10-27T10:00:00Z"}}})) == [],
      "...and the bake's own publication check accepts it")
check(fr.stock_leaks(json.dumps({"weeks": {"2026-10-19": {**w19, "columns": {"location": "Maki-12-Nicolson-St"}}}}))
      != [], "...but refuses a copy carrying the file name's spelling as a column")
w = rfs.parse_report(kobas_csv([(FROZEN4[0], ""), (FROZEN4[1], "-2"), (FROZEN4[2], "n/a"), (FROZEN4[3], "")]),
                     REAL, "2026-10-26T17:57:52Z", MATCH)
w19 = w["2026-10-19"]
check(w19["locations"] == {"Maki 1/2 Nicolson St": {"lines": 4, "counted": 0}}
      and any("negative" in p_ for p_ in w19["problems"]) and any("not a number" in p_ for p_ in w19["problems"]),
      "a blank, a negative or a text Closing Stock Units is NOT a count - listed, not counted, and named")
w = rfs.parse_report(kobas_csv([(FROZEN4[0], "2.5")]), kname("Maki-12-Nicolson-St", "2026-10-17", "2026-10-24", ""),
                     "2026-10-26T17:57:52Z", MATCH)
check(w["2026-10-19"]["locations"]["Maki 1/2 Nicolson St"]["counted"] == 1,
      "a Google Sheet (no extension) reads the same; part of a box is a count")
_wb = openpyxl.Workbook()
for r_ in kobas_rows(ALLZERO):
    _wb.active.append([float(c) if c not in ("", "750 grams") and re.fullmatch(r"-?[\d.]+", c) else c for c in r_])
_buf = io.BytesIO()
_wb.save(_buf)
w = rfs.parse_report(_buf.getvalue(), kname("Maki-Yorkshire", "2026-10-17", "2026-10-24", ".xlsx"),
                     "2026-10-26T17:57:52Z", MATCH)
check(w["2026-10-19"]["locations"] == {"Maki Meadowhall": {"lines": 4, "counted": 4}},
      "an .xlsx export reads the same, numbers as numbers (Kobas's 'Maki Yorkshire' is Meadowhall)")
_withloc = [["Venue"] + KOBAS_HEADER] + [["Maki Leeds"] + r_ for r_ in kobas_rows(ALLZERO)[1:]]
_cbuf = io.StringIO()
csv.writer(_cbuf).writerows(_withloc)
w = rfs.parse_report(_cbuf.getvalue().encode(), REAL, "2026-10-26T17:57:52Z", MATCH)
check(list(w["2026-10-19"]["locations"]) == ["Maki Leeds"] and w["2026-10-19"]["columns"]["location"] == "Venue",
      "a Kobas-named report that DOES have a location column is read by the column, not the name")
_withdate = [KOBAS_HEADER + ["Count Date"]] + [r_ + ["15/10/2026"] for r_ in kobas_rows(ALLZERO)[1:]]
_dbuf = io.StringIO()
csv.writer(_dbuf).writerows(_withdate)
w = rfs.parse_report(_dbuf.getvalue().encode(), REAL, "2026-10-26T17:57:52Z", MATCH)
check(list(w) == ["2026-10-19"] and w["2026-10-19"]["week_from"] == "period_end",
      "a Kobas-named report is ONE week, its period's end, even with a date column (15/10 would be w/c 12/10) - "
      "so its month is known from its name before it is read")
try:
    rfs.parse_report(b"Outlet,Item,Count\nMaki Soho,Frozen Ramen - Hell Ramen,3\n", "stock.csv",
                     "2026-10-26T17:57:52Z", MATCH)
    check(False, "an all-restaurant report with an unknown location header is refused")
except rfs.DriveError as e:
    check(e.cause == "header_missing" and e.roles == ["location"],
          "an all-restaurant report whose location header is not known keeps header_missing (missing: location) - "
          "never Kobas's 'keep the file name'")
for nm_, data_, want in (
        ("stock usage nicolson.csv", kobas_csv(ALLZERO), "venue_not_named"),
        (kname("Maki-Atlantis", "2026-10-17", "2026-10-24"), kobas_csv(ALLZERO), "venue_unknown"),
        (kname("Maki-12-Nicolson-St", "2026-10-17", "2026-10-24"), kobas_csv([("Asahi", "3")]), "no_frozen_lines")):
    try:
        rfs.parse_report(data_, nm_, "2026-10-26T17:57:52Z", MATCH)
        check(False, f"{want} raises")
    except rfs.DriveError as e:
        check(e.cause == want and want in rfs.CAUSE_TEXT and "Atlantis" not in rfs.CAUSE_TEXT[want],
              f"{want}: a fixed cause that never repeats the name")


def krun(tmp_, files, pulled, mods, created=None):
    os.environ["PULLED_AT"] = pulled
    buf = io.StringIO()
    _o, sys.stdout = sys.stdout, buf
    try:
        rc_ = rfs.main(sum((["--from-file", f_] for f_ in files), [])
                       + sum((["--modified-at", m_] for m_ in mods), [])
                       + sum((["--created-at", c_] for c_ in (created or [])), []) + ["--out-dir", tmp_])
    finally:
        sys.stdout = _o
        os.environ.pop("PULLED_AT", None)
    st_ = json.load(open(os.path.join(tmp_, fr.STOCK_STATUS_FILE)))
    try:
        doc_ = json.load(open(os.path.join(tmp_, fr.STOCK_FILE)))
    except (OSError, ValueError):
        doc_ = None
    return rc_, st_, doc_, buf.getvalue()


ktmp = tempfile.mkdtemp(prefix="oo6-kobas-")
kdir = os.path.join(ktmp, "folder")
os.makedirs(kdir)
kout = os.path.join(ktmp, "out")
try:
    # twenty restaurants, one file each, the same week
    files, mods = [], []
    for gc_ in bake.OO6_KR3_SITES:
        k_ = next(k for k, v in bake.SITE_ALIASES.items() if v[0] == gc_)
        p_ = os.path.join(kdir, kname(kslug(bake.SITE_ALIASES[k_][1]), "2026-10-17", "2026-10-24"))
        open(p_, "wb").write(kobas_csv(ALLZERO))
        files.append(p_)
        mods.append(f"2026-10-26T{10 + len(files) // 4:02d}:{len(files):02d}:00Z")
    os.makedirs(kout)
    rc, st, doc, _o = krun(kout, files, "2026-10-27T10:00:00Z", mods)
    w19 = doc["weeks"]["2026-10-19"]
    check(rc == 0 and st["ok"] and st["reports_read"] == 20 and len(w19["locations"]) == 20
          and all(r_ == {"lines": 4, "counted": 4} for r_ in w19["locations"].values()),
          "twenty per-restaurant exports for one week merge into one week of twenty restaurants")
    check("counts merged from more than one report" in w19["problems"]
          and not any("newer wins" in p_ for p_ in w19["problems"]),
          "...said to come from several reports - and NOT that one replaced another, as none share a restaurant")
    _sites = [(bake.SITE_ALIASES[next(k for k, v in bake.SITE_ALIASES.items() if v[0] == g)][2],
               [g, bake.SITE_ALIASES[next(k for k, v in bake.SITE_ALIASES.items() if v[0] == g)][1]])
              for g in bake.OO6_KR3_SITES]
    sd, se = fr.load_stock(kout)
    ex, gp = fr.kr3_months(sd, se, fr.load_status(kout), _sites, "2026-10", "2026-10", mvar, score("full"), rag,
                           asof="2026-10-27")
    o = by_m(ex)["2026-10"]
    check("w/c 19/10: 20 of 20" in o["basis"] and "week from the report period's end date" in o["basis"]
          and "0 included (Ross, 27/10/2026)" in o["basis"] and "Closing Stock Units" in o["basis"],
          "OO6 KR3: w/c 19/10 is 20 of 20 - the basis says the week is the period's end and 0 is a count (Ross)")
    # a second download of one restaurant (' (1)') replaces the first
    p_ = files[0].replace(".csv", " (1).csv")
    open(p_, "wb").write(kobas_csv([(n, "") for n in FROZEN4]))
    rc, st, doc, _o = krun(kout, files + [p_], "2026-10-27T11:00:00Z", mods + ["2026-10-27T10:30:00Z"])
    _w = doc["weeks"]["2026-10-19"]
    check(len(_w["locations"]) == 20 and sum(r_["counted"] == 0 for r_ in _w["locations"].values()) == 1
          and any("newer wins" in p_ for p_ in _w["problems"]),
          "a newer export for the same restaurant and week replaces the older one, and says so")
finally:
    shutil.rmtree(ktmp)

# CLOSED MONTHS - per-restaurant exports would outgrow MAX_REPORTS. A month is
# re-read until day 15 of the next; the first bake on or after it reads the
# month one last time and closes it; then it stands as read then. Only Kobas's
# per-restaurant exports (one week each, known from the name) are not re-read.
ktmp = tempfile.mkdtemp(prefix="oo6-closed-")
kdir = os.path.join(ktmp, "folder")
os.makedirs(kdir)
kout = os.path.join(ktmp, "out")
os.makedirs(kout)
try:
    folder = {}          # path -> (modifiedTime, createdTime)

    def kput(fname, data, mod, created=None):
        p_ = os.path.join(kdir, fname)
        open(p_, "wb").write(data)
        folder[p_] = (mod, created or mod)
        return p_

    def kdel(*ps):
        for p_ in ps:
            os.remove(p_)
            del folder[p_]

    def kgo(pulled):
        fs_ = sorted(folder)
        return krun(kout, fs_, pulled, [folder[f_][0] for f_ in fs_], [folder[f_][1] for f_ in fs_])

    def gen(rows):
        return ("Venue,Item,Count Date,Count\n" + "".join(
            f"{v},Frozen Ramen - Hell Ramen,{d},{c}\n" for v, d, c in rows)).encode()

    def ucauses(d_):
        return sorted((u["cause"], u["modified_at"][:16]) for u in d_.get("unread_reports", []))

    def kr3_gaps(asof, dated=None):
        sd_, se_ = fr.load_stock(kout)
        return fr.kr3_months(sd_, se_, None, SITES + [("Maki 1/2 Nicolson St", ["M1TOO Ltd"])], "2026-10",
                             "2026-11", mvar, score("full"), rag, asof=asof, dated=dated)

    K_SEPT = kput(kname("Maki-Soho", "2026-09-26", "2026-10-03"), kobas_csv(ALLZERO), "2026-10-05T09:00:00Z")
    K_JULY = kput(kname("Maki-Soho", "2026-07-04", "2026-07-11"), kobas_csv(ALLZERO), "2026-10-05T09:30:00Z")
    K_OCT = kput(kname("Maki-12-Nicolson-St", "2026-10-17", "2026-10-24"), kobas_csv(ALLZERO), "2026-10-26T18:00:00Z")
    # uploaded 10/11 keeping its file's own modified time: createdTime is when it was saved here
    K_BAD = kput(kname("Maki-Atlantis", "2026-10-24", "2026-10-31"), kobas_csv(ALLZERO), "2026-11-02T09:00:00Z",
                 "2026-11-10T08:00:00Z")
    K_NOV = kput(kname("Maki-Leeds", "2026-10-31", "2026-11-07"), kobas_csv(ALLZERO), "2026-11-09T09:00:00Z")
    G_BAD = kput("stock count leeds.csv", b"Outlet,Item,Count Date,Count\nMaki Leeds,Frozen Ramen - Hell Ramen,"
                 b"20/10/2026,1\n", "2026-10-21T09:00:00Z")
    SPAN = kput("renfield.csv", gen([("Maki Renfield", "30/10/2026", 1), ("Maki Renfield", "03/11/2026", 1)]),
                "2026-11-03T09:00:00Z")
    SUN = kput("aberdeen sunday.csv", b"Venue,Item,Week Commencing,Count\nMaki Aberdeen,Frozen Ramen - Hell Ramen,"
               b"02/11/2026,1\n", "2026-11-01T21:00:00Z")
    rc, st, d1, _o = kgo("2026-11-10T10:00:00Z")
    check(st["ok"] and st["full_read"] is True and d1["reader"] == rfs.READER
          and sorted(d1["weeks"]) == ["2026-09-28", "2026-10-19", "2026-10-26", "2026-11-02"]
          and d1["closed_months"] == [{"month": "2026-08", "read_through_at": "2026-11-10T10:00:00.000Z", "saved": [],
                                       "unknown": [{"modified_at": "2026-10-21T09:00:00.000Z"}]},
                                      {"month": "2026-09", "read_through_at": "2026-11-10T10:00:00.000Z",
                                       "saved": ["2026-10-05T09:00:00.000Z"],
                                       "unknown": [{"modified_at": "2026-10-21T09:00:00.000Z"}]}]
          and st["reports_before_window"] == 1,
          "first read (no copy): every report is read; August and September close (September with the one "
          "export it holds); October not until 15/11; a July export is never read")
    ur1 = {u["cause"]: u for u in d1["unread_reports"]}
    check(ur1["venue_unknown"] == {"modified_at": "2026-11-10T08:00:00.000Z", "cause": "venue_unknown",
                                   "detail": rfs.CAUSE_TEXT["venue_unknown"], "week": "2026-10-26"}
          and "week" not in ur1["header_missing"] and "month" not in ur1["header_missing"],
          "an unreadable Kobas export is listed when it ARRIVED (createdTime) with its week; any other with neither")
    kgo("2026-11-14T10:00:00Z")
    K_BATH = kput(kname("Maki-Bath-Street", "2026-10-24", "2026-10-31"), kobas_csv(ALLZERO), "2026-11-14T15:00:00Z")
    rc, st, d2, _o = kgo("2026-11-14T23:00:00Z")
    check(not any(c["month"] == "2026-10" for c in d2["closed_months"])
          and "Maki Bath Street" in d2["weeks"]["2026-10-26"]["locations"],
          "23:00 UTC on 14/11 is still the 14th in the UK (GMT): October is open, and today's report is read")
    kdel(K_BATH)
    kgo("2026-11-14T23:30:00Z")
    K_BATH = kput(kname("Maki-Bath-Street", "2026-10-24", "2026-10-31"), kobas_csv(ALLZERO), "2026-11-14T15:00:00Z")
    rc, st, d3, _o = kgo("2026-11-15T00:30:00Z")
    oct3 = next((c for c in d3["closed_months"] if c["month"] == "2026-10"), {})
    check(oct3 == {"month": "2026-10", "read_through_at": "2026-11-15T00:30:00.000Z",
                   "saved": ["2026-10-26T18:00:00.000Z", "2026-11-03T09:00:00.000Z", "2026-11-10T08:00:00.000Z",
                             "2026-11-14T15:00:00.000Z"],
                   "unknown": [{"modified_at": "2026-10-21T09:00:00.000Z"},
                               {"modified_at": "2026-11-10T08:00:00.000Z", "week": "2026-10-26"}]}
          and "Maki Bath Street" in d3["weeks"]["2026-10-26"]["locations"]
          and not any(u["cause"] in fr.CLOSED_CAUSES for u in d3.get("unread_reports", [])),
          "the first bake of 15/11 reads October ONE LAST TIME and closes it - a report saved on the 14th after "
          "that day's bake counts - recording the reports it closed with (its three exports, the unreadable one "
          "too, and the two-month sheet) and the two it could not read, as its frozen lower bound "
          f"(got {oct3})")
    check("Maki Renfield" in d3["weeks"]["2026-10-26"]["locations"]
          and "Maki Aberdeen" in d3["weeks"]["2026-11-02"]["locations"],
          "...October's w/c 26/10 has the two-month sheet; November's w/c 02/11 the Sunday-night one")
    # October is closed: its exports are not read again - damage one to prove it
    open(K_OCT, "w").write("this is not the report any more\n")
    K_LATE = kput(kname("Maki-Soho", "2026-10-24", "2026-10-31"), kobas_csv(ALLZERO), "2026-11-16T09:00:00Z")
    G = kput("stock count.csv", gen([("Maki Soho", "27/10/2026", 1), ("Maki Soho", "17/11/2026", 1)]),
             "2026-11-16T09:30:00Z")
    K_BADNOV = kput(kname("Maki-Atlantis", "2026-11-07", "2026-11-14"), kobas_csv(ALLZERO), "2026-11-16T09:40:00Z")
    MOVEG = kput("soho catch-up.csv", gen([("Maki Lakeside", "27/10/2026", 1), ("Maki Lakeside", "10/11/2026", 1)]),
                 "2026-11-14T09:00:00Z")
    rc, st, d4, _o = kgo("2026-11-16T10:00:00Z")
    check(st["ok"] and st["full_read"] is False and st["reports_in_closed_months"] == 4
          and d4["weeks"]["2026-10-19"] == d3["weeks"]["2026-10-19"]
          and d4["weeks"]["2026-10-26"] == d3["weeks"]["2026-10-26"] and "2026-09-28" in d4["weeks"],
          "16/11: September's and October's weeks stand EXACTLY as they closed (read_at too); the four exports "
          "they closed with are not downloaded - one is now damaged and nothing changes")
    check(ucauses(d4) == [("closed_month_added", "2026-11-14T09:00"), ("header_missing", "2026-10-21T09:00"),
                          ("month_closed", "2026-11-16T09:00"), ("month_closed", "2026-11-16T09:30"),
                          ("venue_unknown", "2026-11-16T09:40")],
          f"named in the folder's current state: the unreadable sheet (re-read every bake), the sheet moved in "
          f"with an old date, the late export and the late sheet, and November's unreadable export - the "
          f"October export that could not be read is October's frozen lower bound instead (got {ucauses(d4)})")
    late4 = {u["modified_at"][:16]: u for u in d4["unread_reports"] if u["cause"] == "month_closed"}
    check(late4["2026-11-16T09:00"].get("week") == "2026-10-26" and late4["2026-11-16T09:00"].get("location") == "Maki Soho"
          and "week" not in late4["2026-11-16T09:30"] and late4["2026-11-16T09:30"]["month"] == "2026-10",
          "...the late export with its week and restaurant (never read); the late sheet with the month")
    check("Maki Soho" not in d4["weeks"]["2026-10-26"]["locations"]
          and "Maki Lakeside" not in d4["weeks"]["2026-10-26"]["locations"]
          and d4["weeks"]["2026-11-16"]["locations"] == {"Maki Soho": {"lines": 1, "counted": 1}}
          and "Maki Lakeside" in d4["weeks"]["2026-11-09"]["locations"]
          and "Maki Renfield" in d4["weeks"]["2026-11-02"]["locations"]
          and "Maki Aberdeen" in d4["weeks"]["2026-11-02"]["locations"],
          "no late or moved-in count reaches October; their November counts are used, as are the two-month and "
          "Sunday-night sheets' November weeks")
    check(fr.stock_leaks(open(os.path.join(kout, fr.STOCK_FILE)).read()) == [],
          "the copy with closed months passes the bake's publication check")
    ex, gp = kr3_gaps("2026-11-16")
    gl = " | ".join(gp)
    check("(for the w/c 26/10, Maki Soho, by its file name), was not read - it was saved after October 2026 closed" in gl
          and "saved 16/11/2026, was read - it was saved after October 2026 closed" in gl
          and "saved 14/11/2026, was not read when October 2026 closed for re-reading (it was not in the folder then" in gl
          and "October 2026 closed for re-reading with a report it could not read, saved 10/11/2026 (for the w/c "
              "26/10)" in gl
          and "saved 21/10/2026, could not be read" in gl,
          "the gaps say exactly what happened to each: not read (late export), read but not used (late sheet), "
          "not read when the month closed (moved in), and what October closed without being able to read")
    # a sheet re-saved in place: unchanged October rows are no news, even with an undated row added
    LIVE = kput("living.csv", gen([("Maki Renfield", "30/10/2026", 1), ("Maki Lakeside", "18/11/2026", 1),
                                   ("Maki Soho", "", 1)]), "2026-11-17T09:00:00Z")
    rc, st, d5, _o = kgo("2026-11-17T10:00:00Z")
    check(("month_closed", "2026-11-17T09:00") not in ucauses(d5)
          and "Maki Lakeside" in d5["weeks"]["2026-11-16"]["locations"],
          "a sheet saved after the close whose October count is what October closed with is NOT named (an "
          "undated row elsewhere in it does not make October's week differ); its November count is used")
    kdel(LIVE)
    G2 = kput("renfield redo.csv", gen([("Maki Renfield", "30/10/2026", "")]), "2026-11-17T09:10:00Z")
    kput(kname("Maki-Shoreditch", "2026-10-24", "2026-10-31"), kobas_csv(ALLZERO), "2026-11-02T09:00:00Z",
         "2026-11-17T11:00:00Z")
    kput(kname("Maki-Soho", "2026-10-03", "2026-10-10"), kobas_csv(ALLZERO), "2026-11-17T11:30:00Z")
    MOVEK = kput(kname("Maki-Lakeside", "2026-10-17", "2026-10-24"), kobas_csv(ALLZERO), "2026-11-02T09:00:00Z")
    rc, st, d6, _o = kgo("2026-11-17T12:00:00Z")
    u6 = ucauses(d6)
    check(("month_closed", "2026-11-17T09:10") in u6 and ("month_closed", "2026-11-17T11:00") in u6
          and ("month_closed", "2026-11-17T11:30") in u6 and ("closed_month_added", "2026-11-02T09:00") in u6
          and d6["weeks"]["2026-10-26"]["locations"]["Maki Renfield"] == {"lines": 1, "counted": 1}
          and "Maki Shoreditch" not in d6["weeks"]["2026-10-26"]["locations"]
          and "2026-10-05" not in d6["weeks"] and "Maki Lakeside" not in d6["weeks"]["2026-10-19"]["locations"],
          "after the close: a sheet changing a closed restaurant-week, an export uploaded late (createdTime 17/11 "
          "though modified 02/11), one for a week October closed WITHOUT, and one moved in with its old date are "
          f"all named and none moves October (got {u6})")
    # an open-month export that could not be read, read later with the SAME stamps, is no longer named
    open(K_BADNOV, "wb").write(b"Venue,Item,Count\nMaki Soho,RAMEN NOODLES,1\n")
    kdel(K_BADNOV)
    K_NOVX = kput(kname("Maki-Leicester", "2026-11-07", "2026-11-14"), b"not a stock report\n", "2026-11-16T11:00:00Z")
    rc, st, d7, _o = kgo("2026-11-18T10:00:00Z")
    check(("header_missing", "2026-11-16T11:00") in ucauses(d7) and "2026-11-09" in d7["weeks"],
          "an open month's damaged export is named")
    open(K_NOVX, "wb").write(kobas_csv(ALLZERO))
    rc, st, d8, _o = kgo("2026-11-18T11:00:00Z")
    check(("header_missing", "2026-11-16T11:00") not in ucauses(d8)
          and "Maki Leicester" in d8["weeks"]["2026-11-09"]["locations"],
          "...and once it reads (same stamps), it is counted and no longer named")
    # deleting reports after the close: the month stands; the unreadable export goes from the list
    kdel(K_BATH, K_BAD, MOVEK, MOVEG, G2)
    rc, st, d9, _o = kgo("2026-11-19T10:00:00Z")
    c9 = [c for c, _t in ucauses(d9)]
    oct9 = next(c for c in d9["closed_months"] if c["month"] == "2026-10")
    check("Maki Bath Street" in d9["weeks"]["2026-10-26"]["locations"] and "venue_unknown" not in c9
          and "closed_month_added" not in c9 and "header_missing" in c9
          and {"modified_at": "2026-11-10T08:00:00.000Z", "week": "2026-10-26"} in oct9["unknown"],
          f"a report deleted after its month closed changes nothing in it: its weeks, and the export it could "
          f"not read, which stays its lower bound though the file is gone (got {c9})")
    _cap, rfs.MAX_REPORTS = rfs.MAX_REPORTS, 9
    try:
        rc, st, d10, _o = kgo("2026-11-19T11:00:00Z")
        check(st["ok"] and st["reports_in_closed_months"] == 2 and st["reports_before_window"] == 1
              and st["reports_in_folder"] == 12 and st["reports_read"] == 5,
              "MAX_REPORTS (9 here) counts only the reports a run has to READ - twelve in the folder: two exports "
              "a closed month closed with, a July one, and three late ones are never downloaded; six are read "
              f"(got {st['cause']}, {st.get('reports_in_folder')}, {st.get('reports_in_closed_months')})")
        check(st["reports_unreadable"] == 1 and st["closed_month_notices"] == 4,
              "...and the status counts unreadable reports apart from closed-month notices")
        dd = json.load(open(os.path.join(kout, fr.STOCK_FILE)))
        dd["reader"] = 1
        json.dump(dd, open(os.path.join(kout, fr.STOCK_FILE), "w"))
        rfs.MAX_REPORTS = 5
        rc, st, d11, _o = kgo("2026-11-19T12:00:00Z")
        check(st["cause"] == "too_many_to_rebuild" and st["full_read"] is True
              and "raise MAX_REPORTS" in st["detail"] and "restore data/ops_command/frozen_stock_count.json" in st["detail"]
              and "would lose the months they hold" in st["detail"],
              "a copy written under OTHER rules is never built on - over the ceiling nothing is written, and the advice "
              "is to raise the ceiling for one run (or restore a lost copy), never to move reports out")
    finally:
        rfs.MAX_REPORTS = _cap
    rc, st, d12, _o = kgo("2026-11-19T13:00:00Z")
    check(st["ok"] and st["full_read"] is True and "2026-10-19" not in d12["weeks"]
          and any(u["cause"] == "header_missing" and u.get("week") == "2026-10-19" for u in d12["unread_reports"])
          and "Maki Soho" in d12["weeks"]["2026-10-26"]["locations"]
          and all(c["read_through_at"] == "2026-11-19T13:00:00.000Z" for c in d12["closed_months"]),
          "...a full read re-reads October too - the damaged export is named and its week goes, the late Soho "
          "export now counts - and closes every month due with itself")
    # the publication check knows the new fields exactly
    good = json.load(open(os.path.join(kout, fr.STOCK_FILE)))
    _u = {"modified_at": "2026-11-18T12:00:00.000Z", "cause": "x", "detail": "y"}
    _c = {"month": "2026-10", "read_through_at": "2026-11-18T12:00:00.000Z", "saved": [], "unknown": []}
    check(fr.stock_leaks(json.dumps(dict(good, closed_months=[_c]))) == [],
          "(the closed month the refusals below vary is itself accepted)")
    for bad_, why in ((dict(good, closed_months=[dict(_c, month="Oct")]), "a closed month that is not a month"),
                      (dict(good, closed_months=[dict(_c, month="2026-10 Maki-12-Nicolson-St")]),
                       "a closed month with a name after it"),
                      (dict(good, closed_months=[dict(_c, month="2026-13")]), "month 13"),
                      (dict(good, closed_months=[dict(_c, read_through_at="18/11/2026")]),
                       "a read-through that is not a stamp"),
                      (dict(good, closed_months=[dict(_c, read_through_at=["Maki-12-Nicolson-St"])]),
                       "a read-through that is not even a string"),
                      (dict(good, closed_months=[dict(_c, saved=["Maki-12-Nicolson-St"])]), "a saved entry that is a name"),
                      (dict(good, closed_months=[dict(_c, saved="2026-11-18T12:00:00.000Z")]), "saved as a bare string"),
                      (dict(good, closed_months=[{k: v for k, v in _c.items() if k != "saved"}]), "a closed month without saved"),
                      (dict(good, closed_months=[dict(_c, unknown=[{"modified_at": "02/11/2026"}])]),
                       "an unknown report whose stamp is not a stamp"),
                      (dict(good, closed_months=[dict(_c, unknown=[{"modified_at": "2026-11-02T09:00:00.000Z",
                                                                    "file": "x"}])]), "an unknown report with another field"),
                      (dict(good, closed_months=[dict(_c, unknown=[{"modified_at": "2026-11-02T09:00:00.000Z",
                                                                    "week": "2026-10-27"}])]), "an unknown week not a Monday"),
                      (dict(good, closed_months=[dict(_c, file="x")]), "a closed month with another field"),
                      (dict(good, closed_months="Maki-12-Nicolson-St"), "closed_months as a bare string"),
                      (dict(good, unread_reports="Maki-12-Nicolson-St"), "unread_reports as a bare string"),
                      (dict(good, reader="2"), "a reader that is not a whole number"),
                      (dict(good, reader=True), "a reader that is true"),
                      (dict(good, unread_reports=[dict(_u, week="Maki-12-Nicolson-St")]), "an unread week that is a name"),
                      (dict(good, unread_reports=[dict(_u, week="2026-10-27")]), "an unread week that is not a Monday"),
                      (dict(good, unread_reports=[dict(_u, month="KOBAS")]), "an unread month that is not a month"),
                      (dict(good, unread_reports=[dict(_u, month="2026-10 Maki-12-Nicolson-St")]),
                       "an unread month with a name after it"),
                      (dict(good, unread_reports=[dict(_u, location=["Maki Soho"])]), "a location that is not a string"),
                      (dict(good, unread_reports=[dict(_u, location="someone@maki.co.uk")]), "a location that is contact data")):
        check(fr.stock_leaks(json.dumps(bad_)) != [], f"the bake refuses {why}")
    check(fr.stock_leaks(json.dumps(dict(good, unread_reports=[dict(_u, week="2026-10-26", month="2026-10",
                                                                     location="Maki Soho")]))) == [],
          "...and accepts a real week, month and restaurant")
finally:
    os.environ.pop("PULLED_AT", None)
    shutil.rmtree(ktmp)

# round 3: names Drive and Windows make of an export are still Kobas's
for nm_ in ("Copy of KOBAS_Stock_Usage_Comparison_Report_Maki-Soho_2026-10-17_2026-10-24.csv",
            "KOBAS_Stock_Usage_Comparison_Report_Maki-Soho_2026-10-17_2026-10-24 - Copy.csv",
            "KOBAS_Stock_Usage_Comparison_Report_Maki-Soho_2026-10-17_2026-10-24 copy.csv",
            "KOBAS_Stock_Usage_Comparison_Report_Maki-Soho_2026-10-17_2026-10-24-1.csv"):
    check(rfs.kobas_name(nm_) == ("Maki-Soho", "2026-10-24"), f"{nm_!r} is still Kobas's per-restaurant name")
check(rfs.kobas_name("KOBAS_Stock_Usage_Comparison_Report_Maki-Soho_2026-10-17_2026-10-245.csv") is None,
      "...but never a date with a digit run on")
# round 3: a report moved in holding two closed months is named for each
ktmp = tempfile.mkdtemp(prefix="oo6-two-")
try:
    _o3 = os.path.join(ktmp, "o")
    os.makedirs(_o3)
    _a = os.path.join(ktmp, "a.csv")
    open(_a, "w").write("Venue,Item,Count Date,Count\nMaki Soho,Frozen Ramen - Hell Ramen,13/10/2026,1\n")
    krun(_o3, [_a], "2026-11-16T10:00:00Z", ["2026-10-14T09:00:00Z"])
    _b = os.path.join(ktmp, "b.csv")
    open(_b, "w").write("Venue,Item,Count Date,Count\nMaki Leeds,Frozen Ramen - Hell Ramen,15/09/2026,1\n"
                        "Maki Leeds,Frozen Ramen - Hell Ramen,13/10/2026,1\n")
    rc, st, dt2, _o = krun(_o3, [_a, _b], "2026-11-17T10:00:00Z", ["2026-10-14T09:00:00Z", "2026-10-30T09:00:00Z"])
    check(sorted((u["cause"], u.get("month")) for u in dt2["unread_reports"])
          == [("closed_month_added", "2026-09"), ("closed_month_added", "2026-10")]
          and "Maki Leeds" not in dt2["weeks"]["2026-10-12"]["locations"],
          "a sheet moved in after September and October closed is named for EACH month it holds")
finally:
    shutil.rmtree(ktmp)

# a report saved before a month began cannot hold one of its counts: never its lower bound
ktmp = tempfile.mkdtemp(prefix="oo6-first-")
try:
    _o4 = os.path.join(ktmp, "o")
    os.makedirs(_o4)
    _g_old = os.path.join(ktmp, "old.csv")
    open(_g_old, "w").write("Outlet,Item,Count\nMaki Soho,Frozen Ramen - Hell Ramen,1\n")
    _k = os.path.join(ktmp, kname("Maki-Soho", "2026-10-17", "2026-10-24"))
    open(_k, "wb").write(kobas_csv(ALLZERO))
    rc, st, d_f, _o = krun(_o4, [_g_old, _k], "2026-11-16T10:00:00Z", ["2026-10-01T09:00:00Z", "2026-10-26T09:00:00Z"])
    _cm = {c["month"]: c["unknown"] for c in d_f["closed_months"]}
    check(_cm["2026-09"] == [{"modified_at": "2026-10-01T09:00:00.000Z"}] and _cm["2026-10"] == [],
          "an unreadable report saved 01/10 is September's lower bound when it closes, never October's "
          "(no October week began before it was saved)")
finally:
    shutil.rmtree(ktmp)
_d_nov = {"pulled_at": "2026-11-16T10:00:00Z", "_problems": [], "closed": {},
          "weeks": {"2026-11-02": week("2026-11-02", {"Maki Leeds": {"lines": 1, "counted": 1}})},
          "unread": [{"modified_at": "2026-10-20T09:00:00.000Z", "cause": "header_missing", "detail": "x",
                      "week": None, "month": None, "location": None}]}
_exn, _ = fr.kr3_months(_d_nov, None, None, [("Maki Leeds", ["Maki Leeds"]), ("Maki Soho", ["Maki Soho"])],
                        "2026-11", "2026-11", mvar, score("full"), rag, asof="2026-11-16")
check("20/10/2026" not in by_m(_exn)["2026-11"]["basis"],
      "...and in an open month, a report saved before its first Monday is never named as one that may hold a count")

# kr3_months: an export that could not be read makes its week a lower bound,
# and the 'may hold it' hint is given only where it can be true
_s2 = [("Maki Leeds", ["Maki Leeds"]), ("Maki Soho", ["Maki Soho"])]
_wk = {w: week(w, {"Maki Leeds": {"lines": 4, "counted": 4}, "Maki Soho": {"lines": 4, "counted": 4}}) for w in OCT}
_wk["2026-10-19"] = week("2026-10-19", {"Maki Leeds": {"lines": 4, "counted": 4}})


def _kr(unread_, weeks_=None, dated=None, asof="2026-11-16", closed=None):
    d_ = {"pulled_at": "2026-11-16T10:00:00Z", "weeks": dict(weeks_ or _wk), "_problems": [],
          "unread": [{"week": None, "month": None, "location": None, **u_} for u_ in unread_],
          "closed": closed or {}}
    ex_, gp_ = fr.kr3_months(d_, None, None, _s2, "2026-10", "2026-11", mvar, score("full"), rag, asof=asof, dated=dated)
    return by_m(ex_)["2026-10"], gp_


_bad = {"modified_at": "2026-10-26T18:00:00.000Z", "cause": "header_missing", "detail": "no header", "week": "2026-10-19"}
o, _g = _kr([dict(_bad, location="Maki Soho")])
check(o.get("score") is None and "lower bound" in o["basis"] and "the w/c 19/10 export of Maki Soho could not be read" in o["basis"],
      "a finished month whose only gap is Soho's unreadable w/c 19/10 export is a LOWER BOUND, not scored (87.5% "
      "would have read as a final red)")
o, _g = _kr([dict(_bad, cause="venue_unknown")])
check(o.get("score") is None and "export of a restaurant not on the site map could not be read" in o["basis"],
      "...an export naming a restaurant not on the site map too (it may be one of the twenty, renamed in Kobas)")
o, _g = _kr([dict(_bad, location="Maki Leeds")])
check(o.get("score") == 0 and "lower bound" not in o["basis"],
      "...but not when the restaurant it names was counted that week anyway")
o, _g = _kr([dict(_bad, location="Maki Braehead")])
check(o.get("score") == 0 and "lower bound" not in o["basis"],
      "...nor when it names a restaurant on the site map but not one of the KR's (Braehead)")
_frozen = {"2026-10": {"read_through_at": "2026-11-15T10:00:00.000Z",
                       "unknown": [{"modified_at": "2026-10-26T18:00:00.000Z", "week": "2026-10-19",
                                    "location": "Maki Soho"}]}}
o, _g = _kr([], closed=_frozen)
check(o.get("score") is None and "the w/c 19/10 export of Maki Soho could not be read when the month closed" in o["basis"]
      and any("October 2026 closed for re-reading with a report it could not read" in g_ for g_ in _g),
      "a CLOSED month's lower bound is frozen with it: with the export gone from the folder (and from unread), "
      "October still is not scored final")
o, _g = _kr([dict(_bad, week=None, modified_at="2026-10-20T09:00:00.000Z")])
check(o.get("score") is None and "a report saved 20/10/2026 that could not be read may hold a count for the w/c "
                                 "19/10, so" in o["basis"],
      "an unreadable report with no week may hold a count for a week up to the day it was saved - named only where "
      "a location is uncounted (w/c 19/10; 05/10 and 12/10 are already complete)")
o, _g = _kr([dict(_bad, week=None, modified_at="2026-10-20T09:00:00.000Z")], closed={
    "2026-10": {"read_through_at": "2026-11-15T10:00:00.000Z", "unknown": []}})
check(o.get("score") == 0,
      "...but a closed month's lower bound is only what it closed with")
o, _g = _kr([dict(_bad, cause="no_frozen_lines", location="Maki Soho")])
check(o.get("score") == 0 and any("was read, but no line in it is frozen ramen by name" in g_ and "could not be read" not in g_
                                  for g_ in _g),
      "an export that was read and holds no frozen-ramen line is a definite 'not counted', and says it was read")
_miss = {w: v for w, v in _wk.items() if w != "2026-10-12"}
for unread_, hint, why in (
        ([dict(_bad, cause="month_closed", week=None, month="2026-10", modified_at="2026-11-16T09:00:00.000Z")], None,
         "only a late sheet's notice"),
        ([dict(_bad, week="2026-11-09")], None, "an unreadable export for another week"),
        ([dict(_bad, week="2026-10-12")], "could not be read may hold it", "an unreadable export for that week"),
        ([dict(_bad, week=None, modified_at="2026-10-10T09:00:00.000Z")], None,
         "an unreadable sheet saved before that week began"),
        ([dict(_bad, week=None, modified_at="2026-10-20T09:00:00.000Z")], "could not be read may hold it",
         "an unreadable sheet saved after it"),
        ([dict(_bad, cause="month_closed", week="2026-10-12", month="2026-10")], "arrived after the month closed",
         "a late export for that week")):
    o, _g = _kr(unread_, _miss)
    got = [h for h in ("could not be read may hold it", "arrived after the month closed") if h in o["basis"]]
    check(got == ([hint] if hint else []), f"a month missing w/c 12/10, with {why}: hint {hint!r} (got {got})")
o, _g = _kr([dict(_bad, modified_at="2026-11-20T09:00:00.000Z"),
             dict(_bad, cause="closed_month_added", week=None, month="2026-11", modified_at="2026-11-02T09:00:00.000Z")],
            dated="2026-11-16")
check(not any("saved 20/11" in g_ or "closed_month" in g_ or "was not read when" in g_ for g_ in _g),
      "a back-bake names no report saved after its date, and no month closed after it")
_cl = {"2026-10": {"read_through_at": "2026-11-15T10:00:00.000Z",
                   "unknown": [{"modified_at": "2026-10-26T18:00:00.000Z", "week": "2026-10-19", "location": "Maki Soho"}]}}
o, _g = _kr([dict(_bad, location="Maki Soho")], closed=_cl, dated="2026-11-10", asof="2026-11-10")
check(not any("closed for re-reading with" in g_ for g_ in _g) and "when the month closed" not in o["basis"]
      and "the w/c 19/10 export of Maki Soho could not be read" in o["basis"],
      "a back-bake dated before October closed sees October OPEN - never 'when the month closed'")
_miss2 = {w: v for w, v in _wk.items() if w != "2026-10-12"}
o, _g = _kr([dict(_bad, week=None, modified_at="2026-11-20T09:00:00.000Z")], _miss2,
            closed={"2026-10": {"read_through_at": "2026-11-15T10:00:00.000Z", "unknown": []}})
check("may hold it" not in o["basis"],
      "a report saved after October closed is never 'may hold it' for October's missing week")
# a file name's spelling of a restaurant is never a location in the copy
for bad_, why in (({"weeks": {}, "unread_reports": [{"modified_at": "2026-11-18T12:00:00.000Z", "cause": "x",
                                                      "detail": "y", "location": "Maki-12-Nicolson-St"}]},
                   "an unread location"),
                  ({"weeks": {}, "closed_months": [{"month": "2026-10", "read_through_at": "2026-11-18T12:00:00.000Z",
                                                    "saved": [], "unknown": [{"modified_at": "2026-11-18T12:00:00.000Z",
                                                                              "location": "Maki-12-Nicolson-St"}]}]},
                   "a closed month's unknown location"),
                  ({"weeks": {"2026-10-19": week("2026-10-19", {"Maki-12-Nicolson-St": {"lines": 1, "counted": 1}})}},
                   "a week's location key"),
                  ({"weeks": {}, "unread_reports": [{"modified_at": "2026-11-18T12:00:00.000Z", "cause": "Maki Soho said",
                                                      "detail": "y"}]}, "a cause that is not a fixed cause")):
    check(fr.stock_leaks(json.dumps(bad_)) != [], f"the bake refuses a file name's spelling or free text as {why}")

# venue_not_named only for a Kobas report
for nm_, data_, want in (
        ("KOBAS_Stock_Count_Report.csv", b"Ingredient Name,Counted Quantity\nM&R Hell Ramen,1\n", "venue_not_named"),
        ("stock.csv", b"Outlet,Item,Closing Stock\nMaki Soho,Frozen Ramen - Hell Ramen,1\n", "header_missing"),
        ("renamed export.csv", b"Stock usage, Nicolson St\n" + kobas_csv(ALLZERO), "venue_not_named"),
        ("kobas stock usage nicolson.csv", b"Ingredient Name,Waste Units\nM&R Hell Ramen,1\n", "header_missing")):
    try:
        rfs.parse_report(data_, nm_, "2026-10-26T17:57:52Z", MATCH)
        check(False, f"{nm_}: refused")
    except rfs.DriveError as e:
        check(e.cause == want, f"{nm_}: {want} (got {e.cause} {getattr(e, 'roles', '')})")
# the UK day decides: 23:30 UTC on 14/10 is already 15/10 in BST, so September closes
ktmp = tempfile.mkdtemp(prefix="oo6-bst-")
try:
    _p = os.path.join(ktmp, "s.csv")
    open(_p, "w").write("Venue,Item,Count Date,Count\nMaki Soho,Frozen Ramen - Hell Ramen,13/10/2026,1\n")
    for pulled, closes in (("2026-10-14T22:30:00Z", False), ("2026-10-14T23:30:00Z", True)):
        _o2 = os.path.join(ktmp, pulled[11:13])
        os.makedirs(_o2)
        rc, st, dz, _o = krun(_o2, [_p], pulled, ["2026-10-14T09:00:00Z"])
        check(("2026-09" in [c["month"] for c in dz.get("closed_months", [])]) == closes,
              f"{pulled}: September {'closes' if closes else 'is still open'} - the UK date "
              f"({'15' if closes else '14'}/10 in BST) decides, not UTC's")
finally:
    shutil.rmtree(ktmp)

print(f"\n{'FAILED' if failures else 'passed'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
