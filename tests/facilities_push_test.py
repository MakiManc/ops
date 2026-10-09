#!/usr/bin/env python3
"""Facilities: why a pull failed, and the PythonAnywhere push path (09/10/2026).

facilities_ppm.json sat at pulled_at 2026-09-25 for a fortnight and nothing
could say why. This pins the three pieces that fix that:

  1. refresh_facilities.fetch() CLASSIFIES each failure - key_rejected,
     timeout, app_down, app_disabled (PythonAnywhere's placeholder page),
     not_json - logs the HTTP status and the head of the reply, and writes
     facilities_pull_status.json WITHOUT the body head (that file is public).
  2. builders/facilities_push_pythonanywhere.py fetches the same feed on the
     app's side, applies the same shape check, and PUTs it to
     data/ops_command/facilities_ppm_pushed.json through the Contents API -
     never printing either secret.
  3. the bake reads the FRESHER of the two copies, and a stale feed's grey
     rows name the cause; inside the grace period the tab still warns.

No network: every HTTP call goes through a fake opener.

  python3 tests/facilities_push_test.py      (exit 1 on any failure)
"""
from __future__ import annotations

import base64
import contextlib
import copy
import datetime
import importlib.util
import io
import json
import logging
import os
import shutil
import socket
import sys
import tempfile
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "builders"))
import bake_ops_command as bake  # noqa: E402
import facilities_push_pythonanywhere as push  # noqa: E402


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


refresh = _load("refresh_facilities", os.path.join(REPO, "builders", "refresh_facilities.py"))
FEED = json.load(open(os.path.join(HERE, "fixtures", "facilities_ppm.json")))
for k in ("pulled_at", "feed_url", "pulled_by"):
    FEED.pop(k, None)
KEY, TOKEN = "fixture-api-key-123", "github_pat_fixture_token_456"

failures = 0


