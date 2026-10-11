"""OO5 KR3 (stocktake variance) and OO5 KR5 (production orders in full) - Phase 3.

Both KRs are about the factory, and both read sources this module owns:

  * data/ops_command/factory_workbook.json - two tabs of the factory's Weekly
    Report workbook, written by builders/refresh_factory_workbook.py: the
    weekly stocktake variance (KR3) and the per-day site orders (KR5's (c)).
  * the 'JFC Factory POs' feed - JFC's weekly POs on the factory and every
    reply in their threads, landed from the mailbox by the ETL's
    pull_jfc_factory_pos.py (KR5's (a)).

The bake (bake_ops_command.py) calls kr3_months() and kr5_months() and drops
their month variants into the scorecard like any other `_okr_extra` row. The
rules live here, in one place, so the tests can pin them without a bake.

DECIMAL, NOT FLOAT. A mean that lands exactly on a band edge (5.00% for
'stock') must score the same on every Python. Sums are Decimal; KR3 rounds
half-up to 0.01; KR5's rate is cut DOWN to 0.1 (ROUND_FLOOR) so a rate is
never rounded into a better band than the one it earned.
"""

from __future__ import annotations

import datetime
import json
import os
import re
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal, InvalidOperation

WORKBOOK_FILE = "factory_workbook.json"
WORKBOOK_STATUS_FILE = "factory_workbook_status.json"
JFC_PO_FEED = "JFC Factory POs"
#: The one factory the Weekly Report workbook speaks for: its venue on the
#: workbook's own supplier tab, and the GetCompliant location of the same name.
FACTORY_NAME = "AA Factory1 Limited"
#: The factory as an issue form's 'Supplier?' answer names it (canon_supplier).
FACTORY_ON_FORMS = "AA Factory"
#: KR3's first month: the scorecard's own earliest month (the OO5 broth rows
#: start there). The stocktake sheet goes back to w/c 30/12/2024.
KR3_FIRST_MONTH = "2025-08"

_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"]
_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_SUSPECT = re.compile(r"@|£|\+\s*\d|\d{6,}")


def mlabel(ym: str) -> str:
    return _MONTHS[int(ym[5:7]) - 1] + " " + ym[:4]


def next_month(ym: str) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    return f"{y + (m == 12)}-{1 if m == 12 else m + 1:02d}"


def month_end(ym: str) -> str:
    return (datetime.date.fromisoformat(next_month(ym) + "-01")
            - datetime.timedelta(days=1)).isoformat()


def dmy(iso: str) -> str:
    return f"{iso[8:10]}/{iso[5:7]}/{iso[:4]}"


def mondays(ym: str) -> list[str]:
    d = datetime.date.fromisoformat(ym + "-01")
    d += datetime.timedelta(days=(7 - d.weekday()) % 7)
    out = []
    while d.isoformat()[:7] == ym:
        out.append(d.isoformat())
        d += datetime.timedelta(days=7)
    return out


# ---------------------------------------------------------------------------
# factory_workbook.json
# ---------------------------------------------------------------------------
def _reject_constant(c):
    raise ValueError(f"non-finite number {c} in {WORKBOOK_FILE}")


def load_workbook(out_dir: str):
    """(doc, err) for factory_workbook.json, type-checked. Never raises."""
    path = os.path.join(out_dir, WORKBOOK_FILE)
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh, parse_constant=_reject_constant)
    except FileNotFoundError:
        return None, "absent"
    except (OSError, ValueError) as e:
        return None, f"unreadable ({type(e).__name__})"
    if not isinstance(doc, dict) or not isinstance(doc.get("pulled_at"), str):
        return None, "unreadable (no pulled_at)"
    st, so = doc.get("stocktake"), doc.get("site_orders")
    if st is not None and not (isinstance(st, dict) and isinstance(st.get("rows"), list)
                               and isinstance(st.get("read_at"), str)):
        return None, "unreadable (stocktake has no rows or no read_at)"
    if so is not None and not (isinstance(so, dict) and isinstance(so.get("days"), list)
                               and isinstance(so.get("read_at"), str)):
        return None, "unreadable (site_orders has no days or no read_at)"
    return doc, None


def load_status(out_dir: str):
    try:
        with open(os.path.join(out_dir, WORKBOOK_STATUS_FILE), encoding="utf-8") as fh:
            s = json.load(fh)
        return s if isinstance(s, dict) else None
    except (OSError, ValueError):
        return None


def workbook_leaks(raw: str) -> list[str]:
    """Paths in factory_workbook.json holding an '@', '£', '+<digit>' or six digits.

    The refresher checks itself; this is the bake's own check, because the file
    rides out to the PUBLIC repo on the bake's push. Locations only.
    """
    if not raw:
        return []
    try:
        doc = json.loads(raw, parse_constant=_reject_constant)
    except ValueError:
        return []
    bad = []

    def walk(x, path):
        if isinstance(x, str):
            if _SUSPECT.search(x):
                bad.append(path)
        elif isinstance(x, dict):
            for k, v in x.items():
                walk(k, f"{path}.<key>")
                walk(v, f"{path}.{k}")
        elif isinstance(x, list):
            for i, v in enumerate(x):
                walk(v, f"{path}[{i}]")
    walk(doc, "$")
    return bad


_PART_LABEL = {"stocktake": "its STOCK TAKE VARIANCE - WEEKLY tab",
               "site_orders": "its CLOSING INVENTORY tab"}


