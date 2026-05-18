import { AuthState, PrivacyStats, SemanticSnapshot } from '../common/types';

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const jwtPattern = /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/g;
const secretPattern = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|bearer)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/gi;
const longTokenPattern = /\b[A-Za-z0-9_-]{32,}\b/g;
const phonePattern = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const cardPattern = /\b(?:\d[ -]*?){13,19}\b/g;
const sensitiveParams = new Set([
  'access_token',
  'auth',
  'code',
  'credential',
  'id_token',
  'jwt',
  'key',
  'pass',
  'passwd',
  'password',
  'pwd',
  'refresh_token',
  'secret',
  'session',
  'state',
  'token',
]);

const textKeys = new Set([
  'alt',
  'label',
  'message',
  'placeholder',
  'rows',
  'sample_items',
  'text',
  'title',
  'value',
]);

const urlKeys = new Set(['action', 'href', 'src', 'url']);

export function maskSnapshot(snapshot: SemanticSnapshot): PrivacyStats {
  const stats: PrivacyStats = { masked: 0, kinds: {} };
  snapshot.elements = snapshot.elements.map((element) => maskObject(element, stats));
  if (snapshot.forms) snapshot.forms = maskObject(snapshot.forms, stats);
  if (snapshot.alerts) snapshot.alerts = maskObject(snapshot.alerts, stats);
  if (snapshot.navigation) snapshot.navigation = maskObject(snapshot.navigation, stats);
  if (snapshot.auth) snapshot.auth = maskAuth(snapshot.auth, stats);
  return stats;
}

export function maskText(value: string, stats: PrivacyStats = { masked: 0, kinds: {} }): string {
  let next = value;
  next = replace(next, jwtPattern, '[secret]', 'secret', stats);
  next = replace(next, secretPattern, '[secret]', 'secret', stats);
  next = replace(next, emailPattern, '[email]', 'email', stats);
  next = replace(next, cardPattern, (match) => (isLikelyCard(match) ? '[card]' : match), 'card', stats);
  next = replace(next, phonePattern, (match) => (isLikelyPhone(match) ? '[phone]' : match), 'phone', stats);
  next = replace(next, longTokenPattern, (match) => (looksLikeToken(match) ? '[secret]' : match), 'secret', stats);
  return next;
}

function maskObject<T>(value: T, stats: PrivacyStats, key = ''): T {
  if (typeof value === 'string') {
    if (urlKeys.has(key)) return maskUrl(value, stats) as T;
    if (textKeys.has(key)) return maskText(value, stats) as T;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => maskObject(entry, stats, key)) as T;
  }
  if (value && typeof value === 'object') {
    const output: Record<string, any> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (typeof entryValue === 'string') {
        if (urlKeys.has(entryKey)) {
          output[entryKey] = maskUrl(entryValue, stats);
        } else if (textKeys.has(entryKey) || textKeys.has(key)) {
          output[entryKey] = maskText(entryValue, stats);
        } else {
          output[entryKey] = entryValue;
        }
      } else {
        output[entryKey] = maskObject(entryValue, stats, entryKey);
      }
    }
    return output as T;
  }
  return value;
}

function maskAuth(auth: AuthState, stats: PrivacyStats): AuthState {
  return {
    ...auth,
    user_identity: auth.user_identity ? maskText(auth.user_identity, stats) : undefined,
  };
}

function maskUrl(value: string, stats: PrivacyStats): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return maskText(value, stats);
  }

  let changed = false;
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (sensitiveParams.has(key.toLowerCase())) {
      parsed.searchParams.set(key, '[secret]');
      changed = true;
      count(stats, 'secret');
    }
  }
  const masked = maskText(parsed.toString(), stats);
  return changed ? masked : masked;
}

function replace(
  value: string,
  pattern: RegExp,
  replacement: string | ((match: string) => string),
  kind: string,
  stats: PrivacyStats
): string {
  return value.replace(pattern, (match) => {
    const next = typeof replacement === 'function' ? replacement(match) : replacement;
    if (next !== match) count(stats, kind);
    return next;
  });
}

function count(stats: PrivacyStats, kind: string): void {
  stats.masked += 1;
  stats.kinds[kind] = (stats.kinds[kind] ?? 0) + 1;
}

function isLikelyPhone(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length < 8 || digits.length > 15) return false;
  return /[+().\s-]/.test(value);
}

function isLikelyCard(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length < 13 || digits.length > 19) return false;
  return luhn(digits);
}

function looksLikeToken(value: string): boolean {
  if (/^\d+$/.test(value)) return false;
  return /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value);
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

function luhn(value: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum > 0 && sum % 10 === 0;
}
