#!/usr/bin/env python3
"""Refresh data/ops_command/frozen_stock_count.json from Ross's weekly stock count report.

OO6 KR3 (Ross, 21/10/2026): "% of locations with a frozen ramen count that
week". Ross drops the weekly stock count report into a Drive folder; each bake
reads the folder's reports, keeps only the frozen-ramen lines, and records per
week and location how many lines it listed and how many carry a number.
builders/frozen_ramen.py (kr3_months) turns that into the scorecard row.

WHERE THE FOLDER IS. The folder id comes from the STOCK_COUNT_FOLDER_ID secret
of maki-hospitality-etl's bake workflow - the bare id or the whole folder
link. It is never logged, never written, and never in this public file. The
folder must be shared with the service account (client_email in
GOOGLE_SA_JSON) as Viewer, or the service account added to its shared drive:
"anyone with the link" does not put a file into a listing.

THE FOLDER IS THE TRUTH (review, 21/10/2026). Every run re-reads the folder's
CSV, .xlsx and Google Sheet reports (not subfolders) - every one saved since
WINDOW_FROM; an older one can only hold weeks before October 2026, which OO6
never scores - and REBUILDS the copy from them, for every month not yet
CLOSED (below). Nothing else is carried from the last copy but each unchanged
week's read_at. There is no read mark to fall behind, skip or stall on:
  * a report fixed and re-saved replaces what it said, and one deleted stops
    counting;
  * a week two reports share is MERGED BY LOCATION, the newer report winning a
    location both list - a count that runs Sunday into Monday, or a report
    split by region, loses nothing. An older report whose every location a
    newer one re-lists (a re-issue) no longer counts its unplaced lines;
  * a report that cannot be read for its OWN reason (no header, not a table,
    no frozen-ramen line...) is listed in the copy's unread_reports, by its
    date and fixed cause, for as long as it sits in the folder - and the bake
    names it on OO6 KR3;
  * a failure that is the RUNNER'S or Google's (network, rate limit, no xlsx
    reader...) writes nothing: the last good copy stands and the status says
    why, and the next run reads the folder again.
A week whose counts are unchanged keeps the read_at it was first read with,
so a back-bake still shows what was known on its date. A folder holding more
than MAX_REPORTS reports to read, or a run past RUN_DEADLINE_S, writes
nothing and says so - never a copy built from part of the folder.

CLOSED MONTHS (27/10/2026). Kobas's reports come one per restaurant, ~20 a
week, so re-reading the whole folder every bake would pass MAX_REPORTS by
March 2027 (and spend Actions minutes on months long scored). A month's
reports are re-read every bake until frozen_ramen.CLOSE_DAY of the NEXT
month; from then on the month is CLOSED: its weeks are carried from the last
copy exactly as they were last read, and its reports are not downloaded
again. The copy's closed_months records, per month, the moment the folder was
last listed while the month was still open (read_through_at): a report for a
closed month saved after that moment was never read, so it is READ to find
out, its closed weeks are not used, and it is listed in unread_reports (cause
month_closed) for as long as it sits there - never dropped silently. A
report fixed or deleted after its month closed changes nothing. A copy
written under other reading rules (READER), or none at all, is never built
on: that run reads every report in the window, closed months too.

WHAT IS WRITTEN - AND WHAT IS NOT. The copy is committed to the PUBLIC ops
repo. A location is written ONLY when it is a venue on the bake's own site
map (bake_ops_command.stock_venues), as that venue's label; anything else in
the location column - a person's name, a typo - is counted, never written,
and a report whose location column names no venue for most of its lines is
refused as not being the location at all. Also written: line counts, dates,
the frozen-ramen products as one of frozen_ramen.CANON_ITEMS (an item cell is
free text, and is never copied) and each role's header only when it is a known
one (else '(column N)'). Never a quantity, a money value, a person, the file's
name or id: the download is held in memory and parsed there. self_check() refuses the result before it is
written, and the bake refuses it again (frozen_ramen.stock_leaks).

KOBAS, ONE RESTAURANT PER FILE (Ross, 27/10/2026). Kobas's Stock Usage
Comparison, exported for one restaurant, has no location or date column: Kobas
puts both in its file name, 'KOBAS_<report>_<Restaurant-Name>_<from>_<to>'. A
report with that name and no location column is read for the restaurant the
name spells (matched letters-and-digits only against the site map, so
'Maki-12-Nicolson-St' is Maki 1/2 Nicolson St), in the week of the period's
END - the closing stock take - and its count column is Closing Stock Units.
The name itself is never written. A report with no location column and no
such name is refused (venue_not_named), and one naming a restaurant not on
the site map too (venue_unknown).

THE WEEK a count belongs to is the Monday of a date column when the report has
one, else - Kobas's per-restaurant name - of the period's end date, else of a
date in the file's name, else of the day Drive says the file was created (UK
time) - and each week records which (week_from).

A BLANK IS NOT A ZERO. A count cell that is empty, text or negative is not a
count; a 0 is (Ross, 27/10/2026, for Kobas's Closing Stock Units too). A
frozen-ramen line with no number is recorded as listed but not counted.

FAIL SOFT, ALWAYS, AND SAY WHY: every path exits 0, and the status file
(frozen_stock_count_status.json) carries only the fixed CAUSE_TEXT for its
cause. Exception text goes nowhere - a Google error or URL can carry the
folder id.
"""

from __future__ import annotations

import argparse
import csv
import datetime
import io
import json
import os
import re
import sys

here = os.path.dirname(os.path.abspath(__file__))
if here not in sys.path:
    sys.path.insert(0, here)
import frozen_ramen  # noqa: E402

OUT_DIR = os.environ.get("OPS_COMMAND_OUT_DIR", "").strip() or \
    os.path.join(here, "..", "data", "ops_command")
