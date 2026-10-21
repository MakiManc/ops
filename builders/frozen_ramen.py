"""OO6 (Frozen Ramen) - what counts as frozen ramen, and KR3's weekly stock count.

Two OO6 KRs read the same definition of "frozen ramen", so it lives here once:

  * OO6 KR1's REFERENCE figure (Ross, 21/10/2026): the delivery/supplier issue
    forms in the month that mention frozen ramen, shown beside Matthew's typed
    availability % - for reference only, never scored.
  * OO6 KR3 (Ross, 21/10/2026): the % of locations with a frozen-ramen count in
    the week, from the weekly stock count report Ross drops into a Drive
    folder. builders/refresh_frozen_stock.py reads the newest report(s) into
    data/ops_command/frozen_stock_count.json; kr3_months() below scores it.

STDLIB ONLY. The bake - and the verifier's recompute, which installs nothing
but duckdb - imports this module. The Drive reader is a separate file the bake
never imports.

WHAT IS PUBLISHED. The stock-count copy is committed to the PUBLIC ops repo on
the same push as the snapshot, so it carries location labels, the product
names that matched, line counts and dates - never a quantity (a stock level is
not needed to know a count was done), a file name or id, the folder id, the
counter's name, a money value or a free-text cell. stock_leaks() is the bake's
refusal, as factory_kpis.workbook_leaks() is for the factory workbook.
"""

from __future__ import annotations

import datetime
import json
import os
import re
from decimal import ROUND_FLOOR, Decimal

#: Frozen ramen, by name. Checked against the archive (21/10/2026): on Kobas's
#: stock lines it matches only the four 'Frozen Ramen - ...' lines and the two
#: 'M&R ... Ramen' ones; on JFC's PO lines 'M&R HELL RAMEN 5/700G' and the like.
#: It must NOT match RAMEN NOODLES, (VEGAN) TONKOTSU RAMEN SOUP, ARIAKE RAMEN
#: SOUP TONKOTSU, SQUID FOR RAMEN, 'Prawn use for seafood ramen', RAMEN RUMP,
#: M&R CHICKEN/TONKOTSU BROTH FROZEN, M&R CHICKEN PASTE or FROZEN COOKED
#: OCTOPUS - a bare "ramen" or "frozen" test matches every one of them.
#: The last branch takes the misspelling a real form used ('M&R black
#: tonkontsu ramen', Leicester 09/10/2026).
FROZEN_RAMEN_RE = re.compile(
    r"\bfrozen\s*ramen\b"
    r"|\bM\s*&\s*R\s+(?:(?:truffle\s+)?chicken|hell|laksa)\s+ramen\b"
    r"|\bM\s*&\s*R\s+black\s+garlic\s+tonkotsu\b(?!\s+broth)"
    r"|\b5\s*/\s*700\s*g\b"
    r"|\bM\s*&\s*R\s+black\s+(?:garlic\s+)?tonk\w*\s+ramen\b",
    re.I)


def is_frozen_ramen(text) -> bool:
    return bool(text) and FROZEN_RAMEN_RE.search(str(text)) is not None


# ---------------------------------------------------------------------------
# OO6 KR3 - the weekly stock count
# ---------------------------------------------------------------------------
STOCK_FILE = "frozen_stock_count.json"
STOCK_STATUS_FILE = "frozen_stock_count_status.json"
#: OO6 is scored from October 2026 (Ross, 21/10/2026: "Yes, from October").
OO6_FIRST_MONTH = "2026-10"

_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"]
#: Anything in the published copy that could be a contact, a money value, a
#: long number or a Drive id: the bake refuses the file outright.
_SUSPECT = re.compile(r"@|£|\+\s*\d|\d{6,}|(?:\d[\s().-]?){9,}")
_ID_LIKE = re.compile(r"[-\w]{25,}")
_STAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?Z")
#: The keys a week may carry, and a location record's.
_WEEK_KEYS = {"week_commencing", "week_from", "report_modified_at", "read_at", "kind",
              "columns", "rows_read", "frozen_lines", "items_matched", "locations",
              "unrecognised_locations", "problems"}
_LOC_KEYS = {"lines", "counted"}


def mlabel(ym: str) -> str:
    return _MONTHS[int(ym[5:7]) - 1] + " " + ym[:4]


def next_month(ym: str) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    return f"{y + (m == 12)}-{1 if m == 12 else m + 1:02d}"


def month_end(ym: str) -> str:
    return (datetime.date.fromisoformat(next_month(ym) + "-01")
            - datetime.timedelta(days=1)).isoformat()


