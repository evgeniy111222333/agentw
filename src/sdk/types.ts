import {
  ActionRecord,
  ActionParam,
  AuthState,
  AvailableAction,
  RuntimeEvent,
  RuntimeEventKind,
  RuntimeEventStats,
  SemanticSnapshot,
  SessionState,
  StreamEvent,
  StreamEventType,
  TabState,
  ViewportState,
} from '../common/types';

export type BrowserAction =
  | 'click'
  | 'check'
  | 'clear'
  | 'clear_form'
  | 'clear_search'
  | 'append'
  | 'fill_form'
  | 'fill_and_verify'
  | 'go_back'
  | 'go_forward'
  | 'hover'
  | 'interact'
  | 'evaluate'
  | 'if'
  | 'invalidate_cache'
  | 'keyboard'
  | 'loop'
  | 'multi_click'
  | 'navigate'
  | 'navigate_and_extract'
  | 'login_flow'
  | 'async_navigate'
  | 'new_tab'
  | 'open_tab'
  | 'parallel'
  | 'poll'
  | 'refresh'
  | 'reset_form'
  | 'screenshot'
  | 'search_and_paginate'
  | 'scroll'
  | 'scroll_to_element'
  | 'select'
  | 'select_all'
  | 'sequence'
  | 'run_flow'
  | 'browser_run_flow'
  | 'set_color'
  | 'set_date'
  | 'set_value'
  | 'set_viewport'
  | 'snapshot'
  | 'submit'
  | 'switch_tab'
  | 'type'
  | 'wait'
  | 'wait_for'
  | 'cancel'
  | 'download'
  | 'file_system'
  | 'fs'
  | 'pdf'
  | 'pdf_generate'
  | 'screenshot_file'
  | 'screenshot_to_file'
  | 'list_tabs'
  | 'close_tab'
  | 'upload'
  | 'validate_form'
  | 'visual'
  | 'define_script'
  | 'call_script'
  | 'try'
  | 'noop';

export interface CommandResult {
  status: 'success';
  action: BrowserAction | string;
  action_id: string;
  data?: Record<string, any>;
  snapshot: SemanticSnapshot;
  timing: {
    total_ms: number;
    action_ms: number;
    extraction_ms: number;
    attempts: number;
  };
  metadata: {
    trace_id: string;
    element_count: number;
    token_estimate?: number;
    rate_limit?: {
      remaining: number;
      reset_ms: number;
    };
  };
}

export interface OpStart {
  status: 'started';
  operation_id: string;
  action: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  estimated_time_ms: number;
  metadata: {
    trace_id: string;
  };
}

export interface OpStatus {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  operation_id: string;
  action: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  estimated_time_ms?: number;
  estimated_time_remaining_ms?: number;
  result?: CommandResult;
  partial_result?: CommandResult;
  error?: {
    code?: string;
    message: string;
    recoverable?: boolean;
    context?: Record<string, any>;
  };
}

export interface TraceSpan {
  span_id: string;
  name: string;
  started_at: string;
  duration_ms: number;
  status: 'ok' | 'error';
  attributes?: Record<string, any>;
  error?: {
    message: string;
    code?: string;
  };
}

export interface TraceRecord {
  trace_id: string;
  session_id: string;
  action: string;
  target_id?: string;
  status: 'running' | 'success' | 'error';
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  spans: TraceSpan[];
  error?: {
    message: string;
    code?: string;
  };
}

export interface SemanticCacheInfo {
  stats: {
    entries: number;
    hits: number;
    misses: number;
    writes: number;
    evictions: number;
    stale: number;
    bytes: number;
  };
  entries: Array<{
    key: string;
    url: string;
    title: string;
    created_at: string;
    last_hit_at?: string;
    hits: number;
    bytes: number;
  }>;
}

export interface RuntimeEventInfo {
  stats: RuntimeEventStats;
  events: RuntimeEvent[];
}

export interface StreamSubscribeOptions {
  events?: Array<StreamEventType | 'runtime' | '*' | 'all'>;
  replay?: boolean;
  since?: string;
  limit?: number;
}

export interface Pagination<T> {
  data: T[];
  pagination: {
    total_count: number;
    page: number;
    limit: number;
    total_pages: number;
    links: {
      first: string;
      prev: string | null;
      next: string | null;
      last: string;
    };
  };
}

export interface PluginRuntimeInfo {
  name: string;
  version: string;
  priority: number;
  status: 'enabled' | 'disabled';
  kind?: string;
  description?: string;
  capabilities?: string[];
  actions: Array<{ name: string; schema?: Record<string, any>; description?: string; risk?: 'low' | 'medium' | 'high' }>;
  extractors: Array<{ type: string; selector: string; description?: string }>;
  warnings: string[];
  failures: number;
  disabled_reason?: string;
  last_error?: string;
}

export interface SessionPack {
  version: string;
  exported_at: string;
  session: SessionState;
  actions: ActionRecord[];
  browser: {
    storage_state: Record<string, any>;
  };
  page: {
    url: string;
    title: string;
    viewport?: ViewportState;
  };
  snapshot?: SemanticSnapshot;
}

export interface ImportSessionOptions {
  session_id?: string;
  navigate?: boolean;
  url?: string;
  viewport?: ViewportState | string;
}

export interface ImportSessionResponse {
  session_id: string;
  ws_token?: string;
  imported_from_session_id: string;
  current_url?: string;
  actions_imported: number;
  snapshot_imported: boolean;
}

