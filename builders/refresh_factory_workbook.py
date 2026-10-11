#!/usr/bin/env python3
"""Refresh data/ops_command/factory_workbook.json from the factory's Weekly Report workbook.

WHY THIS EXISTS (Phase 3, 11/10/2026). Two OO5 KRs have their only source in
the factory's own Google Sheet, the "AA FACTORY" workbook (the Weekly Report):
  * OO5 KR3, stocktake variance - tab STOCK TAKE VARIANCE - WEEKLY: one row per
    week, 'Week Commencing' and the factory's 'Stocktake Variance Report' %.
  * OO5 KR5, production orders completed in full - tab CLOSING INVENTORY: one
    block per day, product rows by site column, giving which site ordered how
    many units from the factory that day (the brief's "site orders table").

TWO TABS, OPENED BY TITLE, AND NOTHING ELSE. The workbook's other tabs hold
staff names and pay, labour cost, sales and supplier spend. This script never
lists the worksheets and never reads another tab. From the two it does read it
keeps only: per week, the date and the variance cell; per day, per site, how
many product lines it ordered and how many units. No product name, no £, no
person. A self-check refuses to write anything holding an '@', a '£' or a run
of six digits.

THE SHEET ID IS NOT IN THIS FILE, ON PURPOSE. The workbook is shared "anyone
with the link can view", so its id opens the pay data. It comes from
FACTORY_SHEET_ID, set in the private maki-hospitality-etl workflow, and is
never written to the output. Without it: cause no_sheet_id, nothing changes.

READ THE CLOSING INVENTORY GRID, NOT ITS TEXT. Each day block is: a date in
column A; an 'Items' row whose 'Total' cell marks where the site columns end;
a row of site names (Kobas venue names); then one row per product with each
site's quantity, the Total, and the inventory columns. The grid keeps every
cell where it is, so a site's quantity is read under its own name. Each block
CHECKS ITS OWN MAPPING: on every product row with a numeric Total, Total must
equal the sum of the site cells. A block where no row agrees is not published
(its date is named as a problem) - a column that moved would otherwise put one
site's order under another's name.

FAIL SOFT, PART BY PART. The two tabs are read independently: if one cannot be
read, the other is still refreshed and the failed part is carried forward from
the last file with its own read_at, so the bake can say how old it is. The
script always exits 0; factory_workbook_status.json records the outcome with
fixed text (it is public too).
"""

from __future__ import annotations

import argparse
import datetime
import json
import logging
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refresh_okr_sources import _atomic_write, _now, classify  # noqa: E402

log = logging.getLogger("refresh_factory_workbook")

#: From the private workflow only - see THE SHEET ID IS NOT IN THIS FILE.
SHEET_ID = os.environ.get("FACTORY_SHEET_ID", "").strip()
OUT_DIR = os.environ.get("OPS_COMMAND_OUT_DIR", "").strip() or \
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "ops_command")
OUT_FILE = "factory_workbook.json"
STATUS_FILE = "factory_workbook_status.json"
STOCK_TAB = "STOCK TAKE VARIANCE - WEEKLY"
STOCK_RANGE = "A1:B"
ORDERS_TAB = "CLOSING INVENTORY"

CAUSE_TEXT = {
    "ok": "read both tabs",
    "partial": "read one of the two tabs; the other is carried forward from the last read",
    "no_sheet_id": "FACTORY_SHEET_ID is not set for the refresh step, so the workbook "
                   "was not asked for",
    "no_credentials": "GOOGLE_SA_JSON is not set for the refresh step, so the workbook "
                      "was not asked for",
    "credentials_malformed": "GOOGLE_SA_JSON is set but is not a usable service-account key",
    "auth_failed": "Google refused the service account's credentials",
    "not_shared": "HTTP 403 - the factory's Weekly Report workbook is not readable by the "
                  "service account (its link sharing may have been restricted); share it "
                  "with the service account as Viewer",
    "not_found": "HTTP 404 - no workbook with this id is visible to the service account",
    "quota": "HTTP 429 - the Google Sheets API quota was exceeded",
    "google_down": "Google Sheets did not answer (HTTP 5xx, a timeout or a dropped "
                   "connection)",
    "tab_missing": "a tab this script reads was not found under its title (renamed or "
                   "deleted); that part was carried forward from the last read",
    "nothing_parsed": "the tabs opened but neither yielded a single week or day block; "
                      "the last file was left untouched",
    "self_check_failed": "the output held something that looks like personal or money "
                         "data, so it was NOT written; the last file was left untouched",
    "write_failed": "factory_workbook.json could not be written; the last file was left "
                    "in place",
    "unexpected": "an unexpected error - the bake log names its type",
}

