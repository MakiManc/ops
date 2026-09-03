#!/usr/bin/env python3
"""
bake_ops_command.py  -- Pipe 9 (Ops Command daily snapshot)
Bakes one data/ops_command/snapshot_<pull_date>.json per day for the Ops Command
dashboard (command/index.html + the desktop artifact), and prepends the date to
snapshot_index.json. Structured JSON replaces the markdown-pipe-table SNAPSHOT
string the artifact used to carry between SNAPSHOT-START/END markers.
SOURCE
  Neon Postgres warehouse (system of record for all ETL feeds), table
  etl_feed_rows(feed, pull_date, row_num, data jsonb, loaded_at).
  Connection : WAREHOUSE_DSN env var (the same secret the ETL workflows use).
  This pipe reads the warehouse DIRECTLY -- the "Ops Command KPIs" Google Sheet
  is a serving layer for chat sessions, not a source, and reading it back as
  text was two lossy hops for data that started structured (13/08/2026).
TRAPS, WITH DATES (house rule: write them down where the next person will look)
  * DEEP vs DAILY FEED NAMESPACES (13/08/2026). The 03:00 deep pull and the
    08:15 daily export both wrote feed 'Flow Modules' with the same pull_date,
    and pg_loader replaces per (feed, pull_date) -- so the export's ~456-row
    module CATALOGUE clobbered the ~4,700-row per-trainee pull every morning.
    Fixed by namespacing: per-trainee data is 'Deep Flow Modules' etc. This pipe
    PROBES for the Deep feed and falls back to the un-prefixed one, and always
    records which it used in the block's `source_feed`.
  * Flow Trainees.branch holds a branch ID, not a name (13/08/2026). Join
    through Flow Branches id -> name or every site reads "121711".
  * module_status is COMPOSITE, comma-joined: 'In Progress, Overdue',
    'Not Yet Started, Overdue' (13/08/2026). Overdue is a flag on top of a
    state -- match as a substring; = 'Overdue' silently finds nothing. Never
    render Overdue as a stack segment beside the states: it double-counts.
  * Flow Certificates exposes NO expiry field (only certificate_url,
    module_name, trainee_id) (13/08/2026). Emitted as a `gaps` entry every run
    so the blind spot stays visible until the source improves.
  * SUPPLIER ATTRIBUTION (13/08/2026, resolved same day). The Delivery/
    Supplier Issue Form HAS a 'Supplier?' task (free-text 'Supplier Name').
    'GC Form Task Answers' first LANDED in the warehouse with run #35 on
    13/08/2026 (earlier probes found it absent - that was timing: the pg
    dual-write was only added 12/08 and the sheet tab's idempotent skip
    bypassed it). Each pull covers a rolling ~7-day window, so this pipe
    dedupes by FormId/AnswerID ACROSS pull_dates - history accumulates from
    13/08/2026 onward. First real data: Lynas 14 answered issues in 7 days
    while form-TITLE attribution showed Lynas 0. Titles lie; answers don't.
  * EVENT DATES vs PULL DATES (13/08/2026). Date-range filtering must slice
    on the event's own date - AnsweredDateTime for form answers/issues,
    module_completed_date for training - never on pull_date. pull_date is
    when the ETL ran, not when the thing happened.
  * module_completed_date is UK-format 'DD/MM/YYYY HH:MM' (13/08/2026);
    AnsweredDateTime is ISO. Both parsed defensively, bad values skipped.
  * "Sosltice" is a live typo in a GetCompliant form title (13/08/2026). Both
    spellings map to supplier Solstice here; fix at source when possible.
  * GC Forms Overview LocationGroupName/Id are entirely null (13/08/2026), so
    form completion cannot be split by site -- only by form and folder.
  * The legacy Feed Status ('ok'/'failed'/'empty') reflects the SHEETS write,
    not the data: the warehouse sheet hit Google's 10M-cell ceiling on
    12/08/2026 and healthy feeds were stamped 'empty'. Feed health here is
    measured against Postgres row counts, which is the point of this pipe.
  * SQL uses position(x in y), never LIKE -- no literal '%' in query strings,
    so psycopg parameter substitution can't be tripped (13/08/2026).
HOUSE RULES HONOURED
  nulls + a named entry in `gaps`, never silent zeros; every derived signal
  carries a `basis` string; independent data families are independent blocks;
  the site map lives in this builder, not the shell; history is append-only
  (dated files, index prepended, nothing rewritten).
USAGE
  WAREHOUSE_DSN=postgres://... python3 builders/bake_ops_command.py [--date YYYY-MM-DD]
  Writes data/ops_command/snapshot_<date>.json and updates snapshot_index.json.
  Exit 0 on success, 1 on any failure (nothing partially written).
"""
from __future__ import annotations
import argparse, datetime, hashlib, json, os, re, sys
# psycopg2 is imported lazily in main(): with OPS_WAREHOUSE_SOURCE=archive the
# bake needs no Postgres driver at all, and requiring one would defeat the point.
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "ops_command")
# Site map lives in the builder (house rule) -- classification, not presentation.
# type: restaurant | factory | entity (non-trading legal vehicles on the roster)
SITE_TYPES = {
    "AA Factory1 Limited": "factory",
    "Maki Property Ltd": "entity",
    "M1TOO Ltd": "entity",
    "South Ikigai Ltd": "entity",
    "Renfield Good Food Ltd": "restaurant",
    "Fountain Good Food Ltd": "restaurant",
}
# Ross, 18 Aug 2026: the Show filter groups sites by AM REGION (replacing the
# site-type split). Mapping follows the AM Manual's three clusters (Scotland &
# Newcastle / North England & Midlands / South England), confirmed by Ross --
# deliberately organisational, not geographic: Newcastle+METRO sit under
# Scotland, Renfield (Glasgow) under North England, Birmingham under South
# England, because that is who manages them. Best-fit for the three sites the
# manual doesn't cover (also Ross-confirmed): O2 Arena -> south (London,
# host-region AM), AA Factory1 + Maki Property -> scotland. Any site missing
# from this map gets a named gap and shows under All only -- never guessed.
SITE_REGIONS = {
    "M1TOO Ltd": "scotland",              # M1 WR
    "Fountain Good Food Ltd": "scotland", # M3 Fountainbridge
    "South Ikigai Ltd": "scotland",       # M5 Iki 2
    "Maki Bath St": "scotland",           # M6
    "Maki SJQ Ltd": "scotland",           # M7
    "Maki Newcastle Ltd": "scotland",     # M12 -- Scotland & Newcastle cluster
    "Maki Aberdeen Ltd": "scotland",      # M13
    "Maki METRO": "scotland",             # M15 -- Scotland & Newcastle cluster
    "AA Factory1 Limited": "scotland",    # best-fit (factory)
    "Maki Property Ltd": "scotland",      # best-fit (entity)
    "Renfield Good Food Ltd": "north",    # M8 -- North England & Midlands cluster
    "Maki Manchester LTD": "north",       # M9
    "Maki Leeds Ltd": "north",            # M10
    "Maki Leicester Ltd": "north",        # M11
    "Maki Meadowhall": "north",           # M14
    "Maki Nottingham Ltd": "north",       # M16
    "Maki Lakeside": "south",             # M17
    "Maki Soho": "south",                 # M18
    "Maki Shoreditch": "south",           # M19
    "Maki Southampton": "south",          # M20
    "Maki Birmingham Ltd": "south",       # M21 -- South England cluster
    "Maki Nori": "south",
    "Maki O2 Arena": "south",             # best-fit (franchise MAF3, London)
}
SUPPLIER_MATCH = [("Lynas","Lynas"),("Solstice","Solstice"),("Solstice","Sosltice"),
                  ("TWF","TWF"),("M&R","M&R")]
# Canonical supplier names + the needles that identify them (18/08/2026, for
# the Supplier Issues tab). Two jobs, one map:
#   1. Canonicalise the free-text 'Supplier?' ANSWER ('Jfc' / 'Breaks' /
#      'Blue Ocean' / 'LYNAS FOODSERVICE' all -> one canonical name), so the
#      supplier table doesn't split one supplier across spelling variants.
#   2. TEXT-MATCH attribution (Ross's direction, 18/08): when the form has no
#      usable 'Supplier?' answer, scan ALL the form's answers for a known
#      supplier name and bucket the issue there. Merged silently with answered
#      attribution in the UI, but every issue row carries an 'attribution'
#      field ('answered'|'text'|None) so the evidence trail stays auditable.
# Needles shorter than 4 chars only match as whole words (JFC inside a word
# would be noise). Needles in ANSWER_ONLY_NEEDLES are trusted only when they
# arrive as the answer to 'Supplier?' -- e.g. the common misspelling 'Breaks'
# means Brakes as an answer, but 'breaks' inside free text usually doesn't.
SUPPLIERS = [
    ("Lynas",         ["lynas"]),
    ("Harro",         ["harro"]),
    ("Brakes",        ["brakes","breaks"]),
    ("JFC",           ["jfc"]),
    ("JFE",           ["jfe"]),
    ("Blue Ocean",    ["blue ocean"]),
    ("Solstice",      ["solstice","sosltice"]),
    ("TWF",           ["twf","true world"]),
    ("Perfect Ted",   ["perfect ted"]),
    ("LWC",           ["lwc"]),
    ("Hodgson Fish",  ["hodgson"]),
    ("Dunster Farm",  ["dunster"]),
    ("FreshFV",       ["freshfv","fresh fv"]),
    ("Global Fruits", ["global fruit"]),
    ("Boba Box",      ["boba box"]),
    ("PCY",           ["pcy"]),
    ("AA Factory",    ["aa factory"]),
    # Added 26/08/2026 from the live Kobas supplier list (34 distinct names in
    # the Ops Deliveries report). Unmapped names are NOT dropped - they keep
    # supplier_canon=null and render under their verbatim Kobas name - but
    # mapping them here is what lets an emailed order and a filed issue meet
    # on the same row of the OTIF table. Deliberately NOT mapped: 'J&S' and
    # 'LTH'. Both are short enough to fire inside unrelated free text during
    # the text-attribution scan, and a wrong attribution is worse than none.
    ("Wellocks",      ["wellock"]),
    ("John Vallance", ["vallance"]),
    ("Dunns",         ["dunns"]),
    ("Campbells",     ["campbell"]),
    ("Tazaki",        ["tazaki"]),
    ("Shield Foods",  ["shield food"]),
    ("Kirkstall Brewery", ["kirkstall"]),
    ("ETeaket",       ["eteaket"]),
    ("Eddies Seafood", ["eddies seafood"]),
    ("Daata Meats",   ["daata"]),
    ("Rahmans",       ["rahman"]),
    ("F&J Food",      ["f&j food"]),
    ("Wismetta",      ["wismetta"]),
    ("Logistics RHQ", ["logistics - rhq"]),
]
ANSWER_ONLY_NEEDLES = {"breaks"}
# Answers that mean "no supplier named", never a supplier called N/A:
NONE_ANSWERS = {"n/a","na","none","-","nil","other supplier","other","unknown","?","tbc","x"}
def canon_supplier(text, from_answer=False):
    """Canonical supplier name for a string, or None. from_answer=True treats
    the string as the form's 'Supplier?' answer (none-tokens -> None, and the
    answer-only needles are allowed); otherwise it's a free-text scan."""
    if not text: return None
    t = text.strip().lower()
    if from_answer and t in NONE_ANSWERS: return None
    for name, needles in SUPPLIERS:
        for nd in needles:
            if not from_answer and nd in ANSWER_ONLY_NEEDLES: continue
            if len(nd) < 4:
                if re.search(r"(?<![a-z0-9])"+re.escape(nd)+r"(?![a-z0-9])", t): return name
            elif nd in t:
                return name
    return None
# Cross-reference join key (14/08/2026): site names differ across systems -
# GC LocationNameLabel vs Kobas 'Venue Placed' vs 'Site' are spelled
# differently for the same physical site ('Maki SJQ Ltd' vs 'Maki SJQ',
# 'Maki METRO' vs 'Maki Metro'). Hand-built from the live distinct-value
# lists, same house rule as SITE_TYPES: the site map lives in the builder,
# not inferred by fuzzy matching in the shell. key -> (GC name, Kobas name,
# display label). Sites seen on only one side are deliberately left out
# (see the standing gap emitted in main()) rather than guessed.
SITE_ALIASES = {
    "aa_factory1":   ("AA Factory1 Limited",   "AA Factory1 Limited",        "AA Factory1"),
    "aberdeen":      ("Maki Aberdeen Ltd",     "Maki Aberdeen",              "Maki Aberdeen"),
    "bath_st":       ("Maki Bath St",          "Maki Bath Street",           "Maki Bath Street"),
    "birmingham":    ("Maki Birmingham Ltd",   "Maki Birmingham",            "Maki Birmingham"),
    "lakeside":      ("Maki Lakeside",         "Maki Lakeside",              "Maki Lakeside"),
    "leeds":         ("Maki Leeds Ltd",        "Maki Leeds",                 "Maki Leeds"),
    "leicester":     ("Maki Leicester Ltd",    "Maki Leicester",             "Maki Leicester"),
    "metro":         ("Maki METRO",            "Maki Metro",                 "Maki Metro"),
    "manchester":    ("Maki Manchester LTD",   "Maki Manchester",            "Maki Manchester"),
    "newcastle":     ("Maki Newcastle Ltd",    "Maki Newcastle",             "Maki Newcastle"),
    "nori":          ("Maki Nori",             "Maki NORI",                  "Maki Nori"),
    "nottingham":    ("Maki Nottingham Ltd",   "Maki Nottingham",            "Maki Nottingham"),
    "sjq":           ("Maki SJQ Ltd",          "Maki SJQ",                   "Maki SJQ"),
    "shoreditch":    ("Maki Shoreditch",       "Maki Shoreditch",            "Maki Shoreditch"),
    "soho":          ("Maki Soho",             "Maki SOHO",                  "Maki Soho"),
    "southampton":   ("Maki Southampton",      "Maki Southampton",           "Maki Southampton"),
    "o2_arena":      ("Maki O2 Arena",         "Maki O2 Arena",              "Maki O2 Arena"),
    "renfield":      ("Renfield Good Food Ltd","Maki Renfield",              "Maki Renfield"),
    "south_ikigai":  ("South Ikigai Ltd",      "Ikigai Ramen South Bridge",  "South Ikigai"),
}
# GC-side sites with no confirmed Kobas match (as of 14/08/2026): Fountain
# Good Food Ltd, M1TOO Ltd, Maki Meadowhall, Maki Property Ltd. Kobas-side
# sites with no GC broth-check match: Maki 1/2 (Nicolson St), Maki
# Fountainbridge, Maki Leith, Maki Manchester NQ, Maki West End, Maki
# Yorkshire, and the two 'OLD: ...' rows. These are excluded from
# cross-referencing, not guessed at - see the gaps entry.
# Issue-nature keyword heuristic (14/08/2026): the only feed with a REAL
# category taxonomy is the 10-row Gmail 'Supplier Issues' feed. Everything
# from GetCompliant delivery/supplier forms is free text in the 'Issue?'
# task answer, so this buckets by keyword - labelled a heuristic everywhere
# it surfaces, never presented as ground truth.
ISSUE_KEYWORDS = [
    ("shortage", ["missing", "lack of", "short delivery", "shortage", "didn't receive",
                  "not received", "did not receive"]),
    ("damage_quality", ["damage", "damaged", "bad quality", "mould", "mold",
                        "black dots", "rotten", "spoiled", "off ", "quality"]),
    ("wrong_item", ["wrong", "substitut", "incorrect item", "wrong order"]),
    ("temperature", ["temperature", "frozen", "thawed", "warm delivery", "cold chain"]),
    ("invoice_credit", ["invoice", "credit", "overcharge", "charged"]),
]
def classify_issue(text):
    if not text: return None
    t = text.strip().lower()
    if t in ("n/a", "na", "none", "-", "nil"): return "no_issue_recorded"
    for cat, kws in ISSUE_KEYWORDS:
        for kw in kws:
            if kw in t: return cat
    return "other"
