#!/usr/bin/env python3
"""Refresh data/ops_command/okr_sheet.json from Matthew's 2026 Operations Input sheet.

WHY THIS EXISTS. The Overview scorecard was built from the Master Operating
Manual. Ross is scored on a different list - the "2026 Operations Input" sheet
that Matthew owns - and several of its KRs have no feed anywhere in this
system: they are TYPED INTO THE SHEET and nowhere else. Those are:

  * OO2 KR3  unplanned restaurant closures                  (a log tab)
  * OO3 KR3  menu items unavailable due to supply failure    (a log tab)
  * OO4 KR1  service disruptions caused by logistics delays  (a log tab)
  * OO4 KR4  % of delivery credit notes and refunds actioned (Finance-entered)
  * OO6 KR1  supply chain availability %, typed monthly by Matthew (Ross,
             21/10/2026), on the '2026 OKRs' tab
  * OO6 KR2's "all POs invoiced: yes/no" for the month, typed beside it -
             not a KR on its own: half of KR2's test, read by the bake

OO1 IS NOT READ HERE ANY MORE (Ross, 15/10/2026). It used to be read from the
'2026 Summary' tab as Finance's 0/50/80/100 scores; Ross moved it to Finance's
management-account summary, read on the 7th of each month by
builders/oo1_ma.py. The '2026 Summary' tab is no longer asked for, and the
bake refuses an okr_sheet.json that carries an OO1 series.

This script is the only path those numbers have into the dashboard. Everything
else on the scorecard is computed from the warehouse and must NOT come from
here - see THE SHEET IS NOT A FALLBACK below.

FAIL SOFT, ALWAYS, AND SAY WHY (Phase 1, 10/10/2026). If the sheet cannot be
read - access not granted, tab renamed, Google down - this leaves the existing
committed okr_sheet.json untouched, exits 0, and writes okr_sheet_status.json
beside it:

    {"attempted_at", "ok", "cause", "detail", "http_status", "last_ok_at",
     "failing_since", "series_read", "series_missing"}

`cause` is one of the codes in CAUSE_TEXT below, and `detail` is that code's
FIXED text - never an exception message, because the file is committed to the
PUBLIC ops repo and a Google error body can quote anything. The exception
type and message go to the bake log only (maki-hospitality-etl is private).
The bake reads the status and names the cause on the grey rows.

A PARTIAL READ NEVER LOSES DATA. If one tab is renamed or has changed shape,
that series is CARRIED FORWARD from the previous okr_sheet.json with its
own older pulled_at, and named in series_missing. Before 10/10/2026 a renamed
tab rewrote the file without that series and flipped every scored month of it
to "not entered" with nothing recording why.

  ---------------------------------------------------------------------------
  ACCESS: THE SHEET IS NOT SHARED WITH US YET (checked 10/10/2026)
  ---------------------------------------------------------------------------
  The Operations Input sheet is shared to the makiramen.com domain and to named
  users. A service account address ends .iam.gserviceaccount.com and is NOT a
  member of that domain, so domain-wide sharing does not reach it. Expect a
  403 (cause not_shared) until Matthew shares the file explicitly with the
  client_email inside GOOGLE_SA_JSON as Viewer. That is not a bug in this
  script and it must not fail the bake: the rows it feeds stay grey with that
  blocker named.
  ---------------------------------------------------------------------------

  ---------------------------------------------------------------------------
  GIDS: NOT KNOWN YET, SO THIS SCRIPT DISCOVERS AND LOGS THEM
  ---------------------------------------------------------------------------
  Tabs are found by OKR_GID_<NAME> if set, else by an EXACT title match from
  TAB_TITLES. One tab is literally named 'Unplanned Restarant Closures '
  (misspelt, trailing space) - exactly the kind of title somebody fixes one
  afternoon - so the first run that can open the sheet LOGS every worksheet
  with its gid ("PIN THESE GIDS"), to the private bake log only. The inventory
  is NOT written into okr_sheet.json: that file is public, and it needs only
  the tabs it read.

  DO NOT substitute the sheetId values out of an .xlsx export. Those are Excel
  ordinals (1..6), not Google gids; they look plausible and are silently wrong.
  ---------------------------------------------------------------------------

  ---------------------------------------------------------------------------
  FINANCE'S FIGURES NEVER REACH THIS REPOSITORY. THIS IS A PUBLICATION RULE.
  ---------------------------------------------------------------------------
  MakiManc/ops is a PUBLIC repository, and the "2026 OKRs" tab carries OO1's
  underlying percentages (Net Profit). They must never reach this repo, this
  JSON, a log line, or a snapshot.
  "2026 OKRs" IS read, but by fixed, narrow ranges only - the OO4 credit
  notes block (OO4_KR4_RANGE), and the two OO6 cells' columns once they are
  pinned (OO6_BLOCKS) - and each is checked against its own header and month
  labels before a single value is used. No other cell of that tab is
  requested from Google.
  ---------------------------------------------------------------------------

THE SHEET IS NOT A FALLBACK. Ross, 21/09/2026: "dashboard only". For any KR this
system can compute, the sheet's typed Actual is IGNORED - not shown, not
reconciled against, not used when a feed is quiet. This file carries ONLY the
KRs that have no other source. Widening it is how a computed KR quietly starts
reporting whatever somebody typed.

A BLANK IS NOT A ZERO. A month whose cell is blank is absent from its series -
"not entered", carrying no score - never a 0 that would score 100. And a month
after the month of the pull is dropped: a typed figure for a month that has not
happened is not an event yet.

Run it in ops_command_bake.yml (in the maki-hospitality-etl repo), beside the
"Refresh the maintenance sheet" step and before "Bake the snapshot" - that is
the only job holding both the ops checkout and the push token, so the
refreshed file rides out on the same commit as the snapshot it feeds.
"""