#: '@', '£', '+<digit>', six digits in a row, or nine digits however spaced
#: (a phone number written '0131 496 0000'). Dates and quantities never reach
#: nine digits with only spaces, dots, dashes or brackets between them.
_SUSPECT = re.compile(r"@|£|\+\s*\d|\d{6,}|(?:\d[\s().-]?){9,}")
#: A site column's header as Kobas writes a venue: "Maki & Ramen - <venue>".
#: Anything else in the site-name row is published as "(unrecognised column
#: N)", never as itself - the row is hand-typed, in a workbook that also holds
#: staff pay (review, 11/10/2026).
SITE_NAME_RE = re.compile(r"^Maki\s*&\s*Ramen\s*-\s*[A-Za-z][A-Za-z0-9 &'()./-]{0,48}$")


def _site_ok(name: str) -> bool:
    return bool(SITE_NAME_RE.match(name)) and not re.search(r"\d{3,}", name)
_DATE_CELL = re.compile(r"^\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*$")
_PCT_CELL = re.compile(r"^\s*[-+]?(\d+(\.\d*)?|\.\d+)?\s*%?\s*$")
_NUM_CELL = re.compile(r"^\s*[-+]?(\d+(\.\d*)?|\.\d+)\s*$")


def parse_date(cell) -> str | None:
    """'3/8/2026' or '03/08/2026' (day first) -> '2026-08-03'; else None."""
    m = _DATE_CELL.match(str(cell or ""))
    if not m:
        return None
    try:
        return datetime.date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
    except ValueError:
        return None


def _num(cell):
    s = str(cell if cell is not None else "").replace(",", "").strip()
    return float(s) if _NUM_CELL.match(s) else None


# ---- STOCK TAKE VARIANCE - WEEKLY ----------------------------------------------
def build_stocktake(rows) -> dict:
    """A1:B values -> {"rows": [{"row", "week", "variance"}], "blank_rows"}.

    Raw cells, bounded: the bake decides what a row means (a Monday, in order,
    a number). A cell that is neither a date nor a percentage is published as
    '(text)', never as itself. Rows whose variance cell is empty are counted,
    not listed (the tab carries 120-odd pre-dated blank rows).
    """
    rows = [list(r) + ["", ""] for r in (rows or [])]
    out, blank = [], 0
    for i, r in enumerate(rows[1:], start=2):
        a, b = str(r[0] or "").strip(), str(r[1] or "").strip()
        if not b:
            blank += 1
            continue
        out.append({"row": i,
                    "week": a if (not a or _DATE_CELL.match(a)) else "(text)",
                    "variance": b if (len(b) <= 12 and (_PCT_CELL.match(b) or b == "-%"))
                    else "(text)"})
    return {"rows": out, "blank_rows": blank}


# ---- CLOSING INVENTORY -----------------------------------------------------------
def _block_date(r) -> str | None:
    """A day block starts at a row whose column A is a date (or 'DATE' + a date)."""
    if not r:
        return None
    a = str(r[0] or "").strip()
    d = parse_date(a)
    if d is None and a.casefold() == "date" and len(r) > 1:
        d = parse_date(r[1])
    if d is None:
        return None
    # the rest of the row is empty or labels - a product row never starts with a date
    return d


