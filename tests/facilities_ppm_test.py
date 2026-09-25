#!/usr/bin/env python3
"""Fixture test for the Facilities app feed -> OO2 KR1 / KR2 / KR4 (25/09/2026).

WHY THIS TEST EXISTS
  Three OO2 KRs that were grey placeholders now read facilities_ppm.json, a
  file pulled from the M&R Facilities app before every bake. Each has a trap
  that produces a plausible wrong number rather than an error, so each is
  pinned here against a trimmed copy of the real 25/09/2026 pull
  (tests/fixtures/facilities_ppm.json):

    KR4  the group figure is the app's (current+due30)/tasks - 84 of 227, 37%
         - and never a mean of the nineteen site percentages (which is 35.8).
    KR2  the app zero-fills every month before its fault log began (Sep 2026),
         so a Jun-Aug baseline built from its own array is 0.0 per site and
         the first September repeat reads as an infinite increase. It must
         stay grey, naming why.
    all  a stale file looks exactly like a fresh one - the refresh leaves the
         old file in place when the app is asleep - so past 3 days all three
         must go grey and name the file.

WHAT IT CHECKS
  1. facilities_block() directly, with a pinned clock: fresh, stale, absent,
     unreadable, reshaped, and the KR2 / KR4 / KR1 edge cases.
  2. The REAL builder end to end (bake_ops_command.py over a one-row archive,
     into a temp OPS_OUT_DIR): the three rows land on the scorecard with the
     expected values, score and RAG, and a stale file greys them.
  3. The verifier's check 6 thresholds and the manifest's side-channel entry.

Run: python3 tests/facilities_ppm_test.py   (needs duckdb for part 2, as
tests/price_spike_attribution_test.py does; exits non-zero on any failure)
"""

from __future__ import annotations

import atexit
import copy
import datetime
import gzip
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BAKE = os.path.join(REPO, "builders", "bake_ops_command.py")
VERIFY = os.path.join(REPO, "builders", "verify_ops_data.py")
FIXTURE = os.path.join(HERE, "fixtures", "facilities_ppm.json")
MANIFEST = os.path.join(REPO, "data", "ops_command", "feeds_manifest.json")


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        pass
    return mod


bake = _load("bake", BAKE)
verify = _load("verify", VERIFY)

failures = 0


def check(cond, msg):
    global failures
    if cond:
        print("ok  :", msg)
    else:
        failures += 1
        print("FAIL:", msg)


with open(FIXTURE, encoding="utf-8") as fh:
    FEED = json.load(fh)
TODAY = datetime.date(2026, 9, 25)          # the fixture's own pull date
KR1, KR2, KR4 = ("KR1 PPM on time", "KR2 repeat issues vs baseline",
                 "KR4 statutory compliance")
KR1_WHY = ("no PPM completion has been logged with a due date yet — backfilled "
           "certificates carry no on-time flag; the figure starts counting from "
           "the first completion logged in the app (25 Sep 2026 onwards)")
KR2_WHY = ("baseline needs Jun–Aug; the app's fault log starts Sep 2026 — the "
           "sheet-based KR2 build (plan of 17 Sep) remains the baseline source "
           "until the January re-baseline")


def block(feed=None, today=TODAY, **kw):
    return bake.facilities_block(copy.deepcopy(FEED if feed is None else feed),
                                 None, today, **kw)


# ---- 1. the fresh path, on the real numbers --------------------------------
b = block()
r4, r1, r2 = b["rows"][KR4], b["rows"][KR1], b["rows"][KR2]
check(b["tab"]["status"] == "ok" and b["gap"] is None, "fresh fixture: status ok, no gap")
check(r4.get("value") == 37, f"KR4 value is the app's group kr4_pct, 37 (got {r4.get('value')})")
check(r4.get("display") == "37% (84 of 227)", f"KR4 display '37% (84 of 227)' (got {r4.get('display')!r})")
check(r4.get("source_kind") == "facilities_app", "KR4 says it came from the Facilities app")
for frag in ("84 of 227 tracked statutory items across 19 sites current or due within 30 days",
             "37 overdue", "106 with no certificate on file (placeholder date, not counted as compliant)",
             "franchise sites excluded", "from the Facilities app, as of 2026-09-25",
             "never an average of the site percentages", "no month variants"):
    check(frag in (r4.get("basis") or ""), f"KR4 basis says: {frag}")
