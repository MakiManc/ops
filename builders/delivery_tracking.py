"""OO4 KR3: supplier orders tracked from the order to the goods-in (Phase 4.2).

THE KR, VERBATIM: "KR3: >=95% of deliveries tracked end-to-end (departure ->
receipt) (KOBAS)", band pct95.

ROSS'S DECISION, 12/10/2026, VERBATIM: "Kobas goods in from suppliers use the
orders that come in through email and the deliveries report to track all
orders are delivered".

So the measure is: of the supplier orders Kobas emailed a confirmation for
(feed 'Kobas Orders'), the share that have a goods-in on Kobas's deliveries
report. Departure is the order email - Kobas records no despatch - and receipt
is the goods-in's booking date.

WHAT MAKES IT HARD, STATED PLAINLY
  * THE DELIVERIES REPORT CARRIES NO ORDER NUMBER. An order and its goods-in
    can only be paired by site, supplier and date - except where a site typed
    the order ref ("3031/<id>") into the goods-in's Invoice Number, which is an
    exact link (about 2% of goods-ins). So pairing needs a day window, and the
    window moves the figure: on the one week we hold (orders due 13-19/08),
    same-day pairing finds 39 of 61 (64%), the due date + 2 days 50 (82%). That window is a
    rule, so it was PROPOSED (12/10/2026) and no month was scored until Ross
    agreed it: "2 day window agreed" (Ross, 15/10/2026). MATCH_RULE_STATUS
    keeps the gate, so a future change of window is shown, unscored, until
    it too is agreed.
  * THE REPORT HAS NEVER BEEN SCHEDULED. The only copy is a one-off "[TEST]"
    send covering goods-ins booked 13-20/08; the export skips "[TEST]"
    subjects since 01/09. Any report whose subject holds "Ops Deliveries" is
    read (DELIVERIES_FEED_RE), so a scheduled daily send lands with no code
    change.
  * CANCELLED ORDERS ARE INVISIBLE in the order emails, so a cancelled order
    counts as not received: the figure is a lower bound.
  * FACTORY DELIVERIES SEND NO ORDER EMAIL, so they are outside this measure
    (Ross: "goods in from suppliers").

The functions here are pure - the bake queries the rows and passes them in -
so the whole rule is testable without a warehouse.
"""
from __future__ import annotations

import datetime
import math
import re

#: Any Kobas emailed report whose subject names the deliveries report. The
#: export names a feed "Kobas Report - " + its subject, so the one-off test
#: send is "Kobas Report - [TEST] Test - Ops Deliveries" and a scheduled one
#: would be e.g. "Kobas Report - Daily Ops Deliveries".
DELIVERIES_FEED_RE = re.compile(r"^Kobas Report - .*\bOps Deliveries\b", re.I)

#: An order pairs with a goods-in at the same site from the same supplier,
#: booked from the day the order was emailed to this many days after its due
#: date. AGREED by Ross on 15/10/2026, verbatim "2 day window agreed"
#: (proposed 12/10/2026): it is the narrowest window that pairs every exact
#: link (11 of 11 orders whose ref was typed on a goods-in) and agrees with
#: Kobas's own pending list on 57 of 61 orders due 13-19/08.
MATCH_DAYS_AFTER_DUE = 2
#: "agreed" - months are scored; "proposed" - figures are shown, never scored
#: (a rule is not scored before Ross agrees it). Set back to "proposed" with
#: any change of MATCH_DAYS_AFTER_DUE until he agrees the new window.
MATCH_RULE_STATUS = "agreed"
#: What was agreed is THE WINDOW, not the flag: {days after due: by whom}. A
#: window not in here is proposed whatever MATCH_RULE_STATUS says (review,
#: 15/10/2026), so a back-test or a caller passing another k is never scored
#: under, or labelled with, an agreement nobody gave.
MATCH_RULE_AGREED = {2: "Ross, 15/10/2026"}

FIRST_MONTH = "2026-08"
_MONTHS = ("January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December")


