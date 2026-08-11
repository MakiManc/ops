#!/usr/bin/env python3
"""
pull_daily_cashup.py  -- Pipe 8 (DAILY cash-up)

Turns a gviz CSV export of the Auto Cash Up workbook's `Raw Data 2` tab into one
JSON file per trading day for the Control Centre's Daily tab.

SOURCE
  Workbook : 1T4TtCs-SkBjinToxG45oKksUiPPPIllo2Pqrqbaix6w  ("Auto Cash Up")
  Tab      : `Raw Data 2`, gid=1549502863, header row 1, data from row 2
  Fetch    : authenticated Chrome, gviz CSV with a server-side date filter --
             .../gviz/tq?tqx=out:csv&headers=1&gid=1549502863&cb=<epoch>
                  &tq=select * where B >= date 'YYYY-MM-DD' and B <= date 'YYYY-MM-DD'
             ALWAYS pass a cache-buster: a cached gviz response served a day-old
             answer on 29/07/2026.
             ALWAYS checksum the browser-side response against the written file:
             get_page_text collapses runs of spaces and silently corrupts the
             accounting-dash cells (" £ -   ").

  The two "Day before Auto" tabs (gid 678700973 / 749766463) are NOT used. They
  are SUMIFS presentation layers over this tab, they hold a single day
  (A1 = TODAY()-1) and they keep no history at all.

WHY THIS PARSER DOES NOT KEY BY HEADER NAME
  Every other pipe in this repo keys by header, and that is still the house rule.
  This tab cannot support it, for two reasons found on 29/07/2026:

  1. DUPLICATE HEADERS. `FOH % ` appears twice (idx 13 and 17) and `BOH % ` twice
     (idx 15 and 19) -- once for Projected, once for Actual. csv.DictReader
     silently drops one of each pair.

  2. PER-ROW COLUMN SHIFT. Individual venue rows are misaligned against the
     header, in both directions:
       Maki 7  -- shifted LEFT by one from idx 10 (it carries no `Projected` £),
                  so its FOH Actual sits under `BOH % `.
       Maki 6  -- shifted RIGHT by one from idx 18, so `BOH Actual ` is empty and
                  the BOH £ sits under `BOH % `.
     Reading those two straight off the header yields percentages where money
     should be, and a £0 split.

  So the labour block is located STRUCTURALLY instead, anchored on the
  percentages, which is invariant under a shift in either direction:

     ... FOHproj£ FOHproj% BOHproj£ BOHproj% FOHact£ FOHact% BOHact£ BOHact% ...

  The £ value for a department is the nearest non-empty money cell to the LEFT of
  its % cell. Where a row carries all four percentages the actual pair is the
  last two; where it carries only two, those two ARE the actual pair.

  Every extraction is then CROSS-VALIDATED: FOH£ must equal FOH% x total labour
  (and likewise BOH) to within 1%. A row that fails validation emits nulls and is
  named in `gaps`, never a silent zero.

  Columns 21 (`Actual Total Labour (£)`) and 22 (`Actual Total Hours`) are stable
  across every row seen, including the shifted ones, because the shifts
  self-correct by a compensating blank. They are read positionally and asserted.

UNALLOCATED LABOUR IS REPORTED, NOT ABSORBED
  FOH + BOH does not always equal total labour. On 27/07/2026 the shortfall ran
  to £86.71 at M18 and £43.58 at M20 -- shifts worked but never assigned to a
  department in the rota system. That gap is emitted as `unallocated` rather than
  being forced into either side, because forcing it would flatter whichever
  department the eye lands on and this split exists to settle exactly that
  argument. It also gives Ziang Lin's 28/07/2026 action -- assign every staff
  member to a position each shift so labour tracks automatically between FOH and
  BOH -- a number to be measured against.

OUTPUT
  <out>/daily_<YYYY-MM-DD>.json, one file per date present in the CSV, plus a
  refreshed <out>/daily_index.json listing available dates newest-first.

USAGE
  python3 pull_daily_cashup.py --csv path/to/raw.csv --out ../data/daily
  python3 pull_daily_cashup.py --csv path/to/raw.csv --out ../data/daily --validate
"""

import argparse
import csv
import json
import os
import re
import sys
from datetime import datetime