check(not r4.get("months"), "KR4 carries no month variants (the app has no history table)")
check("does not match" not in r4["basis"], "KR4: the app's 37 agrees with its own counts (84/227 = 37.0%)")
_mean = sum(s["kr4_pct"] for s in FEED["sites"]) / len(FEED["sites"])
check(round(_mean, 1) != 37 and r4["value"] != round(_mean, 1),
      f"KR4 is NOT the mean of site percentages ({_mean:.1f})")
check(r1 == {"not_measured": KR1_WHY}, "KR1 grey with the exact 'no completion logged yet' reason")
check("value" not in r2 and (r2.get("not_measured") or "").startswith(KR2_WHY),
      "KR2 grey with the exact baseline reason")
for frag in (FEED["kr2_repeat_issues"]["rule"], "2 chaser reports merged",
             "zero-filled, not measured, and are never used as a baseline"):
    check(frag in r2["not_measured"], f"KR2 reason carries: {frag[:60]}")

tab = b["tab"]
pcts = [s["kr4_pct"] for s in tab["sites"]]
check(pcts == sorted(pcts) and len(pcts) == 19, "per-site drill-down: 19 sites, kr4_pct ascending")
check(tab["sites"][0]["code"] in ("M6", "M8") and tab["sites"][-1]["code"] == "M15",
      "worst site first (M6/M8 at 0%), best last (M15 at 79%)")
check(all(s["oldest_overdue_days"] is None for s in tab["sites"] if not s["overdue"]),
      "a site with nothing overdue shows no 'oldest overdue' age, not 0 days")
check([m["logged"] for m in tab["kr2"]["months"]] == [False] * 5 + [True],
      "KR2 months Apr-Aug flagged as pre-log zero-fill, Sep as logged")
check(tab["faults"] == {"open": 0, "open_over_14d": 0, "assets_down": 0}, "fault queue passed through (real: all zero)")
check("franchise" not in tab["notes"]["faults"] and "every site" not in tab["notes"]["faults"],
      "the fault card makes no scope claim the feed does not support")
_ct = sum(c["tasks"] for c in FEED["contractors"])          # 161 in the trimmed fixture
check(f"{_ct} of the 227 tracked items" in tab["notes"]["contractors"]
      and f"{227 - _ct} have no contractor assigned" in tab["notes"]["contractors"],
      f"the contractor card says how many items have no contractor ({227 - _ct} in the fixture)")
check(len(tab["contractors"]) == 8 and tab["contractors"][0]["name"] == "IDES",
      "contractor scorecard in the app's order")
check(tab["links"]["compliance"] == "https://rossmward.eu.pythonanywhere.com/compliance"
      and tab["links"]["insights"] == "https://rossmward.eu.pythonanywhere.com/insights",
      "tab header links to the app's /compliance and /insights")

# ---- 2. stale, absent, unreadable, reshaped: grey, never a number ----------
for age, stale in ((3, False), (4, True), (30, True)):
    bs = block(today=TODAY + datetime.timedelta(days=age))
    greys = all("value" not in bs["rows"][k] and bs["rows"][k].get("not_measured") for k in (KR1, KR2, KR4))
    if stale:
        check(greys and "stale" in bs["rows"][KR4]["not_measured"]
              and "data/ops_command/facilities_ppm.json" in bs["rows"][KR4]["not_measured"]
              and bs["tab"]["status"] == "stale",
              f"{age} days old: all three KRs grey, naming the stale file")
        check(len(bs["tab"]["sites"]) == 19, f"{age} days old: the tab still shows the data, under a banner")
    else:
        check(bs["rows"][KR4].get("value") == 37, f"{age} days old: still fresh (limit is 3)")
nope = bake.facilities_block(*bake.load_facilities(os.path.join(HERE, "no_such_file.json")), TODAY)
check(all("absent" in nope["rows"][k]["not_measured"] for k in (KR1, KR2, KR4))
      and nope["gap"] and nope["tab"]["status"] == "missing",
      "file absent: all three grey, a top-level gap, status missing")
