import re
from typing import Any
from fastapi import APIRouter, Body, Depends, Request
from pydantic import ValidationError

from .auth import COOKIE, Principal, permission
from .config import ID_MAX
from .key_service import KeyService
from .models import KeyCreate, EncryptIn, DecryptIn, ConfirmationIn, RotateIn, RevokeIn
from .security import token_hash

router = APIRouter()


def service(request, p):
    return KeyService(request.state.conn, request.app.state.vault, p,
                      token_hash(request.cookies[COOKIE]), t0=request.state.t0)


def parse(model, raw, s, action, perm):
    try:
        return model.model_validate(raw, strict=True)
    except ValidationError:
        s.deny(action, "INVALID_INPUT", perm)


def number(value, s, action, perm, *, maximum=ID_MAX, minimum=1):
    if not isinstance(value, str) or len(value)>19 or not re.fullmatch(r"0|[1-9][0-9]*", value):
        s.deny(action, "INVALID_INPUT", perm)
    n = int(value)
    if not minimum <= n <= maximum:
        s.deny(action, "INVALID_INPUT", perm)
    return n


def query(request, s, action, perm, allowed):
    q = request.query_params
    if set(q) - set(allowed) or len(q.multi_items()) != len(q):
        s.deny(action, "INVALID_INPUT", perm)
    return q


@router.post("/keys", status_code=201)
def create(request: Request, p: Principal = Depends(permission("manage_keys")), raw: Any = Body(None)):
    s = service(request, p)
    return s.create(parse(KeyCreate, raw, s, "key_create", "manage_keys"))


@router.get("/keys")
def list_keys(request: Request, p: Principal = Depends(permission("view_keys"))):
    s = service(request,p)
    q = query(request,s,"key_list","view_keys", ("state","purpose","after_id","limit"))
    if (q.get("state") is not None and q["state"] not in ("active","expired","revoked")) or (q.get("purpose") is not None and q["purpose"] not in ("standard","test")):
        s.deny("key_list","INVALID_INPUT","view_keys")
    return s.list(state=q.get("state"), purpose=q.get("purpose"),
                  after_id=number(q.get("after_id","0"),s,"key_list","view_keys",minimum=0),
                  limit=number(q.get("limit","50"),s,"key_list","view_keys",maximum=100))


@router.get("/keys/{key_id}")
def get_key(key_id: str, request: Request, p: Principal = Depends(permission("view_keys"))):
    s=service(request,p)
    q=query(request,s,"key_read","view_keys",("version_after","versions_limit"))
    return s.get(number(key_id,s,"key_read","view_keys"),
        number(q.get("version_after","0"),s,"key_read","view_keys",minimum=0),
        number(q.get("versions_limit","50"),s,"key_read","view_keys",maximum=100))


@router.post("/crypto/encrypt")
def encrypt(request: Request, p: Principal = Depends(permission("use_key")), raw: Any = Body(None)):
    s=service(request,p)
    return s.encrypt(parse(EncryptIn,raw,s,"encrypt","use_key"))


@router.post("/crypto/decrypt")
def decrypt(request: Request, p: Principal = Depends(permission("use_key")), raw: Any = Body(None)):
    s=service(request,p)
    return s.decrypt(parse(DecryptIn,raw,s,"decrypt","use_key"))


@router.post("/confirmations", status_code=201)
def issue(request: Request, p: Principal = Depends(permission("manage_keys")), raw: Any = Body(None)):
    s=service(request,p)
    return s.issue(parse(ConfirmationIn,raw,s,"confirmation_issue","manage_keys"))


@router.post("/keys/{key_id}/rotate")
def rotate(key_id: str, request: Request, p: Principal = Depends(permission("manage_keys")), raw: Any = Body(None)):
    s=service(request,p)
    body=parse(RotateIn,raw,s,"key_rotate","manage_keys")
    return s.rotate(number(key_id,s,"key_rotate","manage_keys"),body.confirmation_token)


@router.post("/keys/{key_id}/revoke")
def revoke(key_id: str, request: Request, p: Principal = Depends(permission("manage_keys")), raw: Any = Body(None)):
    s=service(request,p)
    body=parse(RevokeIn,raw,s,"key_revoke","manage_keys")
    return s.revoke(number(key_id,s,"key_revoke","manage_keys"),body)


@router.get("/results")
def results(request: Request, p: Principal = Depends(permission("view_results"))):
    s=service(request,p)
    q=query(request,s,"result_read","view_results",("before_entry","limit"))
    return s.results(before_entry=number(q["before_entry"],s,"result_read","view_results") if "before_entry" in q else None,
                     limit=number(q.get("limit","50"),s,"result_read","view_results",maximum=100))


@router.get("/results/{entry}")
def result(entry: str, request: Request, p: Principal = Depends(permission("view_results"))):
    s=service(request,p)
    return s.results(entry=number(entry,s,"result_read","view_results"))
