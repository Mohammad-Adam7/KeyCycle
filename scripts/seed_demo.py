"""Create a NEW synthetic demo database. Never overwrite live data."""
import argparse
import getpass
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import audit
from app.auth import Principal
from app.ciphertext import Package, decode_package, encode_package
from app.config import kdf_params
from app.db import init_db, connect, transaction
from app.key_policy import utc
from app.key_service import KeyService
from app.models import KeyCreate, EncryptIn, ConfirmationIn, RevokeIn
from app.scheduler import run_due_once
from app.security import make_hasher, new_token, token_hash
from app.vault import Vault


def seed(db_path, password, passphrase, *, fixture_path=None):
    if not 12 <= len(password) <= 128 or not 12 <= len(passphrase) <= 128:
        raise ValueError("Demo password and passphrase must be 12–128 characters")
    path=Path(db_path).resolve()
    path.parent.mkdir(parents=True,exist_ok=True)
    # Exclusive creation prevents accidental overwrite, including races.
    fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    os.close(fd)
    init_db(str(path))
    conn=connect(str(path))
    vault=Vault()
    now=int(time.time())
    try:
        actors={}
        hasher=make_hasher()
        with transaction(conn):
            for name,role,disabled in [("admin","administrator",0),("operator1","operator",0),("operator2","operator",0),("viewer","viewer",0),("trainee","viewer",1)]:
                uid=conn.execute("INSERT INTO users(username,password_hash,role,disabled,created_at) VALUES (?,?,?,?,?)",(name,hasher.hash(password),role,disabled,now)).lastrowid
                session,csrf=token_hash(new_token()),new_token()
                conn.execute("INSERT INTO sessions VALUES (?,?,?,?,?,?)",(session,uid,csrf,now,now,now+3600))
                actors[name]=(Principal(uid,name,role,csrf),session)
            vault.initialise(conn,passphrase,kdf_params())
            audit.record(conn,user="admin",role="administrator",action="setup",outcome="success",details={"fixture":True})
        assert vault.unlock(conn,passphrase)
        admin=KeyService(conn,vault,*actors["admin"])
        operator=KeyService(conn,vault,*actors["operator1"])
        ids={}
        for name,purpose in [("payroll-key","standard"),("finance-key","standard"),("backup-key","standard"),("legacy-api","standard"),("test-key","test")]:
            ids[name]=admin.create(KeyCreate(name=name,purpose=purpose))["data"]["id"]
        payroll=ids["payroll-key"]
        old=operator.encrypt(EncryptIn(key_id=payroll,data="Synthetic payroll sample"))["data"]["package"]
        for _ in range(2):
            t=admin.issue(ConfirmationIn(action="rotate",key_id=payroll))["data"]["confirmation_token"]
            admin.rotate(payroll,t)
        historical=KeyService(conn,vault,*actors["admin"],now=now-120)
        ids["archive-2026"]=historical.create(KeyCreate(name="archive-2026",purpose="standard",expires_at=utc(now-60)))["data"]["id"]
        legacy=ids["legacy-api"]
        t=admin.issue(ConfirmationIn(action="revoke",key_id=legacy))["data"]["confirmation_token"]
        admin.revoke(legacy,RevokeIn(confirmation_token=t,reason="Synthetic retired key",confirm_name="legacy-api"))
        run_due_once(conn,vault,now,set())
        p=decode_package(old)
        fixtures=dict(keys=ids,retired_version_package=old,
            altered_ciphertext=encode_package(Package(p.key_id,p.version,p.nonce,bytes([p.ct[0]^1])+p.ct[1:])),
            altered_version=encode_package(Package(p.key_id,2,p.nonce,p.ct)),
            altered_key=encode_package(Package(ids["finance-key"],p.version,p.nonce,p.ct)))
        if fixture_path:
            target=Path(fixture_path).resolve()
            target.parent.mkdir(parents=True,exist_ok=True)
            with target.open("x",encoding="utf-8") as f:
                json.dump(fixtures,f,indent=2)
        return fixtures
    finally:
        vault.lock()
        conn.execute("DELETE FROM confirmations")
        conn.execute("DELETE FROM sessions")
        conn.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db",required=True)
    parser.add_argument("--fixtures")
    args=parser.parse_args()
    password=os.environ.get("KEYCYCLE_DEMO_PASSWORD") or getpass.getpass("Demo account password (all synthetic users): ")
    passphrase=os.environ.get("KEYCYCLE_DEMO_PASSPHRASE") or getpass.getpass("Demo vault passphrase: ")
    seed(args.db,password,passphrase,fixture_path=args.fixtures)
    print("Demo created. Vault is locked; sessions were removed. No credentials were printed.")


if __name__ == "__main__":
    main()