tmpd = tempfile.mkdtemp(prefix="facfix-")
atexit.register(shutil.rmtree, tmpd, True)      # even when an assertion path dies
bad = os.path.join(tmpd, "facilities_ppm.json")
with open(bad, "w") as fh:
    fh.write("{not json")
ub = bake.facilities_block(*bake.load_facilities(bad), TODAY)
check(all("unreadable" in ub["rows"][k]["not_measured"] for k in (KR1, KR2, KR4)),
      "unreadable file: all three grey, saying so - the bake does not crash")
reshaped = copy.deepcopy(FEED)
del reshaped["group"]
rb = block(reshaped)
check("group" in rb["rows"][KR4]["not_measured"] and "value" not in rb["rows"][KR4],
      "feed without 'group': grey, naming the key")
nop = copy.deepcopy(FEED)
del nop["pulled_at"]
check("pulled_at" in block(nop)["rows"][KR4]["not_measured"], "no pulled_at: age unprovable, grey")

# ---- 3. KR2: the baseline can only come from months the fault log covered --
f2 = copy.deepcopy(FEED)
for m in f2["kr2_repeat_issues"]["months"]:
    m["per_site"] = {"2026-06": 0.5, "2026-07": 0.4, "2026-08": 0.6, "2026-09": 0.3}.get(m["month"], 0.0)
check("value" not in block(f2)["rows"][KR2],
      "Jun-Aug with non-zero rows but BEFORE the log start: still grey, never a baseline")
m2 = block(f2, fault_log_start="2026-06")["rows"][KR2]
check(m2.get("value") == -40.0, f"once the log covers Jun-Aug: 0.3 vs mean 0.5 = -40.0% (got {m2.get('value')})")
check(bake.okr_score("repeat", m2.get("value")) == 100, "-40% scores 100 on the repeat band")
check([v["m"] for v in (m2.get("months") or [])] == ["2026-09"],
      "KR2 month variants start after the baseline")
for frag in ("Jun–Aug 2026 baseline mean of 0.50 per site", "Rule '", "2 chaser reports merged",
             "app's own fault log"):
    check(frag in (m2.get("basis") or ""), f"KR2 measured basis: {frag}")
z = block(fault_log_start="2026-04")["rows"][KR2]
check("value" not in z and "undefined" in z["not_measured"],
      "a genuine 0.0 baseline: grey ('change against zero is undefined'), never a number")

# ---- 4. KR1 / KR4 edge cases -----------------------------------------------
f1 = copy.deepcopy(FEED)
f1["group"].update(kr1_pct=96, kr1_n=25, kr1_ok=24)
k1 = block(f1)["rows"][KR1]
check(k1.get("value") == 96 and k1.get("display") == "96% (24 of 25)",
      f"KR1 measured: value 96, display shows kr1_ok/kr1_n (got {k1.get('display')!r})")
f1["group"].update(kr1_pct=100, kr1_n=0, kr1_ok=0)
check("value" not in block(f1)["rows"][KR1], "KR1 with kr1_n 0: grey, not 100% of nothing")
f4 = copy.deepcopy(FEED)
f4["group"]["kr4_pct"] = 50
d4 = block(f4)["rows"][KR4]
check(d4.get("value") == 37.0 and "does not match its counts (37.0%)" in d4["basis"],
      "KR4 app figure disagreeing with its own counts: scored on the counts, and said")
# The app rounds to a whole percent, and the band is 'full'. 226 of 227 is
# 99.56%, which the app sends as 100: that must never score 100 / green.
f4 = copy.deepcopy(FEED)
f4["group"].update(current=212, due30=14, overdue=1, no_evidence=0, tasks=227, kr4_pct=100)
d4 = block(f4)["rows"][KR4]
check(d4.get("value") == 99.5 and bake.okr_score("full", d4["value"]) != 100
      and "rounded to a whole percent" in d4["basis"],
      f"KR4 226/227 with the app showing 100: scored 99.5, not green (got {d4.get('value')})")
