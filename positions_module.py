from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
import os
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException

from supabase_module import pg_connect

BASE_DIR = Path(__file__).resolve().parent

router = APIRouter(prefix="/api/positions", tags=["Endereçamento"])

# Zonas por setor — cada zona é um local físico distinto dentro do setor.
# EC usa 1=Feminino / 2=Masculino; os demais setores com mais de uma zona
# seguem os mesmos parâmetros (casulos 01–20, níveis A/B/C).
SECTOR_ZONES: dict[str, list[str]] = {
    "RM": ["1"],
    "QA": ["1", "2"],
    "PR": ["1"],
    "ET": ["1"],
    "EC": ["1", "2"],
}
ZONE_LABELS: dict[str, str] = {"EC:1": "Feminino", "EC:2": "Masculino"}
CASULOS = [f"{i:02d}" for i in range(1, 21)]
NIVEIS = ["A", "B", "C"]
FLAT_SECTORS = {"ET", "EC"}


def iso_now() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def init_positions_db() -> None:
    # tabelas no schema distrilog (Supabase)
    try:
        with pg_connect() as con:
            with con.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS distrilog.sector_positions (
                        id SERIAL PRIMARY KEY,
                        address TEXT UNIQUE NOT NULL,
                        setor TEXT NOT NULL,
                        zona TEXT NOT NULL,
                        casulo TEXT NOT NULL,
                        nivel TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS distrilog.card_allocations (
                        id SERIAL PRIMARY KEY,
                        card_id INTEGER NOT NULL,
                        setor TEXT NOT NULL,
                        address TEXT NOT NULL,
                        quantidade INTEGER NOT NULL,
                        responsavel TEXT,
                        created_at TEXT NOT NULL,
                        item_id INTEGER,
                        allocation_purpose TEXT NOT NULL DEFAULT 'STOCK',
                        active BOOLEAN NOT NULL DEFAULT TRUE
                    );
                    CREATE INDEX IF NOT EXISTS idx_card_allocations_card ON distrilog.card_allocations(card_id, setor);
                    """
                )
                cur.execute(
                    "ALTER TABLE distrilog.card_allocations ADD COLUMN IF NOT EXISTS item_id INTEGER"
                )
                cur.execute(
                    "ALTER TABLE distrilog.card_allocations ADD COLUMN IF NOT EXISTS allocation_purpose TEXT NOT NULL DEFAULT 'STOCK'"
                )
                cur.execute(
                    "ALTER TABLE distrilog.card_allocations ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE"
                )
                cur.execute(
                    "ALTER TABLE distrilog.card_allocations ADD COLUMN IF NOT EXISTS box_count INTEGER NOT NULL DEFAULT 0"
                )
                cur.execute(
                    """UPDATE distrilog.card_allocations SET allocation_purpose='TEN_PERCENT_SAMPLE'
                       WHERE setor='QA' AND item_id IS NULL AND allocation_purpose='STOCK'"""
                )
                cur.execute(
                    "CREATE INDEX IF NOT EXISTS idx_card_allocations_item "
                    "ON distrilog.card_allocations(item_id, setor, address)"
                )
                cur.execute(
                    """CREATE TABLE IF NOT EXISTS distrilog.outlog_migrations (
                        version TEXT PRIMARY KEY,
                        applied_at TEXT NOT NULL DEFAULT now()::text
                    )"""
                )
                cur.execute(
                    """INSERT INTO distrilog.outlog_migrations(version)
                       VALUES(%s) ON CONFLICT (version) DO NOTHING""",
                    ("reset-card-allocations-2026-10-01",),
                )
                if cur.rowcount == 1:
                    cur.execute("DELETE FROM distrilog.card_allocations")
                    print("[migracao] Alocações de peças zeradas; tabela card_allocations preservada.")
                cur.execute(
                    """UPDATE distrilog.card_allocations AS a SET active=FALSE
                       WHERE a.active IS TRUE AND a.setor = ANY(%s)
                         AND EXISTS (
                             SELECT 1 FROM distrilog.cards c
                             WHERE c.id=a.card_id AND c.status IN ('EM_COSTURA_CD01','DESPACHO_CD02')
                         )""",
                    (["RM", "QA", "PR"],),
                )
                cur.execute(
                    """UPDATE distrilog.card_allocations AS a SET active=FALSE
                       WHERE a.active IS TRUE AND a.setor = ANY(%s)
                         AND (
                             a.created_at < (
                                 SELECT MAX(r.created_at) FROM distrilog.receivings r
                                 WHERE r.card_id=a.card_id AND r.receiving_type='RETORNO'
                             )
                             OR (
                                 a.allocation_purpose='TEN_PERCENT_SAMPLE'
                                 AND EXISTS (
                                     SELECT 1 FROM distrilog.receivings r
                                     WHERE r.card_id=a.card_id AND r.receiving_type='RETORNO'
                                 )
                             )
                         )""",
                    (["RM", "QA", "PR"],),
                )
                rows = []
                for setor, zonas in SECTOR_ZONES.items():
                    for zona in zonas:
                        for casulo in CASULOS:
                            niveis = [""] if setor in FLAT_SECTORS else NIVEIS
                            for nivel in niveis:
                                address = f"{zona}{setor}{casulo}{nivel}"
                                rows.append((address, setor, zona, casulo, nivel))
                cur.executemany(
                    "INSERT INTO distrilog.sector_positions(address,setor,zona,casulo,nivel) VALUES(%s,%s,%s,%s,%s) ON CONFLICT (address) DO NOTHING",
                    rows,
                )
                cur.execute("DELETE FROM distrilog.sector_positions WHERE setor = ANY(%s) AND nivel<>''", (list(FLAT_SECTORS),))
            con.commit()
    except RuntimeError as e:
        print(f"[aviso] Endereçamento: {e}")


@router.get("")
def list_positions(setor: str, zona: Optional[str] = None) -> list[dict[str, Any]]:
    setor = setor.upper()
    try:
        with pg_connect() as con:
            with con.cursor() as cur:
                sql = """SELECT p.address,p.setor,p.zona,p.casulo,p.nivel,
                         COALESCE(SUM(CASE WHEN p.setor IN ('ET','EC') THEN a.box_count ELSE a.quantidade END),0) AS ocupado,
                         COUNT(DISTINCT NULLIF(TRIM(i.color),'')) AS color_count,
                         COALESCE(STRING_AGG(DISTINCT NULLIF(TRIM(i.color),''), ', ' ORDER BY NULLIF(TRIM(i.color),'')), '') AS colors
                         FROM distrilog.sector_positions p
                         LEFT JOIN distrilog.card_allocations a ON a.address=p.address AND a.setor=p.setor AND a.active IS TRUE
                         LEFT JOIN distrilog.items i ON i.id=a.item_id
                         WHERE p.setor=%s"""
                args: list[Any] = [setor]
                if zona:
                    sql += " AND p.zona=%s"
                    args.append(zona)
                sql += " GROUP BY p.address,p.setor,p.zona,p.casulo,p.nivel ORDER BY p.zona,p.casulo,p.nivel"
                cur.execute(sql, args)
                rows = cur.fetchall()
    except RuntimeError:
        return []
    return [
        {
            "address": r["address"], "setor": r["setor"], "zona": r["zona"],
            "zona_label": ZONE_LABELS.get(f"{r['setor']}:{r['zona']}"),
            "casulo": r["casulo"], "nivel": r["nivel"], "ocupado": int(r["ocupado"] or 0),
            "color_count": int(r.get("color_count") or 0), "colors": r.get("colors") or "",
        }
        for r in rows
    ]


@router.get("/suggest")
def suggest_position(setor: str, zona: Optional[str] = None) -> dict[str, Any]:
    """Sugere a posição menos ocupada do setor (e zona, se informada) — a
    pessoa pode aceitar ou escolher outra na hora de alocar."""
    positions = list_positions(setor, zona)
    if not positions:
        raise HTTPException(404, "Nenhuma posição cadastrada para esse setor/zona.")
    best = min(positions, key=lambda p: p["ocupado"])
    return best


GLOBAL_ALLOCATION_SECTORS = ("RM", "QA", "PR")


def _card_or_404(cur, card_id: int, lock: bool = False) -> dict[str, Any]:
    # lock=True serializa alocações simultâneas do mesmo card (evita estourar o saldo)
    cur.execute("SELECT * FROM distrilog.cards WHERE id=%s" + (" FOR UPDATE" if lock else ""), (card_id,))
    card = cur.fetchone()
    if not card:
        raise HTTPException(404, "Card não encontrado.")
    return card


def _card_total_volumes(cur, card_id: int, receiving_id: Optional[int] = None) -> Optional[int]:
    """Volumes do recebimento atual, preferindo seu ID quando a requisição o informa."""
    if receiving_id:
        cur.execute(
            "SELECT COALESCE(volumes_after_sample, volumes) AS volumes FROM distrilog.receivings WHERE id=%s AND card_id=%s",
            (receiving_id, card_id),
        )
    else:
        cur.execute(
            """SELECT COALESCE(r.volumes_after_sample, r.volumes) AS volumes FROM distrilog.receivings r
               LEFT JOIN distrilog.cards c ON c.id=r.card_id
               WHERE r.card_id=%s
               ORDER BY (r.closed_at IS NULL) DESC,
                        (r.receiving_type=c.receiving_type) DESC, r.id DESC LIMIT 1""",
            (card_id,),
        )
    row = cur.fetchone()
    vol = int(row["volumes"]) if row and row["volumes"] is not None else 0
    return vol if vol > 0 else None


def _global_allocated(cur, card_id: int) -> int:
    """Saldo dos volumes recebidos em RM + QA + PR, sem contar o bag extra da amostra."""
    cur.execute(
        """SELECT COALESCE(SUM(quantidade),0) t FROM distrilog.card_allocations
           WHERE card_id=%s AND setor = ANY(%s) AND active IS TRUE
             AND COALESCE(allocation_purpose,'STOCK') <> 'TEN_PERCENT_SAMPLE'
             AND NOT (setor='QA' AND item_id IS NULL)""",
        (card_id, list(GLOBAL_ALLOCATION_SECTORS)),
    )
    return int(cur.fetchone()["t"] or 0)


def _sector_scope(setor: Optional[str]) -> list[str]:
    """RM, QA e PR dividem um saldo global; qualquer outro setor conta isolado."""
    s = (setor or "RM").upper()
    return list(GLOBAL_ALLOCATION_SECTORS) if s in GLOBAL_ALLOCATION_SECTORS else [s]


def _ten_percent_volume_target(volumes: Any) -> int:
    """A amostra de peças vai em um bag adicional; não substitui nenhum volume recebido."""
    try:
        total = max(0, int(volumes or 0))
    except (TypeError, ValueError):
        total = 0
    return 1 if total > 0 else 0


@router.post("/cards/{card_id}/allocate")
def allocate(card_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    setor = str(payload.get("setor") or "").upper()
    responsavel = payload.get("responsavel")
    allocations = payload.get("allocations") or []
    if setor not in SECTOR_ZONES:
        raise HTTPException(400, "Setor inválido.")
    if not allocations:
        raise HTTPException(400, "Informe ao menos uma posição e quantidade.")

    try:
        with pg_connect() as con:
            with con.cursor() as cur:
                card = _card_or_404(cur, card_id, lock=True)
                current_sector = str(card.get("current_sector") or "").upper()
                card_status = str(card.get("status") or "").upper()
                if current_sector == "FINALIZADO" or card_status == "FINALIZADO":
                    raise HTTPException(409,"Card finalizado não aceita novas alocações.")
                if current_sector == "PROCESSAMENTO" and card_status == "AGUARDANDO_ENTRADA":
                    raise HTTPException(409,"A mercadoria já foi estocada em EC e aguarda apenas a Entrada do Processamento.")
                if current_sector == "PROCESSAMENTO" and setor != "ET":
                    raise HTTPException(409,"Na saída da Triagem, a mercadoria só pode ser endereçada em ET.")
                if current_sector in {"ETIQUETAGEM","ESTOCAGEM"} and setor != "EC":
                    raise HTTPException(409,"A partir da Etiquetagem/Estocagem, a mercadoria só pode ser endereçada em EC.")
                receiving_id = int(payload.get("receiving_id") or 0)
                if receiving_id:
                    cur.execute(
                        "SELECT receiving_type FROM distrilog.receivings WHERE id=%s AND card_id=%s",
                        (receiving_id, card_id),
                    )
                else:
                    cur.execute(
                        """SELECT r.receiving_type FROM distrilog.receivings r
                           LEFT JOIN distrilog.cards c ON c.id=r.card_id
                           WHERE r.card_id=%s
                           ORDER BY (r.closed_at IS NULL) DESC,
                                    (r.receiving_type=c.receiving_type) DESC, r.id DESC
                           LIMIT 1""",
                        (card_id,),
                    )
                allocation_receiving = cur.fetchone()
                if receiving_id and not allocation_receiving:
                    raise HTTPException(400, "O recebimento informado não pertence a este Card.")
                if (
                    allocation_receiving
                    and allocation_receiving["receiving_type"] == "RETORNO"
                    and setor not in GLOBAL_ALLOCATION_SECTORS
                ):
                    raise HTTPException(400, "O retorno da Costura só pode ser alocado no saldo compartilhado entre RM, QA e PR.")
                is_ten_percent_sample = (
                    setor == "QA"
                    and str(payload.get("allocation_purpose") or "").upper() == "TEN_PERCENT_SAMPLE"
                )
                if setor == "RM" or is_ten_percent_sample:
                    if receiving_id:
                        cur.execute(
                            "SELECT ten_percent_status,volumes,ten_percent_required,receiving_type FROM distrilog.receivings WHERE id=%s AND card_id=%s",
                            (receiving_id, card_id),
                        )
                    else:
                        cur.execute(
                            """SELECT r.ten_percent_status,r.volumes,r.ten_percent_required,r.receiving_type FROM distrilog.receivings r
                               LEFT JOIN distrilog.cards c ON c.id=r.card_id
                               WHERE r.card_id=%s
                               ORDER BY (r.closed_at IS NULL) DESC,
                                        (r.receiving_type=c.receiving_type) DESC, r.id DESC LIMIT 1""",
                            (card_id,),
                        )
                    receiving = cur.fetchone()
                    if not receiving:
                        raise HTTPException(400, "Informe e salve o recebimento antes de alocar os volumes.")
                    is_return_receiving = receiving["receiving_type"] == "RETORNO"
                    if is_ten_percent_sample and (
                        receiving["receiving_type"] != "NOVA" or not receiving["ten_percent_required"]
                    ):
                        raise HTTPException(400, "A alocação especial dos 10% está disponível somente no recebimento inicial.")
                    if not is_return_receiving and receiving["ten_percent_status"] != "CONCLUIDA":
                        raise HTTPException(400, "Conclua a tiragem dos 10% antes de alocar os volumes.")
                    ten_percent_target = _ten_percent_volume_target(receiving["volumes"])
                    cur.execute(
                        """SELECT COALESCE(SUM(quantidade),0) total FROM distrilog.card_allocations
                           WHERE card_id=%s AND setor='QA' AND item_id IS NULL AND active IS TRUE""",
                        (card_id,),
                    )
                    ten_percent_allocated = int(cur.fetchone()["total"] or 0)
                    if is_ten_percent_sample:
                        if ten_percent_target <= 0:
                            raise HTTPException(400, "Informe e salve os volumes recebidos antes de endereçar os 10% na Qualidade.")
                        try:
                            requested_sample_qty = sum(int(a.get("quantidade") or 0) for a in allocations)
                        except (TypeError, ValueError):
                            raise HTTPException(400, "A quantidade precisa ser um número válido.")
                        if ten_percent_allocated + requested_sample_qty > ten_percent_target:
                            remaining_sample = max(0, ten_percent_target - ten_percent_allocated)
                            raise HTTPException(
                                400,
                                f"A alocação obrigatória dos 10% na QA é de {ten_percent_target} volume(s). "
                                f"Já foram alocados {ten_percent_allocated}; restam {remaining_sample}.",
                            )
                    elif setor == "RM":
                        if ten_percent_target <= 0:
                            raise HTTPException(400, "Informe e salve os volumes recebidos antes de alocar no RM.")
                        if not is_return_receiving and ten_percent_allocated < ten_percent_target:
                            raise HTTPException(
                                400,
                                f"Antes de alocar no RM, enderece {ten_percent_target} volume(s) (10% dos volumes) na Qualidade. "
                                f"Já foram alocados {ten_percent_allocated}.",
                            )
                if setor in {"QA", "PR"} and not is_ten_percent_sample:
                    if receiving_id:
                        cur.execute(
                            """SELECT ten_percent_status,volumes,ten_percent_required,receiving_type
                               FROM distrilog.receivings WHERE id=%s AND card_id=%s""",
                            (receiving_id, card_id),
                        )
                    else:
                        cur.execute(
                            """SELECT r.ten_percent_status,r.volumes,r.ten_percent_required,r.receiving_type
                               FROM distrilog.receivings r LEFT JOIN distrilog.cards c ON c.id=r.card_id
                               WHERE r.card_id=%s
                               ORDER BY (r.closed_at IS NULL) DESC,
                                        (r.receiving_type=c.receiving_type) DESC, r.id DESC LIMIT 1""",
                            (card_id,),
                        )
                    sample_receiving = cur.fetchone()
                    if (
                        sample_receiving
                        and sample_receiving["receiving_type"] == "NOVA"
                        and sample_receiving["ten_percent_required"]
                    ):
                        sample_target = _ten_percent_volume_target(sample_receiving["volumes"])
                        cur.execute(
                            """SELECT COALESCE(SUM(quantidade),0) total FROM distrilog.card_allocations
                               WHERE card_id=%s AND setor='QA' AND item_id IS NULL AND active IS TRUE""",
                            (card_id,),
                        )
                        sample_allocated = int(cur.fetchone()["total"] or 0)
                        if sample_receiving["ten_percent_status"] != "CONCLUIDA" or sample_target <= 0:
                            raise HTTPException(400, "Conclua a tiragem e informe os volumes recebidos antes de alocar na QA ou no PR.")
                        if sample_allocated < sample_target:
                            raise HTTPException(
                                400,
                                f"Primeiro, enderece na Qualidade os {sample_target} volume(s) da amostra de 10%. "
                                f"Já foram alocados {sample_allocated}.",
                            )
                valid = {p["address"] for p in list_positions(setor)}
                now = iso_now()
                is_global = setor in GLOBAL_ALLOCATION_SECTORS
                allocation_receiving_id = receiving_id if (setor == "RM" or is_ten_percent_sample) else None
                total_volumes = _card_total_volumes(cur, card_id, allocation_receiving_id or None) if is_global else None
                alocado_global = _global_allocated(cur, card_id) if is_global else 0

                expanded_allocations = []
                for a in allocations:
                    if setor in FLAT_SECTORS and a.get("color"):
                        color = str(a.get("color") or "").strip()
                        cur.execute("""SELECT id,expected_qty,real_qty FROM distrilog.items
                          WHERE card_id=%s AND COALESCE(NULLIF(TRIM(color),''),'SEM COR')=%s ORDER BY id""",(card_id,color or "SEM COR"))
                        color_items=cur.fetchall()
                        if not color_items: raise HTTPException(400,"A cor selecionada não pertence a este Card.")
                        boxes=int(a.get("box_count") or 0)
                        for color_item in color_items:
                            piece_qty=int(color_item["real_qty"] if color_item.get("real_qty") is not None else color_item["expected_qty"] or 0)
                            if piece_qty>0:
                                expanded_allocations.append({"address":a.get("address"),"quantidade":piece_qty,"item_id":int(color_item["id"]),"box_count":boxes if not expanded_allocations or expanded_allocations[-1].get("_color")!=color else 0,"_color":color})
                    else:
                        expanded_allocations.append(a)
                for a in expanded_allocations:
                    address = str(a.get("address") or "")
                    qty = int(a.get("quantidade") or 0)

                    if address not in valid:
                        raise HTTPException(400, f"Posição {address} não pertence ao setor {setor}.")
                    if setor in FLAT_SECTORS:
                        item_id_check = int(a.get("item_id") or 0)
                        cur.execute("SELECT COALESCE(NULLIF(TRIM(color),''),'SEM COR') color FROM distrilog.items WHERE id=%s AND card_id=%s",(item_id_check,card_id))
                        color_row=cur.fetchone()
                        if not color_row: raise HTTPException(400,"Selecione uma cor válida do Card.")
                        cur.execute("""SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(i.color),''),'SEM COR')) n
                          FROM distrilog.card_allocations ca JOIN distrilog.items i ON i.id=ca.item_id
                          WHERE ca.address=%s AND ca.setor=%s AND ca.active IS TRUE
                            AND COALESCE(NULLIF(TRIM(i.color),''),'SEM COR')<>%s""",(address,setor,color_row["color"]))
                        other_colors=int(cur.fetchone()["n"] or 0)
                        if other_colors>=4:
                            raise HTTPException(409,"Este casulo já possui 4 cores no chão. Escolha outro casulo.")
                    if qty <= 0:
                        raise HTTPException(400, "Quantidade precisa ser maior que zero.")

                    if setor == "RM" or is_ten_percent_sample:
                        item_id = None
                        item = None
                    else:
                        item_id = int(a.get("item_id") or 0)
                        if item_id <= 0:
                            raise HTTPException(400, "Selecione a referência antes de alocar.")
                        cur.execute(
                            "SELECT id,expected_qty,real_qty,product,reference,sku,color,size FROM distrilog.items WHERE id=%s AND card_id=%s",
                            (item_id, card_id),
                        )
                        item = cur.fetchone()
                        if not item:
                            raise HTTPException(400, "A referência selecionada não pertence a este Card.")

                    if is_global:
                        # Saldo único do Card (volumes): RM, QA e PR saem do mesmo total.
                        if total_volumes is not None and alocado_global + qty > total_volumes:
                            restante = max(0, total_volumes - alocado_global)
                            raise HTTPException(
                                400,
                                f"Saldo insuficiente: o Card tem {total_volumes} volume(s), "
                                f"{alocado_global} já alocado(s) (RM + QA + PR) e restam {restante}.",
                            )
                        alocado_global += qty
                    else:
                        cur.execute(
                            """SELECT COALESCE(SUM(quantidade),0) qty
                               FROM distrilog.card_allocations
                               WHERE card_id=%s AND setor=%s AND active IS TRUE AND item_id=%s""",
                            (card_id, setor, item_id),
                        )
                        already = int(cur.fetchone()["qty"] or 0)
                        expected = int(item["real_qty"] if item.get("real_qty") is not None else item["expected_qty"] or 0)
                        if already + qty > expected:
                            label = item["reference"] or item["sku"] or item["product"] or str(item_id)
                            raise HTTPException(
                                400,
                                f"A referência {label} possui {expected} peças previstas e já tem {already} alocadas.",
                            )

                    allocation_purpose = "TEN_PERCENT_SAMPLE" if is_ten_percent_sample else "STOCK"
                    box_count = int(a.get("box_count") or 0) if setor in FLAT_SECTORS else 0
                    if setor in FLAT_SECTORS and box_count <= 0:
                        raise HTTPException(400, "Informe quantas caixas pretas foram deixadas neste casulo.")
                    cur.execute(
                        """INSERT INTO distrilog.card_allocations(
                               card_id,setor,address,quantidade,responsavel,created_at,item_id,allocation_purpose,box_count
                           ) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (card_id, setor, address, qty, responsavel, now, item_id, allocation_purpose, box_count),
                    )
            con.commit()
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    return allocation_status(card_id, setor)