def build_site_orders(grid) -> dict:
    """The CLOSING INVENTORY grid -> {"days": [...], "problems": [...]}.

    days: [{"date", "sites": {site: {"lines", "units"}}, "rows", "total_checked",
            "total_mismatches"}], one per day block whose mapping checks out.
    problems: what was skipped, and why - dates and counts only.
    """
    grid = [list(r) for r in (grid or [])]
    starts = [(i, d) for i, r in enumerate(grid) for d in [_block_date(r)] if d]
    days, problems, seen = {}, [], {}
    for k, (i0, d) in enumerate(starts):
        i1 = starts[k + 1][0] if k + 1 < len(starts) else len(grid)
        block = grid[i0 + 1:i1]
        hi = next((j for j, r in enumerate(block)
                   if r and str(r[0] or "").strip().casefold() == "items"), None)
        if hi is None:
            problems.append(f"{d}: no 'Items' header row - day not read")
            continue
        hdr = [str(c or "").strip().casefold() for c in block[hi]]
        if "total" not in hdr:
            problems.append(f"{d}: the 'Items' row has no 'Total' column - day not read")
            continue
        t_idx = hdr.index("total")
        # the site-name row: the first row below 'Items' holding at least two
        # venue names - a note typed between them is not mistaken for it
        si = next((j for j in range(hi + 1, len(block))
                   if sum(_site_ok(str(c or "").strip()) for c in list(block[j])[:t_idx]) >= 2),
                  None)
        if si is None:
            problems.append(f"{d}: no row of site names under 'Items' - day not read")
            continue
        site_row = list(block[si]) + [""] * (t_idx + 1)
        names = {j: (str(site_row[j]).strip() if _site_ok(str(site_row[j]).strip())
                     else f"(unrecognised column {j + 1})")
                 for j in range(t_idx) if str(site_row[j]).strip()}
        if 0 in names and (t_idx - 1) not in names:
            # the names start in column A: they label the columns one to the right
            names = {j + 1: n for j, n in names.items()}
        names.pop(0, None)
        if not names:
            problems.append(f"{d}: the site-name row is empty - day not read")
            continue
        sites, n_rows, checked, bad = {}, 0, 0, 0
        for r in block[si + 1:]:
            r = r + [""] * (t_idx + 1)
            label = str(r[0] or "").strip()
            if label.casefold() == "items":
                # a second header with no readable date above it: the next
                # day's block under a date this script cannot read. Its rows
                # are NOT this day's - stop, and name it (review, 11/10/2026).
                problems.append(f"{d}: an 'Items' header follows with no readable date above it "
                                "- the rows under it were not read")
                break
            if not label or label.casefold() == "total":
                continue
            qty = {j: _num(r[j]) for j in range(1, t_idx)}
            if not any(q is not None for q in qty.values()) and _num(r[t_idx]) is None:
                continue
            n_rows += 1
            tot = _num(r[t_idx])
            if tot is not None:
                checked += 1
                if abs(tot - sum(q for q in qty.values() if q is not None)) > 0.001:
                    bad += 1
            for j, q in qty.items():
                if q is not None and q > 0:
                    nm = names.get(j) or f"(unnamed column {j + 1})"
                    s = sites.setdefault(nm, {"lines": 0, "units": 0.0})
                    s["lines"] += 1
                    s["units"] = round(s["units"] + q, 3)
        if checked and bad == checked:
            problems.append(f"{d}: Total disagrees with the site columns on every one of "
                            f"{checked} product row(s) - the column map cannot be trusted, "
                            "day not read")
            continue
        if d in seen:
            problems.append(f"{d}: the date appears twice - the later block is used")
        seen[d] = True
        days[d] = {"date": d, "sites": sites, "rows": n_rows, "total_checked": checked,
                   "total_mismatches": bad}
    return {"days": [days[d] for d in sorted(days)], "problems": problems}


def self_check(doc: dict) -> list[str]:
    """Paths of any string holding '@', '£', '+<digit>' or six digits in a row."""
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


def fetch(sheet_id: str, spreadsheet=None) -> dict:
    """{part: rows or an exception} for the two tabs. Never lists the worksheets."""
    if spreadsheet is None:
        from refresh_okr_sources import open_sheet
        spreadsheet = open_sheet(sheet_id)
    out = {}
    for part, title, rng in (("stocktake", STOCK_TAB, STOCK_RANGE),
                             ("site_orders", ORDERS_TAB, None)):
        try:
            ws = spreadsheet.worksheet(title)
            out[part] = ws.get(rng) if rng else ws.get_all_values()
            log.info("read tab %r: %d row(s)", title, len(out[part]))
        except Exception as e:  # noqa: BLE001 - one tab, not the run
            log.error("could not read tab %r (%s)", title, type(e).__name__)
            out[part] = e
    return out


