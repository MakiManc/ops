#!/usr/bin/env python3
"""Deep Flow completion dates: one parser, both engines, bake and verifier (09/10/2026).

The verifier warned "no parseable module_completed_date values in the latest
pull" every day once it moved onto the DuckDB archive. The data was fine -
'DD/MM/YYYY HH:MM' in every pull since 13/08/2026 - but the check filtered on
`data->>'module_completed_date' ~ '^\\d{2}/\\d{2}/\\d{4}'`, and DuckDB's `~` must
match the WHOLE value where Postgres' only searches. So 0 of 1,875 values
matched and the Training feed's freshness went unchecked.

Both the bake and the verifier now build the date with event_day_sql()
(substr/length/translate only - portable, no regex). This pins:
  1. the two copies are identical;
  2. what it accepts and refuses, evaluated by DuckDB itself;
  3. the verifier's check, run against a hand-built archive, reads the newest
     date instead of warning;
  4. the bake's completions survive the shapes a Flow export change could
     plausibly bring (seconds, '-' or '.' separators, ISO) and disclose what
     they cannot place rather than dropping it silently.

  python3 tests/deep_flow_dates_test.py      (exit 1 on any failure)
"""
from __future__ import annotations

import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "builders"))
import duckdb  # noqa: E402
import archive_source  # noqa: E402
import bake_ops_command as bake  # noqa: E402
import verify_ops_data as verify  # noqa: E402

failures = 0