from __future__ import annotations

import argparse
import datetime
import json
import logging
import os
import re
import sys

log = logging.getLogger("refresh_okr_sources")

SHEET_ID = os.environ.get("OKR_SHEET_ID", "").strip() or \
    "1UretphzyQFe9mrRtntuKZi-V1ct1gAHy7oXS4SQaMHk"

#: Exact worksheet titles, verbatim from the file (re-checked 10/10/2026). The
#: trailing space and the misspelling in the closures tab are REAL - do not
#: tidy them, they are what the match is against. Each maps to the env var
#: that pins its gid once somebody reads it out of the first run's log.
TAB_TITLES = {
    "okrs":     ("2026 OKRs", "OKR_GID_OKRS"),
    "oo3_kr3":  ("KR3: Zero menu items unavailable due to supply failure",
                 "OKR_GID_MENU"),
    "oo4_kr1":  ("KR1: Zero service disruptions caused by logistics delays "
                 "(24 hour Max)", "OKR_GID_LOGISTICS"),
    "oo2_kr3":  ("Unplanned Restarant Closures ", "OKR_GID_CLOSURES"),
}

#: The series this file carries, and the tab each one comes from.
LOG_SERIES = ("oo2_kr3", "oo3_kr3", "oo4_kr1")
#: OO6's two cells (Ross, 21/10/2026) - see OO6_BLOCKS.
OO6_SERIES = ("oo6_kr1", "oo6_kr2_invoiced")
SERIES = LOG_SERIES + ("oo4_kr4",) + OO6_SERIES
SERIES_TAB = {"oo2_kr3": "oo2_kr3", "oo3_kr3": "oo3_kr3", "oo4_kr1": "oo4_kr1",
              "oo4_kr4": "okrs", "oo6_kr1": "oo6_kr1",
              "oo6_kr2_invoiced": "oo6_kr2_invoiced"}

#: OO4 KR4 - % of delivery credit notes and refunds actioned. Ross, 10/10/2026:
#: "Raw % + band full" - read the Finance-entered Actual % and band it with
#: OKR_BANDS 'full' in the bake, rather than take the sheet's own score (whose
#: formula scores any Actual of 100% or less as 100, so it cannot go red).
#: This range is the ONLY part of "2026 OKRs" this script asks Google for.
#: Two ranges, combined row by row into [Month, Limit, Actual]: column A holds
#: the month labels ('Jan-26'..'Dec-26'), G:H the Limit and Actual. B:F and
#: I:L (another KR's figures and the sheet's own scores) are never requested.
OO4_KR4_RANGES = ("A144:A156", "G144:H156")
OO4_KR4_RANGE = "A144:A156 + G144:H156"
OO4_KR4_FIRST_ROW = 144
OO4_KR4_NEEDLE = "credit notes and refunds actioned"

