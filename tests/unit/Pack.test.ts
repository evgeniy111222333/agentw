import { importedActions, importedSession, importedSnapshot, makePack, readPack } from '../../src/session/Pack';
import { SessionState } from '../../src/common/types';

describe('Session Pack', () => {
  it('serializes and imports session state with a new session id', () => {
    const session: SessionState = {
      session_id: 'old-session',
      created_at: '2026-05-18T00:00:00.000Z',
      updated_at: '2026-05-18T00:00:01.000Z',
      status: 'active',
      current_url: 'https://example.test/app',
      tabs: [{ tab_id: 'tab-1', url: 'https://example.test/app', title: 'App', active: true }],
      cookies: [],
      localStorage: { mode: 'dark' },
      history: [{ url: 'https://example.test/app', timestamp: '2026-05-18T00:00:01.000Z' }],
      configuration: { role: 'operator' },
    };

    const pack = makePack({
      session,
      actions: [{ action_id: 'a1', session_id: 'old-session', action: 'navigate', status: 'success', requested_at: session.created_at }],
      storageState: {
        cookies: [],
        origins: [{ origin: 'https://example.test', localStorage: [{ name: 'mode', value: 'dark' }] }],
      },
      page: { url: session.current_url, title: 'App' },
      snapshot: {
        version: '2.3.0',
        url: session.current_url,
        title: 'App',
        timestamp: session.updated_at,
        elements: [],
        available_actions: [],
        session: {
          session_id: 'old-session',
          tab_id: 'tab-1',
          tabs_count: 1,
          history_length: 1,
          cookies_count: 0,
        },
      },
    });

    const parsed = readPack({ package: pack });
    const imported = importedSession(parsed, 'new-session');

    expect(parsed.version).toBe('session-pack/1.0');
    expect(imported).toEqual(expect.objectContaining({
      session_id: 'new-session',
      current_url: 'https://example.test/app',
      status: 'active',
    }));
    expect(imported.configuration).toEqual(expect.objectContaining({
      imported_from_session_id: 'old-session',
    }));
    expect(importedActions(parsed, 'new-session')[0].session_id).toBe('new-session');
    expect(importedSnapshot(parsed, 'new-session')?.session.session_id).toBe('new-session');
  });

  it('rejects unsupported package versions', () => {
    expect(() => readPack({ version: 'bad', session: { session_id: 'x' } })).toThrow(/Unsupported session package/);
  });
});
