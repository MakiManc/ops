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
# Ross, 16/09/2026: THE SOURCE IS THE FORM RESPONSES, NOT LINCOLN'S RECAP.
# This script first shipped reading the curated "UPDATED AS OF <date>" block,
# which is Lincoln's weekly write-up. The record sites actually submit into is
# the Google Form responses worksheet, and that is what the tab should show.
#
# Targeted by worksheet GID, not by title or by column signature. The file has
# THREE form-response-shaped worksheets (two of them near-duplicates) plus two
# curated trackers, so "the tab whose header looks like a form" is ambiguous
# and "the first worksheet" is wrong. A gid is exact and survives a rename.
# It is the number in the sheet URL after #gid=.
FORM_GID = int(os.environ.get("MAINT_FORM_GID") or 1754461106)
# How old the newest submission may be before the log says so out loud. 30 days
# rather than a week: sites submit when something breaks, so a quiet fortnight
# is a good fortnight, not a fault.
MAX_QUIET_DAYS = 30
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
    # Ross, 16/09/2026: "Maki 2 is merged with Maki 1 to make Maki 1/2."
    # So M2 is not a missing site, it is half of one that already resolves. The
    # site's own Kobas name records the merge - bake_ops_command.py pairs
    # M1TOO Ltd with the venue 'Maki 1/2 (Nicolson St)' - which is why 'm1/2'
    # was already in this map and 'm2' was not. One submission, 26/05/2025.
    "m2":  "M1TOO Ltd",              "maki 2":  "M1TOO Ltd",
    "m3":  "Fountain Good Food Ltd", "maki 3":  "Fountain Good Food Ltd",
    "m5":  "South Ikigai Ltd",       "maki 5":  "South Ikigai Ltd",
    "iki2": "South Ikigai Ltd",      "iki 2":   "South Ikigai Ltd",
    "ikigai 2": "South Ikigai Ltd",  "ikigai2": "South Ikigai Ltd",
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
    # Ross, 16/09/2026: "Maki 4 is the Leith site. MAF4 is Braehead."
    #
    # M4 is not in the M-code list this map was built from, which is why its 44
    # submissions sat unresolved. 'Maki Leith' is a real Kobas venue, not a name
    # invented to house them: it appears as `"Venue Placed":"Maki Leith"` with
    # `"Region Placed":"Scotland"` in the Weekly Outstanding Stock Orders report
    # archived on 13/08/2026, and bake_ops_command.py already names it as a
    # Kobas-side site with no GetCompliant match.
    #
    # Do NOT "correct" this to Maki SJQ. The EC dashboard calls M7 "M7 Leith
    # Street" because St James Quarter sits on Leith Street; Leith is a
    # different part of Edinburgh and a different venue in Kobas. M4 and M7 are
    # not the same site.
    #
    # It is a former site, so it will appear on the Maintenance tab and nowhere
    # else: it is absent from the 26-entry estate directory the dashboard builds
    # from GetCompliant Locations, its submissions run 15/02/2024 to 15/05/2026
    # and stop, and the Kobas orders naming it are from 2024.
    "m4":   "Maki Leith",            "maki 4":  "Maki Leith",
    # MAF4 in the same sentence, recorded so the next person does not read M4
    # and MAF4 as the same code and file Leith's maintenance against Braehead.
    # These keys match nothing in the worksheet today - every one of the 1,264
    # submissions uses an 'M'/'Maki N' label, never an MAF one - so they resolve
    # 0 rows and are here to catch the label rather than to claim it exists.
    "maf4": "Maki Braehead",         "braehead": "Maki Braehead",
    "maki braehead": "Maki Braehead",
}
# The form and the recap use DIFFERENT vocabularies for the same estate, which
# is why both spellings appear above: the recap writes 'Iki 2' and 'Maki 7',
# the form writes 'Ikigai 2' and 'Maki 7'. Every pair is still evidenced -
# 'Ikigai 2' resolves to the site 'Iki 2' already resolved to in the set Ross
# signed off, not to a new guess.
#
# Deliberately NOT mapped, and they must stay that way until somebody decides
# what they are:
# Counts below are from the live worksheet, 1,265 submissions, 16/09/2026:
#   'MF Edinburgh' (20), 'MF Glasgow' (22), 'Factory - Dalkeith Road,
#     Edinburgh' (4), 'Factory - Renfield St, Glasgow' (17) - four spellings of
#     two factories. The only factory site on this dashboard is AA Factory1
#     Limited, and mapping an Edinburgh or Glasgow factory onto it would
#     attribute one site's maintenance to another.
#   'Maki 4' and 'Maki 2' both left this list on 16/09/2026, when Ross said what
#     they were - M4 is Leith, M2 is half of M1/2. What remains below is not a
#     backlog of unanswered labels; it is four things that are not trading sites
#     and one that is not confirmed.
#   'RHQ' (22) - head office, not a trading site.
#   'IKIGAI 1' (3) - Iki 2 is South Ikigai Ltd; there is no confirmed Iki 1 on
#     this dashboard, so this is not assumed to be the same place.
#   'Grindlay Flat' (4) - a flat, not a site.
# All of them surface in unresolved_site_labels and are named in the gap the
# baker puts on the Maintenance tab.

