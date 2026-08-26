#!/usr/bin/env python3
"""
verify_ops_data.py -- the daily verification spine (verify.yml).

Every daily process in this system must either prove it worked or fail
loudly, and "proved it worked" is always measured at the DESTINATION --
Neon Postgres and the live dashboard -- never at a workflow's own exit
code. This script is the safety net under the ETL's own loud-failure
receipts (etl_receipt.py in MakiManc/maki-hospitality-etl).

Driven by data/ops_command/feeds_manifest.json -- the single home for the
system's expectations.

CHECKS (v2, Phase 2 complete)
  check 0  RUN RECEIPTS    etl_run_log has a receipt for today's
                           daily-export and deep-pull runs. Exit 0 is not
                           enough on its own: exit 0 with ZERO rows
                           written, or exit 0 with failed feeds, is a
                           critical. (25 Aug 2026: the receipt row said
                           exit 0 / 0 rows / every feed failed while the
                           workflow itself was red, and this check called
                           it ok.)
  check 1  FEEDS LANDED    every status=expected feed's max(pull_date) is
                           today. Measured in Postgres (the §13 class).
  check 2  ROWS SANE       today's rows >= manifest floor and within a
                           0.5x-3x band of the trailing 14-day median
                           (falls back to the calibration median while
                           post-trim Neon history is thin).
  check 3  EVENTS FRESH    for manifest feeds with event_date_field: the
                           max event date INSIDE the data is recent per
                           the feed's event_fresh_days. Catches pulls that
                           keep landing while the upstream API silently
                           serves a frozen window. Always a warning tier.
  check 4a SNAPSHOT FRESH  the live snapshot_index.json says the same
                           latest data date as Postgres (raw GitHub
                           primary; Pages CDN informative only).
  check 4b CONSISTENT      the REAL builder (bake_ops_command.py, copied
                           to a temp dir and run against today's
                           warehouse -- same code, no drift) must produce
                           the same headline aggregates as the live baked
                           snapshot: scheduled-task on-time/missed totals,
                           projected-spend GBP total, broth cell count,
                           supplier-issue count, outstanding-training
                           count. Catches a correct warehouse feeding a
                           wrong dashboard.
  check 5  NOTHING BLIND   feeds present in Postgres today but absent
                           from the manifest raise warnings -- the
                           manifest cannot quietly fall behind reality.
  check 6  SIDE CHANNELS   maintenance_source.json age (>7 days without a
                           refresh commit suggests the refresh chain is
                           dead) and DB size (warn at 400 MB, CRITICAL at
                           450 -- Neon free cap is 512 MB and a rejected
                           insert loses the day; the archive+trim keeps
                           steady state near 300 MB).

MORNING vs RECHECK (the false-alarm damper, plan §1)
  09:30 UTC morning run: timing-deferrable criticals -- a feed missing
  while its producing run has no receipt yet (may still be in flight),
  a stale snapshot, a 4b mismatch or recompute crash -- are recorded as
  "deferred" (overall amber, no push, exit 0). Everything genuinely
  broken (receipt says exit!=0, feed missing though its run finished
  fine, floor breach, DSN dead) still alerts immediately.
  12:00 UTC recheck run: no deferral -- anything still failing pushes.
  Mode is chosen by UTC hour (>= 11 -> recheck).

ALSO WRITTEN EACH RUN
  data/ops_command/health_latest.json   full verdict (banner + Data
                                        Health tab read this)
  data/ops_command/verify_history.json  rolling 60-entry run history
                                        (7-day strip + alive-push source)
  ops_daily_aggregates (Postgres)       per-site daily aggregates upserted
                                        from the recompute snapshot --
                                        tasks on-time/missed, broth cells,
                                        supplier issues. This is the
                                        approved history archive: it
                                        accumulates beyond the feeds' own
                                        rolling windows (open item 5). A
                                        failed upsert is a CRITICAL -- it
                                        is usually the first sign the
                                        store itself is refusing writes.

MONDAY ALIVE-PUSH: silence-as-healthy is only trustworthy while the
checker is provably alive, so every Monday morning run sends one push --
"verifier alive - N/7 days green" -- regardless of status.

Env: WAREHOUSE_DSN (required), NTFY_TOPIC (optional -- degrades to log).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "data", "ops_command")
MANIFEST_PATH = os.path.join(OUT_DIR, "feeds_manifest.json")
HEALTH_PATH = os.path.join(OUT_DIR, "health_latest.json")
HISTORY_PATH = os.path.join(OUT_DIR, "verify_history.json")
MAINT_PATH = os.path.join(OUT_DIR, "maintenance_source.json")

RAW_BASE = ("https://raw.githubusercontent.com/MakiManc/ops/main/"
            "data/ops_command/")
PAGES_INDEX = ("https://makimanc.github.io/ops/data/ops_command/"
               "snapshot_index.json")

DB_SIZE_WARN_MB = 400          # Neon free cap is 512 MB
# Above this, the store is close enough to the cap that the NEXT pull is
# likely to be rejected outright (25 Aug 2026: 513 MB, every insert failed
# with DiskFull and the day's data was lost). A warning is the wrong tier
# for "tomorrow's export will not run" -- while Neon is still the store,
# this is a critical. Retired with Neon at the end of Phase 2.
DB_SIZE_CRIT_MB = 450
MAINT_AGE_WARN_DAYS = 7        # a week with no refresh commit = dead chain

# Timing-deferrable failure classes (morning run defers them to 12:00).
# A missing receipt at 09:30 is indistinguishable from an export still in
# flight (75-min timeout from 08:15 can outlast the morning run); by 12:00
# it is unambiguous, so it defers alongside the other timing classes.
DEFERRABLE = {"1-landed-inflight", "4a-snapshot", "4b-consistency",
              "0-receipts-missing"}


def domain_of(feed: str) -> str:
    if feed.startswith(("Flow", "Deep Flow", "Deep Profile", "Deep Run")):
        return "training"
    if feed.startswith("GC"):
        return "gc-compliance"
    if feed.startswith(("Kobas", "Supplier", "Mapal")):
        return "kobas-supply"
    return "other"

PRIORITY_DOMAINS = {"gc-compliance", "kobas-supply"}

RESULTS: list[dict] = []


def add(check: str, level: str, detail: str, feed: str | None = None,
        klass: str | None = None):
    RESULTS.append({"check": check, "level": level,
                    **({"feed": feed} if feed else {}),
                    **({"class": klass} if klass else {}),
                    "detail": detail})


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_json(url: str, timeout: int = 20):
    req = urllib.request.Request(url + f"?cb={int(time.time())}",
                                 headers={"User-Agent": "ops-verify"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# Phase 4 of the Neon exit: OPS_WAREHOUSE_SOURCE=archive verifies the committed
# pull archive instead of Postgres. Every check below runs unchanged; only the
# connection and the two store-specific behaviours (capacity, aggregates) branch
# on this. Default is Postgres, so the flag is inert until something sets it.
ARCHIVE_MODE = os.environ.get("OPS_WAREHOUSE_SOURCE") == "archive"


def connect():
    if ARCHIVE_MODE:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import archive_source
        adir = (os.environ.get("OPS_ARCHIVE_DIR") or "").strip()
        if not adir:
            add("setup", "critical",
                "OPS_WAREHOUSE_SOURCE=archive but OPS_ARCHIVE_DIR is not set "
                "- the verifier cannot verify anything")
            return None
        try:
            # OPS_RUN_LOG points at the ETL repo's shadow receipt JSONL; when
            # absent the etl_run_log table simply does not exist and check 0
            # takes its own "no receipts yet" path.
            return archive_source.connect(
                adir, manifest=MANIFEST_PATH,
                run_log=(os.environ.get("OPS_RUN_LOG") or "").strip() or None)
        except SystemExit as e:
            add("setup", "critical", f"cannot open the archive: {e}")
            return None
    import psycopg2
    dsn = (os.environ.get("WAREHOUSE_DSN") or "").strip()
    if not dsn:
        add("setup", "critical",
            "WAREHOUSE_DSN not set - the verifier cannot verify anything")
        return None
    try:
        return psycopg2.connect(dsn, keepalives=1, keepalives_idle=30,
                                keepalives_interval=10, keepalives_count=3)
    except Exception as e:  # noqa: BLE001
        add("setup", "critical", f"cannot connect to the warehouse: {e}")
        return None


# --------------------------------------------------------------- check 0
def check_receipts(cur, today: str) -> dict:
    """Returns {run_kind: exit_code or None-if-missing} for deferral logic."""
    states: dict = {}
    cur.execute("SELECT to_regclass('etl_run_log') IS NOT NULL")
    if not cur.fetchone()[0]:
        add("0-receipts", "warning",
            "etl_run_log does not exist yet - the loud-failure wrapper has "
            "not produced its first receipt. Checks 1-2 still verify the "
            "data directly.")
        return states
    for kind, label in (("daily-export", "08:15 daily export"),
                        ("deep-pull", "03:00 deep pull")):
        cur.execute(
            "SELECT exit_code, feeds_failed, rows_written, finished_at "
            "FROM etl_run_log WHERE run_kind=%s "
            "AND started_at::date = %s::date "
            "ORDER BY finished_at DESC LIMIT 1", (kind, today))
        row = cur.fetchone()
        if row is None:
            states[kind] = None
            cur.execute("SELECT count(*) FROM etl_run_log WHERE run_kind=%s",
                        (kind,))
            if cur.fetchone()[0]:
                add("0-receipts", "critical",
                    f"no receipt from the {label} today - the run either "
                    "never started or died before writing anything",
                    kind, klass="0-receipts-missing")
            else:
                add("0-receipts", "warning",
                    f"no {label} receipt yet (wrapper newly deployed)", kind)
            continue
        exit_code, feeds_failed, rows_written, finished = row
        states[kind] = exit_code
        if exit_code:
            add("0-receipts", "critical",
                f"{label} receipt says exit {exit_code} with "
                f"{feeds_failed} failed feed(s) - see its run log", kind)
        elif not rows_written:
            # 25 Aug 2026: Neon hit its 512 MB cap and rejected every
            # insert. The receipt row said exit 0 with 0 rows and every
            # feed failed -- because etl_receipt.finalize() persisted the
            # INNER run's exit code, not its own verdict -- and this check
            # called it "ok" while the workflow itself was red. Exit 0 is
            # not evidence on its own: a run that persisted nothing did
            # not work, whatever it reports about itself. Non-timing, so
            # it alerts at 09:30 rather than deferring -- there is nothing
            # a later recheck could change about a finished, empty run.
            add("0-receipts", "critical",
                f"{label} reports exit 0 but wrote ZERO rows "
                f"({feeds_failed} failed feed(s), finished {finished}) - "
                "the run persisted nothing to the store", kind,
                klass="0-receipts-empty")
        elif feeds_failed:
            add("0-receipts", "critical",
                f"{label} reports exit 0 but {feeds_failed} feed(s) "
                f"failed ({rows_written} rows written, finished "
                f"{finished}) - see its run log", kind,
                klass="0-receipts-failed-feeds")
        else:
            add("0-receipts", "ok",
                f"{label}: exit 0, {rows_written} rows written, "
                f"finished {finished}", kind)
    return states


# ----------------------------------------------------------- checks 1+2
def check_feeds(cur, manifest: dict, today: str, receipt_states: dict):
    cur.execute("SELECT feed, max(pull_date)::text FROM etl_feed_rows "
                "GROUP BY feed")
    latest = dict(cur.fetchall())
    cur.execute("SELECT feed, count(*) FROM etl_feed_rows "
                "WHERE pull_date=%s::date GROUP BY feed", (today,))
    today_rows = dict(cur.fetchall())

    for f in manifest["feeds"]:
        name, status = f["name"], f["status"]
        if status == "known_broken":
            add("1-landed", "known_broken",
                f"not verified (known_broken: {f.get('note', '')})", name)
            continue
        dom = domain_of(name)
        sev = "critical" if dom in PRIORITY_DOMAINS else "warning"
        lp = latest.get(name)
        wf = f.get("workflow", "daily-export")
        # Feed missing while its producing run has no receipt today: the
        # run may still be in flight -> timing-deferrable in the morning.
        inflight = receipt_states.get(wf, "no-table") is None
        if lp is None:
            add("1-landed", sev, "feed has NEVER landed in Postgres", name,
                klass="1-landed-inflight" if inflight else "1-landed")
            continue
        age = (date.fromisoformat(today) - date.fromisoformat(lp)).days
        if age > f.get("cadence_days", 1) - 1:
            add("1-landed", sev,
                f"last pull {lp} ({age}d old) - expected today", name,
                klass="1-landed-inflight" if inflight else "1-landed")
            continue
        add("1-landed", "ok", f"landed {lp}", name)

        n = today_rows.get(name, 0)
        floor = f.get("min_rows", 1)
        if n < floor:
            add("2-rows", sev,
                f"{n} rows today, below the manifest floor {floor}", name)
            continue
        cur.execute(
            "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY c) FROM "
            "(SELECT count(*) c FROM etl_feed_rows WHERE feed=%s "
            " AND pull_date < %s::date AND pull_date >= %s::date - 14 "
            " GROUP BY pull_date) t", (name, today, today))
        med = cur.fetchone()[0]
        cur.execute(
            "SELECT count(DISTINCT pull_date) FROM etl_feed_rows "
            "WHERE feed=%s AND pull_date < %s::date", (name, today))
        hist_days = cur.fetchone()[0]
        basis = "trailing 14-day median"
        if med is None or hist_days < 4:
            med = f.get("median_rows_at_calibration")
            basis = "calibration median (Neon history thin after trim)"
        if med:
            if n < 0.5 * med or n > 3 * med:
                add("2-rows", "warning",
                    f"{n} rows today vs {basis} {int(med)} - outside the "
                    "0.5x-3x band", name)
            else:
                add("2-rows", "ok", f"{n} rows (median {int(med)})", name)
        else:
            add("2-rows", "ok", f"{n} rows (no median available)", name)

    # ------------------------------------------------------- check 5
    man_names = {f["name"] for f in manifest["feeds"]}
    for feed in sorted(set(today_rows) - man_names):
        add("5-unmanifested", "warning",
            f"feed landed {today_rows[feed]} rows today but is NOT in the "
            "manifest - add it (or mark known_broken) so it stops flying "
            "blind", feed)


# --------------------------------------------------------------- check 3
def check_event_dates(cur, manifest: dict, today: str):
    for f in manifest["feeds"]:
        field = f.get("event_date_field")
        if not field or f["status"] != "expected":
            continue
        name = f["name"]
        window = int(f.get("event_fresh_days", 7))
        try:
            if f.get("event_date_format") == "uk":
                cur.execute(
                    "SELECT max(to_date(substring(data->>%s,1,10),"
                    "'DD/MM/YYYY'))::text FROM etl_feed_rows "
                    "WHERE feed=%s "
                    "AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows"
                    " WHERE feed=%s) "
                    "AND data->>%s ~ %s",
                    (field, name, name, field,
                     r"^\d{2}/\d{2}/\d{4}"))
            else:
                cur.execute(
                    "SELECT left(max(nullif(data->>%s,'')),10) "
                    "FROM etl_feed_rows WHERE feed=%s "
                    "AND pull_date=(SELECT max(pull_date) FROM etl_feed_rows"
                    " WHERE feed=%s)", (field, name, name))
            mx = (cur.fetchone() or [None])[0]
        except Exception as e:  # noqa: BLE001
            add("3-events", "warning",
                f"could not read max({field}): {e}", name)
            continue
        if not mx:
            add("3-events", "warning",
                f"no parseable {field} values in the latest pull", name)
            continue
        try:
            age = (date.fromisoformat(today) - date.fromisoformat(mx)).days
        except ValueError:
            add("3-events", "warning",
                f"unparseable max {field}: {mx!r}", name)
            continue
        if age > window:
            add("3-events", "warning",
                f"newest {field} is {mx} ({age}d old, window {window}d) - "
                "pulls are landing but the content looks frozen", name)
        else:
            add("3-events", "ok", f"newest {field} {mx} ({age}d old)", name)


# -------------------------------------------------------------- check 4a
def check_snapshot(cur):
    cur.execute("SELECT max(pull_date)::text FROM etl_feed_rows")
    pg_latest = cur.fetchone()[0]
    idx = None
    for attempt in range(3):
        try:
            idx = fetch_json(RAW_BASE + "snapshot_index.json")
            break
        except Exception as e:  # noqa: BLE001
            if attempt == 2:
                add("4a-snapshot", "critical",
                    f"cannot fetch snapshot_index.json from raw GitHub "
                    f"after 3 tries: {e}", klass="4a-snapshot")
                return pg_latest, None
            time.sleep(60)
    snap_latest = (idx or {}).get("latest")
    if snap_latest != pg_latest:
        time.sleep(120)   # raw has a ~5-minute cache (architecture doc §12)
        try:
            idx = fetch_json(RAW_BASE + "snapshot_index.json")
            snap_latest = idx.get("latest")
        except Exception:  # noqa: BLE001
            pass
    if snap_latest == pg_latest:
        add("4a-snapshot", "ok",
            f"dashboard snapshot {snap_latest} matches Postgres {pg_latest}")
    else:
        add("4a-snapshot", "critical",
            f"dashboard says latest data is {snap_latest} but Postgres "
            f"says {pg_latest} - the bake failed, baked stale, or the "
            "commit never landed", klass="4a-snapshot")
    try:
        pages = fetch_json(PAGES_INDEX)
        if pages.get("latest") != snap_latest:
            add("4a-snapshot", "info",
                f"Pages CDN still serving {pages.get('latest')} "
                "(propagation lag - normal for up to ~an hour)")
    except Exception as e:  # noqa: BLE001
        add("4a-snapshot", "info", f"Pages fetch failed (informative): {e}")
    return pg_latest, snap_latest


# -------------------------------------------------------------- check 4b
def _snapshot_aggregates(snap: dict) -> dict:
    tasks = (snap.get("tasks") or {}).get("cells") or []
    week = (snap.get("supply") or {}).get("week_spend") or []
    broth = ((snap.get("quality") or {}).get("broth") or {}).get("cells") or []
    issues = (snap.get("suppliers") or {}).get("issues") or []
    outstanding = (snap.get("training") or {}).get("outstanding") or []
    return {
        "tasks_on_time": sum(c.get("on_time") or 0 for c in tasks),
        "tasks_missed": sum(c.get("missed") or 0 for c in tasks),
        "week_spend_gbp": round(sum(w.get("value_gbp") or 0 for w in week), 2),
        "broth_cells": len(broth),
        "supplier_issues": len(issues),
        "training_outstanding": len(outstanding),
    }


def check_consistency(pg_latest: str, snap_latest: str):
    """Run the REAL builder into a temp dir; compare aggregates with live.

    Returns the recomputed snapshot dict (for the aggregates archive), or
    None if the recompute failed.
    """
    if snap_latest != pg_latest:
        add("4b-consistency", "info",
            "skipped - check 4a already failing, nothing meaningful to "
            "compare until the snapshot is fresh")
        return None
    tmp = tempfile.mkdtemp(prefix="verify_recompute_")
    local_snap = None
    try:
        os.makedirs(os.path.join(tmp, "builders"), exist_ok=True)
        shutil.copy(os.path.join(HERE, "bake_ops_command.py"),
                    os.path.join(tmp, "builders", "bake_ops_command.py"))
        # In archive mode the copied bake imports archive_source from ITS OWN
        # directory (the subprocess inherits OPS_WAREHOUSE_SOURCE and an
        # absolute OPS_ARCHIVE_DIR from this process) - without this copy the
        # recompute dies on ModuleNotFoundError, which is exactly how it
        # failed on first test. Copied unconditionally: harmless in Postgres
        # mode, required in archive mode.
        shutil.copy(os.path.join(HERE, "archive_source.py"),
                    os.path.join(tmp, "builders", "archive_source.py"))
        # The builder reads maintenance_source.json from its OUT_DIR, and the
        # archive-mode feed map falls back to the manifest for names.
        os.makedirs(os.path.join(tmp, "data", "ops_command"), exist_ok=True)
        if os.path.exists(MAINT_PATH):
            shutil.copy(MAINT_PATH, os.path.join(
                tmp, "data", "ops_command", "maintenance_source.json"))
        if os.path.exists(MANIFEST_PATH):
            shutil.copy(MANIFEST_PATH, os.path.join(
                tmp, "data", "ops_command", "feeds_manifest.json"))
        r = subprocess.run(
            [sys.executable, os.path.join(tmp, "builders",
                                          "bake_ops_command.py")],
            capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            add("4b-consistency", "critical",
                "recompute failed - the builder exited "
                f"{r.returncode}: {(r.stderr or r.stdout)[-300:]}",
                klass="4b-consistency")
            return None
        path = os.path.join(tmp, "data", "ops_command",
                            f"snapshot_{pg_latest}.json")
        with open(path, encoding="utf-8") as fh:
            local_snap = json.load(fh)
    except Exception as e:  # noqa: BLE001
        add("4b-consistency", "critical",
            f"recompute could not run: {e}", klass="4b-consistency")
        return None
    finally:
        # keep the temp dir only long enough to read; the snapshot dict
        # survives in memory for the aggregates archive
        shutil.rmtree(tmp, ignore_errors=True)

    try:
        live = fetch_json(RAW_BASE + f"snapshot_{pg_latest}.json", timeout=30)
    except Exception as e:  # noqa: BLE001
        add("4b-consistency", "critical",
            f"could not fetch the live snapshot to compare: {e}",
            klass="4b-consistency")
        return local_snap

    mine, theirs = _snapshot_aggregates(local_snap), _snapshot_aggregates(live)
    diffs = [f"{k}: live {theirs[k]} vs recomputed {mine[k]}"
             for k in mine if mine[k] != theirs[k]]
    if diffs:
        add("4b-consistency", "critical",
            "live dashboard aggregates do not match a fresh recompute from "
            "Postgres - " + "; ".join(diffs) + " (a builder deploy after "
            "the 09:00 bake causes this legitimately - rebake via "
            "workflow_dispatch if so)", klass="4b-consistency")
    else:
        add("4b-consistency", "ok",
            "recomputed aggregates match the live snapshot exactly: " +
            ", ".join(f"{k}={v}" for k, v in mine.items()))
    return local_snap


# --------------------------------------------------------------- check 6
def check_side_channels(cur, today: str) -> dict:
    sizes = {}
    try:
        with open(MAINT_PATH, encoding="utf-8") as fh:
            m = json.load(fh)
        pulled = (m.get("pulled_at") or "")[:10]
        age = (date.fromisoformat(today) - date.fromisoformat(pulled)).days \
            if pulled else None
        sizes["maintenance_pulled_at"] = m.get("pulled_at")
        sizes["maintenance_source_as_of"] = m.get("source_as_of")
        if age is None:
            add("6-side", "warning",
                "maintenance_source.json has no pulled_at date")
        elif age > MAINT_AGE_WARN_DAYS:
            add("6-side", "warning",
                f"maintenance_source.json last pulled {pulled} ({age}d ago) "
                "- the refresh chain may be dead (its daily 08:00 task "
                "skips commits when the sheet is unchanged, but a week of "
                "silence is worth checking)")
        else:
            add("6-side", "ok",
                f"maintenance source pulled {pulled} ({age}d ago), "
                f"sheet content as of {m.get('source_as_of')}")
    except FileNotFoundError:
        add("6-side", "warning", "maintenance_source.json missing from the "
            "repo - the Maintenance tab is dark")
    except Exception as e:  # noqa: BLE001
        add("6-side", "warning", f"maintenance_source.json unreadable: {e}")

    if ARCHIVE_MODE:
        # pg_database_size and the 512 MB Neon cap mean nothing against the
        # archive. The store here is the git repo, whose practical comfort
        # bound is ~5 GB; the archive grows ~1.7 GB/year, so this is a slow
        # drift warning rather than tomorrow's outage.
        adir = os.environ.get("OPS_ARCHIVE_DIR") or ""
        total = 0
        for root, _dirs, files in os.walk(adir):
            for fn in files:
                try:
                    total += os.path.getsize(os.path.join(root, fn))
                except OSError:
                    pass
        arch_mb = round(total / 1e6)
        sizes["archive_mb"] = arch_mb
        if arch_mb > 4000:
            add("6-side", "warning",
                f"pull archive is {arch_mb} MB - approaching the ~5 GB point "
                "where a git repo gets unwieldy; plan a yearly split or a "
                "Parquet conversion")
        else:
            add("6-side", "ok",
                f"pull archive {arch_mb} MB on disk (~1.7 GB/year growth; "
                "repo comfort bound ~5 GB)")
        return sizes

    cur.execute("SELECT pg_database_size(current_database())")
    db_bytes = cur.fetchone()[0]
    db_mb = round(db_bytes / 1e6)
    sizes["db_mb"] = db_mb
    if db_mb > DB_SIZE_CRIT_MB:
        add("6-side", "critical",
            f"warehouse database is {db_mb} MB against a 512 MB Neon cap - "
            "the next pull is likely to be REJECTED outright (DiskFull). "
            "Dispatch warehouse-archive.yml with vacuum_full now",
            klass="6-store-capacity")
    elif db_mb > DB_SIZE_WARN_MB:
        add("6-side", "warning",
            f"warehouse database is {db_mb} MB - Neon free cap is 512 MB; "
            "check the archive+trim job (warehouse-archive.yml) and "
            "consider a vacuum_full dispatch")
    else:
        add("6-side", "ok", f"warehouse database {db_mb} MB "
            f"(warn at {DB_SIZE_WARN_MB}, critical at {DB_SIZE_CRIT_MB}, "
            "Neon cap 512)")
    return sizes


# ------------------------------------------------- aggregates archive
AGG_DDL = """
CREATE TABLE IF NOT EXISTS ops_daily_aggregates (
    metric_date date NOT NULL,
    site text NOT NULL,
    metric text NOT NULL,
    v1 numeric,
    v2 numeric,
    v3 numeric,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (metric_date, site, metric)
);
"""


def archive_aggregates(conn, snap: dict | None) -> None:
    """Upsert per-site daily aggregates from the recomputed snapshot.

    This is the approved retention archive (plan §5): a few hundred tiny
    rows a day that outlive the raw feeds' trimmed windows, so on-time %,
    broth readings and issue counts finally accumulate real history.
    Upserting every cell the snapshot carries (each covers a trailing
    window) back-fills and self-heals after any gap.
    """
    if snap is None:
        add("aggregates", "warning",
            "no recomputed snapshot available - aggregates archive not "
            "updated this run")
        return
    rows = []
    for c in (snap.get("tasks") or {}).get("cells") or []:
        if c.get("site") and c.get("d"):
            rows.append((c["d"], c["site"], "tasks",
                         c.get("on_time") or 0, c.get("missed") or 0, None))
    for c in ((snap.get("quality") or {}).get("broth") or {}).get("cells") or []:
        if c.get("site") and c.get("d") and c.get("kind"):
            rows.append((c["d"], c["site"], f"broth_{c['kind']}",
                         c.get("value"), c.get("checks") or 0,
                         c.get("checks_missed") or 0))
    per = {}
    for i in (snap.get("suppliers") or {}).get("issues") or []:
        if i.get("site") and i.get("d"):
            k = (i["d"], i["site"])
            tot, op = per.get(k, (0, 0))
            per[k] = (tot + 1, op + (1 if i.get("open") else 0))
    for (d, site), (tot, op) in per.items():
        rows.append((d, site, "supplier_issues", tot, op, None))
    if not rows:
        add("aggregates", "warning",
            "recomputed snapshot had no aggregatable cells - nothing "
            "written to ops_daily_aggregates")
        return
    if ARCHIVE_MODE:
        # The aggregates keep the same upsert semantics, but the store is a
        # committed JSONL beside the snapshots rather than a Postgres table.
        # Everything in it derives from the PUBLIC snapshot (that is what
        # `snap` is), so it belongs in this public repo; committing is the
        # bake workflow's job, same as health_latest.json.
        try:
            path = os.path.join(OUT_DIR, "ops_daily_aggregates.jsonl")
            current: dict = {}
            if os.path.exists(path):
                with open(path, encoding="utf-8") as fh:
                    for line in fh:
                        if line.strip():
                            r = json.loads(line)
                            current[(r["metric_date"], r["site"],
                                     r["metric"])] = r
            for d, site, metric, v1, v2, v3 in rows:
                current[(d, site, metric)] = {
                    "metric_date": d, "site": site, "metric": metric,
                    "v1": v1, "v2": v2, "v3": v3, "updated_at": utcnow()}
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                for k in sorted(current):
                    fh.write(json.dumps(current[k], ensure_ascii=False,
                                        separators=(",", ":"),
                                        default=str) + "\n")
            os.replace(tmp, path)
            add("aggregates", "ok",
                f"{len(rows)} per-site daily aggregate rows upserted into "
                f"ops_daily_aggregates.jsonl ({len(current)} total)")
        except Exception as e:  # noqa: BLE001
            add("aggregates", "critical",
                f"ops_daily_aggregates.jsonl upsert failed: {e}",
                klass="aggregates-write")
        return
    try:
        with conn.cursor() as cur:
            cur.execute(AGG_DDL)
            cur.executemany(
                "INSERT INTO ops_daily_aggregates "
                "(metric_date, site, metric, v1, v2, v3) "
                "VALUES (%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT (metric_date, site, metric) DO UPDATE SET "
                "v1=EXCLUDED.v1, v2=EXCLUDED.v2, v3=EXCLUDED.v3, "
                "updated_at=now()", rows)
        conn.commit()
        add("aggregates", "ok",
            f"{len(rows)} per-site daily aggregate rows upserted "
            "(tasks, broth, supplier issues)")
    except Exception as e:  # noqa: BLE001
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001
            pass
        # Not a warning: this write is the only durable history the system
        # keeps beyond each feed's rolling window, and on 25 Aug 2026 its
        # failure carried the same Neon DiskFull error that had already
        # eaten the whole day's pull -- the earliest, clearest signal
        # available, filed as a warning nobody was paged for.
        add("aggregates", "critical",
            f"ops_daily_aggregates upsert failed: {e}",
            klass="aggregates-write")


# ------------------------------------------------------------ history
def update_history(entry: dict) -> list:
    try:
        with open(HISTORY_PATH, encoding="utf-8") as fh:
            hist = json.load(fh).get("runs", [])
    except Exception:  # noqa: BLE001
        hist = []
    key = (entry["date"], entry["mode"])
    hist = [h for h in hist if (h.get("date"), h.get("mode")) != key]
    hist.append(entry)
    hist = sorted(hist, key=lambda h: (h.get("date", ""),
                                       h.get("mode", "")))[-60:]
    with open(HISTORY_PATH, "w", encoding="utf-8") as fh:
        json.dump({"runs": hist}, fh, indent=1)
        fh.write("\n")
    return hist


def day_verdicts(hist: list) -> dict:
    """date -> final overall for that day (recheck wins over morning)."""
    out = {}
    for h in hist:
        d = h.get("date")
        if not d:
            continue
        if d not in out or h.get("mode") == "recheck":
            out[d] = h.get("overall", "unknown")
    return out


# --------------------------------------------------------------- ntfy
def push_ntfy(title: str, body: str, priority: str = "high") -> bool:
    topic = (os.environ.get("NTFY_TOPIC") or "").strip()
    if not topic:
        print(f"NTFY_TOPIC not set - no push ({title})")
        return False
    try:
        req = urllib.request.Request(
            f"https://ntfy.sh/{topic}", data=body.encode("utf-8"),
            headers={"Title": title, "Priority": priority,
                     "Tags": "rotating_light" if priority == "high"
                             else "white_check_mark",
                     "User-Agent": "ops-verify"})
        urllib.request.urlopen(req, timeout=15).read()
        print(f"ntfy push sent: {title}")
        return True
    except Exception as e:  # noqa: BLE001
        print(f"ntfy push FAILED ({e}) - GitHub email is the backstop")
        return False


# ---------------------------------------------------------------- main
def main() -> None:
    today = date.today().isoformat()
    now = datetime.now(timezone.utc)
    mode = "recheck" if now.hour >= 11 else "morning"
    with open(MANIFEST_PATH, encoding="utf-8") as f:
        manifest = json.load(f)

    conn = connect()
    pg_latest = snap_latest = None
    sizes: dict = {}
    if conn is not None:
        try:
            with conn.cursor() as cur:
                receipt_states = check_receipts(cur, today)
                check_feeds(cur, manifest, today, receipt_states)
                check_event_dates(cur, manifest, today)
                pg_latest, snap_latest = check_snapshot(cur)
                sizes = check_side_channels(cur, today)
            recomputed = check_consistency(pg_latest, snap_latest)
            archive_aggregates(conn, recomputed)
        finally:
            conn.close()

    # ---- deferral: morning run parks timing-class criticals ----------
    deferred = []
    if mode == "morning":
        for r in RESULTS:
            if r["level"] == "critical" and r.get("class") in DEFERRABLE:
                r["level"] = "deferred"
                r["detail"] += "  [deferred - rechecked at 12:00 UTC]"
                deferred.append(r)

    criticals = [r for r in RESULTS if r["level"] == "critical"]
    warnings = [r for r in RESULTS if r["level"] == "warning"]
    overall = ("red" if criticals else
               "amber" if (warnings or deferred) else "green")

    known_broken = [{"name": f["name"], "note": f.get("note", "")}
                    for f in manifest["feeds"]
                    if f["status"] == "known_broken"]
    health = {
        "verifier_version": 2,
        "generated_at": utcnow(),
        "verified_date": today,
        "mode": mode,
        "overall": overall,
        "postgres_latest": pg_latest,
        "snapshot_latest": snap_latest,
        "sizes": sizes,
        "counts": {
            "expected_feeds": sum(1 for f in manifest["feeds"]
                                  if f["status"] == "expected"),
            "known_broken": len(known_broken),
            "criticals": len(criticals),
            "warnings": len(warnings),
            "deferred": len(deferred),
        },
        "criticals": criticals,
        "warnings": warnings,
        "deferred": deferred,
        "known_broken": known_broken,
        "results": RESULTS,
        "basis": ("verify_ops_data.py v2 checks 0/1/2/3/4a/4b/5/6 against "
                  "Neon Postgres and raw.githubusercontent.com; manifest v"
                  f"{manifest.get('version')} calibrated "
                  f"{manifest.get('calibrated')}; "
                  f"{mode} run (morning defers timing-class failures to "
                  "the 12:00 UTC recheck)"),
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(HEALTH_PATH, "w", encoding="utf-8") as f:
        json.dump(health, f, indent=1, ensure_ascii=False)
        f.write("\n")

    hist = update_history({
        "date": today, "mode": mode, "overall": overall,
        "criticals": len(criticals), "warnings": len(warnings),
        "deferred": len(deferred), "at": health["generated_at"]})

    print("\n" + "=" * 70)
    print(f"OPS DATA VERIFICATION  {today}  ({mode})  ->  {overall.upper()}")
    print("=" * 70)
    for r in RESULTS:
        if r["level"] in ("critical", "warning", "deferred"):
            print(f"  {r['level'].upper():<9} [{r['check']}] "
                  f"{r.get('feed', '')}: {r['detail']}")
    ok_n = sum(1 for r in RESULTS if r["level"] == "ok")
    print(f"  ({ok_n} ok, {len(warnings)} warnings, {len(deferred)} "
          f"deferred, {len(criticals)} criticals)")
    print("=" * 70)

    # ---- Monday alive-push (morning run only) ------------------------
    if mode == "morning" and now.weekday() == 0:
        verdicts = day_verdicts(hist)
        last7 = [verdicts.get((date.today() - timedelta(days=i)).isoformat())
                 for i in range(1, 8)]
        greens = sum(1 for v in last7 if v in ("green", "amber"))
        counted = sum(1 for v in last7 if v)
        exp = health["counts"]["expected_feeds"]
        push_ntfy(
            "Ops verifier alive",
            f"verifier alive - {greens}/{counted or 7} days without a red "
            f"verdict - {exp} feeds under test, "
            f"{health['counts']['known_broken']} known_broken - today: "
            f"{overall}", priority="default")

    if criticals:
        lines = [f"{c.get('feed', c['check'])}: {c['detail']}"
                 for c in criticals[:5]]
        if len(criticals) > 5:
            lines.append(f"...and {len(criticals) - 5} more")
        if push_ntfy("Ops data verification FAILED",
                     f"({today}, {mode} run)\n" + "\n".join(lines) +
                     "\nhttps://github.com/MakiManc/ops/actions"):
            with open(".ntfy_sent", "w", encoding="utf-8") as f:
                f.write(utcnow())
        sys.exit(1)
    if deferred:
        print(f"{len(deferred)} timing-class failure(s) deferred to the "
              "12:00 UTC recheck - no alert yet")


if __name__ == "__main__":
    main()
