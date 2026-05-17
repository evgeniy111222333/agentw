import { ApiServer } from '../src/layer5_agent_interface/ApiServer';
import { ConfigurationManager } from '../src/config/ConfigurationManager';
import { BrowserClient } from '../src/sdk';
import { createServer, Server } from 'http';

const port = Number(process.env.LLM_BROWSER_SDK_SMOKE_PORT ?? 3227);

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
      root_dir: `./.llm-browser/smoke-sdk-${port}`,
    },
  });

  const server = new ApiServer();
  await server.start();
  const fixture = await startFixtureServer(port + 100);
  const fixtureBaseUrl = `http://127.0.0.1:${port + 100}`;

  const client = new BrowserClient({ baseUrl: `http://127.0.0.1:${port}` });
  const session = await client.createSession();
  let importedSession: any;

  try {
    const navigate = await session.navigate(`${fixtureBaseUrl}/page`);
    const openedTab = await session.openTab(`${fixtureBaseUrl}/tab?title=${encodeURIComponent('SDK Tab')}`);
    const openedTabId = openedTab.data?.tab?.tab_id;
    if (!openedTabId) throw new Error('SDK openTab did not return tab_id');
    const tabsOpen = await session.tabs();
    const switchedTab = await session.switchTab('tab-1');
    const closedTab = await session.closeTab(openedTabId);
    const tabsFinal = await session.tabs();

    const inputAction = navigate.snapshot.available_actions.find((action) => action.action === 'type');
    if (!inputAction?.target) throw new Error('No input action discovered by SDK smoke');
    const samAction = navigate.snapshot.available_actions.find((action) => action.action === 'save_profile');
    if (!samAction?.target) throw new Error('No SAM action discovered by SDK smoke');

    const typed = await session.type(inputAction.target, 'sdk@example.com');
    const filled = await session.fillForm('profile', { email: 'flow-sdk@example.com' });
    const sequence = await session.sequence([
      { action: 'wait', params: { ms: 25 } },
      { action: 'click', target_id: 'save-button' },
    ]);
    const waited = await session.waitFor({
      type: 'element_text_contains',
      element_id: 'status',
      text: 'saved',
    });
    const asyncWait = await session.start('wait', { params: { ms: 100 } });
    const asyncDone = await pollUntilDone(session, asyncWait.operation_id);
    const cancelStart = await session.start('wait', { params: { ms: 500 } });
    const cancelled = await session.cancel(cancelStart.operation_id);
    const samExecuted = await client.executeAction(session.id, 'save_profile', { target_id: samAction.target });
    const clicked = await session.click('save-button');
    const fsWrite = await session.fs('write', '/uploads/sdk.txt', { content: 'sdk-upload' });
    const upload = await session.upload('file-input', { file_path: fsWrite.data?.file.path });
    const download = await session.download('download-link', { file_name: 'sdk-report.txt' });
    const screenshotFile = await session.screenshotFile({ file_name: 'sdk-page.png', full_page: false });
    const pdf = await session.pdf({ file_name: 'sdk-page.pdf' });

    const socket = session.socket();
    const wsSnapshot = await socket.call('snapshot', { session_id: session.id });
    socket.close();

    const sessionPack = await session.export();
    importedSession = await client.importSession(sessionPack);
    const importedSnapshot = await importedSession.snapshot();
    const diagnostics = await session.diagnostics();
    const auth = await session.auth();
    const events = await session.events({ limit: 50 });
    const consoleEvents = await session.events({ kind: 'console', limit: 10 });
    const traces = await session.traces();
    const navigateTrace = await client.getTrace(navigate.metadata.trace_id);
    const cacheProbeOne = await session.snapshot();
    const cacheProbeTwo = await session.snapshot();
    const semanticCache = await client.getSemanticCache();
    const invalidated = await session.invalidateCache();

    const actions = await client.listActions(session.id);
    const audit = await client.getAudit(session.id);
    const plugins = await client.listPlugins();
    const ops = await client.listOps(session.id);

    console.log(
      JSON.stringify(
        {
          session_id: session.id,
          navigate: summarize(navigate),
          tabs: {
            opened: {
              tab_id: openedTabId,
              title: openedTab.snapshot.title,
              snapshot_tab: openedTab.snapshot.session.tab_id,
              count: openedTab.snapshot.session.tabs_count,
            },
            after_open: tabsOpen.map((tab) => ({ tab_id: tab.tab_id, active: tab.active, title: tab.title })),
            switched: {
              title: switchedTab.snapshot.title,
              snapshot_tab: switchedTab.snapshot.session.tab_id,
            },
            closed: closedTab.data?.closed_tab_id,
            final_count: tabsFinal.length,
          },
          typed: summarize(typed),
          filled: summarize(filled),
          sequence: summarize(sequence),
          waited: {
            status: waited.status,
            elapsed_ms: waited.data?.elapsed_ms,
            timing: waited.timing,
          },
          async_wait: {
            started: asyncWait.status,
            final_status: asyncDone.status,
          },
          cancelled_op: {
            started: cancelStart.status,
            final_status: cancelled.status,
          },
          sam_executed: summarize(samExecuted),
          clicked: summarize(clicked),
          files: {
            fs_write: fsWrite.data?.file,
            upload_count: upload.data?.count,
            download_file: download.data?.file,
            screenshot_file: screenshotFile.data?.file,
            pdf_file: pdf.data?.file,
          },
          session_pack: {
            version: sessionPack.version,
            actions: sessionPack.actions.length,
            snapshot: Boolean(sessionPack.snapshot),
          },
          imported_session: {
            session_id: importedSession.id,
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
            navigate_trace_status: navigateTrace.status,
            navigate_spans: navigateTrace.spans.map((span) => span.name),
          },
          semantic_cache: {
            entries: semanticCache.stats.entries,
            hits: semanticCache.stats.hits,
            misses: semanticCache.stats.misses,
            probe_one: cacheProbeOne.snapshot.meta?.cache_status,
            probe_two: cacheProbeTwo.snapshot.meta?.cache_status,
            invalidated: invalidated.data?.invalidated,
          },
          events: {
            total: events.stats.total,
            by_kind: events.stats.by_kind,
            recent_errors: events.stats.recent_errors,
            console_count: consoleEvents.events.length,
            redacted: JSON.stringify(events.events).includes('%5Bredacted%5D') || JSON.stringify(events.events).includes('[redacted]'),
            recent_console: consoleEvents.events.slice(-3).map((event) => ({ level: event.level, text: event.text })),
          },
          ws_snapshot_elements: wsSnapshot.snapshot.elements.length,
          actions_recorded: actions.pagination.total_count,
          audit_events: audit.pagination.total_count,
          operations: ops.pagination.total_count,
          plugins: plugins.data.map((plugin) => ({ name: plugin.name, status: plugin.status })),
        },
        null,
        2
      )
    );
  } finally {
    await importedSession?.close().catch(() => undefined);
    await session.close().catch(() => undefined);
    await server.stop();
    await closeServer(fixture);
  }
}