@router.get("/cards/{card_id}/status")
def allocation_status(card_id: int, setor: str) -> dict[str, Any]:
    setor = setor.upper()
    try:
        with pg_connect() as con:
            with con.cursor() as cur:
                cur.execute(
                    """SELECT address,SUM(quantidade) qty
                       FROM distrilog.card_allocations
                       WHERE card_id=%s AND setor=%s AND active IS TRUE
                       GROUP BY address
                       ORDER BY address""",
                    (card_id, setor),
                )
                rows = cur.fetchall()

                cur.execute(
                    """SELECT a.item_id,SUM(a.quantidade) qty,
                              i.product,i.reference,i.sku,i.color,i.size,i.expected_qty
                       FROM distrilog.card_allocations a
                       LEFT JOIN distrilog.items i ON i.id=a.item_id
                       WHERE a.card_id=%s AND a.setor=%s AND a.active IS TRUE
                       GROUP BY a.item_id,i.product,i.reference,i.sku,i.color,i.size,i.expected_qty
                       ORDER BY i.product,i.reference,i.color,i.size,a.item_id""",
                    (card_id, setor),
                )
                item_rows = cur.fetchall()

                cur.execute(
                    """SELECT item_id,address,SUM(quantidade) qty,SUM(box_count) box_count
                       FROM distrilog.card_allocations
                       WHERE card_id=%s AND setor=%s AND active IS TRUE AND item_id IS NOT NULL
                       GROUP BY item_id,address
                       ORDER BY item_id,address""",
                    (card_id, setor),
                )
                item_positions = cur.fetchall()

                cur.execute(
                    """SELECT COALESCE(SUM(quantidade),0) total
                       FROM distrilog.card_allocations
                       WHERE card_id=%s AND setor IN (%s,%s,%s) AND active IS TRUE
                         AND COALESCE(allocation_purpose,'STOCK') <> 'TEN_PERCENT_SAMPLE'
                         AND NOT (setor='QA' AND item_id IS NULL)""",
                    (card_id, *GLOBAL_ALLOCATION_SECTORS),
                )
                global_total = int(cur.fetchone()["total"] or 0)
                cur.execute(
                    """SELECT COALESCE(SUM(quantidade),0) total FROM distrilog.card_allocations
                       WHERE card_id=%s AND setor='QA' AND item_id IS NULL AND active IS TRUE""",
                    (card_id,),
                )
                ten_percent_sample_allocated = int(cur.fetchone()["total"] or 0)

                cur.execute(
                    """SELECT a.item_id,SUM(a.quantidade) qty,
                              i.product,i.reference,i.sku,i.color,i.size,i.expected_qty
                       FROM distrilog.card_allocations a
                       LEFT JOIN distrilog.items i ON i.id=a.item_id
                       WHERE a.card_id=%s
                         AND a.setor IN (%s,%s,%s) AND a.active IS TRUE
                         AND a.item_id IS NOT NULL
                       GROUP BY a.item_id,i.product,i.reference,i.sku,i.color,i.size,i.expected_qty
                       ORDER BY i.product,i.reference,i.color,i.size,a.item_id""",
                    (card_id, *GLOBAL_ALLOCATION_SECTORS),
                )
                global_item_rows = cur.fetchall()

                cur.execute(
                    """SELECT setor,COALESCE(SUM(quantidade),0) qty
                       FROM distrilog.card_allocations
                       WHERE card_id=%s AND setor = ANY(%s) AND active IS TRUE
                         AND COALESCE(allocation_purpose,'STOCK') <> 'TEN_PERCENT_SAMPLE'
                         AND NOT (setor='QA' AND item_id IS NULL)
                       GROUP BY setor""",
                    (card_id, list(GLOBAL_ALLOCATION_SECTORS)),
                )
                por_setor_rows = cur.fetchall()
                volumes_total = _card_total_volumes(cur, card_id)
    except RuntimeError:
        rows, item_rows, item_positions = [], [], []
        global_total, global_item_rows = 0, []
        por_setor_rows, volumes_total, ten_percent_sample_allocated = [], None, 0

    total = sum(int(r["qty"] or 0) for r in rows)
    grouped: dict[int, dict[str, Any]] = {}
    for r in item_rows:
        item_id = int(r["item_id"]) if r["item_id"] is not None else 0
        if item_id not in grouped:
            grouped[item_id] = {
                "item_id": item_id,
                "product": r["product"],
                "reference": r["reference"],
                "sku": r["sku"],
                "color": r["color"],
                "size": r["size"],
                "expected_qty": int(r["expected_qty"] or 0),
                "total_alocado": int(r["qty"] or 0),
                "posicoes": [],
            }

    for r in item_positions:
        item_id = int(r["item_id"])
        grouped.setdefault(item_id, {
            "item_id": item_id, "product": None, "reference": None, "sku": None,
            "color": None, "size": None, "expected_qty": 0, "total_alocado": 0,
            "posicoes": [],
        })
        grouped[item_id]["posicoes"].append({
            "address": r["address"],
            "quantidade": int(r["qty"] or 0),
            "box_count": int(r.get("box_count") or 0),
        })

    global_item_grouped: dict[int, dict[str, Any]] = {}
    for r in global_item_rows:
        item_id = int(r["item_id"]) if r["item_id"] is not None else 0
        global_item_grouped[item_id] = {
            "item_id": item_id,
            "product": r["product"],
            "reference": r["reference"],
            "sku": r["sku"],
            "color": r["color"],
            "size": r["size"],
            "expected_qty": int(r["expected_qty"] or 0),
            "total_alocado": int(r["qty"] or 0),
        }

    return {
        "card_id": card_id,
        "setor": setor,
        "total_alocado": total,
        "global_total_alocado": global_total,
        "volumes_total": volumes_total,
        "ten_percent_sample_allocated": ten_percent_sample_allocated,
        "volumes_restante": max(0, volumes_total - global_total) if volumes_total is not None else None,
        "global_por_setor": {
            s: next((int(r["qty"] or 0) for r in por_setor_rows if r["setor"] == s), 0)
            for s in GLOBAL_ALLOCATION_SECTORS
        },
        "posicoes": [{"address": r["address"], "quantidade": int(r["qty"] or 0)} for r in rows],
        "item_allocations": list(grouped.values()),
        "global_item_allocations": list(global_item_grouped.values()),
    }


