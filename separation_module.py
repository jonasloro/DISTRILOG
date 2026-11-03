"""Separação de pedidos por cronômetro, isolada das operações de estoque.

Os relatórios CSV são uma fonte de pedidos, não um inventário: ruas 001-
e linhas sem casulo não viram peças para separar. Referências excluídas são
registradas para o aviso de que a referência constou em um pedido.
"""
from __future__ import annotations

import csv
import hashlib
import io
import re
from collections import defaultdict
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, UploadFile

import db

router = APIRouter(prefix="/api/separation", tags=["Separação de pedidos"])
OPERATORS = {"admin", "supervisor", "separacao"}
IMPORTERS = {"admin", "supervisor", "separacao", "expedicao"}
REQUIRED_COLUMNS = {
    "identificacao", "emissao", "numero_documento", "referencia",
    "descricao", "codigo_barras", "composicoes_visualizacao",
    "quantidade", "casulo",
}
MAX_IMPORT_BYTES = 10 * 1024 * 1024
MAX_ROWS = 50_000
DURATION_RE = re.compile(r"^([0-9]{1,4}):([0-5][0-9]):([0-5][0-9])$")


def authorize(request: Request, roles: set[str]) -> int:
    if getattr(request.state, "auth_role", None) not in roles:
        raise HTTPException(403, "Seu perfil não permite operar a Separação.")
    return int(request.state.auth_user_id)


def duration_seconds(value: Any) -> int:
    match = DURATION_RE.fullmatch(str(value or "").strip())
    if not match:
        raise HTTPException(422, "Informe o tempo de pausa em hh:mm:ss.")
    hours, minutes, seconds = map(int, match.groups())
    return hours * 3600 + minutes * 60 + seconds


def validate_int(value: Any, label: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool):
        raise HTTPException(422, f"{label}: informe um número inteiro.")
    try:
        number = int(str(value).strip())
    except (ValueError, TypeError):
        raise HTTPException(422, f"{label}: informe um número inteiro.") from None
    if number < minimum or number > 2_000_000:
        raise HTTPException(422, f"{label}: valor inválido.")
    return number


def init_separation_db() -> None:
    """Criação idempotente no schema operacional; acesso SQL só pelo backend."""
    with db.connect() as con:
        con.executescript("""
            CREATE TABLE IF NOT EXISTS distrilog.separation_orders (
                id BIGSERIAL PRIMARY KEY,
                document_no TEXT NOT NULL,
                destination TEXT NOT NULL,
                issue_date TEXT,
                source_sha256 TEXT NOT NULL,
                expected_qty INTEGER NOT NULL CHECK(expected_qty >= 0),
                excluded_street_qty INTEGER NOT NULL DEFAULT 0,
                excluded_without_casulo_qty INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'PENDENTE'
                    CHECK(status IN ('PENDENTE','EM_ANDAMENTO','PAUSADO','CONCLUIDA','SEM_SEPARACAO')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                started_at TIMESTAMPTZ,
                pause_started_at TIMESTAMPTZ,
                accumulated_pause_seconds INTEGER NOT NULL DEFAULT 0,
                completed_at TIMESTAMPTZ,
                operator_id BIGINT REFERENCES distrilog.users(id),
                bags INTEGER,
                boxes INTEGER,
                separated_qty INTEGER,
                weight_kg NUMERIC(12,3),
                zero_left BOOLEAN,
                had_pause BOOLEAN,
                pause_reason TEXT,
                declared_pause_seconds INTEGER,
                shipment_id BIGINT UNIQUE REFERENCES distrilog.shipments(id),
                UNIQUE(document_no, destination)
            );
            CREATE INDEX IF NOT EXISTS idx_separation_orders_status
                ON distrilog.separation_orders(status, created_at DESC);
            CREATE TABLE IF NOT EXISTS distrilog.separation_order_items (
                id BIGSERIAL PRIMARY KEY,
                order_id BIGINT NOT NULL REFERENCES distrilog.separation_orders(id) ON DELETE CASCADE,
                reference TEXT NOT NULL,
                description TEXT,
                barcode TEXT,
                variation TEXT,
                casulo TEXT NOT NULL,
                quantity INTEGER NOT NULL CHECK(quantity > 0)
            );
            CREATE INDEX IF NOT EXISTS idx_separation_items_order
                ON distrilog.separation_order_items(order_id);
            CREATE TABLE IF NOT EXISTS distrilog.separation_order_references (
                order_id BIGINT NOT NULL REFERENCES distrilog.separation_orders(id) ON DELETE CASCADE,
                reference TEXT NOT NULL,
                PRIMARY KEY (order_id, reference)
            );
            CREATE INDEX IF NOT EXISTS idx_separation_refs_match
                ON distrilog.separation_order_references(upper(btrim(reference)));
            CREATE TABLE IF NOT EXISTS distrilog.separation_pauses (
                id BIGSERIAL PRIMARY KEY,
                order_id BIGINT NOT NULL REFERENCES distrilog.separation_orders(id) ON DELETE CASCADE,
                reason TEXT NOT NULL,
                started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                ended_at TIMESTAMPTZ
            );
            CREATE INDEX IF NOT EXISTS idx_separation_pauses_order
                ON distrilog.separation_pauses(order_id);
            ALTER TABLE distrilog.separation_orders ENABLE ROW LEVEL SECURITY;
            ALTER TABLE distrilog.separation_order_items ENABLE ROW LEVEL SECURITY;
            ALTER TABLE distrilog.separation_order_references ENABLE ROW LEVEL SECURITY;
            ALTER TABLE distrilog.separation_pauses ENABLE ROW LEVEL SECURITY;
        """)


