#!/usr/bin/env python3
"""Refresh data/ops_command/facilities_ppm.json from the M&R Facilities app.

WHAT THIS IS. The Facilities app (rossmward.eu.pythonanywhere.com) is now the
system of record for statutory compliance (OO2 KR4), PPM on-time (OO2 KR1),
repeat maintenance issues (OO2 KR2), the open-fault queue and a per-contractor
scorecard. It publishes all of that as one read-only JSON feed:

    GET https://rossmward.eu.pythonanywhere.com/api/ppm_summary
    header  X-API-Key: <FACILITIES_API_KEY>

This script pulls that feed and writes it, unchanged apart from a pulled_at
stamp, to data/ops_command/facilities_ppm.json so bake_ops_command.py can read
it like maintenance_source.json. Same contract as refresh_maintenance.py and
refresh_okr_sources.py: run it in the bake workflow before the bake.

WHERE IT RUNS. MakiManc/maki-hospitality-etl, .github/workflows/ops_command_bake.yml
(the daily bake), as a step before the bake. That job checks MakiManc/ops out
into ./ops and runs from the ETL repo's root, hence the ops/ prefix:

      - name: Refresh Facilities app feed (OO2 KR1/KR2/KR4)
        env:
          FACILITIES_API_KEY: ${{ secrets.FACILITIES_API_KEY }}
        run: python ops/builders/refresh_facilities.py

One new repo secret: FACILITIES_API_KEY (the value is in the app's
config_secrets.py on PythonAnywhere as API_KEY; Ross holds a copy in
facilities_api_key.txt). No browser, no Google credential.

FAIL SOFT, ALWAYS. If the app is asleep, the key is wrong or the JSON does not
parse, the committed file is left untouched and this exits 0 with a loud log.
The bake renders pulled_at / as_of, so staleness is visible on the tab; a
failed bake is not. A free PythonAnywhere site expires every 3 months unless
"Run until 1 month from today" is clicked — if pulled_at goes stale, that is
the first thing to check.

SHAPE OF THE FEED (all keys stable; the bake should read defensively anyway):
  as_of, generated_at, source
  group:   tasks, current, due30, overdue, no_evidence, kr4_pct, kr1_pct, kr1_n, kr1_ok
  sites[]: site, code, trading_name, company, tasks, current, due30, overdue,
           no_evidence, oldest_overdue_days, kr4_pct, kr1_pct (+ kr1_n, kr1_ok)
  kr2_repeat_issues: rule, months[{month, label, repeats, sites, per_site}],
           by_site[{site, repeats}], pairs[{site, asset, first, second, days,
           fix_date, note}], chasers (int)
  faults:  open, open_over_14d, assets_down
  contractors[]: name, tasks, overdue, no_evidence, ontime_pct_12m,
           avg_days_late, last_cert
Franchise sites (MAF*) are already excluded from the compliance figures by the
app; KR2 counts every site with assets.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import sys
import urllib.error
import urllib.request

log = logging.getLogger("refresh_facilities")

FEED_URL = os.environ.get("FACILITIES_FEED_URL", "").strip() or \
    "https://rossmward.eu.pythonanywhere.com/api/ppm_summary"
OUT_DIR = os.environ.get("OPS_COMMAND_OUT_DIR", "").strip() or \
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "ops_command")
OUT_PATH = os.path.join(OUT_DIR, "facilities_ppm.json")
TIMEOUT_S = 40   # PythonAnywhere free tier can take a few seconds to wake


def fetch(key: str) -> dict:
    req = urllib.request.Request(FEED_URL, headers={"X-API-Key": key, "User-Agent": "ops-command-bake/1.0"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status}")
        return json.load(r)


def sanity(feed: dict) -> None:
    """Refuse to overwrite a good file with a broken one.

    Type-checks what the bake type-checks (25/09/2026): a feed that passed on
    key names alone - "pairs": 2, "faults": [...] - used to overwrite the last
    good file and grey the three KRs the next morning, instead of getting the
    three-day grace a failed pull gets.
    """
    if not isinstance(feed, dict):
        raise ValueError("feed is not a JSON object")
    for k, t in (("as_of", str), ("group", dict), ("sites", list),
                 ("kr2_repeat_issues", dict), ("faults", dict)):
        if not isinstance(feed.get(k), t):
            raise ValueError(f"feed '{k}' missing or not {t.__name__}")
    for k in ("months", "by_site", "pairs"):
        if k in feed["kr2_repeat_issues"] and not isinstance(feed["kr2_repeat_issues"][k], list):
            raise ValueError(f"feed 'kr2_repeat_issues.{k}' is not a list")
    if "contractors" in feed and not isinstance(feed["contractors"], list):
        raise ValueError("feed 'contractors' is not a list")
    if len(feed["sites"]) < 5:
        raise ValueError(f"feed has {len(feed.get('sites', []))} sites — expected the estate")
    if feed["group"].get("tasks", 0) < 50:
        raise ValueError(f"feed has only {feed['group'].get('tasks')} PPM tasks — looks empty")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    key = os.environ.get("FACILITIES_API_KEY", "").strip()
    if not key:
        log.error("FACILITIES_API_KEY not set — leaving %s untouched", OUT_PATH)
        return 0
    try:
        feed = fetch(key)
        sanity(feed)
        feed["pulled_at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        feed["feed_url"] = FEED_URL
        # allow_nan=False: NaN/Infinity are not JSON. One in the committed file
        # would reach the public snapshot, where the browser's JSON.parse
        # throws and the whole dashboard goes blank. Refused here, file untouched.
        body = json.dumps(feed, indent=1, ensure_ascii=False, sort_keys=True, allow_nan=False)
    except urllib.error.HTTPError as e:
        log.error("Facilities feed HTTP %s (%s) — key wrong or app down; file untouched", e.code, e.reason)
        return 0
    except Exception as e:  # noqa: BLE001 — fail soft by design
        log.error("Facilities feed unusable (%s: %s) — file untouched", type(e).__name__, e)
        return 0
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        tmp = OUT_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(body)
        os.replace(tmp, OUT_PATH)
    except OSError as e:
        log.error("could not write %s (%s) — previous file left in place", OUT_PATH, e)
        return 0
    # Nothing after the write may change the exit code: a raise here would exit
    # 1 and fail the workflow step, the one thing this script must never do.
    try:
        g = feed["group"]
        k2m = feed["kr2_repeat_issues"].get("months") or []
        k2 = k2m[-1] if k2m and isinstance(k2m[-1], dict) else {}
        log.info("wrote %s — as_of %s, KR4 %s%%, KR1 %s%%, %d sites, KR2 %s repeats this month, %s open faults",
                 OUT_PATH, feed["as_of"], g.get("kr4_pct"), g.get("kr1_pct"), len(feed["sites"]), k2.get("repeats"),
                 feed["faults"].get("open"))
    except Exception as e:  # noqa: BLE001
        log.warning("wrote %s; the summary line itself failed (%s)", OUT_PATH, e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
