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

SAY WHAT HAPPENED (Ross, 09/10/2026). The file sat at pulled_at 2026-09-25 for
a fortnight and nobody could say why: the log line was "HTTP 401" or "timed
out" at best, and nothing reached the dashboard but "stale". Every attempt now
logs the HTTP status, content type and the first 300 characters of what came
back, and writes data/ops_command/facilities_pull_status.json:

    {"attempted_at", "ok", "cause", "http_status", "content_type",
     "detail", "feed_url", "last_ok_at"}

with `cause` one of:
    ok           pulled and written
    no_key       FACILITIES_API_KEY is not set on maki-hospitality-etl
    key_malformed FACILITIES_API_KEY holds a line break or a character an HTTP
                 header cannot carry (a two-line paste) - never echoed
    key_rejected HTTP 401/403 - the key is wrong or was rotated in the app
    timeout      no answer within TIMEOUT_S - the free-tier app is asleep or
                 overloaded
    app_down     HTTP 5xx (including PythonAnywhere's own 5xx error page when
                 the app fails to load), the host cannot be reached, or the
                 connection dropped mid-reply
    app_disabled the reply is PythonAnywhere's own HTML page, not the feed -
                 the free web app has EXPIRED (click "Run until 1 month from
                 today" on the Web tab) or been disabled
    not_json     a 200 that is not JSON, and not the page above
    bad_shape    JSON that fails sanity() - the feed changed shape
    write_failed the file could not be written
    unexpected   anything else - the bake log names the exception TYPE only
The bake reads it and names the cause on the grey OO2 rows and the
Maintenance tab, so "stale" always comes with a reason. The BODY HEAD goes to
the bake log only (maki-hospitality-etl is private) and never into this file,
which is committed to the PUBLIC ops repo: an app error page can carry a
traceback. The key is never logged, and is scrubbed from the body head should
the app ever echo it.

THE PUSH PATH. builders/facilities_push_pythonanywhere.py runs ON
PythonAnywhere as a daily scheduled task and PUTs the same summary to
data/ops_command/facilities_ppm_pushed.json through GitHub's Contents API -
so a day this pull cannot reach the app (asleep, network, key) can still have
fresh figures. The bake uses whichever of the two copies was pulled more
recently (see bake_ops_command.load_facilities_best).
"""

from __future__ import annotations

import datetime
import http.client
import json
import logging
import os
import socket
import sys
import urllib.error
import urllib.request

log = logging.getLogger("refresh_facilities")

FEED_URL = os.environ.get("FACILITIES_FEED_URL", "").strip() or \
    "https://rossmward.eu.pythonanywhere.com/api/ppm_summary"
OUT_DIR = os.environ.get("OPS_COMMAND_OUT_DIR", "").strip() or \
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "ops_command")
OUT_PATH = os.path.join(OUT_DIR, "facilities_ppm.json")
STATUS_FILE = "facilities_pull_status.json"
_KEY = ""   # set by main(); write_status scrubs it from anything it records
TIMEOUT_S = 40   # PythonAnywhere free tier can take a few seconds to wake
BODY_HEAD = 300  # characters of the reply kept for the log and the status file

# Phrases from PythonAnywhere's own placeholder pages, served with a 200 or a
# 404 in place of the app when a free web app has expired or been disabled.
# Specific phrases only: the bare word "pythonanywhere" is on its 5xx error
# page too, and a 5xx is a crashing app, not an expired one.
_PA_PAGE_MARKERS = ("has been disabled", "disabled by its owner", "has expired",
                    "coming soon")


class PullError(Exception):
    """A failed pull, classified. `cause` is one of the codes in the docstring."""

    def __init__(self, cause, detail, http_status=None, content_type=None, body_head=None):
        super().__init__(detail)
        self.cause, self.detail = cause, detail
        self.http_status, self.content_type, self.body_head = http_status, content_type, body_head


def scrub(txt: str, key: str = "") -> str:
    """Remove the key - whole, each of its lines, and its repr - from text.

    Belt and braces for anything that may reach the PUBLIC status file or a
    log: a key pasted with a line break makes http.client raise a ValueError
    that quotes it (09/10/2026 review)."""
    txt = str(txt or "")
    if not key:
        return txt
    parts = {key, repr(key)[1:-1], *[ln.strip() for ln in key.splitlines()]}
    for part in sorted((p_ for p_ in parts if len(p_) >= 4), key=len, reverse=True):
        txt = txt.replace(part, "[key]")
    return txt


def _head(raw: bytes, key: str = "") -> str:
    """The first BODY_HEAD characters of a reply, one line, key scrubbed."""
    txt = (raw or b"")[:BODY_HEAD * 4].decode("utf-8", "replace")
    txt = " ".join(txt.split())[:BODY_HEAD]
    return scrub(txt, key)


def _looks_like_pa_page(content_type: str, head: str) -> bool:
    h = head.lower()
    return ("html" in (content_type or "").lower() or h.startswith("<")) and \
        any(m in h for m in _PA_PAGE_MARKERS)


def fetch(key: str) -> dict:
    """GET the feed and return it parsed, or raise PullError saying why not.

    Every attempt logs status, content type and the head of the reply - the
    log line Ross needs to tell "asleep" from "key rotated" from "expired".
    """
    if any(not (32 < ord(c) < 127) for c in key):
        # A header value with a line break makes http.client raise a ValueError
        # that QUOTES the key. Refuse before building the request; never echo it.
        log.error("Facilities feed: FACILITIES_API_KEY contains a line break, space or "
                  "non-ASCII character - re-paste it on one line (value not shown)")
        raise PullError("key_malformed", "FACILITIES_API_KEY contains a line break, space or "
                        "character an HTTP header cannot carry - re-paste the secret as one line")
    req = urllib.request.Request(FEED_URL, headers={"X-API-Key": key, "User-Agent": "ops-command-bake/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            status, ctype, raw = r.status, r.headers.get("Content-Type", ""), r.read()
    except urllib.error.HTTPError as e:
        raw = e.read() if e.fp else b""
        ctype, head = (e.headers or {}).get("Content-Type", ""), _head(raw, key)
        log.error("Facilities feed: HTTP %s %s, content-type %r, body head: %s",
                  e.code, e.reason, ctype, head or "(empty)")
        if e.code in (401, 403):
            raise PullError("key_rejected", f"HTTP {e.code} {e.reason} - the app refused "
                            "FACILITIES_API_KEY (wrong, or rotated in the app's config_secrets.py)",
                            e.code, ctype, head)
        if e.code >= 500:
            # Before the placeholder test: PythonAnywhere's own 5xx page (an
            # app that fails to load) names PythonAnywhere too, and is a
            # crashing app, not an expired one.
            raise PullError("app_down", f"HTTP {e.code} {e.reason} - the app is erroring or "
                            "failing to load", e.code, ctype, head)
        if _looks_like_pa_page(ctype, head):
            raise PullError("app_disabled", f"HTTP {e.code}: PythonAnywhere's placeholder page "
                            "instead of the feed - the free web app has expired or been disabled",
                            e.code, ctype, head)
        raise PullError("app_down", f"HTTP {e.code} {e.reason}", e.code, ctype, head)
    except (socket.timeout, TimeoutError) as e:
        log.error("Facilities feed: no answer within %ss (%s)", TIMEOUT_S, e)
        raise PullError("timeout", f"no answer within {TIMEOUT_S}s - the free-tier app is asleep "
                        "or overloaded")
    except urllib.error.URLError as e:
        if isinstance(e.reason, (socket.timeout, TimeoutError)) or "timed out" in str(e.reason):
            log.error("Facilities feed: no answer within %ss (%s)", TIMEOUT_S, e.reason)
            raise PullError("timeout", f"no answer within {TIMEOUT_S}s - the free-tier app is "
                            "asleep or overloaded")
        log.error("Facilities feed: could not connect (%s)", scrub(e.reason, key))
        raise PullError("app_down", f"could not reach the app ({scrub(e.reason, key)})")
    except (http.client.HTTPException, ConnectionError, OSError) as e:
        # Sent, then cut off: RemoteDisconnected, a reset, a truncated body
        # (IncompleteRead). The app or the network dropped it - not a shape
        # problem with the feed.
        log.error("Facilities feed: connection dropped (%s)", type(e).__name__)
        raise PullError("app_down", f"the connection dropped before a complete reply "
                        f"({type(e).__name__})")
    head = _head(raw, key)
    log.info("Facilities feed: HTTP %s, content-type %r, %d bytes, body head: %s",
             status, ctype, len(raw or b""), head or "(empty)")
    if status != 200:
        raise PullError("app_down", f"HTTP {status}", status, ctype, head)
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        if _looks_like_pa_page(ctype, head):
            raise PullError("app_disabled", "a 200 carrying PythonAnywhere's placeholder page, not "
                            "the feed - the free web app has expired (Web tab: 'Run until 1 month "
                            "from today') or been disabled", status, ctype, head)
        raise PullError("not_json", f"HTTP 200 but the body is not JSON (content-type {ctype!r})",
                        status, ctype, head)


def write_status(ok: bool, cause: str, detail: str, err: PullError | None = None) -> None:
    """Record this attempt beside the feed. Never raises: the status file is
    diagnostics, and failing to write it must not fail the bake step."""
    path = os.path.join(OUT_DIR, STATUS_FILE)
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        prev = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                prev = json.load(fh) or {}
        rec = {"attempted_at": now, "ok": ok, "cause": cause, "detail": scrub(detail, _KEY),
               "http_status": err.http_status if err else (200 if ok else None),
               "content_type": err.content_type if err else None,
               "feed_url": FEED_URL,
               "last_ok_at": now if ok else prev.get("last_ok_at")}
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(rec, fh, indent=1, ensure_ascii=False, sort_keys=True)
        os.replace(tmp, path)
    except Exception as e:  # noqa: BLE001 - diagnostics must never fail the step
        log.warning("could not write %s (%s)", path, e)


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
        write_status(False, "no_key", "FACILITIES_API_KEY is not set on maki-hospitality-etl, "
                     "so the bake cannot ask the app for the feed")
        return 0
    global _KEY
    _KEY = key
    try:
        feed = fetch(key)
    except PullError as e:
        log.error("Facilities feed: %s (%s) — file untouched", e.cause, e.detail)
        write_status(False, e.cause, e.detail, e)
        return 0
    except Exception as e:  # noqa: BLE001 — fail soft by design
        # Unforeseen: name the TYPE only. An exception message can quote the
        # request, and this text reaches a file in the public repo.
        log.error("Facilities feed: unexpected %s during the pull — file untouched", type(e).__name__)
        write_status(False, "unexpected", f"unexpected {type(e).__name__} during the pull - "
                     "the bake log names it")
        return 0
    try:
        sanity(feed)
        feed["pulled_at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        feed["feed_url"] = FEED_URL
        feed["pulled_by"] = "bake"
        # allow_nan=False: NaN/Infinity are not JSON. One in the committed file
        # would reach the public snapshot, where the browser's JSON.parse
        # throws and the whole dashboard goes blank. Refused here, file untouched.
        body = json.dumps(feed, indent=1, ensure_ascii=False, sort_keys=True, allow_nan=False)
    except Exception as e:  # noqa: BLE001 — fail soft by design
        log.error("Facilities feed unusable (%s: %s) — file untouched", type(e).__name__,
                  scrub(str(e), key))
        write_status(False, "bad_shape", f"the feed arrived but cannot be used: {type(e).__name__}: {e}")
        return 0
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        tmp = OUT_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(body)
        os.replace(tmp, OUT_PATH)
    except OSError as e:
        log.error("could not write %s (%s) — previous file left in place", OUT_PATH, e)
        write_status(False, "write_failed", f"could not write {os.path.basename(OUT_PATH)} ({e})")
        return 0
    write_status(True, "ok", f"pulled and written, as_of {feed.get('as_of')}")
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
