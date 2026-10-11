#!/usr/bin/env python3
"""Phase 3 (11/10/2026): OO5 KR3, OO5 KR5 and the scheduled-task target - pinned.

Run:  python3 tests/phase3_factory_test.py      (no network, no Google, no mailbox)

Part 1  refresh_factory_workbook.py: two tabs by title and nothing else; the
        CLOSING INVENTORY grid read by position and checked against its own
        Total column; fail soft part by part; the self-check.
Part 2  OO5 KR3: the mean ABSOLUTE weekly variance, Decimal and half-up; a
        closed month with a week missing is shown, not scored; mis-dated rows
        named, never moved; back-bakes; the blocker when there is no copy.
Part 3  OO5 KR5 (a): JFC's replies - short and damaged lines fail a PO, extra
        cartons do not; the collection day; what is published.
Part 4  OO5 KR5: (a) + (c); a form naming the factory charged to the site's
        latest order; a short source -> not scored; the rate cut DOWN.
Part 5  the real builder on a synthetic archive (KR3, KR5, the 95% target),
        and the verifier's recompute with the new module.
"""
import datetime as dt
import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "builders"))
import factory_kpis as fk  # noqa: E402
import refresh_factory_workbook as rfw  # noqa: E402

failures = 0


def check(cond, msg):
    global failures
    print(("ok  : " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


def mvar(m, **kw):
    return {"m": m, "label": fk.mlabel(m), "value": None, "display": None, "rag": None,
            "basis": None, "not_measured": None, **kw}


def stock_score(v):
    return 100 if v <= 5 else 80 if v <= 7.5 else 50 if v <= 10 else 0


def prod_score(v):
    return 100 if v >= 98 else 80 if v >= 97 else 50 if v >= 95 else 0


def rag(s):
    return {100: "green", 80: "amber", 50: "amber", 0: "red"}.get(s)


# ===========================================================================
print("== Part 1: the refresher ==")
SITES = ["Maki & Ramen - Maki SJQ", "Maki & Ramen - Maki Fountainbridge",
         "Maki & Ramen - Maki Leith", "Maki & Ramen - Maki Manchester"]
HEAD = ["Items", "EDINBURGH", "", "", "GLASGOW (THURSDAY)", "Total", "DAILY PRODUCTION",
        "PREVIOUS DAY CLOSING", "CLOSING INVENTORY"]


def block(date, rows, names_at_a=False, bad_total=False):
    """One CLOSING INVENTORY day block as the Sheets API returns it."""
    names = (SITES + [""] if names_at_a else [""] + SITES)
    out = [[date] + [""] * 8, HEAD, names + ["", "", "", ""]]
    for prod, q in rows:
        tot = sum(x for x in q if x != "") + (1 if bad_total else 0)
        out.append([prod] + [str(x) for x in q] + [str(tot), "", "100", str(100 - tot)])
    return out


GRID = (block("10/10/2026", [("M&R SPICY MISO CHILLED", [2, "", "", 4]),
                             ("M&R TONKOTSU BROTH FROZEN", [10, 4, "", ""]),
                             ("MATCHA BROWNIE", ["", "", "", ""])])
        + [[""] * 9]
        + block("9/10/2026", [("M&R SPICY MISO CHILLED", ["", 3, "", ""])], names_at_a=True)
        + block("8/10/2026", [("M&R SPICY MISO CHILLED", [1, "", "", ""])], bad_total=True)
        + [["7/10/2026"], ["M&R SPICY MISO CHILLED", "1", "", "", "", "1"]])
so = rfw.build_site_orders(GRID)
d10 = next(d for d in so["days"] if d["date"] == "2026-10-10")
check(d10["sites"] == {"Maki & Ramen - Maki SJQ": {"lines": 2, "units": 12.0},
                       "Maki & Ramen - Maki Fountainbridge": {"lines": 1, "units": 4.0},
                       "Maki & Ramen - Maki Manchester": {"lines": 1, "units": 4.0}},
      "a day block: each site's quantity read under its OWN column name (blank cells kept)")
check(d10["total_checked"] == 3 and d10["total_mismatches"] == 0, "...and Total agrees on every row")
d9 = next(d for d in so["days"] if d["date"] == "2026-10-09")
check(list(d9["sites"]) == ["Maki & Ramen - Maki Fountainbridge"],
      "site names starting in column A label the columns to their right")
check("2026-10-08" not in [d["date"] for d in so["days"]]
      and any(p.startswith("2026-10-08: Total disagrees") for p in so["problems"]),
      "a day whose Total disagrees on EVERY row is not published, and is named")
check(any(p.startswith("2026-10-07: no 'Items'") for p in so["problems"]),
      "a day with no header is named, not guessed")

ST = [["Week Commencing ", "Stocktake Variance Report"], ["30/12/2024", "0.70%"],
      ["29/09/2025", "-%"], ["3/8/2026", "-5.80%"], ["6/2/2026", "-3.20%"], ["7/2/2026", ""],
      ["note", "see Dean"]]
st = rfw.build_stocktake(ST)
check(st["header"] == ["Week Commencing", "Stocktake Variance Report"] and st["blank_rows"] == 1,
      "stocktake: header read, blank rows counted not listed")
check([r["variance"] for r in st["rows"]] == ["0.70%", "-%", "-5.80%", "-3.20%", "(text)"]
      and st["rows"][-1]["week"] == "(text)",
      "cells kept as written when they are dates or percentages, '(text)' otherwise")


class WS:
    def __init__(self, rows):
        self.rows = rows

    def get(self, rng):
        return [r[:2] for r in self.rows]

    def get_all_values(self):
        return self.rows


class Book:
    def __init__(self, tabs):
        self.tabs, self.asked = tabs, []

    def worksheet(self, title):
        self.asked.append(title)
        if title not in self.tabs:
            raise type("WorksheetNotFound", (Exception,), {})(title)
        return WS(self.tabs[title])

    def worksheets(self):
        raise AssertionError("the refresher must never list the workbook's tabs")


b = Book({rfw.STOCK_TAB: ST, rfw.ORDERS_TAB: GRID, "WEEKLY HOLIDAY CALCULATOR": [["Name", "Pay"]]})
got = rfw.fetch("x", spreadsheet=b)
check(b.asked == [rfw.STOCK_TAB, rfw.ORDERS_TAB], "opens exactly the two tabs, by title, and lists none")

tmp = tempfile.mkdtemp(prefix="p3-")
os.environ["PULLED_AT"] = "2026-10-11T19:00:00Z"
dump = os.path.join(tmp, "dump.json")
json.dump({rfw.STOCK_TAB: ST, rfw.ORDERS_TAB: GRID}, open(dump, "w"))
outp = os.path.join(tmp, "factory_workbook.json")
rfw.main(["--from-json", dump, "--out", outp])
doc = json.load(open(outp))
stat = json.load(open(os.path.join(tmp, "factory_workbook_status.json")))
check(doc["stocktake"]["read_at"] == doc["site_orders"]["read_at"] == "2026-10-11T19:00:00Z"
      and stat["ok"] and stat["cause"] == "ok", "--from-json: both parts written, status ok")
# a Google file id: 40+ id characters with letters AND digits in it (not a ---- rule)
ID_LIKE = __import__("re").compile(r"(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])\b[A-Za-z0-9_-]{40,}")
check(not ID_LIKE.search(json.dumps(doc)), "no sheet id (nor anything shaped like one) in the output")

os.environ["PULLED_AT"] = "2026-10-12T19:00:00Z"
json.dump({rfw.STOCK_TAB: ST}, open(dump, "w"))           # CLOSING INVENTORY renamed
rfw.main(["--from-json", dump, "--out", outp])
doc2 = json.load(open(outp))
stat2 = json.load(open(os.path.join(tmp, "factory_workbook_status.json")))
check(doc2["stocktake"]["read_at"] == "2026-10-12T19:00:00Z"
      and doc2["site_orders"]["read_at"] == "2026-10-11T19:00:00Z"
      and stat2["cause"] == "partial" and stat2["parts"]["site_orders"] == "tab_missing"
      and stat2["ok"] is False, "one tab missing: the other refreshed, this one carried forward with its own read_at")

json.dump({rfw.STOCK_TAB: ST, rfw.ORDERS_TAB: block("1/10/2026", [("X", [1, "", "", ""])])[:2]
           + [["", "pay@factory.co.uk", "", "", ""]] + block("1/10/2026", [("X", [1, "", "", ""])])[3:]},
          open(dump, "w"))
before = open(outp).read()
rfw.main(["--from-json", dump, "--out", outp])
check(open(outp).read() == before and json.load(open(os.path.join(tmp, "factory_workbook_status.json")))
      ["cause"] == "self_check_failed", "anything personal-looking: nothing written")
os.environ.pop("FACTORY_SHEET_ID", None)
rfw.SHEET_ID = ""
rfw.main(["--out", outp])
check(json.load(open(os.path.join(tmp, "factory_workbook_status.json")))["cause"] == "no_sheet_id"
      and open(outp).read() == before, "no FACTORY_SHEET_ID: not asked for, file untouched")
src = open(os.path.join(REPO, "builders", "refresh_factory_workbook.py")).read()
check(not ID_LIKE.search(src) and not ID_LIKE.search(open(os.path.join(REPO, "builders", "factory_kpis.py")).read()),
      "no Google file id is written into either public module")

# ===========================================================================
print("\n== Part 2: OO5 KR3 ==")
REAL = [(85, "3/8/2026", "-5.80%"), (86, "10/8/2026", "-1.00%"), (87, "17/8/2026", "0.20%"),
        (88, "24/8/2026", "-4.30%"), (89, "31/8/2026", "-4.60%"), (90, "7/9/2026", "-4.70%"),
        (91, "14/9/2026", "-3.80%"), (92, "21/9/2026", "-4.20%"), (93, "6/2/2026", "-3.20%"),
        (76, "1/6/2026", "-1.60%"), (77, "8/6/2026", "-4.80%"), (78, "15/6/2026", "-3.20%"),
        (79, "22/6/2026", "-5.00%"), (80, "29/6/2026", "-15.70%"),
        (81, "6/7/2026", "4.40%"), (82, "13/7/2026", "-56.80%"), (83, "20/7/2026", "-163.50%"),
        (84, "27/7/2026", "-84.50%"), (41, "29/09/2025", "-%"), (37, "1/9/2025", "0.10%"),
        (38, "8/9/2025", "4.30%"), (39, "15/9/2025", "-2.50%"), (40, "22/9/2025", "-0.40%")]
part = {"tab": rfw.STOCK_TAB, "read_at": "2026-10-11T19:00:00Z",
        "rows": [{"row": r, "week": w, "variance": v} for r, w, v in REAL]}
D = {"pulled_at": "2026-10-11T19:00:00Z", "stocktake": part}
ext, gaps = fk.kr3_months(D, None, None, "2026-10", "2025-08", mvar, stock_score, rag)
V = {v["m"]: v for v in ext["months"]}
check(V["2026-08"]["value"] == 3.18 and V["2026-08"]["score"] == 100
      and V["2026-08"]["display"] == "3.18% (worst -5.80%)"
      and "Worst week: w/c 03/08/2026 at -5.80%" in V["2026-08"]["basis"],
      "August 2026: mean |variance| of 5 weeks 3.18% -> 100, worst week shown")
check(V["2026-09"]["score"] is None and V["2026-09"]["incomplete"] and V["2026-09"]["value"] == 4.23
      and "w/c 28/09/2026 is not entered" in V["2026-09"]["basis"]
      and "-3.20% dated 06/02/2026, a Friday" in V["2026-09"]["basis"]
      and "if it is w/c 28/09/2026" in V["2026-09"]["basis"],
      "September 2026: 3 of 4 weeks -> shown, NOT scored; the mis-dated entry is named, not moved")
check(V["2026-06"]["value"] == 6.06 and V["2026-06"]["score"] == 80, "June 2026: 6.06% -> 80")
check(V["2026-07"]["value"] == 77.3 and V["2026-07"]["score"] == 0, "July 2026: 77.30% -> 0")
check(V["2025-09"]["score"] is None and "w/c 29/09/2025 holds '-%'" in V["2025-09"]["basis"],
      "September 2025: the '-%' week is not a number -> short month, named")
check(V["2026-10"].get("mtd") and V["2026-10"]["value"] is None and V["2026-10"]["coverage_days"] == 0
      and "the newest entry is w/c 21/09/2026" in V["2026-10"]["basis"],
      "October: no week entered yet -> month to date, no value, says how far the sheet reaches (never 0)")
check(V["2025-08"]["not_measured"].startswith("no week commencing in August 2025"),
      "a month with nothing entered is grey, not 0")
edge = {"tab": "t", "read_at": "2026-10-11", "rows": [
    {"row": 2, "week": "5/10/2026", "variance": "4.70%"}, {"row": 3, "week": "12/10/2026", "variance": "-3.80%"},
    {"row": 4, "week": "19/10/2026", "variance": "4.20%"}, {"row": 5, "week": "26/10/2026", "variance": "-3.20%"}]}
e2, _ = fk.kr3_months({"pulled_at": "x", "stocktake": edge}, None, None, "2026-11", "2026-10",
                      mvar, stock_score, rag)
check(e2["months"][0]["value"] == 3.98, "3.975 rounds HALF-UP to 3.98 in Decimal, whatever the float sum says")
edge["rows"] = [{"row": 2, "week": "5/10/2026", "variance": "5.00%"}, {"row": 3, "week": "12/10/2026", "variance": "-5.00%"},
                {"row": 4, "week": "19/10/2026", "variance": "5%"}, {"row": 5, "week": "26/10/2026", "variance": "-5.0%"}]
e3, _ = fk.kr3_months({"pulled_at": "x", "stocktake": edge}, None, None, "2026-11", "2026-10",
                      mvar, stock_score, rag)
check(e3["months"][0]["value"] == 5.0 and e3["months"][0]["score"] == 100, "exactly 5.00% is inside the 100 band")
bb, _ = fk.kr3_months(D, None, None, "2026-10", "2026-08", mvar, stock_score, rag, dated="2026-10-05")
check(bb["months"] is None and "after this snapshot's date" in bb["not_measured"],
      "a back-bake never shows a copy read after its date")
nb, ng = fk.kr3_months(None, "absent", {"ok": False, "cause": "not_shared", "attempted_at": "2026-10-12T08:00:00Z",
                                        "detail": "HTTP 403 - ..."}, "2026-10", "2026-08", mvar, stock_score, rag)
check(nb["months"] is None and "HTTP 403" in nb["not_measured"] and ng,
      "no copy yet: grey, with the read's own failure as the blocker")
fb, fg = fk.kr3_months(D, None, {"ok": False, "cause": "quota", "attempted_at": "2026-10-12T08:00:00Z",
                                 "detail": "HTTP 429"}, "2026-10", "2026-08", mvar, stock_score, rag)
check(fb["months"] and "failed: HTTP 429" in fb["months"][0]["basis"] and fg,
      "a failed re-read keeps the last copy and says so on the row and in the gaps")

# ===========================================================================
print("\n== Part 3: OO5 KR5 (a) - JFC's POs ==")
REPLY = ("Hi,\nI have been reported that there are short/extra cartons on UK16238 as below;\n"
         "B7393 *M&R BEEF TATAKI SAUCE (MR005) 4/2KG 1 carton short\n"
         "S4063 *M&R CHICKEN BROTH (MR014) 8/2L 10 cartons short\n"
         "S4064 *M&R TONKOTSU BROTH (MR015) 8/2L 10 cartons extra\nKind regards")
c = fk.classify_reply(REPLY)
check(len(c["short"]) == 3 and len(c["extra"]) == 1, "short lines and the extra line told apart")
check(fk.line_summary(c["short"][1]) == "MR005 1 carton" and fk.line_summary(c["short"][0]) is None,
      "published: the product code and quantity, never the text")
check(fk.classify_reply("We received the goods but we received extra 6 cartons of S4064 TONKOTSU BROTH (MR015)")
      == {"short": [], "damaged": [], "extra": ["We received the goods but we received extra 6 cartons of S4064 TONKOTSU BROTH (MR015)"]},
      "extra cartons alone are not a failure (Ross)")
check(fk.classify_reply("2 tubs of MR011 arrived damaged")["damaged"], "damage is a failure")
check(fk.classify_reply("All received, nothing missing and no damage.") == {"short": [], "damaged": [], "extra": []},
      "'nothing missing', 'no damage' are not failures")
check(fk.classify_reply("These are short-dated, please check")["short"] == [], "'short-dated' is not short")
check(fk.collection_date("Kindly arrange for our driver to collect the shipment next Thursday morning (10AM).",
                         "2026-09-11T08:02:03+00:00") == ("2026-09-17", "the first Thursday after the PO was emailed"),
      "Friday's 'next Thursday' -> the following Thursday")
check(fk.collection_date("collect the shipment on Thursday morning (10AM).", "2026-10-05T08:20:58+00:00")[0]
      == "2026-10-08", "Monday's 'on Thursday' -> that week's Thursday")
check(fk.collection_date("I am sending the order for the August 13th collection in advance.",
                         "2026-07-31T10:41:33+00:00")[0] == "2026-08-13", "a stated date wins")
check(fk.collection_date("Dear Dean, please see attached.", "2026-07-31T10:41:33+00:00")[0] is None,
      "no collection day: None, never guessed")


def msg(po, kind, when, role, text):
    return {"PO": po, "Kind": kind, "Message Date": when, "Sender Role": role, "Text": text}


ROWS = [msg("UK 16238", "po", "2026-09-11T08:02:03+00:00", "jfc", "collect the shipment next Thursday morning."),
        msg("UK 16238", "reply", "2026-09-21T10:58:48+00:00", "jfc", REPLY),
        msg("UK 16238", "reply", "2026-09-21T11:43:45+00:00", "other",
            "We can issue a credit note for the missing 1 carton of Beef Tataki"),
        msg("UK 16135", "po", "2026-08-28T08:45:08+00:00", "jfc", "collect the shipment next Friday morning."),
        msg("UK 16135", "reply", "2026-09-07T10:28:27+00:00", "jfc", "we received extra 6 cartons of TONKOTSU (MR015)"),
        msg("UK 16420", "po", "2026-10-09T08:23:12+00:00", "jfc", "collect the shipment on Thursday (12:00)."),
        msg("UK 16420", "reply", "2026-10-09T08:31:19+00:00", "jfc", "Is 11:00 okay? Nothing missing from the list."),
        msg("UK 16001", "po", "2026-08-03T08:00:00+00:00", "jfc", "collect on Thursday."),
        msg("UK 16001", "reply", "2026-08-04T09:00:00+00:00", "jfc", "Sorry, MR020 is missing from the PO - please add 4 cartons")]
P = {p["po"]: p for p in fk.jfc_pos(ROWS)}
check(P["UK 16238"]["failed"] and P["UK 16238"]["collection"] == "2026-09-17"
      and P["UK 16238"]["lines"] == ["short MR005 1 carton", "short MR014 10 cartons"] and P["UK 16238"]["extra"] == 1,
      "PO 16238: collected 17/09, two short lines -> NOT in full; the extra line is counted, not failed")
check(not P["UK 16135"]["failed"] and P["UK 16135"]["extra"] == 1, "PO 16135: extra cartons only -> in full")
check(not P["UK 16420"]["failed"], "the factory's and Maki's messages are answers, not reports")
check(not P["UK 16001"]["failed"], "a JFC message BEFORE the collection is about the order, not the delivery")
W = fk.classify_reply("We received the delivery but we didn't receive B5296 *M&R TOM YUM TARE\n(MR028) 4/2KG at all.\n"
                      "Can you please issue a credit note ASAP?")
check(len(W["short"]) == 1 and fk.line_summary(W["short"][0]) == "MR028",
      "a hard-wrapped line is re-joined, so the product code on the next line is kept (PO 16057, 24/08)")
fut = fk.kr5_months(pos=fk.jfc_pos([msg("UK 16420", "po", "2026-10-09T08:23:12+00:00", "jfc",
                                        "collect the shipment on Thursday.")]),
                    jfc_pull="2026-10-11", doc=None, err="absent", status=None, issues=[], site_alias={},
                    gc_cover=lambda m: (11, [], fk.month_end(m)), gc_answers_through="2026-10-10",
                    gc_feed_first="2026-08-01", pull_month="2026-10", first_month="2026-10", mvar=mvar,
                    score_fn=prod_score, rag_fn=rag, asof="2026-10-11")[0]["months"][0]
check("PO UK 16420" not in (fut.get("basis") or "") and "no JFC PO collected" in (fut.get("basis") or ""),
      "a PO to be collected after the bake's date (16420, 15/10) is not counted yet")

# ===========================================================================
print("\n== Part 4: OO5 KR5 ==")


def cover_full(m):
    return 31, [], fk.month_end(m)


def days_doc(spec, read="2026-10-31T19:00:00Z"):
    return {"pulled_at": read, "site_orders": {"tab": rfw.ORDERS_TAB, "read_at": read, "problems": [],
            "days": [{"date": d, "sites": {s: {"lines": 1, "units": 2} for s in ss}} for d, ss in spec]}}


SJQ, LEITH = "Maki & Ramen - Maki SJQ", "Maki & Ramen - Maki Leith"
spec = [(f"2026-09-{d:02d}", [SJQ, LEITH]) for d in range(1, 31)]          # 60 site orders in September
args = dict(jfc_pull="2026-10-31", err=None, status=None, site_alias={SJQ: "Maki SJQ Ltd"},
            gc_cover=cover_full, gc_answers_through="2026-10-31", gc_feed_first="2026-08-01",
            pull_month="2026-10", first_month="2026-09", mvar=mvar, score_fn=prod_score, rag_fn=rag,
            asof="2026-10-31")
pos = fk.jfc_pos(ROWS)
FORMS = [{"d": "2026-09-14", "site": "Maki SJQ Ltd", "supplier": "AA Factory", "issue_text": "broth short"},
         {"d": "2026-09-15", "site": "Maki SJQ Ltd", "supplier": "Lynas", "issue_text": "broth short"},
         {"d": "2026-09-16", "site": "Maki Leeds Ltd", "supplier": "AA Factory", "issue_text": "late"}]
e5, g5 = fk.kr5_months(pos=pos, doc=days_doc(spec), issues=FORMS, **args)
S = {v["m"]: v for v in e5["months"]}
# September: (a) 16178? no - POs collected in Sep: 16135 (04/09), 16238 (17/09) -> 2; (c) 60
check(S["2026-09"]["value"] == 96.7 and S["2026-09"]["score"] == 50
      and S["2026-09"]["display"] == "96.7% (60 of 62)",
      f"September: 62 orders, 16238 short + SJQ's 14/09 order charged with a factory form -> 60/62 = 96.77 cut DOWN to 96.7 -> 50 (got {S['2026-09'].get('display')})")
b9 = S["2026-09"]["basis"]
check("PO UK 16238 (collected 17/09) NOT IN FULL - short MR005 1 carton, short MR014 10 cartons" in b9
      and "PO UK 16135 (collected 04/09), 1 extra line(s) not counted" in b9,
      "the basis names each PO, its collection and its failing lines")
check(f"{SJQ} 14/09 (issue form naming the factory on 14/09)" in b9, "...and the site order the form was charged to")
check("(b) Lynas's POs on the factory are NOT counted" in b9, "...and says Lynas's POs cannot be seen")
check("issue forms naming the factory with no order to charge: 2026-09-16 Maki Leeds Ltd" in b9,
      "a factory form at a site with no order on the sheet is named, not charged to another site")
check(fk.published_leaks(e5["months"]) == [], "nothing published looks like an address or a number from a reply")
e6, g6 = fk.kr5_months(pos=None, doc=days_doc(spec), issues=[], **args)
S6 = {v["m"]: v for v in e6["months"]}
check(S6["2026-09"]["score"] is None and S6["2026-09"]["incomplete"]
      and "JFC's POs are not read in this bake" in S6["2026-09"]["basis"] and g6,
      "no JFC feed: shown, NOT scored, and named in the gaps")
e7, _ = fk.kr5_months(pos=pos, doc=days_doc(spec), issues=[],
                      **{**args, "gc_cover": lambda m: (28, ["2026-09-20", "2026-09-21"], fk.month_end(m))})
S7 = {v["m"]: v for v in e7["months"]}
check(S7["2026-09"]["score"] is None and "no pull of the issue-form feed covers 20/09, 21/09" in S7["2026-09"]["basis"],
      "a hole in the issue-form feed: a form could be missing -> upper bound, not scored")
e8, _ = fk.kr5_months(pos=pos, doc=days_doc(spec[:25]), issues=[], **args)
S8 = {v["m"]: v for v in e8["months"]}
check(S8["2026-09"]["score"] is None and "reaches only 2026-09-25" in S8["2026-09"]["basis"],
      "the site-orders sheet stopping short of the month end -> not scored")
o = S["2026-10"]
check(o["m"] == "2026-10" and o["value"] == 100.0 and o.get("coverage_days") == 0,
      "the open month carries its days of data for the month-to-date rule: the site sheet "
      "reaches only 30/09, so October has 0 (the bake's MTD rule then leaves it unscored)")
e9, _ = fk.kr5_months(pos=pos, doc=days_doc(spec), issues=[], **{**args, "dated": "2026-10-20"})
check({v["m"]: v for v in e9["months"]}["2026-09"]["score"] is None,
      "a back-bake does not use a site-orders copy read after its date")

# ===========================================================================
print("\n== Part 5: the real builder ==")
btmp = tempfile.mkdtemp(prefix="p3bake-")
wd = os.path.join(btmp, "warehouse_direct")


def put(pull, slug, feed, rows):
    pdir = os.path.join(wd, pull)
    os.makedirs(pdir, exist_ok=True)
    with gzip.open(os.path.join(pdir, slug + ".jsonl.gz"), "wt") as fh:
        for i, row in enumerate(rows):
            fh.write(json.dumps({"row_num": i, "data": row}) + "\n")
    fp = os.path.join(pdir, "_feeds.json")
    m = json.load(open(fp)) if os.path.exists(fp) else {}
    m[slug] = feed
    json.dump(m, open(fp, "w"))


def drange(a, b):
    x, y = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
    while x <= y:
        yield x.isoformat()
        x += dt.timedelta(days=1)


GCF = {"F1": ("2026-10-14", "AA Factory", "chilli oil short")}


def answers(lo, hi):
    out = []
    for d in drange(lo, hi):
        out.append({"FormId": f"R{d}", "TaskID": "1", "FormTemplateName": "Opening Checks",
                    "TaskName": "Fridge temp?", "Answer": "3", "LocationNameLabel": "Maki SJQ Ltd",
                    "AnsweredDateTime": d + "T09:00:00", "IsOpenDeviation": "false", "AnswerID": f"A{d}"})
        for fid, (fd, sup, text) in GCF.items():
            if fd == d:
                for t, (task, ans) in enumerate([("Supplier?", sup), ("Issue?", text)]):
                    out.append({"FormId": fid, "TaskID": str(t), "FormTemplateName": "Delivery/Supplier Issue Form",
                                "TaskName": task, "Answer": ans, "LocationNameLabel": "Maki SJQ Ltd",
                                "AnsweredDateTime": d + "T11:00:00", "IsOpenDeviation": "true",
                                "AnswerID": f"{fid}-{t}"})
    return out


x = dt.date(2026, 9, 26)
while x <= dt.date(2026, 11, 4):
    put(x.isoformat(), "GC_Form_Task_Answers", "GC Form Task Answers",
        answers((x - dt.timedelta(days=8)).isoformat(), (x - dt.timedelta(days=1)).isoformat()))
    x += dt.timedelta(days=4)
put("2026-11-03", "JFC_Factory_POs", "JFC Factory POs",
    [msg("UK 16500", "po", "2026-10-09T08:00:00+00:00", "jfc", "collect the shipment on Thursday."),
     msg("UK 16500", "reply", "2026-10-16T09:00:00+00:00", "jfc", "MR014 2 cartons damaged in transit"),
     msg("UK 16510", "po", "2026-10-16T08:00:00+00:00", "jfc", "collect the shipment next Thursday.")])
out = os.path.join(btmp, "out")
os.makedirs(out)
shutil.copy(os.path.join(REPO, "data", "ops_command", "feeds_manifest.json"), out)
json.dump({"pulled_at": "2026-11-03T19:00:00Z",
           "stocktake": {"tab": rfw.STOCK_TAB, "read_at": "2026-11-03T19:00:00Z", "rows": [
               {"row": 2, "week": "5/10/2026", "variance": "-2.00%"}, {"row": 3, "week": "12/10/2026", "variance": "3.00%"},
               {"row": 4, "week": "19/10/2026", "variance": "-4.00%"}, {"row": 5, "week": "26/10/2026", "variance": "-9.00%"},
               {"row": 6, "week": "2/11/2026", "variance": "-1.00%"}]},
           **days_doc([(d, [SJQ, LEITH]) for d in drange("2026-10-01", "2026-11-03")],
                      read="2026-11-03T19:00:00Z")},
          open(os.path.join(out, "factory_workbook.json"), "w"))
env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=wd, OPS_OUT_DIR=out)
p = subprocess.run([sys.executable, os.path.join(REPO, "builders", "bake_ops_command.py"),
                    "--date", "2026-11-04"], env=env, capture_output=True, text=True)
check(p.returncode == 0, "the real builder bakes the fixture as of 04/11/2026"
      + ("" if p.returncode == 0 else ": " + p.stderr[-1500:]))
if p.returncode == 0:
    snap = json.load(open(os.path.join(out, "snapshot_2026-11-04.json")))
    rows = {(r["objective"], r["kr"]): r for r in snap["scorecard"]["rows"]}

    def var(k, m):
        return next((v for v in rows[k]["months"] or [] if v["m"] == m), {})

    k3 = var(("OO5", "KR3"), "2026-10")
    check(k3.get("value") == 4.5 and k3.get("score") == 100 and "worst -9.00%" in (k3.get("display") or ""),
          f"OO5 KR3 October: (2+3+4+9)/4 = 4.50% -> 100, worst week shown (got {k3.get('display')}, {k3.get('score')})")
    k3n = var(("OO5", "KR3"), "2026-11")
    check(k3n.get("mtd") is False and k3n.get("score") == 100 and k3n.get("coverage_days") == 7,
          "OO5 KR3 November: one week entered = 7 days of data, the month-to-date minimum -> scored")
    k5n = var(("OO5", "KR5"), "2026-11")
    check(k5n.get("score") is None and k5n.get("mtd"),
          f"OO5 KR5 November: 3 days of data -> month to date, unscored (got {k5n.get('display')})")
    k5 = var(("OO5", "KR5"), "2026-10")
    # Oct: (a) 16500 (15/10, damaged), 16510 (22/10) -> 2; (c) 31 days x 2 sites = 62, SJQ 14/10 charged
    check(k5.get("display") == "96.8% (62 of 64)" and k5.get("score") == 50,
          f"OO5 KR5 October: 64 orders, one damaged PO and one factory form -> 96.8% -> 50 (got {k5.get('display')}, {k5.get('score')})")
    check("PO UK 16500 (collected 15/10) NOT IN FULL - damaged MR014 2 cartons" in (k5.get("basis") or ""),
          "...naming the PO and its damaged line")
    check(rows[("OO5", "KR3")]["band"] == "stock" and rows[("OO5", "KR5")]["band"] == "prod",
          "the bands are the sheet's: stock and prod")
    check(not any(r["kr"] == "Stock variance" for r in snap["scorecard"]["operating_kpis"]),
          "the Production 'Stock variance' placeholder is gone from the Operating KPIs")
    for op in snap["scorecard"]["operating_kpis"]:
        if op["kr"] == "Scheduled task on-time":
            check(op["target"] == ">=95%", "the scheduled-task row's target is >=95% (Ross, 09/10/2026)")
            check(op.get("rag") in ("green", "red") or op.get("not_measured"),
                  f"...and it carries the two-colour RAG, or is grey with its blocker (got {op.get('rag')})")
    lk = json.dumps(snap["scorecard"])
    check("@" not in json.dumps([rows[("OO5", "KR5")], rows[("OO5", "KR3")]]), "no address in either row")
    del lk

    print("\n-- the verifier's recompute (check 4b) --")
    import verify_ops_data as vod
    vod.OUT_DIR = out
    vod.FACTORY_WB_PATH = os.path.join(out, "factory_workbook.json")
    vod.FACTORY_WB_STATUS_PATH = os.path.join(out, "factory_workbook_status.json")
    vod.RESULTS.clear()
    vod.fetch_json = lambda *a, **k: (_ for _ in ()).throw(OSError("offline in tests"))
    os.environ.update(OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=wd)
    rc = vod.check_consistency("2026-11-03", "2026-11-03")
    bad = [r["detail"] for r in vod.RESULTS if r["check"] == "4b-consistency"
           and ("recompute failed" in r["detail"] or "could not run" in r["detail"])]
    check(rc is not None and not bad, "the recompute runs with factory_kpis.py" + (f": {bad}" if bad else ""))
    if rc:
        r3 = next(r for r in rc["scorecard"]["rows"] if (r["objective"], r["kr"]) == ("OO5", "KR3"))
        check(next((v for v in r3["months"] or [] if v["m"] == "2026-10"), {}).get("value") == 4.5,
              "...and reads the factory workbook copy, as the live bake does")

    print("\n-- a leak in the workbook copy refuses the bake --")
    d_ = json.load(open(os.path.join(out, "factory_workbook.json")))
    d_["site_orders"]["days"][0]["sites"]["someone@factory.co.uk"] = {"lines": 1, "units": 1}
    json.dump(d_, open(os.path.join(out, "factory_workbook.json"), "w"))
    p3 = subprocess.run([sys.executable, os.path.join(REPO, "builders", "bake_ops_command.py"),
                         "--date", "2026-11-04"], env=env, capture_output=True, text=True)
    check(p3.returncode == 1 and "REFUSING TO BAKE" in p3.stderr, "the bake refuses to publish it")
shutil.rmtree(btmp)
shutil.rmtree(tmp)

print(f"\n{'FAILED' if failures else 'passed'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
