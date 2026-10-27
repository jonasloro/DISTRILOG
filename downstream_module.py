from __future__ import annotations

import os
import db
from positions_module import item_allocation_totals, deactivate_card_allocations
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request

BASE_DIR = Path(__file__).resolve().parent
router = APIRouter(prefix="/api", tags=["Etiquetagem e Estocagem"])
SECTORS = {"ETIQUETAGEM", "ESTOCAGEM"}


def db_connect() -> "db.Connection":
    """Conexão direta com o Supabase (pool)."""
    return db.connect()


def now() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def user(con: "db.Connection", user_id: int, sector: str) -> db.Row:
    row = con.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    allowed = {sector.lower(), "supervisor", "admin"}
    if not row or row["role"] not in allowed:
        raise HTTPException(403, "Seu perfil não possui permissão para esta operação.")
    return row


def history(con: "db.Connection", card_id: int, kind: str, text: str, user_id: int) -> None:
    con.execute(
        "INSERT INTO history(card_id,user_id,event_type,description,created_at) VALUES(?,?,?,?,?)",
        (card_id, user_id, kind, text, now()),
    )


def init_downstream_db() -> None:
    con = db_connect()
    con.executescript("""
    CREATE TABLE IF NOT EXISTS downstream_operations(
      id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, sector TEXT NOT NULL,
      purchase_mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ABERTO', created_at TEXT NOT NULL,
      completed_at TEXT, completed_by INTEGER, source_subset INTEGER NOT NULL DEFAULT 0,
      labeling_type TEXT, UNIQUE(card_id,sector),
      FOREIGN KEY(card_id) REFERENCES cards(id), FOREIGN KEY(completed_by) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS downstream_operation_items(
      operation_id INTEGER NOT NULL, item_id INTEGER NOT NULL, PRIMARY KEY(operation_id,item_id),
      FOREIGN KEY(operation_id) REFERENCES downstream_operations(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS downstream_assignments(
      id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id INTEGER NOT NULL, item_id INTEGER,
      worker_user_id INTEGER NOT NULL, assigned_qty INTEGER NOT NULL, completed_qty INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ATRIBUIDA', timer_state TEXT NOT NULL DEFAULT 'NAO_INICIADA',
      timer_started_at TEXT, accumulated_seconds INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      completed_at TEXT, FOREIGN KEY(operation_id) REFERENCES downstream_operations(id),
      FOREIGN KEY(item_id) REFERENCES items(id), FOREIGN KEY(worker_user_id) REFERENCES users(id));
    CREATE INDEX IF NOT EXISTS idx_downstream_card ON downstream_operations(card_id,sector);
    CREATE INDEX IF NOT EXISTS idx_downstream_assignment ON downstream_assignments(operation_id,item_id);
    CREATE TABLE IF NOT EXISTS storage_blind_checks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id INTEGER NOT NULL, item_id INTEGER,
      counted_qty INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, matched INTEGER NOT NULL DEFAULT 0,
      counted_by INTEGER NOT NULL, counted_by_name TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(operation_id) REFERENCES downstream_operations(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE SET NULL);
    CREATE INDEX IF NOT EXISTS idx_storage_blind_checks_operation ON storage_blind_checks(operation_id,item_id,id);
    CREATE TABLE IF NOT EXISTS labeling_final_checks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
      counted_qty INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, matched INTEGER NOT NULL DEFAULT 0,
      counted_by INTEGER NOT NULL, counted_by_name TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(operation_id) REFERENCES downstream_operations(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS idx_labeling_final_checks_operation ON labeling_final_checks(operation_id,item_id,id);
    """)
    columns = {row["name"] for row in con.execute("PRAGMA table_info(downstream_operations)").fetchall()}
    if "source_subset" not in columns:
        con.execute("ALTER TABLE downstream_operations ADD COLUMN source_subset INTEGER NOT NULL DEFAULT 0")
    if "labeling_type" not in columns:
        con.execute("ALTER TABLE downstream_operations ADD COLUMN labeling_type TEXT")
    con.commit()
    con.close()


