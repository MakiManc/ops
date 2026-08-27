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

TWO DIRECTORIES, ONE WAREHOUSE
------------------------------
The archive arrived by two routes and neither covers the whole span. Pulls from
13/08/2026 were archived out of Postgres into warehouse_archive/; from 27/08/2026
the export writes warehouse_direct/ itself. Reading either one alone is wrong in
a different direction - archive-only goes stale the day Neon stops being written,
direct-only silently drops every pull before it existed - so connect() takes
several directories joined by os.pathsep, in PRECEDENCE order:

    connect("warehouse_direct" + os.pathsep + "warehouse_archive")

Files are resolved per (pull_date, filename), and the FIRST directory that has one
wins; the rest are skipped, not concatenated. Concatenating would double every row
of every overlapping pull - a silent doubling of the whole dashboard, since both
routes write the same pull_date on the same day.

Direct wins over archive because it is first-hand. archive_writer.write_pull is
atomic (write .tmp, verify the gzip line count round-trips, rename), so a file
present there is a complete file; warehouse_archive/ is a dump of whatever
Postgres held, which on 26/08/2026 - Neon at its 512 MB cap, zero rows stored,
every fetch fine - was nothing at all.

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

THE `data` COLUMN IS PINNED TO JSON, NOT AUTO-DETECTED
------------------------------------------------------
This used to be read_json_auto with CAST(data AS JSON) over the top, and what
DuckDB inferred depended on HOW MANY FEEDS THE FILE SET HAPPENED TO COVER:

    ~50 feeds  -> MAP(VARCHAR, JSON), on which every ->> silently returns NULL
    one pull   -> a typed STRUCT, which then dies outright on the first pair of
                  keys differing only in case:
                  "Duplicate name \"Language\" in struct auto-detected in JSON"

So the same code read the fortnight-wide archive fine and could not read a single
day of it - a property of the input, discoverable only by trying. read_json with
an explicit columns= pins row_num and data to BIGINT and JSON whatever the set
looks like, which is what the archive envelope has always been. The CAST is kept
below as a free no-op so the intent survives if anyone loosens this again.

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
# The key can be a quoted literal OR a %s placeholder - the ETL sibling's
# headcount extract joins on b.data->>%s = t.data->>%s and hit the same trap.
_JSON_EXTRACT = re.compile(
    r"(?<![\w')])([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)"
    r"\s*->>\s*('(?:[^']|'')*'|%s)")

# Functions Postgres has and DuckDB does not, all verified missing rather than
# assumed. The argument matches non-greedily up to the quoted format string, so
# nested calls with their own commas survive: to_date(substring(x,1,10),'...').
_JSONB_KEYS = re.compile(r"\bjsonb_object_keys\s*\(([^()]*)\)")
_TO_CHAR = re.compile(r"\bto_char\s*\((.+?),\s*'([^']+)'\s*\)", re.IGNORECASE)
_TO_DATE = re.compile(r"\bto_date\s*\((.+?),\s*'([^']+)'\s*\)", re.IGNORECASE)
_TO_REGCLASS = re.compile(
    r"\bto_regclass\s*\(\s*'([^']+)'\s*\)\s+IS\s+NOT\s+NULL", re.IGNORECASE)
_FMT_TOKENS = [("YYYY", "%Y"), ("MM", "%m"), ("DD", "%d"),
               ("HH24", "%H"), ("MI", "%M"), ("SS", "%S")]


def _fmt(pg_format: str) -> str:
    for pg, du in _FMT_TOKENS:
        pg_format = pg_format.replace(pg, du)
    return pg_format

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
    sql = _JSONB_KEYS.sub(r"unnest(json_keys(\1))", sql)
    sql = _TO_CHAR.sub(lambda m: f"strftime({m.group(1)}, '{_fmt(m.group(2))}')", sql)
    sql = _TO_DATE.sub(
        lambda m: f"CAST(strptime({m.group(1)}, '{_fmt(m.group(2))}') AS DATE)", sql)
    sql = _TO_REGCLASS.sub(
        r"EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='\1')",
        sql)
    sql = _JSON_EXTRACT.sub(r"(\1->>\2)", sql)
    sql = _BARE_ALIAS.sub(r"\1 AS \2\3\4", sql)
    return sql.replace("%s", "?")


def archive_dirs(spec: str | Sequence[str]) -> list[str]:
    """The directory list behind an OPS_ARCHIVE_DIR value, in precedence order."""
    parts = spec.split(os.pathsep) if isinstance(spec, str) else [str(p) for p in spec]
    return [p.strip() for p in parts if p and p.strip()]


