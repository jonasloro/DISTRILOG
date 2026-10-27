"""Consultas de estoque e transferências físicas independentes dos Cards.

A transação serializa o destino e a origem para evitar concorrência entre
Cards diferentes. Uma linha de alocação nunca perde o histórico original:
linhas ativas são substituídas por novas linhas de saldo após a transferência.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from supabase_module import pg_connect

router = APIRouter(prefix="/api/positions", tags=["WMS - Consulta e Transferência"])
_VOLUMES = {"RM", "QA", "PR"}
_BOXES = {"ET", "EC"}


class TransferRequest(BaseModel):
    source_allocation_id: int = Field(gt=0)
    destination_address: str = Field(min_length=4, max_length=24)
    quantity: int | None = Field(default=None, gt=0)
    reason: str = Field(min_length=3, max_length=500)


def init_inventory_db() -> None:
    with pg_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS distrilog.position_movements (
                    id BIGSERIAL PRIMARY KEY,
                    card_id BIGINT NOT NULL,
                    source_address TEXT NOT NULL,
                    destination_address TEXT NOT NULL,
                    from_sector TEXT NOT NULL,
                    to_sector TEXT NOT NULL,
                    item_id BIGINT,
                    color TEXT,
                    quantity INTEGER NOT NULL CHECK(quantity > 0),
                    box_count INTEGER NOT NULL DEFAULT 0 CHECK(box_count >= 0),
                    unit TEXT NOT NULL CHECK(unit IN ('VOLUME', 'CAIXA_PRETA')),
                    reason TEXT NOT NULL,
                    actor_user_id BIGINT NOT NULL,
                    actor_name TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS distrilog.wms_reconciliation_actions (
                    id BIGSERIAL PRIMARY KEY,
                    allocation_id BIGINT NOT NULL,
                    record_snapshot JSONB NOT NULL,
                    action TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    physically_verified BOOLEAN NOT NULL,
                    actor_user_id BIGINT NOT NULL,
                    actor_name TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)
            cur.execute("ALTER TABLE distrilog.wms_reconciliation_actions ENABLE ROW LEVEL SECURITY")
            cur.execute("ALTER TABLE distrilog.position_movements ENABLE ROW LEVEL SECURITY")
            cur.execute("""CREATE INDEX IF NOT EXISTS idx_wms_active_address
                ON distrilog.card_allocations(address, setor, card_id)
                WHERE active IS TRUE""")
            cur.execute("""CREATE INDEX IF NOT EXISTS idx_wms_moves_location_date
                ON distrilog.position_movements(source_address, created_at DESC)""")
            cur.execute("""CREATE INDEX IF NOT EXISTS idx_wms_moves_destination_date
                ON distrilog.position_movements(destination_address, created_at DESC)""")
        conn.commit()


def _actor(cur, request: Request, sector: str, other_sector: str | None = None):
    roles = {"admin", "supervisor"}
    if sector in _VOLUMES and (other_sector is None or other_sector in _VOLUMES):
        roles |= {"recebimento", "qualidade", "processamento"}
    elif sector == "ET" and other_sector in (None, "ET"):
        roles |= {"etiquetagem"}
    elif sector == "EC" and other_sector in (None, "EC"):
        roles |= {"estocagem"}
    if getattr(request.state, "auth_role", None) not in roles:
        raise HTTPException(403, "Seu perfil não pode transferir materiais entre esses endereços.")
    uid = getattr(request.state, "auth_user_id", None)
    cur.execute("SELECT id,name,role FROM distrilog.users WHERE id=%s", (uid,))
    actor = cur.fetchone()
    if not actor or actor["role"] != request.state.auth_role:
        raise HTTPException(401, "Operador inválido. Entre novamente.")
    return actor


@router.get("/{address}/inventory")
def inventory(address: str) -> dict[str, Any]:
    """Conteúdo físico real da posição, distinguindo linhas órfãs legadas."""
    with pg_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""SELECT address,setor,zona,casulo,nivel
                FROM distrilog.sector_positions WHERE address=%s""", (address,))
            location = cur.fetchone()
            if not location:
                raise HTTPException(404, "Endereço físico não cadastrado.")
            cur.execute("""
                SELECT a.id AS allocation_id,a.card_id,a.item_id,a.setor,a.address,
                       a.quantidade,a.box_count,a.allocation_purpose,a.created_at,
                       c.purchase_id,c.supplier,c.brand,c.current_sector,c.status,
                       i.product,i.reference,i.sku,i.color,i.size,
                       (c.id IS NULL) AS missing_card,
                       (a.item_id IS NOT NULL AND i.id IS NULL) AS missing_item
                FROM distrilog.card_allocations a
                LEFT JOIN distrilog.cards c ON c.id=a.card_id
                LEFT JOIN distrilog.items i ON i.id=a.item_id
                WHERE a.address=%s AND a.active IS TRUE AND a.setor=%s
                ORDER BY c.purchase_id NULLS LAST,i.reference NULLS LAST,
                         i.color NULLS LAST,i.size NULLS LAST,a.id
            """, (address, location["setor"]))
            rows = [dict(r) for r in cur.fetchall()]
    return {
        "location": dict(location),
        "items": rows,
        "occupied": sum(int(row["box_count"] if location["setor"] in _BOXES else row["quantidade"]) for row in rows),
        "unit": "CAIXA_PRETA" if location["setor"] in _BOXES else "VOLUME",
        "inconsistent": any(row["missing_card"] or row["missing_item"] for row in rows),
    }


