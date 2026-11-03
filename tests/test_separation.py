"""Contrato do relatório de pedidos, sem depender de produção ou de credenciais."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from separation_module import duration_seconds, parse_report


HEADER = (
    "identificacao;emissao;numero_documento;referencia;descricao;"
    "codigo_barras;composicoes_visualizacao;quantidade;casulo\n"
)


def _csv(*rows: str, encoding: str = "utf-8") -> bytes:
    return (HEADER + "\n".join(rows) + "\n").encode(encoding)


def test_import_excludes_street_001_and_missing_casulo_but_preserves_references():
    raw = _csv(
        "05 - Porto Praia;10/07/2026;45454;REF-A;Blusa;001;[P,AZUL];2;001-P-010",
        "05 - Porto Praia;10/07/2026;45454;REF-B;Blusa;002;[P,ROSA];3;",
        "05 - Porto Praia;10/07/2026;45454;REF-C;Blusa;003;[M,AZUL];5;010-B-088",
        "05 - Porto Praia;10/07/2026;45454;REF-C;Blusa;003;[M,AZUL];2;010-B-088",
    )
    orders = parse_report(raw)
    assert len(orders) == 1
    order = orders[("45454", "05 - Porto Praia")]
    assert order["expected_qty"] == 7
    assert order["excluded_street_qty"] == 2
    assert order["excluded_without_casulo_qty"] == 3
    assert order["references"] == {"REF-A", "REF-B", "REF-C"}
    assert len(order["items"]) == 1
    assert next(iter(order["items"].values())) == 7


def test_parser_keeps_leading_zeros_in_barcode_and_handles_cp1252():
    raw = _csv(
        "Loja A;10/07/2026;45454;REF-A;CALÇA;000012;[U,UNICO];1;003-A-001",
        encoding="cp1252",
    )
    item = next(iter(parse_report(raw)[("45454", "Loja A")]["items"]))
    assert item[2] == "000012"


def test_same_document_different_destinations_are_distinct():
    rows = [
        "Loja A;10/07/2026;45454;REF-1;Blusa;111;[P];1;010-A-010",
        "Loja B;10/07/2026;45454;REF-2;Blusa;222;[P];2;010-A-010",
    ]
    assert len(parse_report(_csv(*rows))) == 2


@pytest.mark.parametrize("value", ["-1", "x", "1.5", ""])
def test_invalid_quantities_are_rejected(value):
    with pytest.raises(HTTPException) as error:
        parse_report(_csv(
            f"Loja A;10/07/2026;45454;REF-A;Blusa;111;[P];{value};010-A-010"
        ))
    assert error.value.status_code == 422


def test_inconsistent_issue_dates_are_rejected():
    with pytest.raises(HTTPException):
        parse_report(_csv(
            "Loja A;10/07/2026;45454;REF-A;Blusa;111;[P];1;010-A-010",
            "Loja A;11/07/2026;45454;REF-A;Blusa;111;[P];1;010-A-010",
        ))


def test_duration_hh_mm_ss_validation():
    assert duration_seconds("01:02:03") == 3723
    assert duration_seconds("100:00:00") == 360000
    for value in ("", "1:2:3", "01:61:00", "00:00:99", "-1:00:00"):
        with pytest.raises(HTTPException):
            duration_seconds(value)
