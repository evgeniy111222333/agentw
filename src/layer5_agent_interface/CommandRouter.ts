import { randomUUID } from 'crypto';
import { BrowserCore } from '../layer1_browser_core/BrowserCore';
import { ActionExecutor, ActionExecutionResult } from '../layer2_action_execution/ActionExecutor';
import { StateManagementLayer } from '../layer3_state_management/StateManagementLayer';
import { SemanticLayer } from '../layer4_semantic/SemanticLayer';
import { globalMetrics } from '../common/MetricsRegistry';
import { ActionRecord, AvailableAction, SemanticSnapshot, SessionInfo } from '../common/types';
import { LlmBrowserError, normalizeError } from '../common/errors';
import { globalAuditLog, riskScoreForAction } from '../common/AuditLog';
import { SecurityPolicy } from '../security/SecurityPolicy';
import { OpStart, OpStatus, OpStore } from '../op/Op';
import { globalTraceStore } from '../trace/Trace';

export interface AgentCommand {
  action: string;
  session_id: string;
  target_id?: string;
  action_params?: Record<string, any>;
  trace_id?: string;
}

export interface CommandResult {
  status: 'success';
  action: string;
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

export type RouterResult = CommandResult | OpStart | OpStatus<CommandResult>;

type ActionSchema = {
  target?: 'required' | 'optional' | 'none';
  requiredParams?: string[];
  validate?: (params: Record<string, any>) => void;
  retryable?: boolean;
};

interface ResolvedAction {
  schema: ActionSchema;
  executionAction: string;
  targetId?: string;
  params: Record<string, any>;
  availableAction?: AvailableAction;
}

const actionSchemas: Record<string, ActionSchema> = {
  click: { target: 'required', retryable: true },
  go_back: { target: 'none', retryable: true },
  hover: { target: 'required', retryable: true },
  keyboard: { target: 'none', requiredParams: ['key'] },
  navigate: { target: 'none', requiredParams: ['url'], retryable: true },
  refresh: { target: 'none', retryable: true },
  screenshot: { target: 'optional', retryable: true },
  screenshot_file: { target: 'optional', retryable: true },
  screenshot_to_file: { target: 'optional', retryable: true },
  pdf: { target: 'none', retryable: true },
  pdf_generate: { target: 'none', retryable: true },
  download: { target: 'optional', retryable: true },
  upload: {
    target: 'required',
    validate: (params) => {
      if (
        params.file_path === undefined &&
        params.file_paths === undefined &&
        params.files === undefined &&
        params.file_content === undefined &&
        params.content === undefined &&
        params.base64 === undefined
      ) {
        throw new LlmBrowserError('MISSING_PARAM', 'upload requires file_path, file_paths, files, or file_content');
      }
    },
  },
  fs: {
    target: 'none',
    validate: validateFsParams,
  },
  file_system: {
    target: 'none',
    validate: validateFsParams,
  },
  fill_form: {
    target: 'optional',
    requiredParams: ['fields'],
    validate: (params) => {
      if (!params.fields || typeof params.fields !== 'object' || Array.isArray(params.fields)) {
        throw new LlmBrowserError('INVALID_PARAMS', 'fill_form fields must be an object');
      }
    },
  },
  if: { target: 'none', requiredParams: ['condition'] },
  loop: {
    target: 'none',
    validate: (params) => {
      if (!params.condition && !params.while) throw new LlmBrowserError('MISSING_PARAM', 'loop condition is required');
      if (!params.do?.action) throw new LlmBrowserError('MISSING_PARAM', 'loop do action is required');
    },
  },
  multi_click: {
    target: 'optional',
    validate: (params) => {
      const ids = params.element_ids ?? params.target_ids ?? params.targets;
      if (ids !== undefined && !Array.isArray(ids)) throw new LlmBrowserError('INVALID_PARAMS', 'multi_click ids must be an array');
    },
  },
  parallel: {
    target: 'none',
    validate: (params) => {
      if (!Array.isArray(params.steps ?? params.actions)) throw new LlmBrowserError('MISSING_PARAM', 'parallel steps are required');
    },
  },
  search_and_paginate: { target: 'optional', requiredParams: ['query'] },
  scroll: {
    target: 'optional',
    validate: (params) => {
      if (params.direction !== undefined && !['up', 'down'].includes(params.direction)) {
        throw new LlmBrowserError('INVALID_PARAMS', 'scroll direction must be "up" or "down"');
      }
    },
    retryable: true,
  },
  scroll_to_element: { target: 'required', retryable: true },
  select: { target: 'required', requiredParams: ['value'], retryable: true },
  snapshot: { target: 'none' },
  sequence: {
    target: 'none',
    validate: (params) => {
      if (!Array.isArray(params.steps)) throw new LlmBrowserError('MISSING_PARAM', 'sequence steps are required');
    },
  },
  submit: { target: 'required', retryable: true },
  type: { target: 'required', requiredParams: ['text'], retryable: true },
  wait: { target: 'none' },
  wait_for: { target: 'none', requiredParams: ['condition'], retryable: true },
  poll: { target: 'none', requiredParams: ['operation_id'] },
  cancel: { target: 'none', requiredParams: ['operation_id'] },
};

export class CommandRouter {
  constructor(
    private browserCore: BrowserCore,
    private stateManager: StateManagementLayer,
    private actionExecutor: ActionExecutor,
    private semanticLayer: SemanticLayer,
    private previousSnapshots: Map<string, SemanticSnapshot>,
    private securityPolicy = new SecurityPolicy(stateManager),
    private ops = new OpStore<CommandResult>()
  ) {}