def check(cond, msg):
    global failures
    print(("ok  : " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


class Resp:
    def __init__(self, status, body, ctype="application/json"):
        self.status, self._b = status, body if isinstance(body, bytes) else body.encode()
        self.headers = {"Content-Type": ctype}

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(code, body=b"", ctype="text/html"):
    return urllib.error.HTTPError("http://x", code, "reason", {"Content-Type": ctype}, io.BytesIO(body))


# ---- 1. refresh_facilities: classify, log, record ---------------------------
print("-- refresh_facilities.fetch classifies the failure --")
tmp = tempfile.mkdtemp(prefix="facpush-")
refresh.OUT_DIR = tmp
refresh.OUT_PATH = os.path.join(tmp, "facilities_ppm.json")
CASES = [
    ("key_rejected", http_error(401, b'{"error":"bad key fixture-api-key-123"}', "application/json")),
    ("app_down", http_error(503, b"<html>Service Unavailable</html>")),
    ("app_disabled", Resp(200, b"<html><body>This web app has been disabled by its owner. pythonanywhere</body></html>", "text/html")),
    ("not_json", Resp(200, b"<html><body>Hello</body></html>", "text/html")),
    ("app_down", http_error(502, b"<html><h1>Something went wrong :-(</h1> There was an error loading "
                                b"your PythonAnywhere-hosted site. 502-backend</html>")),
    ("app_down", __import__("http.client").client.RemoteDisconnected("Remote end closed connection")),
    ("app_down", ConnectionResetError(104, "Connection reset by peer")),
    ("timeout", socket.timeout("timed out")),
    ("timeout", urllib.error.URLError(socket.timeout("timed out"))),
    ("app_down", urllib.error.URLError("Name or service not known")),
]
real_urlopen = refresh.urllib.request.urlopen
for want, outcome in CASES:
    def fake(req, timeout=None, _o=outcome):
        if isinstance(_o, BaseException):
            raise _o
        return _o
    refresh.urllib.request.urlopen = fake
    buf = io.StringIO()
    h = logging.StreamHandler(buf)
    refresh.log.addHandler(h)
    os.environ["FACILITIES_API_KEY"] = KEY
    try:
        rc = refresh.main()
    finally:
        refresh.log.removeHandler(h)
    st = json.load(open(os.path.join(tmp, refresh.STATUS_FILE)))
    logged = buf.getvalue()
    check(rc == 0 and st["ok"] is False and st["cause"] == want,
          f"{type(outcome).__name__}{'(' + str(getattr(outcome, 'code', '')) + ')' if hasattr(outcome, 'code') else ''}"
          f" -> cause {want} (got {st['cause']}), exit 0")
    check(KEY not in logged and KEY not in json.dumps(st), f"  {want}: the API key appears in neither the log nor the file")
    check("body_head" not in st, f"  {want}: no body head in the committed status file")
    if isinstance(outcome, (urllib.error.HTTPError, Resp)):
        check("body head:" in logged, f"  {want}: the log carries the HTTP status and body head")
# a truncated body (IncompleteRead raised from read()) is a dropped connection too
class _Trunc(Resp):
    def read(self):
        import http.client as _hc
        raise _hc.IncompleteRead(b"{\"as_of", 7000)
refresh.urllib.request.urlopen = lambda req, timeout=None: _Trunc(200, b"")
os.environ["FACILITIES_API_KEY"] = KEY
refresh.main()
st = json.load(open(os.path.join(tmp, refresh.STATUS_FILE)))
check(st["cause"] == "app_down" and "IncompleteRead" in st["detail"],
      f"a truncated reply is a dropped connection (app_down), not bad_shape (got {st['cause']})")

print("\n-- a malformed key never reaches the public file --")
TWO_LINE = "fixture-key-first-half\nfixture-key-second-half"
os.environ["FACILITIES_API_KEY"] = TWO_LINE
called = []
refresh.urllib.request.urlopen = lambda req, timeout=None: called.append(1) or Resp(200, json.dumps(FEED))
buf = io.StringIO(); h = logging.StreamHandler(buf); refresh.log.addHandler(h)
try:
    rc = refresh.main()
finally:
    refresh.log.removeHandler(h)
raw_status = open(os.path.join(tmp, refresh.STATUS_FILE)).read()
st = json.loads(raw_status)
check(rc == 0 and st["cause"] == "key_malformed" and not called,
      f"a key with a line break: cause key_malformed, and no request is even made (got {st['cause']})")
check("first-half" not in raw_status and "second-half" not in raw_status
      and "first-half" not in buf.getvalue() and "second-half" not in buf.getvalue(),
      "neither half of the key appears in the status file or the log")
check(refresh.scrub("Invalid header value b'fixture-key-first-half\\nfixture-key-second-half'", TWO_LINE)
      .count("[key]") >= 1 and "first-half" not in refresh.scrub(
          "Invalid header value b'fixture-key-first-half\\nfixture-key-second-half'", TWO_LINE),
      "scrub() removes a key quoted in its escaped form, as http.client would quote it")
os.environ["FACILITIES_API_KEY"] = KEY

refresh.urllib.request.urlopen = lambda req, timeout=None: Resp(200, json.dumps(FEED))
rc = refresh.main()
st = json.load(open(os.path.join(tmp, refresh.STATUS_FILE)))
check(rc == 0 and st["ok"] is True and st["cause"] == "ok" and st["last_ok_at"] == st["attempted_at"],
      "a good pull records ok and stamps last_ok_at")
w = json.load(open(refresh.OUT_PATH))
check(w.get("pulled_by") == "bake" and w.get("pulled_at"), "the written copy says the bake pulled it")
os.environ.pop("FACILITIES_API_KEY", None)
rc = refresh.main()
st = json.load(open(os.path.join(tmp, refresh.STATUS_FILE)))
check(st["cause"] == "no_key" and st["last_ok_at"], "no key: cause no_key, and last_ok_at survives from the good pull")
refresh.urllib.request.urlopen = real_urlopen

# ---- 2. the PythonAnywhere push script --------------------------------------
print("\n-- facilities_push_pythonanywhere.py --")
for name, bad in (("good", FEED), ("pairs is a count", dict(FEED, kr2_repeat_issues=dict(FEED["kr2_repeat_issues"], pairs=2))),
                  ("faults is a list", dict(FEED, faults=[])), ("three sites", dict(FEED, sites=FEED["sites"][:3])),
                  ("not an object", [1, 2])):
    v = []
    for fn in (refresh.sanity, push.sanity):
        try:
            fn(copy.deepcopy(bad)); v.append("ok")
        except ValueError as e:
            v.append(str(e))
    check(v[0] == v[1], f"same shape verdict as the bake's pull for '{name}' ({v[0][:40]})")


class GH:
    """A fake for the app feed + GitHub's Contents API; records every call."""

    def __init__(self, get_status=404, put_seq=(201,), sha="abc123", feed=FEED):
        self.calls, self.get_status, self.put_seq, self.sha, self.feed = [], get_status, list(put_seq), sha, feed

    def __call__(self, req, timeout=None):
        url, method = req.full_url, req.get_method()
        hdrs = {k.lower(): v for k, v in req.header_items()}
        body = json.loads(req.data) if req.data else None
        self.calls.append((method, url, hdrs, body))
        if "pythonanywhere" in url:
            return Resp(200, json.dumps(self.feed))
        if method == "GET":
            if self.get_status == 200:
                return Resp(200, json.dumps({"sha": self.sha}))
            raise http_error(self.get_status, b'{"message":"Not Found"}', "application/json")
        st = self.put_seq.pop(0)
        if st in (200, 201):
            return Resp(st, json.dumps({"commit": {"html_url": "https://github.com/MakiManc/ops/commit/f00"}}))
        raise http_error(st, b'{"message":"conflict"}', "application/json")


def run_push(argv=(), env=None, gh=None):
    gh = gh or GH()
    old = {k: os.environ.get(k) for k in ("OPS_PUSH_TOKEN", "FACILITIES_API_KEY")}
    push.ENV_FILE = os.path.join(tmp, "no-such.env")
    for k in old:
        os.environ.pop(k, None)
    os.environ.update(env if env is not None else {"OPS_PUSH_TOKEN": TOKEN, "FACILITIES_API_KEY": KEY})
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            rc = push.main(list(argv), opener=gh,
                           now=datetime.datetime(2026, 10, 9, 6, 30, tzinfo=datetime.timezone.utc))
    finally:
        for k, v in old.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
    return rc, out.getvalue(), gh


rc, out, gh = run_push()
puts = [c for c in gh.calls if c[0] == "PUT"]
check(rc == 0 and len(puts) == 1, f"first push: exit 0, one PUT (got rc={rc}, {len(puts)})")
m, url, hdrs, body = puts[0]
check(url.endswith("/repos/MakiManc/ops/contents/data/ops_command/facilities_ppm_pushed.json"),
      "it writes facilities_ppm_pushed.json in MakiManc/ops - not the bake's own file")
check(body["branch"] == "main" and "sha" not in body, "to main, with no sha for a new file")
written = json.loads(base64.b64decode(body["content"]))
check(written["pulled_by"] == "pythonanywhere" and written["pulled_at"] == "2026-10-09T06:30:00Z"
      and written["as_of"] == FEED["as_of"], "the pushed copy is the feed, stamped pulled_at and pulled_by")
check(hdrs.get("authorization") == f"Bearer {TOKEN}", "GitHub is called with the token")
feed_call = next(c for c in gh.calls if "pythonanywhere" in c[1])
check(feed_call[2].get("x-api-key") == KEY and "authorization" not in feed_call[2],
      "the app is called with the API key, and never sent the GitHub token")
check(TOKEN not in out and KEY not in out, "neither secret is printed")
check("pushed: https://github.com/MakiManc/ops/commit/f00" in out, "it prints the commit URL")

rc, out, gh = run_push(gh=GH(get_status=200))
body = next(c for c in gh.calls if c[0] == "PUT")[3]
check(rc == 0 and body.get("sha") == "abc123", "an existing file is updated with its sha")

rc, out, gh = run_push(gh=GH(get_status=200, put_seq=(409, 201)))
check(rc == 0 and len([c for c in gh.calls if c[0] == "PUT"]) == 2, "a 409 conflict re-reads the sha and retries once")

rc, out, gh = run_push(gh=GH(get_status=401))
check(rc == 3 and "rejected OPS_PUSH_TOKEN" in out, "an expired token: exit 3, saying so")

rc, out, gh = run_push(gh=GH(put_seq=(403,)))
check(rc == 3 and "Contents: Read and write" in out, "a token without write: exit 3, naming the permission")

rc, out, gh = run_push(["--dry-run"], env={"FACILITIES_API_KEY": KEY})
check(rc == 0 and not any(c for c in gh.calls if "api.github.com" in c[1]),
      "--dry-run fetches and checks the feed and touches GitHub not at all - and needs no token")

rc, out, gh = run_push(env={"FACILITIES_API_KEY": KEY})
check(rc == 2 and "OPS_PUSH_TOKEN" in out and not gh.calls, "no token: exit 2 naming it, nothing called")

rc, out, gh = run_push(gh=GH(feed=dict(FEED, sites=[])))
check(rc == 1 and not any(c[0] == "PUT" for c in gh.calls), "a bad feed is refused before anything is pushed")

envf = os.path.join(tmp, "ops_push.env")
open(envf, "w").write(f"# comment\nOPS_PUSH_TOKEN={TOKEN}\nFACILITIES_API_KEY='{KEY}'\n")
os.chmod(envf, 0o600)
check(push.load_secrets(envf) == {"OPS_PUSH_TOKEN": TOKEN, "FACILITIES_API_KEY": KEY},
      "the secrets file is read (comments skipped, quotes stripped)")

# ---- 3. the bake: fresher copy wins; stale names the cause ------------------
print("\n-- the bake reads the fresher copy --")
d = os.path.join(tmp, "bake")
os.makedirs(d)
own = dict(FEED, pulled_at="2026-10-01T15:00:00Z", pulled_by="bake")
pushed = dict(FEED, pulled_at="2026-10-09T06:30:00Z", pulled_by="pythonanywhere")
json.dump(own, open(os.path.join(d, bake.FACILITIES_FILE), "w"))
f, e, lbl = bake.load_facilities_best(d)
check(lbl.endswith(bake.FACILITIES_FILE) and f["pulled_at"] == own["pulled_at"], "no pushed copy: the bake's own")
json.dump(pushed, open(os.path.join(d, bake.FACILITIES_PUSHED_FILE), "w"))
f, e, lbl = bake.load_facilities_best(d)
check(lbl.endswith(bake.FACILITIES_PUSHED_FILE) and f["pulled_by"] == "pythonanywhere", "a newer push wins")
json.dump(dict(own, pulled_at="2026-10-09T15:00:00Z"), open(os.path.join(d, bake.FACILITIES_FILE), "w"))
f, e, lbl = bake.load_facilities_best(d)
check(lbl.endswith(bake.FACILITIES_FILE), "a newer pull wins over an older push")
open(os.path.join(d, bake.FACILITIES_PUSHED_FILE), "w").write("{not json")
f, e, lbl = bake.load_facilities_best(d)
check(lbl.endswith(bake.FACILITIES_FILE) and f is not None, "a corrupt push is ignored, never quoted")
os.remove(os.path.join(d, bake.FACILITIES_FILE))
json.dump(pushed, open(os.path.join(d, bake.FACILITIES_PUSHED_FILE), "w"))
f, e, lbl = bake.load_facilities_best(d)
check(lbl.endswith(bake.FACILITIES_PUSHED_FILE) and e is None, "with no own copy at all, the push alone serves")

today = datetime.date(2026, 10, 9)
st_fail = {"attempted_at": "2026-10-09T15:00:00Z", "ok": False, "cause": "app_disabled",
           "detail": "a 200 carrying PythonAnywhere's placeholder page", "http_status": 200}
blk = bake.facilities_block(dict(FEED, pulled_at="2026-09-25T09:47:06Z"), None, today, pull_status=st_fail)
why = blk["rows"]["KR4 statutory compliance"]["not_measured"]
check(blk["tab"]["status"] == "stale" and "EXPIRED" in why and "Run until 1 month" in why,
      "stale for 14 days: the grey rows name the cause - the app has expired")
check(blk["tab"]["pull"]["cause"] == "app_disabled", "and the tab carries the last attempt")
for cause, word in (("key_rejected", "REJECTED the API key"), ("timeout", "asleep"), ("app_down", "5xx")):
    b2 = bake.facilities_block(dict(FEED, pulled_at="2026-09-25T09:47:06Z"), None, today,
                               pull_status=dict(st_fail, cause=cause))
    check(word in b2["tab"]["note"], f"cause {cause}: the stale note says '{word}'")
b3 = bake.facilities_block(dict(FEED, pulled_at="2026-10-08T15:00:00Z"), None, today,
                           pull_status=dict(st_fail, cause="timeout"))
check(b3["tab"]["status"] == "ok" and "asleep" in (b3["tab"]["pull_note"] or ""),
      "inside the 3-day grace: still quoted, but the tab warns that today's pull failed and why")
b4 = bake.facilities_block(dict(FEED, pulled_at="2026-10-09T16:00:00Z"), None, today,
                           pull_status=dict(st_fail, cause="timeout", attempted_at="2026-10-09T15:00:00Z"))
check(b4["tab"]["pull_note"] is None, "a failed attempt OLDER than the copy in use (e.g. the push landed later) raises no warning")
b5 = bake.facilities_block(dict(FEED, pulled_at="2026-10-09T06:30:00Z"), None, today,
                           label="data/ops_command/" + bake.FACILITIES_PUSHED_FILE)
check("PythonAnywhere" in b5["tab"]["origin"], "the tab says which route delivered the copy")

print("\n-- the verifier picks the same copy as the bake --")
import verify_ops_data as verify  # noqa: E402
vd = os.path.join(tmp, "verify")
os.makedirs(vd)
man = {"feeds": [{"name": "Facilities PPM summary", "store": "side_channel",
                  "file": "facilities_ppm.json", "status": "best_effort"}]}
def vrun(own=None, pushed=None, today="2026-10-09"):
    for fn, v in (("facilities_ppm.json", own), ("facilities_ppm_pushed.json", pushed)):
        p_ = os.path.join(vd, fn)
        if os.path.exists(p_):
            os.remove(p_)
        if v is not None:
            open(p_, "w").write(v if isinstance(v, str) else json.dumps(v))
    verify.RESULTS.clear()
    out = verify.check_facilities(today, man, os.path.join(vd, "facilities_ppm.json"))
    return verify.RESULTS[-1], out
r, out = vrun(own="{not json", pushed=dict(FEED, pulled_at="2026-10-09T06:30:00Z"))
check(r["level"] == "ok" and out.get("facilities_copy") == "facilities_ppm_pushed.json",
      f"bake copy unreadable, fresh push: ok on the push, as the bake decides (got {r['level']})")
nan_push = json.dumps(dict(FEED, pulled_at="2026-10-09T06:30:00Z")).replace('"kr4_pct": 37', '"kr4_pct": NaN', 1)
r, out = vrun(own=dict(FEED, pulled_at="2026-09-25T09:00:00Z"), pushed=nan_push)
check(out.get("facilities_copy") == "facilities_ppm.json" and r["level"] == "warning",
      "a pushed copy holding NaN is passed over, exactly as the bake rejects it")
r, out = vrun(own=dict(FEED, pulled_at="2026-09-25T09:00:00Z"), pushed=dict(FEED, pulled_at="2026-10-05T06:30:00Z"))
check(r["detail"].startswith("facilities_ppm_pushed.json last pulled 2026-10-05")
      and "facilities_ppm.json, was pulled 2026-09-25" in r["detail"],
      f"a stale message names the copy it measured and gives the other's date (got {r['detail'][:110]!r})")
r, out = vrun(own="{not json", pushed=None)
check(r["level"] in ("warning", "critical") and "unreadable" in r["detail"],
      "neither copy usable: still reported unreadable")

shutil.rmtree(tmp, ignore_errors=True)
print()
if failures:
    print(f"{failures} assertion(s) FAILED")
    sys.exit(1)
print("all assertions passed")