def status_failure(status, part=None) -> str | None:
    """'the latest read of ... failed: <fixed text>' or None.

    With `part`, only THAT tab's outcome counts (review, 11/10/2026): a
    refresh that read the stocktake tab but not CLOSING INVENTORY is a failure
    for KR5's site orders and none for KR3, and the reason given is that tab's
    own (e.g. "not found under its title"), not the run's "partial".
    """
    if not status:
        return None
    at = str(status.get("attempted_at") or "")[:16].replace("T", " ")
    parts = status.get("parts") if isinstance(status.get("parts"), dict) else {}
    if part and part in parts:
        p = parts[part]
        cause = p.get("cause") if isinstance(p, dict) else p
        if cause == "ok":
            return None
        det = p.get("detail") if isinstance(p, dict) else None
        where = _PART_LABEL.get(part, part)
    else:
        if status.get("ok") is not False:
            return None
        cause, det, where = status.get("cause"), status.get("detail"), None
    if not isinstance(det, str) or len(det) > 400 or "@" in det:
        det = None
    return (f"the latest read of the factory's Weekly Report workbook"
            f"{(' (' + where + ')') if where else ''}"
            f"{(' at ' + at + ' UTC') if at else ''} failed: "
            f"{det or str(cause or 'cause not recorded')}")


# ---------------------------------------------------------------------------
# OO5 KR3 - stocktake variance
# ---------------------------------------------------------------------------
_DATE = re.compile(r"^\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*$")


def parse_dmy(s) -> str | None:
    m = _DATE.match(str(s or ""))
    if not m:
        return None
    try:
        return datetime.date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
    except ValueError:
        return None


def parse_pct(s) -> Decimal | None:
    t = str(s or "").strip().rstrip("%").strip()
    if not re.fullmatch(r"[-+]?(\d+(\.\d*)?|\.\d+)", t):
        return None
    try:
        return Decimal(t)
    except InvalidOperation:
        return None


def stocktake_weeks(part: dict):
    """-> (weeks, skipped).

    weeks:   [{"wc", "pct": Decimal, "row"}], ascending - one per week commencing.
    skipped: [{"row", "text", "why", "month"}] - an entered row that is not used,
             with the month whose basis names it.

    A row is used when its date is a Monday, it carries a number, and it comes
    after the previous week used. Anything else is named, never guessed: the
    sheet's 06/02/2026 entry (a Friday, after w/c 21/09/2026) is most likely w/c
    28/09/2026, but the sheet does not say so, and a week moved by this code is
    a week the factory never recorded.
    """
    weeks, skipped, last = [], [], None
    for r in sorted((x for x in part.get("rows") or [] if isinstance(x, dict)),
                    key=lambda x: x.get("row") or 0):
        d, v = parse_dmy(r.get("week")), parse_pct(r.get("variance"))
        cell = str(r.get("variance") or "")[:12]
        expected = (datetime.date.fromisoformat(last) + datetime.timedelta(days=7)).isoformat() \
            if last else None
        if d is None:
            skipped.append({"row": r.get("row"), "text": f"'{cell}' with no week date",
                            "why": "no week-commencing date", "month": (expected or "")[:7]})
            continue
        dow = datetime.date.fromisoformat(d).weekday()
        in_seq = last is None or d > last
        if dow != 0 or not in_seq:
            why = (f"dated {dmy(d)}, a {_DAYS[dow]}" if dow != 0 else f"dated {dmy(d)}")
            if not in_seq:
                why += f", out of sequence after w/c {dmy(last)}"
            if expected:
                why += (f" (if it is w/c {dmy(expected)}, correcting its date on the sheet "
                        f"would count it)")
            skipped.append({"row": r.get("row"), "text": f"{cell} {why}",
                            "why": "not a week in sequence",
                            "month": (expected or d)[:7]})
            continue
        if v is None:
            skipped.append({"row": r.get("row"), "text": f"w/c {dmy(d)} holds '{cell}'",
                            "why": "no variance entered", "month": d[:7]})
            last = d
            continue
        weeks.append({"wc": d, "pct": v, "row": r.get("row")})
        last = d
    return weeks, skipped


