"""Cadastro, Triagem e conferência de Entrada do Processamento.
Persistência transacional no schema distrilog (Supabase)."""
from __future__ import annotations
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo
from fastapi import APIRouter, HTTPException, Request
import db

router = APIRouter(prefix="/api/processing", tags=["Processamento - fluxo"])
PROCESSING_ROLES = {"processamento", "supervisor", "admin"}
TZ = ZoneInfo("America/Sao_Paulo")

def _now() -> datetime:
    return datetime.now(TZ).replace(microsecond=0)

def _iso(value: datetime | None = None) -> str:
    return (value or _now()).isoformat(timespec="seconds")

def _user(con, user_id: Any):
    try:
        uid = int(user_id or 0)
    except (TypeError, ValueError):
        uid = 0
    row = con.execute("SELECT id,name,role FROM users WHERE id=?", (uid,)).fetchone()
    if not row:
        raise HTTPException(401, "Usuário não autenticado.")
    return row

def _operator(con, user_id: Any):
    actor = _user(con, user_id)
    if actor["role"] not in PROCESSING_ROLES:
        raise HTTPException(403, "Somente Processamento, Supervisor ou Administrador pode executar esta etapa.")
    return actor

def _qty(value: Any, label: str) -> int:
    if isinstance(value, bool) or value is None or str(value).strip() == "":
        raise HTTPException(400, f"Informe um inteiro válido para {label}.")
    try:
        number = int(value)
        if float(value) != number:
            raise HTTPException(400, f"{label} precisa ser um número inteiro.")
    except (TypeError, ValueError, OverflowError):
        raise HTTPException(400, f"Informe um inteiro válido para {label}.") from None
    if number < 0:
        raise HTTPException(400, f"{label} não pode ser negativo.")
    return number

def _summarize(events: list, now: datetime) -> dict[str, Any]:
    worked = paused = 0
    state, last = None, None
    for ev in events:
        at = datetime.fromisoformat(ev["occurred_at"])
        name = ev["event"]
        if name in ("START", "RESUME"):
            if state == "PAUSADA" and last:
                paused += max(0, int((at - last).total_seconds()))
            state, last = "EM_ANDAMENTO", at
        elif name == "PAUSE":
            if state == "EM_ANDAMENTO" and last:
                worked += max(0, int((at - last).total_seconds()))
            state, last = "PAUSADA", at
        elif name == "FINISH":
            if state == "EM_ANDAMENTO" and last:
                worked += max(0, int((at - last).total_seconds()))
            elif state == "PAUSADA" and last:
                paused += max(0, int((at - last).total_seconds()))
            state, last = "CONCLUIDO", at
    if state == "EM_ANDAMENTO" and last:
        worked += max(0, int((now - last).total_seconds()))
    elif state == "PAUSADA" and last:
        paused += max(0, int((now - last).total_seconds()))
    return {"state": state, "worked_seconds": worked, "paused_seconds": paused}

def _events_summary(con, table: str, fk: str, task_id: int, now: datetime | None = None):
    # table e fk são constantes internas, não dados do pedido.
    rows = con.execute(f"SELECT event,occurred_at FROM {table} WHERE {fk}=? ORDER BY id", (task_id,)).fetchall()
    return _summarize(rows, now or _now())

def _assert_no_other_timer(con, user_id: int, cadastro_id: int | None = None, triage_id: int | None = None):
    sql = "SELECT id FROM processing_cadastro_tasks WHERE user_id=? AND status IN ('EM_ANDAMENTO','PAUSADA')"
    params: list[Any] = [user_id]
    if cadastro_id:
        sql += " AND id<>?"
        params.append(cadastro_id)
    if con.execute(sql + " LIMIT 1", params).fetchone():
        raise HTTPException(409, "Você já tem um cronômetro de Cadastro ou Triagem aberto. Conclua-o antes de iniciar outro.")
    sql = "SELECT id FROM processing_triages WHERE user_id=? AND status IN ('EM_ANDAMENTO','PAUSADA')"
    params = [user_id]
    if triage_id:
        sql += " AND id<>?"
        params.append(triage_id)
    if con.execute(sql + " LIMIT 1", params).fetchone():
        raise HTTPException(409, "Você já tem um cronômetro de Triagem ou Cadastro aberto. Conclua-o antes de iniciar outro.")

def _history(con, card_id: int, event_type: str, description: str, user_id: int):
    from app import add_history
    add_history(con, card_id, event_type, description, user_id)

