import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { BrowserCore } from '../layer1_browser_core/BrowserCore';
import { ActionExecutor, ActionExecutionResult } from '../layer2_action_execution/ActionExecutor';
import { ActionValidator } from '../layer2_action_execution/ActionValidator';
import { StateManagementLayer } from '../layer3_state_management/StateManagementLayer';
import { SemanticLayer } from '../layer4_semantic/SemanticLayer';
import { StateReconciler } from '../layer3_state_management/StateReconciler';
import { globalMetrics } from '../common/MetricsRegistry';
import { ActionRecord, AvailableAction, SemanticSnapshot, SessionInfo } from '../common/types';
import { LlmBrowserError, normalizeError } from '../common/errors';
import { globalEventBus } from '../common/EventBus';
import { globalAuditLog, riskScoreForAction } from '../common/AuditLog';
import { SecurityPolicy } from '../security/SecurityPolicy';
import { OpStart, OpStatus, OpStore } from '../op/Op';
import { globalTraceStore } from '../trace/Trace';
import { activeTab, deleteSessionSnaps, snapKey } from '../session/Tabs';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { Bouncer } from '../layer2_action_execution/Bouncer';

export interface AgentCommand {
  action: string;
  session_id: string;
  target_id?: string;
  target_semantic?: string | Record<string, any>;
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
  check: { target: 'required', retryable: true },
  clear: { target: 'required', retryable: true },
  clear_search: { target: 'required', retryable: true },
  solve_captcha: { target: 'none' },
  append: { target: 'required', requiredParams: ['text'], retryable: true },
  select_all: { target: 'required', retryable: true },
  set_value: { target: 'required', requiredParams: ['value'], retryable: true },
  set_color: { target: 'required', retryable: true },
  set_date: { target: 'required', requiredParams: ['value'], retryable: true },
  go_back: { target: 'none', retryable: true },
  go_forward: { target: 'none', retryable: true },
  hover: { target: 'required', retryable: true },
  interact: { target: 'required', retryable: true },
  keyboard: { target: 'none', requiredParams: ['key'] },
  navigate: { target: 'none', requiredParams: ['url'], retryable: true },
  open_tab: { target: 'none', retryable: true },
  new_tab: { target: 'none', retryable: true },
  switch_tab: { target: 'optional', retryable: true },
  close_tab: { target: 'optional', retryable: true },
  list_tabs: { target: 'none' },
  set_viewport: {
    target: 'none',
    validate: validateViewportParams,
    retryable: true,
  },
  refresh: { target: 'none', retryable: true },
  screenshot: { target: 'optional', retryable: true },
  visual: { target: 'none', retryable: true },
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
  evaluate: {
    target: 'none',
    validate: (params) => {
      if (params.script === undefined && params.expression === undefined && params.javascript === undefined) {
        throw new LlmBrowserError('MISSING_PARAM', 'evaluate requires script or expression');
      }
    },
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
  reset_form: { target: 'required', retryable: true },
  clear_form: { target: 'required', retryable: true },
  validate_form: { target: 'required', retryable: true },
  if: { target: 'none', requiredParams: ['condition'] },
  invalidate_cache: { target: 'none' },
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
  select: {
    target: 'required',
    validate: (params) => {
      if (params.value === undefined && params.label === undefined) {
        throw new LlmBrowserError('MISSING_PARAM', 'select requires value or label');
      }
    },
    retryable: true,
  },
  snapshot: { target: 'none' },
  sequence: {
    target: 'none',
    validate: (params) => {
      if (!Array.isArray(params.steps)) throw new LlmBrowserError('MISSING_PARAM', 'sequence steps are required');
    },
  },
  run_flow: {
    target: 'none',
    validate: (params) => {
      if (!Array.isArray(params.steps ?? params.actions ?? params.flow)) {
        throw new LlmBrowserError('MISSING_PARAM', 'run_flow steps are required');
      }
    },
  },
  browser_run_flow: {
    target: 'none',
    validate: (params) => {
      if (!Array.isArray(params.steps ?? params.actions ?? params.flow)) {
        throw new LlmBrowserError('MISSING_PARAM', 'browser_run_flow steps are required');
      }
    },
  },
  submit: { target: 'required', retryable: true },
  type: { target: 'required', requiredParams: ['text'], retryable: true },
  wait: { target: 'none' },
  wait_for: { target: 'none', requiredParams: ['condition'], retryable: true },
  fill_and_verify: {
    target: 'optional',
    requiredParams: ['fields'],
    validate: (params) => {
      if (!params.fields || typeof params.fields !== 'object' || Array.isArray(params.fields)) {
        throw new LlmBrowserError('INVALID_PARAMS', 'fill_and_verify fields must be an object');
      }
    },
  },
  navigate_and_extract: { target: 'none', requiredParams: ['url'], retryable: true },
  login_flow: {
    target: 'none',
    validate: (params) => {
      if (!params.url && !params.login_url) throw new LlmBrowserError('MISSING_PARAM', 'login_flow requires url or login_url');
      if (!params.credentials && !params.fields) throw new LlmBrowserError('MISSING_PARAM', 'login_flow requires credentials or fields');
    },
  },
  async_navigate: { target: 'none', requiredParams: ['url'], retryable: true },
  poll: { target: 'none', requiredParams: ['operation_id'] },
  cancel: { target: 'none', requiredParams: ['operation_id'] },
  try: {
    target: 'none',
    validate: (params) => {
      if (!params.do?.action) throw new LlmBrowserError('MISSING_PARAM', 'try requires a do action');
    },
  },
  define_script: {
    target: 'none',
    validate: (params) => {
      if (!params.name) throw new LlmBrowserError('MISSING_PARAM', 'define_script requires name');
      if (!Array.isArray(params.steps)) throw new LlmBrowserError('MISSING_PARAM', 'define_script requires steps');
    },
  },
  call_script: { target: 'none', requiredParams: ['name'] },
};

export class CommandRouter {
  private sessionQueues = new Map<string, Promise<unknown>>();
  private readonly wsSecret = process.env.PRISM_WS_SECRET ?? process.env.LLM_BROWSER_WS_SECRET ?? randomBytes(32).toString('hex');