_MONTHS = ("january february march april may june july august september "
           "october november december").split()


def canon_site(raw: str) -> str | None:
    """Canonical dashboard site for a sheet label, or None if not confirmed.

    Ross, 16/09/2026: the form's dropdown has been re-worded at least once, so
    the SAME site appears under two labels - 180 rows of 'Maki 8' and 14 of
    'Maki 8 - Renfield St, Glasgow'. Matching the whole string only resolved
    942 of 1,264 submissions and left the entire estate in the unresolved list
    under its long spelling.

    So: try the label whole, then try the part before the FIRST ' - '. First,
    not last, because two of them carry a second dash - 'Maki 9 - York St -
    Manchester', 'Maki 10 - Bond St - Leeds'.

    This is still matching, not guessing: the prefix it falls back to is the
    site code already in the map, so 'Maki 8 - Renfield St, Glasgow' resolves
    to what 'Maki 8' resolves to and nothing new is invented. A label whose
    prefix is not a known code - 'Factory - Dalkeith Road, Edinburgh' - stays
    unresolved exactly as before.
    """
    def _key(t):
        return re.sub(r"\s+", " ", str(t or "")).strip().lower().rstrip("-").strip()
    key = _key(raw)
    if key in SITE_CODES:
        return SITE_CODES[key]
    head = _key(key.split(" - ", 1)[0]) if " - " in key else None
    return SITE_CODES.get(head) if head else None


def iso_date(raw: str) -> str | None:
    """'26/08/2026' -> '2026-08-26'. Day-first: this is a UK sheet typed by
    hand, and 03/09 is the third of September in it, never the ninth of March.
    """
    # split() because a form Timestamp is "13/01/2024 12:53:25" - the date is
    # the first token. The recap's Date column has no time part; both work.
    s = str(raw or "").strip().split()[0] if str(raw or "").strip() else ""
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


def _cells(row) -> list[str]:
    return [re.sub(r"\s+", " ", str(c or "")).strip() for c in row]


# A form row counts as DONE when the sheet says so in either of the two places
# it can: the Status column, or a filled Date of Completion. Both, because they
# disagree in practice - rows carry a completion date with Status still blank,
# and rows read "Completed" with no date. Anything else is ongoing, INCLUDING a
# blank status: an unanswered row is outstanding work, not finished work, and
# defaulting the other way would quietly empty the tab.
_DONE_WORDS = re.compile(
    r"^(completed?|done|resolved|fixed|sorted|closed|complete - .*)$", re.I)

# Ross, 17/09/2026: "The cancelled maintenance tasks are classed as completed
# and not open."
#
# CANCELLED IS A THIRD STATE, NOT A SYNONYM FOR DONE. It is first-class in the
# source and always has been - the sheet's own summary worksheets are headed
# "Name of the site | Total Requests | Completed | Ongoing | Cancelled |
# Delayed | Expenses", and the month dashboard uses the same four. This parser
# simply had no word for it: "Cancelled" matched nothing in _DONE_WORDS, so a
# cancelled row fell through to "ongoing" and was counted as outstanding work.
#
# It is deliberately NOT added to _DONE_WORDS. Everything matching there is
# work that actually happened; a cancelled job did not happen. Folding it in
# would inflate "Resolved" with tasks nobody ever did and put a green tick
# beside them - so it counts as CLOSED (not open, per Ross) while being
# reported under its own name everywhere it is counted.
#
# DELAYED IS ABSENT FROM BOTH PATTERNS ON PURPOSE. It is the fourth column in
# those same dashboards and deferred work is still outstanding work, so it goes
# on falling through to "ongoing", which was already right.
_CANCELLED_WORDS = re.compile(r"^(cancell?ed|cancel)$", re.I)


