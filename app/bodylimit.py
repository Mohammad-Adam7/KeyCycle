
import json


class _TooLarge(Exception):
    pass


class BodyLimit:
    def __init__(self, app, limit: int):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.lower(): v for k, v in scope["headers"]}
        declared = headers.get(b"content-length", b"")
        if declared.isdigit() and int(declared) > self.limit:
            return await self._reject(send)
        seen, exceeded, started = 0, False, False

        async def counted():
            nonlocal seen, exceeded
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.limit:
                    exceeded = True
                    raise _TooLarge()
            return message

        async def tracked_send(message):
            nonlocal started
            if exceeded:
                if not started:
                    started = True
                    await self._reject(send)
                return
            started = started or message["type"] == "http.response.start"
            await send(message)

        try:
            await self.app(scope, counted, tracked_send)
        except _TooLarge:
            pass
        except Exception:
            if not exceeded:
                raise
        if exceeded and not started:
            await self._reject(send)

    @staticmethod
    async def _reject(send):
        body = json.dumps({"code": "PAYLOAD_TOO_LARGE", "message": "The request is too large.",
                           "audit_entry": None}).encode()
        await send({"type": "http.response.start", "status": 413, "headers": [
            (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
            (b"x-content-type-options", b"nosniff"), (b"cache-control", b"no-store")]})
        await send({"type": "http.response.body", "body": body})
