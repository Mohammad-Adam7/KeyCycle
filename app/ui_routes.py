from pathlib import Path
from fastapi import APIRouter
from fastapi.responses import FileResponse

router = APIRouter()
STATIC_DIR = Path(__file__).resolve().parent / "static"
INDEX_HTML = STATIC_DIR / "index.html"


@router.get("/")
def index():
    return FileResponse(INDEX_HTML)


@router.get("/login")
def login_view():
    return FileResponse(INDEX_HTML)


@router.get("/dashboard")
def dashboard_view():
    return FileResponse(INDEX_HTML)


@router.get("/keys")
def keys_view():
    return FileResponse(INDEX_HTML)


@router.get("/crypto")
def crypto_view():
    return FileResponse(INDEX_HTML)


@router.get("/audit")
def audit_view():
    return FileResponse(INDEX_HTML)


@router.get("/backup")
def backup_view():
    return FileResponse(INDEX_HTML)


@router.get("/admin")
def admin_view():
    return FileResponse(INDEX_HTML)


@router.get("/history")
def history_view():
    return FileResponse(INDEX_HTML)