DRIVE_FILES = "https://www.googleapis.com/drive/v3/files"
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
#: A stock count report this large is not one.
MAX_BYTES = 10 * 1024 * 1024
#: Reports saved before this hold only weeks before OO6's first month (October
#: 2026), which are never scored: they are not read.
WINDOW_FROM = "2026-08-27"
#: More reports than this in the window is not a stock count folder any more
#: (years of weekly reports): the run writes nothing and says so, rather than
#: build the copy from part of the folder.
MAX_REPORTS = 400
#: A run that has not finished reading the folder by now writes nothing.
RUN_DEADLINE_S = 420
#: The reading rules the copy was written under. A copy with another number is
#: never built on: the next run reads every report in the window, closed months
#: too. Bump it when a change lets this read a report it could not before (with
#: more than MAX_REPORTS reports in the window, that run then says
#: too_many_reports - move old reports out of the folder first).
#: 2 (27/10/2026): Kobas's per-restaurant export; closed months.
READER = 2
#: Rows read from one sheet; a longer sheet is refused, never cut short.
MAX_ROWS = 50000
MIME_CSV = "text/csv"
MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MIME_GSHEET = "application/vnd.google-apps.spreadsheet"
MIME_FOLDER = "application/vnd.google-apps.folder"

#: Fixed, public text per cause. NEVER interpolate an exception message, a
#: file name or an id here.
CAUSE_TEXT = {
    "ok": "read every stock count report in the folder (any it could not read are listed in "
          "the copy's unread_reports)",
    "too_many_reports": "the folder holds more reports than a stock count folder should, so "
                        "none were used - move old reports out of it",
    "timeout": "the folder could not be read within the run's time limit - the next bake "
               "retries; the last copy stands",
    "no_folder_id": "STOCK_COUNT_FOLDER_ID is not set in the bake workflow (Ross adds it as "
                    "a repository secret of maki-hospitality-etl)",
    "bad_folder_id": "STOCK_COUNT_FOLDER_ID is not a Drive folder id or folder link",
    "no_credentials": "the bake has no Google service-account key (GOOGLE_SA_JSON)",
    "credentials_malformed": "GOOGLE_SA_JSON is set but is not a usable service-account key",
    "not_shared": "Drive refused the service account (HTTP 403) - share the folder with the "
                  "service account as Viewer",
    "not_found": "Drive has no folder at that id that the service account can see (HTTP 404) "
                 "- share the folder with the service account as Viewer, and check "
                 "STOCK_COUNT_FOLDER_ID",
    "not_a_folder": "STOCK_COUNT_FOLDER_ID names a file, not a folder",
    "drive_api_disabled": "the Drive API is not enabled on the service account's Google Cloud "
                          "project (HTTP 403)",
    "rate_limited": "Drive asked the bake to slow down (HTTP 403/429) - the next bake retries",
    "http_error": "Drive returned an error",
    "network": "the read failed (network or timeout)",
    "download_blocked": "Drive would not let the service account download this report (HTTP "
                        "403/404) although the folder lists it - its own sharing, or 'viewers "
                        "can download' turned off; read again every bake",
    "no_report": "the folder holds no CSV, .xlsx or Google Sheet",
    "too_large": "a report is far larger than a stock count",
    "not_a_table": "a report is not a CSV or .xlsx table (a legacy .xls or a PDF cannot be read)",
    "report_unreadable": "a report could not be parsed (damaged, or a format this does not "
                         "know) - the bake log names the error's type",
    "no_reader": "the bake could not load openpyxl, the .xlsx reader - the runner's fault, not "
                 "the report's",
    "header_missing": "a report has no header row naming a location, an item and a count "
                      "column",
    "header_ambiguous": "a report has two columns that could each be the location, the item or "
                        "the count",
    "locations_unknown": "a report's location column names no restaurant on the site map for "
                         "most of its frozen-ramen lines, so it is not read as the location",
    "no_date": "a report's frozen-ramen lines have no readable date in its date column",
    "no_frozen_lines": "a report was read but no line in it is frozen ramen by name - if the "
                       "products were renamed, builders/frozen_ramen.py needs the new name",
    "no_venues": "the bake's site map could not be loaded, so no location could be checked",
    "venue_not_named": "a report has no location column, and its file name is not the one Kobas "
                       "gives a report exported for one restaurant ('KOBAS_..._Report_<restaurant>"
                       "_<from>_<to>'), so its restaurant is unknown - keep Kobas's file name",
    "venue_unknown": "a report exported for one restaurant names, in its file name, a restaurant "
                     "that is not on the site map",
    "month_closed": "a report saved after its month was closed for re-reading (day "
                    f"{frozen_ramen.CLOSE_DAY} of the next month) - that month's weeks stand as "
                    "they were last read",
    "refused": "the result failed the publication check, so nothing was written",
    "write_failed": "frozen_stock_count.json could not be written; the last file was left in "
                    "place",
    "unexpected": "an unexpected error - the bake log names its type",
}
#: The runner's or Google's fault: nothing is written, the last copy stands.
#: Every other cause is the report's own, listed in unread_reports.
TRANSIENT = frozenset({"network", "rate_limited", "http_error", "drive_api_disabled",
                       "no_reader", "timeout"})

_FOLDER_RE = re.compile(r"(?:.*?/folders/)?([-\w]{15,})(?:[/?#].*)?")


def folder_id(raw):
    """STOCK_COUNT_FOLDER_ID as a bare id: None when unset, False when it is not
    one. Takes the whole '.../drive/folders/<id>?usp=sharing' link too. A shared
    drive's root id is about 19 characters, so this accepts 15 or more - not the
    25+ a file id has (oo1_ma.file_id would refuse a valid folder)."""
    s_ = str(raw or "").strip()
    if not s_:
        return None
    m = _FOLDER_RE.fullmatch(s_)
    return m.group(1) if m else False