def _status_of(status: str, completed_on: str) -> str:
    """One of 'done', 'cancelled', 'ongoing'. Branch order is load-bearing."""
    s = (status or "").strip()
    if _CANCELLED_WORDS.match(s):
        return "cancelled"
    if _DONE_WORDS.match(s):
        return "done"
    # This sits BELOW the cancelled test on purpose. A cancelled job can be
    # date-stamped on the day it was dropped, and 15 of the committed rows do
    # carry a Date of Completion, so running the date test first would keep
    # reporting those as done. The consequence is worth stating plainly: this
    # change can move rows OUT of "Resolved" as well as out of "Outstanding",
    # so a small fall in the Resolved count is expected, not a regression.
    if iso_date(completed_on):
        return "done"
    return "ongoing"


def _header_row(values: list[list]) -> tuple[int, dict] | None:
    """Locate the form's header row and map the columns this script reads.

    By NAME, never by position: the three form-shaped worksheets in this file
    have different column orders, one carries a leading 'Month' column the
    others lack, and the person-column is spelled 'Your Name' on one and
    'Name' on another. Position would silently read the wrong field.
    """
    want = {
        "d":         ("timestamp",),
        "site":      ("location",),
        "issue":     ("outstanding maintenance/repair tasks", "issue"),
        "urgency":   ("on a scale of urgency, where does it fall?", "urgency"),
        "completed": ("date of completion",),
        "status":    ("status",),
        "by":        ("carried out bykr", "carried out by"),
        "cost":      ("expenses",),
        "comment":   ("notes",),
        "who":       ("your name", "name"),
    }
    for i, row in enumerate(values[:40]):
        low = [c.lower() for c in _cells(row)]
        if "timestamp" not in low or "location" not in low:
            continue
        cols = {}
        for key, names in want.items():
            for n in names:
                if n in low:
                    cols[key] = low.index(n)
                    break
        return i, cols
    return None


def parse_form(values: list[list]) -> list[dict]:
    """Every submission in the form-responses worksheet, newest first."""
    found = _header_row(values)
    if not found:
        return []
    hdr, cols = found
    get = lambda cs, k: (cs[cols[k]] if k in cols and cols[k] < len(cs) else "")
    tasks = []
    for row in values[hdr + 1:]:
        cs = _cells(row)
        if not any(cs):
            continue
        issue = get(cs, "issue")
        if not issue:
            continue                      # a row with no task is not a task
        site_raw = get(cs, "site")
        raw_status = get(cs, "status")
        status = _status_of(raw_status, get(cs, "completed"))
        tasks.append({
            "site": canon_site(site_raw) or site_raw or "(no site given)",
            "raw_site": site_raw,
            "d": iso_date(get(cs, "d")),
            "issue": issue,
            # The recap had one free-text update per row; the form splits that
            # across Notes and who carried it out, so they are joined rather
            # than one being dropped - the Maintenance tab renders this as the
            # task's comment and a half-empty column reads as missing data.
            "comment": " · ".join(x for x in (get(cs, "comment"),
                                              get(cs, "by")) if x),
            "status": status,
            # The verbatim cell beside the classification, exactly as raw_site
            # sits beside site. It is what lets a later reader re-derive these
            # buckets - or notice a FIFTH status nobody has told this parser
            # about - without re-pulling the sheet. Today's file cannot answer
            # "which rows did the sheet call Cancelled?" at all.
            "status_raw": raw_status or None,
            # Fields the recap never carried. Urgency is the one sites actually
            # fill in, and it is the only priority signal this system has.
            "urgency": get(cs, "urgency") or None,
            "completed_on": iso_date(get(cs, "completed")),
            "cost": get(cs, "cost") or None,
            "raised_by": get(cs, "who") or None,
        })
    tasks.sort(key=lambda t: (t["d"] or "", t["issue"]), reverse=True)
    return tasks


