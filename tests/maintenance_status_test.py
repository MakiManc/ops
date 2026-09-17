#!/usr/bin/env python3
"""
Fixture test for maintenance task status classification (17/09/2026).

WHY THIS FILE EXISTS. The Maintenance tab had zero test coverage of any kind,
and it cost a year of wrong numbers. The sheet's status vocabulary is four
words - its own summary worksheets are headed "Total Requests | Completed |
Ongoing | Cancelled | Delayed" - but the parser only ever knew two. "Cancelled"
matched nothing, fell through the default, and every cancelled ticket was
counted as outstanding work. Nothing failed, because an unrecognised status is
not an error in that code path; it is a silent vote for "outstanding".

So this pins the vocabulary itself. It is a pure-function test - no browser, no
Google, no network - because the classification rule is a pure function, and
the rule is the thing that was wrong.

WHAT EACH CASE GUARDS, in one line: every row below exists to stop one specific
way of getting this wrong, and the comment on it says which. If you widen
_DONE_WORDS or reorder _status_of, this file is where that announces itself.

  python3 tests/maintenance_status_test.py      (exit 1 on any failure)
"""
from __future__ import annotations

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

spec = importlib.util.spec_from_file_location(
    "refresh_maintenance", os.path.join(REPO, "builders", "refresh_maintenance.py"))
rm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rm)

failures = 0


def check(cond, msg):
    global failures
    if cond:
        print("ok  :", msg)
    else:
        failures += 1
        print("FAIL:", msg, file=sys.stderr)


def status(cell, completed=""):
    return rm._status_of(cell, completed)


def main() -> int:
    # -- the three buckets, from the words the sheet actually uses -----------
    check(status("Completed") == "done", "'Completed' is done")
    check(status("Ongoing") == "ongoing", "'Ongoing' is ongoing")
    check(status("Cancelled") == "cancelled", "'Cancelled' is its own state")

    # THE BUG THIS FILE WAS WRITTEN FOR. Before 17/09/2026 this returned
    # "ongoing" and every cancelled ticket was counted as outstanding work.
    check(status("Cancelled") != "ongoing",
          "a cancelled task is NOT outstanding - the bug this pins")
    # And the other half of it: closed is not the same as done. Folding
    # cancelled into "done" would put a green tick on a job nobody did.
    check(status("Cancelled") != "done",
          "a cancelled task is NOT resolved either - closed is not done")

    # -- 'Delayed' is the fourth column and must stay OPEN -------------------
    # Deferred work is still outstanding work. This is the case most likely to
    # be broken by someone "tidying up" the cancelled fix.
    check(status("Delayed") == "ongoing",
          "'Delayed' stays outstanding - deferred work is still open work")

    # -- branch order: cancelled beats a completion date --------------------
    # A cancelled job can be date-stamped on the day it was dropped. If the
    # date test ran first those rows would report as done, which is the same
    # lie in the opposite direction.
    check(status("Cancelled", "14/03/2025") == "cancelled",
          "cancelled beats a Date of Completion - branch order is load-bearing")
    check(status("", "14/03/2025") == "done",
          "a completion date alone still means done, as before")
    check(status("Completed", "") == "done",
          "a status word alone still means done, as before")

    # -- a blank status is outstanding, never finished -----------------------
    check(status("") == "ongoing", "a blank status is outstanding, not finished")
    check(status(None, None) == "ongoing", "None behaves like blank")

    # -- spelling and whitespace, as typed by hand into a form ---------------
    for spelling in ("cancelled", "CANCELLED", "Canceled", "  Cancelled  ",
                     "cancel"):
        check(status(spelling) == "cancelled", f"{spelling!r} is cancelled")

    # -- what must NOT be swept into cancelled ------------------------------
    # Whole-string matching only. A free-text note about a cancellation is not
    # a cancelled ticket, and reading it as one would close real open work.
    for not_cancelled in ("cancelled by supplier, rebooking",
                          "engineer cancelled - still outstanding",
                          "cancellation fee paid"):
        check(status(not_cancelled) == "ongoing",
              f"{not_cancelled!r} is free text, not a status - stays outstanding")

    # -- the raw cell survives parsing --------------------------------------
    # Today's committed file cannot answer "which rows did the sheet call
    # Cancelled?" because the raw cell was discarded at classification time.
    header = ["Month", "Timestamp", "Location", "Your Name",
              "Outstanding Maintenance/Repair Tasks", "Upload Pictures",
              "On a scale of urgency, where does it fall?",
              "Date of Completion", "Status", "Carried Out By", "", "Expenses",
              "Notes"]
    rows = [
        header,
        ["March", "14/03/2025 09:00:00", "Maki 8", "Kris", "Ice machine leak",
         "", "High Priority", "", "Cancelled", "KRIS", "", "", "duplicated"],
        ["March", "15/03/2025 09:00:00", "Maki 8", "Kris", "Fryer broken",
         "", "High Priority", "20/03/2025", "Completed", "KRIS", "", "£120", ""],
        ["March", "16/03/2025 09:00:00", "Maki 8", "Kris", "Door handle",
         "", "Low Priority", "", "Delayed", "", "", "", ""],
        ["March", "17/03/2025 09:00:00", "Maki 8", "Kris", "Light flickering",
         "", "Low Priority", "", "", "", "", "", ""],
    ]
    tasks = rm.parse_form(rows)
    check(len(tasks) == 4, f"all four fixture rows parse (got {len(tasks)})")
    by_issue = {t["issue"]: t for t in tasks}
    check(by_issue["Ice machine leak"]["status"] == "cancelled",
          "parse_form carries the cancelled classification through")
    check(by_issue["Ice machine leak"]["status_raw"] == "Cancelled",
          "the raw Status cell is preserved verbatim beside the classification")
    check(by_issue["Fryer broken"]["status"] == "done", "the completed row is done")
    check(by_issue["Door handle"]["status"] == "ongoing",
          "the delayed row is still outstanding")
    check(by_issue["Light flickering"]["status"] == "ongoing",
          "the blank-status row is still outstanding")
    check(by_issue["Light flickering"]["status_raw"] is None,
          "a blank raw status is None, not an empty string")

    # -- the counting contract the tab and the baker both rely on -----------
    # Both count by testing t["status"] against exact literals, so the set of
    # values this parser can emit is an interface, not an implementation
    # detail. A fourth literal would be dropped from every total.
    check({t["status"] for t in tasks} <= {"ongoing", "done", "cancelled"},
          "parse_form emits only the three literals the consumers count")

    print("\n" + ("all assertions passed" if not failures
                  else f"{failures} assertion(s) FAILED"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
