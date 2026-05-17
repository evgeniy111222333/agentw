import { BrowserClient, LlmBrowserApiError } from '../../src/sdk';

describe('BrowserClient SDK', () => {
  it('creates sessions and serializes high-level actions through REST', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/api/v2/sessions')) {
        return jsonResponse({ session_id: 'session-1' }, 201);
      }
      if (url.endsWith('/api/v2/sessions/session-1/actions')) {
        return jsonResponse(commandResult('type'));
      }
      throw new Error(`unexpected url ${url}`);
    }) as any;

    const client = new BrowserClient({ baseUrl: 'http://example.test', fetchImpl });
    const session = await client.createSession();
    const result = await session.type('email', 'user@example.com', { press_enter: true });
    await session.upload('file', { file_path: '/uploads/a.txt' });
    await session.screenshotFile({ file_name: 'page.png' });
    await session.pdf({ file_name: 'page.pdf' });
    await session.fs('write', '/uploads/a.txt', { content: 'a' });

    expect(session.id).toBe('session-1');
    expect(result.action).toBe('type');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      action: 'type',
      target_id: 'email',
      params: { text: 'user@example.com', press_enter: true },
    });
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      action: 'upload',
      target_id: 'file',
      params: { file_path: '/uploads/a.txt' },
    });
    expect(JSON.parse(String(calls[3].init?.body))).toEqual({
      action: 'screenshot_file',
      params: { file_name: 'page.png' },
    });
    expect(JSON.parse(String(calls[4].init?.body))).toEqual({
      action: 'pdf',
      params: { file_name: 'page.pdf' },
    });
    expect(JSON.parse(String(calls[5].init?.body))).toEqual({
      action: 'fs',
      params: { operation: 'write', path: '/uploads/a.txt', content: 'a' },
    });
  });

  it('retries recoverable rate-limit responses', async () => {
    let attempts = 0;
    const fetchImpl = jest.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse(
          {
            error: {
              code: 'RATE_LIMIT_EXCEEDED',
              message: 'too fast',
              recoverable: true,
            },
          },
          429
        );
      }
      return jsonResponse(commandResult('snapshot'));
    }) as any;

    const client = new BrowserClient({
      baseUrl: 'http://example.test',
      fetchImpl,
      retries: 1,
      retryBaseDelayMs: 1,
    });

    const result = await client.getSnapshot('session-1');

    expect(result.action).toBe('snapshot');
    expect(attempts).toBe(2);
  });

  it('lists plugin registry status through the SDK', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      expect(url).toBe('http://example.test/api/v2/plugins?page=1&limit=20');
      return jsonResponse({
        data: [
          {
            name: 'semantic-action-markup',
            version: '0.1.0',
            priority: 100,
            status: 'enabled',
            actions: [],
            extractors: [],
            warnings: [],
            failures: 0,
          },
        ],
        pagination: pagination(1),
      });
    }) as any;

    const client = new BrowserClient({ baseUrl: 'http://example.test', fetchImpl });
    const plugins = await client.listPlugins();

    expect(plugins.data[0]).toEqual(expect.objectContaining({
      name: 'semantic-action-markup',
      status: 'enabled',
    }));
  });

  it('exports, imports, and reads diagnostics for sessions', async () => {
    const pack = sessionPack();
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url === 'http://example.test/api/v2/sessions/session-1/export') {
        return jsonResponse(pack);
      }
      if (url === 'http://example.test/api/v2/sessions/import') {
        expect(JSON.parse(String(init?.body))).toEqual({
          session_id: 'session-2',
          package: pack,
        });
        return jsonResponse({ session_id: 'session-2', imported_from_session_id: 'session-1', actions_imported: 0, snapshot_imported: true }, 201);
      }
      if (url === 'http://example.test/api/v2/sessions/session-2/diagnostics') {
        return jsonResponse({ health: { status: 'ok' } });
      }
      throw new Error(`unexpected url ${url}`);
    }) as any;

    const client = new BrowserClient({ baseUrl: 'http://example.test', fetchImpl });
    const exported = await client.exportSession('session-1');
    const imported = await client.importSession(exported, { session_id: 'session-2' });
    const diagnostics = await imported.diagnostics();

    expect(imported.id).toBe('session-2');
    expect(diagnostics.health.status).toBe('ok');
  });


  it('throws typed API errors for non-retryable failures', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse(
        {
          error: {
            code: 'SECURITY_VIOLATION',
            message: 'blocked',
            recoverable: false,
          },
        },
        403
      )
    ) as any;

    const client = new BrowserClient({ baseUrl: 'http://example.test', fetchImpl, retries: 0 });

    await expect(client.getSnapshot('session-1')).rejects.toBeInstanceOf(LlmBrowserApiError);
  });
});

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function commandResult(action: string) {
  return {
    status: 'success',
    action,
    action_id: `${action}-1`,
    snapshot: {
      version: '2.2.0',
      url: 'https://example.test',
      title: 'Example',
      timestamp: '2026-05-17T00:00:00.000Z',
      elements: [],
      available_actions: [],
      session: {
        session_id: 'session-1',
        tab_id: 'tab-1',
        tabs_count: 1,
        history_length: 0,
        cookies_count: 0,
      },
    },
    timing: {
      total_ms: 1,
      action_ms: 0,
      extraction_ms: 1,
      attempts: 1,
    },
    metadata: {
      trace_id: 'trace',
      element_count: 0,
    },
  };
}

function pagination(total: number) {
  return {
    total_count: total,
    page: 1,
    limit: 20,
    total_pages: 1,
    links: {
      first: '/api/v2/plugins?page=1&limit=20',
      prev: null,
      next: null,
      last: '/api/v2/plugins?page=1&limit=20',
    },
  };
}

function sessionPack() {
  return {
    version: 'session-pack/1.0',
    exported_at: '2026-05-18T00:00:00.000Z',
    session: {
      session_id: 'session-1',
      created_at: '2026-05-18T00:00:00.000Z',
      updated_at: '2026-05-18T00:00:00.000Z',
      status: 'active',
      current_url: 'https://example.test',
      tabs: [],
      cookies: [],
      localStorage: {},
      history: [],
      configuration: {},
    },
    actions: [],
    browser: {
      storage_state: { cookies: [], origins: [] },
    },
    page: {
      url: 'https://example.test',
      title: 'Example',
    },
    snapshot: commandResult('snapshot').snapshot,
  };
}
