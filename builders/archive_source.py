"""Read the warehouse from the committed archive instead of Postgres.

Phase 2 of moving the ops warehouse off Neon. Presents the gzipped pull archive
(warehouse_direct/ or warehouse_archive/, both the same format) through a DuckDB
connection shaped like the psycopg2 one bake_ops_command.py already uses, so the
bake's 27 queries run against files with no rewrite.

    conn = archive_source.connect("/path/to/warehouse_direct")
    cur  = conn.cursor()
    cur.execute("SELECT ... FROM etl_feed_rows WHERE feed=%s", ("Kobas Orders",))

NOTHING SWITCHES TO THIS AUTOMATICALLY. bake_ops_command.py uses it only when
OPS_WAREHOUSE_SOURCE=archive, so the default path is untouched and the two can be
run back to back and diffed.

DIALECT - VERIFIED AGAINST DUCKDB 1.5.5, NOT ASSUMED
----------------------------------------------------
These behave identically to Postgres and need no translation:
    DISTINCT ON              count(*) FILTER (WHERE ...)     string_agg
    date_trunc('week', ...)  + INTERVAL '6 day'              substr
    ::text ::date ::int      nullif(...)                     ->>
    date - date -> INTEGER   (the feed-health staleness column relies on this;
                              it was the one I expected to differ, and it does not)

Two differences do need translating, both mechanical:
    %s -> ?          psycopg2 positional params
    bare alias       Postgres accepts `data->>'Order Ref' ref`; DuckDB needs AS

THE JSON CAST IS LOAD-BEARING
-----------------------------
read_json_auto infers `data` as a typed STRUCT when the glob covers one feed, but
degrades to MAP(VARCHAR, JSON) across the ~50 feeds in a full archive - and on a
MAP every `->>` silently returns NULL rather than erroring. CAST(data AS JSON)
restores Postgres semantics. Removing it does not fail loudly; it just quietly
empties the dashboard.

FEED NAMES
----------
The archive filename is a lossy slug ([^A-Za-z0-9]+ -> _), so the real feed name
is read from the _feeds.json that archive_writer.py writes per pull date. Older
pulls predate that file; for those the name is recovered from the feeds manifest,
and anything still unresolved keeps its slug so a query for it returns nothing
rather than silently matching the wrong feed.
"""
from __future__ import annotations

import glob
import json
import os
import re
from typing import Any, Sequence

SLUG_RE = re.compile(r"[^A-Za-z0-9]+")

# DuckDB binds a comparison tighter than ->>, where Postgres does the opposite:
#     data->>'module_status'<>'Complete'
# parses as  data ->> ('module_status' <> 'Complete'), making the right operand a
# BOOLEAN, which DuckDB then treats as an array index and tries to cast the whole
# JSON object to a number. It fails loudly here, but the same precedence applied
# to an = comparison is the kind of thing that returns a wrong answer quietly, so
# every extraction gets parenthesised rather than only the ones seen to break.
# Verified: bare form errors, parenthesised form returns 30,235 rows.
_JSON_EXTRACT = re.compile(
    r"(?<![\w')])([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)"
    r"\s*->>\s*('(?:[^']|'')*')")

# Postgres allows an alias to follow an expression with no AS. DuckDB does not
# when the expression ends in a JSON operator or a closing paren.
#
# The keyword guard is not decoration. Without it this matched the END of a CASE
# ("...substr(m.dd,1,2) END FROM m") and rewrote it to "AS END", which DuckDB
# rejects - and a keyword that happened to parse would have silently changed the
# query's meaning instead. Anything that is a word SQL already owns is never an
# alias, so exclude the lot rather than the two that happened to bite.
_KEYWORDS = (
    "end|then|else|when|case|and|or|not|is|null|in|like|ilike|between|"
    "desc|asc|from|where|group|order|having|limit|offset|on|using|join|"
    "inner|left|right|full|cross|union|except|intersect|as|filter|over|"
    "partition|distinct|by|for|with|returning|nulls|first|last"
)
_BARE_ALIAS = re.compile(
    r"(->>\s*'[^']+'|\)) +(?!(?:" + _KEYWORDS + r")\b)"
    r"([a-z_][a-z0-9_]*)(\s*)(,|\s+FROM\b)",
    re.IGNORECASE)


def slug(feed: str) -> str:
    s = SLUG_RE.sub("_", feed).strip("_")
    return s or "feed"


