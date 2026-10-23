from __future__ import annotations

import json
import os
import re
import db
from datetime import datetime
from pathlib import Path
from typing import Any
from fastapi import APIRouter, FastAPI, File, HTTPException, UploadFile
from openpyxl import load_workbook

from supabase_module import pg_connect

BASE_DIR = Path(__file__).resolve().parent
router = APIRouter(prefix="/api/goat", tags=["GOAT"])

SHEET_LABELS = {
    "Rejeitados": "Peças rejeitadas por lote/fornecedor",
    "Retrabalho": "Peças em retrabalho",
    "Perdas": "Perdas gerais de processo",
    "Desempenho de fornecedores": "Acompanhamento de entregas e atrasos por fornecedor",
    "Entregas atrasadas": "Lista de lotes com entrega em atraso",
    "Compra x recebido": "Divergências entre pedido de compra e físico recebido",
    "Estocagem x esperado": "Divergências no momento do endereçamento",
}


def db_connect() -> "db.Connection":
    """Conexão direta com o Supabase (pool)."""
    return db.connect()


def init_goat_db() -> None:
    try:
        with pg_connect() as con:
            with con.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS distrilog.goat_imports (
                        id SERIAL PRIMARY KEY,
                        filename TEXT,
                        sheets_count INTEGER,
                        rows_count INTEGER,
                        imported_at TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS distrilog.goat_records (
                        id SERIAL PRIMARY KEY,
                        sheet TEXT NOT NULL,
                        data TEXT NOT NULL,
                        imported_at TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_goat_records_sheet ON distrilog.goat_records(sheet);
                    """
                )
            con.commit()
    except Exception as e:
        print(f"[aviso] GOAT: não consegui preparar as tabelas no Supabase: {e}")


def _cell(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, (datetime,)):
        return v.isoformat()
    return str(v)


def _num(v: Any) -> float:
    if v is None:
        return 0.0
    try:
        s = str(v).replace("R$", "").replace(".", "").replace(",", ".").strip()
        return float(s)
    except ValueError:
        return 0.0


def _get_sheet_records(sheet_name: str) -> list[dict[str, Any]]:
    try:
        with pg_connect() as con:
            with con.cursor() as cur:
                cur.execute("SELECT data FROM distrilog.goat_records WHERE sheet=%s", (sheet_name,))
                rows = cur.fetchall()
    except Exception as e:
        print(f"[aviso] GOAT: não consegui ler a aba {sheet_name} no Supabase: {e}")
        return []
    res = []
    for r in rows:
        try:
            res.append(json.loads(r[0]))
        except Exception:
            pass
    return res


@router.post("/import")
async def import_report(file: UploadFile = File(...)) -> dict[str, Any]:
    if not file.filename or not file.filename.endswith(".xlsx"):
        raise HTTPException(400, "Envie um arquivo .xlsx exportado do GOAT.")

    content = await file.read()
    tmp = BASE_DIR / "_tmp_goat.xlsx"
    tmp.write_bytes(content)
    wb = load_workbook(tmp, read_only=True, data_only=True)

    now = datetime.now().replace(microsecond=0).isoformat()
    total_rows = 0

    try:
        with pg_connect() as con:
            with con.cursor() as cur:
                cur.execute("DELETE FROM distrilog.goat_records")
                for sheet_name in wb.sheetnames:
                    ws = wb[sheet_name]
                    rows_iter = ws.iter_rows(values_only=True)
                    headers = next(rows_iter, None)
                    if not headers:
                        continue
                    headers = [str(h).strip() if h else f"col{i}" for i, h in enumerate(headers)]
                    batch: list[tuple[str, str, str]] = []
                    for row in rows_iter:
                        if not any(v is not None for v in row):
                            continue
                        record = {headers[i]: _cell(row[i]) for i in range(min(len(headers), len(row)))}
                        batch.append((sheet_name, json.dumps(record, ensure_ascii=False), now))
                    if batch:
                        cur.executemany("INSERT INTO distrilog.goat_records(sheet,data,imported_at) VALUES(%s,%s,%s)", batch)
                        total_rows += len(batch)
                cur.execute(
                    "INSERT INTO distrilog.goat_imports(filename,sheets_count,rows_count,imported_at) VALUES(%s,%s,%s,%s)",
                    (file.filename, len(wb.sheetnames), total_rows, now),
                )
            con.commit()
    except Exception as e:
        print(f"[erro] GOAT: falha ao importar no Supabase: {e}")
        raise HTTPException(503, "Não foi possível salvar a importação do GOAT no Supabase. Tente novamente.") from e
    finally:
        if tmp.exists():
            tmp.unlink()

    return {"sheets": len(wb.sheetnames), "rows": total_rows, "imported_at": now}


@router.get("/status")
def status() -> dict[str, Any]:
    try:
        with pg_connect() as con:
            with con.cursor() as cur:
                cur.execute("SELECT id, filename, sheets_count, rows_count, imported_at FROM distrilog.goat_imports ORDER BY id DESC LIMIT 1")
                last = cur.fetchone()
                cur.execute("SELECT sheet, COUNT(*) FROM distrilog.goat_records GROUP BY sheet")
                sheets = cur.fetchall()

                last_dict = None
                if last:
                    last_dict = {
                        "id": last[0],
                        "filename": last[1],
                        "sheets_count": last[2],
                        "rows_count": last[3],
                        "imported_at": last[4],
                    }

                sheets_list = [{"sheet": s[0], "label": SHEET_LABELS.get(s[0], s[0]), "rows": s[1]} for s in sheets if s]
                return {"last_import": last_dict, "sheets": sheets_list}
    except Exception as e:
        print(f"[aviso] GOAT status error: {e}")
        return {"last_import": None, "sheets": []}


@router.get("/sheet/{sheet}")
def sheet_rows(sheet: str, limit: int = 100) -> dict[str, Any]:
    rows = _get_sheet_records(sheet)
    return {"sheet": sheet, "label": SHEET_LABELS.get(sheet, sheet), "total": len(rows), "rows": rows[: max(1, min(limit, 500))]}


@router.get("/summary")
def summary() -> dict[str, Any]:
    rejeitados = _get_sheet_records("Rejeitados")
    perdas = _get_sheet_records("Perdas")
    desempenho = _get_sheet_records("Desempenho de fornecedores")
    atrasadas = _get_sheet_records("Entregas atrasadas")
    divergencia_compra = _get_sheet_records("Compra x recebido")
    divergencia_estoque = _get_sheet_records("Estocagem x esperado")

    # Rejeitados por fornecedor
    por_fornecedor: dict[str, dict[str, Any]] = {}
    for r in rejeitados:
        if isinstance(r, dict):
            forn = r.get("Fornecedor") or "—"
            entry = por_fornecedor.setdefault(forn, {"name": forn, "pecas": 0, "valor": 0.0})
            entry["pecas"] += int(_num(r.get("Peças")))
            entry["valor"] += _num(r.get("Valor"))
    top_rejeitados = sorted(por_fornecedor.values(), key=lambda x: -x["pecas"])[:8]

    # Perdas por responsável
    por_responsavel: dict[str, dict[str, Any]] = {}
    for r in perdas:
        if isinstance(r, dict):
            quem = r.get("Quem") or "—"
            entry = por_responsavel.setdefault(quem, {"name": quem, "pecas": 0})
            entry["pecas"] += int(_num(r.get("Peças")))
    top_perdas = sorted(por_responsavel.values(), key=lambda x: -x["pecas"])[:8]

    # Fornecedores críticos (desempenho)
    desempenho_filtrado = [d for d in desempenho if isinstance(d, dict)]
    top_desempenho = sorted(desempenho_filtrado, key=lambda x: -_num(x.get("Atrasadas hoje")) if isinstance(x, dict) else 0)[:8]

    fornecedores_criticos = [
        {
            "name": d.get("Fornecedor") or "—",
            "atrasadas_hoje": int(_num(d.get("Atrasadas hoje"))),
            "acerto_pct": _num(d.get("Acerto da data (%)")),
        }
        for d in top_desempenho
    ]

    # Retorna exatamente as chaves esperadas por: renderGoatIndicators()
    return {
        "totals": {
            "rejeitados_pecas": sum(int(_num(r.get("Peças"))) for r in rejeitados if isinstance(r, dict)),
            "rejeitados_valor": sum(_num(r.get("Valor")) for r in rejeitados if isinstance(r, dict)),
            "perdas_pecas": sum(int(_num(r.get("Peças"))) for r in perdas if isinstance(r, dict)),
            "entregas_atrasadas": len(atrasadas),
            "divergencias_compra": len(divergencia_compra),
            "divergencias_estoque": len(divergencia_estoque),
        },
        "top_rejeitados_fornecedor": top_rejeitados,
        "top_perdas_responsavel": top_perdas,
        "fornecedores_criticos": fornecedores_criticos,
    }


def _manual_card_purchase_id(reference: str) -> str:
    """Gera identificador técnico único para cards criados manualmente."""
    stamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    return f"MANUAL-{stamp}-{abs(hash(reference)) % 10000:04d}"


@router.post("/parse-card")
def parse_manual_card_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
    """Valida dados manuais da grade; não interpreta texto copiado."""
    reference = str(payload.get("reference") or "").strip()
    grade = payload.get("grade") or []
    if not reference:
        raise HTTPException(400, "Informe a referência.")
    if not isinstance(grade, list) or not grade:
        raise HTTPException(400, "Informe a grade da referência.")
    normalized=[]; total=0
    for row in grade:
        color=str(row.get("color") or "").strip(); size=str(row.get("size") or "").strip()
        try: quantity=int(row.get("quantity") or 0)
        except (TypeError,ValueError): raise HTTPException(400,"As quantidades da grade precisam ser números inteiros.")
        if not color or not size: raise HTTPException(400,"Cada item da grade precisa ter cor e tamanho.")
        if quantity < 0: raise HTTPException(400,"As quantidades da grade não podem ser negativas.")
        if quantity: normalized.append({"color":color,"size":size,"quantity":quantity}); total += quantity
    if total <= 0: raise HTTPException(400,"A grade precisa ter pelo menos uma quantidade maior que zero.")
    return {"reference":reference,"grade":normalized,"expected_total":total}


def _iso_now() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


@router.post("/create-card")
def create_manual_card(payload: dict[str, Any]) -> dict[str, Any]:
    """Cria um Card manual: uma única referência com uma grade dinâmica."""
    reference = str(payload.get("reference") or "").strip()
    supplier = str(payload.get("supplier") or "").strip()
    nf = str(payload.get("nf") or "").strip()
    lot = str(payload.get("lot") or "").strip()
    target_sector = str(payload.get("target_sector") or "RECEBIMENTO").strip().upper()
    sector_config = {
        "RECEBIMENTO": ("RECEBIMENTO", "EM_TRANSITO", "TRANSITO"),
        "QUALIDADE": ("QUALIDADE", "AGUARDANDO_INSPECAO", "QUALIDADE"),
        "PROCESSAMENTO": ("PROCESSAMENTO", "AGUARDANDO_TRIAGEM", "PROCESSAMENTO"),
        "ETIQUETAGEM": ("ETIQUETAGEM", "AGUARDANDO_ETIQUETAGEM", "ETIQUETAGEM"),
        "ESTOCAGEM": ("ESTOCAGEM", "AGUARDANDO_ESTOCAGEM", "ESTOCAGEM"),
        "COSTURA": ("COSTURA", "AGUARDANDO_COSTURA", "COSTURA"),
    }
    if target_sector not in sector_config:
        raise HTTPException(400, "Setor de teste inválido.")
    current_sector, initial_status, source_stage = sector_config[target_sector]
    grade = payload.get("grade") or []

    if not reference:
        raise HTTPException(400, "Informe a referência.")
    if not supplier:
        raise HTTPException(400, "Informe o fornecedor.")
    if not isinstance(grade, list) or not grade:
        raise HTTPException(400, "Informe a grade da referência.")

    normalized = []
    total = 0
    for row in grade:
        color = str(row.get("color") or "").strip()
        size = str(row.get("size") or "").strip()
        try:
            quantity = int(row.get("quantity") or 0)
        except (TypeError, ValueError):
            raise HTTPException(400, "As quantidades da grade precisam ser números inteiros.")
        if not color or not size:
            raise HTTPException(400, "Cada item da grade precisa ter cor e tamanho.")
        if quantity < 0:
            raise HTTPException(400, "As quantidades da grade não podem ser negativas.")
        if quantity:
            normalized.append((color, size, quantity))
            total += quantity

    if total <= 0:
        raise HTTPException(400, "A grade precisa ter pelo menos uma quantidade maior que zero.")

    now = _iso_now()
    purchase_id = _manual_card_purchase_id(reference)
    source_notes = f"Referência criada manualmente: {reference}"
    source_notes += f" | Fornecedor: {supplier}"
    if nf:
        source_notes += f" | NF: {nf}"
    if lot:
        source_notes += f" | Lote: {lot}"

    con = db_connect()
    try:
        con.execute("PRAGMA foreign_keys=ON")
        cur = con.execute(
            """INSERT INTO cards(
                purchase_id,source_created_date,supplier,original_type,purchase_mode,status_compra,
                qtd_itens,source_notes,current_sector,status,receiving_type,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                purchase_id, now[:10], supplier, "Grade", "GRADE",
                "Em Trânsito" if target_sector == "RECEBIMENTO" else "Teste",
                total, source_notes + f" | CARD DE TESTE | Setor inicial: {target_sector}",
                current_sector, initial_status, "NOVA", now, now
            ),
        )
        card_id = cur.lastrowid

        for color, size, quantity in normalized:
            con.execute(
                """INSERT INTO items(
                    card_id,source_key,product,reference,sku,color,size,lot,nf,expected_qty,
                    status_kanban,source_stage,source_status_purchase
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    card_id, f"{purchase_id}|{reference}|{color}|{size}",
                    reference, reference, "", color, size, lot, nf, quantity,
                    "1.3 Compras - Em Trânsito" if target_sector == "RECEBIMENTO" else "TESTE - " + target_sector,
                    source_stage, "Teste" if target_sector != "RECEBIMENTO" else "Em Trânsito",
                ),
            )

        con.execute(
            "INSERT INTO history(card_id,user_id,event_type,description,created_at) VALUES(?,?,?,?,?)",
            (
                card_id, None, "CRIACAO_MANUAL",
                f"Card de teste criado diretamente em {target_sector} para a referência {reference}, com {total} peças. Fornecedor {supplier}."
                + (f" NF {nf}." if nf else "")
                + (f" Lote {lot}." if lot else ""),
                now,
            ),
        )
        con.commit()
    finally:
        con.close()

    return {
        "card_id": card_id,
        "purchase_id": purchase_id,
        "target_sector": target_sector,
        "reference": reference,
        "supplier": supplier,
        "nf": nf,
        "lot": lot,
        "grade": [{"color": c, "size": s, "quantity": q} for c, s, q in normalized],
        "expected_total": total,
    }

def register_goat_routes(app: FastAPI) -> None:
    init_goat_db()
    app.include_router(router)
# ==========================================
# TRATATIVA E CONFIRMAÇÃO DE RECEBIMENTO
# ==========================================

@router.post("/confirm-receiving")
def confirm_receiving(payload: dict[str, Any]) -> dict[str, Any]:
    """Confirma o recebimento físico de um card: volumes, peças, casulo e tratativa."""
    card_id = payload.get("id") or payload.get("item_id") or payload.get("card_id")
    casulo = str(payload.get("casulo") or "").strip().upper()
    if not card_id:
        raise HTTPException(400, "ID do card é obrigatório.")
    if not casulo:
        raise HTTPException(400, "Informe o casulo de destino.")
    try:
        card_id = int(card_id)
        vol = int(payload.get("qtd_volumes") or 0)
        pecas = int(payload.get("qtd_pecas") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "Volumes, peças e ID precisam ser números.")
    status = str(payload.get("status_conferencia") or "Conforme")
    obs = str(payload.get("observacao") or "").strip()
    now = _iso_now()
    con = db_connect()
    try:
        con.execute("PRAGMA foreign_keys=ON")
        if not con.execute("SELECT 1 FROM cards WHERE id=?", (card_id,)).fetchone():
            raise HTTPException(404, "Card não encontrado.")
        rec = con.execute(
            "SELECT id FROM receivings WHERE card_id=? AND closed_at IS NULL ORDER BY id DESC LIMIT 1", (card_id,)
        ).fetchone()
        note = f"[{status}] {obs}".strip()
        if rec:
            con.execute("UPDATE receivings SET volumes=?, received_qty=?, notes=? WHERE id=?", (vol, pecas, note, rec["id"]))
        else:
            con.execute(
                "INSERT INTO receivings(card_id,receiving_type,volumes,received_qty,notes,created_at) VALUES(?,?,?,?,?,?)",
                (card_id, "NOVA", vol, pecas, note, now),
            )
        con.execute("UPDATE cards SET casulo_current=?, updated_at=? WHERE id=?", (casulo, now, card_id))
        con.execute(
            "INSERT INTO history(card_id,user_id,event_type,description,created_at) VALUES(?,?,?,?,?)",
            (card_id, None, "CONFERENCIA", f"Conferência {status}: {pecas} peças, {vol} volumes, casulo {casulo}. {obs}".strip(), now),
        )
        con.commit()
    finally:
        con.close()
    return {"success": True, "message": f"Card alocado no casulo {casulo} com sucesso!", "casulo": casulo, "status": status}