  async execute(command: AgentCommand): Promise<RouterResult> {
    if (command.action === 'poll') return this.poll(command);
    if (command.action === 'cancel') return this.cancel(command);
    if (command.action_params?.async === true) return this.start(command);
    return this.executeSync(command);
  }

  listOps(sessionId?: string): OpStatus<CommandResult>[] {
    return this.ops.list({ session_id: sessionId }).map((record) => this.ops.toStatus(record));
  }

  getOp(operationId: string): OpStatus<CommandResult> | undefined {
    const record = this.ops.get(operationId);
    return record ? this.ops.toStatus(record) : undefined;
  }

  cancelOp(operationId: string): OpStatus<CommandResult> | undefined {
    const record = this.ops.cancel(operationId);
    return record ? this.ops.toStatus(record) : undefined;
  }

  private async start(command: AgentCommand): Promise<OpStart> {
    const traceId = command.trace_id ?? randomUUID();
    const actionParams = stripOpParams(command.action_params ?? {});
    const asyncCommand = {
      ...command,
      trace_id: traceId,
      action_params: actionParams,
    };
    const resolvedAction = this.validateCommand(asyncCommand);
    this.securityPolicy.authorize({
      ...asyncCommand,
      action: resolvedAction.executionAction,
      target_id: resolvedAction.targetId,
      action_params: resolvedAction.params,
    });

    const estimatedTimeMs = estimateMs(resolvedAction.executionAction, resolvedAction.params);
    const op = this.ops.start({
      session_id: command.session_id,
      action: command.action,
      estimated_time_ms: estimatedTimeMs,
      run: () => this.executeSync(asyncCommand, {
        traceId,
        resolvedAction,
        securityDecision: { rate_limit: undefined },
        skipSecurity: true,
      }),
    });

    globalMetrics.increment('llm_browser_ops_started_total');
    globalAuditLog.record({
      category: 'ACTION',
      session_id: command.session_id,
      action: command.action,
      target: resolvedAction.targetId,
      result: 'success',
      request_id: traceId,
      risk_score: riskScoreForAction(command.action),
      metadata: {
        operation_id: op.operation_id,
        async: true,
      },
    });

    return {
      status: 'started',
      operation_id: op.operation_id,
      action: command.action,
      state: op.state,
      estimated_time_ms: estimatedTimeMs,
      metadata: {
        trace_id: traceId,
      },
    };
  }