def _q2(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _pct_txt(v: Decimal) -> str:
    return f"{_q2(v):+.2f}%".replace("+0.00", "0.00")


def kr3_months(doc, err, status, pull_month, first_month, mvar, score_fn, rag_fn,
               dated=None, asof=None):
    """OO5 KR3 as an `_okr_extra` entry: {"months": [...]} or {"months": None, ...}.

    Value = the MEAN of the ABSOLUTE weekly variances of the weeks commencing in
    the month (band 'stock' scores the size; the sheet does not say what a sign
    means). Shown with the worst week. A CLOSED month is scored only when every
    Monday in it has a week entered - "do not score a short month" - and is
    otherwise shown, unscored, saying which weeks are missing. The open month
    carries 7 days of data per week entered, for the month-to-date rule.
    """
    fail = status_failure(status, "stocktake")
    part = (doc or {}).get("stocktake") if doc else None
    if part is None:
        why = (f"data/ops_command/{WORKBOOK_FILE} is {err}" if err and err != "absent"
               else "the factory's Weekly Report workbook has not been read into this "
                    "repository yet - " + (fail or "no read of it is recorded "
                                           "(builders/refresh_factory_workbook.py has not run)"))
        return {"months": None, "source_kind": "not_measured", "not_measured": why}, \
            [f"OO5 KR3 (stocktake variance) is grey: {why}"]
    read = str(part.get("read_at") or "")[:10]
    if dated and read > dated:
        return {"months": None, "source_kind": "not_measured",
                "not_measured": (f"back-baked snapshot: the copy of the factory's stocktake "
                                 f"sheet on file was read on {read}, after this snapshot's "
                                 f"date ({dated}), so it is not shown here")}, []
    gaps = [f"OO5 KR3: {fail} - figures are from the copy read {read}"] if fail else []
    if asof and read < asof and not fail:
        # the refresher runs before every live bake; an older copy means it did
        # not run or did not reach this tab (review, 11/10/2026)
        gaps.append(f"OO5 KR3: the factory's stocktake sheet was last read {read}, before this "
                    f"bake ({asof}) - weeks entered since are not shown")
    weeks, skipped = stocktake_weeks(part)
    note = (f"From the factory's Weekly Report workbook, tab '{part.get('tab') or 'STOCK TAKE VARIANCE - WEEKLY'}' "
            f"(read {read}{'; ' + fail if fail else ''}): one factory-wide figure per week, "
            f"for the one factory the workbook covers ({FACTORY_NAME}). The sheet does not "
            "say whether a negative variance is a loss or a gain, so the band scores its "
            "SIZE. A closed month is scored only when every week commencing in it is "
            "entered")
    newest = weeks[-1]["wc"] if weeks else None
    out = []
    m = first_month
    while m <= pull_month:
        mons = mondays(m)
        ent = [w for w in weeks if w["wc"][:7] == m]
        skp = [s for s in skipped if s.get("month") == m]
        skp_txt = ("; NOT USED: " + "; ".join(s["text"] for s in skp)) if skp else ""
        after_read = [d for d in mons if d > read]
        if not ent:
            if m == pull_month:
                out.append(mvar(m, mtd=True, score=None, coverage_days=0, basis=(
                    f"month-to-date, not yet scored (0 weeks entered) - no week commencing "
                    f"in {mlabel(m)} is entered on the sheet as read on {read}"
                    + (f"; the newest entry is w/c {dmy(newest)}" if newest else "")
                    + skp_txt + ". " + note)))
            elif mons and len(after_read) == len(mons):
                out.append(mvar(m, not_measured=(
                    f"the copy of the factory's stocktake sheet on file was read on {read}, "
                    f"before any week commencing in {mlabel(m)}")))
            else:
                out.append(mvar(m, not_measured=(
                    f"no week commencing in {mlabel(m)} is entered on the factory's stocktake "
                    f"sheet" + skp_txt)))
            m = next_month(m)
            continue
        total = sum((abs(w["pct"]) for w in ent), Decimal(0))
        mean = _q2(total / len(ent))
        signed = _q2(sum((w["pct"] for w in ent), Decimal(0)) / len(ent))
        worst = max(ent, key=lambda w: (abs(w["pct"]), -int(w["wc"].replace("-", ""))))
        missing = [d for d in mons if d not in {w["wc"] for w in ent}]
        disp = f"{mean}% (worst {_pct_txt(worst['pct'])})"
        basis = (f"Mean ABSOLUTE weekly stocktake variance over the {len(ent)} week(s) "
                 f"commencing in {mlabel(m)}: "
                 + ", ".join(f"w/c {dmy(w['wc'])[:5]} {_pct_txt(w['pct'])}" for w in ent)
                 + f". Worst week: w/c {dmy(worst['wc'])} at {_pct_txt(worst['pct'])}. "
                 f"Signed mean {_pct_txt(signed)}" + skp_txt + ". " + note)
        val = float(mean)
        s = score_fn(val)
        if m == pull_month:
            out.append(mvar(m, value=val, display=disp, score=s, rag=rag_fn(s),
                            coverage_days=7 * len(ent), basis=basis))
        elif missing:
            out.append(mvar(m, value=val, display=f"{disp} - {len(ent)} of {len(mons)} weeks",
                            score=None, rag=None, incomplete=True,
                            basis=(f"not scored - an INCOMPLETE month: "
                                   + ", ".join(f"w/c {dmy(d)}" for d in missing)
                                   + f" {'is' if len(missing) == 1 else 'are'} not entered"
                                   + (f" (or not yet - the copy on file was read on {read})"
                                      if any(d in after_read for d in missing) else "")
                                   + f", so {len(ent)} of {len(mons)} weeks are known - "
                                   + basis)))
        else:
            out.append(mvar(m, value=val, display=disp, score=s, rag=rag_fn(s), basis=basis))
        m = next_month(m)
    return {"months": out, "source_kind": "computed", "tab": "—"}, gaps


# ---------------------------------------------------------------------------
# OO5 KR5 (a) - JFC's POs on the factory
# ---------------------------------------------------------------------------
#: A clause of JFC's own reply that reports a quantity missing. Review,
#: 11/10/2026: the real replies say "didn't receive", "missing", "N cartons
#: short"; the rest are the ways the same thing is commonly written.
SHORT_RE = re.compile(
    r"\bshort\b(?![- ]?(?:dated|notice|staffed|handed))(?! of time)|\bshortage"
    r"|\bmissing\b"
    r"|(?:\bnot|\bnever|n't)\s+(?:been\s+)?(?:received|delivered|arrived|included|sent|come"
    r"|on the (?:pallet|delivery|lorry|van))\b"
    r"|\bdid(?:n't| not)\s+(?:receive|arrive|come|get)\b"
    r"|\bonly\s+(?:received|got|had|came|arrived)\b|\binstead of\b|\bless than (?:ordered|we ordered)"
    r"|\b(?:cartons?|cases?|boxes?|units?)\s+down\b|\bunder[- ]?(?:delivered|supplied)\b"
    r"|\bno\b[^,;.]{0,40}\bon the (?:pallet|delivery|lorry|van)\b", re.I)
#: ...or one damaged. Words, not stems - see bake_ops_command.DAMAGE_RE.
DAMAGE_RE = re.compile(
    r"\bdamag|\bbroken\b|\bburst|\bleak|\bspilt\b|\bspill|\bexplod|\bpunctur|\bsquash"
    r"|\bdented\b|\btorn\b|\bcracked\b|\bcrushed\b|\bsmashed\b", re.I)
#: Extra cartons are NOT a failure (Ross, Phase 3 brief).
EXTRA_RE = re.compile(r"\bextra\b|\bover[- ]?(?:delivered|supplied|shipped)\b|\btoo many\b",
                      re.I)
#: A negator DIRECTLY before the word - "no damage", "nothing missing", "not
#: short". Applied per clause, so "2 cartons missing, no damage to the rest"
#: keeps its shortage.
_NEG_RE = re.compile(r"\b(?:no|nothing|not|none|without)\s+(?:\w+\s+)?"
                     r"(?:missing|short|shortage|damag\w*|broken)\b", re.I)
#: Paperwork, not goods: "missing the credit note", "the invoice is missing".
_PAPER_RE = re.compile(r"\binvoice|\bcredit note|\bdelivery note|\bpaperwork|\bPO number"
                       r"|\bstatement\b|\bprice list|\bpaper", re.I)
#: A follow-up about an EARLIER delivery, not this PO's ("the cases that were
#: missing last week have now arrived").
_EARLIER_RE = re.compile(r"\blast week\b|\bprevious (?:delivery|collection|order|week)\b"
                         r"|\b(?:now|also|finally) (?:arrived|received)\b|\bha(?:s|ve) (?:now )?arrived\b",
                         re.I)
_PO_IN_TEXT = re.compile(r"\bUK\s?(\d{5})\b", re.I)
_CODE_RE = re.compile(r"\bMR\s?0*(\d{1,3})\b", re.I)
_ITEM_CODE = re.compile(r"\b[A-Z]\d{4}\b")
_QTY_RE = re.compile(r"\b(\d{1,4})\s*(cartons?|cases?|ctns?|boxes|box|units?|pallets?|"
                     r"packs?|bottles?|tubs?|bags?)\b", re.I)


def _norm(text: str) -> str:
    """Curly quotes, HTML entities and non-breaking spaces as plain text."""
    import html
    t = html.unescape(text or "")
    return (t.replace("\u2019", "'").replace("\u2018", "'").replace("\u00a0", " ")
            .replace("\u201c", '"').replace("\u201d", '"'))


def _clauses(line: str) -> list[str]:
    return [c.strip() for c in re.split(r"[,;]|\s+but\s+|\s+however\s+", line) if c.strip()]


def classify_reply(text: str, po: str | None = None) -> dict:
    """JFC's own reply text -> {"short", "damaged", "extra": [lines], "unclear": n}.

    One entry per LINE. A line FAILS a PO only when, after dropping any
    negated clause ("no damage to the rest"), a clause reports a shortfall or
    damage AND the line names a product (an MR code or an item code) or a
    quantity - "missing the invoice", "sorry for the short notice" and "the
    delivery note was not included" are not goods. A shortage or damage line
    that names neither is counted as UNCLEAR: it fails nothing on its own, and
    the month that holds it is not scored. A line naming another PO, or about
    an earlier delivery ("missing last week, now arrived"), is skipped. Extra
    cartons are never a failure; a line with both is a shortfall.
    """
    out = {"short": [], "damaged": [], "extra": [], "unclear": 0}
    mine = re.sub(r"\D", "", po or "")
    for ln in logical_lines(_norm(text)):
        s = ln.strip().strip("*").strip()
        if not s:
            continue
        others = [n for n in _PO_IN_TEXT.findall(s) if n != mine]
        if (others and mine) or _EARLIER_RE.search(s):
            continue
        live = [c for c in _clauses(s) if not _NEG_RE.search(c)]
        goods = [c for c in live if not _PAPER_RE.search(c) or _CODE_RE.search(c)
                 or _ITEM_CODE.search(c)]
        named = bool(_CODE_RE.search(s) or _ITEM_CODE.search(s) or _QTY_RE.search(s))
        if any(SHORT_RE.search(c) for c in goods):
            if named:
                out["short"].append(s)
            else:
                out["unclear"] += 1
        elif any(DAMAGE_RE.search(c) for c in goods):
            if named:
                out["damaged"].append(s)
            else:
                out["unclear"] += 1
        elif any(EXTRA_RE.search(c) for c in live):
            out["extra"].append(s)
    return out


_ITEM_START = re.compile(r"^\*?\s*[A-Z]{1,2}\d{3,5}\b")


def logical_lines(text: str) -> list[str]:
    """Physical lines re-joined where the mail client hard-wrapped one.

    JFC's replies wrap at ~76 characters, which can split an item from its
    product code ("...didn't receive X1234 *M&R SOME TARE" / "(MR028) 4/2KG
    at all."). A line of 60+ characters that does not end a sentence is joined
    to the next, unless the next starts a new item line (an item code) or is
    blank.
    """
    out = []
    for ln in (text or "").replace("\r\n", "\n").split("\n"):
        s = ln.strip()
        if (out and s and len(out[-1]) >= 60 and not re.search(r"[.!?:;]\**$", out[-1])
                and not _ITEM_START.match(s)):
            out[-1] = out[-1] + " " + s
        else:
            out.append(s)
    return [x for x in out if x]


def line_summary(line: str) -> str | None:
    """'X1234 *M&R SOME SAUCE (MR005) 4/2KG 1 carton short' -> 'MR005 1 carton'.

    What is PUBLISHED about a failing line: its MR product code(s) and its
    quantity, never the text (which can carry a name). None when the line
    names neither - it still fails the PO, and the basis says 'a line'.
    """
    codes = [f"MR{int(c):03d}" for c in _CODE_RE.findall(line)]
    qty = _QTY_RE.findall(line)
    q = f"{qty[-1][0]} {qty[-1][1].lower()}" if qty else ""
    if not codes and not q:
        return None
    return " ".join(x for x in (", ".join(dict.fromkeys(codes)), q) if x)


def _uk_date(iso_utc: str) -> str:
    try:
        from zoneinfo import ZoneInfo
        t = datetime.datetime.fromisoformat(str(iso_utc).replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=datetime.timezone.utc)
        return t.astimezone(ZoneInfo("Europe/London")).date().isoformat()
    except (ValueError, TypeError, KeyError):
        return str(iso_utc or "")[:10]


_MONTH_RE = ("(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?"
             "|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)")
_MONTH_NUM = {k: i for i, k in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
_EXPL_1 = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?" + _MONTH_RE + r"\b", re.I)
_EXPL_2 = re.compile(r"\b" + _MONTH_RE + r"\s+(\d{1,2})(?:st|nd|rd|th)?\b(?![:/.]\d)", re.I)
#: d/m or d/m/yyyy, not a pack size ("4/2KG", "8/2L")
_EXPL_3 = re.compile(r"(?<![\d/])(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?(?![\d/A-Za-z])")
_WEEKDAY = re.compile(r"\b(mon|tues|wednes|thurs|fri|satur|sun)day\b", re.I)


def collection_date(text: str, sent_iso_utc: str):
    """-> (YYYY-MM-DD or None, how). How JFC's PO says when it will collect.

    In the sentences that mention collecting: an explicit date first ("the
    August 13th collection", "Thursday(8/10)", "Thursday 13/8/2026"); otherwise the named weekday,
    taken as the FIRST such day AFTER the day the PO was emailed - JFC emails on
    Monday "collect on Thursday" (that week) and on Friday "next Thursday" (the
    following week), and both are the first Thursday after. Neither: None.
    """
    sent = _uk_date(sent_iso_utc)
    try:
        s0 = datetime.date.fromisoformat(sent)
    except ValueError:
        return None, "the PO's date is unreadable"
    flat = re.sub(r"\s+", " ", re.sub(r"[*_（）]", lambda m: {"（": "(", "）": ")"}.get(m.group(0), " "),
                                      text or ""))
    sents = [x for x in re.split(r"(?<=[.!?])\s+", flat) if re.search(r"collect", x, re.I)]
    for x in sents:
        for rx, order in ((_EXPL_1, "dm"), (_EXPL_2, "md")):
            mm = rx.search(x)
            if mm:
                if order == "dm":
                    day, mon = int(mm.group(1)), _MONTH_NUM[mm.group(2)[:3].lower()]
                else:
                    mon, day = _MONTH_NUM[mm.group(1)[:3].lower()], int(mm.group(2))
                y = s0.year + (1 if mon < s0.month - 6 else 0)
                try:
                    return datetime.date(y, mon, day).isoformat(), "the date the PO states"
                except ValueError:
                    pass
        mm = _EXPL_3.search(x)
        if mm:
            day, mon = int(mm.group(1)), int(mm.group(2))
            y = (int(mm.group(3)) + (2000 if len(mm.group(3)) == 2 else 0) if mm.group(3)
                 else s0.year + (1 if mon < s0.month - 6 else 0))
            try:
                return datetime.date(y, mon, day).isoformat(), "the date the PO states"
            except ValueError:
                pass
    for x in sents:
        mm = _WEEKDAY.search(x)
        if mm:
            want = [d[:3].lower() for d in _DAYS].index(mm.group(1)[:3].lower())
            ahead = (want - s0.weekday()) % 7 or 7
            return (s0 + datetime.timedelta(days=ahead)).isoformat(), \
                f"the first {_DAYS[want]} after the PO was emailed"
    return None, "the PO names no collection day"


def jfc_pos(rows) -> list[dict]:
    """The feed's rows -> one record per PO, oldest first.

    {"po", "emailed", "collection", "how", "failed", "lines": [published summaries],
     "extra": n, "replies": n, "unclear": n}
    A PO FAILS when a message from JFC in its thread, dated on or after the
    collection (or after the PO when the collection day is unknown), has a line
    reporting a shortfall or damage. Extra cartons never fail it. Messages from
    the factory or from Maki & Ramen are answers, not reports.
    """
    by = {}
    for r in rows or []:
        if isinstance(r, dict) and r.get("PO"):
            by.setdefault(str(r["PO"]), []).append(r)
    out = []
    for po, msgs in by.items():
        msgs.sort(key=lambda r: str(r.get("Message Date") or ""))
        orig = [r for r in msgs if r.get("Kind") == "po" and r.get("Sender Role") == "jfc"]
        # The newest PO message that names a collection day wins (an amended
        # PO); a later one that names none ("please proceed with this PO")
        # does not erase it.
        o = orig[-1] if orig else None
        coll, how = (None, "the PO itself is not in the mailbox")
        for cand in reversed(orig):
            c_, h_ = collection_date(cand.get("Text") or "", cand.get("Message Date"))
            if c_:
                o, coll, how = cand, c_, h_
                break
            if cand is o:
                how = h_
        emailed = _uk_date((o or msgs[0]).get("Message Date"))
        after = coll or emailed
        lines, extra, failed, replies, unclear, last_jfc = [], 0, False, 0, 0, None
        for r in msgs:
            if r.get("Sender Role") != "jfc" or r.get("Kind") == "po":
                continue
            replies += 1
            if _uk_date(r.get("Message Date")) < after:
                continue
            c = classify_reply(r.get("Text") or "", po)
            extra += len(c["extra"])
            unclear += c["unclear"]
            for kind in ("short", "damaged"):
                for ln in c[kind]:
                    failed = True
                    tag = f"{kind} {line_summary(ln) or 'a product line'}"
                    if tag not in lines:
                        lines.append(tag)
        out.append({"po": po, "emailed": emailed, "collection": coll, "how": how,
                    "failed": failed, "lines": lines, "extra": extra, "replies": replies,
                    # a shortage or damage line naming no product or quantity:
                    # it fails nothing, but the PO cannot be called in full
                    "unclear": (unclear if not failed else 0)})
    return sorted(out, key=lambda p: (p["collection"] or p["emailed"], p["po"]))


# ---------------------------------------------------------------------------
# OO5 KR5 - production orders completed in full
# ---------------------------------------------------------------------------
def _floor1(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.1"), rounding=ROUND_FLOOR)


#: Days JFC has to report a short or damaged collection before a PO counts
#: as in full. JFC's real reports came 3 and 4 days after collection (PO
#: 16057, 16238) and the over-delivery note on PO 16135 after 3; a week
#: covers them with margin. A PO younger than this - in JFC's newest pulled
#: replies - is listed as awaiting JFC, not counted, and a CLOSED month holding
#: one is not scored (review, 11/10/2026). Not a scoring band: it decides when
#: a PO's outcome is known, not how good it is.
JFC_REPORT_DAYS = 7


def _plus(iso: str, n: int) -> str:
    return (datetime.date.fromisoformat(iso) + datetime.timedelta(days=n)).isoformat()


def kr5_months(*, pos, jfc_pull, doc, err, status, issues, site_alias, gc_cover,
               gc_answers_through, gc_feed_first, pull_month, first_month, mvar,
               score_fn, rag_fn, asof, dated=None):
    """OO5 KR5 as an `_okr_extra` entry, plus gaps.

    pos          jfc_pos() of the newest 'JFC Factory POs' pull, or None when
                 the feed is absent from this bake
    jfc_pull     that pull's date
    doc/err/status   factory_workbook.json and its status (site_orders part)
    issues       the snapshot's supplier issue forms (suppliers.issues)
    site_alias   {Kobas venue name (as the sheet writes it): GC location name}
    gc_cover     bake.gc_month_cover: month -> (days covered, holes, month end)
    asof         the bake's date

    An order is IN FULL when (a) for a JFC PO, no short or damaged line in
    JFC's replies; (c) for a site's order on the factory's sheet, no issue form
    naming the factory at that site charged to it. (b) Lynas's POs cannot be
    seen and are named, not counted. A PO counts once JFC has had
    JFC_REPORT_DAYS to report on it, in the replies this bake can see. A
    closed month is scored only when every source covers all of it.
    """
    gaps = []
    fail = status_failure(status, "site_orders")
    part = (doc or {}).get("site_orders") if doc else None
    so_why = None
    if part is None:
        so_why = (f"data/ops_command/{WORKBOOK_FILE} is {err}" if err and err != "absent"
                  else "the factory's CLOSING INVENTORY sheet has not been read yet - "
                       + (fail or "builders/refresh_factory_workbook.py has not run"))
    elif dated and str(part.get("read_at") or "")[:10] > dated:
        so_why = (f"the copy of the factory's CLOSING INVENTORY sheet on file was read on "
                  f"{str(part.get('read_at'))[:10]}, after this snapshot's date ({dated})")
        part = None
    days = sorted((d for d in (part or {}).get("days") or []
                   if isinstance(d, dict) and parse_iso(d.get("date"))),
                  key=lambda d: d["date"])
    so_through = min(days[-1]["date"], (dated or "9999-12-31")) if days else ""
    # day blocks the refresher could not read (it names them by date): a month
    # holding one is short, whatever the last day says (review, 11/10/2026)
    dropped = sorted({x[:10] for x in (part or {}).get("problems") or []
                      if isinstance(x, str) and parse_iso(x[:10])})
    if so_why:
        gaps.append(f"OO5 KR5 (production orders in full): the site-orders table is not "
                    f"counted - {so_why}")
    elif fail:
        gaps.append(f"OO5 KR5: {fail} - site orders are from the copy read "
                    f"{str(part.get('read_at'))[:10]}")
    if pos is None:
        gaps.append(f"OO5 KR5 (production orders in full): JFC's POs are not counted - the "
                    f"'{JFC_PO_FEED}' feed is absent from this bake")
    elif jfc_pull and jfc_pull < asof:
        gaps.append(f"OO5 KR5: JFC's PO threads were last read {jfc_pull}, before this bake "
                    f"({asof}) - a short reported since is not counted yet")

    # (a) which POs are known: collected, and JFC has had its week to report
    seen_to = min(jfc_pull or "", asof) if pos is not None else ""
    known, awaiting = [], []
    for p in (pos or []):
        d0 = p["collection"] or p["emailed"]
        if d0 > asof:
            continue                     # not collected yet: not an order completed
        if p["failed"] or (seen_to and _plus(d0, JFC_REPORT_DAYS) <= seen_to):
            known.append(p)              # a reported failure is known at once
        else:
            awaiting.append(p)

    # (c) failures: an issue form naming the factory, charged to that site's
    # latest order on or before the form's date.
    gc_to_kobas = {}
    for kob, gc in (site_alias or {}).items():
        gc_to_kobas.setdefault(gc, set()).add(kob)
    orders_by_site = {}
    for d in days:
        for site in (d.get("sites") or {}):
            orders_by_site.setdefault(site, []).append(d["date"])
    never = sorted(s_ for s_ in orders_by_site
                   if s_ not in (site_alias or {}) and not s_.startswith("(unrecognised"))
    charged, unmatched = {}, []
    for f in issues or []:
        if f.get("supplier") != FACTORY_ON_FORMS:
            continue
        fd = str(f.get("d") or "")[:10]
        cand = []
        for kob in gc_to_kobas.get(f.get("site"), set()) | {f.get("site")}:
            for od in orders_by_site.get(kob, ()):
                if od <= fd:
                    cand.append((od, kob))
        if cand:
            od, kob = max(cand)
            charged.setdefault((od, kob), []).append(fd)
        else:
            unmatched.append(f"{fd} {f.get('site') or 'no site'}")

    out = []
    m = first_month
    while m <= pull_month:
        def _in(p):
            return (p["collection"] or p["emailed"])[:7] == m
        a_pos = [p for p in known if _in(p)]
        a_wait = [p for p in awaiting if _in(p)]
        a_unclear = [p for p in a_pos if p.get("unclear")]
        c_orders = [(d["date"], s_) for d in days if d["date"][:7] == m
                    for s_ in sorted(d.get("sites") or {})]
        a_bad = [p for p in a_pos if p["failed"]]
        c_bad = [(od, s_) for od, s_ in c_orders if (od, s_) in charged]
        drop_m = [x for x in dropped if x[:7] == m]
        n = len(a_pos) + len(c_orders)
        open_ = m == pull_month
        me = month_end(m)
        why, gc_only = [], True
        if pos is None:
            why.append(f"JFC's POs are not read in this bake (the '{JFC_PO_FEED}' feed is absent)")
            gc_only = False
        elif a_wait and not open_:
            why.append(f"{len(a_wait)} JFC PO(s) collected in {mlabel(m)} have not had "
                       f"{JFC_REPORT_DAYS} days for JFC to report in the replies read "
                       f"({seen_to or 'none'})")
            gc_only = False
        if a_unclear:
            why.append(f"JFC's replies on {', '.join('PO ' + p['po'] for p in a_unclear)} mention a "
                       "shortage or damage without naming a product or quantity")
            gc_only = False
        if so_why:
            why.append(f"the site-orders table is not counted ({so_why})")
            gc_only = False
        elif not open_ and so_through < me:
            why.append(f"the factory's CLOSING INVENTORY sheet reaches only "
                       f"{so_through or 'no day'}")
            gc_only = False
        if drop_m and not so_why:
            why.append(f"the CLOSING INVENTORY day block(s) for {', '.join(dmy(x)[:5] for x in drop_m)} "
                       "could not be read (the refresher names why)")
            gc_only = False
        ncov, holes, _ = gc_cover(m)
        if gc_feed_first and m + "-01" < gc_feed_first <= me:
            why.append(f"the issue-form feed starts {gc_feed_first}")
        if holes:
            why.append(f"no pull of the issue-form feed covers {', '.join(dmy(h)[:5] for h in holes)}")
        if not open_ and (not gc_answers_through or gc_answers_through < me):
            why.append(f"the issue-form feed reaches only {gc_answers_through or 'no day'}")
        a_good = len(a_pos) - len(a_bad)
        a_txt = ((f"(a) {len(a_pos)} JFC PO(s) collected in {mlabel(m)}, {a_good} in full"
                  + (": " + "; ".join(
                      f"PO {p['po']} ({'collected ' + dmy(p['collection'])[:5] if p['collection'] else 'emailed ' + dmy(p['emailed'])[:5] + ', collection day not stated'})"
                      + (" NOT IN FULL - " + ", ".join(p["lines"]) if p["failed"] else "")
                      + (f", {p['extra']} extra line(s) not counted" if p["extra"] else "")
                      for p in a_pos) if a_pos else "")
                  + ("; AWAITING JFC'S REPORT, not counted: " + "; ".join(
                      f"PO {p['po']} ({'collected ' + dmy(p['collection'])[:5] if p['collection'] else 'emailed ' + dmy(p['emailed'])[:5]})"
                      for p in a_wait) if a_wait else "")
                  + (f" - JFC's replies as read on {jfc_pull}" if jfc_pull else ""))
                 if pos is not None else "(a) JFC's POs: not read")
        c_txt = (f"(c) {len(c_orders)} site order(s) on the factory across "
                 f"{len({od for od, _ in c_orders})} day(s) of its CLOSING INVENTORY sheet"
                 + (f" (read {str(part.get('read_at'))[:10]})" if part else "")
                 + (": NOT IN FULL - " + "; ".join(
                     f"{s_} {dmy(od)[:5]} (issue form naming the factory on "
                     + ", ".join(dmy(x)[:5] for x in charged[(od, s_)]) + ")"
                     for od, s_ in c_bad) if c_bad else "")
                 if not so_why else "(c) site orders: not counted")
        rule = ("An order is in full unless JFC's replies in its PO thread report a short or "
                "damaged line naming a product or quantity (extra cartons are not a failure), "
                f"counted once JFC has had {JFC_REPORT_DAYS} days to report; or - for a site's "
                "order - an issue form names the factory at that site, charged to the site's "
                "latest order on or before the form's date, since the sheet records the day an "
                "order is logged, not a delivery date. No issue form has ever named the factory "
                "(GetCompliant's Supplier? list does not offer it), so (c) fails only if that "
                "changes"
                + (f"; orders from {', '.join(never)} can never fail - no GetCompliant location "
                   "files issue forms for them" if never else "")
                + ". (b) Lynas's POs on the factory are NOT counted: they go to the factory's "
                "own mailbox, not the one this system reads")
        if unmatched and any(u[:7] == m for u in unmatched):
            rule += ("; issue forms naming the factory with no order to charge: "
                     + ", ".join(u for u in unmatched if u[:7] == m))
        cov = _cov(m, [so_through if not so_why else "", gc_answers_through,
                       seen_to if pos is not None else ""], holes + [x for x in drop_m])
        if n == 0:
            if open_:
                out.append(mvar(m, mtd=True, score=None, coverage_days=cov, basis=(
                    f"month-to-date, not yet scored ({cov} day(s) of data) - no JFC PO "
                    f"known and no site order logged in {mlabel(m)} yet. {a_txt}. {rule}")))
            else:
                out.append(mvar(m, not_measured=(
                    f"no JFC PO known and no site order logged in {mlabel(m)}"
                    + (" - " + "; ".join(why) if why else ""))))
            m = next_month(m)
            continue
        good = n - len(a_bad) - len(c_bad)
        val = _floor1(Decimal(100 * good) / Decimal(n))
        disp = (f"{val}% ({good} of {n})"
                + (f" - JFC {a_good} of {len(a_pos)}" if pos is not None and a_pos else ""))
        basis = (f"{good} of {n} production order(s) in {mlabel(m)} completed in full. "
                 f"{a_txt}. {c_txt}. {rule}")
        s_ = score_fn(float(val))
        if open_:
            if why:
                # a source is missing: shown as counts, with no value the
                # month-to-date rule could score
                out.append(mvar(m, mtd=True, score=None, coverage_days=cov,
                                basis=(f"month-to-date, not yet scored - {'; '.join(why)}. So "
                                       f"far: {disp} - " + basis)))
            else:
                out.append(mvar(m, value=float(val), display=disp, score=s_, rag=rag_fn(s_),
                                coverage_days=cov, basis=basis))
        elif why:
            # "upper bound" only when every reason is unseen issue forms, which
            # can only ADD failures; a missing source of orders moves it either way
            out.append(mvar(m, value=float(val), display=disp, score=None, rag=None,
                            incomplete=True,
                            basis=(f"not scored - an INCOMPLETE month: {'; '.join(why)}, so "
                                   + (f"{val}% is an upper bound" if gc_only else
                                      f"{val}% is partial - the missing part could move it "
                                      "either way")
                                   + " - " + basis)))
        else:
            out.append(mvar(m, value=float(val), display=disp, score=s_, rag=rag_fn(s_),
                            basis=basis))
        m = next_month(m)
    return {"months": out, "source_kind": "computed", "tab": "—"}, gaps


def parse_iso(s) -> str | None:
    try:
        return datetime.date.fromisoformat(str(s)[:10]).isoformat() if s else None
    except ValueError:
        return None


def _cov(m: str, throughs, holes) -> int:
    """Days of month m (from the 1st) that EVERY source reaches, less holes."""
    if any(not t for t in throughs):
        return 0
    end = min(min(t[:10] for t in throughs), month_end(m))
    if end < m + "-01":
        return 0
    n = (datetime.date.fromisoformat(end) - datetime.date.fromisoformat(m + "-01")).days + 1
    return n - sum(1 for h in holes if m + "-01" <= h <= end)


def published_leaks(variants) -> list[str]:
    """Any '@' or long digit run in KR5's published text - a name or a number
    from a reply must never reach the public snapshot."""
    bad = []
    for v in variants or []:
        for k in ("basis", "display", "not_measured"):
            t = v.get(k)
            if isinstance(t, str) and re.search(r"@|\+\s*\d|\d{7,}", t):
                bad.append(f"{v.get('m')}.{k}")
    return bad
