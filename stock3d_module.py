"""Stock 3D — shared private model, calibrated WMS anchors and read-only navigation.

The GLB is stored gzip-compressed in the existing Supabase PostgreSQL database,
never in Render's ephemeral filesystem nor in the public GitHub repository.
All API routes are protected by the app's existing session middleware.
Only admins can publish geometry or change physical anchors. WMS data is
always read from the existing authoritative allocation tables.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import struct
import zlib
from pathlib import PurePath

from fastapi import APIRouter, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from supabase_module import pg_connect

router = APIRouter(prefix="/api/stock3d", tags=["Stock 3D - Consulta"])
MAX_MODEL_BYTES = 45 * 1024 * 1024
ADDRESS_PATTERN = re.compile(r"^\d+(?:RM|QA|PR)\d{2}[A-C]$|^\d+(?:ET|EC)\d{2}$")


def init_stock3d_db() -> None:
    """Idempotent private data structures; no direct Data API grants."""
    with pg_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS distrilog.stock3d_model (
                    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id=1),
                    filename TEXT NOT NULL,
                    sha256 CHAR(64) NOT NULL,
                    raw_bytes INTEGER NOT NULL CHECK(raw_bytes BETWEEN 20 AND 47185920),
                    gzip_content BYTEA NOT NULL,
                    uploaded_by BIGINT NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS distrilog.stock3d_anchors (
                    model_sha256 CHAR(64) NOT NULL,
                    address TEXT NOT NULL,
                    x DOUBLE PRECISION NOT NULL,
                    y DOUBLE PRECISION NOT NULL,
                    z DOUBLE PRECISION NOT NULL,
                    updated_by BIGINT NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    PRIMARY KEY (model_sha256, address),
                    CHECK(abs(x)<10000000 AND abs(y)<10000000 AND abs(z)<10000000)
                )
            """)
            cur.execute("ALTER TABLE distrilog.stock3d_model ENABLE ROW LEVEL SECURITY")
            cur.execute("ALTER TABLE distrilog.stock3d_anchors ENABLE ROW LEVEL SECURITY")
            cur.execute("REVOKE ALL ON distrilog.stock3d_model FROM PUBLIC, anon, authenticated")
            cur.execute("REVOKE ALL ON distrilog.stock3d_anchors FROM PUBLIC, anon, authenticated")
        conn.commit()


def _admin(request: Request) -> int:
    if getattr(request.state, "auth_role", None) != "admin":
        raise HTTPException(403, "Somente administradores podem publicar o modelo ou calibrar endereços 3D.")
    return int(request.state.auth_user_id)


def _current_model(cur):
    cur.execute("SELECT filename,sha256,raw_bytes,updated_at FROM distrilog.stock3d_model WHERE id=1")
    return cur.fetchone()


def _validate_glb(raw: bytes) -> None:
    if len(raw) < 20:
        raise HTTPException(422, "Arquivo GLB incompleto.")
    magic, version, declared = struct.unpack_from("<III", raw, 0)
    if magic != 0x46546C67 or version != 2 or declared != len(raw):
        raise HTTPException(422, "Arquivo GLB inválido: cabeçalho, versão ou comprimento incorreto.")
    chunk_len, chunk_type = struct.unpack_from("<II", raw, 12)
    if chunk_type != 0x4E4F534A or chunk_len < 2 or chunk_len > 20 * 1024 * 1024 or 20 + chunk_len > len(raw):
        raise HTTPException(422, "Arquivo GLB não contém JSON válido.")
    try:
        document = json.loads(raw[20:20 + chunk_len].decode("utf-8"))
    except (ValueError, UnicodeError):
        raise HTTPException(422, "Metadados GLB inválidos.") from None
    if not isinstance(document, dict) or not isinstance(document.get("asset"), dict):
        raise HTTPException(422, "Estrutura glTF inválida.")
    # Never load remote references embedded inside a private GLB.
    for kind in ("buffers", "images"):
        for entry in document.get(kind, []):
            if not isinstance(entry, dict):
                raise HTTPException(422, "Recurso GLB inválido.")
            uri = entry.get("uri")
            if uri is not None and (not isinstance(uri, str) or not uri.startswith("data:")):
                raise HTTPException(422, "O GLB deve ser autocontido, sem arquivos ou URLs externos.")


@router.get("/model")
def model_metadata(request: Request) -> dict:
    with pg_connect() as conn:
        with conn.cursor() as cur:
            row = _current_model(cur)
    if not row:
        return {"available": False, "can_manage": request.state.auth_role == "admin"}
    return {
        "available": True, "filename": row["filename"], "sha256": row["sha256"].strip(),
        "bytes": int(row["raw_bytes"]), "updated_at": row["updated_at"].isoformat(),
        "can_manage": request.state.auth_role == "admin",
    }


