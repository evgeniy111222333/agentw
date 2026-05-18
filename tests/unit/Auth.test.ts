import { AuthTracker } from '../../src/auth/Auth';
import { SemanticSnapshot } from '../../src/common/types';

describe('AuthTracker', () => {
  it('detects cookie-backed authenticated pages without exposing cookie values', async () => {
    const tracker = new AuthTracker();
    const auth = await tracker.inspect(
      fakePage('https://app.test/dashboard', [
        {
          name: 'session_id',
          value: 'secret-cookie',
          domain: 'app.test',
          path: '/',
          expires: 1893456000,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ]),
      snapshot('https://app.test/dashboard', [
        { id: 'user', type: 'text', text: 'Signed in as ada@example.com' },
        { id: 'logout', type: 'button', text: 'Logout' },
      ])
    );

    expect(auth.authenticated).toBe(true);
    expect(auth.method).toBe('cookie');
    expect(auth.user_identity).toBe('ada@example.com');
    expect(auth.cookies).toEqual([
      expect.objectContaining({
        name: 'session_id',
        http_only: true,
        secure: true,
      }),
    ]);
    expect(JSON.stringify(auth)).not.toContain('secret-cookie');
  });

  it('marks login forms as unauthenticated state', async () => {
    const tracker = new AuthTracker();
    const auth = await tracker.inspect(
      fakePage('https://app.test/login', []),
      snapshot('https://app.test/login', [
        { id: 'login-form', type: 'form', label: 'Sign in' },
        { id: 'email', type: 'input', label: 'Email', input_type: 'email' },
        { id: 'password', type: 'input', label: 'Password', input_type: 'password' },
        { id: 'submit', type: 'button', text: 'Sign in' },
      ])
    );

    expect(auth.authenticated).toBe(false);
    expect(auth.login_form_detected).toBe(true);
    expect(auth.indicators).toEqual(expect.arrayContaining(['login_url', 'login_form']));
  });

  it('detects OAuth authorize redirects and provider metadata', async () => {
    const tracker = new AuthTracker();
    const auth = await tracker.inspect(
      fakePage('https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=xyz&response_type=code', []),
      snapshot('https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=xyz&response_type=code', [
        { id: 'heading', type: 'heading', text: 'Choose an account' },
      ])
    );

    expect(auth.authenticated).toBe(false);
    expect(auth.method).toBe('oauth');
    expect(auth.oauth).toEqual(expect.objectContaining({
      detected: true,
      provider: 'google',
      stage: 'authorize',
      has_state: true,
    }));
  });

  it('does not treat public login links or provider hostnames as authenticated sessions', async () => {
    const tracker = new AuthTracker();
    const auth = await tracker.inspect(
      fakePage('https://github.com/', []),
      snapshot('https://github.com/', [
        { id: 'hero', type: 'text', text: 'Build and ship software on a single platform' },
        { id: 'signin', type: 'link', text: 'Sign in', url: '/login' },
        { id: 'email', type: 'text', text: 'support@github.com' },
      ])
    );

    expect(auth.authenticated).toBe(false);
    expect(auth.method).toBeUndefined();
    expect(auth.oauth).toBeUndefined();
    expect(auth.user_identity).toBeUndefined();
    expect(auth.confidence).toBeLessThan(0.8);
  });

  it('does not mark weak anonymous token cookies as authenticated without account proof', async () => {
    const tracker = new AuthTracker();
    const auth = await tracker.inspect(
      fakePage('https://www.wikipedia.org/', [
        {
          name: 'centralAuth_Token',
          value: 'anonymous-token',
          domain: '.wikipedia.org',
          path: '/',
        },
      ]),
      snapshot('https://www.wikipedia.org/', [
        { id: 'login', type: 'link', text: 'Log in' },
        { id: 'search', type: 'input', label: 'Search Wikipedia' },
      ])
    );

    expect(auth.authenticated).toBe(false);
    expect(auth.cookies).toEqual([]);
    expect(auth.indicators).toContain('login_content');
  });
});

function fakePage(url: string, cookies: any[]): any {
  return {
    url: () => url,
    context: () => ({
      cookies: jest.fn(async () => cookies),
    }),
  };
}

function snapshot(url: string, elements: SemanticSnapshot['elements']): SemanticSnapshot {
  return {
    version: '2.2.0',
    url,
    title: 'Auth',
    timestamp: '2026-05-18T00:00:00.000Z',
    elements,
    available_actions: [],
    session: {
      session_id: 'session',
      tab_id: 'tab-1',
      tabs_count: 1,
      history_length: 0,
      cookies_count: 0,
    },
  };
}
