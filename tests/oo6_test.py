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
"""
import datetime as dt
import gzip
import io
import json
import os
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
            "items_matched": ["Frozen Ramen - Hell Ramen"], "locations": locs,
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
check("EVERY location" in o["basis"] and "Maki Soho" in o["basis"] and "0 is a count" in o["basis"],
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
check(o["score"] == 0 and "listed with no number: Maki Leeds" in o["basis"],
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

unp = {w: week(w, ALL4) for w in OCT}
unp["2026-10-12"]["unrecognised_locations"] = 2
o = by_m(fr.kr3_months(stock(unp), None, None, SITES, "2026-10", "2026-11", mvar, score("full"), rag,
                       asof="2026-11-04")[0])["2026-10"]
check(o.get("score") is None and o.get("incomplete") and "2 frozen-ramen line(s) in the w/c 12/10 report" in o["basis"]
      and "lower bound" in o["basis"],
      "lines with no usable location make the week a lower bound: the closed month is shown, NOT scored, and says why")
unp = {w: week(w, ALL4) for w in OCT}
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
check(any("saved 13/10/2026 could not be read" in g and "missing: count" in g for g in gp)
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

CSV = ("Venue,Item,Count Date,Quantity,Value (£),User performing edit\r\n"
       "Maki & Ramen - Maki Aberdeen,Frozen Ramen - Hell Ramen,13/10/2026,12,48.00,Somebody Real\r\n"
       "Maki & Ramen - Maki Aberdeen,Frozen Ramen - Laksa Ramen,13/10/2026,0,0,Somebody Real\r\n"
       "Maki & Ramen - Maki Aberdeen,RAMEN NOODLES,13/10/2026,40,80.00,Somebody Real\r\n"
       "Maki NE1 Ltd,M&R Chicken Ramen,14/10/2026,,,Somebody Else\r\n"
       "Maki NE1 Ltd,M&R Black Garlic Tonkotsu,14/10/2026,three,,Somebody Else\r\n"
       "Maki Leeds,Frozen Ramen - Hell Ramen,20/10/2026,5,20.00,Third Person\r\n").encode("utf-8-sig")
w = rfs.parse_report(CSV, "stock.csv", "2026-10-21T09:00:00Z")
check(sorted(w) == ["2026-10-12", "2026-10-19"], "weeks come from the date column's Mondays")
w12 = w["2026-10-12"]
check(w12["locations"] == {"Maki & Ramen - Maki Aberdeen": {"lines": 2, "counted": 2},
                           "Maki NE1 Ltd": {"lines": 2, "counted": 0}}
      and w12["frozen_lines"] == 4 and w12["week_from"] == "column",
      "per location: frozen lines listed and how many carry a number (0 counts; a blank and 'three' do not)")
check(any("count is not a number" in p for p in w12["problems"]), "...and a text count is named by row")
_wtxt = json.dumps(w)
check(not any(x in _wtxt for x in ("Somebody", "Person", "48.00", "RAMEN NOODLES", "stock.csv", '"12"'))
      and '"Quantity"' not in _wtxt.replace('"count": "Quantity"', ""),
      "no person, money, non-frozen line, file name or quantity is kept")
w = rfs.parse_report(b"Site,Product,Stock Count\nMaki Soho,Frozen Ramen - Hell Ramen,3\n",
                     "Stock count 2026-10-27.csv", "2026-11-02T09:00:00Z")
check(list(w) == ["2026-10-26"] and w["2026-10-26"]["week_from"] == "file_name",
      "no date column: the week comes from a date in the file name")
w = rfs.parse_report(b"Site,Product,Stock Count\nMaki Soho,Frozen Ramen - Hell Ramen,3\n",
                     "stock.csv", "2026-10-18T23:30:00Z")
check(list(w) == ["2026-10-19"] and w["2026-10-19"]["week_from"] == "modified_time",
      "...else from Drive's modifiedTime on the UK clock (23:30 UTC on Sunday 18/10 is Monday 19/10 in BST)")
for data, want in ((b"Venue,Item,Count\nMaki Soho,RAMEN NOODLES,4\n", "no_frozen_lines"),
                   (b"just,some,cells\n1,2,3\n", "header_missing"),
                   (b"%PDF-1.4 ...", "not_a_table")):
    try:
        rfs.parse_report(data, "x.csv", "2026-10-21T09:00:00Z")
        check(False, f"{want} raises")
    except rfs.DriveError as e:
        check(e.cause == want and want in rfs.CAUSE_TEXT, f"{want}: a fixed cause, never a guess")
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
w = rfs.parse_report(XLSX, "x.xlsx", "2026-10-21T09:00:00Z")
check(w["2026-10-19"]["locations"] == {"Maki Leeds": {"lines": 1, "counted": 1}},
      "an .xlsx is read in memory the same way (real date cells; squid for ramen is not frozen ramen)")

# main(), end to end on local files
tmp = tempfile.mkdtemp(prefix="oo6-rfs-")
try:
    p1 = os.path.join(tmp, "a.csv")
    open(p1, "wb").write(CSV)
    os.environ["PULLED_AT"] = "2026-10-21T13:00:00Z"
    rc = rfs.main(["--from-file", p1, "--modified-at", "2026-10-21T09:00:00.123Z", "--out-dir", tmp])
    doc = json.load(open(os.path.join(tmp, fr.STOCK_FILE)))
    st = json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))
    check(rc == 0 and st["ok"] is True and st["cause"] == "ok" and sorted(doc["weeks"]) == ["2026-10-12", "2026-10-19"]
          and doc["weeks"]["2026-10-12"]["report_modified_at"] == "2026-10-21T09:00:00.123Z"
          and doc["weeks"]["2026-10-12"]["read_at"] == "2026-10-21T13:00:00Z",
          "a read writes the copy and an ok status; stamps are normalised")
    check(fr.stock_leaks(open(os.path.join(tmp, fr.STOCK_FILE)).read()) == [] and "a.csv" not in json.dumps(doc),
          "what it writes passes the bake's own publication check, and names no file")
    check(not [f for f in os.listdir(tmp) if f.endswith(".tmp")], "no .tmp is left behind")
    before = open(os.path.join(tmp, fr.STOCK_FILE)).read()
    os.environ["PULLED_AT"] = "2026-10-22T13:00:00Z"
    rc = rfs.main(["--from-file", p1, "--modified-at", "2026-10-21T09:00:00.123Z", "--out-dir", tmp])
    st = json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))
    check(rc == 0 and st["cause"] == "no_new_report" and st["ok"] is True
          and open(os.path.join(tmp, fr.STOCK_FILE)).read() == before,
          "the same report again: 'no new report', the copy untouched")
    p2 = os.path.join(tmp, "b.csv")
    open(p2, "wb").write(b"Venue,Item,Count\nMaki Soho,RAMEN NOODLES,4\n")
    rc = rfs.main(["--from-file", p2, "--modified-at", "2026-10-22T09:00:00Z", "--out-dir", tmp])
    st = json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))
    check(rc == 0 and st["ok"] is False and st["cause"] == "no_frozen_lines"
          and st["detail"] == rfs.CAUSE_TEXT["no_frozen_lines"] and st["failing_since"] == "2026-10-22T13:00:00Z"
          and open(os.path.join(tmp, fr.STOCK_FILE)).read() == before,
          "a report with no frozen line fails soft: exit 0, the fixed text, the copy untouched")
    files = []
    for i in range(6):
        pth = os.path.join(tmp, f"r{i}.csv")
        open(pth, "wb").write(f"Venue,Item,Count Date,Count\nMaki Soho,Frozen Ramen - Hell Ramen,0{i + 2}/11/2026,1\n".encode())
        files.append(pth)
    # six new reports at once: at most MAX_FILES are read, oldest first, and the
    # rest are named as waiting - and read on the next run, never skipped
    _fargs = sum((["--from-file", f_] for f_ in files), [])
    _mods = sum((["--modified-at", f"2026-11-08T09:00:0{i}Z"] for i in range(6)), [])
    rc = rfs.main(_fargs + _mods + ["--out-dir", tmp])
    st = json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))
    check(st["reports_read"] == rfs.MAX_FILES and st["reports_waiting"] == 6 - rfs.MAX_FILES,
          f"a batch larger than {rfs.MAX_FILES} reads {rfs.MAX_FILES} and says how many wait - never a silent cap")
    rc = rfs.main(_fargs + _mods + ["--out-dir", tmp])
    st = json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))
    check(st["reports_read"] == 2 and st["reports_waiting"] == 0 and st["ok"] is True,
          "...and the next run reads the two that waited")
    tie = tempfile.mkdtemp(prefix="oo6-tie-")
    rc = rfs.main(_fargs + ["--modified-at", "2026-11-09T09:00:00Z", "--out-dir", tie])
    st = json.load(open(os.path.join(tie, fr.STOCK_STATUS_FILE)))
    check(st["reports_read"] == 6 and st["reports_waiting"] == 0,
          "reports saved in the same millisecond are never split by the cap - one read mark could not tell them apart")
    shutil.rmtree(tie)
    open(os.path.join(tmp, fr.STOCK_FILE), "w").write('{"weeks": {"2026-10-05": {"x": "a@b.co"}}}')
    bad_before = open(os.path.join(tmp, fr.STOCK_FILE)).read()
    rc = rfs.main(["--from-file", p1, "--modified-at", "2026-12-01T09:00:00Z", "--out-dir", tmp])
    st = json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))
    check(st["cause"] == "refused" and open(os.path.join(tmp, fr.STOCK_FILE)).read() == bad_before,
          "a stored copy that fails the publication check is never built on or rewritten")
    open(os.path.join(tmp, fr.STOCK_FILE), "w").write('{"weeks": ["x"]}')
    rc = rfs.main(["--from-file", p1, "--modified-at", "2026-12-01T09:00:00Z", "--out-dir", tmp])
    check(rc == 0 and json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))["cause"] == "refused",
          "a stored copy whose weeks are not an object is refused too - exit 0, never a traceback")
    os.remove(os.path.join(tmp, fr.STOCK_FILE))

    # WEEKS SHARED BY TWO REPORTS ARE MERGED BY LOCATION (review, 21/10/2026):
    # a count that runs Sunday into Monday, then the next one
    r1, r2 = os.path.join(tmp, "s1.csv"), os.path.join(tmp, "s2.csv")
    open(r1, "w").write("Venue,Item,Count Date,Count\nMaki Soho,Frozen Ramen - Hell Ramen,04/10/2026,2\n"
                        "Maki Leeds,Frozen Ramen - Hell Ramen,05/10/2026,3\n")
    open(r2, "w").write("Venue,Item,Count Date,Count\nMaki Soho,Frozen Ramen - Hell Ramen,11/10/2026,2\n"
                        "Maki Leeds,Frozen Ramen - Hell Ramen,12/10/2026,3\n")
    rfs.main(["--from-file", r1, "--modified-at", "2026-10-06T09:00:00Z", "--out-dir", tmp])
    rfs.main(["--from-file", r2, "--modified-at", "2026-10-13T09:00:00Z", "--out-dir", tmp])
    doc = json.load(open(os.path.join(tmp, fr.STOCK_FILE)))
    check(sorted(doc["weeks"]["2026-10-05"]["locations"]) == ["Maki Leeds", "Maki Soho"]
          and any("merged from more than one report" in p_ for p_ in doc["weeks"]["2026-10-05"]["problems"]),
          "a week two reports share keeps both: Monday's Leeds count (report 1) and Sunday's Soho count (report 2), and says it merged")
    r3 = os.path.join(tmp, "s3.csv")
    open(r3, "w").write("Venue,Item,Count Date,Count\nMaki Leeds,Frozen Ramen - Hell Ramen,12/10/2026,\n")
    rfs.main(["--from-file", r3, "--modified-at", "2026-10-14T09:00:00Z", "--out-dir", tmp])
    doc = json.load(open(os.path.join(tmp, fr.STOCK_FILE)))
    check(doc["weeks"]["2026-10-12"]["locations"] == {"Maki Leeds": {"lines": 1, "counted": 0}},
          "...the newer report wins a location both list (a re-issued Leeds line replaces the older one)")
    os.remove(os.path.join(tmp, fr.STOCK_FILE))

    # a person column is never the location (it would be published)
    try:
        rfs.find_header([["Outlet", "Ingredient", "Quantity", "Store Manager"]])
        check(False, "a 'Store Manager' column is never taken as the location")
    except rfs.DriveError as e:
        check(e.cause == "header_missing" and e.roles == ["location"],
              "a 'Store Manager' column is never taken as the location - it is header_missing, naming the role")
    check(rfs.find_header([["Venue", "Ingredient", "Quantity", "Site Manager", "Restaurant contact"]])[1]["location"] == 0,
          "...and beside a real 'Venue' column, 'Venue' is the location")
    # a wide report with a blank row; a suspect product name; a 403 on one file
    wide = ",".join(f"c{i}" for i in range(9)) + ",Venue,Item,Count\n"
    wide += ",,,,,,,,,Maki Soho,Frozen Ramen - Hell Ramen,1\n\n"
    wide += ",,,,,,,,,Maki Leeds,Frozen Ramen - Hell Ramen 1234567,2\n"
    w = rfs.parse_report(wide.encode(), "x 20-10-2026.csv", "2026-10-21T09:00:00Z")
    _w = w["2026-10-19"]
    check(sorted(_w["locations"]) == ["Maki Leeds", "Maki Soho"] and _w["items_matched"] == ["Frozen Ramen - Hell Ramen"]
          and any("product name was not kept" in p_ for p_ in _w["problems"]),
          "a wide report with a blank row reads (no IndexError); a product name that looks like a code is not kept, its line still counts")
    check(fr.stock_leaks(json.dumps({"weeks": w, "pulled_at": "2026-10-21T09:00:00Z"})) == [],
          "...so one odd name can no longer refuse the whole copy")
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
try:
    sys.modules.update(_fake)
    os.environ["GOOGLE_SA_JSON"] = '{"client_email": "sa@x.iam.gserviceaccount.com"}'
    os.environ["STOCK_COUNT_FOLDER_ID"] = f"https://drive.google.com/drive/folders/{_FID}?usp=sharing"
    _drive["route"] = route_ok
    buf = io.StringIO()
    _o, sys.stdout = sys.stdout, buf
    try:
        rc = rfs.main(["--out-dir", tmp])
    finally:
        sys.stdout = _o
    doc = json.load(open(os.path.join(tmp, fr.STOCK_FILE)))
    st = json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))
    check(rc == 0 and st["ok"] and sorted(doc["weeks"]) == ["2026-10-12", "2026-10-19"]
          and doc["weeks"]["2026-10-19"]["kind"] == "gsheet"
          and doc["weeks"]["2026-10-12"]["kind"] == "csv",
          "Drive: the folder is listed, the CSV downloaded and the Google Sheet EXPORTED; oldest first, a shared week merged")
    check(_drive["calls"][0][1].get("fields") == "id,mimeType",
          "the folder itself is asked for before it is listed (an unshared folder lists empty)")
    _all = buf.getvalue() + json.dumps(doc) + json.dumps(st)
    check(_FID not in _all and "F" * 30 not in _all and "count 13-10" not in _all and "sa@x" not in _all,
          "the folder id, file ids, file names and the service account appear in no output and no file")
    for lab, route, want in (
            ("folder 404", lambda u, p: _Resp(404), "not_found"),
            ("folder 403 API off", lambda u, p: _Resp(403, b'{"reason": "accessNotConfigured"}'), "drive_api_disabled"),
            ("folder 403", lambda u, p: _Resp(403, b'{"reason": "forbidden"}'), "not_shared"),
            ("a file id, not a folder", lambda u, p: _Resp(200, js={"id": _FID, "mimeType": rfs.MIME_CSV}), "not_a_folder"),
            ("an empty folder", lambda u, p: _Resp(200, js={"id": _FID, "mimeType": rfs.MIME_FOLDER})
             if p.get("fields") == "id,mimeType" else _Resp(200, js={"files": []}), "no_report")):
        _drive["route"] = route
        os.remove(os.path.join(tmp, fr.STOCK_FILE)) if os.path.exists(os.path.join(tmp, fr.STOCK_FILE)) else None
        rc = rfs.main(["--out-dir", tmp])
        st = json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))
        check(rc == 0 and st["cause"] == want and not os.path.exists(os.path.join(tmp, fr.STOCK_FILE)),
              f"Drive {lab} -> {want}, exit 0, nothing written")
    # A TRANSIENT failure stops the run: the newer report is not read past it
    def route_flaky(fail_old):
        def r_(u, p):
            if u.endswith("F" * 30) and p.get("alt") == "media" and fail_old:
                return _Resp(500)
            return route_ok(u, p)
        return r_
    for f_ in os.listdir(tmp):
        os.remove(os.path.join(tmp, f_))
    os.environ["STOCK_COUNT_FOLDER_ID"] = _FID
    _drive["route"] = route_flaky(True)
    rfs.main(["--out-dir", tmp])
    st = json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))
    check(st["cause"] == "http_error" and not os.path.exists(os.path.join(tmp, fr.STOCK_FILE))
          and st["reports_waiting"] == 2,
          "Google's error on the OLDER report stops the run - the newer one is not read past it")
    _drive["route"] = route_flaky(False)
    rfs.main(["--out-dir", tmp])
    doc = json.load(open(os.path.join(tmp, fr.STOCK_FILE)))
    st = json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))
    check(st["ok"] and st["reports_read"] == 2 and "2026-10-12" in doc["weeks"],
          "...and the next run reads both")
    # the report's OWN fault, older than a good one: recorded for good
    _BAD = {"id": "H" * 30, "name": "x.csv", "mimeType": rfs.MIME_CSV,
            "modifiedTime": "2026-10-22T08:00:00.000Z", "size": "40"}
    _NEW = {"id": "F" * 30, "name": "y.csv", "mimeType": rfs.MIME_CSV,
            "modifiedTime": "2026-10-23T08:00:00.000Z", "size": "300"}

    def route_bad(u, p):
        if url_list(u, p):
            return _Resp(200, js={"files": [_NEW, _BAD]})
        if u.endswith("H" * 30) and p.get("alt") == "media":
            return _Resp(200, b"Venue,Item\nMaki Soho,Frozen Ramen\n")
        return route_ok(u, p)

    def url_list(u, p):
        return u == rfs.DRIVE_FILES

    _drive["route"] = route_bad
    rfs.main(["--out-dir", tmp])
    doc = json.load(open(os.path.join(tmp, fr.STOCK_FILE)))
    check([u["modified_at"] for u in doc.get("unread_reports") or []] == ["2026-10-22T08:00:00.000Z"]
          and doc["unread_reports"][0]["cause"] == "header_missing"
          and "missing: count" in doc["unread_reports"][0]["detail"],
          "a report that fails for its OWN cause, older than one read now, is recorded in the copy - date and fixed cause only")
    check(fr.stock_leaks(json.dumps(doc)) == [] and "x.csv" not in json.dumps(doc),
          "...which passes the publication check and names no file")
    d_, e_ = fr.load_stock(tmp)
    check(d_["unread"] and d_["unread"][0]["cause"] == "header_missing", "...and the bake's loader reads it")
    def route_block(u, p):
        if u.endswith("F" * 30) and p.get("alt") == "media":
            return _Resp(403, b'{"reason": "cannotDownloadFile"}')
        return route_ok(u, p)
    for f_ in os.listdir(tmp):
        os.remove(os.path.join(tmp, f_))
    _drive["route"] = route_block
    rfs.main(["--out-dir", tmp])
    check(json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))["cause"] == "download_blocked",
          "a 403 on ONE file after the folder listed is download_blocked, not 'share the folder'")
    os.environ["STOCK_COUNT_FOLDER_ID"] = "not a folder id"
    rc = rfs.main(["--out-dir", tmp])
    check(json.load(open(os.path.join(tmp, fr.STOCK_STATUS_FILE)))["cause"] == "bad_folder_id",
          "a malformed STOCK_COUNT_FOLDER_ID is bad_folder_id, never a request")
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
    logging.getLogger().addHandler(_lh)
    try:
        ros.main(["--from-json", os.path.join(tmp, "dump.json"), "--out", os.path.join(tmp, "okr_sheet.json")])
    finally:
        logging.getLogger().removeHandler(_lh)
    check(not any("ERROR" in ln and "oo6_kr2_invoiced" in ln for ln in _lb.getvalue().splitlines())
          and "not_located" in _lb.getvalue(),
          "an unpinned OO6 cell is not logged as an ERROR - it is not a failed pull")
    doc = json.load(open(os.path.join(tmp, "okr_sheet.json")))
    st = json.load(open(os.path.join(tmp, "okr_sheet_status.json")))
    check(doc["series"]["oo6_kr1"]["months"] == {"2026-10": 98}
          and doc["series"]["oo6_kr1"]["range"] == "A160:A172 + C160:C172"
          and st["ok"] is True and st["series_missing"] == {"oo6_kr2_invoiced": "not_located"},
          "the refresher writes OO6 KR1 with its pinned range; an unpinned invoiced cell is named, and the pull is ok")
    check(bake.okr_sheet_leaks(open(os.path.join(tmp, "okr_sheet.json")).read()) == [],
          "...and nothing in it trips the bake's Finance check")
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
json.dump({"pulled_at": "2026-11-03T19:00:00Z", "basis": rfs.BASIS,
           "weeks": {w_: week(w_, {lb: {"lines": 4, "counted": 4} for lb in _labels})
                     for w_ in OCT + ["2026-11-02"]}},
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

print(f"\n{'FAILED' if failures else 'passed'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
