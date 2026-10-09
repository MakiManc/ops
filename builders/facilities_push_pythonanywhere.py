#!/usr/bin/env python3
"""Push the Facilities app's PPM summary to the ops repo, FROM PythonAnywhere.

WHY THIS EXISTS (Ross, 09/10/2026)
----------------------------------
The dashboard's Facilities figures (OO2 KR1/KR2/KR4 and the Maintenance tab)
come from the app's /api/ppm_summary feed. Until now the only route was a
PULL: the Ops Command bake, running on GitHub Actions, calls the app with
FACILITIES_API_KEY. When that call fails - app asleep or expired, key rotated,
GitHub's runner unable to reach PythonAnywhere - nothing arrives, and on
25/09/2026 that left the three KRs grey for a fortnight.

This is the PUSH route, run on the app's own side of the wire. A daily
scheduled task on PythonAnywhere fetches the same summary from the app and
writes it to MakiManc/ops as data/ops_command/facilities_ppm_pushed.json via
GitHub's Contents API. The bake reads both copies and uses whichever was
pulled more recently (bake_ops_command.load_facilities_best), so either route
alone keeps the figures fresh, and a stale copy never overrides a fresh one.

It writes a SEPARATE file from the bake's facilities_ppm.json on purpose: two
writers on one file would race, and the pull/push timestamps would stop
meaning which route delivered what.

INSTALL (once, on PythonAnywhere - Ross)
----------------------------------------
1. Upload this file to your PythonAnywhere home, e.g.
       /home/rossmward/ops_push/facilities_push_pythonanywhere.py
   It needs nothing beyond the standard library.

2. Create the secrets file, readable by you only:
       nano /home/rossmward/.ops_push.env
       chmod 600 /home/rossmward/.ops_push.env
   with exactly these two lines (values are yours; do not paste them anywhere
   else):
       OPS_PUSH_TOKEN=<a fine-grained PAT - see below>
       FACILITIES_API_KEY=<the API_KEY value from the app's config_secrets.py>

   THE TWO SECRETS
   * OPS_PUSH_TOKEN - a NEW fine-grained personal access token, made at
     https://github.com/settings/personal-access-tokens :
       Resource owner MakiManc; Only select repositories: MakiManc/ops;
       Repository permissions: Contents = Read and write; nothing else.
     Set an expiry and put a reminder in your calendar a week before it -
     when it expires this script fails with "GitHub rejected OPS_PUSH_TOKEN"
     and the bake's own pull becomes the only route again. Do not reuse
     OPS_REPO_TOKEN from maki-hospitality-etl: one leak, one token to revoke.
   * FACILITIES_API_KEY - the SAME value as the app's API_KEY in
     config_secrets.py (and as the FACILITIES_API_KEY secret the bake uses).
     It is how this script authenticates to the app's own feed.

3. Test it by hand from a Bash console:
       python3 /home/rossmward/ops_push/facilities_push_pythonanywhere.py --dry-run
   (fetches and checks the feed, pushes nothing), then without --dry-run.
   A free PythonAnywhere account can only reach whitelisted sites; api.github.com
   is on the whitelist (https://www.pythonanywhere.com/whitelist/). If the push
   fails with a connection error rather than an HTTP status, check that first.
   A successful push prints the commit URL; the file appears at
   https://github.com/MakiManc/ops/blob/main/data/ops_command/facilities_ppm_pushed.json

4. Tasks tab -> Scheduled tasks -> daily at 06:30 (UTC on PythonAnywhere):
       python3 /home/rossmward/ops_push/facilities_push_pythonanywhere.py
   06:30 lands it before the 08:17 export and the bake that follows. The task
   log (Tasks tab) holds each run's output; a failed run exits non-zero.

WHAT IT PRINTS. The HTTP status of each call and, on a failure, the first 300
characters of the reply - never either secret. Exit 0 pushed (or dry run OK),
1 the app's feed could not be fetched or failed the shape check, 2 a secret is
missing, 3 GitHub refused the write.

Options (environment variables, all optional): FACILITIES_FEED_URL (default
the app's own /api/ppm_summary), OPS_PUSH_ENV_FILE (default ~/.ops_push.env),
OPS_PUSH_REPO (default MakiManc/ops), OPS_PUSH_BRANCH (default main).
"""
from __future__ import annotations

import argparse
import base64
import datetime
import json
import os
import socket
import stat
import sys
import urllib.error
import urllib.request

FEED_URL = os.environ.get("FACILITIES_FEED_URL", "").strip() or \
    "https://rossmward.eu.pythonanywhere.com/api/ppm_summary"
REPO = os.environ.get("OPS_PUSH_REPO", "").strip() or "MakiManc/ops"
BRANCH = os.environ.get("OPS_PUSH_BRANCH", "").strip() or "main"
TARGET = "data/ops_command/facilities_ppm_pushed.json"
ENV_FILE = os.environ.get("OPS_PUSH_ENV_FILE", "").strip() or \
    os.path.join(os.path.expanduser("~"), ".ops_push.env")
TIMEOUT_S = 40
API = "https://api.github.com"


def log(msg: str) -> None:
    print(f"{datetime.datetime.now(datetime.timezone.utc):%Y-%m-%d %H:%M:%SZ} {msg}", flush=True)


def load_secrets(path: str | None = None) -> dict:
    """KEY=VALUE lines from the secrets file, overridden by the environment."""
    path = path or ENV_FILE
    out = {}
    if os.path.exists(path):
        mode = os.stat(path).st_mode
        if mode & (stat.S_IRGRP | stat.S_IROTH):
            log(f"WARNING {path} is readable by other users - run: chmod 600 {path}")
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("OPS_PUSH_TOKEN", "FACILITIES_API_KEY"):
        if os.environ.get(k, "").strip():
            out[k] = os.environ[k].strip()
    return out


