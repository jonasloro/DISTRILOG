"""Stock-space timer: validation, permissions and disposable PostgreSQL lifecycle.

Never connects to the user's live Supabase database.
"""
from __future__ import annotations

import os
from types import SimpleNamespace

import psycopg
import pytest
from fastapi import HTTPException

from stock_space_module import (
    _actor, _finish_fields, _start_fields, init_stock_space_db,
    start_activity, pause_activity, resume_activity, finish_activity,
    active_activity, activity_history, SCHEMA,
)


def session(user_id=61001, role="estocagem"):
    return SimpleNamespace(state=SimpleNamespace(auth_user_id=user_id, auth_role=role))


def test_kind_street_brand_required_and_normalized():
    assert _start_fields({"kind": "AJUSTE_ESTOQUE", "street": " Rua   03 ", "brand": "  ALFA  "}) == (
        "AJUSTE_ESTOQUE", "Rua 03", "ALFA",
    )
    assert _start_fields({"kind": "DEVOLUCAO_PORTA_PALETES", "street": "4", "brand": "B"}) == (
        "DEVOLUCAO_PORTA_PALETES", "4", "B",
    )
    for payload in ({"kind": "INVENTORY_WRITE", "street": "1", "brand": "Z"},
                    {"kind": "AJUSTE_ESTOQUE", "street": "", "brand": "Z"},
                    {"kind": "AJUSTE_ESTOQUE", "street": "01", "brand": ""}):
        with pytest.raises(HTTPException) as exc:
            _start_fields(payload)
        assert exc.value.status_code == 422


def test_final_count_must_be_positive_and_unit_explicit():
    assert _finish_fields({"moved_quantity": 4, "quantity_unit": "PALETES"}) == (4, "PALETES", "")
    for value in (None, "3", -1, 0, 1.5, True, 1_000_001):
        with pytest.raises(HTTPException):
            _finish_fields({"moved_quantity": value, "quantity_unit": "CAIXAS"})
    with pytest.raises(HTTPException):
        _finish_fields({"moved_quantity": 2, "quantity_unit": "PECA"})


def test_non_operator_cannot_move_or_read_another_operators_operation():
    with pytest.raises(HTTPException) as exc:
        _actor(session(role="consulta"), write=True)
    assert exc.value.status_code == 403
    assert _actor(session(role="estocagem")) == (61001, "estocagem")


def test_private_schema_cannot_mutate_real_inventory():
    assert "distrilog.card_allocations" not in SCHEMA
    assert "UNIQUE INDEX" in SCHEMA
    assert "ENABLE ROW LEVEL SECURITY" in SCHEMA
    assert "REVOKE ALL" in SCHEMA


@pytest.fixture
def isolated_postgres(monkeypatch):
    url = os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Requer PostgreSQL descartável do workflow de CI.")
    monkeypatch.setenv("AUTH_DATABASE_URL", url)
    with psycopg.connect(url, autocommit=True) as con:
        con.execute("CREATE SCHEMA IF NOT EXISTS distrilog")
        con.execute("""
            CREATE TABLE IF NOT EXISTS distrilog.users
                (id BIGINT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL)
        """)
        con.execute("""
            INSERT INTO distrilog.users(id,name,role)
            VALUES (61001,'Operador Exemplo','estocagem'),(61002,'Outro Operador','recebimento')
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role
        """)
    init_stock_space_db()
    with psycopg.connect(url, autocommit=True) as con:
        con.execute("DELETE FROM distrilog.stock_space_activity_events WHERE operator_user_id IN (61001,61002)")
        con.execute("DELETE FROM distrilog.stock_space_activities WHERE operator_user_id IN (61001,61002)")
    yield url


def test_full_timer_lifecycle_is_persistent_and_idempotent(isolated_postgres):
    operator = session()
    started = start_activity(operator, {"kind": "AJUSTE_ESTOQUE", "street": "RUA A", "brand": "MARCA X"})
    activity_id = started["activity"]["id"]
    assert started["activity"]["status"] == "EM_ANDAMENTO"
    assert active_activity(operator)["activity"]["id"] == activity_id
    with pytest.raises(HTTPException) as exc:
        start_activity(operator, {"kind": "DEVOLUCAO_PORTA_PALETES", "street": "RUA B", "brand": "MARCA Y"})
    assert exc.value.status_code == 409
    with pytest.raises(HTTPException) as exc:
        pause_activity(activity_id, session(user_id=61002, role="recebimento"))
    assert exc.value.status_code == 403
    paused = pause_activity(activity_id, operator)
    assert paused["activity"]["status"] == "PAUSADA"
    assert pause_activity(activity_id, operator)["unchanged"] is True
    resumed = resume_activity(activity_id, operator)
    assert resumed["activity"]["status"] == "EM_ANDAMENTO"
    done = finish_activity(activity_id, operator, {"moved_quantity": 12, "quantity_unit": "CAIXAS", "notes": "Conferido."})
    assert done["activity"]["status"] == "CONCLUIDA"
    assert done["activity"]["moved_quantity"] == 12
    assert done["activity"]["worked_seconds_live"] >= 0
    assert active_activity(operator)["activity"] is None
    assert finish_activity(activity_id, operator, {"moved_quantity": 12, "quantity_unit": "CAIXAS", "notes": "Conferido."})["unchanged"] is True
    with pytest.raises(HTTPException):
        finish_activity(activity_id, operator, {"moved_quantity": 99, "quantity_unit": "CAIXAS"})
    assert activity_history(operator, limit=30)["activities"][0]["id"] == activity_id
    with psycopg.connect(isolated_postgres) as con:
        event_names = [r[0] for r in con.execute(
            "SELECT event FROM distrilog.stock_space_activity_events WHERE activity_id=%s ORDER BY id",
            (activity_id,),
        )]
    assert event_names == ["INICIO", "PAUSA", "RETOMADA", "CONCLUSAO"]


def test_team_history_is_manager_only(isolated_postgres):
    with pytest.raises(HTTPException) as exc:
        activity_history(session(role="estocagem"), scope="team", limit=30)
    assert exc.value.status_code == 403
    assert isinstance(activity_history(session(user_id=61002, role="supervisor"), scope="team", limit=30)["activities"], list)