async function pollUntilDone(session: any, operationId: string) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const status = await session.poll(operationId);
    if (['completed', 'failed', 'cancelled'].includes(status.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`operation ${operationId} did not finish`);
}

function summarize(result: any) {
  return {
    status: result.status,
    action: result.action,
    elements: result.snapshot.elements.length,
    actions: result.snapshot.available_actions.length,
    delta_operations: result.snapshot.delta?.operations.length ?? 0,
    timing: result.timing,
  };
}

function smokeHtml(baseUrl: string): string {
  return `<!doctype html>
<html>
  <head><title>SDK Smoke</title></head>
  <body>
    <main>
      <h1>SDK Smoke</h1>
      <p id="account">Signed in as sdk@example.com</p>
      <button id="logout">Logout</button>
      <form id="profile">
        <label>Email <input id="email" name="email" placeholder="Email"></label>
      </form>
      <button
        id="save-button"
        data-semantic-action="save_profile"
        data-semantic-label="Save profile"
        onclick="document.getElementById('status').textContent = 'saved'"
      >Save</button>
      <p id="status">idle</p>
      <input id="file-input" type="file" onchange="document.getElementById('file-status').textContent = this.files[0].name + ':' + this.files[0].size">
      <p id="file-status">empty</p>
      <a id="download-link" download="report.txt" href="data:text/plain;base64,c2RrLXJlcG9ydA==">Download report</a>
      <script>
        console.log('sdk smoke console ready');
        console.error('sdk smoke console error');
        fetch('${baseUrl}/probe?token=sdk-secret').then(() => console.log('sdk smoke probe done'));
        fetch('data:application/json,%7B%22ok%22%3Atrue%7D').then(() => console.log('sdk smoke fetch done'));
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
      res.end(tabHtml(requestUrl.searchParams.get('title') ?? 'SDK Tab'));
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
