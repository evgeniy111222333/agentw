import { randomUUID } from 'crypto';

export type OpState = 'running' | 'done' | 'failed' | 'cancelled';

export interface OpRecord<T = any> {
  operation_id: string;
  session_id: string;
  action: string;
  state: OpState;
  progress: number;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  estimated_time_ms?: number;
  result?: T;
  partial_result?: T;
  error?: {
    code?: string;
    message: string;
    recoverable?: boolean;
    context?: Record<string, any>;
  };
}

export interface OpStart {
  status: 'started';
  operation_id: string;
  action: string;
  state: OpState;
  estimated_time_ms: number;
  metadata: {
    trace_id: string;
  };
}

export interface OpStatus<T = any> {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  operation_id: string;
  action: string;
  state: OpState;
  progress: number;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  estimated_time_ms?: number;
  result?: T;
  partial_result?: T;
  error?: OpRecord['error'];
}

export class OpStore<T = any> {
  private records = new Map<string, OpRecord<T>>();

  start(input: {
    session_id: string;
    action: string;
    estimated_time_ms?: number;
    run: () => Promise<T>;
  }): OpRecord<T> {
    const now = new Date().toISOString();
    const record: OpRecord<T> = {
      operation_id: randomUUID(),
      session_id: input.session_id,
      action: input.action,
      state: 'running',
      progress: 0.05,
      created_at: now,
      updated_at: now,
      estimated_time_ms: input.estimated_time_ms,
    };

    this.records.set(record.operation_id, record);

    void input.run()
      .then((result) => this.done(record.operation_id, result))
      .catch((error) => this.fail(record.operation_id, error));

    return record;
  }

  get(operationId: string): OpRecord<T> | undefined {
    return this.records.get(operationId);
  }

  list(filter: { session_id?: string } = {}): OpRecord<T>[] {
    return [...this.records.values()].filter((record) => {
      if (filter.session_id && record.session_id !== filter.session_id) return false;
      return true;
    });
  }

  cancel(operationId: string): OpRecord<T> | undefined {
    const record = this.records.get(operationId);
    if (!record) return undefined;
    if (record.state === 'done' || record.state === 'failed' || record.state === 'cancelled') return record;

    record.state = 'cancelled';
    record.progress = Math.max(record.progress, 0.01);
    record.updated_at = new Date().toISOString();
    record.completed_at = record.updated_at;
    return record;
  }

  toStatus(record: OpRecord<T>): OpStatus<T> {
    return {
      status: record.state === 'done' ? 'completed' : record.state,
      operation_id: record.operation_id,
      action: record.action,
      state: record.state,
      progress: record.progress,
      created_at: record.created_at,
      updated_at: record.updated_at,
      completed_at: record.completed_at,
      estimated_time_ms: record.estimated_time_ms,
      result: record.result,
      partial_result: record.partial_result,
      error: record.error,
    };
  }

  private done(operationId: string, result: T): void {
    const record = this.records.get(operationId);
    if (!record) return;

    if (record.state === 'cancelled') {
      record.partial_result = result;
      record.updated_at = new Date().toISOString();
      return;
    }

    record.state = 'done';
    record.progress = 1;
    record.result = result;
    record.updated_at = new Date().toISOString();
    record.completed_at = record.updated_at;
  }

  private fail(operationId: string, error: any): void {
    const record = this.records.get(operationId);
    if (!record || record.state === 'cancelled') return;

    record.state = 'failed';
    record.progress = Math.max(record.progress, 0.01);
    record.error = {
      code: error?.code,
      message: error?.message ?? String(error),
      recoverable: error?.recoverable,
      context: error?.context,
    };
    record.updated_at = new Date().toISOString();
    record.completed_at = record.updated_at;
  }
}
