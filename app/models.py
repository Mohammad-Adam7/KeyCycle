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
