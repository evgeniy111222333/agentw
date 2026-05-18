from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen

Json = dict[str, Any]
Transport = Callable[[str, str, Any, float], Any]


class BrowserApiError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
        recoverable: bool | None = None,
        context: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.recoverable = recoverable
        self.context = dict(context or {})


class BrowserClient:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:3001",
        *,
        timeout: float = 30.0,
        retries: int = 2,
        retry_base_delay: float = 0.1,
        transport: Transport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.retries = retries
        self.retry_base_delay = retry_base_delay
        self.transport = transport

    def create_session(self) -> "BrowserSession":
        data = self._request("POST", "/api/v2/sessions")
        return BrowserSession(self, data["session_id"])

    def list_sessions(self, page: int = 1, limit: int = 20) -> Json:
        return self._request("GET", f"/api/v2/sessions?{urlencode({'page': page, 'limit': limit})}")

    def get_session(self, session_id: str) -> Json:
        return self._request("GET", f"/api/v2/sessions/{enc(session_id)}")

    def close_session(self, session_id: str) -> None:
        self._request("DELETE", f"/api/v2/sessions/{enc(session_id)}", expect_json=False)

    def execute_action(
        self,
        session_id: str,
        action: str,
        *,
        target_id: str | None = None,
        params: Mapping[str, Any] | None = None,
        trace_id: str | None = None,
    ) -> Json:
        return self._request(
            "POST",
            f"/api/v2/sessions/{enc(session_id)}/actions",
            {
                "action": action,
                "target_id": target_id,
                "params": dict(params or {}),
                "trace_id": trace_id,
            },
        )

    def start_action(
        self,
        session_id: str,
        action: str,
        *,
        target_id: str | None = None,
        params: Mapping[str, Any] | None = None,
        trace_id: str | None = None,
    ) -> Json:
        merged = dict(params or {})
        merged["async"] = True
        return self.execute_action(session_id, action, target_id=target_id, params=merged, trace_id=trace_id)

    def get_snapshot(self, session_id: str, *, max_elements: int | None = None) -> Json:
        query = f"?{urlencode({'max_elements': max_elements})}" if max_elements is not None else ""
        return self._request("GET", f"/api/v2/sessions/{enc(session_id)}/snapshot{query}")

    def export_session(self, session_id: str) -> Json:
        return self._request("GET", f"/api/v2/sessions/{enc(session_id)}/export")

    def import_session(
        self,
        pack: Mapping[str, Any],
        *,
        session_id: str | None = None,
        navigate: bool | None = None,
        url: str | None = None,
    ) -> "BrowserSession":
        body: Json = {"package": dict(pack)}
        if session_id is not None:
            body["session_id"] = session_id
        if navigate is not None:
            body["navigate"] = navigate
        if url is not None:
            body["url"] = url
        data = self._request("POST", "/api/v2/sessions/import", body)
        return BrowserSession(self, data["session_id"])

    def get_diagnostics(self, session_id: str) -> Json:
        return self._request("GET", f"/api/v2/sessions/{enc(session_id)}/diagnostics")

    def get_auth(self, session_id: str) -> Json:
        return self._request("GET", f"/api/v2/sessions/{enc(session_id)}/auth")

    def list_tabs(self, session_id: str) -> list[Json]:
        return self._request("GET", f"/api/v2/sessions/{enc(session_id)}/tabs")["tabs"]

    def open_tab(self, session_id: str, url: str | None = None) -> Json:
        return self._request("POST", f"/api/v2/sessions/{enc(session_id)}/tabs", {"url": url})

    def switch_tab(self, session_id: str, tab_id: str) -> Json:
        return self._request("POST", f"/api/v2/sessions/{enc(session_id)}/tabs/{enc(tab_id)}/switch")

    def close_tab(self, session_id: str, tab_id: str) -> Json:
        return self._request("DELETE", f"/api/v2/sessions/{enc(session_id)}/tabs/{enc(tab_id)}")

    def list_events(
        self,
        session_id: str,
        *,
        tab_id: str | None = None,
        kind: str | None = None,
        limit: int | None = None,
    ) -> Json:
        params = {k: v for k, v in {"tab_id": tab_id, "kind": kind, "limit": limit}.items() if v is not None}
        query = f"?{urlencode(params)}" if params else ""
        return self._request("GET", f"/api/v2/sessions/{enc(session_id)}/events{query}")

    def clear_events(self, session_id: str) -> None:
        self._request("DELETE", f"/api/v2/sessions/{enc(session_id)}/events", expect_json=False)

    def list_actions(self, session_id: str, page: int = 1, limit: int = 20) -> Json:
        query = urlencode({"page": page, "limit": limit})
        return self._request("GET", f"/api/v2/sessions/{enc(session_id)}/actions?{query}")

    def list_ops(self, session_id: str | None = None, page: int = 1, limit: int = 20) -> Json:
        params: Json = {"page": page, "limit": limit}
        if session_id:
            params["session_id"] = session_id
        return self._request("GET", f"/api/v2/ops?{urlencode(params)}")

    def get_op(self, operation_id: str) -> Json:
        return self._request("GET", f"/api/v2/ops/{enc(operation_id)}")

    def cancel_op(self, operation_id: str) -> Json:
        return self._request("POST", f"/api/v2/ops/{enc(operation_id)}/cancel")

    def list_traces(self, session_id: str | None = None, page: int = 1, limit: int = 20) -> Json:
        params: Json = {"page": page, "limit": limit}
        if session_id:
            params["session_id"] = session_id
        return self._request("GET", f"/api/v2/traces?{urlencode(params)}")

    def get_trace(self, trace_id: str) -> Json:
        return self._request("GET", f"/api/v2/traces/{enc(trace_id)}")

    def get_audit(self, session_id: str | None = None, page: int = 1, limit: int = 20) -> Json:
        params: Json = {"page": page, "limit": limit}
        if session_id:
            params["session_id"] = session_id
        return self._request("GET", f"/api/v2/audit?{urlencode(params)}")

    def list_plugins(self, page: int = 1, limit: int = 20) -> Json:
        return self._request("GET", f"/api/v2/plugins?{urlencode({'page': page, 'limit': limit})}")

    def get_semantic_cache(self) -> Json:
        return self._request("GET", "/api/v2/cache/semantic")

    def clear_semantic_cache(self) -> None:
        self._request("DELETE", "/api/v2/cache/semantic", expect_json=False)

    def json_rpc(self, method: str, params: Mapping[str, Any], rpc_id: str | int | None = None) -> Json:
        body = self._request(
            "POST",
            "/api/v2/jsonrpc",
            {"jsonrpc": "2.0", "method": method, "params": dict(params), "id": rpc_id or f"{method}-1"},
        )
        if "error" in body:
            error = body["error"]
            data = error.get("data", {})
            raise BrowserApiError(
                error.get("message", "JSON-RPC error"),
                code=data.get("error_code"),
                recoverable=data.get("recoverable"),
                context=data,
            )
        return body["result"]

    def json_rpc_batch(self, calls: list[Mapping[str, Any]]) -> list[Json]:
        body = [
            {
                "jsonrpc": "2.0",
                "method": call["method"],
                "params": dict(call.get("params", {})),
                "id": call.get("id", f"{call['method']}-{index}"),
            }
            for index, call in enumerate(calls)
        ]
        data = self._request("POST", "/api/v2/jsonrpc", body)  # type: ignore[arg-type]
        for entry in data:
            if "error" in entry:
                raise BrowserApiError(entry["error"].get("message", "JSON-RPC batch error"))
        return data

    def _request(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | list[Mapping[str, Any]] | None = None,
        *,
        expect_json: bool = True,
    ) -> Any:
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                if self.transport:
                    return self.transport(method, path, body, self.timeout)
                return self._http_request(method, path, body, expect_json)
            except BrowserApiError:
                raise
            except (TimeoutError, URLError, OSError) as error:
                last_error = error
                if attempt >= self.retries:
                    break
                time.sleep(self.retry_base_delay * (2**attempt))
        raise BrowserApiError(str(last_error or "request failed"), recoverable=True)

    def _http_request(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | list[Mapping[str, Any]] | None,
        expect_json: bool,
    ) -> Any:
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"content-type": "application/json"} if payload is not None else {}
        req = Request(f"{self.base_url}{path}", data=payload, headers=headers, method=method)
        try:
            with urlopen(req, timeout=self.timeout) as response:
                if not expect_json or response.status == 204:
                    return None
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except HTTPError as error:
            raise self._api_error(error) from error

    def _api_error(self, error: HTTPError) -> BrowserApiError:
        try:
            data = json.loads(error.read().decode("utf-8"))
        except Exception:
            data = {}
        detail = data.get("error", data)
        return BrowserApiError(
            detail.get("message", str(error)),
            status=error.code,
            code=detail.get("code"),
            recoverable=detail.get("recoverable"),
            context=detail.get("context", {}),
        )