def ensure_operation(con: "db.Connection", card_id: int, sector: str) -> db.Row:
    sector = sector.upper()
    if sector not in SECTORS:
        raise HTTPException(400, "Setor inválido.")
    card = con.execute("SELECT * FROM cards WHERE id=?", (card_id,)).fetchone()
    if not card:
        raise HTTPException(404, "Card não encontrado.")
    source_subset = bool(card["source_snapshot_at"] and card["current_sector"] != sector)
    eligible_items = []
    if source_subset:
        eligible_items = con.execute(
            "SELECT id FROM items WHERE card_id=? AND source_stage=? ORDER BY id", (card_id, sector)
        ).fetchall()
        if not eligible_items:
            raise HTTPException(400, f"Não há itens disponíveis em {sector.title()}.")
    elif card["current_sector"] != sector:
        raise HTTPException(400, f"O Card não está em {sector.title()}.")
    is_test = str(card["original_type"] or "").strip().upper() == "TESTE" or "CARD DE TESTE" in str(card["source_notes"] or "").upper()
    if sector == "ETIQUETAGEM" and not source_subset and not is_test:
        cadastro_total = int(con.execute("SELECT COUNT(*) n FROM processing_cadastro_tasks WHERE card_id=?",(card_id,)).fetchone()["n"] or 0)
        pending_labels = int(con.execute("""SELECT COUNT(*) n FROM processing_cadastro_tasks
          WHERE card_id=? AND (status<>'CONCLUIDO' OR COALESCE(labels_ready,0)=0)""",(card_id,)).fetchone()["n"] or 0)
        if cadastro_total <= 0 or pending_labels > 0:
            raise HTTPException(409, "Aguardando etiquetas. O responsável pelo Cadastro precisa informar que as etiquetas estão disponíveis.")
    con.execute(
        "INSERT OR IGNORE INTO downstream_operations(card_id,sector,purchase_mode,source_subset,created_at) VALUES(?,?,?,?,?)",
        (card_id, sector, card["purchase_mode"], 1 if source_subset else 0, now()),
    )
    operation = con.execute("SELECT * FROM downstream_operations WHERE card_id=? AND sector=?", (card_id, sector)).fetchone()
    if operation["status"] != "ABERTO":
        raise HTTPException(400, f"O controle de {sector.title()} desta compra já foi concluído.")
    if source_subset:
        for item in eligible_items:
            con.execute(
                "INSERT OR IGNORE INTO downstream_operation_items(operation_id,item_id) VALUES(?,?)",
                (operation["id"], item["id"]),
            )
    return operation


def elapsed(row: db.Row) -> int:
    seconds = int(row["accumulated_seconds"] or 0)
    if row["timer_state"] == "EM_ANDAMENTO" and row["timer_started_at"]:
        seconds += max(0, int((datetime.now() - datetime.fromisoformat(row["timer_started_at"])).total_seconds()))
    return seconds


def downstream_card_data(con: "db.Connection", card_id: int, sector: str) -> dict[str, Any] | None:
    op = con.execute("SELECT * FROM downstream_operations WHERE card_id=? AND sector=?", (card_id, sector)).fetchone()
    card = con.execute("SELECT purchase_mode FROM cards WHERE id=?", (card_id,)).fetchone()
    if not card:
        return None
    if not op:
        return {"id": None, "sector": sector, "purchase_mode": card["purchase_mode"], "status": "NAO_INICIADO", "items": [], "assignments": [], "totals": {"expected": 0, "assigned": 0, "completed": 0, "available": 0}}
    source_subset = bool("source_subset" in op.keys() and op["source_subset"])
    subset_filter = "AND EXISTS (SELECT 1 FROM downstream_operation_items doi WHERE doi.operation_id=? AND doi.item_id=i.id)" if source_subset else ""
    item_params = (op["id"], op["id"], card_id, op["id"]) if source_subset else (op["id"], op["id"], card_id)
    items = [dict(r) for r in con.execute(f"""
      SELECT i.id item_id,i.product,i.reference,i.sku,i.color,i.size,
       COALESCE(i.real_qty,NULLIF((SELECT piq.processed_qty FROM processing_item_quantities piq
         JOIN processing_records pr ON pr.id=piq.processing_id WHERE pr.card_id=i.card_id AND piq.item_id=i.id
         ORDER BY pr.id DESC LIMIT 1),0),i.expected_qty) expected_qty,
       COALESCE((SELECT SUM(a.assigned_qty) FROM downstream_assignments a WHERE a.operation_id=? AND a.item_id=i.id),0) assigned_qty,
       COALESCE((SELECT SUM(a.completed_qty) FROM downstream_assignments a WHERE a.operation_id=? AND a.item_id=i.id),0) completed_qty
      FROM items i WHERE i.card_id=? {subset_filter}
      ORDER BY i.product,i.color,i.size,i.id""", item_params).fetchall()]
    assignments = []
    for row in con.execute("""SELECT a.*,u.name worker_name,i.product,i.reference,i.sku,i.color,i.size
      FROM downstream_assignments a JOIN users u ON u.id=a.worker_user_id
      LEFT JOIN items i ON i.id=a.item_id WHERE a.operation_id=? ORDER BY a.id DESC""", (op["id"],)).fetchall():
        data = dict(row); data["elapsed_seconds"] = elapsed(row); assignments.append(data)
    expected = sum(int(i["expected_qty"] or 0) for i in items)
    assigned = sum(int(a["assigned_qty"] or 0) for a in assignments)
    completed = sum(int(a["completed_qty"] or 0) for a in assignments)
    result = dict(op)
    result.update({"items": items, "assignments": assignments,
                   "totals": {"expected": expected, "assigned": assigned, "completed": completed, "available": max(0, expected-assigned)}})
    return result


