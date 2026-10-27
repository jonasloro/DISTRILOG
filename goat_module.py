from __future__ import annotations

import json
import uuid
import os
import re
import db
from datetime import datetime
from pathlib import Path
from typing import Any
from fastapi import APIRouter, FastAPI, File, HTTPException, UploadFile, Request
from openpyxl import load_workbook

from supabase_module import pg_connect

BASE_DIR = Path(__file__).resolve().parent
router = APIRouter(prefix="/api/goat", tags=["GOAT"])

def _authorize(request: Request, allowed: set[str]) -> None:
    role = getattr(request.state, "auth_role", None)
    if role not in allowed:
        raise HTTPException(403, "Seu perfil não pode executar esta operação.")


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
async def import_report(request: Request, file: UploadFile = File(...)) -> dict[str, Any]:
    _authorize(request, {"admin", "supervisor"})
    if not file.filename or not file.filename.endswith(".xlsx"):
        raise HTTPException(400, "Envie um arquivo .xlsx exportado do GOAT.")

    content = await file.read(25 * 1024 * 1024 + 1)
    if len(content) > 25 * 1024 * 1024:
        raise HTTPException(413, "O relatório deve ter até 25 MB.")
    tmp = BASE_DIR / f"_tmp_goat_{uuid.uuid4().hex}.xlsx"
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


def _create_manual_card(payload: dict[str, Any], *, allow_direct_sector: bool) -> dict[str, Any]:
    """Cria um Card com uma referência e grade; testes podem escolher setor inicial."""
    reference = str(payload.get("reference") or "").strip()
    supplier = str(payload.get("supplier") or "").strip()
    nf = str(payload.get("nf") or "").strip()
    lot = str(payload.get("lot") or "").strip()
    target_sector = (str(payload.get("target_sector") or "RECEBIMENTO").strip().upper() if allow_direct_sector else "RECEBIMENTO")
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

    # Consolidar linhas repetidas antes de persistir: a chave de origem identifica
    # uma combinação referência/cor/tamanho e não pode ser inserida duas vezes no mesmo Card.
    quantities_by_variant: dict[tuple[str, str], int] = {}
    total = 0
    for row in grade:
        if not isinstance(row, dict):
            raise HTTPException(400, "Cada linha da grade precisa conter cor, tamanho e quantidade.")
        color = str(row.get("color") or "").strip()
        size = str(row.get("size") or "").strip()
        try:
            raw_quantity = row.get("quantity")
            quantity = int(raw_quantity or 0)
            if str(raw_quantity or "0").strip() not in (str(quantity), f"{quantity}.0"):
                raise ValueError
        except (TypeError, ValueError):
            raise HTTPException(400, "As quantidades da grade precisam ser números inteiros.")
        if not color or not size:
            raise HTTPException(400, "Cada item da grade precisa ter cor e tamanho.")
        if quantity < 0:
            raise HTTPException(400, "As quantidades da grade não podem ser negativas.")
        if quantity:
            variant = (color, size)
            quantities_by_variant[variant] = quantities_by_variant.get(variant, 0) + quantity
            total += quantity

    normalized = [(color, size, quantity) for (color, size), quantity in quantities_by_variant.items()]
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
                total, source_notes + (f" | CARD DE TESTE | Setor inicial: {target_sector}" if allow_direct_sector else " | CRIAÇÃO OPERACIONAL | Fluxo normal de Recebimento"),
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
                (f"Card de teste criado diretamente em {target_sector}" if allow_direct_sector else "Card operacional criado no fluxo normal de Recebimento") + f" para a referência {reference}, com {total} peças. Fornecedor {supplier}."
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

 
@router.post("/create-card")
def create_manual_card(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    """Criação operacional: sempre inicia no Recebimento, sem atalhos entre setores."""
    _authorize(request, {"recebimento", "admin", "supervisor"})
    return _create_manual_card(payload, allow_direct_sector=False)


@router.post("/create-test-card")
def create_test_card(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    """Ferramenta de teste separada; permite iniciar diretamente em um setor."""
    _authorize(request, {"admin"})
    return _create_manual_card(payload, allow_direct_sector=True)

def register_goat_routes(app: FastAPI) -> None:
    init_goat_db()
    app.include_router(router)
# ==========================================
# TRATATIVA E CONFIRMAÇÃO DE RECEBIMENTO
# ==========================================

@router.post("/confirm-receiving")
def confirm_receiving(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    """Descontinuado: a rota antiga não executava a transação física do WMS."""
    _authorize(request, {"recebimento", "supervisor", "admin"})
    raise HTTPException(
        410,
        "Esta rota de recebimento foi substituída pelo fluxo de Recebimento e "
        "Endereçamento WMS do Card. Atualize a aplicação antes de continuar.",
    )