#: OO6 (Ross, 21/10/2026). Matthew types two figures a month on '2026 OKRs':
#: KR1's supply chain availability % (banded 'full' in the bake) and, for
#: KR2, whether every JFC PO of the month was invoiced (yes/no). WHERE they
#: sit is not known - the sheet has never been readable from here - so their
#: cells are PINNED, not guessed: each is an env var set in the private bake
#: workflow (an Actions variable, not a secret), holding two single-column
#: ranges over the same rows, the month labels and the figure:
#:     OKR_CELLS_OO6_KR1="A160:A172,C160:C172"
#: Row one of each range is the header: 'Month' over the labels, and over the
#: figure a header containing the series' needle - so a pin that lands on any
#: other block (Finance's OO1 blocks are on this tab) is refused as
#: layout_changed before a value is read, and nothing of it is written.
#: Unset: the series is 'not_located' - named on its row, and not a failed
#: pull (every other series still reads, and the status stays ok).
OO6_BLOCKS = {
    "oo6_kr1": ("OKR_CELLS_OO6_KR1", "availab", "pct"),
    "oo6_kr2_invoiced": ("OKR_CELLS_OO6_KR2_INVOICED", "invoic", "yes_no"),
}
_A1_COL = re.compile(r"([A-Z]{1,3})([1-9]\d{0,3}):([A-Z]{1,3})([1-9]\d{0,3})")


def oo6_cells(key: str):
    """(months range, figure range, first row, label) for an OO6 series; None
    when its env var is unset; False when it is not two single-column ranges
    over the same 2-13 rows."""
    raw = (os.environ.get(OO6_BLOCKS[key][0]) or "").strip().upper().replace(" ", "")
    if not raw:
        return None
    parts = raw.split(",")
    if len(parts) != 2:
        return False
    got = [_A1_COL.fullmatch(p_) for p_ in parts]
    if not all(got):
        return False
    (c1, r1, c2, r2), (c3, r3, c4, r4) = (g.groups() for g in got)
    if c1 != c2 or c3 != c4 or c1 == c3 or (r1, r2) != (r3, r4):
        return False
    first, last = int(r1), int(r2)
    if not (2 <= last - first + 1 <= 13):
        return False
    return parts[0], parts[1], first, f"{parts[0]} + {parts[1]}"

OUT_DIR = os.environ.get("OPS_COMMAND_OUT_DIR", "").strip() or \
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "ops_command")
OUT_FILE = "okr_sheet.json"
STATUS_FILE = "okr_sheet_status.json"

#: Fixed, public text per cause. NEVER interpolate an exception message here.
CAUSE_TEXT = {
    "ok": "read every series",
    "no_credentials": "GOOGLE_SA_JSON is not set for the refresh step, so the "
                      "sheet was not asked for",
    "credentials_malformed": "GOOGLE_SA_JSON is set but is not a usable "
                             "service-account key",
    "auth_failed": "Google refused the service account's credentials (key "
                   "revoked or deleted, or the account disabled)",
    "not_shared": "HTTP 403 - the Operations Input sheet is not shared with the "
                  "service account. It is shared to the makiramen.com domain, "
                  "which does not include a service account; Matthew needs to "
                  "share it with the service account as Viewer",
    "not_found": "HTTP 404 - no sheet with this id is visible to the service "
                 "account (deleted, or the id changed)",
    "quota": "HTTP 429 - the Google Sheets API quota was exceeded",
    "google_down": "Google Sheets did not answer (HTTP 5xx, a timeout or a "
                   "dropped connection)",
    "tab_missing": "a tab could not be found by gid or exact title - the series "
                   "named in series_missing were carried forward from the last "
                   "good pull",
    "layout_changed": "a tab was read but no longer has the layout this script "
                      "checks for - the series named in series_missing were "
                      "carried forward from the last good pull",
    "not_located": "where this figure sits on the '2026 OKRs' tab is not pinned yet - the "
                   "sheet has never been readable, so its cells are not known; they are "
                   "set as OKR_CELLS_OO6_* in the bake workflow once it is. Not a failed "
                   "pull",
    "bad_cells": "the cells pinned for an OO6 figure (OKR_CELLS_OO6_*) are not two "
                 "single-column ranges over the same rows, e.g. A160:A172,C160:C172",
    "nothing_parsed": "the sheet opened but no series parsed - every tab is "
                      "missing or has changed shape; the last file was left "
                      "untouched",
    "write_failed": "okr_sheet.json could not be written; the last file was left "
                    "in place",
    "unexpected": "an unexpected error - the bake log names its type",
}
#: Worst first: when several series fail for different reasons, the status
#: names the most serious one (all are listed in series_missing).
CAUSE_RANK = ("layout_changed", "tab_missing", "bad_cells")
#: Causes that are not a failed pull: the series is named in series_missing,
#: and the status stays ok when nothing else failed.
NOT_A_FAILURE = ("not_located",)

_MONTHS = ("january", "february", "march", "april", "may", "june", "july",
           "august", "september", "october", "november", "december")


class SourceError(Exception):
    """A failure with a known cause code. `str()` is never published."""

    def __init__(self, cause: str, http_status: int | None = None):
        super().__init__(cause)
        self.cause = cause
        self.http_status = http_status


