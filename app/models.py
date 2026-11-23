from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .config import PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN

USERNAME = dict(min_length=USERNAME_MIN, max_length=USERNAME_MAX, pattern=r"^[A-Za-z0-9_.-]+$")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LoginIn(Strict):
    username: str = Field(**USERNAME)
    password: str = Field(min_length=1, max_length=PASSWORD_MAX)


class SetupIn(Strict):
    username: str = Field(**USERNAME)
    password: str = Field(min_length=PASSWORD_MIN, max_length=PASSWORD_MAX)
    vault_passphrase: str = Field(min_length=PASSWORD_MIN, max_length=PASSWORD_MAX)


class UnlockIn(Strict):
    passphrase: str = Field(min_length=1, max_length=PASSWORD_MAX)


class UserCreate(Strict):
    username: str = Field(**USERNAME)
    password: str = Field(min_length=PASSWORD_MIN, max_length=PASSWORD_MAX)
    role: Literal["administrator", "operator", "viewer"]


class UserPatch(Strict):
    role: Optional[Literal["administrator", "operator", "viewer"]] = None
    disabled: Optional[bool] = None

    @model_validator(mode="after")
    def at_least_one(self):
        if self.role is None and self.disabled is None:
            raise ValueError("nothing to change")
        return self


class SettingPatch(Strict):
    value: int


class PasswordChangeIn(Strict):
    current_password: str = Field(min_length=1, max_length=PASSWORD_MAX)
    new_password: str = Field(min_length=PASSWORD_MIN, max_length=PASSWORD_MAX)


# Part B uses strict types without changing A's request contract.
import unicodedata
from pydantic import field_validator
from .config import ID_MAX, MAX_PACKAGE_CHARS
from .key_policy import parse_expiry


class BStrict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    @field_validator("*", mode="after")
    @classmethod
    def valid_text(cls, value):
        if isinstance(value, str):
            try:
                value.encode("utf-8")
            except UnicodeEncodeError:
                raise ValueError("invalid Unicode") from None
        return value


class KeyCreate(BStrict):
    name: str = Field(min_length=1, max_length=64)
    purpose: Literal["standard", "test"]
    algorithm: Literal["AES-256-GCM"] = "AES-256-GCM"
    rotation_days: int = Field(default=90, ge=1, le=365)
    expires_at: str | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        if value != value.strip() or any(unicodedata.category(c) == "Cc" for c in value):
            raise ValueError("invalid name")
        return value

    @field_validator("expires_at")
    @classmethod
    def valid_expiry(cls, value):
        try:
            parse_expiry(value)
        except (ValueError, OverflowError, OSError):
            raise ValueError("invalid expiry") from None
        return value


class EncryptIn(BStrict):
    key_id: int = Field(ge=1, le=ID_MAX)
    data: str = Field(min_length=1)


class DecryptIn(BStrict):
    package: str = Field(max_length=MAX_PACKAGE_CHARS)


class ConfirmationIn(BStrict):
    action: Literal["rotate", "revoke", "backup", "restore", "recovery_drill"]
    key_id: int | None = Field(default=None, ge=1, le=ID_MAX)
    backup_name: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def target_matches_action(self):
        key_action = self.action in ("rotate", "revoke")
        named_action = self.action in ("restore", "recovery_drill")
        if key_action and (self.key_id is None or self.backup_name is not None):
            raise ValueError("key confirmation requires a key")
        if self.action == "backup" and (self.key_id is not None or self.backup_name is not None):
            raise ValueError("backup confirmation has no named target")
        if named_action and (self.key_id is not None or self.backup_name is None):
            raise ValueError("restore confirmation requires a backup")
        return self


class RotateIn(BStrict):
    confirmation_token: str = Field(min_length=1, max_length=100)


class RevokeIn(RotateIn):
    reason: str = Field(min_length=1, max_length=200)
    confirm_name: str = Field(min_length=1, max_length=64)

    @field_validator("reason")
    @classmethod
    def clean_reason(cls, value):
        return KeyCreate.clean_name(value)