@router.get("/model/glb")
def download_model(request: Request):
    with pg_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT sha256,gzip_content FROM distrilog.stock3d_model WHERE id=1")
            row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Modelo 3D ainda não foi publicado pela gestão.")
    tag = '"' + row["sha256"].strip() + '"'
    headers = {
        "ETag": tag,
        "Cache-Control": "private, max-age=3600",
        "Content-Encoding": "gzip",
        "X-Content-Type-Options": "nosniff",
    }
    if request.headers.get("if-none-match") == tag:
        headers.pop("Content-Encoding")
        return Response(status_code=304, headers=headers)
    return Response(content=bytes(row["gzip_content"]), media_type="model/gltf-binary", headers=headers)


@router.post("/model")
async def publish_model(request: Request, file: UploadFile = File(...)) -> dict:
    actor = _admin(request)
    name = str(file.filename or "").replace("\\", "/").split("/")[-1].strip()
    if not name.lower().endswith(".glb") or not 1 <= len(name) <= 160:
        raise HTTPException(415, "Envie um modelo .glb com nome válido.")
    raw = await file.read(MAX_MODEL_BYTES + 1)
    await file.close()
    if not 20 <= len(raw) <= MAX_MODEL_BYTES:
        raise HTTPException(413, "Modelo vazio ou maior que 45 MB.")
    _validate_glb(raw)
    digest = hashlib.sha256(raw).hexdigest()
    compressed = zlib.compress(raw, level=8, wbits=31)
    with pg_connect() as conn:
        with conn.cursor() as cur:
            previous = _current_model(cur)
            if previous and previous["sha256"].strip() == digest:
                return {"ok": True, "unchanged": True, "sha256": digest}
            cur.execute("""
                INSERT INTO distrilog.stock3d_model(id,filename,sha256,raw_bytes,gzip_content,uploaded_by)
                VALUES (1,%s,%s,%s,%s,%s)
                ON CONFLICT(id) DO UPDATE SET
                  filename=EXCLUDED.filename, sha256=EXCLUDED.sha256,
                  raw_bytes=EXCLUDED.raw_bytes, gzip_content=EXCLUDED.gzip_content,
                  uploaded_by=EXCLUDED.uploaded_by, updated_at=now()
            """, (name, digest, len(raw), compressed, actor))
        conn.commit()
    return {"ok": True, "unchanged": False, "sha256": digest,
            "bytes": len(raw), "stored_bytes": len(compressed)}


def _model_hash(cur) -> str:
    row = _current_model(cur)
    if not row:
        raise HTTPException(409, "Publique primeiro o modelo 3D.")
    return row["sha256"].strip()


def _valid_address(address: str) -> str:
    address = address.strip().upper()
    if len(address) > 20 or not ADDRESS_PATTERN.fullmatch(address):
        raise HTTPException(422, "Endereço WMS inválido.")
    return address


def _valid_point(point) -> list[float]:
    if (not isinstance(point, list) or len(point) != 3
        or any(type(n) not in (float, int) or not math.isfinite(n) or abs(n) >= 10000000 for n in point)):
        raise HTTPException(422, "Coordenadas 3D inválidas.")
    return [float(n) for n in point]


@router.get("/anchors")
def shared_anchors() -> dict:
    with pg_connect() as conn:
        with conn.cursor() as cur:
            current = _current_model(cur)
            if not current:
                return {"model_sha256": None, "anchors": {}}
            digest = current["sha256"].strip()
            cur.execute("SELECT address,x,y,z FROM distrilog.stock3d_anchors WHERE model_sha256=%s", (digest,))
            rows = cur.fetchall()
    return {"model_sha256": digest, "anchors": {
        row["address"]: [float(row["x"]), float(row["y"]), float(row["z"])] for row in rows
    }}


@router.put("/anchors/{address}")
def set_anchor(address: str, payload: dict, request: Request) -> dict:
    actor = _admin(request)
    address = _valid_address(address)
    point = _valid_point(payload.get("point"))
    with pg_connect() as conn:
        with conn.cursor() as cur:
            digest = _model_hash(cur)
            if payload.get("model_sha256") != digest:
                raise HTTPException(409, "O modelo foi atualizado. Recarregue a tela antes de calibrar.")
            cur.execute("SELECT 1 FROM distrilog.sector_positions WHERE address=%s", (address,))
            if not cur.fetchone():
                raise HTTPException(404, "Este endereço não existe no WMS.")
            cur.execute("""
                INSERT INTO distrilog.stock3d_anchors(model_sha256,address,x,y,z,updated_by)
                VALUES(%s,%s,%s,%s,%s,%s)
                ON CONFLICT (model_sha256,address) DO UPDATE SET
                  x=EXCLUDED.x,y=EXCLUDED.y,z=EXCLUDED.z,
                  updated_by=EXCLUDED.updated_by,updated_at=now()
            """, (digest, address, *point, actor))
        conn.commit()
    return {"ok": True, "address": address, "point": point}