def mondays(ym: str) -> list[str]:
    d = datetime.date.fromisoformat(ym + "-01")
    d += datetime.timedelta(days=(7 - d.weekday()) % 7)
    out = []
    while d.isoformat()[:7] == ym:
        out.append(d.isoformat())
        d += datetime.timedelta(days=7)
    return out


def dm(iso: str) -> str:
    return f"{iso[8:10]}/{iso[5:7]}"


def _floor1(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.1"), rounding=ROUND_FLOOR)


def _bad(s: str, path: str = "") -> bool:
    if _SUSPECT.search(s) or _ID_LIKE.search(s):
        return True
    # the file's own basis is fixed prose; every other string is a label
    return len(s) > (1000 if path == "basis" else 120)


def _walk(o, path=""):
    """(path, string, is_key) for every key and string value in a JSON value.
    A key that fails the check is named by its position, never by itself -
    the path is printed, and a location label IS a key."""
    if isinstance(o, dict):
        for i, (k, v) in enumerate(o.items()):
            seg = str(k) if not _bad(str(k)) else f"[key {i + 1}]"
            here = f"{path}.{seg}" if path else seg
            yield here, str(k), True
            yield from _walk(v, here)
    elif isinstance(o, list):
        for i, v in enumerate(o):
            yield from _walk(v, f"{path}[{i}]")
    elif isinstance(o, str):
        yield path, o, False


def stock_leaks(raw: str) -> list[str]:
    """Where the frozen_stock_count.json TEXT holds something that must not be
    published, or []. Paths only, never the value - the bake log names where
    to look, not what was found."""
    if not raw:
        return []
    try:
        doc = json.loads(raw)
    except ValueError:
        return ["(the file is not JSON)"]
    bad = []
    for path, s, is_key in _walk(doc):
        if path.endswith("_at") and not is_key:
            # a stamp is digits by design - so it must be exactly a stamp
            if not _STAMP.fullmatch(s):
                bad.append(path)
            continue
        if _bad(s, path):
            bad.append(path)
    weeks = doc.get("weeks") if isinstance(doc, dict) else None
    for wk, w in (weeks.items() if isinstance(weeks, dict) else []):
        wk_ = str(wk) if not _bad(str(wk)) else "[a week key]"
        if not isinstance(w, dict) or not set(w) <= _WEEK_KEYS:
            bad.append(f"weeks.{wk_} (unexpected fields)")
            continue
        locs = w.get("locations")
        for rec in (locs.values() if isinstance(locs, dict) else []):
            if not isinstance(rec, dict) or not set(rec) <= _LOC_KEYS:
                bad.append(f"weeks.{wk_}.locations (unexpected fields)")
                break
    return bad


def _reject_constant(c):
    raise ValueError(f"non-finite number {c}")


def _count(v):
    return v if type(v) is int and v >= 0 else None


def load_stock(out_dir: str):
    """(doc, err). doc is None when the file is absent (err 'absent') or
    unusable; a week that fails its type check is dropped and named in
    doc['_problems'], never coerced."""
    path = os.path.join(out_dir, STOCK_FILE)
    try:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh, parse_constant=_reject_constant)
    except FileNotFoundError:
        return None, "absent"
    except (OSError, ValueError) as e:
        return None, f"unreadable ({type(e).__name__})"
    if not isinstance(raw, dict) or not isinstance(raw.get("weeks"), dict):
        return None, "unreadable (no 'weeks' object)"
    weeks, probs = {}, []
    for wk, w in raw["weeks"].items():
        try:
            ok = (isinstance(w, dict) and datetime.date.fromisoformat(wk).weekday() == 0
                  and w.get("week_commencing") == wk and isinstance(w.get("locations"), dict)
                  and isinstance(w.get("read_at"), str))
        except (TypeError, ValueError):
            ok = False
        if not ok:
            probs.append(f"week {str(wk)[:10]}: not the shape this reads - ignored")
            continue
        locs = {}
        for lab, rec in w["locations"].items():
            ln, ct = _count((rec or {}).get("lines")), _count((rec or {}).get("counted"))
            if not isinstance(lab, str) or ln is None or ct is None or ct > ln:
                probs.append(f"week {wk}: a location record is not two whole counts - ignored")
                continue
            locs[lab] = {"lines": ln, "counted": ct}
        weeks[wk] = {**{k: w.get(k) for k in _WEEK_KEYS}, "locations": locs}
    return {"pulled_at": raw.get("pulled_at"), "weeks": weeks, "_problems": probs}, None


def load_status(out_dir: str):
    try:
        with open(os.path.join(out_dir, STOCK_STATUS_FILE), encoding="utf-8") as fh:
            st = json.load(fh)
        return st if isinstance(st, dict) else None
    except (OSError, ValueError):
        return None


