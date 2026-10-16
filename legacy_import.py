"""Importação única dos dados antigos (tabelas outlog_* e afins, schema public) para o
schema `distrilog`. Roda sozinha no primeiro boot em que o schema novo estiver vazio e
nunca mais (fica registrada em distrilog.legacy_import). Não apaga nada do schema antigo."""
from __future__ import annotations

import os

import psycopg

SCHEMA = "distrilog"
MARKER = "legacy_import_v1"

# (tabela antiga em public, tabela nova em distrilog) — na ordem das chaves estrangeiras
PAIRS = [
    ("outlog_cards", "cards"),
    ("outlog_items", "items"),
    ("outlog_receivings", "receivings"),
    ("outlog_receiving_operation_items", "receiving_operation_items"),
    ("outlog_timer_events", "timer_events"),
    ("outlog_quality_inspections", "quality_inspections"),
    ("outlog_quality_sample_items", "quality_sample_items"),
    ("outlog_quality_inspection_items", "quality_inspection_items"),
    ("outlog_quality_item_routes", "quality_item_routes"),
    ("outlog_quality_workers", "quality_workers"),
    ("outlog_quality_worker_timer_events", "quality_worker_timer_events"),
    ("outlog_quality_assignments", "quality_assignments"),
    ("outlog_quality_files", "quality_files"),
    ("card_allocations", "card_allocations"),
    ("sector_positions", "sector_positions"),
    ("goat_imports", "goat_imports"),
    ("goat_records", "goat_records"),
]


def _columns(cur, schema: str, table: str) -> dict[str, str]:
    cur.execute(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=%s AND table_name=%s",
        (schema, table),
    )
    return {r[0]: r[1] for r in cur.fetchall()}


def import_legacy_once() -> dict[str, int]:
    url = os.getenv("SUPABASE_DATABASE_URL")
    if not url:
        return {}
    copied: dict[str, int] = {}
    with psycopg.connect(url, connect_timeout=10) as con:
        cur = con.cursor()
        cur.execute("SELECT pg_advisory_xact_lock(727003)")
        cur.execute(
            f"CREATE TABLE IF NOT EXISTS {SCHEMA}.legacy_import (name TEXT PRIMARY KEY, done_at TEXT NOT NULL, details TEXT)"
        )
        cur.execute(f"SELECT 1 FROM {SCHEMA}.legacy_import WHERE name=%s", (MARKER,))
        if cur.fetchone():
            return {}
        cur.execute(f"SELECT COUNT(*) FROM {SCHEMA}.cards")
        if cur.fetchone()[0]:
            # schema novo já tem dados: não mistura; só registra para não tentar de novo
            cur.execute(f"INSERT INTO {SCHEMA}.legacy_import VALUES(%s, now()::text, 'pulado: schema novo já tinha cards')", (MARKER,))
            con.commit()
            return {}
        for old, new in PAIRS:
            src = _columns(cur, "public", old)
            dst = _columns(cur, SCHEMA, new)
            common = [c for c in dst if c in src]
            if not src or not common:
                continue
            cols = ", ".join(f'"{c}"' for c in common)
            sel = ", ".join(f'"{c}"::{dst[c]}' for c in common)
            cur.execute("SAVEPOINT t")
            try:
                cur.execute(f'INSERT INTO {SCHEMA}."{new}" ({cols}) SELECT {sel} FROM public."{old}" ON CONFLICT DO NOTHING')
                copied[new] = cur.rowcount
                cur.execute("RELEASE SAVEPOINT t")
            except Exception as exc:  # uma tabela ruim não derruba as outras
                cur.execute("ROLLBACK TO SAVEPOINT t")
                print(f"[importação] não consegui copiar {old} → {new}: {str(exc).splitlines()[0]}")
        # ajusta as sequências dos ids automáticos
        for _old, new in PAIRS:
            if "id" not in _columns(cur, SCHEMA, new):
                continue
            cur.execute("SELECT pg_get_serial_sequence(%s, 'id')", (f"{SCHEMA}.{new}",))
            seq = cur.fetchone()
            if seq and seq[0]:
                cur.execute(f"SELECT setval(%s, COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM {SCHEMA}.\"{new}\"", (seq[0],))
        details = ", ".join(f"{k}={v}" for k, v in copied.items())
        cur.execute(f"INSERT INTO {SCHEMA}.legacy_import VALUES(%s, now()::text, %s)", (MARKER, details))
        con.commit()
    if copied:
        print("[importação] dados antigos copiados para o schema distrilog:", copied)
    return copied


if __name__ == "__main__":
    print(import_legacy_once())
