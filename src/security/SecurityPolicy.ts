import { ConfigurationManager } from '../config/ConfigurationManager';
import { LlmBrowserError } from '../common/errors';
import type { AgentCommand } from '../layer5_agent_interface/CommandRouter';
import { StateManagementLayer } from '../layer3_state_management/StateManagementLayer';
import { TokenBucketRateLimiter } from './TokenBucketRateLimiter';

export interface SecurityDecision {
  rate_limit?: {
    remaining: number;
    reset_ms: number;
  };
}

const viewerActions = new Set(['snapshot', 'wait', 'poll']);
const operatorActions = new Set([
  ...viewerActions,
  'click',
  'check',
  'clear',
  'clear_form',
  'clear_search',
  'cancel',
  'append',
  'async_navigate',
  'call_script',
  'fill_form',
  'fill_and_verify',
  'evaluate',
  'define_script',
  'download',
  'file_system',
  'fs',
  'go_back',
  'go_forward',
  'hover',
  'interact',
  'if',
  'invalidate_cache',
  'keyboard',
  'loop',
  'multi_click',
  'navigate',
  'navigate_and_extract',
  'new_tab',
  'open_tab',
  'parallel',
  'refresh',
  'reset_form',
  'pdf',
  'pdf_generate',
  'screenshot',
  'screenshot_file',
  'screenshot_to_file',
  'search_and_paginate',
  'close_tab',
  'list_tabs',
  'scroll',
  'scroll_to_element',
  'select',
  'select_all',
  'sequence',
  'set_color',
  'set_date',
  'set_value',
  'set_viewport',
  'submit',
  'switch_tab',
  'type',
  'try',
  'validate_form',
  'visual',
  'upload',
  'wait',
  'wait_for',
  'login_flow',
  'run_flow',
  'browser_run_flow',
]);

export class SecurityPolicy {
  constructor(
    private stateManager: StateManagementLayer,
    private limiter = new TokenBucketRateLimiter()
  ) {}

  authorize(command: AgentCommand): SecurityDecision {
    const config = ConfigurationManager.getInstance().getConfig();
    const state = this.stateManager.getSessionState(command.session_id);
    if (!state) {
      throw new LlmBrowserError('SESSION_NOT_FOUND', 'Session not found', { session_id: command.session_id });
    }

    if (state.status !== 'active') {
      throw new LlmBrowserError('ACCESS_DENIED', `Session is ${state.status}`, { session_id: command.session_id });
    }

    const idleMs = Date.now() - Date.parse(state.updated_at);
    if (idleMs > config.security.session_timeout_seconds * 1000) {
      throw new LlmBrowserError('ACCESS_DENIED', 'Session expired', { session_id: command.session_id });
    }

    const history = this.stateManager.getActionHistory(command.session_id);
    if (history.filter((record) => record.status === 'success').length >= config.security.max_actions_per_session) {
      throw new LlmBrowserError('RATE_LIMIT_EXCEEDED', 'max_actions_per_session exceeded', {
        session_id: command.session_id,
        limit: config.security.max_actions_per_session,
      });
    }

    const role = state.configuration?.role ?? 'operator';
    if (!isAllowedForRole(role, command.action)) {
      throw new LlmBrowserError('ACCESS_DENIED', `Action ${command.action} is not allowed for role ${role}`, {
        role,
        action: command.action,
      });
    }

    if (
      command.action === 'navigate' ||
      command.action === 'async_navigate' ||
      command.action === 'navigate_and_extract' ||
      command.action === 'login_flow' ||
      ((command.action === 'open_tab' || command.action === 'new_tab') && command.action_params?.url !== undefined)
    ) {
      this.checkDomain(command.action_params?.url ?? command.action_params?.login_url, state.current_url);
    }
    for (const url of collectNestedNavigateUrls(command.action_params)) {
      this.checkDomain(url, state.current_url);
    }

    const rateLimit = this.consumeRateLimit(command.session_id, command.action);
    return { rate_limit: rateLimit };
  }