  constructor(
    private browserCore: BrowserCore,
    private stateManager: StateManagementLayer,
    private actionExecutor: ActionExecutor,
    private semanticLayer: SemanticLayer,
    private previousSnapshots: Map<string, SemanticSnapshot>,
    private securityPolicy = new SecurityPolicy(stateManager),
    private ops = new OpStore<CommandResult>(),
    private actionValidator = new ActionValidator(),
    private stateReconciler = new StateReconciler(),
    private bouncer = new Bouncer()
  ) {}

  async execute(command: AgentCommand): Promise<RouterResult> {
    if (command.action === 'poll') return this.poll(command);
    if (command.action === 'cancel') return this.cancel(command);
    if (command.action === 'async_navigate') {
      return this.start({
        ...command,
        action: 'navigate',
        action_params: { ...(command.action_params ?? {}), async: true },
      }, 'async_navigate');
    }
    if (command.action_params?.async === true) return this.start(command);
    return this.enqueueSession(command.session_id, () => this.executeSync(command));
  }

  listOps(sessionId?: string): OpStatus<CommandResult>[] {
    return this.ops.list({ session_id: sessionId }).map((record) => this.ops.toStatus(record));
  }

  getOp(operationId: string, sessionId?: string): OpStatus<CommandResult> | undefined {
    const record = sessionId ? this.ops.getForSession(operationId, sessionId) : this.ops.get(operationId);
    return record ? this.ops.toStatus(record) : undefined;
  }

  cancelOp(operationId: string, sessionId?: string): OpStatus<CommandResult> | undefined {
    const record = sessionId ? this.ops.cancelForSession(operationId, sessionId) : this.ops.cancel(operationId);
    return record ? this.ops.toStatus(record) : undefined;
  }

  cleanupSession(sessionId: string): void {
    this.ops.clearSession(sessionId);
    this.actionExecutor.clearSession(sessionId);
    deleteSessionSnaps(this.previousSnapshots, sessionId);
    this.sessionQueues.delete(sessionId);
  }

  issueWebSocketToken(sessionId: string): string {
    return createHmac('sha256', this.wsSecret).update(sessionId).digest('hex');
  }