def _now():
    v = os.environ.get("PULLED_AT")
    if v:
        return v
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _atomic_write(path: str, text: str) -> None:
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    finally:
        # a stray .tmp would be published by the bake's `git add data/ops_command`
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Reading Drive (credentials come from the private workflow)
# ---------------------------------------------------------------------------
class DriveError(Exception):
    def __init__(self, cause, http=None):
        super().__init__(cause)
        self.cause, self.http = cause, http


def session():
    sa = os.environ.get("GOOGLE_SA_JSON", "").strip()
    if not sa:
        raise DriveError("no_credentials")
    try:
        info = json.loads(sa)
        if not isinstance(info, dict) or "client_email" not in info:
            raise ValueError("not a service-account key")
        from google.oauth2 import service_account
        creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    except (ValueError, KeyError, TypeError):
        raise DriveError("credentials_malformed") from None
    from google.auth.transport.requests import AuthorizedSession
    return AuthorizedSession(creds)


def _refusal(r):
    """A 403/429 body's reason, read and never printed."""
    try:
        body = r.content[:4000].decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        body = ""
    if re.search(r"accessNotConfigured|SERVICE_DISABLED|has not been used in project", body):
        return "drive_api_disabled"
    if r.status_code == 429 or re.search(r"[rR]ateLimitExceeded|[qQ]uotaExceeded", body):
        return "rate_limited"
    # one file's own refusal, after the folder listed fine - not the folder's sharing
    if re.search(r"cannotDownloadFile|cannotExportFile|fileNotDownloadable", body):
        return "download_blocked"
    if "exportSizeLimitExceeded" in body:
        return "too_large"
    return "not_shared"


def _get(sess, url, **kw):
    try:
        r = sess.get(url, timeout=(15, 120), **kw)
    except Exception:  # noqa: BLE001 - its text can carry the URL, so only the cause
        raise DriveError("network") from None
    if r.status_code in (403, 429):
        raise DriveError(_refusal(r), r.status_code)
    if r.status_code == 404:
        raise DriveError("not_found", 404)
    if r.status_code != 200:
        raise DriveError("http_error", r.status_code)
    return r


def list_reports(sess, folder):
    """The folder's CSV / xlsx / Google Sheet files, newest first. The folder
    itself is asked for FIRST: a listing of a folder the service account
    cannot see comes back 200 and empty, which would read as 'no report'."""
    meta = _get(sess, f"{DRIVE_FILES}/{folder}",
                params={"fields": "id,mimeType", "supportsAllDrives": "true"}).json()
    if meta.get("mimeType") != MIME_FOLDER:
        raise DriveError("not_a_folder")
    q = (f"'{folder}' in parents and trashed = false and (mimeType = '{MIME_CSV}' or "
         f"mimeType = '{MIME_XLSX}' or mimeType = '{MIME_GSHEET}')")
    out, token = [], None
    while True:
        params = {"q": q, "orderBy": "modifiedTime desc", "pageSize": 100,
                  "fields": "nextPageToken, files(id, name, mimeType, createdTime, "
                            "modifiedTime, size)",
                  # without these a shared drive lists EMPTY
                  "supportsAllDrives": "true", "includeItemsFromAllDrives": "true",
                  "corpora": "allDrives"}
        if token:
            params["pageToken"] = token
        page = _get(sess, DRIVE_FILES, params=params).json()
        out.extend(page.get("files") or [])
        token = page.get("nextPageToken")
        if not token:
            break
    return sorted(out, key=lambda f: str(f.get("modifiedTime") or ""), reverse=True)


def download(sess, f):
    """(bytes, kind). A Google Sheet is exported as .xlsx."""
    if f.get("mimeType") == MIME_GSHEET:
        url, params, kind = (f"{DRIVE_FILES}/{f['id']}/export", {"mimeType": MIME_XLSX},
                             "gsheet")
    else:
        url, params = f"{DRIVE_FILES}/{f['id']}", {"alt": "media", "supportsAllDrives": "true"}
        kind = "xlsx" if f.get("mimeType") == MIME_XLSX else "csv"
    try:
        size = int(f.get("size") or 0)
    except (TypeError, ValueError):
        size = 0
    if size > MAX_BYTES:
        raise DriveError("too_large")
    try:
        r = _get(sess, url, params=params, stream=True)
    except DriveError as e:
        # the folder listed it, so a refusal or a 404 now is THIS file's own -
        # never "share the folder"
        if e.cause in ("not_shared", "not_found"):
            raise DriveError("download_blocked", e.http) from None
        raise
    try:
        buf = io.BytesIO()
        for chunk in r.iter_content(1 << 16):
            buf.write(chunk)
            if buf.tell() > MAX_BYTES:
                raise DriveError("too_large")
        return buf.getvalue(), kind
    except DriveError:
        raise
    except Exception:  # noqa: BLE001
        raise DriveError("network") from None
    finally:
        r.close()


# ---------------------------------------------------------------------------
# Parsing (in memory)
# ---------------------------------------------------------------------------
def grids(data: bytes):
    """[(sheet number, rows)] from an .xlsx or a CSV. Raises DriveError."""
    if data[:2] == b"PK":
        try:
            import openpyxl
        except ImportError:
            raise DriveError("no_reader") from None
        try:
            wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        except Exception:  # noqa: BLE001
            raise DriveError("not_a_table") from None
        out = []
        try:
            for i, ws in enumerate(wb.worksheets, start=1):
                ws.reset_dimensions()
                rows = []
                for r in ws.iter_rows(values_only=True):
                    rows.append(list(r))
                    if len(rows) > MAX_ROWS:
                        raise DriveError("too_large")
                out.append((i, rows))
        finally:
            wb.close()
        return out
    if data[:4] in (b"\xd0\xcf\x11\xe0", b"%PDF"):
        raise DriveError("not_a_table")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1252", "replace")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    rows = []
    for r in csv.reader(io.StringIO(text), dialect):
        rows.append(r)
        if len(rows) > MAX_ROWS:
            raise DriveError("too_large")
    return [(1, rows)]


