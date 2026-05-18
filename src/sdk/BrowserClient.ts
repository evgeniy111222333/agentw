import { WebSocket } from 'ws';
import { LlmBrowserApiError, isRetryableError } from './errors';
import {
  BrowserAction,
  BrowserClientOptions,
  CommandResult,
  CreateSessionOptions,
  CreateSessionResponse,
  ExecuteActionOptions,
  ImportSessionOptions,
  ImportSessionResponse,
  OpStart,
  OpStatus,
  Pagination,
  PluginRuntimeInfo,
  RuntimeEventInfo,
  SessionPack,
  SemanticCacheInfo,
  StreamEvent,
  StreamSubscribeOptions,
  TraceRecord,
} from './types';
import { ActionRecord, AuthState, RuntimeEventKind, SessionState, TabState, ViewportState } from '../common/types';

type JsonValue = Record<string, any>;

export class BrowserClient {
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private retries: number;
  private retryBaseDelayMs: number;

  constructor(options: BrowserClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? 'http://127.0.0.1:3001');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.retries = options.retries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 100;
  }

  async createSession(options: CreateSessionOptions = {}): Promise<BrowserSession> {
    const response = await this.request<CreateSessionResponse>('/api/v2/sessions', {
      method: 'POST',
      body: Object.keys(options).length > 0 ? options : undefined,
    });
    return new BrowserSession(this, response.session_id);
  }

  async listSessions(page = 1, limit = 20): Promise<Pagination<SessionState>> {
    return this.request(`/api/v2/sessions?page=${page}&limit=${limit}`);
  }

  async exportSession(sessionId: string): Promise<SessionPack> {
    return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/export`);
  }

  async importSession(pack: SessionPack, options: ImportSessionOptions = {}): Promise<BrowserSession> {
    const response = await this.request<ImportSessionResponse>('/api/v2/sessions/import', {
      method: 'POST',
      body: {
        ...options,
        package: pack,
      },
    });
    return new BrowserSession(this, response.session_id);
  }

  async listPlugins(page = 1, limit = 20): Promise<Pagination<PluginRuntimeInfo>> {
    return this.request(`/api/v2/plugins?page=${page}&limit=${limit}`);
  }

  async listOps(sessionId?: string, page = 1, limit = 20): Promise<Pagination<OpStatus>> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (sessionId) params.set('session_id', sessionId);
    return this.request(`/api/v2/ops?${params}`);
  }

  async listTraces(sessionId?: string, page = 1, limit = 20): Promise<Pagination<TraceRecord>> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (sessionId) params.set('session_id', sessionId);
    return this.request(`/api/v2/traces?${params}`);
  }

  async getTrace(traceId: string): Promise<TraceRecord> {
    return this.request(`/api/v2/traces/${encodeURIComponent(traceId)}`);
  }

  async getSemanticCache(): Promise<SemanticCacheInfo> {
    return this.request('/api/v2/cache/semantic');
  }

  async clearSemanticCache(): Promise<void> {
    await this.request('/api/v2/cache/semantic', {
      method: 'DELETE',
      expectJson: false,
    });
  }

  async getSession(sessionId: string): Promise<SessionState> {
    return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}`);
  }

  async getDiagnostics(sessionId: string): Promise<Record<string, any>> {
    return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/diagnostics`);
  }

  async getAuth(sessionId: string): Promise<AuthState> {
    return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/auth`);
  }

  async listTabs(sessionId: string): Promise<TabState[]> {
    const response = await this.request<{ tabs: TabState[] }>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/tabs`);
    return response.tabs;
  }

  async listEvents(
    sessionId: string,
    options: { tab_id?: string; kind?: RuntimeEventKind; limit?: number } = {}
  ): Promise<RuntimeEventInfo> {
    const params = new URLSearchParams();
    if (options.tab_id) params.set('tab_id', options.tab_id);
    if (options.kind) params.set('kind', options.kind);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const suffix = params.size > 0 ? `?${params}` : '';
    return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/events${suffix}`);
  }

  async clearEvents(sessionId: string): Promise<void> {
    await this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'DELETE',
      expectJson: false,
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      expectJson: false,
    });
  }

  async getSnapshot(sessionId: string, options: { max_elements?: number } = {}): Promise<CommandResult> {
    const params = new URLSearchParams();
    if (options.max_elements !== undefined) params.set('max_elements', String(options.max_elements));
    const suffix = params.size > 0 ? `?${params}` : '';
    return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/snapshot${suffix}`);
  }

  async executeAction(
    sessionId: string,
    action: BrowserAction | string,
    options: ExecuteActionOptions = {}
  ): Promise<CommandResult> {
    return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/actions`, {
      method: 'POST',
      body: {
        action,
        target_id: options.target_id,
        params: options.params ?? {},
        trace_id: options.trace_id,
      },
    });
  }

  async startAction(
    sessionId: string,
    action: BrowserAction | string,
    options: ExecuteActionOptions = {}
  ): Promise<OpStart> {
    return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/actions`, {
      method: 'POST',
      body: {
        action,
        target_id: options.target_id,
        params: { ...(options.params ?? {}), async: true },
        trace_id: options.trace_id,
      },
    });
  }

  async getOp(operationId: string): Promise<OpStatus> {
    return this.request(`/api/v2/ops/${encodeURIComponent(operationId)}`);
  }

  async cancelOp(operationId: string): Promise<OpStatus> {
    return this.request(`/api/v2/ops/${encodeURIComponent(operationId)}/cancel`, {
      method: 'POST',
    });
  }

  async listActions(sessionId: string, page = 1, limit = 20): Promise<Pagination<ActionRecord>> {
    return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/actions?page=${page}&limit=${limit}`);
  }

  async getAudit(sessionId?: string, page = 1, limit = 20): Promise<Pagination<any>> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (sessionId) params.set('session_id', sessionId);
    return this.request(`/api/v2/audit?${params}`);
  }

  async jsonRpc(method: string, params: JsonValue, id = `${method}-${Date.now()}`): Promise<CommandResult> {
    const body = await this.request<JsonValue>('/api/v2/jsonrpc', {
      method: 'POST',
      body: {
        jsonrpc: '2.0',
        method,
        params,
        id,
      },
    });
    if (body.error) throw apiErrorFromJsonRpc(body.error);
    return body.result;
  }

  async jsonRpcBatch(calls: Array<{ method: string; params: JsonValue; id?: string }>): Promise<JsonValue[]> {
    const body = await this.request<JsonValue[]>('/api/v2/jsonrpc', {
      method: 'POST',
      body: calls.map((call, index) => ({
        jsonrpc: '2.0',
        method: call.method,
        params: call.params,
        id: call.id ?? `${call.method}-${index}`,
      })),
    });

    const error = body.find((entry) => entry.error);
    if (error) throw apiErrorFromJsonRpc(error.error);
    return body;
  }

  connectWebSocket(sessionId: string): BrowserSocket {
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/api/v2/ws?session_id=${encodeURIComponent(sessionId)}`;
    return new BrowserSocket(wsUrl, this.timeoutMs);
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      expectJson?: boolean;
    } = {}
  ): Promise<T> {
    const method = options.method ?? 'GET';
    const expectJson = options.expectJson ?? true;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
          throw await apiErrorFromResponse(response);
        }
        if (!expectJson || response.status === 204) return undefined as T;
        return (await response.json()) as T;
      } catch (error) {
        clearTimeout(timeout);
        lastError = normalizeTransportError(error);
        if (attempt >= this.retries || !isRetryableError(lastError)) break;
        await delay(this.retryBaseDelayMs * 2 ** attempt);
      }
    }

    throw lastError;
  }
}

export class BrowserSession {
  constructor(private client: BrowserClient, readonly id: string) {}

  snapshot(options: { max_elements?: number } = {}): Promise<CommandResult> {
    return this.client.getSnapshot(this.id, options);
  }

  export(): Promise<SessionPack> {
    return this.client.exportSession(this.id);
  }

  diagnostics(): Promise<Record<string, any>> {
    return this.client.getDiagnostics(this.id);
  }

  auth(): Promise<AuthState> {
    return this.client.getAuth(this.id);
  }

  traces(page = 1, limit = 20): Promise<Pagination<TraceRecord>> {
    return this.client.listTraces(this.id, page, limit);
  }

  navigate(url: string): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'navigate', { params: { url } });
  }

  asyncNavigate(url: string, options: Record<string, any> = {}): Promise<OpStart> {
    return this.client.startAction(this.id, 'async_navigate', { params: { ...options, url } });
  }

  navigateAndExtract(url: string, options: Record<string, any> = {}): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'navigate_and_extract', { params: { ...options, url } });
  }

  tabs(): Promise<TabState[]> {
    return this.client.listTabs(this.id);
  }

  events(options: { tab_id?: string; kind?: RuntimeEventKind; limit?: number } = {}): Promise<RuntimeEventInfo> {
    return this.client.listEvents(this.id, options);
  }

  clearEvents(): Promise<void> {
    return this.client.clearEvents(this.id);
  }

  openTab(url?: string): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'open_tab', { params: url ? { url } : {} });
  }

  switchTab(tabId: string): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'switch_tab', { params: { tab_id: tabId } });
  }

  closeTab(tabId?: string): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'close_tab', { params: tabId ? { tab_id: tabId } : {} });
  }

  setViewport(viewport: ViewportState | string): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'set_viewport', {
      params: typeof viewport === 'string' ? { profile: viewport } : viewport,
    });
  }

  click(targetId: string): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'click', { target_id: targetId });
  }

  interact(targetId: string): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'interact', { target_id: targetId });
  }

  type(targetId: string, text: string, options: Record<string, any> = {}): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'type', {
      target_id: targetId,
      params: { ...options, text },
    });
  }

  select(targetId: string, value: string): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'select', {
      target_id: targetId,
      params: { value },
    });
  }

  submit(targetId: string): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'submit', { target_id: targetId });
  }

  goBack(): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'go_back');
  }

  goForward(): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'go_forward');
  }

  fillForm(formId: string, fields: Record<string, any>, submit = false): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'fill_form', {
      target_id: formId,
      params: { fields, submit },
    });
  }

  fillAndVerify(formId: string, fields: Record<string, any>, options: Record<string, any> = {}): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'fill_and_verify', {
      target_id: formId,
      params: { ...options, fields },
    });
  }

  loginFlow(url: string, credentials: Record<string, any>, options: Record<string, any> = {}): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'login_flow', {
      params: { ...options, url, credentials },
    });
  }

  multiClick(targetIds: string[]): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'multi_click', {
      params: { element_ids: targetIds },
    });
  }

  sequence(steps: Array<Record<string, any>>): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'sequence', {
      params: { steps },
    });
  }

  defineScript(name: string, steps: Array<Record<string, any>>, params: string[] = []): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'define_script', {
      params: { name, steps, params },
    });
  }

  callScript(name: string, args: Record<string, any> = {}): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'call_script', {
      params: { name, args },
    });
  }

  tryAction(step: Record<string, any>, handlers: Array<Record<string, any>> | Record<string, any> = []): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'try', {
      params: { do: step, catch: handlers },
    });
  }

  waitFor(condition: Record<string, any>, options: Record<string, any> = {}): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'wait_for', {
      params: { ...options, condition },
    });
  }

  search(inputId: string, query: string, options: Record<string, any> = {}): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'search_and_paginate', {
      target_id: inputId,
      params: { ...options, query },
    });
  }

  scroll(direction: 'up' | 'down' = 'down', amount = 720): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'scroll', { params: { direction, amount } });
  }

  wait(ms = 500): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'wait', { params: { ms } });
  }

  screenshot(options: Record<string, any> = {}): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'screenshot', { params: options });
  }

  screenshotFile(options: Record<string, any> = {}): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'screenshot_file', { params: options });
  }

  pdf(options: Record<string, any> = {}): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'pdf', { params: options });
  }

  upload(targetId: string, file: Record<string, any>): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'upload', {
      target_id: targetId,
      params: file,
    });
  }

  download(targetId?: string, options: Record<string, any> = {}): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'download', {
      target_id: targetId,
      params: options,
    });
  }

  fs(operation: 'list' | 'read' | 'write' | 'delete', path?: string, options: Record<string, any> = {}): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'fs', {
      params: {
        ...options,
        operation,
        path,
      },
    });
  }

  invalidateCache(): Promise<CommandResult> {
    return this.client.executeAction(this.id, 'invalidate_cache');
  }

  start(action: BrowserAction | string, options: ExecuteActionOptions = {}): Promise<OpStart> {
    return this.client.startAction(this.id, action, options);
  }

  poll(operationId: string): Promise<OpStatus> {
    return this.client.getOp(operationId);
  }

  cancel(operationId: string): Promise<OpStatus> {
    return this.client.cancelOp(operationId);
  }

  socket(): BrowserSocket {
    return this.client.connectWebSocket(this.id);
  }

  close(): Promise<void> {
    return this.client.closeSession(this.id);
  }
}

export class BrowserSocket {
  private socket?: WebSocket;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private openPromise?: Promise<void>;
  private listeners = new Set<(event: StreamEvent) => void>();

  constructor(private url: string, private timeoutMs: number) {}

  async connect(): Promise<void> {
    if (this.openPromise) return this.openPromise;

    this.openPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.on('open', () => resolve());
      socket.on('message', (raw) => this.handleMessage(raw.toString()));
      socket.on('error', (error) => reject(error));
      socket.on('close', () => this.rejectAll(new Error('WebSocket closed')));
    });

    return this.openPromise;
  }

  async call(method: string, params: JsonValue = {}): Promise<CommandResult> {
    await this.connect();
    const id = `${method}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LlmBrowserApiError(`WebSocket ${method} timed out`, 'TIMEOUT_ACTION', 408, true));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.socket?.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
    });
  }

  async subscribe(options: StreamSubscribeOptions = {}, listener?: (event: StreamEvent) => void): Promise<Record<string, any>> {
    if (listener) this.listeners.add(listener);
    return this.control('subscribe', {
      events: options.events ?? ['*'],
      replay: options.replay,
      since: options.since,
      limit: options.limit,
    });
  }

  async unsubscribe(events?: StreamSubscribeOptions['events']): Promise<Record<string, any>> {
    return this.control('unsubscribe', { events: events ?? [] });
  }

  async replay(options: StreamSubscribeOptions = {}): Promise<Record<string, any>> {
    return this.control('replay', {
      events: options.events,
      since: options.since,
      limit: options.limit,
    });
  }

  async ping(): Promise<Record<string, any>> {
    return this.control('ping', {});
  }

  onEvent(listener: (event: StreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.socket?.close();
  }

  private async control(type: string, payload: Record<string, any>): Promise<Record<string, any>> {
    await this.connect();
    const id = `${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LlmBrowserApiError(`WebSocket ${type} timed out`, 'TIMEOUT_ACTION', 408, true));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.socket?.send(JSON.stringify({ type, ...payload, id }));
    });
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw);
    if (message.type === 'connected') return;

    const pending = message.id ? this.pending.get(message.id) : undefined;
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(message.jsonrpc === '2.0' ? apiErrorFromJsonRpc(message.error) : streamError(message.error));
      } else {
        pending.resolve(message.result ?? message);
      }
      return;
    }

    if (message.event_id && message.type) {
      for (const listener of this.listeners) listener(message as StreamEvent);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

async function apiErrorFromResponse(response: Response): Promise<LlmBrowserApiError> {
  const body = await response.json().catch(() => ({}));
  const error = body.error ?? {};
  return new LlmBrowserApiError(
    error.message ?? `HTTP ${response.status}`,
    error.code ?? 'HTTP_ERROR',
    response.status,
    Boolean(error.recoverable),
    error.context ?? {}
  );
}

function apiErrorFromJsonRpc(error: any): LlmBrowserApiError {
  return new LlmBrowserApiError(
    error.message ?? 'JSON-RPC error',
    error.data?.error_code ?? String(error.code ?? 'JSON_RPC_ERROR'),
    undefined,
    Boolean(error.data?.recoverable),
    error.data ?? {}
  );
}

function streamError(error: any): LlmBrowserApiError {
  return new LlmBrowserApiError(
    error?.message ?? 'WebSocket stream error',
    error?.code ?? 'WS_STREAM_ERROR',
    undefined,
    Boolean(error?.recoverable),
    error ?? {}
  );
}

function normalizeTransportError(error: unknown): unknown {
  if (error instanceof LlmBrowserApiError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new LlmBrowserApiError('Request timed out', 'TIMEOUT_ACTION', 408, true);
  }
  return error;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