class BrowserSession:
    def __init__(self, client: BrowserClient, session_id: str) -> None:
        self.client = client
        self.id = session_id

    def snapshot(self, *, max_elements: int | None = None) -> Json:
        return self.client.get_snapshot(self.id, max_elements=max_elements)

    def navigate(self, url: str) -> Json:
        return self.client.execute_action(self.id, "navigate", params={"url": url})

    def click(self, target_id: str) -> Json:
        return self.client.execute_action(self.id, "click", target_id=target_id)

    def type(self, target_id: str, text: str, **options: Any) -> Json:
        return self.client.execute_action(self.id, "type", target_id=target_id, params={**options, "text": text})

    def fill_form(self, form_id: str, fields: Mapping[str, Any], submit: bool = False) -> Json:
        return self.client.execute_action(self.id, "fill_form", target_id=form_id, params={"fields": dict(fields), "submit": submit})

    def start(self, action: str, **options: Any) -> Json:
        return self.client.start_action(self.id, action, **options)

    def poll(self, operation_id: str) -> Json:
        return self.client.get_op(operation_id)

    def cancel(self, operation_id: str) -> Json:
        return self.client.cancel_op(operation_id)

    def tabs(self) -> list[Json]:
        return self.client.list_tabs(self.id)

    def open_tab(self, url: str | None = None) -> Json:
        return self.client.open_tab(self.id, url)

    def switch_tab(self, tab_id: str) -> Json:
        return self.client.switch_tab(self.id, tab_id)

    def close_tab(self, tab_id: str) -> Json:
        return self.client.close_tab(self.id, tab_id)

    def events(self, **options: Any) -> Json:
        return self.client.list_events(self.id, **options)

    def auth(self) -> Json:
        return self.client.get_auth(self.id)

    def diagnostics(self) -> Json:
        return self.client.get_diagnostics(self.id)

    def export(self) -> Json:
        return self.client.export_session(self.id)

    def close(self) -> None:
        self.client.close_session(self.id)