def _operation_expected_by_item(con: "db.Connection", op: db.Row) -> dict[int,int]:
    params: list[Any] = [int(op["card_id"])]
    sql = "SELECT id,COALESCE(real_qty,expected_qty,0) qty FROM items WHERE card_id=?"
    if bool(op["source_subset"]):
        ids=[int(r["item_id"]) for r in con.execute(
            "SELECT item_id FROM downstream_operation_items WHERE operation_id=? ORDER BY item_id",(int(op["id"]),)).fetchall()]
        if not ids:
            return {}
        sql += " AND id IN (" + ",".join("?" for _ in ids) + ")"
        params.extend(ids)
    rows=con.execute(sql+" ORDER BY id",params).fetchall()
    return {int(r["id"]):int(r["qty"] or 0) for r in rows}


def _missing_allocations(setor: str, card_id: int, expected: dict[int,int]) -> dict[int,int]:
    allocated=item_allocation_totals(card_id,setor)
    return {iid:max(0,qty-int(allocated.get(iid,0))) for iid,qty in expected.items()
            if int(allocated.get(iid,0)) < qty}


@router.get("/downstream/users")
def downstream_users(sector: str):
    sector = sector.upper()
    if sector not in SECTORS:
        raise HTTPException(400, "Setor inválido.")
    con = db_connect()
    rows = con.execute("SELECT id,name,username,role FROM users WHERE role=? ORDER BY name", (sector.lower(),)).fetchall()
    con.close()
    return [dict(r) for r in rows]


@router.post("/cards/{card_id}/downstream/{sector}")
async def create_operation(card_id: int, sector: str, request: Request):
    payload = await request.json(); uid = int(payload.get("user_id") or 0); sector = sector.upper()
    con = db_connect(); actor = user(con, uid, sector); op = ensure_operation(con, card_id, sector)
    labeling_type = str(payload.get("labeling_type") or "").strip().upper()
    if sector == "ETIQUETAGEM":
        allowed_types = {"APENAS_BRANCA","APENAS_VERMELHA","TAG_BRANCA","BRANCA_VERMELHA"}
        if labeling_type not in allowed_types:
            con.close(); raise HTTPException(400,"Selecione o tipo de etiquetagem.")
        con.execute("UPDATE downstream_operations SET labeling_type=? WHERE id=?",(labeling_type,int(op["id"])))
    history(con, card_id, f"{sector}_INICIADA",
            f"{actor['name']} iniciou o controle de {sector.title()}"+(f" ({labeling_type})." if sector=="ETIQUETAGEM" else "."), uid)
    con.commit(); data = downstream_card_data(con, card_id, sector); con.close(); return data


