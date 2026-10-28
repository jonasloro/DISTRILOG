"""Consultas auxiliares SOMENTE LEITURA para o Stock 3D.

As movimentações continuam sendo realizadas exclusivamente pelo WMS existente.
Este módulo não faz escrita, nem autoriza alocação com base em coordenadas 3D.
A sessão/identidade é verificada pelo middleware global de app.py.
"""
from __future__ import annotations

from fastapi import APIRouter, FastAPI, HTTPException, Query
from supabase_module import pg_connect

router = APIRouter(prefix="/api/stock3d", tags=["Stock 3D - Consulta"])


def reference_pattern(value: str) -> str:
    text = value.strip()
    if len(text) < 3 or len(text) > 64:
        raise HTTPException(422, "Pesquise com 3 a 64 caracteres.")
    # Escapar %, _ e barra para impedir que a busca textual vire wildcard.
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@router.get("/search")
def search_reference(reference: str = Query(min_length=3, max_length=64)) -> dict:
    """Encontrar endereços WMS com saldo ativo ligados à referência/SKU/Card."""
    pattern = reference_pattern(reference)
    try:
        with pg_connect() as con:
            with con.cursor() as cur:
                cur.execute(
                    """
                    SELECT DISTINCT a.address
                    FROM distrilog.card_allocations a
                    LEFT JOIN distrilog.items i ON i.id=a.item_id
                    LEFT JOIN distrilog.cards c ON c.id=a.card_id
                    WHERE a.active IS TRUE
                      AND (
                        i.reference ILIKE %s ESCAPE '\\'
                        OR i.sku ILIKE %s ESCAPE '\\'
                        OR c.purchase_id ILIKE %s ESCAPE '\\'
                      )
                    ORDER BY a.address ASC LIMIT 120
                    """,
                    (pattern, pattern, pattern),
                )
                rows = cur.fetchall()
    except RuntimeError as exc:
        raise HTTPException(503, "Conexão WMS indisponível.") from exc
    return {"addresses": [str(row["address"]) for row in rows]}


def register_stock3d_routes(app: FastAPI) -> None:
    app.include_router(router)