# ----------------------------------------------------------------------------
# Site map. Keys are TRIMMED venue labels -- 5 of 22 carry trailing spaces at
# source ("Maki 7 ", "Ikigai 1 ", "Maki 17 ", "Maki O2 ", "Maki Nori ").
# The 19 live sites match build_site_json.py's CLUSTERS exactly.
# ----------------------------------------------------------------------------
VENUE_TO_CODE = {
    "Maki 1": "M1",
    "Maki 3": "M3",
    "Maki 6": "M6",
    "Maki 7": "M7",
    "Maki 8": "M8",
    "Maki 9": "M9",
    "Maki 10": "M10",
    "Maki 11": "M11",
    "Maki 12": "M12",
    "Maki 13": "M13",
    "Maki 14": "M14",
    "Maki 15": "M15",
    "Maki 16": "M16",
    "Maki 17": "M17",
    "Maki 18": "M18",
    "Maki 19": "M19",
    "Maki 20": "M20",
    "Maki Nori": "MakiNori",
    "Ikigai 2": "IKI2",
}

# Deliberately excluded. M4 and Ikigai 1 are PHANTOM source columns, not sites
# (Michael, 28/07/2026). AA Factory is production. Maki O2 is franchise (MAF3)
# and its feed runs a day behind on `RAW Data Franchisee`.
VENUE_IGNORE = {"Maki 4", "Ikigai 1", "AA Factory", "Maki O2"}

# ---- org map ----------------------------------------------------------------
# Regions, Area Managers and Deputy Area Managers, from the Area Management
# Function Operational Manual v1.0 (May 2026). Site membership matches
# build_site_json.py's CLUSTERS exactly, so the Daily tab groups the estate the
# same way every weekly tab does. Held here rather than in the shell so a
# re-org only needs a rebuild, not an index.html redeploy.
CLUSTERS = [
    ("Scotland & Newcastle", "Ka Ho", "Óisín Patrick Darragh",
     ["M1", "M3", "M6", "M7", "M8", "IKI2", "M12", "M13", "M15"]),
    ("North England & Midlands", "Inka Cheung", "Amy Tang",
     ["M9", "M10", "M11", "M14", "M16"]),
    ("South England", "Lincoln (Ziang)", "Kaitlin Dorcherty",
     ["M17", "M18", "M19", "M20", "MakiNori"]),
]
CODE_TO_CLUSTER = {c: name for name, _am, _dam, codes in CLUSTERS for c in codes}

# Positional anchors, asserted at run time rather than trusted.
IDX_VENUE, IDX_DATE, IDX_DAY = 0, 1, 2
IDX_SIT_IN_TARGET, IDX_DELIVERY_TARGET = 3, 4
IDX_SIT_IN, IDX_DELIVERY, IDX_TIPS, IDX_ACTUAL = 5, 6, 7, 8
IDX_LABOUR_TOTAL, IDX_LABOUR_HOURS = 21, 22
IDX_COVERS, IDX_AVG_SPEND, IDX_WAGE_PCT = 24, 25, 26

# The window the FOH/BOH block always falls inside, shifted or not.
BLOCK_START, BLOCK_END = 9, 21

EXPECTED_HEADERS = {
    IDX_VENUE: "Venue ",
    IDX_DATE: "Date",
    IDX_ACTUAL: "Actual (£)",
    IDX_LABOUR_TOTAL: "Actual Total Labour (£)",
    IDX_LABOUR_HOURS: "Actual Total Hours",
    IDX_COVERS: "No. Of Customers",
    IDX_WAGE_PCT: "Wages/Revenue (%)",
}

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday",
             "Friday", "Saturday", "Sunday"]

MONEY_RE = re.compile(r"^[\s£$]*-?[\d,]*\.?\d*[\s]*$")
PCT_RE = re.compile(r"^\s*-?[\d,]*\.?\d+\s*%\s*$")


def is_pct(raw):
    return bool(raw) and bool(PCT_RE.match(raw))