@router.post("/downstream/{operation_id}/claim")
async def claim(operation_id: int, request: Request):
    p = await request.json(); uid = int(p.get("user_id") or 0); worker_id = int(p.get("worker_user_id") or uid); qty = int(p.get("qty") or 0)
    con = db_connect(); con.execute("BEGIN IMMEDIATE")
    op = con.execute("SELECT * FROM downstream_operations WHERE id=?", (operation_id,)).fetchone()
    if not op: con.close(); raise HTTPException(404, "Operação não encontrada.")
    actor = user(con, uid, op["sector"])
    worker = con.execute("SELECT * FROM users WHERE id=? AND role=?", (worker_id, op["sector"].lower())).fetchone()
    if not worker: con.close(); raise HTTPException(400, "Selecione um colaborador do setor.")
    if op["status"] != "ABERTO" or (qty <= 0 and op["sector"]!="ESTOCAGEM"): con.close(); raise HTTPException(400, "Informe uma quantidade válida em uma operação aberta.")
    item_id = int(p.get("item_id") or 0) or None
    if op["purchase_mode"] == "GRADE":
        if not item_id: con.close(); raise HTTPException(400, "Selecione um tamanho.")
        item = con.execute("SELECT * FROM items WHERE id=? AND card_id=?", (item_id, op["card_id"])).fetchone()
        if not item: con.close(); raise HTTPException(400, "O tamanho não pertence a este Card.")
        if op["source_subset"] and not con.execute(
            "SELECT 1 FROM downstream_operation_items WHERE operation_id=? AND item_id=?", (operation_id, item_id)
        ).fetchone():
            con.close(); raise HTTPException(400, "Este tamanho não está disponível nesta etapa.")
        duplicate = con.execute("SELECT 1 FROM downstream_assignments WHERE operation_id=? AND item_id=? AND status!='LIBERADA'", (operation_id,item_id)).fetchone()
        if duplicate: con.close(); raise HTTPException(409, "Este tamanho já foi assumido.")
        processed = con.execute("""SELECT piq.processed_qty FROM processing_item_quantities piq
          JOIN processing_records pr ON pr.id=piq.processing_id WHERE pr.card_id=? AND piq.item_id=?
          ORDER BY pr.id DESC LIMIT 1""", (op["card_id"], item_id)).fetchone()
        if item["real_qty"] is not None:
            expected = int(item["real_qty"] or 0)
        else:
            expected = int(processed["processed_qty"] or 0) if processed else 0
            if expected <= 0: expected = int(item["expected_qty"] or 0)
        if op["sector"]=="ESTOCAGEM": qty=expected
        if qty != expected: con.close(); raise HTTPException(400, f"Grade é assumida por tamanho completo ({expected} peças).")
    else:
        item_id = None
        expected = sum(int(r[0] or 0) for r in con.execute("SELECT COALESCE(real_qty,expected_qty,0) FROM items WHERE card_id=?", (op["card_id"],)))
        used = con.execute("SELECT COALESCE(SUM(assigned_qty),0) FROM downstream_assignments WHERE operation_id=? AND status!='LIBERADA'", (operation_id,)).fetchone()[0]
        remaining=max(0,expected-int(used or 0))
        if op["sector"]=="ESTOCAGEM": qty=remaining
        if qty <= 0 or qty > remaining: con.close(); raise HTTPException(400, f"Há somente {remaining} peças disponíveis.")
    cur = con.execute("INSERT INTO downstream_assignments(operation_id,item_id,worker_user_id,assigned_qty,created_at) VALUES(?,?,?,?,?)", (operation_id,item_id,worker_id,qty,now()))
    history(con, op["card_id"], f"{op['sector']}_ASSUMIDA", f"{actor['name']} atribuiu {qty} peça(s) a {con.execute('SELECT name FROM users WHERE id=?',(worker_id,)).fetchone()[0]}.", uid)
    con.commit(); aid=cur.lastrowid; con.close(); return {"id":aid}


@router.post("/downstream/assignments/{assignment_id}/timer/{action}")
async def timer(assignment_id: int, action: str, request: Request):
    p=await request.json(); uid=int(p.get("user_id") or 0); con=db_connect()
    row=con.execute("SELECT a.*,o.sector,o.card_id FROM downstream_assignments a JOIN downstream_operations o ON o.id=a.operation_id WHERE a.id=?",(assignment_id,)).fetchone()
    if not row: con.close(); raise HTTPException(404,"Atribuição não encontrada.")
    actor=user(con,uid,row["sector"])
    if actor["role"]==row["sector"].lower() and row["worker_user_id"]!=uid: con.close(); raise HTTPException(403,"Você controla somente o seu próprio tempo.")
    state=row["timer_state"]; stamp=now(); accum=int(row["accumulated_seconds"] or 0)
    if action in {"pause","finish"} and state=="EM_ANDAMENTO" and row["timer_started_at"]: accum += max(0,int((datetime.now()-datetime.fromisoformat(row["timer_started_at"])).total_seconds()))
    if action=="start" and state=="NAO_INICIADA": new="EM_ANDAMENTO"
    elif action=="resume" and state=="PAUSADA": new="EM_ANDAMENTO"
    elif action=="pause" and state=="EM_ANDAMENTO": new="PAUSADA"
    elif action=="finish" and state in {"EM_ANDAMENTO","PAUSADA"}: new="FINALIZADA"
    else: con.close(); raise HTTPException(400,"Ação incompatível com o estado atual.")
    con.execute("UPDATE downstream_assignments SET timer_state=?,timer_started_at=?,accumulated_seconds=?,status=? WHERE id=?",(new,stamp if new=="EM_ANDAMENTO" else None,accum,"CONCLUIDA" if new=="FINALIZADA" else "EM_EXECUCAO",assignment_id))
    con.commit(); con.close(); return {"timer_state":new,"elapsed_seconds":accum}


