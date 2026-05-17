import { randomUUID } from 'crypto';

export type TraceStatus = 'running' | 'success' | 'error';

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
  status: TraceStatus;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  spans: TraceSpan[];
  error?: {
    message: string;
    code?: string;
  };
}

export class TraceStore {
  private traces = new Map<string, TraceRecord>();
  private order: string[] = [];

  constructor(private retention = 1000) {}

  start(input: { trace_id: string; session_id: string; action: string; target_id?: string }): TraceRecord {
    const existing = this.traces.get(input.trace_id);
    if (existing) return existing;

    const trace: TraceRecord = {
      trace_id: input.trace_id,
      session_id: input.session_id,
      action: input.action,
      target_id: input.target_id,
      status: 'running',
      started_at: new Date().toISOString(),
      spans: [],
    };
    this.traces.set(input.trace_id, trace);
    this.order.push(input.trace_id);
    this.trim();
    return trace;
  }

  addSpan(traceId: string, span: Omit<TraceSpan, 'span_id'>): TraceSpan | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) return undefined;
    const fullSpan: TraceSpan = {
      span_id: randomUUID(),
      ...span,
    };
    trace.spans.push(fullSpan);
    return fullSpan;
  }

  finish(traceId: string, status: Exclude<TraceStatus, 'running'>, durationMs: number, error?: { message: string; code?: string }): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    trace.status = status;
    trace.completed_at = new Date().toISOString();
    trace.duration_ms = Math.round(durationMs);
    if (error) trace.error = error;
  }

  get(traceId: string): TraceRecord | undefined {
    const trace = this.traces.get(traceId);
    return trace ? clone(trace) : undefined;
  }

  list(filter: { session_id?: string; status?: TraceStatus } = {}): TraceRecord[] {
    return this.order
      .map((traceId) => this.traces.get(traceId))
      .filter((trace): trace is TraceRecord => Boolean(trace))
      .filter((trace) => {
        if (filter.session_id && trace.session_id !== filter.session_id) return false;
        if (filter.status && trace.status !== filter.status) return false;
        return true;
      })
      .map((trace) => clone(trace))
      .reverse();
  }

  stats(): Record<string, number> {
    const traces = this.list();
    return {
      retained: traces.length,
      running: traces.filter((trace) => trace.status === 'running').length,
      success: traces.filter((trace) => trace.status === 'success').length,
      error: traces.filter((trace) => trace.status === 'error').length,
    };
  }

  clear(): void {
    this.traces.clear();
    this.order = [];
  }

  private trim(): void {
    while (this.order.length > this.retention) {
      const removed = this.order.shift();
      if (removed) this.traces.delete(removed);
    }
  }
}

export const globalTraceStore = new TraceStore();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