@router.get("/movements")
def movement_history(address: str = "", limit: int = 100) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 200))
    with pg_connect() as conn:
        with conn.cursor() as cur:
            if address:
                cur.execute("""SELECT * FROM distrilog.position_movements
                    WHERE source_address=%s OR destination_address=%s
                    ORDER BY id DESC LIMIT %s""", (address, address, limit))
            else:
                cur.execute("""SELECT * FROM distrilog.position_movements
                    ORDER BY id DESC LIMIT %s""", (limit,))
            return [dict(r) for r in cur.fetchall()]


@router.post("/transfer")
def transfer(payload: TransferRequest, request: Request) -> dict[str, Any]:
    """Move estoque sem alterar estágio do Card; transação única no Postgres.

    RM/QA/PR: saldo compartilhado de volumes, permite transferência parcial.
    ET/EC: movimenta uma cor inteira com todos os tamanhos e caixas pretas.
    Transições de etapa (ET->EC etc.) continuam nos fluxos operacionais.
    """
    destination = payload.destination_address.strip().upper()
    reason = payload.reason.strip()
    if len(reason) < 3:
        raise HTTPException(400, "Informe o motivo da transferência.")
    stamp = datetime.now(timezone.utc).isoformat()

    with pg_connect() as conn:
        with conn.cursor() as cur:
            # A trava por alocação impede duas movimentações simultâneas da
            # mesma linha. O destino é travado antes da checagem de 4 cores.
            cur.execute("""SELECT a.*,i.color,c.id AS valid_card
                FROM distrilog.card_allocations a
                LEFT JOIN distrilog.items i ON i.id=a.item_id
                LEFT JOIN distrilog.cards c ON c.id=a.card_id
                WHERE a.id=%s AND a.active IS TRUE FOR UPDATE OF a""",
                (payload.source_allocation_id,))
            source = cur.fetchone()
            if not source:
                raise HTTPException(409, "Este saldo foi movimentado. Atualize a posição.")
            if not source["valid_card"]:
                raise HTTPException(409, "Alocação órfã: o Card de origem não existe. Exige reconciliação.")
            if source["item_id"] is not None and source["color"] is None:
                cur.execute("SELECT id FROM distrilog.items WHERE id=%s", (source["item_id"],))
                if not cur.fetchone():
                    raise HTTPException(409, "O item desta alocação não existe. Exige reconciliação.")
            origin = str(source["address"])
            if origin == destination:
                raise HTTPException(400, "Origem e destino devem ser diferentes.")
            cur.execute("""SELECT address,setor FROM distrilog.sector_positions
                WHERE address = ANY(%s) ORDER BY address FOR UPDATE""",
                (sorted({origin, destination}),))
            places = {r["address"]: r["setor"] for r in cur.fetchall()}
            if places.get(origin) != source["setor"]:
                raise HTTPException(409, "A posição de origem não corresponde à alocação.")
            target_sector = places.get(destination)
            if not target_sector:
                raise HTTPException(404, "Endereço de destino não cadastrado.")
            from_sector = str(source["setor"])
            if from_sector in _VOLUMES:
                if target_sector not in _VOLUMES:
                    raise HTTPException(409, "Volumes RM/QA/PR não podem ser movidos para ET/EC.")
            elif from_sector in _BOXES:
                if target_sector != from_sector:
                    raise HTTPException(409, "Transferências entre ET e EC exigem conclusão do fluxo operacional.")
            else:
                raise HTTPException(409, "Esta categoria de endereço não permite transferência.")
            actor = _actor(cur, request, from_sector, target_sector)
            unit = "CAIXA_PRETA" if from_sector in _BOXES else "VOLUME"
            card_id = int(source["card_id"])
            moved_ids = []
            if from_sector in _BOXES:
                if payload.quantity is not None:
                    raise HTTPException(400, "Em ET/EC selecione uma cor inteira; quantidades parciais de caixas não são permitidas.")
                # As caixas são registradas por cor, com os demais tamanhos
                # vinculados à mesma cor. A movimentação é indivisível.
                if source["item_id"] is None:
                    raise HTTPException(409, "Caixa preta sem identificação de cor não pode ser movida.")
                color = str(source["color"] or "").strip() or "SEM COR"
                cur.execute("""SELECT a.*,i.color FROM distrilog.card_allocations a
                    JOIN distrilog.items i ON i.id=a.item_id
                    WHERE a.active IS TRUE AND a.card_id=%s AND a.setor=%s
                      AND a.address=%s
                      AND COALESCE(NULLIF(BTRIM(i.color),''),'SEM COR')=%s
                    ORDER BY a.id FOR UPDATE OF a""",
                    (card_id, from_sector, origin, color))
                lines = cur.fetchall()
                if not lines:
                    raise HTTPException(409, "O saldo da cor selecionada mudou. Atualize a posição.")
                boxes = sum(int(row["box_count"] or 0) for row in lines)
                pieces = sum(int(row["quantidade"] or 0) for row in lines)
                if boxes <= 0 or pieces <= 0:
                    raise HTTPException(409, "Registro de caixas incompleto; reconcilie antes de transferir.")
                cur.execute("""SELECT COUNT(DISTINCT COALESCE(NULLIF(BTRIM(i.color),''),'SEM COR')) AS other_colors
                    FROM distrilog.card_allocations a JOIN distrilog.items i ON i.id=a.item_id
                    WHERE a.address=%s AND a.setor=%s AND a.active IS TRUE
                      AND COALESCE(NULLIF(BTRIM(i.color),''),'SEM COR')<>%s""",
                    (destination, target_sector, color))
                other_colors = int(cur.fetchone()["other_colors"] or 0)
                if other_colors >= 4:
                    raise HTTPException(409, "O casulo de destino já comporta quatro outras cores.")
                for row in lines:
                    cur.execute("UPDATE distrilog.card_allocations SET active=FALSE WHERE id=%s AND active IS TRUE", (row["id"],))
                    if cur.rowcount != 1:
                        raise HTTPException(409, "Uma linha foi movimentada simultaneamente.")
                    cur.execute("""INSERT INTO distrilog.card_allocations
                        (card_id,setor,address,quantidade,responsavel,created_at,
                         item_id,allocation_purpose,box_count)
                        VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (card_id,target_sector,destination,row["quantidade"],actor["name"],stamp,
                         row["item_id"],row["allocation_purpose"],row["box_count"]))
                    moved_ids.append(int(row["id"]))
                quantity = pieces
                box_count = boxes
                item_id = int(source["item_id"])
            else:
                total = int(source["quantidade"] or 0)
                quantity = int(payload.quantity or total)
                if quantity <= 0 or quantity > total:
                    raise HTTPException(409, "A quantidade excede os volumes disponíveis nesta alocação.")
                box_count = 0
                color = None
                item_id = source["item_id"]
                cur.execute("UPDATE distrilog.card_allocations SET active=FALSE WHERE id=%s AND active IS TRUE", (source["id"],))
                if cur.rowcount != 1:
                    raise HTTPException(409, "Alocação alterada simultaneamente. Atualize a posição.")
                if quantity < total:
                    cur.execute("""INSERT INTO distrilog.card_allocations
                        (card_id,setor,address,quantidade,responsavel,created_at,
                         item_id,allocation_purpose,box_count)
                        VALUES(%s,%s,%s,%s,%s,%s,%s,%s,0)""",
                        (card_id,from_sector,origin,total-quantity,source["responsavel"],
                         stamp,item_id,source["allocation_purpose"]))
                cur.execute("""INSERT INTO distrilog.card_allocations
                    (card_id,setor,address,quantidade,responsavel,created_at,
                     item_id,allocation_purpose,box_count)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,0)""",
                    (card_id,target_sector,destination,quantity,actor["name"],
                     stamp,item_id,source["allocation_purpose"]))
                moved_ids = [int(source["id"])]

            cur.execute("""INSERT INTO distrilog.position_movements
                (card_id,source_address,destination_address,from_sector,to_sector,item_id,color,
                 quantity,box_count,unit,reason,actor_user_id,actor_name)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                (card_id,origin,destination,from_sector,target_sector,item_id,color,quantity,
                 box_count,unit,reason,actor["id"],actor["name"]))
            move_id = int(cur.fetchone()["id"])
            display_count = box_count if unit == "CAIXA_PRETA" else quantity
            cur.execute("""INSERT INTO distrilog.history(card_id,user_id,event_type,description,created_at)
                VALUES(%s,%s,%s,%s,%s)""",
                (card_id,actor["id"],"TRANSFERENCIA_ENDERECO",
                 f"Movimento #{move_id}: {origin} → {destination}; {display_count} {unit}; motivo: {reason}",
                 stamp))
        conn.commit()
    return {
        "ok": True, "movement_id": move_id, "card_id": card_id,
        "source": origin, "destination": destination, "quantity": quantity,
        "box_count": box_count, "unit": unit, "replaced_allocation_ids": moved_ids,
    }


