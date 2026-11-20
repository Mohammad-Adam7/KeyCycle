import os

USERNAME_MIN, USERNAME_MAX = 3, 32
PASSWORD_MIN, PASSWORD_MAX = 12, 128
KEY_NAME_MIN, KEY_NAME_MAX = 1, 64
REASON_MAX = 200
MAX_BODY_BYTES = 256 * 1024

SETTINGS = {
    "failed_logins_before_lockout": (5, 3, 10, "Failed logins before lockout"),
    "lockout_minutes": (15, 1, 60, "Lockout duration (minutes)"),
    "session_timeout_minutes": (30, 5, 120, "Session inactivity timeout (minutes)"),
    "rate_limit_per_minute": (30, 5, 300, "Rate limit (requests per minute per user)"),
    "rotation_days": (90, 1, 365, "Default rotation interval (days)"),
    "max_data_kib": (64, 1, 128, "Maximum data per request (KiB)"),
}

KDF_STRONG = dict(time_cost=3, memory_cost=65536, parallelism=4)
KDF_FAST = dict(time_cost=1, memory_cost=8, parallelism=1)


def kdf_params() -> dict:
    return KDF_FAST if os.environ.get("KEYCYCLE_FAST_KDF") == "1" else KDF_STRONG

SCHEMA_VERSION = 1
BACKUP_FORMAT = "keycycle-backup-v1"
MAX_BACKUP_BYTES = 50 * 1024 * 1024
MAX_BACKUP_NAME = 128
ID_MAX = 2**63 - 1
HARD_MAX_PLAINTEXT_BYTES = 128 * 1024
MAX_PACKAGE_CHARS = 180_000
CONFIRMATION_TTL_SECONDS = 300
SCHEDULER_INTERVAL_SECONDS = 30
SCHEDULER_BATCH = 100
