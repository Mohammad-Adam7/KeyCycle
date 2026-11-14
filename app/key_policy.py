import math
import re
from datetime import datetime, timezone

from .config import SETTINGS


def effective_state(key, now):
    if key["state"] != "active":
        return key["state"]
    if key["expires_at"] is not None and now >= key["expires_at"]:
        return "expired"
    return "active"


def role_may_use(role, purpose):
    return (role, purpose) in {("administrator", "test"), ("operator", "standard")}


def utc(value):
    return None if value is None else datetime.fromtimestamp(value, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_expiry(value):
    if value is None:
        return None
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})", value):
        raise ValueError("invalid expiry")
    # fromisoformat accepts offsets with minutes >59; enforce RFC bounds first.
    if value[-1] != "Z" and (int(value[-5:-3]) > 23 or int(value[-2:]) > 59):
        raise ValueError("invalid offset")
    return math.floor(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())


def setting_snapshot(conn, name):
    row = conn.execute("SELECT value,version FROM settings WHERE name=?", (name,)).fetchone()
    if row is None:
        raise ValueError("missing setting")
    _, lo, hi, _ = SETTINGS[name]
    if type(row["value"]) is not int or not lo <= row["value"] <= hi or row["version"] < 1:
        raise ValueError("invalid setting")
    return {"value": row["value"], "setting_version": row["version"]}
