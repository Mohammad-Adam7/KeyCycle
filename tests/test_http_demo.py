import socket
import threading
import uvicorn
from app.main import create_app
from scripts.seed_demo import seed
from scripts.demo_part_b import demonstrate as demonstrate_b
from scripts.demo_part_c import demonstrate as demonstrate_c


def test_real_http_demo(tmp_path):
    path=tmp_path/"http.db"
    seed(path,"demo-password-123","demo-passphrase-123")
    ready=threading.Event()
    class ObservedServer(uvicorn.Server):
        async def startup(self,sockets=None):
            await super().startup(sockets=sockets)
            ready.set()
    sock=socket.socket()
    sock.bind(("127.0.0.1",0))
    port=sock.getsockname()[1]
    server=ObservedServer(uvicorn.Config(create_app(str(path)),log_level="critical",lifespan="on"))
    thread=threading.Thread(target=server.run,kwargs={"sockets":[sock]},daemon=True)
    thread.start()
    try:
        assert ready.wait(10)
        base_url = f"http://127.0.0.1:{port}"
        demonstrate_b(base_url,"demo-password-123","demo-passphrase-123")
        result = demonstrate_c(base_url,"demo-password-123","demo-passphrase-123")
        assert len(result["steps"]) == 4
    finally:
        server.should_exit=True
        thread.join(15)
        sock.close()
        assert not thread.is_alive()
