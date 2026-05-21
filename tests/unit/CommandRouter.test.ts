import { CommandRouter } from '../../src/layer5_agent_interface/CommandRouter';

describe('CommandRouter', () => {
  const router = new CommandRouter(
    {} as any,
    {
      getActionHistory: () => [],
      getSessionState: () => ({
        session_id: 'session',
        status: 'active',
        updated_at: new Date().toISOString(),
        current_url: 'https://example.com/start',
        tabs: [],
        history: [],
        cookies: [],
        configuration: {},
      }),
      recordAction: jest.fn(),
    } as any,
    {} as any,
    {} as any,
    new Map()
  );

  it('normalizes REST commands and strips routing params from action params', () => {
    const command = router.normalizeRest('session', {
      action: 'click',
      params: {
        element_id: 'submit',
        extra: true,
      },
      trace_id: 'trace',
    });

    expect(command).toEqual({
      action: 'click',
      session_id: 'session',
      target_id: 'submit',
      target_semantic: undefined,
      action_params: { extra: true },
      trace_id: 'trace',
    });
  });

  it('normalizes zero-shot semantic targets into action params', () => {
    const command = router.normalizeRest('session', {
      action: 'click',
      target_semantic: 'button with text "Add to Cart"',
      params: {
        timeout_ms: 1000,
      },
    });

    expect(command).toEqual({
      action: 'click',
      session_id: 'session',
      target_id: undefined,
      target_semantic: 'button with text "Add to Cart"',
      action_params: {
        timeout_ms: 1000,
        target_semantic: 'button with text "Add to Cart"',
      },
      trace_id: undefined,
    });
  });

  it('rejects invalid commands before browser execution', async () => {
    await expect(
      router.execute({
        action: 'type',
        session_id: 'session',
        target_id: 'email',
        action_params: {},
      })
    ).rejects.toMatchObject({
      code: 'MISSING_PARAM',
    });
  });

  it('validates file system action parameters before execution', async () => {
    await expect(
      router.execute({
        action: 'fs',
        session_id: 'session',
        action_params: {
          operation: 'write',
          path: '/uploads/a.txt',
        },
      })
    ).rejects.toMatchObject({
      code: 'MISSING_PARAM',
    });
  });

  it('starts async_navigate through the shared operation store', async () => {
    const state = {
      session_id: 'session',
      status: 'active',
      updated_at: new Date().toISOString(),
      current_url: 'https://example.com/start',
      tabs: [{ tab_id: 'tab-1', url: 'https://example.com/start', title: 'Start', active: true }],
      history: [],
      cookies: [],
      configuration: {},
    };
    const asyncRouter = new CommandRouter(
      {
        listTabs: jest.fn(async () => state.tabs),
        getPage: jest.fn(() => ({
          url: () => 'https://example.com/start',
          evaluate: jest.fn(async () => []),
        })),
        getViewport: jest.fn(() => ({ width: 1280, height: 720 })),
      } as any,
      {
        getActionHistory: () => [],
        getSessionState: () => state,
        recordAction: jest.fn(),
        syncTabs: jest.fn(),
        recordPageState: jest.fn(),
        updateSession: jest.fn(),
      } as any,
      {
        executeAction: jest.fn(async () => ({ action: 'navigate', duration_ms: 1, data: { url: 'https://example.com/slow' } })),
      } as any,
      {
        createSnapshot: jest.fn(async () => ({
          snapshot_id: 'snap-async',
          version: '2.2.0',
          url: 'https://example.com/slow',
          title: 'Slow',
          timestamp: new Date().toISOString(),
          elements: [],
          available_actions: [],
          session: { session_id: 'session', tab_id: 'tab-1', tabs_count: 1, history_length: 0, cookies_count: 0 },
          meta: { extraction_time: 1 },
        })),
      } as any,
      new Map()
    );

    const result = await asyncRouter.execute({
      action: 'async_navigate',
      session_id: 'session',
      action_params: {
        url: 'https://example.com/slow',
        estimated_time_ms: 1234,
      },
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'started',
      action: 'async_navigate',
      state: 'running',
      estimated_time_ms: 1234,
    }));

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(asyncRouter.getOp((result as any).operation_id, 'session')?.state).toBe('done');
    expect(asyncRouter.getOp((result as any).operation_id, 'other-session')).toBeUndefined();
  });

  it('serializes actions per session and redacts credentials from action history', async () => {
    const state = {
      session_id: 'session',
      status: 'active',
      updated_at: new Date().toISOString(),
      current_url: 'https://example.com/start',
      tabs: [{ tab_id: 'tab-1', url: 'https://example.com/start', title: 'Start', active: true }],
      history: [],
      cookies: [],
      configuration: {},
    };
    const records: any[] = [];
    const events: string[] = [];
    const queuedRouter = new CommandRouter(
      {
        listTabs: jest.fn(async () => state.tabs),
        getPage: jest.fn(() => ({
          url: () => 'https://example.com/start',
          evaluate: jest.fn(async () => []),
        })),
        getViewport: jest.fn(() => ({ width: 1280, height: 720 })),
      } as any,
      {
        getActionHistory: () => records,
        getSessionState: () => state,
        recordAction: jest.fn((record) => records.push(record)),
        syncTabs: jest.fn(),
        recordPageState: jest.fn(),
        updateSession: jest.fn(),
      } as any,
      {
        executeAction: jest.fn(async (_sessionId, action) => {
          events.push(`start:${action}`);
          await new Promise((resolve) => setTimeout(resolve, action === 'login_flow' ? 20 : 0));
          events.push(`end:${action}`);
          return { action, duration_ms: 1, data: { ok: true } };
        }),
      } as any,
      {
        createSnapshot: jest.fn(async () => ({
          snapshot_id: `snap-${records.length}`,
          version: '2.2.0',
          url: 'https://example.com/start',
          title: 'Start',
          timestamp: new Date().toISOString(),
          elements: [],
          available_actions: [],
          session: { session_id: 'session', tab_id: 'tab-1', tabs_count: 1, history_length: 0, cookies_count: 0 },
          meta: { extraction_time: 1 },
        })),
      } as any,
      new Map()
    );

    await Promise.all([
      queuedRouter.execute({
        action: 'login_flow',
        session_id: 'session',
        action_params: {
          url: 'https://example.com/login',
          credentials: { username: 'u', password: 'secret' },
        },
      }),
      queuedRouter.execute({
        action: 'wait',
        session_id: 'session',
        action_params: { ms: 1 },
      }),
    ]);

    expect(events).toEqual(['start:login_flow', 'end:login_flow', 'start:wait', 'end:wait']);
    expect(JSON.stringify(records)).not.toContain('secret');
    expect(JSON.stringify(records)).toContain('[redacted]');
  });
});