def mlabel(ym):
    return _MONTHS[int(ym[5:7]) - 1] + " " + ym[:4]


def dmy(iso):
    return f"{iso[8:10]}/{iso[5:7]}/{iso[:4]}"


def _d(iso):
    return datetime.date.fromisoformat(iso)


def _days(a, b):
    """Every ISO day from a to b inclusive."""
    x, y = _d(a), _d(b)
    while x <= y:
        yield x.isoformat()
        x += datetime.timedelta(days=1)


def _next_month(ym):
    y, m = int(ym[:4]), int(ym[5:7])
    return f"{y + (m == 12)}-{1 if m == 12 else m + 1:02d}"


def _last_day(ym):
    return (_d(_next_month(ym) + "-01") - datetime.timedelta(days=1)).isoformat()


def _iso(s):
    s = str(s or "").strip()[:10]
    try:
        _d(s)
        return s
    except ValueError:
        return None


def is_deliveries_feed(name):
    return bool(DELIVERIES_FEED_RE.search(str(name or "")))


# ---------------------------------------------------------------------------
# the goods-in side
# ---------------------------------------------------------------------------
def goods_in(rows):
    """Deduped goods-ins and each pull's span.

    rows  [(pull_date, feed, {Venue, Supplier, Kobas ID, Delivery Date,
           Invoice Number, Last Modified, status}), ...] - every pull of every
           deliveries feed.

    -> (goods, pulls, deleted)
       goods    [{"id", "site", "sup", "date", "ref"}]: one per Kobas ID, the
                latest pull's copy, Deleted ones dropped
       pulls    {(pull_date, feed): {"rows", "lm_min", "lm_max"}} - the Last
                Modified span each pull carried, for coverage()
       deleted  how many goods-ins the latest copy marks Deleted
    """
    latest, pulls = {}, {}
    for pd, feed, r in rows:
        if not isinstance(r, dict):
            continue
        p = pulls.setdefault((str(pd)[:10], feed), {"rows": 0, "lm_min": None, "lm_max": None})
        p["rows"] += 1
        lm = str(r.get("Last Modified") or r.get("Created") or "")[:19]
        if _iso(lm):
            p["lm_min"] = min(p["lm_min"] or lm, lm)
            p["lm_max"] = max(p["lm_max"] or lm, lm)
        gid = str(r.get("Kobas ID") or "").strip()
        if not gid:
            continue
        if gid not in latest or str(pd) >= latest[gid][0]:
            latest[gid] = (str(pd), r)
    goods, deleted = [], 0
    for gid, (_, r) in latest.items():
        if str(r.get("status") or "").strip().lower() == "deleted":
            deleted += 1
            continue
        day = _iso(r.get("Delivery Date") or r.get("Created"))
        site, sup = str(r.get("Venue") or "").strip(), str(r.get("Supplier") or "").strip()
        if not day or not site or not sup:
            continue
        goods.append({"id": gid, "site": site, "sup": sup, "date": day,
                      "ref": str(r.get("Invoice Number") or "").strip() or None})
    goods.sort(key=lambda g: (g["date"], g["id"]))
    return goods, pulls, deleted


def coverage(pulls, sent):
    """The days the deliveries report covers, as a sorted list.

    pulls  goods_in()'s per-pull spans
    sent   {(pull_date, feed): 'YYYY-MM-DD'} - the email's own send date where
           the export's receipt recorded one

    A report lists the goods-ins modified in a window ending when it was sent,
    so a pull covers from the day after its oldest Last Modified (that first
    day may be cut part-way) to the day before it was sent - or, with no
    receipt, the day before its newest Last Modified (that day may be cut too).
    A pull with no rows proves nothing and covers nothing.
    """
    days = set()
    for key, p in pulls.items():
        if not p["rows"] or not p["lm_min"]:
            continue
        a = (_d(p["lm_min"][:10]) + datetime.timedelta(days=1)).isoformat()
        s = sent.get(key)
        b = ((_d(s) - datetime.timedelta(days=1)).isoformat() if s
             else (_d(p["lm_max"][:10]) - datetime.timedelta(days=1)).isoformat())
        if a <= b:
            days.update(_days(a, b))
    return sorted(days)


