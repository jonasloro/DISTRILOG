from __future__ import annotations

import os

import psycopg
from fastapi import FastAPI
from fastapi.testclient import TestClient

import db
import processing_flow_module as flow
import processing_module
import downstream_module


def setup_db():
    with psycopg.connect(os.environ["SUPABASE_DATABASE_URL"], autocommit=True) as raw:
        raw.execute("DROP SCHEMA IF EXISTS distrilog CASCADE")
        raw.execute("CREATE SCHEMA distrilog")
    con = db.connect()
    try:
        con.executescript("""
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, role TEXT NOT NULL
        );
        CREATE TABLE cards (
          id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id TEXT UNIQUE NOT NULL,
          supplier TEXT, brand TEXT, purchase_mode TEXT, current_sector TEXT NOT NULL,
          status TEXT NOT NULL, receiving_type TEXT NOT NULL DEFAULT 'NOVA',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE items (
          id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, reference TEXT,
          product TEXT, expected_qty INTEGER NOT NULL DEFAULT 0, real_qty INTEGER,
          color TEXT, size TEXT, source_stage TEXT,
          FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
        );
        CREATE TABLE history (
          id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, user_id INTEGER,
          event_type TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE downstream_operations (
          id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, sector TEXT NOT NULL,
          purchase_mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ABERTO', created_at TEXT NOT NULL,
          completed_at TEXT, completed_by INTEGER, source_subset INTEGER NOT NULL DEFAULT 0,
          UNIQUE(card_id,sector), FOREIGN KEY(card_id) REFERENCES cards(id),
          FOREIGN KEY(completed_by) REFERENCES users(id)
        );
        CREATE TABLE downstream_operation_items (
          operation_id INTEGER NOT NULL, item_id INTEGER NOT NULL, PRIMARY KEY(operation_id,item_id)
        );
        """)
        con.commit()
    finally:
        con.close()
    processing_module.init_processing_db()
    downstream_module.init_downstream_db()
    flow.init_processing_flow_db()


def insert_card(con, purchase_id, sector, status):
    stamp = "2026-10-23T12:00:00-03:00"
    cur = con.execute(
        """INSERT INTO cards(purchase_id,supplier,brand,purchase_mode,current_sector,status,receiving_type,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?)""",
        (purchase_id, "Fornecedor teste", "Marca teste", "GRADE", sector, status, "NOVA", stamp, stamp),
    )
    return int(cur.lastrowid)


