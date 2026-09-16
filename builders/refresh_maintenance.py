#!/usr/bin/env python3
"""Refresh data/ops_command/maintenance_source.json from Lincoln's sheet.

WHY THIS EXISTS. The Maintenance tab was frozen for three weeks (source_as_of
2026-08-19, pulled 2026-08-25) and the reason was structural, not neglect:
the refresh was done by hand through a browser connector, and the scheduled
task that was supposed to do it runs headless in GitHub Actions with no
browser. Fifteen consecutive scheduled refreshes built the data and could not
commit it. A job that can only succeed when a human is watching is not a
scheduled job.

WHAT CHANGED. Nothing about the credential - and that is the point. The ETL
has had a Google service account (GOOGLE_SA_JSON) since external_sheets.py
went in, and external_sheets.py ALREADY reads this exact spreadsheet id every
day. It just writes it to a tab in the KPI workbook, which the bake cannot
see. So the sheet was never unreachable from Actions; the parsed form of it
simply had no automated path into data/ops_command/. This script is that path.
No new secret, no browser, no Ross-side credential step.

Run it before the bake, in the workflow that already checks out the ops repo
and holds the push token (ops_command_bake.yml). It writes the same JSON
schema bake_ops_command.py already reads, so nothing downstream changes.

FAIL SOFT, ALWAYS. If the sheet cannot be read - access revoked, tab renamed,
Google down - this leaves the existing committed file untouched and exits 0
with a loud log. A maintenance refresh must never be the reason the whole
dashboard fails to bake. Staleness is visible on the tab (source_as_of is
rendered); a failed bake is not.
"""

from __future__ import annotations

import argparse
import datetime
import json
import logging
import os
import re
import sys

log = logging.getLogger("refresh_maintenance")

# The spreadsheet external_sheets.py already pulls daily (EXT_MAINTENANCE_ID).
# Same id, deliberately: if it ever moves, both should move together.
SHEET_ID = os.environ.get("EXT_MAINTENANCE_ID", "").strip() or \
    "1_ssmA8xOdmdb8tKspL4qVvQ5DWYM1lVvI83iwrEyClA"
SHEET_NAME = "Required Maintenance/Repair (Responses)"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "data", "ops_command")

# Site-code -> canonical dashboard site. The codes come from the estate's own
# M-numbering, and every pair below is corroborated twice: against the M-codes
# written beside SITE_REGIONS in bake_ops_command.py, and against the raw_site
# -> site pairs in the hand-built maintenance_source.json that Ross already
# signed off (2026-08-19). Nothing here is inferred from a site's name.
#
# 'Maki 1/2' is the one addition to that signed-off set, and it is evidenced
# rather than guessed: it sat in unresolved_site_labels because nobody could
# confirm it, and Flow Branches' trainee_feed_identifier now records M1TOO Ltd
# as 'Maki 1/2 (Nicolson St)' - Flow's own first-party mapping, stable across
# every archived pull. Same evidence that closed the cross-reference aliases.
SITE_CODES = {
    "m1":  "M1TOO Ltd",              "maki 1":  "M1TOO Ltd",
    "m1/2": "M1TOO Ltd",             "maki 1/2": "M1TOO Ltd",
    "m3":  "Fountain Good Food Ltd", "maki 3":  "Fountain Good Food Ltd",
    "m5":  "South Ikigai Ltd",       "maki 5":  "South Ikigai Ltd",
    "iki2": "South Ikigai Ltd",      "iki 2":   "South Ikigai Ltd",
    "m6":  "Maki Bath St",           "maki 6":  "Maki Bath St",
    "m7":  "Maki SJQ Ltd",           "maki 7":  "Maki SJQ Ltd",
    "m8":  "Renfield Good Food Ltd", "maki 8":  "Renfield Good Food Ltd",
    "m9":  "Maki Manchester LTD",    "maki 9":  "Maki Manchester LTD",
    "m10": "Maki Leeds Ltd",         "maki 10": "Maki Leeds Ltd",
    "m11": "Maki Leicester Ltd",     "maki 11": "Maki Leicester Ltd",
    "m12": "Maki Newcastle Ltd",     "maki 12": "Maki Newcastle Ltd",
    "m13": "Maki Aberdeen Ltd",      "maki 13": "Maki Aberdeen Ltd",
    "m14": "Maki Meadowhall",        "maki 14": "Maki Meadowhall",
    "m15": "Maki METRO",             "maki 15": "Maki METRO",
    "m16": "Maki Nottingham Ltd",    "maki 16": "Maki Nottingham Ltd",
    "m17": "Maki Lakeside",          "maki 17": "Maki Lakeside",
    "m18": "Maki Soho",              "maki 18": "Maki Soho",
    "m19": "Maki Shoreditch",        "maki 19": "Maki Shoreditch",
    "m20": "Maki Southampton",       "maki 20": "Maki Southampton",
    "m21": "Maki Birmingham Ltd",    "maki 21": "Maki Birmingham Ltd",
    "maki nori": "Maki Nori",        "nori": "Maki Nori",
}
# Deliberately NOT mapped, and they must stay that way until somebody decides
# what they are: 'Factory Edin', 'Glasgow Factory', 'MF Glasgow'. The estate's
# only factory site on this dashboard is AA Factory1 Limited, and mapping an
# Edinburgh or Glasgow factory onto it would attribute one site's maintenance
# to another. They surface in unresolved_site_labels and render as themselves.