class AsyncBrowserClient:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._sync = BrowserClient(*args, **kwargs)

    async def create_session(self) -> "AsyncBrowserSession":
        session = await asyncio.to_thread(self._sync.create_session)
        return AsyncBrowserSession(self, session.id)

    async def import_session(self, pack: Mapping[str, Any], **kwargs: Any) -> "AsyncBrowserSession":
        session = await asyncio.to_thread(self._sync.import_session, pack, **kwargs)
        return AsyncBrowserSession(self, session.id)

    async def execute_action(self, session_id: str, action: str, **kwargs: Any) -> Json:
        return await asyncio.to_thread(self._sync.execute_action, session_id, action, **kwargs)

    async def get_snapshot(self, session_id: str, **kwargs: Any) -> Json:
        return await asyncio.to_thread(self._sync.get_snapshot, session_id, **kwargs)

    async def close_session(self, session_id: str) -> None:
        await asyncio.to_thread(self._sync.close_session, session_id)

    async def get_op(self, operation_id: str) -> Json:
        return await asyncio.to_thread(self._sync.get_op, operation_id)

    async def cancel_op(self, operation_id: str) -> Json:
        return await asyncio.to_thread(self._sync.cancel_op, operation_id)

    async def get_auth(self, session_id: str) -> Json:
        return await asyncio.to_thread(self._sync.get_auth, session_id)

    async def get_diagnostics(self, session_id: str) -> Json:
        return await asyncio.to_thread(self._sync.get_diagnostics, session_id)

    def __getattr__(self, name: str) -> Any:
        target = getattr(self._sync, name)
        if not callable(target):
            return target

        async def call(*args: Any, **kwargs: Any) -> Any:
            return await asyncio.to_thread(target, *args, **kwargs)

        return call


class AsyncBrowserSession:
    def __init__(self, client: AsyncBrowserClient, session_id: str) -> None:
        self.client = client
        self.id = session_id

    async def snapshot(self, *, max_elements: int | None = None) -> Json:
        return await self.client.get_snapshot(self.id, max_elements=max_elements)

    async def navigate(self, url: str) -> Json:
        return await self.client.execute_action(self.id, "navigate", params={"url": url})

    async def click(self, target_id: str) -> Json:
        return await self.client.execute_action(self.id, "click", target_id=target_id)

    async def type(self, target_id: str, text: str, **options: Any) -> Json:
        return await self.client.execute_action(self.id, "type", target_id=target_id, params={**options, "text": text})

    async def fill_form(self, form_id: str, fields: Mapping[str, Any], submit: bool = False) -> Json:
        return await self.client.execute_action(self.id, "fill_form", target_id=form_id, params={"fields": dict(fields), "submit": submit})

    async def poll(self, operation_id: str) -> Json:
        return await self.client.get_op(operation_id)

    async def cancel(self, operation_id: str) -> Json:
        return await self.client.cancel_op(operation_id)

    async def auth(self) -> Json:
        return await self.client.get_auth(self.id)

    async def diagnostics(self) -> Json:
        return await self.client.get_diagnostics(self.id)

    async def close(self) -> None:
        await self.client.close_session(self.id)

    def __getattr__(self, name: str) -> Any:
        target = getattr(BrowserSession(self.client._sync, self.id), name)
        if not callable(target):
            return target

        async def call(*args: Any, **kwargs: Any) -> Any:
            return await asyncio.to_thread(target, *args, **kwargs)

        return call


def enc(value: str) -> str:
    return quote(value, safe="")
