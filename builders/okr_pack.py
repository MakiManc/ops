#!/usr/bin/env python3
"""The monthly OKR pack (Phase 2, 2.5): data/ops_command/okr_pack/<YYYY-MM>.md
and .pdf for the month just closed.

WHEN. Twice per month, by the bake itself (live bakes only - a back-bake never
writes one):
  * the FIRST edition, by the first bake on or after the 1st, as soon as the
    month has closed;
  * the 8TH edition, by the first bake on or after the 8th, because Finance's
    rows on the Operations Input sheet land by the 7th. It replaces the first.
okr_pack/<YYYY-MM>.json records both editions and when each was made. Nothing
here sends the pack anywhere: a Cowork scheduled task does that, and Ross
decides who receives it.

WHAT. Everything comes from the snapshot the same bake has just built - the
pack computes nothing. For the month: the Operations %, each objective's %
(OO1's is never published - see OKR_PCT_WITHHELD in the bake), and every KR
with its value, score, RAG, the scores of the two months before it, and its
basis or its blocker. Then the month's supplier statement and the bake's gaps.
A KR with no monthly form has no value for a closed month, and says so rather
than borrowing today's.

OO1 IS SCORES ONLY, here as everywhere: an OO1 row prints its score and never
a value or a display, and the bake refuses to write a pack that carries one of
OO1's Finance column names.

THE PDF needs reportlab (pip install reportlab). Without it the markdown is
still written and the pack's .json says the PDF is missing and why - a missing
library must never cost the dashboard its bake.
"""
from __future__ import annotations

import datetime
import json
import os
import re

from supplier_statements import md_cell, mlabel, prev_month

PACK_DIR = "okr_pack"
#: The longest text one PDF table cell carries before it is cut (and says so).
PDF_CELL_MAX = 2500
#: Finance's rows on the Operations Input sheet land by the 7th.
SECOND_EDITION_DAY = 8


#: The reason to_pdf gives when the library is absent - the one failure a later
#: bake can cure by itself, so the one that makes an edition due again.
NO_REPORTLAB = "reportlab is not installed on the runner (pip install reportlab)"


def have_reportlab() -> bool:
    try:
        import reportlab  # noqa: F401
        return True
    except ImportError:
        return False


def due(today: str, meta: dict | None) -> str | None:
    """'first', '8th' or None for the month just closed, given its pack's meta.

    An edition whose PDF was not written because reportlab was missing is due
    again once reportlab imports (review, 11/10/2026: it was never retried, so a
    bake that ran before the install step merged lost that month's PDF)."""
    d = datetime.date.fromisoformat(today[:10])
    eds_all = (meta or {}).get("editions") or []
    eds = {e.get("edition") for e in eds_all}
    want = "8th" if d.day >= SECOND_EDITION_DAY else "first"
    if want not in eds:
        return want
    last = next((e for e in reversed(eds_all) if e.get("edition") == want), {})
    if not last.get("pdf") and last.get("pdf_missing_because") == NO_REPORTLAB and have_reportlab():
        return want
    return None


def _variant(row, m):
    for v in row.get("months") or []:
        if v.get("m") == m:
            return v
    return None


def _text(row):
    """The sheet's KR wording without its own 'KR1:' prefix (the pack prints
    the id beside it) - the same strip the OKR wall applies."""
    return re.sub(r"^KR\s?\d\s*:?\s*", "", row.get("text") or "", flags=re.I)


def _score_txt(s):
    return "—" if s is None else str(s)


