"""Stock 3D integration contracts, no production DB or private model required."""
import json
import math
import struct
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.routing import APIRoute

from stock3d_module import _admin, _valid_address, _valid_point, _validate_glb

ROOT = Path(__file__).resolve().parent.parent


def minimal_glb(document=None):
    if document is None:
        document = {"asset": {"version": "2.0"}, "scenes": []}
    payload = json.dumps(document).encode("utf-8")
    payload += b" " * (-len(payload) % 4)
    return (struct.pack("<III", 0x46546C67, 2, 20 + len(payload))
            + struct.pack("<II", len(payload), 0x4E4F534A) + payload)


def test_glb_validation_accepts_internal_model_only():
    assert _validate_glb(minimal_glb()) is None
    with pytest.raises(HTTPException) as error:
        _validate_glb(minimal_glb({"asset": {"version": "2.0"}, "buffers": [{"uri": "https://attacker.invalid/data.bin"}]}))
    assert error.value.status_code == 422
    with pytest.raises(HTTPException):
        _validate_glb(minimal_glb()[:-1])


@pytest.mark.parametrize("point", [[0, 1], [math.inf, 0, 0], [True, 0, 1], [1e9, 0, 0], ["0", 0, 0]])
def test_invalid_anchors_are_blocked(point):
    with pytest.raises(HTTPException) as e:
        _valid_point(point)
    assert e.value.status_code == 422


def test_addresses_must_exist_in_current_wms_format():
    assert _valid_address("1rm06a") == "1RM06A"
    assert _valid_address("1et05") == "1ET05"
    for invalid in ["../../etc/passwd", "1ET05A", "ABC", "1RM06Z"]:
        with pytest.raises(HTTPException):
            _valid_address(invalid)


def test_model_upload_and_calibration_admin_only():
    with pytest.raises(HTTPException) as error:
        _admin(SimpleNamespace(state=SimpleNamespace(auth_role="recebimento", auth_user_id=44)))
    assert error.value.status_code == 403
    assert _admin(SimpleNamespace(state=SimpleNamespace(auth_role="admin", auth_user_id=1))) == 1


def test_stock3d_routes_and_navigation_present():
    from app import app
    routes = {r.path: r for r in app.routes if isinstance(r, APIRoute)}
    expected = {
        "/api/stock3d/model": {"GET", "POST"},
        "/api/stock3d/model/glb": {"GET"},
        "/api/stock3d/anchors": {"GET"},
        "/api/stock3d/anchors/{address}": {"PUT", "DELETE"},
        "/api/stock3d/anchors/import": {"POST"},
        "/api/stock3d/cards/{card_id}/locations": {"GET"},
    }
    for path, methods in expected.items():
        assert path in routes
        assert routes[path].methods in ({m} for m in methods) or routes[path].methods <= methods
    app_src = (ROOT / "app.py").read_text(encoding="utf-8")
    js = (ROOT / "static/app.js").read_text(encoding="utf-8")
    assert "init_stock3d_db()" in app_src
    assert "openStock3DForCard" in js
    assert "openStock3DForAddress" in js


def test_model_is_never_in_public_repo():
    assets = ROOT / "static/stock3d"
    assert not list(assets.rglob("*.glb"))
    assert not list(assets.rglob("*.skb"))
