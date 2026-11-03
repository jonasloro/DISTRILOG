"""Fluxo real de Separação -> Expedição no PostgreSQL DESCARTÁVEL do CI."""
from __future__ import annotations

import asyncio
import io
import os
from types import SimpleNamespace

import psycopg
import pytest
from fastapi import HTTPException, UploadFile
from psycopg import ClientCursor
from psycopg_pool import ConnectionPool

import db
import separation_module as sep


class Actor:
    def __init__(self, body=None, user_id=93101, role="admin"):
        self.state = SimpleNamespace(auth_role=role, auth_user_id=user_id)
        self.body = body or {}

    async def json(self):
        return self.body


def report(document="90001", reference="REF-TESTE", casulo="010-A-010"):
    return (
        "identificacao;emissao;numero_documento;referencia;descricao;"
        "codigo_barras;composicoes_visualizacao;quantidade;casulo\n"
        f"Loja Teste;10/07/2026;{document};{reference};Blusa;000012;[P,AZUL];3;{casulo}\n"
        f"Loja Teste;10/07/2026;{document};{reference};Blusa;000013;[P,AZUL];2;001-A-010\n"
    ).encode("utf-8")


@pytest.fixture(scope="module")
def database():
    url = os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Requer PostgreSQL descartável em TEST_DATABASE_URL.")
    with psycopg.connect(url, autocommit=True) as pg:
        pg.execute("CREATE SCHEMA IF NOT EXISTS distrilog")
        pg.execute("""
            CREATE TABLE IF NOT EXISTS distrilog.users (
                id BIGINT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL
            )""")
        pg.execute("""
            CREATE TABLE IF NOT EXISTS distrilog.shipments (
                id BIGSERIAL PRIMARY KEY, document_no TEXT NOT NULL, destination TEXT,
                status TEXT, total_qty INTEGER, created_by BIGINT, created_at TIMESTAMPTZ,
                volume_count INTEGER, notes TEXT, updated_at TIMESTAMPTZ
            )""")
        pg.execute("""
            CREATE TABLE IF NOT EXISTS distrilog.shipment_items (
                id BIGSERIAL PRIMARY KEY, shipment_id BIGINT, barcode TEXT,
                description TEXT, quantity INTEGER, checked_qty INTEGER
            )""")
        pg.execute("""
            INSERT INTO distrilog.users(id,name,role)
            VALUES(93101,'Operador de teste','admin')
            ON CONFLICT(id) DO NOTHING""")
    pool = ConnectionPool(
        url, min_size=1, max_size=2,
        kwargs={"cursor_factory": ClientCursor, "prepare_threshold": None},
        open=True,
    )
    original_connect = db.connect
    db.connect = lambda: db.Connection(pool)
    try:
        sep.init_separation_db()
        yield url
    finally:
        db.connect = original_connect
        pool.close()


@pytest.fixture
def clean_orders(database):
    with psycopg.connect(database) as pg:
        pg.execute("""
            TRUNCATE distrilog.separation_pauses,
                     distrilog.separation_order_references,
                     distrilog.separation_order_items,
                     distrilog.separation_orders,
                     distrilog.shipment_items,
                     distrilog.shipments
            RESTART IDENTITY CASCADE
        """)
        pg.commit()
    return database


def _import(raw):
    file = UploadFile(file=io.BytesIO(raw), filename="Pedidos_Separacao.csv")
    return asyncio.run(sep.import_csv(Actor(), file))


def test_import_is_idempotent_and_handoff_has_all_required_data(clean_orders):
    first = _import(report())
    second = _import(report())
    assert first["imported"] == 1
    assert first["valid_qty"] == 3
    assert first["excluded_qty"] == 2
    assert second["existing"] == 1
    order = sep.list_orders(Actor())[0]
    assert order["expected_qty"] == 3
    assert order["status"] == "PENDENTE"

    sep.start_order(order["id"], Actor())
    body = {
        "bags": 2, "boxes": 1, "separated_qty": 3,
        "weight_kg": "4.125", "zero_left": False, "had_pause": False,
    }
    result = asyncio.run(sep.complete_order(order["id"], Actor(body)))
    with psycopg.connect(clean_orders) as pg:
        handoff = pg.execute(
            "SELECT total_qty,volume_count,notes FROM distrilog.shipments WHERE id=%s",
            (result["shipment_id"],),
        ).fetchone()
        assert handoff[0:2] == (3, 3)
        assert "Bags: 2" in handoff[2]
        assert "Peso: 4.125 kg" in handoff[2]
        assert pg.execute(
            "SELECT COUNT(*) FROM distrilog.shipment_items WHERE shipment_id=%s",
            (result["shipment_id"],),
        ).fetchone()[0] == 1
    with pytest.raises(HTTPException) as error:
        asyncio.run(sep.complete_order(order["id"], Actor(body)))
    assert error.value.status_code == 409


def test_pause_is_measured_and_reason_recorded(clean_orders):
    _import(report(document="90002"))
    order = sep.list_orders(Actor())[0]
    order_id = order["id"]
    sep.start_order(order_id, Actor())
    asyncio.run(sep.pause_order(order_id, Actor({"reason": "Reposição de caixas"})))
    with psycopg.connect(clean_orders) as pg:
        pg.execute(
            """UPDATE distrilog.separation_orders
               SET started_at=now()-interval '120 seconds',
                   pause_started_at=now()-interval '60 seconds'
               WHERE id=%s""", (order_id,),
        )
        pg.commit()
    sep.resume_order(order_id, Actor())
    row = next(x for x in sep.list_orders(Actor()) if x["id"] == order_id)
    assert row["accumulated_pause_seconds"] >= 60
    pause = int(row["accumulated_pause_seconds"])
    assert pause <= 61
    body = {
        "bags": 1, "boxes": 0, "separated_qty": 3, "weight_kg": "2.00",
        "zero_left": True, "had_pause": True,
        "pause_reason": "Reposição de caixas", "pause_duration": "00:01:00",
    }
    result = asyncio.run(sep.complete_order(order_id, Actor(body)))
    assert result["shipment_id"] > 0
    with psycopg.connect(clean_orders) as pg:
        row = pg.execute(
            "SELECT status,had_pause,declared_pause_seconds,pause_reason FROM distrilog.separation_orders WHERE id=%s",
            (order_id,),
        ).fetchone()
        assert row == ("CONCLUIDA", True, 60, "Reposição de caixas")