export interface ExecuteActionOptions {
  target_id?: string;
  target_semantic?: string | Record<string, any>;
  params?: ActionParam;
  trace_id?: string;
}

export interface CreateSessionOptions {
  viewport?: ViewportState | string;
}

export interface BrowserClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export interface CreateSessionResponse {
  session_id: string;
  ws_token?: string;
}

export interface BrowserClientContract {
  createSession(options?: CreateSessionOptions): Promise<BrowserSessionContract>;
  listSessions(): Promise<Pagination<SessionState>>;
  exportSession(sessionId: string): Promise<SessionPack>;
  importSession(pack: SessionPack, options?: ImportSessionOptions): Promise<BrowserSessionContract>;
  listPlugins(): Promise<Pagination<PluginRuntimeInfo>>;
  listOps(sessionId?: string): Promise<Pagination<OpStatus>>;
  listTraces(sessionId?: string): Promise<Pagination<TraceRecord>>;
  getTrace(traceId: string): Promise<TraceRecord>;
  getSemanticCache(): Promise<SemanticCacheInfo>;
  clearSemanticCache(): Promise<void>;
  getAuth(sessionId: string): Promise<AuthState>;
  listTabs(sessionId: string): Promise<TabState[]>;
  listEvents(sessionId: string, options?: { tab_id?: string; kind?: RuntimeEventKind; limit?: number }): Promise<RuntimeEventInfo>;
  clearEvents(sessionId: string): Promise<void>;
  getSnapshot(sessionId: string, options?: { max_elements?: number }): Promise<CommandResult>;
  getAudit(sessionId?: string): Promise<Pagination<any>>;
}

export interface BrowserSessionContract {
  id: string;
  snapshot(options?: { max_elements?: number }): Promise<CommandResult>;
  export(): Promise<SessionPack>;
  diagnostics(): Promise<Record<string, any>>;
  auth(): Promise<AuthState>;
  tabs(): Promise<TabState[]>;
  events(options?: { tab_id?: string; kind?: RuntimeEventKind; limit?: number }): Promise<RuntimeEventInfo>;
  clearEvents(): Promise<void>;
  traces(): Promise<Pagination<TraceRecord>>;
  navigate(url: string): Promise<CommandResult>;
  asyncNavigate(url: string, options?: Record<string, any>): Promise<OpStart>;
  navigateAndExtract(url: string, options?: Record<string, any>): Promise<CommandResult>;
  openTab(url?: string): Promise<CommandResult>;
  switchTab(tabId: string): Promise<CommandResult>;
  closeTab(tabId?: string): Promise<CommandResult>;
  setViewport(viewport: ViewportState | string): Promise<CommandResult>;
  click(targetId: string): Promise<CommandResult>;
  interact(targetId: string): Promise<CommandResult>;
  type(targetId: string, text: string, options?: Record<string, any>): Promise<CommandResult>;
  select(targetId: string, value: string): Promise<CommandResult>;
  submit(targetId: string): Promise<CommandResult>;
  goBack(): Promise<CommandResult>;
  goForward(): Promise<CommandResult>;
  fillForm(formId: string, fields: Record<string, any>, submit?: boolean): Promise<CommandResult>;
  fillAndVerify(formId: string, fields: Record<string, any>, options?: Record<string, any>): Promise<CommandResult>;
  loginFlow(url: string, credentials: Record<string, any>, options?: Record<string, any>): Promise<CommandResult>;
  multiClick(targetIds: string[]): Promise<CommandResult>;
  sequence(steps: Array<Record<string, any>>): Promise<CommandResult>;
  waitFor(condition: Record<string, any>, options?: Record<string, any>): Promise<CommandResult>;
  search(inputId: string, query: string, options?: Record<string, any>): Promise<CommandResult>;
  scroll(direction?: 'up' | 'down', amount?: number): Promise<CommandResult>;
  wait(ms?: number): Promise<CommandResult>;
  defineScript(name: string, steps: Array<Record<string, any>>, params?: string[]): Promise<CommandResult>;
  callScript(name: string, args?: Record<string, any>): Promise<CommandResult>;
  tryAction(step: Record<string, any>, handlers?: Array<Record<string, any>> | Record<string, any>): Promise<CommandResult>;
  start(action: BrowserAction | string, options?: ExecuteActionOptions): Promise<OpStart>;
  poll(operationId: string): Promise<OpStatus>;
  cancel(operationId: string): Promise<OpStatus>;
  screenshot(options?: Record<string, any>): Promise<CommandResult>;
  screenshotFile(options?: Record<string, any>): Promise<CommandResult>;
  pdf(options?: Record<string, any>): Promise<CommandResult>;
  upload(targetId: string, file: Record<string, any>): Promise<CommandResult>;
  download(targetId?: string, options?: Record<string, any>): Promise<CommandResult>;
  fs(operation: 'list' | 'read' | 'write' | 'delete', path?: string, options?: Record<string, any>): Promise<CommandResult>;
  invalidateCache(): Promise<CommandResult>;
  close(): Promise<void>;
}

export type {
  ActionRecord,
  AuthState,
  AvailableAction,
  RuntimeEvent,
  RuntimeEventKind,
  RuntimeEventStats,
  SemanticSnapshot,
  SessionState,
  StreamEvent,
  StreamEventType,
  TabState,
  ViewportState,
};