def build(values: list[list], pulled_at: str, tab: str) -> dict | None:
    """The committed file, from one form-responses worksheet."""
    tasks = parse_form(values)
    if not tasks:
        return None
    unresolved = sorted({t["raw_site"] for t in tasks
                         if canon_site(t["raw_site"]) is None and t["raw_site"]})
    dates = [t["d"] for t in tasks if t["d"]]
    return {
        "source": (f"Google Sheet '{SHEET_NAME}' (owned by lincoln@makiramen.com), "
                   f"worksheet '{tab}' (gid {FORM_GID}) - the Google Form "
                   f"responses themselves, one row per submission"),
        "source_url": (f"https://docs.google.com/spreadsheets/d/{SHEET_ID}"
                       f"/edit#gid={FORM_GID}"),
        # source_kind exists so the never-go-backwards guard in main() can tell
        # a genuine regression from a deliberate change of source. Switching
        # from the recap to the form moves source_as_of backwards by design.
        "source_kind": "form_responses",
        "source_as_of": max(dates) if dates else None,
        "first_submission": min(dates) if dates else None,
        "pulled_at": pulled_at,
        "pulled_by": "builders/refresh_maintenance.py (service account, headless)",
        "unresolved_site_labels": unresolved,
        "tasks": tasks,
    }


def fetch(sheet_id: str, gid: int) -> tuple[str, list[list]]:
    """One worksheet's values, by gid, via the service account the ETL uses."""
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
    # Log every worksheet before picking one. When this file is reorganised -
    # and it has been, it carries five trackers and three form tabs - the log
    # is what tells the next person which gid to use instead of guessing.
    titles = [(w.title, w.id) for w in sh.worksheets()]
    log.info("worksheets in %s: %s", sheet_id,
             ", ".join(f"{t!r} (gid {i})" for t, i in titles))
    ws = sh.get_worksheet_by_id(gid)
    log.info("reading worksheet %r (gid %s)", ws.title, gid)
    return ws.title, ws.get_all_values()


