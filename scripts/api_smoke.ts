import { ApiServer } from '../src/layer5_agent_interface/ApiServer';
import { ConfigurationManager } from '../src/config/ConfigurationManager';
import { WebSocket } from 'ws';
import { createServer, Server } from 'http';

const port = Number(process.env.LLM_BROWSER_SMOKE_PORT ?? 3217);

async function main() {
  const configManager = ConfigurationManager.getInstance();
  const config = configManager.getConfig();
  configManager.updateConfig({
    server: {
      ...config.server,
      port,
    },
    file: {
      ...config.file,
      root_dir: `./.llm-browser/smoke-api-${port}`,
    },
  });

  const server = new ApiServer();
  await server.start();
  const fixture = await startFixtureServer(port + 100);
  const fixtureBaseUrl = `http://127.0.0.1:${port + 100}`;

  let sessionId: string | undefined;
  let importedSessionId: string | undefined;
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const sessionResponse = await fetch(`${baseUrl}/api/v2/sessions`, { method: 'POST' });
    assertOk(sessionResponse, 'create session');
    sessionId = (await sessionResponse.json()).session_id;
    if (!sessionId) throw new Error('create session response did not include session_id');
    const activeSessionId = sessionId;

    const viewport = await restAction(baseUrl, activeSessionId, {
      action: 'set_viewport',
      params: {
        profile: 'mobile',
      },
    });

    const navigate = await rpc(baseUrl, 'navigate', {
      session_id: activeSessionId,
      action_params: {
        url: `${fixtureBaseUrl}/page`,
      },
    });

    const openTabResponse = await fetch(`${baseUrl}/api/v2/sessions/${activeSessionId}/tabs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${fixtureBaseUrl}/tab?title=${encodeURIComponent('API Tab')}`,
      }),
    });
    assertOk(openTabResponse, 'open tab');
    const openedTab = await openTabResponse.json();
    const openedTabId = openedTab.data?.tab?.tab_id;
    if (!openedTabId) throw new Error('open tab did not return tab_id');

    const tabsOpenResponse = await fetch(`${baseUrl}/api/v2/sessions/${activeSessionId}/tabs`);
    assertOk(tabsOpenResponse, 'list tabs after open');
    const tabsOpen = await tabsOpenResponse.json();

    const switchTabResponse = await fetch(`${baseUrl}/api/v2/sessions/${activeSessionId}/tabs/tab-1/switch`, { method: 'POST' });
    assertOk(switchTabResponse, 'switch tab');
    const switchedTab = await switchTabResponse.json();

    const closeTabResponse = await fetch(`${baseUrl}/api/v2/sessions/${activeSessionId}/tabs/${openedTabId}`, { method: 'DELETE' });
    assertOk(closeTabResponse, 'close tab');
    const closedTab = await closeTabResponse.json();

    const tabsFinalResponse = await fetch(`${baseUrl}/api/v2/sessions/${activeSessionId}/tabs`);
    assertOk(tabsFinalResponse, 'list tabs final');
    const tabsFinal = await tabsFinalResponse.json();

    const typeAction = navigate.snapshot.available_actions.find((action: any) => action.action === 'type');
    if (!typeAction) throw new Error('type action was not discovered');
    const samAction = navigate.snapshot.available_actions.find((action: any) => action.action === 'add_to_cart');
    if (!samAction?.target) throw new Error('SAM add_to_cart action was not discovered');

    const restType = await restAction(baseUrl, activeSessionId, {
      action: 'type',
      target_id: typeAction.target,
      params: { text: 'user@example.com' },
    });

    const fillForm = await restAction(baseUrl, activeSessionId, {
      action: 'fill_form',
      target_id: 'contact',
      params: {
        fields: { email: 'flow@example.com' },
        submit: false,
      },
    });

    const search = await restAction(baseUrl, activeSessionId, {
      action: 'search_and_paginate',
      target_id: 'search',
      params: {
        query: 'alpha',
        submit_id: 'search-btn',
        collect_all_pages: true,
        next_id: 'next-page',
        max_pages: 2,
      },
    });

    const conditional = await rpc(baseUrl, 'if', {
      session_id: activeSessionId,
      action_params: {
        condition: { type: 'element_text_contains', element_id: 'status', text: 'idle' },
        then: { action: 'click', target_id: 'add-button' },
        else: { action: 'wait', params: { ms: 25 } },
      },
    });

    const samClick = await rpc(baseUrl, 'add_to_cart', {
      session_id: activeSessionId,
      target_id: samAction.target,
    });

    const waitFor = await restAction(baseUrl, activeSessionId, {
      action: 'wait_for',
      params: {
        condition: { type: 'element_text_contains', element_id: 'status', text: 'clicked' },
        timeout_ms: 1000,
        poll_interval_ms: 50,
      },
    });

    const asyncWait = await restAction(baseUrl, activeSessionId, {
      action: 'wait',
      params: {
        ms: 100,
        async: true,
      },
    });
    const asyncDone = await pollUntilOp(baseUrl, asyncWait.operation_id);
    const rpcPoll = await rpc(baseUrl, 'poll', {
      session_id: activeSessionId,
      action_params: { operation_id: asyncWait.operation_id },
    });

    const cancelStart = await restAction(baseUrl, activeSessionId, {
      action: 'wait',
      params: {
        ms: 500,
        async: true,
      },
    });
    const cancelled = await cancelOp(baseUrl, cancelStart.operation_id);

    const click = await rpc(baseUrl, 'click', {
      session_id: activeSessionId,
      target_id: 'add-button',
    });

    const screenshot = await restAction(baseUrl, activeSessionId, {
      action: 'screenshot',
      params: { full_page: false },
    });

    const fsWrite = await restAction(baseUrl, activeSessionId, {
      action: 'fs',
      params: {
        operation: 'write',
        path: '/uploads/api.txt',
        content: 'api-upload',
      },
    });

    const upload = await restAction(baseUrl, activeSessionId, {
      action: 'upload',
      target_id: 'file-input',
      params: {
        file_path: fsWrite.data?.file.path,
      },
    });

    const download = await restAction(baseUrl, activeSessionId, {
      action: 'download',
      target_id: 'download-link',
      params: {
        file_name: 'api-report.txt',
      },
    });

    const screenshotFile = await restAction(baseUrl, activeSessionId, {
      action: 'screenshot_file',
      params: {
        file_name: 'api-page.png',
        full_page: false,
      },
    });

    const pdf = await restAction(baseUrl, activeSessionId, {
      action: 'pdf',
      params: {
        file_name: 'api-page.pdf',
      },
    });

    const fsList = await restAction(baseUrl, activeSessionId, {
      action: 'fs',
      params: {
        operation: 'list',
        path: '/',
      },
    });

    const batch = await rpcBatch(baseUrl, [
      {
        jsonrpc: '2.0',
        method: 'snapshot',
        params: { session_id: activeSessionId },
        id: 'snapshot-batch',
      },
      {
        jsonrpc: '2.0',
        method: 'wait',
        params: { session_id: activeSessionId, action_params: { ms: 50 } },
        id: 'wait-batch',
      },
    ]);

    const wsSnapshot = await wsRpc(activeSessionId, 'snapshot', {});
    const wsStream = await wsStreamProbe(activeSessionId, () =>
      restAction(baseUrl, activeSessionId, { action: 'snapshot', params: { max_elements: 50 } })
    );

    const exportResponse = await fetch(`${baseUrl}/api/v2/sessions/${activeSessionId}/export`);
    assertOk(exportResponse, 'export session');
    const sessionPack = await exportResponse.json();

    const importResponse = await fetch(`${baseUrl}/api/v2/sessions/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package: sessionPack }),
    });
    assertOk(importResponse, 'import session');
    const imported = await importResponse.json();
    importedSessionId = imported.session_id;

    const importedSnapshotResponse = await fetch(`${baseUrl}/api/v2/sessions/${importedSessionId}/snapshot`);
    assertOk(importedSnapshotResponse, 'imported snapshot');
    const importedSnapshot = await importedSnapshotResponse.json();

    const diagnosticsResponse = await fetch(`${baseUrl}/api/v2/sessions/${activeSessionId}/diagnostics`);
    assertOk(diagnosticsResponse, 'session diagnostics');
    const diagnostics = await diagnosticsResponse.json();

    const authResponse = await fetch(`${baseUrl}/api/v2/sessions/${activeSessionId}/auth`);
    assertOk(authResponse, 'session auth');
    const auth = await authResponse.json();

    const tracesResponse = await fetch(`${baseUrl}/api/v2/traces?session_id=${activeSessionId}`);
    assertOk(tracesResponse, 'traces');
    const traces = await tracesResponse.json();

    const traceResponse = await fetch(`${baseUrl}/api/v2/traces/${navigate.metadata.trace_id}`);
    assertOk(traceResponse, 'trace detail');
    const trace = await traceResponse.json();

    const cacheProbeOneResponse = await fetch(`${baseUrl}/api/v2/sessions/${activeSessionId}/snapshot`);
    assertOk(cacheProbeOneResponse, 'cache probe one');
    const cacheProbeOne = await cacheProbeOneResponse.json();
    const cacheProbeTwoResponse = await fetch(`${baseUrl}/api/v2/sessions/${activeSessionId}/snapshot`);
    assertOk(cacheProbeTwoResponse, 'cache probe two');
    const cacheProbeTwo = await cacheProbeTwoResponse.json();

    const cacheResponse = await fetch(`${baseUrl}/api/v2/cache/semantic`);
    assertOk(cacheResponse, 'semantic cache');
    const cache = await cacheResponse.json();

    const snapshotResponse = await fetch(`${baseUrl}/api/v2/sessions/${activeSessionId}/snapshot`);
    assertOk(snapshotResponse, 'snapshot');
    const snapshot = await snapshotResponse.json();

    const actionsResponse = await fetch(`${baseUrl}/api/v2/sessions/${activeSessionId}/actions`);
    assertOk(actionsResponse, 'actions');
    const actions = await actionsResponse.json();

    const auditResponse = await fetch(`${baseUrl}/api/v2/audit?session_id=${activeSessionId}`);
    assertOk(auditResponse, 'audit');
    const audit = await auditResponse.json();

    const pluginResponse = await fetch(`${baseUrl}/api/v2/plugins`);
    assertOk(pluginResponse, 'plugins');
    const plugins = await pluginResponse.json();

    const opsResponse = await fetch(`${baseUrl}/api/v2/ops?session_id=${activeSessionId}`);
    assertOk(opsResponse, 'ops');
    const ops = await opsResponse.json();

    const healthResponse = await fetch(`${baseUrl}/api/v2/health`);
    assertOk(healthResponse, 'health');
    const health = await healthResponse.json();

    const eventsResponse = await fetch(`${baseUrl}/api/v2/sessions/${activeSessionId}/events?limit=50`);
    assertOk(eventsResponse, 'runtime events');
    const events = await eventsResponse.json();

    const consoleEventsResponse = await fetch(`${baseUrl}/api/v2/sessions/${activeSessionId}/events?kind=console&limit=10`);
    assertOk(consoleEventsResponse, 'console events');
    const consoleEvents = await consoleEventsResponse.json();

    const report = {
      session_id: activeSessionId,
      navigate: summarizeRpc(navigate),
      tabs: {
        opened: {
          tab_id: openedTabId,
          title: openedTab.snapshot.title,
          snapshot_tab: openedTab.snapshot.session.tab_id,
          count: openedTab.snapshot.session.tabs_count,
        },
        after_open: tabsOpen.tabs.map((tab: any) => ({ tab_id: tab.tab_id, active: tab.active, title: tab.title })),
        switched: {
          title: switchedTab.snapshot.title,
          snapshot_tab: switchedTab.snapshot.session.tab_id,
        },
        closed: closedTab.data?.closed_tab_id,
        final_count: tabsFinal.tabs.length,
      },
      viewport: {
        status: viewport.status,
        width: viewport.data?.viewport?.width,
        height: viewport.data?.viewport?.height,
        profile: viewport.data?.viewport?.profile,
        snapshot_width: viewport.snapshot.meta?.viewport?.width,
      },
      rest_type: summarizeRpc(restType),
      fill_form: summarizeRpc(fillForm),
      search: {
        status: search.status,
        pages_collected: search.data?.pages_collected,
        timing: search.timing,
      },
      conditional: summarizeRpc(conditional),
      sam_action: summarizeRpc(samClick),
      wait_for: {
        status: waitFor.status,
        elapsed_ms: waitFor.data?.elapsed_ms,
        timing: waitFor.timing,
      },
      async_wait: {
        started: asyncWait.status,
        operation_id: asyncWait.operation_id,
        final_status: asyncDone.status,
        rpc_poll_status: rpcPoll.status,
      },
      cancelled_op: {
        started: cancelStart.status,
        final_status: cancelled.status,
      },
      click: summarizeRpc(click),
      screenshot: {
        status: screenshot.status,
        mime_type: screenshot.data?.mime_type,
        image_bytes_base64: screenshot.data?.image?.length,
      },
      files: {
        fs_write: fsWrite.data?.file,
        upload_count: upload.data?.count,
        download_file: download.data?.file,
        screenshot_file: screenshotFile.data?.file,
        pdf_file: pdf.data?.file,
        root_entries: fsList.data?.entries?.length,
      },
      batch_results: batch.length,
      ws_snapshot_elements: wsSnapshot.result.snapshot.elements.length,
      ws_stream: wsStream,
      session_pack: {
        version: sessionPack.version,
        actions: sessionPack.actions.length,
        snapshot: Boolean(sessionPack.snapshot),
      },
      imported_session: {
        session_id: importedSessionId,
        actions_imported: imported.actions_imported,
        snapshot_elements: importedSnapshot.snapshot.elements.length,
      },
      diagnostics: {
        health_score: diagnostics.health.health_score,
        action_total: diagnostics.actions.total,
        events_total: diagnostics.events.stats.total,
        auth: {
          authenticated: diagnostics.session.auth?.authenticated,
          method: diagnostics.session.auth?.method,
        },
      },
      auth: {
        authenticated: auth.authenticated,
        method: auth.method,
        confidence: auth.confidence,
        indicators: auth.indicators,
      },
      traces: {
        total: traces.pagination.total_count,
        navigate_trace_status: trace.status,
        navigate_spans: trace.spans.map((span: any) => span.name),
      },
      semantic_cache: {
        entries: cache.stats.entries,
        hits: cache.stats.hits,
        misses: cache.stats.misses,
        probe_one: cacheProbeOne.snapshot.meta?.cache_status,
        probe_two: cacheProbeTwo.snapshot.meta?.cache_status,
        max_elements: cacheProbeOne.snapshot.meta?.max_elements,
      },
      events: {
        total: events.stats.total,
        by_kind: events.stats.by_kind,
        recent_errors: events.stats.recent_errors,
        console_count: consoleEvents.events.length,
        redacted: JSON.stringify(events.events).includes('%5Bredacted%5D') || JSON.stringify(events.events).includes('[redacted]'),
        recent_console: consoleEvents.events.slice(-3).map((event: any) => ({ level: event.level, text: event.text })),
      },
      rest_snapshot_elements: snapshot.snapshot.elements.length,
      rest_snapshot_meta: {
        max_elements: snapshot.snapshot.meta?.max_elements,
        semantic_nodes_total: snapshot.snapshot.meta?.semantic_nodes_total,
        privacy: snapshot.snapshot.meta?.privacy,
      },
      recorded_actions: actions.pagination.total_count,
      audit_events: audit.pagination.total_count,
      operations: ops.pagination.total_count,
      plugins: plugins.data.map((plugin: any) => ({ name: plugin.name, status: plugin.status })),
      health_status: health.status,
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (importedSessionId) {
      await fetch(`http://127.0.0.1:${port}/api/v2/sessions/${importedSessionId}`, { method: 'DELETE' }).catch(() => undefined);
    }
    if (sessionId) {
      await fetch(`http://127.0.0.1:${port}/api/v2/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => undefined);
    }
    await server.stop();
    await closeServer(fixture);
  }
}

async function rpc(baseUrl: string, method: string, params: Record<string, any>) {
  const response = await fetch(`${baseUrl}/api/v2/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: `${method}-1`,
    }),
  });
  assertOk(response, method);

  const body = await response.json();
  if (body.error) {
    throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

async function restAction(baseUrl: string, sessionId: string, body: Record<string, any>) {
  const response = await fetch(`${baseUrl}/api/v2/sessions/${sessionId}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assertOk(response, body.action);
  const result = await response.json();
  if (result.error) {
    throw new Error(`${body.action} failed: ${JSON.stringify(result.error)}`);
  }
  return result;
}

async function rpcBatch(baseUrl: string, body: Record<string, any>[]) {
  const response = await fetch(`${baseUrl}/api/v2/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assertOk(response, 'jsonrpc batch');
  const result = await response.json();
  if (!Array.isArray(result) || result.some((entry) => entry.error)) {
    throw new Error(`batch failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function pollOp(baseUrl: string, operationId: string) {
  const response = await fetch(`${baseUrl}/api/v2/ops/${operationId}`);
  assertOk(response, 'poll op');
  return response.json();
}

async function pollUntilOp(baseUrl: string, operationId: string) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const status = await pollOp(baseUrl, operationId);
    if (['completed', 'failed', 'cancelled'].includes(status.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`operation ${operationId} did not finish`);
}

async function cancelOp(baseUrl: string, operationId: string) {
  const response = await fetch(`${baseUrl}/api/v2/ops/${operationId}/cancel`, { method: 'POST' });
  assertOk(response, 'cancel op');
  return response.json();
}

async function wsRpc(sessionId: string, method: string, params: Record<string, any>) {
  return new Promise<any>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws?session_id=${sessionId}`);
    const id = `${method}-ws`;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`WebSocket ${method} timed out`));
    }, 5000);

    socket.on('open', () => {
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        method,
        params: {
          session_id: sessionId,
          ...params,
        },
        id,
      }));
    });

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'connected') return;
      if (message.id !== id) return;

      clearTimeout(timer);
      socket.close();
      if (message.error) {
        reject(new Error(`WebSocket ${method} failed: ${JSON.stringify(message.error)}`));
      } else {
        resolve(message);
      }
    });

    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function wsStreamProbe(sessionId: string, trigger: () => Promise<unknown>) {
  return new Promise<any>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws?session_id=${sessionId}`);
    const seen: string[] = [];
    let triggered = false;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`WebSocket stream timed out; seen=${seen.join(',')}`));
    }, 5000);

    const finish = () => {
      clearTimeout(timer);
      socket.close();
      resolve({
        events: seen,
        page_changed: seen.includes('page_changed'),
        action_completed: seen.includes('action_completed'),
      });
    };

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'connected') return;
      if (message.type === 'subscribed' && !triggered) {
        triggered = true;
        void trigger().catch((error) => {
          clearTimeout(timer);
          socket.close();
          reject(error);
        });
        return;
      }
      if (['page_changed', 'action_completed'].includes(message.type)) {
        seen.push(message.type);
        if (seen.includes('page_changed') && seen.includes('action_completed')) finish();
      }
    });

    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'subscribe',
        events: ['page_changed', 'action_completed'],
        id: 'stream-subscribe',
      }));
    });

    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function summarizeRpc(result: any) {
  return {
    status: result.status,
    elements: result.snapshot.elements.length,
    actions: result.snapshot.available_actions.length,
    delta_operations: result.snapshot.delta?.operations.length ?? 0,
    timing: result.timing,
    token_estimate: result.metadata.token_estimate,
  };
}

function smokeHtml(baseUrl: string): string {
  return `<!doctype html>
<html>
  <head><title>API Smoke</title></head>
  <body>
    <main>
      <h1>API Smoke</h1>
      <p id="account">Signed in as api@example.com</p>
      <button id="logout">Logout</button>
      <label>Search <input id="search" name="search" type="search" placeholder="Search"></label>
      <button id="search-btn" onclick="document.getElementById('results').textContent = 'alpha page 1'">Search</button>
      <button id="next-page" onclick="document.getElementById('results').textContent = 'alpha page 2'">Next</button>
      <p id="results">empty</p>
      <button
        id="add-button"
        data-semantic-action="add_to_cart"
        data-semantic-label="Add cart item"
        data-semantic-params='{"sku":"api-credit"}'
        onclick="document.getElementById('status').textContent = 'clicked'"
      >Add</button>
      <p id="status">idle</p>
      <input id="file-input" type="file" onchange="document.getElementById('file-status').textContent = this.files[0].name + ':' + this.files[0].size">
      <p id="file-status">empty</p>
      <a id="download-link" download="report.txt" href="data:text/plain;base64,YXBpLXJlcG9ydA==">Download report</a>
      <form id="contact"><input name="email" placeholder="Email"><button type="submit">Send</button></form>
      <script type="application/llm-actions+json">
        {"actions":[{"action":"checkout","label":"Checkout via SAM","selector":"#add-button","execution":{"action":"click"}}]}
      </script>
      <script>
        console.log('api smoke console ready');
        console.error('api smoke console error');
        fetch('${baseUrl}/probe?token=api-secret').then(() => console.log('api smoke probe done'));
        fetch('data:application/json,%7B%22ok%22%3Atrue%7D').then(() => console.log('api smoke fetch done'));
      </script>
    </main>
  </body>
</html>`;
}

async function startFixtureServer(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (requestUrl.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(smokeHtml(`http://127.0.0.1:${port}`));
      return;
    }
    if (requestUrl.pathname === '/tab') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(tabHtml(requestUrl.searchParams.get('title') ?? 'API Tab'));
      return;
    }
    if (requestUrl.pathname === '/probe') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function tabHtml(title: string): string {
  return `<!doctype html>
<html>
  <head><title>${title}</title></head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>Second tab content</p>
      <script>console.log('${title} console ready')</script>
    </main>
  </body>
</html>`;
}

function assertOk(response: Response, label: string): void {
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