def _decode_report(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise HTTPException(422, "Não foi possível identificar a codificação do CSV.")


def parse_report(raw: bytes) -> dict[tuple[str, str], dict[str, Any]]:
    """Parser com validação antes de persistir; não confunde volumes e peças."""
    text = _decode_report(raw)
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter=";")
    if not reader.fieldnames or not REQUIRED_COLUMNS.issubset(
        {str(h or "").strip().lower() for h in reader.fieldnames}
    ):
        raise HTTPException(422, "CSV inválido: faltam colunas do relatório Pedidos_Separacao.")
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    for row_index, row in enumerate(reader, start=2):
        if row_index > MAX_ROWS + 1:
            raise HTTPException(413, "O relatório ultrapassa 50.000 linhas.")
        row = {str(k or "").strip().lower(): str(v or "").strip()
               for k, v in row.items() if k is not None}
        if not any(row.values()):
            continue
        document = row["numero_documento"][:100]
        destination = row["identificacao"][:200]
        reference = row["referencia"][:200]
        if not document or not destination or not reference:
            raise HTTPException(422, f"Linha {row_index}: pedido, destino e referência são obrigatórios.")
        quantity = validate_int(row["quantidade"], f"Linha {row_index}: quantidade")
        if not quantity:
            continue
        date_text = row["emissao"]
        try:
            issue_date = datetime.strptime(date_text, "%d/%m/%Y").date().isoformat()
        except ValueError:
            raise HTTPException(422, f"Linha {row_index}: emissão inválida.") from None
        key = (document, destination)
        group = groups.setdefault(key, {
            "issue_date": issue_date, "expected_qty": 0, "excluded_street_qty": 0,
            "excluded_without_casulo_qty": 0, "items": defaultdict(int), "references": set(),
        })
        if group["issue_date"] != issue_date:
            raise HTTPException(422, f"Emissões divergentes no pedido {document}.")
        group["references"].add(reference)
        casulo = row["casulo"].upper()
        if not casulo:
            group["excluded_without_casulo_qty"] += quantity
        elif casulo.startswith("001-"):
            group["excluded_street_qty"] += quantity
        else:
            group["expected_qty"] += quantity
            item_key = (
                reference, row["descricao"][:300], row["codigo_barras"][:30],
                row["composicoes_visualizacao"][:100], casulo[:80],
            )
            group["items"][item_key] += quantity
    if not groups:
        raise HTTPException(422, "Nenhum pedido válido encontrado no CSV.")
    return groups


