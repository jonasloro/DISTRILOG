"""Impressão oficial de etiquetas Rack para DISTRILOG Web e Android.

Documento A4 (duas etiquetas por folha). QR e Code128 contêm exatamente
RACK-<card_id>, aceito pelo leitor do aplicativo móvel. Dados são recuperados
do banco em cada impressão, não confiados ao cliente.
"""
from __future__ import annotations

from io import BytesIO
from typing import Callable

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas
from reportlab.graphics.barcode import code128
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.graphics import renderPDF

import db

router = APIRouter(prefix="/api/racks", tags=["Etiquetas Rack"])
PRINT_ROLES = frozenset({
    "admin", "supervisor", "recebimento", "qualidade",
    "processamento", "etiquetagem", "estocagem",
})
PAGE_W, PAGE_H = A4
LABEL_WIDTH = PAGE_W - 14 * mm
LABEL_HEIGHT = PAGE_H / 2 - 12 * mm


def rack_code(card_id: int) -> str:
    if not isinstance(card_id, int) or isinstance(card_id, bool) or card_id <= 0:
        raise ValueError("Card inválido.")
    return f"RACK-{card_id}"


def _fit(value: object, font: str, size: int, max_width: float) -> str:
    text = str(value or "—").replace("\n", " ").replace("\r", " ").strip()
    if pdfmetrics.stringWidth(text, font, size) <= max_width:
        return text
    while text and pdfmetrics.stringWidth(text + "...", font, size) > max_width:
        text = text[:-1]
    return text + "..." if text else "..."


def _label(pdf: canvas.Canvas, card: dict, y: float) -> None:
    x = 7 * mm
    w, h = LABEL_WIDTH, LABEL_HEIGHT
    code = rack_code(int(card["id"]))
    pdf.setLineWidth(0.85)
    pdf.setStrokeColor(colors.HexColor("#34383D"))
    pdf.roundRect(x, y, w, h, 3 * mm, stroke=1, fill=0)
    # No fundo preto, a identidade fica em destaque e a etiqueta mantém
    # contraste na impressora térmica ou laser monocromática.
    pdf.setFillColor(colors.HexColor("#171D22"))
    pdf.roundRect(x + 0.7 * mm, y + h - 24 * mm, w - 1.4 * mm, 23.3 * mm,
                  2.3 * mm, stroke=0, fill=1)
    pdf.setFillColor(colors.white)
    pdf.setFont("Helvetica-Bold", 19)
    pdf.drawString(x + 7 * mm, y + h - 12.5 * mm, "DISTRILOG")
    pdf.setFont("Helvetica", 9)
    pdf.drawString(x + 7 * mm, y + h - 19 * mm, "ETIQUETA DE IDENTIFICACAO DE RACK")
    pdf.setFont("Helvetica-Bold", 15)
    pdf.drawRightString(x + w - 7 * mm, y + h - 14 * mm, code)

    # Código nativo do leitor móvel; não cria IDs de Rack independentes.
    qr = QrCodeWidget(code)
    bounds = qr.getBounds()
    side = 40 * mm
    qr_draw = Drawing(side, side, transform=[
        side / (bounds[2] - bounds[0]), 0, 0,
        side / (bounds[3] - bounds[1]), 0, 0,
    ])
    qr_draw.add(qr)
    renderPDF.draw(qr_draw, pdf, x + w - 51 * mm, y + 46 * mm)

    left = x + 7 * mm
    text_right = w - 66 * mm
    def line(label: str, value: object, yy: float, large: bool = False) -> None:
        pdf.setFillColor(colors.HexColor("#5D6770"))
        pdf.setFont("Helvetica-Bold", 8)
        pdf.drawString(left, y + yy * mm, label)
        pdf.setFillColor(colors.HexColor("#16191D"))
        font_size = 13 if large else 10
        pdf.setFont("Helvetica-Bold" if large else "Helvetica", font_size)
        pdf.drawString(left, y + (yy - 6) * mm,
                       _fit(value, "Helvetica-Bold" if large else "Helvetica",
                            font_size, text_right))

    line("REFERENCIA", card["reference"], 98, large=True)
    line("FORNECEDOR / MARCA", card.get("supplier_or_brand"), 79)
    line("NOTA FISCAL", card.get("nf"), 63)
    line("LOTE", card.get("lot"), 48)
    line("COMPRA", card.get("purchase_id"), 34)

    # Quantidade prevista vem da soma do cadastro original dos itens.
    # Não representa volumes, quantidade recebida nem saldo WMS.
    pdf.setFillColor(colors.HexColor("#EEF2F2"))
    pdf.roundRect(x + w - 55 * mm, y + 9 * mm, 48 * mm, 31 * mm, 2 * mm, stroke=0, fill=1)
    pdf.setFillColor(colors.HexColor("#47505B"))
    pdf.setFont("Helvetica-Bold", 8)
    pdf.drawCentredString(x + w - 31 * mm, y + 31 * mm, "PECAS PREVISTAS")
    pdf.setFillColor(colors.black)
    pdf.setFont("Helvetica-Bold", 22)
    pdf.drawCentredString(x + w - 31 * mm, y + 17 * mm,
                          f"{card['expected_qty']:,}".replace(",", "."))
    pdf.setFont("Helvetica", 8)
    pdf.drawCentredString(x + w - 31 * mm, y + 11.5 * mm,
                          f"{card['item_lines']} itens na grade")

    barcode = code128.Code128(code, barWidth=0.40 * mm, barHeight=13 * mm,
                              humanReadable=False)
    barcode_x = left + max(0, (text_right - barcode.width) / 2)
    barcode.drawOn(pdf, barcode_x, y + 12 * mm)
    pdf.setFont("Helvetica-Bold", 10)
    pdf.setFillColor(colors.black)
    pdf.drawCentredString(barcode_x + barcode.width / 2, y + 8 * mm, code)


