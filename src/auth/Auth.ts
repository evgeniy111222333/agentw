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
const ignoredAuthCookiePattern = /(csrf|xsrf|nonce|visitor|guest|anon|anonymous|consent|pref|analytics|geo|wmf|wikimedia|last[-_]?access|central[-_]?auth[-_]?token)/i;
const strongAuthCookiePattern = /(^|[_\-.])(session|sid|auth|sso)($|[_\-.])/i;
const loginPathPattern = /\/(login|log-in|signin|sign-in|auth|oauth|sso)(\/|$)/i;
const accountPathPattern = /\/(dashboard|account|profile|settings|admin|workspace|home)(\/|$)/i;

export class AuthTracker {
  async inspect(page: Page, snapshot: SemanticSnapshot): Promise<AuthState> {
    const url = snapshot.url || safeUrl(page);
    const cookies = sanitizeAuthCookies(await this.readCookies(page, url));
    const oauth = detectOAuth(url);
    const text = collectText(snapshot.elements);
    const loginFormDetected = hasLoginForm(snapshot.elements, text, url);
    const loginContentDetected = /\b(sign\s*in|log\s*in|login|create account|forgot password)\b/i.test(text);
    const userIdentity = detectIdentity(text);
    const logoutDetected = /\b(log\s*out|sign\s*out|logout|signout)\b/i.test(text);
    const accountContentDetected = /\b(my account|account settings|profile|dashboard)\b/i.test(text);
    const accountUrlDetected = accountPathPattern.test(url);
    const strongCookieDetected = cookies.some((cookie) => strongAuthCookiePattern.test(cookie.name));

    const indicators: string[] = [];
    let positive = 0;
    let negative = 0;
    let method: AuthState['method'];
    let strongProof = false;

    if (cookies.length > 0) {
      positive += strongCookieDetected ? 0.55 : 0.25;
      method = pickCookieMethod(cookies);
      indicators.push('auth_cookie');
    }
    if (accountUrlDetected) {
      positive += 0.25;
      strongProof = true;
      indicators.push('account_url');
    }
    if (logoutDetected) {
      positive += 0.4;
      strongProof = true;
      indicators.push('logout_control');
    }
    if (accountContentDetected) {
      positive += 0.25;
      strongProof = true;
      indicators.push('account_content');
    }
    if (userIdentity) {
      positive += 0.2;
      strongProof = true;
      indicators.push('user_identity');
    }

    if (loginPathPattern.test(url)) {
      negative += 0.5;
      indicators.push('login_url');
    }
    if (loginFormDetected) {
      negative += 0.55;
      indicators.push('login_form');
      method = method ?? 'form';
    }
    if (loginContentDetected) {
      negative += 0.2;
      indicators.push('login_content');
    }

    if (oauth.detected) {
      indicators.push(`oauth_${oauth.stage ?? 'unknown'}`);
      if (oauth.stage !== 'unknown') method = 'oauth';
      if (oauth.stage === 'callback' && oauth.has_code) {
        positive += 0.15;
      } else if (oauth.stage === 'authorize') {
        negative += 0.35;
      } else {
        negative += 0.1;
      }
    }

    const authenticated =
      positive >= 0.55 &&
      negative < 0.55 &&
      (strongProof || (strongCookieDetected && !loginFormDetected && !loginContentDetected));
    const confidence = authenticated
      ? clamp(0.55 + positive * 0.35 - negative * 0.25)
      : clamp(0.5 + Math.min(0.3, negative * 0.35) - Math.min(0.2, positive * 0.2));
    const finalMethod = authenticated || (oauth.detected && oauth.stage !== 'unknown') ? method : loginFormDetected ? 'form' : undefined;

    return dropUndefined({
      authenticated,
      confidence: Number(confidence.toFixed(2)),
      method: finalMethod ?? (authenticated ? 'unknown' : undefined),
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
    .filter((cookie) => authCookiePattern.test(cookie.name) && !ignoredAuthCookiePattern.test(cookie.name))
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
  const authProviderHost = /(accounts\.google|login\.microsoftonline|okta|auth0|oauth|sso)/i.test(parsed.hostname);
  const githubOAuth = /(^|\.)github\.com$/i.test(parsed.hostname) && /\/login\/oauth|\/oauth|\/authorize/i.test(parsed.pathname);
  const oauthPath = /(oauth|authorize|callback|sso)/i.test(parsed.pathname);
  const detected = hasAuthorizeParams || hasCallbackParams || githubOAuth || oauthPath || (authProviderHost && !/^github\.com$/i.test(parsed.hostname));

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
  const signedIn = /\b(?:signed in as|logged in as|authenticated as|welcome,?)\s+([^\s<>,;]{2,80})/i.exec(text);
  return signedIn?.[1] ? sanitizeIdentity(signedIn[1]) : undefined;
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
