import {
  ActionRecord,
  ActionParam,
  AvailableAction,
  SemanticSnapshot,
  SessionState,
} from '../common/types';

export type BrowserAction =
  | 'click'
  | 'fill_form'
  | 'go_back'
  | 'hover'
  | 'if'
  | 'keyboard'
  | 'loop'
  | 'multi_click'
  | 'navigate'
  | 'parallel'
  | 'poll'
  | 'refresh'
  | 'screenshot'
  | 'search_and_paginate'
  | 'scroll'
  | 'scroll_to_element'
  | 'select'
  | 'sequence'
  | 'snapshot'
  | 'submit'
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
  | 'upload';

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
  result?: CommandResult;
  partial_result?: CommandResult;
  error?: {
    code?: string;
    message: string;
    recoverable?: boolean;
    context?: Record<string, any>;
  };
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
  };
  snapshot?: SemanticSnapshot;
}

export interface ImportSessionOptions {
  session_id?: string;
  navigate?: boolean;
  url?: string;
}

export interface ImportSessionResponse {
  session_id: string;
  imported_from_session_id: string;
  current_url?: string;
  actions_imported: number;
  snapshot_imported: boolean;
}

export interface ExecuteActionOptions {
  target_id?: string;
  params?: ActionParam;
  trace_id?: string;
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
}

export interface BrowserClientContract {
  createSession(): Promise<BrowserSessionContract>;
  listSessions(): Promise<Pagination<SessionState>>;
  exportSession(sessionId: string): Promise<SessionPack>;
  importSession(pack: SessionPack, options?: ImportSessionOptions): Promise<BrowserSessionContract>;
  listPlugins(): Promise<Pagination<PluginRuntimeInfo>>;
  listOps(sessionId?: string): Promise<Pagination<OpStatus>>;
  getAudit(sessionId?: string): Promise<Pagination<any>>;
}

export interface BrowserSessionContract {
  id: string;
  snapshot(): Promise<CommandResult>;
  export(): Promise<SessionPack>;
  diagnostics(): Promise<Record<string, any>>;
  navigate(url: string): Promise<CommandResult>;
  click(targetId: string): Promise<CommandResult>;
  type(targetId: string, text: string, options?: Record<string, any>): Promise<CommandResult>;
  select(targetId: string, value: string): Promise<CommandResult>;
  submit(targetId: string): Promise<CommandResult>;
  fillForm(formId: string, fields: Record<string, any>, submit?: boolean): Promise<CommandResult>;
  start(action: BrowserAction | string, options?: ExecuteActionOptions): Promise<OpStart>;
  poll(operationId: string): Promise<OpStatus>;
  cancel(operationId: string): Promise<OpStatus>;
  screenshot(options?: Record<string, any>): Promise<CommandResult>;
  screenshotFile(options?: Record<string, any>): Promise<CommandResult>;
  pdf(options?: Record<string, any>): Promise<CommandResult>;
  upload(targetId: string, file: Record<string, any>): Promise<CommandResult>;
  download(targetId?: string, options?: Record<string, any>): Promise<CommandResult>;
  fs(operation: 'list' | 'read' | 'write' | 'delete', path?: string, options?: Record<string, any>): Promise<CommandResult>;
  close(): Promise<void>;
}

export type { ActionRecord, AvailableAction, SemanticSnapshot, SessionState };