def translate(sql: str) -> str:
    """psycopg2/Postgres SQL -> the DuckDB equivalent. Mechanical, not clever.

    Order matters: parenthesise extractions first, so the alias pass then sees a
    closing paren and handles `(data->>'x') alias` by its existing rule.
    """
    sql = _JSON_EXTRACT.sub(r"(\1->>\2)", sql)
    sql = _BARE_ALIAS.sub(r"\1 AS \2\3\4", sql)
    return sql.replace("%s", "?")


def _feed_map(archive_dir: str, manifest: str | None) -> dict[str, str]:
    """slug -> real feed name, preferring what the writer recorded at the time."""
    out: dict[str, str] = {}
    if manifest and os.path.exists(manifest):
        try:
            with open(manifest, encoding="utf-8") as f:
                m = json.load(f)
            for entry in (m["feeds"] if isinstance(m, dict) else m):
                name = entry["name"] if isinstance(entry, dict) else entry
                out[slug(name)] = name
        except Exception:  # noqa: BLE001 - a bad manifest must not stop the read
            pass
    # _feeds.json is authoritative where present: it was written next to the data.
    for p in sorted(glob.glob(os.path.join(archive_dir, "*", "_feeds.json"))):
        try:
            with open(p, encoding="utf-8") as f:
                out.update(json.load(f))
        except Exception:  # noqa: BLE001
            pass
    return out


class _Cursor:
    """The four methods bake_ops_command.py actually calls."""

    def __init__(self, con):
        self._con = con
        self._res = None

    def execute(self, sql: str, params: Sequence[Any] | None = None):
        q = translate(sql)
        self._res = (self._con.execute(q, list(params)) if params
                     else self._con.execute(q))
        return self

    def fetchall(self):
        return self._res.fetchall() if self._res is not None else []

    def fetchone(self):
        return self._res.fetchone() if self._res is not None else None

    def close(self):
        self._res = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class _Connection:
    def __init__(self, con):
        self._con = con

    def cursor(self):
        return _Cursor(self._con)

    def close(self):
        self._con.close()


def connect(archive_dir: str, manifest: str | None = None) -> _Connection:
    """Open the archive as if it were the warehouse.

    Builds one view named etl_feed_rows with the same columns the real table has
    (feed, pull_date, row_num, data) so the bake's SQL binds unchanged.
    """
    try:
        import duckdb
    except ImportError:  # pragma: no cover
        raise SystemExit("duckdb is required for OPS_WAREHOUSE_SOURCE=archive: "
                         "pip install duckdb")

    pattern = os.path.join(archive_dir, "*", "*.jsonl.gz")
    if not glob.glob(pattern):
        raise SystemExit(f"no archive files under {archive_dir!r} - nothing to read")

    fmap = _feed_map(archive_dir, manifest)
    if fmap:
        cases = " ".join(
            "WHEN {} THEN {}".format(_lit(s), _lit(n)) for s, n in sorted(fmap.items()))
        feed_expr = f"CASE {_SLUG_FROM_FILENAME} {cases} ELSE {_SLUG_FROM_FILENAME} END"
    else:
        feed_expr = _SLUG_FROM_FILENAME

    con = duckdb.connect()
    # A TABLE, not a VIEW. As a view every one of the bake's 27 queries re-parses
    # the whole gzipped archive: measured at 278s per bake against 21s for the
    # Postgres one, a 13x regression that would have made the daily bake slower
    # than the export. Materialising reads the gzip once and leaves the queries
    # hitting memory. The archive is ~53MB compressed / ~1.2M rows, which fits
    # comfortably; if it ever stops fitting, the answer is a per-feed read rather
    # than going back to a view.
    con.execute(f"""
        CREATE TABLE etl_feed_rows AS
        SELECT {feed_expr}                                            AS feed,
               CAST(regexp_extract(filename, '(\\d{{4}}-\\d{{2}}-\\d{{2}})', 1)
                    AS DATE)                                          AS pull_date,
               row_num,
               CAST(data AS JSON)                                     AS data
        FROM read_json_auto({_lit(pattern)}, filename=true,
                            union_by_name=true, maximum_object_size=20000000)
    """)
    # Every query filters on feed, and most also on pull_date - the same index
    # the real table carries (etl_feed_rows_feed_idx).
    con.execute("CREATE INDEX etl_feed_rows_feed_idx ON etl_feed_rows (feed, pull_date)")
    return _Connection(con)


_SLUG_FROM_FILENAME = r"regexp_extract(filename, '([^/]+)\.jsonl\.gz$', 1)"


def _lit(s: str) -> str:
    """Single-quoted SQL literal. Feed names come from our own files, but they
    contain apostrophes often enough that escaping is not optional."""
    return "'" + s.replace("'", "''") + "'"
