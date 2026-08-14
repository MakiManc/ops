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
import argparse, datetime, json, os, sys

try:
    import psycopg2
except ImportError:
    sys.exit("psycopg2 is required: pip install psycopg2-binary")

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
SUPPLIER_MATCH = [("Lynas","Lynas"),("Solstice","Solstice"),("Solstice","Sosltice"),
                  ("TWF","TWF"),("M&R","M&R")]

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

EXPECTED_FEEDS = [
    "Flow Trainees","Flow Branches","Flow Modules","Flow Certificates",
    "Deep Flow Modules","Deep Flow Certificates",
    "GC Forms Overview","GC Central Module Tasks","GC Locations",
    "GC Deviations","GC Waste Registered",
    "Mapal Supplier Orders","Mapal Smart Delivery","Mapal Invoices To Receive",
    "Kobas Orders",
]

def supplier_of(form):
    for sup, needle in SUPPLIER_MATCH:
        if needle.lower() in (form or "").lower(): return sup
    return "Unattributed"

def has_feed(cur, feed):
    cur.execute("SELECT 1 FROM etl_feed_rows WHERE feed=%s LIMIT 1", (feed,))
    return cur.fetchone() is not None

L = "(SELECT max(pull_date) FROM etl_feed_rows WHERE feed=%s)"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None, help="pull date to stamp (default: max pull_date in warehouse)")
    a = ap.parse_args()
    dsn = os.environ.get("WAREHOUSE_DSN") or sys.exit("WAREHOUSE_DSN not set")
    conn = psycopg2.connect(dsn); cur = conn.cursor()
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
    # Completion EVENTS by day+site, so ranges filter on when modules were
    # actually completed, not on pull_date. module_completed_date is UK-format
    # 'DD/MM/YYYY HH:MM' (13/08/2026); parsed defensively, bad values skipped.
    completions=[]
    if linked:
        cur.execute(
          "WITH m AS (SELECT data->>'trainee_id' tid, nullif(data->>'module_completed_date','') cd "
          "  FROM etl_feed_rows WHERE feed=%s AND pull_date="+L+
          "  AND data->>'module_status'='Complete' "
          "  AND nullif(data->>'module_completed_date','') IS NOT NULL), "
          "t AS (SELECT data->>'id' id, nullif(data->>'branch','') bid FROM etl_feed_rows "
          "  WHERE feed='Flow Trainees' AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='Flow Trainees')), "
          "b AS (SELECT data->>'id' id, nullif(data->>'name','') name FROM etl_feed_rows "
          "  WHERE feed='Flow Branches' AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed='Flow Branches')), "
          "p AS (SELECT coalesce(b.name,'Branch '||t.bid,'(no branch)') site, "
          "  CASE WHEN length(m.cd)>=10 AND substr(m.cd,3,1)='/' AND substr(m.cd,6,1)='/' "
          "       THEN substr(m.cd,7,4)||'-'||substr(m.cd,4,2)||'-'||substr(m.cd,1,2) END d "
          "  FROM m JOIN t ON t.id=m.tid LEFT JOIN b ON b.id=t.bid) "
          "SELECT d, site, count(*) FROM p WHERE d IS NOT NULL "
          "GROUP BY 1,2 ORDER BY 1 DESC LIMIT 4000", (feed, feed))
        completions=[{"d":r[0],"site":r[1],"n":r[2]} for r in cur.fetchall()]
    snap["training"]={"source_feed":feed,"sites":training,"completions":completions,
      "completions_basis":"count of modules with module_status='Complete' grouped by "
      "module_completed_date (the completion EVENT date) and site; capped at 4000 day-site rows"}

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
          "GROUP BY 1 ORDER BY 3 DESC, 2 DESC")
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
          " max(CASE WHEN task='Issue?' THEN ans END) "
          "FROM a WHERE position('eliver' in tpl)>0 OR position('upplier' in tpl)>0 "
          "GROUP BY fid ORDER BY 3 DESC LIMIT 2000")
        for fid,tpl,d,ans,site,opn,issue_text in cur.fetchall():
            sup=supplier_of(ans or "")
            if sup=="Unattributed" and ans: sup=ans.strip().title()[:40]
            if not ans: sup=None   # form has no supplier answer -> null, never a fake name
            issues.append({"d":d,"supplier":sup,"site":site,"form":tpl,"open":bool(opn),
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
      "form's own 'Supplier?' answer, null when unanswered",
      "note":"GetCompliant delivery/supplier issue forms. The Mapal supplier "
      "feeds fail at fetch, so this is the only supplier signal that lands - self-reported, "
      "not a measured OTIF.","totals":[{"supplier":k,**v} for k,v in
      sorted(agg.items(),key=lambda kv:-kv[1]["open"])],"forms":sorted(sups,key=lambda r:-r["open"])}
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
    broth_cells=[]; broth_deviations=[]
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
            broth_cells.append({"site":site,"kind":kind,"d":d,
              "value":round(sum(c["vals"])/len(c["vals"]),2) if c["vals"] else None,
              "checks":c["n"],"checks_missed":c["missed"]})
        broth_deviations.sort(key=lambda r:r["d"],reverse=True)
    else:
        gaps.append("'GC Scheduled Task Answers' absent from the warehouse - broth quality "
            "checks (Chicken/Tonkotsu Broth Check) unavailable")
    gaps.append("Broth heatmap colours are scaled to the OBSERVED reading range in this "
        "snapshot, not an official spec band - no chicken/tonkotsu density target exists in "
        "the data yet (needs a small reference table of min/target/max from Ross's par "
        "standards)")
    snap["quality"]={"broth":{"cells":broth_cells,"deviations":broth_deviations[:200],
      "tasks":BROTH_TASKS,
      "basis":"one cell per site + check-type + day from GC Scheduled Task Answers, "
      "deduped by AnswerID across pulls, averaged if >1 reading landed that day; "
      "'checks_missed' counts non-numeric answers (e.g. 'Not registered on time') "
      "separately from checks_missed==checks meaning value is null (no numeric reading "
      "that day); event-dated on AnsweredDateTime, never pull_date"}}

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
        for (site,d),c in cell_agg.items():
            task_cells.append({"site":site,"d":d,"on_time":c["on_time"],
              "missed":c["missed"]})
        for site,items in by_site.items():
            items.sort(key=lambda r:r["due"] or "",reverse=True)
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

    # ---- supply / fulfilment aging (Kobas Outstanding Stock Orders) ----
    FULFIL_FEED="Kobas Report - Maki Ramen - Weekly Outstanding Stock Orders Report"
    fulfil=[]; price_watch=[]
    if has_feed(cur,FULFIL_FEED):
        cur.execute(
          "WITH o AS (SELECT DISTINCT ON (data->>'Order ID') "
          "   data->>'Order ID' oid, nullif(data->>'Supplier/Sending Venue','') sup, "
          "   nullif(data->>'Venue Placed','') site, nullif(data->>'Order Value','') val, "
          "   nullif(data->>'Target Delivery Date','') target "
          " FROM etl_feed_rows WHERE feed=%s ORDER BY data->>'Order ID', pull_date DESC) "
          "SELECT oid, sup, site, val, target, "
          " CASE WHEN target IS NOT NULL THEN (current_date - target::date) END "
          "FROM o", (FULFIL_FEED,))
        agg3={}
        for oid,sup,site,val,target,overdue_days in cur.fetchall():
            if not oid: continue
            k=sup or "(no supplier)"
            a_=agg3.setdefault(k,{"open":0,"value":0.0,"overdue_n":0,"on_target_n":0,
                                   "overdue_days_worst":0})
            a_["open"]+=1
            try: v=float(val)
            except (TypeError,ValueError): v=0.0
            a_["value"]+=v
            od=int(overdue_days) if overdue_days is not None else None
            if od is not None and od>0:
                a_["overdue_n"]+=1
                a_["overdue_days_worst"]=max(a_["overdue_days_worst"],od)
            elif od is not None:
                a_["on_target_n"]+=1
        for sup,a_ in agg3.items():
            fulfil.append({"supplier":sup,"open_orders":a_["open"],
              "value_gbp":round(a_["value"],2),"overdue_orders":a_["overdue_n"],
              "on_target_pct":round(100.0*a_["on_target_n"]/a_["open"],1) if a_["open"] else None,
              "worst_overdue_days":a_["overdue_days_worst"]})
        fulfil.sort(key=lambda r:-r["value_gbp"])
    else:
        gaps.append(f"'{FULFIL_FEED}' absent from the warehouse - fulfilment aging unavailable")
    gaps.append("Fulfilment aging is a proxy, not true OTIF: the Mapal Supplier Orders/Smart "
        "Delivery/Invoices To Receive feeds fail at fetch (credentials), so there is no "
        "delivered-vs-ordered signal - fixing Mapal is the single highest-value data unlock "
        "for this dashboard")
    gaps.append("Some 'outstanding' orders in the Kobas report carry Order Placed dates back "
        "to 2024 and still show status=pending - almost certainly abandoned/never closed out "
        "in the source system rather than a live backlog; the aging table includes them as-is")

    PRICE_FEED="Kobas Report - Weekly Ingredient Price Changes Report"
    if has_feed(cur,PRICE_FEED):
        cur.execute(
          "SELECT nullif(data->>'Ingredient Name','') i, nullif(data->>'Old Price','') op, "
          " nullif(data->>'New Price','') np FROM etl_feed_rows WHERE feed=%s "
          " AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows WHERE feed=%s)",
          (PRICE_FEED,PRICE_FEED))
        for i,op,np in cur.fetchall():
            try: npf=float(np)
            except (TypeError,ValueError): continue
            try: opf=float(op)
            except (TypeError,ValueError): opf=None
            pct=round(100.0*(npf-opf)/opf,1) if opf else None
            price_watch.append({"ingredient":i,"old_price":opf,"new_price":npf,
              "pct_change":pct,"is_new":opf is None})
        price_watch.sort(key=lambda r:(r["pct_change"] is None, -(r["pct_change"] or 0)))
    else:
        gaps.append(f"'{PRICE_FEED}' absent from the warehouse")
    gaps.append("Ingredient price changes carry no supplier or site field in the source "
        "report, so price rises cannot be joined to a specific supplier or location - shown "
        "as a standalone watchlist, not cross-referenced to suppliers.issues")

    snap["supply"]={"fulfilment":fulfil,
      "fulfilment_basis":"one row per Order ID (deduped across weekly pulls, latest pull "
      "wins) from the Kobas Outstanding Stock Orders report; value_gbp/overdue counts are a "
      "proxy for OTIF, not a measured fulfilment rate",
      "price_watch":price_watch[:100],
      "price_watch_basis":"latest pull of the Kobas Weekly Ingredient Price Changes report; "
      "pct_change = (new-old)/old*100; is_new=true when there is no prior price on file"}

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
      "GROUP BY 1 ORDER BY 2 DESC")
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
    snap["source"]="Neon Postgres warehouse via bake_ops_command.py (Pipe 9); feed health measured against Postgres, not the Sheets write"
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
