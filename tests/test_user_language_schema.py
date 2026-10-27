"""Regression for account-language migration against isolated disposable PostgreSQL."""
from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest


def test_language_migration_is_idempotent_and_per_account():
    url = os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.skip("No disposable TEST_DATABASE_URL configured.")
    schema = "language_" + uuid4().hex[:12]
    migration = (
        Path(__file__).resolve().parents[1]
        / "migrations" / "20261027_user_preferred_language.sql"
    ).read_text(encoding="utf-8")
    sql = migration.replace("public.usuarios", f"{schema}.usuarios")
    with psycopg.connect(url, autocommit=True) as con:
        con.execute(f"CREATE SCHEMA {schema}")
    try:
        with psycopg.connect(url) as con:
            con.execute(f"CREATE TABLE {schema}.usuarios (usuario TEXT PRIMARY KEY)")
            con.execute(
                f"INSERT INTO {schema}.usuarios(usuario) VALUES ('operador_pt'), ('operador_es')"
            )
            con.execute(sql)
            con.execute(sql)  # repeatable deploy
            con.execute(
                f"UPDATE {schema}.usuarios SET idioma_preferido='es' WHERE usuario='operador_es'"
            )
            result = con.execute(
                f"SELECT usuario,idioma_preferido FROM {schema}.usuarios ORDER BY usuario"
            ).fetchall()
            assert result == [('operador_es', 'es'), ('operador_pt', 'pt-BR')]
            with con.transaction():
                with pytest.raises(psycopg.errors.CheckViolation):
                    con.execute(
                        f"UPDATE {schema}.usuarios SET idioma_preferido='fr' WHERE usuario='operador_pt'"
                    )
    finally:
        with psycopg.connect(url, autocommit=True) as con:
            con.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