def _now() -> str:
    return (os.environ.get("PULLED_AT")
            or datetime.datetime.now(datetime.timezone.utc)
            .strftime("%Y-%m-%dT%H:%M:%SZ"))


def _col(j: int) -> str:
    """0-based column index -> A1 letters."""
    s = ""
    j += 1
    while j:
        j, r = divmod(j - 1, 26)
        s = chr(65 + r) + s
    return s


def parse_month(cell: str) -> str | None:
    """A month cell -> 'YYYY-MM', or None if it is not a month.

    Two renderings, because the tabs disagree with each other:
      * the log tabs spell it out - 'January 2026'
      * the '2026 OKRs' credit-notes block abbreviates and hyphenates - 'Jan-26'
    Anything else (a blank, a stray total row) returns None and is skipped
    rather than guessed at.
    """
    s = (cell or "").strip().lower().replace("–", "-")
    if not s:
        return None
    m = re.match(r"^([a-z]+)[ \-/]+(\d{2,4})$", s)
    if not m:
        return None
    name, year = m.group(1), m.group(2)
    idx = next((i for i, mn in enumerate(_MONTHS)
                if mn.startswith(name) and len(name) >= 3), None)
    if idx is None:
        return None
    y = int(year)
    if y < 100:
        y += 2000
    if not (2020 <= y <= 2099):
        return None
    return f"{y:04d}-{idx + 1:02d}"


def parse_num(cell: str):
    """A numeric cell -> float, or None. A BLANK IS NOT A ZERO.

    That distinction is the whole point of this function: a blank month must
    reach the scorecard as "not entered", never as a zero that scores 100.
    Sheet error values (#REF!, #VALUE!, #N/A) are non-numeric and return None
    for the same reason. A '%' is NOT stripped here - callers that accept a
    percentage say so with parse_pct.
    """
    s = (cell or "").strip().replace(",", "")
    if not s or s.startswith("#") or "%" in s:
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return v if v == v and v not in (float("inf"), float("-inf")) else None


def parse_pct(cell: str):
    """A percentage cell ('98', '98%', '98.00%') -> float 0-100, or None."""
    s = (cell or "").strip().replace(",", "")
    if s.endswith("%"):
        s = s[:-1].strip()
    v = parse_num(s)
    if v is None or not (0 <= v <= 100):
        return None
    return v


def parse_yes_no(cell: str):
    """A yes/no cell -> True / False, or None. A BLANK IS NOT A 'NO'.

    'yes' / 'y' / 'TRUE' (a ticked checkbox) -> True; 'no' / 'n' / 'FALSE'
    -> False; anything else, including a blank, -> None (not entered)."""
    s = (cell or "").strip().lower().rstrip(".!")
    if s in ("yes", "y", "true", "✓", "✔"):
        return True
    if s in ("no", "n", "false", "✗", "✘"):
        return False
    return None


# ---------------------------------------------------------------------------
# Reading Google
# ---------------------------------------------------------------------------

def classify(exc: BaseException) -> tuple[str, int | None]:
    """An exception from gspread / google-auth / requests -> (cause, http).

    Matched on class names and the response status so this module never has to
    import gspread (CI has none) to know what went wrong.
    """
    if isinstance(exc, SourceError):
        return exc.cause, exc.http_status
    resp = getattr(exc, "response", None)
    code = getattr(resp, "status_code", None)
    code = code if isinstance(code, int) else None
    names = {c.__name__ for c in type(exc).__mro__}
    if isinstance(exc, PermissionError) or code == 403:
        return "not_shared", 403
    if "SpreadsheetNotFound" in names or code == 404:
        return "not_found", 404
    if code == 429:
        return "quota", 429
    if code is not None and 500 <= code < 600:
        return "google_down", code
    if names & {"RefreshError", "DefaultCredentialsError", "MalformedError"} or code == 401:
        return "auth_failed", code
    if (isinstance(exc, (TimeoutError, ConnectionError))
            or names & {"TransportError", "ConnectionError", "Timeout", "ReadTimeout",
                        "ConnectTimeout", "ChunkedEncodingError", "RequestException"}):
        return "google_down", code
    return "unexpected", code


def open_sheet(sheet_id: str):
    """Credentials -> gspread Spreadsheet. Raises SourceError with a cause."""
    sa = os.environ.get("GOOGLE_SA_JSON")
    path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not (sa or "").strip() and not path:
        raise SourceError("no_credentials")
    import gspread
    try:
        if (sa or "").strip():
            info = json.loads(sa)
            if not isinstance(info, dict) or "client_email" not in info:
                raise ValueError("not a service-account key")
            gc = gspread.service_account_from_dict(info)
        else:
            gc = gspread.service_account(filename=path)
    except (ValueError, KeyError, TypeError) as exc:
        raise SourceError("credentials_malformed") from exc
    return gc.open_by_key(sheet_id)


