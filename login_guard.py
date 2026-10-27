"""Distributed throttling for sign-in and temporary-password changes.

Counters live in the Supabase PostgreSQL database, not the FastAPI process.
No raw IP address or username is stored in the throttle table.
"""
from __future__ import annotations

import hashlib
from fastapi import HTTPException

from supabase_module import pg_connect

_WINDOW_SQL = "INTERVAL '10 minutes'"
_ACCOUNT_LIMIT = 8
_IP_LIMIT = 200


def _bucket(prefix: str, value: str) -> str:
    digest = hashlib.sha256((prefix + ":" + value).encode("utf-8")).hexdigest()
    return prefix + ":" + digest


def account_bucket(username: str) -> str:
    return _bucket("account", str(username).strip().casefold())


def ip_bucket(remote_address: str) -> str:
    return _bucket("ip", str(remote_address or "unknown"))


def reserve_login_attempt(username: str, remote_address: str) -> None:
    """Atomically reserve one attempt per account and per IP.

    UPSERT serializes updates for each shared key at the PostgreSQL row level;
    an operator cannot evade the limit by reaching a different Render instance.
    All counters are committed even if an attempt is rejected.
    """
    buckets = sorted((
        (account_bucket(username), _ACCOUNT_LIMIT),
        (ip_bucket(remote_address), _IP_LIMIT),
    ), key=lambda row: row[0])
    exceeded = False
    with pg_connect() as conn:
        with conn.cursor() as cur:
            for key, threshold in buckets:
                cur.execute("""
                    INSERT INTO distrilog.auth_login_attempts
                        (bucket_key,attempts,window_started_at)
                    VALUES (%s,1,clock_timestamp())
                    ON CONFLICT (bucket_key)
                    DO UPDATE SET
                        attempts = CASE
                            WHEN distrilog.auth_login_attempts.window_started_at <
                                 clock_timestamp() - INTERVAL '10 minutes'
                            THEN 1 ELSE distrilog.auth_login_attempts.attempts + 1 END,
                        window_started_at = CASE
                            WHEN distrilog.auth_login_attempts.window_started_at <
                                 clock_timestamp() - INTERVAL '10 minutes'
                            THEN clock_timestamp()
                            ELSE distrilog.auth_login_attempts.window_started_at END
                    RETURNING attempts
                """, (key,))
                if int(cur.fetchone()["attempts"]) > threshold:
                    exceeded = True
        conn.commit()
    if exceeded:
        raise HTTPException(
            429,
            "Muitas tentativas de autenticação. Aguarde dez minutos e tente novamente.",
            headers={"Retry-After": "600"},
        )


def clear_successful_account(username: str) -> None:
    """Clear only the account bucket; retain IP budget against bulk attacks."""
    with pg_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM distrilog.auth_login_attempts WHERE bucket_key=%s",
                (account_bucket(username),),
            )
        conn.commit()