def _order(con: db.Connection, order_id: int, *, lock: bool = False) -> dict[str, Any]:
    query = "SELECT * FROM distrilog.separation_orders WHERE id=?"
    if lock:
        query += " FOR UPDATE"
    row = con.execute(query, (order_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Separação não encontrada.")
    return dict(row)


def _owner(request: Request, row: dict[str, Any]) -> int:
    user_id = authorize(request, OPERATORS)
    if (row["operator_id"] is not None and int(row["operator_id"]) != user_id
            and request.state.auth_role not in {"admin", "supervisor"}):
        raise HTTPException(403, "Esta separação está atribuída a outro operador.")
    return user_id


@router.post("/import-csv")
async def import_csv(request: Request, file: UploadFile = File(...)):
    authorize(request, IMPORTERS)
    if not (file.filename or "").lower().endswith(".csv"):
        raise HTTPException(415, "Envie o relatório Pedidos_Separacao em CSV.")
    raw = await file.read(MAX_IMPORT_BYTES + 1)
    if not raw or len(raw) > MAX_IMPORT_BYTES:
        raise HTTPException(413, "O CSV deve ter no máximo 10 MB.")
    groups = parse_report(raw)
    digest = hashlib.sha256(raw).hexdigest()
    imported, existing, valid_qty, excluded = 0, 0, 0, 0
    with db.connect() as con:
        for (document, destination), group in groups.items():
            # Não substitui silenciosamente cronômetros ou entregas já criadas.
            result = con.execute(
                """INSERT INTO distrilog.separation_orders
                   (document_no,destination,issue_date,source_sha256,expected_qty,
                    excluded_street_qty,excluded_without_casulo_qty,status)
                   VALUES(?,?,?,?,?,?,?,?)
                   ON CONFLICT(document_no,destination) DO NOTHING RETURNING id""",
                (document, destination, group["issue_date"], digest,
                 group["expected_qty"], group["excluded_street_qty"],
                 group["excluded_without_casulo_qty"],
                 "PENDENTE" if group["expected_qty"] else "SEM_SEPARACAO"),
            ).fetchone()
            if not result:
                existing += 1
                continue
            order_id = int(result["id"])
            for (reference, description, barcode, variation, casulo), quantity in group["items"].items():
                con.execute(
                    """INSERT INTO distrilog.separation_order_items
                       (order_id,reference,description,barcode,variation,casulo,quantity)
                       VALUES(?,?,?,?,?,?,?)""",
                    (order_id, reference, description, barcode, variation, casulo, quantity),
                )
            for reference in group["references"]:
                con.execute(
                    "INSERT INTO distrilog.separation_order_references(order_id,reference) VALUES(?,?)",
                    (order_id, reference),
                )
            imported += 1
            valid_qty += group["expected_qty"]
            excluded += group["excluded_street_qty"] + group["excluded_without_casulo_qty"]
    return {"imported": imported, "existing": existing, "valid_qty": valid_qty,
            "excluded_qty": excluded, "document_count": len(groups)}


@router.get("/orders")
def list_orders(request: Request):
    authorize(request, OPERATORS | {"expedicao", "consulta", "estocagem"})
    with db.connect() as con:
        rows = con.execute("""
            SELECT o.*, u.name operator_name,
                   COALESCE((SELECT count(*) FROM distrilog.separation_order_items i
                             WHERE i.order_id=o.id),0) line_count,
                   CASE WHEN o.status IN ('EM_ANDAMENTO','PAUSADO')
                        THEN greatest(0,extract(epoch FROM (now()-o.started_at))::integer)
                        WHEN o.completed_at IS NOT NULL
                        THEN greatest(0,extract(epoch FROM (o.completed_at-o.started_at))::integer)
                        ELSE 0 END elapsed_seconds
            FROM distrilog.separation_orders o
            LEFT JOIN distrilog.users u ON u.id=o.operator_id
            ORDER BY CASE o.status WHEN 'EM_ANDAMENTO' THEN 0 WHEN 'PAUSADO' THEN 1
                     WHEN 'PENDENTE' THEN 2 ELSE 3 END, o.id DESC LIMIT 200
        """).fetchall()
        return [dict(row) for row in rows]


@router.get("/orders/{order_id}/items")
def order_items(order_id: int, request: Request):
    authorize(request, OPERATORS | {"expedicao", "consulta", "estocagem"})
    with db.connect() as con:
        _order(con, order_id)
        return [dict(row) for row in con.execute(
            """SELECT reference,description,barcode,variation,casulo,quantity
               FROM distrilog.separation_order_items WHERE order_id=?
               ORDER BY casulo,reference LIMIT 5000""", (order_id,)
        ).fetchall()]


@router.post("/orders/{order_id}/start")
def start_order(order_id: int, request: Request):
    user_id = authorize(request, OPERATORS)
    with db.connect() as con:
        row = _order(con, order_id, lock=True)
        if row["status"] != "PENDENTE":
            raise HTTPException(409, "O cronômetro só pode iniciar uma separação pendente.")
        con.execute(
            """UPDATE distrilog.separation_orders SET status='EM_ANDAMENTO',
               started_at=now(),operator_id=? WHERE id=?""", (user_id, order_id)
        )
    return {"ok": True}


@router.post("/orders/{order_id}/pause")
async def pause_order(order_id: int, request: Request):
    body = await request.json()
    reason = str(body.get("reason") or "").strip()[:500] if isinstance(body, dict) else ""
    if not reason:
        raise HTTPException(422, "Informe o motivo da pausa.")
    with db.connect() as con:
        row = _order(con, order_id, lock=True)
        _owner(request, row)
        if row["status"] != "EM_ANDAMENTO":
            raise HTTPException(409, "Só é possível pausar um cronômetro em andamento.")
        con.execute(
            """UPDATE distrilog.separation_orders SET status='PAUSADO',
               pause_started_at=now() WHERE id=?""", (order_id,)
        )
        con.execute(
            """INSERT INTO distrilog.separation_pauses(order_id,reason)
               VALUES(?,?)""", (order_id, reason)
        )
    return {"ok": True}


@router.post("/orders/{order_id}/resume")
def resume_order(order_id: int, request: Request):
    with db.connect() as con:
        row = _order(con, order_id, lock=True)
        _owner(request, row)
        if row["status"] != "PAUSADO" or row["pause_started_at"] is None:
            raise HTTPException(409, "Esta separação não está pausada.")
        con.execute(
            """UPDATE distrilog.separation_orders SET status='EM_ANDAMENTO',
               accumulated_pause_seconds=accumulated_pause_seconds+
                   greatest(0,extract(epoch FROM (now()-pause_started_at))::integer),
               pause_started_at=NULL WHERE id=?""", (order_id,)
        )
        con.execute(
            """UPDATE distrilog.separation_pauses SET ended_at=now()
               WHERE id=(SELECT id FROM distrilog.separation_pauses
                         WHERE order_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1)""",
            (order_id,),
        )
    return {"ok": True}


@router.post("/orders/{order_id}/complete")
async def complete_order(order_id: int, request: Request):
    authorize(request, OPERATORS)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(422, "Dados de fechamento inválidos.")
    bags = validate_int(body.get("bags"), "Quantidade de bags")
    boxes = validate_int(body.get("boxes"), "Quantidade de caixas")
    separated = validate_int(body.get("separated_qty"), "Peças separadas", minimum=1)
    if bags + boxes < 1:
        raise HTTPException(422, "Informe pelo menos um bag ou uma caixa.")
    try:
        weight = Decimal(str(body.get("weight_kg", "")).replace(",", "."))
    except InvalidOperation:
        raise HTTPException(422, "Informe o peso em quilogramas.") from None
    if not weight.is_finite() or weight <= 0 or weight > Decimal("999999999.999"):
        raise HTTPException(422, "O peso deve ser maior que zero.")
    if not isinstance(body.get("zero_left"), bool) or not isinstance(body.get("had_pause"), bool):
        raise HTTPException(422, "Informe Sim ou Não para 0 à esquerda e pausa.")
    with db.connect() as con:
        row = _order(con, order_id, lock=True)
        _owner(request, row)
        if row["status"] != "EM_ANDAMENTO":
            raise HTTPException(409, "Retome o cronômetro antes de concluir a separação.")
        elapsed = int(con.execute(
            """SELECT greatest(0,extract(epoch FROM (now()-started_at))::integer) AS seconds
               FROM distrilog.separation_orders WHERE id=?""", (order_id,)
        ).fetchone()["seconds"])
        measured = int(row["accumulated_pause_seconds"])
        had_pause = body["had_pause"] or measured > 0
        reason = str(body.get("pause_reason") or "").strip()[:500]
        paused = duration_seconds(body.get("pause_duration")) if had_pause else 0
        if had_pause and (not reason or paused <= 0):
            raise HTTPException(422, "Informe o motivo e o tempo da pausa em hh:mm:ss.")
        if paused < measured or paused > elapsed:
            raise HTTPException(422, "Tempo de pausa incompatível com o cronômetro.")
        # Handoff atômico: o pedido nunca fica concluído sem chegar à Expedição.
        notes = (f"Origem: Separação DISTRILOG #{order_id}. "
                 f"Bags: {bags}; Caixas: {boxes}; Peças separadas: {separated}; "
                 f"Peso: {weight} kg; 0 à esquerda: {'Sim' if body['zero_left'] else 'Não'}; "
                 f"Pausa: {'Sim' if had_pause else 'Não'}"
                 + (f"; Tempo de pausa: {body.get('pause_duration')}; Motivo: {reason}" if had_pause else ""))
        shipment = con.execute(
            """INSERT INTO shipments(document_no,destination,status,total_qty,created_by,created_at,
               volume_count,notes,updated_at)
               VALUES(?,?,'EM_CONFERENCIA',?,?,now(),?,?,now()) RETURNING id""",
            (row["document_no"], row["destination"], separated, request.state.auth_user_id,
             bags + boxes, notes),
        ).fetchone()
        shipment_id = int(shipment["id"])
        # O operador apenas aponta totais. A conferência detalhada é da Expedição.
        con.execute(
            """INSERT INTO shipment_items(shipment_id,barcode,description,quantity,checked_qty)
               VALUES(?,NULL,?,?,0)""",
            (shipment_id, "Total apontado pela Separação (sem conferência por SKU)", separated),
        )
        con.execute(
            """UPDATE distrilog.separation_orders
               SET status='CONCLUIDA',completed_at=now(),bags=?,boxes=?,separated_qty=?,
                   weight_kg=?,zero_left=?,had_pause=?,pause_reason=?,declared_pause_seconds=?,
                   shipment_id=? WHERE id=?""",
            (bags, boxes, separated, str(weight), body["zero_left"], had_pause,
             reason if had_pause else None, paused, shipment_id, order_id),
        )
    return {"ok": True, "shipment_id": shipment_id}


@router.get("/entry-alerts")
def entry_alerts(request: Request):
    authorize(request, OPERATORS | {"expedicao", "consulta", "recebimento", "estocagem"})
    with db.connect() as con:
        rows = con.execute("""
            SELECT upper(btrim(i.reference)) AS reference,
                   max(left(r.physical_completed_at,10)) AS entry_date,
                   (timezone('America/Sao_Paulo',now())::date -
                    max(left(r.physical_completed_at,10))::date) AS days_since_entry
            FROM distrilog.receivings r
            JOIN distrilog.items i ON i.card_id=r.card_id
            WHERE r.physical_status='CONCLUIDO'
              AND r.physical_completed_at IS NOT NULL AND length(btrim(i.reference))>0
              AND NOT EXISTS (
                SELECT 1 FROM distrilog.separation_order_references refs
                WHERE upper(btrim(refs.reference))=upper(btrim(i.reference))
              )
            GROUP BY upper(btrim(i.reference))
            ORDER BY entry_date DESC LIMIT 80
        """).fetchall()
    return [dict(row) for row in rows]


def register_separation_routes(app) -> None:
    app.include_router(router)
