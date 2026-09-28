#!/usr/bin/env python3
"""A feed's tier must not be able to quieten the ETL run AND the verifier at once.

Run:  python3 tests/manifest_tiers_test.py     (no deps, no network, no DB)

WHAT THIS PINS (28/09/2026)
---------------------------
feeds_manifest.json's `status` is read by two systems that want different
things from it:

  * etl_receipt.py (MakiManc/maki-hospitality-etl) - does a fetch failure turn
    the ETL RUN red? expected: yes. best_effort / known_broken: no.
  * builders/verify_ops_data.py (here) - how loudly does the verifier report
    this feed? best_effort caps it at warning.

The Outstanding Stock Orders report needed those to disagree. It is read
downstream (the Supply tab's projected spend) but has been dead at source
since 01/09/2026, so it failed at fetch on every daily export for three weeks
and the export was permanently red. That is how the 21/09 Actions stoppage -
every workflow in the ETL repo dying in 2 seconds - went unnoticed for seven
days: the run had been red every morning anyway.

Softening the tier fixes the exit code. On its own it would ALSO have demoted
check 3, the event-freshness check, to warning - and check 3 is the single
check that saw this report die (28/08, six days before the arrival check), the
reason its severity stopped being pinned to warning on 03/09. So the fix is a
`verify_severity` override that wins over the cap, and these assertions exist
so nobody removes one half of it and leaves the other.
"""
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "builders"))
import verify_ops_data as V  # noqa: E402

MANIFEST = os.path.join(REPO, "data", "ops_command", "feeds_manifest.json")
STALLED = "Kobas Report - Maki Ramen - Weekly Outstanding Stock Orders Report"
LEVELS = ("critical", "warning")

FAILED = []


def check(ok, label):
    print(("ok  : " if ok else "FAIL: ") + label)
    if not ok:
        FAILED.append(label)


def main():
    with open(MANIFEST, encoding="utf-8") as fh:
        man = json.load(fh)
    feeds = {f["name"]: f for f in man["feeds"]}

    # ---- the ask: this feed must not be able to fail the ETL run ----
    f = feeds.get(STALLED)
    check(f is not None, "the Outstanding Stock Orders entry is still present")
    if f is None:
        return 1
    check(f["status"] != "expected",
          "it is NOT 'expected', so etl_receipt cannot fail the run on its fetch")
    check(f["status"] == "best_effort",
          "it is 'best_effort' - softened, but still checked (known_broken is not)")

    # ---- and the half that must not be lost: it still pages ----
    check(f.get("verify_severity") == "critical",
          "verify_severity holds it at critical, so softening the exit code "
          "did not also quieten checks 1-3")
    check(bool(f.get("note")), "it carries a note explaining the exception")
    check("verify_severity" in (f.get("note") or ""),
          "the note names verify_severity, so removing one half points at the other")

    # ---- tier_severity(): the override wins, the cap still applies ----
    check(V.tier_severity(f, "critical") == "critical",
          "tier_severity: best_effort + override stays critical")
    check(V.tier_severity({"status": "best_effort"}, "critical") == "warning",
          "tier_severity: plain best_effort is still capped to warning")
    check(V.tier_severity({"status": "expected"}, "critical") == "critical",
          "tier_severity: expected is untouched")
    check(V.tier_severity({"status": "expected"}, "warning") == "warning",
          "tier_severity: a warning is not promoted by the tier")
    check(V.tier_severity({"status": "best_effort",
                           "verify_severity": "warning"}, "critical") == "warning",
          "tier_severity: an explicit warning override is honoured too")

    # ---- this feed is in a priority domain, so critical is its real level ----
    check(V.domain_of(STALLED) in V.PRIORITY_DOMAINS,
          "the feed is in a priority domain, so 'critical' is the level it "
          "would have had as 'expected' - the override preserves, not inflates")

    # ---- conventions, so the next softening is deliberate ----
    be = [x for x in man["feeds"] if x.get("status") == "best_effort"]
    check(all(x.get("note") for x in be),
          f"every best_effort entry carries a note ({len(be)} of them)")
    overrides = [x for x in man["feeds"] if x.get("verify_severity")]
    check(all(x["verify_severity"] in LEVELS for x in overrides),
          "every verify_severity is a real level")
    check(all(x.get("status") != "expected" for x in overrides),
          "no 'expected' entry carries verify_severity (it would be a no-op "
          "and would read as if it were doing something)")
    check(all(x.get("status") != "known_broken" for x in overrides),
          "no 'known_broken' entry carries verify_severity - checks 1-3 skip "
          "those entirely, so an override there would be a lie")
    check(len(overrides) == 1,
          f"exactly one entry needs the override today (found {len(overrides)})")

    print()
    if FAILED:
        print(f"{len(FAILED)} assertion(s) failed")
        return 1
    print("all assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
