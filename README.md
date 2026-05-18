# LLM Browser

Semantic browser runtime for LLM agents. It exposes REST, JSON-RPC, and WebSocket APIs that return semantic snapshots, available actions, deltas, metrics, and audit events.

## Local Development

```bash
npm install
npm run build
npm run smoke:api
npm run sdk:smoke
```

## Run Server

```bash
npm run build
node dist/index.js
```

Default API:

- `POST /api/v2/sessions`
- `POST /api/v2/sessions/import`
- `POST /api/v2/jsonrpc`
- `POST /api/v2/sessions/:id/actions`
- `GET /api/v2/sessions/:id/snapshot`
- `GET /api/v2/sessions/:id/export`
- `GET /api/v2/sessions/:id/diagnostics`
- `GET /api/v2/sessions/:id/auth`
- `GET /api/v2/sessions/:id/tabs`
- `POST /api/v2/sessions/:id/tabs`
- `POST /api/v2/sessions/:id/tabs/:tabId/switch`
- `DELETE /api/v2/sessions/:id/tabs/:tabId`
- `GET /api/v2/sessions/:id/events`
- `DELETE /api/v2/sessions/:id/events`
- `GET /api/v2/audit`
- `GET /api/v2/traces`
- `GET /api/v2/cache/semantic`
- `GET /api/v2/plugins`
- `GET /api/v2/ops`
- `GET /metrics`
- `WS /api/v2/ws?session_id=...`

## TypeScript SDK

```ts
import { BrowserClient } from 'llm-browser/sdk';

const client = new BrowserClient({ baseUrl: 'http://127.0.0.1:3001' });
const session = await client.createSession();

const page = await session.navigate('https://example.com');
const auth = await session.auth();
const action = page.snapshot.available_actions.find((item) => item.action === 'click');
if (action?.target) {
  await session.click(action.target);
}

await session.close();
```

## Python SDK

The Python SDK lives in `python/llm_browser` and uses the standard library only. It includes sync and async clients for sessions, actions, snapshots, tabs, events, auth, diagnostics, traces, ops, audit, plugins, and semantic cache. From a source checkout, run with `PYTHONPATH=python` or install the package from `python/`.

```py
from llm_browser import BrowserClient

client = BrowserClient("http://127.0.0.1:3001")
session = client.create_session()

page = session.navigate("https://example.com")
snapshot = session.snapshot(max_elements=120)
action = next((item for item in page["snapshot"]["available_actions"] if item["action"] == "click"), None)
if action and action.get("target"):
    session.click(action["target"])

session.close()
```

```py
from llm_browser import AsyncBrowserClient

client = AsyncBrowserClient("http://127.0.0.1:3001")
session = await client.create_session()
await session.navigate("https://example.com")
await session.close()
```

Local SDK tests:

```bash
npm run py:test
```

## Auth State

Semantic snapshots include `snapshot.auth`, and session diagnostics include the latest `session.auth`.
The tracker uses sanitized cookie names/attributes, OAuth URL signals, login forms, account URLs, user identity text, and logout controls. Cookie and token values are never emitted. Login UI, anonymous token cookies, and public OAuth-capable hostnames are not treated as authenticated sessions without stronger account proof.

```ts
const auth = await session.auth();
if (auth.authenticated) {
  console.log(auth.method, auth.confidence, auth.indicators);
}
```

REST endpoint:

- `GET /api/v2/sessions/:id/auth`

## Snapshot Budget and Privacy

Snapshots use an adaptive element budget by default. Clients can request a tighter or larger snapshot with `max_elements`; the runtime clamps it to `LLM_BROWSER_MAX_ELEMENTS_HARD_LIMIT` and reports the effective values in `snapshot.meta`.

```ts
const compact = await session.snapshot({ max_elements: 120 });
console.log(compact.snapshot.meta?.max_elements, compact.snapshot.meta?.semantic_nodes_total);
```

Snapshot text content is privacy-masked before it is returned or cached. Emails, phones, payment-card-like values, JWTs, token assignments, and sensitive URL query values are replaced with stable placeholders such as `[email]` and `[secret]`. Element IDs, targets, and action IDs are preserved so actions remain executable. Masking counts are exposed at `snapshot.meta.privacy`.

REST endpoint:

- `GET /api/v2/sessions/:id/snapshot?max_elements=500`

## Tabs

Sessions can hold multiple isolated pages in one browser context. The active tab is reflected in `snapshot.session.tab_id`, and deltas are tracked per tab so snapshots from different tabs are not compared to each other.
Runtime caps protect heavy pages: `LLM_BROWSER_MAX_SESSIONS`, `LLM_BROWSER_MAX_TABS_PER_SESSION`, and `LLM_BROWSER_MEMORY_LIMIT_MB` reject new work before Chromium exhausts memory. Idle sessions are closed after `LLM_BROWSER_SESSION_TIMEOUT_SECONDS`.

```ts
const second = await session.openTab('https://example.com/docs');
await session.switchTab('tab-1');
const tabs = await session.tabs();
await session.closeTab(second.data?.tab.tab_id);
```

REST endpoints:

- `GET /api/v2/sessions/:id/tabs`
- `POST /api/v2/sessions/:id/tabs`
- `POST /api/v2/sessions/:id/tabs/:tabId/switch`
- `DELETE /api/v2/sessions/:id/tabs/:tabId`

## Events

Each page records a bounded stream of runtime events: network requests, responses, request failures, console messages, and page errors. Event URLs redact sensitive query values such as tokens, secrets, passwords, auth codes, and session IDs. Request/response bodies and headers are not emitted.