f4 = copy.deepcopy(FEED)
f4["group"].update(current=227, due30=0, overdue=0, no_evidence=0, kr4_pct=100)
check(block(f4)["rows"][KR4].get("value") == 100.0, "KR4 227/227: exactly 100")
for bad_kr4, what in ((None, "null"), (137, "out of range")):
    f4 = copy.deepcopy(FEED)
    f4["group"]["kr4_pct"] = bad_kr4
    b4 = block(f4)
    check("value" not in b4["rows"][KR4] and b4["tab"]["group"]["kr4_pct"] is None
          and b4["tab"].get("group_note"),
          f"KR4 {what}: grey, and the tab's group row shows no figure either")
f4 = copy.deepcopy(FEED)
del f4["group"]["current"]
b4 = block(f4)
check("value" not in b4["rows"][KR4] and "group.current" in b4["rows"][KR4]["not_measured"]
      and b4["tab"]["group"]["kr4_pct"] is None, "KR4 without its counts: grey on the Overview and the tab")
f4 = copy.deepcopy(FEED)
f4["sites"] = []
b4 = block(f4)["rows"][KR4]
check("across 0 sites" not in b4["basis"] and "no usable per-site rows" in b4["basis"]
      and "sum to 0 items against the group's 227" in b4["basis"],
      "KR4 with no site rows: says so, never 'across 0 sites'")
fk = copy.deepcopy(FEED)
for k in ("repeats", "sites"):
    del fk["kr2_repeat_issues"]["months"][-1][k]
bk = block(fk)
check(all("None" not in (bk["rows"][k].get("not_measured") or bk["rows"][k].get("basis") or "")
          for k in (KR1, KR2, KR4)), "a month missing its counts never prints 'None' into a reason")

# ---- 5. malformed feeds never crash, and never publish invalid JSON ---------
MALFORMED = [
    ("kr2 pairs is a count", lambda f: f["kr2_repeat_issues"].__setitem__("pairs", 2)),
    ("kr2 months is a count", lambda f: f["kr2_repeat_issues"].__setitem__("months", 6)),
    ("kr2 months is true", lambda f: f["kr2_repeat_issues"].__setitem__("months", True)),
    ("kr2 by_site is a count", lambda f: f["kr2_repeat_issues"].__setitem__("by_site", 3)),
    ("contractors is a count", lambda f: f.__setitem__("contractors", 19)),
    ("source is an object", lambda f: f.__setitem__("source", {"name": "x", "v": 2})),
    ("a site is a string", lambda f: f["sites"].append("M99")),
    ("a site kr4_pct is 137", lambda f: f["sites"][0].__setitem__("kr4_pct", 137)),
]
for what, mutate in MALFORMED:
    fm = copy.deepcopy(FEED)
    mutate(fm)
    try:
        bm = block(fm)
        ok = all(k in bm["rows"] for k in (KR1, KR2, KR4))
        json.dumps(bm, allow_nan=False)
    except Exception as e:  # noqa: BLE001
        ok = False
        print("   raised:", type(e).__name__, e)
    check(ok, f"malformed feed ({what}): no exception, all three rows present")
fm = copy.deepcopy(FEED)
fm["kr2_repeat_issues"]["months"] = 6
check("no kr2_repeat_issues.months list" in block(fm)["rows"][KR2]["not_measured"],
      "KR2 with months not a list: grey, naming the field (not a baseline story)")
fm = copy.deepcopy(FEED)
fm["sites"][0]["kr4_pct"] = 137
check(all(s["kr4_pct"] is None or 0 <= s["kr4_pct"] <= 100 for s in block(fm)["tab"]["sites"]),
      "a site kr4_pct outside 0-100 never becomes a 'Compliant' figure")
nan_path = os.path.join(tmpd, "nan.json")
with open(nan_path, "w") as fh:
    fh.write(json.dumps(FEED).replace('"kr4_pct": 37', '"kr4_pct": NaN', 1))
nb = bake.facilities_block(*bake.load_facilities(nan_path), TODAY)
check(all("unreadable" in nb["rows"][k]["not_measured"] for k in (KR1, KR2, KR4))
      and "NaN" in nb["rows"][KR4]["not_measured"],
      "a NaN in the file: unreadable, grey - never passed on to the snapshot")
check(bake._fac_num(float("nan")) is None and bake._fac_num(float("inf")) is None
      and bake._fac_num(True) is None and bake._fac_num(3) == 3, "_fac_num: finite numbers only, no bools")