def status_failure(status):
    """One clause naming why the latest read of the folder failed, or None.
    `detail` is the refresher's fixed text for its cause."""
    if not status or status.get("ok") is not False:
        return None
    det = status.get("detail") if isinstance(status.get("detail"), str) else None
    if det and (len(det) > 400 or "@" in det):
        det = None
    at = str(status.get("attempted_at") or "")[:16].replace("T", " ")
    since = str(status.get("failing_since") or "")[:10]
    return (f"the latest read of the stock count folder{(' (' + at + ' UTC)') if at else ''} "
            f"failed: {det or status.get('cause') or 'cause not recorded'}"
            + (f" (failing since {since})" if since and since != at[:10] else ""))


def _norm(label: str) -> str:
    s = re.sub(r"^\s*maki\s*&\s*ramen\s*-\s*", "", str(label or ""), flags=re.I)
    return re.sub(r"[^a-z0-9/&]+", " ", s.lower()).strip()


def site_matcher(sites):
    """sites: [(display label, [names it goes by])] -> label -> display or None."""
    idx = {}
    for disp, names in sites:
        for n in list(names) + [disp]:
            if n:
                idx.setdefault(_norm(n), disp)
    return lambda lab: idx.get(_norm(lab))


def kr3_months(doc, err, status, sites, first_month, pull_month, mvar, score_fn, rag_fn,
               asof, dated=None):
    """OO6 KR3 as an `_okr_extra` entry, plus gaps.

    sites   [(display label, [names])]: EVERY location the KR is over - the
            denominator is this list, never the locations the report happens
            to name (a location missing from the report is not counted)
    A location is COUNTED in a week when the report gives at least one of its
    frozen-ramen lines a number - 0 included; a blank is not a count. A month
    is the weeks COMMENCING in it, pooled: location-weeks counted over
    location-weeks due. A closed month is scored only when every Monday in it
    has a report; the month in progress scores under the month-to-date rule.
    """
    gaps = []
    fail = status_failure(status)
    n_sites = len(sites)
    if doc is None:
        why = (f"data/ops_command/{STOCK_FILE} is {err}" if err and err != "absent" else
               "no weekly stock count report has been read yet - "
               + (fail or "builders/refresh_frozen_stock.py has not run"))
        gaps.append(f"OO6 KR3 is grey: {why}")
        return {"months": None, "source_kind": "not_measured", "not_measured": why,
                "tab": "—"}, gaps
    if not n_sites:
        why = "the builder's location list for OO6 KR3 is empty"
        gaps.append(f"OO6 KR3 is grey: {why}")
        return {"months": None, "source_kind": "not_measured", "not_measured": why,
                "tab": "—"}, gaps
    weeks = dict(doc.get("weeks") or {})
    held = sorted(wk for wk, w in weeks.items()
                  if dated and str(w.get("read_at") or "")[:10] > dated)
    for wk in held:
        weeks.pop(wk)
    if held:
        gaps.append(f"back-baked snapshot: {len(held)} stock count week(s) read after "
                    f"{dated} are not shown here - the copy is current state only")
    if fail:
        gaps.append(f"OO6 KR3: {fail} - the weeks shown are those read before it")
    for p in doc.get("_problems") or []:
        gaps.append(f"{STOCK_FILE}: {p}")
    match = site_matcher(sites)
    labels = [d for d, _ in sites]

    def week_facts(wk):
        w = weeks[wk]
        counted, blank, outside = set(), set(), set()
        for lab, rec in (w.get("locations") or {}).items():
            site = match(lab)
            if site is None:
                outside.add(lab)
            elif rec["counted"] >= 1:
                counted.add(site)
            else:
                blank.add(site)
        blank -= counted
        return counted, blank, outside, w

    rule = ("A location is counted in a week when Ross's weekly stock count report gives at "
            "least one of its frozen-ramen lines a number (0 is a count; a blank is not). "
            f"Over EVERY location on the builder's list ({n_sites}: {', '.join(labels)}), so "
            "a location the report leaves out is not counted. A month is the weeks commencing "
            "in it, pooled; a closed month is scored only when every one of its weeks has a "
            "report. Frozen ramen is matched by name (builders/frozen_ramen.py)")
    out = []
    m = first_month
    today = min(asof, dated) if dated else asof
    while m <= pull_month:
        open_ = m == pull_month
        due = [w for w in mondays(m) if w <= today]
        have = [w for w in due if w in weeks]
        missing = [w for w in due if w not in weeks and (not open_ or (have and w < have[-1]))]
        if not have:
            if open_:
                out.append(mvar(m, mtd=True, score=None, coverage_days=0, basis=(
                    f"month-to-date, not yet scored (0 days of data) - no stock count report "
                    f"read for a week commencing in {mlabel(m)} yet. {rule}")))
            else:
                out.append(mvar(m, not_measured=(
                    f"no stock count report read for any week commencing in {mlabel(m)}"
                    + (f" - {fail}" if fail else ""))))
            m = next_month(m)
            continue
        got, parts, outside_all = 0, [], set()
        for wk in have:
            counted, blank, outside, w = week_facts(wk)
            got += len(counted)
            outside_all |= outside
            not_c = [lb for lb in labels if lb not in counted]
            parts.append(f"w/c {dm(wk)}: {len(counted)} of {n_sites}"
                         + (f" (not counted: {', '.join(not_c)}"
                            + (f"; listed with no number: {', '.join(sorted(blank))}" if blank else "")
                            + ")" if not_c else "")
                         + f" - report {w.get('kind') or 'file'} read {str(w.get('read_at'))[:10]}"
                         + (", week from the file's date" if w.get("week_from") == "modified_time"
                            else ""))
        due_n = n_sites * len(have)
        val = _floor1(Decimal(100 * got) / Decimal(due_n))
        disp = (f"{val}% ({got} of {n_sites})" if len(have) == 1 else
                f"{val}% ({got} of {due_n} location-weeks, {len(have)} weeks)")
        basis = (f"{got} of {due_n} location-weeks counted in {mlabel(m)}: " + "; ".join(parts)
                 + (f". Not on the location list, so not counted: {', '.join(sorted(outside_all))}"
                    if outside_all else "") + f". {rule}")
        s_ = score_fn(float(val))
        cov = sum(1 for wk in have for i in range(7)
                  if (datetime.date.fromisoformat(wk) + datetime.timedelta(days=i)).isoformat()
                  <= min(today, month_end(m)))
        if missing:
            why = (f"no stock count report read for the week(s) commencing "
                   f"{', '.join(dm(w) for w in missing)}")
            if open_:
                out.append(mvar(m, mtd=True, score=None, coverage_days=cov, basis=(
                    f"month-to-date, not yet scored - {why}, so the month cannot be complete. "
                    f"So far: {disp} - " + basis)))
            else:
                out.append(mvar(m, value=float(val), display=disp, score=None, rag=None,
                                incomplete=True, basis=(
                                    f"not scored - an INCOMPLETE month: {why}, so {val}% covers "
                                    f"{len(have)} of {len(due)} weeks - " + basis)))
        else:
            out.append(mvar(m, value=float(val), display=disp, score=s_, rag=rag_fn(s_),
                            coverage_days=cov, basis=basis))
        m = next_month(m)
    return {"months": out, "source_kind": "stock_report", "tab": "—"}, gaps