def build_rack_pdf(card: dict, copies: int = 2) -> bytes:
    if copies not in (1, 2) or isinstance(copies, bool):
        raise ValueError("Use uma ou duas etiquetas.")
    data = dict(card)
    rack_code(int(data["id"]))
    if int(data["expected_qty"]) < 0 or int(data["item_lines"]) < 0:
        raise ValueError("Quantidades inválidas.")
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4, pageCompression=1)
    pdf.setTitle(f"DISTRILOG — {rack_code(int(data['id']))}")
    pdf.setAuthor("DISTRILOG")
    pdf.setSubject("Etiqueta para identificação física do Card")
    # Cada etiqueta ocupa meia folha A4, inclusive ao imprimir duas cópias.
    for row in range(copies):
        y = PAGE_H / 2 + 6 * mm if row == 0 else 6 * mm
        _label(pdf, data, y)
    pdf.setStrokeColor(colors.HexColor("#B8BFC4"))
    pdf.setDash(3, 3)
    pdf.line(5 * mm, PAGE_H / 2, PAGE_W - 5 * mm, PAGE_H / 2)
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def _card_data(con, card_id: int, *, is_awaiting_arrival: Callable) -> dict:
    row = con.execute(
        """SELECT id,purchase_id,supplier,brand,source_notes,current_sector,status
           FROM cards WHERE id=?""", (card_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Card não encontrado.")
    if is_awaiting_arrival(con, card_id):
        raise HTTPException(
            409, "Confirme a chegada do Card no Recebimento antes de imprimir sua Rack."
        )
    items = con.execute(
        """SELECT reference,product,nf,lot,expected_qty
           FROM items WHERE card_id=? ORDER BY id""", (card_id,)
    ).fetchall()
    if not items:
        raise HTTPException(409, "Este Card ainda não possui itens cadastrados.")
    qty = sum(int(item["expected_qty"] or 0) for item in items)
    if qty <= 0:
        raise HTTPException(409, "Este Card não possui peças previstas para identificação.")
    first_reference = next(
        (str(item["reference"]).strip() for item in items if item["reference"]), ""
    )
    if not first_reference:
        marker = "Referência criada manualmente:"
        notes = str(row["source_notes"] or "")
        first_reference = notes.split(marker, 1)[1].split(" | ", 1)[0].strip() if marker in notes else ""
    reference = first_reference or next(
        (str(item["product"]).strip() for item in items if item["product"]), "Não informada"
    )
    values = lambda field: " / ".join(dict.fromkeys(
        str(item[field]).strip() for item in items if item[field] and str(item[field]).strip()
    ))
    return {
        "id": int(row["id"]),
        "purchase_id": str(row["purchase_id"] or "—"),
        "reference": reference,
        "supplier_or_brand": " / ".join(
            p for p in (row["supplier"], row["brand"]) if p
        ) or "—",
        "nf": values("nf") or "—",
        "lot": values("lot") or "—",
        "expected_qty": qty,
        "item_lines": len(items),
    }


def register_rack_routes(app, is_awaiting_arrival: Callable) -> None:
    @router.get("/cards/{card_id}.pdf")
    def rack_pdf(card_id: int, request: Request, copies: int = 2):
        if getattr(request.state, "auth_role", None) not in PRINT_ROLES:
            raise HTTPException(403, "Seu perfil não possui permissão para imprimir Racks.")
        if copies not in (1, 2):
            raise HTTPException(422, "É permitido imprimir uma ou duas etiquetas.")
        with db.connect() as con:
            card = _card_data(con, card_id, is_awaiting_arrival=is_awaiting_arrival)
        pdf = build_rack_pdf(card, copies)
        return Response(
            content=pdf, media_type="application/pdf",
            headers={
                "Content-Disposition": f'inline; filename="rack-{card_id}.pdf"',
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; sandbox",
            },
        )
    app.include_router(router)
