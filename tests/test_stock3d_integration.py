"""Contract checks for the Stock 3D read-only integration.

These tests need no production credentials and never access real inventory.
"""
from pathlib import Path
from fastapi.routing import APIRoute

ROOT = Path(__file__).resolve().parent.parent


def test_stock3d_wms_consultation_routes_remain_read_only():
    from app import app
    stock = [r for r in app.routes if isinstance(r, APIRoute)
             and (r.path == "/stock-3d" or r.path.startswith("/api/stock3d/"))]
    paths = {r.path: r.methods for r in stock}
    assert paths["/stock-3d"] == {"GET"}
    assert paths["/api/stock3d/search"] == {"GET"}
    assert paths["/api/stock3d/model/glb"] == {"GET"}
    assert paths["/api/stock3d/cards/{card_id}/locations"] == {"GET"}
    # Administrative model uploads and anchor writes are tested separately.


def test_stock3d_requires_session_and_is_accessible_in_sidebar():
    source = (ROOT / "app.py").read_text(encoding="utf-8")
    assert 'path != "/stock-3d"' in source
    assert 'register_stock3d_routes(app)' in source
    html = (ROOT / "templates/index.html").read_text(encoding="utf-8")
    js = (ROOT / "static/app.js").read_text(encoding="utf-8")
    assert 'data-view="stock-3d"' in html
    assert 'renderStock3D(' in js
    assert '"/stock-3d"' in js


def test_private_model_not_in_public_assets():
    public = ROOT / "static/stock3d"
    assert (public / "index.html").exists()
    assert not list(public.rglob("*.glb"))
    assert not list(public.rglob("*.skb"))
    assert not list(public.rglob("*.skp"))