@router.get("/cards/{card_id}/trail")
def card_trail(card_id: int) -> list[dict[str, Any]]:
    """Trilha completa do card: toda alocação, em qualquer setor, em ordem
    cronológica — é o histórico de por onde o card passou fisicamente."""
    try:
        with pg_connect() as con:
            with con.cursor() as cur:
                cur.execute(
                    """SELECT a.setor,a.address,a.quantidade,a.responsavel,a.created_at,a.item_id,a.allocation_purpose,a.active,a.active,
                              i.product,i.reference,i.sku,i.color,i.size
                       FROM distrilog.card_allocations a
                       LEFT JOIN distrilog.items i ON i.id=a.item_id
                       WHERE a.card_id=%s
                       ORDER BY a.created_at""",
                    (card_id,),
                )
                rows = cur.fetchall()
    except RuntimeError:
        return []
    return [dict(r) for r in rows]



def item_allocation_totals(card_id: int, setor: str = "RM") -> dict[int, int]:
    """Retorna a quantidade física alocada por item, em volumes (caixa/bag).

    RM, QA e PR dividem um saldo global: pedir qualquer um deles soma os três,
    porque o Card pode ser endereçado direto em outro setor a partir do RM.
    O módulo não transforma quantidade de peças em volume.
    """
    try:
        with pg_connect() as con:
            with con.cursor() as cur:
                cur.execute(
                    """SELECT item_id,COALESCE(SUM(quantidade),0) qty
                       FROM distrilog.card_allocations
                       WHERE card_id=%s AND setor = ANY(%s) AND item_id IS NOT NULL AND active IS TRUE
                       GROUP BY item_id""",
                    (card_id, _sector_scope(setor)),
                )
                return {
                    int(row["item_id"]): int(row["qty"] or 0)
                    for row in cur.fetchall()
                }
    except RuntimeError:
        return {}


