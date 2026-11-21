import re
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, Request, Response

from . import audit
from .auth import Principal, permission
from .errors import AppError
from .reports import build_report_data, format_csv_report, format_json_report

router = APIRouter()


@router.get("/reports/export")
def export_report(request: Request, p: Principal = Depends(permission("export_report"))):
    conn, query = request.state.conn, request.query_params
    allowed = {"format"}
    if set(query) - allowed or len(query.multi_items()) != len(query):
        entry = audit.record(conn, user=p.username, role=p.role, action="report_export",
                             outcome="denied", severity="warning", reason="INVALID_INPUT")
        raise AppError("INVALID_INPUT", entry)

    fmt = query.get("format", "").lower()
    if fmt not in ("csv", "json"):
        entry = audit.record(conn, user=p.username, role=p.role, action="report_export",
                             outcome="denied", severity="warning", reason="INVALID_INPUT")
        raise AppError("INVALID_INPUT", entry)

    data = build_report_data(conn, p)
    audit.record(conn, user=p.username, role=p.role, action="report_export",
                 outcome="success", details={"format": fmt})

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%SZ")
    if fmt == "json":
        body = format_json_report(data)
        media_type = "application/json"
        filename = f"keycycle_report_{p.role}_{ts}.json"
    else:
        body = format_csv_report(data)
        media_type = "text/csv; charset=utf-8"
        filename = f"keycycle_report_{p.role}_{ts}.csv"

    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Cache-Control": "no-store",
    }
    return Response(content=body, media_type=media_type, headers=headers)