def _h(v) -> str:
    return re.sub(r"\s+", " ", str(v if v is not None else "")).strip().lower()


#: Header roles. A header is a candidate when it matches the role and none of
#: that role's exclusions; an EXACT match outranks a partial one. A person
#: column ('User performing edit', 'Counted by', 'Store Manager') and a money
#: column are never a role. (A location is published only when it is a venue
#: on the site map anyway - see parse_report.)
_PERSON = (r"manager|supervisor|contact|owner|lead\b|user|staff|person|employee|email|"
           r"e-mail|phone|by\b|\bgm\b|keeper|chef\b|director")
_ROLES = {
    "location": (re.compile(r"\b(venue|location|site|restaurant|branch|store)\b"),
                 re.compile(r"storage|area|bin\b|shelf|\bid\b|code|" + _PERSON)),
    "item": (re.compile(r"\b(ingredient|item|product|stock batch name|description|stock item)\b"),
             re.compile(r"\bid\b|code|sku|number|\bno\b|categor|group|type|unit|uom|£|price|"
                        r"cost|value|user|staff|person|by\b")),
    "count": (re.compile(r"\b(count|counted|quantity|qty|on hand|closing stock|stock level)\b"),
              re.compile(r"£|value|cost|price|variance|expected|theoretical|\bpar\b|unit|uom|"
                         r"date|by\b|user|staff|person|code|\bid\b")),
    "date": (re.compile(r"\b(date|counted on|week commencing|w/c|week)\b"),
             re.compile(r"expir|delivery|best before|use by|created|modified|edit|birth")),
}
_EXACT = frozen_ramen.HEADER_EXACT


def find_header(rows, location_optional=False):
    """-> (row index, {role: column}) or raises DriveError(header_*), with the
    missing roles named in .roles. location_optional: the file name gives the
    restaurant (Kobas's per-restaurant export), so a header with no location
    column is complete - one that has one still uses it."""
    best_missing = None
    for i, r in enumerate(rows[:10]):
        heads = [_h(c) for c in r]
        cols, ambiguous = {}, False
        for role, (want, nope) in _ROLES.items():
            # a known header is its role whatever else it holds: 'closing stock
            # units' has the 'unit' that keeps 'Unit Description' out
            cand = [(0 if h in _EXACT[role] else 1, j) for j, h in enumerate(heads)
                    if h and (h in _EXACT[role] or (want.search(h) and not nope.search(h)))]
            if not cand:
                continue
            top = min(c[0] for c in cand)
            pick = [j for rank, j in cand if rank == top]
            if len(pick) > 1:
                ambiguous = ambiguous or role != "date"
                if role == "date":
                    continue
            cols[role] = pick[0]
        roles = (("item", "count") if location_optional and "location" not in cols
                 else ("location", "item", "count"))
        need = [x for x in roles if x not in cols]
        if not need and len({cols[x] for x in roles}) == len(roles):
            if ambiguous:
                raise DriveError("header_ambiguous")
            return i, cols
        if best_missing is None or len(need) < len(best_missing):
            best_missing = need
    e = DriveError("header_missing")
    e.roles = best_missing or ["location", "item", "count"]
    raise e


def _num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v if v == v and v not in (float("inf"), float("-inf")) else None
    s = str(v or "").strip().replace(",", "")
    if not s:
        return None
    try:
        x = float(s)
    except ValueError:
        return None
    return x if x == x and x not in (float("inf"), float("-inf")) else None


_D_ISO = re.compile(r"(20\d\d)[-/._](\d{1,2})[-/._](\d{1,2})")
_D_DMY = re.compile(r"(?<!\d)(\d{1,2})[-/._](\d{1,2})[-/._](20\d\d|\d\d)(?!\d)")


def _date(v):
    """A date cell or a date inside text -> ISO date, or None."""
    if isinstance(v, datetime.datetime):
        return v.date().isoformat()
    if isinstance(v, datetime.date):
        return v.isoformat()
    s = str(v or "")
    for rx, order in ((_D_ISO, "ymd"), (_D_DMY, "dmy")):
        m = rx.search(s)
        if m:
            a, b, c = (int(x) for x in m.groups())
            y, mo, d = (a, b, c) if order == "ymd" else (c + 2000 if c < 100 else c, b, a)
            try:
                return datetime.date(y, mo, d).isoformat()
            except ValueError:
                return None
    return None


#: Kobas's own name for a report exported for ONE restaurant (26/10/2026:
#: 'KOBAS_Stock_Usage_Comparison_Report_Maki-12-Nicolson-St_2026-10-17_2026-
#: 10-24.csv'): the restaurant as a file name spells it, and the period - a
#: browser's ' (1)' and a Google Sheet's missing extension allowed.
_KOBAS_NAME = re.compile(
    r"KOBAS_\w*?Report_(?P<venue>.+?)_(?P<frm>20\d\d-\d\d-\d\d)_(?P<to>20\d\d-\d\d-\d\d)"
    r"(?:\s*\(\d{1,3}\))?(?:\.(?:csv|xlsx))?", re.I)


def kobas_name(name):
    """(the restaurant as the name spells it, the period's end date ISO) from
    Kobas's per-restaurant file name, or None. Neither is ever written."""
    m_ = _KOBAS_NAME.fullmatch(str(name or "").strip())
    if not m_:
        return None
    try:
        frm = datetime.date.fromisoformat(m_["frm"])
        to = datetime.date.fromisoformat(m_["to"])
    except ValueError:
        return None
    return (m_["venue"], to.isoformat()) if frm <= to else None