def _head(raw: bytes, *secrets: str) -> str:
    txt = " ".join((raw or b"")[:1200].decode("utf-8", "replace").split())[:300]
    for s_ in secrets:
        if s_:
            txt = txt.replace(s_, "[secret]")
    return txt


def sanity(feed: dict) -> None:
    """The SAME checks refresh_facilities.sanity() makes before the bake writes
    its copy (tests/facilities_push_test.py holds the two to the same verdicts),
    so a pushed file can never be one the pull would have refused."""
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


def fetch_feed(key: str, opener=urllib.request.urlopen) -> dict:
    req = urllib.request.Request(FEED_URL, headers={"X-API-Key": key,
                                                    "User-Agent": "ops-facilities-push/1.0"})
    try:
        with opener(req, timeout=TIMEOUT_S) as r:
            raw = r.read()
            log(f"app feed: HTTP {r.status}, {len(raw)} bytes")
    except urllib.error.HTTPError as e:
        raw = e.read() if e.fp else b""
        raise RuntimeError(f"app feed: HTTP {e.code} {e.reason} - {_head(raw, key)}")
    except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
        raise RuntimeError(f"app feed: could not fetch ({getattr(e, 'reason', e)})")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise RuntimeError(f"app feed: not JSON - {_head(raw, key)}")


def _gh(method: str, url: str, token: str, body: dict | None = None, opener=urllib.request.urlopen):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ops-facilities-push/1.0",
        **({"Content-Type": "application/json"} if data else {})})
    try:
        with opener(req, timeout=TIMEOUT_S) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read() if e.fp else b""
        try:
            return e.code, json.loads(raw or b"{}")
        except ValueError:
            return e.code, {"message": _head(raw, token)}


def push(feed: dict, token: str, opener=urllib.request.urlopen) -> str:
    """PUT the feed to TARGET; returns the commit URL. Raises RuntimeError."""
    url = f"{API}/repos/{REPO}/contents/{TARGET}"
    body = json.dumps(feed, indent=1, ensure_ascii=False, sort_keys=True, allow_nan=False) + "\n"
    content = base64.b64encode(body.encode("utf-8")).decode()
    for attempt in (1, 2):
        st, cur = _gh("GET", f"{url}?ref={BRANCH}", token, opener=opener)
        if st == 401:
            raise RuntimeError("GitHub rejected OPS_PUSH_TOKEN (401) - it has expired or was "
                               "revoked; make a new one (see the docstring) and update ~/.ops_push.env")
        if st not in (200, 404):
            raise RuntimeError(f"GitHub GET {TARGET}: HTTP {st} - {cur.get('message')}")
        req = {"message": f"facilities: push from PythonAnywhere {feed.get('pulled_at', '')[:10]}"
                          f" (as of {feed.get('as_of')})",
               "content": content, "branch": BRANCH,
               "committer": {"name": "facilities-push", "email": "ops@makiramen.com"}}
        if st == 200 and cur.get("sha"):
            req["sha"] = cur["sha"]
        st, res = _gh("PUT", url, token, req, opener=opener)
        log(f"GitHub PUT {TARGET}: HTTP {st}")
        if st in (200, 201):
            return ((res.get("commit") or {}).get("html_url")) or "(no commit url returned)"
        if st in (409, 422) and attempt == 1:
            log("the file changed under us (another push landed) - re-reading and retrying once")
            continue
        if st == 401:
            raise RuntimeError("GitHub rejected OPS_PUSH_TOKEN (401) - it has expired or was revoked")
        if st == 403:
            raise RuntimeError("GitHub refused the write (403) - OPS_PUSH_TOKEN needs "
                               "Contents: Read and write on MakiManc/ops")
        raise RuntimeError(f"GitHub PUT {TARGET}: HTTP {st} - {res.get('message')}")
    raise RuntimeError("GitHub PUT kept conflicting - try again later")


def main(argv=None, opener=urllib.request.urlopen, now=None) -> int:
    ap = argparse.ArgumentParser(description="Push the Facilities PPM summary to MakiManc/ops")
    ap.add_argument("--dry-run", action="store_true", help="fetch and check the feed, push nothing")
    a = ap.parse_args(argv)
    sec = load_secrets()
    key, token = sec.get("FACILITIES_API_KEY", ""), sec.get("OPS_PUSH_TOKEN", "")
    if not key or (not token and not a.dry_run):
        missing = [n for n, v in (("FACILITIES_API_KEY", key), ("OPS_PUSH_TOKEN", token))
                   if not v and not (n == "OPS_PUSH_TOKEN" and a.dry_run)]
        log(f"ERROR missing secret(s): {', '.join(missing)} - set them in {ENV_FILE} "
            "(see the docstring at the top of this file)")
        return 2
    try:
        feed = fetch_feed(key, opener=opener)
        sanity(feed)
    except (RuntimeError, ValueError) as e:
        log(f"ERROR {e}")
        return 1
    now = now or datetime.datetime.now(datetime.timezone.utc)
    feed["pulled_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    feed["feed_url"] = FEED_URL
    feed["pulled_by"] = "pythonanywhere"
    log(f"feed OK: as_of {feed.get('as_of')}, {len(feed['sites'])} sites, "
        f"{feed['group'].get('tasks')} PPM tasks")
    if a.dry_run:
        log("dry run - nothing pushed")
        return 0
    try:
        log(f"pushed: {push(feed, token, opener=opener)}")
    except (RuntimeError, ValueError) as e:
        log(f"ERROR {e}")
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