def init_processing_flow_db() -> None:
    con = db.connect()
    try:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS processing_cadastro_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, reference TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDENTE', user_id INTEGER, user_name TEXT,
          started_at TEXT, finished_at TEXT, worked_seconds INTEGER NOT NULL DEFAULT 0,
          paused_seconds INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
          UNIQUE(card_id,reference), FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS processing_cadastro_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, event TEXT NOT NULL,
          occurred_at TEXT NOT NULL, user_id INTEGER,
          FOREIGN KEY(task_id) REFERENCES processing_cadastro_tasks(id) ON DELETE CASCADE,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS processing_triages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'EM_ANDAMENTO', user_id INTEGER NOT NULL, user_name TEXT NOT NULL,
          started_at TEXT NOT NULL, finished_at TEXT, worked_seconds INTEGER NOT NULL DEFAULT 0,
          paused_seconds INTEGER NOT NULL DEFAULT 0, expected_total INTEGER NOT NULL DEFAULT 0,
          counted_total INTEGER, created_at TEXT NOT NULL,
          FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE, FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS processing_triage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, triage_id INTEGER NOT NULL, event TEXT NOT NULL,
          occurred_at TEXT NOT NULL, user_id INTEGER,
          FOREIGN KEY(triage_id) REFERENCES processing_triages(id) ON DELETE CASCADE,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS processing_triage_counts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, triage_id INTEGER NOT NULL, item_id INTEGER,
          reference TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '', size TEXT NOT NULL DEFAULT '',
          expected_qty INTEGER NOT NULL DEFAULT 0, counted_qty INTEGER NOT NULL DEFAULT 0,
          is_extra INTEGER NOT NULL DEFAULT 0, UNIQUE(triage_id,item_id),
          FOREIGN KEY(triage_id) REFERENCES processing_triages(id) ON DELETE CASCADE,
          FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS storage_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, downstream_operation_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDENTE', concluded_by_user_id INTEGER, concluded_by_name TEXT,
          concluded_at TEXT, has_divergence INTEGER NOT NULL DEFAULT 0, grade_changed INTEGER NOT NULL DEFAULT 0,
          notes TEXT, created_at TEXT NOT NULL, UNIQUE(card_id,downstream_operation_id),
          FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE,
          FOREIGN KEY(downstream_operation_id) REFERENCES downstream_operations(id) ON DELETE CASCADE,
          FOREIGN KEY(concluded_by_user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS storage_entry_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER NOT NULL, item_id INTEGER,
          reference TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '', size TEXT NOT NULL DEFAULT '',
          triage_qty INTEGER NOT NULL DEFAULT 0, stored_qty INTEGER NOT NULL DEFAULT 0,
          diff INTEGER NOT NULL DEFAULT 0, reason TEXT, is_extra INTEGER NOT NULL DEFAULT 0,
          UNIQUE(entry_id,item_id),
          FOREIGN KEY(entry_id) REFERENCES storage_entries(id) ON DELETE CASCADE,
          FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_processing_cadastro_status ON processing_cadastro_tasks(status,created_at);
        CREATE INDEX IF NOT EXISTS idx_processing_cadastro_events_task ON processing_cadastro_events(task_id,id);
        CREATE INDEX IF NOT EXISTS idx_processing_triages_card ON processing_triages(card_id,id);
        CREATE INDEX IF NOT EXISTS idx_processing_triage_events_task ON processing_triage_events(triage_id,id);
        CREATE INDEX IF NOT EXISTS idx_processing_triage_counts_task ON processing_triage_counts(triage_id);
        CREATE INDEX IF NOT EXISTS idx_storage_entries_status ON storage_entries(status,created_at);
        CREATE INDEX IF NOT EXISTS idx_storage_entry_items_entry ON storage_entry_items(entry_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_processing_triage_one_open_per_card
          ON processing_triages(card_id) WHERE status IN ('EM_ANDAMENTO','PAUSADA');
        """)
        con.execute("ALTER TABLE items ADD COLUMN IF NOT EXISTS real_qty INTEGER")
        con.commit()
    finally:
        con.close()

def _ensure_cadastro_pairs(con, pairs: list[tuple[int, str]]) -> int:
    """Insere tarefas/eventos por lotes, garantindo idempotência e evitando N+1."""
    normalized, seen = [], set()
    for card_id, reference in pairs:
        card_id, reference = int(card_id), str(reference or "").strip()
        key = (card_id, reference)
        if card_id > 0 and reference and key not in seen:
            seen.add(key)
            normalized.append(key)
    if not normalized:
        return 0
    stamp = _iso()
    values_sql = ",".join("(?,?,'PENDENTE',?)" for _ in normalized)
    insert_params = [v for card_id, ref in normalized for v in (card_id, ref, stamp)]
    inserted = con.execute(
        "INSERT OR IGNORE INTO processing_cadastro_tasks(card_id,reference,status,created_at) VALUES " + values_sql,
        insert_params,
    )
    pair_sql = ",".join("(?,?)" for _ in normalized)
    pair_params = [v for pair in normalized for v in pair]
    tasks = con.execute(
        "SELECT id,card_id,reference FROM processing_cadastro_tasks WHERE (card_id,reference) IN (" + pair_sql + ")",
        pair_params,
    ).fetchall()
    if len(tasks) < len(normalized):
        raise HTTPException(500, "Não foi possível garantir todas as tarefas de Cadastro.")
    task_ids = [int(row["id"]) for row in tasks]
    marks = ",".join("?" for _ in task_ids)
    existing_events = {int(row["task_id"]) for row in con.execute(
        "SELECT task_id FROM processing_cadastro_events WHERE event='CREATED' AND task_id IN (" + marks + ")",
        task_ids,
    ).fetchall()}
    missing_events = [task_id for task_id in task_ids if task_id not in existing_events]
    if missing_events:
        event_sql = ",".join("(?, 'CREATED', ?, NULL)" for _ in missing_events)
        event_params = [v for task_id in missing_events for v in (task_id, stamp)]
        con.execute(
            "INSERT INTO processing_cadastro_events(task_id,event,occurred_at,user_id) VALUES " + event_sql,
            event_params,
        )
    return max(0, int(inserted.rowcount or 0))


def ensure_cadastro_tasks(con, card_id: int, item_ids: list[int] | None = None) -> int:
    """Cria uma tarefa por referência, em lote, dentro da transação da ação de Qualidade."""
    sql = "SELECT id,COALESCE(NULLIF(TRIM(reference),''),TRIM(product)) AS ref FROM items WHERE card_id=?"
    params: list[Any] = [int(card_id)]
    if item_ids is not None:
        ids = sorted({int(value) for value in item_ids if int(value) > 0})
        if not ids:
            return 0
        sql += " AND id IN (" + ",".join("?" for _ in ids) + ")"
        params.extend(ids)
    refs = []
    for row in con.execute(sql + " ORDER BY id", params).fetchall():
        reference = str(row["ref"] or "").strip()
        if reference and reference not in refs:
            refs.append(reference)
    return _ensure_cadastro_pairs(con, [(int(card_id), reference) for reference in refs])


def backfill_cadastro_tasks() -> int:
    """Backfill idempotente dos Cards enviados à Costura, agrupado por lote."""
    con = db.connect()
    try:
        con.execute("BEGIN")
        cards = con.execute(
            "SELECT id FROM cards WHERE status IN ('AGUARDANDO_DESPACHO_COSTURA','EM_COSTURA_CD01') ORDER BY id"
        ).fetchall()
        card_ids = [int(row["id"]) for row in cards]
        if not card_ids:
            con.commit()
            return 0
        marks = ",".join("?" for _ in card_ids)
        item_rows = con.execute(
            "SELECT card_id,id,COALESCE(NULLIF(TRIM(reference),''),TRIM(product)) AS ref,source_stage "
            "FROM items WHERE card_id IN (" + marks + ") ORDER BY card_id,id",
            card_ids,
        ).fetchall()
        items_by_card: dict[int, list] = {card_id: [] for card_id in card_ids}
        for row in item_rows:
            items_by_card[int(row["card_id"])].append(row)
        pairs = []
        for card_id in card_ids:
            items = items_by_card[card_id]
            subset = [row for row in items if row["source_stage"] == "AGUARDANDO_COSTURA"]
            for row in (subset if subset else items):
                reference = str(row["ref"] or "").strip()
                pair = (card_id, reference)
                if reference and pair not in pairs:
                    pairs.append(pair)
        created = _ensure_cadastro_pairs(con, pairs)
        con.commit()
        return created
    finally:
        con.close()


@router.get("/cadastro/queue")
def cadastro_queue(user_id: int):
    con = db.connect()
    try:
        _operator(con, user_id)
        rows = con.execute("""
          SELECT t.*,c.purchase_id,c.supplier,c.current_sector AS card_current_sector,c.status AS card_status,
                 COALESCE(i.reference_qty,0) AS reference_qty
          FROM processing_cadastro_tasks t JOIN cards c ON c.id=t.card_id
          LEFT JOIN (
            SELECT card_id,COALESCE(NULLIF(TRIM(reference),''),TRIM(product)) AS ref_key,
                   SUM(COALESCE(real_qty,expected_qty,0)) AS reference_qty
            FROM items GROUP BY card_id,COALESCE(NULLIF(TRIM(reference),''),TRIM(product))
          ) i ON i.card_id=t.card_id AND i.ref_key=t.reference
          ORDER BY CASE t.status WHEN 'PENDENTE' THEN 0 WHEN 'EM_ANDAMENTO' THEN 1 WHEN 'PAUSADA' THEN 2 ELSE 3 END,t.created_at,t.id
        """).fetchall()
        if not rows:
            return []
        ids = [int(row["id"]) for row in rows]
        marks = ",".join("?" for _ in ids)
        events = {task_id: [] for task_id in ids}
        for ev in con.execute(f"SELECT task_id,event,occurred_at FROM processing_cadastro_events WHERE task_id IN ({marks}) ORDER BY id", ids).fetchall():
            events[int(ev["task_id"])].append(ev)
        stamp, result = _now(), []
        for row in rows:
            item = dict(row)
            item["card_sector_label"] = "Costura — aguardando despacho" if row["card_status"] == "AGUARDANDO_DESPACHO_COSTURA" else str(row["card_current_sector"] or "—")
            item.update(_summarize(events[int(row["id"])], stamp))
            result.append(item)
        return result
    finally:
        con.close()

@router.get("/cadastro/card/{card_id}")
def cadastro_card_status(card_id: int, user_id: int):
    con = db.connect()
    try:
        _user(con, user_id)
        if not con.execute("SELECT 1 FROM cards WHERE id=?", (card_id,)).fetchone():
            raise HTTPException(404, "Card não encontrado.")
        return [dict(row) for row in con.execute("SELECT id,reference,status,user_name,started_at,finished_at,worked_seconds,paused_seconds FROM processing_cadastro_tasks WHERE card_id=? ORDER BY reference,id", (card_id,)).fetchall()]
    finally:
        con.close()

_CADASTRO = {"pause": ("EM_ANDAMENTO", "PAUSE", "PAUSADA"), "resume": ("PAUSADA", "RESUME", "EM_ANDAMENTO"),
             "finish": (("EM_ANDAMENTO", "PAUSADA"), "FINISH", "CONCLUIDO")}

@router.post("/cadastro/{task_id}/{action}")
async def cadastro_action(task_id: int, action: str, request: Request):
    if action not in {"start", "pause", "resume", "finish"}:
        raise HTTPException(404, "Ação de Cadastro inválida.")
    body = await request.json()
    con = db.connect()
    try:
        con.execute("BEGIN")
        actor = _operator(con, body.get("user_id"))
        task = con.execute("SELECT * FROM processing_cadastro_tasks WHERE id=?", (task_id,)).fetchone()
        if not task:
            raise HTTPException(404, "Tarefa de Cadastro não encontrada.")
        if actor["role"] not in {"admin", "supervisor"} and task["user_id"] not in (None, int(actor["id"])):
            raise HTTPException(403, "Esta tarefa pertence a outra operadora.")
        stamp = _iso()
        if action == "start":
            if task["status"] != "PENDENTE":
                raise HTTPException(409, "Somente tarefas pendentes podem ser iniciadas.")
            _assert_no_other_timer(con, int(actor["id"]), cadastro_id=task_id)
            changed = con.execute("UPDATE processing_cadastro_tasks SET status='EM_ANDAMENTO',user_id=?,user_name=?,started_at=? WHERE id=? AND status='PENDENTE'",
                                  (int(actor["id"]), actor["name"], stamp, task_id))
            if changed.rowcount != 1:
                raise HTTPException(409, "Outra operadora iniciou esta tarefa primeiro.")
            event, next_status = "START", "EM_ANDAMENTO"
        else:
            if int(task["user_id"] or 0) != int(actor["id"]) and actor["role"] not in {"admin", "supervisor"}:
                raise HTTPException(403, "Somente quem iniciou esta tarefa pode controlar o cronômetro.")
            allowed, event, next_status = _CADASTRO[action]
            allowed = (allowed,) if isinstance(allowed, str) else allowed
            if task["status"] not in allowed:
                raise HTTPException(409, f"Ação incompatível com o estado atual: {task['status']}.")
            if action == "resume":
                _assert_no_other_timer(con, int(actor["id"]), cadastro_id=task_id)
        con.execute("INSERT INTO processing_cadastro_events(task_id,event,occurred_at,user_id) VALUES(?,?,?,?)", (task_id, event, stamp, int(actor["id"])))
        summary = _events_summary(con, "processing_cadastro_events", "task_id", task_id, datetime.fromisoformat(stamp))
        if action != "start":
            changed = con.execute("UPDATE processing_cadastro_tasks SET status=?,finished_at=?,worked_seconds=?,paused_seconds=? WHERE id=? AND status=?",
                                  (next_status, stamp if next_status == "CONCLUIDO" else None, summary["worked_seconds"], summary["paused_seconds"], task_id, task["status"]))
            if changed.rowcount != 1:
                raise HTTPException(409, "A tarefa foi alterada por outra pessoa. Atualize a fila.")
        con.commit()
        return {"ok": True, "id": task_id, "status": next_status, **summary}
    finally:
        con.close()

def _items_for_card(con, card_id: int):
    return [dict(row) for row in con.execute("""SELECT id AS item_id,COALESCE(NULLIF(TRIM(reference),''),TRIM(product),'') AS reference,
        COALESCE(color,'') AS color,COALESCE(size,'') AS size,COALESCE(expected_qty,0) AS expected_qty,real_qty
        FROM items WHERE card_id=? ORDER BY reference,color,size,id""", (card_id,)).fetchall()]

@router.get("/triage/queue")
def triage_queue(user_id: int):
    con = db.connect()
    try:
        _operator(con, user_id)
        cards = con.execute("""SELECT c.id,c.purchase_id,c.supplier,c.brand,c.status,c.current_sector,c.purchase_mode,
            COALESCE((SELECT NULLIF(TRIM(i.reference),'') FROM items i WHERE i.card_id=c.id ORDER BY i.id LIMIT 1),c.purchase_id) AS reference_list,
            COALESCE((SELECT SUM(i.expected_qty) FROM items i WHERE i.card_id=c.id),0) AS expected_total
            FROM cards c WHERE c.current_sector='PROCESSAMENTO' ORDER BY c.updated_at DESC,c.id DESC""").fetchall()
        if not cards:
            return []
        ids = [int(row["id"]) for row in cards]
        marks = ",".join("?" for _ in ids)
        triages = con.execute(f"SELECT * FROM processing_triages WHERE card_id IN ({marks}) ORDER BY id DESC", ids).fetchall()
        tids = [int(row["id"]) for row in triages]
        event_map = {tid: [] for tid in tids}
        if tids:
            tm = ",".join("?" for _ in tids)
            for ev in con.execute(f"SELECT triage_id,event,occurred_at FROM processing_triage_events WHERE triage_id IN ({tm}) ORDER BY id", tids).fetchall():
                event_map[int(ev["triage_id"])].append(ev)
        latest, stamp = {}, _now()
        for row in triages:
            cid = int(row["card_id"])
            if cid not in latest:
                data = dict(row)
                data.update(_summarize(event_map[int(row["id"])], stamp))
                latest[cid] = data
        items_by_card = {cid: [] for cid in ids}
        for item in con.execute(f"""SELECT id AS item_id,card_id,COALESCE(NULLIF(TRIM(reference),''),TRIM(product),'') AS reference,
            COALESCE(color,'') AS color,COALESCE(size,'') AS size,COALESCE(expected_qty,0) AS expected_qty,real_qty
            FROM items WHERE card_id IN ({marks}) ORDER BY card_id,reference,color,size,id""", ids).fetchall():
            items_by_card[int(item["card_id"])].append(dict(item))
        result = []
        for row in cards:
            card = dict(row)
            card["items"] = items_by_card[int(row["id"])]
            card["triage"] = latest.get(int(row["id"]))
            card["can_start_triage"] = not card["triage"] or card["triage"]["status"] not in {"EM_ANDAMENTO", "PAUSADA"}
            result.append(card)
        return result
    finally:
        con.close()

@router.post("/triage/cards/{card_id}/start")
async def triage_start(card_id: int, request: Request):
    body = await request.json()
    con = db.connect()
    try:
        con.execute("BEGIN")
        actor = _operator(con, body.get("user_id"))
        card = con.execute("SELECT * FROM cards WHERE id=?", (card_id,)).fetchone()
        if not card:
            raise HTTPException(404, "Card não encontrado.")
        if card["current_sector"] != "PROCESSAMENTO":
            raise HTTPException(409, "A Triagem só pode iniciar para Cards no setor Processamento.")
        previous = con.execute("SELECT * FROM processing_triages WHERE card_id=? ORDER BY id DESC LIMIT 1", (card_id,)).fetchone()
        if previous and previous["status"] in {"EM_ANDAMENTO", "PAUSADA"}:
            raise HTTPException(409, "Este Card já possui uma Triagem aberta.")
        if not con.execute("SELECT 1 FROM items WHERE card_id=? LIMIT 1", (card_id,)).fetchone():
            raise HTTPException(400, "Este Card não possui itens para contar.")
        _assert_no_other_timer(con, int(actor["id"]))
        stamp = _iso()
        total = int(con.execute("SELECT COALESCE(SUM(expected_qty),0) AS total FROM items WHERE card_id=?", (card_id,)).fetchone()["total"] or 0)
        cur = con.execute("""INSERT INTO processing_triages(card_id,status,user_id,user_name,started_at,expected_total,created_at)
                             VALUES(?,'EM_ANDAMENTO',?,?,?,?,?)""", (card_id, int(actor["id"]), actor["name"], stamp, total, stamp))
        tid = int(cur.lastrowid or 0)
        con.execute("INSERT INTO processing_triage_events(triage_id,event,occurred_at,user_id) VALUES(?,?,?,?)", (tid, "START", stamp, int(actor["id"])))
        con.commit()
        return {"ok": True, "id": tid, "status": "EM_ANDAMENTO"}
    finally:
        con.close()

@router.get("/triage/{triage_id}/details")
def triage_details(triage_id: int, user_id: int):
    con = db.connect()
    try:
        _operator(con, user_id)
        triage = con.execute("SELECT * FROM processing_triages WHERE id=?", (triage_id,)).fetchone()
        if not triage:
            raise HTTPException(404, "Triagem não encontrada.")
        data = dict(triage)
        data.update(_events_summary(con, "processing_triage_events", "triage_id", triage_id))
        data["items"] = _items_for_card(con, int(triage["card_id"]))
        data["counts"] = [dict(row) for row in con.execute("SELECT * FROM processing_triage_counts WHERE triage_id=? ORDER BY id", (triage_id,)).fetchall()]
        return data
    finally:
        con.close()

@router.post("/triage/{triage_id}/{action}")
async def triage_action(triage_id: int, action: str, request: Request):
    if action not in {"pause", "resume", "finish"}:
        raise HTTPException(404, "Ação de Triagem inválida.")
    body = await request.json()
    con = db.connect()
    try:
        con.execute("BEGIN")
        actor = _operator(con, body.get("user_id"))
        triage = con.execute("SELECT * FROM processing_triages WHERE id=?", (triage_id,)).fetchone()
        if not triage:
            raise HTTPException(404, "Triagem não encontrada.")
        if triage["status"] not in {"EM_ANDAMENTO", "PAUSADA"}:
            raise HTTPException(409, "Esta Triagem já foi concluída.")
        if int(triage["user_id"]) != int(actor["id"]) and actor["role"] not in {"admin", "supervisor"}:
            raise HTTPException(403, "Somente quem iniciou a Triagem pode controlar o cronômetro e concluir a contagem.")
        stamp = _iso()
        if action != "finish":
            allowed, event, next_status = ("EM_ANDAMENTO", "PAUSE", "PAUSADA") if action == "pause" else ("PAUSADA", "RESUME", "EM_ANDAMENTO")
            if triage["status"] != allowed:
                raise HTTPException(409, f"Ação incompatível com o estado atual: {triage['status']}.")
            if action == "resume":
                _assert_no_other_timer(con, int(actor["id"]), triage_id=triage_id)
            con.execute("INSERT INTO processing_triage_events(triage_id,event,occurred_at,user_id) VALUES(?,?,?,?)", (triage_id, event, stamp, int(actor["id"])))
            summary = _events_summary(con, "processing_triage_events", "triage_id", triage_id, datetime.fromisoformat(stamp))
            changed = con.execute("UPDATE processing_triages SET status=?,worked_seconds=?,paused_seconds=? WHERE id=? AND status=?",
                                  (next_status, summary["worked_seconds"], summary["paused_seconds"], triage_id, triage["status"]))
            if changed.rowcount != 1:
                raise HTTPException(409, "A Triagem foi alterada por outra pessoa. Atualize a fila.")
            con.commit()
            return {"ok": True, "id": triage_id, "status": next_status, **summary}
        raw = body.get("counts")
        if not isinstance(raw, list):
            raise HTTPException(400, "Envie a contagem de todas as linhas e das combinações extras.")
        original = _items_for_card(con, int(triage["card_id"]))
        expected = {int(item["item_id"]): item for item in original}
        seen: set[int] = set()
        counts = []
        extra_keys = set()
        for value in raw:
            if not isinstance(value, dict):
                raise HTTPException(400, "Formato de linha de contagem inválido.")
            counted = _qty(value.get("counted_qty"), "quantidade contada")
            iid_value = value.get("item_id")
            if iid_value not in (None, ""):
                try:
                    iid = int(iid_value)
                except (ValueError, TypeError):
                    raise HTTPException(400, "Item inválido na contagem.") from None
                item = expected.get(iid)
                if not item or iid in seen:
                    raise HTTPException(400, "A contagem contém um item estranho ou duplicado.")
                seen.add(iid)
                counts.append({"item_id": iid, "reference": str(item["reference"] or ""), "color": str(item["color"] or ""),
                               "size": str(item["size"] or ""), "expected_qty": int(item["expected_qty"] or 0), "counted_qty": counted, "is_extra": 0})
            else:
                if not bool(value.get("is_extra")):
                    raise HTTPException(400, "Linhas sem item precisam estar marcadas como combinação extra.")
                ref, color, size = (str(value.get(k) or "").strip() for k in ("reference", "color", "size"))
                if not ref or not color or not size:
                    raise HTTPException(400, "Preencha referência, cor e tamanho de cada combinação extra.")
                extra_key = (ref.casefold(), color.casefold(), size.casefold())
                if extra_key in extra_keys or any(
                    extra_key == (str(item["reference"] or "").strip().casefold(),
                                  str(item["color"] or "").strip().casefold(),
                                  str(item["size"] or "").strip().casefold())
                    for item in original
                ):
                    raise HTTPException(400, "A combinação extra está duplicada ou já existe na grade original.")
                extra_keys.add(extra_key)
                counts.append({"item_id": None, "reference": ref, "color": color, "size": size, "expected_qty": 0, "counted_qty": counted, "is_extra": 1})
        missing = set(expected) - seen
        if missing:
            raise HTTPException(400, f"Preencha todas as linhas da grade. Faltam {len(missing)} item(ns).")
        if not counts:
            raise HTTPException(400, "A contagem não pode ficar vazia.")
        con.execute("INSERT INTO processing_triage_events(triage_id,event,occurred_at,user_id) VALUES(?,?,?,?)", (triage_id, "FINISH", stamp, int(actor["id"])))
        summary = _events_summary(con, "processing_triage_events", "triage_id", triage_id, datetime.fromisoformat(stamp))
        count_values = ",".join("(?,?,?,?,?,?,?,?)" for _ in counts)
        count_params = [value for item in counts for value in (
            triage_id, item["item_id"], item["reference"], item["color"], item["size"],
            item["expected_qty"], item["counted_qty"], item["is_extra"]
        )]
        con.execute(
            "INSERT INTO processing_triage_counts(triage_id,item_id,reference,color,size,expected_qty,counted_qty,is_extra) VALUES " + count_values,
            count_params,
        )
        item_counts = [item for item in counts if item["item_id"] is not None]
        if item_counts:
            case_sql = " ".join("WHEN ? THEN ?" for _ in item_counts)
            id_marks = ",".join("?" for _ in item_counts)
            qty_params = [value for item in item_counts for value in (item["item_id"], item["counted_qty"])]
            qty_params.extend((int(triage["card_id"]), *[item["item_id"] for item in item_counts]))
            con.execute(
                "UPDATE items SET real_qty=CASE id " + case_sql +
                " ELSE real_qty END WHERE card_id=? AND id IN (" + id_marks + ")",
                qty_params,
            )
        expected_total = sum(item["expected_qty"] for item in counts)
        counted_total = sum(item["counted_qty"] for item in counts)
        diff_lines = sum(1 for item in counts if not item["is_extra"] and item["expected_qty"] != item["counted_qty"])
        extra_lines = sum(1 for item in counts if item["is_extra"])
        con.execute("""UPDATE processing_triages SET status='CONCLUIDA',finished_at=?,worked_seconds=?,paused_seconds=?,
                       expected_total=?,counted_total=? WHERE id=? AND status IN ('EM_ANDAMENTO','PAUSADA')""",
                    (stamp, summary["worked_seconds"], summary["paused_seconds"], expected_total, counted_total, triage_id))
        _history(con, int(triage["card_id"]), "TRIAGEM_CONCLUIDA",
                 f"{actor['name']} concluiu a Triagem: grade prevista {expected_total}, contagem {counted_total}, {diff_lines} combinação(ões) divergente(s), {extra_lines} combinação(ões) extra(s).", int(actor["id"]))
        con.commit()
        return {"ok": True, "id": triage_id, "status": "CONCLUIDA", "expected_total": expected_total, "counted_total": counted_total,
                "worked_seconds": summary["worked_seconds"], "paused_seconds": summary["paused_seconds"], "differences": diff_lines, "extras": extra_lines}
    finally:
        con.close()

def ensure_storage_entry(con, card_id: int, operation_id: int) -> int:
    """Cria a conferência e todas as linhas em lote, na transação da Estocagem."""
    op = con.execute("SELECT * FROM downstream_operations WHERE id=? AND card_id=?", (operation_id, card_id)).fetchone()
    if not op or op["sector"] != "ESTOCAGEM" or op["status"] != "CONCLUIDO":
        raise HTTPException(409, "A Entrada só pode ser criada após a conclusão da Estocagem.")
    row = con.execute("SELECT id FROM storage_entries WHERE card_id=? AND downstream_operation_id=?", (card_id, operation_id)).fetchone()
    if row:
        entry_id = int(row["id"])
    else:
        cur = con.execute(
            "INSERT OR IGNORE INTO storage_entries(card_id,downstream_operation_id,status,created_at) VALUES(?,?,'PENDENTE',?)",
            (card_id, operation_id, _iso()),
        )
        entry_id = int(cur.lastrowid or 0)
        if not entry_id:
            row = con.execute("SELECT id FROM storage_entries WHERE card_id=? AND downstream_operation_id=?", (card_id, operation_id)).fetchone()
            if not row:
                raise HTTPException(500, "Não foi possível criar a conferência de Entrada.")
            entry_id = int(row["id"])
    if int(con.execute("SELECT COUNT(*) n FROM storage_entry_items WHERE entry_id=?", (entry_id,)).fetchone()["n"] or 0):
        return entry_id
    params: list[Any] = [card_id]
    sql = """SELECT i.id,i.reference,i.product,i.color,i.size,COALESCE(i.real_qty,i.expected_qty,0) AS qty
             FROM items i WHERE i.card_id=?"""
    if op["source_subset"]:
        ids = [int(row["item_id"]) for row in con.execute(
            "SELECT item_id FROM downstream_operation_items WHERE operation_id=? ORDER BY item_id", (operation_id,)
        ).fetchall()]
        if not ids:
            raise HTTPException(409, "A Estocagem deste subconjunto não possui itens vinculados.")
        sql += " AND i.id IN (" + ",".join("?" for _ in ids) + ")"
        params.extend(ids)
    items = con.execute(sql + " ORDER BY i.reference,i.color,i.size,i.id", params).fetchall()
    if not items:
        raise HTTPException(409, "A Estocagem não possui itens para gerar a conferência de Entrada.")
    insert_rows = []
    for item in items:
        qty = int(item["qty"] or 0)
        insert_rows.append((
            entry_id, int(item["id"]), str(item["reference"] or item["product"] or ""),
            str(item["color"] or ""), str(item["size"] or ""), qty, qty, 0
        ))
    if not op["source_subset"]:
        triage = con.execute(
            "SELECT id FROM processing_triages WHERE card_id=? AND status='CONCLUIDA' ORDER BY id DESC LIMIT 1", (card_id,)
        ).fetchone()
        if triage:
            extras = con.execute(
                "SELECT reference,color,size,counted_qty FROM processing_triage_counts WHERE triage_id=? AND is_extra=1 ORDER BY id",
                (triage["id"],)
            ).fetchall()
            for extra in extras:
                qty = int(extra["counted_qty"] or 0)
                insert_rows.append((entry_id, None, str(extra["reference"] or ""), str(extra["color"] or ""),
                                    str(extra["size"] or ""), qty, qty, 1))
    values_sql = ",".join("(?,?,?,?,?,?,?,0,?)" for _ in insert_rows)
    values_params = [value for row in insert_rows for value in row]
    con.execute(
        "INSERT OR IGNORE INTO storage_entry_items(entry_id,item_id,reference,color,size,triage_qty,stored_qty,diff,is_extra) VALUES " + values_sql,
        values_params,
    )
    return entry_id


@router.get("/entry/queue")
def entry_queue(user_id: int):
    con = db.connect()
    try:
        _operator(con, user_id)
        rows = con.execute("""SELECT se.*,c.purchase_id,c.supplier,c.brand,
             COALESCE((SELECT NULLIF(TRIM(i.reference),'') FROM items i WHERE i.card_id=se.card_id ORDER BY i.id LIMIT 1),c.purchase_id) AS reference_list
             FROM storage_entries se JOIN cards c ON c.id=se.card_id
             ORDER BY CASE se.status WHEN 'PENDENTE' THEN 0 ELSE 1 END,se.created_at DESC,se.id DESC""").fetchall()
        if not rows:
            return {"pending": [], "recent": []}
        ids = [int(row["id"]) for row in rows]
        marks = ",".join("?" for _ in ids)
        by_entry = {entry_id: [] for entry_id in ids}
        for item in con.execute(f"SELECT * FROM storage_entry_items WHERE entry_id IN ({marks}) ORDER BY reference,color,size,id", ids).fetchall():
            by_entry[int(item["entry_id"])].append(dict(item))
        pending, recent = [], []
        for row in rows:
            entry = dict(row)
            entry["items"] = by_entry[int(row["id"])]
            (pending if row["status"] == "PENDENTE" else recent).append(entry)
        return {"pending": pending, "recent": recent[:30]}
    finally:
        con.close()

@router.post("/entry/{entry_id}/confirm")
async def entry_confirm(entry_id: int, request: Request):
    body = await request.json()
    con = db.connect()
    try:
        con.execute("BEGIN")
        actor = _operator(con, body.get("user_id"))
        entry = con.execute("SELECT * FROM storage_entries WHERE id=?", (entry_id,)).fetchone()
        if not entry:
            raise HTTPException(404, "Entrada não encontrada.")
        if entry["status"] != "PENDENTE":
            raise HTTPException(409, "Esta Entrada já foi confirmada.")
        current = con.execute("SELECT * FROM storage_entry_items WHERE entry_id=? ORDER BY id", (entry_id,)).fetchall()
        supplied = body.get("items")
        if not isinstance(supplied, list):
            raise HTTPException(400, "Informe as quantidades armazenadas de todos os itens.")
        by_id = {int(row["id"]): row for row in current}
        seen: set[int] = set()
        divergent = 0
        grade_changed = False
        updates = []
        updates = []
        for value in supplied:
            if not isinstance(value, dict):
                raise HTTPException(400, "Formato de linha de Entrada inválido.")
            try:
                item_id = int(value.get("id") or 0)
            except (TypeError, ValueError):
                raise HTTPException(400, "Item inválido na Entrada.") from None
            item = by_id.get(item_id)
            if not item or item_id in seen:
                raise HTTPException(400, "A Entrada contém um item estranho ou duplicado.")
            seen.add(item_id)
            stored = _qty(value.get("stored_qty"), "quantidade armazenada")
            reason = str(value.get("reason") or "").strip()
            diff = stored - int(item["triage_qty"] or 0)
            if diff and not reason:
                raise HTTPException(400, f"Justifique a divergência de {item['reference']} / {item['color']} / {item['size']}.")
            updates.append((item_id, stored, diff, reason or None))
            if diff:
                divergent += 1
                grade_changed = True
            if item["is_extra"]:
                grade_changed = True
        missing = set(by_id) - seen
        if missing:
            raise HTTPException(400, f"Informe a quantidade armazenada de todas as linhas. Faltam {len(missing)}.")
        if not current:
            raise HTTPException(409, "Esta Entrada não contém itens para conferir.")
        if updates:
            values_sql = ",".join("(?::bigint,?::integer,?::integer,?::text)" for _ in updates)
            update_params = [value for row in updates for value in row]
            update_params.append(entry_id)
            cur = con.execute(
                "UPDATE storage_entry_items AS target SET stored_qty=src.stored_qty,diff=src.diff,reason=src.reason "
                "FROM (VALUES " + values_sql + ") AS src(id,stored_qty,diff,reason) "
                "WHERE target.id=src.id AND target.entry_id=?",
                update_params,
            )
            if int(cur.rowcount or 0) != len(updates):
                raise HTTPException(409, "As linhas da Entrada mudaram durante a conferência. Atualize a tela.")
        stamp = _iso()
        changed = con.execute("""UPDATE storage_entries SET status='CONFIRMADA',concluded_by_user_id=?,concluded_by_name=?,
                 concluded_at=?,has_divergence=?,grade_changed=?,notes=? WHERE id=? AND status='PENDENTE'""",
              (int(actor["id"]), actor["name"], stamp, 1 if divergent else 0, 1 if grade_changed else 0, str(body.get("notes") or "").strip() or None, entry_id))
        if changed.rowcount != 1:
            raise HTTPException(409, "Esta Entrada foi confirmada por outra pessoa. Atualize a tela.")
        _history(con, int(entry["card_id"]), "ENTRADA_ESTOCAGEM_CONFIRMADA",
                 f"{actor['name']} confirmou a Entrada após a Estocagem: {divergent} linha(s) divergente(s)" + ("; grade alterada." if grade_changed else "; sem alteração de grade."), int(actor["id"]))
        con.commit()
        return {"ok": True, "id": entry_id, "status": "CONFIRMADA", "has_divergence": bool(divergent), "grade_changed": grade_changed, "divergent_lines": divergent}
    finally:
        con.close()

@router.get("/overview")
def processing_flow_overview(user_id: int):
    con = db.connect()
    try:
        _operator(con, user_id)
        row = con.execute("""SELECT
            (SELECT COUNT(*) FROM processing_cadastro_tasks WHERE status<>'CONCLUIDO') AS cadastro_pendentes,
            (SELECT COUNT(*) FROM processing_cadastro_tasks WHERE status='EM_ANDAMENTO') AS cadastro_em_andamento,
            (SELECT COUNT(*) FROM processing_triages WHERE status IN ('EM_ANDAMENTO','PAUSADA')) AS triagens_em_andamento,
            (SELECT COUNT(*) FROM processing_triages WHERE status='CONCLUIDA') AS triagens_concluidas,
            (SELECT COUNT(*) FROM storage_entries WHERE status='PENDENTE') AS entradas_pendentes,
            (SELECT COUNT(*) FROM storage_entries WHERE status='CONFIRMADA' AND has_divergence=1) AS entradas_divergentes,
            (SELECT COUNT(*) FROM cards WHERE current_sector='PROCESSAMENTO') AS cards_processamento,
            (SELECT COALESCE(AVG(worked_seconds),0) FROM processing_cadastro_tasks WHERE status='CONCLUIDO') AS cadastro_seconds,
            (SELECT COALESCE(AVG(worked_seconds),0) FROM processing_triages WHERE status='CONCLUIDA') AS triage_seconds""").fetchone()
        keys = ("cadastro_pendentes", "cadastro_em_andamento", "triagens_em_andamento", "triagens_concluidas", "entradas_pendentes", "entradas_divergentes", "cards_processamento")
        return {"counts": {key: int(row[key] or 0) for key in keys},
                "averages": {"cadastro_seconds": int(row["cadastro_seconds"] or 0), "triage_seconds": int(row["triage_seconds"] or 0)}}
    finally:
        con.close()

def register_processing_flow_routes(app) -> None:
    app.include_router(router)