def pick_worksheets(sheets) -> tuple[dict, dict]:
    """[worksheet] -> ({key: worksheet}, {key: 'tab_missing'}).

    gid first (OKR_GID_<NAME>), exact title second. Logs every worksheet with
    its gid before selecting any, so a run that cannot find a tab leaves the
    real list in the (private) bake log - and the first successful run hands
    over the gids to pin.
    """
    inventory = [(w.title, w.id) for w in sheets]
    log.info("worksheets in the Operations Input sheet: %s",
             ", ".join(f"{t!r} (gid {g})" for t, g in inventory))
    log.info("PIN THESE GIDS to stop depending on titles: %s",
             " ".join(f"{env}={next((g for t, g in inventory if t == title), '?')}"
                      for _k, (title, env) in TAB_TITLES.items()))
    out, missing = {}, {}
    for key, (title, env) in TAB_TITLES.items():
        gid = (os.environ.get(env) or "").strip()
        ws = None
        if gid.isdigit():
            ws = next((w for w in sheets if w.id == int(gid)), None)
            if ws is None:
                log.error("%s=%s names no worksheet in this file - falling back "
                          "to the title %r. Fix the env var.", env, gid, title)
        if ws is None:
            ws = next((w for w in sheets if w.title == title), None)
        if ws is None:
            log.error("no worksheet matches %r and %s is unset - %s is carried "
                      "forward from the last good pull.", title, env, key)
            missing[key] = "tab_missing"
            continue
        out[key] = ws
    return out, missing


def fetch(sheet_id: str, spreadsheet=None) -> tuple[dict, dict]:
    """-> ({key: (title, gid, rows)}, {key: cause}) for the tabs we need.

    Whole-tab reads for the three log tabs; of '2026 OKRs', ONE fixed range
    (OO4_KR4_RANGE) and each OO6 figure's two pinned columns, and nothing else.
    """
    sh = spreadsheet if spreadsheet is not None else open_sheet(sheet_id)
    picked, missing = pick_worksheets(sh.worksheets())
    out = {}
    for key, ws in picked.items():
        if key == "okrs":
            months, gh = ws.batch_get(list(OO4_KR4_RANGES))
            n = max(len(months), len(gh))
            rows = [((list(months[i]) if i < len(months) else []) + [""])[:1]
                    + ((list(gh[i]) if i < len(gh) else []) + ["", ""])[:2]
                    for i in range(n)]
            # OO6's pinned columns, each its own request - and nothing at all
            # of this tab for a figure whose cells are not pinned
            for skey in OO6_SERIES:
                cells = oo6_cells(skey)
                if not cells:
                    missing[skey] = "not_located" if cells is None else "bad_cells"
                    continue
                mo, fig = ws.batch_get([cells[0], cells[1]])
                k = max(len(mo), len(fig))
                out[skey] = (ws.title, ws.id, [
                    [str(c) for c in ((list(mo[i]) if i < len(mo) else []) + [""])[:1]
                     + ((list(fig[i]) if i < len(fig) else []) + [""])[:1]] for i in range(k)])
        else:
            rows = ws.get_all_values()
        out[key] = (ws.title, ws.id, [[str(c) for c in r] for r in (rows or [])])
    for skey in OO6_SERIES:
        if skey not in out and skey not in missing:
            missing[skey] = missing.get("okrs", "tab_missing")
    return out, missing


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def build_log(rows, through: str) -> tuple[dict | None, str | None]:
    """A two-column log tab -> ({'YYYY-MM': count}, None) or (None, cause).

    Only months with a NUMBER are emitted. A month row that exists but is blank
    is deliberately absent from the dict, so the bake can tell "entered as
    zero" from "not entered" - they score 100 and nothing respectively. A tab
    with no month rows at all has changed shape (layout_changed) - that is not
    the same as nothing entered, and the series is carried forward instead.
    Months after `through` (the pull month) are dropped.
    """
    out, month_rows = {}, 0
    for i, r in enumerate(rows):
        if not r:
            continue
        m = parse_month(r[0] if len(r) > 0 else "")
        if m is None:
            continue
        month_rows += 1
        raw = r[1] if len(r) > 1 else ""
        v = parse_num(raw)
        if v is None:
            if (raw or "").strip():
                log.error("log row %d: %r is not a count - month left as not "
                          "entered", i + 1, raw[:12])
            continue
        if v < 0 or not float(v).is_integer():
            log.error("log row %d: %r is not a whole count - month left as not "
                      "entered", i + 1, raw[:12])
            continue
        if m > through:
            log.warning("log row %d: %s is after the pull month %s - dropped "
                        "(not an event yet)", i + 1, m, through)
            continue
        out[m] = int(v)
    if month_rows == 0:
        return None, "layout_changed"
    return out, None


