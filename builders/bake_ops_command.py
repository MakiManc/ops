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
          " max(site), bool_or(opn IN ('true','1','yes')) "
          "FROM a WHERE position('eliver' in tpl)>0 OR position('upplier' in tpl)>0 "
          "GROUP BY fid ORDER BY 3 DESC LIMIT 2000")
        for fid,tpl,d,ans,site,opn in cur.fetchall():
            sup=supplier_of(ans or "")
            if sup=="Unattributed" and ans: sup=ans.strip().title()[:40]
            if not ans: sup=None   # form has no supplier answer -> null, never a fake name
            issues.append({"d":d,"supplier":sup,"site":site,"form":tpl,"open":bool(opn)})
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