def _prev(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def write_status(path: str, ok: bool, cause: str, http_status=None, parts=None) -> None:
    now = _now()
    try:
        prev = _prev(path)
        rec = {"attempted_at": now, "ok": ok, "cause": cause,
               "detail": CAUSE_TEXT.get(cause, CAUSE_TEXT["unexpected"]),
               "http_status": http_status,
               # per tab: the bake judges each KR by its own tab's outcome
               "parts": {p: {"cause": c, "detail": CAUSE_TEXT.get(c, CAUSE_TEXT["unexpected"])}
                         for p, c in (parts or {}).items()},
               "last_ok_at": now if ok else prev.get("last_ok_at"),
               "failing_since": None if ok else (
                   (prev.get("failing_since") if prev.get("ok") is False else None) or now)}
        _atomic_write(path, json.dumps(rec, indent=1, sort_keys=True) + "\n")
    except Exception as e:  # noqa: BLE001 - diagnostics must never fail the step
        log.warning("could not write %s (%s)", path, type(e).__name__)


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-json", help="parse this dump ({tab title: rows}) instead of "
                                        "calling Google")
    ap.add_argument("--out", default=os.path.join(OUT_DIR, OUT_FILE))
    ap.add_argument("--print", action="store_true", help="print, do not write")
    a = ap.parse_args(argv)
    sheet_id = os.environ.get("FACTORY_SHEET_ID", "").strip() or SHEET_ID
    out_path = os.path.abspath(a.out)
    status_path = os.path.join(os.path.dirname(out_path), STATUS_FILE)
    status = (lambda *x, **k: None) if a.print else \
        (lambda *x, **k: write_status(status_path, *x, **k))

    try:
        if a.from_json:
            with open(a.from_json, encoding="utf-8") as fh:
                raw = json.load(fh)
            got = {"stocktake": raw.get(STOCK_TAB, KeyError(STOCK_TAB)),
                   "site_orders": raw.get(ORDERS_TAB, KeyError(ORDERS_TAB))}
        elif not sheet_id:
            log.error("FACTORY_SHEET_ID is not set - %s left untouched. It is set in the "
                      "private maki-hospitality-etl workflow, never here.", OUT_FILE)
            status(False, "no_sheet_id")
            return 0
        else:
            got = fetch(sheet_id)
    except Exception as exc:  # noqa: BLE001 - fail soft by design
        cause, http = classify(exc)
        log.error("could not open the factory workbook: %s (%s). Leaving %s untouched.",
                  cause, type(exc).__name__, OUT_FILE)
        status(False, cause, http)
        return 0

    prev = _prev(out_path)
    now = _now()
    doc = {"pulled_at": now,
           "basis": ("From the factory's Weekly Report workbook ('AA FACTORY'), two tabs "
                     "only. stocktake: each row of 'STOCK TAKE VARIANCE - WEEKLY' that has "
                     "a variance, as the sheet writes it. site_orders: per day of 'CLOSING "
                     "INVENTORY', per site, how many product lines it ordered from the "
                     "factory and how many units. No product, money or person is kept - "
                     "this repository is public.")}
    parts, http = {}, None
    for part, title in (("stocktake", STOCK_TAB), ("site_orders", ORDERS_TAB)):
        rows = got.get(part)
        if isinstance(rows, BaseException) or rows is None:
            cause = ("tab_missing" if type(rows).__name__ in ("WorksheetNotFound", "KeyError")
                     else classify(rows)[0] if isinstance(rows, BaseException) else "tab_missing")
            if isinstance(rows, BaseException):
                http = http or classify(rows)[1]
            parts[part] = cause
            if isinstance(prev.get(part), dict):
                doc[part] = prev[part]          # carried forward, with its own read_at
            continue
        try:
            body = build_stocktake(rows) if part == "stocktake" else build_site_orders(rows)
        except Exception as exc:  # noqa: BLE001
            log.error("parsing tab %r failed: %s", title, type(exc).__name__)
            parts[part] = "unexpected"
            if isinstance(prev.get(part), dict):
                doc[part] = prev[part]
            continue
        n = len(body["rows"] if part == "stocktake" else body["days"])
        if not n:
            log.error("tab %r yielded nothing to keep", title)
            parts[part] = "nothing_parsed"
            if isinstance(prev.get(part), dict):
                doc[part] = prev[part]
            continue
        doc[part] = {"tab": title, "read_at": now, **body}
        parts[part] = "ok"
        if part == "site_orders":
            log.info("tab %r: %d day(s) %s..%s, %d problem(s)%s", title, n,
                     body["days"][0]["date"], body["days"][-1]["date"], len(body["problems"]),
                     "".join(f"\n    {p}" for p in body["problems"][:20]))
        else:
            log.info("tab %r: %d row(s) with a variance, %d blank", title, n,
                     body["blank_rows"])
    fresh = [p for p, c in parts.items() if c == "ok"]
    if not fresh:
        log.error("neither tab could be refreshed (%s) - %s left untouched",
                  ", ".join(f"{p}: {c}" for p, c in parts.items()), OUT_FILE)
        bad = [c for c in parts.values() if c not in ("tab_missing", "nothing_parsed")]
        status(False, bad[0] if bad else ("tab_missing" if "tab_missing" in parts.values()
                                          else "nothing_parsed"), http, parts)
        return 0
    leaks = self_check(doc)
    if leaks:
        log.error("SELF-CHECK FAILED - %d place(s) look like personal or money data (%s). "
                  "Nothing written.", len(leaks), ", ".join(leaks[:10]))
        status(False, "self_check_failed", None, parts)
        return 0
    if a.print:
        print(json.dumps(doc, indent=1, sort_keys=True))
        return 0
    try:
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        _atomic_write(out_path, json.dumps(doc, indent=1, sort_keys=True,
                                           allow_nan=False) + "\n")
    except Exception as exc:  # noqa: BLE001
        log.error("could not write %s (%s) - previous file left in place", out_path,
                  type(exc).__name__)
        status(False, "write_failed", None, parts)
        return 0
    log.info("wrote %s", out_path)
    whole = len(fresh) == 2
    status(whole, "ok" if whole else "partial", None if a.from_json else 200, parts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