def build_oo4_kr4(rows, through: str) -> tuple[dict | None, str | None]:
    """The OO4_KR4_RANGES of '2026 OKRs' -> ({'YYYY-MM': pct}, cause).

    `rows` are [A, G, H] for sheet rows 144-156: row 144 is the header
    (Month | Limit | Actual), rows 145-156 are Jan-26..Dec-26. The header and
    every month label are checked before any value is used; a block that has
    moved returns (None, 'layout_changed') and the series is carried forward.
    Only the Actual is kept: the Limit is a constant 100, and the sheet's own
    score (column J) is never requested.
    """
    if not rows:
        log.error("'2026 OKRs'!%s came back empty - OO4 KR4 carried forward.",
                  OO4_KR4_RANGE)
        return None, "layout_changed"
    head = [c.strip().lower() for c in rows[0]] + ["", "", ""]
    if not (head[0].startswith("month") and head[1].startswith("limit")
            and head[2].startswith("actual")):
        log.error("'2026 OKRs' row %d does not read Month (A) | Limit | Actual "
                  "(G:H) - the credit-notes block has moved. OO4 KR4 carried "
                  "forward.", OO4_KR4_FIRST_ROW)
        return None, "layout_changed"
    out, seen = {}, 0
    for k, r in enumerate(rows[1:], start=1):
        r = list(r) + ["", "", ""]
        m = parse_month(r[0])
        rowno = OO4_KR4_FIRST_ROW + k
        if m is None:
            if any(c.strip() for c in r[:3]):
                log.error("'2026 OKRs' row %d: column A is not a month - the "
                          "credit-notes block has moved. OO4 KR4 carried "
                          "forward.", rowno)
                return None, "layout_changed"
            continue
        seen += 1
        raw = r[2].strip()
        if not raw:
            continue
        v = parse_pct(raw)
        if v is None:
            log.error("'2026 OKRs'!H%d (%s) is not a 0-100 percentage - that "
                      "month left as not entered.", rowno, m)
            continue
        if m > through:
            log.warning("'2026 OKRs'!H%d holds a figure for %s, after the pull "
                        "month - dropped.", rowno, m)
            continue
        out[m] = int(v) if float(v).is_integer() else round(v, 2)
    if seen == 0:
        log.error("no month labels in '2026 OKRs'!%s - OO4 KR4 carried forward.",
                  OO4_KR4_RANGE)
        return None, "layout_changed"
    return out, None


def build_oo6_block(key: str, rows, through: str) -> tuple[dict | None, str | None]:
    """An OO6 figure's pinned columns -> ({'YYYY-MM': value}, cause).

    `rows` are [month label, figure] for the pinned rows. Row one must read
    'Month' over the labels and carry the series' needle over the figure (see
    OO6_BLOCKS); every other row is a month label or blank. A value is a 0-100
    % for oo6_kr1 and a JSON true/false for oo6_kr2_invoiced. A blank is not
    entered - never a 0, never a 'no'. Errors name the cell, never its text.
    """
    _env, needle, kind = OO6_BLOCKS[key]
    cells = oo6_cells(key)
    first = cells[2] if cells else 0
    if not rows:
        log.error("%s: the pinned cells came back empty - carried forward.", key)
        return None, "layout_changed"
    head = [c.strip().lower() for c in rows[0]] + ["", ""]
    if not (head[0].startswith("month") and needle in head[1]):
        log.error("%s: row %d of the pinned cells does not read 'Month' over the labels "
                  "and a header naming the figure - the pin is wrong or the block moved. "
                  "Carried forward.", key, first)
        return None, "layout_changed"
    out, seen = {}, 0
    for k, r in enumerate(rows[1:], start=1):
        r = list(r) + ["", ""]
        m = parse_month(r[0])
        if m is None:
            if any(c.strip() for c in r[:2]):
                log.error("%s: row %d of the pinned cells is not a month - carried "
                          "forward.", key, first + k)
                return None, "layout_changed"
            continue
        seen += 1
        raw = r[1].strip()
        if not raw:
            continue
        v = parse_pct(raw) if kind == "pct" else parse_yes_no(raw)
        if v is None:
            log.error("%s: row %d (%s) is not %s - that month left as not entered.", key,
                      first + k, m, "a 0-100 percentage" if kind == "pct" else "yes or no")
            continue
        if m > through:
            log.warning("%s: row %d holds a figure for %s, after the pull month - "
                        "dropped.", key, first + k, m)
            continue
        out[m] = v if kind != "pct" else (int(v) if float(v).is_integer() else round(v, 2))
    if seen == 0:
        log.error("%s: no month labels in the pinned cells - carried forward.", key)
        return None, "layout_changed"
    return out, None