def resolve_files(spec: str | Sequence[str]) -> tuple[list[str], list[tuple[str, str]]]:
    """Which .jsonl.gz files make up the warehouse, one per (pull_date, feed).

    Returns (files, shadowed), where shadowed lists (skipped, kept) pairs so the
    caller can say out loud which route supplied an overlapping pull rather than
    leaving it to be inferred. Precedence is the directory order, first wins.
    """
    chosen: dict[tuple[str, str], str] = {}
    shadowed: list[tuple[str, str]] = []
    for d in archive_dirs(spec):
        for p in sorted(glob.glob(os.path.join(d, "*", "*.jsonl.gz"))):
            key = (os.path.basename(os.path.dirname(p)), os.path.basename(p))
            if key in chosen:
                shadowed.append((p, chosen[key]))
            else:
                chosen[key] = p
    return [chosen[k] for k in sorted(chosen)], shadowed


def _feed_map(spec: str | Sequence[str], manifest: str | None) -> dict[str, str]:
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
    # Lowest-precedence directory first, so the highest-precedence one has the
    # last word on any slug both recorded.
    for d in reversed(archive_dirs(spec)):
        for p in sorted(glob.glob(os.path.join(d, "*", "_feeds.json"))):
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

    def executemany(self, sql: str, seq: Sequence[Sequence[Any]]):
        for params in seq:
            self.execute(sql, params)
        return self

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

    def rollback(self):
        """Readers call this to clear aborted-tx state; DuckDB over files has
        no transaction to roll back."""

    def commit(self):
        pass

    def close(self):
        self._con.close()


def connect(archive_dir: str, manifest: str | None = None,
            run_log: str | None = None) -> _Connection:
    """Open the archive as if it were the warehouse.

    Builds one view named etl_feed_rows with the same columns the real table has
    (feed, pull_date, row_num, data) so the bake's SQL binds unchanged.

    archive_dir is one directory or several joined by os.pathsep, highest
    precedence first - see the module docstring.
    """
    try:
        import duckdb
    except ImportError:  # pragma: no cover
        raise SystemExit("duckdb is required for OPS_WAREHOUSE_SOURCE=archive: "
                         "pip install duckdb")

    files, shadowed = resolve_files(archive_dir)
    if not files:
        raise SystemExit(f"no archive files under {archive_dir!r} - nothing to read")
    if shadowed:
        print(f"[archive] {len(files)} pull files; {len(shadowed)} shadowed by a "
              f"higher-precedence copy, e.g. {shadowed[0][0]} <- {shadowed[0][1]}")

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
        FROM read_json({_lit_list(files)}, filename=true,
                       format='newline_delimited',
                       columns={{'row_num': 'BIGINT', 'data': 'JSON'}},
                       maximum_object_size=20000000)
    """)
    # Every query filters on feed, and most also on pull_date - the same index
    # the real table carries (etl_feed_rows_feed_idx).
    con.execute("CREATE INDEX etl_feed_rows_feed_idx ON etl_feed_rows (feed, pull_date)")

    # The run receipts, when the caller can point at the shadow JSONL the ETL
    # repo commits (run_log/etl_run_log.jsonl, one line per run). Built as a
    # real etl_run_log table so the verifier's receipt queries run unchanged -
    # its to_regclass() existence probe is translated to an information_schema
    # check, so with no run_log given the table is simply absent and the
    # verifier takes its own "no receipts yet" path rather than erroring.
    if run_log and os.path.exists(run_log):
        con.execute(f"""
            CREATE TABLE etl_run_log AS
            SELECT CAST(run_kind AS VARCHAR)              AS run_kind,
                   CAST(started_at AS TIMESTAMP)          AS started_at,
                   CAST(finished_at AS TIMESTAMP)         AS finished_at,
                   CAST(pull_date AS DATE)                AS pull_date,
                   CAST(github_run_id AS VARCHAR)         AS github_run_id,
                   CAST(feeds_attempted AS INTEGER)       AS feeds_attempted,
                   CAST(feeds_ok AS INTEGER)              AS feeds_ok,
                   CAST(feeds_failed AS INTEGER)          AS feeds_failed,
                   CAST(rows_written AS BIGINT)           AS rows_written,
                   CAST(exit_code AS INTEGER)             AS exit_code,
                   CAST(failures AS JSON)                 AS failures
            FROM read_json_auto({_lit(run_log)}, format='newline_delimited',
                                union_by_name=true)
        """)
    return _Connection(con)


_SLUG_FROM_FILENAME = r"regexp_extract(filename, '([^/]+)\.jsonl\.gz$', 1)"


def _lit(s: str) -> str:
    """Single-quoted SQL literal. Feed names come from our own files, but they
    contain apostrophes often enough that escaping is not optional."""
    return "'" + s.replace("'", "''") + "'"


def _lit_list(items: Sequence[str]) -> str:
    """A DuckDB list literal. An explicit file list, not a glob: the glob cannot
    express 'this pull date from direct, that one from archive'."""
    return "[" + ", ".join(_lit(s) for s in items) + "]"
