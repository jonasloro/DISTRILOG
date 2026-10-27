"""Banco único do DistriLog: tudo vive no Postgres do Supabase.

Os módulos continuam escrevendo SQL no estilo sqlite3 (`?`, `lastrowid`,
`INSERT OR IGNORE`, linhas acessíveis por nome ou posição). Esta camada traduz
isso para Postgres e fala DIRETO com o Supabase, usando um pool de conexões.
Não existe mais cópia local, restauração nem sincronização: cada operação é
uma transação só, confirmada no próprio Supabase.

Todas as tabelas ficam no schema `distrilog`, separado das tabelas antigas.
"""
from __future__ import annotations

import os
import re
import threading
from decimal import Decimal
from typing import Any, Iterable

import psycopg
from psycopg import ClientCursor
from psycopg.adapt import Loader
from psycopg_pool import ConnectionPool

SCHEMA = "distrilog"

# Tabelas gerenciadas por esta camada (as que os módulos criam em init_*_db()).
# Os nomes são qualificados com o schema automaticamente em todo SQL.
TABLES = {
    "card_allocations", "cards", "casulo_history", "dispatches", "downstream_assignments",
    "downstream_operation_items", "downstream_operations", "goat_imports", "goat_records",
    "history", "imports", "items", "operational_tasks", "outlog_migrations",
    "processing_item_quantities", "processing_records", "processing_timer_events",
    "processing_workers", "quality_assignments", "quality_audit_events",
    "quality_inspection_items", "quality_inspections", "quality_item_routes",
    "quality_sample_items", "quality_worker_timer_events", "quality_workers",
    "receiving_operation_items", "receivings", "return_items", "returns",
    "sector_positions", "sgo_entries", "sgo_imports", "shipment_items", "shipments",
    "stock_group_snapshots", "stock_report_imports", "timer_events", "unified_movements",
    "users", "quality_files", "cleaning_tasks", "cleaning_task_events",
    "processing_cadastro_tasks", "processing_cadastro_events", "processing_triages",
    "processing_triage_events", "processing_triage_counts", "processing_intake_routes",
    "storage_entries", "storage_entry_items", "storage_blind_checks", "labeling_final_checks",
}

IntegrityError = psycopg.errors.IntegrityError
OperationalError = psycopg.OperationalError
Error = psycopg.Error

_ADVISORY_WRITE_LOCK = 727001   # substitui o BEGIN IMMEDIATE do SQLite
_ADVISORY_DDL_LOCK = 727002

_PARAM = "\ue000"               # marcador temporário de parâmetro
_LITERAL_SPLIT = re.compile(r"('(?:[^']|'')*')")
_TABLE_RE = re.compile(r"(?<![\w.\"])(" + "|".join(sorted(TABLES, key=len, reverse=True)) + r")(?![\w\"])")


# --------------------------------------------------------------------------- linhas

class Row:
    """Linha compatível com sqlite3.Row: acesso por posição ou por nome."""

    __slots__ = ("_cols", "_vals", "_idx")

    def __init__(self, cols: list[str], vals: Iterable[Any]):
        self._cols = cols
        self._vals = tuple(vals)
        self._idx = None

    def _index(self) -> dict[str, int]:
        if self._idx is None:
            self._idx = {c.lower(): i for i, c in enumerate(self._cols)}
        return self._idx

    def __getitem__(self, key):
        if isinstance(key, (int, slice)):
            return self._vals[key]
        try:
            return self._vals[self._index()[str(key).lower()]]
        except KeyError:
            raise IndexError(f"No item with that key: {key}") from None

    def keys(self) -> list[str]:
        return list(self._cols)

    def __iter__(self):
        return iter(self._vals)

    def __len__(self) -> int:
        return len(self._vals)

    def __eq__(self, other):
        return isinstance(other, Row) and self._cols == other._cols and self._vals == other._vals

    def __repr__(self) -> str:
        return "Row(" + ", ".join(f"{c}={v!r}" for c, v in zip(self._cols, self._vals)) + ")"


def _row_factory(cursor):
    cols = [c.name for c in (cursor.description or [])]

    def make(values):
        return Row(cols, values)

    return make


