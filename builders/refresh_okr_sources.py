#!/usr/bin/env python3
"""Refresh data/ops_command/okr_sheet.json from Matthew's 2026 Operations Input sheet.

WHY THIS EXISTS. The Overview scorecard was built from the Master Operating
Manual. Ross is scored on a different list - the "2026 Operations Input" sheet
that Matthew owns - and four of its KRs have no feed anywhere in this system:
they are TYPED INTO THE SHEET and nowhere else. Those four are:

  * OO3 KR3  menu items unavailable due to supply failure  (a log tab)
  * OO4 KR1  service disruptions caused by logistics delays (a log tab)
  * OO2 KR3  unplanned restaurant closures                  (a log tab)
  * OO1 KR1-KR5 and OO4 KR4                                 (Finance-entered)

This script is the only path those numbers have into the dashboard. Everything
else on the scorecard is computed from the warehouse and must NOT come from
here - see THE SHEET IS NOT A FALLBACK below.

FAIL SOFT, ALWAYS. Same contract as refresh_maintenance.py: if the sheet cannot
be read - access revoked, tab renamed, Google down - this leaves the existing
committed file untouched and exits 0 with a loud log. source_as_of is rendered
on the page, so staleness is visible; a failed bake is not.

  ---------------------------------------------------------------------------
  ACCESS: THE SHEET IS PROBABLY NOT SHARED WITH US YET (Ross, 21/09/2026)
  ---------------------------------------------------------------------------
  The Operations Input sheet is shared as `domain: makiramen.com, reader`. A
  service account address ends .iam.gserviceaccount.com and is NOT a member of
  that domain, so domain-wide sharing does not reach it. Expect a 403 until
  Matthew shares the file explicitly with the client_email inside GOOGLE_SA_JSON.
  That is not a bug in this script and it must not fail the bake: the rows it
  feeds stay grey with their blocker named, exactly as they are today.
  ---------------------------------------------------------------------------

  ---------------------------------------------------------------------------
  GIDS: NOT KNOWN YET, SO THIS SCRIPT DISCOVERS AND PRINTS THEM
  ---------------------------------------------------------------------------
  refresh_maintenance.py targets its worksheet by gid, not title, and the same
  rule should hold here - one of these tabs is literally named
  'Unplanned Restarant Closures ' (misspelt, trailing space), which is exactly
  the kind of title somebody fixes one afternoon. But nobody has the gids: the
  sheet never links to its own tabs, and no route outside a browser exposes them.

  So this script does BOTH, in this order:
    1. If OKR_GID_<NAME> is set, use it. That is the durable configuration and
       the one to end up on.
    2. Otherwise fall back to an EXACT title match from TAB_TITLES below.
  Either way it logs every worksheet with its gid on every run. The first run
  that can open the sheet therefore PRINTS the gids Ross needs to pin, and the
  fallback stops being load-bearing. Until then the titles are all we have, and
  a renamed tab is a named, logged failure rather than a wrong number.

  DO NOT substitute the sheetId values out of an .xlsx export. Those are Excel
  ordinals (1..6), not Google gids; they look plausible and are silently wrong.
  ---------------------------------------------------------------------------

  ---------------------------------------------------------------------------
  OO1 IS SCORES ONLY. THIS IS A PUBLICATION RULE, NOT A PREFERENCE.
  ---------------------------------------------------------------------------
  MakiManc/ops is a PUBLIC repository. OO1 is Net Profit, and the "2026 OKRs"
  tab carries its underlying W/R, FR, V/R and NP percentages. Those must never
  reach this repo, this JSON, or a snapshot. This script reads OO1 ONLY from the
  five 0-100 SCORE cells on the "2026 Summary" tab and has no code path that can
  read the percentage columns. verify_ops_data.py asserts the absence
  independently, so if this rule is ever broken here the verifier fails the bake.
  ---------------------------------------------------------------------------

THE SHEET IS NOT A FALLBACK. Ross, 21/09/2026: "dashboard only". For any KR this
system can compute, the sheet's typed Actual is IGNORED - not shown, not
reconciled against, not used when a feed is quiet. This file carries ONLY the
KRs that have no other source. Widening it is how a computed KR quietly starts
reporting whatever somebody typed.

Run it in ops_command_bake.yml (in the maki-hospitality-etl repo), beside the
existing "Refresh the maintenance sheet" step and before "Bake the snapshot" -
that is the only job holding both the ops checkout and the push token, so the
refreshed file rides out on the same commit as the snapshot it feeds. That bake
is chained to the export finishing (workflow_run), NOT to a 09:00 cron, so this
needs no schedule of its own.
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

#: Exact worksheet titles, verbatim from the file (21/09/2026). The trailing
#: space and the misspelling in the closures tab are REAL - do not tidy them,
#: they are what the match is against. Each maps to the env var that pins its
#: gid once somebody reads it out of the tab's URL.
TAB_TITLES = {
    "summary":  ("2026 Summary", "OKR_GID_SUMMARY"),
    "oo3_kr3":  ("KR3: Zero menu items unavailable due to supply failure",
                 "OKR_GID_MENU"),
    "oo4_kr1":  ("KR1: Zero service disruptions caused by logistics delays "
                 "(24 hour Max)", "OKR_GID_LOGISTICS"),
    "oo2_kr3":  ("Unplanned Restarant Closures ", "OKR_GID_CLOSURES"),
}

#: The five OO1 KR labels, in sheet order, as they appear in column A of
#: "2026 Summary" rows 3-7. Matched on the "KR<n>:" prefix only - the rest of
#: each label names a Finance percentage and is not needed to find the row.
OO1_KRS = ("KR1", "KR2", "KR3", "KR4", "KR5")

#: The OO4 Finance row. Note it is labelled "KR:" on the sheet, not "KR4:" -
#: that is the sheet's own typo and the reason this is matched on its text.
OO4_KR4_NEEDLE = "credit notes and refunds actioned"

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "data", "ops_command")

_MONTHS = ("january", "february", "march", "april", "may", "june", "july",
           "august", "september", "october", "november", "december")


def parse_month(cell: str) -> str | None:
    """A month cell -> 'YYYY-MM', or None if it is not a month.

    Two renderings, because the tabs disagree with each other:
      * the log tabs spell it out - 'January 2026'
      * '2026 Summary' abbreviates and hyphenates - 'Jan-26'
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

    That distinction is the whole point of this function. All three log tabs
    are blank from August 2026 onward, and a blank month must reach the
    scorecard as "not entered", never as a zero that scores 100. Sheet error
    values (#REF!, #VALUE!, #N/A) are non-numeric and return None for the same
    reason - the sheet has several of both.
    """
    s = (cell or "").strip().replace(",", "").replace("%", "")
    if not s or s.startswith("#"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def fetch(sheet_id: str):
    """-> (worksheets, {key: (title, gid, rows)}) for the tabs we need.

    Logs every worksheet with its gid before selecting any, so a run that
    cannot find a tab leaves the real list in the bake log - and so the first
    successful run hands over the gids to pin.
    """
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
    sheets = sh.worksheets()
    inventory = [{"title": w.title, "gid": w.id} for w in sheets]
    log.info("worksheets in %s: %s", sheet_id,
             ", ".join(f"{w['title']!r} (gid {w['gid']})" for w in inventory))
    log.info("PIN THESE GIDS to stop depending on titles: %s",
             " ".join(f"{env}={next((w['gid'] for w in inventory if w['title'] == t), '?')}"
                      for _k, (t, env) in TAB_TITLES.items()))

    out = {}
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
            log.error("no worksheet matches %r and %s is unset - %s will be "
                      "absent from the output and its rows stay grey.",
                      title, env, key)
            continue
        out[key] = (ws.title, ws.id, ws.get_all_values())
    return inventory, out


def build_log(rows) -> dict:
    """A two-column log tab -> {'YYYY-MM': count}.

    Only months with a NUMBER are emitted. A month row that exists but is blank
    is deliberately absent from the dict, so the builder can tell "entered as
    zero" from "not entered" - they score 100 and nothing respectively.
    """
    out = {}
    for r in rows:
        if not r:
            continue
        m = parse_month(r[0] if len(r) > 0 else "")
        if m is None:
            continue
        v = parse_num(r[1] if len(r) > 1 else "")
        if v is not None:
            out[m] = int(v) if float(v).is_integer() else v
    return out


def build_summary(rows) -> tuple[dict, dict, dict]:
    """'2026 Summary' -> (oo1_scores, oo4_kr4_scores, diagnostics).

    OO1: the five 0-100 SCORES on rows 3-7, and nothing else. No percentage
    column is read here or anywhere else in this file - see the header.

    Located by label rather than by fixed index, then CHECKED against the
    expected rows 3-7 and logged if it has moved, because a sheet that gains a
    row above OO1 would otherwise silently start publishing the wrong KR's
    score under KR1's name.
    """
    diag = {}
    # Month columns come from the first row that parses as two or more months.
    months = {}
    header_row = None
    for i, r in enumerate(rows[:6]):
        cand = {j: parse_month(c) for j, c in enumerate(r)}
        cand = {j: m for j, m in cand.items() if m}
        if len(cand) >= 2:
            months, header_row = cand, i
            break
    if not months:
        log.error("no month header found on the summary tab - OO1 and OO4 KR4 "
                  "will be absent and those rows stay grey.")
        return {}, {}, {"header_row": None}
    diag["header_row"] = header_row + 1
    diag["month_columns"] = {str(j): m for j, m in sorted(months.items())}

    def read(r):
        out = {}
        for j, m in months.items():
            v = parse_num(r[j] if len(r) > j else "")
            if v is not None:
                out[m] = v
        return out

    # OO1: the block starts at the row whose column A names OO1, and its five
    # KR rows follow it in order.
    oo1, oo1_start = {}, None
    for i, r in enumerate(rows):
        a = (r[0] if r else "").strip()
        if re.match(r"^OO\s*1\b", a, re.I) or a.lower().startswith("oo1 "):
            oo1_start = i
            break
    if oo1_start is None:
        log.error("no OO1 block found on the summary tab - the five Finance "
                  "rows stay grey.")
    else:
        for n, kr in enumerate(OO1_KRS):
            i = oo1_start + 1 + n
            if i >= len(rows):
                break
            label = (rows[i][0] if rows[i] else "").strip()
            if not label.upper().startswith(kr.upper() + ":"):
                log.error("summary row %d reads %r, expected it to start %r - "
                          "OO1 %s not read. The tab's layout has moved.",
                          i + 1, label[:60], kr + ":", kr)
                continue
            oo1[kr] = read(rows[i])
        diag["oo1_rows"] = [oo1_start + 2, oo1_start + 6]
        if oo1_start + 2 != 3:
            log.warning("OO1's KR rows are %d-%d, not the expected 3-7. Read by "
                        "label so this is handled, but the tab has changed "
                        "shape - worth a look.", oo1_start + 2, oo1_start + 6)

    # OO4 KR4 (Finance, credit notes). Labelled "KR:" on the sheet, not "KR4:".
    oo4 = {}
    for r in rows:
        if OO4_KR4_NEEDLE in (r[0] if r else "").lower():
            oo4 = read(r)
            break
    if not oo4:
        log.error("no OO4 credit-notes row found on the summary tab (needle "
                  "%r) - that row stays grey.", OO4_KR4_NEEDLE)
    return oo1, oo4, diag


def build(fetched: dict, inventory, pulled_at: str) -> dict | None:
    logs, tabs = {}, {}
    for key in ("oo3_kr3", "oo4_kr1", "oo2_kr3"):
        if key not in fetched:
            continue
        title, gid, rows = fetched[key]
        logs[key] = build_log(rows)
        tabs[key] = {"title": title, "gid": gid, "months": len(logs[key])}

    oo1, oo4_kr4, diag = ({}, {}, {})
    if "summary" in fetched:
        title, gid, rows = fetched["summary"]
        oo1, oo4_kr4, diag = build_summary(rows)
        tabs["summary"] = {"title": title, "gid": gid, **diag}

    if not logs and not oo1 and not oo4_kr4:
        return None

    # The newest month any series carries. This is what the page renders as
    # "as at", and what the verifier ages.
    everything = list(logs.values()) + list(oo1.values()) + [oo4_kr4]
    months = sorted({m for d in everything for m in d})
    return {
        "pulled_at": pulled_at,
        "source_as_of": months[-1] if months else None,
        "first_month": months[0] if months else None,
        "sheet_id": SHEET_ID,
        "worksheets": inventory,
        "tabs": tabs,
        "logs": logs,
        "oo1_scores": oo1,
        "oo4_kr4_scores": oo4_kr4,
        "basis": (
            "Typed into Matthew's 2026 Operations Input sheet and read here "
            "because these KRs have no feed anywhere else. A month absent from "
            "a series was NOT ENTERED on the sheet and carries no score - it is "
            "never read as a zero. OO1 is carried as the five 0-100 scores only; "
            "its underlying percentages are never read into this repository."),
    }


def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-json", help="parse this dump ({key: rows}) instead "
                                        "of calling Google")
    ap.add_argument("--out", default=os.path.join(OUT_DIR, "okr_sheet.json"))
    ap.add_argument("--print", action="store_true", help="print, do not write")
    a = ap.parse_args()

    try:
        if a.from_json:
            raw = json.load(open(a.from_json))
            fetched = {k: (f"(local dump) {k}", -1, v) for k, v in raw.items()}
            inventory = []
        else:
            inventory, fetched = fetch(SHEET_ID)
    except Exception as exc:                                     # noqa: BLE001
        log.error("could not read the Operations Input sheet (%s: %s). Leaving "
                  "the committed file untouched. A 403 here is EXPECTED until "
                  "Matthew shares %s explicitly with the service account "
                  "(client_email in GOOGLE_SA_JSON) as Viewer - the sheet is "
                  "shared to the makiramen.com domain, which does not cover a "
                  "service account.", type(exc).__name__, exc, SHEET_ID)
        return 0

    pulled_at = (os.environ.get("PULLED_AT")
                 or datetime.datetime.now(datetime.timezone.utc)
                 .strftime("%Y-%m-%dT%H:%M:%SZ"))
    built = build(fetched, inventory, pulled_at)
    if built is None:
        log.error("nothing parsed from %s - expected three two-column log tabs "
                  "and a summary grid. Leaving the committed file untouched.",
                  SHEET_ID)
        return 0

    for key, series in sorted(built["logs"].items()):
        log.info("%s: %d month(s) entered, %s", key, len(series),
                 ", ".join(f"{m}={v}" for m, v in sorted(series.items())) or "none")
    log.info("OO1: %s", ", ".join(f"{k} {len(v)} month(s)"
                                  for k, v in sorted(built["oo1_scores"].items())) or "none")
    log.info("OO4 KR4: %d month(s)", len(built["oo4_kr4_scores"]))

    # SAY WHEN THE SHEET HAS STOPPED BEING FILLED IN. Every one of these KRs is
    # hand-entered, and all three log tabs went quiet after July 2026. A refresh
    # that runs daily and succeeds against a sheet nobody has touched since then
    # looks perfectly healthy - pulled_at is today - which is exactly how a
    # scorecard ends up reporting a stale month as though it were current.
    if built["source_as_of"]:
        newest = built["source_as_of"]
        this_month = pulled_at[:7]
        if newest < this_month:
            log.warning("NEWEST ENTERED MONTH IS %s, and it is %s. The sheet "
                        "parsed fine, so this is not a broken pull - nobody has "
                        "filled it in. The rows it feeds will carry no score for "
                        "the missing months, which is correct and deliberate.",
                        newest, this_month)

    if a.print:
        print(json.dumps(built, indent=2, sort_keys=True))
        return 0
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(built, fh, indent=2, sort_keys=True)
        fh.write("\n")
    log.info("wrote %s", a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
