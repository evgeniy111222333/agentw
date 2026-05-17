import { Page } from 'playwright';
import { AuthCookieInfo, AuthState, OAuthState, SemanticElement, SemanticSnapshot } from '../common/types';

type CookieLike = {
  name: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
};

const authCookiePattern = /(^|[_\-.])(session|sid|auth|token|jwt|access|refresh|id[_-]?token|sso|oauth)($|[_\-.])/i;
const loginPathPattern = /\/(login|log-in|signin|sign-in|auth|oauth|sso)(\/|$)/i;
const accountPathPattern = /\/(dashboard|account|profile|settings|admin|workspace|home)(\/|$)/i;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export class AuthTracker {
  async inspect(page: Page, snapshot: SemanticSnapshot): Promise<AuthState> {
    const url = snapshot.url || safeUrl(page);
    const cookies = sanitizeAuthCookies(await this.readCookies(page, url));
    const oauth = detectOAuth(url);
    const text = collectText(snapshot.elements);
    const loginFormDetected = hasLoginForm(snapshot.elements, text, url);
    const userIdentity = detectIdentity(text);

    const indicators: string[] = [];
    let positive = 0;
    let negative = 0;
    let method: AuthState['method'];

    if (cookies.length > 0) {
      positive += 0.55;
      method = pickCookieMethod(cookies);
      indicators.push('auth_cookie');
    }
    if (accountPathPattern.test(url)) {
      positive += 0.2;
      indicators.push('account_url');
    }
    if (/\b(log\s*out|sign\s*out|logout|signout)\b/i.test(text)) {
      positive += 0.25;
      indicators.push('logout_control');
    }
    if (/\b(my account|account settings|profile|dashboard)\b/i.test(text)) {
      positive += 0.15;
      indicators.push('account_content');
    }
    if (userIdentity) {
      positive += 0.1;
      indicators.push('user_identity');
    }

    if (loginPathPattern.test(url)) {
      negative += 0.3;
      indicators.push('login_url');
    }
    if (loginFormDetected) {
      negative += 0.35;
      indicators.push('login_form');
      method = method ?? 'form';
    }
    if (/\b(sign\s*in|log\s*in|login|create account|forgot password)\b/i.test(text)) {
      negative += 0.15;
      indicators.push('login_content');
    }

    if (oauth.detected) {
      method = 'oauth';
      indicators.push(`oauth_${oauth.stage ?? 'unknown'}`);
      if (oauth.stage === 'callback' && oauth.has_code) {
        positive += 0.2;
      } else if (cookies.length === 0) {
        negative += 0.3;
      }
    }

    const score = positive - negative;
    const authenticated = cookies.length > 0 ? score >= 0.25 : score >= 0.3;
    const confidence = clamp(authenticated ? 0.5 + positive - negative * 0.35 : 0.5 + negative - positive * 0.35);

    return dropUndefined({
      authenticated,
      confidence: Number(confidence.toFixed(2)),
      method: method ?? (authenticated ? 'unknown' : undefined),
      session_expires_at: firstExpiry(cookies),
      user_identity: userIdentity,
      indicators: Array.from(new Set(indicators)),
      cookies,
      oauth: oauth.detected ? oauth : undefined,
      login_form_detected: loginFormDetected || undefined,
      updated_at: new Date().toISOString(),
    });
  }

  private async readCookies(page: Page, url: string): Promise<CookieLike[]> {
    try {
      return await page.context().cookies(url);
    } catch {
      return [];
    }
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

function sanitizeAuthCookies(cookies: CookieLike[]): AuthCookieInfo[] {
  return cookies
    .filter((cookie) => authCookiePattern.test(cookie.name))
    .map((cookie) =>
      dropUndefined({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        expires_at: cookie.expires && cookie.expires > 0 ? new Date(cookie.expires * 1000).toISOString() : undefined,
        http_only: cookie.httpOnly,
        secure: cookie.secure,
        same_site: cookie.sameSite,
      })
    );
}

function detectOAuth(url: string): OAuthState {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { detected: false };
  }

  const params = parsed.searchParams;
  const hasAuthorizeParams = params.has('client_id') || params.has('redirect_uri') || params.has('response_type');
  const hasCallbackParams = params.has('code') || params.has('access_token') || params.has('id_token');
  const oauthHost = /(accounts\.google|github\.com|login\.microsoftonline|okta|auth0|oauth|sso)/i.test(parsed.hostname);
  const oauthPath = /(oauth|authorize|callback|sso)/i.test(parsed.pathname);
  const detected = hasAuthorizeParams || hasCallbackParams || oauthHost || oauthPath;

  return dropUndefined({
    detected,
    provider: detected ? detectProvider(parsed.hostname) : undefined,
    stage: hasCallbackParams ? 'callback' : hasAuthorizeParams || /authorize/i.test(parsed.pathname) ? 'authorize' : detected ? 'unknown' : undefined,
    has_state: params.has('state') || undefined,
    has_code: params.has('code') || undefined,
  });
}

function detectProvider(hostname: string): string | undefined {
  const host = hostname.toLowerCase();
  if (host.includes('google')) return 'google';
  if (host.includes('github')) return 'github';
  if (host.includes('microsoft')) return 'microsoft';
  if (host.includes('okta')) return 'okta';
  if (host.includes('auth0')) return 'auth0';
  return undefined;
}

function collectText(elements: SemanticElement[]): string {
  return elements
    .map((element) => [element.label, element.text, element.placeholder, element.name, element.role].filter(Boolean).join(' '))
    .join(' ')
    .slice(0, 12000);
}

function hasLoginForm(elements: SemanticElement[], text: string, url: string): boolean {
  if (loginPathPattern.test(url) && /\b(password|passcode)\b/i.test(text)) return true;
  const passwordInput = elements.some((element) => element.type === 'input' && /password/i.test(String(element.input_type ?? element.name ?? '')));
  if (!passwordInput) return false;
  return /\b(sign\s*in|log\s*in|login|forgot password)\b/i.test(text);
}

function detectIdentity(text: string): string | undefined {
  const signedIn = /\b(?:signed in as|logged in as|welcome,?)\s+([^\s<>,;]{2,80})/i.exec(text);
  if (signedIn?.[1]) return sanitizeIdentity(signedIn[1]);
  const email = emailPattern.exec(text);
  return email?.[0] ? sanitizeIdentity(email[0]) : undefined;
}

function sanitizeIdentity(value: string): string | undefined {
  const cleaned = value.replace(/["'()[\]{}]/g, '').trim();
  if (!cleaned || /\b(password|token|secret)\b/i.test(cleaned)) return undefined;
  return cleaned.slice(0, 120);
}

function pickCookieMethod(cookies: AuthCookieInfo[]): AuthState['method'] {
  const joined = cookies.map((cookie) => cookie.name).join(' ');
  if (/oauth|sso/i.test(joined)) return 'oauth';
  if (/token|jwt|access|refresh|id[_-]?token/i.test(joined)) return 'token';
  return 'cookie';
}

function firstExpiry(cookies: AuthCookieInfo[]): string | undefined {
  return cookies
    .map((cookie) => cookie.expires_at)
    .filter((value): value is string => Boolean(value))
    .sort()[0];
}

function clamp(value: number): number {
  return Math.max(0.05, Math.min(1, value));
}

function dropUndefined<T extends Record<string, any>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