# ---------------------------------------------------------------------------
# pairing
# ---------------------------------------------------------------------------
def match(orders, goods, k=MATCH_DAYS_AFTER_DUE):
    """{order ref: (goods-in id, "ref" | "window")} - one goods-in per order.

    orders  [{"ref", "site", "sup", "dd", "emailed"}] - due date and email date ISO
    goods   goods_in()'s list

    First the exact links: a goods-in whose Invoice Number IS an order's ref,
    at the same site from the same supplier. Then, per site and supplier,
    CLOSEST FIRST: every order takes a goods-in booked on its due date; then
    the orders still open take one booked a day after it, then a day before,
    two days after, and so on out to the window [email date, due + k].

    Closest first, not "as many pairs as the windows allow": with a delivery
    every day, the most pairs comes from sliding each goods-in back a day to
    the order before, which moves a missed order's miss to the END of the run
    - into a later month - instead of leaving it on its own day (a 07/10 miss
    read as October 100% in the review of this rule, 13/10/2026). Site and
    supplier are Kobas's own names on both sides, never a canonical name: the
    LWC depots are different suppliers for this purpose.
    """
    by_ref = {o["ref"]: o for o in orders if o.get("ref")}
    paired, used = {}, set()
    for g in goods:
        o = by_ref.get(g["ref"]) if g["ref"] else None
        if (o and o["ref"] not in paired and o["site"] == g["site"]
                and o["sup"] == g["sup"]):
            paired[o["ref"]] = (g["id"], "ref")
            used.add(g["id"])
    free = {}
    for g in goods:
        if g["id"] not in used:
            free.setdefault((g["site"], g["sup"], g["date"]), []).append(g["id"])
    todo = sorted((o for o in orders if o.get("ref") and o["ref"] not in paired and o.get("dd")),
                  key=lambda o: (o["dd"], o["ref"]))
    early = max([0] + [(_d(o["dd"]) - _d(o["emailed"])).days for o in todo
                       if o.get("emailed") and o["emailed"] < o["dd"]])
    for delta in sorted(range(-early, k + 1), key=lambda x: (abs(x), x < 0)):
        for o in todo:
            if o["ref"] in paired:
                continue
            day = (_d(o["dd"]) + datetime.timedelta(days=delta)).isoformat()
            if day < (o.get("emailed") or o["dd"]):
                continue
            ids = free.get((o["site"], o["sup"], day))
            if ids:
                paired[o["ref"]] = (ids.pop(0), "window")
    return paired


# ---------------------------------------------------------------------------
# the KR, by month
# ---------------------------------------------------------------------------
def _floor1(x):
    return math.floor(round(x * 10, 6)) / 10


#: What the deliveries report needs, said wherever the row is grey for want of it.
REPORT_NEEDS = ("Kobas needs to email the deliveries report DAILY, with 'Ops Deliveries' in "
                "its subject and no '[TEST]' (the export skips test sends), over a rolling "
                "window of at least 7 days")
def order_email_days(order_pulls):
    """The days whose order emails some pull of 'Kobas Orders' read, sorted.

    order_pulls  [(pull_date, oldest 'Order Email Date', newest), ...] - one per
                 pull of the feed, from its OWN rows

    A pull covers from the oldest email it holds to the newest, and never the
    day it ran (that day is only partly read). Taken from the rows rather than
    from the export's 14-day fetch window (re-review, 13/10/2026): a backfill
    pull holding weeks of emails covers them all, and a pull that keeps
    running after the emails stop arriving covers nothing new.
    """
    days = set()
    for p, lo, hi in order_pulls or ():
        p, lo, hi = _iso(p), _iso(lo), _iso(hi)
        if p and lo and hi:
            end = min(hi, (_d(p) - datetime.timedelta(days=1)).isoformat())
            if lo <= end:
                days.update(_days(lo, end))
    return sorted(days)


