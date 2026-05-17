import { ApiServer } from '../src/layer5_agent_interface/ApiServer';
import { ConfigurationManager } from '../src/config/ConfigurationManager';
import { BrowserClient } from '../src/sdk';

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

  const client = new BrowserClient({ baseUrl: `http://127.0.0.1:${port}` });
  const session = await client.createSession();
  let importedSession: any;

  try {
    const navigate = await session.navigate(`data:text/html;charset=utf-8,${encodeURIComponent(smokeHtml())}`);
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

    const actions = await client.listActions(session.id);
    const audit = await client.getAudit(session.id);
    const plugins = await client.listPlugins();
    const ops = await client.listOps(session.id);

    console.log(
      JSON.stringify(
        {
          session_id: session.id,
          navigate: summarize(navigate),
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

function smokeHtml(): string {
  return `<!doctype html>
<html>
  <head><title>SDK Smoke</title></head>
  <body>
    <main>
      <h1>SDK Smoke</h1>
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
    </main>
  </body>
</html>`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
