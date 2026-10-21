#!/usr/bin/env python3
"""The Operations Input sheet and the Maintenance Contact List (Phase 1, 10/10/2026).

Pins, end to end, the rules the five sheet-fed KRs and OO2 KR5 live by (OO6
KR1 and OO6 KR2's 'all POs invoiced' cell are pinned in tests/oo6_test.py):

  * A MONTH NOT ENTERED IS NOT SCORED - an explicit not-measured month, never 0.
  * OO1 IS NOT READ FROM THIS SHEET ANY MORE (Ross, 15/10/2026: Finance's
    management account, builders/oo1_ma.py - tests/oo1_ma_test.py). Its
    '2026 Summary' tab is never asked for, and an okr_sheet.json carrying an
    OO1 series is refused. OO1 is still SCORES ONLY - no value, no display, no
    objective % - and the real bake below checks that with the new source.
  * The refreshers fail soft, write a status file with FIXED text (never an
    exception message - the file is public), write atomically, and carry a
    series forward rather than drop it when one tab cannot be read.
  * Only the OO4 credit-notes ranges of '2026 OKRs' are ever requested - and
    the OO6 cells only once they are pinned (none are, here).
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
import oo1_ma  # noqa: E402
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


OO1_KRS = ("KR1", "KR2", "KR3", "KR4", "KR5")


def summary(oo1=None, label="OO1 :  <target> Net Profit", lead_rows=0):
    """'2026 Summary' as it is on the sheet - which is NO LONGER READ (OO1 moved
    to Finance's management account, 15/10/2026). Kept so the tests can show
    that its cells, a Finance percentage included, reach nothing."""
    oo1 = oo1 or {k: ["100.00", "80.00", "50", "0", "", "", "", "", "", "", "", ""]
                  for k in OO1_KRS}
    rows = [["", ""] + [""] * 12 for _ in range(lead_rows)]
    rows.append(["Objective ", ""] + MON)
    rows.append([label, "Function "] + [""] * 12)
    for kr in OO1_KRS:
        rows.append([f"{kr}: <synthetic label>", "Finance"] + oo1[kr])
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

check(not hasattr(ros, "build_oo1") and "summary" not in ros.TAB_TITLES and "oo1" not in ros.SERIES
      and "oo1_not_scores" not in ros.CAUSE_TEXT,
      "OO1 is not read from the Operations Input sheet any more (Ross, 15/10/2026): no reader, tab, series or cause")

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
# OO6's two cells are not pinned in this file's environment: named, never requested
NL = {"oo6_kr1": "not_located", "oo6_kr2_invoiced": "not_located"}
got, missing = ros.fetch("x", spreadsheet=FakeSheet(wss))
check(missing == NL and set(got) == {"okrs", "oo2_kr3", "oo3_kr3", "oo4_kr1"},
      "fetch finds every tab it reads by exact title (trailing space and misspelling included)")
check(wss[2].calls == [ros.OO4_KR4_RANGES] and wss[0].calls == [] and wss[1].calls == [],
      f"'2026 OKRs' is asked ONLY for {ros.OO4_KR4_RANGES} (never get_all_values); 'Approval' and "
      "'2026 Summary' are never read")
check(got["okrs"][2][2][:3] == ["Feb-26", "100", "100"],
      "the two ranges are joined row by row into [Month, Limit, Actual]")
wss[5].title = "Unplanned Restaurant Closures"
got, missing = ros.fetch("x", spreadsheet=FakeSheet(wss))
check(missing == {"oo2_kr3": "tab_missing", **NL}, "a renamed tab is named as tab_missing, not guessed")
os.environ["OKR_GID_CLOSURES"] = "6"
got, missing = ros.fetch("x", spreadsheet=FakeSheet(wss))
os.environ.pop("OKR_GID_CLOSURES")
check("oo2_kr3" in got and missing == NL, "a pinned gid survives the rename")


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
    _read4 = sorted(set(ros.SERIES) - set(ros.OO6_SERIES))
    check(rc == 0 and st["ok"] is True and st["cause"] == "ok" and st["failing_since"] is None
          and st["series_read"] == _read4 and st["series_missing"] == NL,
          "a full read writes the file and an ok status - OO6's unpinned cells are named, "
          "and are not a failed pull")
    check("worksheets" not in doc and set(doc["series"]) == set(_read4) and len(ros.SERIES) == 6
          and "oo1" not in doc["series"],
          "the public file carries the four series read - no OO1 - and NOT the worksheet inventory")
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
    check(st["ok"] is False and st["cause"] == "tab_missing"
          and st["series_missing"] == {"oo4_kr1": "tab_missing", **NL}
          and st["failing_since"] == "2026-04-20T10:00:00Z", "...and the status says which, and since when")
    rc, out = run_refresher(tmp, dump(oo4_kr1=None), pulled="2026-04-21T10:00:00Z")
    st = read(tmp, "okr_sheet_status.json")
    check(st["failing_since"] == "2026-04-20T10:00:00Z", "failing_since holds while the failure lasts")

    # a Finance percentage typed on '2026 Summary' reaches nothing: the tab
    # is no longer read at all (OO1 moved to Finance's management account)
    bad = {k: ["100", "", "", "", "", "", "", "", "", "", "", ""] for k in OO1_KRS}
    bad["KR2"] = ["12.34%", "", "", "", "", "", "", "", "", "", "", ""]
    rc, out = run_refresher(tmp, dump(summary=summary(oo1=bad)), pulled="2026-04-22T10:00:00Z")
    raw = open(os.path.join(tmp, "okr_sheet.json")).read()
    check("12.34" not in raw and "12.34" not in out and "oo1" not in json.loads(raw)["series"],
          "a Finance percentage on '2026 Summary' reaches neither the file nor the log - and no OO1 series is written")

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
        "oo2_kr3": {"tab": "c", "pulled_at": pulled, "months": {"2026-01": 0, "2026-02": 1, "2026-10": 0}},
        "oo3_kr3": {"tab": "m", "pulled_at": pulled, "months": {"2026-01": 0, "2026-10": 2}},
        "oo4_kr1": {"tab": "l", "pulled_at": pulled, "months": {"2026-03": 4}},
        "oo4_kr4": {"tab": "2026 OKRs", "pulled_at": pulled,
                    "months": {"2026-02": 100, "2026-03": 99, "2026-04": 98, "2026-05": 97.5, "2026-10": 100}},
        "oo6_kr1": {"tab": "2026 OKRs", "pulled_at": pulled, "months": {"2026-10": 100}},
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

check(not any(k[0] == "OO1" for k in ex), "the sheet feeds no OO1 row any more")

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
check(len(ex) == 5 and all(e["months"] is None and "HTTP 403" in e["not_measured"] for e in ex.values()),
      "no file: all five rows grey, each naming the 403")
check(len(gp) == 1 and "OO2 KR3, OO3 KR3, OO4 KR1, OO4 KR4 and OO6 KR1" in gp[0] and "OO1" not in gp[0],
      "...and one gap names them")
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
    "oo2_kr3": {"tab": "c", "pulled_at": "2026-09-20T09:00:00Z", "months": {"2026-08": 0, "2026-09": 0}},
    "oo3_kr3": {"tab": "m", "pulled_at": "2026-09-20T09:00:00Z", "months": {"2026-09": 3}},
    "oo4_kr1": {"tab": "l", "pulled_at": "2026-09-20T09:00:00Z", "months": {}},
    "oo4_kr4": {"tab": "o", "pulled_at": "2026-09-20T09:00:00Z", "months": {"2026-09": 100}}}}
for _st, _dated, _lab in ((None, "2026-10-05", "back-bake, status dropped"),
                          ({"ok": False, "cause": "not_shared", "detail": "HTTP 403 - x",
                            "attempted_at": "2026-10-05T09:00:00Z", "series_read": []}, None, "failing pull")):
    ex, _ = bake.okr_sheet_extra(mid, None, _st, "2026-10", dated=_dated)
    s3, s4 = by_m(ex[("OO2", "KR3")]), by_m(ex[("OO4", "KR4")])
    m3 = by_m(ex[("OO3", "KR3")])
    check(s3["2026-08"]["score"] == 100,
          f"[{_lab}] a month that closed BEFORE the copy was read still scores")
    check(s3["2026-09"]["score"] is None and s3["2026-09"].get("incomplete") and s4["2026-09"]["score"] is None
          and "still in progress" in (s4["2026-09"]["basis"] or ""),
          f"[{_lab}] September, read on 20/09 while in progress, is NOT scored - count or %")
    check(m3["2026-09"]["score"] == 0, f"[{_lab}] ...unless a count was already past its last tolerance (3 on zero_strict)")
    check("began after the copy" in (s3["2026-10"]["not_measured"] or ""),
          f"[{_lab}] October began after the copy was read - unknown, not 'not entered'")

# REVIEW: staleness comes from what the pull READ, not from a timestamp a second apart
fresh = sheet_doc(pulled="2026-10-10T06:00:00Z")
for att in ("2026-10-10T06:00:00Z", "2026-10-10T06:00:01Z"):
    ex, _ = bake.okr_sheet_extra(fresh, None, {"ok": False, "cause": "layout_changed", "detail": "x",
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
    d["series"]["oo1"] = {"tab": "2026 Summary", "pulled_at": "2026-10-05T09:00:00Z",
                          "krs": {"KR2": {"2026-05": 37.5}}}
    d["series"]["oo2_kr3"]["months"]["2026-05"] = -1
    with open(os.path.join(tmp, "okr_sheet.json"), "w") as fh:
        json.dump(d, fh)
    d_, err_, probs_, raw_ = bake.load_okr_sheet(tmp)
    check("oo1" not in d_["series"] and "2026-05" not in d_["series"]["oo2_kr3"]["months"]
          and len(probs_) == 2 and not any("37.5" in p_ for p_ in probs_),
          "the bake ignores an OO1 series and drops (never coerces) a negative count, naming month not value")
    check(bake.okr_sheet_leaks(raw_) == ["an OO1 series that is not the old score-only shape - OO1 is no "
                                         "longer read from the Operations Input sheet (Ross, 15/10/2026)"],
          "...and REFUSES to publish a file carrying an OO1 series that is not a score (maybe a Finance figure)")
    check(bake.okr_sheet_leaks('{"x": "KR2 Variance"}') == ["Finance column name 'KR2 Variance'"],
          "...or a Finance column name")
    # REVIEW (15/10/2026): json.dumps writes '£' as \u00a3 - the check reads it decoded
    check(bake.okr_sheet_leaks(json.dumps({"x": "Money In (£)"})) == ["Finance column name 'Money In (£)'"]
          and "\\u00a3" in json.dumps({"x": "Money In (£)"}),
          "...including a '£' name written escaped, as json.dumps writes it")
    # an old score-only series (what the refresher wrote before 15/10/2026) is
    # ignored with a gap, never a refusal - it was publishable then
    d = sheet_doc()
    d["series"]["oo1"] = {"tab": "2026 Summary", "gid": 0, "pulled_at": "2026-10-05T09:00:00Z",
                          "rows": [3, 7], "as_of": "2026-09", "carried_forward": True,
                          "krs": {"KR1": {"2026-08": 80, "2026-09": 100}, "KR5": {"2026-09": 0}}}
    with open(os.path.join(tmp, "okr_sheet.json"), "w") as fh:
        json.dump(d, fh)
    d_, err_, probs_, raw_ = bake.load_okr_sheet(tmp)
    ex_, gp_ = bake.okr_sheet_extra(d_, err_, None, "2026-10", problems=probs_)
    check(bake.okr_sheet_leaks(raw_) == [] and "oo1" not in d_["series"]
          and any("an OO1 series from before 15/10/2026 - ignored" in g_ for g_ in gp_)
          and not any(k[0] == "OO1" for k in ex_),
          "an OLD score-only OO1 series is ignored with a gap - not refused, and never shown")
    for k_, v_ in (("tab", "Wages 18.4%"), ("gid", "x"), ("pct", 1), ("rows", [1, 2, 3])):
        d["series"]["oo1"] = {"pulled_at": "2026-10-05T09:00:00Z", "krs": {"KR1": {"2026-09": 100}}, k_: v_}
        check(len(bake.okr_sheet_leaks(json.dumps(d))) == 1,
              f"...but one with {k_} {'a figure' if k_ == 'tab' else 'of another shape'} is refused")
finally:
    shutil.rmtree(tmp)
check(bake.OO1_FORBIDDEN == vod.OO1_FORBIDDEN, "the bake's OO1_FORBIDDEN is identical to the verifier's")

# REVIEW (10/10/2026): a malformed but valid-JSON file greys rows, never crashes the bake
tmp = tempfile.mkdtemp(prefix="okr_sheet_test_")
try:
    for bad_doc, lab in (({"pulled_at": "x", "series": ["x"]}, "series a list"),
                         ({"series": {"oo2_kr3": {"pulled_at": "2026-10-01T00:00:00Z", "months": [3]}}}, "months a list"),
                         ({"series": {"oo1": {"pulled_at": "2026-10-01T00:00:00Z", "krs": [12.5]}}}, "krs a list"),
                         ({"series": {"oo1": {"pulled_at": "2026-10-01T00:00:00Z", "krs": {"KR1": [1]}}}}, "a KR a list")):
        with open(os.path.join(tmp, "okr_sheet.json"), "w") as fh:
            json.dump(bad_doc, fh)
        try:
            d_, err_, probs_, raw_ = bake.load_okr_sheet(tmp)
            lk = bake.okr_sheet_leaks(raw_)
            ex_, _ = bake.okr_sheet_extra(d_, err_, None, "2026-10")
            ok_ = True
        except Exception as e:  # noqa: BLE001
            ok_, lk = False, [repr(e)]
        check(ok_, f"malformed okr_sheet.json ({lab}) does not crash the loader, the leak check or the rows")
        if "krs" in lab or "KR a list" in lab:
            check(any("an OO1 series" in x for x in lk),
                  f"...and an OO1 series of any shape ({lab}) is refused, not ignored")
finally:
    shutil.rmtree(tmp)
_lk = bake.okr_sheet_leaks(json.dumps({"series": {"oo1": {"pulled_at": "x", "krs": {"KR1": {"12.5%": 100}},
                                                           "pct": 12.5}}}))
check(len(_lk) == 1 and "12.5" not in _lk[0],
      "an OO1 series with a 'pct' or a stray key is refused - and nothing of it is echoed into the message")
ex, gp = bake.okr_sheet_extra(sheet_doc(pulled="2026-10-06T09:00:00Z"), None, None, "2026-10", today="2026-10-10")
check(any("read on 2026-10-06, 4 days before this bake, and no failed pull is recorded" in g_ for g_ in gp),
      "an old sheet copy with no recorded failure is named by its age (the refresh step stopped)")

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
# REVIEW (15/10/2026): the guard read json.dumps' escaped text, so a '£' name
# never matched; and a figure in an OO1 text or gap was not checked at all
check(bake.okr_oo1_guard({"note": "Money Out (£)"})[1] == ["Money Out (£)"],
      "...including a '£' name (the guard reads the snapshot decoded)")
snap = {"scorecard": {"rows": [{"objective": "OO1", "kr": "KR1", "value": None, "display": None,
                                "score": None, "basis": "≤20% of sales",
                                "months": [{"m": "2026-09", "score": 100, "basis": "wages were 18.4% of sales"},
                                           {"m": "2026-08", "score": 0, "not_measured": "Wages £18,000"}]},
                               {"objective": "OO2", "kr": "KR1", "basis": "93.5% of tasks"}]},
        "gaps": ["OO1: the last good read showed net profit of 6%", "OO2: 12.5% of sites"]}
nulled, leaked = bake.okr_oo1_guard(snap)
check(nulled == [] and leaked == ["a figure in the text of OO1 KR1 2026-09",
                                  "a figure in the text of OO1 KR1 2026-08", "a figure in OO1 gap #1"]
      and not any(x in " ".join(leaked) for x in ("18.4", "18,000", "6%")),
      "...and a figure in an OO1 month's basis or reason, or in an OO1 gap, makes it refuse - "
      "naming where, never the figure; OO2's own percentages are not OO1's")
check(bake.okr_oo1_guard({"scorecard": {"rows": [{"objective": "OO1", "kr": "KR5", "score": True}]}})[0]
      == ["OO1 KR5"], "...and a score that is a bool, not 0 or 100, is nulled")

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


def cdoc(full_tabs, partial=(), extra_tabs=(), pulled="2026-10-10T10:00:00Z",
         empty=("Glasgow and Edinburgh",)):
    """full_tabs: tabs with reachable contacts; partial: tabs whose rows have
    neither a Contact Number nor an Email; empty: tabs present with a header
    and no rows (the real 'Glasgow and Edinburgh' tab). Others are absent."""
    tabs = []
    for tab in bake.CONTACT_TAB_SITES:
        if tab in full_tabs:
            tabs.append({"title": tab, "header": HDR, "rows": ["xxxxx.x", "xxx.x.."]})
        elif tab in partial:
            tabs.append({"title": tab, "header": HDR, "rows": ["xx..x..", "x......"]})
        elif tab in empty:
            tabs.append({"title": tab, "header": HDR[:5], "rows": []})
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
check("Not covered: M1TOO Ltd" in kw["basis"] and "Glasgow and Edinburgh: no contacts" in kw["basis"]
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

# REVIEW (10/10/2026): a tab that could not be read is UNKNOWN, not "no contacts"
unr = cdoc(list(bake.CONTACT_TAB_SITES))
unr["tabs"][0]["header"], unr["tabs"][0]["rows"] = [], []
kw, gp = bake.maint_contacts_kr5(unr, None, None)
check("value" not in kw and "'London' tab has no header row" in kw["not_measured"]
      and "Maki Soho" in kw["not_measured"],
      "a mapped tab whose header could not be found makes KR5 unscored, naming the tab and its sites")
ren = cdoc([t_ for t_ in bake.CONTACT_TAB_SITES if t_ != "Leeds"], extra_tabs=("Leeds (new)",))
kw, _ = bake.maint_contacts_kr5(ren, None, None)
check("value" not in kw and "'Leeds' tab is missing while 'Leeds (new)' is not mapped" in kw["not_measured"],
      "a mapped tab missing while an unmapped one exists (a rename?) is unknown too")
gone = cdoc([t_ for t_ in bake.CONTACT_TAB_SITES if t_ != "Leeds"], empty=())
kw, gp = bake.maint_contacts_kr5(gone, None, None)
check(kw.get("value") == 85.0 and any("'Leeds' tab is missing" in g_ for g_ in gp),
      "a mapped tab simply gone (nothing unmapped) is not covered, and named")
# REVIEW: an old copy with no recorded failure is named by its age
kw, gp = bake.maint_contacts_kr5(cdoc(allt, pulled="2026-10-07T10:00:00Z"), None, None, today="2026-10-10")
check(any("read on 2026-10-07, 3 days before this bake" in g_ for g_ in gp) and "3 days before" in kw["basis"],
      "a contact-list copy older than the bake is named in a gap and the basis, by its age")
kw, gp = bake.maint_contacts_kr5(cdoc(allt, pulled="2026-10-10T06:00:00Z"), None, None, today="2026-10-10")
check(not any("before this bake" in g_ for g_ in gp), "...and today's copy is not")

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


def ma_grid(months):
    """A synthetic '2026' tab of Finance's management account, as a grid: every
    number is INVENTED. months = {m: (sales, wages, rent, food, variable, tax)}."""
    names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    lines = {k: [] for k in ("sales", "wages", "rent", "food", "variable", "tax")}
    calc = {k: [] for k in ("money_in", "money_out", "np", "wages_pct", "food_pct", "variable_pct", "np_pct")}
    for m in range(1, 13):
        v = months.get(m)
        for i, k in enumerate(lines):
            lines[k].append(v[i] if v else None)
        if v:
            s_, w, r, f, va, t = v
            # a blank (or text) line sums as 0, as Excel's SUM does
            out_ = sum(x for x in (w, r, f, va, t) if isinstance(x, (int, float)))
            for k, x in (("money_in", s_), ("money_out", out_), ("np", s_ - out_), ("wages_pct", w / s_),
                         ("food_pct", f / s_), ("variable_pct", va / s_), ("np_pct", (s_ - out_) / s_)):
                calc[k].append(x)
        else:
            for k in calc:
                calc[k].append(0 if k in ("money_in", "money_out", "np") else "#DIV/0!")
    lab = [("Restaurant Sales", lines["sales"]), ("Money In (£)", calc["money_in"]), ("Wages", lines["wages"]),
           ("Wages %", calc["wages_pct"]), ("Rent", lines["rent"]), ("Food costs", lines["food"]),
           ("Food costs %", calc["food_pct"]), ("Variable costs", lines["variable"]),
           ("Variable costs %", calc["variable_pct"]), ("TAX", lines["tax"]),
           ("Money Out (£)", calc["money_out"]), ("Net Profit (£)", calc["np"]), ("Net Profit (%)", calc["np_pct"])]
    return {"2026 ": [["2026 "] + [None] * 12, ["Month"] + names] + [[a] + b for a, b in lab]}


import datetime as _dt  # noqa: E402
# every month Jan-Sep complete: wages 18% (met), food 30% (met), variable 14%
# (missed), net profit 27.9% (met) - read on 03/10, before September's deadline
_MA = ma_grid({m: (100000, 18000, 2000, 30000, 14000, 8100) for m in range(1, 10)})
MA_DOC = oo1_ma.merge(None, oo1_ma.judge_pull(_MA, _dt.datetime(2026, 10, 3, 10, 0), bake.okr_score))
check(oo1_ma.doc_problems(MA_DOC) == [], "the synthetic OO1 document is in the score-only shape")

# OO1's rows from oo1_ma.json, unit level (review, 15/10/2026)
FAILED = {"attempted_at": "2026-10-15T09:00+01:00", "ok": False, "cause": "drive_api_disabled",
          "failing_since": "2026-10-07T09:00+01:00"}
_api = oo1_ma.CAUSE_TEXT["drive_api_disabled"]
ex, gp = bake.oo1_ma_extra(MA_DOC, None, FAILED, "2026-10", "2026-10-15")
_s9 = next(v for v in ex[("OO1", "KR1")]["months"] if v["m"] == "2026-09")
check(gp == [f"OO1: the read of Finance's management account due 07/10/2026 has not happened; the "
             f"last good read was 03/10/2026 - the latest read of Finance's management account "
             f"(15/10/2026 09:00 UK) failed: {_api} (failing since 07/10/2026)"]
      and _s9["score"] == 100,
      "a failed read after a missed 7th: ONE gap naming the due date, the last good read and the "
      "fixed cause - and the last good read's scores stay")
ex, gp = bake.oo1_ma_extra(MA_DOC, None, None, "2026-10", "2026-10-15")
check(gp and gp[0].endswith("the next bake reads"), "...with no attempt recorded, it says the next bake reads")
ex, gp = bake.oo1_ma_extra(MA_DOC, None, None, "2026-10", "2026-10-05")
check(gp == [], "...and before the 7th there is no gap: nothing is due yet")
_odd = dict(FAILED, cause="Traceback: https://example.invalid/?key=SECRET")
ex, gp = bake.oo1_ma_extra(MA_DOC, None, _odd, "2026-10", "2026-10-15")
check("cause not recorded" in gp[0] and "SECRET" not in json.dumps([list(ex.values()), gp], default=str),
      "an unknown cause code is never echoed - 'cause not recorded'")
_only_failed = oo1_ma.merge(None, {"pulled_at": "2026-10-07T09:00+01:00", "pull_date": "2026-10-07",
                                   "ok": False, "cause": "drive_api_disabled", "tab": None})
ex, gp = bake.oo1_ma_extra(_only_failed, None, FAILED, "2026-10", "2026-10-15")
check(all(ex[("OO1", k)]["months"] is None and ex[("OO1", k)]["source_kind"] == "not_measured"
          and "has not been read yet" in ex[("OO1", k)]["not_measured"]
          and _api in ex[("OO1", k)]["not_measured"] for k in OO1_KRS) and len(gp) == 1,
      "only failed reads: every OO1 row grey with the cause and NO months (nothing to pick)")
ex, gp = bake.oo1_ma_extra(None, "absent", None, "2026-10", "2026-10-15")
check("the first read is the next bake (the read due 07/10/2026 has not happened)"
      in ex[("OO1", "KR1")]["not_measured"],
      "no file after a missed 7th: the first read is the next bake, never a date already past")
ex, gp = bake.oo1_ma_extra(None, "absent", None, "2026-10", "2026-10-05")
check("the first read is the next bake (the read due 07/09/2026 has not happened)"
      in ex[("OO1", "KR1")]["not_measured"],
      "...and a workbook never read is read at once, even before the 7th (review, 15/10/2026)")
_D107 = oo1_ma.merge(MA_DOC, oo1_ma.judge_pull(_MA, _dt.datetime(2026, 10, 7, 10, 0), bake.okr_score))
ex, gp = bake.oo1_ma_extra(_D107, None, None, "2026-11", "2026-11-03")
_s10 = next(v for v in ex[("OO1", "KR1")]["months"] if v["m"] == "2026-10")
check("read on 07/11/2026" in _s10["not_measured"] and gp == [],
      "...while after a good read, the next read is the 7th")
# a later read replaced September's record: a back-bake before it withholds it
_DOC2 = oo1_ma.merge(MA_DOC, oo1_ma.judge_pull(_MA, _dt.datetime(2026, 10, 9, 10, 0), bake.okr_score))
ex, gp = bake.oo1_ma_extra(_DOC2, None, None, "2026-10", "2026-10-05", dated="2026-10-05")
_s9 = next(v for v in ex[("OO1", "KR1")]["months"] if v["m"] == "2026-09")
_k5 = next(v for v in ex[("OO1", "KR5")]["months"] if v["m"] == "2026-09")
check(_s9["score"] is None and "September 2026 was last read on 09/10/2026 10:00, after this snapshot's "
      "date; only the latest read is kept, so it is withheld here" in _s9["not_measured"]
      and _k5["score"] == 100,
      "BACK-BAKE: a month whose record a later read replaced is withheld, saying why; KR5's proof "
      "from the read before the date still shows")
# KR5: a blank on the deadline day, confirmed by the next day's read
_g_tax = ma_grid({m: (100000, 18000, 2000, 30000, 14000, None if m == 9 else 8100) for m in range(1, 10)})
_D7 = oo1_ma.merge(None, oo1_ma.judge_pull(_g_tax, _dt.datetime(2026, 10, 7, 9, 0), bake.okr_score))
_D8 = oo1_ma.merge(_D7, oo1_ma.judge_pull(_g_tax, _dt.datetime(2026, 10, 8, 9, 0), bake.okr_score))
ex, gp = bake.oo1_ma_extra(_D8, None, None, "2026-10", "2026-10-09")
_k5 = next(v for v in ex[("OO1", "KR5")]["months"] if v["m"] == "2026-09")
check(_k5["score"] == 0 and "TAX still not entered for September 2026" in _k5["basis"]
      and "as on the deadline day (07/10/2026 09:00)" in _k5["basis"],
      "KR5: blank on the 7th and still blank on the 8th is a final 0, citing both reads")
ex, gp = bake.oo1_ma_extra(_D8, None, None, "2026-10", "2026-10-07", dated="2026-10-07")
_k5 = next(v for v in ex[("OO1", "KR5")]["months"] if v["m"] == "2026-09")
check(_k5["score"] is None and not _k5.get("mtd") and "the deadline day" in _k5["not_measured"]
      and "a later read today can still find it complete" in _k5["not_measured"],
      "BACK-BAKE to the 7th: only the deadline-day read is visible - grey, not judged yet, never the "
      "later 0, and never an 'MTD' month (September has closed)")
ex, gp = bake.oo1_ma_extra(_D7, None, None, "2026-10", "2026-10-09")
_k5 = next(v for v in ex[("OO1", "KR5")]["months"] if v["m"] == "2026-09")
check(_k5["score"] is None and not _k5.get("mtd")
      and "the first read after the 7th decides it" in _k5["not_measured"]
      and "the next bake reads" in _k5["not_measured"]
      and gp == ["OO1 KR5: September 2026 waits for a read after its deadline to decide it - the next bake reads"],
      "KR5: a deadline-day blank with no later read waits for one - grey, never a 0 by the calendar, "
      "with a gap while it waits")
ex, gp = bake.oo1_ma_extra(_D7, None, FAILED, "2026-10", "2026-10-15")
_k5 = next(v for v in ex[("OO1", "KR5")]["months"] if v["m"] == "2026-09")
check(_api in _k5["not_measured"] and len(gp) == 1 and gp[0].startswith("OO1 KR5: September 2026 waits")
      and _api in gp[0],
      "...and while the deciding read FAILS, the month and the gap name the failure")
# review, 15/10/2026: the deadline-day list differs from the deciding read's
_g_rt = ma_grid({m: (100000, 18000, None if m == 9 else 2000, 30000, 14000, None if m == 9 else 8100)
                 for m in range(1, 10)})
_E7 = oo1_ma.merge(None, oo1_ma.judge_pull(_g_rt, _dt.datetime(2026, 10, 7, 9, 0), bake.okr_score))
_E8 = oo1_ma.merge(_E7, oo1_ma.judge_pull(_g_tax, _dt.datetime(2026, 10, 8, 9, 0), bake.okr_score))
ex, gp = bake.oo1_ma_extra(_E8, None, None, "2026-10", "2026-10-07", dated="2026-10-07")
_k5 = next(v for v in ex[("OO1", "KR5")]["months"] if v["m"] == "2026-09")
check("Rent, TAX not entered for September 2026" in _k5["not_measured"],
      "BACK-BAKE to the 7th names the 7th's own blank lines (Rent and TAX), not the 8th's")
ex, gp = bake.oo1_ma_extra(_E8, None, None, "2026-10", "2026-10-09")
_k5 = next(v for v in ex[("OO1", "KR5")]["months"] if v["m"] == "2026-09")
check(_k5["score"] == 0 and "TAX still not entered" in _k5["basis"] and "Rent" not in _k5["basis"],
      "...and the final 0 names only the line blank in both reads")
# review, 15/10/2026: blank on the 7th, complete on the 8th - NOT JUDGED, decided for good,
# and its text names what happened (never "no read on its deadline is recorded")
_F8 = oo1_ma.merge(_D7, oo1_ma.judge_pull(_MA, _dt.datetime(2026, 10, 8, 9, 0), bake.okr_score))
_g_rent = ma_grid({m: (100000, 18000, None if m == 9 else 2000, 30000, 14000, 8100) for m in range(1, 10)})
_F9 = oo1_ma.merge(_F8, oo1_ma.judge_pull(_g_rent, _dt.datetime(2026, 10, 9, 9, 0), bake.okr_score))
for _doc_, _lab in ((_F8, "on the 9th"), (_F9, "after Rent is cleared on the 9th")):
    ex, gp = bake.oo1_ma_extra(_doc_, None, None, "2026-10", "2026-10-10")
    _k5 = next(v for v in ex[("OO1", "KR5")]["months"] if v["m"] == "2026-09")
    check(_k5["score"] is None
          and "not judged: September 2026 was not complete when read on 07/10/2026 09:00 (the deadline day)"
          in _k5["not_measured"] and "first read after its deadline, on 08/10/2026 09:00" in _k5["not_measured"]
          and "no read" not in _k5["not_measured"] and gp == [],
          f"KR5: blank on the 7th, complete on the 8th - not judged, saying so ({_lab}: never turned "
          "into a 0 by a later read)")
# a back-bake to a day KR5 was waiting shows the wait in its gaps too
_G9 = oo1_ma.merge(oo1_ma.merge(_D7, {"pulled_at": "2026-10-08T09:00+01:00", "pull_date": "2026-10-08",
                                      "ok": False, "cause": "not_shared", "tab": None}),
                   oo1_ma.judge_pull(_g_tax, _dt.datetime(2026, 10, 9, 9, 0), bake.okr_score))
ex, gp = bake.oo1_ma_extra(_G9, None, None, "2026-10", "2026-10-08", dated="2026-10-08")
_k5 = next(v for v in ex[("OO1", "KR5")]["months"] if v["m"] == "2026-09")
check(_G9["kr5"]["2026-09"]["final"] and _k5["score"] is None
      and any(g_.startswith("OO1 KR5: September 2026 waits") for g_ in gp),
      "BACK-BAKE to the 8th: the 9th's final 0 is not shown, and the wait is in the gaps as it was live")
# round 4 (16/10/2026): a back-bake names a failing run from the stored reads
_R = oo1_ma.merge(None, oo1_ma.judge_pull(_MA, _dt.datetime(2026, 11, 9, 9, 0), bake.okr_score))
for _d in range(7, 15):
    _R = oo1_ma.merge(_R, {"pulled_at": f"2026-12-{_d:02d}T09:00+00:00", "pull_date": f"2026-12-{_d:02d}",
                           "ok": False, "cause": "not_shared", "tab": None})
ex, gp = bake.oo1_ma_extra(_R, None, None, "2026-12", "2026-12-15", dated="2026-12-15")
_k1 = next(v for v in ex[("OO1", "KR1")]["months"] if v["m"] == "2026-11")
check(len(gp) == 1 and oo1_ma.CAUSE_TEXT["not_shared"] in gp[0] and "failing since 07/12/2026" in gp[0]
      and oo1_ma.CAUSE_TEXT["not_shared"] in _k1["not_measured"],
      "BACK-BAKE during a failing run: the gap and the rows name the failure from the stored reads, "
      "not 'the next bake reads'")
ex, gp = bake.oo1_ma_extra(_R, None, None, "2026-12", "2026-11-20", dated="2026-11-20")
check(gp == [], "...and a back-bake to before the failures shows none")
# months the 2026 tab can never hold
ex, gp = bake.oo1_ma_extra(_R, None, None, "2027-02", "2027-02-10")
_j1 = next(v for v in ex[("OO1", "KR1")]["months"] if v["m"] == "2027-01")
_j5 = next(v for v in ex[("OO1", "KR5")]["months"] if v["m"] == "2027-01")
check(all(x["score"] is None and "is not on the 2026 tab" in x["not_measured"] for x in (_j1, _j5)),
      "2027 months: grey, saying the 2026 tab is the only one read - never a promised read")
# a 0 from the first read of the month says so (not 'blank in every read before it')
_g_or = ma_grid({**{m: (100000, 18000, 2000, 30000, 14000, 8100) for m in range(1, 10)},
                 10: (100000, 18000, None, 30000, 14000, 8100)})
_FR = oo1_ma.merge(_D107, oo1_ma.judge_pull(_g_or, _dt.datetime(2026, 11, 9, 14, 0), bake.okr_score))
ex, gp = bake.oo1_ma_extra(_FR, None, None, "2026-11", "2026-11-10")
_o5 = next(v for v in ex[("OO1", "KR5")]["months"] if v["m"] == "2026-10")
check(_o5["score"] == 0 and "the first read of it since it ended" in _o5["basis"]
      and "every read of it before" not in _o5["basis"],
      "a KR5 0 from the month's first read says so, never 'blank in every read before it'")
_FR2 = oo1_ma.merge(oo1_ma.merge(_D107, oo1_ma.judge_pull(_g_or, _dt.datetime(2026, 11, 7, 9, 0),
                                                         bake.okr_score)),
                    oo1_ma.judge_pull(_g_or, _dt.datetime(2026, 11, 8, 9, 0), bake.okr_score))
ex, gp = bake.oo1_ma_extra(_FR2, None, None, "2026-11", "2026-11-10")
_o5 = next(v for v in ex[("OO1", "KR5")]["months"] if v["m"] == "2026-10")
check(_o5["score"] == 0 and "and blank in every read of it before" in _o5["basis"],
      "...while one with an earlier read says it was blank in every read before")
# the deadline day itself, after a failed read
_fail7 = oo1_ma.merge(oo1_ma.merge(None, oo1_ma.judge_pull(_g_tax, _dt.datetime(2026, 10, 3, 9, 0),
                                                          bake.okr_score)),
                      {"pulled_at": "2026-10-07T09:00+01:00", "pull_date": "2026-10-07",
                       "ok": False, "cause": "drive_api_disabled", "tab": None})
ex, gp = bake.oo1_ma_extra(_fail7, None, dict(FAILED, attempted_at="2026-10-07T09:00+01:00"),
                           "2026-10", "2026-10-07")
_k5 = next(v for v in ex[("OO1", "KR5")]["months"] if v["m"] == "2026-09")
check(_k5["score"] is None and "due today (07/10/2026)" in _k5["not_measured"] and _api in _k5["not_measured"]
      and len(gp) == 1,
      "KR5 on the deadline day after a failed read: grey, naming the failure; one gap")

# an entered-but-unreadable line, through the bake (review, 15/10/2026)
_g_dash = ma_grid({m: (100000, 18000, 2000, 30000, 14000, "-" if m == 9 else 8100) for m in range(1, 10)})
_U = oo1_ma.merge(None, oo1_ma.judge_pull(_g_dash, _dt.datetime(2026, 10, 9, 9, 0), bake.okr_score))
ex, gp = bake.oo1_ma_extra(_U, None, None, "2026-10", "2026-10-09")
_k4 = next(v for v in ex[("OO1", "KR4")]["months"] if v["m"] == "2026-09")
_k5 = next(v for v in ex[("OO1", "KR5")]["months"] if v["m"] == "2026-09")
_k1 = next(v for v in ex[("OO1", "KR1")]["months"] if v["m"] == "2026-09")
check(_U["months"]["2026-09"]["unreadable"] == ["TAX"] and _k4["score"] is None
      and "TAX for September 2026 cannot be read as a typed figure" in _k4["not_measured"]
      and _k5["score"] is None
      and "not judged: the first read of September 2026 after it ended was on 09/10/2026 09:00"
      in _k5["not_measured"]
      and _k1["score"] == 100 and not oo1_ma.figure_in(json.dumps([_k4, _k5], ensure_ascii=False)),
      "TAX typed '-': KR4 grey naming it, KR5 not judged, KR1 still scores - through the bake")
ex, gp = bake.oo1_ma_extra(_DOC2, None, FAILED, "2026-10", "2026-10-15")
check(gp == [], "a good read since the 7th, then a failed retry: no gap (not news)")

# 4f: the verifier's warning when this month's read has not happened
_t4f = tempfile.mkdtemp(prefix="oo1_4f_")
_orig4f = vod.OO1_MA_PATH, vod.OO1_MA_STATUS_PATH
try:
    vod.OO1_MA_PATH = os.path.join(_t4f, oo1_ma.MA_FILE)
    vod.OO1_MA_STATUS_PATH = os.path.join(_t4f, oo1_ma.MA_STATUS_FILE)

    def _4f(today, doc=None, st=None):
        for pth, obj in ((vod.OO1_MA_PATH, doc), (vod.OO1_MA_STATUS_PATH, st)):
            if obj is None:
                if os.path.exists(pth):
                    os.remove(pth)
            else:
                with open(pth, "w") as fh:
                    json.dump(obj, fh)
        vod.RESULTS.clear()
        vod.check_oo1_ma(today)
        r_ = [r for r in vod.RESULTS if r["check"] == "4f-oo1-ma"]
        return (r_[0]["level"], r_[0]["detail"]) if len(r_) == 1 else (None, repr(r_))
    lv, dt_ = _4f("2026-10-05", MA_DOC)
    check(lv == "ok" and "last read 2026-10-03" in dt_, "4f: before the 7th, the last read is fine")
    lv, dt_ = _4f("2026-10-07", MA_DOC)
    check(lv == "ok", "4f: ON the 7th it does not warn yet (a later bake that day can still read)")
    lv, dt_ = _4f("2026-10-08", MA_DOC)
    check(lv == "warning" and "not been read since 2026-10-03 - the read due 2026-10-07 has not happened" in dt_
          and "no attempt recorded" in dt_, "4f: from the 8th, no read since the 7th is a warning")
    _oct_failed = oo1_ma.merge(MA_DOC, {"pulled_at": "2026-10-07T09:00+01:00", "pull_date": "2026-10-07",
                                        "ok": False, "cause": "not_shared", "tab": None})
    for _d in ("2026-11-01", "2026-11-06", "2026-11-07"):
        lv, dt_ = _4f(_d, _oct_failed, dict(FAILED, attempted_at="2026-10-31T09:00+00:00"))
        check(lv == "warning" and "the read due 2026-10-07 has not happened" in dt_,
              f"4f on {_d}: October's read never succeeded - still a warning after the month turns "
              "(review, 15/10/2026)")
    ex, gp = bake.oo1_ma_extra(_oct_failed, None, FAILED, "2026-11", "2026-11-03")
    check(len(gp) == 1 and "the read of Finance's management account due 07/10/2026 has not happened" in gp[0],
          "...and the bake keeps its gap on 03/11 too")
    lv, dt_ = _4f("2026-10-15", MA_DOC, FAILED)
    check(lv == "warning" and _api in dt_ and "(2026-10-15 09:00 UK)" in dt_,
          "4f: ...naming the latest attempt's fixed cause and time")
    lv, dt_ = _4f("2026-10-15", MA_DOC, dict(_odd, attempted_at="soon <script>"))
    check(lv == "warning" and "cause not recorded" in dt_ and "SECRET" not in dt_ and "script" not in dt_,
          "4f: an unknown cause or a stamp that is not one is never echoed (health_latest.json is public)")
    lv, dt_ = _4f("2026-10-15", _DOC2, FAILED)
    check(lv == "ok" and "last read 2026-10-09" in dt_, "4f: read on the 9th - fine, even if a retry failed since")
    lv, dt_ = _4f("2026-10-15", None, FAILED)
    check(lv == "warning" and "has not been read yet" in dt_ and _api in dt_, "4f: never read: a warning with the cause")
    lv, dt_ = _4f("2026-10-15", _D7, FAILED)
    check(lv == "warning" and "waits for a read after its deadline" in dt_ and _api in dt_,
          "4f: a deadline-day blank waiting for a read that keeps failing is a warning")
    lv, dt_ = _4f("2026-10-15", _D7)
    check(lv == "ok", "4f: ...but waiting with no failure recorded is fine (the next bake reads)")
    lv, dt_ = _4f("2026-10-15", dict(MA_DOC, pulls=[{"ok": True, "pull_date": "NOT-A-DATE"}]))
    check(lv == "warning" and "NOT-A-DATE" not in dt_, "4f: a pull date that is not a date is not echoed")
finally:
    vod.OO1_MA_PATH, vod.OO1_MA_STATUS_PATH = _orig4f
    shutil.rmtree(_t4f)

# 4e reads the files decoded, and accepts only an OLD score-only OO1 series (review, 15/10/2026)
_t4e = tempfile.mkdtemp(prefix="oo1_4e_")
_orig4e = vod.OKR_SHEET_PATH, vod.OO1_MA_PATH
try:
    vod.OKR_SHEET_PATH = os.path.join(_t4e, "okr_sheet.json")
    vod.OO1_MA_PATH = os.path.join(_t4e, oo1_ma.MA_FILE)
    _snap4e = os.path.join(_t4e, "snap.json")

    def _4e(sheet, snapshot):
        with open(vod.OKR_SHEET_PATH, "w") as fh:
            json.dump(sheet, fh)              # ensure_ascii: '£' is written \u00a3
        with open(_snap4e, "w") as fh:
            json.dump(snapshot, fh)
        vod.RESULTS.clear()
        vod.check_oo1_public(_snap4e)
        return " ".join(r["detail"] for r in vod.RESULTS if r["level"] == "critical")
    _old = sheet_doc()
    _old["series"]["oo1"] = {"tab": "2026 Summary", "gid": 0, "pulled_at": "2026-10-05T09:00:00Z",
                             "krs": {"KR1": {"2026-09": 80}}}
    _rows = {"scorecard": {"rows": [{"objective": "OO1", "kr": "KR1", "source_kind": "ma_summary",
                                     "score": 100, "months": [{"m": "2026-09", "score": 0}]}]},
             "gaps": []}
    check(_4e(_old, _rows) == "", "4e: an old score-only OO1 series and a clean pass/fail snapshot pass")
    _bad = json.loads(json.dumps(_old))
    _bad["series"]["oo1"]["tab"] = "Wages 18.4%"
    c_ = _4e(_bad, {"note": "Money In (£)", **_rows})
    check("okr_sheet.json OO1 tab carries a figure" in c_ and "'Money In (£)'" in c_ and "18.4" not in c_,
          "4e: a figure in an old series' text, and a '£' name written escaped, are both caught")
    _r80 = json.loads(json.dumps(_rows))
    _r80["scorecard"]["rows"][0]["months"][0]["score"] = 80
    _r80["gaps"] = ["OO1: wages were 18.4% of sales"]
    c_ = _4e(_old, _r80)
    check("score is not 0/100" in c_ and "OO1 gap #1 has a figure" in c_ and "18.4" not in c_,
          "4e: an 80 on a pass/fail row and a figure in an OO1 gap are caught, never quoted")
    # a refused oo1_ma.json with more than four problems says how many (no silent cap)
    _many = {"version": 2, "months": [], "kr5": [], "pulls": {}, "a": 1, "b": 2}
    with open(vod.OO1_MA_PATH, "w") as fh:
        json.dump(_many, fh)
    c_ = _4e(_old, _rows)
    check("...and " in c_ and "more problem(s)" in c_,
          "4e: more than four problems in oo1_ma.json are counted, not silently dropped")
finally:
    vod.OKR_SHEET_PATH, vod.OO1_MA_PATH = _orig4e
    shutil.rmtree(_t4e)

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
    with open(os.path.join(out, oo1_ma.MA_FILE), "w") as fh:
        json.dump(MA_DOC, fh)
    p = real_bake(arc, out)
    check(p.returncode == 0, "the real bake runs with all three files present" + ("" if p.returncode == 0 else p.stderr[-800:]))
    sn = json.load(open(os.path.join(out, "snapshot_2026-10-05.json")))
    sc = sn["scorecard"]
    rows = {(r["objective"], r["kr"]): r for r in sc["rows"]}
    oo1 = [rows[("OO1", k)] for k in OO1_KRS]
    check(all(r["source_kind"] == "ma_summary" and r["value"] is None and r["display"] is None
              and all(v["value"] is None and v["display"] is None for v in r["months"]) for r in oo1),
          "BAKED: OO1 rows are from Finance's management account with no value or display, row or month")
    sep1 = {r["kr"]: next(v for v in r["months"] if v["m"] == "2026-09") for r in oo1}
    check([sep1[k]["score"] for k in OO1_KRS] == [100, 100, 0, 100, 100]
          and sep1["KR3"]["rag"] == "red" and "variable costs were more than 13% of sales" in sep1["KR3"]["basis"]
          and "complete by the 7th" in sep1["KR5"]["basis"],
          "BAKED: September pass/fail - wages, food, net profit met; variable missed; complete by the 7th")
    check(all(r["band"] and r["band_status"] == "agreed" for r in oo1),
          "BAKED: each OO1 row carries its agreed pass/fail band")
    ob = {o["objective"]: o for o in sc["objectives"]}
    sep = next(x for x in ob["OO1"]["months"] if x["m"] == "2026-09")
    check(sep["pct"] is None and sep["scored"] == 5 and ob["OO1"]["pct"] is None and ob["OO1"].get("pct_note"),
          "BAKED: OO1 shows '5 scored' for September and NO objective percentage")
    _oo1_text = json.dumps(oo1)
    check(not re.search(r"(?<![\d(-])(18|30|14|27\.9)(\.0+)?%", _oo1_text) and "£" not in _oo1_text
          and "27.9" not in _oo1_text,
          "BAKED: no Finance figure (18%, 30%, 14%, 27.9%, £) anywhere on the OO1 rows - only the targets")
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
    check("FINANCE FIGURES" in crit and "KR4" in crit and "6.25" not in crit and "a score outside its set" in crit,
          "the verifier flags an OO1 figure and a non-score, naming the KR and NOT the figure")
    # ...and a figure slipped into an OO1 BASIS
    bad2 = json.loads(json.dumps(sn))
    for r in bad2["scorecard"]["rows"]:
        if r["objective"] == "OO1" and r["kr"] == "KR1":
            r["months"][-2]["basis"] = "wages were 18.4% of sales"
    vod.RESULTS.clear()
    vod.check_okr_scorecard(bad2, "2026-10-05")
    crit = " ".join(r["detail"] for r in vod.RESULTS if r["level"] == "critical")
    check("FINANCE FIGURES" in crit and "a figure in its basis" in crit and "18.4" not in crit,
          "the verifier flags a Finance percentage in an OO1 basis - and does not repeat it")
    with open(os.path.join(tmp, "bad_snap.json"), "w") as fh:
        json.dump(bad, fh)
    vod.RESULTS.clear()
    _orig = vod.OKR_SHEET_PATH, vod.OO1_MA_PATH
    vod.OKR_SHEET_PATH = os.path.join(out, "okr_sheet.json")
    vod.OO1_MA_PATH = os.path.join(out, oo1_ma.MA_FILE)
    try:
        vod.check_oo1_public(os.path.join(tmp, "bad_snap.json"))
        c1 = [r for r in vod.RESULTS if r["level"] == "critical"]
        vod.RESULTS.clear()
        vod.check_oo1_public(os.path.join(out, "snapshot_2026-10-05.json"))
        c2 = [r for r in vod.RESULTS if r["level"] == "critical"]
        # a figure in oo1_ma.json itself
        leak = json.loads(json.dumps(MA_DOC))
        leak["months"]["2026-09"]["wages_pct"] = 0.184
        with open(os.path.join(tmp, "leak_ma.json"), "w") as fh:
            json.dump(leak, fh)
        vod.OO1_MA_PATH = os.path.join(tmp, "leak_ma.json")
        vod.RESULTS.clear()
        vod.check_oo1_public(os.path.join(out, "snapshot_2026-10-05.json"))
        c3 = [r for r in vod.RESULTS if r["level"] == "critical"]
    finally:
        vod.OKR_SHEET_PATH, vod.OO1_MA_PATH = _orig
    check(len(c1) == 1 and "6.25" not in c1[0]["detail"] and not c2,
          "4e sweeps the COMMITTED snapshot and the OO1 files: flags the leak, passes the clean one")
    check(len(c3) == 1 and "oo1_ma.json" in c3[0]["detail"] and "0.184" not in c3[0]["detail"],
          "4e flags a figure in oo1_ma.json by its field, never its value")

    # a dated back-bake withholds both copies (read on 10-05 09:00 > 10-04)
    p = real_bake(arc, out, date="2026-10-04")
    sn = json.load(open(os.path.join(out, "snapshot_2026-10-04.json")))
    rows = {(r["objective"], r["kr"]): r for r in sn["scorecard"]["rows"]}
    check(p.returncode == 0 and "after this snapshot's date (2026-10-04)" in (rows[("OO2", "KR3")]["not_measured"] or "")
          and rows[("OO2", "KR5")]["value"] is None,
          "BAKED --date: the sheet rows and KR5 are withheld, not time-travelled")

    o1b = {r["kr"]: r for r in sn["scorecard"]["rows"] if r["objective"] == "OO1"}
    check(o1b["KR1"]["months"] and next(v for v in o1b["KR1"]["months"] if v["m"] == "2026-09")["score"] == 100,
          "BAKED --date 04/10: OO1 read on 03/10 is shown (read before the snapshot's date)")
    # a back-bake dated before the read withholds it (no time travel)
    write_archive(arc, "2026-10-02")
    p = real_bake(arc, out, date="2026-10-02")
    sn = json.load(open(os.path.join(out, "snapshot_2026-10-02.json")))
    o1b = {r["kr"]: r for r in sn["scorecard"]["rows"] if r["objective"] == "OO1"}
    check(p.returncode == 0 and all(o1b[k]["months"] is None and o1b[k]["score"] is None
                                    and "has not been read yet" in (o1b[k]["not_measured"] or "")
                                    for k in OO1_KRS),
          "BAKED --date 02/10: OO1 read on 03/10 is withheld - grey, not read yet as of that date, no months")

    # the bake refuses to run when okr_sheet.json carries an OO1 series at all
    d = sheet_doc()
    d["series"]["oo1"] = {"tab": "2026 Summary", "pulled_at": "2026-10-05T09:00:00Z",
                          "krs": {"KR1": {"2026-03": 12.5}}}
    with open(os.path.join(out, "okr_sheet.json"), "w") as fh:
        json.dump(d, fh)
    before = sorted(os.listdir(out))
    p = real_bake(arc, out)
    check(p.returncode == 1 and "REFUSING TO BAKE" in p.stderr and "12.5" not in p.stderr + p.stdout,
          "the bake REFUSES (exit 1, so nothing is pushed) when okr_sheet.json carries an OO1 series")
    check(sorted(os.listdir(out)) == before, "...and writes nothing")
    # ...and when oo1_ma.json is not exactly the score-only shape
    with open(os.path.join(out, "okr_sheet.json"), "w") as fh:
        json.dump(sheet_doc(), fh)
    leak = json.loads(json.dumps(MA_DOC))
    leak["months"]["2026-09"]["KR1"]["pct"] = 18.4
    with open(os.path.join(out, oo1_ma.MA_FILE), "w") as fh:
        json.dump(leak, fh)
    before = sorted(os.listdir(out))
    p = real_bake(arc, out)
    check(p.returncode == 1 and "REFUSING TO BAKE" in p.stderr and "oo1_ma.json" in p.stderr
          and "18.4" not in p.stderr + p.stdout,
          "the bake REFUSES when oo1_ma.json carries a figure - naming the file, never the figure")
    check(sorted(os.listdir(out)) == before, "...and writes nothing")
finally:
    shutil.rmtree(tmp)

print(f"\n{'FAILED' if failures else 'passed'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