_MONTHS = ("january february march april may june july august september "
           "october november december").split()


def canon_site(raw: str) -> str | None:
    """Canonical dashboard site for a sheet label, or None if not confirmed."""
    key = re.sub(r"\s+", " ", str(raw or "")).strip().lower().rstrip("-").strip()
    return SITE_CODES.get(key)


def iso_date(raw: str) -> str | None:
    """'26/08/2026' -> '2026-08-26'. Day-first: this is a UK sheet typed by
    hand, and 03/09 is the third of September in it, never the ninth of March.
    """
    s = str(raw or "").strip()
    m = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$", s)
    if not m:
        return None
    d, mo, y = (int(x) for x in m.groups())
    if y < 100:
        y += 2000
    try:
        return datetime.date(y, mo, d).isoformat()
    except ValueError:
        return None


def _section_date(text: str) -> str | None:
    """'UPDATED AS OF - September 9, 2026' -> '2026-09-09'."""
    m = re.search(r"updated\s+as\s+of\s*[-:]?\s*([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})",
                  str(text or ""), re.I)
    if not m:
        return None
    name, day, year = m.group(1).lower(), int(m.group(2)), int(m.group(3))
    if name not in _MONTHS:
        return None
    return datetime.date(year, _MONTHS.index(name) + 1, day).isoformat()


def _cells(row) -> list[str]:
    return [re.sub(r"\s+", " ", str(c or "")).strip() for c in row]


def _heading(cs: list[str]) -> str | None:
    """'ongoing' | 'done' if this row is a merged banner, else None."""
    vals = {re.sub(r"^\\?\[merged\\?\]\s*", "", c, flags=re.I)
            .strip().lower().rstrip(":").strip() for c in cs if c}
    if len(vals) != 1:
        return None
    v = vals.pop()
    if re.fullmatch(r"done\.?", v):
        return "done"
    if re.fullmatch(r"(on\s*going|ongoing)(\s*/\s*pending)?|pending", v):
        return "ongoing"
    return None


def parse_sections(values: list[list]) -> tuple[str, list[dict]] | None:
    """Find the NEWEST 'UPDATED AS OF' block in one worksheet and parse its
    ON GOING/PENDING and DONE tables. Returns (as_of_iso, tasks) or None.

    Newest rather than first, and by the date IN THE HEADING rather than by
    position: the sheet keeps old sections above and below the current one
    (there is a May block sitting above the September one), so "the top table"
    and "the last table" are both wrong answers.
    """
    starts = []
    for i, row in enumerate(values):
        for c in _cells(row):
            d = _section_date(c)
            if d:
                starts.append((d, i))
                break
    if not starts:
        return None
    as_of, start = max(starts)                      # newest heading wins
    ends = [i for _, i in starts if i > start]
    end = min(ends) if ends else len(values)

    tasks, status, cols = [], None, None
    for row in values[start + 1:end]:
        cs = _cells(row)
        joined = " ".join(cs).lower()
        if not any(cs):
            continue
        # Table headings. A banner row is a MERGED cell, so every non-empty
        # cell on it carries the same text and that text is only the heading.
        # Testing "does this row mention done" instead would swallow real work:
        # the DONE table has a row reading "| | | Walk in Fridge issue | done
        # and sorted |", which mentions done, has few filled cells, and is a
        # task.
        head = _heading(cs)
        if head:
            status, cols = head, None
            continue
        # Column header row - locate columns by name, never by position.
        low = [c.lower() for c in cs]
        if "site" in low and ("concern" in low or "issue" in low):
            cols = {"date": low.index("date") if "date" in low else 0,
                    "site": low.index("site"),
                    "issue": low.index("concern") if "concern" in low
                             else low.index("issue")}
            rest = [j for j, c in enumerate(low)
                    if j not in cols.values() and c]
            cols["comment"] = rest[-1] if rest else None
            continue
        if status is None or cols is None:
            continue
        get = lambda k: (cs[cols[k]] if cols.get(k) is not None
                         and cols[k] < len(cs) else "")
        site_raw, issue = get("site"), get("issue")
        if not issue and not site_raw:
            continue
        if not issue:                    # a site with no concern is not a task
            continue
        tasks.append({
            # A row with a concern but no site is real work that the sheet
            # left unattributed. It is NOT inherited from the row above: a
            # blank under a filled cell usually means "same site", and usually
            # is not a standard this file gets to invent.
            "site": canon_site(site_raw) or site_raw or "(no site given)",
            "raw_site": site_raw,
            "d": iso_date(get("date")),
            "issue": issue,
            "comment": get("comment"),
            "status": status,
        })
    return as_of, tasks


