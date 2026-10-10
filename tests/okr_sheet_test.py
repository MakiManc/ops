#!/usr/bin/env python3
"""The Operations Input sheet and the Maintenance Contact List (Phase 1, 10/10/2026).

Pins, end to end, the rules the nine sheet-fed KRs and OO2 KR5 live by:

  * A MONTH NOT ENTERED IS NOT SCORED - an explicit not-measured month, never 0.
  * OO1 is Finance's SCORES ONLY - no value, no display, no objective %, and a
    cell that is not 0/50/80/100 (or carries a '%') is never written anywhere.
  * The refreshers fail soft, write a status file with FIXED text (never an
    exception message - the file is public), write atomically, and carry a
    series forward rather than drop it when one tab cannot be read.
  * Only the OO4 credit-notes ranges of '2026 OKRs' are ever requested.
  * The contact list leaves the refresher as structure only.
  * OO2 KR5 is the exact fraction of the 20 corporate restaurants whose city tab
    holds any contact (Ross, 10/10/2026), never rounded into a better band, and
    the list's sheet id (a password while it is shared "anyone can edit")
    never appears in this public repo.
  * A back-bake never shows a copy read after its date.
  * The bake refuses to write when anything OO1-shaped would be published.

Synthetic fixtures only: no real contact detail and no real Finance figure.

  python3 tests/okr_sheet_test.py      (exit 1 on any failure)
"""
from __future__ import annotations

import gzip
import io
import json
import logging
import os
import shutil
import subprocess
import sys
import re
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BUILDERS = os.path.join(REPO, "builders")
sys.path.insert(0, BUILDERS)
import bake_ops_command as bake  # noqa: E402
import refresh_maintenance_contacts as rmc  # noqa: E402
import refresh_okr_sources as ros  # noqa: E402
import verify_ops_data as vod  # noqa: E402

failures = 0