@router.patch("/downstream/assignments/{assignment_id}")
async def result(assignment_id: int, request: Request):
    p=await request.json(); uid=int(p.get("user_id") or 0); qty=int(p.get("completed_qty") or 0); con=db_connect()
    row=con.execute("SELECT a.*,o.sector,o.card_id FROM downstream_assignments a JOIN downstream_operations o ON o.id=a.operation_id WHERE a.id=?",(assignment_id,)).fetchone()
    if not row: con.close(); raise HTTPException(404,"Atribuição não encontrada.")
    actor=user(con,uid,row["sector"])
    if actor["role"]==row["sector"].lower() and row["worker_user_id"]!=uid: con.close(); raise HTTPException(403,"Você altera somente o seu próprio apontamento.")
    if qty<0 or qty>int(row["assigned_qty"]): con.close(); raise HTTPException(400,"A quantidade concluída deve estar entre zero e a quantidade assumida.")
    con.execute("UPDATE downstream_assignments SET completed_qty=? WHERE id=?",(qty,assignment_id)); con.commit(); con.close(); return {"completed_qty":qty}


@router.post("/downstream/{operation_id}/labeling-check")
async def labeling_final_check(operation_id: int, request: Request):
    p=await request.json(); uid=int(p.get("user_id") or 0); supplied=p.get("items")
    if not isinstance(supplied,list): raise HTTPException(400,"Informe a contagem final por cor e tamanho.")
    con=db_connect()
    try:
        con.execute("BEGIN"); op=con.execute("SELECT * FROM downstream_operations WHERE id=?",(operation_id,)).fetchone()
        if not op or op["sector"]!="ETIQUETAGEM": raise HTTPException(404,"Operação de Etiquetagem não encontrada.")
        if op["status"]!="ABERTO": raise HTTPException(409,"A Etiquetagem já foi concluída.")
        actor=user(con,uid,"ETIQUETAGEM")
        expected=_operation_expected_by_item(con,op); seen=set(); divergences=[]
        for value in supplied:
            try: iid=int(value.get("item_id")); qty=int(value.get("counted_qty"))
            except (TypeError,ValueError,AttributeError): raise HTTPException(400,"Contagem inválida.") from None
            if iid not in expected or iid in seen or qty<0: raise HTTPException(400,"Item inválido ou duplicado na conferência.")
            seen.add(iid); prev=con.execute("SELECT MAX(attempt) n FROM labeling_final_checks WHERE operation_id=? AND item_id=?",(operation_id,iid)).fetchone()
            attempt=int(prev["n"] or 0)+1; matched=qty==expected[iid]
            con.execute("""INSERT INTO labeling_final_checks(operation_id,item_id,counted_qty,attempt,matched,counted_by,counted_by_name,created_at)
              VALUES(?,?,?,?,?,?,?,?)""",(operation_id,iid,qty,attempt,1 if matched else 0,uid,actor["name"],now()))
            if not matched: divergences.append({"item_id":iid,"attempt":attempt})
        if set(expected)!=seen: raise HTTPException(400,"A conferência precisa incluir toda a grade da Etiquetagem.")
        if divergences:
            persistent=any(x["attempt"]>=2 for x in divergences)
            history(con,int(op["card_id"]),"ETIQUETAGEM_RECONTAGEM_DIVERGENTE",f"{actor['name']} encontrou divergência na conferência final da Etiquetagem.",uid)
            con.commit(); return {"ok":False,"requires_recount":True,"persistent_divergence":persistent,"divergences":divergences,
              "detail":("A recontagem continua divergente. Procure o responsável do Processamento para verificar a grade." if persistent else "A quantidade não bateu com a Triagem. Reconte somente as linhas indicadas.")}
        history(con,int(op["card_id"]),"ETIQUETAGEM_CONFERENCIA_OK",f"{actor['name']} conferiu a Etiquetagem; todas as quantidades bateram com a Triagem.",uid)
        con.commit(); return {"ok":True,"matched":True}
    finally: con.close()


