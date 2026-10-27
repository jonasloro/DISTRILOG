"""Regression checks for WMS transfer permissions and input contracts."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from wms_inventory_module import TransferRequest, _actor


class DummyCursor:
    def __init__(self, role="recebimento"):
        self.role = role
        self.calls = []

    def execute(self, sql, args):
        self.calls.append((sql, args))
        return self

    def fetchone(self):
        return {"id": 11, "name": "Operador", "role": self.role}


def request(role):
    return SimpleNamespace(state=SimpleNamespace(auth_role=role, auth_user_id=11))


@pytest.mark.parametrize("invalid", [
    {"source_allocation_id": 0, "destination_address": "1RM01A", "reason": "Organização"},
    {"source_allocation_id": 1, "destination_address": "A", "reason": "Organização"},
    {"source_allocation_id": 1, "destination_address": "1RM01A", "reason": ""},
    {"source_allocation_id": 1, "destination_address": "1RM01A", "quantity": -4, "reason": "Organização"},
])
def test_transfer_input_rejects_invalid_payload(invalid):
    with pytest.raises(ValidationError):
        TransferRequest(**invalid)


def test_transfer_allows_partial_volume_but_not_zero():
    ok = TransferRequest(source_allocation_id=3, destination_address="1RM02A", quantity=1, reason="Reorganização")
    assert ok.quantity == 1


@pytest.mark.parametrize("role,from_sector,to_sector", [
    ("recebimento", "RM", "QA"),
    ("qualidade", "QA", "PR"),
    ("processamento", "PR", "RM"),
    ("etiquetagem", "ET", "ET"),
    ("estocagem", "EC", "EC"),
    ("supervisor", "EC", "EC"),
])
def test_allowed_actor_roles(role, from_sector, to_sector):
    cur = DummyCursor(role)
    actor = _actor(cur, request(role), from_sector, to_sector)
    assert actor["role"] == role
    assert cur.calls[0][1] == (11,)


@pytest.mark.parametrize("role,from_sector,to_sector", [
    ("consulta", "RM", "RM"),
    ("recebimento", "EC", "EC"),
    ("qualidade", "ET", "ET"),
    ("estocagem", "RM", "RM"),
    ("etiquetagem", "QA", "RM"),
])
def test_transfer_rejects_cross_role(role, from_sector, to_sector):
    with pytest.raises(HTTPException) as err:
        _actor(DummyCursor(role), request(role), from_sector, to_sector)
    assert err.value.status_code == 403
