from starlette.testclient import TestClient

from app.main import create_app


def test_ui_index_served(tmp_path):
    app = create_app(str(tmp_path / "ui_test.db"))
    client = TestClient(app)

    # Root endpoint
    res = client.get("/")
    assert res.status_code == 200
    assert "KeyCycle" in res.text
    assert '<link rel="stylesheet" href="/static/style.css">' in res.text
    assert '<script src="/static/app.js"></script>' in res.text


def test_ui_static_assets_served(tmp_path):
    app = create_app(str(tmp_path / "ui_test.db"))
    client = TestClient(app)

    # Style sheet with Midnight Navy + Electric Cyan palette
    css = client.get("/static/style.css")
    assert css.status_code == 200
    assert "text/css" in css.headers["content-type"]
    assert "--cyan-primary: #00f0ff" in css.text
    assert "--bg-base: #070b14" in css.text

    # JavaScript controller
    js = client.get("/static/app.js")
    assert js.status_code == 200
    assert "KeyCycleApp" in js.text


def test_ui_client_side_routes(tmp_path):
    app = create_app(str(tmp_path / "ui_test.db"))
    client = TestClient(app)

    for route in ["/dashboard", "/keys", "/crypto", "/audit", "/backup", "/admin"]:
        res = client.get(route)
        assert res.status_code == 200
        assert "KeyCycle" in res.text
