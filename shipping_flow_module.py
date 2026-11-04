"""Expedição: conferência de lacres -> faturamento -> liberação física.

O estado e a exclusividade são decididos no PostgreSQL, nunca no navegador.
Uma linha por romaneio impede dois operadores de assumir o mesmo trabalho.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from contextlib import contextmanager
from fastapi import APIRouter, HTTPException, Request
import db

router = APIRouter(prefix="/api/shipping", tags=["Expedição por etapas"])
OPERATORS = {"expedicao", "admin", "supervisor"}
VIEWERS = OPERATORS | {"consulta", "recebimento", "qualidade", "processamento",
                       "etiquetagem", "estocagem", "separacao", "planejamento", "devolucoes"}
STAGES = ("CONFERENCIA", "FATURAMENTO", "EXPEDIR", "EXPEDIDO", "DIVERGENCIA")
LEASE_SECONDS = 300  # Renovado pelo cliente a cada 30 s; queda de conexão libera após 5 min.

@contextmanager
def shipping_db():
    """Transação com devolução obrigatória da conexão ao pool.

    db.Connection.__exit__ confirma transações mas NÃO fecha a conexão.
    Usar with db.connect() diretamente causa exaustão do pool em operações.
    """
    con = db.connect()
    try:
        yield con
        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()



def init_shipping_flow_db() -> None:
    with shipping_db() as con:
        con.executescript("""
          CREATE TABLE IF NOT EXISTS distrilog.shipping_workflows(
            shipment_id BIGINT PRIMARY KEY REFERENCES distrilog.shipments(id) ON DELETE CASCADE,
            stage TEXT NOT NULL DEFAULT 'CONFERENCIA'
              CHECK(stage IN ('CONFERENCIA','FATURAMENTO','EXPEDIR','EXPEDIDO','DIVERGENCIA')),
            owner_user_id BIGINT REFERENCES distrilog.users(id),
            owner_started_at TIMESTAMPTZ,
            owner_heartbeat_at TIMESTAMPTZ,
            conference_seconds INTEGER NOT NULL DEFAULT 0 CHECK(conference_seconds >= 0),
            billing_seconds INTEGER NOT NULL DEFAULT 0 CHECK(billing_seconds >= 0),
            seals_checked INTEGER,
            seals_ok BOOLEAN,
            seal_notes TEXT,
            invoice_number TEXT,
            invoice_notes TEXT,
            dispatched_at TIMESTAMPTZ,
            dispatched_by BIGINT REFERENCES distrilog.users(id),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT shipping_lock_complete CHECK(
              (owner_user_id IS NULL AND owner_started_at IS NULL AND owner_heartbeat_at IS NULL)
              OR
              (owner_user_id IS NOT NULL AND owner_started_at IS NOT NULL AND owner_heartbeat_at IS NOT NULL)
            )
          );
          CREATE TABLE IF NOT EXISTS distrilog.shipping_workflow_events(
            id BIGSERIAL PRIMARY KEY,
            shipment_id BIGINT NOT NULL REFERENCES distrilog.shipments(id) ON DELETE CASCADE,
            actor_user_id BIGINT NOT NULL REFERENCES distrilog.users(id),
            stage TEXT NOT NULL,
            event TEXT NOT NULL,
            details TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS shipping_flow_stage_idx
              ON distrilog.shipping_workflows(stage, updated_at DESC);
          CREATE INDEX IF NOT EXISTS shipping_flow_events_idx
              ON distrilog.shipping_workflow_events(shipment_id, id);
          ALTER TABLE distrilog.shipping_workflows ENABLE ROW LEVEL SECURITY;
          ALTER TABLE distrilog.shipping_workflow_events ENABLE ROW LEVEL SECURITY;
          INSERT INTO distrilog.shipping_workflows(shipment_id, stage)
            SELECT id, CASE WHEN status='EXPEDIDO' THEN 'EXPEDIDO' ELSE 'CONFERENCIA' END
            FROM distrilog.shipments
            ON CONFLICT(shipment_id) DO NOTHING;
        """)


def _user(request: Request, *, write: bool = False) -> int:
    role = getattr(request.state, "auth_role", None)
    user = getattr(request.state, "auth_user_id", None)
    if role not in (OPERATORS if write else VIEWERS) or not user:
        raise HTTPException(403, "Sem permissão para esta operação de Expedição.")
    return int(user)


def _event(con, sid: int, uid: int, stage: str, event: str, details: str = "") -> None:
    con.execute(
        """INSERT INTO distrilog.shipping_workflow_events
           (shipment_id,actor_user_id,stage,event,details) VALUES(?,?,?,?,?)""",
        (sid, uid, stage, event, details[:1000]),
    )


def _lock(con, sid: int):
    shipment = con.execute("SELECT id,status,total_qty FROM distrilog.shipments WHERE id=? FOR UPDATE", (sid,)).fetchone()
    if not shipment:
        raise HTTPException(404, "Romaneio não encontrado.")
    con.execute(
        """INSERT INTO distrilog.shipping_workflows(shipment_id,stage)
           VALUES(?,?) ON CONFLICT(shipment_id) DO NOTHING""",
        (sid, "EXPEDIDO" if shipment["status"] == "EXPEDIDO" else "CONFERENCIA"),
    )
    row = con.execute(
        """SELECT wf.*,u.name AS owner_name FROM distrilog.shipping_workflows wf
           LEFT JOIN distrilog.users u ON u.id=wf.owner_user_id
           WHERE wf.shipment_id=? FOR UPDATE OF wf""", (sid,)
    ).fetchone()
    return dict(shipment), dict(row)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _lease_alive(row: dict, now: datetime) -> bool:
    heartbeat = row.get("owner_heartbeat_at")
    return bool(row.get("owner_user_id") and heartbeat and
                heartbeat >= now - timedelta(seconds=LEASE_SECONDS))


def _elapsed(row: dict, now: datetime, *, stale: bool = False) -> int:
    if not row["owner_started_at"]:
        return 0
    end = row["owner_heartbeat_at"] if stale else now
    return max(0, int((end - row["owner_started_at"]).total_seconds()))


def _clear_owner(con, sid: int, stage: str, elapsed: int) -> None:
    field = "conference_seconds" if stage == "CONFERENCIA" else "billing_seconds"
    con.execute(
        f"""UPDATE distrilog.shipping_workflows
             SET {field}={field}+?,owner_user_id=NULL,owner_started_at=NULL,
                 owner_heartbeat_at=NULL,updated_at=now() WHERE shipment_id=?""",
        (elapsed, sid),
    )


def _assert_owner(row: dict, uid: int, now: datetime) -> None:
    if not _lease_alive(row, now) or int(row["owner_user_id"] or 0) != uid:
        raise HTTPException(409, "Esta etapa não está atribuída a você ou a reserva expirou. Atualize a fila.")


def _view(con, sid: int) -> dict:
    row = con.execute(
        """SELECT s.id,s.document_no,s.destination,s.total_qty,s.volume_count,
                  s.carrier,s.vehicle_plate,s.driver_name,s.scheduled_at,s.notes,
                  s.status AS legacy_status,s.completed_at,
                  COALESCE(w.stage,CASE WHEN s.status='EXPEDIDO' THEN 'EXPEDIDO' ELSE 'CONFERENCIA' END) AS stage,
                  w.owner_user_id,w.owner_started_at,w.owner_heartbeat_at,
                  COALESCE(w.conference_seconds,0) AS conference_seconds,
                  COALESCE(w.billing_seconds,0) AS billing_seconds,
                  w.seals_checked,w.seals_ok,w.seal_notes,w.invoice_number,w.invoice_notes,
                  w.dispatched_at,w.dispatched_by,u.name AS owner_name,
                  (SELECT COUNT(*) FROM distrilog.shipment_items si WHERE si.shipment_id=s.id) AS item_lines
           FROM distrilog.shipments s
           LEFT JOIN distrilog.shipping_workflows w ON w.shipment_id=s.id
           LEFT JOIN distrilog.users u ON u.id=w.owner_user_id
           WHERE s.id=?""", (sid,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Romaneio não encontrado.")
    return dict(row)


@router.get("/queue")
def queue(request: Request):
    _user(request)
    with shipping_db() as con:
        ids = [r["id"] for r in con.execute(
            "SELECT id FROM distrilog.shipments ORDER BY id DESC LIMIT 250"
        ).fetchall()]
        return [_view(con, int(sid)) for sid in ids]


@router.get("/{shipment_id}")
def detail(shipment_id: int, request: Request):
    _user(request)
    with shipping_db() as con:
        result = _view(con, shipment_id)
        result["events"] = [dict(r) for r in con.execute(
            """SELECT e.stage,e.event,e.details,e.created_at,u.name AS actor
               FROM distrilog.shipping_workflow_events e
               LEFT JOIN distrilog.users u ON u.id=e.actor_user_id
               WHERE e.shipment_id=? ORDER BY e.id DESC LIMIT 30""", (shipment_id,)
        ).fetchall()]
    return result


@router.post("/{shipment_id}/claim")
def claim(shipment_id: int, request: Request):
    uid = _user(request, write=True)
    with shipping_db() as con:
        shipment, row = _lock(con, shipment_id)
        now = _now()
        if row["stage"] not in ("CONFERENCIA", "FATURAMENTO"):
            raise HTTPException(409, "Esta etapa não pode ser assumida.")
        if row["owner_user_id"] is not None:
            if _lease_alive(row, now):
                if int(row["owner_user_id"]) == uid:
                    # Segunda aba do mesmo operador: não reinicia o timer.
                    return {"ok": True, "stage": row["stage"], "already_claimed": True}
                raise HTTPException(409, f"Em execução por {row['owner_name'] or 'outro operador'}.")
            # Reserva ficou sem heartbeat: preserva tempo auditável até o último sinal.
            elapsed = _elapsed(row, now, stale=True)
            _clear_owner(con, shipment_id, row["stage"], elapsed)
            _event(con, shipment_id, uid, row["stage"], "RESERVA_EXPIRADA",
                   f"Operador anterior: {row['owner_user_id']}; tempo confirmado: {elapsed}s")
        con.execute(
            """UPDATE distrilog.shipping_workflows SET owner_user_id=?,owner_started_at=now(),
               owner_heartbeat_at=now(),updated_at=now() WHERE shipment_id=?""",
            (uid, shipment_id),
        )
        _event(con, shipment_id, uid, row["stage"], "INICIAR")
    return {"ok": True, "stage": row["stage"]}


@router.post("/{shipment_id}/heartbeat")
def heartbeat(shipment_id: int, request: Request):
    uid = _user(request, write=True)
    with shipping_db() as con:
        _, row = _lock(con, shipment_id)
        _assert_owner(row, uid, _now())
        con.execute(
            "UPDATE distrilog.shipping_workflows SET owner_heartbeat_at=now() WHERE shipment_id=?",
            (shipment_id,),
        )
    return {"ok": True}


@router.post("/{shipment_id}/release")
def release(shipment_id: int, request: Request):
    uid = _user(request, write=True)
    with shipping_db() as con:
        _, row = _lock(con, shipment_id)
        now = _now()
        _assert_owner(row, uid, now)
        elapsed = _elapsed(row, now)
        _clear_owner(con, shipment_id, row["stage"], elapsed)
        _event(con, shipment_id, uid, row["stage"], "LIBERAR", f"Tempo: {elapsed}s")
    return {"ok": True}


def _body_int(value, field: str, minimum: int = 1) -> int:
    if isinstance(value, bool) or not str(value).strip().isdigit():
        raise HTTPException(422, f"{field}: informe um número inteiro.")
    val = int(value)
    if not minimum <= val <= 100000:
        raise HTTPException(422, f"{field}: quantidade inválida.")
    return val


@router.post("/{shipment_id}/complete")
async def complete(shipment_id: int, request: Request):
    uid = _user(request, write=True)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(422, "Dados inválidos.")
    with shipping_db() as con:
        shipment, row = _lock(con, shipment_id)
        now = _now()
        _assert_owner(row, uid, now)
        stage = row["stage"]
        if stage == "CONFERENCIA":
            count = _body_int(body.get("seals_checked"), "Lacres conferidos")
            status = body.get("seals_ok")
            if not isinstance(status, bool):
                raise HTTPException(422, "Informe se os lacres estão corretos.")
            notes = str(body.get("notes") or "").strip()[:500]
            if not status and not notes:
                raise HTTPException(422, "Descreva a divergência dos lacres.")
            next_stage = "FATURAMENTO" if status else "DIVERGENCIA"
            con.execute(
                """UPDATE distrilog.shipping_workflows SET seals_checked=?,seals_ok=?,seal_notes=?
                   WHERE shipment_id=?""", (count, status, notes or None, shipment_id),
            )
            con.execute("UPDATE distrilog.shipments SET status=?,updated_at=? WHERE id=?",
                        ("AGUARDANDO_FATURAMENTO" if status else "DIVERGENCIA_LACRES",
                         now.isoformat(), shipment_id))
            details = f"Lacres conferidos: {count}; resultado: {'OK' if status else 'DIVERGÊNCIA'}; {notes}"
        elif stage == "FATURAMENTO":
            invoice = str(body.get("invoice_number") or "").strip()
            if not 1 <= len(invoice) <= 80:
                raise HTTPException(422, "Informe o número da nota fiscal emitida.")
            notes = str(body.get("notes") or "").strip()[:500]
            next_stage = "EXPEDIR"
            con.execute(
                """UPDATE distrilog.shipping_workflows SET invoice_number=?,invoice_notes=?
                   WHERE shipment_id=?""", (invoice, notes or None, shipment_id),
            )
            con.execute("UPDATE distrilog.shipments SET status='PRONTO_EXPEDIR',updated_at=? WHERE id=?",
                        (now.isoformat(), shipment_id))
            details = f"NF informada: {invoice}; {notes}"
        else:
            raise HTTPException(409, "Etapa indisponível para conclusão.")
        elapsed = _elapsed(row, now)
        _clear_owner(con, shipment_id, stage, elapsed)
        con.execute("UPDATE distrilog.shipping_workflows SET stage=? WHERE shipment_id=?",
                    (next_stage, shipment_id))
        _event(con, shipment_id, uid, stage, "CONCLUIR", f"{details}; timer: {elapsed}s")
    return {"ok": True, "stage": next_stage}


@router.post("/{shipment_id}/resolve")
async def resolve_divergence(shipment_id: int, request: Request):
    uid = _user(request, write=True)
    if getattr(request.state, "auth_role", None) not in {"admin", "supervisor"}:
        raise HTTPException(403, "Somente gestão pode devolver uma divergência para nova conferência.")
    body = await request.json()
    reason = str(body.get("reason") or "").strip() if isinstance(body, dict) else ""
    if len(reason) < 5 or len(reason) > 500:
        raise HTTPException(422, "Justifique a liberação para uma nova conferência.")
    with shipping_db() as con:
        _, row = _lock(con, shipment_id)
        if row["stage"] != "DIVERGENCIA":
            raise HTTPException(409, "O romaneio não possui divergência aberta.")
        con.execute(
            """UPDATE distrilog.shipping_workflows SET stage='CONFERENCIA',
                seals_checked=NULL,seals_ok=NULL,seal_notes=NULL,updated_at=now()
               WHERE shipment_id=?""", (shipment_id,),
        )
        con.execute(
            "UPDATE distrilog.shipments SET status='AGUARDANDO_CONFERENCIA',updated_at=? WHERE id=?",
            (_now().isoformat(), shipment_id),
        )
        _event(con, shipment_id, uid, row["stage"], "REABRIR_CONFERENCIA", reason)
    return {"ok": True, "stage": "CONFERENCIA"}


@router.post("/{shipment_id}/dispatch")
def dispatch(shipment_id: int, request: Request):
    uid = _user(request, write=True)
    with shipping_db() as con:
        shipment, row = _lock(con, shipment_id)
        if row["stage"] != "EXPEDIR" or shipment["status"] == "EXPEDIDO":
            raise HTTPException(409, "O faturamento deve estar concluído e o pedido ainda não pode ter sido expedido.")
        if row["owner_user_id"] is not None:
            raise HTTPException(409, "Outra etapa ainda está em execução.")
        con.execute(
            """UPDATE distrilog.shipping_workflows SET stage='EXPEDIDO',
                 dispatched_at=now(),dispatched_by=?,updated_at=now() WHERE shipment_id=?""",
            (uid, shipment_id),
        )
        con.execute(
            "UPDATE distrilog.shipments SET status='EXPEDIDO',completed_at=?,updated_at=? WHERE id=?",
            (_now().isoformat(), _now().isoformat(), shipment_id),
        )
        _event(con, shipment_id, uid, "EXPEDIR", "EXPEDIDO", "Saída física confirmada pelo operador.")
    return {"ok": True, "stage": "EXPEDIDO"}


def register_shipping_flow_routes(app) -> None:
    app.include_router(router)
