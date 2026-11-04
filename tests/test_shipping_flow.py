"""Expedição: transições concorrentes e trava em PostgreSQL descartável.

Não usa o Supabase de produção. O CI oferece TEST_DATABASE_URL.
"""
from __future__ import annotations
import asyncio
import os
from types import SimpleNamespace

import psycopg
import pytest
from psycopg import ClientCursor
from psycopg_pool import ConnectionPool
from fastapi import HTTPException

import db
import shipping_flow_module as flow


class Actor:
    def __init__(self, user=88101, role="expedicao", payload=None):
        self.state = SimpleNamespace(auth_user_id=user, auth_role=role)
        self.payload = payload or {}

    async def json(self):
        return self.payload


@pytest.fixture(scope="module")
def postgres():
    url = os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Requer TEST_DATABASE_URL de banco descartável.")
    with psycopg.connect(url, autocommit=True) as con:
        con.execute("CREATE SCHEMA IF NOT EXISTS distrilog")
        con.execute("""CREATE TABLE IF NOT EXISTS distrilog.users(
            id BIGINT PRIMARY KEY,name TEXT,role TEXT)""")
        con.execute("""CREATE TABLE IF NOT EXISTS distrilog.shipments(
            id BIGSERIAL PRIMARY KEY,document_no TEXT,destination TEXT,
            status TEXT,total_qty INTEGER,created_by BIGINT,created_at TEXT,
            completed_at TEXT,carrier TEXT,vehicle_plate TEXT,driver_name TEXT,
            scheduled_at TEXT,volume_count INTEGER,notes TEXT,updated_at TEXT)""")
        for name in ("carrier","vehicle_plate","driver_name","scheduled_at","notes","updated_at"):
            con.execute(f"ALTER TABLE distrilog.shipments ADD COLUMN IF NOT EXISTS {name} TEXT")
        con.execute("ALTER TABLE distrilog.shipments ADD COLUMN IF NOT EXISTS volume_count INTEGER")
        con.execute("ALTER TABLE distrilog.shipments ADD COLUMN IF NOT EXISTS completed_at TEXT")
        con.execute("""INSERT INTO distrilog.users(id,name,role)
            VALUES(88101,'Expedição A','expedicao'),(88102,'Expedição B','expedicao'),
                  (88103,'Gestor','supervisor')
            ON CONFLICT(id) DO NOTHING""")
    pool = ConnectionPool(
        url, min_size=1, max_size=3,
        kwargs={"cursor_factory": ClientCursor, "prepare_threshold": None},
        open=True,
    )
    original = db.connect
    db.connect = lambda: db.Connection(pool)
    try:
        flow.init_shipping_flow_db()
        yield url
    finally:
        db.connect = original
        pool.close()


@pytest.fixture
def shipment(postgres):
    with psycopg.connect(postgres) as con:
        row = con.execute("""INSERT INTO distrilog.shipments
          (document_no,destination,status,total_qty,created_by,created_at,volume_count)
          VALUES('SHIPPING-TEST','Loja','AGUARDANDO_CONFERENCIA',30,88101,'2026-11-04',4)
          RETURNING id""").fetchone()
        con.commit()
    try:
        yield row[0]
    finally:
        with psycopg.connect(postgres) as con:
            con.execute("DELETE FROM distrilog.shipments WHERE id=%s", (row[0],))
            con.commit()


def test_one_operator_claim_prevents_another_and_does_not_reset_timer(shipment):
    assert flow.claim(shipment, Actor())["stage"] == "CONFERENCIA"
    with pytest.raises(HTTPException) as err:
        flow.claim(shipment, Actor(user=88102))
    assert err.value.status_code == 409
    assert flow.claim(shipment, Actor())["already_claimed"] is True
    assert flow.heartbeat(shipment, Actor()) == {"ok": True}
    assert flow.release(shipment, Actor()) == {"ok": True}
    assert flow.claim(shipment, Actor(user=88102))["stage"] == "CONFERENCIA"


def test_seals_to_invoice_to_explicit_dispatch(shipment):
    flow.claim(shipment, Actor())
    data = Actor(payload={"seals_checked": 4, "seals_ok": True})
    result = asyncio.run(flow.complete(shipment, data))
    assert result["stage"] == "FATURAMENTO"
    before = flow.detail(shipment, Actor())
    assert before["legacy_status"] != "EXPEDIDO"
    assert before["seals_checked"] == 4
    assert before["invoice_number"] is None
    flow.claim(shipment, Actor(user=88102))
    result = asyncio.run(flow.complete(shipment, Actor(user=88102, payload={"invoice_number": "NF-9076"})))
    assert result["stage"] == "EXPEDIR"
    pending = flow.detail(shipment, Actor())
    assert pending["legacy_status"] != "EXPEDIDO"
    assert pending["invoice_number"] == "NF-9076"
    assert flow.dispatch(shipment, Actor(user=88101))["stage"] == "EXPEDIDO"
    with pytest.raises(HTTPException) as err:
        flow.dispatch(shipment, Actor(user=88102))
    assert err.value.status_code == 409


def test_seal_mismatch_blocks_billing_until_supervisor_reopens(shipment):
    flow.claim(shipment, Actor())
    with pytest.raises(HTTPException):
        asyncio.run(flow.complete(shipment, Actor(payload={
            "seals_checked": 4, "seals_ok": False})))
    result = asyncio.run(flow.complete(shipment, Actor(payload={
        "seals_checked": 4, "seals_ok": False, "notes": "Lacre rompido"})))
    assert result["stage"] == "DIVERGENCIA"
    with pytest.raises(HTTPException):
        flow.claim(shipment, Actor(user=88102))
    with pytest.raises(HTTPException):
        asyncio.run(flow.resolve_divergence(shipment, Actor(payload={"reason": "Resolvido"})))
    assert asyncio.run(flow.resolve_divergence(
        shipment, Actor(user=88103, role="supervisor", payload={"reason": "Lacre substituído e revisado"})
    ))["stage"] == "CONFERENCIA"
    assert flow.claim(shipment, Actor(user=88102))["stage"] == "CONFERENCIA"


def test_only_shipping_role_may_operate(shipment):
    with pytest.raises(HTTPException) as err:
        flow.claim(shipment, Actor(role="recebimento"))
    assert err.value.status_code == 403
    assert len(flow.queue(Actor(role="recebimento"))) >= 1
