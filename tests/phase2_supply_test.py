#!/usr/bin/env python3
"""Phase 2 (11/10/2026): supplier statements (OO3 KR5), OO4 KR5, OO4 KR2 and
the monthly OKR pack - pinned.

  python3 tests/phase2_supply_test.py      (exit 1 on any failure)

Part 1 drives builders/supplier_statements.py and builders/okr_pack.py
directly, with the dates pinned: a live bake writes, a back-bake never does;
generated_on is set once and is the KR's measurement; a provisional statement
is refreshed until the issue feed reaches the month end, then frozen; the
markdown cannot break GitHub's renderer or Jekyll; OO1 never reaches a pack.

Part 2 bakes a hand-built archive with the REAL builder as of 04/11/2026 and
pins the three scorecard rows it now computes.
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
sys.path.insert(0, os.path.join(REPO, "builders"))
import okr_pack as pk  # noqa: E402
import supplier_statements as ss  # noqa: E402

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


AUDIT = {"le": [(3, 100), (10, 50)]}


def audit_score(v):
    for t, s in AUDIT["le"]:
        if v <= t:
            return s
    return 0


def mvar(m, **kw):
    return {"m": m, "value": None, "display": None, "score": None, "basis": None,
            "not_measured": None, **kw}


print("-- OO3 KR5: the day the statement was generated --")
idx = {"monthly": [
    {"month": "2026-09", "generated_on": "2026-10-12", "final": True, "url": "https://x/09.md",
     "forms": 74, "suppliers_named": 8},
    {"month": "2026-10", "generated_on": "2026-11-01", "final": False, "url": "https://x/10.md",
     "forms": 40, "suppliers_named": 6},
    {"month": "2026-11", "generated_on": "2026-12-04", "final": True, "url": "https://x/11.md",
     "forms": 30, "suppliers_named": 5},
    {"month": "2026-12", "generated_on": "2027-01-11", "final": True, "url": "https://x/12.md",
     "forms": 3, "suppliers_named": 1}]}
v = {x["m"]: x for x in ss.kr5_variants(idx, "2027-01-20", "2027-01", audit_score, mvar)}
check(v["2026-08"]["score"] is None and "began with Phase 2" in v["2026-08"]["not_measured"]
      and v["2026-08"].get("link") is None,
      "August: before the statements existed - not scored, never 0")
check(v["2026-09"]["score"] is None and "retrospectively on 2026-10-12" in v["2026-09"]["not_measured"]
      and v["2026-09"]["link"]["href"] == "https://x/09.md",
      "September: generated after the fact - not scored, says when, and links it")
check(v["2026-10"]["value"] == 1 and v["2026-10"]["score"] == 100
      and "PROVISIONAL" in v["2026-10"]["basis"] and v["2026-10"]["display"] == "day 1 (1 Nov)",
      "October: generated 1 Nov = day 1 -> 100, and says it is provisional")
check(v["2026-11"]["value"] == 4 and v["2026-11"]["score"] == 50, "November: day 4 -> 50")
check(v["2026-12"]["value"] == 11 and v["2026-12"]["score"] == 0, "December: day 11 -> 0")
check(v["2027-01"].get("mtd") and v["2027-01"]["score"] is None and "not due yet" in v["2027-01"]["basis"],
      "January (the pull month): not due yet - MTD, no score")
v2 = {x["m"]: x for x in ss.kr5_variants({"monthly": []}, "2026-11-04", "2026-11", audit_score, mvar)}
check(v2["2026-10"]["score"] is None and "pending" in v2["2026-10"]["not_measured"]
      and "at most 50" in v2["2026-10"]["not_measured"],
      "no October statement on 4 Nov: pending, and it can now score at most 50")
v3 = {x["m"]: x for x in ss.kr5_variants({"monthly": []}, "2026-11-12", "2026-11", audit_score, mvar)}
check(v3["2026-10"]["score"] == 0 and v3["2026-10"]["value"] == 12,
      "no October statement by 12 Nov: past the 10th, 0 - final whenever it appears")
v4 = {x["m"]: x for x in ss.kr5_variants({"monthly": []}, "2026-11-02", "2026-11", audit_score, mvar)}
check(v4["2026-10"]["score"] is None and "at most" not in v4["2026-10"]["not_measured"],
      "no October statement on 2 Nov: still pending, and 100 is still possible")

print("\n-- the statement document --")
ISS = [
    {"d": "2026-10-03", "supplier": "Lynas", "site": "Maki A", "category": "shortage", "open": True,
     "attribution": "answered", "form": "F", "issue_text": "missing panko - please credit"},
    {"d": "2026-10-05", "supplier": "Lynas", "site": "Maki B", "category": "other", "open": False,
     "attribution": "answered", "form": "F", "issue_text": "lid {{ site.secret }} | leaked <b>x</b>"},
    {"d": "2026-10-09", "supplier": None, "site": "Maki C", "category": "invoice_credit", "open": True,
     "attribution": None, "form": "F", "issue_text": "invoice wrong"},
    {"d": "2026-09-30", "supplier": "Lynas", "site": "Maki A", "category": "shortage", "open": True,
     "attribution": "answered", "form": "F", "issue_text": "September, not October"},
]
OTIF_OCT = {"month": "2026-10", "suppliers": [
    {"supplier": "Lynas", "deliveries": 31, "issues": 2, "otif_pct": 93.5, "measurable": True, "not_measured": None},
    {"supplier": "Harro", "deliveries": 20, "issues": 0, "otif_pct": 100.0, "measurable": True, "not_measured": None},
    {"supplier": "TWF", "deliveries": 9, "issues": 0, "otif_pct": None, "measurable": False,
     "not_measured": "order emails for this supplier only start 2026-10-09"}]}
doc = ss.month_statement("2026-10", ISS, OTIF_OCT, "2026-10-29", ["2026-10-20"], "2026-09-01",
                         "2026-11-01", "2026-11-01")
lyn = next(b for b in doc["supplier_blocks"] if b["supplier"] == "Lynas")
check(doc["forms"] == 3 and doc["suppliers_named"] == 1 and doc["suppliers"] == 3,
      "3 October forms (not the 30/09 one); 1 supplier named; 3 listed (deliveries count too)")
check(lyn["forms"] == 2 and lyn["issue_free"]["rate"] == 93.5 and lyn["credit_flagged"] == 1,
      "Lynas: its 2 forms, supply.otif's rate, one credit-flagged row")
check(doc["unattributed"]["forms"] == 1 and doc["unattributed"]["issues"][0]["credit_flag"],
      "the form naming no supplier is listed, and flagged (category invoice_credit)")
check(not doc["final"] and any("PROVISIONAL" in n for n in doc["coverage_notes"])
      and any("2026-10-20" in n for n in doc["coverage_notes"]),
      "feed short of 31/10 and a hole on 20/10: provisional, and both are said")
check(lyn["issues"][1]["text"] == "lid {{ site.secret }} | leaked <b>x</b>",
      "the JSON keeps the issue text VERBATIM")
md = ss.statement_md(doc)
check("{{" not in md and "{%" not in md and "<b>" not in md and "lid &#123;&#123; site.secret &#125;&#125; \\| leaked &lt;b&gt;x&lt;/b&gt;" in md,
      "the markdown escapes Liquid braces, pipes and HTML (a '{{' would fail the Pages build)")
hostile = ss.statement_md(ss.month_statement("2026-10", [dict(ISS[0], issue_text="[click](javascript:alert(1)) ![px](https://evil.example/p.png)")],
                                             OTIF_OCT, "2026-10-31", [], "", "2026-11-01", "2026-11-01"))
check("](javascript:" not in hostile and "![px](" not in hostile and "&#91;click&#93;" in hostile,
      "markdown link and image syntax in issue text is neutralised (Pages renders .md with no URL filter)")
check("TWF - not measured - order emails for this supplier only start 2026-10-09" in md,
      "a supplier with deliveries and no forms is listed with its rate or why it has none")

print("\n-- sync: live writes, back-bakes read --")
tmp = tempfile.mkdtemp(prefix="p2stmt-")
DEL = {(d, "Lynas"): 1 for d in days("2026-10-01", "2026-11-03")}
r = ss.sync(tmp, "2026-11-01", None, ISS, [OTIF_OCT], "2026-10-30", [], "2026-09-01", DEL,
            {"Lynas": "2026-09-01"})
jp = os.path.join(tmp, "supplier_statements", "2026-10.json")
d1 = json.load(open(jp))
check(os.path.exists(jp) and os.path.exists(jp[:-5] + ".md") and d1["generated_on"] == "2026-11-01"
      and not d1["final"], "1 Nov: October's statement written, PROVISIONAL (feed reaches 30/10)")
check(r["weekly"] and r["weekly"][0]["week"] == "2026-W43",
      "1 Nov (a Sunday): the Lynas cut is for the week just ended, W43 (19-25 Oct)")
r = ss.sync(tmp, "2026-11-02", None, ISS, [OTIF_OCT], "2026-10-31", [], "2026-09-01", DEL,
            {"Lynas": "2026-09-01"})
d2 = json.load(open(jp))
check(d2["generated_on"] == "2026-11-01" and d2["updated_on"] == "2026-11-02" and d2["final"],
      "2 Nov: refreshed to FINAL - generated_on unchanged (it is the KR's measurement)")
check(any(w["week"] == "2026-W44" for w in r["weekly"]),
      "2 Nov (Monday): the cut for W44 (26 Oct - 1 Nov) is written")
m0 = os.path.getmtime(jp)
r = ss.sync(tmp, "2026-11-03", None, ISS + [dict(ISS[0], d="2026-10-31", issue_text="late form")],
            [OTIF_OCT], "2026-11-02", [], "2026-09-01", DEL, {"Lynas": "2026-09-01"})
check(os.path.getmtime(jp) == m0 and json.load(open(jp))["forms"] == 3 and jp not in r["written"],
      "3 Nov: a FINAL statement is frozen - a late form does not rewrite it")
before = sorted(os.listdir(os.path.join(tmp, "supplier_statements")))
ss.sync(tmp, "2026-12-01", "2026-12-01", ISS, [], "2026-11-30", [], "", DEL, {})
check(sorted(os.listdir(os.path.join(tmp, "supplier_statements"))) == before,
      "a back-bake (dated) writes nothing")
check([x["month"] for x in ss.index(tmp, "2026-10-31")["monthly"]] == [],
      "a back-bake of 31 Oct does not see a statement generated on 1 Nov")
check("2026-10" in [x["month"] for x in ss.index(tmp, "2026-11-01")["monthly"]],
      "...and a back-bake of 1 Nov does")
try:
    ss.sync(tempfile.mkdtemp(), "2026-11-01", None,
            [dict(ISS[0], issue_text="Predicted NP was 9%")], [OTIF_OCT], "2026-10-31", [],
            "", DEL, {}, forbidden=("Predicted NP",))
    check(False, "a statement carrying an OO1 Finance column name is refused")
except SystemExit:
    check(True, "a statement carrying an OO1 Finance column name is refused")

print("\n-- the weekly Lynas cut --")
w = ss.week_cut("2026-W43", "2026-10-19", "2026-10-25", ISS + [
    dict(ISS[0], d="2026-10-20"), dict(ISS[0], d="2026-10-21", supplier="Harro")],
    {(d, "Lynas"): 2 for d in days("2026-10-19", "2026-10-25")}, "2026-09-01",
    "2026-10-30", [], "2026-10-26", "2026-10-26")
check(w["forms"] == 1 and w["deliveries"] == 14 and w["rate"] == round(100 * 13 / 14, 1) and w["final"],
      "W43: Lynas forms only, 14 deliveries, 92.9% issue-free, final")
w2 = ss.week_cut("2026-W43", "2026-10-19", "2026-10-25", ISS, {}, "2026-10-21", "2026-10-30", [],
                 "2026-10-26", "2026-10-26")
check(w2["rate"] is None and "only start 2026-10-21" in w2["not_measured"],
      "order emails starting mid-week: not measured, and says why")

print("\n-- the monthly OKR pack --")
check(pk.due("2026-11-01", None) == "first" and pk.due("2026-11-03", {"editions": [{"edition": "first"}]}) is None,
      "first edition on the first bake after month end, once")
check(pk.due("2026-11-08", {"editions": [{"edition": "first"}]}) == "8th"
      and pk.due("2026-11-09", {"editions": [{"edition": "first"}, {"edition": "8th"}]}) is None,
      "the 8th edition on the first bake on or after the 8th, once")
check(pk.due("2026-11-12", None) == "8th", "a month first reached after the 8th gets the 8th edition only")
SNAP = {"pull_date": "2026-11-01", "gaps": ["a gap"],
        "suppliers": {"statements": {"monthly": [{"month": "2026-10", "url": "https://x/10.md",
                                                  "final": True, "generated_on": "2026-11-01"}]}},
        "scorecard": {"basis": "b", "month_basis": "mb",
                      "operations": {"months": [{"m": "2026-10", "pct": 72.5, "scored": 4, "total": 5}]},
                      "objectives": [
                          {"objective": "OO1", "label": "7% Net Profit", "pct_note": "withheld",
                           "months": [{"m": "2026-10", "pct": None, "scored": 1, "total": 5}]},
                          {"objective": "OO3", "label": "Supply Chain",
                           "months": [{"m": "2026-10", "pct": 50.0, "scored": 2, "total": 5}]}],
                      "rows": [
                          {"objective": "OO1", "kr": "KR1", "text": "KR1: Actual W/R% (20%)", "target": "per sheet",
                           "months": [{"m": "2026-10", "value": 21.7, "display": "21.7%", "score": 80, "rag": "amber"}]},
                          {"objective": "OO3", "kr": "KR5", "text": "KR5: Monthly Supplier Audit Completion",
                           "target": "statement by the 3rd",
                           "months": [{"m": "2026-08", "score": None}, {"m": "2026-09", "score": None},
                                      {"m": "2026-10", "value": 1, "display": "day 1 (1 Nov)", "score": 100,
                                       "rag": "green", "basis": "generated 1 Nov",
                                       "link": {"href": "https://x/10.md", "label": "October 2026 statement"}}]},
                          {"objective": "OO3", "kr": "KR3", "text": "KR3: Zero menu items", "target": "0",
                           "not_measured": "sheet not shared"}]}}
pd = pk.build(SNAP, "2026-10", "first", "2026-11-01")
oo1 = pd["objectives"][0]["krs"][0]
check(oo1["value"] is None and oo1["score"] == 80, "OO1: Finance's score, and NO value even if one leaked in")
pmd = pk.to_md(pd)
check("21.7" not in pmd and "score only" in pmd and "no % published" in pmd,
      "the pack's markdown never prints an OO1 figure or an OO1 %")
check("| KR5 Monthly Supplier Audit Completion |" in pmd and "[October 2026 statement](https://x/10.md)" in pmd,
      "a KR row carries its text once (no 'KR5 KR5:') and links its document")
check("NOT MEASURED: current state only" in pmd, "a KR with no monthly form says so for a closed month")
check("**Operations: 72.5%**" in pmd and "- a gap" in pmd, "Operations % and the gaps are in the pack")
ptmp = tempfile.mkdtemp(prefix="p2pack-")
check(pk.maybe_render(SNAP, ptmp, "2026-11-01", "2026-11-01") == ([], []), "a back-bake renders no pack")
w_, g_ = pk.maybe_render(SNAP, ptmp, "2026-11-01", None)
meta = json.load(open(os.path.join(ptmp, "okr_pack", "2026-10.json")))
check(os.path.exists(os.path.join(ptmp, "okr_pack", "2026-10.md"))
      and meta["editions"][0]["edition"] == "first",
      "1 Nov: the first edition is written and recorded")
try:
    import reportlab  # noqa: F401
    check(os.path.exists(os.path.join(ptmp, "okr_pack", "2026-10.pdf")) and meta["pdf"] and not g_,
          "...with its PDF (reportlab installed)")
except ImportError:
    check(meta["pdf"] is None and g_ and "reportlab" in g_[0],
          "...and without reportlab the markdown stands and a gap says why")
check(pk.maybe_render(SNAP, ptmp, "2026-11-02", None) == ([], []), "2 Nov: nothing new to render")
pk.maybe_render(SNAP, ptmp, "2026-11-08", None)
meta = json.load(open(os.path.join(ptmp, "okr_pack", "2026-10.json")))
check([e["edition"] for e in meta["editions"]] == ["first", "8th"], "8 Nov: the 8th edition, recorded beside the first")
check([x["month"] for x in pk.index(ptmp, "2026-10-31")] == [] and pk.index(ptmp)[0]["edition"] == "8th",
      "the pack index: a back-bake before 1 Nov sees none; the live index names the latest edition")
try:
    bad = json.loads(json.dumps(SNAP))
    bad["gaps"].append("Predicted NP read 9%")
    pk.maybe_render(bad, tempfile.mkdtemp(), "2026-11-01", None, forbidden=("Predicted NP",))
    check(False, "a pack carrying an OO1 Finance column name is refused")
except SystemExit:
    check(True, "a pack carrying an OO1 Finance column name is refused")

print("\n-- review fixes (11/10/2026) --")
early = json.loads(json.dumps(SNAP)); early["pull_date"] = "2026-10-31"
check(pk.maybe_render(early, tempfile.mkdtemp(), "2026-11-01", None) == ([], []),
      "a bake on the 1st whose newest pull is still the 31st renders no pack (it would freeze an MTD month)")
nopdf = {"editions": [{"edition": "first", "pdf": False, "pdf_missing_because": pk.NO_REPORTLAB}]}
check(pk.due("2026-11-02", nopdf) == ("first" if pk.have_reportlab() else None),
      "an edition whose PDF was lost to a missing reportlab is due again once it imports")
check(pk.due("2026-11-02", {"editions": [{"edition": "first", "pdf": False,
                                          "pdf_missing_because": "the PDF could not be laid out"}]}) is None,
      "...but a layout failure is not retried every day")
if pk.have_reportlab():
    import reportlab.platypus as _rp
    _orig = _rp.SimpleDocTemplate.build
    _rp.SimpleDocTemplate.build = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("layout"))
    _pd = tempfile.mkdtemp()
    why = pk.to_pdf(pd, os.path.join(_pd, "x.pdf"))
    _rp.SimpleDocTemplate.build = _orig
    check(why and "could not be laid out (RuntimeError)" in why and os.listdir(_pd) == [],
          "a PDF that cannot be laid out is a reason, not an exception, and leaves no .tmp")
    longd = json.loads(json.dumps(pd))
    longd["objectives"][1]["krs"][0]["note"] = "x " * 10000
    check(pk.to_pdf(longd, os.path.join(_pd, "long.pdf")) is None and os.path.exists(os.path.join(_pd, "long.pdf")),
          "a 20,000-character basis is cut (and says so) rather than breaking the layout")
late = tempfile.mkdtemp()
pk.maybe_render(SNAP, late, "2026-11-12", None)
check("no first edition was made for this month" in open(os.path.join(late, "okr_pack", "2026-10.md")).read(),
      "an 8th edition with no first says so - it does not claim to replace one")
ix = pk.index(ptmp, "2026-11-05")
check(ix and ix[0]["edition"] == "first" and ix[0]["file_is_later_edition"],
      "a back-bake of 5 Nov names the first edition, and that the file on disk is a later one")

ss_tmp = tempfile.mkdtemp()
ss.sync(ss_tmp, "2026-11-01", None, ISS, [OTIF_OCT], "2026-10-30", [], "2026-09-01", DEL,
        {"Lynas": "2026-09-01"}, pull="2026-10-31")
check(not os.path.exists(os.path.join(ss_tmp, "supplier_statements", "2026-10.json")),
      "1 Nov with the newest pull still 31 Oct: October's statement waits for the data to leave the month")
r = ss.sync(ss_tmp, "2026-11-02", None, ISS, [OTIF_OCT], "2026-10-31", [], "2026-09-01", DEL,
            {"Lynas": "2026-09-01"})
sdir = os.path.join(ss_tmp, "supplier_statements")
check(os.path.exists(os.path.join(sdir, "2026-10.json")) and os.path.exists(os.path.join(sdir, "2026-09.json")),
      "the month before last is caught up too (a bake that did not push for days loses nothing)")
check(sorted(f[:8] for f in os.listdir(os.path.join(sdir, "weekly")) if f.endswith(".json"))
      == ["2026-W40", "2026-W41", "2026-W42", "2026-W43", "2026-W44"],
      "...and the Lynas weeks: four back from 1 Nov, then W44 on 2 Nov")
open(os.path.join(sdir, "2026-10.json"), "w").write("{ not json")
r = ss.sync(ss_tmp, "2026-11-03", None, ISS, [OTIF_OCT], "2026-10-31", [], "2026-09-01", DEL, {})
check(open(os.path.join(sdir, "2026-10.json")).read() == "{ not json" and any("cannot be read" in g for g in r["gaps"]),
      "an unreadable statement is NOT rewritten (that would reset generated_on) - a gap says so")
f_tmp = tempfile.mkdtemp()
ss.sync(f_tmp, "2026-11-01", None, ISS, [OTIF_OCT], "2026-10-30", [], "2026-09-01", DEL, {})
ss.sync(f_tmp, "2026-11-02", None, ISS, [OTIF_OCT], "2026-10-31", [], "2026-09-01", DEL, {})
d_ = json.load(open(os.path.join(f_tmp, "supplier_statements", "2026-10.json")))
check(d_["generated_on"] == "2026-11-01" and d_["final_on"] == "2026-11-02", "the day it went FINAL is recorded")
v5 = {x["m"]: x for x in ss.kr5_variants(ss.index(f_tmp), "2026-11-05", "2026-11", audit_score, mvar)}
check("PROVISIONAL when generated and FINAL since 2026-11-02" in v5["2026-10"]["basis"],
      "...and OO3 KR5 says it was provisional on the day it scored")
check("Last scored: October 2026, day 1 (1 Nov), 100" in v5["2026-11"]["basis"],
      "the month in progress shows the last scored result, not just 'not due yet'")
vb = {x["m"]: x for x in ss.kr5_variants(ss.index(f_tmp, "2026-11-01"), "2026-11-01", "2026-11", audit_score, mvar)}
check("last updated on 2026-11-02, after this snapshot's date" in vb["2026-10"]["basis"],
      "a back-bake of 1 Nov says the copy on disk was updated after its date")
check(not os.path.exists(os.path.join(tempfile.mkdtemp(), "x"))
      and ss.sync(tempfile.mkdtemp(), "2026-11-02", None, ISS, [OTIF_OCT], "", [], "", DEL, {})["monthly"] == [],
      "no issue feed at all: no statement is written (it would be empty and still score)")


def band7(v):
    return 100 if v <= 3 else 50 if v <= 7 else 0


v7 = {x["m"]: x for x in ss.kr5_variants({"monthly": []}, "2026-11-09", "2026-11", band7, mvar)}
check(v7["2026-10"]["score"] == 0 and v7["2026-10"]["value"] == 9,
      "the band decides when a missing statement is a final 0 - no day threshold of its own")

# ===========================================================================
print("\n== Part 2: the real builder, as of 04/11/2026 ==")


def answers(lo, hi, forms):
    out = []
    for d in days(lo, hi):
        out.append({"FormId": f"R{d}", "TaskID": "1", "FormTemplateName": "Opening Checks",
                    "TaskName": "Fridge temp?", "Answer": "3", "LocationNameLabel": "Maki Test",
                    "AnsweredDateTime": d + "T09:00:00", "IsOpenDeviation": "false", "AnswerID": f"A{d}"})
        for fid, (fd, sup, text) in forms.items():
            if fd != d:
                continue
            for t, (task, ans) in enumerate([("Supplier?", sup), ("Issue?", text)]):
                out.append({"FormId": fid, "TaskID": str(t), "FormTemplateName": "Delivery/Supplier Issue Form",
                            "TaskName": task, "Answer": ans, "LocationNameLabel": "Maki Test",
                            "AnsweredDateTime": d + "T11:00:00", "IsOpenDeviation": "true",
                            "AnswerID": f"{fid}-{t}"})
    return out


FORMS = {"L1": ("2026-10-06", "Lynas", "missing panko"),
         "L2": ("2026-10-15", "Lynas", "short delivery, please credit"),
         "F1": ("2026-10-14", "AA Factory", "tonkotsu broth tub split and leaking in the van"),
         "F2": ("2026-10-20", "AA Factory", "late delivery"),
         "F3": ("2026-10-22", "AA Factory", "chilli oil damaged"),
         "L3": ("2026-10-23", "Lynas", "missing tom yum, exploded Soba sauce"),
         "L4": ("2026-10-24", "Lynas", "prawn crackers short, crushed chilli for the broth"),
         "J1": ("2026-10-25", "JFC", "soy sauce bottle broken")}
ORDERS = [{"Order Ref": f"O{s}{d}", "Supplier": s, "Site": "Maki Test", "Delivery Date ISO": d,
           "Order Email Date": d, "Order Value GBP": "100", "Line Items": "3", "Items Ordered": "10",
           "Order Placed At": d + "T06:00:00"}
          for d in days("2026-09-20", "2026-11-06") for s in ("Lynas", "Harro")]
btmp = tempfile.mkdtemp(prefix="p2bake-")
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


x = dt.date(2026, 9, 30)
while x <= dt.date(2026, 11, 4):          # a pull every 4 days, each reaching back 8
    put(x.isoformat(), "GC_Form_Task_Answers", "GC Form Task Answers",
        answers((x - dt.timedelta(days=8)).isoformat(), (x - dt.timedelta(days=1)).isoformat(), FORMS))
    x += dt.timedelta(days=4)
put("2026-11-03", "Kobas_Orders", "Kobas Orders", ORDERS)
out = os.path.join(btmp, "out")
os.makedirs(os.path.join(out, "supplier_statements"))
shutil.copy(os.path.join(REPO, "data", "ops_command", "feeds_manifest.json"), out)
# October's statement, as the live bake of 2 Nov would have left it
json.dump({"month": "2026-10", "generated_on": "2026-11-02", "updated_on": "2026-11-02",
           "final": True, "forms": 5, "suppliers": 2, "suppliers_named": 2},
          open(os.path.join(out, "supplier_statements", "2026-10.json"), "w"))
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

    k5 = var(("OO3", "KR5"), "2026-10")
    check(k5.get("value") == 2 and k5.get("score") == 100 and k5.get("rag") == "green"
          and (k5.get("link") or {}).get("href", "").endswith("supplier_statements/2026-10.md"),
          f"OO3 KR5 October: generated 2 Nov -> day 2 -> 100, linked (got {k5.get('value')}, {k5.get('score')})")
    check(rows[("OO3", "KR5")]["mtd"] and rows[("OO3", "KR5")]["score"] is None,
          "OO3 KR5's default month (November) is not due yet")
    check(sorted(os.listdir(os.path.join(out, "supplier_statements"))) == ["2026-10.json"]
          and not os.path.exists(os.path.join(out, "okr_pack")),
          "a dated bake wrote no statement, no Lynas cut and no pack")
    om = next(m for m in snap["supply"]["otif"]["months"] if m["month"] == "2026-10")
    lyn = next(r for r in om["suppliers"] if r["supplier"] == "Lynas")
    check(om["supplier_mean"] == round((lyn["otif_pct"] + 100.0) / 2, 1) and om["supplier_mean_of"] == 2,
          f"supply.otif October carries the unweighted mean of Lynas and Harro (got {om.get('supplier_mean')})")
    k5b = var(("OO4", "KR5"), "2026-10")
    _want = next((sc_ for t_, sc_ in ((95, 100), (90, 80), (85, 50)) if om["supplier_mean"] >= t_), 0)
    check(k5b.get("value") == om["supplier_mean"] and k5b.get("score") == _want,
          f"OO4 KR5 October: that mean, banded pct95 (got {k5b.get('display')}, {k5b.get('score')})")
    check("AA Factory (no Kobas order emails)" in (k5b.get("basis") or ""),
          "...and the factory (forms, no order emails) is named as left out, with the right reason")
    check("Lynas" in (k5b.get("basis") or "") and "Harro 100%" in (k5b.get("basis") or ""),
          "...and its basis lists each supplier's rate")
    k2 = var(("OO4", "KR2"), "2026-10")
    check(k2.get("value") == 2 and k2.get("score") == 100 and not k2.get("incomplete")
          and "2026-10-14" in (k2.get("basis") or "") and "2026-10-23 Maki Test (Lynas)" in (k2.get("basis") or ""),
          f"OO4 KR2 October: the factory's broth tub AND Lynas's exploded soba sauce count (Ross, 11/10); the chilli oil, the late one, crackers and crushed chilli do not -> 2, 100 (got {k2.get('value')}, {k2.get('score')})")
    check("NOT COUNTED: 1 form(s) naming another supplier" in (k2.get("basis") or "")
          and "2026-10-25 JFC" in (k2.get("basis") or ""),
          "...and another supplier's sauce (JFC soy sauce, a bought-in product) is named, not counted")
    k2n = var(("OO4", "KR2"), "2026-11")
    check(k2n.get("mtd") and k2n.get("score") is None, "OO4 KR2 November: month to date, unscored")
    st = snap["suppliers"]["statements"]
    check([m["month"] for m in st["monthly"]] == ["2026-10"] and st["weekly"] == [],
          "the snapshot's statement index lists what exists as of the bake")
    check(snap.get("okr_packs") == [], "and no pack (none on disk)")

    print("\n-- the verifier's recompute (check 4b) --")
    # It runs the REAL builder, undated, from a temp copy. Without the two new
    # modules it dies on ModuleNotFoundError; without the statements it writes
    # one dated today and scores OO3 KR5 on the wrong day.
    import verify_ops_data as vod
    vod.OUT_DIR = out
    vod.RESULTS.clear()
    vod.fetch_json = lambda *a, **k: (_ for _ in ()).throw(OSError("offline in tests"))
    os.environ.update(OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=wd)
    rc = vod.check_consistency("2026-11-03", "2026-11-03")
    bad = [r["detail"] for r in vod.RESULTS if r["check"] == "4b-consistency"
           and ("recompute failed" in r["detail"] or "could not run" in r["detail"])]
    check(rc is not None and not bad, "the recompute runs with the Phase 2 modules" + (f": {bad}" if bad else ""))
    if rc:
        r5 = next(r for r in rc["scorecard"]["rows"] if (r["objective"], r["kr"]) == ("OO3", "KR5"))
        o5 = next((v for v in r5["months"] if v["m"] == "2026-10"), {})
        check(o5.get("value") == 2 and o5.get("score") == 100,
              f"...and reads October's statement from disk - day 2, not regenerated today (got {o5.get('value')})")
    print("\n-- a closed month the issue feed stopped short of --")
    wd2 = os.path.join(btmp, "wd2")
    shutil.copytree(wd, wd2)
    for pd_ in os.listdir(wd2):
        if pd_ > "2026-10-21" and os.path.exists(os.path.join(wd2, pd_, "GC_Form_Task_Answers.jsonl.gz")):
            shutil.rmtree(os.path.join(wd2, pd_)) if pd_ != "2026-11-03" else os.remove(
                os.path.join(wd2, pd_, "GC_Form_Task_Answers.jsonl.gz"))
    out2 = os.path.join(btmp, "out2")
    os.makedirs(out2)
    shutil.copy(os.path.join(REPO, "data", "ops_command", "feeds_manifest.json"), out2)
    p2 = subprocess.run([sys.executable, os.path.join(REPO, "builders", "bake_ops_command.py"),
                         "--date", "2026-11-04"],
                        env=dict(env, OPS_ARCHIVE_DIR=wd2, OPS_OUT_DIR=out2), capture_output=True, text=True)
    check(p2.returncode == 0, "the builder bakes it" + ("" if p2.returncode == 0 else ": " + p2.stderr[-800:]))
    if p2.returncode == 0:
        s2 = json.load(open(os.path.join(out2, "snapshot_2026-11-04.json")))
        r2 = next(r for r in s2["scorecard"]["rows"] if (r["objective"], r["kr"]) == ("OO4", "KR5"))
        o2 = next(v for v in r2["months"] if v["m"] == "2026-10")
        check(o2.get("score") is None and o2.get("incomplete") and "INCOMPLETE month" in (o2.get("basis") or "")
              and "- to 2026-10-" in (o2.get("display") or ""),
              f"OO4 KR5 October counted only to 20 Oct: shown, NOT scored, and says why (got {o2.get('display')}, {o2.get('score')})")
shutil.rmtree(btmp)
shutil.rmtree(tmp)
shutil.rmtree(ptmp)

print(f"\n{'FAILED' if failures else 'passed'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