def monday(iso):
    d = datetime.date.fromisoformat(iso)
    return (d - datetime.timedelta(days=d.weekday())).isoformat()


def _clip(s, n=40):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[:n - 1] + "…"


def parse_report(data: bytes, name: str, created_at: str, match):
    """One report -> {week Monday: week record}. Raises DriveError.

    `match(label)` -> the venue's display label, or None (stock_venues). name
    and created_at decide the week only when the report has no date column;
    neither is written. created_at is Drive's createdTime - an edit does not
    move it, so a report re-saved later stays in its own week. Kobas's
    per-restaurant name (kobas_name) gives the restaurant when there is no
    location column, and the week from the period's end."""
    kob = kobas_name(name)
    by_week, header_err, headed, frozen_undated = {}, None, False, 0
    labelled, unknown = 0, 0
    for sheet_no, rows in grids(data):
        if not rows:
            continue
        try:
            hi, cols = find_header(rows, location_optional=kob is not None)
        except DriveError as e:
            header_err = header_err or e
            continue
        headed = True
        fixed = None
        if "location" not in cols:
            # one restaurant's export: the restaurant is the one its name spells
            fixed = match(kob[0])
            if fixed is None:
                raise DriveError("venue_unknown")
        width = max(cols.values()) + 1
        head = list(rows[hi]) + [None] * width
        # a header is published only when it is a known one - any other (it can
        # name a person: 'Counted (Jane)') is written as its position
        colnames = {r: (_clip(head[j]) if _h(head[j]) in frozen_ramen.HEADER_EXACT[r]
                        else f"(column {j + 1})") for r, j in cols.items() if r != "date"}
        if fixed is not None:
            colnames["location"] = "(file name)"
        if "date" in cols:
            fallback_day, week_from = None, "column"
        elif kob is not None:
            # the closing stock take is the count: the week it was taken in
            fallback_day, week_from = kob[1], "period_end"
        else:
            fallback_day = _date(name)
            week_from = "file_name" if fallback_day else "created_time"
            fallback_day = fallback_day or uk_day(created_at)
        for k, r in enumerate(rows[hi + 1:], start=hi + 2):
            r = list(r)
            if len(r) < width:
                r += [None] * (width - len(r))      # a blank or short row, never an IndexError
            item = r[cols["item"]]
            if not frozen_ramen.is_frozen_ramen(item):
                continue
            day = _date(r[cols["date"]]) if "date" in cols else fallback_day
            if not day:
                frozen_undated += 1      # cannot be put in a week: every week of this report says so
                continue
            wk = monday(day)
            w = by_week.setdefault(wk, {
                "week_commencing": wk, "week_from": week_from, "columns": colnames,
                "rows_read": len(rows) - hi - 1, "frozen_lines": 0, "items_matched": [],
                "locations": {}, "unrecognised_locations": 0, "lines_unplaced": 0,
                "problems": []})
            w["frozen_lines"] += 1
            # the cell is free text: only its canonical product is kept
            nm = frozen_ramen.canonical_item(item)
            if nm not in w["items_matched"]:
                w["items_matched"].append(nm)
            if fixed is not None:
                raw, venue = None, fixed
            else:
                raw = r[cols["location"]]
                venue = match(raw) if str(raw if raw is not None else "").strip() else None
                if str(raw if raw is not None else "").strip():
                    labelled += 1
                    if venue is None:
                        unknown += 1
            if venue is None:
                # a blank, or a label on no site map: counted, never written
                w["unrecognised_locations"] += 1
                _problem(w, f"sheet {sheet_no} row {k}: the location is "
                            + ("blank" if not str(raw if raw is not None else "").strip()
                               else "not a restaurant on the site map"))
                continue
            rec = w["locations"].setdefault(venue, {"lines": 0, "counted": 0})
            rec["lines"] += 1
            cell = r[cols["count"]]
            v = _num(cell)
            if v is not None and v >= 0:
                rec["counted"] += 1
            elif v is not None:
                _problem(w, f"sheet {sheet_no} row {k}: count is negative, so not a count")
            elif str(cell if cell is not None else "").strip():
                _problem(w, f"sheet {sheet_no} row {k}: count is not a number")
    if not headed:
        e = header_err or DriveError("header_missing")
        if e.cause == "header_missing" and getattr(e, "roles", None) == ["location"]:
            # an item and a count but no restaurant anywhere
            raise DriveError("venue_not_named") from None
        raise e
    if labelled and unknown * 2 > labelled:
        # most labels name no venue: this column is not the location (a person
        # column, a region code...) - refused, and nothing of it is written
        raise DriveError("locations_unknown")
    if frozen_undated:
        for w in by_week.values():
            # which week they belong to is unknown, so EVERY week of the report
            # carries them: its location counts are a lower bound
            w["lines_unplaced"] += frozen_undated
            _problem(w, f"{frozen_undated} frozen-ramen line(s) of this report have no "
                        "readable date and are in no week")
    if not by_week:
        raise DriveError("no_date" if frozen_undated else "no_frozen_lines")
    return by_week


def _problem(w, text):
    """At most 10 problems a week, and the 11th says there are more."""
    if len(w["problems"]) < 10:
        w["problems"].append(text)
    elif len(w["problems"]) == 10:
        w["problems"].append("more problems in this report - not listed")


def uk_day(stamp):
    """A Drive modifiedTime (UTC) -> the UK date, ISO."""
    from zoneinfo import ZoneInfo
    try:
        t = datetime.datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=datetime.timezone.utc)
    return t.astimezone(ZoneInfo("Europe/London")).date().isoformat()