  private poll(command: AgentCommand): OpStatus<CommandResult> {
    const operationId = command.action_params?.operation_id;
    if (!operationId) throw new LlmBrowserError('MISSING_PARAM', 'operation_id is required for poll');
    const status = this.getOp(String(operationId));
    if (!status) throw new LlmBrowserError('ELEMENT_NOT_FOUND', 'Operation not found', { operation_id: operationId });
    if (status.result?.snapshot) {
      this.previousSnapshots.set(status.result.snapshot.session.session_id, status.result.snapshot);
    }
    return status;
  }

  private cancel(command: AgentCommand): OpStatus<CommandResult> {
    const operationId = command.action_params?.operation_id;
    if (!operationId) throw new LlmBrowserError('MISSING_PARAM', 'operation_id is required for cancel');
    const status = this.cancelOp(String(operationId));
    if (!status) throw new LlmBrowserError('ELEMENT_NOT_FOUND', 'Operation not found', { operation_id: operationId });
    globalMetrics.increment('llm_browser_ops_cancelled_total');
    return status;
  }

  private async executeSync(
    command: AgentCommand,
    preflight?: {
      traceId: string;
      resolvedAction: ResolvedAction;
      securityDecision: ReturnType<SecurityPolicy['authorize']>;
      skipSecurity?: boolean;
    }
  ): Promise<CommandResult> {
    const requestStart = performance.now();
    const traceId = preflight?.traceId ?? command.trace_id ?? randomUUID();
    const actionId = randomUUID();
    const params = command.action_params ?? {};
    const action = command.action;
    const requestedAt = new Date().toISOString();
    let securityDecision: ReturnType<SecurityPolicy['authorize']> = {};
    let resolvedAction: ResolvedAction | undefined;

    let execution: ActionExecutionResult | undefined;
    let attempts = 0;
    globalTraceStore.start({
      trace_id: traceId,
      session_id: command.session_id,
      action,
      target_id: command.target_id,
    });

    try {
      resolvedAction = preflight?.resolvedAction ?? this.traceSync(traceId, 'router.validate', { action }, () =>
        this.validateCommand({ ...command, trace_id: traceId, action_params: params })
      );
      if (preflight?.resolvedAction) {
        this.traceInstant(traceId, 'router.validate', { action, preflight: true });
      }
      const activeAction = resolvedAction;
      securityDecision = preflight?.securityDecision ?? {};
      if (!preflight?.skipSecurity) {
        securityDecision = this.traceSync(traceId, 'security.authorize', { action: activeAction.executionAction }, () =>
          this.securityPolicy.authorize({
            ...command,
            action: activeAction.executionAction,
            target_id: activeAction.targetId,
            trace_id: traceId,
            action_params: activeAction.params,
          })
        );
      } else {
        this.traceInstant(traceId, 'security.authorize', { action: activeAction.executionAction, skipped: true });
      }
      this.recordAction({
        action_id: actionId,
        session_id: command.session_id,
        action,
        target_id: command.target_id ?? activeAction.targetId,
        params,
        status: 'requested',
        requested_at: requestedAt,
        trace_id: traceId,
      });

      globalMetrics.increment('llm_browser_actions_total');

      if (activeAction.executionAction !== 'snapshot') {
        execution = await this.traceAsync(
          traceId,
          'action.execute',
          {
            action: activeAction.executionAction,
            target_id: activeAction.targetId,
          },
          () => this.executeWithRetry(
            command.session_id,
            activeAction.executionAction,
            activeAction.targetId,
            activeAction.params
          )
        );
      }

      const page = this.browserCore.getPage(command.session_id);
      const previousSnapshot = this.previousSnapshots.get(command.session_id);
      const snapshot = await this.traceAsync(
        traceId,
        'semantic.extract',
        {
          previous_snapshot: Boolean(previousSnapshot),
        },
        () => this.semanticLayer.createSnapshot(page, {
          previousSnapshot,
          session: this.createSessionInfo(command.session_id),
          actionTime: execution?.duration_ms ?? 0,
          totalTime: Math.round(performance.now() - requestStart),
          traceId,
        })
      );

      this.previousSnapshots.set(command.session_id, snapshot);
      this.stateManager.recordPageState(command.session_id, {
        url: snapshot.url,
        title: snapshot.title,
        snapshot_id: snapshot.snapshot_id,
      });

      const totalTime = Math.round(performance.now() - requestStart);
      if (snapshot.meta) snapshot.meta.total_time = totalTime;

      const completed: ActionRecord = {
        action_id: actionId,
        session_id: command.session_id,
        action,
        target_id: command.target_id ?? resolvedAction.targetId,
        params,
        status: 'success',
        requested_at: requestedAt,
        completed_at: new Date().toISOString(),
        duration_ms: totalTime,
        trace_id: traceId,
        token_estimate: snapshot.meta?.token_estimate,
      };
      this.recordAction(completed);

      globalMetrics.increment('llm_browser_actions_succeeded_total');
      globalMetrics.increment('llm_browser_snapshots_total');
      globalMetrics.observe('llm_browser_action_duration', execution?.duration_ms ?? 0);
      globalMetrics.observe('llm_browser_extraction_duration', snapshot.meta?.extraction_time ?? 0);
      globalMetrics.observe('llm_browser_snapshot_size_bytes', snapshot.meta?.snapshot_bytes ?? 0);
      attempts = Number(execution?.data?.attempts ?? 1);
      globalAuditLog.record({
        category: 'ACTION',
        session_id: command.session_id,
        action,
        target: command.target_id ?? resolvedAction.targetId,
        result: 'success',
        duration_ms: totalTime,
        request_id: traceId,
        risk_score: riskScoreForAction(action),
        metadata: {
          token_estimate: snapshot.meta?.token_estimate,
          attempts,
        },
      });
      globalTraceStore.finish(traceId, 'success', totalTime);
      globalMetrics.increment('llm_browser_traces_completed_total');

      return {
        status: 'success',
        action,
        action_id: actionId,
        data: execution?.data,
        snapshot,
        timing: {
          total_ms: totalTime,
          action_ms: execution?.duration_ms ?? 0,
          extraction_ms: snapshot.meta?.extraction_time ?? 0,
          attempts,
        },
        metadata: {
          trace_id: traceId,
          element_count: snapshot.elements.length,
          token_estimate: snapshot.meta?.token_estimate,
          rate_limit: securityDecision.rate_limit,
        },
      };
    } catch (error) {
      const normalized = normalizeError(error, {
        session_id: command.session_id,
        action,
        target_id: command.target_id ?? resolvedAction?.targetId,
        trace_id: traceId,
      });

      this.recordAction({
        action_id: actionId,
        session_id: command.session_id,
        action,
        target_id: command.target_id ?? resolvedAction?.targetId,
        params,
        status: 'error',
        requested_at: requestedAt,
        completed_at: new Date().toISOString(),
        duration_ms: Math.round(performance.now() - requestStart),
        error_code: normalized.code,
        error_message: normalized.message,
        trace_id: traceId,
      });
      globalAuditLog.record({
        category: normalized.code === 'RATE_LIMIT_EXCEEDED' || normalized.code === 'SECURITY_VIOLATION' ? 'SECURITY' : 'ACTION',
        session_id: command.session_id,
        action,
        target: command.target_id ?? resolvedAction?.targetId,
        result: normalized.code === 'RATE_LIMIT_EXCEEDED' || normalized.code === 'SECURITY_VIOLATION' ? 'blocked' : 'error',
        duration_ms: Math.round(performance.now() - requestStart),
        request_id: traceId,
        risk_score: riskScoreForAction(action),
        error_code: normalized.code,
        message: normalized.message,
      });
      globalMetrics.increment('llm_browser_actions_failed_total');
      globalTraceStore.finish(traceId, 'error', Math.round(performance.now() - requestStart), {
        message: normalized.message,
        code: normalized.code,
      });
      globalMetrics.increment('llm_browser_traces_failed_total');
      throw normalized;
    }
  }

