#!/usr/bin/env python3
"""Refresh data/ops_command/frozen_stock_count.json from Ross's weekly stock count report.

OO6 KR3 (Ross, 21/10/2026): "% of locations with a frozen ramen count that
week". Ross drops the weekly stock count report into a Drive folder; each bake
reads the newest report(s) from it, keeps only the frozen-ramen lines, and
records per location how many lines it listed and how many carry a number.
builders/frozen_ramen.py (kr3_months) turns that into the scorecard row.

WHERE THE FOLDER IS. The folder id comes from the STOCK_COUNT_FOLDER_ID secret
of maki-hospitality-etl's bake workflow - the bare id or the whole folder
link. It is never logged, never written, and never in this public file. The
folder must be shared with the service account (client_email in
GOOGLE_SA_JSON) as Viewer, or the service account added to its shared drive:
"anyone with the link" does not put a file into a listing.

WHAT IS READ. CSV, .xlsx and Google Sheets in the folder (not in subfolders),
newest first by Drive's modifiedTime. Every report modified since the newest
one already read is read, oldest first, up to MAX_FILES - so two reports
dropped between bakes are both kept, and the newest wins a week they share.
More than that is named in the status, never dropped silently.

WHAT IS WRITTEN - AND WHAT IS NOT. The copy is committed to the PUBLIC ops
repo, so it carries location labels as the report writes them, the frozen-
ramen product names that matched, line counts, header names and dates. Never
a quantity, a money value, a person, the file's name or id, or any other cell:
the download is held in memory and parsed there, and nothing of it is written
to disk. self_check() refuses the result outright before it is written, and
the bake refuses it again (frozen_ramen.stock_leaks).

THE WEEK a count belongs to is the Monday of a date column when the report has
one, else of a date in the file's name, else of the day Drive says the file
was modified (UK time) - and each week records which (week_from).

A BLANK IS NOT A ZERO. A count cell that is empty, or text, is not a count; a
0 is. A frozen-ramen line with no number is recorded as listed but not counted.

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
#: Reports read per run (the newest first; the rest are named in the status).
MAX_FILES = 4
#: Rows read from one sheet; a longer sheet is refused, never cut short.
MAX_ROWS = 50000
MIME_CSV = "text/csv"
MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MIME_GSHEET = "application/vnd.google-apps.spreadsheet"
MIME_FOLDER = "application/vnd.google-apps.folder"

#: Fixed, public text per cause. NEVER interpolate an exception message, a
#: file name or an id here.
CAUSE_TEXT = {
    "ok": "read the newest stock count report(s)",
    "no_new_report": "no report has been added or changed in the folder since the last read",
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
    "no_report": "the folder holds no CSV, .xlsx or Google Sheet",
    "too_large": "a report is far larger than a stock count",
    "not_a_table": "a report is not a CSV or .xlsx table (a legacy .xls or a PDF cannot be read)",
    "no_reader": "the bake could not load openpyxl, the .xlsx reader - the runner's fault, not "
                 "the report's",
    "header_missing": "a report has no header row naming a location, an item and a count "
                      "column - the status names the missing role",
    "header_ambiguous": "a report has two columns that could each be the location, the item or "
                        "the count",
    "no_date": "a report's frozen-ramen lines have no readable date in its date column",
    "no_frozen_lines": "a report was read but no line in it is frozen ramen by name - if the "
                       "products were renamed, builders/frozen_ramen.py needs the new name",
    "refused": "the result failed the publication check, so nothing was written",
    "write_failed": "frozen_stock_count.json could not be written; the last file was left in "
                    "place",
    "unexpected": "an unexpected error - the bake log names its type",
}

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
    if r.status_code == 429 or re.search(r"[rR]ateLimitExceeded|quotaExceeded", body):
        return "rate_limited"
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
                  "fields": "nextPageToken, files(id, name, mimeType, modifiedTime, size)",
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
    r = _get(sess, url, params=params, stream=True)
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
#: column ('User performing edit', 'Counted by') and a money column are never
#: a role, so they are never read.
_ROLES = {
    "location": (re.compile(r"\b(venue|location|site|restaurant|branch|store)\b"),
                 re.compile(r"storage|area|bin\b|shelf|\bid\b|code")),
    "item": (re.compile(r"\b(ingredient|item|product|stock batch name|description|stock item)\b"),
             re.compile(r"\bid\b|code|sku|number|\bno\b|categor|group|type|unit|uom|£|price|"
                        r"cost|value|user|staff|person|by\b")),
    "count": (re.compile(r"\b(count|counted|quantity|qty|on hand|closing stock|stock level)\b"),
              re.compile(r"£|value|cost|price|variance|expected|theoretical|\bpar\b|unit|uom|"
                         r"date|by\b|user|staff|person|code|\bid\b")),
    "date": (re.compile(r"\b(date|counted on|week commencing|w/c|week)\b"),
             re.compile(r"expir|delivery|best before|use by|created|modified|edit|birth")),
}
_EXACT = {"location": {"venue", "location", "site", "restaurant", "branch", "store"},
          "item": {"ingredient", "item", "product", "stock batch name", "description",
                   "stock item", "item name", "product name", "ingredient name"},
          "count": {"count", "counted", "quantity", "qty", "on hand", "closing stock",
                    "stock count", "counted quantity", "count quantity"},
          "date": {"date", "count date", "stock count date", "counted on", "week commencing",
                   "w/c"}}


def find_header(rows):
    """-> (row index, {role: column}) or raises DriveError(header_*), with the
    missing roles named in .roles."""
    best_missing = None
    for i, r in enumerate(rows[:10]):
        heads = [_h(c) for c in r]
        cols, ambiguous = {}, False
        for role, (want, nope) in _ROLES.items():
            cand = [(0 if h in _EXACT[role] else 1, j) for j, h in enumerate(heads)
                    if h and want.search(h) and not nope.search(h)]
            if not cand:
                continue
            top = min(c[0] for c in cand)
            pick = [j for rank, j in cand if rank == top]
            if len(pick) > 1:
                ambiguous = ambiguous or role != "date"
                if role == "date":
                    continue
            cols[role] = pick[0]
        need = [x for x in ("location", "item", "count") if x not in cols]
        if not need and len({cols["location"], cols["item"], cols["count"]}) == 3:
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


def monday(iso):
    d = datetime.date.fromisoformat(iso)
    return (d - datetime.timedelta(days=d.weekday())).isoformat()


def _clip(s, n=40):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[:n - 1] + "…"


def parse_report(data: bytes, name: str, modified_at: str):
    """One report -> {week Monday: week record}. Raises DriveError.

    name and modified_at decide the week only when the report has no date
    column; neither is written."""
    by_week, header_err, headed, frozen_undated = {}, None, False, 0
    for sheet_no, rows in grids(data):
        if not rows:
            continue
        try:
            hi, cols = find_header(rows)
        except DriveError as e:
            header_err = header_err or e
            continue
        headed = True
        head = rows[hi]
        colnames = {r: (_clip(head[j]) or f"(column {j + 1})") for r, j in cols.items()
                    if r != "date"}
        if "date" in cols:
            fallback_day, week_from = None, "column"
        else:
            fallback_day = _date(name)
            week_from = "file_name" if fallback_day else "modified_time"
            fallback_day = fallback_day or uk_day(modified_at)
        for k, r in enumerate(rows[hi + 1:], start=hi + 2):
            r = list(r) + [None] * 8
            item = r[cols["item"]]
            if not frozen_ramen.is_frozen_ramen(item):
                continue
            day = _date(r[cols["date"]]) if "date" in cols else fallback_day
            if not day:
                frozen_undated += 1      # cannot be put in a week; counted in the status
                continue
            wk = monday(day)
            w = by_week.setdefault(wk, {
                "week_commencing": wk, "week_from": week_from, "columns": colnames,
                "rows_read": len(rows) - hi - 1, "frozen_lines": 0, "items_matched": [],
                "locations": {}, "unrecognised_locations": 0, "problems": []})
            w["frozen_lines"] += 1
            nm = _clip(item, 80)
            if nm not in w["items_matched"] and len(w["items_matched"]) < 20:
                w["items_matched"].append(nm)
            loc = _clip(r[cols["location"]], 60)
            if not loc or frozen_ramen._SUSPECT.search(loc) or frozen_ramen._ID_LIKE.search(loc):
                w["unrecognised_locations"] += 1
                _problem(w, f"sheet {sheet_no} row {k}: no usable location")
                continue
            rec = w["locations"].setdefault(loc, {"lines": 0, "counted": 0})
            rec["lines"] += 1
            cell = r[cols["count"]]
            v = _num(cell)
            if v is not None and v >= 0:
                rec["counted"] += 1
            elif str(cell if cell is not None else "").strip():
                _problem(w, f"sheet {sheet_no} row {k}: count is not a number")
    if not headed:
        raise header_err or DriveError("header_missing")
    if frozen_undated:
        for w in by_week.values():
            _problem(w, f"{frozen_undated} frozen-ramen line(s) of this report have no "
                        "readable date and are in no week")
    if not by_week:
        raise DriveError("no_date" if frozen_undated else "no_frozen_lines")
    return by_week


def _problem(w, text):
    """At most 10 problems a week, and the 11th says how many more."""
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


# ---------------------------------------------------------------------------
# The copy
# ---------------------------------------------------------------------------
BASIS = ("OO6 KR3's source: the frozen-ramen lines of Ross's weekly stock count report, "
         "read from a Drive folder. Per week (the Monday of the count's date), per location "
         "as the report names it: how many frozen-ramen lines it lists and how many of them "
         "carry a number - 0 included; a blank is not a count. No quantity, money value, "
         "person or file name is kept. Frozen ramen is matched by name "
         "(builders/frozen_ramen.py).")


def self_check(doc) -> list[str]:
    return frozen_ramen.stock_leaks(json.dumps(doc))


def write_status(path, ok, cause, http=None, roles=None, extra=None):
    """Fixed texts and stamps only. Never raises."""
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
              "failing_since": None if ok else (
                  (prev.get("failing_since") if prev.get("ok") is False else None) or now),
              **(extra or {})}
        _atomic_write(path, json.dumps(st, indent=1, sort_keys=True) + "\n")
    except Exception as e:  # noqa: BLE001
        print(f"[frozen_stock] could not write the status ({type(e).__name__})")


def merge(previous, new_weeks, pulled_at):
    weeks = dict((previous or {}).get("weeks") or {})
    for wk, w in new_weeks.items():
        weeks[wk] = w
    return {"pulled_at": pulled_at, "basis": BASIS,
            "weeks": dict(sorted(weeks.items()))}


def _stamp(v):
    """A Drive modifiedTime ('2026-10-20T09:15:31.123Z') -> '2026-10-20T09:15:31Z',
    so stored and listed stamps compare as equals."""
    s_ = str(v or "")
    return s_[:19] + "Z" if re.match(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d", s_) else ""


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--from-file", action="append", default=[],
                    help="read this local report instead of Drive (tests); repeatable")
    ap.add_argument("--modified-at", help="the modifiedTime to give --from-file (tests)")
    ap.add_argument("--out-dir", default=OUT_DIR)
    a = ap.parse_args(argv)
    out_path = os.path.join(a.out_dir, frozen_ramen.STOCK_FILE)
    spath = os.path.join(a.out_dir, frozen_ramen.STOCK_STATUS_FILE)
    os.makedirs(a.out_dir, exist_ok=True)
    pulled_at = _now()
    previous = None
    try:
        with open(out_path, encoding="utf-8") as fh:
            previous = json.load(fh)
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        previous = False
    if previous is False or (previous is not None and (
            not isinstance(previous, dict) or frozen_ramen.stock_leaks(json.dumps(previous)))):
        # never build on a copy this cannot read or would not publish: its weeks
        # cannot be carried, and rewriting it would drop them without saying so
        print(f"[frozen_stock] {frozen_ramen.STOCK_FILE} is unreadable or fails the "
              "publication check - left untouched, nothing read. Restore it from git "
              "history or delete it (the next read starts a new one)")
        write_status(spath, False, "refused")
        return 0
    newest_read = max((_stamp(w.get("report_modified_at"))
                       for w in ((previous or {}).get("weeks") or {}).values()
                       if isinstance(w, dict)), default="")
    sess = None
    try:
        if a.from_file:
            files = [{"_path": p, "name": os.path.basename(p),
                      "modifiedTime": a.modified_at or pulled_at,
                      "mimeType": MIME_XLSX if p.endswith(".xlsx") else MIME_CSV}
                     for p in a.from_file]
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
    except DriveError as e:
        print(f"[frozen_stock] not read: {e.cause} - {CAUSE_TEXT.get(e.cause, '')}")
        write_status(spath, False, e.cause, e.http)
        return 0
    except Exception as e:  # noqa: BLE001 - the type only: the text can carry an id
        print(f"[frozen_stock] unexpected error ({type(e).__name__}) - nothing read")
        write_status(spath, False, "unexpected")
        return 0
    # OLDEST FIRST, so the newest wins a week two reports share - and a batch
    # larger than MAX_FILES is read over several runs, never dropped: the rest
    # are newer than everything read, so the next run still sees them.
    fresh = sorted((f for f in files if _stamp(f.get("modifiedTime")) > newest_read),
                   key=lambda f: _stamp(f.get("modifiedTime")))
    if not fresh:
        print("[frozen_stock] no report added or changed since the last read - "
              f"{frozen_ramen.STOCK_FILE} left as it is")
        write_status(spath, True, "no_new_report", 200 if sess else None)
        return 0
    waiting = max(0, len(fresh) - MAX_FILES)
    new_weeks, failed = {}, []
    for f in fresh[:MAX_FILES]:
        try:
            if sess is None:
                with open(f["_path"], "rb") as fh:
                    data, kind = fh.read(), ("xlsx" if f["mimeType"] == MIME_XLSX else "csv")
            else:
                data, kind = download(sess, f)
            weeks = parse_report(data, str(f.get("name") or ""), str(f.get("modifiedTime")))
        except DriveError as e:
            failed.append(e)
            print(f"[frozen_stock] a report was not read: {e.cause} - "
                  f"{CAUSE_TEXT.get(e.cause, '')}")
            continue
        except Exception as e:  # noqa: BLE001
            failed.append(DriveError("unexpected"))
            print(f"[frozen_stock] a report was not read ({type(e).__name__})")
            continue
        for wk, w in weeks.items():
            w.update({"report_modified_at": _stamp(f.get("modifiedTime")) or pulled_at,
                      "read_at": pulled_at, "kind": kind})
            new_weeks[wk] = w
        print(f"[frozen_stock] read a {kind} report: " + ", ".join(
            f"w/c {wk} {sum(1 for r in w['locations'].values() if r['counted'])} of "
            f"{len(w['locations'])} location(s) with a count" for wk, w in sorted(weeks.items())))
    extra = {"reports_read": len(fresh[:MAX_FILES]) - len(failed),
             "reports_failed": len(failed), "reports_waiting": waiting}
    if waiting:
        print(f"[frozen_stock] {waiting} newer report(s) wait for the next run "
              f"(at most {MAX_FILES} a run)")
    if not new_weeks:
        e = failed[0] if failed else DriveError("unexpected")
        write_status(spath, False, e.cause, e.http, roles=getattr(e, "roles", None), extra=extra)
        return 0
    doc = merge(previous, new_weeks, pulled_at)
    bad = self_check(doc)
    if bad:
        print(f"[frozen_stock] REFUSED: the result holds something that may not be published "
              f"at {', '.join(bad[:5])} - {frozen_ramen.STOCK_FILE} left untouched")
        write_status(spath, False, "refused", extra=extra)
        return 0
    try:
        os.makedirs(a.out_dir, exist_ok=True)
        _atomic_write(out_path, json.dumps(doc, indent=1, sort_keys=True, allow_nan=False) + "\n")
    except Exception as e:  # noqa: BLE001
        print(f"[frozen_stock] could not write the copy ({type(e).__name__})")
        write_status(spath, False, "write_failed", extra=extra)
        return 0
    if failed:
        e = failed[0]
        write_status(spath, False, e.cause, e.http, roles=getattr(e, "roles", None), extra=extra)
    else:
        write_status(spath, True, "ok", 200 if sess else None, extra=extra)
    return 0


if __name__ == "__main__":
    sys.exit(main())