# ---------------------------------------------------------------------------
# OO6 KR1's reference figure - frozen-ramen issue forms
# ---------------------------------------------------------------------------
def forms_reference(issues, m, cover, open_):
    """The month's delivery/supplier issue forms that mention frozen ramen:
    {"label", "value", "display", "basis"} - shown beside OO6 KR1, never scored.

    issues  the snapshot's suppliers.issues (delivery/supplier templates only)
    cover   (days the answer feed covers in m, its holes in m, month end), or
            None when the issue feed is absent from this bake
    """
    label = "Frozen ramen on issue forms (reference, not scored)"
    if cover is None:
        return {"label": label, "value": None, "display": "—",
                "basis": "the GetCompliant answer feed is absent from this bake, so the issue "
                         "forms cannot be counted"}
    hits = sorted((i for i in issues or [] if str(i.get("d") or "")[:7] == m
                   and is_frozen_ramen(i.get("issue_text"))),
                  key=lambda i: (i.get("d") or "", i.get("site") or ""))
    ncov, holes, me = cover
    short = bool(holes) or ncov < int(me[8:10])
    n = len(hits)
    disp = f"{n}" + (" so far" if open_ else "+" if short else "")
    basis = (f"{n} delivery/supplier issue form(s) answered in {mlabel(m)} mention frozen ramen"
             + (": " + "; ".join(f"{dm(i['d'])} {i.get('site') or 'no site'} ("
                                 f"{i.get('supplier') or 'no supplier named'})" for i in hits)
                if hits else "")
             + (f". The answer feed covers {ncov} day(s) of the month" if short else "")
             + (" (no pull covers " + ", ".join(dm(h) for h in holes) + ")" if holes else "")
             + (", so this is a lower bound" if short and not open_ else "")
             + ". For reference beside the KR, which is Matthew's typed availability %: it is "
             "never scored, and a form is not proof an item was unavailable")
    return {"label": label, "value": n, "display": disp, "basis": basis}