# Ross, 18 Aug 2026: the Training tab's analyst view counts ONLY mandatory
# compliance training. Confirmed set (safety & food core + region-specific
# licensing + internal mandatory), matched on trim(module_name) against the
# exact names observed live in Deep Flow Modules. Licensing region-fit is
# handled naturally by assignment: a Scottish site has no 'Licensing England
# & Wales' assignments, so its cell renders as no-data, never a penalty.
# HR/people modules (Sexual Harassment, Data Privacy, D&I, Disability
# Awareness, Anti-Modern Slavery) are deliberately NOT in this list.
#
# Ross, 03/09/2026: 'Mapal Run through' and 'Mapal Run through Management'
# come OUT. They are training in how to use Mapal itself, not a safety, food
# or licensing obligation - the only kind this view is meant to count. Their
# rows are still pulled and still appear under "All modules"; what changes is
# that nobody is counted non-compliant for them. Two of the eleven heatmap
# columns go with them.
MANDATORY_MODULES = [
    "COSHH: Working With Hazardous Substances - UK",
    "First Aid Awareness",
    "Health and Safety Level 2",
    "Food Safety Level 2",
    "Food Allergens",
    "Fire Safety Awareness",
    "Licensing Scotland",
    "Licensing England & Wales",
    "MRSOS Training Module",
]
EXPECTED_FEEDS = [
    "Flow Trainees","Flow Branches","Flow Modules","Flow Certificates",
    "Deep Flow Modules","Deep Flow Certificates",
    "GC Forms Overview","GC Central Module Tasks","GC Locations",
    "GC Deviations","GC Waste Registered",
    "Kobas Orders",
    "Factory Broth Readings",
]
def supplier_of(form):
    for sup, needle in SUPPLIER_MATCH:
        if needle.lower() in (form or "").lower(): return sup
    return "Unattributed"
# Ross, 27/08/2026, verbatim: "Tonkotsu should be between 8 and 9 after ice ...
# for chicken broth it should be between 5 and 6". The first real after-ice
# SPEC this system has ever had - every string in the factory block used to say
# no target band existed, because until now none did. Bounds are INCLUSIVE:
# 8.0 and 9.0 both pass.
#
# A product with no entry here is NOT graded and NOT flagged - it gets a named
# gap instead. Inventing a band for it would be exactly the fabrication the
# rest of this block refuses: 'Ikigai Chicken Broth' appears in the form and
# Ross did not give it a range, so it stays ungraded until he does.
FACTORY_BROTH_BANDS = {
    "Tonkotsu Broth": (8.0, 9.0),
    "Chicken Broth":  (5.0, 6.0),
}
def fb_grade(product, score):
    """'in' | 'low' | 'high' for a graded product, None when it has no band."""
    band = FACTORY_BROTH_BANDS.get(product or "")
    if band is None or score is None:
        return None
    lo, hi = band
    return "low" if score < lo else "high" if score > hi else "in"
#: A Brix reading this instrument can physically produce. Used ONLY to decide
#: how to read an ambiguous cell format - never to reject a reading.
FB_PLAUSIBLE_LO, FB_PLAUSIBLE_HI = 0.5, 30.0
def fb_num(v):
    """One refractometer reading as a float, or None if it is not a number.

    Readings arrive as the SHEET RENDERS them, so this has to read what the
    factory actually typed rather than what a strict float() will accept.
    Three real cases, all confirmed against the batch's own before-ice
    reading (28/08/2026) - every one of these was previously being mangled or
    dropped, and Ross's instruction was to ignore no reading:

      '8,7'    DECIMAL COMMA. Staff type it as often as a point. The old code
               stripped commas as thousands separators, turning 8.7 into 87 -
               which then read as a batch three times over spec. Four readings
               (8,7 / 8,0 / 8,0 / 5,2) were wrong this way, and they were the
               reason a 'suspect' rule existed at all.
      '8.4’'   TRAILING JUNK. A stray typographic apostrophe. float() raised,
               so the reading was dropped entirely and counted as non-numeric.
      '8.60%'  PERCENT-FORMATTED CELL. The cell really does hold 0.086 - the
               person typed 8.6 into a cell someone had formatted as a
               percentage. Dividing by 100 is right about the cell and wrong
               about the batch, so where /100 lands outside anything a
               refractometer can read AND the face value is plausible, the
               face value wins. '900.00%' still reads as 9 (900/100), which
               is what the sheet's derived tabs contain.

    Anything genuinely non-numeric is still None, counted, and never guessed
    at. A comma is only a decimal point when it is followed by one or two
    digits and nothing else - '1,234' stays 1234.
    """
    s = (v or "").strip()
    if not s:
        return None
    pct = s.endswith("%")
    if pct:
        s = s[:-1].strip()
    if re.fullmatch(r"-?\d+,\d{1,2}", s):
        s = s.replace(",", ".")
    else:
        s = s.replace(",", "")
    m = re.match(r"-?\d*\.?\d+", s)
    if not m:
        return None
    n = float(m.group(0))
    if not pct:
        return n
    scaled = n / 100
    if FB_PLAUSIBLE_LO <= scaled <= FB_PLAUSIBLE_HI:
        return scaled
    if FB_PLAUSIBLE_LO <= n <= FB_PLAUSIBLE_HI:
        return n
    return scaled
FB_MAX_LAG_DAYS = 7
def fb_parse_date(val):
    """A UK-format DD/MM/YYYY leading date, or None if it is not one."""
    try:
        d = datetime.datetime.strptime((val or "").strip()[:10], "%d/%m/%Y").date()
    except ValueError:
        return None
    return d if 2000 <= d.year <= 2100 else None
def fb_date(form_date, ts):
    """(iso_date, dated_from_timestamp) for one refractometer response.

    The form's own 'Date' field is the right field to PREFER: a batch made late
    one night is often submitted the next morning, and the operator dates it to
    the production day rather than the submission day.

    But it is hand-typed next to an automatic Timestamp, so it is trusted only
    when it PARSES and is PLAUSIBLE - and those are two different tests:
      * doesn't parse: '03/08/0025' for 03/08/2025.
      * parses and is wrong: batch 080925B is dated 08/09/2024 and was
        submitted 08/09/2025. Exactly a year out, perfectly well-formed, and
        contradicted by the batch number itself, which reads 08/09/25.
    A production date AFTER its own submission is impossible, and one more than
    FB_MAX_LAG_DAYS before it is a slip rather than a late entry: 3 readings of
    1,461 in the first full pull were 14, 30 and 365 days out, and every one of
    them was contradicted by its own batch number. Left alone, the 365-day one
    stretched the dashboard's whole date range back a year on its own.

    Either failure falls back to the Timestamp's date and is counted, so the
    row says where its date came from. A reading neither field can date is
    returned undated and disclosed, never dated by guess.
    """
    d_form, d_ts = fb_parse_date(form_date), fb_parse_date(ts)
    if d_form is not None:
        if d_ts is None:
            return d_form.isoformat(), False          # nothing to check it against
        if 0 <= (d_ts - d_form).days <= FB_MAX_LAG_DAYS:
            return d_form.isoformat(), False
    if d_ts is not None:
        return d_ts.isoformat(), True
    return None, False
def has_feed(cur, feed):
    cur.execute("SELECT 1 FROM etl_feed_rows WHERE feed=%s LIMIT 1", (feed,))
    return cur.fetchone() is not None
