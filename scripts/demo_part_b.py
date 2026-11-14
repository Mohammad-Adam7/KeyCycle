"""HTTP walkthrough against a seeded LOCAL server; prints no secrets."""
import argparse
import getpass
import os
import time
from urllib.parse import urlparse
import httpx


def demonstrate(base_url, password, passphrase):
    if urlparse(base_url).hostname not in ("127.0.0.1","localhost","::1"):
        raise ValueError("Demo credentials may only be sent to a local server")
    def call(client,method,path,body=None,status=200):
        r=client.request(method,path,json=body)
        if r.status_code != status:
            raise RuntimeError(f"Demo request {method} {path} returned {r.status_code}; expected {status}")
        return r.json()
    with httpx.Client(base_url=base_url,timeout=20,trust_env=False) as admin, httpx.Client(base_url=base_url,timeout=20,trust_env=False) as op:
        for client,name in ((admin,"admin"),(op,"operator1")):
            session=call(client,"POST","/api/auth/login",{"username":name,"password":password})
            client.headers["x-csrf-token"]=session["csrf_token"]
        try:
            call(admin,"POST","/api/vault/unlock",{"passphrase":passphrase})
            name=f"demo-{time.time_ns()}"
            kid=call(admin,"POST","/api/keys",{"name":name,"purpose":"standard"},201)["data"]["id"]
            package=call(op,"POST","/api/crypto/encrypt",{"key_id":kid,"data":"Synthetic HTTP demo"})["data"]["package"]
            token=call(admin,"POST","/api/confirmations",{"key_id":kid,"action":"rotate"},201)["data"]["confirmation_token"]
            call(admin,"POST",f"/api/keys/{kid}/rotate",{"confirmation_token":token})
            restored=call(op,"POST","/api/crypto/decrypt",{"package":package})["data"]["plaintext"]
            assert restored == "Synthetic HTTP demo"
            token=call(admin,"POST","/api/confirmations",{"key_id":kid,"action":"revoke"},201)["data"]["confirmation_token"]
            call(admin,"POST",f"/api/keys/{kid}/revoke",{"confirmation_token":token,"reason":"Completed demo","confirm_name":name})
            denied=call(op,"POST","/api/crypto/decrypt",{"package":package},409)
            assert denied["code"] == "KEY_REVOKED"
        finally:
            call(admin,"POST","/api/vault/lock")
            for client in (admin,op):
                call(client,"POST","/api/auth/logout")


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url",default="http://127.0.0.1:8000")
    args=parser.parse_args()
    password=os.environ.get("KEYCYCLE_DEMO_PASSWORD") or getpass.getpass("Demo account password: ")
    passphrase=os.environ.get("KEYCYCLE_DEMO_PASSPHRASE") or getpass.getpass("Demo vault passphrase: ")
    demonstrate(args.base_url,password,passphrase)
    print("PASS: creation, encryption, rotation, old-version decryption, revocation and denial.")