def venue_matcher():
    """label -> venue display label or None, from the bake's own site map
    (house rule: the site map lives in the builder). Raises DriveError."""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "bake_ops_command", os.path.join(here, "bake_ops_command.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return frozen_ramen.site_matcher(mod.stock_venues())
    except Exception as e:  # noqa: BLE001
        print(f"[frozen_stock] the site map could not be loaded ({type(e).__name__})")
        raise DriveError("no_venues") from None


# ---------------------------------------------------------------------------
# The copy
# ---------------------------------------------------------------------------
BASIS = ("OO6 KR3's source: the frozen-ramen lines of Ross's weekly stock count reports, "
         "re-read from a Drive folder every bake. Per week (the Monday of the count's date), "
         "per restaurant on the site map: how many frozen-ramen lines the reports list and how "
         "many of them carry a number - 0 included; a blank is not a count. Kobas's Stock Usage "
         "Comparison exported for one restaurant counts for the restaurant its file name names, "
         "in the week of its closing stock take (the period's end), on Closing Stock Units "
         "(Ross, 27/10/2026). A week two reports share is merged by restaurant, the newer "
         "report winning one both list. A month's reports are re-read until day "
         f"{frozen_ramen.CLOSE_DAY} of the next month (closed_months); after that its weeks "
         "stand as they were last read. No quantity, money value, person or file name is kept. "
         "Frozen ramen is matched by name (builders/frozen_ramen.py).")


def self_check(doc) -> list[str]:
    return frozen_ramen.stock_leaks(json.dumps(doc))


def write_status(path, ok, cause, http=None, roles=None, extra=None, listed_at=None):
    """Fixed texts and stamps only. Never raises. listed_at: when an ok run
    listed the folder - the next run's read_through_at for a month it closes
    (kept from the last ok run while runs fail)."""
    now = _now()
    try:
        try:
            with open(path, encoding="utf-8") as fh:
                prev = json.load(fh)
        except (OSError, ValueError):
            prev = {}
        prev = prev if isinstance(prev, dict) else {}
        st = {"attempted_at": now, "ok": bool(ok), "cause": cause,
              "detail": CAUSE_TEXT.get(cause, CAUSE_TEXT["unexpected"])
              + (f" (missing: {', '.join(roles)})" if roles else ""),
              "http_status": http if isinstance(http, int) and not isinstance(http, bool) else None,
              "last_ok_at": now if ok else prev.get("last_ok_at"),
              "last_ok_listed_at": listed_at if ok else prev.get("last_ok_listed_at"),
              "failing_since": None if ok else (
                  (prev.get("failing_since") if prev.get("ok") is False else None) or now),
              **(extra or {})}
        _atomic_write(path, json.dumps(st, indent=1, sort_keys=True) + "\n")
    except Exception as e:  # noqa: BLE001
        print(f"[frozen_stock] could not write the status ({type(e).__name__})")


def _supersedes(new, old) -> bool:
    """A newer report's week re-lists every location an older one listed, with
    at least as many lines: a re-issue, so the older one's unplaced lines no
    longer count."""
    return (bool(old["locations"]) and set(old["locations"]) <= set(new["locations"])
            and new["frozen_lines"] >= old["frozen_lines"])


def build_weeks(reports):
    """[(stamp, kind, {week: record})], OLDEST first -> {week: merged record}."""
    contrib = {}
    for stamp, kind, weeks in reports:
        for wk, w in weeks.items():
            contrib.setdefault(wk, []).append((stamp, kind, w))
    out = {}
    for wk, cs in contrib.items():
        locs = {}
        for _s, _k, w in cs:
            for lab, rec in w["locations"].items():
                locs[lab] = dict(rec)                  # the newer report wins a location
        live = [c for i, c in enumerate(cs)
                if not any(_supersedes(n[2], c[2]) for n in cs[i + 1:])]
        unrec = sum(c[2]["unrecognised_locations"] for c in live)
        items, probs = [], []
        for _s, _k, w in reversed(cs):
            for it in w["items_matched"]:
                if it not in items:
                    items.append(it)
        shared = any(sum(lab in c[2]["locations"] for c in cs) > 1 for lab in locs)
        allp = ((["counts merged from more than one report"
                  + (" - the newer wins a location both list" if shared else "")]
                 if len(cs) > 1 else [])
                + [p_ for c in reversed(live) for p_ in c[2]["problems"]])
        for p_ in allp:
            if p_ not in probs and len(probs) < 10:
                probs.append(p_)
        if any(p_ not in probs for p_ in allp):
            probs.append("more problems in these reports - not listed")
        stamp, kind, newest = cs[-1]
        out[wk] = {**newest, "locations": dict(sorted(locs.items())), "items_matched": items,
                   "problems": probs, "unrecognised_locations": unrec,
                   "lines_unplaced": sum(c[2]["lines_unplaced"] for c in live),
                   "rows_read": max(c[2]["rows_read"] for c in cs),
                   "frozen_lines": sum(v["lines"] for v in locs.values()) + unrec,
                   "report_modified_at": stamp, "kind": kind}
    return dict(sorted(out.items()))


#: What decides whether a week CHANGED (and so gets a new read_at): what it
#: scores on, not which file or row it came from.
_SCORED = ("week_commencing", "week_from", "locations", "unrecognised_locations",
           "lines_unplaced")


def _prev_weeks(prev):
    """The last copy's weeks, if it is exactly the shape this writes; else None.
    Used to keep each unchanged week's read_at, and - only when the copy is
    this reader's own (_base) - a closed month's weeks."""
    try:
        if not isinstance(prev, dict) or frozen_ramen.stock_leaks(json.dumps(prev)):
            return None
        out = {}
        for wk, w in (prev.get("weeks") or {}).items():
            locs = w["locations"]
            assert isinstance(locs, dict) and all(
                type(r["lines"]) is int and type(r["counted"]) is int for r in locs.values())
            assert isinstance(w["read_at"], str) and isinstance(w.get("problems", []), list)
            out[wk] = w
        return out
    except Exception:  # noqa: BLE001 - a copy of another shape is rebuilt, not trusted
        return None


def _base(previous, status):
    """What this run may build on - (the last copy's weeks, {closed month:
    read_through_at}, when the last ok run listed the folder, its unread
    reports) - or None, and then every report in the window is read. Built on
    only when the copy is this reader's own (READER) and that listing time is
    known."""
    if not isinstance(previous, dict) or previous.get("reader") != READER:
        return None
    weeks = _prev_weeks(previous)
    if weeks is None:
        return None
    closed = {}
    for c in previous.get("closed_months") or []:
        if not (isinstance(c, dict) and isinstance(c.get("month"), str)
                and frozen_ramen._STAMP.fullmatch(str(c.get("read_through_at")))):
            return None
        closed[c["month"]] = _stamp(c["read_through_at"])
    seen = [_stamp(v) for v in ((status or {}).get("last_ok_listed_at"), previous.get("pulled_at"))
            if isinstance(v, str) and frozen_ramen._STAMP.fullmatch(v)]
    unread = [u for u in previous.get("unread_reports") or []
              if isinstance(u, dict) and isinstance(u.get("week"), str)]
    return (weeks, closed, max(seen), unread) if seen else None


def _saved(f):
    """When the report was last saved: Drive's modifiedTime, or its createdTime
    when that is later (an upload can keep the file's own older modified time)."""
    return max(_stamp(f.get("modifiedTime")), _stamp(f.get("createdTime")))


def _last_week(f):
    """The latest week the report can hold, before it is read: its period's
    end for Kobas's per-restaurant name, else the week it was saved in (a count
    cannot be dated after its report) or of a date in its name. None: unknown."""
    kob = kobas_name(f.get("name"))
    if kob:
        return monday(kob[1])
    day = uk_day(_saved(f)) if _saved(f) else None
    named = _date(f.get("name"))
    days = [d for d in (day, named) if d]
    return monday(max(days)) if days else None


def _stamp(v):
    """A Drive modifiedTime -> 'YYYY-MM-DDTHH:MM:SS.mmmZ' (milliseconds kept)."""
    m_ = re.match(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?", str(v or ""))
    return f"{m_.group(1)}.{(m_.group(2) or '').ljust(3, '0')[:3]}Z" if m_ else ""


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--from-file", action="append", default=[],
                    help="read this local file as the folder's contents (tests); repeatable")
    ap.add_argument("--modified-at", action="append", default=[],
                    help="the modifiedTime to give each --from-file, in order (tests); "
                         "one value is given to them all")
    ap.add_argument("--created-at", action="append", default=[],
                    help="the createdTime to give each --from-file (tests); defaults to its "
                         "modifiedTime")
    ap.add_argument("--out-dir", default=OUT_DIR)
    a = ap.parse_args(argv)
    out_path = os.path.join(a.out_dir, frozen_ramen.STOCK_FILE)
    spath = os.path.join(a.out_dir, frozen_ramen.STOCK_STATUS_FILE)
    try:
        os.makedirs(a.out_dir, exist_ok=True)
        return _run(a, out_path, spath)
    except Exception as e:  # noqa: BLE001 - every path exits 0; the type only
        print(f"[frozen_stock] unexpected error ({type(e).__name__}) - nothing written")
        write_status(spath, False, "unexpected")
        return 0


def _run(a, out_path, spath) -> int:
    pulled_at = _now()       # taken BEFORE the folder is listed: a month's read_through_at
    try:
        with open(out_path, encoding="utf-8") as fh:
            previous = json.load(fh)
    except (OSError, ValueError):
        previous = None
    try:
        with open(spath, encoding="utf-8") as fh:
            prev_status = json.load(fh)
    except (OSError, ValueError):
        prev_status = None
    prev_weeks = _prev_weeks(previous) or {}
    base = _base(previous, prev_status if isinstance(prev_status, dict) else None)
    sess = None
    try:
        if a.from_file:
            mods = a.modified_at or [pulled_at]
            made = a.created_at or []
            files = [{"_path": p_, "name": os.path.basename(p_),
                      "modifiedTime": mods[i] if i < len(mods) else mods[-1],
                      "createdTime": (made[i] if i < len(made) else made[-1]) if made
                      else (mods[i] if i < len(mods) else mods[-1]),
                      "mimeType": MIME_XLSX if p_.endswith(".xlsx") else MIME_CSV}
                     for i, p_ in enumerate(a.from_file)]
        else:
            fid = folder_id(os.environ.get("STOCK_COUNT_FOLDER_ID", ""))
            if fid is None:
                raise DriveError("no_folder_id")
            if fid is False:
                raise DriveError("bad_folder_id")
            sess = session()
            files = list_reports(sess, fid)
            if not files:
                raise DriveError("no_report")
        match = venue_matcher()
    except DriveError as e:
        print(f"[frozen_stock] not read: {e.cause} - {CAUSE_TEXT.get(e.cause, '')}")
        write_status(spath, False, e.cause, e.http)
        return 0
    import time
    t0 = time.monotonic()
    old_n = sum(1 for f in files if _stamp(f.get("modifiedTime")) < WINDOW_FROM)
    files = sorted((f for f in files if _stamp(f.get("modifiedTime")) >= WINDOW_FROM),
                   key=lambda f: _stamp(f.get("modifiedTime")))       # oldest first: the newer wins
    today = uk_day(pulled_at) or pulled_at[:10]
    first = WINDOW_FROM[:7]
    months = []
    while frozen_ramen.month_closes(first) <= today:
        months.append(first)
        first = frozen_ramen.next_month(first)
    # every month closed by today, and when the folder was last listed while it
    # was open: kept from the last copy, else (closing now) the last ok run's
    # listing, else (a full read - everything is read now) this run's
    closed = {m: (base[1].get(m) or base[2]) if base else _stamp(pulled_at) for m in months}
    in_folder = len(files) + old_n
    if base:
        # a closed month's report saved before the folder was last listed while
        # the month was open has been read: its weeks are carried, not re-read
        files = [f for f in files if not (
            (_last_week(f) or "9")[:7] in closed
            and _saved(f) and _saved(f) < closed[_last_week(f)[:7]])]
    extra = {"reports_in_folder": in_folder, "reports_before_window": old_n,
             "reports_in_closed_months": in_folder - old_n - len(files),
             "full_read": base is None}
    if len(files) > MAX_REPORTS:
        # never a copy built from part of the folder
        print(f"[frozen_stock] {len(files)} reports in the window - more than {MAX_REPORTS}; "
              "nothing written")
        write_status(spath, False, "too_many_reports", extra=extra)
        return 0
    reports, unread = [], []
    for f in files:
        if time.monotonic() - t0 > RUN_DEADLINE_S:
            print("[frozen_stock] the run's time limit passed - nothing written")
            write_status(spath, False, "timeout", extra=extra)
            return 0
        st_ = _stamp(f.get("modifiedTime")) or _stamp(pulled_at)
        try:
            if sess is None:
                with open(f["_path"], "rb") as fh:
                    data, kind = fh.read(), ("xlsx" if f["mimeType"] == MIME_XLSX else "csv")
            else:
                data, kind = download(sess, f)
            try:
                weeks = parse_report(data, str(f.get("name") or ""),
                                     str(f.get("createdTime") or f.get("modifiedTime")), match)
            except DriveError:
                raise
            except Exception as e:  # noqa: BLE001 - a parse error is the REPORT'S, never transient
                print(f"[frozen_stock] a report could not be parsed ({type(e).__name__})")
                raise DriveError("report_unreadable") from None
        except DriveError as e:
            print(f"[frozen_stock] a report was not read: {e.cause} - "
                  f"{CAUSE_TEXT.get(e.cause, '')}")
            if e.cause in TRANSIENT:
                # not the report's fault: write nothing, keep the last copy
                write_status(spath, False, e.cause, e.http, extra=extra)
                return 0
            kob = kobas_name(f.get("name"))
            unread.append({"modified_at": st_, "cause": e.cause,
                           "detail": CAUSE_TEXT.get(e.cause, CAUSE_TEXT["unexpected"])
                           + (f" (missing: {', '.join(e.roles)})"
                              if getattr(e, "roles", None) else ""),
                           # Kobas's per-restaurant name says which week it is
                           # for: the entry stays named once its month closes
                           **({"week": monday(kob[1])} if kob else {})})
            continue
        if base:
            # a closed month's weeks come from the last copy only; a report
            # saved after the month closed was never read - it is named
            late = False
            for wk in [wk for wk in weeks if wk[:7] in closed]:
                late = late or (_saved(f) or st_) >= closed[wk[:7]]
                del weeks[wk]
            if late:
                print("[frozen_stock] a report holds a week of a closed month, saved after it "
                      "closed - that week is not used")
                unread.append({"modified_at": st_, "cause": "month_closed",
                               "detail": CAUSE_TEXT["month_closed"]})
            if not weeks:
                continue
        reports.append((st_, kind, weeks))
        print(f"[frozen_stock] read a {kind} report: " + ", ".join(
            f"w/c {wk} {sum(1 for r in w['locations'].values() if r['counted'])} of "
            f"{len(w['locations'])} restaurant(s) with a count" for wk, w in sorted(weeks.items())))
    weeks = build_weeks(reports)
    for wk, w in list(weeks.items()):
        # counts unchanged since the last copy: keep the read_at they were
        # first read with (a re-save or a new row elsewhere is not news)
        old = prev_weeks.get(wk)
        same = old is not None and all(old.get(k) == w.get(k) for k in _SCORED)
        weeks[wk] = {**w, "read_at": old["read_at"] if same else pulled_at}
    if base:
        for wk, w in base[0].items():
            if wk[:7] in closed:
                weeks[wk] = w            # exactly as last read
        # a closed month's report that could not be read is not read again, and
        # stays named: carried as the last copy listed it
        unread += [u for u in base[3] if u["week"][:7] in closed and u not in unread]
    doc = {"pulled_at": pulled_at, "basis": BASIS, "reader": READER,
           "weeks": dict(sorted(weeks.items()))}
    if closed:
        doc["closed_months"] = [{"month": m, "read_through_at": rt}
                                for m, rt in sorted(closed.items())]
    if unread:
        doc["unread_reports"] = sorted(unread, key=lambda u: u["modified_at"])
    extra.update({"reports_read": len(reports), "reports_unreadable": len(unread),
                  "unread_causes": sorted({u["cause"] for u in unread})})
    bad = self_check(doc)
    if bad:
        print(f"[frozen_stock] REFUSED: the result holds something that may not be published "
              f"at {', '.join(bad[:5])} - {frozen_ramen.STOCK_FILE} left untouched")
        write_status(spath, False, "refused", extra=extra)
        return 0
    same_doc = isinstance(previous, dict) and {k: v for k, v in previous.items()
                                               if k != "pulled_at"} == \
        {k: v for k, v in doc.items() if k != "pulled_at"}
    if not same_doc:
        try:
            _atomic_write(out_path, json.dumps(doc, indent=1, sort_keys=True,
                                               allow_nan=False) + "\n")
        except Exception as e:  # noqa: BLE001
            print(f"[frozen_stock] could not write the copy ({type(e).__name__})")
            write_status(spath, False, "write_failed", extra=extra)
            return 0
    # the read worked: the folder was read and the copy is current. A report
    # it could not read is the copy's news (unread_reports, named on OO6 KR3),
    # not a failed read - so it never makes the weeks look stale.
    write_status(spath, True, "ok", 200 if sess else None, extra=extra, listed_at=pulled_at)
    return 0


if __name__ == "__main__":
    sys.exit(main())