@router.delete("/anchors/{address}")
def remove_anchor(address: str, request: Request, model_sha256: str = Query(min_length=64, max_length=64)) -> dict:
    _admin(request)
    address = _valid_address(address)
    with pg_connect() as conn:
        with conn.cursor() as cur:
            digest = _model_hash(cur)
            if model_sha256 != digest:
                raise HTTPException(409, "O modelo foi atualizado. Recarregue o Stock 3D.")
            cur.execute("DELETE FROM distrilog.stock3d_anchors WHERE model_sha256=%s AND address=%s",
                        (digest, address))
        conn.commit()
    return {"ok": True}


@router.post("/anchors/import")
def import_anchors(payload: dict, request: Request) -> dict:
    actor = _admin(request)
    anchors = payload.get("anchors")
    if not isinstance(anchors, dict) or not 1 <= len(anchors) <= 1000:
        raise HTTPException(422, "Envie entre 1 e 1000 vínculos válidos.")
    validated = [(_valid_address(a), *_valid_point(p)) for a, p in anchors.items()]
    if len({item[0] for item in validated}) != len(validated):
        raise HTTPException(422, "Endereços duplicados.")
    with pg_connect() as conn:
        with conn.cursor() as cur:
            digest = _model_hash(cur)
            if payload.get("model_sha256") != digest:
                raise HTTPException(409, "Os vínculos pertencem a outro modelo 3D.")
            cur.execute("SELECT address FROM distrilog.sector_positions WHERE address=ANY(%s)",
                        ([x[0] for x in validated],))
            found = {row["address"] for row in cur.fetchall()}
            if found != {x[0] for x in validated}:
                raise HTTPException(422, "Um dos vínculos aponta para um endereço WMS inexistente.")
            cur.executemany("""
                INSERT INTO distrilog.stock3d_anchors(model_sha256,address,x,y,z,updated_by)
                VALUES(%s,%s,%s,%s,%s,%s)
                ON CONFLICT(model_sha256,address) DO UPDATE SET
                  x=EXCLUDED.x,y=EXCLUDED.y,z=EXCLUDED.z,
                  updated_by=EXCLUDED.updated_by,updated_at=now()
            """, [(digest,*item,actor) for item in validated])
        conn.commit()
    return {"ok": True, "count": len(validated)}


def reference_pattern(value: str) -> str:
    text = value.strip()
    if len(text) < 3 or len(text) > 64:
        raise HTTPException(422, "Pesquise com 3 a 64 caracteres.")
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@router.get("/search")
def search_reference(reference: str = Query(min_length=3, max_length=64)) -> dict:
    pattern = reference_pattern(reference)
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT a.address FROM distrilog.card_allocations a
                LEFT JOIN distrilog.items i ON i.id=a.item_id
                LEFT JOIN distrilog.cards c ON c.id=a.card_id
                WHERE a.active IS TRUE AND (
                    i.reference ILIKE %s ESCAPE '\\'
                    OR i.sku ILIKE %s ESCAPE '\\'
                    OR c.purchase_id ILIKE %s ESCAPE '\\'
                )
                ORDER BY a.address ASC LIMIT 120
            """, (pattern, pattern, pattern))
            rows = cur.fetchall()
    return {"addresses": [str(row["address"]) for row in rows]}


@router.get("/cards/{card_id}/locations")
def card_locations(card_id: int, reference: str = Query(default="", max_length=64)) -> dict:
    """Only currently active WMS allocations; no cached card address field."""
    if card_id <= 0:
        raise HTTPException(422, "Card inválido.")
    ref = reference.strip().lower()
    with pg_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM distrilog.cards WHERE id=%s", (card_id,))
            if not cur.fetchone():
                raise HTTPException(404, "Card não encontrado.")
            sql = """
                SELECT a.address,a.setor,
                    SUM(CASE WHEN a.setor IN ('ET','EC') THEN COALESCE(a.box_count,0)
                             ELSE COALESCE(a.quantidade,0) END) AS quantity
                FROM distrilog.card_allocations a
                LEFT JOIN distrilog.items i ON i.id=a.item_id
                WHERE a.card_id=%s AND a.active IS TRUE
            """
            params: list = [card_id]
            if ref:
                sql += " AND (LOWER(TRIM(COALESCE(i.reference,'')))=%s OR LOWER(TRIM(COALESCE(i.sku,'')))=%s)"
                params.extend([ref,ref])
            sql += " GROUP BY a.address,a.setor ORDER BY a.address LIMIT 300"
            cur.execute(sql, params)
            rows = cur.fetchall()
    return {"card_id": card_id, "reference": reference, "locations": [
        {"address": r["address"], "setor": r["setor"], "quantity": int(r["quantity"] or 0)}
        for r in rows
    ]}


def register_stock3d_routes(app: FastAPI) -> None:
    app.include_router(router)
