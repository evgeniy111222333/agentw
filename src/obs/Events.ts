import { randomUUID } from 'crypto';
import { ConsoleMessage, Page, Request, Response } from 'playwright';
import { RuntimeEvent, RuntimeEventKind, RuntimeEventStats } from '../common/types';

export interface EventFilter {
  tab_id?: string;
  kind?: RuntimeEventKind;
  limit?: number;
}

interface ReqMeta {
  request_id: string;
  started: number;
}

const sensitiveParam = /token|secret|password|passwd|pwd|key|code|auth|credential|session|jwt|access|refresh|id_token|state/i;

export class Events {
  private events = new Map<string, RuntimeEvent[]>();
  private requests = new WeakMap<Request, ReqMeta>();

  constructor(private maxEvents = 500) {}

  attach(sessionId: string, tabId: string, page: Page): void {
    page.on('request', (request) => this.onRequest(sessionId, tabId, request));
    page.on('response', (response) => this.onResponse(sessionId, tabId, response));
    page.on('requestfailed', (request) => this.onFailed(sessionId, tabId, request));
    page.on('console', (message) => this.onConsole(sessionId, tabId, message));
    page.on('pageerror', (error) => this.add(sessionId, {
      event_id: randomUUID(),
      session_id: sessionId,
      tab_id: tabId,
      kind: 'page_error',
      timestamp: new Date().toISOString(),
      error: truncate(error.message),
    }));
  }

  list(sessionId: string, filter: EventFilter = {}): RuntimeEvent[] {
    const limit = Math.min(Math.max(Number(filter.limit ?? 100), 1), this.maxEvents);
    return (this.events.get(sessionId) ?? [])
      .filter((event) => !filter.tab_id || event.tab_id === filter.tab_id)
      .filter((event) => !filter.kind || event.kind === filter.kind)
      .slice(-limit)
      .map((event) => ({ ...event, location: event.location ? { ...event.location } : undefined }));
  }

  clear(sessionId: string): void {
    this.events.delete(sessionId);
  }

  stats(sessionId?: string): RuntimeEventStats {
    const events = sessionId
      ? this.events.get(sessionId) ?? []
      : Array.from(this.events.values()).flat();
    const byKind: Record<RuntimeEventKind, number> = {
      request: 0,
      response: 0,
      request_failed: 0,
      console: 0,
      page_error: 0,
    };
    let recentErrors = 0;
    const recentBoundary = Date.now() - 5 * 60 * 1000;
    for (const event of events) {
      byKind[event.kind] += 1;
      if ((event.kind === 'request_failed' || event.kind === 'page_error' || event.level === 'error') && Date.parse(event.timestamp) >= recentBoundary) {
        recentErrors += 1;
      }
    }
    return {
      total: events.length,
      by_kind: byKind,
      recent_errors: recentErrors,
    };
  }

  private onRequest(sessionId: string, tabId: string, request: Request): void {
    const meta = {
      request_id: randomUUID(),
      started: performance.now(),
    };
    this.requests.set(request, meta);
    this.add(sessionId, {
      event_id: randomUUID(),
      session_id: sessionId,
      tab_id: tabId,
      kind: 'request',
      timestamp: new Date().toISOString(),
      request_id: meta.request_id,
      method: request.method(),
      url: cleanUrl(request.url()),
      resource_type: request.resourceType(),
    });
  }

  private onResponse(sessionId: string, tabId: string, response: Response): void {
    const request = response.request();
    const meta = this.requests.get(request);
    const status = response.status();
    this.add(sessionId, {
      event_id: randomUUID(),
      session_id: sessionId,
      tab_id: tabId,
      kind: 'response',
      timestamp: new Date().toISOString(),
      request_id: meta?.request_id,
      method: request.method(),
      url: cleanUrl(response.url()),
      resource_type: request.resourceType(),
      status,
      status_text: response.statusText(),
      ok: status >= 200 && status < 400,
      duration_ms: meta ? Math.round(performance.now() - meta.started) : undefined,
    });
  }

  private onFailed(sessionId: string, tabId: string, request: Request): void {
    const meta = this.requests.get(request);
    this.add(sessionId, {
      event_id: randomUUID(),
      session_id: sessionId,
      tab_id: tabId,
      kind: 'request_failed',
      timestamp: new Date().toISOString(),
      request_id: meta?.request_id,
      method: request.method(),
      url: cleanUrl(request.url()),
      resource_type: request.resourceType(),
      duration_ms: meta ? Math.round(performance.now() - meta.started) : undefined,
      error: truncate(request.failure()?.errorText ?? 'request failed'),
    });
  }

  private onConsole(sessionId: string, tabId: string, message: ConsoleMessage): void {
    const location = message.location();
    this.add(sessionId, {
      event_id: randomUUID(),
      session_id: sessionId,
      tab_id: tabId,
      kind: 'console',
      timestamp: new Date().toISOString(),
      level: message.type(),
      text: truncate(message.text()),
      location: {
        url: location.url ? cleanUrl(location.url) : undefined,
        line: location.lineNumber,
        column: location.columnNumber,
      },
    });
  }

  private add(sessionId: string, event: RuntimeEvent): void {
    const list = this.events.get(sessionId) ?? [];
    list.push(dropUndefined(event));
    this.events.set(sessionId, list.slice(-this.maxEvents));
  }
}

function cleanUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (sensitiveParam.test(key)) url.searchParams.set(key, '[redacted]');
    }
    return url.toString();
  } catch {
    return truncate(value, 300);
  }
}

function truncate(value: string, max = 500): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function dropUndefined<T extends Record<string, any>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