def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-json", help="parse this worksheet dump (a list of "
                                        "rows) instead of calling Google")
    ap.add_argument("--gid", type=int, default=FORM_GID)
    ap.add_argument("--out", default=os.path.join(OUT_DIR, "maintenance_source.json"))
    ap.add_argument("--print", action="store_true", help="print, do not write")
    a = ap.parse_args()

    try:
        if a.from_json:
            values, tab = json.load(open(a.from_json)), "(local dump)"
        else:
            tab, values = fetch(SHEET_ID, a.gid)
    except Exception as exc:                                     # noqa: BLE001
        # Fail soft. The committed file stays as it is, and the tab keeps
        # showing its real source_as_of, which is the honest outcome.
        log.error("could not read the maintenance sheet (%s: %s). Leaving the "
                  "committed file untouched. If this is a 403/404, share %s "
                  "with the service account (client_email in GOOGLE_SA_JSON) "
                  "as Viewer; if it names the gid, worksheet %s has been "
                  "deleted or renumbered and the log above lists the real "
                  "ones.", type(exc).__name__, exc, SHEET_ID, a.gid)
        return 0

    pulled_at = (os.environ.get("PULLED_AT")
                 or datetime.datetime.now(datetime.timezone.utc)
                 .strftime("%Y-%m-%dT%H:%M:%SZ"))
    built = build(values, pulled_at, tab)
    if not built:
        log.error("no form submissions parsed from worksheet gid %s of %s - "
                  "expected a header row carrying 'Timestamp' and 'Location'. "
                  "The layout may have changed. Leaving the committed file "
                  "untouched.", a.gid, SHEET_ID)
        return 0

    ongoing = sum(1 for t in built["tasks"] if t["status"] == "ongoing")
    done = sum(1 for t in built["tasks"] if t["status"] == "done")
    cancelled = sum(1 for t in built["tasks"] if t["status"] == "cancelled")
    log.info("parsed %d submissions (%d ongoing, %d done, %d cancelled), "
             "dated %s..%s, %d unresolved site label(s): %s",
             len(built["tasks"]), ongoing, done, cancelled,
             built["first_submission"], built["source_as_of"],
             len(built["unresolved_site_labels"]),
             ", ".join(built["unresolved_site_labels"]) or "none")

    # Ross, 17/09/2026. The Cancelled bug was invisible for a year because a
    # status this parser does not recognise is not an error here - it is
    # silently counted as outstanding work. So say out loud which words fell
    # through, and how many rows each took with it.
    #
    # It is a log line rather than a failure on purpose: a new dropdown option
    # must not stop the Maintenance tab refreshing. But it is the one place a
    # fifth status, a renamed Status header (every row would read blank at
    # once), or a typo'd bulk edit would announce itself instead of quietly
    # inflating the outstanding count.
    # Deliberately checked in EVERY bucket, not just the outstanding one. A
    # first draft of this only inspected rows that fell through to "ongoing",
    # which left it blind in the direction that matters most: "Complete - not
    # required" and "Cancelled - site closed" are both classified done (the
    # first by the 'complete - .*' wildcard, the second by its completion date)
    # and would have been reported as nothing at all, while rendering a green
    # tick on work nobody did. The bucket each word landed in is named so the
    # reader can judge whether it was the right one.
    _KNOWN = {
        "": "ongoing", "ongoing": "ongoing", "on going": "ongoing",
        "pending": "ongoing", "delayed": "ongoing", "in progress": "ongoing",
        "outstanding": "ongoing",
        "completed": "done", "complete": "done", "done": "done",
        "resolved": "done", "fixed": "done", "sorted": "done", "closed": "done",
        "cancelled": "cancelled", "canceled": "cancelled", "cancel": "cancelled",
    }
    unknown = {}
    for t in built["tasks"]:
        word = (t.get("status_raw") or "").strip()
        if word.lower() in _KNOWN:
            continue
        key = (word, t["status"])
        unknown[key] = unknown.get(key, 0) + 1
    if unknown:
        log.warning("status word(s) this parser does not recognise, and the "
                    "bucket each was given by default - check every one of "
                    "them is in the right column: %s",
                    ", ".join(f"{w!r} -> {b} ({n})" for (w, b), n
                              in sorted(unknown.items(), key=lambda kv: -kv[1])))
    blank = sum(1 for t in built["tasks"] if not (t.get("status_raw") or "").strip())
    if blank == len(built["tasks"]) and built["tasks"]:
        log.error("EVERY row has an empty Status cell (%d of %d). The Status "
                  "column header has almost certainly been renamed - this "
                  "parser matches it by the exact word 'status' - so every "
                  "task is now classified on its completion date alone.",
                  blank, len(built["tasks"]))

    # NEVER PUBLISH AN ANCIENT TAB QUIETLY. The form responses are the source
    # Ross chose, but this file's form worksheets have gone quiet before - the
    # three legacy ones stop between Aug 2024 and Feb 2025 - and a refresh that
    # runs daily, succeeds, and serves two-year-old work would look healthy in
    # every check we have: pulled_at would be today. The tab renders
    # source_as_of, so a reader can see it; this makes sure the bake log says
    # it too, because that is where somebody debugging will actually look.
    if built["source_as_of"]:
        stale = (datetime.date.fromisoformat(pulled_at[:10])
                 - datetime.date.fromisoformat(built["source_as_of"])).days
        if stale > MAX_QUIET_DAYS:
            log.warning("NEWEST SUBMISSION IS %d DAYS OLD (%s). Worksheet gid "
                        "%s parsed fine, so this is not a broken pull - either "
                        "sites have stopped using the form, or the live "
                        "responses are on a different worksheet. The list of "
                        "worksheets logged above gives the other gids.",
                        stale, built["source_as_of"], a.gid)

    if a.print:
        print(json.dumps(built, indent=1))
        return 0

    prev = {}
    if os.path.exists(a.out):
        try:
            prev = json.load(open(a.out)) or {}
        except Exception:                                        # noqa: BLE001
            pass
    prev_as_of, prev_kind = prev.get("source_as_of"), prev.get("source_kind")
    # Never go backwards WITHIN a source: a sheet edit that removes the newest
    # rows must not silently roll the dashboard back. But a change of source is
    # not a regression - moving from Lincoln's recap to the form responses
    # legitimately moves source_as_of to whatever the form's newest row is, and
    # blocking that would make the switch impossible to deploy.
    if (prev_as_of and prev_kind == built["source_kind"]
            and built["source_as_of"] and built["source_as_of"] < prev_as_of):
        log.error("newest submission %s is OLDER than the committed %s from "
                  "the same source - refusing to go backwards. Leaving the "
                  "committed file untouched.", built["source_as_of"], prev_as_of)
        return 0
    if prev_kind and prev_kind != built["source_kind"]:
        log.warning("source changed: %s -> %s. source_as_of moves %s -> %s, "
                    "which is expected and not a regression.",
                    prev_kind, built["source_kind"], prev_as_of,
                    built["source_as_of"])

    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(built, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    log.info("wrote %s (was %s, now %s)", a.out, prev_as_of or "absent",
             built["source_as_of"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
