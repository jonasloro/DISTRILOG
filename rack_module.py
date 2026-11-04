"""Impressão oficial de etiquetas Rack para DISTRILOG Web e Android.

Etiqueta térmica 100 x 85 mm (uma etiqueta por página). QR e Code128 contêm exatamente
RACK-<card_id>, aceito pelo leitor do aplicativo móvel. Dados são recuperados
do banco em cada impressão, não confiados ao cliente.
"""
from __future__ import annotations

from io import BytesIO
from typing import Callable

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from reportlab.lib import colors
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
PAGE_W, PAGE_H = 100 * mm, 85 * mm
LABEL_WIDTH, LABEL_HEIGHT = PAGE_W, PAGE_H


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


def _label(pdf: canvas.Canvas, card: dict) -> None:
    """Desenho vetorial monocromático, com área útil de 94 x 79 mm.

    Sem escalonamento automático: driver da L42 Pro Full deve usar
    papel 100 x 85 mm / tamanho real. QR tem 28 mm (~224 pontos a 203 dpi).
    """
    code = rack_code(int(card["id"]))
    border = 3 * mm
    pdf.setStrokeColor(colors.black)
    pdf.setLineWidth(0.5)
    pdf.rect(border, border, PAGE_W - 2*border, PAGE_H - 2*border, stroke=1, fill=0)
    pdf.setFillColor(colors.black)
    pdf.setFont("Helvetica-Bold", 12)
    pdf.drawString(5*mm, 74*mm, "DISTRILOG")
    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawRightString(95*mm, 74*mm, code)
    pdf.setLineWidth(0.55)
    pdf.line(5*mm, 70*mm, 95*mm, 70*mm)

    def info(label: str, value: object, baseline_mm: float, big: bool = False) -> None:
        pdf.setFont("Helvetica-Bold", 6.5)
        pdf.drawString(6*mm, (baseline_mm + 4)*mm, label)
        size = 11 if big else 8.3
        font = "Helvetica-Bold" if big else "Helvetica"
        pdf.setFont(font, size)
        pdf.drawString(6*mm, baseline_mm*mm, _fit(value, font, size, 54*mm))

    info("REFERENCIA", card["reference"], 59, big=True)
    pdf.setFont("Helvetica-Bold", 7)
    pdf.drawString(6*mm, 50*mm, "PECAS PREVISTAS")
    pdf.setFont("Helvetica-Bold", 22)
    pdf.drawString(6*mm, 41*mm, f"{card['expected_qty']:,}".replace(",", "."))
    pdf.setFont("Helvetica", 7)
    pdf.drawString(6*mm, 36*mm, f"{card['item_lines']} itens na grade")
    info("FORNECEDOR / MARCA", card.get("supplier_or_brand"), 28)
    info("NF", card.get("nf"), 19)
    info("LOTE / COMPRA", str(card.get("lot") or "—") + " / " +
         str(card.get("purchase_id") or "—"), 10)

    qr = QrCodeWidget(code)
    bounds = qr.getBounds()
    side = 28*mm
    drawing = Drawing(side, side, transform=[
        side/(bounds[2]-bounds[0]), 0, 0,
        side/(bounds[3]-bounds[1]), 0, 0])
    drawing.add(qr)
    renderPDF.draw(drawing, pdf, 65*mm, 40*mm)

    barcode = code128.Code128(code, barWidth=0.29*mm, barHeight=12*mm,
                              humanReadable=False)
    if barcode.width > 39*mm:
        raise ValueError("Código de Rack grande demais para a etiqueta.")
    bx = 60*mm + (36*mm-barcode.width)/2
    barcode.drawOn(pdf, bx, 21*mm)
    pdf.setFont("Helvetica-Bold", 7.5)
    pdf.drawCentredString(78*mm, 17*mm, code)
    pdf.setFont("Helvetica", 6.5)
    pdf.drawCentredString(78*mm, 10*mm, "LER QR OU CODIGO")


def build_rack_pdf(card: dict, copies: int = 1) -> bytes:
    if copies not in (1, 2) or isinstance(copies, bool):
        raise ValueError("Use uma ou duas etiquetas.")
    data = dict(card)
    rack_code(int(data["id"]))
    if int(data["expected_qty"]) < 0 or int(data["item_lines"]) < 0:
        raise ValueError("Quantidades inválidas.")
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    pdf.setTitle(f"DISTRILOG - {rack_code(int(data['id']))}")
    pdf.setAuthor("DISTRILOG")
    for _ in range(copies):
        _label(pdf, data)
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
    def rack_pdf(card_id: int, request: Request, copies: int = 1):
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
