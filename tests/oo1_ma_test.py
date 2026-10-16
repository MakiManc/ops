#!/usr/bin/env python3
"""OO1 from Finance's management-account summary (Ross, 15/10/2026).

WHY THIS TEST EXISTS
  Ross, 15/10/2026: "use this sheet to fill OO1 pull on the 3rd of every
  month", then: the sheet is Finance's 'AA MA Summary.xlsx' (2026 tab), each
  KR is pass/fail on its own target, KR5 "Just pull on the 7th", and it
  replaces the Operations Input sheet as OO1's source.

  MakiManc/ops is PUBLIC and every figure in that workbook is Finance's, so
  the one failure that matters most here is not a wrong score - it is a
  figure reaching the public file. Part 4 serialises everything this module
  writes and fails on any number in it that is not a score or a date.

  The other traps each give a plausible wrong score, not an error:
    * a blank line read as 0 (TAX not entered yet -> net profit too high);
    * a formula row (Money In, the % rows) deciding that a month is entered;
    * notes to the right of the month columns read as a month;
    * a month still running scored;
    * 20.00% exactly scored as missed (the KR is "20%", i.e. at most 20%);
    * the workbook disagreeing with itself and a score picked from one side;
    * KR5 scored 100 from a pull after the 7th, or 0 from a pull on the 7th
      that a later pull the same day contradicts.

THE WORKBOOK HERE IS SYNTHETIC: every number, label beyond the row names this
module reads, and tab beyond the year's is invented. It exercises the shapes
the reader must survive: a 'Total' column, notes to the right of the months,
'#DIV/0!' and 0 in the formula rows of months not entered, a trailing space in
the tab title, another year's tab laid out differently.

Run: python3 tests/oo1_ma_test.py   (needs openpyxl)
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "builders"))
import oo1_ma as ma  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "bake", os.path.join(HERE, "..", "builders", "bake_ops_command.py"))
bake = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bake)

fails = 0


def check(cond, msg):
    global fails
    if cond:
        print("ok  :", msg)
    else:
        fails += 1
        print("FAIL:", msg)


MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct",
          "Nov", "Dec"]
#: invented: month -> (sales, wages, rent, food, variable, tax); None = blank
INVENTED = {
    1: (100000, 18000, 2000, 30000, 14000, 8100),    # W 18 F 30 V 14 NP 27.9
    2: (80000, 16000, 2000, 28000, 10400, 4400),     # W 20.00 exactly, V 13.00
    3: (90000, 18009, 2000, 31500, 9000, 7650),      # W 20.01 -> missed; F 35.00
    4: (50000, 15000, 3000, 20000, 9000, 3250),      # NP -0.5% -> missed
    5: (60000, 9000, 2000, 18000, 6000, None),       # TAX not entered
    6: (70000, 12600, 2000, 21000, 7000, 5950),      # NP 30.6%
}


def build_xlsx(invented=INVENTED, title="2026 ", mangle=None):
    """A synthetic workbook in the shape this reader expects; formula rows carry 'cached' values."""
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = title
    ws.append(["2026 "] + [None] * 12 + ["Total"])
    ws.append(["Month"] + MONTHS + ["2026"])
    rows = {k: [] for k in ("sales", "money_in", "wages", "wages_pct", "rent",
                            "rent_pct", "food", "food_pct", "variable",
                            "variable_pct", "tax", "tax_pct", "money_out", "np",
                            "np_pct")}
    for m in range(1, 13):
        v = invented.get(m)
        if v is None:
            for k in rows:
                rows[k].append(0 if k in ("money_in", "money_out", "np")
                               else "#DIV/0!" if k.endswith("_pct") else None)
            continue
        s, w, r, f, va, t = v
        out = sum(x or 0 for x in (w, r, f, va, t))
        vals = {"sales": s, "money_in": s, "wages": w, "rent": r, "food": f,
                "variable": va, "tax": t, "money_out": out, "np": s - out}
        for k in rows:
            if k.endswith("_pct"):
                base = vals[k[:-4]]
                rows[k].append((base or 0) / s)
            else:
                rows[k].append(vals[k])
    labels = [("Restaurant Sales", "sales"), ("Money In (£)", "money_in"),
              ("Wages", "wages"), ("Wages %", "wages_pct"), ("Rent", "rent"),
              ("Rent %", "rent_pct"), ("Food costs", "food"),
              ("Food costs %", "food_pct"), ("Variable costs", "variable"),
              ("Variable costs %", "variable_pct"), ("TAX", "tax"),
              ("Tax %", "tax_pct"), ("Money Out (£)", "money_out"),
              ("Net Profit (£)", "np"), ("Net Profit (%)", "np_pct")]
    for i, (lab, k) in enumerate(labels):
        row = [lab] + rows[k] + [None]
        if k == "rent":            # invented notes right of the months
            row += [None, 123456, None]
        if k == "rent_pct":
            row += [None, 654321, 12.34, "note"]
        ws.append(row)
    ws.append(["Balance (£)"] + [1] * 12)
    if mangle:
        mangle(ws)
    old = wb.create_sheet("2024 X")   # another year, laid out differently - must not be read
    old.append(["2024 X"] + [None] * 12 + ["Total", "Jan"])
    old.append(["Restaurant Sales"] + [999] * 14)
    wb.create_sheet("Other ")
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


SCORE = bake.okr_score
UK = dt.timezone(dt.timedelta(hours=1))


def at(y, m, d, h=12, mi=0):
    return dt.datetime(y, m, d, h, mi)


# ---- 0. the bands are Ross's pass/fail targets, in OKR_BANDS ---------------
for band, (direction, target) in {"oo1_wr": ("le", 20), "oo1_fr": ("le", 35),
                                  "oo1_vr": ("le", 13), "oo1_np": ("ge", 4),
                                  "oo1_ma": ("ge", 1)}.items():
    check(bake.OKR_BANDS.get(band) == (direction, [(target, 100)])
          and bake.OKR_BAND_STATUS.get(band) == "agreed",
          f"OKR_BANDS[{band}] is pass/fail at {target} ({direction}), agreed")
check(SCORE("oo1_wr", 20.0) == 100 and SCORE("oo1_wr", 20.000001) == 0
      and SCORE("oo1_np", 4.0) == 100 and SCORE("oo1_np", 3.99) == 0
      and SCORE("oo1_np", 25.0) == 100,
      "pass/fail: at the target passes, past it fails; NP above 10% still passes")

# ---- 1. finding the tab, the header and the rows ----------------------------
data = build_xlsx()
g = ma.grid_from_xlsx(data)
title, rows = g.get("title"), g.get("rows")
check(title == "2026 " and isinstance(g["formula_cells"], set),
      f"the 2026 tab is found by its title, trailing space and all, and only it is read (got {title!r})")
check(ma.grid_from_xlsx(build_xlsx(title="Summary")).get("title") == "Summary",
      "...or by its A1 when the title is something else")
s2 = {"Summary": rows, "2024 X": [["2024 X"]]}
check(ma.find_tab(s2)[0] == "Summary", "find_tab (for grids): by A1 too")
check(ma.find_tab({"2024": [["2024"]]}) == (None, "tab_missing"), "no 2026 tab: tab_missing")
check(ma.find_tab({"2026": [], " 2026": []}) == (None, "tab_ambiguous"), "two 2026 tabs: tab_ambiguous")
months, cause = ma.read_months(rows)
check(cause is None and sorted(months) == [f"2026-{m:02d}" for m in range(1, 13)],
      "twelve months read off the Jan..Dec header")
check(months["2026-01"]["sales"] == 100000 and months["2026-01"]["tax"] == 8100
      and months["2026-12"]["sales"] is None and months["2026-12"]["money_in"] == 0,
      "a blank input reads None (not entered); a formula row of a blank month reads 0")
check(months["2026-12"]["wages_pct"] is None, "'#DIV/0!' reads None, never a number")
# invented notes sit right of 'Total': no month column reaches them
check(all(v["rent"] != 123456 for v in months.values()), "notes right of the months are never read as a month")
for name, mangle, want in (
        ("a required row renamed", lambda ws: ws.cell(row=5, column=1, value="Wage bill"), "rows_missing"),
        ("a row duplicated", lambda ws: ws.append(["TAX", 1, 2, 3]), "rows_duplicated"),
        ("the header row broken", lambda ws: ws.cell(row=2, column=5, value="April"), None)):
    r_ = ma.grid_from_xlsx(build_xlsx(mangle=mangle))["rows"]
    got = ma.read_months(r_)[1]
    if want:
        check(got == want, f"{name}: {want}, nothing read (got {got})")
    else:
        # 'April' still starts 'apr' - a header in full words is still a header
        check(got is None, f"{name} to 'April': still the header (got {got})")
r_ = ma.grid_from_xlsx(build_xlsx(mangle=lambda ws: ws.cell(row=2, column=5, value="Q2")))["rows"]
check(ma.read_months(r_)[1] == "header_missing", "a header without Jan..Dec in a row: header_missing")


def date_header(ws):
    for j in range(12):
        ws.cell(row=2, column=2 + j, value=dt.datetime(2026, j + 1, 1))
r_ = ma.grid_from_xlsx(build_xlsx(mangle=date_header))["rows"]
mh, ch = ma.read_months(r_)
check(ch is None and mh["2026-01"]["sales"] == 100000, "a header typed as dates (formatted 'mmm') is still the header")


def formula_inputs(ws):
    # December's input lines as FORMULAS that cache 0 - a month nobody entered
    for rr in range(3, ws.max_row + 1):
        if ws.cell(row=rr, column=1).value in ("Restaurant Sales", "Wages", "Rent", "Food costs",
                                               "Variable costs", "TAX"):
            ws.cell(row=rr, column=13, value="=SUM(Other!B2:B40)")
def cached_zero(data):
    """The workbook as Excel or Google saves it: every formula carries a cached
    value - here 0. openpyxl itself writes none (<v></v>), which reads None, so
    without this the formula-cell detection would go untested (review,
    15/10/2026)."""
    import zipfile
    src, out = zipfile.ZipFile(io.BytesIO(data)), io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for it in src.infolist():
            b = src.read(it.filename)
            if it.filename.startswith("xl/worksheets/sheet"):
                b = re.sub(rb"(<f>[^<]*</f>)<v\s*/?>(</v>)?", rb"\1<v>0</v>", b)
            dst.writestr(it, b)
    return out.getvalue()


_fx = cached_zero(build_xlsx(mangle=formula_inputs))
check(b"<v>0</v>" in __import__("zipfile").ZipFile(io.BytesIO(_fx)).read("xl/worksheets/sheet1.xml"),
      "(the test workbook carries cached 0s on its formulas, as Excel saves them)")
gf = ma.grid_from_xlsx(_fx)
mf, _ = ma.read_months(gf["rows"], gf["formula_cells"])
_jf = ma.judge_month(mf["2026-12"], SCORE)
check(mf["2026-12"]["sales"] == ma.UNREADABLE and mf["2026-12"]["tax"] == ma.UNREADABLE
      and _jf["complete"] is False and _jf["missing"] == [] and len(_jf["unreadable"]) == 6
      and _jf["KR1"] == {"unreadable": ["Restaurant Sales", "Wages"]},
      "an input line that is a FORMULA showing 0 is unknown - neither a typed 0 (no false "
      "complete) nor a typed blank - December is not complete and no KR scores")
check(ma.kr5_from_pull("2026-12", _jf, at(2027, 1, 6)) is None
      and ma.kr5_from_pull("2026-12", _jf, at(2027, 1, 9)) is None,
      "...and it proves NO KR5 verdict, before or after the deadline (a real 0 looks the same)")
check(mf["2026-01"]["sales"] == 100000, "...while a typed figure in the same row still reads")
gn = ma.grid_from_xlsx(build_xlsx(mangle=formula_inputs))   # never calculated: <v></v>
mn, _ = ma.read_months(gn["rows"], gn["formula_cells"])
check(mn["2026-12"]["sales"] == ma.UNREADABLE,
      "...and so is a formula never calculated (no cached value at all)")
check(ma.num("1,307") == 1307 and ma.num("(1,461)") == -1461 and ma.num("£12") == 12
      and ma.num(True) is None and ma.num("n/a") is None and ma.num(float("nan")) is None,
      "num(): typed numbers with commas/£/brackets; bool, text and NaN are not numbers")

# ---- 2. each month's verdicts ----------------------------------------------
j = {ym: ma.judge_month(v, SCORE) for ym, v in months.items()}
def sc(ym, kr):
    return j[ym][kr].get("score")
check([sc("2026-01", k) for k in ("KR1", "KR2", "KR3", "KR4")] == [100, 100, 0, 100],
      "Jan: wages 18% met, food 30% met, variable 14% missed, NP 27.9% met")
check(sc("2026-02", "KR1") == 100 and sc("2026-02", "KR3") == 100,
      "Feb: wages at exactly 20.00% and variable at exactly 13.00% are MET")
check(sc("2026-03", "KR1") == 0 and sc("2026-03", "KR2") == 100,
      "Mar: wages 20.01% missed; food at exactly 35.00% met")
check(sc("2026-04", "KR4") == 0, "Apr: a net LOSS misses KR4")
check(j["2026-05"]["KR4"] == {"not_entered": ["TAX"]}
      and [sc("2026-05", k) for k in ("KR1", "KR2", "KR3")] == [100, 100, 100]
      and j["2026-05"]["complete"] is False and j["2026-05"]["missing"] == ["TAX"],
      "May, TAX blank: KR4 grey naming TAX, never computed as if tax were 0; KR1-3 scored; incomplete")
check(all(j["2026-12"][k].get("score") is None for k in ("KR1", "KR2", "KR3", "KR4"))
      and j["2026-12"]["KR1"] == {"not_entered": ["Restaurant Sales", "Wages"]} and j["2026-12"]["complete"] is False,
      "Dec, nothing entered: every KR grey naming the line, never 0")
check(j["2026-01"]["complete"] is True and j["2026-01"]["missing"] == [], "Jan is complete")
# the workbook disagreeing with itself
bad = dict(months["2026-01"], wages_pct=0.25)
check(ma.judge_month(bad, SCORE)["KR1"].get("score") is None
      and "does not match" in ma.judge_month(bad, SCORE)["KR1"]["not_measured"]
      and ma.judge_month(bad, SCORE)["KR1"]["not_measured"] in ma.FIXED_REASONS,
      "Finance's own % row disagreeing with its £ lines: grey, not a pick of one side")
bad = dict(months["2026-01"], np=1.0)
check(ma.judge_month(bad, SCORE)["KR4"].get("score") is None,
      "Net Profit (£) not equal to Money In less the cost lines: KR4 grey")
bad = dict(months["2026-01"], money_in=0)
check(all(ma.judge_month(bad, SCORE)[k].get("score") is None for k in ("KR1", "KR2", "KR3", "KR4")),
      "Money In 0 with sales typed: no share of sales, every KR grey")
bad = dict(months["2026-01"], wages_pct=None)
check(ma.judge_month(bad, SCORE)["KR1"] == {"score": 100, "met": True, "checked": False},
      "Finance's % cell unreadable: scored on the £ lines, and marked unchecked")

# ---- 3. a pull: only months that have ENDED ---------------------------------
p = ma.judge_pull(data, at(2026, 6, 7, 9), SCORE)
check(p["ok"] and sorted(p["months"]) == ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"],
      "a pull on 07/06 judges Jan-May only - June is still running")
check(ma.judge_pull(b"not a workbook", at(2026, 6, 7), SCORE)["cause"] == "unreadable",
      "bytes that are not an .xlsx: cause unreadable")
check(ma.judge_pull({"x": [[1]]}, at(2026, 6, 7), SCORE)["cause"] == "tab_missing",
      "a workbook with no 2026 tab: cause tab_missing")

# ---- 4. THE PUBLICATION RULE: no figure in anything written -----------------
doc = ma.merge(None, ma.judge_pull(data, at(2026, 7, 7, 18), SCORE))
text = json.dumps(doc)
figures = set()
for v in INVENTED.values():
    s = v[0]
    for x in v:
        if x is not None:
            figures.add(str(x))
            figures.add(f"{100.0 * x / s:g}")
    out = sum(x or 0 for x in v[1:])
    figures.update({str(out), str(s - out), f"{100.0 * (s - out) / s:g}"})
# what may carry digits and is not a figure: timestamps, the KR keys, the tab
# name and the version - stripped, then every remaining number must be a score
scan = re.sub(r"\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}([+-]\d{2}:\d{2})?)?", "", text)
scan = re.sub(r'"KR[1-5]"|"kr5"|"tab": "2026"|"version": 1', "", scan)
nums = set(re.findall(r"(?<![\d-])-?\d+(?:\.\d+)?(?![\d-])", scan))
leaked = sorted(n for n in nums if n in figures and n not in ("100", "0"))
check(not leaked, f"no Finance figure in the written document (leaked: {leaked})")
check(nums <= {"100", "0"}, f"the only numbers written are scores (got {sorted(nums)})")
check(ma.doc_problems(doc) == [], f"merge() writes exactly the score-only shape (got {ma.doc_problems(doc)[:2]})")
# the validator refuses anything that could carry a figure - by path, never by value
for name, mut in (
        ("a figure in a new field", lambda d: d["months"]["2026-01"].__setitem__("wages_pct", 0.18)),
        ("a score that is not 0/100", lambda d: d["months"]["2026-01"]["KR1"].__setitem__("score", 80)),
        ("met disagreeing with its score", lambda d: d["months"]["2026-01"]["KR1"].__setitem__("met", False)),
        ("a free-text reason", lambda d: d["months"]["2026-05"].__setitem__("KR4", {"not_measured": "net profit was 29.0%"})),
        ("an unknown line name", lambda d: d["months"]["2026-05"].__setitem__("missing", ["NP 29%"])),
        ("a top-level extra", lambda d: d.__setitem__("figures", {})),
        ("a pull with a figure for a tab", lambda d: d["pulls"][0].__setitem__("tab", "29.0%")),
        ("a bool where a score belongs", lambda d: d["months"]["2026-01"]["KR1"].__setitem__("score", True))):
    d2 = json.loads(json.dumps(doc))
    mut(d2)
    pr = ma.doc_problems(d2)
    check(pr and not any(x in " ".join(pr) for x in ("0.18", "29", "80")),
          f"doc_problems refuses {name}, naming the field, not the value (got {pr[:1]})")

# ---- 5. KR5: the 7th ---------------------------------------------------------
check(ma.deadline("2026-10") == dt.date(2026, 11, 7) and ma.deadline("2026-12") == dt.date(2027, 1, 7),
      "KR5's deadline is the 7th of the month after (December's is 07/01)")
k = ma.kr5_from_pull
C, I = {"complete": True, "missing": []}, {"complete": False, "missing": ["TAX"]}
check(k("2026-10", C, at(2026, 11, 7, 18))["score"] == 100, "complete on the 7th: 100")
check(k("2026-10", C, at(2026, 11, 3))["score"] == 100, "complete on the 3rd (a forced pull): 100 - before the deadline")
v = k("2026-10", I, at(2026, 11, 7, 9))
check(v["score"] == 0 and v["final"] is False and v["missing"] == ["TAX"],
      "incomplete at 09:00 on the 7th: 0 so far, not final, naming the line")
check(k("2026-10", I, at(2026, 11, 8))["final"] is True, "incomplete on the 8th: a final 0")
check(k("2026-10", C, at(2026, 11, 8)) is None, "complete, but first seen on the 8th: proves nothing about the 7th")

full = {m: INVENTED[1] for m in range(1, 11)}
no_oct = {m: INVENTED[1] for m in range(1, 10)}
d0 = ma.merge(None, ma.judge_pull(build_xlsx(no_oct), at(2026, 11, 7, 9), SCORE))
check(d0["kr5"]["2026-10"]["score"] == 0 and not d0["kr5"]["2026-10"]["final"],
      "merge: October incomplete at 09:00 on 07/11 - a provisional 0")
check(all(d0["kr5"].get(f"2026-{m:02d}") == {"not_judged": "after", "judged_at": d0["pulls"][0]["pulled_at"]}
          for m in range(1, 10)),
      "merge: Jan-Sep complete but first pulled on 07/11 - decided as NOT JUDGED (first read after "
      "the deadline), never a 100")
d1 = ma.merge(d0, ma.judge_pull(build_xlsx(full), at(2026, 11, 7, 18), SCORE))
check(d1["kr5"]["2026-10"]["score"] == 100 and d1["kr5"]["2026-10"]["final"],
      "merge: complete at 18:00 the same day - 100, final")
d2 = ma.merge(d1, ma.judge_pull(build_xlsx(no_oct), at(2026, 11, 9), SCORE))
check(d2["kr5"]["2026-10"]["score"] == 100, "merge: a line blanked later does not undo a proven 100")
check(d2["months"]["2026-10"]["complete"] is False and d2["months"]["2026-10"]["KR1"].get("score") is None,
      "...but KR1-4 follow the newest workbook (October no longer entered)")
check(len(d2["pulls"]) == 3 and [x["pull_date"] for x in d2["pulls"]] == ["2026-11-07", "2026-11-07", "2026-11-09"],
      "every pull is listed, none dropped")
# review, 15/10/2026: a provisional 0 is NOT made final by the calendar - the
# account may have been finished later on the 7th - only a read after the 7th
# decides it, and due() asks for that read
check(ma.kr5_now(d0["kr5"]["2026-10"], "2026-10", dt.date(2026, 11, 8))["final"] is False
      and ma.kr5_awaiting(d0["kr5"]["2026-10"], "2026-10", dt.date(2026, 11, 8))
      and not ma.kr5_awaiting(d0["kr5"]["2026-10"], "2026-10", dt.date(2026, 11, 7)),
      "a provisional 0 stays provisional after the 7th, awaiting the read that decides it")
check(ma.due(d0, at(2026, 11, 8)) and not ma.due(d0, at(2026, 11, 3)) and not ma.due(d1, at(2026, 11, 8)),
      "due() on the 8th while a provisional 0 waits (not once it is decided)")
dA = ma.merge(d0, ma.judge_pull(build_xlsx(full), at(2026, 11, 8, 10), SCORE))
check(dA["kr5"]["2026-10"].get("not_judged") == "late"
      and dA["kr5"]["2026-10"]["last_before"].startswith("2026-11-07T09:00")
      and dA["kr5"]["2026-10"]["provisional_at"] == dA["kr5"]["2026-10"]["last_before"]
      and ma.doc_problems(dA) == [] and not ma.due(dA, at(2026, 11, 9)),
      "the read after the 7th finds October complete: the provisional 0 proves nothing - decided as "
      "NOT JUDGED for good (Finance may have finished on the 7th itself), never a false 0")
# review, 15/10/2026: decided means decided - a later read cannot turn it into a 0
dA2 = ma.merge(dA, ma.judge_pull(build_xlsx(no_oct), at(2026, 11, 9), SCORE))
dA3 = ma.merge(dA2, ma.judge_pull(build_xlsx(no_oct), at(2026, 12, 7), SCORE))
check(dA3["kr5"]["2026-10"] == dA["kr5"]["2026-10"],
      "...and October blanked again on 09/11, read again on 07/12: still not judged, never a 0")
dB = ma.merge(d0, ma.judge_pull(build_xlsx(no_oct), at(2026, 11, 8, 10), SCORE))
check(dB["kr5"]["2026-10"]["score"] == 0 and dB["kr5"]["2026-10"]["final"]
      and dB["kr5"]["2026-10"]["provisional_at"].startswith("2026-11-07T09:00")
      and dB["kr5"]["2026-10"]["provisional_missing"] == dB["kr5"]["2026-10"]["missing"]
      and not ma.due(dB, at(2026, 11, 9)) and ma.doc_problems(dB) == [],
      "...still incomplete on the 8th: a final 0, keeping the deadline-day read and its list; no longer due")
# review, 15/10/2026: only a line blank in BOTH reads proves the 0
_s, _w, _r, _f, _va, _t = INVENTED[1]
no_rent = {**no_oct, 10: (_s, _w, None, _f, _va, _t)}
no_tax = {**no_oct, 10: (_s, _w, _r, _f, _va, None)}
no_both = {**no_oct, 10: (_s, _w, None, _f, _va, None)}
dR = ma.merge(None, ma.judge_pull(build_xlsx(no_rent), at(2026, 11, 7, 9), SCORE))
dRT = ma.merge(dR, ma.judge_pull(build_xlsx(no_tax), at(2026, 11, 8, 9), SCORE))
_dRT9 = ma.merge(dRT, ma.judge_pull(build_xlsx(no_tax), at(2026, 11, 9, 9), SCORE))
check(dR["kr5"]["2026-10"]["missing"] == ["Rent"] and dRT["kr5"]["2026-10"].get("not_judged") == "late"
      and _dRT9["kr5"]["2026-10"] == dRT["kr5"]["2026-10"],
      "Rent blank on the 7th, Rent typed and TAX cleared by the 8th: NOT a 0 - no line was blank in "
      "both reads, so TAX was cleared since and nothing is proven")
dB2 = ma.merge(ma.merge(None, ma.judge_pull(build_xlsx(no_both), at(2026, 11, 7, 9), SCORE)),
               ma.judge_pull(build_xlsx(no_tax), at(2026, 11, 8, 9), SCORE))
_v = dB2["kr5"]["2026-10"]
check(_v["score"] == 0 and _v["final"] and _v["missing"] == ["TAX"]
      and _v["provisional_missing"] == ["Rent", "TAX"] and ma.doc_problems(dB2) == [],
      "Rent and TAX blank on the 7th, TAX still blank on the 8th: a final 0 naming TAX only; the "
      "deadline-day list is kept for a back-bake")
dS = ma.merge(None, ma.judge_pull(build_xlsx(no_both), at(2026, 11, 7, 9), SCORE))
dS = ma.merge(dS, ma.judge_pull(build_xlsx(no_tax), at(2026, 11, 7, 18), SCORE))
dS = ma.merge(dS, ma.judge_pull(build_xlsx(no_tax), at(2026, 11, 8, 9), SCORE))
check(dS["kr5"]["2026-10"]["provisional_at"].startswith("2026-11-07T18:00")
      and dS["kr5"]["2026-10"]["provisional_missing"] == ["TAX"],
      "two deadline-day reads: the LAST one stands for the 7th (nearest the end of the day)")
for _lab, _mut in (("provisional_missing without provisional_at",
                    lambda v: v.pop("provisional_at")),
                   ("a final line not blank on the deadline day",
                    lambda v: v.__setitem__("provisional_missing", ["Rent"])),
                   ("a provisional stamp after the deciding read",
                    lambda v: v.__setitem__("provisional_at", "2026-11-09T09:00"))):
    _d = json.loads(json.dumps(dB2))
    _mut(_d["kr5"]["2026-10"])
    check(ma.doc_problems(_d) != [], f"doc_problems refuses {_lab}")
# a month once seen complete cannot later be 'proven' incomplete
jun = {m: INVENTED[1] for m in range(1, 10)}
dC = ma.merge(None, ma.judge_pull(build_xlsx(jun), at(2026, 10, 16), SCORE))
jun_cleared = dict(jun)
jun_cleared[6] = INVENTED[1][:2] + (None,) + INVENTED[1][3:]
dC = ma.merge(dC, ma.judge_pull(build_xlsx(jun_cleared), at(2026, 11, 7), SCORE))
check(dC["kr5"]["2026-06"].get("not_judged") == "after" and dC["months"]["2026-06"]["seen_complete"] is True
      and dC["months"]["2026-06"]["complete"] is False,
      "June seen complete on 16/10 and its Rent cleared by 07/11: no 'proven' 0 - a line was un-typed")
dfail = ma.merge(d0, {"pulled_at": "2026-11-07T20:00", "pull_date": "2026-11-07", "ok": False,
                      "cause": "unreadable", "tab": None})
check(dfail["kr5"] == d0["kr5"] and dfail["months"] == d0["months"] and dfail["pulls"][-1]["cause"] == "unreadable",
      "a failed pull is listed and changes nothing else")

# ---- 5b. the KR5 rule against an independent oracle (review, 15/10/2026) ------
import random  # noqa: E402
_NAMES = [n for _k, n in ma.INPUTS]


def _oracle(reads):
    """reads: [(datetime, {name: 'num'|'blank'|'unread'})] in time order, all
    after October ended. -> the verdict the agreed rule gives, as a tuple."""
    d = dt.date(2026, 11, 7)
    if any(r[0].date() <= d and all(v == "num" for v in r[1].values()) for r in reads):
        return ("100",)
    after = [i for i, r in enumerate(reads) if r[0].date() > d]
    if after:
        i = after[0]
        blank = [n for n in _NAMES if all(reads[j][1][n] == "blank" for j in range(i + 1))]
        if blank:
            return ("0", tuple(blank))
        return ("not_judged", "late" if i > 0 else "after")
    on_d = [r for r in reads if r[0].date() == d]
    if on_d and any(v == "blank" for v in on_d[-1][1].values()):
        return ("provisional", tuple(n for n in _NAMES if on_d[-1][1][n] == "blank"))
    return (None,)


def _verdict(v):
    if not v:
        return (None,)
    if "not_judged" in v:
        return ("not_judged", v["not_judged"])
    if v["score"] == 100:
        return ("100",)
    return ("0", tuple(v["missing"])) if v["final"] else ("provisional", tuple(v["missing"]))


_rng, _bad, _decided_moved = random.Random(15102026), [], 0
for _case in range(3000):
    _n = _rng.randint(1, 6)
    _times = sorted(dt.datetime(2026, 11, _rng.randint(1, 10), _rng.choice((8, 9, 13, 18, 21)), _i)
                    for _i in range(_n))
    _reads = [(t_, {n: _rng.choice(("num", "num", "blank", "unread")) for n in _NAMES}) for t_ in _times]
    _doc, _first = None, None
    for _k, (t_, st_) in enumerate(_reads):
        res = {"complete": all(v == "num" for v in st_.values()),
               "missing": [n for n in _NAMES if st_[n] == "blank"],
               "unreadable": [n for n in _NAMES if st_[n] == "unread"]}
        _doc = ma.merge(_doc, {"pulled_at": t_.isoformat(timespec="minutes"),
                               "pull_date": t_.date().isoformat(), "ok": True, "cause": None,
                               "tab": "2026", "months": {"2026-10": res}})
        got = _verdict(_doc["kr5"].get("2026-10"))
        if got != _oracle(_reads[:_k + 1]) or ma.doc_problems(_doc):
            _bad.append((_case, _k))
        if _first is None and got[0] in ("100", "0", "not_judged"):
            _first = got
        elif _first is not None and got != _first:
            _decided_moved += 1
check(not _bad and not _decided_moved,
      f"KR5 matches an independent oracle over 3000 random read histories, every step valid, and a "
      f"decided month never changes ({len(_bad)} mismatches, {_decided_moved} moved)")

# ---- 6. when it pulls: the 7th, and catch-up after a missed one -------------
check(ma.due(None, at(2026, 11, 7, 8)) and ma.due(d1, at(2026, 11, 7, 20)),
      "due on the 7th, every bake that day (a re-read can turn a provisional 0 into 100)")
_read_oct7 = {"version": 1, "months": {}, "kr5": {},
              "pulls": [{"pulled_at": "2026-10-07T09:00", "pull_date": "2026-10-07", "ok": True,
                         "cause": None, "tab": "2026"}]}
check(not ma.due(_read_oct7, at(2026, 11, 6)) and not ma.due(_read_oct7, at(2026, 11, 1)),
      "not due before the 7th when last month's read happened")
_failed_since = ma.merge(_read_oct7, {"pulled_at": "2026-11-07T09:00", "pull_date": "2026-11-07",
                                      "ok": False, "cause": "not_shared", "tab": None})
check(ma.due(_failed_since, at(2026, 12, 2)) and ma.due(None, at(2026, 11, 3))
      and ma.last_seventh(dt.date(2026, 12, 2)) == dt.date(2026, 11, 7)
      and ma.last_seventh(dt.date(2027, 1, 3)) == dt.date(2026, 12, 7),
      "...but a read due on the 7th that never succeeded is caught up even after the month turns "
      "(review, 15/10/2026), and a never-read workbook is read at once")
_good_oct = {"version": 1, "months": {}, "kr5": {},
             "pulls": [{"pulled_at": "2026-10-07T09:00+01:00", "pull_date": "2026-10-07", "ok": True,
                        "cause": None, "tab": "2026"}]}
f7 = ma.merge(_good_oct, {"pulled_at": "2026-11-07T09:00+00:00", "pull_date": "2026-11-07",
                          "ok": False, "cause": "not_shared", "tab": None})
check(ma.due(None, at(2026, 11, 9)) and ma.due(f7, at(2026, 11, 9)) and not f7["kr5"],
      "after the 7th: due while no read since this month's 7th has SUCCEEDED - no bake ran, or the "
      "7th's read failed (a failed read is not this month's read)")
check(not ma.due(d1, at(2026, 11, 9)), "after a good read on the 7th: not due again until next month")
oct_only = {"version": 1, "months": {}, "kr5": {},
            "pulls": [{"pulled_at": "2026-10-16T13:00+01:00", "pull_date": "2026-10-16", "ok": True,
                       "cause": None, "tab": "2026"}]}
check(not ma.due(oct_only, at(2026, 10, 20)) and ma.due(oct_only, at(2026, 11, 8)),
      "a catch-up read on 16/10 counts for October, not for November")

# ---- 6b. Drive's answers, mapped to the blocker a reader can act on ----------
# (review, 15/10/2026: Drive answers 404 when the caller cannot read a file,
# and a 403 has several reasons, only one of which is sharing)
import types  # noqa: E402


class _Resp:
    def __init__(self, code, body=b""):
        self.status_code, self.content = code, body

    def iter_content(self, n):
        yield self.content

    def close(self):
        pass


_drive = {}


class _Sess:
    def __init__(self, creds):
        pass

    def get(self, url, **kw):
        _drive["url"] = url
        return _drive["resp"]


_fake = {"google": types.ModuleType("google"), "google.auth": types.ModuleType("google.auth"),
         "google.auth.transport": types.ModuleType("google.auth.transport"),
         "google.auth.transport.requests": types.ModuleType("google.auth.transport.requests"),
         "google.oauth2": types.ModuleType("google.oauth2"),
         "google.oauth2.service_account": types.ModuleType("google.oauth2.service_account")}
_fake["google.auth.transport.requests"].AuthorizedSession = _Sess
_fake["google.oauth2.service_account"].Credentials = types.SimpleNamespace(
    from_service_account_info=lambda info, scopes: object())
_saved = {k: sys.modules.get(k) for k in _fake}
_env = os.environ.get("GOOGLE_SA_JSON")
try:
    sys.modules.update(_fake)
    os.environ["GOOGLE_SA_JSON"] = "{}"
    for code, body, want in ((404, b"", "not_found"),
                             (403, b'{"reason": "accessNotConfigured"}', "drive_api_disabled"),
                             (403, b'{"reason": "fileNotDownloadable"}', "not_xlsx"),
                             (403, b'{"reason": "cannotDownloadFile"}', "download_blocked"),
                             (403, b'{"reason": "userRateLimitExceeded"}', "rate_limited"),
                             (429, b"", "rate_limited"),
                             (403, b'{"reason": "insufficientFilePermissions"}', "not_shared"),
                             (500, b"", "http_error")):
        _drive["resp"] = _Resp(code, body)
        got = ma.download("X" * 30)[1]
        check(got == want and want in ma.CAUSE_TEXT, f"Drive HTTP {code} {body[:40]!r} -> {want}")
    _drive["resp"] = _Resp(200, b"PK-bytes")
    check(ma.download("X" * 30)[:2] == (b"PK-bytes", None), "Drive 200: the bytes, no cause")
finally:
    for k, v in _saved.items():
        if v is None:
            sys.modules.pop(k, None)
        else:
            sys.modules[k] = v
    if _env is None:
        os.environ.pop("GOOGLE_SA_JSON", None)
    else:
        os.environ["GOOGLE_SA_JSON"] = _env
check("sharing was tightened" in ma.CAUSE_TEXT["not_found"] and "Viewer" in ma.CAUSE_TEXT["not_found"],
      "a 404 names lost sharing first, not only 'moved or deleted'")
_ID = "1" + "a" * 32
check(ma.file_id("") is None and ma.file_id("  ") is None and ma.file_id("abc") is False
      and ma.file_id(_ID) == _ID and ma.file_id(_ID + "/edit?usp=drive_link&rtpof=true") == _ID
      and ma.file_id(f"https://docs.google.com/spreadsheets/d/{_ID}/edit#gid=0") == _ID
      and ma.file_id(f"https://drive.google.com/file/d/{_ID}/view?usp=sharing") == _ID,
      "MA_FILE_ID: the bare ID, the part after /d/ with '/edit?...' still on, or the whole link "
      "all give the ID; anything else is bad_file_id, never a request")

# ---- 7. the CLI end to end (no Google: --from-xlsx) ------------------------
import subprocess  # noqa: E402
import tempfile  # noqa: E402
td = tempfile.mkdtemp(prefix="oo1ma-")
xl = os.path.join(td, "ma.xlsx")
with open(xl, "wb") as fh:
    fh.write(build_xlsx(no_oct))
CLI = [sys.executable, os.path.join(HERE, "..", "builders", "oo1_ma.py"), "--out-dir", td]
with open(os.path.join(td, ma.MA_FILE), "w") as fh:     # October's read on 07/10 happened
    json.dump(_read_oct7, fh)
r = subprocess.run(CLI + ["--from-xlsx", xl, "--now", "2026-11-05T10:00"], capture_output=True, text=True)
with open(os.path.join(td, ma.MA_FILE)) as fh:
    _w0 = json.load(fh)
check(r.returncode == 0 and "not due" in r.stdout and _w0 == _read_oct7,
      f"CLI on 05/11: not due, nothing written ({r.stdout.strip()[:80]})")
r = subprocess.run(CLI + ["--from-xlsx", xl, "--now", "2026-11-07T09:30"], capture_output=True, text=True)
with open(os.path.join(td, ma.MA_FILE)) as fh:
    w = json.load(fh)
with open(os.path.join(td, ma.MA_STATUS_FILE)) as fh:
    st = json.load(fh)
check(r.returncode == 0 and ma.doc_problems(w) == [] and w["kr5"]["2026-10"]["score"] == 0
      and not w["kr5"]["2026-10"]["final"] and w["pulls"][-1]["pulled_at"].startswith("2026-11-07T09:30"),
      "CLI on 07/11 09:30: writes the score-only file, October a provisional 0")
check(st["ok"] is True and st["cause"] is None and st["last_ok_at"].startswith("2026-11-07"),
      "...and its status file")
check(not re.search(r"\d{4,}", r.stdout.replace("2026", "")), f"the CLI log carries no figure ({r.stdout.strip()[:100]})")
r = subprocess.run(CLI + ["--now", "2026-11-07T18:00"], capture_output=True, text=True,
                   env={k: v for k, v in os.environ.items() if k not in ("MA_FILE_ID", "GOOGLE_SA_JSON")})
with open(os.path.join(td, ma.MA_STATUS_FILE)) as fh:
    st = json.load(fh)
with open(os.path.join(td, ma.MA_FILE)) as fh:
    w2 = json.load(fh)
check(st["ok"] is False and st["cause"] == "no_file_id" and st["last_ok_at"].startswith("2026-11-07T09:30")
      and w2["pulls"][-1]["cause"] == "no_file_id" and w2["kr5"] == w["kr5"],
      "no MA_FILE_ID: a failed pull recorded, the last good result kept")
FAKE_ID = "1ZZfakeFileIdForTheTestOnly_0123"   # 33 chars, like an uploaded file's
r = subprocess.run(CLI + ["--now", "2026-11-07T18:30", "--force"], capture_output=True, text=True,
                   env={**{k: v for k, v in os.environ.items() if k != "GOOGLE_SA_JSON"}, "MA_FILE_ID": FAKE_ID})
blob = r.stdout + r.stderr
for f_ in (ma.MA_FILE, ma.MA_STATUS_FILE):
    with open(os.path.join(td, f_)) as fh:
        blob += fh.read()
check("no_credentials" in blob and FAKE_ID not in blob and "ZZfake" not in blob,
      "the file ID never reaches the log, the public file or the status file")
_bad = "https://example.invalid/not-a-drive-link?ZZsecretish"
r = subprocess.run(CLI + ["--now", "2026-11-07T18:40", "--force"], capture_output=True, text=True,
                   env={**{k: v for k, v in os.environ.items() if k != "GOOGLE_SA_JSON"}, "MA_FILE_ID": _bad})
with open(os.path.join(td, ma.MA_STATUS_FILE)) as fh:
    _st = json.load(fh)
check(_st["cause"] == "bad_file_id" and "ZZsecretish" not in r.stdout + r.stderr + json.dumps(_st),
      "an MA_FILE_ID that is not a Drive ID: cause bad_file_id, no request, and the value never printed")
with open(os.path.join(td, ma.MA_FILE), "w") as fh:
    fh.write('{"version": 1, "months": {}, "kr5": {}, "pulls": [], "np": 29.0}')
r = subprocess.run(CLI + ["--from-xlsx", xl, "--now", "2026-11-07T19:00"], capture_output=True, text=True)
with open(os.path.join(td, ma.MA_FILE)) as fh:
    check('"np": 29.0' in fh.read() and "left untouched" in r.stdout,
          "a stored file that fails the check is never overwritten (it may hold verdicts no later read can prove)")

# ---- 8. review, 15/10/2026 ---------------------------------------------------
# a line ENTERED but not a number (a dash, text, an error) is not "not entered"
def dash_tax(ws):
    for rr in range(3, ws.max_row + 1):
        if ws.cell(row=rr, column=1).value == "TAX":
            ws.cell(row=rr, column=6, value="-")      # May
            ws.cell(row=rr, column=7, value="#REF!")  # June
gd = ma.grid_from_xlsx(build_xlsx(mangle=dash_tax))
md, _ = ma.read_months(gd["rows"], gd["formula_cells"])
jm = ma.judge_month(md["2026-05"], SCORE)
check(md["2026-05"]["tax"] == ma.UNREADABLE and jm["KR4"] == {"unreadable": ["TAX"]}
      and jm["complete"] is False and jm["missing"] == [] and jm["unreadable"] == ["TAX"],
      "TAX typed '-' : unreadable, not 'not entered' - KR4 says so, and the month is not complete")
check(ma.kr5_from_pull("2026-05", jm, at(2026, 6, 8)) is None
      and ma.kr5_from_pull("2026-06", ma.judge_month(md["2026-06"], SCORE), at(2026, 7, 8)) is None,
      "...and KR5 is NOT a proven 0 - an unreadable line proves nothing either way")


class FakeArray:   # what openpyxl returns for an array / dynamic-array formula
    def __init__(self, ref, text):
        self.ref, self.text = ref, text
fc = ma._formula_cells([[None] * 14, [None] * 14, [None] * 5 + [FakeArray("F3:H3", "=SEQUENCE(1,3)")]])
check({(2, 5), (2, 6), (2, 7)} <= fc,
      "an array formula marks its whole spill range as formula output (spilled cells carry no formula)")
rows0 = ma.grid_from_xlsx(build_xlsx())["rows"]
rows_z = [list(r) for r in rows0]
rows_z[2] = (rows_z[2] + [None] * 14)[:14]
rows_z[2][12] = 0   # December's Restaurant Sales caches 0 from a spilled formula
mz, _ = ma.read_months(rows_z, {(2, 12)})
check(mz["2026-12"]["sales"] == ma.UNREADABLE,
      "...so a spilled 0 in an input line for December is unknown, never a typed 0")


def strip_above(ws):
    ws.insert_rows(1, amount=2)
    ws.cell(row=1, column=1, value="Covers")
    for j, mname in enumerate(MONTHS):
        ws.cell(row=2, column=3 + j, value=mname)     # its own months, one column right
gs = ma.grid_from_xlsx(build_xlsx(mangle=strip_above))
ms_, cs_ = ma.read_months(gs["rows"], gs["formula_cells"])
check(cs_ is None and ms_["2026-01"]["sales"] == 100000 and ms_["2026-05"]["tax"] is None,
      "a strip ABOVE the block with its own offset month header does not shift the months")
check(ma.judge_pull(build_xlsx(title="2026 MA"), at(2026, 7, 7), SCORE)["tab"] == "2026"
      and ma.doc_problems(ma.merge(None, ma.judge_pull(build_xlsx(title="2026 MA"), at(2026, 7, 7), SCORE))) == [],
      "a tab renamed '2026 MA' (found by its A1) is read and published as the year, not refused")
# the shared figure check
for t_, want in (("wages were 20% of sales or less", False), ("net profit was 4% of sales or more", False),
                 ("read on 07/11/2026 15:02", False), ("Ross, 15/10/2026: 100 met, 0 missed", False),
                 ("12,4%", True), ("-4%", True), ("4.5%", True), ("12.5 per cent", True), ("45 percent", True),
                 ("GBP 1,234", True), ("£12", True), ("sales 12,345", True), ("0.123", True), ("wages 23%", True)):
    check(ma.figure_in(t_) is want, f"figure_in({t_!r}) is {want}")
# the stricter shape check
base_doc = ma.merge(None, ma.judge_pull(data, at(2026, 7, 7, 18), SCORE))
for name, mut in (
        ("a stamp that is not a real time", lambda d: d["pulls"][0].__setitem__("pulled_at", "2026-18-40T12:34")),
        ("a pull_date not its stamp's date", lambda d: d["pulls"][0].__setitem__("pull_date", "2026-07-08")),
        ("a month of another year", lambda d: d["months"].__setitem__("2099-12", d["months"]["2026-01"])),
        ("a padded tab", lambda d: d["pulls"][0].__setitem__("tab", " 2026 ")),
        ("a repeated line name", lambda d: d["months"]["2026-05"].__setitem__("missing", ["TAX", "TAX"])),
        ("version True", lambda d: d.__setitem__("version", True)),
        ("an unknown key holding a figure", lambda d: d.__setitem__("wages_jan_12345", True))):
    d2 = json.loads(json.dumps(base_doc))
    mut(d2)
    pr = ma.doc_problems(d2)
    check(pr and "12345" not in " ".join(pr), f"doc_problems refuses {name} (got {pr[:1]})")
# the CLI: no reader, a stored file it cannot read
td2 = tempfile.mkdtemp(prefix="oo1ma2-")
r = subprocess.run([sys.executable, "-c", "import sys, runpy; sys.modules['openpyxl'] = None; "
                    f"sys.argv = ['oo1_ma.py', '--out-dir', {td2!r}, '--now', '2026-11-07T10:00', '--from-xlsx', {xl!r}]; "
                    f"runpy.run_path({os.path.join(HERE, '..', 'builders', 'oo1_ma.py')!r}, run_name='__main__')"],
                   capture_output=True, text=True)
with open(os.path.join(td2, ma.MA_STATUS_FILE)) as fh:
    st2 = json.load(fh)
check(st2["cause"] == "no_reader" and "not the workbook's" in st2["detail"],
      "openpyxl missing on the runner: cause no_reader - never 'the file is unreadable'")
with open(os.path.join(td2, ma.MA_FILE), "w") as fh:
    fh.write("{not json")
r = subprocess.run(CLI[:2] + ["--out-dir", td2, "--from-xlsx", xl, "--now", "2026-11-07T11:00"],
                   capture_output=True, text=True)
with open(os.path.join(td2, ma.MA_STATUS_FILE)) as fh:
    st2 = json.load(fh)
check(st2["cause"] == "store_unreadable" and "restore the last good copy" in st2["detail"]
      and "do not delete it" in r.stdout,
      "a stored file it cannot read: left untouched, and the status SAYS reads are being skipped")

print()
print("all assertions passed" if not fails else f"{fails} assertion(s) FAILED")
sys.exit(1 if fails else 0)