# ---- 6. the real builder, end to end ----------------------------------------
def bake_with(feed_or_raw, out, manifest=None):
    """Run bake_ops_command.py over a one-row archive into `out`.

    feed_or_raw: a dict (written as JSON), a str (written verbatim - for a NaN),
    or None (no file). manifest: a dict to use instead of the real one.
    """
    arch = os.path.join(out, "arch", "2026-09-25")
    os.makedirs(arch, exist_ok=True)
    with gzip.open(os.path.join(arch, "Dummy.jsonl.gz"), "wt") as fh:
        fh.write(json.dumps({"row_num": 0, "data": {"x": 1}}) + "\n")
    if manifest is None:
        shutil.copy(MANIFEST, out)
    else:
        with open(os.path.join(out, "feeds_manifest.json"), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh)
    if feed_or_raw is not None:
        with open(os.path.join(out, "facilities_ppm.json"), "w", encoding="utf-8") as fh:
            fh.write(feed_or_raw if isinstance(feed_or_raw, str) else json.dumps(feed_or_raw))
    env = dict(os.environ, OPS_WAREHOUSE_SOURCE="archive",
               OPS_ARCHIVE_DIR=os.path.join(out, "arch"), OPS_OUT_DIR=out)
    p = subprocess.run([sys.executable, BAKE, "--date", "2026-09-25"],
                       env=env, capture_output=True, text=True)
    if p.returncode != 0:
        print("builder failed:\n", p.stdout[-2000:], p.stderr[-2000:])
        return None
    with open(os.path.join(out, "snapshot_2026-09-25.json"), encoding="utf-8") as fh:
        # Strict: the browser's JSON.parse rejects NaN, so the test does too.
        return json.loads(fh.read(), parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))


def oo2(snap, kr):
    return next((r for r in snap["scorecard"]["rows"]
                 if (r.get("objective"), r.get("kr")) == ("OO2", kr)), None)


# The bake judges age against the wall clock, so stamp the copy relative to now.
# The real fixture's fault queue is all zeros and its pairs / by_site are
# empty, which cannot catch two fields swapped in the wiring - so the fresh
# copy carries distinct test values there (the fixture file stays as the app
# sent it).
utc = datetime.datetime.now(datetime.timezone.utc)
fresh = copy.deepcopy(FEED)
fresh["pulled_at"] = utc.strftime("%Y-%m-%dT%H:%M:%SZ")
fresh["faults"] = {"open": 3, "open_over_14d": 1, "assets_down": 2}
fresh["kr2_repeat_issues"]["by_site"] = [{"site": "Maki 9", "repeats": 1}, {"site": "Maki 3", "repeats": 2}]
fresh["kr2_repeat_issues"]["pairs"] = [{"site": "Maki 3", "asset": "Fryer 2", "first": "2026-09-02",
                                        "fix_date": "2026-09-04", "second": "2026-09-20", "days": 18,
                                        "note": "x"}]