def _as_of(months) -> str | None:
    return max(months) if months else None


def build(fetched: dict, missing: dict, previous: dict | None, pulled_at: str):
    """-> (document or None, {series: cause}).

    `missing` is {tab key: cause} from fetch. Every series that could not be
    read THIS run is carried forward from `previous` with its own pulled_at,
    and named in the returned dict. Returns (None, ...) when no series was
    read this run - the caller then leaves the old file untouched.
    """
    through = pulled_at[:7]
    prev_series = (previous or {}).get("series") or {}
    series, failed = {}, {}

    def put(key, tab_key, data, extra=None):
        title, gid, _rows = fetched[tab_key]
        rec = {"tab": title, "gid": gid, "pulled_at": pulled_at, **(extra or {})}
        rec["months"] = data
        rec["as_of"] = _as_of(list(data))
        series[key] = rec

    for key in SERIES:
        tab = SERIES_TAB[key]
        if tab not in fetched:
            failed[key] = missing.get(tab, "tab_missing")
            continue
        rows = fetched[tab][2]
        if key in LOG_SERIES:
            data, cause = build_log(rows, through)
            if cause is None:
                put(key, tab, data)
        elif key == "oo4_kr4":
            data, cause = build_oo4_kr4(rows, through)
            if cause is None:
                put(key, tab, data, {"range": OO4_KR4_RANGE})
        elif key in OO6_SERIES:
            data, cause = build_oo6_block(key, rows, through)
            if cause is None:
                put(key, tab, data, {"range": (oo6_cells(key) or (None,) * 4)[3]})
        else:
            raise ValueError(f"no parser for series {key}")
        if cause is not None:
            failed[key] = cause

    if not series:
        return None, failed
    for key, cause in failed.items():
        if key in prev_series:
            series[key] = dict(prev_series[key], carried_forward=True)
            log.warning("%s not read this run (%s) - carried forward from the "
                        "pull of %s.", key, cause, prev_series[key].get("pulled_at"))
        else:
            log.error("%s not read this run (%s) and there is no earlier pull to "
                      "carry forward - its rows stay grey.", key, cause)
    return {
        "pulled_at": pulled_at,
        "sheet_id": SHEET_ID,
        "series": series,
        "basis": (
            "Typed into Matthew's 2026 Operations Input sheet and read here "
            "because these KRs have no feed anywhere else. A month absent from "
            "a series was NOT ENTERED on the sheet and carries no score - it is "
            "never read as a zero. OO1 is not read from this sheet (Ross, "
            "15/10/2026: Finance's management account). Each series carries its "
            "own pulled_at: a series that "
            "could not be read on the latest pull is carried forward from an "
            "earlier one and says so."),
    }, failed


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

