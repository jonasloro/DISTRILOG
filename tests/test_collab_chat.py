"""Regression tests for the Supabase chat and calendar with isolated PostgreSQL.

Uses TEST_DATABASE_URL from CI; never writes to the real DISTRILOG data.
"""
from __future__ import annotations

import os

import psycopg
import pytest
from psycopg.rows import dict_row

import collab_module


@pytest.fixture
def chat_db(monkeypatch):
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Requires a disposable TEST_DATABASE_URL.")

    def connect():
        return psycopg.connect(url, row_factory=dict_row)

    import supabase_module
    monkeypatch.setattr(supabase_module, "pg_connect", connect)
    monkeypatch.setattr(
        collab_module,
        "_user",
        lambda uid, fallback="": {"name": f"Operador {uid}", "role": "recebimento"},
    )

    collab_module.init_collab_db()
    with connect() as con:
        con.execute("TRUNCATE TABLE public.chat_messages, public.chat_reads RESTART IDENTITY")
        con.execute("TRUNCATE TABLE public.calendar_events RESTART IDENTITY")
        con.commit()
    return connect


def test_reading_messages_inserts_receipt_without_id_column(chat_db):
    first = collab_module.chat_send(
        {"user_id": 1, "channel": "geral", "body": "Bom dia"}
    )["id"]
    collab_module.chat_send(
        {"user_id": 2, "channel": "geral", "body": "Recebido"}
    )
    assert collab_module.chat_unread(2) == {"geral": 1}

    messages = collab_module.chat_messages(user_id=2, channel="geral")
    assert [m["body"] for m in messages] == ["Bom dia", "Recebido"]
    assert collab_module.chat_unread(2) == {}

    # Repeated reads of the same conversation must update, not duplicate PK.
    assert len(collab_module.chat_messages(user_id=2, channel="geral")) == 2
    with chat_db() as con:
        receipt = con.execute(
            "SELECT last_id FROM public.chat_reads WHERE user_id=%s AND channel=%s",
            (2, "geral"),
        ).fetchone()
    assert receipt["last_id"] > first


def test_incremental_read_receipt_and_private_chat_isolation(chat_db):
    first = collab_module.chat_send(
        {"user_id": 1, "channel": "dm:2", "body": "Transferência confirmada"}
    )["id"]
    assert collab_module.chat_unread(2) == {"dm:1:2": 1}
    messages = collab_module.chat_messages(user_id=2, channel="dm:1")
    assert [m["id"] for m in messages] == [first]
    assert collab_module.chat_messages(user_id=3, channel="dm:1") == []
    assert collab_module.chat_unread(2) == {}

    second = collab_module.chat_send(
        {"user_id": 1, "channel": "dm:2", "body": "Segundo volume"}
    )["id"]
    assert collab_module.chat_unread(2) == {"dm:1:2": 1}
    incremental = collab_module.chat_messages(
        user_id=2, channel="dm:1", after_id=first
    )
    assert [m["id"] for m in incremental] == [second]
    assert collab_module.chat_unread(2) == {}


def test_calendar_insert_still_returns_record_id(chat_db):
    result = collab_module.calendar_create(
        {
            "user_id": 1,
            "title": "Conferência semanal",
            "start_at": "2026-10-27T14:00",
            "end_at": "2026-10-27T15:00",
        }
    )
    assert result["id"] > 0
    events = collab_module.calendar_events(
        user_id=1, start="2026-10-27T00:00", end="2026-10-28T00:00"
    )
    assert len(events) == 1
    assert events[0]["title"] == "Conferência semanal"