  private consumeRateLimit(sessionId: string, action: string): SecurityDecision['rate_limit'] {
    const config = ConfigurationManager.getInstance().getConfig().security;
    const base = this.limiter.consume(`session:${sessionId}`, config.rate_limit_per_minute, config.rate_limit_per_minute);
    if (!base.allowed) {
      throw new LlmBrowserError('RATE_LIMIT_EXCEEDED', 'session rate limit exceeded', {
        session_id: sessionId,
        remaining: base.remaining,
        reset_ms: base.reset_ms,
      });
    }

    const specificLimit =
      action === 'navigate' || action === 'open_tab' || action === 'new_tab'
        ? config.navigate_rate_limit_per_minute
        : ['screenshot', 'screenshot_file', 'screenshot_to_file', 'pdf', 'pdf_generate'].includes(action)
          ? config.screenshot_rate_limit_per_minute
          : 0;

    if (specificLimit > 0) {
      const specific = this.limiter.consume(
        `session:${sessionId}:action:${action}`,
        specificLimit,
        specificLimit
      );
      if (!specific.allowed) {
        throw new LlmBrowserError('RATE_LIMIT_EXCEEDED', `${action} rate limit exceeded`, {
          session_id: sessionId,
          action,
          remaining: specific.remaining,
          reset_ms: specific.reset_ms,
        });
      }
    }

    return {
      remaining: base.remaining,
      reset_ms: base.reset_ms,
    };
  }

  private checkDomain(urlValue: unknown, baseUrl?: string): void {
    if (typeof urlValue !== 'string') {
      throw new LlmBrowserError('MISSING_PARAM', 'url is required for navigate');
    }

    if (urlValue.startsWith('data:') || urlValue.startsWith('about:')) {
      return;
    }

    let hostname = '';
    try {
      hostname = new URL(urlValue, baseUrl || undefined).hostname.toLowerCase();
    } catch {
      throw new LlmBrowserError('INVALID_PARAMS', 'navigate url must be absolute, relative to current page, or data URL');
    }

    const { domain_blacklist, domain_whitelist } = ConfigurationManager.getInstance().getConfig().security;
    if (domain_blacklist.some((domain) => matchesDomain(hostname, domain))) {
      throw new LlmBrowserError('SECURITY_VIOLATION', `Domain ${hostname} is blacklisted`, { hostname });
    }

    if (domain_whitelist.length > 0 && !domain_whitelist.some((domain) => matchesDomain(hostname, domain))) {
      throw new LlmBrowserError('SECURITY_VIOLATION', `Domain ${hostname} is outside whitelist`, { hostname });
    }
  }
}

function isAllowedForRole(role: string, action: string): boolean {
  if (role === 'admin') return true;
  if (role === 'viewer') return viewerActions.has(action);
  return operatorActions.has(action);
}

function matchesDomain(hostname: string, configuredDomain: string): boolean {
  const normalized = configuredDomain.toLowerCase().replace(/^\*\./, '');
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function collectNestedNavigateUrls(params: unknown, depth = 0): unknown[] {
  if (!params || typeof params !== 'object' || depth > 4) return [];
  const value = params as Record<string, any>;
  const urls: unknown[] = [];

  const visitStep = (step: any) => {
    if (!step || typeof step !== 'object') return;
    const stepParams = step.params ?? step.action_params ?? step.parameters ?? {};
    if (
      step.action === 'navigate' ||
      step.action === 'async_navigate' ||
      step.action === 'navigate_and_extract' ||
      step.action === 'login_flow' ||
      ((step.action === 'open_tab' || step.action === 'new_tab') && stepParams.url !== undefined)
    ) {
      urls.push(stepParams.url ?? stepParams.login_url);
    }
    urls.push(...collectNestedNavigateUrls(stepParams, depth + 1));
  };

  for (const step of [...arrayOf(value.steps), ...arrayOf(value.actions)]) visitStep(step);
  visitStep(value.then);
  visitStep(value.else);
  visitStep(value.do);
  for (const handler of arrayOf(value.catch)) visitStep(handler.action ?? handler.fallback ?? handler);
  if (value.fallback) visitStep(value.fallback);
  return urls;
}

function arrayOf(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' ? [value] : [];
}