def _atomic_write(path: str, text: str) -> None:
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    finally:
        # A stray .tmp would be committed to the PUBLIC repo by the bake's
        # `git add data/ops_command`.
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def write_status(path: str, ok: bool, cause: str, http_status=None,
                 series_read=(), series_missing=None) -> None:
    """Record this attempt. Never raises: diagnostics must not fail the step."""
    now = _now()
    try:
        prev = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                prev = json.load(fh) or {}
        failing_since = None
        if not ok:
            failing_since = (prev.get("failing_since") if prev.get("ok") is False
                             else None) or now
        rec = {"attempted_at": now, "ok": ok, "cause": cause,
               "detail": CAUSE_TEXT.get(cause, CAUSE_TEXT["unexpected"]),
               "http_status": http_status,
               "last_ok_at": now if ok else prev.get("last_ok_at"),
               "failing_since": failing_since,
               "series_read": sorted(series_read),
               "series_missing": dict(sorted((series_missing or {}).items()))}
        _atomic_write(path, json.dumps(rec, indent=1, sort_keys=True) + "\n")
    except Exception as e:  # noqa: BLE001
        log.warning("could not write %s (%s)", path, type(e).__name__)


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-json", help="parse this dump ({tab key: rows}) "
                                        "instead of calling Google")
    ap.add_argument("--out", default=os.path.join(OUT_DIR, OUT_FILE))
    ap.add_argument("--print", action="store_true", help="print, do not write")
    a = ap.parse_args(argv)
    out_path = os.path.abspath(a.out)
    status_path = os.path.join(os.path.dirname(out_path), STATUS_FILE)
    status = (lambda *x, **k: None) if a.print else \
        (lambda *x, **k: write_status(status_path, *x, **k))

    try:
        if a.from_json:
            with open(a.from_json, encoding="utf-8") as fh:
                raw = json.load(fh)
            # the OO6 figures are dumped under their series keys ('oo6_kr1'),
            # as [month label, figure] rows - they live on the '2026 OKRs' tab
            fetched = {k: (TAB_TITLES["okrs" if k in OO6_SERIES else k][0], -1, v)
                       for k, v in raw.items() if k in TAB_TITLES or k in OO6_SERIES}
            missing = {k: "tab_missing" for k in TAB_TITLES if k not in fetched}
            for k in OO6_SERIES:
                if k not in fetched:
                    c_ = oo6_cells(k)
                    missing[k] = ("not_located" if c_ is None else "bad_cells" if c_ is False
                                  else missing.get("okrs", "tab_missing"))
        else:
            fetched, missing = fetch(SHEET_ID)
    except Exception as exc:  # noqa: BLE001 - fail soft by design
        cause, http = classify(exc)
        # The private bake log gets the type and message; the public status
        # file gets the fixed text for the cause, never str(exc).
        log.error("could not read the Operations Input sheet: %s (%s: %s). "
                  "Leaving %s untouched.", cause, type(exc).__name__, exc, OUT_FILE)
        if cause == "not_shared":
            log.error("A 403 is EXPECTED until Matthew shares %s with the service "
                      "account (client_email in GOOGLE_SA_JSON) as Viewer.", SHEET_ID)
        status(False, cause, http)
        return 0

    pulled_at = _now()
    previous = None
    if os.path.exists(out_path):
        try:
            with open(out_path, encoding="utf-8") as fh:
                previous = json.load(fh)
        except Exception as exc:  # noqa: BLE001
            log.warning("previous %s unreadable (%s) - nothing to carry forward",
                        OUT_FILE, type(exc).__name__)
    try:
        built, failed = build(fetched, missing, previous, pulled_at)
    except Exception as exc:  # noqa: BLE001
        log.error("parsing the Operations Input sheet failed: %s - %s untouched",
                  type(exc).__name__, OUT_FILE)
        status(False, "unexpected")
        return 0
    if built is None:
        log.error("nothing parsed from the Operations Input sheet (%s) - %s left "
                  "untouched.", ", ".join(f"{k}: {c}" for k, c in sorted(failed.items())),
                  OUT_FILE)
        status(False, "nothing_parsed", series_missing=failed)
        return 0

    read_now = sorted(k for k, s in built["series"].items()
                      if not s.get("carried_forward"))
    for key in SERIES:
        s = built["series"].get(key)
        if not s:
            continue
        if key in ("oo4_kr4",) + OO6_SERIES:
            log.info("%s: %d month(s) entered", key, len(s["months"]))
        else:
            log.info("%s: %s", key, ", ".join(f"{m}={v}" for m, v in
                                              sorted(s["months"].items())) or "none")
        # SAY WHEN THE SHEET HAS STOPPED BEING FILLED IN, per series - a single
        # file-wide "newest month" hid that all three log tabs stop at July 2026
        # while another series ran to September.
        if s.get("as_of") and s["as_of"] < pulled_at[:7] and not s.get("carried_forward"):
            log.warning("%s: newest entered month is %s and it is %s - nobody has "
                        "filled it in since. Not a broken pull; the months after "
                        "carry no score.", key, s["as_of"], pulled_at[:7])

    if a.print:
        print(json.dumps(built, indent=2, sort_keys=True))
        return 0
    try:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        _atomic_write(out_path, json.dumps(built, indent=2, sort_keys=True,
                                           allow_nan=False) + "\n")
    except Exception as exc:  # noqa: BLE001
        log.error("could not write %s (%s) - previous file left in place",
                  out_path, type(exc).__name__)
        status(False, "write_failed", series_read=read_now, series_missing=failed)
        return 0
    log.info("wrote %s", out_path)
    hard = {k: c for k, c in failed.items() if c not in NOT_A_FAILURE}
    for k, c in sorted(failed.items()):
        if c in NOT_A_FAILURE:
            log.warning("%s: %s - %s", k, c, CAUSE_TEXT[c])
    if hard:
        cause = next((c for c in CAUSE_RANK if c in hard.values()), "tab_missing")
        status(False, cause, series_read=read_now, series_missing=failed)
    else:
        status(True, "ok", 200 if not a.from_json else None, series_read=read_now,
               series_missing=failed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