  normalizeJsonRpc(method: string, params: any): AgentCommand {
    const actionParams = params?.action_params ?? params?.parameters ?? params?.params ?? {};
    const targetId =
      params?.target_id ??
      params?.element_id ??
      actionParams.element_id ??
      actionParams.target_id ??
      actionParams.form_id ??
      actionParams.search_input_id;
    return {
      action: method,
      session_id: params?.session_id,
      target_id: targetId,
      action_params: stripRoutingParams(actionParams),
      trace_id: params?.trace_id,
    };
  }

  normalizeRest(sessionId: string, body: any): AgentCommand {
    const actionParams = body?.params ?? body?.action_params ?? body?.parameters ?? {};
    const targetId =
      body?.target_id ??
      body?.element_id ??
      actionParams.element_id ??
      actionParams.target_id ??
      actionParams.form_id ??
      actionParams.search_input_id;
    return {
      action: body?.action,
      session_id: sessionId,
      target_id: targetId,
      action_params: stripRoutingParams(actionParams),
      trace_id: body?.trace_id,
    };
  }

  private async executeWithRetry(
    sessionId: string,
    action: string,
    targetId: string | undefined,
    params: Record<string, any>
  ): Promise<ActionExecutionResult> {
    const schema = actionSchemas[action];
    const maxAttempts = schema?.retryable ? 2 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.actionExecutor.executeAction(sessionId, action, targetId, params);
        return {
          ...result,
          data: {
            ...result.data,
            attempts: attempt,
          },
        };
      } catch (error) {
        lastError = error;
        const normalized = normalizeError(error);
        if (!normalized.recoverable || attempt === maxAttempts) break;
        await delay(100 * attempt);
      }
    }