def total_allocated(setor: str, card_id: int) -> int:
    """Helper síncrono usado pelos gates de avanço de setor em app.py.
    RM, QA e PR contam como saldo global (ver _sector_scope)."""
    try:
        with pg_connect() as con:
            with con.cursor() as cur:
                cur.execute(
                    """SELECT COALESCE(SUM(quantidade),0) t FROM distrilog.card_allocations
                       WHERE card_id=%s AND setor = ANY(%s) AND active IS TRUE
                         AND COALESCE(allocation_purpose,'STOCK') <> 'TEN_PERCENT_SAMPLE'
                         AND NOT (setor='QA' AND item_id IS NULL)""",
                    (card_id, _sector_scope(setor)),
                )
                return int(cur.fetchone()["t"] or 0)
    except RuntimeError:
        return 0


def deactivate_card_allocations(card_id: int, sectors: list[str] | tuple[str, ...], item_ids: Optional[list[int]] = None) -> int:
    """Desativa endereços de origem após uma movimentação física concluída, preservando a trilha histórica."""
    normalized = [str(s or "").upper() for s in sectors if str(s or "").strip()]
    if not normalized:
        return 0
    with pg_connect() as con:
        with con.cursor() as cur:
            sql = """UPDATE distrilog.card_allocations
                     SET active=FALSE
                     WHERE card_id=%s AND setor = ANY(%s) AND active IS TRUE"""
            params: list[Any] = [card_id, normalized]
            if item_ids is not None:
                clean_ids = [int(i) for i in item_ids if int(i) > 0]
                if not clean_ids:
                    return 0
                sql += " AND item_id = ANY(%s)"
                params.append(clean_ids)
            cur.execute(sql, tuple(params))
            changed = int(cur.rowcount or 0)
        con.commit()
    return changed