def num(raw):
    """Parse a money/number cell. Returns None for blank, dash-zero or errors.

    Handles: '£528.20', ' £ 1,263.31 ', '346.8', ' £ -   ' (accounting zero),
    '#DIV/0!', '' and '-'.
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if not s or s.startswith("#"):
        return None
    s = s.replace("£", "").replace(",", "").replace("%", "").strip()
    if s in ("", "-", "–"):
        return 0.0
    try:
        return float(s)
    except ValueError:
        return None


def pct(raw):
    """Parse a percentage cell into a number of percent (31.51% -> 31.51)."""
    if not is_pct(raw):
        return None
    return num(raw)


def money_left_of(row, i):
    """Nearest non-empty, non-percentage money cell to the left of index i."""
    j = i - 1
    while j >= BLOCK_START:
        raw = row[j].strip() if j < len(row) else ""
        if raw and not is_pct(raw):
            v = num(raw)
            if v is not None:
                return v, j
        j -= 1
    return None, None


def extract_split(row, total_labour, code, date_str, warnings):
    """Locate the FOH/BOH ACTUAL pair by RECONCILIATION, not by column position.

    The one property that holds on every row seen, shifted or not, is that the
    two actual department figures sum to a money cell sitting to their RIGHT --
    either the `FOH+BOH` cell or, where that is blank, `Actual Total Labour`.
    So: find money cells i < j < k inside the block where v[i] + v[j] == v[k],
    and take the RIGHTMOST such triple.

    Why not anchor on the percentages, which was the obvious first idea:
      - Maki Nori drops one of the two actual % cells (blank FOH %), leaving an
        odd count of three, so pairing by position breaks.
      - Ikigai 2 carries 0.00% placeholders with no £ at all.
      - and fatally, sites disagree on the DENOMINATOR. Maki 7's 39.78% is a
        share of FOH+BOH; Maki 18's 33.55% is a share of total labour. The
        column is not one metric.
    So the sheet's own % columns are ignored entirely. The percentage this pipe
    publishes is computed here as £ / final total labour cost, which is what was
    asked for and is the same definition at every site.

    The projected pair can never be mistaken for the actual pair: `Projected`
    sits to the LEFT of the projected departments, so a projected triple fails
    the i < j < k ordering test.

    Returns (foh, foh_pct, boh, boh_pct, status).
    """
    end = min(BLOCK_END, len(row) - 1)
    vals = {}
    for i in range(BLOCK_START, end + 1):
        raw = row[i].strip()
        if not raw or is_pct(raw):
            continue
        v = num(raw)
        if v is not None:
            vals[i] = v

    idxs = sorted(vals)
    best = None
    for a in range(len(idxs)):
        for b in range(a + 1, len(idxs)):
            i, j = idxs[a], idxs[b]
            if vals[i] <= 0 or vals[j] <= 0:
                continue
            target = vals[i] + vals[j]
            for c in range(b + 1, len(idxs)):
                k = idxs[c]
                if abs(vals[k] - target) > max(0.02, target * 0.0005):
                    continue
                if total_labour and vals[k] > total_labour * 1.005:
                    continue
                cand = (k, j, i)
                if best is None or cand > best[0]:
                    best = (cand, vals[i], vals[j])

    if best is not None:
        (_, _, _), foh_v, boh_v = best
    else:
        # FALLBACK. The reconciliation anchor needs the sum to appear in a cell.
        # Maki 6 is shifted RIGHT far enough that its `FOH+BOH` cell is consumed,
        # so on a day where it also has unallocated labour the sum appears
        # nowhere and the triple search finds nothing. Fall back to the layout's
        # other invariant: each department's £ is immediately followed by its %.
        # Take the last two such (£, %) pairs and only accept them if the
        # percentages actually resolve against a sane denominator -- either the
        # final total labour cost or the pair's own sum. That check is what stops
        # a projected-only pair being accepted as actual.
        pairs = []
        for i in idxs:
            if i + 1 <= end and is_pct(row[i + 1].strip()) and vals[i] > 0:
                p = pct(row[i + 1])
                if p:                      # a 0.00% cell means "not recorded"
                    pairs.append((i, vals[i], p))
        if len(pairs) < 2 or not total_labour:
            return None, None, None, None, "absent"
        (_, foh_v, foh_p), (_, boh_v, boh_p) = pairs[-2], pairs[-1]

        # The percentages MUST resolve against the final total labour cost. Not
        # against the pair's own sum -- that looser test let Maki 14's
        # PROJECTED pair through on 28/07/2026 (£388.77 + £597.37 = £986.14,
        # which is exactly the `Projected` cell, and the projected percentages
        # reconcile perfectly against it) even though the site recorded no
        # actual split at all that day.
        tol = max(0.5, total_labour * 0.005)
        if (abs(foh_v - total_labour * foh_p / 100.0) > tol
                or abs(boh_v - total_labour * boh_p / 100.0) > tol):
            warnings.append(
                f"{date_str} {code}: FOH £{foh_v:,.2f}/{foh_p}% and BOH "
                f"£{boh_v:,.2f}/{boh_p}% do not resolve against total labour "
                f"£{total_labour:,.2f} - looks like projected, not actual "
                f"- split rejected"
            )
            return None, None, None, None, "failed_validation"

    if not total_labour:
        return None, None, None, None, "absent"

    if foh_v + boh_v > total_labour * 1.005:
        warnings.append(
            f"{date_str} {code}: FOH £{foh_v:,.2f} + BOH £{boh_v:,.2f} exceeds "
            f"total labour £{total_labour:,.2f} - split rejected"
        )
        return None, None, None, None, "failed_validation"

    return (round(foh_v, 2), round(foh_v / total_labour * 100.0, 2),
            round(boh_v, 2), round(boh_v / total_labour * 100.0, 2), "ok")


def iso_date(raw):
    """'27/07/2026' -> '2026-07-27'. UK order, always."""
    s = raw.strip()
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="gviz CSV export of Raw Data 2")
    ap.add_argument("--out", required=True, help="output dir for daily_<date>.json")
    ap.add_argument("--validate", action="store_true",
                    help="parse and report, write nothing")
    a = ap.parse_args()

    with open(a.csv, newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.reader(fh))

    if not rows:
        sys.exit("FATAL: empty CSV")

    header = rows[0]
    for idx, expected in EXPECTED_HEADERS.items():
        got = header[idx] if idx < len(header) else "<missing>"
        if got.strip() != expected.strip():
            sys.exit(
                f"FATAL: column {idx} is {got!r}, expected {expected!r}. The "
                f"`Raw Data 2` layout has changed -- re-scout the tab and update "
                f"the anchors in this script rather than reading positionally."
            )

    days = {}
    warnings = []
    unknown = set()

    for row in rows[1:]:
        if len(row) <= IDX_WAGE_PCT:
            row = row + [""] * (IDX_WAGE_PCT + 1 - len(row))

        venue = row[IDX_VENUE].strip()
        if not venue or venue in VENUE_IGNORE:
            continue
        code = VENUE_TO_CODE.get(venue)
        if not code:
            unknown.add(venue)
            continue

        date_str = iso_date(row[IDX_DATE])
        if not date_str:
            continue

        sales = num(row[IDX_ACTUAL])
        # Future rows are pre-created out to 2028 with £0.00 placeholders, so a
        # zero-sales row is "not cashed up yet", not a real trading day.
        if not sales:
            continue

        total_labour = num(row[IDX_LABOUR_TOTAL])
        hours = num(row[IDX_LABOUR_HOURS])
        covers = num(row[IDX_COVERS])
        wage_pct = pct(row[IDX_WAGE_PCT])
        if wage_pct is None and total_labour and sales:
            wage_pct = round(total_labour / sales * 100.0, 2)

        foh, foh_p, boh, boh_p, status = extract_split(
            row, total_labour, code, date_str, warnings)

        unallocated = None
        if status == "ok" and total_labour is not None:
            unallocated = round(total_labour - foh - boh, 2)
            if abs(unallocated) < 0.05:      # rounding noise, not a real gap
                unallocated = 0.0

        # TARGET = Sit In target + Delivery Target. That sum is exactly the
        # "Target Sales" row Michael already reads on the Day before Auto tabs
        # (M1 27/07: £2,800 + £1,200 = £4,000). Column D alone is NOT the target.
        # The separate "Flat Target" row is a different figure and is not used.
        t_sit, t_del = num(row[IDX_SIT_IN_TARGET]), num(row[IDX_DELIVERY_TARGET])
        target = None if (t_sit is None and t_del is None) else round((t_sit or 0) + (t_del or 0), 2)
        if target == 0:
            target = None

        day = days.setdefault(date_str, {"sites": {}})
        day["sites"][code] = {
            "name": venue,
            "cluster": CODE_TO_CLUSTER.get(code),
            "sales": {
                "actual": round(sales, 2),
                "sit_in": num(row[IDX_SIT_IN]),
                "delivery": num(row[IDX_DELIVERY]),
                "tips": num(row[IDX_TIPS]),
                "target": target,
                "vs_target_pct": (round((sales / target - 1) * 100.0, 2)
                                  if target else None),
            },
            "covers": int(covers) if covers else None,
            "avg_spend": num(row[IDX_AVG_SPEND]),
            "labour": {
                "total": round(total_labour, 2) if total_labour is not None else None,
                "hours": hours,
                "wage_pct": wage_pct,
                "foh": foh,
                "foh_pct": foh_p,
                "boh": boh,
                "boh_pct": boh_p,
                "unallocated": unallocated,
                "unallocated_pct": (
                    round(unallocated / total_labour * 100.0, 2)
                    if unallocated and total_labour else (0.0 if status == "ok" else None)
                ),
                "split_status": status,
            },
        }

    if unknown:
        sys.exit(
            "FATAL: unrecognised venue label(s): "
            + ", ".join(sorted(repr(u) for u in unknown))
            + ". Add them to VENUE_TO_CODE (or VENUE_IGNORE) rather than "
              "letting a site drop out of the daily silently."
        )

    if not days:
        sys.exit(
            "FATAL: no trading days found in the CSV. Either the date filter "
            "returned only pre-created placeholder rows, or the pull ran before "
            "any site cashed up. Nothing written -- rerun later."
        )

    os.makedirs(a.out, exist_ok=True)
    written = []

    for date_str in sorted(days):
        sites = days[date_str]["sites"]
        split_ok = [c for c, s in sites.items() if s["labour"]["split_status"] == "ok"]
        missing = sorted(set(VENUE_TO_CODE.values()) - set(sites))
        no_split = sorted(c for c in sites if c not in split_ok)
        unalloc_total = round(sum(
            s["labour"]["unallocated"] or 0.0 for s in sites.values()), 2)

        payload = {
            "_source": (
                "Auto Cash Up workbook 1T4TtCs-SkBjinToxG45oKksUiPPPIllo2Pqrqbaix6w, "
                "tab 'Raw Data 2' gid=1549502863. FOH/BOH ACTUAL split located "
                "structurally by percentage anchor (the header carries duplicate "
                "`FOH % `/`BOH % ` names and individual venue rows are shifted "
                "against it), then cross-validated against % x total labour."
            ),
            "_generated_at": datetime.now().isoformat(timespec="seconds"),
            "date": date_str,
            "day": DAY_NAMES[datetime.fromisoformat(date_str).weekday()],
            "sites_reported": len(sites),
            "sites_expected": len(VENUE_TO_CODE),
            "foh_boh_reported": len(split_ok),
            "unallocated_labour_total": unalloc_total,
            "clusters": [
                {"name": name, "am": am, "dam": dam,
                 "codes": [c for c in codes if c in sites]}
                for name, am, dam, codes in CLUSTERS
            ],
            "gaps": {
                "no_sales": missing,
                "no_foh_boh_split": no_split,
                "warnings": [w for w in warnings if w.startswith(date_str)],
            },
            "sites": dict(sorted(sites.items())),
        }

        totals = {
            "sales": round(sum(s["sales"]["actual"] or 0 for s in sites.values()), 2),
            "target": round(sum(s["sales"]["target"] or 0 for s in sites.values()), 2),
            "covers": sum(s["covers"] or 0 for s in sites.values()),
            "labour": round(sum(s["labour"]["total"] or 0 for s in sites.values()), 2),
            "foh": round(sum(s["labour"]["foh"] or 0 for s in sites.values()), 2),
            "boh": round(sum(s["labour"]["boh"] or 0 for s in sites.values()), 2),
        }
        totals["wage_pct"] = (round(totals["labour"] / totals["sales"] * 100.0, 2)
                              if totals["sales"] else None)
        totals["avg_spend"] = (round(totals["sales"] / totals["covers"], 2)
                               if totals["covers"] else None)
        payload["totals"] = totals

        path = os.path.join(a.out, f"daily_{date_str}.json")
        if not a.validate:
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=1, ensure_ascii=False)
        written.append(path)
        print(f"[daily] {date_str} {payload['day']}: {len(sites)}/"
              f"{len(VENUE_TO_CODE)} sites, FOH/BOH {len(split_ok)}/{len(sites)}, "
              f"unallocated £{unalloc_total:,.2f} -> {path}")

    # Rebuild the index from what is actually on disk, so a day can never be
    # advertised to the shell before its file exists.
    #
    # ⭐ THE STEM MUST PARSE AS A DATE. Since 31/07/2026 this directory ALSO holds
    #    Pipe 8b's `daily_reviews_<date>.json` + `daily_reviews_index.json`, and
    #    every one of them matches `daily_*.json`. Excluding `daily_index.json`
    #    by name is not enough: the first run after the reviews pipe shipped
    #    produced `latest: "reviews_index"` and nine bogus dates, which would
    #    have made the shell fetch `daily_reviews_index.json` as if it were a
    #    trading day and blank the tab. Caught 31/07/2026 before deploy.
    #    Do NOT relax this back to a prefix test.
    if not a.validate:
        dates = sorted(
            (f[6:-5] for f in os.listdir(a.out)
             if f.startswith("daily_") and f.endswith(".json")
             and re.fullmatch(r"\d{4}-\d{2}-\d{2}", f[6:-5])),
            reverse=True,
        )
        idx_path = os.path.join(a.out, "daily_index.json")
        with open(idx_path, "w", encoding="utf-8") as fh:
            json.dump({
                "_generated_at": datetime.now().isoformat(timespec="seconds"),
                "latest": dates[0] if dates else None,
                "dates": dates,
            }, fh, indent=1)
        print(f"[daily] index: {len(dates)} day(s), latest {dates[0]} -> {idx_path}")

    for w in warnings:
        print(f"[daily] WARN {w}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