def test_cadastro_triage_and_entry_round_trip(monkeypatch):
    monkeypatch.setenv("SUPABASE_DATABASE_URL", os.environ["SUPABASE_DATABASE_URL"])
    setup_db()
    con = db.connect()
    try:
        user_id = int(con.execute(
            "INSERT INTO users(username,password,name,role) VALUES(?,?,?,?)",
            ("processamento_teste", "", "Operadora teste", "processamento"),
        ).lastrowid)
        storage_user_id = int(con.execute(
            "INSERT INTO users(username,password,name,role) VALUES(?,?,?,?)",
            ("estocagem_teste", "", "Operador de estocagem", "estocagem"),
        ).lastrowid)

        # Cadastro is a projection and is idempotent per card/reference.
        sewing_card = insert_card(con, "COMPRA-CADASTRO", "QUALIDADE", "AGUARDANDO_DESPACHO_COSTURA")
        con.execute(
            """INSERT INTO items(card_id,reference,product,expected_qty,color,size,source_stage)
               VALUES(?,?,?,?,?,?,?),(?,?,?,?,?,?,?)""",
            (sewing_card,"REF-ALFA","Produto alfa",10,"Preto","P","AGUARDANDO_COSTURA",
             sewing_card,"REF-ALFA","Produto alfa",12,"Preto","M","AGUARDANDO_COSTURA"),
        )
        assert flow.ensure_cadastro_tasks(con, sewing_card) == 1
        con.commit()
        assert flow.backfill_cadastro_tasks() == 0
        assert flow.backfill_cadastro_tasks() == 0
        task = con.execute("SELECT * FROM processing_cadastro_tasks WHERE card_id=?", (sewing_card,)).fetchall()
        assert len(task) == 1
        assert int(con.execute("SELECT COUNT(*) n FROM cards WHERE id=?", (sewing_card,)).fetchone()["n"]) == 1
        card = con.execute("SELECT current_sector,status FROM cards WHERE id=?", (sewing_card,)).fetchone()
        assert (card["current_sector"], card["status"]) == ("QUALIDADE", "AGUARDANDO_DESPACHO_COSTURA")

        test_app = FastAPI()
        flow.register_processing_flow_routes(test_app)
        downstream_module.register_downstream_routes(test_app)
        client = TestClient(test_app)

        def post(path, payload):
            return client.post(path, json=payload)

        task_id = int(task[0]["id"])
        for action in ("start", "pause", "resume", "finish"):
            response = post(f"/api/processing/cadastro/{task_id}/{action}", {"user_id": user_id})
            assert response.status_code == 200, response.text
        assert con.execute("SELECT status FROM processing_cadastro_tasks WHERE id=?", (task_id,)).fetchone()["status"] == "CONCLUIDO"

        # Triage persists the real count separately and never changes the original grade.
        triage_card = insert_card(con, "COMPRA-TRIAGEM", "PROCESSAMENTO", "AGUARDANDO_PROCESSAMENTO")
        con.execute(
            """INSERT INTO items(card_id,reference,product,expected_qty,color,size)
               VALUES(?,?,?,?,?,?),(?,?,?,?,?,?)""",
            (triage_card,"REF-BETA","Produto beta",10,"Azul","P",
             triage_card,"REF-GAMA","Produto gama",20,"Branco","M"),
        )
        op = con.execute(
            "INSERT INTO downstream_operations(card_id,sector,purchase_mode,status,source_subset,created_at) VALUES(?,?,?,?,?,?)",
            (triage_card,"ESTOCAGEM","GRADE","ABERTO",0,"2026-10-23T12:00:00-03:00"),
        )
        downstream_id = int(op.lastrowid)
        con.commit()
        queue = client.get(f"/api/processing/triage/queue?user_id={user_id}")
        assert queue.status_code == 200 and any(int(card["id"]) == triage_card for card in queue.json())
        started = post(f"/api/processing/triage/cards/{triage_card}/start", {"user_id": user_id})
        assert started.status_code == 200, started.text
        triage_id = int(started.json()["id"])
        invalid = post(f"/api/processing/triage/{triage_id}/finish", {"user_id":user_id,"counts":[]})
        assert invalid.status_code == 400, invalid.text
        assert con.execute("SELECT status FROM processing_triages WHERE id=?", (triage_id,)).fetchone()["status"] == "EM_ANDAMENTO"

        items = con.execute("SELECT id,expected_qty FROM items WHERE card_id=? ORDER BY id", (triage_card,)).fetchall()
        counts = [
            {"item_id":int(items[0]["id"]),"counted_qty":8},
            {"item_id":int(items[1]["id"]),"counted_qty":19},
            {"item_id":None,"is_extra":1,"reference":"REF-DELTA","color":"Azul-claro","size":"GG","counted_qty":3},
        ]
        finished = post(f"/api/processing/triage/{triage_id}/finish", {"user_id":user_id,"counts":counts})
        assert finished.status_code == 200, finished.text
        assert finished.json()["counted_total"] == 30
        actual = con.execute("SELECT expected_qty,real_qty FROM items WHERE card_id=? ORDER BY id",(triage_card,)).fetchall()
        assert [(int(x["expected_qty"]),int(x["real_qty"])) for x in actual] == [(10,8),(20,19)]
        assert int(con.execute("SELECT COUNT(*) n FROM processing_triage_counts WHERE triage_id=? AND is_extra=1",(triage_id,)).fetchone()["n"]) == 1

        # Completing Estocagem must create the pending Entrada in the same transaction.
        storage_rows = con.execute("SELECT id,real_qty FROM items WHERE card_id=? ORDER BY id", (triage_card,)).fetchall()
        assignments = [
            (downstream_id,int(storage_rows[0]["id"]),user_id,8,8,"CONCLUIDA","FINALIZADA","2026-10-23T12:01:00-03:00","2026-10-23T12:02:00-03:00"),
            (downstream_id,int(storage_rows[1]["id"]),user_id,19,19,"CONCLUIDA","FINALIZADA","2026-10-23T12:01:00-03:00","2026-10-23T12:02:00-03:00"),
        ]
        con.executemany(
            """INSERT INTO downstream_assignments(operation_id,item_id,worker_user_id,assigned_qty,completed_qty,status,timer_state,created_at,completed_at)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            assignments,
        )
        con.commit()
        storage_complete = client.post(f"/api/downstream/{downstream_id}/complete", json={"user_id":storage_user_id})
        assert storage_complete.status_code == 200, storage_complete.text
        assert con.execute("SELECT status FROM downstream_operations WHERE id=?", (downstream_id,)).fetchone()["status"] == "CONCLUIDO"

        queued = client.get(f"/api/processing/entry/queue?user_id={user_id}")
        assert queued.status_code == 200, queued.text
        entry = next(row for row in queued.json()["pending"] if int(row["card_id"]) == triage_card)
        assert len(entry["items"]) == 3
        expected_qty = {row["reference"]:int(row["triage_qty"]) for row in entry["items"]}
        assert expected_qty["REF-BETA"] == 8 and expected_qty["REF-GAMA"] == 19
        stored = [{"id":int(row["id"]),"stored_qty":int(row["triage_qty"]),"reason":""} for row in entry["items"]]
        stored[0]["stored_qty"] -= 1
        stored[0]["reason"] = "Diferença física confirmada"
        confirmed = post(f"/api/processing/entry/{entry['id']}/confirm",
                         {"user_id":user_id,"items":stored,"notes":"Teste automatizado"})
        assert confirmed.status_code == 200, confirmed.text
        assert confirmed.json()["has_divergence"] is True and confirmed.json()["grade_changed"] is True
        saved = con.execute("SELECT status,has_divergence,grade_changed,concluded_by_user_id FROM storage_entries WHERE id=?",(entry["id"],)).fetchone()
        assert saved["status"] == "CONFIRMADA"
        assert int(saved["has_divergence"]) == 1 and int(saved["grade_changed"]) == 1
        assert int(saved["concluded_by_user_id"]) == user_id
        assert int(con.execute("SELECT COUNT(*) n FROM downstream_operations WHERE id=?",(downstream_id,)).fetchone()["n"]) == 1
        assert int(con.execute("SELECT COUNT(*) n FROM history WHERE card_id=? AND event_type='TRIAGEM_CONCLUIDA'",(triage_card,)).fetchone()["n"]) == 1
        assert int(con.execute("SELECT COUNT(*) n FROM history WHERE card_id=? AND event_type='ENTRADA_ESTOCAGEM_CONFIRMADA'",(triage_card,)).fetchone()["n"]) == 1
        client.close()
    finally:
        con.close()