@router.post("/downstream/{operation_id}/storage-check")
async def storage_blind_check(operation_id: int, request: Request):
    p=await request.json(); uid=int(p.get("user_id") or 0); supplied=p.get("items")
    if not isinstance(supplied,list): raise HTTPException(400,"Informe a contagem de todas as linhas.")
    con=db_connect()
    try:
        con.execute("BEGIN")
        op=con.execute("SELECT * FROM downstream_operations WHERE id=?",(operation_id,)).fetchone()
        if not op or op["sector"]!="ESTOCAGEM": raise HTTPException(404,"Operação de Estocagem não encontrada.")
        if op["status"]!="ABERTO": raise HTTPException(409,"A Estocagem já foi concluída.")
        actor=user(con,uid,"ESTOCAGEM")
        expected=_operation_expected_by_item(con,op); seen=set(); divergences=[]
        for value in supplied:
            try: iid=int(value.get("item_id")); qty=int(value.get("counted_qty"))
            except (TypeError,ValueError,AttributeError): raise HTTPException(400,"Contagem inválida.") from None
            if iid not in expected or iid in seen or qty<0: raise HTTPException(400,"Item inválido ou duplicado na conferência.")
            seen.add(iid); previous=con.execute("SELECT MAX(attempt) n FROM storage_blind_checks WHERE operation_id=? AND item_id=?",(operation_id,iid)).fetchone()
            attempt=int(previous["n"] or 0)+1; matched=qty==expected[iid]
            con.execute("""INSERT INTO storage_blind_checks(operation_id,item_id,counted_qty,attempt,matched,counted_by,counted_by_name,created_at)
              VALUES(?,?,?,?,?,?,?,?)""",(operation_id,iid,qty,attempt,1 if matched else 0,uid,actor["name"],now()))
            if not matched: divergences.append({"item_id":iid,"attempt":attempt})
        if set(expected)!=seen: raise HTTPException(400,"A conferência precisa incluir todas as linhas da Estocagem.")
        if divergences:
            persistent=any(x["attempt"]>=2 for x in divergences)
            history(con,int(op["card_id"]),"ESTOCAGEM_RECONTAGEM_DIVERGENTE",f"{actor['name']} encontrou divergência na conferência cega da Estocagem.",uid)
            con.commit()
            return {"ok":False,"requires_recount":True,"persistent_divergence":persistent,"divergences":divergences,
                    "detail":("A recontagem continua divergente. Procure o Processamento; somente o Processamento pode confirmar o erro e alterar a grade." if persistent else "A conferência divergiu. Reconte somente as linhas indicadas.")}
        history(con,int(op["card_id"]),"ESTOCAGEM_CONFERENCIA_OK",f"{actor['name']} concluiu a conferência cega da Estocagem sem divergências.",uid)
        con.commit(); return {"ok":True,"matched":True}
    finally: con.close()