def build(snap: dict, month: str, edition: str, today: str) -> dict:
    """The pack for `month` as plain data. Pure: no file is touched."""
    sc = snap.get("scorecard") or {}
    ops = next((x for x in ((sc.get("operations") or {}).get("months") or [])
                if x.get("m") == month), None)
    m1, m2 = prev_month(month), prev_month(prev_month(month))
    objectives = []
    for o in sc.get("objectives") or []:
        om = next((x for x in o.get("months") or [] if x.get("m") == month), None) or {}
        krs = []
        for r in sc.get("rows") or []:
            if r.get("objective") != o.get("objective"):
                continue
            oo1 = r.get("objective") == "OO1"
            v = _variant(r, month)
            hist = [(mm, (_variant(r, mm) or {}).get("score")) for mm in (m2, m1)]
            if v is None:
                why = ("current state only - this KR has no monthly form, so it has no value "
                       "for a closed month" if not r.get("months") else
                       f"no figure for {mlabel(month)}")
                krs.append({"kr": r.get("kr"), "text": _text(r), "target": r.get("target"),
                            "value": None, "score": None, "rag": None, "history": hist,
                            "note": why, "blocked": True})
                continue
            grey = v.get("value") is None and v.get("score") is None
            krs.append({
                "kr": r.get("kr"), "text": _text(r), "target": r.get("target"),
                # OO1: Finance's score only - never a value or a display
                "value": None if oo1 else (v.get("display") if v.get("display") is not None
                                           else v.get("value")),
                "score": v.get("score"), "rag": v.get("rag"), "history": hist,
                "note": (v.get("not_measured") or r.get("not_measured") or v.get("basis")
                         if grey else v.get("basis")),
                "blocked": grey, "incomplete": bool(v.get("incomplete")),
                "link": v.get("link")})
        objectives.append({"objective": o.get("objective"), "label": o.get("label"),
                           "pct": om.get("pct"), "scored": om.get("scored"),
                           "total": om.get("total"), "pct_note": o.get("pct_note"),
                           "krs": krs})
    st = next((x for x in (((snap.get("suppliers") or {}).get("statements") or {})
                           .get("monthly") or []) if x.get("month") == month), None)
    return {"kind": "okr_pack", "month": month, "label": mlabel(month),
            "edition": edition, "generated_on": today[:10],
            "snapshot": f"snapshot_{snap.get('pull_date')}.json",
            "operations": {"pct": (ops or {}).get("pct"), "scored": (ops or {}).get("scored"),
                           "total": (ops or {}).get("total")},
            "objectives": objectives,
            "statement": ({"url": st.get("url"), "final": st.get("final"),
                           "generated_on": st.get("generated_on")} if st else None),
            "gaps": list(snap.get("gaps") or []),
            "basis": sc.get("basis"), "month_basis": sc.get("month_basis")}


def _pct(p):
    return "—" if p is None else f"{p:g}%"


def to_md(doc: dict) -> str:
    ed = ("first edition, made as the month closed" if doc["edition"] == "first" else
          "8th-of-the-month edition, after Finance's rows land on the 7th"
          + (" - it replaces the first" if doc.get("replaces_first") else
             " - no first edition was made for this month"))
    L = [f"# Ops OKR pack - {md_cell(doc['label'])}", "",
         f"{md_cell(ed)} · generated {doc['generated_on']} · from {md_cell(doc['snapshot'])}", "",
         f"**Operations: {_pct(doc['operations']['pct'])}** "
         f"({doc['operations']['scored'] or 0} of {doc['operations']['total'] or 5} objectives "
         "scored; OO1 is Finance's and is excluded)", "",
         "| Objective | % | KRs scored |", "|---|---:|---:|"]
    for o in doc["objectives"]:
        pct = ("no % published" if o.get("pct_note") else _pct(o["pct"]))
        L.append(f"| {md_cell(o['objective'])} {md_cell(o['label'])} | {md_cell(pct)} | "
                 f"{o['scored'] or 0} of {o['total'] or 5} |")
    L.append("")
    for o in doc["objectives"]:
        L += [f"## {md_cell(o['objective'])} - {md_cell(o['label'])}", ""]
        if o.get("pct_note"):
            L += [f"> {md_cell(o['pct_note'])}", ""]
        L += ["| KR | Target | Value | Score | Before | Basis or blocker |",
              "|---|---|---|---:|---|---|"]
        for k in o["krs"]:
            hist = ", ".join(f"{mlabel(m)[:3]} {_score_txt(s)}" for m, s in k["history"])
            val = ("score only" if o["objective"] == "OO1" and k["score"] is not None
                   else ("—" if k["value"] is None else k["value"]))
            note = md_cell(("NOT MEASURED: " if k.get("blocked") else "") + (k.get("note") or ""))
            lk = k.get("link") or {}
            if str(lk.get("href") or "").startswith("https://"):
                note += f" [{md_cell(lk.get('label') or 'document')}]({lk['href']})"
            L.append(f"| {md_cell(k['kr'])} {md_cell(k['text'])} | {md_cell(k['target'])} | "
                     f"{md_cell(val)} | {_score_txt(k['score'])} | {md_cell(hist)} | {note} |")
        L.append("")
    L += ["## Supplier statement", ""]
    s = doc.get("statement")
    L += [(f"[{md_cell(doc['label'])} supplier statement]({s['url']}) - "
           f"{'FINAL' if s['final'] else 'PROVISIONAL'}, generated {s['generated_on']}")
          if s else f"No supplier statement exists for {md_cell(doc['label'])}.", ""]
    L += ["## Gaps (as at this bake)", ""] + [f"- {md_cell(g)}" for g in doc["gaps"]] + [""]
    L += ["---", "", f"How the scorecard is scored: {md_cell(doc.get('basis') or '')}", "",
          f"How months are scored: {md_cell(doc.get('month_basis') or '')}", ""]
    return "\n".join(L)