  verifyWebSocketToken(sessionId: string | undefined, token: string | undefined): boolean {
    if (!sessionId || !token) return false;
    const expected = this.issueWebSocketToken(sessionId);
    const expectedBuffer = Buffer.from(expected, 'hex');
    const actualBuffer = Buffer.from(String(token), 'hex');
    return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
  }

  private async start(command: AgentCommand, opAction = command.action): Promise<OpStart> {
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
      action: opAction,
      estimated_time_ms: estimatedTimeMs,
      cancel: async () => {
        const page = this.browserCore.getPage(command.session_id);
        await page.evaluate(() => window.stop()).catch(() => undefined);
      },
      run: () => this.enqueueSession(command.session_id, () => this.executeSync(asyncCommand, {
          traceId,
          resolvedAction,
          securityDecision: { rate_limit: undefined },
          skipSecurity: true,
        })),
    });

    globalMetrics.increment('llm_browser_ops_started_total');
    globalAuditLog.record({
      category: 'ACTION',
      session_id: command.session_id,
      action: opAction,
      target: resolvedAction.targetId,
      result: 'success',
      request_id: traceId,
      risk_score: riskScoreForAction(command.action),
      metadata: {
        operation_id: op.operation_id,
        async: true,
        execution_action: resolvedAction.executionAction,
      },
    });

    return {
      status: 'started',
      operation_id: op.operation_id,
      action: opAction,
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
    const status = this.getOp(String(operationId), command.session_id);
    if (!status) throw new LlmBrowserError('ELEMENT_NOT_FOUND', 'Operation not found', { operation_id: operationId });
    if (status.result?.snapshot) {
      this.previousSnapshots.set(
        snapKey(status.result.snapshot.session.session_id, status.result.snapshot.session.tab_id),
        status.result.snapshot
      );
    }
    return status;
  }

