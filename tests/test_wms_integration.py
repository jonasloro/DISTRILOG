"""WMS transfer integration tests against an isolated PostgreSQL service.

No production credentials are used. CI sets TEST_DATABASE_URL to its disposable
PostgreSQL container; the tests skip on normal workstations without that URL.
"""
from __future__ import annotations

import os
from types import SimpleNamespace

import psycopg
import pytest
from fastapi import HTTPException


@pytest.fixture(scope="module")
def db_url():
    url = os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.skip("A disposable PostgreSQL test database is not configured.")
    os.environ["AUTH_DATABASE_URL"] = url
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("CREATE SCHEMA IF NOT EXISTS distrilog")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS distrilog.users(
                id BIGINT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS distrilog.cards(
                id BIGINT PRIMARY KEY, purchase_id TEXT, supplier TEXT, brand TEXT, current_sector TEXT, status TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS distrilog.items(
                id BIGINT PRIMARY KEY, card_id BIGINT, product TEXT,
                reference TEXT, sku TEXT, color TEXT, size TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS distrilog.sector_positions(
                address TEXT PRIMARY KEY, setor TEXT NOT NULL,
                zona TEXT, casulo TEXT, nivel TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS distrilog.card_allocations(
                id SERIAL PRIMARY KEY, card_id BIGINT NOT NULL,
                setor TEXT NOT NULL, address TEXT NOT NULL,
                quantidade INTEGER NOT NULL, responsavel TEXT, created_at TEXT NOT NULL,
                item_id BIGINT, allocation_purpose TEXT NOT NULL DEFAULT 'STOCK',
                active BOOLEAN NOT NULL DEFAULT TRUE, box_count INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS distrilog.history(
                id SERIAL PRIMARY KEY, card_id BIGINT NOT NULL,
                user_id BIGINT, event_type TEXT, description TEXT, created_at TEXT
            )
        """)
    from wms_inventory_module import init_inventory_db
    init_inventory_db()
    yield url


@pytest.fixture
def session(db_url):
    with psycopg.connect(db_url) as conn:
        conn.execute("TRUNCATE distrilog.position_movements, distrilog.history, distrilog.card_allocations, distrilog.items, distrilog.cards, distrilog.users, distrilog.sector_positions RESTART IDENTITY CASCADE")
        conn.execute("INSERT INTO distrilog.users(id,name,role) VALUES(11,'Operador','recebimento'),(12,'Estoquista','estocagem')")
        conn.execute("INSERT INTO distrilog.cards(id,purchase_id,current_sector,status) VALUES(100,'TESTE-100','RECEBIMENTO','AGUARDANDO'),(101,'TESTE-101','ESTOCAGEM','AGUARDANDO')")
        conn.execute("""INSERT INTO distrilog.sector_positions(address,setor,zona,casulo,nivel)
            VALUES('1RM01A','RM','1','01','A'),('1RM02A','RM','1','02','A'),
                  ('1QA01A','QA','1','01','A'),('1EC01','EC','1','01',''),
                  ('1EC02','EC','1','02','')""")
        conn.commit()
    return db_url


def actor(user_id=11, role="recebimento"):
    return SimpleNamespace(state=SimpleNamespace(auth_user_id=user_id, auth_role=role))


def create_allocation(url, *, card=100, sector="RM", address="1RM01A",
                      qty=4, item_id=None, boxes=0):
    with psycopg.connect(url) as conn:
        row=conn.execute("""INSERT INTO distrilog.card_allocations
           (card_id,setor,address,quantidade,responsavel,created_at,item_id,box_count)
           VALUES(%s,%s,%s,%s,'setup','2026-10-27T12:00:00',%s,%s)
           RETURNING id""", (card,sector,address,qty,item_id,boxes)).fetchone()
        conn.commit()
        return row[0]


def test_partial_volume_transfer_is_atomic(session):
    from wms_inventory_module import TransferRequest, transfer, inventory, movement_history
    allocation_id = create_allocation(session)
    result = transfer(TransferRequest(
        source_allocation_id=allocation_id, destination_address="1QA01A",
        quantity=2, reason="Reposição entre setores",
    ),actor())
    assert result["quantity"] == 2
    assert result["unit"] == "VOLUME"
    origin = inventory("1RM01A")
    target = inventory("1QA01A")
    assert origin["occupied"] == 2
    assert target["occupied"] == 2
    assert len(movement_history("1RM01A")) == 1
    with psycopg.connect(session) as conn:
        assert conn.execute("SELECT active FROM distrilog.card_allocations WHERE id=%s", (allocation_id,)).fetchone()[0] is False
        assert conn.execute("SELECT COUNT(*) FROM distrilog.history WHERE event_type='TRANSFERENCIA_ENDERECO'").fetchone()[0] == 1


def test_full_color_transfer_preserves_boxes_and_sizes(session):
    from wms_inventory_module import TransferRequest, transfer, inventory
    with psycopg.connect(session) as conn:
        conn.execute("""INSERT INTO distrilog.items(id,card_id,product,reference,color,size)
           VALUES(1,101,'Blusa','REF-COR','Azul','P'),(2,101,'Blusa','REF-COR','Azul','M')""")
        conn.commit()
    source = create_allocation(session, card=101,sector="EC",address="1EC01",qty=5,item_id=1,boxes=3)
    create_allocation(session, card=101,sector="EC",address="1EC01",qty=7,item_id=2,boxes=0)
    result=transfer(TransferRequest(
        source_allocation_id=source,destination_address="1EC02",
        reason="Reorganizar cor azul",
    ),actor(user_id=12,role="estocagem"))
    assert result["box_count"] == 3
    assert result["quantity"] == 12
    assert inventory("1EC01")["occupied"] == 0
    assert inventory("1EC02")["occupied"] == 3
    assert len(inventory("1EC02")["items"]) == 2


def test_four_other_colors_block_transfer_without_mutation(session):
    from wms_inventory_module import TransferRequest, transfer, inventory
    with psycopg.connect(session) as conn:
        values=[(i,101,"Produto","REF",color,"P") for i,color in enumerate(["Azul","Rosa","Preto","Branco","Verde"],1)]
        conn.cursor().executemany("INSERT INTO distrilog.items(id,card_id,product,reference,color,size) VALUES(%s,%s,%s,%s,%s,%s)",values)
        conn.commit()
    source=create_allocation(session,card=101,sector="EC",address="1EC01",qty=12,item_id=1,boxes=2)
    for item in [2,3,4,5]:
        create_allocation(session,card=101,sector="EC",address="1EC02",qty=5,item_id=item,boxes=1)
    with pytest.raises(HTTPException) as exc:
        transfer(TransferRequest(source_allocation_id=source,
                 destination_address="1EC02", reason="Teste excesso de cores"),
                 actor(user_id=12,role="estocagem"))
    assert exc.value.status_code == 409
    assert inventory("1EC01")["occupied"] == 2
    assert inventory("1EC02")["occupied"] == 4
    with psycopg.connect(session) as conn:
        assert conn.execute("SELECT COUNT(*) FROM distrilog.position_movements").fetchone()[0] == 0