def check(cond, msg):
    global failures
    print(("ok  : " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


print("-- one parser, two copies --")
check(bake.event_day_sql("x") == verify.event_day_sql("x"),
      "bake_ops_command.event_day_sql and verify_ops_data.event_day_sql are identical")

print("\n-- what it accepts and refuses (evaluated by DuckDB) --")
CASES = [
    ("04/10/2026 11:41", "2026-10-04", "Flow's shape today: DD/MM/YYYY HH:MM"),
    ("04/10/2026 11:41:07", "2026-10-04", "with seconds"),
    ("04/10/2026", "2026-10-04", "date only"),
    ("04-10-2026 11:41", "2026-10-04", "'-' separator"),
    ("04.10.2026", "2026-10-04", "'.' separator"),
    ("2026-10-04", "2026-10-04", "ISO date"),
    ("2026-10-04T11:41:07Z", "2026-10-04", "ISO timestamp"),
    ("2026-10-04 11:41:07+01:00", "2026-10-04", "ISO with a space and an offset"),
    ("31/12/2025 23:59", "2025-12-31", "the last day of a year, day-first"),
    ("4/10/2026 11:41", None, "a one-digit day is refused, not guessed"),
    ("04/10-2026", None, "mixed separators are refused"),
    ("13/13/2026", None, "month 13 is refused"),
    ("00/10/2026", None, "day 00 is refused"),
    ("ab/cd/efgh", None, "letters in the date positions are refused"),
    ("Monday", None, "free text is refused"),
    ("", None, "empty is NULL"),
    (None, None, "NULL is NULL"),
]
con = duckdb.connect()
expr = bake.event_day_sql("v")
for raw, want, label in CASES:
    got = con.execute(f"SELECT {expr} FROM (SELECT CAST(? AS VARCHAR) v)", [raw]).fetchone()[0]
    check(got == want, f"{label}: {raw!r} -> {want!r} (got {got!r})")
# The same SQL after the archive adapter's Postgres->DuckDB translation, which
# is the path both callers actually take in archive mode.
t = archive_source.translate("SELECT " + expr + " d FROM (SELECT %s v) x")
got = con.execute(t, ["04/10/2026 11:41"]).fetchone()[0]
check(got == "2026-10-04", f"and it survives archive_source.translate unchanged in meaning (got {got!r})")


def write_archive(root, pulls):
    for pull_date, feeds in pulls.items():
        d = os.path.join(root, pull_date)
        os.makedirs(d, exist_ok=True)
        names = {}
        for slug, (name, rows) in feeds.items():
            names[slug] = name
            with gzip.open(os.path.join(d, slug + ".jsonl.gz"), "wt") as fh:
                for i, r in enumerate(rows):
                    fh.write(json.dumps({"row_num": i, "data": r}) + "\n")
        with open(os.path.join(d, "_feeds.json"), "w") as fh:
            json.dump(names, fh)


def module(tid, name, cd, status="Complete"):
    return {"trainee_id": tid, "module_name": name, "module_status": status,
            "module_completed_date": cd, "module_due_date": None,
            "module_allocation_date": "01/09/2026"}


MODS = [
    module("t1", "Food Safety", "28/09/2026 10:00"),          # today's Flow shape
    module("t1", "Allergens", "29/09/2026 10:00:05"),          # seconds
    module("t2", "Food Safety", "2026-10-05T09:00:00Z"),      # ISO
    module("t2", "Fire Safety", "06.10.2026"),                 # dots
    module("t3", "Food Safety", "07/10/2026 08:00"),          # trainee t3 is not in Flow Trainees
    module("t1", "COSHH", "the seventh"),                      # unparseable
    module("t2", "Allergens", None, status="In Progress"),     # not complete - not counted
]
PULLS = {"2026-10-07": {
    "Deep_Flow_Modules": ("Deep Flow Modules", MODS),
    "Flow_Trainees": ("Flow Trainees", [{"id": "t1", "branch": "b1"}, {"id": "t2", "branch": "b2"}]),
    "Flow_Branches": ("Flow Branches", [{"id": "b1", "name": "Maki Test One"},
                                        {"id": "b2", "name": "Maki Test Two"}]),
}}

tmp = tempfile.mkdtemp(prefix="deepflow-")
arch = os.path.join(tmp, "warehouse_direct")
write_archive(arch, PULLS)

print("\n-- the verifier's 3-events check on the archive --")
conn = archive_source.connect(arch)
manifest = {"feeds": [{"name": "Deep Flow Modules", "status": "expected",
                       "event_date_field": "module_completed_date",
                       "event_date_format": "uk", "event_fresh_days": 21}]}
verify.RESULTS.clear()
with conn.cursor() as cur:
    verify.check_event_dates(cur, manifest, "2026-10-07")
res = [r for r in verify.RESULTS if r.get("feed") == "Deep Flow Modules"]
check(len(res) == 1 and res[0]["level"] == "ok",
      f"the check passes instead of warning 'no parseable' (got {res})")
check(res and "2026-10-07" in res[0]["detail"],
      "and it reads the newest completion, 07/10, across all the accepted shapes")

print("\n-- the bake's completions --")
out = os.path.join(tmp, "out")
os.makedirs(out)
shutil.copy(os.path.join(REPO, "data", "ops_command", "feeds_manifest.json"), out)
env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive", OPS_ARCHIVE_DIR=arch, OPS_OUT_DIR=out)
p = subprocess.run([sys.executable, os.path.join(REPO, "builders", "bake_ops_command.py"),
                    "--date", "2026-10-07"], env=env, capture_output=True, text=True)
check(p.returncode == 0, "the real builder bakes the fixture")
if p.returncode != 0:
    print(p.stdout[-2000:], p.stderr[-2000:])
else:
    snap = json.load(open(os.path.join(out, "snapshot_2026-10-07.json")))
    tr = snap["training"]
    comp = {(c["d"], c["site"]): c["n"] for c in tr["completions"]}
    check(comp == {("2026-09-28", "Maki Test One"): 1, ("2026-09-29", "Maki Test One"): 1,
                   ("2026-10-05", "Maki Test Two"): 1, ("2026-10-06", "Maki Test Two"): 1},
          f"seconds, ISO and dotted dates all land on their completion day (got {comp})")
    meta = tr.get("completions_meta") or {}
    check(meta.get("complete_rows") == 6 and meta.get("shown") == 4,
          f"6 completed rows, 4 shown (got {meta.get('complete_rows')}, {meta.get('shown')})")
    check(meta.get("unparsed_dates") == 1 and meta.get("unparsed_example") == "the seventh",
          f"the unparseable one is counted and quoted (got {meta.get('unparsed_dates')}, "
          f"{meta.get('unparsed_example')!r})")
    check(meta.get("unlinked_trainees") == 1,
          f"the completion whose trainee is missing from Flow Trainees is counted (got {meta.get('unlinked_trainees')})")
    b = tr.get("completions_basis") or ""
    check("Of 6 completed rows" in b and "4 are shown" in b and "1 belong to trainees missing" in b
          and "1 have a completion date that did not parse" in b,
          "the basis says all of that in words")
    check(any("the seventh" in g for g in snap.get("gaps") or []),
          "and the unparseable date is a named gap, not a silent drop")

shutil.rmtree(tmp, ignore_errors=True)
print()
if failures:
    print(f"{failures} assertion(s) FAILED")
    sys.exit(1)
print("all assertions passed")