def release_card_allocations(card_id: int, keep_quality_qty: int = 0) -> int:
    """Libera o endereço do card quando a produção começa. Os 10% ficam na Qualidade
    (registrados no setor QUALIDADE); o restante sai do endereço original."""
    with pg_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT COALESCE(SUM(quantidade),0) t FROM distrilog.card_allocations WHERE card_id=%s AND setor<>'QUALIDADE' AND active IS TRUE", (card_id,))
        total = int(cur.fetchone()["t"] or 0)
        if total <= 0:
            return 0
        cur.execute("UPDATE distrilog.card_allocations SET active=FALSE WHERE card_id=%s AND setor<>'QUALIDADE' AND active IS TRUE", (card_id,))
        keep = max(0, min(int(keep_quality_qty or 0), total))
        if keep:
            cur.execute(
                "INSERT INTO distrilog.card_allocations(card_id,setor,address,quantidade,responsavel,created_at,allocation_purpose) VALUES(%s,%s,%s,%s,%s,%s,%s)",
                (card_id, "QUALIDADE", "QUALIDADE (10%)", keep, "sistema", iso_now(), "TEN_PERCENT_SAMPLE"),
            )
        conn.commit()
    return total - keep
























def total_volume_only_allocated(setor: str, card_id: int) -> int:
    """Total de alocações por volume (sem item/referência) em um setor."""
    setor = str(setor or "").upper()
    try:
        with pg_connect() as con:
            with con.cursor() as cur:
                cur.execute(
                    """SELECT COALESCE(SUM(quantidade),0) total FROM distrilog.card_allocations
                       WHERE card_id=%s AND setor=%s AND active IS TRUE AND item_id IS NULL""",
                    (card_id, setor),
                )
                return int(cur.fetchone()["total"] or 0)
    except RuntimeError:
        return 0