  private cancel(command: AgentCommand): OpStatus<CommandResult> {
    const operationId = command.action_params?.operation_id;
    if (!operationId) throw new LlmBrowserError('MISSING_PARAM', 'operation_id is required for cancel');
    const status = this.cancelOp(String(operationId), command.session_id);
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
    const params = {
      ...(command.action_params ?? {}),
      ...(command.target_semantic !== undefined ? { target_semantic: command.target_semantic } : {}),
    };
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

      // Semantic pre-flight validation (Concept 2.5.3)
      if (activeAction.executionAction !== 'snapshot') {
        const active = activeTab(this.stateManager.getSessionState(command.session_id));
        const previousSnapshot = active ? this.previousSnapshots.get(snapKey(command.session_id, active.tab_id)) : undefined;
        const expectedSnapshotId = activeAction.params.expected_snapshot_id ?? activeAction.params.snapshot_id;
        if (expectedSnapshotId && previousSnapshot?.snapshot_id !== expectedSnapshotId) {
          throw new LlmBrowserError('STALE_ELEMENT', 'Snapshot version is stale for this action', {
            expected_snapshot_id: expectedSnapshotId,
            current_snapshot_id: previousSnapshot?.snapshot_id,
            tab_id: active?.tab_id,
          });
        }
        const validation = this.traceSync(
          traceId,
          'validator.preflight',
          { action: activeAction.executionAction, target_id: activeAction.targetId },
          () => this.actionValidator.validate(
            activeAction.executionAction,
            activeAction.targetId,
            activeAction.params,
            previousSnapshot,
            ConfigurationManager.getInstance().getConfig().security.degradation_level
          )
        );
        if (!validation.valid) {
          throw new LlmBrowserError(
            validation.error!.code as any,
            validation.error!.message,
            {
              suggestion: validation.error!.suggestion,
              ...validation.error!.context,
            }
          );
        }
      }

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

      await this.syncTabs(command.session_id);
      const page = this.browserCore.getPage(command.session_id);
      if (typeof (this.stateManager as any).injectAllTrackers === 'function') {
        await this.stateManager.injectAllTrackers(page, command.session_id).catch(() => undefined);
      }

      // NOTE: auto_bounce for post-action snapshot is handled in getPostActionSnapshot.
      // Only run bouncer here for explicit browser_snapshot calls (action === 'snapshot').
      const bouncerResult = activeAction.executionAction === 'snapshot'
        ? await this.traceAsync(
            traceId,
            'bouncer.dismiss',
            { enabled: activeAction.params.auto_bounce !== false },
            () => this.bouncer.dismiss(page, { enabled: activeAction.params.auto_bounce !== false })
          ).catch(() => undefined)
        : undefined;
      const active = activeTab(this.stateManager.getSessionState(command.session_id));
      let previousSnapshot = active ? this.previousSnapshots.get(snapKey(command.session_id, active.tab_id)) : undefined;

      // State Reconciliation Pipeline (Concept 2.9)
      if (previousSnapshot && activeAction.executionAction !== 'snapshot') {
        const reconciliation = await this.traceAsync(
          traceId,
          'reconciler.check',
          {},
          () => this.stateReconciler.reconcile(page, command.session_id, previousSnapshot)
        );
        if (!reconciliation.valid) {
          previousSnapshot = undefined; // Force full extraction
          this.previousSnapshots.delete(snapKey(command.session_id, active!.tab_id));
        }
      }

      const snapshot = await this.traceAsync(
        traceId,
        'semantic.extract',
        {
          previous_snapshot: Boolean(previousSnapshot),
        },
        () => this.semanticLayer.createSnapshot(page, {
          previousSnapshot,
          session: this.createSessionInfo(command.session_id),
          maxElements: snapshotMaxElements(activeAction.params),
          ...snapshotFilterOptions(activeAction.params),
          actionTime: execution?.duration_ms ?? 0,
          totalTime: Math.round(performance.now() - requestStart),
          traceId,
        })
      );
      if (bouncerResult && snapshot.meta) {
        snapshot.meta.bouncer = {
          attempted: bouncerResult.attempted,
          closed: bouncerResult.closed,
          duration_ms: bouncerResult.duration_ms,
          actions: bouncerResult.actions,
        };
      }

      if (activeAction.executionAction === 'close_tab' && execution?.data?.closed_tab_id) {
        this.previousSnapshots.delete(snapKey(command.session_id, String(execution.data.closed_tab_id)));
      }
      this.previousSnapshots.set(snapKey(command.session_id, snapshot.session.tab_id), snapshot);
      this.stateManager.recordPageState(command.session_id, {
        url: snapshot.url,
        title: snapshot.title,
        snapshot_id: snapshot.snapshot_id,
      });
      if (snapshot.auth) {
        this.stateManager.updateSession(command.session_id, { auth: snapshot.auth });
      }

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
      void globalEventBus.publish('stream_event', {
        type: 'page_changed',
        session_id: command.session_id,
        tab_id: snapshot.session.tab_id,
        timestamp: new Date().toISOString(),
        data: {
          url: snapshot.url,
          title: snapshot.title,
          snapshot_id: snapshot.snapshot_id,
          action,
          trace_id: traceId,
          element_count: snapshot.elements.length,
          delta_operations: snapshot.delta?.operations.length ?? 0,
          delta_stats: snapshot.delta?.stats,
          cache_status: snapshot.meta?.cache_status,
        },
      });
      void globalEventBus.publish('stream_event', {
        type: 'action_completed',
        session_id: command.session_id,
        tab_id: snapshot.session.tab_id,
        timestamp: new Date().toISOString(),
        data: {
          action,
          action_id: actionId,
          target_id: command.target_id ?? resolvedAction.targetId,
          trace_id: traceId,
          duration_ms: totalTime,
          action_ms: execution?.duration_ms ?? 0,
          extraction_ms: snapshot.meta?.extraction_time ?? 0,
          token_estimate: snapshot.meta?.token_estimate,
        },
      });

      // Concept §2.5.2: Delta-mode by default for sequential actions on same page.
      // When a delta is available, strip the full elements array to save tokens.
      // The LLM client applies delta operations to reconstruct the current state.
      // FIX: Only use delta mode when we have a previous snapshot with elements
      // This prevents stripping elements on the first snapshot request
      let responseSnapshot = snapshot;
      const hasValidPrevious = previousSnapshot && previousSnapshot.elements && previousSnapshot.elements.length > 0;
      if (snapshot.delta && hasValidPrevious && activeAction.executionAction !== 'snapshot') {
        const { elements, ...deltaSnapshot } = snapshot;
        responseSnapshot = {
          ...deltaSnapshot,
          elements: [], // Omitted — use delta.operations to reconstruct
        } as SemanticSnapshot;
      }
      // Strip internal _hash field from elements before returning to agent
      if (responseSnapshot.elements.length > 0) {
        responseSnapshot = {
          ...responseSnapshot,
          elements: responseSnapshot.elements.map(el => {
            const { _hash, ...rest } = el as any;
            return rest;
          }),
        };
      }

      return {
        status: 'success',
        action,
        action_id: actionId,
        data: execution?.data,
        snapshot: responseSnapshot,
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
      void globalEventBus.publish('stream_event', {
        type: 'error',
        session_id: command.session_id,
        timestamp: new Date().toISOString(),
        data: {
          action,
          target_id: command.target_id ?? resolvedAction?.targetId,
          trace_id: traceId,
          code: normalized.code,
          message: normalized.message,
          recoverable: normalized.recoverable,
        },
      });
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
    const targetSemantic = params?.target_semantic ?? actionParams.target_semantic ?? params?.semantic_target ?? actionParams.semantic_target;
    return {
      action: method,
      session_id: params?.session_id,
      target_id: targetId,
      target_semantic: targetSemantic,
      action_params: stripRoutingParams({
        ...actionParams,
        ...(targetSemantic !== undefined ? { target_semantic: targetSemantic } : {}),
      }),
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
    const targetSemantic = body?.target_semantic ?? actionParams.target_semantic ?? body?.semantic_target ?? actionParams.semantic_target;
    return {
      action: body?.action,
      session_id: sessionId,
      target_id: targetId,
      target_semantic: targetSemantic,
      action_params: stripRoutingParams({
        ...actionParams,
        ...(targetSemantic !== undefined ? { target_semantic: targetSemantic } : {}),
      }),
      trace_id: body?.trace_id,
    };
  }

  private async executeWithRetry(
    sessionId: string,
    action: string,
    targetId: string | undefined,
    params: Record<string, any>
  ): Promise<ActionExecutionResult> {
    return this.actionExecutor.executeAction(sessionId, action, targetId, params);
  }

  private enqueueSession<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    if (!sessionId) return work();
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    const tracked = current.catch(() => undefined).finally(() => {
      if (this.sessionQueues.get(sessionId) === current) this.sessionQueues.delete(sessionId);
      if (this.sessionQueues.get(sessionId) === tracked) this.sessionQueues.delete(sessionId);
    });
    this.sessionQueues.set(sessionId, tracked);
    return current;
  }

  private validateCommand(command: AgentCommand): ResolvedAction {
    if (!command.session_id) {
      throw new LlmBrowserError('SESSION_NOT_FOUND', 'Session not found', { session_id: command.session_id });
    }
    const sessionState = this.stateManager.getSessionState(command.session_id);
    if (!sessionState) {
      throw new LlmBrowserError('SESSION_NOT_FOUND', 'Session not found', { session_id: command.session_id });
    }
    if (sessionState.status === 'paused') {
      throw new LlmBrowserError('SESSION_PAUSED', 'Session is paused due to CAPTCHA detection');
    }

    if (command.action === 'run_flow' || command.action === 'browser_run_flow') {
      const params: Record<string, any> = {
        ...(command.action_params ?? {}),
        ...(command.target_semantic !== undefined ? { target_semantic: command.target_semantic } : {}),
      };
      const steps = params.steps ?? params.actions ?? params.flow;
      const resolved = {
        schema: actionSchemas.sequence,
        executionAction: 'sequence',
        targetId: undefined,
        params: {
          ...params,
          steps,
        },
      };
      this.validateAgainstSchema(command.action, actionSchemas[command.action], undefined, params);
      this.validateAgainstSchema('sequence', resolved.schema, resolved.targetId, resolved.params);
      return resolved;
    }

    const schema = actionSchemas[command.action];
    if (schema) {
      const resolved = {
        schema,
        executionAction: command.action,
        targetId: command.target_id,
        params: {
          ...(command.action_params ?? {}),
          ...(command.target_semantic !== undefined ? { target_semantic: command.target_semantic } : {}),
        },
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
    const tab = activeTab(this.stateManager.getSessionState(command.session_id));
    const snapshot = tab ? this.previousSnapshots.get(snapKey(command.session_id, tab.tab_id)) : undefined;
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
    const hasSemanticTarget = params.target_semantic !== undefined || params.semantic_target !== undefined || params.selector !== undefined;
    if (schema.target === 'required' && !targetId && !hasSemanticTarget) {
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
    const tab = activeTab(state);
    return {
      session_id: sessionId,
      tab_id: tab?.tab_id ?? 'tab-1',
      tabs_count: state?.tabs.length ?? 1,
      history_length: state?.history.length ?? 0,
      cookies_count: state?.cookies.length ?? 0,
      viewport: this.browserCore.getViewport(sessionId),
    };
  }

  private async syncTabs(sessionId: string): Promise<void> {
    const tabs = await this.browserCore.listTabs(sessionId);
    this.stateManager.syncTabs(sessionId, tabs);
  }

  private recordAction(record: ActionRecord): void {
    this.stateManager.recordAction(sanitizeActionRecord(record));
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
  return clone;
}

function estimateMs(action: string, params: Record<string, any>): number {
  if (typeof params.estimated_time_ms === 'number') return params.estimated_time_ms;
  if (action === 'navigate') return Number(params.timeout_ms ?? 5000);
  if (action === 'open_tab' || action === 'new_tab') return params.url ? Number(params.timeout_ms ?? 5000) : 500;
  if (action === 'set_viewport') return 300;
  if (action === 'wait_for') return Number(params.timeout_ms ?? 10000);
  if (action === 'wait') return Math.min(Number(params.ms ?? 500), 10000);
  if (['download', 'upload', 'screenshot_file', 'screenshot_to_file', 'pdf', 'pdf_generate'].includes(action)) return 2000;
  if (action === 'search_and_paginate') return Math.min(Math.max(Number(params.max_pages ?? 1), 1), 20) * 750;
  if (action === 'sequence') return Array.isArray(params.steps) ? params.steps.length * 500 : 1000;
  return 1000;
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

function validateViewportParams(params: Record<string, any>): void {
  const value = params.viewport ?? params;
  if (typeof value === 'string') return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LlmBrowserError('INVALID_PARAMS', 'set_viewport requires viewport profile or width/height');
  }
  const width = Number(value.width);
  const height = Number(value.height);
  const profile = value.profile ?? value.device ?? value.name;
  if (profile === undefined && (!Number.isFinite(width) || !Number.isFinite(height))) {
    throw new LlmBrowserError('MISSING_PARAM', 'set_viewport requires width/height or profile');
  }
}

function snapshotMaxElements(params: Record<string, any>): number | undefined {
  const value = params.max_elements ?? params.maxElements ?? params.snapshot?.max_elements ?? params.snapshot?.maxElements;
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function snapshotFilterOptions(params: Record<string, any>): {
  actionableOnly?: boolean;
  affordances?: string[];
  includeTypes?: string[];
  excludeTypes?: string[];
} {
  const snapshot = params.snapshot ?? {};
  return {
    actionableOnly: Boolean(params.actionable_only ?? params.actionableOnly ?? snapshot.actionable_only ?? snapshot.actionableOnly),
    affordances: stringArray(params.affordances ?? snapshot.affordances),
    includeTypes: stringArray(params.include_types ?? params.includeTypes ?? snapshot.include_types ?? snapshot.includeTypes),
    excludeTypes: stringArray(params.exclude_types ?? params.excludeTypes ?? snapshot.exclude_types ?? snapshot.excludeTypes),
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

const SENSITIVE_KEY_PATTERN = /(password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|credential|session|jwt|refresh|access[_-]?token)/i;

function sanitizeActionRecord(record: ActionRecord): ActionRecord {
  return {
    ...record,
    params: record.params ? sanitizeValue(record.params) as Record<string, any> : record.params,
  };
}

function sanitizeValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, key));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      result[childKey] = sanitizeValue(childValue, childKey);
    }
    return result;
  }
  return value;
}
