import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from llm_browser import AsyncBrowserClient, BrowserClient  # noqa: E402


class FakeTransport:
    def __init__(self):
        self.calls = []

    def __call__(self, method, path, body, timeout):
        self.calls.append({"method": method, "path": path, "body": body, "timeout": timeout})
        if method == "POST" and path == "/api/v2/sessions":
            return {"session_id": "s1"}
        if path.startswith("/api/v2/sessions/s1/snapshot"):
            return result("snapshot")
        if method == "POST" and path == "/api/v2/sessions/s1/actions":
            return result(body["action"], body=body)
        if method == "DELETE" and path == "/api/v2/sessions/s1":
            return None
        if path == "/api/v2/ops/op1":
            return {"status": "completed", "operation_id": "op1"}
        if path == "/api/v2/ops/op1/cancel":
            return {"status": "cancelled", "operation_id": "op1"}
        if path == "/api/v2/jsonrpc":
            return {"jsonrpc": "2.0", "result": result(body["method"]), "id": body["id"]}
        raise AssertionError(f"unexpected call {method} {path}")


class BrowserClientTest(unittest.TestCase):
    def test_session_actions_and_snapshot_budget(self):
        transport = FakeTransport()
        client = BrowserClient(transport=transport, timeout=7)
        session = client.create_session(viewport="mobile")

        nav = session.navigate("https://example.test")
        snap = session.snapshot(max_elements=120)
        typed = session.type("email", "ada@example.com", clear=True)
        sized = session.set_viewport({"width": 390, "height": 844})
        session.close()

        self.assertEqual(session.id, "s1")
        self.assertEqual(nav["action"], "navigate")
        self.assertEqual(snap["snapshot"]["meta"]["max_elements"], 120)
        self.assertEqual(typed["echo"]["params"]["clear"], True)
        self.assertEqual(sized["action"], "set_viewport")
        self.assertEqual(transport.calls[0]["body"], {"viewport": "mobile"})
        self.assertEqual(transport.calls[-2]["body"]["params"], {"width": 390, "height": 844})
        self.assertIn(
            {"method": "GET", "path": "/api/v2/sessions/s1/snapshot?max_elements=120", "body": None, "timeout": 7},
            transport.calls,
        )

    def test_async_session_wraps_sync_contract(self):
        async def run():
            transport = FakeTransport()
            client = AsyncBrowserClient(transport=transport)
            session = await client.create_session()
            nav = await session.navigate("https://example.test")
            rpc = await client.json_rpc("snapshot", {"session_id": "s1"})
            await session.close()
            return session.id, nav, rpc, transport.calls

        session_id, nav, rpc, calls = asyncio.run(run())

        self.assertEqual(session_id, "s1")
        self.assertEqual(nav["action"], "navigate")
        self.assertEqual(rpc["action"], "snapshot")
        self.assertEqual(calls[-1]["method"], "DELETE")

    def test_json_rpc_unwraps_result(self):
        transport = FakeTransport()
        client = BrowserClient(transport=transport)

        data = client.json_rpc("snapshot", {"session_id": "s1"}, rpc_id="rpc1")

        self.assertEqual(data["action"], "snapshot")
        self.assertEqual(transport.calls[-1]["body"]["id"], "rpc1")


def result(action, body=None):
    max_elements = 120 if action == "snapshot" else 300
    return {
        "status": "success",
        "action": action,
        "echo": body or {},
        "snapshot": {
            "version": "2.2.0",
            "url": "https://example.test",
            "title": "Example",
            "timestamp": "2026-05-18T00:00:00.000Z",
            "elements": [],
            "available_actions": [],
            "session": {
                "session_id": "s1",
                "tab_id": "tab-1",
                "tabs_count": 1,
                "history_length": 0,
                "cookies_count": 0,
            },
            "meta": {
                "max_elements": max_elements,
            },
        },
        "timing": {"total_ms": 1, "action_ms": 1, "extraction_ms": 0, "attempts": 1},
        "metadata": {"trace_id": "trace", "element_count": 0},
    }


if __name__ == "__main__":
    unittest.main()
