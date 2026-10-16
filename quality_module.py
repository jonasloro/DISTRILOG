from __future__ import annotations

import json
import math
import os
import db
import uuid
import mimetypes
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response

from positions_module import move_ten_percent_sample_into_balance, total_ten_percent_sample_in_balance, total_volume_only_allocated

BASE_DIR = Path(__file__).resolve().parent
router = APIRouter(prefix="/api", tags=["Qualidade"])

QUALITY_ROLES = {"qualidade", "supervisor", "admin"}
SUPERVISOR_ROLES = {"supervisor", "admin"}
QUALITY_HISTORY_EVENT_TYPES = (
    "RECEBIMENTO_RECUPERADO",
    "TIPO_COMPRA_MANUAL",
    "DESTINO_QUALIDADE_POR_REFERENCIA",
    "DESENVOLVIMENTO",
    "ATRIBUICAO_QUALIDADE_LOTE",
    "ATRIBUICAO_QUALIDADE",
    "ATRIBUICAO_DEVOLVIDA",
    "ATRIBUICAO_TRANSFERIDA",
    "RESULTADO_QUALIDADE",
    "RESULTADO_QUALIDADE_LOTE",
    "TEMPO_QUALIDADE",
    "QUALIDADE_CONFIGURADA",
    "INSPECAO_CONCLUIDA",
)


def db_connect(persist: bool = True) -> "db.Connection":
    """Conexão direta com o Supabase: a Qualidade grava e lê tudo lá, sem cópia local."""
    try:
        return db.connect()
    except RuntimeError as exc:
        raise HTTPException(
            503,
            "A Qualidade exige conexão com o Supabase. Configure SUPABASE_DATABASE_URL.",
        ) from exc


def iso_now() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def to_json(value: Any) -> str:
    return json.dumps(value or [], ensure_ascii=False)