L = "(SELECT max(pull_date) FROM etl_feed_rows WHERE feed=%s)"
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None, help="pull date to stamp (default: max pull_date in warehouse)")
    a = ap.parse_args()
    # Phase 2 of the Neon exit. OPS_WAREHOUSE_SOURCE=archive reads the committed
    # pull archive through DuckDB instead of Postgres; every query below is
    # unchanged either way. Default is still Postgres, so this is inert until
    # something sets it - which is what makes the two runnable back to back and
    # diffable. See builders/archive_source.py.
    if os.environ.get("OPS_WAREHOUSE_SOURCE") == "archive":
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import archive_source
        # One directory, or several joined by os.pathsep in precedence order -
        # normally "warehouse_direct:warehouse_archive", because neither covers
        # the whole span on its own. archive_source resolves the overlap per
        # (pull_date, feed) rather than concatenating.
        adir = os.environ.get("OPS_ARCHIVE_DIR") or sys.exit(
            "OPS_ARCHIVE_DIR not set (warehouse_direct and/or warehouse_archive, "
            f"joined by {os.pathsep!r}, highest precedence first)")
        conn = archive_source.connect(
            adir, manifest=os.path.join(OUT_DIR, "feeds_manifest.json"))
        # The snapshot is published on a public Pages site and read by scheduled
        # reports that quote its provenance line. It named Neon regardless of
        # where the rows came from, which is a lie the moment this branch runs.
        # Basenames, not the paths: this line is published on a public site and
        # quoted in reports, and OPS_ARCHIVE_DIR is an absolute runner path.
        src_label = ("committed pull archive (%s) via bake_ops_command.py "
                     "(Pipe 9); feed health measured against the archive, "
                     "not the Sheets write"
                     % ", ".join(os.path.basename(d.rstrip("/")) or d
                                 for d in archive_source.archive_dirs(adir)))
    else:
        try:
            import psycopg2
        except ImportError:
            sys.exit("psycopg2 is required: pip install psycopg2-binary")
        dsn = os.environ.get("WAREHOUSE_DSN") or sys.exit("WAREHOUSE_DSN not set")
        conn = psycopg2.connect(dsn)
        src_label = ("Neon Postgres warehouse via bake_ops_command.py (Pipe 9); "
                     "feed health measured against Postgres, not the Sheets write")
    cur = conn.cursor()
    gaps, snap = [], {}
    cur.execute("SELECT max(pull_date)::text FROM etl_feed_rows")
    pull = a.date or (cur.fetchone() or [None])[0] or datetime.date.today().isoformat()
    # ---- feed health (Postgres truth) ----
    cur.execute(
        "SELECT feed, max(pull_date)::text, "
        " count(*) FILTER (WHERE pull_date=(SELECT max(p2.pull_date) FROM etl_feed_rows p2 WHERE p2.feed=e.feed)), "
        " (current_date - max(pull_date)) FROM etl_feed_rows e GROUP BY feed")
    fh, seen = [], set()
    for feed, latest, n, age in cur.fetchall():
        seen.add(feed); age = int(age or 0)
        verdict = "OK" if (n and age<=1) else "WATCH" if (n and age<=3) else "STALE" if n else "EMPTY"
        fh.append({"feed":feed,"latest_pull":latest,"rows":n,"age_days":age,"verdict":verdict})
    for feed in EXPECTED_FEEDS:
        if feed not in seen:
            fh.append({"feed":feed,"latest_pull":None,"rows":0,"age_days":None,"verdict":"MISSING"})
    order={"MISSING":0,"STALE":1,"EMPTY":2,"WATCH":3,"OK":4}
    fh.sort(key=lambda r:(order.get(r["verdict"],9),r["feed"]))
    snap["feed_health"]=fh
    # ---- training by site (Deep feed preferred; branch id -> name join) ----
    deep, base = "Deep Flow Modules", "Flow Modules"
    feed = deep if has_feed(cur, deep) else base
    cur.execute("SELECT count(*) FROM etl_feed_rows WHERE feed=%s AND pull_date="+L+
                " AND nullif(data->>'trainee_id','') IS NOT NULL", (feed, feed))
    linked = (cur.fetchone() or [0])[0] or 0
    training=[]
    if linked:
        cur.execute(
          "WITH m AS (SELECT data->>'trainee_id' tid, coalesce(data->>'module_status','') st "
          "  FROM etl_feed_rows WHERE feed=%s AND pull_date="+L+
          "  AND nullif(data->>'trainee_id','') IS NOT NULL), "
          "t AS (SELECT data->>'id' id, nullif(data->>'branch','') bid FROM etl_feed_rows "
          "  WHERE feed='Flow Trainees' AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='Flow Trainees')), "
          "b AS (SELECT data->>'id' id, nullif(data->>'name','') name FROM etl_feed_rows "
          "  WHERE feed='Flow Branches' AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='Flow Branches')) "
          "SELECT coalesce(b.name,'Branch '||t.bid,'(no branch)'), count(DISTINCT m.tid), count(*), "
          " count(*) FILTER (WHERE m.st='Complete'), "
          " count(*) FILTER (WHERE position('Overdue' in m.st)>0), "
          " count(*) FILTER (WHERE position('Not Yet Started' in m.st)>0) "
          "FROM m JOIN t ON t.id=m.tid LEFT JOIN b ON b.id=t.bid GROUP BY 1", (feed, feed))
        for site, ppl, mods, comp, ovd, ns in cur.fetchall():
            training.append({"site":site,"site_type":SITE_TYPES.get(site,"restaurant"),
              "people":ppl,"modules":mods,"complete":comp,
              "pct_complete":round(100.0*comp/mods,1) if mods else None,
              "overdue":ovd,"not_started":ns})
        training.sort(key=lambda r:(r["pct_complete"] if r["pct_complete"] is not None else 999))
    else:
        gaps.append(f"{feed} exposes no trainee_id, so training cannot be attributed to a site "
                    "(resolves once the namespaced 03:00 deep pull has landed)")
    # ---- outstanding training by person, for the per-site drill-down ----
    # Every module row that isn't Complete (Not Yet Started / In Progress,
    # each optionally +", Overdue"), with the person's name and due date, so
    # clicking a site on the Training tab can show who owes what and by when.
    # module_due_date is UK-format 'DD/MM/YYYY' (fixed length 10, checked live
    # 18/08/2026 -- unlike module_completed_date it never carries a time and
    # is either exactly 10 chars or absent, so no defensive length/slash check
    # is needed here). This is a current-state snapshot like training.sites
    # above (due dates are in the future, not an event that already
    # happened), so it is NOT sliced by the date-range filter client-side.
    outstanding=[]
    if linked:
        cur.execute(
          "WITH m AS (SELECT data->>'trainee_id' tid, data->>'module_name' mn, "
          "  data->>'module_status' st, nullif(data->>'module_due_date','') dd "
          "  FROM etl_feed_rows WHERE feed=%s AND pull_date="+L+
          "  AND nullif(data->>'trainee_id','') IS NOT NULL "
          "  AND data->>'module_status'<>'Complete'), "
          "t AS (SELECT data->>'id' id, nullif(data->>'forename','') fn, "
          "  nullif(data->>'surname','') sn, nullif(data->>'branch','') bid FROM etl_feed_rows "
          "  WHERE feed='Flow Trainees' AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='Flow Trainees')), "
          "b AS (SELECT data->>'id' id, nullif(data->>'name','') name FROM etl_feed_rows "
          "  WHERE feed='Flow Branches' AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='Flow Branches')) "
          "SELECT coalesce(b.name,'Branch '||t.bid,'(no branch)'), "
          " trim(coalesce(t.fn,'')||' '||coalesce(t.sn,'')), m.mn, m.st, "
          " CASE WHEN m.dd IS NOT NULL THEN substr(m.dd,7,4)||'-'||substr(m.dd,4,2)||'-'||substr(m.dd,1,2) END "
          "FROM m JOIN t ON t.id=m.tid LEFT JOIN b ON b.id=t.bid", (feed, feed))
        for site, person, module, status, due in cur.fetchall():
            outstanding.append({"site":site,"person":person or "(unnamed)","module":module,
              "status":status,"overdue":bool(status and "Overdue" in status),"due":due,
              "mand":(module or "").strip() in MANDATORY_MODULES})
        # 2101 rows, and many share a site and a due date - without person and
        # module the tie order is whatever the join happened to emit.
        outstanding.sort(key=lambda r:(r["site"], r["due"] is None, r["due"] or "",
                                       r["person"] or "", r["module"] or ""))
    # Completion EVENTS by day+site, so ranges filter on when modules were
    # actually completed, not on pull_date. module_completed_date is UK-format
    # 'DD/MM/YYYY HH:MM' (13/08/2026); parsed defensively, bad values skipped.
    completions=[]
    if linked:
        cur.execute(
          "WITH m AS (SELECT data->>'trainee_id' tid, nullif(data->>'module_completed_date','') cd, "
          "  trim(coalesce(data->>'module_name','')) mn "
          "  FROM etl_feed_rows WHERE feed=%s AND pull_date="+L+
          "  AND data->>'module_status'='Complete' "
          "  AND nullif(data->>'module_completed_date','') IS NOT NULL), "
          "t AS (SELECT data->>'id' id, nullif(data->>'branch','') bid FROM etl_feed_rows "
          "  WHERE feed='Flow Trainees' AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='Flow Trainees')), "
          "b AS (SELECT data->>'id' id, nullif(data->>'name','') name FROM etl_feed_rows "
          "  WHERE feed='Flow Branches' AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='Flow Branches')), "
          "p AS (SELECT coalesce(b.name,'Branch '||t.bid,'(no branch)') site, m.mn, "
          "  CASE WHEN length(m.cd)>=10 AND substr(m.cd,3,1)='/' AND substr(m.cd,6,1)='/' "
          "       THEN substr(m.cd,7,4)||'-'||substr(m.cd,4,2)||'-'||substr(m.cd,1,2) END d "
          "  FROM m JOIN t ON t.id=m.tid LEFT JOIN b ON b.id=t.bid) "
          "SELECT d, site, count(*), count(*) FILTER (WHERE mn=ANY(%s)) FROM p WHERE d IS NOT NULL "
          "GROUP BY 1,2 ORDER BY 1 DESC, 2 LIMIT 4000", (feed, feed, MANDATORY_MODULES))
        completions=[{"d":r[0],"site":r[1],"n":r[2],"nm":r[3]} for r in cur.fetchall()]
    # ---- mandatory compliance heatmap (site x module) ----
    # Ross, 18 Aug 2026: analyst view of MANDATORY compliance training only
    # (see MANDATORY_MODULES above). Two grains from the same join:
    #   cells -- per site x module {assigned, complete, overdue} for the
    #            heatmap (a site with assigned=0 for a module simply has no
    #            cell -- the shell renders a dash, never a penalty);
    #   sites -- per-site rollup incl. people_overdue = DISTINCT people with
    #            >=1 overdue mandatory module (the actionable number).
    # Current-state snapshot like training.sites -- NOT sliced by the
    # date-range filter client-side.
    mandatory={}
    if linked:
        mand_cells=[]
        cur.execute(
          "WITH m AS (SELECT data->>'trainee_id' tid, trim(coalesce(data->>'module_name','')) mn, "
          "  coalesce(data->>'module_status','') st "
          "  FROM etl_feed_rows WHERE feed=%s AND pull_date="+L+
          "  AND nullif(data->>'trainee_id','') IS NOT NULL "
          "  AND trim(coalesce(data->>'module_name','')) = ANY(%s)), "
          "t AS (SELECT data->>'id' id, nullif(data->>'branch','') bid FROM etl_feed_rows "
          "  WHERE feed='Flow Trainees' AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='Flow Trainees')), "
          "b AS (SELECT data->>'id' id, nullif(data->>'name','') name FROM etl_feed_rows "
          "  WHERE feed='Flow Branches' AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='Flow Branches')) "
          "SELECT coalesce(b.name,'Branch '||t.bid,'(no branch)'), m.mn, count(*), "
          " count(*) FILTER (WHERE m.st='Complete'), "
          " count(*) FILTER (WHERE position('Overdue' in m.st)>0) "
          "FROM m JOIN t ON t.id=m.tid LEFT JOIN b ON b.id=t.bid GROUP BY 1,2",
          (feed, feed, MANDATORY_MODULES))
        for site, mn, assigned, comp, ovd in cur.fetchall():
            mand_cells.append({"site":site,"module":mn,"assigned":assigned,
              "complete":comp,"overdue":ovd})
        mand_sites=[]
        cur.execute(
          "WITH m AS (SELECT data->>'trainee_id' tid, "
          "  coalesce(data->>'module_status','') st "
          "  FROM etl_feed_rows WHERE feed=%s AND pull_date="+L+
          "  AND nullif(data->>'trainee_id','') IS NOT NULL "
          "  AND trim(coalesce(data->>'module_name','')) = ANY(%s)), "
          "t AS (SELECT data->>'id' id, nullif(data->>'branch','') bid FROM etl_feed_rows "
          "  WHERE feed='Flow Trainees' AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='Flow Trainees')), "
          "b AS (SELECT data->>'id' id, nullif(data->>'name','') name FROM etl_feed_rows "
          "  WHERE feed='Flow Branches' AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='Flow Branches')) "
          "SELECT coalesce(b.name,'Branch '||t.bid,'(no branch)'), count(DISTINCT m.tid), "
          " count(*), count(*) FILTER (WHERE m.st='Complete'), "
          " count(DISTINCT m.tid) FILTER (WHERE position('Overdue' in m.st)>0) "
          "FROM m JOIN t ON t.id=m.tid LEFT JOIN b ON b.id=t.bid GROUP BY 1",
          (feed, feed, MANDATORY_MODULES))
        for site, ppl, assigned, comp, p_ovd in cur.fetchall():
            mand_sites.append({"site":site,"site_type":SITE_TYPES.get(site,"restaurant"),
              "people":ppl,"assigned":assigned,"complete":comp,
              "pct":round(100.0*comp/assigned,1) if assigned else None,
              "people_overdue":p_ovd})
        # The heatmap is indexed by site x module in the shell, so cell order does
        # not drive display - but an unsorted list still rewrites the committed
        # snapshot on every bake. It was the last of the eight non-deterministic
        # lists, and the only one that had no sort at all rather than a partial one.
        mand_cells.sort(key=lambda r:(r["site"] or "", r["module"] or ""))
        # ties on pct kept whatever order the GROUP BY produced
        mand_sites.sort(key=lambda r:(r["pct"] if r["pct"] is not None else 999,
                                      r["site"] or ""))
        seen_mods={c["module"] for c in mand_cells}
        mandatory={
          "modules":[mn for mn in MANDATORY_MODULES if mn in seen_mods],
          "cells":mand_cells,"sites":mand_sites,
          "basis":"mandatory compliance modules only ("+", ".join(MANDATORY_MODULES)+"); "
          "matched on trim(module_name) in Deep Flow Modules; assigned = module rows for "
          "people at the site, complete = module_status='Complete', people_overdue = "
          "distinct people with >=1 overdue mandatory module -- current state, not sliced "
          "by the date range above"}
    else:
        gaps.append("mandatory-compliance training block skipped: no per-trainee module rows "
                    "in this pull (resolves once the namespaced 03:00 deep pull has landed)")
    snap["training"]={"source_feed":feed,"sites":training,"completions":completions,
      "completions_basis":"count of modules with module_status='Complete' grouped by "
      "module_completed_date (the completion EVENT date) and site; capped at 4000 day-site rows; "
      "nm = the mandatory-compliance subset of n (see training.mandatory.basis)",
      "mandatory":mandatory,
      "outstanding":outstanding,
      "outstanding_basis":"every module row with module_status<>'Complete' (Not Yet Started / "
      "In Progress, each optionally +', Overdue'), joined to the trainee's name and site; "
      "due date is module_due_date -- current state, not sliced by the date range above"}
    # ---- site -> AM region map for the shell's Show filter ----
    # Single source of truth lives here per house rule (like SITE_TYPES); the
    # shell reads snap.site_regions and never hardcodes a site list. Any site
    # seen in training that isn't mapped is named in gaps, never guessed.
    # Gotcha found live 18/08/2026: at least one Flow branch name ('Maki O2
    # Arena') uses NON-BREAKING spaces (U+00A0), so both this check and the
    # shell's lookup normalise NBSP->space before matching.
    snap["site_regions"]=SITE_REGIONS
    def _norm_site(s): return (s or "").replace("\xa0"," ").strip()
    unmapped=sorted({r["site"] for r in training if _norm_site(r["site"]) not in SITE_REGIONS})
    if unmapped:
        gaps.append("sites with no AM region in SITE_REGIONS (they appear under the "
                    "All filter only until the builder map is updated): "+", ".join(unmapped))
    # ---- compliance ----
    forms=[]
    if has_feed(cur,"GC Forms Overview"):
        cur.execute(
          "SELECT coalesce(nullif(data->>'FolderName',''),'(no folder)'), "
          " coalesce(nullif(data->>'FormName',''),'(unnamed)'), "
          " coalesce((data->>'CompletedFormsCount')::int,0), coalesce((data->>'OngoingFormsCount')::int,0), "
          " coalesce((data->>'DeviationsCount')::int,0), coalesce((data->>'OpenDeviationsCount')::int,0) "
          "FROM etl_feed_rows WHERE feed='GC Forms Overview' AND pull_date="
          "(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='GC Forms Overview')")
        for folder,form,comp,ong,dev,opn in cur.fetchall():
            tot=comp+ong
            forms.append({"folder":folder,"form":form,"completed":comp,"ongoing":ong,
              "pct_complete":round(100.0*comp/tot,1) if tot else None,
              "deviations":dev,"open":opn})
    else: gaps.append("GC Forms Overview absent from warehouse")
    areas=[]
    if has_feed(cur,"GC Central Module Tasks"):
        cur.execute(
          "SELECT coalesce(nullif(data->>'AreaName',''),'(no area)'), count(*), "
          " count(*) FILTER (WHERE lower(coalesce(data->>'IsDeviationOverdue','')) IN ('true','1','yes')), "
          " count(*) FILTER (WHERE lower(coalesce(data->>'IsPaused','')) IN ('true','1','yes')), "
          " count(DISTINCT data->>'ProcedureName') "
          "FROM etl_feed_rows WHERE feed='GC Central Module Tasks' AND pull_date="
          "(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='GC Central Module Tasks') "
          "GROUP BY 1 ORDER BY 3 DESC, 2 DESC, 1")
        areas=[{"area":r[0],"tasks":r[1],"overdue":r[2],"paused":r[3],"procedures":r[4]} for r in cur.fetchall()]
    # Form-answer EVENTS by day (deduped by AnswerID across overlapping pulls)
    # - lets the shell's date range slice by when forms were actually answered.
    answers_by_day=[]
    if has_feed(cur,"GC Form Task Answers"):
        cur.execute(
          "WITH a AS (SELECT DISTINCT ON (data->>'AnswerID') "
          "   left(data->>'AnsweredDateTime',10) d, "
          "   lower(coalesce(data->>'IsDeviation','')) dev "
          " FROM etl_feed_rows WHERE feed='GC Form Task Answers' "
          " ORDER BY data->>'AnswerID', pull_date DESC) "
          "SELECT d, count(*), count(*) FILTER (WHERE dev IN ('true','1','yes')) "
          "FROM a WHERE d IS NOT NULL GROUP BY 1 ORDER BY 1")
        answers_by_day=[{"d":r[0],"answers":r[1],"deviations":r[2]} for r in cur.fetchall()]
    snap["compliance"]={"forms":forms,"areas":areas,"answers_by_day":answers_by_day,
      "answers_basis":"form task answers per AnsweredDateTime day, deduped by AnswerID "
      "across pulls; history accumulates from 13/08/2026 (first landing of the answers feed)"}
    # ---- suppliers (delivery/supplier issue forms; NOT a measured OTIF) ----
    sups=[]
    for f in forms:
        n=f["form"]
        if "eliver" in n or "upplier" in n:
            sups.append({"supplier":supplier_of(n),"form":n,"completed":f["completed"],
                         "raised":f["deviations"],"open":f["open"]})
    agg={}
    for s_ in sups:
        a_=agg.setdefault(s_["supplier"],{"forms":0,"completed":0,"raised":0,"open":0})
        a_["forms"]+=1
        for k in ("completed","raised","open"): a_[k]+=s_[k]
    # -- per-issue supplier attribution from the answers feed ----------------
    # 'GC Form Task Answers' landed 13/08/2026 (run #35). Each pull covers a
    # rolling ~7-day window, so issues are deduped by FormId ACROSS pull_dates
    # (latest row wins) and history accumulates day by day. The issue's own
    # event date is min(AnsweredDateTime) per form - the shell's date-range
    # filter slices on THAT, never on pull_date.
    issues=[]; answered=[]; ans_src=None
    if has_feed(cur, "GC Form Task Answers"):
        ans_src="GC Form Task Answers"
        cur.execute(
          "WITH a AS (SELECT DISTINCT ON (data->>'FormId', data->>'TaskID') "
          "   data->>'FormId' fid, coalesce(data->>'FormTemplateName',data->>'FormName','') tpl, "
          "   coalesce(data->>'TaskName','') task, nullif(data->>'Answer','') ans, "
          "   nullif(data->>'LocationNameLabel','') site, "
          "   left(data->>'AnsweredDateTime',10) d, "
          "   lower(coalesce(data->>'IsOpenDeviation','')) opn "
          " FROM etl_feed_rows WHERE feed='GC Form Task Answers' "
          " ORDER BY data->>'FormId', data->>'TaskID', pull_date DESC) "
          "SELECT fid, max(tpl), min(d), "
          " max(CASE WHEN position('upplier' in task)>0 THEN ans END), "
          " max(site), bool_or(opn IN ('true','1','yes')), "
          " max(CASE WHEN task='Issue?' THEN ans END), "
          " string_agg(ans,' ') "
          "FROM a WHERE position('eliver' in tpl)>0 OR position('upplier' in tpl)>0 "
          "GROUP BY fid ORDER BY 3 DESC, fid LIMIT 2000")
        for fid,tpl,d,ans,site,opn,issue_text,alltext in cur.fetchall():
            # Attribution ladder (18/08/2026, Ross's direction):
            #   1. the form's own 'Supplier?' answer, canonicalised
            #   2. a non-empty answer that isn't a known supplier or a
            #      none-token is kept verbatim (title-cased) - a real answer
            #      naming a supplier this map doesn't know yet
            #   3. no usable answer -> text-search ALL the form's answers for
            #      a known supplier name (attribution='text')
            #   4. still nothing -> null, never a fake name
            sup=None; attribution=None
            c=canon_supplier(ans, from_answer=True)
            if c:
                sup,attribution=c,"answered"
            else:
                t=(ans or "").strip().lower()
                if t and t not in NONE_ANSWERS:
                    sup,attribution=ans.strip().title()[:40],"answered"
                else:
                    m=canon_supplier(alltext) or canon_supplier(issue_text)
                    if m: sup,attribution=m,"text"
            issues.append({"d":d,"supplier":sup,"attribution":attribution,
              "site":site,"form":tpl,"open":bool(opn),
              "issue_text":issue_text,"category":classify_issue(issue_text)})
        agg2={}
        for i_ in issues:
            k=i_["supplier"] or "(no supplier answer)"
            agg2[k]=agg2.get(k,0)+1
        answered=[{"supplier":k,"answers":v} for k,v in
                  sorted(agg2.items(), key=lambda kv:-kv[1])]
    else:
        gaps.append("'GC Form Task Answers' absent from the warehouse - per-issue "
            "supplier attribution and answer-date filtering unavailable until the "
            "daily export lands it")
    snap["suppliers"]={"answered_source":ans_src,"answered":answered,"issues":issues,
      "issues_basis":"one row per delivery/supplier issue form submission in GC Form Task "
      "Answers, deduped by FormId across pulls; d = min(AnsweredDateTime); supplier = the "
      "form's own 'Supplier?' answer canonicalised to a standard supplier name; when the "
      "form names no supplier, a text search of all its answers for known supplier names "
      "attributes it instead (attribution='text', a heuristic); null when neither finds "
      "one, never a fake name",
      "note":"GetCompliant delivery/supplier issue forms - the only supplier signal the "
      "estate produces, and self-reported rather than a measured OTIF. This used to read "
      "'the Mapal supplier feeds fail at fetch', which framed it as a credentials problem "
      "waiting to be fixed. It was not: those feeds were Mapal Easilys, the business does "
      "not use Easilys (Ross, 27/08/2026), and they have been removed from the pull. There "
      "is no delivered-vs-ordered source behind them to unlock.","totals":[{"supplier":k,**v} for k,v in
      sorted(agg.items(),key=lambda kv:(-kv[1]["open"], kv[0] or ""))],"forms":sorted(sups,key=lambda r:(-r["open"], r["form"] or ""))}
    cat_agg={}
    for i_ in issues:
        c=i_.get("category") or "uncategorized"
        cat_agg[c]=cat_agg.get(c,0)+1
    snap["suppliers"]["issue_categories"]=[{"category":k,"n":v} for k,v in
      sorted(cat_agg.items(),key=lambda kv:-kv[1])]
    snap["suppliers"]["issue_categories_basis"]=("keyword heuristic over each issue's free-"
      "text 'Issue?' answer, not an official taxonomy - only the 10-row Gmail 'Supplier "
      "Issues' feed has a real Issue Category field; buckets: shortage, damage_quality, "
      "wrong_item, temperature, invoice_credit, no_issue_recorded, other")
    # ---- quality / broth checks (GC Scheduled Task Answers; event-dated) ----
    # Ross, verbatim: a top-level view where broth quality check scores can be
    # seen "broken down by site (branch) at a glance". These do NOT live in
    # Flow Appraisals (checked: 0 of 672 appraisal rows mention broth) - they
    # are numeric density readings in GetCompliant's scheduled tasks.
    BROTH_TASKS={"Chicken Broth Check":"chicken","Tonkotsu Broth Check":"tonkotsu"}
    # Ross, 27/08/2026: "Chicken broth should be within 1 from 6 and the tonkotsu
    # between 6-7" - the SITE spec, and a separate thing from the factory's
    # after-ice band. Chicken's is stated as a tolerance (6 ± 1) rather than a
    # pair of bounds, so it is written out as 5-7 here and rendered as the
    # bounds it is. Inclusive, like the factory's.
    #
    # These do NOT transfer either way. The factory reads the batch after ice
    # (tonkotsu 8-9); these read broth as served (tonkotsu 6-7). Same
    # instrument, different point in the broth's life, and the numbers say so.
    SITE_BROTH_BANDS={"chicken":(5.0,7.0),"tonkotsu":(6.0,7.0)}
    broth_cells=[]; broth_deviations=[]
    site_grades={"in":0,"low":0,"high":0}
    if has_feed(cur,"GC Scheduled Task Answers"):
        cur.execute(
          "WITH a AS (SELECT DISTINCT ON (data->>'AnswerID') "
          "   data->>'TaskName' task, nullif(data->>'LocationNameLabel','') site, "
          "   left(data->>'AnsweredDateTime',10) d, nullif(data->>'Answer','') ans, "
          "   lower(coalesce(data->>'IsOpenDeviation','')) opn, "
          "   lower(coalesce(data->>'IsDeviation','')) dev "
          " FROM etl_feed_rows WHERE feed='GC Scheduled Task Answers' "
          "  AND data->>'TaskName' IN ('Chicken Broth Check','Tonkotsu Broth Check') "
          " ORDER BY data->>'AnswerID', pull_date DESC) "
          "SELECT task, site, d, ans, opn, dev FROM a WHERE d IS NOT NULL AND site IS NOT NULL")
        cell_agg={}
        for task,site,d,ans,opn,dev in cur.fetchall():
            kind=BROTH_TASKS.get(task)
            if not kind: continue
            val=None
            if ans is not None:
                try: val=float(ans)
                except ValueError: val=None
            key=(site,kind,d)
            c=cell_agg.setdefault(key,{"vals":[],"missed":0,"n":0})
            c["n"]+=1
            if val is not None: c["vals"].append(val)
            else: c["missed"]+=1
            if dev in ("true","1","yes"):
                broth_deviations.append({"site":site,"kind":kind,"d":d,"value":val,
                  "open":opn in ("true","1","yes")})
        for (site,kind,d),c in cell_agg.items():
            val=round(sum(c["vals"])/len(c["vals"]),2) if c["vals"] else None
            band=SITE_BROTH_BANDS.get(kind)
            grade=None; miss=None
            if val is not None and band:
                lo,hi=band
                if val<lo:   grade,miss="low",round(lo-val,2)
                elif val>hi: grade,miss="high",round(val-hi,2)
                else:        grade,miss="in",0.0
            broth_cells.append({"site":site,"kind":kind,"d":d,
              "value":val,"checks":c["n"],"checks_missed":c["missed"],
              "band":list(band) if band else None,"grade":grade,"miss":miss})
            if grade: site_grades[grade]+=1
        broth_deviations.sort(key=lambda r:r["d"],reverse=True)
    else:
        gaps.append("'GC Scheduled Task Answers' absent from the warehouse - broth quality "
            "checks (Chicken/Tonkotsu Broth Check) unavailable")
    if broth_cells:
        sg=site_grades; sg_tot=sg["in"]+sg["low"]+sg["high"]
        if sg_tot:
            gaps.append("Site broth readings are graded against Ross's SITE band (chicken "
                "6+/-1 i.e. 5-7, tonkotsu 6-7), which is NOT the factory's after-ice band "
                "(tonkotsu 8-9, chicken 5-6): same instrument, different point in the broth's "
                "life. "+str(sg["in"])+" of "+str(sg_tot)+" site readings are in band, "
                +str(sg["low"])+" below and "+str(sg["high"])+" above")
        ungraded_kinds=sorted({c["kind"] for c in broth_cells
                               if c["value"] is not None and not c.get("grade")})
        if ungraded_kinds:
            gaps.append("Site broth readings for "+", ".join(repr(k) for k in ungraded_kinds)
                +" have no band and are not graded - shown uncoloured rather than guessed at")
    snap["quality"]={"broth":{"cells":broth_cells,"deviations":broth_deviations[:200],
      "tasks":BROTH_TASKS,
      "bands":{k:list(v) for k,v in SITE_BROTH_BANDS.items()},"grades":site_grades,
      "basis":"one cell per site + check-type + day from GC Scheduled Task Answers, "
      "deduped by AnswerID across pulls, averaged if >1 reading landed that day; "
      "'checks_missed' counts non-numeric answers (e.g. 'Not registered on time') "
      "separately from checks_missed==checks meaning value is null (no numeric reading "
      "that day); event-dated on AnsweredDateTime, never pull_date"}}
    # ---- factory broth score (Factory Broth Readings; the refractometer form) ----
    # Ross, 27/08/2026: a factory-level broth score on this page, by batch,
    # scored on the AFTER-ICE reading.
    #
    # A DIFFERENT MEASUREMENT FROM THE BLOCK ABOVE, NOT MORE OF IT. Those cells
    # are per-SITE GetCompliant checks of broth as it is served; these are the
    # factory's own refractometer readings of the batch it produced, one form
    # submission per batch, taken before and after ice is added. Different
    # instrument, different moment, different scale - so they are separate
    # blocks, never averaged into one another and never plotted on one axis.
    #
    # BEFORE-ICE IS CARRIED BUT IS NOT THE SCORE. Ross was explicit: the score
    # is the after-ice reading. Before-ice rides along because it is what the
    # dilution is measured against and the pair is only meaningful together.
    #
    # NEWEST PULL ONLY. The feed is a whole-sheet copy every day (see
    # factory_broth.py in the ETL repo), so one pull is the complete history to
    # date - dedup across pulls would need a key the form does not have, since
    # two submissions can share a Timestamp to the second (30/07/2025 21:17:35
    # covers batches 3007A, 3007B and 3007C).
    FB_FEED = "Factory Broth Readings"
    # 2,000, not 500 (27/08/2026). The first real pull landed 1,461 scored
    # readings - thirteen months of production - and a 500 cap truncated the
    # dashboard to the most recent five months on its first day. The card
    # disclosed the truncation honestly, but a page built for comparing this
    # month's broth against last year's should not have to. 1,461 readings cost
    # ~220KB in the snapshot and the form adds ~3 a day, so this holds the whole
    # history plus a couple of years of it; the truncation notice stays for the
    # day that stops being true.
    FB_CAP = 2000
    fb_readings=[]; fb_total=0; fb_pull=None; fb_pct=0; fb_comma=0; fb_ts_dated=0
    fb_median=None; fb_suspect=0
    fb_grades={"in":0,"low":0,"high":0,"ungraded":0,"out_suspect":0}
    fb_excl={"no_after_ice":0,"undated":0,"non_numeric":0}
    if has_feed(cur,FB_FEED):
        cur.execute("SELECT max(pull_date)::text FROM etl_feed_rows WHERE feed=%s",(FB_FEED,))
        fb_pull=(cur.fetchone() or [None])[0]
        cur.execute(
          "SELECT data->>'Timestamp', data->>'Date', data->>'Batch Number', "
          " data->>'Product Name', data->>'Reading Before Adding Ice', "
          " data->>'Reading After Adding Ice' "
          "FROM etl_feed_rows WHERE feed=%s AND pull_date="+L, (FB_FEED,FB_FEED))
        for ts,dt,batch,product,before,after in cur.fetchall():
            fb_total+=1
            raw=(after or "").strip()
            if not raw:
                # Every response before 13/08/2025 predates the two ice
                # questions on the form. No after-ice reading means no score -
                # counted and disclosed, never scored as a zero.
                fb_excl["no_after_ice"]+=1; continue
            d,from_ts=fb_date(dt,ts)
            if d is None:
                fb_excl["undated"]+=1; continue
            val=fb_num(raw)
            if val is None:
                fb_excl["non_numeric"]+=1; continue
            if from_ts: fb_ts_dated+=1
            if raw.endswith("%"): fb_pct+=1
            if re.fullmatch(r"-?\d+,\d{1,2}", raw.rstrip("%").strip()): fb_comma+=1
            prod=(product or "").strip() or None
            score=round(val,2)
            fb_readings.append({"d":d,"ts":ts,
              "batch":(batch or "").strip() or None,
              "product":prod,
              "score":score,"before":fb_num(before),
              "band":list(FACTORY_BROTH_BANDS[prod]) if prod in FACTORY_BROTH_BANDS else None,
              "grade":fb_grade(prod,score),
              "date_source":"timestamp" if from_ts else "form"})
        # The same batch and product read twice in one day is real - it happens
        # (210825B, 21/08/2025, 7 then 9). Both rows stay and both are marked,
        # so the reader sees two readings rather than a duplicated row, and
        # nothing is quietly averaged away.
        seen={}
        for r in fb_readings:
            k=(r["batch"],r["product"],r["d"]); seen[k]=seen.get(k,0)+1
        for r in fb_readings:
            r["repeat"]=seen[(r["batch"],r["product"],r["d"])]>1
        # ---- implausible readings, flagged and kept ----------------------
        # This used to fire on six readings - 87.0, 80.0, 80.0, 52.0, 0.09 and
        # one dropped outright - which were read on 27/08/2026 as factory
        # keying slips and reported to Ross as such. They were not. Every one
        # was a reading this parser was mangling: four decimal commas, one
        # percent-formatted cell and one stray apostrophe (see fb_num). The
        # sheet was right and the code was wrong, and the check that was meant
        # to catch bad data was instead reporting the bug that created it.
        #
        # The rule stays, because a genuine lost decimal point is a real thing
        # that will happen and the damage is real: the card's colour scale runs
        # min-to-max, so a single 87 pushes every genuine 4-to-12 reading into
        # the bottom seventh of the scale and the whole column shades the same.
        # It should now fire on nothing, and if it fires again the first
        # question is whether fb_num has met a format it does not know yet.
        #
        # Anything it does catch is FLAGGED, not dropped and not repaired.
        # Dropping loses a real record of what was entered, dividing by ten is
        # inventing data, and the row is the only thing that will make anyone
        # fix the sheet. This band is derived from the data (a third of the
        # median to three times it) and is NOT the spec band. Those are two
        # different things and must stay that way: FACTORY_BROTH_BANDS says
        # whether a batch met spec, this says whether the number was typed
        # correctly - collapsing them would put typos into the out-of-spec
        # count and send someone to the factory over them.
        fb_median=None
        vals=sorted(r["score"] for r in fb_readings)
        if vals:
            n=len(vals)
            fb_median=vals[n//2] if n%2 else round((vals[n//2-1]+vals[n//2])/2,2)
        fb_suspect=0
        for r in fb_readings:
            r["suspect"]=bool(fb_median and (r["score"]>3*fb_median
                                             or r["score"]<fb_median/3))
            if r["suspect"]: fb_suspect+=1
        fb_readings.sort(key=lambda r:(r["d"],r["ts"] or ""),reverse=True)
        for r in fb_readings:
            g=r["grade"]
            if g is None:
                fb_grades["ungraded"]+=1
            else:
                fb_grades[g]+=1
                if g!="in" and r["suspect"]: fb_grades["out_suspect"]+=1
        ungraded=sorted({r["product"] or "(no product named)"
                         for r in fb_readings if r["grade"] is None})
        if ungraded:
            gaps.append(str(fb_grades["ungraded"])+" refractometer reading(s) are NOT "
                "graded because their product has no after-ice band: "
                +", ".join(repr(x) for x in ungraded)+". Shown and counted, never "
                "coloured pass or fail - a band has to be given, not guessed")
        if fb_suspect:
            gaps.append(str(fb_suspect)+" refractometer reading(s) are outside a "
                "third to three times the median of "+str(fb_median)+" - a missed "
                "decimal point ('87' for 8.7) or a percent-formatted cell. They are "
                "kept and flagged, never repaired or dropped. They are graded against "
                "the spec band like any other reading, so a mis-key reads as out of "
                "spec - the 'out_suspect' count says how many of the out-of-band "
                "readings are these: fix them at source and both numbers drop")
        gaps.append("The factory broth score carries no factory: the refractometer "
            "form has no site field, so readings cannot be split between the Glasgow, "
            "Edinburgh and Shoreditch factories - an out-of-spec batch cannot be traced "
            "to the line that made it")
    else:
        gaps.append("'"+FB_FEED+"' absent from the warehouse - the factory broth "
            "score (refractometer readings by batch) is unavailable until the daily "
            "export lands it")
    if fb_excl["no_after_ice"]:
        gaps.append(str(fb_excl["no_after_ice"])+" refractometer response(s) carry no "
            "after-ice reading (the form gained that question on 13/08/2025) and are "
            "excluded from the factory broth score rather than scored as zero")
    if fb_ts_dated:
        gaps.append(str(fb_ts_dated)+" refractometer reading(s) are dated from the "
            "submission timestamp because the form's own hand-typed Date field either "
            "did not parse ('03/08/0025') or contradicted that timestamp - dated after "
            "its own submission, or more than "+str(FB_MAX_LAG_DAYS)+" days before it - "
            "fix at source when possible")
    if fb_pct:
        gaps.append(str(fb_pct)+" after-ice reading(s) arrived percent-formatted and "
            "were converted: '900.00%' is 9, and '8.60%' is a cell holding 0.086 "
            "because someone typed 8.6 into a cell already formatted as a percentage - "
            "read as 8.6, which is what its 11.4 before-ice reading says it was. Worth "
            "clearing the percent formatting on that column at source")
    if fb_comma:
        gaps.append(str(fb_comma)+" reading(s) were typed with a DECIMAL COMMA ('8,7' "
            "for 8.7) and are read as such. Until 28/08/2026 the comma was stripped as "
            "a thousands separator, so these read as 87, 80, 80 and 52 and were "
            "reported as factory keying slips - they were this builder's bug, not the "
            "factory's, and the sheet needs no correction")
    snap["quality"]["factory"]={
      "readings":fb_readings[:FB_CAP],"scored":len(fb_readings),
      "median":fb_median,"suspect":fb_suspect,
      "bands":{k:list(v) for k,v in FACTORY_BROTH_BANDS.items()},"grades":fb_grades,
      "responses":fb_total,"truncated":len(fb_readings)>FB_CAP,
      "excluded":fb_excl,"source_feed":FB_FEED,"pull_date":fb_pull,
      "formats":{"percent":fb_pct,"decimal_comma":fb_comma},
      "basis":"one row per refractometer form submission at the factory, from the "
      "newest pull of '"+FB_FEED+"' (a whole-sheet copy, so one pull is the full "
      "history); score = the reading taken AFTER adding ice, Ross's definition, with "
      "the before-ice reading carried alongside for context; event-dated on the form's "
      "own Date field, falling back to the submission timestamp when that does not "
      "parse OR contradicts it (a date after its own submission, or more than "
      +str(FB_MAX_LAG_DAYS)+" days before it, is a typo), never on pull_date; responses with no after-ice reading are excluded and "
      "counted in 'excluded', never scored as zero; 'repeat' marks a batch and product "
      "read more than once on the same day - both readings are kept, neither averaged; "
      "'grade' is the reading against its product's after-ice SPEC BAND (Ross, 27/08/2026: "
      "tonkotsu 8-9, chicken 5-6, bounds inclusive) - 'in', 'low', 'high', or null for a "
      "product with no band, which is never graded or coloured; 'suspect' is a SEPARATE, "
      "much cruder test for keying slips (outside a third to three times the median, e.g. "
      "87 for 8.7), kept apart from the band so a typo is not read as a batch that missed "
      "spec - 'grades.out_suspect' counts the overlap"}
    # ---- scheduled task completion rate ON TIME by site (GC Scheduled Task Answers) ----
    # Ross, 15 Aug: the Task Completion page was reading GC Form Task Answers
    # (Closed/Open FORM state - a current-state backlog snapshot). Ross asked
    # for the SCHEDULED task on-time completion rate instead - a different
    # feed, a different question ("did the recurring checklist get done by
    # its deadline"), and it turns out to be naturally event-dated rather
    # than a snapshot.
    #
    # GC Scheduled Task Answers carries every recurring checklist item
    # (cleaning, prep, temperature, broth checks, etc: 40+ distinct TaskName
    # values, ~36k rows per pull across 23 sites) with a genuine
    # DueDateTime and a system-computed IsSystemOverdue flag. When a task
    # is completed before its DueDateTime, IsSystemOverdue=false and Answer
    # carries the real response. When nobody completes it in time,
    # GetCompliant auto-closes the row at the deadline with
    # Answer='Not registered on time' and IsSystemOverdue=true - checked
    # live: 100% correlation between IsSystemOverdue=true and that exact
    # Answer text, across every row in the latest pull.
    #
    # Cross-pull dedup by AnswerID (the pattern used everywhere else in this
    # builder) does NOT work here: the auto-closed "missed" rows carry a
    # BLANK AnswerID (verified live - all 1,463 of them in one pull
    # collapsed to a single DISTINCT ON row, silently discarding the rest).
    # TaskID+DueDateTime isn't a safe substitute either - the same task can
    # recur more than once a day sharing an identical nominal due timestamp
    # (checked live: 36,457 rows but only 2,625 distinct TaskID+DueDateTime
    # pairs in one pull). Rather than invent a fragile synthetic key, this
    # block reads the MOST RECENT PULL ONLY. Each pull already carries a
    # trailing ~7-9 day window on its own (verified live), so this still
    # gives a meaningful multi-day picture and refreshes cleanly every day
    # Pipe 9 runs - it just doesn't accumulate a longer history the way the
    # AnswerID-keyed feeds do.
    TASK_DRILLDOWN_CAP=300
    task_cells=[]; task_drilldown={}
    if has_feed(cur,"GC Scheduled Task Answers"):
        cur.execute(
          "SELECT nullif(data->>'LocationNameLabel','') site, "
          "  data->>'TaskName' task, left(data->>'DueDateTime',10) d, "
          "  data->>'DueDateTime' due, data->>'AnsweredDateTime' answered, "
          "  nullif(data->>'Answer','') ans, "
          "  lower(coalesce(data->>'IsSystemOverdue','')) overdue, "
          "  lower(coalesce(data->>'IsDeleted','')) del "
          "FROM etl_feed_rows WHERE feed='GC Scheduled Task Answers' "
          "  AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows "
          "    WHERE feed='GC Scheduled Task Answers')")
        rows=cur.fetchall()
        cell_agg={}; by_site={}
        for site,task,d,due,answered,ans,overdue,del_ in rows:
            if site is None or d is None: continue
            if del_ in ("true","1","yes"): continue
            late=overdue in ("true","1","yes")
            key=(site,d)
            c=cell_agg.setdefault(key,{"on_time":0,"missed":0})
            if late: c["missed"]+=1
            else: c["on_time"]+=1
            by_site.setdefault(site,[]).append({"task":task,"due":due,
              "answered":answered,"answer":ans,"late":late,"d":d})
        for (site,d),c in sorted(cell_agg.items()):
            task_cells.append({"site":site,"d":d,"on_time":c["on_time"],
              "missed":c["missed"]})
        for site,items in by_site.items():
            items.sort(key=lambda r:(r["due"] or "", r["task"] or "",
                                     r["answered"] or ""), reverse=True)
            task_drilldown[site]={"tasks":items[:TASK_DRILLDOWN_CAP],"total":len(items),
              "truncated":len(items)>TASK_DRILLDOWN_CAP}
    else:
        gaps.append("'GC Scheduled Task Answers' absent from the warehouse - scheduled "
            "task on-time completion by site unavailable")
    snap["tasks"]={"cells":task_cells,"drilldown":task_drilldown,
      "basis":"per scheduled-task instance from GC Scheduled Task Answers, most recent "
      "pull only (cross-pull AnswerID dedup isn't reliable here - GetCompliant's "
      "auto-generated 'missed' placeholder rows carry no AnswerID; see builder comments); "
      "a task counts ON TIME when IsSystemOverdue=false (answered before its "
      "DueDateTime) and MISSED when IsSystemOverdue=true (GetCompliant auto-closed it at "
      "the deadline with Answer='Not registered on time'); event-dated on DueDateTime - "
      "the scheduled day, not pull_date - so the date-range filter slices both the "
      "per-site bars/table and the drill-down; deleted rows excluded; drill-down capped "
      f"at {TASK_DRILLDOWN_CAP} rows per site, most recent due date first (see "
      "'total'/'truncated' per site for anything past the cap)"}
    # ---- supply / projected spend this week, by site + supplier ----
    # Ross, 17 Aug: replace the "orders outstanding" aging/backlog framing
    # with a forward-looking view - what do we expect to SPEND this week,
    # broken down by site and supplier. "This week" = the Mon-Sun week
    # containing today (Postgres current_date), matched against each order's
    # own delivery date. Site+supplier is a genuinely new cut: the old aging
    # block only ever grouped by supplier (site was fetched but unused).
    #
    # SOURCE CHANGE (26/08/2026). The primary source is now the 'Kobas Order
    # Emails' feed - a daily IMAP parse of the confirmation emails Kobas sends
    # to ross@makiramen.com. It replaces the 'Kobas Pending Orders' route,
    # which logged in to Kobas headlessly and committed a JSON file into the
    # ETL repo for this workflow to check out. That route never once completed
    # in Actions; the checkout step and its ETL_REPO_TOKEN are gone, and this
    # builder no longer reads any checked-out etl-data/ directory. The email
    # feed arrives in the warehouse like every other feed.
    #
    # WHAT THE EMAIL SOURCE CANNOT DO, STATED PLAINLY (26/08/2026):
    #  * NO DELIVERED/PENDING SPLIT. Confirmation emails record an order being
    #    placed and carry no status. The split that the pending-orders route
    #    supported is REMOVED rather than faked - week_totals has no
    #    delivered/pending keys on this source and the site boxes carry no
    #    split bar.
    #  * PARTIAL SUPPLIER COVERAGE. Kobas only emails a confirmation for
    #    suppliers configured to receive their orders by email. On discovery
    #    that was 6 of 31 estate suppliers (LWC depots, Brakes, Perfect Ted);
    #    Lynas, HARRO, JFC, TRUE WORLD FOODS, Solstice and AA Factory transmit
    #    another way and produce nothing, which is ~80% of estate spend. Ross
    #    is switching the rest on in Kobas, so coverage grows by itself.
    #    Nothing here filters by supplier - a new supplier appears the day its
    #    first email lands. The shortfall is measured below against the weekly
    #    outstanding-orders report and emitted as a named gap listing exactly
    #    which suppliers are still missing, so it self-clears as Ross works
    #    through them.
    #  * CANCELLATIONS ARE INVISIBLE. An order cancelled in Kobas without a
    #    re-sent email stays in the week's total.
    FULFIL_FEED="Kobas Report - Maki Ramen - Weekly Outstanding Stock Orders Report"
    # 26/08/2026: this is the EXISTING 'Kobas Orders' feed, not a new one.
    # daily_export.py has parsed Kobas order-confirmation emails into it since
    # 13/08/2026; it was upgraded the same day to emit an ISO delivery date and
    # an item count, and to dedupe latest-wins. Adding a second feed over the
    # same emails would have duplicated a healthy one and thrown away a
    # fortnight of history.
    ORDER_EMAIL_FEED="Kobas Orders"
    WEEK_DRILL_CAP=400
    # Dedup key is the Kobas Reference, latest pull wins, then latest placed_at
    # within a pull - amended orders are understood to re-send the same
    # reference. Re-pulling the same orders daily is expected and correct.
    # 26/08/2026: a row CARRYING 'Delivery Date ISO' now outranks one without,
    # ahead of pull_date. Rows written before the parser upgrade have no ISO
    # date and so cannot be date-filtered at all; without this a legacy row in
    # a newer pull would shadow the usable one and drop the order out of both
    # the week and the OTIF month, with no gap note - order_feed_usable only
    # checks that SOME row somewhere carries an ISO date. Preferring the
    # richer shape is free when both rows are current.
    # Field names are the feed's own (Title Case) - they predate this work and
    # other consumers read them. 'Delivery Date ISO' is the sortable date;
    # 'Delivery Date' is the raw '28th Aug 2026' string the feed has always
    # carried and is deliberately NOT used for filtering.
    ORDER_EMAIL_DEDUP=(
      "SELECT DISTINCT ON (data->>'Order Ref') "
      "   data->>'Order Ref' ref, nullif(data->>'Supplier','') sup, "
      "   nullif(data->>'Site','') site, "
      "   nullif(data->>'Delivery Date ISO','') dd, "
      "   nullif(data->>'Order Email Date','') emailed, "
      "   nullif(data->>'Created By','') staff, data->>'Line Items' lines, "
      "   data->>'Items Ordered' items, data->>'Order Value GBP' total "
      " FROM etl_feed_rows WHERE feed=%s "
      " ORDER BY data->>'Order Ref', "
      "          (nullif(data->>'Delivery Date ISO','') IS NULL), "
      "          pull_date DESC, "
      "          data->>'Order Placed At' DESC")
    week_spend=[]; price_watch=[]; week_days=[]; week_drill=[]
    week_drill_total=0; week_spend_source=None; week_spend_basis=None; week_totals=None
    supplier_totals=[]; supplier_totals_basis=None
    supplier_totals_all=[]; supplier_totals_all_basis=None; supplier_totals_all_meta=None
    supply_coverage=None
    cur.execute("SELECT date_trunc('week',current_date)::date, "
                "(date_trunc('week',current_date)+interval '6 day')::date")
    week_start,week_end=cur.fetchone()
    week_start,week_end=week_start.isoformat(),week_end.isoformat()

    def _num(v, cast=float, default=0):
        try: return cast(v)
        except (TypeError,ValueError): return default

    # ---- primary source: Kobas Orders (order-confirmation emails) ----
    # A feed present but written by the PRE-26/08 parser carries no
    # 'Delivery Date ISO' on any row, so nothing can be date-filtered. That is
    # a real state between deploying the parser upgrade and running the
    # backfill, and it must fall back rather than render an empty week that
    # looks like nobody ordered anything.
    order_feed_usable=False
    if has_feed(cur, ORDER_EMAIL_FEED):
        cur.execute("SELECT count(*) FROM etl_feed_rows WHERE feed=%s "
                    "AND nullif(data->>'Delivery Date ISO','') IS NOT NULL",
                    (ORDER_EMAIL_FEED,))
        order_feed_usable=bool((cur.fetchone() or [0])[0])
        if not order_feed_usable:
            gaps.append(f"'{ORDER_EMAIL_FEED}' is present but no row carries a "
                "'Delivery Date ISO' - these rows predate the 26/08/2026 parser "
                "upgrade and cannot be date-filtered. Projected spend is falling "
                "back to the weekly outstanding-orders report until the backfill "
                "(run_kobas_orders.py --since) has run")
    if order_feed_usable:
        cur.execute("SELECT max(pull_date)::text FROM etl_feed_rows WHERE feed=%s",
                    (ORDER_EMAIL_FEED,))
        oe_pull=(cur.fetchone() or [None])[0] or "(unknown pull_date)"
        cur.execute("WITH o AS ("+ORDER_EMAIL_DEDUP+") "
                    "SELECT ref,sup,site,dd,staff,lines,items,total FROM o "
                    "WHERE dd IS NOT NULL AND dd::date BETWEEN %s AND %s",
                    (ORDER_EMAIL_FEED,week_start,week_end))
        rows=[]
        for ref,sup,site,dd,staff,lines,items,total in cur.fetchall():
            rows.append({"ref":ref,"sup":sup or "(no supplier)","site":site or "(no site)",
              "d":dd,"staff":staff,"lines":_num(lines,int),"items":_num(items,int),
              "value":_num(total,float,0.0)})
        agg={}; by_day={}
        for r in rows:
            a_=agg.setdefault((r["site"],r["sup"]),
                              {"orders":0,"lines":0,"items":0,"value":0.0})
            a_["orders"]+=1; a_["lines"]+=r["lines"]
            a_["items"]+=r["items"]; a_["value"]+=r["value"]
            d_=by_day.setdefault(r["d"],{"orders":0,"value":0.0})
            d_["orders"]+=1; d_["value"]+=r["value"]
        for (site,sup),a_ in agg.items():
            week_spend.append({"site":site,"supplier":sup,
              # canonical supplier key so the Supplier Issues tab's profile
              # modal can join this spend to issue attribution (18/08/2026);
              # display keeps the Kobas name, the join uses supplier_canon
              "supplier_canon":canon_supplier(sup),
              "orders":a_["orders"],"lines":a_["lines"],"items":a_["items"],
              "value_gbp":round(a_["value"],2)})
        week_spend.sort(key=lambda r:-r["value_gbp"])
        # Same rows, rolled up by supplier instead of site+supplier, so the
        # question "what are we spending with each supplier" is answered
        # without the reader summing a site table by eye.
        #
        # DELIVERIES is a distinct (site, delivery date), not an order count:
        # two orders to one site arriving the same day are one delivery, and
        # this week that is 68 orders arriving as 61 deliveries. It is derived
        # from order confirmations, so it counts SCHEDULED deliveries - nothing
        # in this source observes whether one arrived. The OTIF card on the
        # same page counts deliveries the same way, so the two agree.
        sup_agg={}
        for r in rows:
            a_=sup_agg.setdefault(r["sup"],{"orders":0,"lines":0,"items":0,
                                            "value":0.0,"slots":set(),"sites":set()})
            a_["orders"]+=1; a_["lines"]+=r["lines"]; a_["items"]+=r["items"]
            a_["value"]+=r["value"]
            a_["slots"].add((r["site"],r["d"])); a_["sites"].add(r["site"])
        supplier_totals=[{"supplier":sup,"supplier_canon":canon_supplier(sup),
                          "orders":a_["orders"],"deliveries":len(a_["slots"]),
                          "lines":a_["lines"],"items":a_["items"],
                          "sites":len(a_["sites"]),
                          "value_gbp":round(a_["value"],2)}
                         for sup,a_ in sup_agg.items()]
        supplier_totals.sort(key=lambda r:(-r["value_gbp"],r["supplier"]))
        supplier_totals_basis=("Same orders as the site table above, grouped by the "
            "supplier name Kobas sends. Deliveries counts distinct site+delivery-date "
            "combinations, so two orders to one site on one day are one delivery; "
            "lines and items are the order email's own Line Items and Items Ordered "
            "totals. Scheduled deliveries, not confirmed ones - an order confirmation "
            "says a delivery was booked, never that it turned up.")

        # ---- all-time supplier totals ----
        # Same dedup, no week filter. Kept as its own query rather than widening
        # the one above, so the weekly figures the KPI strip reconciles against
        # cannot be disturbed by anything here.
        #
        # WHERE THE COVERAGE STARTS, MEASURED RATHER THAN ASSUMED. This feed is
        # a rolling 14-day IMAP window over order-confirmation emails, so it has
        # a hard left edge and no knowledge of anything before it. The edge is
        # not a guess: it is the earliest email date in the archive. Deliveries
        # near that edge are still short, because their orders were emailed
        # BEFORE it - so the first trustworthy delivery date is the edge plus
        # the longest order-to-delivery lead actually observed, and the first
        # trustworthy Monday is the one on or after that. Both are recomputed
        # every bake, so this stays true as the archive grows rather than
        # freezing today's dates into a comment.
        cur.execute("WITH o AS ("+ORDER_EMAIL_DEDUP+") "
                    "SELECT ref,sup,site,dd,emailed,lines,items,total FROM o "
                    "WHERE dd IS NOT NULL",(ORDER_EMAIL_FEED,))
        all_rows=[]
        for ref,sup,site,dd,emailed,lines,items,total in cur.fetchall():
            all_rows.append({"sup":sup or "(no supplier)","site":site or "(no site)",
              "d":dd,"emailed":emailed,"lines":_num(lines,int),"items":_num(items,int),
              "value":_num(total,float,0.0)})
        if all_rows:
            a_agg={}
            for r in all_rows:
                a_=a_agg.setdefault(r["sup"],{"orders":0,"lines":0,"items":0,
                                              "value":0.0,"slots":set(),"sites":set()})
                a_["orders"]+=1; a_["lines"]+=r["lines"]; a_["items"]+=r["items"]
                a_["value"]+=r["value"]
                a_["slots"].add((r["site"],r["d"])); a_["sites"].add(r["site"])
            supplier_totals_all=[{"supplier":sup,"supplier_canon":canon_supplier(sup),
                                  "orders":a_["orders"],"deliveries":len(a_["slots"]),
                                  "lines":a_["lines"],"items":a_["items"],
                                  "sites":len(a_["sites"]),
                                  "value_gbp":round(a_["value"],2)}
                                 for sup,a_ in a_agg.items()]
            supplier_totals_all.sort(key=lambda r:(-r["value_gbp"],r["supplier"]))
            dds=sorted(r["d"] for r in all_rows)
            leads=[(datetime.date.fromisoformat(r["d"])
                    -datetime.date.fromisoformat(r["emailed"])).days
                   for r in all_rows if r["emailed"] and r["d"]]
            cov=min((r["emailed"] for r in all_rows if r["emailed"]),default=None)
            max_lead=max(leads) if leads else 0
            complete_from=None
            if cov:
                safe=datetime.date.fromisoformat(cov)+datetime.timedelta(days=max_lead)
                mon=safe-datetime.timedelta(days=safe.weekday())
                if mon<safe: mon+=datetime.timedelta(days=7)
                complete_from=mon.isoformat()
            # Weeks the reader should not treat as a like-for-like comparison:
            # too early for full email coverage, or not finished being ordered.
            wk_orders={}
            for r in all_rows:
                d_=datetime.date.fromisoformat(r["d"])
                wk_orders.setdefault((d_-datetime.timedelta(days=d_.weekday())).isoformat(),
                                     {"orders":0,"value":0.0})
                k_=(d_-datetime.timedelta(days=d_.weekday())).isoformat()
                wk_orders[k_]["orders"]+=1; wk_orders[k_]["value"]+=r["value"]
            partial=[]
            for wmon,v in sorted(wk_orders.items()):
                why=None
                if complete_from and wmon<complete_from:
                    why=("starts before the feed's email coverage does, so orders "
                         "placed for it were never captured")
                elif wmon>=week_start:
                    why="still being ordered into"
                if why:
                    partial.append({"w":wmon,"orders":v["orders"],
                                    "value_gbp":round(v["value"],2),"why":why})
            supplier_totals_all_meta={
              "orders":len(all_rows),
              # (supplier, site, date), NOT (site, date). The per-supplier rows
              # each count their own site+date slots, so collapsing across
              # suppliers here would make this total disagree with the table it
              # describes - one site taking two suppliers in a day is two
              # deliveries, not one. Measured: 200, not 174.
              "deliveries":len({(r["sup"],r["site"],r["d"]) for r in all_rows}),
              "value_gbp":round(sum(r["value"] for r in all_rows),2),
              "first_delivery":dds[0],"last_delivery":dds[-1],
              "coverage_start":cov,"max_lead_days":max_lead,
              "complete_from":complete_from,
              "weeks":len(wk_orders),"partial_weeks":partial}
            supplier_totals_all_basis=(
              "Every order the Kobas Orders feed has ever captured, deduped by Kobas "
              f"Reference, grouped by supplier: {len(all_rows)} orders with delivery dates "
              f"{dds[0]} to {dds[-1]}. NOT A COMPLETE TRADING HISTORY. The feed is a rolling "
              "14-day window over order-confirmation emails, so it knows nothing before its "
              f"first captured email ({cov}); with the longest observed order-to-delivery "
              f"lead being {max_lead} day(s), deliveries are only fully covered from "
              f"{complete_from} onward"
              + (f", which leaves {len(partial)} week(s) that should not be compared "
                 "like for like with the rest" if partial else "")
              + ". Scheduled deliveries, not confirmed ones - an order confirmation says a "
                "delivery was booked, never that it turned up.")
        week_days=[{"d":d,"orders":v["orders"],"value_gbp":round(v["value"],2)}
                   for d,v in sorted(by_day.items())]
        drill_all=sorted(rows,key=lambda r:(r["d"] or "",-r["value"]))
        week_drill_total=len(drill_all)
        week_drill=[{"site":r["site"],"order_no":r["ref"],"supplier":r["sup"],
                     "d":r["d"],"lines":r["lines"],"items":r["items"],
                     "value_gbp":round(r["value"],2),"staff":r["staff"]}
                    for r in drill_all[:WEEK_DRILL_CAP]]
        # Totals computed once here from the FULL row set (never from the
        # capped week_drill) so the KPI strip is exact even when the drill
        # table is truncated.
        week_totals={"orders":len(rows),
          "lines":sum(r["lines"] for r in rows),
          "items":sum(r["items"] for r in rows),
          "value_gbp":round(sum(r["value"] for r in rows),2)}
        week_spend_source="order_emails"
        week_spend_basis=(f"Kobas Orders (daily IMAP parse of Kobas order-confirmation "
            f"emails, pull_date={oe_pull}): one row per order, deduped by Kobas Reference "
            "(latest pull wins), summing the email's own TOTAL for orders whose DELIVERY date "
            "falls in the current Mon-Sun week, all venues including franchises. Orders as "
            "PLACED - confirmation emails carry no delivered status, so there is no "
            "delivered/pending split on this source and none is shown; a cancellation made in "
            "Kobas without a re-sent email stays in the total")
        try:
            stale_days=(datetime.date.today()-datetime.date.fromisoformat(oe_pull)).days
            if stale_days>=2:
                gaps.append(f"Kobas Orders was last pulled {oe_pull} ({stale_days}d ago) "
                    "- the daily IMAP fetch may be failing; check the maki-hospitality-etl "
                    "daily-export run and the GMAIL_APP_PASSWORD secret")
        except ValueError:
            pass
        # -- supplier coverage vs the weekly outstanding report -------------
        # The report sees every supplier the estate orders from; the emails see
        # only those Kobas transmits by email. Naming the difference turns an
        # invisible 80% shortfall into a checklist that empties itself as Ross
        # enables the remaining suppliers in Kobas (26/08/2026).
        if has_feed(cur,FULFIL_FEED):
            cur.execute("SELECT DISTINCT nullif(data->>'Supplier/Sending Venue','') "
                        "FROM etl_feed_rows WHERE feed=%s",(FULFIL_FEED,))
            report_sups={s for (s,) in cur.fetchall() if s}
            cur.execute("WITH o AS ("+ORDER_EMAIL_DEDUP+") SELECT DISTINCT sup FROM o "
                        "WHERE dd IS NOT NULL",(ORDER_EMAIL_FEED,))
            email_sups={s for (s,) in cur.fetchall() if s}
            email_keys={(canon_supplier(s) or s.strip().lower()) for s in email_sups}
            missing=sorted({s for s in report_sups
                            if (canon_supplier(s) or s.strip().lower()) not in email_keys})
            if missing:
                shown=", ".join(missing[:8])+("…" if len(missing)>8 else "")
                gaps.append(f"Kobas Orders covers {len(email_sups)} supplier(s); "
                    f"{len(missing)} supplier(s) the estate orders from send no confirmation "
                    f"email and are therefore ABSENT from projected spend this week: {shown}. "
                    "Kobas only emails a confirmation for suppliers configured to receive "
                    "orders by email - enabling it per supplier in Kobas closes this gap, and "
                    "this note shrinks as it is done")
            supply_coverage={"suppliers_in_emails":sorted(email_sups),
              "suppliers_missing_from_emails":missing,
              "basis":"distinct suppliers in the Kobas Orders feed vs distinct "
              "'Supplier/Sending Venue' in the weekly outstanding-orders report, matched on "
              "the canonical supplier name where one is known"}
        else:
            gaps.append("Supplier coverage of the Kobas Orders feed cannot be checked "
                "this bake: the weekly outstanding-orders report is absent, so there is "
                "nothing to measure the email feed's supplier list against")
    # ---- fallback: weekly outstanding-orders report ----
    elif has_feed(cur,FULFIL_FEED):
        cur.execute(
          "WITH o AS (SELECT DISTINCT ON (data->>'Order ID') "
          "   data->>'Order ID' oid, nullif(data->>'Supplier/Sending Venue','') sup, "
          "   nullif(data->>'Venue Placed','') site, nullif(data->>'Order Value','') val, "
          "   nullif(data->>'Target Delivery Date','') target "
          " FROM etl_feed_rows WHERE feed=%s ORDER BY data->>'Order ID', pull_date DESC) "
          "SELECT oid, sup, site, val FROM o "
          "WHERE target IS NOT NULL AND target::date BETWEEN %s AND %s",
          (FULFIL_FEED,week_start,week_end))
        agg3={}
        for oid,sup,site,val in cur.fetchall():
            if not oid: continue
            k=(site or "(no site)",sup or "(no supplier)")
            a_=agg3.setdefault(k,{"orders":0,"value":0.0})
            a_["orders"]+=1
            a_["value"]+=_num(val,float,0.0)
        for (site,sup),a_ in agg3.items():
            week_spend.append({"site":site,"supplier":sup,"orders":a_["orders"],
              "value_gbp":round(a_["value"],2),
              # no line/item counts exist in the report - null, never 0, so the
              # shell renders an em dash rather than implying an empty order
              "lines":None,"items":None,
              "supplier_canon":canon_supplier(sup)})
        week_spend.sort(key=lambda r:-r["value_gbp"])
        # Same roll-up, but this source carries no line, item or per-delivery
        # detail. Those stay null, never 0, so the shell renders an em dash
        # rather than implying an order with nothing on it.
        sup_agg3={}
        for (site,sup),a_ in agg3.items():
            b_=sup_agg3.setdefault(sup,{"orders":0,"value":0.0,"sites":set()})
            b_["orders"]+=a_["orders"]; b_["value"]+=a_["value"]; b_["sites"].add(site)
        supplier_totals=[{"supplier":sup,"supplier_canon":canon_supplier(sup),
                          "orders":b_["orders"],"deliveries":None,
                          "lines":None,"items":None,"sites":len(b_["sites"]),
                          "value_gbp":round(b_["value"],2)}
                         for sup,b_ in sup_agg3.items()]
        supplier_totals.sort(key=lambda r:(-r["value_gbp"],r["supplier"]))
        supplier_totals_basis=("Weekly outstanding-orders report grouped by supplier. "
            "That report carries no line, item or delivery-date detail per order, so "
            "those columns are blank rather than zero - only spend and order count are "
            "known on this source, and both are a projection from outstanding orders.")
        week_spend_source="weekly_report_fallback"
        week_spend_basis=("Kobas Orders feed missing - projected spend falling back to "
            "the weekly outstanding-orders report (may be up to 7 days stale): one row per "
            "site+supplier combination (deduped by Order ID across weekly pulls, latest pull "
            "wins), summing Order Value for orders whose Target Delivery Date falls within the "
            "current Mon-Sun week - a projection from outstanding orders, not a measured or "
            "confirmed spend figure, and it carries no delivered/pending split and no line or "
            "item counts")
        gaps.append("Kobas Orders feed missing - projected spend falling back to the "
            "weekly outstanding-orders report (may be up to 7 days stale)")
    else:
        week_spend_source="weekly_report_fallback"
        week_spend_basis=("neither the Kobas Orders feed nor the weekly "
            "outstanding-orders report is available this bake")
        gaps.append(f"'{FULFIL_FEED}' absent from the warehouse, and the Kobas Orders "
            "feed is absent too - projected spend this week unavailable")

    if week_spend_source=="weekly_report_fallback":
        gaps.append("Projected spend this week (fallback figure) is a proxy, not a confirmed "
            "figure: it sums Order Value on currently-outstanding orders whose Target Delivery "
            "Date falls in the current Mon-Sun week - it will overstate spend for any order "
            "that later slips to a different week, and it says nothing about orders not yet "
            "placed. There is no delivered-vs-ordered signal anywhere in the estate to true "
            "this up against: the Mapal Easilys feeds that used to be named here as the fix "
            "were removed on 27/08/2026 because the business does not use Easilys, so this is "
            "a missing SOURCE, not a broken feed - closing it needs a system that records "
            "deliveries, not a credential")
        gaps.append("Some 'outstanding' orders in the Kobas report carry Order Placed dates back "
            "to 2024 and still show status=pending - almost certainly abandoned/never closed out "
            "in the source system rather than a live backlog; if one of these happens to carry a "
            "Target Delivery Date in the current week it is still included as-is")

    # ---- monthly supplier OTIF (deliveries vs issues recorded) ------------
    # Ross's definition, locked 26/08/2026, verbatim: "match the deliveries
    # amount for the month to the amount of issues recorded in that month".
    # Per supplier per calendar month:
    #     otif_pct = max(0, deliveries - issues) / deliveries * 100
    # null (rendered as an em dash) when deliveries = 0. This is an
    # ISSUE-FREE-DELIVERY RATE, not a measured on-time-in-full: nothing here
    # observes whether a delivery was on time or complete, only whether
    # somebody filed an issue against that supplier in the same month. It is
    # NOT a one-to-one match either - one issue form can describe several
    # problems and several issues can land on one delivery. Ross has accepted
    # both approximations; the per-issue detail stays on the Supplier Issues
    # tab. A measured OTIF needs a source that records what was DELIVERED,
    # and the estate does not have one: the Mapal Easilys feeds that this
    # comment used to point at were removed on 27/08/2026 (the business does
    # not use Easilys). The open item is a missing system, not a broken feed.
    OTIF_FIRST_MONTH="2026-08"
    ISSUES_HISTORY_START="2026-08-13"
    otif_months=[]; otif_basis=None
    if week_spend_source=="order_emails":
        cur.execute("WITH o AS ("+ORDER_EMAIL_DEDUP+") "
                    "SELECT substr(dd,1,7) m, sup, count(*) FROM o "
                    "WHERE dd IS NOT NULL AND dd>=%s GROUP BY 1,2",
                    (ORDER_EMAIL_FEED,OTIF_FIRST_MONTH+"-01"))
        deliveries={}
        for m,sup,n in cur.fetchall():
            if not m: continue
            name=(sup or "(no supplier)").strip()
            key=canon_supplier(name) or name
            d_=deliveries.setdefault(m,{})
            e_=d_.setdefault(key,{"supplier":key,"supplier_canon":canon_supplier(name),
                                  "deliveries":0,"issues":0})
            e_["deliveries"]+=n
        # Issues come from the SAME list the Supplier Issues tab renders, so
        # the two always reconcile. Sliced on the issue's own answer date.
        issues_by_month={}; unattributed={}
        for i_ in issues:
            d=i_.get("d") or ""
            if len(d)<7 or d[:7]<OTIF_FIRST_MONTH: continue
            m=d[:7]
            if i_.get("supplier"):
                issues_by_month.setdefault(m,{})
                key=i_["supplier"]
                issues_by_month[m][key]=issues_by_month[m].get(key,0)+1
            else:
                unattributed[m]=unattributed.get(m,0)+1
        months=sorted(set(deliveries)|set(issues_by_month)|set(unattributed))
        cutoff=(pull or datetime.date.today().isoformat())[:7]
        months=[m for m in months if OTIF_FIRST_MONTH<=m<=cutoff]
        for m in months:
            sups=dict(deliveries.get(m,{}))
            for key,n in (issues_by_month.get(m,{}) or {}).items():
                e_=sups.setdefault(key,{"supplier":key,"supplier_canon":canon_supplier(key),
                                        "deliveries":0,"issues":0})
                e_["issues"]=n
            rows_=[]
            for e_ in sups.values():
                dl,iss=e_["deliveries"],e_["issues"]
                rows_.append({**e_,
                  "otif_pct":round(100.0*max(0,dl-iss)/dl,1) if dl else None})
            rows_.sort(key=lambda r:(-r["deliveries"],r["supplier"]))
            dl_tot=sum(r["deliveries"] for r in rows_)
            iss_tot=sum(r["issues"] for r in rows_)
            otif_months.append({"month":m,"suppliers":rows_,
              "deliveries":dl_tot,"issues":iss_tot,
              "unattributed_issues":unattributed.get(m,0),
              "otif_pct":round(100.0*max(0,dl_tot-iss_tot)/dl_tot,1) if dl_tot else None})
        otif_basis=("deliveries = orders with a delivery date in the month from the Kobas Order "
            "Emails feed (deduped by Kobas Reference); issues = supplier issues from GC Form "
            "Task Answers whose own answer date falls in the month, deduped by FormId and "
            "canonicalised to the same supplier names - the identical rows the Supplier Issues "
            "tab renders, so the two always reconcile; otif_pct = max(0, deliveries - issues) / "
            "deliveries, null when there were no deliveries")
    else:
        gaps.append("Monthly supplier OTIF unavailable: it needs the Kobas Orders feed "
            "for its delivery counts, and that feed is absent this bake")
    PRICE_FEED="Kobas Report - Weekly Ingredient Price Changes Report"
    # Ross, 01/09/2026: update the price watch every time the report arrives,
    # and flag (1) an increase that has since held, (2) a price that keeps
    # moving. Both need HISTORY, and this block used to read exactly one pull
    # - so it showed the newest report and nothing else, and had no way to
    # know whether a rise had stuck or a price had bounced.
    #
    # WHAT A "REPORT" IS. Kobas emails this weekly; the export pulls it every
    # day, so the same report is archived several days running. Four distinct
    # reports arrived in the ten pulls to 31/08. So the unit of time here is a
    # DISTINCT REPORT, identified by its content, dated by the first pull that
    # carried it - not pull_date, which would count one report four times and
    # make every price look like it changed daily.
    #
    # Dating by first-seen is deliberately conservative. A pull gap (an export
    # that failed, or the 3-day email window that lost the 24-31/08 report on
    # three days) can only make a report look NEWER than it is, so the
    # "held for N days" test under-states age and never over-fires.
    #
    # WHAT A ROW IS. Each row is one change EVENT, not one item: an item can
    # appear several times in a single report, and the report carries no
    # per-event timestamp, so within a report the only ordering is row_num.
    # 'Old Price' is the literal string 'New' for an item priced for the first
    # time - that is not an increase and is counted separately.
    PRICE_SETTLED_DAYS=14          # Ross: "more than 2 weeks"
    PRICE_FLUX_REPORTS=2           # moved in at least this many distinct reports
    PRICE_FLUX_REVERSALS=2         # and changed direction at least this often
    PRICE_SUSPECT_UP=100.0         # a jump this big is a re-spec, not a price rise
    PRICE_SUSPECT_DOWN=-50.0
    PRICE_STALE_DAYS=10            # a weekly report older than this is a gap
    price_reports=[]; price_settled=[]; price_flux=[]; price_suspect=[]
    price_items=0; newest_report=None
    # Initialised HERE, not inside the has_feed branch below: the snapshot
    # publishes it unconditionally, so a day without the price feed (the
    # weekly report missed its window, or the export skipped it) would
    # otherwise fail the whole bake on a NameError.
    price_supplier_seen=set()
    if has_feed(cur,PRICE_FEED):
        # THE SUPPLIER COLUMN IS READ SPECULATIVELY, AND TODAY IT IS ALWAYS NULL.
        # Ross, 02/09/2026, asked for each supplier's price point per product.
        # The emailed report does not carry one: its seven columns are Parent
        # ID, Ingredient Name, Pack Size, Unit Volume, Measurement, Old Price,
        # New Price, and the email parser keeps EVERY column of the sheet
        # (dict(zip(header,row)) - no whitelist), so this is Kobas not sending
        # it rather than us dropping it. Of the reports that do name a
        # supplier, Outstanding Stock Orders and Ops Deliveries, neither
        # carries an ingredient or a unit price - they are order and invoice
        # totals - so no join reconstructs it either.
        #
        # coalesce over the plausible spellings costs nothing (->> on a missing
        # key is NULL in both Postgres and the DuckDB archive) and means the
        # day somebody adds a Supplier column to the report in Kobas, the
        # drill-down fills itself in with no code change. Until then every
        # consumer below sees None and the card says so in as many words.
        cur.execute(
          "SELECT pull_date::text d, row_num, nullif(data->>'Ingredient Name','') i, "
          " data->>'Old Price' op, data->>'New Price' np, "
          " data->>'Parent ID' pid, data->>'Pack Size' ps, "
          " data->>'Unit Volume' uv, data->>'Measurement' ms, "
          " coalesce(data->>'Supplier', data->>'Supplier Name', "
          "          data->>'Vendor', data->>'Supplier/Sending Venue') sup "
          "FROM etl_feed_rows WHERE feed=%s ORDER BY pull_date, row_num",
          (PRICE_FEED,))
        by_pull={}
        for d,rn,i,op,np,pid,ps,uv,ms,sup in cur.fetchall():
            by_pull.setdefault(d,[]).append((rn,i,op,np,pid,ps,uv,ms,sup))
        seen_hash={}; reports=[]
        for d in sorted(by_pull):
            rows=by_pull[d]
            h=hashlib.sha1(repr(rows).encode()).hexdigest()
            if h in seen_hash: continue      # same report, pulled again
            seen_hash[h]=d
            reports.append((d,rows))
            price_reports.append({"date":d,"rows":len(rows)})
        # One item is a specific pack of a specific ingredient. Parent ID alone
        # is not unique - EDAMAME carries several packs under one parent - and
        # keying on it would read two packs' prices as one item bouncing.
        hist={}
        for d,rows in reports:
            for rn,i,op,np,pid,ps,uv,ms,sup in rows:
                n=fb_num(np); o=fb_num(op)
                if n is None: continue
                sup=(sup or "").strip() or None
                if sup: price_supplier_seen.add(sup)
                hist.setdefault((pid,ps,uv,ms),[]).append((d,o,n,i,sup))
        price_items=len(hist)
        newest=newest_report=reports[-1][0] if reports else None
        def packlabel(pid,ps,uv,ms):
            """'1 x 25000 Grams' - what tells two packs of one ingredient apart.

            Without it the cards show 'Sweet potatoes' twice with different
            prices and look broken, when they are in fact two different packs.
            """
            bits=[]
            n=fb_num(ps); v=fb_num(uv)
            if n and n!=1: bits.append(str(int(n) if n==int(n) else n)+" x")
            if v: bits.append(str(int(v) if v==int(v) else v))
            if ms: bits.append(str(ms))
            return " ".join(bits) or None
        def item_trail(evs):
            """Every change event for one pack, oldest first.

            The card shows a rise or a swing as one number; this is the working
            behind it, which is what a supplier conversation actually needs -
            when it moved, from what, to what, and how many times. Capped at 24
            events so one pathological item cannot bloat the snapshot.
            """
            out=[]
            for d,o,n,_i,sup in evs[-24:]:
                out.append({"d":d,"old":o,"new":n,"supplier":sup,
                  "pct":round(100.0*(n-o)/o,1) if (o and o>0) else None,
                  "dir":0 if o is None else (1 if n>o else -1 if n<o else 0)})
            return out

        def supplier_view(evs):
            """Latest price per supplier for one pack, from its change events.

            Returns [] whenever the report carries no supplier - which is every
            row today. NOTE the limit even once it does: this report is a log of
            CHANGES, so it can only ever show suppliers that changed a price. A
            supplier holding a steady quote never appears in it, so this is
            "who moved, and to what", not a full price comparison across the
            supply base. The drill-down says so rather than implying the list
            is exhaustive.
            """
            if not any(e[4] for e in evs): return []
            by={}
            for d,o,n,_i,sup in evs:
                key=sup or "(not named in report)"
                e=by.setdefault(key,{"supplier":key,"changes":0,"price":None,
                                     "last_change":None,"dir":0})
                e["changes"]+=1
                if e["last_change"] is None or d>=e["last_change"]:
                    e["last_change"]=d; e["price"]=n
                    e["dir"]=0 if o is None else (1 if n>o else -1 if n<o else 0)
            return sorted(by.values(),
                          key=lambda r:(r["price"] is None, r["price"]))

        for k,evs in hist.items():
            name=evs[-1][3]
            pack=packlabel(*k)
            changes=[e for e in evs if e[1] is not None and e[1]>0]
            if not changes: continue         # only ever priced 'New'
            d,o,n,_name,_sup=changes[-1]   # events grew a supplier field
            pct=round(100.0*(n-o)/o,1)
            since=datetime.date.fromisoformat(d)
            # TWO different spans, and conflating them would be a lie either
            # way. age_days is calendar time since the rise - what Ross means
            # by "stayed at that price for more than 2 weeks". held_days is
            # how much of that age the reports actually EVIDENCE: the report
            # only lists changes, so silence means "unchanged", but only up to
            # the newest report we hold. If that report is a fortnight stale,
            # age keeps climbing while the evidence does not, so both are
            # published and the card shows the gap.
            age=(datetime.date.fromisoformat(pull)-since).days
            held=(datetime.date.fromisoformat(newest)-since).days if newest else 0
            # Does ANY move in this item's history look like a re-spec rather
            # than a price? If so the item is marked wherever it appears, so a
            # £0.01-£2.13 "swing" cannot lead the fluctuating list ahead of a
            # real one.
            moves=[100.0*(e[2]-e[1])/e[1] for e in changes]
            suspect=any(m>=PRICE_SUSPECT_UP or m<=PRICE_SUSPECT_DOWN for m in moves)
            # id: what the dashboard clicks on. The pack tuple is already the
            # unique key here (Parent ID alone is not - EDAMAME carries several
            # packs under one parent), so reuse it rather than inventing one.
            row={"id":"|".join(str(x) for x in k),
                 "item":name,"pack":pack,"old_price":o,"new_price":n,
                 "pct_change":pct,"since":d,"age_days":age,"held_days":held,
                 "changes":len(changes),"suspect":suspect,
                 "reports":len({e[0] for e in changes}),
                 "trail":item_trail(changes),"suppliers":supplier_view(changes)}
            # A +2298% "rise" is a re-spec or a keying slip, not a price to go
            # and negotiate. Kept and shown, but in its own list - same rule as
            # the refractometer's suspect readings: never silently repaired,
            # never mixed in with the real signal.
            if pct>=PRICE_SUSPECT_UP or pct<=PRICE_SUSPECT_DOWN:
                price_suspect.append(row)
            elif (pct>0 and age>=PRICE_SETTLED_DAYS
                  and not any(e[0]>d for e in evs)):
                # "and not any later event" is belt and braces - changes[-1] is
                # already the last CHANGE, so a later event could only be a
                # 'New' re-price, which still means the item moved again.
                price_settled.append(row)
            dirs=[1 if e[2]>e[1] else -1 for e in changes]
            revs=sum(1 for a,b in zip(dirs,dirs[1:]) if a!=b)
            if row["reports"]>=PRICE_FLUX_REPORTS and revs>=PRICE_FLUX_REVERSALS:
                prices=sorted({e[2] for e in changes}|{changes[0][1]})
                lo,hi=prices[0],prices[-1]
                price_flux.append({**row,"reversals":revs,"low":lo,"high":hi,
                  "swing_pct":round(100.0*(hi-lo)/lo,1) if lo else None,
                  "distinct_prices":len(prices)})
        price_settled.sort(key=lambda r:(-r["pct_change"],-r["age_days"]))
        # Suspect items last: they are genuinely fluctuating, but a data-entry
        # swing is a different job from a supplier who will not hold a price,
        # and the commercial signal has to lead.
        price_flux.sort(key=lambda r:(r["suspect"],-r["reversals"],
                                      -(r["swing_pct"] or 0)))
        price_suspect.sort(key=lambda r:-abs(r["pct_change"]))
        # The newest report's own changes, which is what the existing card shows.
        for rn,i,op,np,pid,ps,uv,ms,_sup in (reports[-1][1] if reports else []):
            npf=fb_num(np)
            if npf is None: continue
            opf=fb_num(op)
            pct=round(100.0*(npf-opf)/opf,1) if opf else None
            price_watch.append({"ingredient":i,"old_price":opf,"new_price":npf,
              "pct_change":pct,"is_new":opf is None})
        price_watch.sort(key=lambda r:(r["pct_change"] is None,
                                       -(r["pct_change"] or 0), r["ingredient"] or ""))
        stale=(datetime.date.fromisoformat(pull)
               -datetime.date.fromisoformat(newest)).days if newest else None
        if stale is not None and stale>PRICE_STALE_DAYS:
            gaps.append("The newest ingredient price report is "+str(stale)+" days old "
                "(the report is weekly), so the settled-increase flag is counting days "
                "nothing has confirmed: an item shows as holding its price only because "
                "no newer report exists to say otherwise. Each row carries held_days - "
                "how far the evidence actually reaches - beside age_days")
        if len(reports)<2:
            gaps.append("Only "+str(len(reports))+" distinct ingredient price report(s) "
                "are in the archive, so 'held for "+str(PRICE_SETTLED_DAYS)+" days' and "
                "'keeps fluctuating' have almost no history to judge against - both "
                "lists will be thin until more reports land")
        if price_suspect:
            gaps.append(str(len(price_suspect))+" ingredient price change(s) move by more "
                "than "+str(int(PRICE_SUSPECT_UP))+"% up or "+str(int(-PRICE_SUSPECT_DOWN))
                +"% down (e.g. 2.73 to 65.48). At that size it is a pack or unit re-spec "
                "or a keying slip rather than a price rise, so they are listed separately "
                "and kept OUT of the settled-increase flag - putting them in would send "
                "someone to a supplier over a data-entry error")
    else:
        gaps.append(f"'{PRICE_FEED}' absent from the warehouse")
    gaps.append("Ingredient price changes carry no supplier or site field in the source "
        "report, so price rises cannot be joined to a specific supplier or location - shown "
        "as a standalone watchlist, not cross-referenced to suppliers.issues")
    snap["supply"]={"week_spend":week_spend,"week_start":week_start,"week_end":week_end,
      "supplier_totals":supplier_totals,
      "supplier_totals_basis":supplier_totals_basis,
      "supplier_totals_all":supplier_totals_all,
      "supplier_totals_all_basis":supplier_totals_all_basis,
      "supplier_totals_all_meta":supplier_totals_all_meta,
      "week_spend_source":week_spend_source,
      "week_spend_basis":week_spend_basis,
      "week_totals":week_totals,
      "week_days":week_days,
      "week_drill":week_drill,
      "week_drill_total":week_drill_total,
      "week_drill_truncated":week_drill_total>WEEK_DRILL_CAP,
      "coverage":supply_coverage,
      "otif":{"months":otif_months,"basis":otif_basis,
        "first_month":OTIF_FIRST_MONTH,
        "issues_history_start":ISSUES_HISTORY_START,
        "note":"An issue-free-delivery rate, NOT a measured on-time-in-full: nothing here "
        "observes whether a delivery arrived on time or complete, only whether an issue was "
        "filed against that supplier in the same month. Issue history begins "
        +ISSUES_HISTORY_START+", so August denominators cover the whole month but its issue "
        "counts only start mid-month - August OTIF is therefore flattered and is not "
        "comparable with later months. Suppliers with deliveries and no issues show 100%; "
        "suppliers with no deliveries show an em dash, never 0%. Issues that name no supplier "
        "are excluded from the per-supplier rows and disclosed as unattributed_issues."},
      "price_watch":price_watch[:100],
      "price_watch_basis":"newest DISTINCT report of the Kobas Weekly Ingredient Price "
      "Changes email (the same report is pulled daily, so pulls are deduped by content); "
      "pct_change = (new-old)/old*100; is_new=true when the source says 'New' rather than "
      "a prior price",
      "price_reports":price_reports,
      "price_items":price_items,
      "price_settled":price_settled[:100],
      "price_flux":price_flux[:100],
      "price_suspect":price_suspect[:100],
      "price_thresholds":{"settled_days":PRICE_SETTLED_DAYS,
        "flux_reports":PRICE_FLUX_REPORTS,"flux_reversals":PRICE_FLUX_REVERSALS,
        "suspect_up":PRICE_SUSPECT_UP,"suspect_down":PRICE_SUSPECT_DOWN,
        "stale_days":PRICE_STALE_DAYS},
      "price_newest_report":newest_report,
      # Whether the report named a supplier on ANY row of ANY archived pull.
      # Published as a fact rather than assumed either way, so the drill-down
      # can say "the feed does not carry one" instead of showing an empty
      # table that reads like a bug - and so it starts working by itself if a
      # Supplier column is ever added to the report in Kobas.
      "price_supplier_names":sorted(price_supplier_seen)[:50],
      "price_has_supplier":bool(price_supplier_seen),
      "price_supplier_basis":"the Weekly Ingredient Price Changes report carries seven "
      "columns - Parent ID, Ingredient Name, Pack Size, Unit Volume, Measurement, Old "
      "Price, New Price - and no supplier. The email parser keeps every column of the "
      "attached sheet, so this is the report not carrying it, not the ETL dropping it. "
      "The reports that do name a supplier (Outstanding Stock Orders, Ops Deliveries) "
      "carry order and invoice totals with no ingredient or unit price, so the two "
      "cannot be joined. Adding a Supplier column to the price report in Kobas is what "
      "fills this in; the bake already reads one if it appears. Even then it would show "
      "only suppliers that CHANGED a price, because the report is a log of changes - a "
      "supplier holding a steady quote never appears in it.",
      "price_flags_basis":"built from EVERY archived pull of the price-changes report, "
      "deduped by content into distinct reports and dated by the first pull that carried "
      "each - the report is emailed weekly but pulled daily, so pull_date would count one "
      "report many times. An item is one PACK of one ingredient (Parent ID + pack size + "
      "unit volume + measurement): Parent ID alone is not unique, so keying on it would "
      "read two packs as one item bouncing. Each row is a change EVENT and an item can "
      "have several in one report, which carries no per-event timestamp - within a report "
      "the only ordering is row_num. SETTLED = the item's most recent change was a rise "
      "and no later report has changed it again, held at least settled_days, measured to "
      "the newest report rather than today so a stale bake cannot inflate it. FLUCTUATING "
      "= changed in at least flux_reports distinct reports with at least flux_reversals "
      "direction changes. SUSPECT = a move beyond suspect_up/suspect_down, which at that "
      "size is a pack or unit re-spec rather than a price, held out of the settled list "
      "and never repaired. Neither flag can see a price that never appears in the report, "
      "because the report only lists changes"}
    # ---- cross-reference: broth quality x supplier issues, by site+date ----
    gc_to_key={v[0]:k for k,v in SITE_ALIASES.items()}
    events=[]
    for dv in broth_deviations:
        key=gc_to_key.get(dv["site"])
        if not key: continue
        events.append({"site_key":key,"d":dv["d"],"kind":"broth_deviation",
          "detail":f"{dv['kind']} broth deviation"+(" (open)" if dv["open"] else "")})
    for i_ in issues:
        key=gc_to_key.get(i_["site"])
        if not key or not i_["d"]: continue
        events.append({"site_key":key,"d":i_["d"],"kind":"supplier_issue",
          "detail":f"{i_['supplier'] or '(no supplier answer)'} issue"+
                   (" (open)" if i_["open"] else "")})
    events.sort(key=lambda r:(r["site_key"],r["d"]))
    def _pd(s):
        try: return datetime.date.fromisoformat(s)
        except Exception: return None
    by_site={}
    for e in events: by_site.setdefault(e["site_key"],[]).append(e)
    coincidences=[]
    for site_key,evs in by_site.items():
        bds=[e for e in evs if e["kind"]=="broth_deviation"]
        sis=[e for e in evs if e["kind"]=="supplier_issue"]
        for bd in bds:
            bdd=_pd(bd["d"])
            if not bdd: continue
            near=[si for si in sis if _pd(si["d"]) and abs((_pd(si["d"])-bdd).days)<=3]
            if near:
                coincidences.append({"site":SITE_ALIASES[site_key][2],"site_key":site_key,
                  "broth_date":bd["d"],"broth_detail":bd["detail"],
                  "supplier_issues":[{"d":si["d"],"detail":si["detail"]} for si in near]})
    coincidences.sort(key=lambda r:r["broth_date"],reverse=True)
    gaps.append("Cross-reference site-alias map does not cover every site: 'Fountain Good "
        "Food Ltd', 'M1TOO Ltd', 'Maki Meadowhall' and 'Maki Property Ltd' appear in "
        "GetCompliant with no confirmed Kobas venue match, and 'Maki 1/2 (Nicolson St)', "
        "'Maki Fountainbridge', 'Maki Leith', 'Maki Manchester NQ', 'Maki West End' and "
        "'Maki Yorkshire' appear in Kobas with no GetCompliant broth-check match - these "
        "sites are excluded from cross-referencing until the alias map is extended, never "
        "guessed at")
    snap["cross_ref"]={"events":events,"coincidences":coincidences,
      "site_aliases":{k:{"gc":v[0],"kobas":v[1],"label":v[2]} for k,v in SITE_ALIASES.items()},
      "basis":"coincidence, NOT causation: every broth deviation (GC Scheduled Task "
      "Answers, IsDeviation=true) paired with any supplier issue (GC Form Task Answers, "
      "delivery/supplier forms) at the SAME site within +/-3 days by event date; join key "
      "is site+date via the hand-built SITE_ALIASES map, since site names differ across "
      "systems (e.g. 'Maki SJQ Ltd' vs 'Maki SJQ')"}
    # ---- maintenance tasks by site (Google Sheet, NOT the Postgres warehouse) ----
    # Ross, 15 Aug: wants a Maintenance tab - tasks by site, outstanding/ongoing
    # tasks, with the comments/updates on each. There is no maintenance feed in
    # the Neon warehouse (checked all 43 feeds), no structured tracker in Asana
    # (checked live - only ad-hoc meeting-note tasks), and no GetCompliant form
    # for it either (checked GC Forms - no maintenance/repair/facilities form
    # exists). The real tracker is a Google Sheet Lincoln maintains by hand:
    # "Required Maintenance/Repair (Responses)", confirmed as the source with
    # Ross. That sheet has no live API wired into Pipe 9 (GitHub Actions has no
    # Google credential, and adding one is a Ross-side credential step - see
    # gaps note below) so this block reads a committed companion file,
    # data/ops_command/maintenance_source.json, instead of querying Postgres.
    # That file is produced by pulling the sheet's most recent curated section
    # ("UPDATED AS OF <date>" - ON GOING/PENDING + DONE tables) via the Drive
    # connector and normalizing site labels (the sheet uses short codes like
    # M12/Maki 12 - mapped to the same canonical site names used everywhere
    # else on this dashboard via a legend cross-checked against the internal
    # "SITE OVERVIEW" directory doc). It is refreshed by re-running that pull,
    # not by Pipe 9 itself - see the project doc for the refresh mechanism.
    MAINT_SRC=os.path.join(OUT_DIR,"maintenance_source.json")
    if os.path.exists(MAINT_SRC):
        msrc=json.load(open(MAINT_SRC))
        mtasks=msrc.get("tasks",[])
        mcell={}
        for t in mtasks:
            key=t.get("site")
            if not key: continue
            c=mcell.setdefault(key,{"ongoing":0,"done":0})
            if t.get("status")=="ongoing": c["ongoing"]+=1
            elif t.get("status")=="done": c["done"]+=1
        maint_sites=[{"site":s,"ongoing":c["ongoing"],"done":c["done"]}
          for s,c in mcell.items()]
        maint_sites.sort(key=lambda r:(-r["ongoing"],-r["done"]))
        maint_gaps=[]
        if msrc.get("unresolved_site_labels"):
            maint_gaps.append("site label(s) not resolved to a canonical dashboard "
              "site name, shown as-is rather than guessed: "
              +", ".join(msrc["unresolved_site_labels"]))
        snap["maintenance"]={"tasks":mtasks,"by_site":maint_sites,
          "source_as_of":msrc.get("source_as_of"),"pulled_at":msrc.get("pulled_at"),
          "gaps":maint_gaps,
          "basis":"per maintenance/repair task from "+msrc.get("source","(unlabelled source)")
          +"; status is 'ongoing' (outstanding/in-progress, per the sheet's own "
          "ON GOING/PENDING section) or 'done' (per its DONE section) - the sheet "
          "does not distinguish outstanding from in-progress any further than that; "
          "event-dated on the sheet's own Date column, so the date-range filter "
          "slices both the per-site bars/table and the drill-down; NOT sourced from "
          "the Neon warehouse or Pipe 9 - see 'source_as_of'/'pulled_at' for "
          "freshness, and the project doc for how this gets refreshed"}
    else:
        snap["maintenance"]={"tasks":[],"by_site":[],"gaps":[
          "maintenance_source.json missing - Maintenance tab has no data this bake"],
          "basis":"no data available this bake"}
        gaps.append("data/ops_command/maintenance_source.json absent - Maintenance tab "
          "empty. This file is not produced by Pipe 9; it's pulled from Lincoln's "
          "Google Sheet by a separate refresh step - see project doc")
    # ---- sites ----
    hc=[]
    cur.execute(
      "WITH t AS (SELECT nullif(data->>'branch','') bid FROM etl_feed_rows WHERE feed='Flow Trainees' "
      " AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='Flow Trainees')), "
      "b AS (SELECT data->>'id' id, nullif(data->>'name','') name FROM etl_feed_rows WHERE feed='Flow Branches' "
      " AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='Flow Branches')) "
      "SELECT coalesce(b.name,'Branch '||t.bid,'(no branch)'), count(*) FROM t LEFT JOIN b ON b.id=t.bid "
      "GROUP BY 1 ORDER BY 2 DESC, 1")
    for site,n in cur.fetchall():
        hc.append({"site":site,"site_type":SITE_TYPES.get(site,"restaurant"),"people":n})
    directory=[]
    if has_feed(cur,"GC Locations"):
        cur.execute(
          "SELECT coalesce(nullif(data->>'LocationName',''),'(unnamed)'), "
          " coalesce(data->>'LocationActive','-'), coalesce(data->>'LocationIsPaused','-'), "
          " nullif(data->>'Groups',''), nullif(data->>'Categories','') "
          "FROM etl_feed_rows WHERE feed='GC Locations' AND pull_date="
          "(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='GC Locations') ORDER BY 1")
        directory=[{"site":r[0],"active":str(r[1]).lower() in ('true','1','yes'),
          "paused":str(r[2]).lower() in ('true','1','yes'),"groups":r[3],"categories":r[4]}
          for r in cur.fetchall()]
    snap["sites"]={"headcount":hc,"directory":directory}
    # ---- summary + standing gaps ----
    cur.execute("SELECT count(DISTINCT data->>'id') FROM etl_feed_rows WHERE feed='Flow Trainees' AND pull_date="+L,("Flow Trainees",))
    employees=(cur.fetchone() or [None])[0]
    snap["summary"]={"employees":employees,
      "feeds_ok":sum(1 for r in fh if r["verdict"]=="OK"),
      "feeds_missing":sum(1 for r in fh if r["verdict"]=="MISSING"),
      "feeds_stale":sum(1 for r in fh if r["verdict"] in ("STALE","EMPTY"))}
    if has_feed(cur,"Flow Certificates"):
        gaps.append("Flow Certificates exposes no expiry field (certificate_url, module_name, "
                    "trainee_id only) - statutory expiries are not visible from this feed")
    snap["gaps"]=gaps
    # ---- signals, each with basis ----
    sig=[]
    tot_sup=sum(t["open"] for t in snap["suppliers"]["totals"])
    if tot_sup>10:
        sig.append({"severity":"red","text":f"Supplier issue backlog is {tot_sup} open (target ≤10/month)",
          "basis":"sum(open) over suppliers.totals vs OKR KR1"})
    missing=[r["feed"] for r in fh if r["verdict"]=="MISSING"]
    if missing:
        sig.append({"severity":"red","text":f"{len(missing)} expected feeds absent: "+", ".join(missing[:5])+("…" if len(missing)>5 else ""),
          "basis":"verdict=MISSING in feed_health"})
    mods=sum(r["modules"] for r in training); comp=sum(r["complete"] for r in training)
    if mods and round(100*comp/mods)<90:
        sig.append({"severity":"amber",
          "text":f"Training completion {round(100*comp/mods)}% ({sum(r['overdue'] for r in training)} overdue, {len(training)} sites)",
          "basis":"sum(complete)/sum(modules) over training.sites vs 90% target"})
    ovd=[a_ for a_ in areas if a_["overdue"]>0]
    if ovd:
        top=max(ovd,key=lambda r:r["overdue"])
        sig.append({"severity":"amber","text":f"{len(ovd)} checklist areas overdue; worst: {top['area']} ({top['overdue']})",
          "basis":"overdue>0 in compliance.areas"})
    for i,s_ in enumerate(sig): s_["rank"]=i+1
    snap["signals"]=sig
    snap["schema_version"]="1.0"
    snap["generated_at"]=datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    snap["source"]=src_label
    snap["pull_date"]=pull
    os.makedirs(OUT_DIR,exist_ok=True)
    out=os.path.join(OUT_DIR,f"snapshot_{pull}.json")
    json.dump(snap,open(out,"w"),separators=(",",":"))
    ip=os.path.join(OUT_DIR,"snapshot_index.json")
    idx=json.load(open(ip)) if os.path.exists(ip) else {"note":"Ops Command snapshots. Newest first; the daily refresh prepends.","dates":[]}
    if pull not in idx["dates"]: idx["dates"].insert(0,pull)
    idx["latest"]=idx["dates"][0]; idx["generated_at"]=snap["generated_at"]
    json.dump(idx,open(ip,"w"),indent=1)
    conn.close()
    print(f"baked {out}: {len(fh)} feeds, {len(training)} training sites, "
          f"{len(forms)} forms, {len(sig)} signals, {len(gaps)} gaps")
if __name__=="__main__":
    main()