```ts
const events = await session.events({ kind: 'console', limit: 20 });
await session.clearEvents();
```

REST endpoints:

- `GET /api/v2/sessions/:id/events`
- `DELETE /api/v2/sessions/:id/events`

## File Actions

Each session gets a sandboxed file box with `/downloads`, `/uploads`, `/shots`, and `/tmp`.
Paths in actions are relative to that box and cannot escape it.

- `upload` sets files on a file input from `/uploads` paths or inline content.
- `download` saves browser downloads into `/downloads`.
- `screenshot_file` saves PNG screenshots into `/shots`.
- `pdf` saves page PDFs into `/shots`.
- `fs` lists, reads, writes, and deletes sandbox files.

```ts
await session.fs('write', '/uploads/report.txt', { content: 'hello' });
await session.upload('file-input', { file_path: '/uploads/report.txt' });
await session.download('download-link', { file_name: 'report.txt' });
await session.screenshotFile({ file_name: 'page.png' });
await session.pdf({ file_name: 'page.pdf' });
```

## Session Pack

Sessions can be exported as a portable package and imported into a fresh isolated browser context. The package contains session metadata, action history, browser storage state, current page metadata, and the latest semantic snapshot when available.

```ts
const pack = await session.export();
const restored = await client.importSession(pack);
const restoredSnapshot = await restored.snapshot();
const diagnostics = await restored.diagnostics();
```

REST endpoints:

- `GET /api/v2/sessions/:id/export`
- `POST /api/v2/sessions/import`
- `GET /api/v2/sessions/:id/diagnostics`

## Tracing

Every command carries a `trace_id`. The runtime stores trace records with spans for router validation, security authorization, action execution, and semantic extraction.

```ts
const result = await session.click('submit');
const trace = await client.getTrace(result.metadata.trace_id);
const sessionTraces = await session.traces();
```

REST endpoints:

- `GET /api/v2/traces`
- `GET /api/v2/traces/:traceId`

## Semantic Cache

Stable pages are fingerprinted from normalized DOM and live form values. Repeated snapshots can be reused from the semantic cache; cache state is visible in `snapshot.meta.cache_status`.

```ts
const first = await session.snapshot();
const second = await session.snapshot();
const cache = await client.getSemanticCache();
await session.invalidateCache();
```

REST endpoints:

- `GET /api/v2/cache/semantic`
- `DELETE /api/v2/cache/semantic`

## Plugin Registry and SAM

The runtime ships with a built-in Semantic Action Markup (SAM) plugin. Pages can expose explicit LLM-safe actions with data attributes:

```html
<button
  data-semantic-action="add_to_cart"
  data-semantic-label="Add item to cart"
  data-semantic-params='{"sku":"pro"}'
>
  Add
</button>
```

Or with JSON blocks:

```html
<script type="application/llm-actions+json">
  {
    "actions": [
      {
        "action": "checkout",
        "label": "Checkout",
        "selector": "#checkout-button",
        "execution": { "action": "click" }
      }
    ]
  }
</script>
```

SAM actions appear in `available_actions` with `source.standard = "SAM"` and an `execution` mapping to a safe core action. Clients can execute them by sending the SAM action name from the latest snapshot.

## Flow Actions

Agent workflows can run as one request:

- `fill_form` fills named form fields and can submit after validation.
- `multi_click` clicks a bounded list of element IDs.
- `sequence` runs ordered steps.
- `parallel` runs independent safe steps.
- `if`, `loop`, and `wait_for` handle state-dependent pages.
- `search_and_paginate` searches, follows a next control, and returns compact page slices.

```ts
await session.fillForm('login', { email: 'user@example.com', password: 'secret' }, true);

await session.sequence([
  { action: 'wait_for', params: { condition: { type: 'element_visible', element_id: 'results' } } },
  { action: 'click', target_id: 'next-page' }
]);
```

## Ops

Long-running actions can be started asynchronously and polled by operation ID:

```ts
const op = await session.start('wait_for', {
  params: {
    condition: { type: 'element_visible', element_id: 'report' },
    timeout_ms: 30000
  }
});

const status = await session.poll(op.operation_id);
await session.cancel(op.operation_id);
```

REST endpoints:

- `GET /api/v2/ops`
- `GET /api/v2/ops/:operationId`
- `POST /api/v2/ops/:operationId/cancel`

## Docker

```bash
docker compose up --build
```

Useful environment variables:

- `LLM_BROWSER_PORT`
- `LLM_BROWSER_RATE_LIMIT_PER_MINUTE`
- `LLM_BROWSER_NAVIGATE_RATE_LIMIT_PER_MINUTE`
- `LLM_BROWSER_SCREENSHOT_RATE_LIMIT_PER_MINUTE`
- `LLM_BROWSER_DOMAIN_WHITELIST`
- `LLM_BROWSER_DOMAIN_BLACKLIST`
- `LLM_BROWSER_AUDIT_ENABLED`
- `LLM_BROWSER_PLUGINS_ENABLED`
- `LLM_BROWSER_SAM_ENABLED`
- `LLM_BROWSER_PLUGINS_DIR`
- `LLM_BROWSER_FILE_ROOT`
- `LLM_BROWSER_MAX_FILE_BYTES`
- `LLM_BROWSER_FILE_DELETE_ENABLED`
- `LLM_BROWSER_SEMANTIC_CACHE_ENABLED`
- `LLM_BROWSER_SEMANTIC_CACHE_TTL_MS`
- `LLM_BROWSER_SEMANTIC_CACHE_MAX_ENTRIES`