@router.post("/downstream/{operation_id}/complete")
async def complete(operation_id: int, request: Request):
    p=await request.json(); uid=int(p.get("user_id") or 0); con=db_connect(); op=con.execute("SELECT * FROM downstream_operations WHERE id=?",(operation_id,)).fetchone()
    if not op: con.close(); raise HTTPException(404,"Operação não encontrada.")
    if op["status"]!="ABERTO": con.close(); raise HTTPException(409,"Esta operação já foi concluída.")
    actor=user(con,uid,op["sector"]); data=downstream_card_data(con,op["card_id"],op["sector"])
    expected_map=_operation_expected_by_item(con,op)
    item_ids=list(expected_map)
    if not item_ids: con.close(); raise HTTPException(400,f"A {op['sector'].title()} não possui itens para conferir.")
    missing_ec=_missing_allocations("EC",int(op["card_id"]),expected_map)
    if missing_ec:
        con.close(); raise HTTPException(409,f"Antes de concluir, enderece toda a mercadoria em EC. Restam {sum(missing_ec.values())} peça(s) sem endereço.")
    marks=",".join("?" for _ in item_ids)
    if op["sector"]=="ETIQUETAGEM":
        matched=int(con.execute(f"""SELECT COUNT(*) n FROM labeling_final_checks s WHERE s.operation_id=? AND s.item_id IN ({marks}) AND s.matched=1
          AND s.id=(SELECT MAX(s2.id) FROM labeling_final_checks s2 WHERE s2.operation_id=s.operation_id AND s2.item_id=s.item_id)""",(operation_id,*item_ids)).fetchone()["n"] or 0)
        if matched!=len(item_ids): con.close(); raise HTTPException(409,"Conclua a conferência final da Etiquetagem antes de enviar para Estocagem.")
    elif op["sector"]=="ESTOCAGEM":
        matched=int(con.execute(f"""SELECT COUNT(*) n FROM storage_blind_checks s WHERE s.operation_id=? AND s.item_id IN ({marks}) AND s.matched=1
          AND s.id=(SELECT MAX(s2.id) FROM storage_blind_checks s2 WHERE s2.operation_id=s.operation_id AND s2.item_id=s.item_id)""",(operation_id,*item_ids)).fetchone()["n"] or 0)
        if matched!=len(item_ids): con.close(); raise HTTPException(409,"Conclua a conferência cega da Estocagem antes de finalizar.")
    unfinished = con.execute("SELECT COUNT(*) FROM downstream_assignments WHERE operation_id=? AND timer_state!='FINALIZADA'", (operation_id,)).fetchone()[0]
    if unfinished: con.close(); raise HTTPException(400,"Finalize o cronômetro de todas as atribuições antes de concluir o setor.")
    nxt="ESTOCAGEM" if op["sector"]=="ETIQUETAGEM" else "PROCESSAMENTO"; status="AGUARDANDO_ESTOCAGEM" if op["sector"]=="ETIQUETAGEM" else "AGUARDANDO_ENTRADA"
    con.execute("UPDATE downstream_operations SET status='CONCLUIDO',completed_at=?,completed_by=? WHERE id=?",(now(),uid,operation_id))
    if op["source_subset"]:
        item_ids = [row["item_id"] for row in con.execute(
            "SELECT item_id FROM downstream_operation_items WHERE operation_id=?", (operation_id,)
        ).fetchall()]
        if item_ids:
            marks = ",".join("?" for _ in item_ids)
            next_stage = "ESTOCAGEM" if op["sector"] == "ETIQUETAGEM" else "CONCLUIDO"
            con.execute(f"UPDATE items SET source_stage=? WHERE id IN ({marks})", (next_stage, *item_ids))
            if op["sector"] == "ESTOCAGEM" and op["purchase_mode"] == "GRADE":
                completed = con.execute(
                    "SELECT item_id,SUM(completed_qty) qty FROM downstream_assignments WHERE operation_id=? GROUP BY item_id",
                    (operation_id,),
                ).fetchall()
                for row in completed:
                    con.execute("""UPDATE processing_item_quantities SET stored_qty=? WHERE item_id=?
                      AND processing_id=(SELECT id FROM processing_records WHERE card_id=? ORDER BY id DESC LIMIT 1)""",
                      (int(row["qty"] or 0), row["item_id"], op["card_id"]))
        con.execute("UPDATE cards SET updated_at=? WHERE id=?", (now(), op["card_id"]))
    else:
        con.execute("UPDATE cards SET current_sector=?,status=?,updated_at=? WHERE id=?",(nxt,status,now(),op["card_id"]))
    moved_item_ids = [int(r["item_id"]) for r in con.execute(
        "SELECT item_id FROM downstream_operation_items WHERE operation_id=?",(operation_id,)).fetchall()] if op["source_subset"] else None
    deactivate_card_allocations(int(op["card_id"]),("ET",),moved_item_ids)
    if op["sector"] == "ESTOCAGEM":
        from processing_flow_module import ensure_storage_entry
        ensure_storage_entry(con,int(op["card_id"]),int(operation_id))
    history(con,op["card_id"],f"{op['sector']}_CONCLUIDA",f"{actor['name']} concluiu {op['sector'].title()}.",uid); con.commit(); con.close(); return {"status":status}


def register_downstream_routes(app: FastAPI) -> None:
    app.include_router(router)
