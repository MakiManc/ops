#!/usr/bin/env python3
"""Refresh data/ops_command/maintenance_contacts.json from the Maintenance Contact List 2026.

WHY THIS EXISTS. OO2 KR5 on Matthew's sheet is "100% Completion of
Maintenance Contact Sheets - Proof Required", and the only contact sheet in
the estate is the "Maintenance Contact List 2026" Google Sheet: one tab per
city, one row per contractor, columns Scope | Company Name | Contact Number |
Email | Location | Notes | Call Out Rate/hR. This script is the path from that
sheet to the bake (Phase 1, 10/10/2026).

STRUCTURE ONLY - THE CELLS NEVER LEAVE THIS PROCESS. MakiManc/ops is a PUBLIC
repository and every cell on that sheet is a company name, a phone number, an
email address, a location or a rate. So this reads each tab and writes, per
tab, only:
    its title and gid, its header row (column names), and one fill pattern per
    contractor row - a string with one character per header column, "x" where
    the cell is filled and "." where it is blank.
That is everything the bake needs to decide "does this tab hold a contact" and
nothing a reader could ring. Before writing, a self-check refuses the whole
file if any string in it holds an '@', a '£' or a run of six or more digits,
and no log line ever prints a cell. The site map and the coverage rule
live in the bake (CONTACT_TAB_SITES, CONTACT_REACH_COLUMNS in
bake_ops_command.py), not here, so changing either needs no new pull.

Rows: the header is the first row (within the first five) carrying both
"Scope" and "Contact Number". Every row below it with ANY non-blank cell
under the header is a contractor row - blank rows are skipped, not treated as
the end (the Sheffield tab has eleven blank rows and then one more entry).

FAIL SOFT, ALWAYS, AND SAY WHY. Same contract as refresh_okr_sources.py: on
any failure the committed file is left untouched, the script exits 0, and
maintenance_contacts_status.json records a cause code with FIXED text - never
an exception message, because that file is public too.

THE SHEET ID IS NOT IN THIS FILE, ON PURPOSE (10/10/2026). The list is
shared "anyone with the link can edit", so its id works as a password: whoever
has it can read every contractor's details and rewrite OO2 KR5. This
repository is public, so the id comes from CONTACTS_SHEET_ID, set in the
private maki-hospitality-etl workflow, and is never written to the output.
Without it the script records cause no_sheet_id and changes nothing.
Recommended to Ross: restrict the list to the domain AND share it with the
service account as Viewer at the same time - restricting it alone would cut
this script off, exactly as the Operations Input sheet is cut off today.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refresh_okr_sources import _atomic_write, _now, classify  # noqa: E402

log = logging.getLogger("refresh_maintenance_contacts")

#: From the private workflow only - see THE SHEET ID IS NOT IN THIS FILE.
SHEET_ID = os.environ.get("CONTACTS_SHEET_ID", "").strip()
OUT_DIR = os.environ.get("OPS_COMMAND_OUT_DIR", "").strip() or \
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "ops_command")
OUT_FILE = "maintenance_contacts.json"
STATUS_FILE = "maintenance_contacts_status.json"
HEADER_NEEDLES = ("scope", "contact number")
#: A header cell longer than this, or one that fails the self-check, is
#: published as "(column X)" instead of its text.
HEADER_MAX = 40

CAUSE_TEXT = {
    "ok": "read every tab",
    "no_sheet_id": "CONTACTS_SHEET_ID is not set for the refresh step, so the "
                   "list was not asked for",
    "no_credentials": "GOOGLE_SA_JSON is not set for the refresh step, so the "
                      "list was not asked for",
    "credentials_malformed": "GOOGLE_SA_JSON is set but is not a usable "
                             "service-account key",
    "auth_failed": "Google refused the service account's credentials",
    "not_shared": "HTTP 403 - the Maintenance Contact List is not readable by "
                  "the service account (its link sharing may have been "
                  "restricted); share it with the service account as Viewer",
    "not_found": "HTTP 404 - no sheet with this id is visible to the service "
                 "account (deleted, or moved out of its owner's Drive)",
    "quota": "HTTP 429 - the Google Sheets API quota was exceeded",
    "google_down": "Google Sheets did not answer (HTTP 5xx, a timeout or a "
                   "dropped connection)",
    "nothing_parsed": "the sheet opened but no tab has a Scope / Contact Number "
                      "header row; the last file was left untouched",
    "self_check_failed": "the structure-only output still held something that "
                         "looks like contact data, so it was NOT written; the "
                         "last file was left untouched",
    "write_failed": "maintenance_contacts.json could not be written; the last "
                    "file was left in place",
    "unexpected": "an unexpected error - the bake log names its type",
}

_SUSPECT = re.compile(r"@|£|\+\s*\d|\d{6,}")


def _contacty(s: str) -> bool:
    """Could this free-text cell (a tab title, a header) be contact data?

    Stricter than _SUSPECT: SIX OR MORE DIGITS IN TOTAL, however they are
    spaced, so '0161 496 0000' and '+44 7700 900 123' are caught as well as
    an unspaced run. Column names and city names carry none.
    """
    return bool(_SUSPECT.search(s)) or sum(ch.isdigit() for ch in s) >= 6


def _col(j: int) -> str:
    s, j = "", j + 1
    while j:
        j, r = divmod(j - 1, 26)
        s = chr(65 + r) + s
    return s


def build_tab(title: str, gid, rows) -> dict:
    """One worksheet's values -> its structure-only record."""
    hdr_i = None
    for i, r in enumerate(rows[:5]):
        cells = [str(c).strip().casefold() for c in r]
        if all(n in cells for n in HEADER_NEEDLES):
            hdr_i = i
            break
    if hdr_i is None:
        log.error("tab %r: no row in the first five carries both 'Scope' and "
                  "'Contact Number' - recorded with no header and no rows.", title)
        return {"title": title, "gid": gid, "header": [], "header_row": None,
                "rows": []}
    raw_hdr = [str(c).strip() for c in rows[hdr_i]]
    while raw_hdr and not raw_hdr[-1]:
        raw_hdr.pop()
    header = [h if (h and len(h) <= HEADER_MAX and not _contacty(h))
              else f"(column {_col(j)})" for j, h in enumerate(raw_hdr)]
    width = len(header)
    fills = []
    for r in rows[hdr_i + 1:]:
        cells = [str(c).strip() for c in list(r)[:width]] + [""] * width
        cells = cells[:width]
        if not any(cells):
            continue
        fills.append("".join("x" if c else "." for c in cells))
    return {"title": title, "gid": gid, "header": header,
            "header_row": hdr_i + 1, "rows": fills}


