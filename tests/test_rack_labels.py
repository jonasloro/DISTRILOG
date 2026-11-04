"""Etiquetas Rack: identidade escaneável, quantidade real e controles de acesso."""
from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pypdf import PdfReader

from rack_module import _card_data, build_rack_pdf, rack_code, router, register_rack_routes

SAMPLE = {
    "id": 1045, "purchase_id": "Lote-348",
    "reference": "BLUSA REF-1045",
    "supplier_or_brand": "Distribox",
    "nf": "45678", "lot": "349.B",
    "expected_qty": 120, "item_lines": 6,
}


def test_pdf_contains_correct_identification_and_expected_pieces():
    raw = build_rack_pdf(SAMPLE)
    assert raw.startswith(b"%PDF-")
    doc = PdfReader(BytesIO(raw))
    assert len(doc.pages) == 2
    text = doc.pages[0].extract_text()
    assert text.count("RACK-1045") >= 4
    assert text.count("120") >= 2
    assert "BLUSA REF-1045" in text
    assert "6 itens na grade" in text
    assert "45678" in text


def test_one_label_mode_is_100_x_85_mm():
    raw = build_rack_pdf(SAMPLE, 1)
    doc = PdfReader(BytesIO(raw))
    assert len(doc.pages) == 1
    assert abs(float(doc.pages[0].mediabox.width) - 100*72/25.4) < 0.5
    assert abs(float(doc.pages[0].mediabox.height) - 85*72/25.4) < 0.5
    assert doc.pages[0].extract_text().count("RACK-1045") >= 2


@pytest.mark.parametrize("count", [0, 3, -1])
def test_invalid_copies_are_rejected(count):
    with pytest.raises(ValueError):
        build_rack_pdf(SAMPLE, count)


def test_rack_code_matches_mobile_scanner_contract():
    assert rack_code(1045) == "RACK-1045"
    with pytest.raises(ValueError):
        rack_code(0)


class Rows:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, card, items):
        self.card = card
        self.items = items

    def execute(self, sql, params):
        return Rows([self.card] if "FROM cards" in sql else self.items)


def test_pdf_uses_sum_of_items_not_volumes():
    con = FakeConnection(
        {
            "id": 1045, "purchase_id": "Compra-1", "supplier": "F",
            "brand": "M", "source_notes": "", "current_sector": "RECEBIMENTO",
            "status": "AGUARDANDO_RECEBIMENTO"
        },
        [
            {"reference": "REF-A", "product": "Blusa", "nf": "10", "lot": "55", "expected_qty": 70},
            {"reference": "REF-A", "product": "Blusa", "nf": "10", "lot": "55", "expected_qty": 50},
        ],
    )
    data = _card_data(con, 1045, is_awaiting_arrival=lambda *_: False)
    assert data["expected_qty"] == 120
    assert data["item_lines"] == 2
    assert data["nf"] == "10"


def test_card_without_arrival_cannot_print():
    con = FakeConnection({"id": 7}, [])
    with pytest.raises(HTTPException) as exc:
        _card_data(con, 7, is_awaiting_arrival=lambda *_: True)
    assert exc.value.status_code == 409


def test_roles_are_restricted():
    # Authentication middleware supplies the role; the client never sends it.
    assert "consulta" not in __import__("rack_module").PRINT_ROLES
    assert "recebimento" in __import__("rack_module").PRINT_ROLES