class ClearOrphanRequest(BaseModel):
    physically_verified_empty: bool
    reason: str = Field(min_length=12, max_length=500)


@router.get("/reconciliation")
def reconciliation(request: Request, limit: int = 200) -> dict[str, Any]:
    """Divergências do WMS, sem apagar ou alterar saldos automaticamente."""
    if getattr(request.state, "auth_role", None) not in {"admin", "supervisor"}:
        raise HTTPException(403, "Somente Gestão pode consultar inconsistências físicas.")
    limit = max(1, min(int(limit), 1000))
    with pg_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT a.id AS allocation_id,a.card_id,a.item_id,a.setor,a.address,
                       a.quantidade,a.box_count,a.created_at,
                       c.purchase_id,i.reference,i.color,i.size,
                       (c.id IS NULL) AS missing_card,
                       (a.item_id IS NOT NULL AND i.id IS NULL) AS missing_item,
                       (p.address IS NULL) AS invalid_address
                FROM distrilog.card_allocations a
                LEFT JOIN distrilog.cards c ON c.id=a.card_id
                LEFT JOIN distrilog.items i ON i.id=a.item_id
                LEFT JOIN distrilog.sector_positions p ON p.address=a.address AND p.setor=a.setor
                WHERE a.active IS TRUE
                  AND (c.id IS NULL OR (a.item_id IS NOT NULL AND i.id IS NULL) OR p.address IS NULL)
                ORDER BY a.setor,a.address,a.id LIMIT %s
            """, (limit,))
            rows = [dict(r) for r in cur.fetchall()]
            cur.execute("""
                SELECT COUNT(*) AS total FROM distrilog.card_allocations a
                LEFT JOIN distrilog.cards c ON c.id=a.card_id
                LEFT JOIN distrilog.items i ON i.id=a.item_id
                LEFT JOIN distrilog.sector_positions p ON p.address=a.address AND p.setor=a.setor
                WHERE a.active IS TRUE
                  AND (c.id IS NULL OR (a.item_id IS NOT NULL AND i.id IS NULL) OR p.address IS NULL)
            """)
            total = int(cur.fetchone()["total"] or 0)
    return {"total": total, "shown": len(rows), "items": rows}


@router.post("/reconciliation/{allocation_id}/clear")
def clear_confirmed_empty_orphan(allocation_id: int, payload: ClearOrphanRequest,
                                request: Request) -> dict[str, Any]:
    """Quarentena reversível de registro órfão após conferência física expressa.

    Nunca elimina linhas: só deixa de contar um saldo comprovadamente inexistente,
    preservando cópia JSON completa e justificativa de quem conferiu.
    """
    if getattr(request.state, "auth_role", None) != "admin":
        raise HTTPException(403, "Somente administrador pode encerrar uma divergência.")
    if not payload.physically_verified_empty:
        raise HTTPException(400, "Confirme que o endereço foi conferido e que a mercadoria não está presente.")
    with pg_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT a.*,c.id AS valid_card,i.id AS valid_item,p.address AS valid_address
                FROM distrilog.card_allocations a
                LEFT JOIN distrilog.cards c ON c.id=a.card_id
                LEFT JOIN distrilog.items i ON i.id=a.item_id
                LEFT JOIN distrilog.sector_positions p ON p.address=a.address AND p.setor=a.setor
                WHERE a.id=%s AND a.active IS TRUE FOR UPDATE OF a
            """, (allocation_id,))
            source = cur.fetchone()
            if not source:
                raise HTTPException(409, "Alocação já alterada. Atualize a reconciliação.")
            is_orphan = (
                source["valid_card"] is None or
                (source["item_id"] is not None and source["valid_item"] is None) or
                source["valid_address"] is None
            )
            if not is_orphan:
                raise HTTPException(409, "Esta alocação tem vínculos válidos e não pode ser baixada por reconciliação.")
            actor = _actor(cur, request, str(source["setor"]), str(source["setor"]))
            import json
            snapshot = {k: v for k, v in dict(source).items()
                        if k not in {"valid_card", "valid_item", "valid_address"}}
            cur.execute("""
                INSERT INTO distrilog.wms_reconciliation_actions
                    (allocation_id,record_snapshot,action,reason,physically_verified,
                     actor_user_id,actor_name)
                VALUES(%s,%s::jsonb,'CONFIRMED_EMPTY_INACTIVATION',%s,TRUE,%s,%s)
                RETURNING id
            """, (allocation_id,json.dumps(snapshot,ensure_ascii=False,default=str),
                  payload.reason.strip(),actor["id"],actor["name"]))
            action_id = int(cur.fetchone()["id"])
            cur.execute("UPDATE distrilog.card_allocations SET active=FALSE WHERE id=%s AND active IS TRUE", (allocation_id,))
            if cur.rowcount != 1:
                raise HTTPException(409, "Estoque alterado durante a conferência. Refaça a consulta.")
        conn.commit()
    return {"ok": True, "reconciliation_action_id": action_id, "allocation_id": allocation_id}


def register_inventory_routes(app: FastAPI) -> None:
    app.include_router(router)