stale = copy.deepcopy(FEED)
stale["pulled_at"] = (utc - datetime.timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%SZ")

snap = bake_with(fresh, os.path.join(tmpd, "fresh"))
check(snap is not None, "the real builder bakes with the fixture in OPS_OUT_DIR")
if snap:
    k4, k1s, k2s = oo2(snap, "KR4"), oo2(snap, "KR1"), oo2(snap, "KR2")
    check(k4 and k4["value"] == 37 and k4["display"] == "37% (84 of 227)",
          "scorecard OO2 KR4: 37% (84 of 227)")
    check(k4 and k4["score"] == 0 and k4["rag"] == "red" and k4["band"] == "full",
          "scorecard OO2 KR4: scores 0 / red on the agreed 'full' band")
    check(k4 and k4["source_kind"] == "facilities_app" and k4["tab"] == "p-maint",
          "scorecard OO2 KR4: from the Facilities app, drills to the Maintenance tab")
    check(k4 and k4["months"] is None, "scorecard OO2 KR4: no month variants")
    check(k1s and k1s["value"] is None and k1s["not_measured"] == KR1_WHY, "scorecard OO2 KR1 grey, reason verbatim")
    check(k2s and k2s["value"] is None and k2s["not_measured"].startswith(KR2_WHY)
          and k2s["band_status"] == "proposed", "scorecard OO2 KR2 grey, reason verbatim, band still PROPOSED")
    for kr in ("KR3", "KR5"):
        r = oo2(snap, kr)
        check(r and r["value"] is None and "Lincoln's maintenance sheet" in (r["not_measured"] or ""),
              f"scorecard OO2 {kr} unchanged")
    o = next(o for o in snap["scorecard"]["objectives"] if o["objective"] == "OO2")
    check(o["scored"] == 1 and o["pct"] == 0.0, "OO2 objective: 1 of 5 scored, 0%")
    fac = snap["maintenance"]["facilities"]
    check(fac["status"] == "ok" and len(fac["sites"]) == 19 and fac["n_sites"] == 19,
          "snap.maintenance.facilities carries the 19-site drill-down")
    check(fac["faults"] == {"open": 3, "open_over_14d": 1, "assets_down": 2},
          "fault queue wired field-for-field (distinct values)")
    check([(b["site"], b["repeats"]) for b in fac["kr2"]["by_site"]] == [("Maki 3", 2), ("Maki 9", 1)],
          "KR2 by-site sorted most repeats first")
    check(fac["kr2"]["pairs"] == fresh["kr2_repeat_issues"]["pairs"], "KR2 pairs wired field-for-field")
    check(not any("acilities" in g for g in snap["gaps"]), "no Facilities gap on a fresh file")
    check("Facilities PPM summary" not in [r["feed"] for r in snap["feed_health"]],
          "the side-channel manifest entry never appears in feed_health")

snap = bake_with(stale, os.path.join(tmpd, "stale"))
if snap:
    for kr in ("KR1", "KR2", "KR4"):
        r = oo2(snap, kr)
        check(r and r["value"] is None and r["score"] is None
              and "stale" in (r["not_measured"] or "")
              and "facilities_ppm.json" in (r["not_measured"] or ""),
              f"stale file (10 days): scorecard OO2 {kr} grey, naming the file")
    check(snap["maintenance"]["facilities"]["status"] == "stale", "stale file: the tab says stale")

snap = bake_with(None, os.path.join(tmpd, "absent"))
if snap:
    r = oo2(snap, "KR4")
    check(r and r["value"] is None and "absent" in (r["not_measured"] or ""),
          "no file at all: the bake still succeeds and OO2 KR4 is grey")
    check(any("facilities_ppm.json" in g for g in snap["gaps"]), "no file at all: a named top-level gap")

for what, raw in (("pairs is a count", dict(fresh, kr2_repeat_issues=dict(fresh["kr2_repeat_issues"], pairs=2))),
                  ("source is an object", dict(fresh, source={"v": 2})),
                  ("a NaN", json.dumps(fresh).replace('"kr4_pct": 37', '"kr4_pct": NaN', 1))):
    snap = bake_with(raw, os.path.join(tmpd, "bad-" + what.replace(" ", "_")))
    check(snap is not None and all(k in (oo2(snap, "KR4") or {}) for k in ("value", "not_measured")),
          f"malformed feed ({what}): the real bake exits 0 and publishes strict JSON")

# ---- 7. the verifier's check 6, and the manifest entry ----------------------
with open(MANIFEST, encoding="utf-8") as fh:
    man = json.load(fh)
ent = [f for f in man["feeds"] if f.get("store") == "side_channel"]
check(len(ent) == 1 and ent[0]["file"] == "facilities_ppm.json" and ent[0]["status"] == "best_effort",
      "manifest: one side_channel entry, facilities_ppm.json, best_effort")
for days, want in ((0, "ok"), (2, "ok"), (3, "warning"), (7, "warning"), (8, "warning")):
    verify.RESULTS.clear()
    verify.check_facilities((TODAY + datetime.timedelta(days=days)).isoformat(), man, FIXTURE)
    got = verify.RESULTS[-1]
    check(got["level"] == want and (days < 8 or "would be critical" in got["detail"]),
          f"check 6 at {days}d: {want}" + (" (critical capped by best_effort)" if days == 8 else ""))
# The manifest note tells an operator to flip the entry to expected once the
# tab is depended on. The side-channel filters only matter from that moment,
# so they are tested against the FLIPPED manifest - with the entry left
# best_effort they would pass with the filters deleted.
man_x = copy.deepcopy(man)
for f in man_x["feeds"]:
    if f.get("store") == "side_channel":
        f["status"] = "expected"
verify.RESULTS.clear()
verify.check_facilities((TODAY + datetime.timedelta(days=8)).isoformat(), man_x, FIXTURE)
check(verify.RESULTS[-1]["level"] == "critical", "check 6 at 8d with the entry flipped to expected: critical")
_mx = os.path.join(tmpd, "flipped")
os.makedirs(_mx, exist_ok=True)
with open(os.path.join(_mx, "feeds_manifest.json"), "w", encoding="utf-8") as fh:
    json.dump(man_x, fh)
_saved, bake.OUT_DIR = bake.OUT_DIR, _mx
try:
    _exp = bake.expected_feeds()
finally:
    bake.OUT_DIR = _saved
check(ent and ent[0]["name"] not in _exp and len(_exp) > 30,
      "flipped to expected: the bake still never counts the file as a warehouse feed")
snap = bake_with(fresh, os.path.join(tmpd, "fresh-flipped"), manifest=man_x)
# The one-row archive holds no warehouse feed, so every expected WAREHOUSE feed
# is legitimately MISSING here; the file must not be one of them.
check(snap is not None and "Facilities PPM summary" not in [r["feed"] for r in snap["feed_health"]]
      and snap["summary"]["feeds_missing"] == len(_exp),
      "flipped to expected: no MISSING row for the file; 'Feeds missing' counts warehouse feeds only")


class _EmptyStore:
    """A cursor over a store with no rows at all: every feed has NEVER landed."""
    def execute(self, *_a, **_k):
        pass

    def fetchall(self):
        return []

    def fetchone(self):
        return (None,)


for m_, which in ((man, "best_effort"), (man_x, "flipped to expected")):
    verify.RESULTS.clear()
    verify.check_feeds(_EmptyStore(), m_, TODAY.isoformat(), {})
    _named = {r.get("feed") for r in verify.RESULTS}
    check(ent and ent[0]["name"] not in _named and len(_named) > 30,
          f"check 1 skips the side-channel entry ({which}) while still checking every warehouse feed")

# ---- 8. refresh_facilities.py: a bad pull never replaces a good file --------
refresh = _load("refresh", os.path.join(REPO, "builders", "refresh_facilities.py"))
_good = os.path.join(tmpd, "refresh", "facilities_ppm.json")
os.makedirs(os.path.dirname(_good), exist_ok=True)
refresh.OUT_DIR, refresh.OUT_PATH = os.path.dirname(_good), _good
os.environ["FACILITIES_API_KEY"] = "test-key"
_orig_fetch = refresh.fetch
try:
    for what, served in (
            ("pairs is a count", dict(FEED, kr2_repeat_issues=dict(FEED["kr2_repeat_issues"], pairs=2))),
            ("faults is a list", dict(FEED, faults=[{"id": 1}])),
            ("a NaN", dict(FEED, group=dict(FEED["group"], kr4_pct=float("nan"))))):
        with open(_good, "w") as fh:
            fh.write('{"sentinel": true}')
        refresh.fetch = lambda _k, _s=served: copy.deepcopy(_s)
        rc = refresh.main()
        with open(_good) as fh:
            check(rc == 0 and fh.read() == '{"sentinel": true}',
                  f"refresh, served a feed where {what}: exit 0, previous file untouched")
    refresh.fetch = lambda _k: copy.deepcopy(FEED)
    rc = refresh.main()
    with open(_good) as fh:
        written = json.load(fh)
    check(rc == 0 and written.get("as_of") == "2026-09-25" and written.get("pulled_at"),
          "refresh, served a good feed: writes it with a fresh pulled_at")
finally:
    refresh.fetch = _orig_fetch
    os.environ.pop("FACILITIES_API_KEY", None)

print("\n" + ("all assertions passed" if not failures else f"{failures} assertion(s) FAILED"))
sys.exit(1 if failures else 0)
