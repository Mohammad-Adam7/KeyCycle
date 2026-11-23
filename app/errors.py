
ERRORS = {
    "AUTH_FAILED": (401, "Sign-in failed. Check your details or try again later."),
    "TOO_MANY_ATTEMPTS": (429, "Too many attempts. Try again later."),
    "PASSWORD_INVALID": (403, "The current password is incorrect."),
    "SESSION_EXPIRED": (401, "Your session is missing or has expired."),
    "CSRF_INVALID": (403, "The request could not be verified."),
    "FORBIDDEN": (403, "You do not have permission to do this."),
    "VAULT_LOCKED": (423, "The vault is locked."),
    "PASSPHRASE_INVALID": (403, "Unlock failed."),
    "KEY_NOT_FOUND": (404, "Key not found."),
    "KEY_EXPIRED": (409, "The key has expired."),
    "KEY_REVOKED": (409, "The key has been revoked."),
    "CIPHERTEXT_INVALID": (400, "The ciphertext is not valid."),
    "INVALID_INPUT": (400, "The request is not valid."),
    "PAYLOAD_TOO_LARGE": (413, "The request is too large."),
    "RATE_LIMITED": (429, "Too many requests. Slow down."),
    "CONFIRMATION_REQUIRED": (409, "A valid confirmation is required."),
    "SETTING_OUT_OF_RANGE": (422, "The value is outside the permitted range."),
    "BACKUP_INVALID": (422, "The backup is not valid."),
    "TAMPER_DETECTED": (409, "The audit log failed verification."),
    "SETUP_CLOSED": (404, "Not found."),
    "NOT_IMPLEMENTED": (501, "This feature is not available yet."),
    "INTERNAL_ERROR": (500, "An unexpected error occurred."),
    "RESULT_NOT_FOUND": (404, "Result not found."),
}


class AppError(Exception):
    def __init__(self, code: str, audit_entry: int | None = None, result: dict | None = None):
        self.code = code
        self.status, self.message = ERRORS[code]
        self.audit_entry = audit_entry
        self.result = result
        super().__init__(code)