def build(values_by_tab: dict[str, list[list]], pulled_at: str) -> dict | None:
    """Pick the worksheet holding the newest section and build the file."""
    best = None
    for tab, values in values_by_tab.items():
        got = parse_sections(values)
        if got and got[1] and (best is None or got[0] > best[1]):
            best = (tab, got[0], got[1])
    if best is None:
        return None
    tab, as_of, tasks = best
    unresolved = sorted({t["raw_site"] for t in tasks
                         if canon_site(t["raw_site"]) is None and t["raw_site"]})
    return {
        "source": (f"Google Sheet '{SHEET_NAME}' (owned by lincoln@makiramen.com), "
                   f"worksheet '{tab}', section 'UPDATED AS OF - {as_of}' "
                   f"(ON GOING/PENDING + DONE tables)"),
        "source_url": f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit",
        "source_as_of": as_of,
        "pulled_at": pulled_at,
        "pulled_by": "builders/refresh_maintenance.py (service account, headless)",
        "unresolved_site_labels": unresolved,
        "tasks": tasks,
    }


def fetch(sheet_id: str) -> dict[str, list[list]]:
    """Every worksheet's values, via the same service account the ETL uses."""
    import gspread
    sa = os.environ.get("GOOGLE_SA_JSON")
    path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if sa:
        gc = gspread.service_account_from_dict(json.loads(sa))
    elif path:
        gc = gspread.service_account(filename=path)
    else:
        raise RuntimeError("no Google credentials (GOOGLE_SA_JSON or "
                           "GOOGLE_APPLICATION_CREDENTIALS)")
    sh = gc.open_by_key(sheet_id)
    return {ws.title: ws.get_all_values() for ws in sh.worksheets()}


def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-json", help="parse this {tab: values} dump instead "
                                        "of calling Google (for tests)")
    ap.add_argument("--out", default=os.path.join(OUT_DIR, "maintenance_source.json"))
    ap.add_argument("--print", action="store_true", help="print, do not write")
    a = ap.parse_args()

    try:
        if a.from_json:
            values_by_tab = json.load(open(a.from_json))
        else:
            values_by_tab = fetch(SHEET_ID)
    except Exception as exc:                                     # noqa: BLE001
        # Fail soft. The committed file stays as it is, and the tab keeps
        # showing its real source_as_of, which is the honest outcome.
        log.error("could not read the maintenance sheet (%s: %s). Leaving the "
                  "committed file untouched. If this is a 403/404, share %s "
                  "with the service account (client_email in GOOGLE_SA_JSON) "
                  "as Viewer.", type(exc).__name__, exc, SHEET_ID)
        return 0

    pulled_at = (os.environ.get("PULLED_AT")
                 or datetime.datetime.now(datetime.timezone.utc)
                 .strftime("%Y-%m-%dT%H:%M:%SZ"))
    built = build(values_by_tab, pulled_at)
    if not built:
        log.error("no 'UPDATED AS OF' section found in any worksheet of %s - "
                  "the sheet's layout may have changed. Leaving the committed "
                  "file untouched.", SHEET_ID)
        return 0

    ongoing = sum(1 for t in built["tasks"] if t["status"] == "ongoing")
    done = sum(1 for t in built["tasks"] if t["status"] == "done")
    log.info("parsed section %s: %d tasks (%d ongoing, %d done), %d unresolved "
             "site label(s): %s", built["source_as_of"], len(built["tasks"]),
             ongoing, done, len(built["unresolved_site_labels"]),
             ", ".join(built["unresolved_site_labels"]) or "none")

    if a.print:
        print(json.dumps(built, indent=1))
        return 0

    prev_as_of = None
    if os.path.exists(a.out):
        try:
            prev_as_of = json.load(open(a.out)).get("source_as_of")
        except Exception:                                        # noqa: BLE001
            pass
    if prev_as_of and built["source_as_of"] < prev_as_of:
        # Only ever move forward. A sheet edit that removes the newest section
        # should not silently roll the dashboard back to an older one.
        log.error("parsed section %s is OLDER than the committed %s - refusing "
                  "to go backwards. Leaving the committed file untouched.",
                  built["source_as_of"], prev_as_of)
        return 0

    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(built, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    log.info("wrote %s (was %s, now %s)", a.out, prev_as_of or "absent",
             built["source_as_of"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