def from_json(value: Optional[str], default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except Exception:
        return default


def get_user(con: "db.Connection", user_id: int) -> db.Row:
    row = con.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(401, "Usuário inválido.")
    return row


def require_role(con: "db.Connection", user_id: int, allowed: set[str]) -> db.Row:
    user = get_user(con, user_id)
    if user["role"] not in allowed:
        raise HTTPException(403, "Seu perfil não possui permissão para esta ação.")
    return user


def latest_receiving_sample(con: "db.Connection", card_id: int, receiving_type: str) -> Optional[db.Row]:
    """Find the latest receiving operation for this Card and receiving type."""
    return con.execute(
        "SELECT * FROM receivings WHERE card_id=? AND receiving_type=? ORDER BY id DESC LIMIT 1",
        (card_id, receiving_type),
    ).fetchone()


def require_completed_receiving_sample(con: "db.Connection", card_id: int, receiving_type: str) -> db.Row:
    """Read the 10% gate from Supabase, then refresh the local working copy for the inspection FK."""
    local_latest = latest_receiving_sample(con, card_id, receiving_type)
    remote_latest = local_latest

    if remote_latest:
        if remote_latest["physical_status"] != "CONCLUIDO":
            con.close()
            raise HTTPException(400, "Conclua e salve o recebimento físico no Supabase antes de iniciar a Inspeção da Qualidade.")
        if not remote_latest["ten_percent_required"]:
            con.close()
            raise HTTPException(400, "O registro de Recebimento no Supabase não está configurado para exigir a separação dos 10%.")
        if remote_latest["ten_percent_status"] != "CONCLUIDA":
            con.close()
            raise HTTPException(400, "Conclua e salve a tiragem dos 10% no Recebimento antes de iniciar a Inspeção da Qualidade.")
        actual_sample = int(remote_latest["ten_percent_actual"] or 0)
        minimum_sample = int(remote_latest["ten_percent_min"] or 0)
        if actual_sample <= 0:
            con.close()
            raise HTTPException(400, "A quantidade efetivamente separada nos 10% não está salva no Supabase como um valor positivo.")
        if actual_sample < minimum_sample:
            con.close()
            raise HTTPException(400, "A quantidade de 10% salva no Supabase está abaixo do mínimo exigido. Revise o Recebimento antes de iniciar a Inspeção.")
        if not local_latest:
            con.close()
            raise HTTPException(503, "O Recebimento existe no Supabase, mas não pôde ser vinculado ao Card local. Tente novamente; a inspeção continua bloqueada até a restauração do vínculo.")
        return local_latest

    existing_types = [
        str(row["receiving_type"])
        for row in con.execute(
            "SELECT DISTINCT receiving_type FROM receivings WHERE card_id=? ORDER BY receiving_type",
            (card_id,),
        ).fetchall()
    ]
    has_any_receiving = con.execute(
        "SELECT 1 FROM receivings WHERE card_id=? LIMIT 1", (card_id,)
    ).fetchone()
    card = con.execute(
        "SELECT current_sector,status,purchase_mode FROM cards WHERE id=?", (card_id,)
    ).fetchone()

    # Both stores have no operation for this Card. Reopen only this known post-receiving
    # state with a pending record; never invent volumes or mark the 10% as completed.
    expected_status = "RETORNO_CONCLUIDO" if receiving_type == "RETORNO" else "AGUARDANDO_QUALIDADE"
    can_reopen = (
        not existing_types
        and not has_any_receiving
        and card is not None
        and card["current_sector"] == "QUALIDADE"
        and card["status"] == expected_status
    )
    if can_reopen:
        quantities = con.execute(
            """SELECT COALESCE(SUM(expected_qty),0) total, COUNT(*) n
               FROM items WHERE card_id=? AND expected_qty>0""",
            (card_id,),
        ).fetchone()
        total = int(quantities["total"] or 0)
        item_count = int(quantities["n"] or 0)
        if total > 0:
            minimum = max(
                math.ceil(total * 0.10),
                item_count if str(card["purchase_mode"] or "").upper() == "GRADE" else 0,
            )
            now = iso_now()
            con.execute(
                """INSERT INTO receivings(
                    card_id,receiving_type,physical_status,ten_percent_required,
                    ten_percent_min,ten_percent_status,created_at
                ) VALUES(?,?,'PENDENTE',1,?,'NAO_INICIADA',?)""",
                (card_id, receiving_type, minimum, now),
            )
            next_status = "AGUARDANDO_RECEBIMENTO_RETORNO" if receiving_type == "RETORNO" else "AGUARDANDO_RECEBIMENTO"
            con.execute(
                """UPDATE cards SET current_sector='RECEBIMENTO',status=?,
                   receiving_type=?,updated_at=? WHERE id=?""",
                (next_status, receiving_type, now, card_id),
            )
            add_history(
                con, card_id, "RECEBIMENTO_RECUPERADO",
                "O registro original do Recebimento não existia no Supabase. O controle foi reaberto como pendente; volumes e separação dos 10% precisam ser registrados novamente.",
            )
            con.commit()
            con.close()
            raise HTTPException(
                409,
                "O registro original do Recebimento não existia no Supabase. O Card foi devolvido ao Recebimento com um controle pendente; informe novamente os volumes e registre a separação dos 10% antes de retomar a Qualidade.",
            )

    details = (
        " Foram encontrados registros de outro tipo: {}.".format(", ".join(existing_types))
        if existing_types
        else " Não existe registro correspondente no Supabase nem uma operação local que possa ser recuperada.",
    )
    con.close()
    raise HTTPException(
        409,
        "Não existe registro de Recebimento do tipo {} no Supabase para este Card.{} A inspeção permanece bloqueada para não inventar a quantidade dos 10%; verifique o histórico do Card ou solicite a recuperação ao Supervisor.".format(receiving_type, details),
    )


def ensure_quality_sector_owner(con: "db.Connection", inspection: db.Row, actor_role: str) -> None:
    """Allow mutations only while the Card or the selected Quality items belong to Quality."""
    card = con.execute(
        "SELECT id,current_sector,source_snapshot_at FROM cards WHERE id=?",
        (inspection["card_id"],),
    ).fetchone()
    if not card:
        con.close()
        raise HTTPException(404, "Card não encontrado.")
    if actor_role not in QUALITY_ROLES:
        con.close()
        raise HTTPException(403, "Este perfil não pode executar ações na Qualidade.")
    if card["current_sector"] == "QUALIDADE":
        return
    if inspection["source_subset"] and card["source_snapshot_at"]:
        quality_items = con.execute(
            """SELECT COUNT(*) n FROM quality_inspection_items qii
               JOIN items i ON i.id=qii.item_id
               WHERE qii.inspection_id=? AND i.card_id=?
                 AND i.source_stage IN ('QUALIDADE','QUALIDADE_RETRABALHO','QUALIDADE_REJEITADO')""",
            (inspection["id"], card["id"]),
        ).fetchone()
        if int(quality_items["n"] or 0) > 0:
            return
    con.close()
    raise HTTPException(403, "Este Card está sob responsabilidade de outro setor. A Qualidade pode consultar as informações, mas não executar ações enquanto o Card não estiver sob sua responsabilidade.")


def add_history(
    con: "db.Connection",
    card_id: int,
    event_type: str,
    description: str,
    user_id: Optional[int] = None,
) -> None:
    created_at = iso_now()
    cursor = con.execute(
        "INSERT INTO history(card_id,user_id,event_type,description,created_at) VALUES(?,?,?,?,?)",
        (card_id, user_id, event_type, description, created_at),
    )
    con.execute(
        """INSERT INTO quality_audit_events(
               id,card_id,user_id,event_type,description,created_at
           ) VALUES(?,?,?,?,?,?)""",
        (cursor.lastrowid, card_id, user_id, event_type, description, created_at),
    )


def business_seconds_between(start: datetime, end: datetime) -> int:
    if end <= start:
        return 0
    total = 0
    current_day = start.date()
    while current_day <= end.date():
        weekday = current_day.weekday()
        if weekday <= 3:
            work_start = datetime.combine(current_day, time(8, 0))
            work_end = datetime.combine(current_day, time(18, 0))
        elif weekday == 4:
            work_start = datetime.combine(current_day, time(8, 0))
            work_end = datetime.combine(current_day, time(17, 0))
        else:
            current_day += timedelta(days=1)
            continue
        interval_start = max(start, work_start)
        interval_end = min(end, work_end)
        if interval_end > interval_start:
            total += int((interval_end - interval_start).total_seconds())
        current_day += timedelta(days=1)
    return total


def init_quality_db() -> None:
    con = db_connect()
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS quality_inspections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id INTEGER NOT NULL,
            inspection_type INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'ABERTA',
            destination TEXT,
            sample_source TEXT NOT NULL,
            source_receiving_id INTEGER REFERENCES receivings(id) ON DELETE SET NULL,
            purchase_mode TEXT NOT NULL DEFAULT 'GRADE',
            sample_target_total INTEGER NOT NULL DEFAULT 0,
            development_required INTEGER,
            development_separated INTEGER,
            development_pending INTEGER NOT NULL DEFAULT 0,
            source_subset INTEGER NOT NULL DEFAULT 0,
            send_to_costura INTEGER,
            created_by INTEGER NOT NULL,
            completed_by INTEGER,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE,
            FOREIGN KEY(created_by) REFERENCES users(id),
            FOREIGN KEY(completed_by) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS quality_sample_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inspection_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,
            sample_qty INTEGER NOT NULL DEFAULT 0,
            sample_scope TEXT NOT NULL DEFAULT 'ITEM',
            UNIQUE(inspection_id,item_id),
            FOREIGN KEY(inspection_id) REFERENCES quality_inspections(id) ON DELETE CASCADE,
            FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS quality_inspection_items (
            inspection_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,
            PRIMARY KEY(inspection_id,item_id),
            FOREIGN KEY(inspection_id) REFERENCES quality_inspections(id) ON DELETE CASCADE,
            FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS quality_item_routes (
            inspection_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,
            destination TEXT,
            PRIMARY KEY(inspection_id,item_id),
            FOREIGN KEY(inspection_id) REFERENCES quality_inspections(id) ON DELETE CASCADE,
            FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS quality_workers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inspection_id INTEGER NOT NULL,
            inspector_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'NAO_INICIADA',
            created_at TEXT NOT NULL,
            completed_at TEXT,
            UNIQUE(inspection_id,inspector_id),
            FOREIGN KEY(inspection_id) REFERENCES quality_inspections(id) ON DELETE CASCADE,
            FOREIGN KEY(inspector_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS quality_worker_timer_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            worker_id INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            event_at TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            FOREIGN KEY(worker_id) REFERENCES quality_workers(id) ON DELETE CASCADE,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS quality_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            worker_id INTEGER NOT NULL,
            sample_item_id INTEGER NOT NULL,
            assigned_qty INTEGER NOT NULL,
            inspected_qty INTEGER NOT NULL DEFAULT 0,
            approved_qty INTEGER NOT NULL DEFAULT 0,
            rejected_qty INTEGER NOT NULL DEFAULT 0,
            rework_qty INTEGER NOT NULL DEFAULT 0,
            reject_reason TEXT,
            rework_reason TEXT,
            observation TEXT,
            photo_paths TEXT,
            result_status TEXT NOT NULL DEFAULT 'PENDENTE',
            assigned_by INTEGER NOT NULL,
            assigned_at TEXT NOT NULL,
            FOREIGN KEY(worker_id) REFERENCES quality_workers(id) ON DELETE CASCADE,
            FOREIGN KEY(sample_item_id) REFERENCES quality_sample_items(id) ON DELETE CASCADE,
            FOREIGN KEY(assigned_by) REFERENCES users(id)
        );
        """
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS quality_audit_events (
            id INTEGER PRIMARY KEY,
            card_id INTEGER NOT NULL,
            user_id INTEGER,
            event_type TEXT NOT NULL,
            description TEXT NOT NULL,
            created_at TEXT NOT NULL
        )"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS quality_files (
            id TEXT PRIMARY KEY,
            original_name TEXT NOT NULL,
            content_type TEXT NOT NULL,
            content BYTEA NOT NULL,
            uploaded_by BIGINT NOT NULL,
            created_at TEXT NOT NULL
        )"""
    )
    inspection_columns = {row["name"] for row in con.execute("PRAGMA table_info(quality_inspections)").fetchall()}
    if "purchase_mode" not in inspection_columns:
        con.execute("ALTER TABLE quality_inspections ADD COLUMN purchase_mode TEXT NOT NULL DEFAULT 'GRADE'")
    if "source_subset" not in inspection_columns:
        con.execute("ALTER TABLE quality_inspections ADD COLUMN source_subset INTEGER NOT NULL DEFAULT 0")
    if "source_receiving_id" not in inspection_columns:
        con.execute("ALTER TABLE quality_inspections ADD COLUMN source_receiving_id INTEGER REFERENCES receivings(id) ON DELETE SET NULL")
    if "send_to_costura" not in inspection_columns:
        con.execute("ALTER TABLE quality_inspections ADD COLUMN send_to_costura INTEGER")
    sample_columns = {row["name"] for row in con.execute("PRAGMA table_info(quality_sample_items)").fetchall()}
    if "sample_scope" not in sample_columns:
        con.execute("ALTER TABLE quality_sample_items ADD COLUMN sample_scope TEXT NOT NULL DEFAULT 'ITEM'")

    # Migra eventos antigos da Qualidade para a tabela de auditoria dedicada.
    event_marks = ",".join(["?"] * len(QUALITY_HISTORY_EVENT_TYPES))
    legacy_events = con.execute(
        "SELECT id,card_id,user_id,event_type,description,created_at FROM history WHERE event_type IN ({})".format(event_marks),
        QUALITY_HISTORY_EVENT_TYPES,
    ).fetchall()
    for event in legacy_events:
        con.execute(
            """INSERT OR IGNORE INTO quality_audit_events(
                   id,card_id,user_id,event_type,description,created_at
               ) VALUES(?,?,?,?,?,?)""",
            tuple(event[column] for column in ("id","card_id","user_id","event_type","description","created_at")),
        )
    con.commit()
    con.close()

def store_quality_files(files: list[dict]) -> list[str]:
    """Grava todas as evidências (fotos) da Qualidade de uma vez, direto no Supabase."""
    if not files:
        return []
    con = db_connect()
    try:
        for uploaded in files:
            con.execute(
                """INSERT OR IGNORE INTO quality_files(
                       id,original_name,content_type,content,uploaded_by,created_at
                   ) VALUES(?,?,?,?,?,?)""",
                (
                    uploaded["id"], uploaded["original_name"], uploaded["content_type"],
                    uploaded["content"], int(uploaded["uploaded_by"]), uploaded["created_at"],
                ),
            )
        con.commit()
    finally:
        con.close()
    return ["/api/quality/files/{}".format(uploaded["id"]) for uploaded in files]


def get_quality_file(file_id: str) -> dict | None:
    con = db_connect()
    try:
        row = con.execute(
            "SELECT original_name,content_type,content FROM quality_files WHERE id=?", (file_id,)
        ).fetchone()
    finally:
        con.close()
    return dict(row) if row else None


def normalize_purchase_mode(value: Any) -> str:
    mode = str(value or "").strip().upper()
    if mode not in {"GRADE", "SALDO"}:
        raise HTTPException(400, "Selecione o tipo da compra: Grade ou Saldo.")
    return mode


def distribute_grade_sample(items: list[db.Row], requested_total: int) -> tuple[int, list[tuple[int, int]]]:
    valid = [item for item in items if int(item["expected_qty"] or 0) > 0]
    if not valid:
        raise HTTPException(400, "Não existem itens com quantidade válida para compor a amostra da Grade.")
    total_capacity = sum(int(item["expected_qty"] or 0) for item in valid)
    target = max(int(requested_total or 0), len(valid))
    if target > total_capacity:
        raise HTTPException(400, f"A amostra calculada ({target}) ultrapassa a quantidade total disponível ({total_capacity}).")

    allocations = {int(item["id"]): 1 for item in valid}
    capacities = {int(item["id"]): int(item["expected_qty"] or 0) - 1 for item in valid}
    remaining = target - len(valid)
    active = [int(item["id"]) for item in valid if capacities[int(item["id"])] > 0]
    while remaining > 0 and active:
        share = max(1, remaining // len(active))
        next_active: list[int] = []
        for item_id in active:
            if remaining <= 0:
                break
            add = min(share, capacities[item_id], remaining)
            allocations[item_id] += add
            capacities[item_id] -= add
            remaining -= add
            if capacities[item_id] > 0:
                next_active.append(item_id)
        active = next_active
    if remaining > 0:
        raise HTTPException(400, "Não foi possível distribuir toda a amostra entre os itens da Grade.")
    return target, [(int(item["id"]), allocations[int(item["id"])]) for item in valid]


def create_automatic_sample(
    con: "db.Connection", inspection_id: int, card_id: int, purchase_mode: str, requested_total: int,
    item_ids: Optional[list[int]] = None,
) -> int:
    if item_ids:
        marks = ",".join("?" for _ in item_ids)
        items = con.execute(
            f"SELECT id,expected_qty FROM items WHERE card_id=? AND id IN ({marks}) ORDER BY id",
            (card_id, *item_ids),
        ).fetchall()
    else:
        items = con.execute("SELECT id,expected_qty FROM items WHERE card_id=? ORDER BY id", (card_id,)).fetchall()
    if not items:
        raise HTTPException(400, "O Card não possui itens para compor a amostra.")
    if purchase_mode == "SALDO":
        target = int(requested_total or 0)
        if target <= 0:
            raise HTTPException(400, "A quantidade geral da amostra deve ser maior que zero.")
        con.execute(
            "INSERT INTO quality_sample_items(inspection_id,item_id,sample_qty,sample_scope) VALUES(?,?,?,'GERAL')",
            (inspection_id, items[0]["id"], target),
        )
        return target

    target, allocations = distribute_grade_sample(items, int(requested_total or 0))
    for item_id, qty in allocations:
        con.execute(
            "INSERT INTO quality_sample_items(inspection_id,item_id,sample_qty,sample_scope) VALUES(?,?,?,'ITEM')",
            (inspection_id, item_id, qty),
        )
    return target


def worker_timer_events(con: "db.Connection", worker_id: int) -> list[db.Row]:
    return con.execute(
        "SELECT * FROM quality_worker_timer_events WHERE worker_id=? ORDER BY id",
        (worker_id,),
    ).fetchall()


def worker_timer_summary(con: "db.Connection", worker_id: int) -> dict[str, Any]:
    events = worker_timer_events(con, worker_id)
    state = "NAO_INICIADA"
    first_start: Optional[datetime] = None
    open_start: Optional[datetime] = None
    pause_start: Optional[datetime] = None
    final_end: Optional[datetime] = None
    active_business = 0
    paused_real = 0
    for event in events:
        dt = datetime.fromisoformat(event["event_at"])
        kind = event["event_type"]
        if kind == "START":
            state = "EM_ANDAMENTO"
            first_start = first_start or dt
            open_start = dt
        elif kind == "PAUSE" and open_start:
            active_business += business_seconds_between(open_start, dt)
            open_start = None
            pause_start = dt
            state = "PAUSADA"
        elif kind == "RESUME":
            if pause_start:
                paused_real += int((dt - pause_start).total_seconds())
            pause_start = None
            open_start = dt
            state = "EM_ANDAMENTO"
        elif kind == "FINISH":
            if open_start:
                active_business += business_seconds_between(open_start, dt)
                open_start = None
            if pause_start:
                paused_real += int((dt - pause_start).total_seconds())
                pause_start = None
            final_end = dt
            state = "CONCLUIDA"
    now_dt = datetime.now().replace(microsecond=0)
    if state == "EM_ANDAMENTO" and open_start:
        active_business += business_seconds_between(open_start, now_dt)
    if state == "PAUSADA" and pause_start:
        paused_real += int((now_dt - pause_start).total_seconds())
    permanence = int(((final_end or now_dt) - first_start).total_seconds()) if first_start else 0
    return {
        "state": state,
        "business_seconds": max(active_business, 0),
        "paused_seconds": max(paused_real, 0),
        "permanence_seconds": max(permanence, 0),
        "started_at": first_start.isoformat() if first_start else None,
        "finished_at": final_end.isoformat() if final_end else None,
        "events": [dict(e) for e in events],
    }


def assignment_is_valid(row: db.Row | dict[str, Any]) -> tuple[bool, list[str]]:
    data = dict(row)
    errors: list[str] = []
    assigned = int(data.get("assigned_qty") or 0)
    inspected = int(data.get("inspected_qty") or 0)
    rejected = int(data.get("rejected_qty") or 0)
    rework = int(data.get("rework_qty") or 0)
    observation = str(data.get("observation") or "").strip()
    photos = from_json(data.get("photo_paths"), [])
    if inspected != assigned:
        errors.append(f"a quantidade inspecionada deve ser {assigned}")
    if rejected < 0 or rework < 0 or inspected < 0:
        errors.append("as quantidades não podem ser negativas")
    if rejected + rework > inspected:
        errors.append("rejeição e retrabalho ultrapassam a quantidade inspecionada")
    if rejected > 0:
        if not str(data.get("reject_reason") or "").strip():
            errors.append("informe o motivo da rejeição")
        if not observation:
            errors.append("informe uma observação para a rejeição")
        if not photos:
            errors.append("adicione pelo menos uma foto para a rejeição")
    if rework > 0:
        if not str(data.get("rework_reason") or "").strip():
            errors.append("informe o motivo do retrabalho")
        if not observation:
            errors.append("informe uma observação para o retrabalho")
        if not photos:
            errors.append("adicione pelo menos uma foto para o retrabalho")
    return not errors, errors


def get_or_create_worker(
    con: "db.Connection",
    inspection_id: int,
    inspector_id: int,
) -> db.Row:
    worker = con.execute(
        "SELECT * FROM quality_workers WHERE inspection_id=? AND inspector_id=?",
        (inspection_id, inspector_id),
    ).fetchone()
    if worker:
        return worker
    cur = con.execute(
        "INSERT INTO quality_workers(inspection_id,inspector_id,status,created_at) VALUES(?,?,?,?)",
        (inspection_id, inspector_id, "NAO_INICIADA", iso_now()),
    )
    return con.execute("SELECT * FROM quality_workers WHERE id=?", (cur.lastrowid,)).fetchone()


def sample_item_rows(con: "db.Connection", inspection_id: int) -> list[dict[str, Any]]:
    rows = con.execute(
        """
        SELECT qs.*,i.product,i.reference,i.sku,i.color,i.size,i.lot,i.expected_qty,
               COALESCE((SELECT SUM(a.assigned_qty) FROM quality_assignments a WHERE a.sample_item_id=qs.id),0) assigned_total,
               COALESCE((SELECT SUM(a.inspected_qty) FROM quality_assignments a WHERE a.sample_item_id=qs.id),0) inspected_total,
               COALESCE((SELECT SUM(a.approved_qty) FROM quality_assignments a WHERE a.sample_item_id=qs.id),0) approved_total,
               COALESCE((SELECT SUM(a.rejected_qty) FROM quality_assignments a WHERE a.sample_item_id=qs.id),0) rejected_total,
               COALESCE((SELECT SUM(a.rework_qty) FROM quality_assignments a WHERE a.sample_item_id=qs.id),0) rework_total
        FROM quality_sample_items qs JOIN items i ON i.id=qs.item_id
        WHERE qs.inspection_id=? ORDER BY i.product,i.color,i.size,i.id
        """,
        (inspection_id,),
    ).fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        data = dict(row)
        data["available_qty"] = max(0, int(data["sample_qty"]) - int(data["assigned_total"]))
        if data.get("sample_scope") == "GERAL":
            data["product"] = "Quantidade geral — Saldo"
            data["reference"] = None
            data["sku"] = None
            data["color"] = None
            data["size"] = None
            data["lot"] = None
        result.append(data)
    return result


def inspection_validation(con: "db.Connection", inspection_id: int) -> list[str]:
    inspection = con.execute("SELECT * FROM quality_inspections WHERE id=?", (inspection_id,)).fetchone()
    if not inspection:
        return ["Inspeção não encontrada."]
    errors: list[str] = []
    if inspection["inspection_type"] == 1 and inspection["destination"] not in ("CD01", "CD02"):
        errors.append("Defina o destino CD01 ou CD02.")
    if inspection["source_subset"] and inspection["inspection_type"] == 1:
        mapped = [int(row["item_id"]) for row in con.execute(
            "SELECT item_id FROM quality_inspection_items WHERE inspection_id=?", (inspection_id,)
        ).fetchall()]
        routes = {
            int(row["item_id"]): str(row["destination"] or "").upper()
            for row in con.execute(
                "SELECT item_id,destination FROM quality_item_routes WHERE inspection_id=?", (inspection_id,)
            ).fetchall()
        }
        missing = [item_id for item_id in mapped if routes.get(item_id) not in {"COSTURA","PROCESSAMENTO"}]
        if missing:
            errors.append(f"Defina o destino de {len(missing)} referência(s) antes de concluir.")
    sample_rows = sample_item_rows(con, inspection_id)
    sample_total = sum(int(row["sample_qty"]) for row in sample_rows)
    if sample_total != int(inspection["sample_target_total"]):
        errors.append(
            f"A composição da amostra soma {sample_total}, mas deve somar {inspection['sample_target_total']}."
        )
    if not sample_rows:
        errors.append("A amostra não possui itens.")
    for row in sample_rows:
        item_label = (
            "Quantidade geral — Saldo"
            if row.get("sample_scope") == "GERAL"
            else " / ".join(
                str(value) for value in [row.get("product"), row.get("color"), row.get("size")] if value
            )
        )
        if int(row["assigned_total"]) != int(row["sample_qty"]):
            errors.append(
                f"O item {item_label or row['item_id']} possui {row['sample_qty']} peças na amostra e {row['assigned_total']} atribuídas."
            )
        if int(row["inspected_total"]) != int(row["sample_qty"]):
            errors.append(
                f"O item {item_label or row['item_id']} possui {row['sample_qty']} peças na amostra e {row['inspected_total']} inspecionadas."
            )
    assignments = con.execute(
        """
        SELECT a.*,u.name inspector_name,qw.status worker_status
        FROM quality_assignments a JOIN quality_workers qw ON qw.id=a.worker_id
        JOIN users u ON u.id=qw.inspector_id WHERE qw.inspection_id=?
        """,
        (inspection_id,),
    ).fetchall()
    if not assignments:
        errors.append("Nenhuma quantidade foi atribuída a inspetores.")
    for assignment in assignments:
        valid, assignment_errors = assignment_is_valid(assignment)
        if not valid:
            errors.append(
                f"Lançamento de {assignment['inspector_name']}: " + "; ".join(assignment_errors) + "."
            )
    workers = con.execute(
        """SELECT qw.* FROM quality_workers qw
           WHERE qw.inspection_id=? AND EXISTS(SELECT 1 FROM quality_assignments a WHERE a.worker_id=qw.id)""",
        (inspection_id,),
    ).fetchall()
    for worker in workers:
        if worker["status"] != "CONCLUIDA":
            user = con.execute("SELECT name FROM users WHERE id=?", (worker["inspector_id"],)).fetchone()
            errors.append(f"{user['name'] if user else 'Inspetor'} ainda não finalizou sua inspeção.")
    return errors


def refresh_quality_card_status(con: "db.Connection", inspection_id: int) -> str:
    inspection = con.execute("SELECT * FROM quality_inspections WHERE id=?", (inspection_id,)).fetchone()
    if not inspection or inspection["status"] == "CONCLUIDA":
        return "INSPECAO_CONCLUIDA"
    workers = con.execute(
        """SELECT qw.* FROM quality_workers qw
           WHERE qw.inspection_id=? AND EXISTS(SELECT 1 FROM quality_assignments a WHERE a.worker_id=qw.id)""",
        (inspection_id,),
    ).fetchall()
    states = [worker["status"] for worker in workers]
    validation_errors = inspection_validation(con, inspection_id)
    if workers and all(state == "CONCLUIDA" for state in states) and not validation_errors:
        card_status = "AGUARDANDO_CONCLUSAO_QUALIDADE"
    elif any(state == "EM_ANDAMENTO" for state in states):
        card_status = "EM_INSPECAO"
    elif states and all(state in ("PAUSADA", "CONCLUIDA") for state in states) and any(state == "PAUSADA" for state in states):
        card_status = "INSPECAO_PAUSADA"
    else:
        card_status = "AGUARDANDO_INSPECAO"
    con.execute(
        "UPDATE cards SET status=?,updated_at=? WHERE id=? AND current_sector='QUALIDADE'",
        (card_status, iso_now(), inspection["card_id"]),
    )
    return card_status


def quality_card_data(con: "db.Connection", card_id: int) -> Optional[dict[str, Any]]:
    inspection = con.execute(
        """SELECT qi.*,uc.name created_by_name,uf.name completed_by_name
           FROM quality_inspections qi
           LEFT JOIN users uc ON uc.id=qi.created_by
           LEFT JOIN users uf ON uf.id=qi.completed_by
           WHERE qi.card_id=? ORDER BY qi.id DESC LIMIT 1""",
        (card_id,),
    ).fetchone()
    if not inspection:
        return None
    data = dict(inspection)
    samples = sample_item_rows(con, inspection["id"])
    workers_raw = con.execute(
        """SELECT qw.*,u.name inspector_name,u.username inspector_username
           FROM quality_workers qw JOIN users u ON u.id=qw.inspector_id
           WHERE qw.inspection_id=? ORDER BY u.name""",
        (inspection["id"],),
    ).fetchall()
    workers: list[dict[str, Any]] = []
    for worker_row in workers_raw:
        worker = dict(worker_row)
        worker["timer"] = worker_timer_summary(con, worker["id"])
        assignments_raw = con.execute(
            """
            SELECT a.*,qs.item_id,qs.sample_qty,qs.sample_scope,i.product,i.reference,i.sku,i.color,i.size,i.lot
            FROM quality_assignments a
            JOIN quality_sample_items qs ON qs.id=a.sample_item_id
            JOIN items i ON i.id=qs.item_id
            WHERE a.worker_id=? ORDER BY i.product,i.color,i.size,a.id
            """,
            (worker["id"],),
        ).fetchall()
        assignments: list[dict[str, Any]] = []
        for assignment_row in assignments_raw:
            assignment = dict(assignment_row)
            if assignment.get("sample_scope") == "GERAL":
                assignment["product"] = "Quantidade geral — Saldo"
                assignment["reference"] = None
                assignment["sku"] = None
                assignment["color"] = None
                assignment["size"] = None
                assignment["lot"] = None
            assignment["photo_paths"] = from_json(assignment.get("photo_paths"), [])
            valid, errors = assignment_is_valid(assignment)
            assignment["valid"] = valid
            assignment["validation_errors"] = errors
            assignments.append(assignment)
        worker["assignments"] = assignments
        workers.append(worker)
    totals = {
        "sample_target": int(inspection["sample_target_total"] or 0),
        "sample_defined": sum(int(row["sample_qty"]) for row in samples),
        "assigned": sum(int(row["assigned_total"]) for row in samples),
        "inspected": sum(int(row["inspected_total"]) for row in samples),
        "approved": sum(int(row["approved_total"]) for row in samples),
        "rejected": sum(int(row["rejected_total"]) for row in samples),
        "rework": sum(int(row["rework_total"]) for row in samples),
        "available": sum(int(row["available_qty"]) for row in samples),
    }
    validation_errors = inspection_validation(con, inspection["id"])
    previous_rows = con.execute(
        """
        SELECT qi.id,qi.inspection_type,qi.status,qi.destination,qi.send_to_costura,qi.purchase_mode,qi.sample_target_total,
               qi.source_subset,qi.development_pending,qi.created_at,qi.completed_at,u.name completed_by_name,
               COALESCE((SELECT SUM(a.approved_qty) FROM quality_assignments a
                         JOIN quality_workers qw ON qw.id=a.worker_id WHERE qw.inspection_id=qi.id),0) approved_total,
               COALESCE((SELECT SUM(a.rejected_qty) FROM quality_assignments a
                         JOIN quality_workers qw ON qw.id=a.worker_id WHERE qw.inspection_id=qi.id),0) rejected_total,
               COALESCE((SELECT SUM(a.rework_qty) FROM quality_assignments a
                         JOIN quality_workers qw ON qw.id=a.worker_id WHERE qw.inspection_id=qi.id),0) rework_total
        FROM quality_inspections qi LEFT JOIN users u ON u.id=qi.completed_by
        WHERE qi.card_id=? AND qi.id<>? ORDER BY qi.id DESC
        """,
        (card_id, inspection["id"]),
    ).fetchall()
    data["item_routes"] = [dict(row) for row in con.execute(
        """SELECT qir.item_id,qir.destination,i.product,i.reference,i.sku,i.color,i.size,i.expected_qty
           FROM quality_item_routes qir JOIN items i ON i.id=qir.item_id
           WHERE qir.inspection_id=? ORDER BY i.product,i.reference,i.color,i.size,i.id""",
        (inspection["id"],),
    ).fetchall()]
    data["sample_items"] = samples
    data["workers"] = workers
    data["totals"] = totals
    data["previous_inspections"] = [dict(row) for row in previous_rows]
    data["development_warning"] = bool(inspection["development_required"] and not inspection["development_separated"])
    data["completion_ready"] = not validation_errors
    data["validation_errors"] = validation_errors
    return data


@router.get("/quality/users")
def quality_users():
    con = db_connect()
    rows = con.execute(
        "SELECT id,username,name,role FROM users WHERE role='qualidade' ORDER BY name"
    ).fetchall()
    con.close()
    return [dict(row) for row in rows]


@router.post("/quality/uploads")
async def upload_quality_files(
    files: list[UploadFile] = File(...),
    user_id: int = Form(...),
):
    if not files or len(files) > 10:
        raise HTTPException(400, "Envie entre 1 e 10 fotos por operação.")

    con = db_connect()
    try:
        actor = require_role(con, user_id, QUALITY_ROLES)
        uploader_id = int(actor["id"])
    finally:
        con.close()

    allowed_types = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"}
    max_file_size = 10 * 1024 * 1024
    max_total_size = 25 * 1024 * 1024
    total_size = 0
    prepared = []
    for uploaded in files:
        content_type = str(uploaded.content_type or "").lower().split(";", 1)[0].strip()
        if content_type not in allowed_types:
            raise HTTPException(415, "As evidências da Qualidade devem ser imagens JPG, PNG, WebP, GIF ou BMP.")
        content = await uploaded.read(max_file_size + 1)
        if not content:
            raise HTTPException(400, "Uma das imagens está vazia.")
        if len(content) > max_file_size:
            raise HTTPException(413, "Cada foto de evidência deve ter até 10 MB.")
        total_size += len(content)
        if total_size > max_total_size:
            raise HTTPException(413, "Envie no máximo 25 MB de fotos por operação.")
        prepared.append({
            "id": uuid.uuid4().hex,
            "original_name": Path(uploaded.filename or "evidencia").name[:255],
            "content_type": content_type,
            "content": content,
            "uploaded_by": uploader_id,
            "created_at": iso_now(),
        })

    try:

        paths = store_quality_files(prepared)
    except Exception as exc:
        print("[qualidade] falha ao salvar evidências no Supabase: {}".format(exc))
        raise HTTPException(503, "As fotos não foram salvas no Supabase. Tente novamente.") from exc
    return {"paths": paths}


@router.get("/quality/files/{file_id}")
def get_quality_evidence(file_id: str):
    if not file_id or len(file_id) != 32 or any(ch not in "0123456789abcdef" for ch in file_id.lower()):
        raise HTTPException(404, "Evidência não encontrada.")
    try:

        file_record = get_quality_file(file_id.lower())
    except Exception as exc:
        print("[qualidade] falha ao consultar evidência no Supabase: {}".format(exc))
        raise HTTPException(503, "Não foi possível carregar a evidência no Supabase.") from exc
    if not file_record:
        raise HTTPException(404, "Evidência não encontrada.")
    return Response(
        content=bytes(file_record["content"]),
        media_type=file_record["content_type"],
        headers={
            "Content-Disposition": "inline",
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/cards/{card_id}/quality/inspections")
async def create_inspection(card_id: int, request: Request):
    payload = await request.json()
    user_id = int(payload.get("user_id") or 0)
    inspection_type = int(payload.get("inspection_type") or 0)
    destination = str(payload.get("destination") or "").strip().upper() or None
    development_required_raw = payload.get("development_required")
    development_separated_raw = payload.get("development_separated")
    source_subset_requested = bool(payload.get("source_subset"))
    send_to_costura_raw = payload.get("send_to_costura")
    requested_item_ids = sorted({int(value) for value in (payload.get("item_ids") or []) if str(value).isdigit() and int(value) > 0})
    if inspection_type not in (1, 2):
        raise HTTPException(400, "Selecione Inspeção 1 ou Inspeção 2.")
    if development_required_raw is None:
        raise HTTPException(400, "Informe se é necessário separar peças para Desenvolvimento.")
    development_required = 1 if bool(development_required_raw) else 0
    if development_required:
        if development_separated_raw is None:
            raise HTTPException(400, "Informe se as peças para Desenvolvimento já foram separadas.")
        development_separated = 1 if bool(development_separated_raw) else 0
    else:
        development_separated = None
    send_to_costura: Optional[int] = None
    if inspection_type == 1:
        if destination not in ("CD01", "CD02"):
            message = (
                "Defina o destino da Inspeção 1 por referência."
                if source_subset_requested
                else "Selecione o destino CD01 ou CD02 da Inspeção 1."
            )
            raise HTTPException(400, message)
        if not source_subset_requested:
            if send_to_costura_raw is None or str(send_to_costura_raw).strip() == "":
                raise HTTPException(400, "Responda obrigatoriamente: Vai para a Costura?")
            normalized_costura = str(send_to_costura_raw).strip().lower()
            if isinstance(send_to_costura_raw, bool):
                send_to_costura = 1 if send_to_costura_raw else 0
            elif normalized_costura in {"1", "true", "sim", "s"}:
                send_to_costura = 1
            elif normalized_costura in {"0", "false", "não", "nao", "n"}:
                send_to_costura = 0
            else:
                raise HTTPException(400, "Selecione Sim ou Não em Vai para a Costura?")
    else:
        destination = None
        send_to_costura = 0

    con = db_connect()
    user = require_role(con, user_id, QUALITY_ROLES)
    card = con.execute("SELECT * FROM cards WHERE id=?", (card_id,)).fetchone()
    if not card:
        con.close()
        raise HTTPException(404, "Card não encontrado.")
    receiving_sample = None
    # The exact 10% receiving record used below must also pass the QA allocation gate.
    if not source_subset_requested and not card["source_snapshot_at"] and card["current_sector"] == "QUALIDADE":
        receiving_type_for_sample = "RETORNO" if card["receiving_type"] == "RETORNO" else "NOVA"
        receiving_sample = require_completed_receiving_sample(con, card_id, receiving_type_for_sample)
        # The Supabase refresh can reveal that another operator moved the Card meanwhile.
        card = con.execute("SELECT * FROM cards WHERE id=?", (card_id,)).fetchone()
        if not card or card["current_sector"] != "QUALIDADE" or card["source_snapshot_at"]:
            con.close()
            raise HTTPException(
                409,
                "O setor responsável pelo Card mudou enquanto o Recebimento era atualizado. Reabra o Card antes de iniciar a inspeção.",
            )
        if receiving_sample["ten_percent_required"]:
            total_volumes = int(receiving_sample["volumes"] or 0)
            if total_volumes <= 0:
                con.close()
                raise HTTPException(400, "Informe e salve os volumes recebidos para calcular e endereçar os 10% na Qualidade.")
            sample_target = 1
            sample_allocated = total_volume_only_allocated("QA", card_id)
            if sample_allocated < sample_target:
                con.close()
                raise HTTPException(
                    400,
                    f"Enderece os {sample_target} volume(s) da amostra de 10% em posições da Qualidade antes de iniciar a Inspeção. "
                    f"Até agora foram alocados {sample_allocated}.",
                )

    source_items: list[db.Row] = []
    source_subset = False
    if source_subset_requested:
        stage_filter = (
            "source_stage IN ('QUALIDADE','QUALIDADE_RETRABALHO','QUALIDADE_REJEITADO')"
            if card["current_sector"] != "QUALIDADE"
            else "source_stage IN ('QUALIDADE','QUALIDADE_RETRABALHO','QUALIDADE_REJEITADO','') OR source_stage IS NULL"
        )
        available_rows = con.execute(
            f"""SELECT id,expected_qty,product,reference,sku,color,size
               FROM items WHERE card_id=? AND ({stage_filter})
               AND expected_qty>0 ORDER BY product,reference,color,size,id""",
            (card_id,),
        ).fetchall()
        available_ids = {int(row["id"]) for row in available_rows}
        if requested_item_ids:
            invalid = [item_id for item_id in requested_item_ids if item_id not in available_ids]
            if invalid:
                con.close()
                raise HTTPException(400, "Uma ou mais referências selecionadas não estão disponíveis na Qualidade.")
            source_items = [row for row in available_rows if int(row["id"]) in requested_item_ids]
        else:
            source_items = available_rows
        source_subset = bool(source_items)
        if not source_subset:
            con.close()
            raise HTTPException(400, "Selecione pelo menos uma referência disponível na Qualidade.")
    elif card["current_sector"] != "QUALIDADE":
        con.close()
        raise HTTPException(400, "O Card não possui itens disponíveis para iniciar na Qualidade.")

    purchase_mode = str(card["purchase_mode"] or "").upper()
    if purchase_mode not in {"GRADE", "SALDO"}:
        # Tipo não reconhecido na importação: permite informar manualmente ao criar a inspeção.
        manual_mode = str(payload.get("purchase_mode") or "").strip().upper()
        if manual_mode not in {"GRADE", "SALDO"}:
            con.close()
            raise HTTPException(400, "O tipo da compra não foi reconhecido. Selecione Grade ou Saldo para continuar.")
        purchase_mode = manual_mode
        con.execute("UPDATE cards SET purchase_mode=?,updated_at=? WHERE id=?", (purchase_mode, iso_now(), card_id))
        add_history(
            con, card_id, "TIPO_COMPRA_MANUAL",
            f"{user['name']} informou manualmente o tipo da compra: {'Grade' if purchase_mode == 'GRADE' else 'Saldo'}.",
            user_id,
        )

    existing = con.execute(
        "SELECT id FROM quality_inspections WHERE card_id=? AND status='ABERTA'",
        (card_id,),
    ).fetchone()
    if existing:
        con.close()
        raise HTTPException(400, "Já existe uma inspeção aberta para este Card.")
    is_costura_return = str(card["receiving_type"] or "").upper() == "RETORNO"
    expected_inspection_type = 2 if is_costura_return else 1
    if inspection_type != expected_inspection_type:
        con.close()
        if is_costura_return:
            raise HTTPException(400, "Após o retorno da Costura, a inspeção obrigatória é a Inspeção 2.")
        raise HTTPException(400, "Na primeira etapa após o Recebimento, a inspeção obrigatória é a Inspeção 1. A Inspeção 2 só pode ocorrer após o retorno da Costura.")

    # A amostra acompanha a etapa real do fluxo: o Recebimento inicial alimenta a
    # Inspeção 1; somente o retorno da Costura pode iniciar a Inspeção 2.
    source_receiving_id: Optional[int] = None
    if source_subset:
        subset_total = sum(int(item["expected_qty"] or 0) for item in source_items)
        requested_target = max(
            math.ceil(subset_total * 0.10),
            len(source_items) if purchase_mode == "GRADE" else 1,
        )
        sample_source = "IMPORTACAO_QUALIDADE"
    elif inspection_type == 1 or not is_costura_return:
        receiving_sample = receiving_sample or require_completed_receiving_sample(con, card_id, "NOVA")
        requested_target = int(receiving_sample["ten_percent_actual"])
        source_receiving_id = int(receiving_sample["id"])
        sample_source = "RECEBIMENTO"
    else:
        receiving_sample = receiving_sample or require_completed_receiving_sample(con, card_id, "RETORNO")
        requested_target = int(receiving_sample["ten_percent_actual"])
        source_receiving_id = int(receiving_sample["id"])
        sample_source = "RECEBIMENTO_RETORNO"

    cur = con.execute(
        """INSERT INTO quality_inspections(card_id,inspection_type,status,destination,sample_source,source_receiving_id,purchase_mode,
           sample_target_total,development_required,development_separated,development_pending,source_subset,send_to_costura,created_by,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            card_id,
            inspection_type,
            "ABERTA",
            destination,
            sample_source,
            source_receiving_id,
            purchase_mode,
            0,
            development_required,
            development_separated,
            1 if development_required and not development_separated else 0,
            1 if source_subset else 0,
            send_to_costura,
            user_id,
            iso_now(),
        ),
    )
    inspection_id = cur.lastrowid
    source_item_ids = [int(item["id"]) for item in source_items]
    if source_subset:
        con.executemany(
            "INSERT INTO quality_inspection_items(inspection_id,item_id) VALUES(?,?)",
            [(inspection_id, item_id) for item_id in source_item_ids],
        )
    if source_subset:
        default_route = "PROCESSAMENTO" if inspection_type == 2 else None
        con.executemany(
            "INSERT INTO quality_item_routes(inspection_id,item_id,destination) VALUES(?,?,?)",
            [(inspection_id, item_id, default_route) for item_id in source_item_ids],
        )
    target = create_automatic_sample(
        con, inspection_id, card_id, purchase_mode, requested_target,
        source_item_ids if source_subset else None,
    )
    con.execute(
        "UPDATE quality_inspections SET sample_target_total=? WHERE id=?",
        (target, inspection_id),
    )

    if not source_subset:
        con.execute(
            "UPDATE cards SET status='AGUARDANDO_INSPECAO',updated_at=? WHERE id=?",
            (iso_now(), card_id),
        )
    development_text = (
        "Separação para Desenvolvimento necessária e ainda pendente."
        if development_required and not development_separated
        else "Informação de Desenvolvimento registrada."
    )
    sample_text = (
        f"amostra automática por item para compra Grade, total {target}"
        if purchase_mode == "GRADE"
        else f"amostra por quantidade geral para compra Saldo, total {target}"
    )
    if inspection_type == 1 and source_subset:
        inspection_context = " com destino definido por referência"
    elif inspection_type == 1 and send_to_costura:
        inspection_context = " com envio para Costura"
    elif inspection_type == 1:
        inspection_context = " com fluxo direto para Processamento"
    elif sample_source == "RECEBIMENTO":
        inspection_context = " como inspeção final, sem envio para Costura"
    else:
        inspection_context = " após o retorno da Costura, com nova inspeção obrigatória de 10%"
    add_history(
        con,
        card_id,
        "QUALIDADE_CONFIGURADA",
        f"{user['name']} abriu a Inspeção {inspection_type}"
        + inspection_context
        + f", usando {sample_text}. {development_text}",
        user_id,
    )
    con.commit()
    detail = quality_card_data(con, card_id)
    con.close()
    return detail


@router.patch("/quality/inspections/{inspection_id}/routes")
async def save_item_routes(inspection_id: int, request: Request):
    payload = await request.json()
    user_id = int(payload.get("user_id") or 0)
    routes = payload.get("routes") or []
    con = db_connect()
    actor = require_role(con, user_id, QUALITY_ROLES)
    inspection = con.execute("SELECT * FROM quality_inspections WHERE id=?", (inspection_id,)).fetchone()
    if not inspection:
        con.close()
        raise HTTPException(404, "Inspeção não encontrada.")
    ensure_quality_sector_owner(con, inspection, actor["role"])
    if inspection["status"] != "ABERTA":
        con.close()
        raise HTTPException(400, "A inspeção já foi concluída.")
    if not inspection["source_subset"] or inspection["inspection_type"] != 1:
        con.close()
        raise HTTPException(400, "O destino por referência só é necessário na Inspeção 1 por referência.")
    mapped = {int(row["item_id"]) for row in con.execute(
        "SELECT item_id FROM quality_inspection_items WHERE inspection_id=?", (inspection_id,)
    ).fetchall()}
    normalized = {}
    for entry in routes:
        item_id = int(entry.get("item_id") or 0)
        destination = str(entry.get("destination") or "").strip().upper()
        if item_id not in mapped:
            con.close()
            raise HTTPException(400, "Uma referência informada não pertence a esta inspeção.")
        if destination not in {"COSTURA","PROCESSAMENTO"}:
            con.close()
            raise HTTPException(400, "O destino deve ser COSTURA ou PROCESSAMENTO.")
        normalized[item_id] = destination
    if set(normalized) != mapped:
        con.close()
        raise HTTPException(400, "Defina o destino para todas as referências selecionadas.")
    con.execute("DELETE FROM quality_item_routes WHERE inspection_id=?", (inspection_id,))
    con.executemany(
        "INSERT INTO quality_item_routes(inspection_id,item_id,destination) VALUES(?,?,?)",
        [(inspection_id, item_id, destination) for item_id, destination in normalized.items()],
    )
    add_history(con, inspection["card_id"], "DESTINO_QUALIDADE_POR_REFERENCIA",
                f"Destinos definidos para {len(normalized)} referência(s).", user_id)
    con.commit()
    detail = quality_card_data(con, inspection["card_id"])
    con.close()
    return detail


@router.patch("/quality/inspections/{inspection_id}/sample")
async def save_sample_composition(inspection_id: int, request: Request):
    payload = await request.json()
    user_id = int(payload.get("user_id") or 0)
    con = db_connect()
    require_role(con, user_id, QUALITY_ROLES)
    inspection = con.execute("SELECT * FROM quality_inspections WHERE id=?", (inspection_id,)).fetchone()
    con.close()
    if not inspection:
        raise HTTPException(404, "Inspeção não encontrada.")
    raise HTTPException(400, "A composição da amostra agora é calculada automaticamente conforme Grade ou Saldo.")


@router.patch("/quality/inspections/{inspection_id}/development")
async def update_development(inspection_id: int, request: Request):
    payload = await request.json()
    user_id = int(payload.get("user_id") or 0)
    required_raw = payload.get("development_required")
    separated_raw = payload.get("development_separated")
    if required_raw is None:
        raise HTTPException(400, "Informe se a separação para Desenvolvimento é necessária.")
    required = 1 if bool(required_raw) else 0
    if required:
        if separated_raw is None:
            raise HTTPException(400, "Informe se as peças já foram separadas.")
        separated = 1 if bool(separated_raw) else 0
    else:
        separated = None
    con = db_connect()
    user = require_role(con, user_id, QUALITY_ROLES)
    inspection = con.execute("SELECT * FROM quality_inspections WHERE id=?", (inspection_id,)).fetchone()
    if not inspection:
        con.close()
        raise HTTPException(404, "Inspeção não encontrada.")
    ensure_quality_sector_owner(con, inspection, user["role"])
    pending = 1 if required and not separated else 0
    con.execute(
        """UPDATE quality_inspections SET development_required=?,development_separated=?,development_pending=?
           WHERE id=?""",
        (required, separated, pending, inspection_id),
    )
    if pending:
        description = f"{user['name']} informou que a separação para Desenvolvimento é necessária e ainda está pendente."
    elif required:
        description = f"{user['name']} confirmou que as peças para Desenvolvimento foram separadas. Pendência encerrada."
    else:
        description = f"{user['name']} informou que não é necessário separar peças para Desenvolvimento."
    add_history(con, inspection["card_id"], "DESENVOLVIMENTO", description, user_id)
    con.commit()
    detail = quality_card_data(con, inspection["card_id"])
    con.close()
    return detail


@router.post("/quality/inspections/{inspection_id}/assignments/batch")
async def create_assignments_batch(inspection_id: int, request: Request):
    payload = await request.json()
    user_id = int(payload.get("user_id") or 0)
    inspector_id = int(payload.get("inspector_id") or 0)
    entries = payload.get("assignments") or []
    normalized: list[tuple[int, int]] = []
    seen: set[int] = set()
    for entry in entries:
        sample_item_id = int(entry.get("sample_item_id") or 0)
        qty = int(entry.get("assigned_qty") or 0)
        if sample_item_id <= 0 or qty <= 0:
            continue
        if sample_item_id in seen:
            raise HTTPException(400, "O mesmo item foi informado mais de uma vez no lote.")
        seen.add(sample_item_id)
        normalized.append((sample_item_id, qty))
    if not normalized:
        raise HTTPException(400, "Selecione pelo menos um item e informe uma quantidade maior que zero.")

    con = db_connect()
    actor = require_role(con, user_id, QUALITY_ROLES)
    inspection = con.execute("SELECT * FROM quality_inspections WHERE id=?", (inspection_id,)).fetchone()
    if not inspection or inspection["status"] != "ABERTA":
        con.close()
        raise HTTPException(400, "A inspeção não está aberta.")
    ensure_quality_sector_owner(con, inspection, actor["role"])
    inspector = con.execute("SELECT * FROM users WHERE id=?", (inspector_id,)).fetchone()
    if not inspector or inspector["role"] != "qualidade":
        con.close()
        raise HTTPException(400, "Selecione um inspetor da Qualidade.")
    if actor["role"] == "qualidade" and inspector_id != user_id:
        con.close()
        raise HTTPException(403, "O inspetor pode assumir somente itens para si próprio.")

    sample_rows = con.execute(
        """SELECT qs.*,i.product,i.color,i.size,
                   COALESCE(SUM(a.assigned_qty),0) AS assigned_total
            FROM quality_sample_items qs
            JOIN items i ON i.id=qs.item_id
            LEFT JOIN quality_assignments a ON a.sample_item_id=qs.id
            WHERE qs.inspection_id=?
            GROUP BY qs.id, i.id""",
        (inspection_id,),
    ).fetchall()
    samples: dict[int, db.Row] = {int(row["id"]): row for row in sample_rows}
    errors: list[str] = []
    for sample_item_id, qty in normalized:
        sample = samples.get(sample_item_id)
        if not sample:
            errors.append(f"Item da amostra {sample_item_id} não encontrado.")
            continue
        available = int(sample["sample_qty"]) - int(sample["assigned_total"])
        if qty > available:
            label = "Quantidade geral — Saldo" if sample["sample_scope"] == "GERAL" else " / ".join(
                str(v) for v in [sample["product"], sample["color"], sample["size"]] if v
            )
            errors.append(f"{label}: solicitado {qty}, disponível {available}.")

    if errors:
        con.close()
        raise HTTPException(400, "Não foi possível salvar o lote: " + " | ".join(errors))

    worker = get_or_create_worker(con, inspection_id, inspector_id)
    if worker["status"] == "CONCLUIDA":
        con.close()
        raise HTTPException(400, "O inspetor já finalizou sua participação nesta inspeção.")
    total_qty = 0
    labels: list[str] = []
    for sample_item_id, qty in normalized:
        sample = samples[sample_item_id]
        con.execute(
            """INSERT INTO quality_assignments(worker_id,sample_item_id,assigned_qty,photo_paths,result_status,
               assigned_by,assigned_at) VALUES(?,?,?,?,?,?,?)""",
            (worker["id"], sample_item_id, qty, "[]", "PENDENTE", user_id, iso_now()),
        )
        total_qty += qty
        if sample["sample_scope"] == "GERAL":
            labels.append("quantidade geral")
        else:
            labels.append(" / ".join(str(v) for v in [sample["product"], sample["color"], sample["size"]] if v))
    shown = ", ".join(labels[:4]) + ("…" if len(labels) > 4 else "")
    add_history(
        con,
        inspection["card_id"],
        "ATRIBUICAO_QUALIDADE_LOTE",
        f"{actor['name']} atribuiu em lote {total_qty} peças em {len(normalized)} linha(s) para {inspector['name']}: {shown}.",
        user_id,
    )
    refresh_quality_card_status(con, inspection_id)
    con.commit()
    detail = quality_card_data(con, inspection["card_id"])
    con.close()
    return detail


@router.post("/quality/inspections/{inspection_id}/assignments")
async def create_assignment(inspection_id: int, request: Request):
    payload = await request.json()
    user_id = int(payload.get("user_id") or 0)
    sample_item_id = int(payload.get("sample_item_id") or 0)
    inspector_id = int(payload.get("inspector_id") or 0)
    qty = int(payload.get("assigned_qty") or 0)
    if qty <= 0:
        raise HTTPException(400, "Informe uma quantidade maior que zero.")
    con = db_connect()
    actor = require_role(con, user_id, QUALITY_ROLES)
    inspection = con.execute("SELECT * FROM quality_inspections WHERE id=?", (inspection_id,)).fetchone()
    if not inspection or inspection["status"] != "ABERTA":
        con.close()
        raise HTTPException(400, "A inspeção não está aberta.")
    ensure_quality_sector_owner(con, inspection, actor["role"])
    inspector = con.execute("SELECT * FROM users WHERE id=?", (inspector_id,)).fetchone()
    if not inspector or inspector["role"] != "qualidade":
        con.close()
        raise HTTPException(400, "Selecione um inspetor da Qualidade.")
    if actor["role"] == "qualidade" and inspector_id != user_id:
        con.close()
        raise HTTPException(403, "O inspetor pode assumir somente itens para si próprio.")
    sample = con.execute(
        "SELECT * FROM quality_sample_items WHERE id=? AND inspection_id=?",
        (sample_item_id, inspection_id),
    ).fetchone()
    if not sample:
        con.close()
        raise HTTPException(404, "Item da amostra não encontrado.")
    assigned = con.execute(
        "SELECT COALESCE(SUM(assigned_qty),0) total FROM quality_assignments WHERE sample_item_id=?",
        (sample_item_id,),
    ).fetchone()["total"]
    available = int(sample["sample_qty"]) - int(assigned)
    if qty > available:
        con.close()
        raise HTTPException(400, f"Existem somente {available} peças disponíveis neste item.")
    worker = get_or_create_worker(con, inspection_id, inspector_id)
    if worker["status"] == "CONCLUIDA":
        con.close()
        raise HTTPException(400, "O inspetor já finalizou sua participação nesta inspeção.")
    con.execute(
        """INSERT INTO quality_assignments(worker_id,sample_item_id,assigned_qty,photo_paths,result_status,
           assigned_by,assigned_at) VALUES(?,?,?,?,?,?,?)""",
        (worker["id"], sample_item_id, qty, "[]", "PENDENTE", user_id, iso_now()),
    )
    item = con.execute(
        """SELECT i.* FROM items i JOIN quality_sample_items qs ON qs.item_id=i.id WHERE qs.id=?""",
        (sample_item_id,),
    ).fetchone()
    add_history(
        con,
        inspection["card_id"],
        "ATRIBUICAO_QUALIDADE",
        f"{actor['name']} atribuiu {qty} peças de {item['product'] or 'item'} / {item['color'] or '-'} / {item['size'] or '-'} para {inspector['name']}.",
        user_id,
    )
    refresh_quality_card_status(con, inspection_id)
    con.commit()
    detail = quality_card_data(con, inspection["card_id"])
    con.close()
    return detail


@router.post("/quality/assignments/{assignment_id}/release")
async def release_assignment(assignment_id: int, request: Request):
    payload = await request.json()
    user_id = int(payload.get("user_id") or 0)
    con = db_connect()
    actor = require_role(con, user_id, QUALITY_ROLES)
    row = con.execute(
        """SELECT a.*,qw.inspection_id,qw.inspector_id,qw.status worker_status,qi.card_id,
                  i.product,i.color,i.size,u.name inspector_name
           FROM quality_assignments a JOIN quality_workers qw ON qw.id=a.worker_id
           JOIN quality_inspections qi ON qi.id=qw.inspection_id
           JOIN quality_sample_items qs ON qs.id=a.sample_item_id JOIN items i ON i.id=qs.item_id
           JOIN users u ON u.id=qw.inspector_id WHERE a.id=?""",
        (assignment_id,),
    ).fetchone()
    if not row:
        con.close()
        raise HTTPException(404, "Atribuição não encontrada.")
    inspection = con.execute("SELECT * FROM quality_inspections WHERE id=?", (row["inspection_id"],)).fetchone()
    ensure_quality_sector_owner(con, inspection, actor["role"])
    if actor["role"] == "qualidade" and row["inspector_id"] != user_id:
        con.close()
        raise HTTPException(403, "Você só pode devolver suas próprias atribuições.")
    if row["worker_status"] != "NAO_INICIADA" or int(row["inspected_qty"] or 0) > 0:
        con.close()
        raise HTTPException(400, "Após iniciar a inspeção, use a transferência com motivo obrigatório.")
    con.execute("DELETE FROM quality_assignments WHERE id=?", (assignment_id,))
    add_history(
        con,
        row["card_id"],
        "ATRIBUICAO_DEVOLVIDA",
        f"{actor['name']} devolveu {row['assigned_qty']} peças de {row['product'] or 'item'} / {row['color'] or '-'} / {row['size'] or '-'} para a disponibilidade.",
        user_id,
    )
    refresh_quality_card_status(con, row["inspection_id"])
    con.commit()
    detail = quality_card_data(con, row["card_id"])
    con.close()
    return detail


@router.post("/quality/assignments/{assignment_id}/transfer")
async def transfer_assignment(assignment_id: int, request: Request):
    payload = await request.json()
    user_id = int(payload.get("user_id") or 0)
    to_user_id = int(payload.get("to_user_id") or 0)
    reason = str(payload.get("reason") or "").strip()
    if not reason:
        raise HTTPException(400, "Informe o motivo da transferência.")
    con = db_connect()
    actor = require_role(con, user_id, QUALITY_ROLES)
    row = con.execute(
        """SELECT a.*,qw.inspection_id,qw.inspector_id,qi.card_id,u.name inspector_name,
                  i.product,i.color,i.size
           FROM quality_assignments a JOIN quality_workers qw ON qw.id=a.worker_id
           JOIN quality_inspections qi ON qi.id=qw.inspection_id JOIN users u ON u.id=qw.inspector_id
           JOIN quality_sample_items qs ON qs.id=a.sample_item_id JOIN items i ON i.id=qs.item_id
           WHERE a.id=?""",
        (assignment_id,),
    ).fetchone()
    if not row:
        con.close()
        raise HTTPException(404, "Atribuição não encontrada.")
    inspection = con.execute("SELECT * FROM quality_inspections WHERE id=?", (row["inspection_id"],)).fetchone()
    ensure_quality_sector_owner(con, inspection, actor["role"])
    if actor["role"] == "qualidade" and row["inspector_id"] != user_id:
        con.close()
        raise HTTPException(403, "Você só pode transferir suas próprias atribuições.")
    target = con.execute("SELECT * FROM users WHERE id=? AND role='qualidade'", (to_user_id,)).fetchone()
    if not target:
        con.close()
        raise HTTPException(400, "Selecione um inspetor da Qualidade.")
    if int(row["inspected_qty"] or 0) > 0:
        con.close()
        raise HTTPException(400, "Atribuições com resultado já apontado não podem ser transferidas.")
    new_worker = get_or_create_worker(con, row["inspection_id"], to_user_id)
    if new_worker["status"] == "CONCLUIDA":
        con.close()
        raise HTTPException(400, "O inspetor de destino já finalizou sua participação.")
    con.execute("UPDATE quality_assignments SET worker_id=? WHERE id=?", (new_worker["id"], assignment_id))
    add_history(
        con,
        row["card_id"],
        "ATRIBUICAO_TRANSFERIDA",
        f"{actor['name']} transferiu {row['assigned_qty']} peças de {row['product'] or 'item'} de {row['inspector_name']} para {target['name']}. Motivo: {reason}",
        user_id,
    )
    refresh_quality_card_status(con, row["inspection_id"])
    con.commit()
    detail = quality_card_data(con, row["card_id"])
    con.close()
    return detail


@router.patch("/quality/assignments/{assignment_id}/result")
async def save_assignment_result(assignment_id: int, request: Request):
    payload = await request.json()
    user_id = int(payload.get("user_id") or 0)
    con = db_connect()
    actor = require_role(con, user_id, QUALITY_ROLES)
    row = con.execute(
        """SELECT a.*,qw.inspection_id,qw.inspector_id,qw.status worker_status,qi.card_id
           FROM quality_assignments a JOIN quality_workers qw ON qw.id=a.worker_id
           JOIN quality_inspections qi ON qi.id=qw.inspection_id WHERE a.id=?""",
        (assignment_id,),
    ).fetchone()
    if not row:
        con.close()
        raise HTTPException(404, "Atribuição não encontrada.")
    inspection = con.execute("SELECT * FROM quality_inspections WHERE id=?", (row["inspection_id"],)).fetchone()
    ensure_quality_sector_owner(con, inspection, actor["role"])
    if actor["role"] == "qualidade" and row["inspector_id"] != user_id:
        con.close()
        raise HTTPException(403, "Você só pode apontar resultados das suas atribuições.")
    if row["worker_status"] == "CONCLUIDA":
        con.close()
        raise HTTPException(400, "O inspetor já finalizou esta inspeção.")
    inspected = int(payload.get("inspected_qty") or 0)
    rejected = int(payload.get("rejected_qty") or 0)
    rework = int(payload.get("rework_qty") or 0)
    if inspected < 0 or rejected < 0 or rework < 0:
        con.close()
        raise HTTPException(400, "As quantidades não podem ser negativas.")
    if inspected > int(row["assigned_qty"]):
        con.close()
        raise HTTPException(400, "A quantidade inspecionada não pode ultrapassar a quantidade atribuída.")
    if rejected + rework > inspected:
        con.close()
        raise HTTPException(400, "Rejeição e retrabalho não podem ultrapassar a quantidade inspecionada.")
    approved = inspected - rejected - rework
    photos = payload.get("photo_paths") or []
    values = (
        inspected,
        approved,
        rejected,
        rework,
        str(payload.get("reject_reason") or "").strip(),
        str(payload.get("rework_reason") or "").strip(),
        str(payload.get("observation") or "").strip(),
        to_json(photos),
        assignment_id,
    )
    con.execute(
        """UPDATE quality_assignments SET inspected_qty=?,approved_qty=?,rejected_qty=?,rework_qty=?,
           reject_reason=?,rework_reason=?,observation=?,photo_paths=? WHERE id=?""",
        values,
    )
    updated = con.execute("SELECT * FROM quality_assignments WHERE id=?", (assignment_id,)).fetchone()
    valid, _ = assignment_is_valid(updated)
    con.execute(
        "UPDATE quality_assignments SET result_status=? WHERE id=?",
        ("VALIDO" if valid else "PENDENTE", assignment_id),
    )
    add_history(
        con,
        row["card_id"],
        "RESULTADO_QUALIDADE",
        f"{actor['name']} atualizou um resultado: {inspected} inspecionadas, {approved} aprovadas, {rejected} rejeitadas e {rework} para retrabalho.",
        user_id,
    )
    refresh_quality_card_status(con, row["inspection_id"])
    con.commit()
    detail = quality_card_data(con, row["card_id"])
    con.close()
    return detail


@router.patch("/quality/workers/{worker_id}/results/batch")
async def save_worker_results_batch(worker_id: int, request: Request):
    payload = await request.json()
    user_id = int(payload.get("user_id") or 0)
    entries = payload.get("results") or []
    if not isinstance(entries, list) or not entries:
        raise HTTPException(400, "Informe pelo menos um resultado para salvar.")

    con = db_connect()
    try:
        actor = require_role(con, user_id, QUALITY_ROLES)
        worker = con.execute(
            """SELECT qw.*,qi.card_id,qi.status inspection_status
               FROM quality_workers qw
               JOIN quality_inspections qi ON qi.id=qw.inspection_id
               WHERE qw.id=?""",
            (worker_id,),
        ).fetchone()
        if not worker:
            raise HTTPException(404, "Participação do inspetor não encontrada.")
        inspection = con.execute(
            "SELECT * FROM quality_inspections WHERE id=?",
            (worker["inspection_id"],),
        ).fetchone()
        ensure_quality_sector_owner(con, inspection, actor["role"])
        if worker["inspection_status"] != "ABERTA":
            raise HTTPException(400, "A inspeção já foi concluída.")
        if worker["status"] == "CONCLUIDA":
            raise HTTPException(400, "O inspetor já finalizou esta inspeção.")
        if actor["role"] == "qualidade" and int(worker["inspector_id"]) != user_id:
            raise HTTPException(403, "Você só pode apontar resultados das suas próprias atribuições.")

        parsed = []
        seen = set()
        for entry in entries:
            try:
                assignment_id = int(entry.get("assignment_id") or 0)
                inspected = int(entry.get("inspected_qty") or 0)
                rejected = int(entry.get("rejected_qty") or 0)
                rework = int(entry.get("rework_qty") or 0)
            except (TypeError, ValueError):
                raise HTTPException(400, "As quantidades e identificadores devem ser numéricos.")
            if assignment_id <= 0 or assignment_id in seen:
                raise HTTPException(400, "Há uma atribuição inválida ou repetida no lote.")
            seen.add(assignment_id)
            parsed.append((entry, assignment_id, inspected, rejected, rework))

        assignment_rows = con.execute(
            """SELECT a.*,i.product,i.reference,i.sku,i.color,i.size
               FROM quality_assignments a
               JOIN quality_sample_items qs ON qs.id=a.sample_item_id
               JOIN items i ON i.id=qs.item_id
               WHERE a.worker_id=?""",
            (worker_id,),
        ).fetchall()
        assignments_by_id = {int(row["id"]): row for row in assignment_rows}
        normalized = []
        for entry, assignment_id, inspected, rejected, rework in parsed:
            row = assignments_by_id.get(assignment_id)
            if not row:
                raise HTTPException(400, "Uma das atribuições não pertence a este inspetor.")
            if inspected < 0 or rejected < 0 or rework < 0:
                raise HTTPException(400, "As quantidades não podem ser negativas.")
            label = " / ".join(str(value) for value in [row["product"], row["color"], row["size"]] if value)
            if inspected > int(row["assigned_qty"]):
                raise HTTPException(400, f"{label or 'Um dos itens'}: a quantidade inspecionada ultrapassa a atribuída.")
            if rejected + rework > inspected:
                raise HTTPException(400, f"{label or 'Um dos itens'}: rejeição e retrabalho ultrapassam a quantidade inspecionada.")
            photos = entry.get("photo_paths", from_json(row["photo_paths"], []))
            if not isinstance(photos, list):
                raise HTTPException(400, "A lista de evidências de um dos itens é inválida.")
            reject_reason = str(entry.get("reject_reason") or "").strip()
            rework_reason = str(entry.get("rework_reason") or "").strip()
            observation = str(entry.get("observation") or "").strip()
            approved = inspected - rejected - rework
            candidate = dict(row)
            candidate.update({
                "inspected_qty": inspected, "approved_qty": approved,
                "rejected_qty": rejected, "rework_qty": rework,
                "reject_reason": reject_reason, "rework_reason": rework_reason,
                "observation": observation, "photo_paths": to_json(photos),
            })
            valid, _ = assignment_is_valid(candidate)
            normalized.append({
                "id": assignment_id, "inspected_qty": inspected, "approved_qty": approved,
                "rejected_qty": rejected, "rework_qty": rework,
                "reject_reason": reject_reason, "rework_reason": rework_reason,
                "observation": observation, "photo_paths": to_json(photos),
                "result_status": "VALIDO" if valid else "PENDENTE",
            })

        for result in normalized:
            con.execute(
                """UPDATE quality_assignments
                   SET inspected_qty=?,approved_qty=?,rejected_qty=?,rework_qty=?,
                       reject_reason=?,rework_reason=?,observation=?,photo_paths=?,result_status=?
                   WHERE id=? AND worker_id=?""",
                (
                    result["inspected_qty"], result["approved_qty"], result["rejected_qty"], result["rework_qty"],
                    result["reject_reason"], result["rework_reason"], result["observation"], result["photo_paths"],
                    result["result_status"], result["id"], worker_id,
                ),
            )
        totals = {
            "inspected": sum(item["inspected_qty"] for item in normalized),
            "approved": sum(item["approved_qty"] for item in normalized),
            "rejected": sum(item["rejected_qty"] for item in normalized),
            "rework": sum(item["rework_qty"] for item in normalized),
        }
        add_history(
            con,
            worker["card_id"],
            "RESULTADO_QUALIDADE_LOTE",
            f"{actor['name']} salvou em lote {len(normalized)} resultado(s): {totals['inspected']} inspecionadas, "
            f"{totals['approved']} aprovadas, {totals['rejected']} rejeitadas e {totals['rework']} para retrabalho.",
            user_id,
        )
        refresh_quality_card_status(con, worker["inspection_id"])
        con.commit()
        return quality_card_data(con, worker["card_id"])
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


@router.post("/quality/workers/{worker_id}/timer/{action}")
async def quality_worker_timer(worker_id: int, action: str, request: Request):
    payload = await request.json()
    user_id = int(payload.get("user_id") or 0)
    con = db_connect()
    actor = require_role(con, user_id, QUALITY_ROLES)
    worker = con.execute(
        """SELECT qw.*,qi.card_id,qi.status inspection_status,u.name inspector_name
           FROM quality_workers qw JOIN quality_inspections qi ON qi.id=qw.inspection_id
           JOIN users u ON u.id=qw.inspector_id WHERE qw.id=?""",
        (worker_id,),
    ).fetchone()
    if not worker:
        con.close()
        raise HTTPException(404, "Participação do inspetor não encontrada.")
    inspection = con.execute("SELECT * FROM quality_inspections WHERE id=?", (worker["inspection_id"],)).fetchone()
    ensure_quality_sector_owner(con, inspection, actor["role"])
    if actor["role"] == "qualidade" and worker["inspector_id"] != user_id:
        con.close()
        raise HTTPException(403, "Cada inspetor controla apenas o próprio tempo.")
    if worker["inspection_status"] != "ABERTA":
        con.close()
        raise HTTPException(400, "A inspeção já foi concluída.")
    summary = worker_timer_summary(con, worker_id)
    state = summary["state"]
    transitions = {
        "start": ("NAO_INICIADA", "START", "EM_ANDAMENTO"),
        "pause": ("EM_ANDAMENTO", "PAUSE", "PAUSADA"),
        "resume": ("PAUSADA", "RESUME", "EM_ANDAMENTO"),
        "finish": (("EM_ANDAMENTO", "PAUSADA"), "FINISH", "CONCLUIDA"),
    }
    if action not in transitions:
        con.close()
        raise HTTPException(400, "Ação inválida.")
    allowed, event_type, new_state = transitions[action]
    valid_transition = state in allowed if isinstance(allowed, tuple) else state == allowed
    if not valid_transition:
        con.close()
        raise HTTPException(400, f"Ação incompatível com o estado atual: {state}.")
    assignments = con.execute("SELECT * FROM quality_assignments WHERE worker_id=?", (worker_id,)).fetchall()
    if action == "start" and not assignments:
        con.close()
        raise HTTPException(400, "Assuma ou receba pelo menos um item antes de iniciar.")
    if action == "finish":
        if not assignments:
            con.close()
            raise HTTPException(400, "Não existem itens atribuídos.")
        errors: list[str] = []
        for assignment in assignments:
            is_valid, assignment_errors = assignment_is_valid(assignment)
            if not is_valid:
                errors.extend(assignment_errors)
        if errors:
            con.close()
            raise HTTPException(400, "Não é possível finalizar: " + "; ".join(dict.fromkeys(errors)) + ".")
    con.execute(
        "INSERT INTO quality_worker_timer_events(worker_id,event_type,event_at,user_id) VALUES(?,?,?,?)",
        (worker_id, event_type, iso_now(), user_id),
    )
    con.execute(
        "UPDATE quality_workers SET status=?,completed_at=? WHERE id=?",
        (new_state, iso_now() if new_state == "CONCLUIDA" else None, worker_id),
    )
    verbs = {"start": "iniciou", "pause": "pausou", "resume": "retomou", "finish": "finalizou"}
    add_history(
        con,
        worker["card_id"],
        "TEMPO_QUALIDADE",
        f"{worker['inspector_name']} {verbs[action]} sua inspeção.",
        user_id,
    )
    refresh_quality_card_status(con, worker["inspection_id"])
    con.commit()
    detail = quality_card_data(con, worker["card_id"])
    con.close()
    return detail


@router.post("/quality/inspections/{inspection_id}/complete")
async def complete_inspection(inspection_id: int, request: Request):
    payload = await request.json()
    user_id = int(payload.get("user_id") or 0)
    confirm_pending = bool(payload.get("confirm_development_pending"))
    con = db_connect()
    actor = require_role(con, user_id, QUALITY_ROLES)
    inspection = con.execute("SELECT * FROM quality_inspections WHERE id=?", (inspection_id,)).fetchone()
    if not inspection:
        con.close()
        raise HTTPException(404, "Inspeção não encontrada.")
    ensure_quality_sector_owner(con, inspection, actor["role"])
    if inspection["status"] != "ABERTA":
        con.close()
        raise HTTPException(400, "A inspeção já foi concluída.")
    # Protege inspeções abertas antes da regra obrigatória e confirma que a
    # amostra permanece fisicamente na QA até a conclusão.
    should_merge_sample = False
    if not inspection["source_subset"]:
        card = con.execute("SELECT * FROM cards WHERE id=?", (inspection["card_id"],)).fetchone()
        if card and not card["source_snapshot_at"] and card["current_sector"] == "QUALIDADE":
            should_merge_sample = True
            expected_receiving_type = "RETORNO" if inspection["sample_source"] == "RECEBIMENTO_RETORNO" else "NOVA"
            if inspection["source_receiving_id"]:
                receiving = con.execute(
                    "SELECT * FROM receivings WHERE id=? AND card_id=? AND receiving_type=?",
                    (inspection["source_receiving_id"], inspection["card_id"], expected_receiving_type),
                ).fetchone()
                if not receiving:
                    con.close()
                    raise HTTPException(409, "O registro de Recebimento vinculado a esta inspeção não está disponível. Restaure os dados do Recebimento antes de concluir.")
            else:
                receiving = require_completed_receiving_sample(con, int(inspection["card_id"]), expected_receiving_type)
            if not receiving["ten_percent_required"] or receiving["ten_percent_status"] != "CONCLUIDA" or int(receiving["ten_percent_actual"] or 0) <= 0:
                con.close()
                raise HTTPException(400, "A tiragem dos 10% vinculada a esta inspeção precisa estar concluída com quantidade efetivamente separada maior que zero.")
            if receiving["receiving_type"] in {"NOVA", "RETORNO"}:
                if receiving["ten_percent_status"] != "CONCLUIDA":
                    con.close()
                    raise HTTPException(400, "Conclua a tiragem dos 10% no Recebimento antes de concluir a Inspeção.")
                total_volumes = int(receiving["volumes"] or 0)
                if total_volumes <= 0:
                    con.close()
                    raise HTTPException(400, "Informe os volumes recebidos para validar a amostra de 10%.")
                sample_target = 1 if total_volumes > 0 else 0
                sample_allocated = total_volume_only_allocated("QA", int(inspection["card_id"]))
                sample_already_moved = total_ten_percent_sample_in_balance(int(inspection["card_id"]))
                if sample_allocated < sample_target and sample_already_moved < sample_target:
                    con.close()
                    raise HTTPException(
                        400,
                        f"Enderece os {sample_target} volume(s) da amostra de 10% na Qualidade antes de concluir a Inspeção. "
                        f"Até agora foram alocados {sample_allocated}.",
                    )

    errors = inspection_validation(con, inspection_id)
    if errors:
        con.close()
        raise HTTPException(400, "Não é possível concluir: " + " | ".join(errors[:12]))
    pending = bool(inspection["development_required"] and not inspection["development_separated"])
    if pending and not confirm_pending:
        con.close()
        raise HTTPException(
            409,
            "Existem peças pendentes de separação para o setor Desenvolvimento. Confirme a conclusão com pendência.",
        )
    merged_sample_location = None
    if should_merge_sample:
        try:
            merged_sample_location = move_ten_percent_sample_into_balance(int(inspection["card_id"]))
        except Exception:
            con.close()
            raise

    now = iso_now()
    con.execute(
        """UPDATE quality_inspections SET status='CONCLUIDA',completed_by=?,completed_at=?,development_pending=?
           WHERE id=?""",
        (user_id, now, 1 if pending else 0, inspection_id),
    )
    if inspection["source_subset"]:
        mapped_ids = [int(row["item_id"]) for row in con.execute(
            "SELECT item_id FROM quality_inspection_items WHERE inspection_id=?", (inspection_id,)
        ).fetchall()]
        if inspection["inspection_type"] == 2:
            costura_ids = []
            processing_ids = mapped_ids
        else:
            route_rows = con.execute(
                "SELECT item_id,destination FROM quality_item_routes WHERE inspection_id=?",
                (inspection_id,),
            ).fetchall()
            route_map = {int(row["item_id"]): str(row["destination"] or "").upper() for row in route_rows}
            missing_routes = [item_id for item_id in mapped_ids if route_map.get(item_id) not in {"COSTURA","PROCESSAMENTO"}]
            if missing_routes:
                con.close()
                raise HTTPException(400, "Defina o destino de todas as referências antes de concluir.")
            costura_ids = [item_id for item_id in mapped_ids if route_map[item_id] == "COSTURA"]
            processing_ids = [item_id for item_id in mapped_ids if route_map[item_id] == "PROCESSAMENTO"]
        for item_ids, stage in ((costura_ids, "AGUARDANDO_COSTURA"), (processing_ids, "AGUARDANDO_PROCESSAMENTO")):
            if item_ids:
                marks = ",".join("?" for _ in item_ids)
                con.execute(
                    f"UPDATE items SET source_stage=?,source_status_quality='Concluído' WHERE id IN ({marks})",
                    (stage, *item_ids),
                )
        remaining_quality = int(con.execute(
            """SELECT COUNT(*) n FROM items
               WHERE card_id=? AND expected_qty>0
                 AND source_stage IN ('QUALIDADE','QUALIDADE_RETRABALHO','QUALIDADE_REJEITADO')""",
            (inspection["card_id"],),
        ).fetchone()["n"])
        if costura_ids:
            from app import ensure_receiving
            ensure_receiving(con, inspection["card_id"], "COSTURA", costura_ids)
            con.execute(
                """UPDATE cards SET current_sector='RECEBIMENTO',status='AGUARDANDO_DESPACHO_COSTURA',
                   quality_destination='CD01',receiving_type='COSTURA',updated_at=? WHERE id=?""",
                (now, inspection["card_id"]),
            )
            route_text = f"{len(costura_ids)} referência(s) encaminhada(s) para Costura; {len(processing_ids)} referência(s) liberada(s) ao Processamento."
            if remaining_quality:
                route_text += f" {remaining_quality} referência(s) permanecem na Qualidade."
        elif remaining_quality:
            con.execute(
                """UPDATE cards SET current_sector='QUALIDADE',status='ORIGEM_MISTO',
                   quality_destination=NULL,updated_at=? WHERE id=?""",
                (now, inspection["card_id"]),
            )
            route_text = f"{len(processing_ids)} referência(s) liberada(s) ao Processamento; {remaining_quality} referência(s) permanecem na Qualidade."
        else:
            con.execute(
                """UPDATE cards SET current_sector='PROCESSAMENTO',status='AGUARDANDO_PROCESSAMENTO',
                   quality_destination=NULL,receiving_type='NOVA',updated_at=? WHERE id=?""",
                (now, inspection["card_id"]),
            )
            route_text = f"{len(processing_ids)} referência(s) encaminhada(s) ao Processamento."
    elif inspection["inspection_type"] == 1 and (
        int(inspection["send_to_costura"] or 0) == 1
        or (inspection["send_to_costura"] is None and inspection["destination"] == "CD01")
    ):
        con.execute(
            """UPDATE cards SET current_sector='RECEBIMENTO',status='AGUARDANDO_DESPACHO_COSTURA',
               quality_destination='CD01',receiving_type='NOVA',updated_at=? WHERE id=?""",
            (now, inspection["card_id"]),
        )
        route_text = "Card liberado para despacho à Costura. A amostra dos 10% foi integrada ao endereço do saldo."
    else:
        # Preserve receiving_type for Inspeção 2 after the Costura return;
        # a normal first Inspection already carries NOVA at this point.
        con.execute(
            """UPDATE cards SET current_sector='PROCESSAMENTO',status='AGUARDANDO_PROCESSAMENTO',
               quality_destination=NULL,updated_at=? WHERE id=?""",
            (now, inspection["card_id"]),
        )
        route_text = "Card encaminhado diretamente ao Processamento, com a amostra dos 10% integrada ao endereço do saldo."
    sample_move_text = (
        f" Amostra dos 10% reunida automaticamente no endereço {merged_sample_location['address']} ({merged_sample_location['sector']})."
        if merged_sample_location
        else ""
    )
    pending_text = " Inspeção concluída com pendência de separação para Desenvolvimento." if pending else ""
    add_history(
        con,
        inspection["card_id"],
        "INSPECAO_CONCLUIDA",
        f"{actor['name']} concluiu a Inspeção {inspection['inspection_type']}. {route_text}{sample_move_text}{pending_text}",
        user_id,
    )
    con.commit()
    detail = quality_card_data(con, inspection["card_id"])
    con.close()
    return detail


def register_quality_routes(app: FastAPI) -> None:
    app.include_router(router)
