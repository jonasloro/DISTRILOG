"""Regressions for shared authentication rate limits.

Uses only the disposable TEST_DATABASE_URL from GitHub Actions. The production
credential store is never queried by this suite.
"""
import os
import uuid

import psycopg
import pytest
from fastapi import HTTPException


@pytest.fixture(scope="module")
def db():
    url=os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL, never production.")
    os.environ["AUTH_DATABASE_URL"]=url
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("CREATE SCHEMA IF NOT EXISTS distrilog")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS distrilog.auth_login_attempts (
              bucket_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL,
              window_started_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
    return url


def _user():
    return "authtest_" + uuid.uuid4().hex[:16]


def test_bucket_normalizes_username_but_never_stores_plaintext(db):
    from login_guard import account_bucket, ip_bucket
    assert account_bucket(" Joao ") == account_bucket("JOAO")
    assert account_bucket("JOAO") != ip_bucket("JOAO")
    assert "joao" not in account_bucket("Joao").lower()


def test_distributed_limit_survives_multiple_logins(db):
    from login_guard import reserve_login_attempt, account_bucket
    username=_user()
    remote="ci-127.0.0.1"
    for _ in range(8):
        reserve_login_attempt(username, remote)
    with pytest.raises(HTTPException) as exc:
        reserve_login_attempt(username, remote)
    assert exc.value.status_code==429
    assert exc.value.headers["Retry-After"]=="600"
    with psycopg.connect(db) as conn:
        row=conn.execute("SELECT attempts FROM distrilog.auth_login_attempts WHERE bucket_key=%s",
                         (account_bucket(username),)).fetchone()
    assert row[0] == 9


def test_success_resets_account_but_keeps_ip_budget(db):
    from login_guard import reserve_login_attempt, clear_successful_account, account_bucket, ip_bucket
    username=_user()
    remote="ci-reset-ip"
    for _ in range(8):
        reserve_login_attempt(username,remote)
    clear_successful_account(username)
    reserve_login_attempt(username,remote)
    with psycopg.connect(db) as conn:
        assert conn.execute("SELECT attempts FROM distrilog.auth_login_attempts WHERE bucket_key=%s",
                            (account_bucket(username),)).fetchone()[0] == 1
        assert conn.execute("SELECT attempts FROM distrilog.auth_login_attempts WHERE bucket_key=%s",
                            (ip_bucket(remote),)).fetchone()[0] == 9


def test_expired_window_resets_counter(db):
    from login_guard import reserve_login_attempt, account_bucket
    username=_user()
    for _ in range(8):
        reserve_login_attempt(username,"ci-expired-ip")
    with psycopg.connect(db) as conn:
        conn.execute("""UPDATE distrilog.auth_login_attempts
            SET window_started_at=now()-interval '11 minutes' WHERE bucket_key=%s""",
            (account_bucket(username),))
        conn.commit()
    reserve_login_attempt(username,"ci-expired-ip")
    with psycopg.connect(db) as conn:
        n=conn.execute("SELECT attempts FROM distrilog.auth_login_attempts WHERE bucket_key=%s",
                       (account_bucket(username),)).fetchone()[0]
    assert n==1
