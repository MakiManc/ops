#!/usr/bin/env python3
"""
Pipe 8b — DAILY Google reviews for the Control Centre Daily tab.
================================================================

Companion to Pipe 8 (`pull_daily_cashup.py`). Same cadence, same output
directory, completely separate source and slice — nothing here can move a
number on the cash-up table, and nothing there can move a number here.

SOURCE
------
The **`Raw Data` tab (gid 284143046)** of the Google Reviews workbook
`1aFGfbGrEBeqWny8myF6H4LVxO0YegT0MdIJHrxpxk3I` — one row per Google review.
This is the SAME tab the weekly Pipe 5 (`pull_reviews.py`) reads. This pipe
does not touch, rewrite or re-key any weekly slice.

Columns (0-indexed, confirmed live 31/07/2026):
    0 reviewId   1 locationId  2 siteName   3 author_name  4 rating (word)
    5 comment    6 createTime  7 updateTime 8 -  9 -  10 Site  11 Date
    12 -  13 Location ID's  14 Site  15 -

⭐ TRAP — THE `Date` COLUMN IS dd/mm/yyyy **TEXT**, NOT A DATE VALUE.
    Pipe 5 reads this tab through openpyxl, where col L arrives as a real
    datetime. Over the **gviz CSV route this pipe uses it is the string
    "28/07/2026"**, and Pipe 5's date logic (`str(...)[:10].replace("/","-")`
    then `date(*map(int, split("-")))`) parses that as year=28, month=7,
    day=2026 -> ValueError -> falls through to createTime. Silent, and it
    would have quietly shifted every review onto its UTC createTime day.
    `_parse_date()` below handles dd/mm/yyyy explicitly and PREFERS col L,
    because col L is the local trading date the sites are judged on.

⭐ TRAP — YOU CANNOT SERVER-SIDE FILTER ON COLUMN L.
    Because L is text, `where L >= date '...'` returns nothing. Filter the
    gviz query on **createTime (col G)** as a STRING comparison (ISO-8601
    sorts lexicographically), with a >=1 day buffer at each end to absorb the
    UTC-vs-local skew, then filter exactly on col L here. See RUNBOOK.

⭐ REVIEWS ARE A FEEDBACK INBOX, NOT A SAME-DAY QUALITY SCORE.
    A Google review lands days after the visit. `day` counts reviews
    RECEIVED that day; it does NOT describe that day's trading. The UI must
    label it as received-that-day. Do not "fix" this by joining on the visit
    date — that date does not exist in the source.

Usage:
    python3 pull_daily_reviews.py --psv raw.psv --date 2026-07-30 \
        --outdir ../data/daily [--window 7] [--validate]
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta

# --------------------------------------------------------------------------
# Org map — MUST stay identical to pull_daily_cashup.py CLUSTERS so the review
# column groups under exactly the same regional bands as the cash-up rows.
# --------------------------------------------------------------------------
CLUSTERS = [
    ("Scotland & Newcastle", "Ka Ho", "Óisín Patrick Darragh",
     ["M1", "M3", "M6", "M7", "M8", "IKI2", "M12", "M13", "M15"]),
    ("North England & Midlands", "Inka Cheung", "Amy Tang",
     ["M9", "M10", "M11", "M14", "M16"]),
    ("South England", "Lincoln (Ziang)", "Kaitlin Dorcherty",
     ["M17", "M18", "M19", "M20", "MakiNori"]),
]
CODE_TO_CLUSTER = {c: n for n, _am, _dam, codes in CLUSTERS for c in codes}
SITES = [c for _n, _am, _dam, codes in CLUSTERS for c in codes]

# --------------------------------------------------------------------------
# Site-label map. Lifted VERBATIM from pull_reviews.RAWTAB_SITE_TO_CODE so the
# daily and weekly views can never disagree about which site a review is for.
#
# ⭐ 'Leith' is deliberately ABSENT — Michael's explicit standing decision. It
#    is NOT Ikigai 2. Do not add it. Leith rows fall through to `unmapped`.
# ⭐ IKI2 has NO label on this tab at all, so it always reads zero reviews.
#    That is a SOURCE gap, not a bug, and is reported in `gaps`.
# ⭐ MAF1/MAF3/MAF-NQ are franchise, collected-but-not-rendered (not in SITES).
# --------------------------------------------------------------------------
SITE_TO_CODE = {
    "sjq": "M7", "leeds": "M10", "manchester": "M9", "renfield": "M8",
    "bath st": "M6", "maki1/2": "M1", "leicester": "M11", "nottingham": "M16",
    "newcastle": "M12", "metro": "M15", "lakeside": "M17", "aberdeen": "M13",
    "soho": "M18", "meadowhall": "M14", "nori": "MakiNori",
    "maki shoreditch": "M19", "maki southampton": "M20",
    "west end": "MAF1", "maki o2": "MAF3", "nq": "MAF-NQ",
}
RATING_WORD_TO_INT = {"five": 5, "four": 4, "three": 3, "two": 2, "one": 1}

NEG_MAX = 3          # <=3* is a negative. Michael's threshold, matches Pipe 5.
POS_CAP = 12         # cap on positives carried per site (negatives are NEVER
                     # capped). Any drop is REPORTED in the payload, never silent.


def _rating_int(v):
    """'FIVE' / '5' / '5*' / 5.0 -> int 1..5, else None. Mirrors Pipe 5."""
    if v is None:
        return None
    s = str(v).strip().lower()
    if not s:
        return None
    if s in RATING_WORD_TO_INT:
        return RATING_WORD_TO_INT[s]
    try:
        n = int(round(float(s.split()[0])))
        if 1 <= n <= 5:
            return n
    except (ValueError, IndexError):
        pass
    for ch in s:
        if ch.isdigit():
            n = int(ch)
            return n if 1 <= n <= 5 else None
    return None


def _parse_date(dcell, createtime):
    """Col L is dd/mm/yyyy TEXT (see module docstring). Prefer it — it is the
    local trading date. Fall back to createTime (ISO, UTC). Never fabricate."""
    s = str(dcell or "").strip()
    if s:
        for sep in ("/", "-"):
            if sep in s:
                parts = s.split(sep)
                if len(parts) == 3:
                    try:
                        a, b, c = (int(p) for p in parts[:3])
                    except ValueError:
                        break
                    # dd/mm/yyyy — the format a plain `select *` returns.
                    if c > 31:
                        return date(c, b, a)
                    # yyyy-m-d — what gviz returns when a GROUP BY coerces the
                    # column to a real date type, e.g. "2026-7-24". NOT zero
                    # padded, so date.fromisoformat() rejects it on <3.11 and
                    # the row would have been silently dropped. Seen live
                    # 31/07/2026; do not remove this branch.
                    if a > 31:
                        return date(a, b, c)
                break
        try:                                             # bare padded ISO
            return date.fromisoformat(s[:10])
        except ValueError:
            pass
    ct = str(createtime or "").strip()
    if ct:
        try:
            return datetime.fromisoformat(ct.replace("Z", "+00:00")).date()
        except ValueError:
            pass
    return None


def load_psv(path):
    """Pipe-delimited fetch: rid|author|rating|comment|site|date (one per line).

    Emitted by the browser-side fetch with runs of whitespace already collapsed
    (see RUNBOOK) so `get_page_text` cannot corrupt it. Split with maxsplit so a
    stray '|' inside comment text can never shift the trailing columns."""
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                continue
            p = line.split("|")
            if len(p) < 6:
                continue
            # site and date are the LAST two fields; comment is everything
            # between rating and site, rejoined (defensive against stray pipes).
            rid, author, rating = p[0], p[1], p[2]
            site, dt = p[-2], p[-1]
            comment = "|".join(p[3:-2])
            rows.append((rid, author, rating, comment, site, dt))
    return rows


def build(rows, target, window_days):
    win_start = target - timedelta(days=window_days - 1)

    per = defaultdict(lambda: {"day": [], "window": []})
    unmapped, dupes, nodate, scanned = defaultdict(int), 0, 0, 0
    seen = set()

    for rid, author, rating_raw, comment, site_raw, dcell in rows:
        site = (site_raw or "").strip()
        if not site:
            continue
        scanned += 1

        d = _parse_date(dcell, None)
        if d is None:
            nodate += 1
            continue
        if not (win_start <= d <= target):
            continue

        code = SITE_TO_CODE.get(site.lower())
        if not code:
            unmapped[site] += 1
            continue

        stars = _rating_int(rating_raw)
        if stars is None:
            continue

        text = (comment or "").strip()
        author = (author or "").strip() or None

        # DEDUPE — the Raw Data tab carries the same review on more than one
        # row for some sites (M10 and M11 have historically doubled EVERY row;
        # see project_reviews_dedupe_fix). Key on the stable Google reviewId,
        # falling back to a content signature for rows pasted without one.
        rid = (rid or "").strip()
        ikey = ("id:" + rid) if rid else None
        ckey = (code, author or "", d.isoformat(), stars, text[:200])
        if (ikey and ikey in seen) or ckey in seen:
            dupes += 1
            continue
        if ikey:
            seen.add(ikey)
        seen.add(ckey)

        rec = {"stars": stars, "author": author, "text": text,
               "date": d.isoformat(), "has_comment": bool(text)}
        per[code]["window"].append(rec)
        if d == target:
            per[code]["day"].append(rec)

    def stats(items):
        n = len(items)
        if not n:
            return {"n": 0, "avg": None, "neg": 0, "pos": 0, "with_comment": 0}
        return {
            "n": n,
            "avg": round(sum(i["stars"] for i in items) / n, 2),
            "neg": sum(1 for i in items if i["stars"] <= NEG_MAX),
            "pos": sum(1 for i in items if i["stars"] > NEG_MAX),
            "with_comment": sum(1 for i in items if i["has_comment"]),
        }

    sites, no_reviews, capped = {}, [], {}
    for code in SITES:
        win = sorted(per[code]["window"],
                     key=lambda r: (r["date"], r["stars"]), reverse=True)
        day = per[code]["day"]
        if not win:
            no_reviews.append(code)

        # Readable list: EVERY negative with a comment (never capped — these
        # are the whole point), plus the most recent POS_CAP positives.
        negs = [r for r in win if r["stars"] <= NEG_MAX and r["has_comment"]]
        poss = [r for r in win if r["stars"] > NEG_MAX and r["has_comment"]]
        if len(poss) > POS_CAP:
            capped[code] = {"positives_total": len(poss), "positives_shown": POS_CAP}
        shown = negs + poss[:POS_CAP]
        shown.sort(key=lambda r: r["date"], reverse=True)

        sites[code] = {
            "cluster": CODE_TO_CLUSTER.get(code),
            "day": stats(day),
            "window": stats(win),
            "reviews": shown,
        }

    regions = {}
    for name, am, dam, codes in CLUSTERS:
        d_items = [r for c in codes for r in per[c]["day"]]
        w_items = [r for c in codes for r in per[c]["window"]]
        regions[name] = {"am": am, "dam": dam, "sites": codes,
                         "day": stats(d_items), "window": stats(w_items)}

    return {
        "date": target.isoformat(),
        "window_from": win_start.isoformat(),
        "window_to": target.isoformat(),
        "window_days": window_days,
        "_generated_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": ("Google Reviews workbook 1aFGfbGr… — 'Raw Data' tab "
                   "(gid 284143046). Reviews RECEIVED on the date shown; a "
                   "review lands days after the visit."),
        "neg_threshold": NEG_MAX,
        "sites": sites,
        "regions": regions,
        "gaps": {
            "no_reviews_in_window": no_reviews,
            "unmapped_labels": dict(unmapped) or None,
            "positives_capped": capped or None,
            "duplicates_dropped": dupes,
            "rows_without_date": nodate,
            "rows_scanned": scanned,
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--psv", required=True)
    ap.add_argument("--date", help="target day YYYY-MM-DD (default: yesterday)")
    ap.add_argument("--window", type=int, default=7)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--validate", action="store_true")
    a = ap.parse_args()

    target = (date.fromisoformat(a.date) if a.date
              else date.today() - timedelta(days=1))
    payload = build(load_psv(a.psv), target, a.window)

    os.makedirs(a.outdir, exist_ok=True)
    out = os.path.join(a.outdir, f"daily_reviews_{target.isoformat()}.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)

    # Index rebuilt from what is ACTUALLY on disk, so a day can never be
    # advertised before its file exists (same rule as the cash-up pipe).
    # ⚠️ The index file itself matches `daily_reviews_*.json`. Without the date
    # test below it listed itself, so `days` ended with the literal "index" and
    # `latest` came out as "index". Caught 31/07/2026 before first deploy. The
    # stem MUST parse as YYYY-MM-DD; anything else in the directory is ignored.
    stems = (f[len("daily_reviews_"):-len(".json")]
             for f in os.listdir(a.outdir)
             if f.startswith("daily_reviews_") and f.endswith(".json"))
    days = sorted(s for s in stems if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s))
    with open(os.path.join(a.outdir, "daily_reviews_index.json"), "w") as fh:
        json.dump({"days": days, "latest": days[-1] if days else None}, fh, indent=1)

    g = payload["gaps"]
    print(f"WROTE {out}")
    print(f"  scanned={g['rows_scanned']} dupes={g['duplicates_dropped']} "
          f"nodate={g['rows_without_date']}")
    print(f"  day {target}: "
          f"{sum(s['day']['n'] for s in payload['sites'].values())} reviews, "
          f"{sum(s['day']['neg'] for s in payload['sites'].values())} negative")
    print(f"  window {payload['window_from']}..{payload['window_to']}: "
          f"{sum(s['window']['n'] for s in payload['sites'].values())} reviews, "
          f"{sum(s['window']['neg'] for s in payload['sites'].values())} negative")
    if g["no_reviews_in_window"]:
        print(f"  WARN no reviews in window: {', '.join(g['no_reviews_in_window'])}")
    if g["unmapped_labels"]:
        print(f"  WARN unmapped labels (dropped): {g['unmapped_labels']}")
    if g["positives_capped"]:
        print(f"  NOTE positives capped at {POS_CAP}: {g['positives_capped']}")

    if a.validate:
        for code, s in payload["sites"].items():
            w = s["window"]
            assert w["neg"] + w["pos"] == w["n"], f"{code} neg+pos != n"
            assert s["day"]["n"] <= w["n"], f"{code} day > window"
            assert all(r["has_comment"] for r in s["reviews"]), f"{code} blank shown"
        print("  VALIDATE OK — neg+pos==n, day<=window, every shown review has text")


if __name__ == "__main__":
    main()
