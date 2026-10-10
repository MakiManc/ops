#!/usr/bin/env python3
"""Kobas Orders: the verifier goes CRITICAL when order emails stop landing (09/10/2026).

Kobas Orders is the IMAP feed of 'Stock Order Confirmation' emails. Projected
spend and OTIF (OO3 KR4) are built on it, and it had been flagged "may be
failing" twice with nothing in the verifier able to say so: its event check
read 'Delivery Date ISO', and delivery dates run up to a week AHEAD of the
pull, so the check read "-6d old" - fresh - even on a day no email had landed.

The manifest now points the check at 'Order Email Date' (the email's own date)
with a 2-day window. This pins, against a hand-built archive through the real
DuckDB adapter:
  * 2 days old is fine; 3 days old is CRITICAL, check 3-events, class
    3-events-stale - not deferrable, so the morning run alerts too;
  * the detail names the field, the age and what to check (the manifest's
    event_stale_hint), and says whether pulls are still arriving;
  * the real manifest entry is what is tested, not a copy.

  python3 tests/kobas_orders_email_fresh_test.py      (exit 1 on any failure)
"""
from __future__ import annotations

import gzip
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "builders"))
import archive_source  # noqa: E402
import verify_ops_data as verify  # noqa: E402

failures = 0


def check(cond, msg):
    global failures
    print(("ok  : " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


MANIFEST = json.load(open(os.path.join(REPO, "data", "ops_command", "feeds_manifest.json")))
ENTRY = next(f for f in MANIFEST["feeds"] if f["name"] == "Kobas Orders")
check(ENTRY["event_date_field"] == "Order Email Date" and ENTRY["event_fresh_days"] == 2,
      "the real manifest checks Kobas Orders on Order Email Date, 2-day window")
check(ENTRY["status"] == "expected" and verify.domain_of("Kobas Orders") in verify.PRIORITY_DOMAINS,
      "it is an expected feed in a priority domain, so a stale result is critical")
check("3-events-stale" not in verify.DEFERRABLE,
      "and 3-events-stale is not deferrable - the morning run alerts on it")


def order(email_date, delivery):
    return {"Order Email Date": email_date, "Site": "Maki Test", "Supplier": "Alpha Foods",
            "Delivery Date ISO": delivery, "Order Ref": f"R-{email_date}", "Order Value GBP": "10.00",
            "Order Placed At": email_date + "T09:00:00+00:00"}


def run(pulls, today):
    tmp = tempfile.mkdtemp(prefix="kobasord-")
    try:
        for pull_date, rows in pulls.items():
            d = os.path.join(tmp, pull_date)
            os.makedirs(d)
            with gzip.open(os.path.join(d, "Kobas_Orders.jsonl.gz"), "wt") as fh:
                for i, r in enumerate(rows):
                    fh.write(json.dumps({"row_num": i, "data": r}) + "\n")
            json.dump({"Kobas_Orders": "Kobas Orders"}, open(os.path.join(d, "_feeds.json"), "w"))
        conn = archive_source.connect(tmp)
        verify.RESULTS.clear()
        with conn.cursor() as cur:
            verify.check_event_dates(cur, {"feeds": [ENTRY]}, today)
        return [r for r in verify.RESULTS if r.get("feed") == "Kobas Orders"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


print("\n-- emails landing daily --")
res = run({"2026-10-09": [order("2026-10-08", "2026-10-14"), order("2026-10-09", "2026-10-15")]},
          "2026-10-09")
check(len(res) == 1 and res[0]["level"] == "ok", f"newest email today: ok (got {res})")

print("\n-- two days without an email (one quiet day is normal) --")
res = run({"2026-10-09": [order("2026-10-07", "2026-10-14")]}, "2026-10-09")
check(res and res[0]["level"] == "ok", f"2 days old: still ok (got {res and res[0]['level']})")

print("\n-- three days without an email, pulls still arriving --")
res = run({"2026-10-09": [order("2026-10-06", "2026-10-15")]}, "2026-10-09")
r = res[0] if res else {}
check(r.get("level") == "critical", f"3 days old: CRITICAL (got {r.get('level')})")
check(r.get("check") == "3-events" and r.get("class") == "3-events-stale",
      f"check 3-events, class 3-events-stale (got {r.get('check')}, {r.get('class')})")
d = r.get("detail", "")
check("newest Order Email Date is 2026-10-06 (3d old, window 2d)" in d, "the detail gives the field, date and age")
check("report itself has stopped being produced" in d,
      "and says the pulls are still arriving, so it is the emails that stopped")
check("IMAP" in d and "GMAIL_APP_PASSWORD" in d and "OTIF" in d,
      "and names what to check and what depends on it (the manifest's hint)")

print("\n-- a future delivery date cannot mask it (the old check's blind spot) --")
res = run({"2026-10-09": [order("2026-10-01", "2026-10-20")]}, "2026-10-09")
check(res and res[0]["level"] == "critical",
      "an order delivering on 20/10 does not make an 8-day-old email feed look fresh")

print("\n-- the fetch itself stopped: last pull days ago --")
res = run({"2026-10-05": [order("2026-10-05", "2026-10-12")]}, "2026-10-09")
d = res[0].get("detail", "") if res else ""
check(res and res[0]["level"] == "critical" and "the last pull was 2026-10-05" in d,
      f"critical, naming the last pull (got {d[:120]!r})")

print()
if failures:
    print(f"{failures} assertion(s) FAILED")
    sys.exit(1)
print("all assertions passed")