def self_check(doc: dict) -> list[str]:
    """Where, if anywhere, the output still holds something contact-like.

    Every STRING in the document is checked - titles, headers, fill
    patterns, timestamps - for an '@', a '£', a '+' before a digit or six
    digits in a row; tab titles and header cells, the free text, are held to
    _contacty (six digits in total, however spaced). Integers (gids) are not
    strings and are exempt. Returns locations only, never the offending text.
    """
    bad = []

    def walk(x, path):
        if isinstance(x, str):
            free = path.endswith(".title") or ".header[" in path
            if (_contacty(x) if free else _SUSPECT.search(x)):
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


def fetch(sheet_id: str, spreadsheet=None) -> list[tuple]:
    """-> [(title, gid, rows)] for every worksheet. Logs titles and gids only."""
    if spreadsheet is None:
        from refresh_okr_sources import open_sheet
        spreadsheet = open_sheet(sheet_id)
    sheets = spreadsheet.worksheets()
    log.info("worksheets in the Maintenance Contact List: %s",
             ", ".join(f"{w.title!r} (gid {w.id})" for w in sheets))
    return [(w.title, w.id, w.get_all_values()) for w in sheets]


def write_status(path: str, ok: bool, cause: str, http_status=None) -> None:
    now = _now()
    try:
        prev = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                prev = json.load(fh) or {}
        rec = {"attempted_at": now, "ok": ok, "cause": cause,
               "detail": CAUSE_TEXT.get(cause, CAUSE_TEXT["unexpected"]),
               "http_status": http_status,
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
    ap.add_argument("--from-json", help="parse this dump ({title: rows}) instead "
                                        "of calling Google")
    ap.add_argument("--out", default=os.path.join(OUT_DIR, OUT_FILE))
    ap.add_argument("--print", action="store_true", help="print, do not write")
    a = ap.parse_args(argv)
    sheet_id = os.environ.get("CONTACTS_SHEET_ID", "").strip() or SHEET_ID
    out_path = os.path.abspath(a.out)
    status_path = os.path.join(os.path.dirname(out_path), STATUS_FILE)
    status = (lambda *x, **k: None) if a.print else \
        (lambda *x, **k: write_status(status_path, *x, **k))

    try:
        if a.from_json:
            with open(a.from_json, encoding="utf-8") as fh:
                raw = json.load(fh)
            fetched = [(t, -1, rows) for t, rows in raw.items()]
        elif not sheet_id:
            log.error("CONTACTS_SHEET_ID is not set - %s left untouched. It is set "
                      "in the private maki-hospitality-etl workflow, never here.",
                      OUT_FILE)
            status(False, "no_sheet_id")
            return 0
        else:
            fetched = fetch(sheet_id)
    except Exception as exc:  # noqa: BLE001 - fail soft by design
        cause, http = classify(exc)
        # type only: an exception message from a read of this sheet could
        # quote a cell, and even the private bake log does not need one
        log.error("could not read the Maintenance Contact List: %s (%s). "
                  "Leaving %s untouched.", cause, type(exc).__name__, OUT_FILE)
        status(False, cause, http)
        return 0

    try:
        tabs = [build_tab(str(t).strip(), g, rows) for t, g, rows in fetched]
    except Exception as exc:  # noqa: BLE001
        log.error("parsing the contact list failed: %s - %s untouched",
                  type(exc).__name__, OUT_FILE)
        status(False, "unexpected")
        return 0
    if not any(t["header"] for t in tabs):
        log.error("no tab of the contact list has a Scope / Contact Number header "
                  "- %s left untouched.", OUT_FILE)
        status(False, "nothing_parsed")
        return 0
    for t in tabs:
        log.info("tab %r (gid %s): %d contractor row(s), header %s", t["title"],
                 t["gid"], len(t["rows"]), " | ".join(t["header"]) or "(none)")

    doc = {
        "pulled_at": _now(),
        # no sheet id: see THE SHEET ID IS NOT IN THIS FILE
        "tabs": tabs,
        "basis": ("Structure only, from the Maintenance Contact List 2026: per city "
                  "tab, its column names and one fill pattern per contractor row "
                  "('x' filled, '.' blank, one character per column). No cell "
                  "value is ever written here - this repository is public."),
    }
    bad = self_check(doc)
    if bad:
        log.error("SELF-CHECK FAILED - %d place(s) look like contact data (%s). "
                  "Nothing written.", len(bad), ", ".join(bad[:10]))
        status(False, "self_check_failed")
        return 0
    if a.print:
        print(json.dumps(doc, indent=2, sort_keys=True))
        return 0
    try:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        _atomic_write(out_path, json.dumps(doc, indent=1, sort_keys=True,
                                           allow_nan=False) + "\n")
    except Exception as exc:  # noqa: BLE001
        log.error("could not write %s (%s) - previous file left in place",
                  out_path, type(exc).__name__)
        status(False, "write_failed")
        return 0
    log.info("wrote %s", out_path)
    status(True, "ok", None if a.from_json else 200)
    return 0


if __name__ == "__main__":
    sys.exit(main())