class _NumericLoader(Loader):
    """SUM()/AVG() voltam como NUMERIC; devolve int quando inteiro, senão float."""

    def load(self, data):
        value = Decimal(bytes(data).decode())
        return int(value) if value == value.to_integral_value() else float(value)


psycopg.adapters.register_loader("numeric", _NumericLoader)


# --------------------------------------------------------------------------- tradução SQL

def _scan_balanced(sql: str, start: int) -> int:
    """Dado o índice logo após '(', devolve o índice do ')' correspondente."""
    depth, i, n = 1, start, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "'":
            i += 1
            while i < n:
                if sql[i] == "'":
                    if i + 1 < n and sql[i + 1] == "'":
                        i += 2
                        continue
                    break
                i += 1
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError("parênteses desbalanceados em GROUP_CONCAT")


def _split_top_level_comma(text: str) -> list[str]:
    parts, depth, cur, i, n = [], 0, [], 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "'":
            j = i + 1
            while j < n:
                if text[j] == "'":
                    if j + 1 < n and text[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            cur.append(text[i : j + 1])
            i = j + 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
        i += 1
    parts.append("".join(cur))
    return parts


def _convert_group_concat(sql: str) -> str:
    pattern = re.compile(r"GROUP_CONCAT\s*\(", re.IGNORECASE)
    while True:
        m = pattern.search(sql)
        if not m:
            return sql
        end = _scan_balanced(sql, m.end())
        inner = sql[m.end() : end].strip()
        distinct = ""
        if re.match(r"DISTINCT\s", inner, re.IGNORECASE):
            distinct = "DISTINCT "
            inner = inner[8:].strip()
        parts = _split_top_level_comma(inner)
        expr = parts[0].strip()
        sep = parts[1].strip() if len(parts) > 1 else "','"
        sql = f"{sql[: m.start()]}STRING_AGG({distinct}({expr})::text, {sep}){sql[end + 1 :]}"


def _translate_segment(seg: str) -> str:
    seg = seg.replace("?", _PARAM)
    seg = _TABLE_RE.sub(lambda m: f"{SCHEMA}.{m.group(1)}", seg)
    seg = re.sub(r"\bLIKE\b", "ILIKE", seg, flags=re.IGNORECASE)
    # card_allocations.active é BOOLEAN no Postgres; o SQL legado compara com 0/1
    seg = re.sub(r"\bSET\s+active\s*=\s*0\b", "SET active=FALSE", seg, flags=re.IGNORECASE)
    seg = re.sub(r"\bSET\s+active\s*=\s*1\b", "SET active=TRUE", seg, flags=re.IGNORECASE)
    seg = re.sub(r"\bactive\s*=\s*1\b", "active IS TRUE", seg, flags=re.IGNORECASE)
    seg = re.sub(r"\bactive\s*=\s*0\b", "active IS FALSE", seg, flags=re.IGNORECASE)
    seg = re.sub(r"\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b", "BIGSERIAL PRIMARY KEY", seg, flags=re.IGNORECASE)
    seg = re.sub(r"\bREAL\b", "DOUBLE PRECISION", seg, flags=re.IGNORECASE)
    seg = re.sub(r"\bBLOB\b", "BYTEA", seg, flags=re.IGNORECASE)
    return seg


_TRANSLATE_CACHE: dict[str, tuple[str, bool]] = {}


def translate(sql: str) -> tuple[str, bool]:
    """Devolve (sql_postgres_com_marcadores, ignore_conflict)."""
    cached = _TRANSLATE_CACHE.get(sql)
    if cached:
        return cached
    work = sql.strip().rstrip(";")
    ignore = False
    m = re.match(r"INSERT\s+OR\s+IGNORE\s+INTO\b", work, re.IGNORECASE)
    if m:
        ignore = True
        work = "INSERT INTO" + work[m.end():]
    if re.search(r"GROUP_CONCAT", work, re.IGNORECASE):
        work = _convert_group_concat(work)
    parts = _LITERAL_SPLIT.split(work)
    for i in range(0, len(parts), 2):
        parts[i] = _translate_segment(parts[i])
    out = "".join(parts)
    if ignore:
        out += " ON CONFLICT DO NOTHING"
    _TRANSLATE_CACHE[sql] = (out, ignore)
    return out, ignore


def split_statements(script: str) -> list[str]:
    parts = _LITERAL_SPLIT.split(script)
    statements, cur = [], []
    for i, part in enumerate(parts):
        if i % 2:
            cur.append(part)
            continue
        pieces = part.split(";")
        for j, piece in enumerate(pieces):
            cur.append(piece)
            if j < len(pieces) - 1:
                statements.append("".join(cur))
                cur = []
    statements.append("".join(cur))
    cleaned = []
    for stmt in statements:
        lines = [ln for ln in stmt.splitlines() if not ln.strip().startswith("--")]
        text = "\n".join(lines).strip()
        if text:
            cleaned.append(text)
    return cleaned


def _adapt_param(value: Any) -> Any:
    """Parâmetros viram literais entre aspas ('5'), que o Postgres converte para o
    tipo da coluna — o mesmo comportamento tolerante do SQLite."""
    if value is None or isinstance(value, (str, bytes, bytearray, memoryview)):
        return value
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float, Decimal)):
        return str(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


# --------------------------------------------------------------------------- pool

_pool: ConnectionPool | None = None
_pool_lock = threading.Lock()
_schema_ready = False
_has_id: set[str] = set()


def _database_url() -> str:
    url = os.getenv("SUPABASE_DATABASE_URL")
    if not url:
        raise RuntimeError(
            "SUPABASE_DATABASE_URL não está configurada. Defina a connection string do Supabase "
            "nas variáveis de ambiente do serviço."
        )
    return url


def ensure_schema(url: str | None = None) -> None:
    """Cria o schema `distrilog` uma vez por processo (idempotente)."""
    global _schema_ready
    if _schema_ready:
        return
    with psycopg.connect(url or _database_url(), connect_timeout=10, autocommit=True) as boot:
        boot.execute(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}")
    _schema_ready = True


def _get_pool() -> ConnectionPool:
    global _pool
    if _pool is not None:
        return _pool
    with _pool_lock:
        if _pool is None:
            url = _database_url()
            ensure_schema(url)
            pool = ConnectionPool(
                url,
                min_size=1,
                max_size=int(os.getenv("DB_POOL_MAX", "14")),
                kwargs={
                    "autocommit": False,
                    "prepare_threshold": None,
                    "connect_timeout": 10,
                    "cursor_factory": ClientCursor,
                    "application_name": "distrilog",
                },
                timeout=20,
                max_idle=240,
                max_lifetime=1800,
                open=False,
            )
            pool.open(wait=True, timeout=20)
            _pool = pool
    return _pool


def _refresh_has_id(raw) -> None:
    rows = raw.execute(
        "SELECT table_name FROM information_schema.columns WHERE table_schema=%s AND column_name='id' "
        "AND data_type IN ('integer','bigint','smallint')",
        (SCHEMA,),
    ).fetchall()
    _has_id.clear()
    _has_id.update(r[0] for r in rows)


_INSERT_RE = re.compile(r"^\s*INSERT\s+INTO\s+" + SCHEMA + r"\.([a-z_0-9]+)", re.IGNORECASE)
_PRAGMA_TABLE_INFO = re.compile(r"^\s*PRAGMA\s+table_info\(\s*['\"]?([a-z_0-9]+)['\"]?\s*\)\s*;?\s*$", re.IGNORECASE)


class Cursor:
    def __init__(self, con: "Connection"):
        self._con = con
        self._cur = con._raw.cursor(row_factory=_row_factory)
        self.lastrowid: int | None = None

    # -- execução
    def _run(self, sql: str, params: Any = None) -> None:
        raw = self._con._raw
        pragma = _PRAGMA_TABLE_INFO.match(sql)
        if pragma:
            self._cur.execute(
                "SELECT ordinal_position-1 AS cid, column_name AS name, data_type AS type, "
                "0 AS notnull, NULL AS dflt_value, 0 AS pk FROM information_schema.columns "
                "WHERE table_schema=%s AND table_name=%s ORDER BY ordinal_position",
                (SCHEMA, pragma.group(1)),
            )
            return
        head = sql.lstrip()[:16].upper()
        if head.startswith("PRAGMA"):
            self._cur.execute("SELECT 1 WHERE false")
            return
        if head.startswith("BEGIN"):
            sql = f"SELECT pg_advisory_xact_lock({_ADVISORY_WRITE_LOCK})"
            self._cur.execute(sql)
            return
        pg_sql, _ignore = translate(sql)
        has_params = params is not None and len(params) > 0
        if has_params:
            final = pg_sql.replace("%", "%%").replace(_PARAM, "%s")
            args: Any = tuple(_adapt_param(p) for p in params)
        else:
            final = pg_sql.replace(_PARAM, "?")
            args = None
        returning = False
        m = _INSERT_RE.match(final)
        if m and " RETURNING " not in final.upper():
            table = m.group(1).lower()
            if table not in _has_id:
                _refresh_has_id(raw)
            if table in _has_id:
                final += " RETURNING id"
                returning = True
        try:
            self._cur.execute(final, args)
        except psycopg.OperationalError:
            if raw.info.transaction_status != psycopg.pq.TransactionStatus.IDLE:
                raise
            self._con._reconnect()
            self._cur = self._con._raw.cursor(row_factory=_row_factory)
            self._cur.execute(final, args)
        if returning:
            row = self._cur.fetchone()
            self.lastrowid = int(row[0]) if row else 0

    def execute(self, sql: str, params: Any = None) -> "Cursor":
        self.lastrowid = None
        self._run(sql, params)
        return self

    def executemany(self, sql: str, seq: Iterable[Any]) -> "Cursor":
        for params in seq:
            self._run(sql, params)
        return self

    # -- leitura
    def fetchone(self):
        return self._cur.fetchone() if self._cur.description else None

    def fetchall(self):
        return self._cur.fetchall() if self._cur.description else []

    def fetchmany(self, size: int = 1):
        return self._cur.fetchmany(size) if self._cur.description else []

    def __iter__(self):
        return iter(self.fetchall())

    @property
    def rowcount(self) -> int:
        return self._cur.rowcount

    @property
    def description(self):
        return self._cur.description

    def close(self) -> None:
        try:
            self._cur.close()
        except Exception:
            pass


class Connection:
    """Conexão do pool com a interface que os módulos já usavam no sqlite3."""

    def __init__(self, pool: ConnectionPool):
        self._pool = pool
        self._raw = pool.getconn()
        self._closed = False
        self.row_factory = None  # ignorado: as linhas já são `Row`

    # -- ciclo de vida
    def _reconnect(self) -> None:
        try:
            self._pool.putconn(self._raw)
        except Exception:
            pass
        self._raw = self._pool.getconn()

    def commit(self) -> None:
        self._raw.commit()

    def rollback(self) -> None:
        self._raw.rollback()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._raw.rollback()
        except Exception:
            pass
        try:
            self._pool.putconn(self._raw)
        except Exception:
            pass

    def __del__(self):  # vazamento de conexão (return antes do close) não esgota o pool
        try:
            self.close()
        except Exception:
            pass

    def __enter__(self) -> "Connection":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc_type is None:
            self.commit()
        else:
            self.rollback()

    # -- SQL
    def cursor(self) -> Cursor:
        return Cursor(self)

    def execute(self, sql: str, params: Any = None) -> Cursor:
        return Cursor(self).execute(sql, params)

    def executemany(self, sql: str, seq: Iterable[Any]) -> Cursor:
        return Cursor(self).executemany(sql, seq)

    def executescript(self, script: str) -> None:
        self._raw.execute(f"SELECT pg_advisory_xact_lock({_ADVISORY_DDL_LOCK})")
        for stmt in split_statements(script):
            Cursor(self).execute(stmt)
        self._raw.commit()
        _has_id.clear()


def connect() -> Connection:
    return Connection(_get_pool())