def total_ten_percent_sample_in_balance(card_id: int) -> int:
    """Quantity of already merged sample bags in stock positions (idempotent completion guard)."""
    try:
        with pg_connect() as con:
            with con.cursor() as cur:
                cur.execute(
                    """SELECT COALESCE(SUM(quantidade),0) total FROM distrilog.card_allocations
                       WHERE card_id=%s AND setor = ANY(%s) AND item_id IS NULL
                         AND active IS TRUE AND allocation_purpose='TEN_PERCENT_SAMPLE'""",
                    (card_id, ["RM", "PR"]),
                )
                return int(cur.fetchone()["total"] or 0)
    except RuntimeError:
        return 0




def move_ten_percent_sample_into_balance(card_id: int) -> dict[str, Any]:
    """Move the physical 10% sample bag beside the Card's main stock address.
    The sample remains tagged as an additional bag and is excluded from the received-volume quota.
    """
    with pg_connect() as con, con.cursor() as cur:
        _card_or_404(cur, card_id, lock=True)
        cur.execute(
            """SELECT id,quantidade FROM distrilog.card_allocations
               WHERE card_id=%s AND setor='QA' AND item_id IS NULL AND active IS TRUE
                 AND allocation_purpose='TEN_PERCENT_SAMPLE'
               ORDER BY created_at,id FOR UPDATE""",
            (card_id,),
        )
        samples = cur.fetchall()
        if not samples:
            cur.execute(
                """SELECT setor,address,SUM(quantidade) qty FROM distrilog.card_allocations
                   WHERE card_id=%s AND setor = ANY(%s) AND active IS TRUE AND allocation_purpose='TEN_PERCENT_SAMPLE'
                   GROUP BY setor,address ORDER BY MAX(created_at) DESC,address LIMIT 1""",
                (card_id, ["RM", "PR"]),
            )
            previously_moved = cur.fetchone()
            if previously_moved:
                con.commit()
                return {"sector": str(previously_moved["setor"]), "address": str(previously_moved["address"]), "quantity": int(previously_moved["qty"] or 0)}
            raise HTTPException(409, "A amostra dos 10% não está endereçada na Qualidade. Retorne ao Recebimento e confira o endereço da amostra antes de concluir.")
        sample_qty = sum(int(row["quantidade"] or 0) for row in samples)
        if sample_qty <= 0:
            raise HTTPException(409, "A amostra dos 10% não possui uma quantidade física válida para movimentar.")
        cur.execute(
            """SELECT address,SUM(quantidade) qty FROM distrilog.card_allocations
               WHERE card_id=%s AND setor='RM' AND item_id IS NULL AND active IS TRUE
                 AND COALESCE(allocation_purpose,'STOCK') <> 'TEN_PERCENT_SAMPLE'
               GROUP BY address HAVING SUM(quantidade)>0
               ORDER BY SUM(quantidade) DESC,address LIMIT 1""",
            (card_id,),
        )
        destination = cur.fetchone()
        destination_sector = "RM"
        if not destination:
            cur.execute(
                """SELECT address,SUM(quantidade) qty FROM distrilog.card_allocations
                   WHERE card_id=%s AND setor='PR' AND active IS TRUE
                     AND COALESCE(allocation_purpose,'STOCK') <> 'TEN_PERCENT_SAMPLE'
                   GROUP BY address HAVING SUM(quantidade)>0
                   ORDER BY SUM(quantidade) DESC,address LIMIT 1""",
                (card_id,),
            )
            destination = cur.fetchone()
            destination_sector = "PR"
        if not destination:
            raise HTTPException(409, "Não foi encontrado um endereço do saldo em RM ou PR. Enderece o saldo do Card no Recebimento antes de concluir; a amostra será reunida automaticamente ao saldo nesse endereço.")
        sample_ids = [int(row["id"]) for row in samples]
        cur.execute("UPDATE distrilog.card_allocations SET active=FALSE WHERE card_id=%s AND id = ANY(%s) AND active IS TRUE", (card_id, sample_ids))
        address = str(destination["address"])
        cur.execute(
            """INSERT INTO distrilog.card_allocations(
                   card_id,setor,address,quantidade,responsavel,created_at,item_id,allocation_purpose
               ) VALUES(%s,%s,%s,%s,%s,%s,NULL,'TEN_PERCENT_SAMPLE')""",
            (card_id, destination_sector, address, sample_qty, "sistema", iso_now()),
        )
        con.commit()
        return {"sector": destination_sector, "address": address, "quantity": sample_qty}


def register_positions_routes(app: FastAPI) -> None:
    app.include_router(router)