    throw lastError;
  }

  private validateCommand(command: AgentCommand): ResolvedAction {
    if (!command.session_id || !this.stateManager.getSessionState(command.session_id)) {
      throw new LlmBrowserError('SESSION_NOT_FOUND', 'Session not found', { session_id: command.session_id });
    }

    const schema = actionSchemas[command.action];
    if (schema) {
      const resolved = {
        schema,
        executionAction: command.action,
        targetId: command.target_id,
        params: command.action_params ?? {},
      };
      this.validateAgainstSchema(command.action, resolved.schema, resolved.targetId, resolved.params);
      return resolved;
    }

    const dynamic = this.resolveDynamicAction(command);
    if (!dynamic) {
      throw new LlmBrowserError('INVALID_ACTION', `Unknown action: ${command.action}`);
    }

    this.validateAgainstSchema(dynamic.executionAction, dynamic.schema, dynamic.targetId, dynamic.params);
    return dynamic;
  }

  private resolveDynamicAction(command: AgentCommand): ResolvedAction | undefined {
    const snapshot = this.previousSnapshots.get(command.session_id);
    if (!snapshot) return undefined;

    const availableAction = snapshot.available_actions.find((candidate) => {
      const actionMatches = candidate.action === command.action || candidate.action_id === command.action;
      const targetMatches = !command.target_id || candidate.target === command.target_id;
      return actionMatches && targetMatches && candidate.execution;
    });
    if (!availableAction?.execution) return undefined;

    const executionSchema = actionSchemas[availableAction.execution.action];
    if (!executionSchema) {
      throw new LlmBrowserError('INVALID_ACTION', `Plugin action cannot execute unsupported core action: ${availableAction.execution.action}`);
    }

    const params = {
      ...(availableAction.execution.params ?? {}),
      ...(command.action_params ?? {}),
    };
    let targetId = command.target_id ?? availableAction.execution.target ?? availableAction.target;
    if (executionSchema.target === 'none') {
      targetId = undefined;
    }

    return {
      schema: executionSchema,
      executionAction: availableAction.execution.action,
      targetId,
      params,
      availableAction,
    };
  }

  private validateAgainstSchema(
    action: string,
    schema: ActionSchema,
    targetId: string | undefined,
    params: Record<string, any>
  ): void {
    if (schema.target === 'required' && !targetId) {
      throw new LlmBrowserError('MISSING_PARAM', `target_id is required for ${action}`);
    }

    if (schema.target === 'none' && targetId) {
      throw new LlmBrowserError('INVALID_PARAMS', `${action} does not accept target_id`);
    }

    for (const param of schema.requiredParams ?? []) {
      if (params[param] === undefined || params[param] === null || params[param] === '') {
        throw new LlmBrowserError('MISSING_PARAM', `${param} is required for ${action}`);
      }
    }
    schema.validate?.(params);
  }

  private createSessionInfo(sessionId: string): SessionInfo {
    const state = this.stateManager.getSessionState(sessionId);
    return {
      session_id: sessionId,
      tab_id: 'tab-1',
      tabs_count: state?.tabs.length ?? 1,
      history_length: state?.history.length ?? 0,
      cookies_count: state?.cookies.length ?? 0,
    };
  }

  private recordAction(record: ActionRecord): void {
    this.stateManager.recordAction(record);
  }

  private traceSync<T>(traceId: string, name: string, attributes: Record<string, any>, work: () => T): T {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    try {
      const result = work();
      globalTraceStore.addSpan(traceId, {
        name,
        started_at: startedAt,
        duration_ms: Math.round(performance.now() - started),
        status: 'ok',
        attributes,
      });
      return result;
    } catch (error: any) {
      globalTraceStore.addSpan(traceId, {
        name,
        started_at: startedAt,
        duration_ms: Math.round(performance.now() - started),
        status: 'error',
        attributes,
        error: errorDetails(error),
      });
      throw error;
    }
  }

  private async traceAsync<T>(
    traceId: string,
    name: string,
    attributes: Record<string, any>,
    work: () => Promise<T>
  ): Promise<T> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    try {
      const result = await work();
      globalTraceStore.addSpan(traceId, {
        name,
        started_at: startedAt,
        duration_ms: Math.round(performance.now() - started),
        status: 'ok',
        attributes,
      });
      return result;
    } catch (error: any) {
      globalTraceStore.addSpan(traceId, {
        name,
        started_at: startedAt,
        duration_ms: Math.round(performance.now() - started),
        status: 'error',
        attributes,
        error: errorDetails(error),
      });
      throw error;
    }
  }

  private traceInstant(traceId: string, name: string, attributes: Record<string, any>): void {
    globalTraceStore.addSpan(traceId, {
      name,
      started_at: new Date().toISOString(),
      duration_ms: 0,
      status: 'ok',
      attributes,
    });
  }
}