def check(cond, msg):
    global failures
    print(("ok  : " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


# ---------------------------------------------------------------------------
# Synthetic sheet, shaped like the real one (FORMATTED_VALUE strings)
# ---------------------------------------------------------------------------
MON = ["Jan-26", "Feb-26", "Mar-26", "Apr-26", "May-26", "Jun-26", "Jul-26",
       "Aug-26", "Sep-26", "Oct-26", "Nov-26", "Dec-26"]


def summary(oo1=None, label="OO1 :  <target> Net Profit", lead_rows=0):
    """'2026 Summary': header row 1, OO1 label row 2, KR1-KR5 on rows 3-7, a
    blank legacy 'OO1:Maintenance' block further down (the latch trap)."""
    oo1 = oo1 or {k: ["100.00", "80.00", "50", "0", "", "", "", "", "", "", "", ""]
                  for k in ros.OO1_KRS}
    rows = [["", ""] + [""] * 12 for _ in range(lead_rows)]
    rows.append(["Objective ", ""] + MON)
    rows.append([label, "Function "] + [""] * 12)
    for kr in ros.OO1_KRS:
        rows.append([f"{kr}: <synthetic label>", "Finance"] + oo1[kr])
    rows += [[""] * 14] * 3
    rows.append(["OO1:Maintenance", ""] + [""] * 12)
    for kr in ros.OO1_KRS:
        rows.append([f"{kr}: legacy", ""] + ["0"] * 12)
    return rows


def log_tab(head, vals):
    rows = [["Month ", head]]
    for i, m in enumerate(["January", "February", "March", "April", "May", "June",
                           "July", "August", "September", "October", "November",
                           "December"]):
        rows.append([f"{m} 2026", vals[i] if i < len(vals) else ""])
    return rows


def okrs(actuals):
    return [["Month ", "Limit", "Actual"]] + [[m, "100", actuals[i] if i < len(actuals) else ""]
                                              for i, m in enumerate(MON)]


def dump(**over):
    d = {
        "summary": summary(),
        "okrs": okrs(["", "100", "99", "97"]),
        "oo2_kr3": log_tab("Closure Log ", ["0", "1", "", "4"]),
        "oo3_kr3": log_tab("Supply Issue Log", ["0", "2"]),
        "oo4_kr1": log_tab("Issues Log", ["1", "0", "3"]),
    }
    d.update(over)
    return {k: v for k, v in d.items() if v is not None}


def run_refresher(tmp, d, pulled="2026-04-15T10:00:00Z", name="okr_sheet.json"):
    p = os.path.join(tmp, "dump.json")
    with open(p, "w") as fh:
        json.dump(d, fh)
    os.environ["PULLED_AT"] = pulled
    buf = io.StringIO()
    h = logging.StreamHandler(buf)
    logging.getLogger().addHandler(h)
    try:
        rc = ros.main(["--from-json", p, "--out", os.path.join(tmp, name)])
    finally:
        logging.getLogger().removeHandler(h)
        os.environ.pop("PULLED_AT", None)
    return rc, buf.getvalue()


def read(tmp, name):
    with open(os.path.join(tmp, name)) as fh:
        return json.load(fh)


# ---------------------------------------------------------------------------
# 1. The parsers
# ---------------------------------------------------------------------------
check(ros.parse_num("") is None and ros.parse_num("0") == 0.0,
      "a blank cell is None and a typed 0 is 0 - a blank is never a zero")
check(ros.parse_num("80%") is None and ros.parse_num("#REF!") is None,
      "parse_num refuses a '%' (it used to strip it) and a sheet error value")
check(ros.parse_pct("98%") == 98.0 and ros.parse_pct("101") is None,
      "parse_pct reads '98%' and refuses a figure over 100")

lg, cause = ros.build_log(log_tab("Log", ["0", "", "2", "x", "1.5", "-1"]), "2026-12")
check(cause is None and lg == {"2026-01": 0, "2026-03": 2},
      f"build_log keeps entered whole counts only (blank, text, 1.5 and -1 left as not entered): {lg}")
lg, cause = ros.build_log(log_tab("Log", ["0", "0", "0", "0", "0"]), "2026-03")
check(sorted(lg) == ["2026-01", "2026-02", "2026-03"],
      "a month after the pull month is dropped - a typed future month is not an event yet")
check(ros.build_log([["Month", "Log"], ["Total", "3"]], "2026-12") == (None, "layout_changed"),
      "a log tab with no month rows is layout_changed, not 'nothing entered'")

oo1, cause, diag = ros.build_oo1(summary(), "2026-12")
check(cause is None and oo1["KR1"] == {"2026-01": 100, "2026-02": 80, "2026-03": 50, "2026-04": 0}
      and diag["oo1_rows"] == [3, 7], "OO1 reads the five score rows at 3-7, blanks absent")
oo1, cause, _ = ros.build_oo1(summary(label="OObjective 1 :  <target> Net Profit"), "2026-12")
check(oo1 is None and cause == "layout_changed",
      "THE LATCH TRAP: with row 2 relabelled, OO1 is NOT read from the legacy 'OO1:Maintenance' block")
oo1, cause, _ = ros.build_oo1(summary(lead_rows=1), "2026-12")
check(oo1 is None and cause == "layout_changed",
      "an OO1 block that has moved off rows 2-7 is an error, not a warning")
bad = {k: ["100", "", "", "", "", "", "", "", "", "", "", ""] for k in ros.OO1_KRS}
bad["KR3"] = ["100", "31.5%", "", "", "", "", "", "", "", "", "", ""]
buf = io.StringIO()
h = logging.StreamHandler(buf)
logging.getLogger().addHandler(h)
oo1, cause, _ = ros.build_oo1(summary(oo1=bad), "2026-12")
logging.getLogger().removeHandler(h)
check(oo1 is None and cause == "oo1_not_scores",
      "a '%' in ONE OO1 cell drops ALL of OO1 for the pull (oo1_not_scores)")
check("31.5" not in buf.getvalue() and "D5" in buf.getvalue(),
      "...and the log names the cell (D5), never its value")
bad["KR3"] = ["100", "75", "", "", "", "", "", "", "", "", "", ""]
check(ros.build_oo1(summary(oo1=bad), "2026-12")[1] == "oo1_not_scores",
      "an OO1 value outside 0/50/80/100 (75) is not a score either")

o4, cause = ros.build_oo4_kr4(okrs(["", "100", "99%", "abc"]), "2026-12")
check(cause is None and o4 == {"2026-02": 100, "2026-03": 99},
      f"OO4 KR4 reads the Actual %, Jan blank absent, a non-number left unentered: {o4}")
check(ros.build_oo4_kr4([["Month ", "Limit", "Variance"]] + okrs(["100"])[1:], "2026-12")[1]
      == "layout_changed", "OO4 KR4 refuses a block whose header no longer reads Month | Limit | Actual")
check(ros.build_oo4_kr4([["Month ", "Limit", "Actual"], ["Total", "100", "100"]], "2026-12")[1]
      == "layout_changed", "OO4 KR4 refuses a block whose rows are not months")

# ---------------------------------------------------------------------------
# 2. fetch(): only the credit-notes ranges of '2026 OKRs' are requested
# ---------------------------------------------------------------------------
class FakeWS:
    def __init__(self, title, gid, rows):
        self.title, self.id, self._rows, self.calls = title, gid, rows, []

    def get_all_values(self):
        self.calls.append("ALL")
        return self._rows

    def batch_get(self, ranges):
        self.calls.append(tuple(ranges))
        return [[[r[0]] for r in okrs(["", "100"])], [[r[1], r[2]] for r in okrs(["", "100"])]]

    def get(self, *a, **k):
        self.calls.append(("get", a))
        return []


class FakeSheet:
    def __init__(self, wss):
        self.wss = wss

    def worksheets(self):
        return self.wss


d0 = dump()
wss = [FakeWS("Approval", 1, [["secret approval"]]),
       FakeWS("2026 Summary", 2, d0["summary"]),
       FakeWS("2026 OKRs", 3, [["FINANCE"]]),
       FakeWS(ros.TAB_TITLES["oo3_kr3"][0], 4, d0["oo3_kr3"]),
       FakeWS(ros.TAB_TITLES["oo4_kr1"][0], 5, d0["oo4_kr1"]),
       FakeWS("Unplanned Restarant Closures ", 6, d0["oo2_kr3"])]
got, missing = ros.fetch("x", spreadsheet=FakeSheet(wss))
check(not missing and set(got) == {"summary", "okrs", "oo2_kr3", "oo3_kr3", "oo4_kr1"},
      "fetch finds every tab by exact title (trailing space and misspelling included)")
check(wss[2].calls == [ros.OO4_KR4_RANGES] and wss[0].calls == [],
      f"'2026 OKRs' is asked ONLY for {ros.OO4_KR4_RANGES} (never get_all_values); 'Approval' is never read")
check(got["okrs"][2][2][:3] == ["Feb-26", "100", "100"],
      "the two ranges are joined row by row into [Month, Limit, Actual]")
wss[5].title = "Unplanned Restaurant Closures"
got, missing = ros.fetch("x", spreadsheet=FakeSheet(wss))
check(missing == {"oo2_kr3": "tab_missing"}, "a renamed tab is named as tab_missing, not guessed")
os.environ["OKR_GID_CLOSURES"] = "6"
got, missing = ros.fetch("x", spreadsheet=FakeSheet(wss))
os.environ.pop("OKR_GID_CLOSURES")
check("oo2_kr3" in got and not missing, "a pinned gid survives the rename")


class APIError(Exception):
    def __init__(self, code):
        super().__init__(f"body quoting something private {code}")
        self.response = type("R", (), {"status_code": code})()


class SpreadsheetNotFound(Exception):
    pass


class RefreshError(Exception):
    pass


check(ros.classify(PermissionError()) == ("not_shared", 403), "PermissionError -> not_shared")
check(ros.classify(APIError(403))[0] == "not_shared" and ros.classify(APIError(429))[0] == "quota"
      and ros.classify(APIError(503)) == ("google_down", 503), "HTTP 403/429/503 -> not_shared/quota/google_down")
check(ros.classify(SpreadsheetNotFound())[0] == "not_found" and ros.classify(RefreshError())[0] == "auth_failed"
      and ros.classify(KeyError())[0] == "unexpected", "404, a revoked key, and anything else are classified")

# ---------------------------------------------------------------------------
# 3. main(): status file, atomic write, carry-forward, no inventory
# ---------------------------------------------------------------------------
tmp = tempfile.mkdtemp(prefix="okr_sheet_test_")
try:
    rc, out = run_refresher(tmp, dump())
    doc, st = read(tmp, "okr_sheet.json"), read(tmp, "okr_sheet_status.json")
    check(rc == 0 and st["ok"] is True and st["cause"] == "ok" and st["failing_since"] is None
          and st["series_read"] == sorted(ros.SERIES), "a full read writes the file and an ok status")
    check("worksheets" not in doc and set(doc["series"]) == set(ros.SERIES),
          "the public file carries the five series and NOT the worksheet inventory")
    check(doc["series"]["oo2_kr3"]["months"] == {"2026-01": 0, "2026-02": 1, "2026-04": 4}
          and doc["series"]["oo2_kr3"]["as_of"] == "2026-04",
          "each series carries its own as_of (newest entered month)")
    check(not [f for f in os.listdir(tmp) if f.endswith(".tmp")], "no .tmp file is left behind")

    # a renamed log tab: carried forward with its old pulled_at, status names it
    rc, out = run_refresher(tmp, dump(oo4_kr1=None), pulled="2026-04-20T10:00:00Z")
    doc, st = read(tmp, "okr_sheet.json"), read(tmp, "okr_sheet_status.json")
    s1 = doc["series"]["oo4_kr1"]
    check(s1.get("carried_forward") is True and s1["pulled_at"] == "2026-04-15T10:00:00Z"
          and s1["months"] == {"2026-01": 1, "2026-02": 0, "2026-03": 3},
          "a tab not read this run is CARRIED FORWARD with its own older pulled_at - not dropped")
    check(st["ok"] is False and st["cause"] == "tab_missing" and st["series_missing"] == {"oo4_kr1": "tab_missing"}
          and st["failing_since"] == "2026-04-20T10:00:00Z", "...and the status says which, and since when")
    rc, out = run_refresher(tmp, dump(oo4_kr1=None), pulled="2026-04-21T10:00:00Z")
    st = read(tmp, "okr_sheet_status.json")
    check(st["failing_since"] == "2026-04-20T10:00:00Z", "failing_since holds while the failure lasts")

    # an OO1 cell that is a percentage: nothing of it written, OO1 carried forward
    bad = {k: ["100", "", "", "", "", "", "", "", "", "", "", ""] for k in ros.OO1_KRS}
    bad["KR2"] = ["12.34%", "", "", "", "", "", "", "", "", "", "", ""]
    rc, out = run_refresher(tmp, dump(summary=summary(oo1=bad)), pulled="2026-04-22T10:00:00Z")
    raw = open(os.path.join(tmp, "okr_sheet.json")).read()
    st = read(tmp, "okr_sheet_status.json")
    check("12.34" not in raw and "12.34" not in out and st["cause"] == "oo1_not_scores",
          "a Finance percentage in an OO1 cell reaches neither the file nor the log")
    check(json.loads(raw)["series"]["oo1"]["krs"]["KR1"] == {"2026-01": 100, "2026-02": 80, "2026-03": 50, "2026-04": 0},
          "...and OO1 is carried forward from the last good pull")

    # the sheet unreadable: file untouched, status names the cause in fixed text
    before = open(os.path.join(tmp, "okr_sheet.json")).read()
    orig = ros.fetch

    def boom(_sid, spreadsheet=None):
        raise APIError(403)
    ros.fetch = boom
    try:
        os.environ["PULLED_AT"] = "2026-04-23T10:00:00Z"
        rc = ros.main(["--out", os.path.join(tmp, "okr_sheet.json")])
        os.environ.pop("PULLED_AT")
    finally:
        ros.fetch = orig
    st = read(tmp, "okr_sheet_status.json")
    check(rc == 0 and open(os.path.join(tmp, "okr_sheet.json")).read() == before,
          "a 403 exits 0 and leaves the last file untouched")
    check(st["cause"] == "not_shared" and st["http_status"] == 403 and "private" not in json.dumps(st)
          and st["detail"] == ros.CAUSE_TEXT["not_shared"],
          "the public status carries the fixed text for the cause, never the exception message")

    # the bake's loader + leak check on what the refresher wrote
    shutil.copy(os.path.join(tmp, "okr_sheet.json"), os.path.join(tmp, "x.json"))
    d_, err_, probs_, raw_ = bake.load_okr_sheet(tmp)
    check(d_ is not None and not err_ and not probs_ and bake.okr_sheet_leaks(raw_) == [],
          "the bake loads the refresher's file cleanly and finds nothing to refuse")
finally:
    shutil.rmtree(tmp)

# ---------------------------------------------------------------------------
# 4. The bake's rules for the nine sheet KRs
# ---------------------------------------------------------------------------
def sheet_doc(pulled="2026-10-05T09:00:00Z", **series_over):
    s = {
        "oo1": {"tab": "2026 Summary", "pulled_at": pulled, "as_of": "2026-10",
                "krs": {k: {"2026-01": 100, "2026-08": 80, "2026-09": 0, "2026-10": 50}
                        for k in ros.OO1_KRS}},
        "oo2_kr3": {"tab": "c", "pulled_at": pulled, "months": {"2026-01": 0, "2026-02": 1, "2026-10": 0}},
        "oo3_kr3": {"tab": "m", "pulled_at": pulled, "months": {"2026-01": 0, "2026-10": 2}},
        "oo4_kr1": {"tab": "l", "pulled_at": pulled, "months": {"2026-03": 4}},
        "oo4_kr4": {"tab": "2026 OKRs", "pulled_at": pulled,
                    "months": {"2026-02": 100, "2026-03": 99, "2026-04": 98, "2026-05": 97.5, "2026-10": 100}},
    }
    s.update(series_over)
    return {"pulled_at": pulled, "series": s}


def by_m(entry):
    return {v["m"]: v for v in entry["months"]}


ex, gp = bake.okr_sheet_extra(sheet_doc(), None, None, "2026-10")
k3 = by_m(ex[("OO2", "KR3")])
check(sorted(k3) == bake._okr_month_range("2026-01", "2026-10"),
      "every month from January to the pull month is present on a sheet row")
check(k3["2026-01"]["score"] == 100 and k3["2026-02"]["score"] == 80 and k3["2026-01"]["value"] == 0,
      "an entered 0 scores 100 and an entered 1 scores 80 on 'zero'")
check(k3["2026-03"]["value"] is None and k3["2026-03"]["score"] is None
      and "not entered for March 2026" in k3["2026-03"]["not_measured"],
      "A CLOSED MONTH NOT ENTERED is not measured, with the reason - never 0")
check(any("OO2 KR3 Mar 2026" in g for g in gp), "...and the not-entered months are listed in a gap")
check(ex[("OO2", "KR3")]["source_kind"] == "sheet_log" and ex[("OO4", "KR4")]["source_kind"] == "sheet_finance",
      "the log KRs say 'sheet_log', OO4 KR4 'sheet_finance'")
k4 = by_m(ex[("OO4", "KR4")])
check([k4[m]["score"] for m in ("2026-02", "2026-03", "2026-04", "2026-05")] == [100, 80, 50, 0]
      and k4["2026-03"]["display"] == "99%",
      "OO4 KR4 is the Finance % banded 'full': 100/99/98/97.5 score 100/80/50/0")
_exs = json.dumps(list(ex.values()))
check("Efficiency" not in _exs and not any(n in _exs for n in bake.OO1_FORBIDDEN),
      "no Finance column name appears anywhere in the sheet rows")

o1 = by_m(ex[("OO1", "KR1")])
check(all(v["value"] is None and v["display"] is None for v in o1.values()),
      "OO1 months carry NO value and NO display - ever")
check(o1["2026-08"]["score"] == 80 and o1["2026-08"]["rag"] == "amber" and o1["2026-09"]["score"] == 0,
      "OO1 closed months carry Finance's score and its RAG")
check(o1["2026-10"]["score"] is None and o1["2026-10"]["mtd"] is True,
      "OO1's month in progress is NOT scored even when Finance has typed one (a short month)")
check(o1["2026-02"]["score"] is None and "not entered" in o1["2026-02"]["not_measured"],
      "an OO1 month Finance has not scored is not measured")

# the MTD gate a la the assembly: an open count already breached scores 0
m3 = by_m(ex[("OO3", "KR3")])["2026-10"]
g = bake.okr_mtd_variant(m3, "zero_strict", "2026-10", None)
check(g["score"] == 0 and g["mtd"] is False, "an open month already past its last tolerance (2 on zero_strict) scores 0")
g = bake.okr_mtd_variant(by_m(ex[("OO2", "KR3")])["2026-10"], "zero", "2026-10", None)
check(g["score"] is None and g["mtd"] is True, "an open month's 0 so far stays MTD - never green early")
g = bake.okr_mtd_variant(by_m(ex[("OO4", "KR4")])["2026-10"], "full", "2026-10", None)
check(g["score"] is None and g["mtd"] is True, "an open month's % stays MTD")

# unavailable / withheld / stale
ex, gp = bake.okr_sheet_extra(None, "absent", {"ok": False, "cause": "not_shared",
                                               "detail": ros.CAUSE_TEXT["not_shared"],
                                               "attempted_at": "2026-10-10T15:00:00Z"}, "2026-10")
check(len(ex) == 9 and all(e["months"] is None and "HTTP 403" in e["not_measured"] for e in ex.values()),
      "no file: all nine rows grey, each naming the 403")
check(len(gp) == 1 and "OO1 KR1-KR5" in gp[0], "...and one gap names them")
ex, gp = bake.okr_sheet_extra(sheet_doc(pulled="2026-10-10T09:00:00Z"), None, None, "2026-10",
                              dated="2026-10-03")
check(all(e["months"] is None and "after this snapshot's date (2026-10-03)" in e["not_measured"]
          for e in ex.values()), "a back-bake never shows a copy read after its date")
st = {"ok": False, "cause": "tab_missing", "detail": "x", "attempted_at": "2026-10-09T09:00:00Z",
      "series_missing": {"oo4_kr1": "tab_missing"}}
doc = sheet_doc(pulled="2026-08-12T09:00:00Z")
doc["series"]["oo4_kr1"]["carried_forward"] = True
ex, gp = bake.okr_sheet_extra(doc, None, st, "2026-10")
l1 = by_m(ex[("OO4", "KR1")])
check("began after the copy" in l1["2026-09"]["not_measured"]
      and "whether it has been entered since is unknown" in l1["2026-08"]["not_measured"]
      and "NOTE: this is the copy read on 2026-08-12" in l1["2026-03"]["basis"],
      "a stale copy says so on every month, and a month after it is 'unknown', not 'not entered'")

# REVIEW (10/10/2026): a copy read while a month was in progress must not score
# that month once it has closed - a part-month figure is a short month.
mid = {"pulled_at": "2026-09-20T09:00:00Z", "series": {
    "oo1": {"tab": "s", "pulled_at": "2026-09-20T09:00:00Z",
            "krs": {k: {"2026-08": 80, "2026-09": 100} for k in ros.OO1_KRS}},
    "oo2_kr3": {"tab": "c", "pulled_at": "2026-09-20T09:00:00Z", "months": {"2026-08": 0, "2026-09": 0}},
    "oo3_kr3": {"tab": "m", "pulled_at": "2026-09-20T09:00:00Z", "months": {"2026-09": 3}},
    "oo4_kr1": {"tab": "l", "pulled_at": "2026-09-20T09:00:00Z", "months": {}},
    "oo4_kr4": {"tab": "o", "pulled_at": "2026-09-20T09:00:00Z", "months": {"2026-09": 100}}}}
for _st, _dated, _lab in ((None, "2026-10-05", "back-bake, status dropped"),
                          ({"ok": False, "cause": "not_shared", "detail": "HTTP 403 - x",
                            "attempted_at": "2026-10-05T09:00:00Z", "series_read": []}, None, "failing pull")):
    ex, _ = bake.okr_sheet_extra(mid, None, _st, "2026-10", dated=_dated)
    s3, s4, o1 = (by_m(ex[("OO2", "KR3")]), by_m(ex[("OO4", "KR4")]), by_m(ex[("OO1", "KR1")]))
    m3 = by_m(ex[("OO3", "KR3")])
    check(s3["2026-08"]["score"] == 100 and o1["2026-08"]["score"] == 80,
          f"[{_lab}] a month that closed BEFORE the copy was read still scores")
    check(s3["2026-09"]["score"] is None and s3["2026-09"].get("incomplete") and s4["2026-09"]["score"] is None
          and o1["2026-09"]["score"] is None and "still in progress" in (o1["2026-09"]["not_measured"] or ""),
          f"[{_lab}] September, read on 20/09 while in progress, is NOT scored - count, % or Finance score")
    check(m3["2026-09"]["score"] == 0, f"[{_lab}] ...unless a count was already past its last tolerance (3 on zero_strict)")
    check("began after the copy" in (s3["2026-10"]["not_measured"] or ""),
          f"[{_lab}] October began after the copy was read - unknown, not 'not entered'")

# REVIEW: staleness comes from what the pull READ, not from a timestamp a second apart
fresh = sheet_doc(pulled="2026-10-10T06:00:00Z")
for att in ("2026-10-10T06:00:00Z", "2026-10-10T06:00:01Z"):
    ex, _ = bake.okr_sheet_extra(fresh, None, {"ok": False, "cause": "oo1_not_scores", "detail": "x",
                                               "attempted_at": att, "series_read": ["oo2_kr3", "oo3_kr3",
                                               "oo4_kr1", "oo4_kr4"]}, "2026-10")
    k3 = by_m(ex[("OO4", "KR1")])   # October blank on this fixture
    check(k3["2026-10"].get("mtd") is True and "NOTE" not in (k3["2026-03"]["basis"] or ""),
          f"a series this pull READ is not stale, whatever second the status was stamped ({att[-3:-1]}s)")
check(any("latest pull of the Operations Input sheet" in g_ for g_ in gp), "...and the failed pull is a gap")
ex, _ = bake.okr_sheet_extra(sheet_doc(oo4_kr1=None), None, {"ok": False, "cause": "tab_missing",
                             "series_missing": {"oo4_kr1": "tab_missing"}}, "2026-10")
check(ex[("OO4", "KR1")]["months"] is None and "(tab_missing)" in ex[("OO4", "KR1")]["not_measured"],
      "a series never read is grey naming its cause; the others still score")

# loader type checks and the leak refusal
tmp = tempfile.mkdtemp(prefix="okr_sheet_test_")
try:
    d = sheet_doc()
    d["series"]["oo1"]["krs"]["KR2"]["2026-05"] = 37.5
    d["series"]["oo2_kr3"]["months"]["2026-05"] = -1
    with open(os.path.join(tmp, "okr_sheet.json"), "w") as fh:
        json.dump(d, fh)
    d_, err_, probs_, raw_ = bake.load_okr_sheet(tmp)
    check("2026-05" not in d_["series"]["oo1"]["krs"]["KR2"] and "2026-05" not in d_["series"]["oo2_kr3"]["months"]
          and len(probs_) == 2 and not any("37.5" in p_ for p_ in probs_),
          "the bake drops (never coerces) a non-score OO1 entry and a negative count, naming month not value")
    check(bake.okr_sheet_leaks(raw_) == ["OO1 KR2 2026-05 is not a 0/50/80/100 score"],
          "...and REFUSES to publish a file carrying a non-score OO1 entry")
    check(bake.okr_sheet_leaks('{"x": "KR2 Variance"}') == ["Finance column name 'KR2 Variance'"],
          "...or a Finance column name")
finally:
    shutil.rmtree(tmp)
check(bake.OO1_FORBIDDEN == vod.OO1_FORBIDDEN, "the bake's OO1_FORBIDDEN is identical to the verifier's")

snap = {"scorecard": {"rows": [{"objective": "OO1", "kr": "KR1", "value": 21.5, "display": "21.5%",
                                "score": 80, "months": [{"m": "2026-09", "value": None, "display": None,
                                                         "score": 75, "rag": "amber"}]}]}}
nulled, leaked = bake.okr_oo1_guard(snap)
r0 = snap["scorecard"]["rows"][0]
check(nulled == ["OO1 KR1", "OO1 KR1 2026-09"] and r0["value"] is None and r0["display"] is None
      and r0["months"][0]["score"] is None and leaked == [],
      "the bake's pre-write guard nulls an OO1 figure and a non-score, naming only KR and month")
check(bake.okr_oo1_guard({"note": "KR1 Efficiency"})[1] == ["KR1 Efficiency"],
      "...and reports a Finance column name so the bake refuses to write")

# ---------------------------------------------------------------------------
# 5. The contact list: structure only, and OO2 KR5's rule
# ---------------------------------------------------------------------------
HDR = ["Scope", "Company Name", "Contact Number", "Email", "Location", "Notes", "Call Out Rate/hR"]
t = rmc.build_tab("Sheffield", 7, [HDR, ["a", "b", "c", "d", "e", "", "f"], [""] * 7, [""] * 7,
                                   ["a", "b", "", "", "", "", ""]])
check(t["rows"] == ["xxxxx.x", "xx....."] and t["header"] == HDR,
      "blank rows are skipped, not the end of the tab; a stray row below them is still a row")
t = rmc.build_tab("X", 1, [["Notes"], HDR[:5], ["v"] * 5])
check(t["header_row"] == 2 and t["rows"] == ["xxxxx"], "the header is found by Scope + Contact Number")
check(rmc.build_tab("Y", 1, [["foo", "bar"], ["1", "2"]])["header"] == [],
      "a tab with no recognisable header carries no header and no rows")
check(rmc.self_check({"tabs": [{"title": "Call 07700900123"}]}) == ["$.tabs[0].title"]
      and rmc.self_check({"a": "x@y.z"}) == ["$.a"] and rmc.self_check({"gid": 1234567890}) == [],
      "the self-check flags a phone-like run or an '@' in any string (a numeric gid is fine)")
check(rmc.self_check({"tabs": [{"title": "Plumber +44 7700 900 123", "header": ["Scope", "OOH 0161 496 0000"]}]})
      == ["$.tabs[0].title", "$.tabs[0].header[1]"]
      and rmc.self_check({"pulled_at": "2026-10-10T10:00:00Z",
                          "tabs": [{"title": "Glasgow and Edinburgh", "header": ["Call Out Rate/hR"]}]}) == [],
      "SPACED phone numbers in a tab title or header cell are caught too; city names, column names "
      "and the timestamp pass")
t = rmc.build_tab("Leeds", 2, [HDR + ["OOH Dave 0161 496 0000"], ["v"] * 8])
check(t["header"][-1] == "(column H)" and "0161" not in json.dumps(t),
      "a header cell holding a spaced phone number is published as '(column H)', not its text")
tmp = tempfile.mkdtemp(prefix="contacts_test_")
try:
    dmp = {"London": [HDR, ["Gas", "Synthetic Co", "0000", "a@b.test", "Town", "", "£10"]],
           "Glasgow and Edinburgh": [HDR[:5]]}
    with open(os.path.join(tmp, "d.json"), "w") as fh:
        json.dump(dmp, fh)
    os.environ["PULLED_AT"] = "2026-10-10T10:00:00Z"
    rc = rmc.main(["--from-json", os.path.join(tmp, "d.json"), "--out", os.path.join(tmp, "mc.json")])
    raw = open(os.path.join(tmp, "mc.json")).read()
    check(rc == 0 and "Synthetic Co" not in raw and "a@b.test" not in raw and "£" not in raw
          and json.loads(raw)["tabs"][0]["rows"] == ["xxxxx.x"],
          "the written file holds the fill pattern only - no cell value")
    check("sheet_id" not in json.loads(raw), "...and no sheet id")
    dmp["Call 07700900123"] = [HDR]
    with open(os.path.join(tmp, "d.json"), "w") as fh:
        json.dump(dmp, fh)
    os.environ["PULLED_AT"] = "2026-10-11T10:00:00Z"
    rc = rmc.main(["--from-json", os.path.join(tmp, "d.json"), "--out", os.path.join(tmp, "mc.json")])
    os.environ.pop("PULLED_AT")
    st = read(tmp, "maintenance_contacts_status.json")
    check(rc == 0 and st["cause"] == "self_check_failed" and "0770" not in open(os.path.join(tmp, "mc.json")).read(),
          "a tab title that looks like a phone number fails the self-check and nothing is written")
    _cid = os.environ.pop("CONTACTS_SHEET_ID", None)
    _sid, rmc.SHEET_ID = rmc.SHEET_ID, ""
    try:
        rc = rmc.main(["--out", os.path.join(tmp, "none.json")])
    finally:
        rmc.SHEET_ID = _sid
        if _cid is not None:
            os.environ["CONTACTS_SHEET_ID"] = _cid
    st = read(tmp, "maintenance_contacts_status.json")
    check(rc == 0 and st["cause"] == "no_sheet_id" and not os.path.exists(os.path.join(tmp, "none.json")),
          "with no CONTACTS_SHEET_ID (set only in the private workflow) nothing is asked for or written")
finally:
    shutil.rmtree(tmp)
_src = open(os.path.join(BUILDERS, "refresh_maintenance_contacts.py")).read()
check(not re.search(r"[A-Za-z0-9_-]{40,}", _src) and rmc.SHEET_ID == os.environ.get("CONTACTS_SHEET_ID", "").strip(),
      "the contact list's sheet id is NOT in the public refresher - it comes from the private workflow")


def cdoc(full_tabs, partial=(), extra_tabs=(), pulled="2026-10-10T10:00:00Z"):
    """full_tabs: tabs with reachable contacts; partial: tabs whose rows have
    neither a Contact Number nor an Email."""
    tabs = []
    for tab in bake.CONTACT_TAB_SITES:
        if tab in full_tabs:
            tabs.append({"title": tab, "header": HDR, "rows": ["xxxxx.x", "xxx.x.."]})
        elif tab in partial:
            tabs.append({"title": tab, "header": HDR, "rows": ["xx..x..", "x......"]})
    for tab in extra_tabs:
        tabs.append({"title": tab, "header": HDR, "rows": ["xxxxxxx"]})
    return {"pulled_at": pulled, "tabs": tabs}


check(len(bake.KR5_SITES) == 20 and len(set(bake.KR5_SITES)) == 20
      and set(bake.KR5_SITES) <= set(bake.SITE_REGIONS)
      and not {"Maki O2 Arena", "Maki Braehead", "AA Factory1 Limited", "Maki Property Ltd"} & set(bake.KR5_SITES),
      "the KR5 denominator is the 20 corporate restaurants - no franchise, factory or head office")
mapped = [s_ for v in bake.CONTACT_TAB_SITES.values() for s_ in v]
check(len(mapped) == len(set(mapped)) and set(mapped) <= set(bake.KR5_SITES)
      and set(bake.KR5_SITES) - set(mapped) == {"Maki Southampton", "Maki Birmingham Ltd"},
      "every mapped site is a KR5 site, mapped once; only Southampton and Birmingham have no tab")
allt = [t_ for t_ in bake.CONTACT_TAB_SITES if t_ != "Glasgow and Edinburgh"]
kw, gp = bake.maint_contacts_kr5(cdoc(allt, extra_tabs=("Bristol",)), None, None)
check(kw["value"] == 60.0 and bake.okr_score("contact", kw["value"]) == 0 and kw["display"] == "12 of 20 sites (60%)",
      "any contact on the tab: 12 of 20 covered is 60% and scores 0 on 'contact' (the real list today)")
check("Not covered: M1TOO Ltd" in kw["basis"] and "Glasgow and Edinburgh: tab not found" in kw["basis"]
      and "any contact on the tab" in kw["basis"], "the basis names the rule, the tabs and every site not covered")
check(any("Maki Southampton, Maki Birmingham Ltd" in g_ for g_ in gp) and any("'Bristol'" in g_ for g_ in gp),
      "sites with no tab and a tab mapped to no site are named gaps")
kw, gp = bake.maint_contacts_kr5(cdoc(allt[:-1], partial=(allt[-1],)), None, None)
check(kw["value"] == 55.0 and "Aberdeen: no contacts" in kw["basis"]
      and any("'Aberdeen' tab holds no contact" in g_ for g_ in gp),
      "a tab whose rows carry neither a number nor an email holds no contact, and is a named gap")
one = cdoc(allt)
one["tabs"][0]["rows"] = ["xx.x..."]
check(bake.maint_contacts_kr5(one, None, None)[0]["value"] == 60.0,
      "one row with only an Email is a contact - the tab is covered")
one["tabs"][0]["rows"] = ["xx.....", "xxx...."]
check("London: 1 contact" in bake.maint_contacts_kr5(one, None, None)[0]["basis"],
      "a stray row with no number or email (the Sheffield footer) is not counted as a contact")
d19 = cdoc(list(bake.CONTACT_TAB_SITES))
v19 = 100.0 * 18 / 20
check(bake.maint_contacts_kr5(d19, None, None)[0]["value"] == v19 and bake.okr_score("contact", v19) == 50,
      "18 of 20 = 90.0 scores 50 - the exact fraction")
check(bake.okr_score("contact", 100.0 * 18 / 19) == 50,
      "18 of 19 = 94.7 would score 50, not 80 - never rounded into a better band")
hdr_short = cdoc(list(bake.CONTACT_TAB_SITES))
hdr_short["tabs"][0]["header"] = ["Scope", "Company Name", "Location"]
hdr_short["tabs"][0]["rows"] = ["xxx"]
check("London: no Contact Number or Email column" in bake.maint_contacts_kr5(hdr_short, None, None)[0]["basis"],
      "a tab whose header has no Contact Number or Email column cannot hold a contact, and says why")
check(bake.maint_contacts_leaks(json.dumps({"pulled_at": "2026-10-10T10:00:00Z", "tabs": [
          {"title": "Plumber +44 7700 900 123", "header": ["OOH 0161 496 0000"], "rows": ["x"]}]}))
      == ["$.tabs[0].title", "$.tabs[0].header[0]"]
      and bake.maint_contacts_leaks(json.dumps(cdoc(allt))) == [],
      "the bake's own check flags contact-like text in the contact file, and passes a clean one")
check("after this snapshot's date (2026-10-03)" in
      bake.maint_contacts_kr5(cdoc(allt), None, None, dated="2026-10-03")[0]["not_measured"],
      "a back-bake never shows a contact list read after its date")
kw, gp = bake.maint_contacts_kr5(None, "absent", {"ok": False, "cause": "not_shared", "detail": "HTTP 403 - x"})
check("HTTP 403" in kw["not_measured"] and "value" not in kw, "no file: KR5 grey with the cause, never 0")

# ---------------------------------------------------------------------------
# 6. A real bake on a tiny archive, with and without the sheet
# ---------------------------------------------------------------------------
PRICE_FEED = "Kobas Report - Weekly Ingredient Price Changes Report"
PRICE_SLUG = "Kobas_Report_Weekly_Ingredient_Price_Changes_Report"


def write_archive(root, day="2026-10-05"):
    d = os.path.join(root, day)
    os.makedirs(d, exist_ok=True)
    with gzip.open(os.path.join(d, PRICE_SLUG + ".jsonl.gz"), "wt") as fh:
        fh.write(json.dumps({"row_num": 0, "data": {"Parent ID": 1, "Ingredient Name": "WIDGET",
                                                    "Pack Size": 1.0, "Unit Volume": 1000,
                                                    "Measurement": "Grams", "Old Price": "1.00",
                                                    "New Price": "1.05"}}) + "\n")
    with open(os.path.join(d, "_feeds.json"), "w") as fh:
        json.dump({PRICE_SLUG: PRICE_FEED}, fh)


def real_bake(archive, out, date=None):
    env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=archive, OPS_OUT_DIR=out)
    args = [sys.executable, os.path.join(BUILDERS, "bake_ops_command.py")] + (["--date", date] if date else [])
    return subprocess.run(args, env=env, capture_output=True, text=True)


tmp = tempfile.mkdtemp(prefix="okr_sheet_bake_")
try:
    arc, out = os.path.join(tmp, "arc"), os.path.join(tmp, "out")
    write_archive(arc, "2026-10-03")
    write_archive(arc, "2026-10-05")
    os.makedirs(out)
    with open(os.path.join(out, "okr_sheet.json"), "w") as fh:
        json.dump(sheet_doc(), fh)
    with open(os.path.join(out, "maintenance_contacts.json"), "w") as fh:
        json.dump(cdoc(allt), fh)
    p = real_bake(arc, out)
    check(p.returncode == 0, "the real bake runs with both files present" + ("" if p.returncode == 0 else p.stderr[-800:]))
    sn = json.load(open(os.path.join(out, "snapshot_2026-10-05.json")))
    sc = sn["scorecard"]
    rows = {(r["objective"], r["kr"]): r for r in sc["rows"]}
    oo1 = [rows[("OO1", k)] for k in ros.OO1_KRS]
    check(all(r["source_kind"] == "sheet_finance" and r["value"] is None and r["display"] is None
              and all(v["value"] is None and v["display"] is None for v in r["months"]) for r in oo1),
          "BAKED: OO1 rows are sheet_finance with no value or display, row or month")
    ob = {o["objective"]: o for o in sc["objectives"]}
    sep = next(x for x in ob["OO1"]["months"] if x["m"] == "2026-09")
    check(sep["pct"] is None and sep["scored"] == 5 and ob["OO1"]["pct"] is None and ob["OO1"].get("pct_note"),
          "BAKED: OO1 shows '5 scored' for September and NO objective percentage")
    jan2 = next(x for x in ob["OO2"]["months"] if x["m"] == "2026-01")
    check(jan2["pct"] == 100.0 and jan2["scored"] == 1, "BAKED: OO2 January scores from the closures log")
    r5 = rows[("OO2", "KR5")]
    check(r5["source_kind"] == "sheet_contacts" and r5["value"] == 60.0 and r5["score"] == 0 and r5["months"] is None,
          "BAKED: OO2 KR5 is 12 of 20 (60%), current state, scored 0")
    check(sc["measured"] == sum(1 for r in sc["rows"]
                                if r["value"] is not None or r["score"] is not None),
          "BAKED: measured counts score-only rows too")
    # the verifier agrees with the bake on its own snapshot
    vod.RESULTS.clear()
    vod.check_okr_scorecard(sn, "2026-10-05")
    crit = [r for r in vod.RESULTS if r["level"] == "critical"]
    check(not crit, "the verifier's scorecard checks pass on the baked snapshot"
          + ("" if not crit else ": " + "; ".join(c["detail"][:200] for c in crit)))
    # the verifier catches a leak and does not quote it
    bad = json.loads(json.dumps(sn))
    for r in bad["scorecard"]["rows"]:
        if r["objective"] == "OO1" and r["kr"] == "KR4":
            r["value"], r["display"] = 6.25, "6.25%"
            r["months"][-2]["score"] = 37
    vod.RESULTS.clear()
    vod.check_okr_scorecard(bad, "2026-10-05")
    crit = " ".join(r["detail"] for r in vod.RESULTS if r["level"] == "critical")
    check("FINANCE FIGURES" in crit and "KR4" in crit and "6.25" not in crit and "outside 0/50/80/100" in crit,
          "the verifier flags an OO1 figure and a non-score, naming the KR and NOT the figure")
    with open(os.path.join(tmp, "bad_snap.json"), "w") as fh:
        json.dump(bad, fh)
    vod.RESULTS.clear()
    _orig = vod.OKR_SHEET_PATH
    vod.OKR_SHEET_PATH = os.path.join(out, "okr_sheet.json")
    try:
        vod.check_oo1_public(os.path.join(tmp, "bad_snap.json"))
        c1 = [r for r in vod.RESULTS if r["level"] == "critical"]
        vod.RESULTS.clear()
        vod.check_oo1_public(os.path.join(out, "snapshot_2026-10-05.json"))
        c2 = [r for r in vod.RESULTS if r["level"] == "critical"]
    finally:
        vod.OKR_SHEET_PATH = _orig
    check(len(c1) == 1 and "6.25" not in c1[0]["detail"] and not c2,
          "4e sweeps the COMMITTED snapshot and okr_sheet.json: flags the leak, passes the clean one")

    # a dated back-bake withholds both copies (read on 10-05 09:00 > 10-04)
    p = real_bake(arc, out, date="2026-10-04")
    sn = json.load(open(os.path.join(out, "snapshot_2026-10-04.json")))
    rows = {(r["objective"], r["kr"]): r for r in sn["scorecard"]["rows"]}
    check(p.returncode == 0 and "after this snapshot's date (2026-10-04)" in (rows[("OO2", "KR3")]["not_measured"] or "")
          and rows[("OO2", "KR5")]["value"] is None,
          "BAKED --date: the sheet rows and KR5 are withheld, not time-travelled")

    # the bake refuses to run when okr_sheet.json would publish a non-score
    d = sheet_doc()
    d["series"]["oo1"]["krs"]["KR1"]["2026-03"] = 12.5
    with open(os.path.join(out, "okr_sheet.json"), "w") as fh:
        json.dump(d, fh)
    before = sorted(os.listdir(out))
    p = real_bake(arc, out)
    check(p.returncode == 1 and "REFUSING TO BAKE" in p.stderr and "12.5" not in p.stderr + p.stdout,
          "the bake REFUSES (exit 1, so nothing is pushed) when okr_sheet.json carries a non-score OO1 entry")
    check(sorted(os.listdir(out)) == before, "...and writes nothing")
finally:
    shutil.rmtree(tmp)

print(f"\n{'FAILED' if failures else 'passed'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
