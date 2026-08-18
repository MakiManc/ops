#!/usr/bin/env python3
"""
verify_ops_data.py -- the daily verification spine (verify.yml, 09:30 UTC).

Every daily process in this system must either prove it worked or fail
loudly, and "proved it worked" is always measured at the DESTINATION --
Neon Postgres and the live dashboard -- never at a workflow's own exit
code. This script is the safety net under the ETL's own loud-failure
receipts (etl_receipt.py in ross440/maki-hospitality-etl).

Driven by data/ops_command/feeds_manifest.json -- the single home for the
system's expectations. Phase 1 checks:

  check 0  RUN RECEIPTS   etl_run_log has a receipt for today's
                          daily-export and deep-pull runs, with exit 0.
                          Distinguishes "never ran" from "ran and wrote
                          nothing" without cross-repo API auth.
  check 1  FEEDS LANDED   every status=expected feed's max(pull_date) is
                          today (cadence_days tolerance). Measured in
                          Postgres -- catches a green workflow whose
                          writes went nowhere (the §13 failure class).
  check 2  ROWS SANE      today's rows >= the manifest floor, and within
                          a band (0.5x..3x) of the trailing 14-day median
                          (self-calibrating; falls back to the manifest's
                          calibration median while Neon history is thin
                          post-trim). Floor breach on a priority domain is
                          critical; band drift is always a warning.
  check 4a SNAPSHOT FRESH the live dashboard's snapshot_index.json says
                          the same latest data date as Postgres. A legit
                          no-new-data day matches on both sides and stays
                          quiet -- this kills the weekend false alarm at
                          the root. Fetched from raw.githubusercontent.com
                          (Pages CDN lag up to ~an hour is documented and
                          normal, so Pages is checked second, informative
                          only).

Severity policy (locked in the approved plan): CRITICAL -> one ntfy push +
non-zero exit (GitHub failure email rides the red workflow); WARNING ->
recorded in health_latest.json only, no push. Priority domains (GC
compliance, Kobas supply) go critical; Training/Flow starts as warnings.
Zero and unknown must never look alike: every check's result -- ok,
warning, critical, or skipped-with-reason -- lands in health_latest.json,
which the dashboard's staleness banner and (Phase 2) Data Health tab read.

Env: WAREHOUSE_DSN (required), NTFY_TOPIC (optional -- degrades to log).
Writes: data/ops_command/health_latest.json (committed by verify.yml).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from datetime import date, datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "data", "ops_command")
MANIFEST_PATH = os.path.join(OUT_DIR, "feeds_manifest.json")
HEALTH_PATH = os.path.join(OUT_DIR, "health_latest.json")

RAW_INDEX = ("https://raw.githubusercontent.com/ross440/ops/main/"
             "data/ops_command/snapshot_index.json")
PAGES_INDEX = ("https://ross440.github.io/ops/data/ops_command/"
               "snapshot_index.json")

# Domain -> alert level for a missing/short feed. Priority domains are
# critical from day one; Training starts as warnings (Ross's ranking).
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


def add(check: str, level: str, detail: str, feed: str | None = None):
    RESULTS.append({"check": check, "level": level,
                    **({"feed": feed} if feed else {}), "detail": detail})


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_json(url: str, timeout: int = 20):
    req = urllib.request.Request(url + f"?cb={int(time.time())}",
                                 headers={"User-Agent": "ops-verify"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def connect():
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


def check_receipts(cur, today: str):
    cur.execute("SELECT to_regclass('etl_run_log') IS NOT NULL")
    if not cur.fetchone()[0]:
        add("0-receipts", "warning",
            "etl_run_log does not exist yet - the loud-failure wrapper has "
            "not produced its first receipt (expected on the first run "
            "after deploy). Checks 1-2 still verify the data directly.")
        return
    for kind, label in (("daily-export", "08:15 daily export"),
                        ("deep-pull", "03:00 deep pull")):
        cur.execute(
            "SELECT exit_code, feeds_failed, rows_written, finished_at "
            "FROM etl_run_log WHERE run_kind=%s "
            "AND started_at::date = %s::date "
            "ORDER BY finished_at DESC LIMIT 1", (kind, today))
        row = cur.fetchone()
        if row is None:
            cur.execute("SELECT count(*) FROM etl_run_log WHERE run_kind=%s",
                        (kind,))
            ever = cur.fetchone()[0]
            if ever:
                add("0-receipts", "critical",
                    f"no receipt from the {label} today - the run either "
                    "never started or died before writing anything", kind)
            else:
                add("0-receipts", "warning",
                    f"no {label} receipt yet (wrapper newly deployed - "
                    "expected to appear after its next scheduled run)", kind)
            continue
        exit_code, feeds_failed, rows_written, finished = row
        if exit_code:
            add("0-receipts", "critical",
                f"{label} receipt says exit {exit_code} with "
                f"{feeds_failed} failed feed(s) - see its run log", kind)
        else:
            add("0-receipts", "ok",
                f"{label}: exit 0, {rows_written} rows written, "
                f"finished {finished}", kind)


def check_feeds(cur, manifest: dict, today: str):
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
        if lp is None:
            add("1-landed", sev,
                "feed has NEVER landed in Postgres", name)
            continue
        age = (date.fromisoformat(today) - date.fromisoformat(lp)).days
        if age > f.get("cadence_days", 1) - 1:
            add("1-landed", sev,
                f"last pull {lp} ({age}d old) - expected today", name)
            continue
        add("1-landed", "ok", f"landed {lp}", name)

        # ---- check 2: row counts, only for feeds that landed today ----
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


def check_snapshot(cur):
    cur.execute("SELECT max(pull_date)::text FROM etl_feed_rows")
    pg_latest = cur.fetchone()[0]
    idx = None
    for attempt in range(3):
        try:
            idx = fetch_json(RAW_INDEX)
            break
        except Exception as e:  # noqa: BLE001
            if attempt == 2:
                add("4a-snapshot", "critical",
                    f"cannot fetch snapshot_index.json from raw GitHub "
                    f"after 3 tries: {e}")
                return pg_latest, None
            time.sleep(60)
    snap_latest = (idx or {}).get("latest")
    if snap_latest != pg_latest:
        # One retry after a pause: Pipe 9 commits ~09:00-09:01; raw has a
        # ~5-minute cache (documented in the architecture doc, §12).
        time.sleep(120)
        try:
            idx = fetch_json(RAW_INDEX)
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
            "commit never landed")
    # Pages CDN view - informative only, its lag is documented as normal.
    try:
        pages = fetch_json(PAGES_INDEX)
        if pages.get("latest") != snap_latest:
            add("4a-snapshot", "info",
                f"Pages CDN still serving {pages.get('latest')} "
                "(propagation lag - normal for up to ~an hour)")
    except Exception as e:  # noqa: BLE001
        add("4a-snapshot", "info", f"Pages fetch failed (informative): {e}")
    return pg_latest, snap_latest


def push_ntfy(criticals: list[dict]) -> bool:
    topic = (os.environ.get("NTFY_TOPIC") or "").strip()
    if not topic:
        print("NTFY_TOPIC not set - no push (GitHub email still fires on "
              "the red workflow)")
        return False
    lines = [f"{c.get('feed', c['check'])}: {c['detail']}"
             for c in criticals[:5]]
    if len(criticals) > 5:
        lines.append(f"...and {len(criticals) - 5} more")
    body = ("Ops data verification FAILED "
            f"({date.today().isoformat()}):\n" + "\n".join(lines) +
            "\nhttps://github.com/ross440/ops/actions")
    try:
        req = urllib.request.Request(
            f"https://ntfy.sh/{topic}", data=body.encode("utf-8"),
            headers={"Title": "Ops data verification FAILED",
                     "Priority": "high", "Tags": "rotating_light",
                     "User-Agent": "ops-verify"})
        urllib.request.urlopen(req, timeout=15).read()
        print("ntfy push sent")
        return True
    except Exception as e:  # noqa: BLE001
        print(f"ntfy push FAILED ({e}) - GitHub failure email is the "
              "backstop")
        return False


def main() -> None:
    today = date.today().isoformat()
    with open(MANIFEST_PATH, encoding="utf-8") as f:
        manifest = json.load(f)

    conn = connect()
    pg_latest = snap_latest = None
    if conn is not None:
        try:
            with conn.cursor() as cur:
                check_receipts(cur, today)
                check_feeds(cur, manifest, today)
                pg_latest, snap_latest = check_snapshot(cur)
        finally:
            conn.close()

    criticals = [r for r in RESULTS if r["level"] == "critical"]
    warnings = [r for r in RESULTS if r["level"] == "warning"]
    overall = ("red" if criticals else
               "amber" if warnings else "green")

    health = {
        "verifier_version": 1,
        "generated_at": utcnow(),
        "verified_date": today,
        "overall": overall,
        "postgres_latest": pg_latest,
        "snapshot_latest": snap_latest,
        "counts": {
            "expected_feeds": sum(1 for f in manifest["feeds"]
                                  if f["status"] == "expected"),
            "known_broken": sum(1 for f in manifest["feeds"]
                                if f["status"] == "known_broken"),
            "criticals": len(criticals),
            "warnings": len(warnings),
        },
        "criticals": criticals,
        "warnings": warnings,
        "results": RESULTS,
        "basis": ("verify_ops_data.py checks 0/1/2/4a against Neon Postgres "
                  "and raw.githubusercontent.com; manifest v"
                  f"{manifest.get('version')} calibrated "
                  f"{manifest.get('calibrated')}"),
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(HEALTH_PATH, "w", encoding="utf-8") as f:
        json.dump(health, f, indent=1, ensure_ascii=False)
        f.write("\n")

    print("\n" + "=" * 70)
    print(f"OPS DATA VERIFICATION  {today}  ->  {overall.upper()}")
    print("=" * 70)
    for r in RESULTS:
        if r["level"] in ("critical", "warning"):
            print(f"  {r['level'].upper():<9} [{r['check']}] "
                  f"{r.get('feed', '')}: {r['detail']}")
    ok_n = sum(1 for r in RESULTS if r["level"] == "ok")
    print(f"  ({ok_n} ok, {len(warnings)} warnings, "
          f"{len(criticals)} criticals; full detail in health_latest.json)")
    print("=" * 70)

    if criticals:
        if push_ntfy(criticals):
            # Marker in the workspace root (NOT data/, so it is never
            # committed): tells the workflow's backstop step a push has
            # already gone out, so a red run doesn't double-push.
            with open(".ntfy_sent", "w", encoding="utf-8") as f:
                f.write(utcnow())
        sys.exit(1)


if __name__ == "__main__":
    main()
