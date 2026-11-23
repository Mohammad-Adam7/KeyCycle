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
    # No inline scripts or styles: the CSP only allows files from this origin
    assert "<script>" not in res.text and "<style>" not in res.text


def test_ui_static_assets_served(tmp_path):
    app = create_app(str(tmp_path / "ui_test.db"))
    client = TestClient(app)

    # Style sheet with the cream, maroon and brass palette
    css = client.get("/static/style.css")
    assert css.status_code == 200
    assert "text/css" in css.headers["content-type"]
    assert "--maroon: #7A1D2A" in css.text
    assert "--bg: #F5EDDD" in css.text
    assert client.get("/static/landing.css").status_code == 200

    # JavaScript controller and the vendored libraries (served locally, no CDN)
    js = client.get("/static/app.js")
    assert js.status_code == 200
    assert "KeyCycleApp" in js.text
    for path in ["/static/landing.js", "/static/kc3d.js", "/static/vendor/three.min.js",
                 "/static/vendor/gsap.min.js", "/static/vendor/ScrollTrigger.min.js",
                 "/static/fonts/pinyon-script-latin-400-normal.woff2"]:
        assert client.get(path).status_code == 200, path


def test_ui_client_side_routes(tmp_path):
    app = create_app(str(tmp_path / "ui_test.db"))
    client = TestClient(app)

    for route in ["/dashboard", "/keys", "/crypto", "/history", "/audit", "/backup", "/admin"]:
        res = client.get(route)
        assert res.status_code == 200
        assert "KeyCycle" in res.text
