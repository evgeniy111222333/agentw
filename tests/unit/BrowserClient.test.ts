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
      if (url === 'http://example.test/api/v2/sessions/session-2/auth') {
        return jsonResponse({
          authenticated: true,
          confidence: 0.9,
          method: 'cookie',
          indicators: ['auth_cookie'],
          cookies: [{ name: 'session_id', http_only: true }],
          updated_at: '2026-05-18T00:00:00.000Z',
        });
      }
      if (url === 'http://example.test/api/v2/traces?page=1&limit=20&session_id=session-2') {
        return jsonResponse({
          data: [traceRecord()],
          pagination: pagination(1),
        });
      }
      if (url === 'http://example.test/api/v2/traces/trace-1') {
        return jsonResponse(traceRecord());
      }
      if (url === 'http://example.test/api/v2/cache/semantic') {
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        return jsonResponse({
          stats: { entries: 1, hits: 2, misses: 1, writes: 1, evictions: 0, stale: 0, bytes: 100 },
          entries: [{ key: 'cache-1', url: 'https://example.test', title: 'Example', created_at: '2026-05-18T00:00:00.000Z', hits: 2, bytes: 100 }],
        });
      }
      throw new Error(`unexpected url ${url}`);
    }) as any;

    const client = new BrowserClient({ baseUrl: 'http://example.test', fetchImpl });
    const exported = await client.exportSession('session-1');
    const imported = await client.importSession(exported, { session_id: 'session-2' });
    const diagnostics = await imported.diagnostics();
    const auth = await imported.auth();
    const traces = await imported.traces();
    const trace = await client.getTrace('trace-1');
    const cache = await client.getSemanticCache();
    await client.clearSemanticCache();

    expect(imported.id).toBe('session-2');
    expect(diagnostics.health.status).toBe('ok');
    expect(auth).toEqual(expect.objectContaining({ authenticated: true, method: 'cookie' }));
    expect(traces.data[0].trace_id).toBe('trace-1');
    expect(trace.spans[0].name).toBe('semantic.extract');
    expect(cache.stats.entries).toBe(1);
  });

  it('lists and controls tabs through the SDK', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/api/v2/sessions')) {
        return jsonResponse({ session_id: 'session-1' }, 201);
      }
      if (url === 'http://example.test/api/v2/sessions/session-1/tabs') {
        return jsonResponse({
          tabs: [
            { tab_id: 'tab-1', url: 'https://example.test/one', title: 'One', active: true },
            { tab_id: 'tab-2', url: 'https://example.test/two', title: 'Two', active: false },
          ],
        });
      }
      if (url.endsWith('/api/v2/sessions/session-1/actions')) {
        return jsonResponse(commandResult(JSON.parse(String(init?.body)).action));
      }
      throw new Error(`unexpected url ${url}`);
    }) as any;

    const client = new BrowserClient({ baseUrl: 'http://example.test', fetchImpl });
    const session = await client.createSession();
    const tabs = await session.tabs();
    await session.openTab('https://example.test/two');
    await session.switchTab('tab-2');
    await session.closeTab('tab-2');

    expect(tabs).toHaveLength(2);
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      action: 'open_tab',
      params: { url: 'https://example.test/two' },
    });
    expect(JSON.parse(String(calls[3].init?.body))).toEqual({
      action: 'switch_tab',
      params: { tab_id: 'tab-2' },
    });
    expect(JSON.parse(String(calls[4].init?.body))).toEqual({
      action: 'close_tab',
      params: { tab_id: 'tab-2' },
    });
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

function traceRecord() {
  return {
    trace_id: 'trace-1',
    session_id: 'session-2',
    action: 'snapshot',
    status: 'success',
    started_at: '2026-05-18T00:00:00.000Z',
    completed_at: '2026-05-18T00:00:00.010Z',
    duration_ms: 10,
    spans: [
      {
        span_id: 'span-1',
        name: 'semantic.extract',
        started_at: '2026-05-18T00:00:00.000Z',
        duration_ms: 10,
        status: 'ok',
      },
    ],
  };
}