def to_pdf(doc: dict, path: str) -> str | None:
    """Write the PDF; return None on success or the reason it was not written."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.platypus import (Paragraph, SimpleDocTemplate, Spacer, Table,
                                        TableStyle)
    except ImportError:
        return NO_REPORTLAB
    from xml.sax.saxutils import escape

    ss = getSampleStyleSheet()
    body, small = ss["BodyText"], ss["BodyText"].clone("small", fontSize=7.5, leading=9)

    def P(t, st=small):
        return Paragraph(escape("" if t is None else str(t)), st)

    def N(t):
        # One table cell cannot run past a page (reportlab raises LayoutError
        # around 5,500 characters); the longest real basis is ~1,400. A cut is
        # SAID, and the .md beside the PDF carries the full text.
        t = "" if t is None else str(t)
        return P(t if len(t) <= PDF_CELL_MAX else
                 t[:PDF_CELL_MAX] + " ... [cut here for the PDF - the full text is in the "
                 ".md beside it]")

    story = [Paragraph(escape(f"Ops OKR pack - {doc['label']}"), ss["Title"]),
             P(f"{doc['edition']} edition · generated {doc['generated_on']} · from "
               f"{doc['snapshot']}", body),
             Spacer(1, 4 * mm),
             P(f"Operations: {_pct(doc['operations']['pct'])} "
               f"({doc['operations']['scored'] or 0} of {doc['operations']['total'] or 5} "
               "objectives scored; OO1 is Finance's and is excluded)", ss["Heading3"])]
    rag_bg = {"green": colors.HexColor("#d9f2e3"), "amber": colors.HexColor("#fdebc8"),
              "red": colors.HexColor("#f8d4d4")}
    for o in doc["objectives"]:
        head = (f"{o['objective']} - {o['label']}: "
                + ("no % published" if o.get("pct_note") else _pct(o["pct"]))
                + f" ({o['scored'] or 0} of {o['total'] or 5} KRs scored)")
        story += [Spacer(1, 3 * mm), Paragraph(escape(head), ss["Heading4"])]
        data = [[P("KR"), P("Target"), P("Value"), P("Score"), P("Before"), P("Basis or blocker")]]
        style = [("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
                 ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")),
                 ("VALIGN", (0, 0), (-1, -1), "TOP")]
        for i, k in enumerate(o["krs"], start=1):
            hist = ", ".join(f"{mlabel(m)[:3]} {_score_txt(s)}" for m, s in k["history"])
            val = ("score only" if o["objective"] == "OO1" and k["score"] is not None
                   else ("—" if k["value"] is None else k["value"]))
            note = ("NOT MEASURED: " if k.get("blocked") else "") + (k.get("note") or "")
            if k.get("link"):
                note += f" ({k['link'].get('href')})"
            data.append([P(f"{k['kr']} {k['text']}"), P(k["target"]), P(val),
                         P(_score_txt(k["score"])), P(hist), N(note)])
            if k.get("rag") in rag_bg:
                style.append(("BACKGROUND", (3, i), (3, i), rag_bg[k["rag"]]))
        t = Table(data, colWidths=[62 * mm, 20 * mm, 30 * mm, 12 * mm, 22 * mm, 124 * mm],
                  repeatRows=1)
        t.setStyle(TableStyle(style))
        story.append(t)
    s = doc.get("statement")
    story += [Spacer(1, 4 * mm), Paragraph("Supplier statement", ss["Heading4"]),
              P((f"{doc['label']}: {'FINAL' if s['final'] else 'PROVISIONAL'}, generated "
                 f"{s['generated_on']} - {s['url']}") if s else
                f"No supplier statement exists for {doc['label']}.", body),
              Spacer(1, 3 * mm), Paragraph("Gaps (as at this bake)", ss["Heading4"])]
    story += [N("• " + g) for g in doc["gaps"]]
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    try:
        SimpleDocTemplate(tmp, pagesize=landscape(A4), leftMargin=10 * mm, rightMargin=10 * mm,
                          topMargin=10 * mm, bottomMargin=10 * mm,
                          title=f"Ops OKR pack - {doc['label']}").build(story)
    except Exception as e:  # noqa: BLE001 - a layout failure is a missing PDF, not a lost bake
        try:
            os.remove(tmp)
        except OSError:
            pass
        return f"the PDF could not be laid out ({type(e).__name__})"
    os.replace(tmp, path)
    return None


def _write(path, text):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def maybe_render(snap, out_dir, today, dated, forbidden=()):
    """Render the pack if one is due. Returns (written paths, gap lines)."""
    if dated:
        return [], []
    month = prev_month(today[:7])
    # Not until the DATA has left the month (review, 11/10/2026): a bake on the
    # 1st whose newest pull is still the 31st - or a day with no pull at all -
    # would freeze a month-to-date scorecard as "the month as it closed".
    if str(snap.get("pull_date") or "")[:7] <= month:
        return [], []
    pdir = os.path.join(out_dir, PACK_DIR)
    mp = os.path.join(pdir, f"{month}.json")
    try:
        with open(mp, encoding="utf-8") as fh:
            meta = json.load(fh)
    except (OSError, ValueError):
        meta = None
    ed = due(today, meta)
    if not ed:
        return [], []
    doc = build(snap, month, ed, today)
    doc["replaces_first"] = any(e.get("edition") == "first"
                                for e in ((meta or {}).get("editions") or []))
    md = to_md(doc)
    bad = [n for n in forbidden if n in md or n in json.dumps(doc)]
    if bad:
        raise SystemExit("[bake] REFUSING TO WRITE the OKR pack: it carries "
                         + ", ".join(repr(n) for n in bad))
    written, gaps = [], []
    _write(os.path.join(pdir, f"{month}.md"), md)
    written.append(os.path.join(pdir, f"{month}.md"))
    why = to_pdf(doc, os.path.join(pdir, f"{month}.pdf"))
    if why:
        gaps.append(f"OKR pack for {mlabel(month)}: the markdown was written but not the PDF - "
                    f"{why}")
    else:
        written.append(os.path.join(pdir, f"{month}.pdf"))
    # a retried edition (its PDF was missing) replaces its own entry
    eds = [e for e in ((meta or {}).get("editions") or []) if e.get("edition") != ed]
    eds.append({"edition": ed, "generated_on": today[:10], "pdf": why is None,
                "pdf_missing_because": why, "snapshot": doc["snapshot"]})
    _write(mp, json.dumps({"month": month, "label": doc["label"], "editions": eds,
                           "md": f"{PACK_DIR}/{month}.md",
                           "pdf": f"{PACK_DIR}/{month}.pdf" if why is None else None},
                          indent=1) + "\n")
    written.append(mp)
    return written, gaps


def index(out_dir, dated=None):
    """Every pack on disk, newest month first, for the snapshot (a back-bake
    sees only packs whose first edition is on or before its date)."""
    pdir = os.path.join(out_dir, PACK_DIR)
    out = []
    for name in sorted(os.listdir(pdir)) if os.path.isdir(pdir) else []:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(pdir, name), encoding="utf-8") as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(d, dict) and d.get("month"):
            eds = [e for e in (d.get("editions") or []) if isinstance(e, dict)]
            if dated:
                eds = [e for e in eds if (e.get("generated_on") or "9999") <= dated]
                if not eds:
                    continue
            last = eds[-1] if eds else {}
            out.append({"month": d["month"], "md": d.get("md"),
                        "pdf": d.get("pdf") if last.get("pdf") else None,
                        "edition": last.get("edition"), "generated_on": last.get("generated_on"),
                        # the file on disk is the newest edition, which a back-bake
                        # of an earlier date names rather than pretends is its own
                        "file_is_later_edition": bool(dated and eds and
                                                      len(eds) < len(d.get("editions") or []))})
    return sorted(out, key=lambda x: x["month"], reverse=True)
