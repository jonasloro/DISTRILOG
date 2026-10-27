"""Regression: deleting a Supabase credential archives the operational login.

Only executes against the disposable PostgreSQL TEST_DATABASE_URL. Historical
references must continue to resolve, and sessions must become invalid.
"""
from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest


@pytest.fixture
def auth_schema():
    url = os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.skip("No disposable TEST_DATABASE_URL configured.")
    schema = "auth_profile_" + uuid4().hex[:12]
    with psycopg.connect(url, autocommit=True) as connection:
        connection.execute(f"CREATE SCHEMA {schema}")
    try:
        with psycopg.connect(url) as connection:
            connection.execute(f"""
                CREATE TABLE {schema}.users (
                    id bigint PRIMARY KEY,
                    username text NOT NULL UNIQUE,
                    name text NOT NULL,
                    role text NOT NULL,
                    is_active boolean NOT NULL DEFAULT true,
                    session_revoked_after_ns bigint NOT NULL DEFAULT 0
                )
            """)
            connection.execute(f"""
                CREATE TABLE {schema}.usuarios (
                    usuario text PRIMARY KEY,
                    papel text NOT NULL
                )
            """)
            connection.execute(f"""
                CREATE TABLE {schema}.history (
                    id bigint PRIMARY KEY,
                    user_id bigint NOT NULL REFERENCES {schema}.users(id),
                    description text NOT NULL
                )
            """)
            connection.execute(f"""
                INSERT INTO {schema}.users(id,username,name,role)
                VALUES (1,'admin','Admin','admin'),
                       (2,'legacy','Excluído anteriormente','qualidade'),
                       (3,'operador','Operador','processamento'),
                       (4,'renomeado','Operador renomeado','estocagem')
            """)
            connection.execute(f"""
                INSERT INTO {schema}.usuarios(usuario,papel)
                VALUES ('admin','admin'),('operador','processamento'),
                       ('renomeado','estocagem')
            """)
            connection.execute(f"""
                INSERT INTO {schema}.history(id,user_id,description)
                VALUES (100,2,'Operação histórica'),
                       (101,3,'Separação física')
            """)
            migration = (
                Path(__file__).resolve().parents[1]
                / "migrations" / "20261027_auth_user_delete_sync.sql"
            ).read_text(encoding="utf-8")
            migration = (
                migration.replace("distrilog.archive_user_on_auth_removal",
                                  f"{schema}.archive_user_on_auth_removal")
                .replace("distrilog.users", f"{schema}.users")
                .replace("public.usuarios", f"{schema}.usuarios")
            )
            connection.execute(migration)
            connection.commit()
        yield schema, url
    finally:
        with psycopg.connect(url, autocommit=True) as connection:
            connection.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")


def test_existing_deleted_credentials_are_archived_without_erasing_history(auth_schema):
    schema, url = auth_schema
    with psycopg.connect(url) as connection:
        legacy = connection.execute(
            f"SELECT is_active,session_revoked_after_ns FROM {schema}.users WHERE id=2"
        ).fetchone()
        assert legacy[0] is False
        assert legacy[1] > 0
        assert connection.execute(
            f"SELECT description FROM {schema}.history WHERE user_id=2"
        ).fetchone()[0] == "Operação histórica"
        admin = connection.execute(
            f"SELECT is_active FROM {schema}.users WHERE username='admin'"
        ).fetchone()
        assert admin == (True,)


def test_delete_revokes_sessions_immediately_and_hides_from_join(auth_schema):
    schema, url = auth_schema
    with psycopg.connect(url) as connection:
        connection.execute(
            f"DELETE FROM {schema}.usuarios WHERE usuario='operador'"
        )
        user = connection.execute(
            f"SELECT id,is_active,session_revoked_after_ns "
            f"FROM {schema}.users WHERE username='operador'"
        ).fetchone()
        assert user[0] == 3
        assert user[1] is False
        assert user[2] > 0
        visible = connection.execute(
            f"""SELECT u.username FROM {schema}.users u
                JOIN {schema}.usuarios a
                  ON a.usuario=u.username AND a.papel=u.role
                WHERE u.is_active=TRUE ORDER BY u.username"""
        ).fetchall()
        assert visible == [('admin',), ('renomeado',)]
        assert connection.execute(
            f"SELECT user_id FROM {schema}.history WHERE id=101"
        ).fetchone()[0] == 3


def test_rename_also_archives_old_identity(auth_schema):
    schema, url = auth_schema
    with psycopg.connect(url) as connection:
        connection.execute(
            f"UPDATE {schema}.usuarios SET usuario='novo' "
            "WHERE usuario='renomeado'"
        )
        assert connection.execute(
            f"SELECT is_active FROM {schema}.users WHERE id=4"
        ).fetchone()[0] is False


def test_rolled_back_delete_does_not_disable_user(auth_schema):
    schema, url = auth_schema
    with psycopg.connect(url) as connection:
        connection.execute(f"DELETE FROM {schema}.usuarios WHERE usuario='operador'")
        assert connection.execute(
            f"SELECT is_active FROM {schema}.users WHERE id=3"
        ).fetchone()[0] is False
        connection.rollback()
        assert connection.execute(
            f"SELECT is_active FROM {schema}.users WHERE id=3"
        ).fetchone()[0] is True
        assert connection.execute(
            f"SELECT usuario FROM {schema}.usuarios WHERE usuario='operador'"
        ).fetchone() == ('operador',)