function stripRoutingParams(params: Record<string, any>): Record<string, any> {
  const clone = { ...params };
  delete clone.element_id;
  delete clone.target_id;
  return clone;
}

function stripOpParams(params: Record<string, any>): Record<string, any> {
  const clone = { ...params };
  delete clone.async;
  delete clone.estimated_time_ms;
  return clone;
}

function estimateMs(action: string, params: Record<string, any>): number {
  if (typeof params.estimated_time_ms === 'number') return params.estimated_time_ms;
  if (action === 'navigate') return Number(params.timeout_ms ?? 5000);
  if (action === 'wait_for') return Number(params.timeout_ms ?? 10000);
  if (action === 'wait') return Math.min(Number(params.ms ?? 500), 10000);
  if (['download', 'upload', 'screenshot_file', 'screenshot_to_file', 'pdf', 'pdf_generate'].includes(action)) return 2000;
  if (action === 'search_and_paginate') return Math.min(Math.max(Number(params.max_pages ?? 1), 1), 20) * 750;
  if (action === 'sequence') return Array.isArray(params.steps) ? params.steps.length * 500 : 1000;
  return 1000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorDetails(error: any): { message: string; code?: string } {
  return {
    message: error?.message ?? String(error),
    code: error?.code,
  };
}

function validateFsParams(params: Record<string, any>): void {
  const operation = String(params.operation ?? params.op ?? 'list');
  if (!['list', 'read', 'write', 'delete'].includes(operation)) {
    throw new LlmBrowserError('INVALID_PARAMS', 'fs operation must be list, read, write, or delete');
  }
  if (['read', 'write', 'delete'].includes(operation) && !params.path && !params.file_path) {
    throw new LlmBrowserError('MISSING_PARAM', `path is required for fs ${operation}`);
  }
  if (
    operation === 'write' &&
    params.content === undefined &&
    params.file_content === undefined &&
    params.base64 === undefined
  ) {
    throw new LlmBrowserError('MISSING_PARAM', 'content or base64 is required for fs write');
  }
}
