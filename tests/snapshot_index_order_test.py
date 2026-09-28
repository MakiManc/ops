#!/usr/bin/env python3
"""snapshot_index.json must always point `latest` at the newest baked date.

THE BUG THIS GUARDS (28/09/2026). bake_ops_command.py used to do:

    if pull not in idx["dates"]: idx["dates"].insert(0, pull)
    idx["latest"] = idx["dates"][0]

Every bake's date went to position 0 and became `latest`, which is only correct
when the bake IS of the newest date. A backfill, or a re-run against a source
that had fallen behind, silently rolled the whole live dashboard back to an
older day: command/index.html reads `latest` unless the roll-back selector says
otherwise, so nothing failed, nothing logged, and the only symptom was that the
numbers had moved. Found while checking whether the Neon rollback bake was safe
to run after the export stopped writing Neon on 11/09/2026 - Neon's newest
pull_date was 2026-09-11 against a 2026-09-21 index.

Runs against the real builder's real function, with no warehouse and no
archive: update_snapshot_index only touches a JSON file in a temp directory.
"""
import json
import os
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "builders"))
import bake_ops_command as B  # noqa: E402

FAILED = []


def check(ok, label):
    print(("ok  : " if ok else "FAIL: ") + label)
    if not ok:
        FAILED.append(label)


def read(d):
    with open(os.path.join(d, "snapshot_index.json"), encoding="utf-8") as fh:
        return json.load(fh)


def main():
    d = tempfile.mkdtemp(prefix="snapidx-")

    # --- a fresh index: the first bake is the latest by definition ---
    B.update_snapshot_index(d, "2026-01-15", "2026-01-15T09:00:00Z")
    idx = read(d)
    check(idx["latest"] == "2026-01-15", "first bake sets latest")
    check(idx["dates"] == ["2026-01-15"], "first bake records exactly its date")
    check(idx["generated_at"] == "2026-01-15T09:00:00Z", "generated_at recorded")

    # --- THE REGRESSION: an OLDER date must not become latest ---
    B.update_snapshot_index(d, "2026-01-10", "2026-01-16T09:00:00Z")
    idx = read(d)
    check(idx["latest"] == "2026-01-15",
          "baking an OLDER date leaves latest alone (the rollback bug)")
    check(idx["latest"] != "2026-01-10",
          "the older date is explicitly NOT promoted to latest")
    check(idx["dates"] == ["2026-01-15", "2026-01-10"],
          "the older date is still recorded, in newest-first order")
    check(idx["generated_at"] == "2026-01-16T09:00:00Z",
          "generated_at still advances on a backfill")

    # --- a genuinely newer date does take over ---
    B.update_snapshot_index(d, "2026-01-20", "2026-01-20T09:00:00Z")
    idx = read(d)
    check(idx["latest"] == "2026-01-20", "a newer date becomes latest")
    check(idx["dates"] == ["2026-01-20", "2026-01-15", "2026-01-10"],
          "dates stay sorted newest-first")

    # --- re-baking the same day is the ordinary case, not a duplicate ---
    before = read(d)["dates"]
    B.update_snapshot_index(d, "2026-01-15", "2026-01-20T11:00:00Z")
    idx = read(d)
    check(idx["dates"] == before, "re-baking an existing date adds no duplicate")
    check(idx["latest"] == "2026-01-20", "re-baking an older date keeps latest")

    # --- an index left unsorted by the old code is repaired, not trusted ---
    bad = os.path.join(d, "unsorted")
    os.makedirs(bad, exist_ok=True)
    with open(os.path.join(bad, "snapshot_index.json"), "w", encoding="utf-8") as fh:
        json.dump({"note": "written by the old prepending code",
                   "dates": ["2026-02-01", "2026-03-01", "2026-01-01"],
                   "latest": "2026-02-01"}, fh)
    B.update_snapshot_index(bad, "2026-02-15", "2026-03-02T09:00:00Z")
    idx = read(bad)
    check(idx["dates"] == ["2026-03-01", "2026-02-15", "2026-02-01", "2026-01-01"],
          "an out-of-order index is re-sorted rather than prepended to")
    check(idx["latest"] == "2026-03-01",
          "latest is the newest date present, not the one just baked")

    # --- month/day boundaries: ISO sort must not be fooled by string length ---
    edge = os.path.join(d, "edge")
    os.makedirs(edge, exist_ok=True)
    for day in ("2026-09-09", "2026-09-10", "2026-10-01", "2026-09-30"):
        B.update_snapshot_index(edge, day, "2026-10-01T09:00:00Z")
    idx = read(edge)
    check(idx["dates"] == ["2026-10-01", "2026-09-30", "2026-09-10", "2026-09-09"],
          "ISO dates sort chronologically across month boundaries")
    check(idx["latest"] == "2026-10-01", "latest survives a month rollover")

    print()
    if FAILED:
        print(f"{len(FAILED)} assertion(s) failed")
        return 1
    print("all assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