def kr3_months(orders, goods, covered, pull_month, mvar, score_fn, rag_fn,
               first_dd=None, deleted=0, feeds=(), first_month=FIRST_MONTH,
               k=MATCH_DAYS_AFTER_DUE, status=MATCH_RULE_STATUS, orders_why=None,
               order_pulls=None, asof=None, mtd_min_days=7):
    """OO4 KR3 as an `_okr_extra` entry, plus gaps.

    orders      the deduped 'Kobas Orders' rows: {"ref","site","sup","dd","emailed"}
    goods       goods_in()'s goods-ins; covered: coverage()'s days
    first_dd    {supplier: the first due date its order emails show} - a supplier
                whose emails start after a month's 1st is left out of that month
                and named (the OTIF rule, 09/09/2026)
    feeds       the deliveries feed names read, for the basis
    orders_why  why the order emails cannot be used, or None
    order_pulls each pull of 'Kobas Orders' as (pull_date, oldest email date,
                newest) - a day no pull read is a day whose orders may be
                missing (review, 13/10/2026: an email outage shrank the month
                and nothing said so). None skips the check (pure-function
                tests only; the bake always passes them).
    asof        the bake's own date, for the "is the report still coming" gap
    mtd_min_days the scorecard's month-to-date minimum (OKR_MTD_MIN_DAYS), so
                the open month's display says "not scored" only past it

    An order is JUDGED when the report covers every day of its window [email
    date, due + k]; it is RECEIVED when match() pairs it. Value = received /
    judged, cut DOWN to 0.1. A closed month is scored only when every order in
    it is judged, every day its orders could have been emailed was read, AND
    the pairing rule is agreed; otherwise it is shown, unscored, with the
    reason. The open month carries its covered days for the month-to-date rule.
    """
    gaps = []
    if orders_why:
        why = f"the Kobas order emails cannot be used: {orders_why}"
        return ({"months": None, "source_kind": "not_measured", "not_measured": why},
                [f"OO4 KR3 is grey: {why}"])
    if not feeds:
        why = ("no Kobas deliveries report has reached the export. Ross chose Kobas goods-in "
               "(12/10/2026); " + REPORT_NEEDS)
        return ({"months": None, "source_kind": "not_measured", "not_measured": why},
                [f"OO4 KR3 (deliveries tracked to receipt) is grey: {why}"])
    first_dd = first_dd or {}
    cov = set(covered)
    through = covered[-1] if covered else None
    asof = asof or _last_day(pull_month)
    # the report has stopped (or never covered a day) when its newest covered
    # day is more than 2 days old: a daily send covers up to yesterday, and a
    # bake can run before the day's email lands
    stale = through is None or through < (_d(asof) - datetime.timedelta(days=2)).isoformat()
    email_days = set(order_email_days(order_pulls)) if order_pulls is not None else None
    newest_pull = max((_iso(p[0]) or "" for p in order_pulls or ()), default="") or None
    # an order can be emailed up to this many days before it is due (the
    # longest lead the orders themselves show), so the order side of a month
    # starts that many days before its 1st (re-review, 13/10/2026)
    lead = max([1] + [(_d(o["dd"]) - _d(o["emailed"])).days for o in orders
                      if o.get("emailed") and o.get("dd") and _iso(o["emailed"]) and o["emailed"] < o["dd"]])
    paired = match(orders, goods, k)
    rule = (f"paired at the same site from the same supplier, booked between the order email "
            f"and {k} day{'' if k == 1 else 's'} after the due date, one goods-in per order (or "
            "the order ref typed on the goods-in, an exact link)")
    if status == "agreed" and k not in MATCH_RULE_AGREED:
        status = "proposed"
    note = (f"Of the supplier orders Kobas emailed a confirmation for, the share with a goods-in "
            f"on Kobas's deliveries report ({', '.join(sorted(feeds))}) - Ross, 12/10/2026. "
            f"Departure is the order email (Kobas records no despatch), receipt the goods-in's "
            f"booking date; {rule}. The report carries no order number, so the day window is "
            f"what pairs them - "
            + (f"agreed ({MATCH_RULE_AGREED[k]})" if status == "agreed"
               else f"{status.upper()}, so no month is scored until Ross agrees it")
            + ". A cancelled order cannot be seen and counts as not received; factory "
            "deliveries send no order email and are outside this measure"
            + (f"; {deleted} goods-in{' is' if deleted == 1 else 's are'} marked Deleted and "
               "not counted" if deleted else ""))
    needs = (" " + REPORT_NEEDS + "." if stale else "")
    out = []
    m = first_month
    while m <= pull_month:
        last = _last_day(m)
        m_days = list(_days(m + "-01", last))
        n_cov = sum(1 for d in m_days if d in cov)
        span = (f"the deliveries report covers {n_cov} of {mlabel(m)}'s {len(m_days)} days"
                + (f" (its newest covered day is {dmy(through)})" if through else
                   " (no copy of it covers any day)"))
        due = [o for o in orders if o.get("dd", "")[:7] == m and o.get("ref")]
        late_sup = sorted({o["sup"] for o in due
                           if first_dd.get(o["sup"], "") > m + "-01"})
        due_in = [o for o in due if o["sup"] not in late_sup]
        judged, waiting, holed = [], 0, 0
        for o in due_in:
            hi = (_d(o["dd"]) + datetime.timedelta(days=k)).isoformat()
            lo = min(o.get("emailed") or o["dd"], o["dd"])
            if through is None or hi > through:
                waiting += 1
            elif all(d in cov for d in _days(lo, hi)):
                judged.append(o)
            else:
                holed += 1
        # the order side: every day an order due in the month could have been
        # emailed (the day before the 1st to the day before the last day, as
        # far as the bake's date) must have been read by some pull. A CLOSED
        # month is checked to its end, whatever the newest pull: an export that
        # stopped mid-month leaves the rest of it "never read", so the month is
        # incomplete until a later pull reads it (review, 15/10/2026 - the cap
        # at the newest pull hid that once the window was agreed and months
        # began to score). The open month allows one day of lag only: the
        # export reads yesterday's emails, and a bake can run before it.
        _ue = min((_d(last) - datetime.timedelta(days=1)).isoformat(),
                  (_d(asof) - datetime.timedelta(days=2)).isoformat())
        _us = (_d(m + "-01") - datetime.timedelta(days=lead)).isoformat()
        unread = ([d for d in _days(_us, _ue) if d not in email_days]
                  if email_days is not None and _us <= _ue else [])
        recv = [o for o in judged if o["ref"] in paired]
        left = ""
        if late_sup:
            left += (f" Left out: {', '.join(late_sup)} - their order emails begin after "
                     f"{dmy(m + '-01')}, so part of the month's orders were never seen.")
        if unread:
            # a day after the newest pull's reach is not yet read; one before
            # it was never read (a backfill can still recover either)
            _reach = ((_d(newest_pull) - datetime.timedelta(days=1)).isoformat()
                      if newest_pull else None)
            never = [d for d in unread if _reach and d <= _reach]
            notyet = [d for d in unread if not (_reach and d <= _reach)]
            for days_, what in ((never, "were never read"),
                                (notyet, "have not been read yet - the newest 'Kobas Orders' "
                                         f"pull is {dmy(newest_pull)}" if newest_pull
                                         else "have not been read - no 'Kobas Orders' pull is recorded")):
                if days_:
                    left += (f" The order emails of {len(days_)} day(s) {what} "
                             f"({', '.join(dmy(d)[:5] for d in days_[:6])}"
                             + (f" and {len(days_) - 6} more" if len(days_) > 6 else "")
                             + "), so orders due in the month may be missing from it.")
        if waiting:
            left += (f" {waiting} order(s) not judged: their window runs past "
                     + (f"{dmy(through)}, the last day any copy of the report covers." if through
                        else "any day the report covers."))
        if holed:
            left += (f" {holed} order(s) not judged: the report does not cover every day of "
                     "their window.")
        if not judged:
            why = (f"no supplier order due in {mlabel(m)} can be judged - {span}"
                   + (f"; {len(due_in)} order(s) emailed" if due_in
                      else f"; {len(due)} order(s) emailed, all from suppliers left out" if due
                      else "; none emailed")
                   + "." + left + needs)
            if m == pull_month:
                out.append(mvar(m, mtd=True, score=None, coverage_days=0,
                                basis="month-to-date, not yet scored (0 orders judged) - " + why
                                + " " + note))
            else:
                out.append(mvar(m, not_measured=why))
            m = _next_month(m)
            continue
        val = _floor1(100.0 * len(recv) / len(judged))
        miss = {}
        for o in judged:
            if o["ref"] not in paired:
                miss[o["sup"]] = miss.get(o["sup"], 0) + 1
        miss_t = (" Not received: " + ", ".join(f"{s} {n}" for s, n in
                                                sorted(miss.items(), key=lambda x: (-x[1], x[0]))[:8])
                  + ("" if len(miss) <= 8 else f" and {len(miss) - 8} more supplier(s)") + "."
                  if miss else "")
        exact = sum(1 for o in recv if paired[o["ref"]][1] == "ref")
        core = (f"{len(recv)} of {len(judged)} supplier orders due in {mlabel(m)} have a goods-in"
                + (f" ({exact} by the order ref typed on the goods-in)" if exact else "")
                + f"; {span}." + miss_t)
        disp = f"{val:g}% ({len(recv)} of {len(judged)})"
        complete = not waiting and not holed and not unread
        _un = set(unread)
        cdays = sum(1 for d in _days(m + "-01", min(last, through or last)) if d in cov)
        if m == pull_month:
            # a day whose order emails were not read is not a day of data for
            # the month-to-date rule either (as _cov_holes does) - left out of
            # the count, not subtracted after it, so a day the report never
            # covered is not taken off twice (round-2 review, 15/10/2026)
            cdays = sum(1 for d in _days(m + "-01", min(last, through or last))
                        if d in cov and d not in _un)
            agreed = status == "agreed"
            out.append(mvar(m, value=val,
                            display=(disp if agreed or cdays < mtd_min_days
                                     else f"{disp} - not scored"),
                            score=score_fn(val) if agreed else None,
                            rag=rag_fn(score_fn(val)) if agreed else None,
                            coverage_days=cdays,
                            basis=((core + left + needs + " " + note) if agreed else
                                   f"not scored - the pairing window is {status}, not agreed - "
                                   + core + left + needs + " " + note)))
        elif not complete or status != "agreed":
            why = ("an INCOMPLETE month" if not complete
                   else f"the pairing window is {status}, not agreed")
            out.append(mvar(m, value=val, display=f"{disp} - not scored", score=None, rag=None,
                            incomplete=True, coverage_days=cdays,
                            basis=f"not scored - {why} - " + core + left + needs + " " + note))
        else:
            s = score_fn(val)
            out.append(mvar(m, value=val, display=disp, score=s, rag=rag_fn(s),
                            coverage_days=cdays, basis=core + left + " " + note))
        m = _next_month(m)
    if stale:
        gaps.append("OO4 KR3: "
                    + (f"the newest Kobas deliveries report covers goods-ins to {dmy(through)} only"
                       if through else "no copy of the Kobas deliveries report covers a whole day")
                    + " - " + REPORT_NEEDS)
    if status != "agreed":
        gaps.append(f"OO4 KR3: the order-to-goods-in pairing window (due date + {k} days) is "
                    f"{status}, not agreed - no month is scored until Ross confirms it")
    return {"months": out, "source_kind": "computed", "tab": "p-supp"}, gaps
