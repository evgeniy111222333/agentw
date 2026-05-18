import { Locator, Page } from 'playwright';
import { BrowserCore } from '../layer1_browser_core/BrowserCore';
import { SemanticElement } from '../common/types';
import { globalEventBus } from '../common/EventBus';
import { FlowStep, FlowStepResult, PAR_ACTIONS, assertSteps, report, stepParams, stepTarget } from '../flow/Flow';
import { Box } from '../file/Box';
import { globalSemCache } from '../cache/Sem';
import { classifyActionError, shouldRetry, retryDelay, LlmBrowserError, RETRY_CONFIG } from '../common/errors';
import { OpStore } from '../op/Op';
import { globalMetrics } from '../common/MetricsRegistry';

/**
 * Concept §5.5: Risk scores per action (0-100).
 */
const ACTION_RISK_SCORE: Record<string, number> = {
  snapshot: 0, wait: 0, wait_for: 0, poll: 0, scroll: 5, scroll_to_element: 5,
  hover: 5, keyboard: 10, click: 10, type: 15, select: 15, go_back: 10, go_forward: 10,
  list_tabs: 0, set_viewport: 5, invalidate_cache: 10,
  navigate: 30, submit: 40, fill_form: 35, search_and_paginate: 25,
  multi_click: 20, sequence: 30, parallel: 25, 'if': 10, loop: 20,
  fill_and_verify: 35, navigate_and_extract: 35, login_flow: 75,
  async_navigate: 30, cancel: 15, interact: 20,
  media_control: 20,
  upload: 40, download: 40, screenshot: 5, screenshot_file: 10, pdf: 15,
  fs: 30, refresh: 15, open_tab: 10, new_tab: 10, switch_tab: 5, close_tab: 15,
  define_script: 5, call_script: 30, 'try': 20,
};

/**
 * Concept §5.8: ScriptRegistry — stores named, parameterized action sequences.
 */
class ScriptRegistry {
  private scripts = new Map<string, { steps: FlowStep[]; params: string[] }>();

  define(name: string, steps: FlowStep[], params: string[] = []): void {
    if (this.scripts.size >= 100) throw new Error('Script registry full (max 100)');
    this.scripts.set(name, { steps, params });
  }

  get(name: string): { steps: FlowStep[]; params: string[] } | undefined {
    return this.scripts.get(name);
  }

  list(): string[] {
    return [...this.scripts.keys()];
  }

  /** Replace {{param}} placeholders in step params */
  instantiate(steps: FlowStep[], args: Record<string, any>): FlowStep[] {
    return substituteTemplate(steps, args) as FlowStep[];
  }
}

export { ACTION_RISK_SCORE };

export interface ActionExecutionResult {
  action: string;
  target_id?: string;
  duration_ms: number;
  data?: Record<string, any>;
}

export class ActionExecutor {
  private scripts = new ScriptRegistry();
  private opStore = new OpStore();

  constructor(
    private browserCore: BrowserCore,
    private box = new Box()
  ) {}

  /** Get risk score for an action (0-100). Concept §5.2.2 / §8.4. */
  static riskScore(action: string): number {
    return ACTION_RISK_SCORE[action] ?? 50;
  }

  /** Concept §5.5: Execute with automatic retry based on error classification. */
  async executeAction(
    sessionId: string,
    action: string,
    targetId?: string,
    params?: any,
    _currentElements?: SemanticElement[]
  ): Promise<ActionExecutionResult> {
    const page = this.browserCore.getPage(sessionId);
    const started = performance.now();
    let lastError: any;

    for (let attempt = 0; ; attempt++) {
      try {
        const data = await this.dispatch(sessionId, page, action, targetId, params ?? {});

        const result: ActionExecutionResult = {
          action,
          target_id: targetId,
          duration_ms: Math.round(performance.now() - started),
          data: {
            ...data,
            ...(attempt > 0 ? { attempts: attempt + 1 } : {}),
          },
        };
        await globalEventBus.publish('action_completed', { session_id: sessionId, ...result });
        if (attempt > 0) globalMetrics.increment('llm_browser_retries_succeeded_total');
        return result;
      } catch (error: any) {
        lastError = error;
        const { code, errorClass } = classifyActionError(error);

        if (shouldRetry(errorClass, attempt)) {
          const delay = retryDelay(errorClass, attempt);
          const maxAttempts = RETRY_CONFIG[errorClass].maxAttempts;
          globalMetrics.increment('llm_browser_retries_total');
          const retryEvent = {
            session_id: sessionId,
            action,
            target_id: targetId,
            attempt: attempt + 1,
            max_attempts: maxAttempts,
            error_class: errorClass,
            error_code: code,
            error_message: error.message,
            delay_ms: delay,
            remaining: maxAttempts - attempt - 1,
          };
          await globalEventBus.publish('action_retry', retryEvent);
          void globalEventBus.publish('stream_event', {
            type: 'action_retry',
            session_id: sessionId,
            timestamp: new Date().toISOString(),
            data: retryEvent,
          });
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        const duration_ms = Math.round(performance.now() - started);
        await globalEventBus.publish('action_failed', {
          session_id: sessionId,
          action,
          target_id: targetId,
          duration_ms,
          error: error.message,
          error_code: code,
          error_class: errorClass,
          attempts: attempt + 1,
        });
        void globalEventBus.publish('stream_event', {
          type: 'action_failed',
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          data: {
            action,
            target_id: targetId,
            duration_ms,
            error: error.message,
            error_code: code,
            error_class: errorClass,
            attempts: attempt + 1,
          },
        });
        throw new LlmBrowserError(code, `Failed to execute action ${action}: ${error.message}`, {
          action, target_id: targetId, attempts: attempt + 1, error_class: errorClass,
        });
      }
    }
  }

  private async dispatch(
    sessionId: string,
    page: Page,
    action: string,
    targetId: string | undefined,
    params: any,
    depth = 0
  ): Promise<Record<string, any> | undefined> {
    if (depth > 4) throw new Error('Flow nesting limit exceeded');

    switch (action) {
      case 'navigate':
        if (!params.url) throw new Error('URL is required for navigate action');
        await page.goto(resolvePageUrl(page, String(params.url)), {
          waitUntil: params.wait_until ?? params.waitUntil ?? 'load',
          timeout: params.timeout_ms ?? params.timeout ?? 30000,
        });
        await page.waitForLoadState('networkidle', { timeout: params.timeout_ms ?? 5000 }).catch(() => undefined);
        return { url: page.url() };

      case 'open_tab':
      case 'new_tab': {
        const tab = await this.browserCore.openTab(sessionId, params.url ? String(params.url) : undefined);
        return { tab, tabs: await this.browserCore.listTabs(sessionId) };
      }

      case 'switch_tab': {
        const tabId = String(params.tab_id ?? targetId ?? '');
        if (!tabId) throw new Error('tab_id is required for switch_tab');
        const tab = await this.browserCore.switchTab(sessionId, tabId);
        return { tab, tabs: await this.browserCore.listTabs(sessionId) };
      }

      case 'close_tab': {
        const tabId = params.tab_id ?? targetId;
        const result = await this.browserCore.closeTab(sessionId, tabId ? String(tabId) : undefined);
        return { ...result, tabs: await this.browserCore.listTabs(sessionId) };
      }

      case 'list_tabs':
        return { tabs: await this.browserCore.listTabs(sessionId) };

      case 'set_viewport': {
        const viewport = await this.browserCore.setViewport(sessionId, params.viewport ?? params);
        await this.shortStabilization(page);
        return { viewport, tabs: await this.browserCore.listTabs(sessionId) };
      }

      case 'click': {
        const locator = await this.resolveActionableLocator(page, targetId, action, params);
        const clickOptions: any = { timeout: params.timeout_ms ?? 5000 };
        if (params.button) clickOptions.button = params.button; // right, middle
        if (params.click_count) clickOptions.clickCount = params.click_count; // dblclick=2
        await locator.click(clickOptions);
        await this.shortStabilization(page);
        return;
      }

      case 'interact': {
        const locator = await this.resolveActionableLocator(page, targetId, action, params);
        await locator.click({ timeout: params.timeout_ms ?? 5000 });
        await this.shortStabilization(page);
        return { interacted: true };
      }

      case 'type': {
        const locator = await this.resolveActionableLocator(page, targetId, action, params);
        if (params.text === undefined) throw new Error('Text is required for type action');
        if (params.clear !== false) {
          await locator.fill(String(params.text), { timeout: params.timeout_ms ?? 5000 });
        } else {
          await locator.type(String(params.text), { delay: params.delay ?? 0, timeout: params.timeout_ms ?? 5000 });
        }
        if (params.press_enter) {
          await locator.press('Enter');
          await this.shortStabilization(page);
        }
        const value = await locator.inputValue().catch(() => String(params.text));
        return { value };
      }

      case 'select': {
        const locator = await this.resolveActionableLocator(page, targetId, action, params);
        if (params.value === undefined && params.label === undefined) {
          throw new Error('Value or label is required for select action');
        }
        // Concept §5.2.2: support both value and label selection
        const selectArg = params.label !== undefined
          ? { label: String(params.label) }
          : (Array.isArray(params.value) ? params.value.map(String) : String(params.value));
        await locator.selectOption(selectArg, { timeout: params.timeout_ms ?? 5000 });
        await this.shortStabilization(page);
        return { value: params.value ?? params.label };
      }

      case 'submit': {
        const locator = await this.resolveActionableLocator(page, targetId, action, params);
        await this.submitLocator(page, locator, params.timeout_ms ?? 5000);
        return { url: page.url() };
      }

      case 'hover': {
        const locator = await this.resolveActionableLocator(page, targetId, action, params);
        await locator.hover({ timeout: params.timeout_ms ?? 5000 });
        await this.shortStabilization(page);
        return;
      }

      case 'media_control':
        return this.mediaControl(page, targetId, params);

      case 'scroll':
      case 'scroll_to_element': {
        const amount = Number(params.amount ?? 720);
        const direction = params.direction === 'up' ? -1 : 1;
        if (targetId) {
          const locator = await this.locatorForAny(page, targetId);
          await locator.scrollIntoViewIfNeeded({ timeout: params.timeout_ms ?? 5000 });
        } else {
          await page.mouse.wheel(0, amount * direction);
        }
        await this.shortStabilization(page);
        return this.scrollState(page);
      }

      case 'keyboard':
        if (!params.key) throw new Error('Key is required for keyboard action');
        await page.keyboard.press(String(params.key));
        await this.shortStabilization(page);
        return { key: params.key };

      case 'wait':
        return this.wait(page, params);

      case 'fill_form':
        return this.fillForm(sessionId, page, targetId, params, depth);

      case 'multi_click':
        return this.multiClick(sessionId, page, targetId, params, depth);

      case 'sequence':
        return this.sequence(sessionId, page, params, depth);

      case 'parallel':
        return this.parallel(sessionId, page, params, depth);

      case 'if':
        return this.branch(sessionId, page, params, depth);

      case 'loop':
        return this.loop(sessionId, page, params, depth);

      case 'wait_for':
        return this.waitFor(page, params);

      case 'search_and_paginate':
        return this.searchAndPaginate(sessionId, page, targetId, params, depth);

      // Concept §5.6: New compound actions
      case 'fill_and_verify':
        return this.fillAndVerify(sessionId, page, targetId, params, depth);

      case 'navigate_and_extract':
        return this.navigateAndExtract(sessionId, page, params, depth);

      case 'login_flow':
        return this.loginFlow(sessionId, page, params, depth);

      // Concept §5.7: Async actions
      case 'async_navigate':
        return this.asyncNavigate(sessionId, params);

      case 'poll':
        return this.pollOp(params);

      case 'cancel':
        return this.cancelOp(params);

      // Concept §5.8: Script system
      case 'try':
        return this.tryCatch(sessionId, page, params, depth);

      case 'define_script':
        return this.defineScript(params);

      case 'call_script':
        return this.callScript(sessionId, page, params, depth);

      case 'upload':
        return this.upload(sessionId, page, targetId, params);

      case 'download':
        return this.download(sessionId, page, targetId, params);

      case 'screenshot_file':
      case 'screenshot_to_file':
        return this.screenshotFile(sessionId, page, targetId, params, action);

      case 'pdf':
      case 'pdf_generate':
        return this.pdf(sessionId, page, params);

      case 'fs':
      case 'file_system':
        return this.fs(sessionId, params);

      case 'screenshot': {
        const screenshotOptions = {
          type: 'png' as const,
          timeout: params.timeout_ms ?? 5000,
        };
        const buffer = targetId
          ? await (await this.resolveActionableLocator(page, targetId, action, params)).screenshot(screenshotOptions)
          : await page.screenshot({
              ...screenshotOptions,
              fullPage: params.full_page !== false,
            });
        const viewport = page.viewportSize();
        return {
          image: buffer.toString('base64'),
          mime_type: 'image/png',
          width: viewport?.width,
          height: viewport?.height,
          full_page: !targetId && params.full_page !== false,
        };
      }

      case 'go_back':
        await page.goBack({ waitUntil: 'load' });
        await this.shortStabilization(page);
        return { url: page.url() };

      case 'go_forward':
        await page.goForward({ waitUntil: 'load' });
        await this.shortStabilization(page);
        return { url: page.url() };

      case 'refresh':
        await page.reload({ waitUntil: 'load' });
        await this.shortStabilization(page);
        return { url: page.url() };

      case 'snapshot':
        return;

      case 'noop':
        return { skipped: true };

      case 'invalidate_cache':
        globalSemCache.clear();
        return {
          cache: 'semantic',
          invalidated: true,
        };

      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  }

  private async wait(page: Page, params: any): Promise<Record<string, any>> {
    const timeoutMs = Math.min(Number(params.timeout_ms ?? params.timeout ?? params.ms ?? 500), 120000);
    const condition = params.condition;
    if (!condition) {
      const waited = Math.min(timeoutMs, 10000);
      await page.waitForTimeout(waited);
      return { waited_ms: waited };
    }

    if (typeof condition === 'string') {
      switch (condition) {
        case 'element_visible': {
          const target = params.element_id ?? params.target_id;
          if (!target) throw new Error('element_id is required for wait element_visible');
          await (await this.locatorForAny(page, String(target))).waitFor({ state: 'visible', timeout: timeoutMs });
          return { condition, matched: true, waited_ms: timeoutMs };
        }
        case 'element_hidden': {
          const target = params.element_id ?? params.target_id;
          if (!target) throw new Error('element_id is required for wait element_hidden');
          await (await this.locatorForAny(page, String(target))).waitFor({ state: 'hidden', timeout: timeoutMs });
          return { condition, matched: true, waited_ms: timeoutMs };
        }
        case 'navigation_complete':
        case 'page_loaded':
          await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => undefined);
          return { condition, matched: true, waited_ms: timeoutMs };
        case 'network_idle':
          await page.waitForLoadState('networkidle', { timeout: timeoutMs });
          return { condition, matched: true, waited_ms: timeoutMs };
        default:
          throw new Error(`Unsupported wait condition: ${condition}`);
      }
    }

    return this.waitFor(page, {
      condition,
      timeout_ms: timeoutMs,
      poll_interval_ms: params.poll_interval_ms,
    });
  }

  private async mediaControl(page: Page, targetId: string | undefined, params: any): Promise<Record<string, any>> {
    if (!targetId) throw new Error('target_id is required for media_control');
    const locator = await this.resolveActionableLocator(page, targetId, 'media_control', params);
    const result = await locator.evaluate(async (node, input) => {
      if (!(node instanceof HTMLMediaElement)) {
        throw new Error('Target is not an audio/video media element');
      }
      const media = node;
      const command = String(input.command ?? 'play');
      switch (command) {
        case 'play':
          await media.play().catch((error) => {
            throw new Error(`Media play failed: ${error?.message ?? error}`);
          });
          break;
        case 'pause':
        case 'stop':
          media.pause();
          if (command === 'stop') media.currentTime = 0;
          break;
        case 'seek':
          media.currentTime = Math.max(0, Number(input.time_seconds ?? input.time ?? 0));
          break;
        case 'mute':
          media.muted = true;
          break;
        case 'unmute':
          media.muted = false;
          break;
        case 'set_volume':
          media.volume = Math.min(1, Math.max(0, Number(input.volume ?? 1)));
          break;
        case 'set_playback_rate':
          media.playbackRate = Math.max(0.0625, Number(input.rate ?? input.playback_rate ?? 1));
          break;
        default:
          throw new Error(`Unsupported media command: ${command}`);
      }
      return {
        command,
        current_time: Number(media.currentTime.toFixed(3)),
        duration: Number.isFinite(media.duration) ? Number(media.duration.toFixed(3)) : undefined,
        paused: media.paused,
        ended: media.ended,
        muted: media.muted,
        volume: Number(media.volume.toFixed(2)),
        playback_rate: Number(media.playbackRate.toFixed(2)),
      };
    }, params);
    await this.shortStabilization(page);
    return result;
  }

  private async fillForm(
    sessionId: string,
    page: Page,
    targetId: string | undefined,
    params: any,
    depth: number
  ): Promise<Record<string, any>> {
    const formId = targetId ?? params.form_id;
    const fields = params.fields;
    if (!formId) throw new Error('form_id or target_id is required for fill_form');
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('fields object is required for fill_form');

    const started = performance.now();
    const steps: FlowStepResult[] = [];
    const changed: FieldState[] = [];

    try {
      for (const [name, value] of Object.entries(fields)) {
        const stepStart = performance.now();
        const field = await this.findFormField(page, formId, name);
        changed.push(await this.readField(page, field.id));
        await this.writeField(sessionId, page, field, value, params.timeout_ms, depth);
        steps.push({
          index: steps.length,
          action: field.kind === 'select' ? 'select' : field.kind === 'check' ? 'click' : 'type',
          target_id: field.id,
          status: 'success',
          duration_ms: Math.round(performance.now() - stepStart),
          data: { field: name },
        });
      }

      const validation = await this.validateForm(page, formId);
      if (!validation.valid) {
        throw new Error(`Form validation failed: ${JSON.stringify(validation.errors)}`);
      }

      if (params.submit) {
        const stepStart = performance.now();
        await this.dispatch(sessionId, page, 'submit', formId, params, depth + 1);
        steps.push({
          index: steps.length,
          action: 'submit',
          target_id: formId,
          status: 'success',
          duration_ms: Math.round(performance.now() - stepStart),
        });
      }

      return {
        ...report('fill_form', steps),
        fields_filled: Object.keys(fields),
        submitted: Boolean(params.submit),
        duration_ms: Math.round(performance.now() - started),
      };
    } catch (error) {
      const onFailure = params.on_failure ?? (params.rollback !== false ? 'rollback' : 'fail');
      if (onFailure === 'rollback') {
        await this.restoreFields(page, changed);
      }
      if (onFailure === 'continue') {
        return {
          ...report('fill_form', steps),
          fields_filled: Object.keys(fields),
          submitted: false,
          partial: true,
          error: (error as Error).message,
          duration_ms: Math.round(performance.now() - started),
        };
      }
      throw error;
    }
  }

  private async multiClick(
    sessionId: string,
    page: Page,
    targetId: string | undefined,
    params: any,
    depth: number
  ): Promise<Record<string, any>> {
    const ids = unique([
      ...(targetId ? [targetId] : []),
      ...toArray(params.element_ids ?? params.target_ids ?? params.targets),
    ]);
    if (ids.length === 0) throw new Error('element_ids are required for multi_click');
    if (ids.length > 50) throw new Error('multi_click exceeds max 50');

    const steps: FlowStepResult[] = [];
    const continueOnError = params.on_failure === 'continue' || (params.on_failure === undefined && params.continue_on_error !== false);
    for (const id of ids) {
      const step = await this.runStep(sessionId, page, { action: 'click', target_id: id, params }, steps.length, depth + 1);
      steps.push(step);
      if (step.status === 'error' && !continueOnError) {
        throw new Error(`multi_click failed at ${id}: ${step.error}`);
      }
    }

    return report('multi_click', steps);
  }

  private async sequence(sessionId: string, page: Page, params: any, depth: number): Promise<Record<string, any>> {
    const steps = assertSteps(params.steps, 'steps', 100);
    const results: FlowStepResult[] = [];

    for (const step of steps) {
      const result = await this.runStep(sessionId, page, step, results.length, depth + 1);
      results.push(result);
      if (result.status === 'error' && params.stop_on_error !== false) {
        throw new Error(`sequence failed at step ${result.index}: ${result.error}`);
      }
    }

    return report('sequence', results);
  }

  private async parallel(sessionId: string, page: Page, params: any, depth: number): Promise<Record<string, any>> {
    const steps = assertSteps(params.steps ?? params.actions, 'steps', 20);
    if (steps.some((step) => step.action === 'parallel')) throw new Error('parallel nesting limit exceeded');
    for (const step of steps) {
      if (!PAR_ACTIONS.has(step.action)) {
        throw new Error(`parallel does not allow ${step.action}`);
      }
    }

    const results = await Promise.all(steps.map((step, index) => this.runStep(sessionId, page, step, index, depth + 1)));
    const summary = report('parallel', results);
    if (summary.failed > 0 && params.continue_on_error !== true) {
      throw new Error(`parallel failed: ${summary.failed} step(s) failed`);
    }
    return summary;
  }

  private async branch(sessionId: string, page: Page, params: any, depth: number): Promise<Record<string, any>> {
    if (depth >= 3) throw new Error('if nesting limit exceeded');
    const matched = await this.testCondition(page, params.condition);
    const next = matched ? params.then : params.else;
    if (!next) {
      return {
        mode: 'if',
        matched,
        branch: matched ? 'then' : 'else',
        completed: 0,
        failed: 0,
        skipped: 1,
        steps: [
          {
            index: 0,
            action: 'noop',
            status: 'skipped',
            duration_ms: 0,
          },
        ],
      };
    }

    const step = await this.runStep(sessionId, page, next, 0, depth + 1);
    if (step.status === 'error') throw new Error(`if ${matched ? 'then' : 'else'} failed: ${step.error}`);
    return {
      ...report('if', [step]),
      matched,
      branch: matched ? 'then' : 'else',
    };
  }

  private async loop(sessionId: string, page: Page, params: any, depth: number): Promise<Record<string, any>> {
    if (depth >= 2) throw new Error('loop nesting limit exceeded');
    const condition = params.while ?? params.condition;
    const step = params.do;
    if (!condition) throw new Error('loop condition is required');
    if (!step?.action) throw new Error('loop do action is required');

    const maxIterations = Math.min(Math.max(Number(params.max_iterations ?? 10), 1), 50);
    const delayMs = Math.min(Math.max(Number(params.delay_ms ?? 0), 0), 10000);
    const results: FlowStepResult[] = [];

    for (let index = 0; index < maxIterations; index += 1) {
      if (!(await this.testCondition(page, condition))) break;
      const result = await this.runStep(sessionId, page, step, index, depth + 1);
      results.push(result);
      if (result.status === 'error') throw new Error(`loop failed at iteration ${index}: ${result.error}`);
      if (delayMs > 0) await page.waitForTimeout(delayMs);
    }

    return {
      ...report('loop', results),
      max_iterations: maxIterations,
      exhausted: results.length === maxIterations,
    };
  }

  private async waitFor(page: Page, params: any): Promise<Record<string, any>> {
    if (!params.condition) throw new Error('condition is required for wait_for');

    const started = performance.now();
    const timeoutMs = Math.min(Math.max(Number(params.timeout_ms ?? 10000), 1), 120000);
    const pollMs = Math.min(Math.max(Number(params.poll_interval_ms ?? 250), 25), 10000);

    while (performance.now() - started <= timeoutMs) {
      if (await this.testCondition(page, params.condition)) {
        return {
          matched: true,
          elapsed_ms: Math.round(performance.now() - started),
          condition: params.condition,
        };
      }
      await page.waitForTimeout(pollMs);
    }

    throw new Error(`wait_for timed out after ${timeoutMs}ms`);
  }

  private async searchAndPaginate(
    sessionId: string,
    page: Page,
    targetId: string | undefined,
    params: any,
    depth: number
  ): Promise<Record<string, any>> {
    const inputId = targetId ?? params.search_input_id;
    if (!inputId) throw new Error('search_input_id or target_id is required for search_and_paginate');
    if (params.query === undefined) throw new Error('query is required for search_and_paginate');

    await this.dispatch(sessionId, page, 'type', inputId, {
      text: String(params.query),
      clear: params.clear !== false,
      press_enter: Boolean(params.submit && !params.submit_id && !params.submit_form_id),
      timeout_ms: params.timeout_ms,
    }, depth + 1);

    if (params.submit_id) {
      await this.dispatch(sessionId, page, 'click', params.submit_id, params, depth + 1);
    } else if (params.submit_form_id) {
      await this.dispatch(sessionId, page, 'submit', params.submit_form_id, params, depth + 1);
    }

    const pages = [];
    const maxPages = Math.min(Math.max(Number(params.max_pages ?? 1), 1), 20);
    for (let index = 0; index < maxPages; index += 1) {
      await this.shortStabilization(page);
      pages.push(await this.pageSlice(page, index + 1));
      if (!params.collect_all_pages || index === maxPages - 1) break;

      const nextId = params.next_id ?? params.next_button_id;
      if (nextId) {
        const next = await this.locatorForAny(page, nextId);
        if ((await next.count()) === 0 || !(await next.isVisible().catch(() => false))) break;
        if (await next.isDisabled().catch(() => false)) break;
        await this.dispatch(sessionId, page, 'click', nextId, params, depth + 1);
      } else if (params.next_selector) {
        const next = page.locator(String(params.next_selector)).first();
        if ((await next.count()) === 0 || !(await next.isVisible().catch(() => false))) break;
        await next.click({ timeout: params.timeout_ms ?? 5000 });
        await this.shortStabilization(page);
      } else {
        break;
      }
    }

    return {
      query: params.query,
      pages_collected: pages.length,
      pages,
    };
  }

  /**
   * Concept §5.6: fill_and_verify — fill form fields then verify values match.
   * Rounds: 2 (fill + verify). Policy: Rollback.
   */
  private async fillAndVerify(
    sessionId: string,
    page: Page,
    targetId: string | undefined,
    params: any,
    depth: number
  ): Promise<Record<string, any>> {
    const formId = targetId ?? params.form_id;
    if (!formId) throw new Error('form_id or target_id is required for fill_and_verify');
    const original: FieldState[] = [];
    for (const name of Object.keys(params.fields ?? {})) {
      const field = await this.findFormField(page, formId, name);
      original.push(await this.readField(page, field.id));
    }

    const fillResult = await this.fillForm(sessionId, page, targetId, {
      ...params,
      submit: false,
      rollback: true,
    }, depth);

    // Verify round: re-read all fields and compare
    const mismatches: Array<{ field: string; expected: unknown; actual: unknown }> = [];
    for (const [name, expected] of Object.entries(params.fields ?? {})) {
      try {
        const field = await this.findFormField(page, formId, name);
        const state = await this.readField(page, field.id);
        const actual = state.kind === 'check' ? state.checked : state.value;
        const expectedStr = String(expected);
        const actualStr = String(actual);
        if (actualStr !== expectedStr && !(state.kind === 'check' && Boolean(actual) === Boolean(expected))) {
          mismatches.push({ field: name, expected, actual });
        }
      } catch {
        mismatches.push({ field: name, expected, actual: '<read_failed>' });
      }
    }

    if (mismatches.length > 0) {
      const onFailure = params.on_failure ?? 'rollback';
      if (onFailure === 'rollback') {
        await this.restoreFields(page, original);
        throw new LlmBrowserError('VALIDATION_ERROR', `fill_and_verify validation failed: ${JSON.stringify(mismatches)}`, {
          mismatches,
        });
      }
      return {
        ...fillResult,
        mode: 'fill_and_verify',
        verified: false,
        mismatches,
      };
    }

    return {
      ...fillResult,
      mode: 'fill_and_verify',
      verified: true,
      mismatches: [],
    };
  }

  /**
   * Concept §5.6: navigate_and_extract — navigate to URL then extract content.
   * Rounds: 2 (navigate + extract). Policy: Fail-fast.
   */
  private async navigateAndExtract(
    sessionId: string,
    page: Page,
    params: any,
    depth: number
  ): Promise<Record<string, any>> {
    if (!params.url) throw new Error('url is required for navigate_and_extract');

    await this.dispatch(sessionId, page, 'navigate', undefined, {
      url: params.url,
      timeout_ms: params.timeout_ms,
    }, depth + 1);

    await this.shortStabilization(page, params.wait_ms ?? 2000);

    const content = await this.pageSlice(page, 1);
    const selector = params.extract_selector;
    let extracted: string | undefined;
    if (selector) {
      extracted = await page.locator(String(selector)).first()
        .textContent({ timeout: params.timeout_ms ?? 5000 })
        .catch(() => undefined) ?? undefined;
    }

    return {
      mode: 'navigate_and_extract',
      url: page.url(),
      title: content.title,
      content: extracted ?? content.text,
      headings: content.headings,
      links: content.links,
    };
  }

  /**
   * Concept §5.6: login_flow — multi-step login sequence with rollback.
   * Rounds: 4+ (navigate → fill credentials → submit → verify auth). Policy: Rollback.
   */
  private async loginFlow(
    sessionId: string,
    page: Page,
    params: any,
    depth: number
  ): Promise<Record<string, any>> {
    if (!params.url && !params.login_url) throw new Error('url or login_url is required for login_flow');
    const steps: FlowStepResult[] = [];
    const started = performance.now();
    const originalUrl = page.url();
    const changed: FieldState[] = [];
    const onFailure = params.on_failure ?? 'rollback';

    try {
      // Step 1: Navigate to login page
      const navStep = await this.runStep(sessionId, page,
        { action: 'navigate', params: { url: params.url ?? params.login_url } },
        0, depth + 1);
      steps.push(navStep);
      if (navStep.status === 'error') throw new Error(`login_flow navigate failed: ${navStep.error}`);

      const formId = params.form_id ?? await this.detectFormContainer(page);

      // Step 2: Fill credentials
      const credentials = params.credentials ?? params.fields ?? {};
      for (const [name, value] of Object.entries(credentials)) {
        const field = await this.findFormField(page, formId, name);
        changed.push(await this.readField(page, field.id));
        await this.writeField(sessionId, page, field, value, params.timeout_ms, depth + 1);
        steps.push({
          index: steps.length,
          action: 'type',
          target_id: field.id,
          status: 'success',
          duration_ms: Math.round(performance.now() - started),
          data: { field: name },
        });
      }

      // Step 3: Submit
      const submitTarget = params.submit_id ?? params.submit_button_id;
      if (submitTarget) {
        const submitStep = await this.runStep(sessionId, page,
          { action: 'click', target_id: submitTarget },
          steps.length, depth + 1);
        steps.push(submitStep);
        if (submitStep.status === 'error') throw new Error(`login_flow submit failed: ${submitStep.error}`);
      } else {
        const submitStep = await this.runStep(sessionId, page,
          { action: 'submit', target_id: formId },
          steps.length, depth + 1);
        steps.push(submitStep);
        if (submitStep.status === 'error') throw new Error(`login_flow submit failed: ${submitStep.error}`);
      }

      await this.shortStabilization(page, params.wait_after_submit_ms ?? 3000);

      // Step 4: Verify authentication
      let authenticated = false;
      if (params.success_url) {
        authenticated = page.url().includes(String(params.success_url));
      } else if (params.success_element) {
        const locator = await this.locatorForAny(page, String(params.success_element));
        authenticated = (await locator.count().catch(() => 0)) > 0;
      } else {
        // Default: check that URL changed from login page
        authenticated = page.url() !== (params.url ?? params.login_url);
      }

      if (!authenticated) throw new Error('login_flow verification failed');

      return {
        ...report('login_flow', steps),
        authenticated,
        url: page.url(),
        duration_ms: Math.round(performance.now() - started),
      };
    } catch (error: any) {
      steps.push({
        index: steps.length,
        action: 'rollback',
        status: onFailure === 'rollback' ? 'success' : 'skipped',
        duration_ms: Math.round(performance.now() - started),
        error: error.message,
      });
      if (onFailure === 'rollback') {
        await this.restoreFields(page, changed);
        if (originalUrl && page.url() !== originalUrl) {
          await page.goto(originalUrl, { waitUntil: 'load', timeout: params.timeout_ms ?? 10000 }).catch(() => undefined);
        }
      }
      if (onFailure === 'continue') {
        return {
          ...report('login_flow', steps),
          authenticated: false,
          partial: true,
          error: error.message,
          url: page.url(),
          duration_ms: Math.round(performance.now() - started),
        };
      }
      throw error;
    }
  }

  /**
   * Concept §5.7: async_navigate — background navigation with operation_id.
   */
  private async asyncNavigate(sessionId: string, params: any): Promise<Record<string, any>> {
    if (!params.url) throw new Error('url is required for async_navigate');

    const page = this.browserCore.getPage(sessionId);
    const record = this.opStore.start({
      session_id: sessionId,
      action: 'async_navigate',
      estimated_time_ms: params.estimated_time_ms ?? 10000,
      cancel: async () => {
        await page.evaluate(() => window.stop()).catch(() => undefined);
      },
      run: async () => {
        await page.goto(resolvePageUrl(page, String(params.url)), { waitUntil: 'load' });
        await page.waitForLoadState('networkidle', { timeout: params.timeout_ms ?? 30000 }).catch(() => undefined);
        return { url: page.url(), title: await page.title() };
      },
    });

    return {
      status: 'started',
      operation_id: record.operation_id,
      action: 'async_navigate',
      state: record.state,
      estimated_time_ms: record.estimated_time_ms,
    };
  }

  /**
   * Concept §5.7: poll — check async operation status.
   */
  private async pollOp(params: any): Promise<Record<string, any>> {
    if (!params.operation_id) throw new Error('operation_id is required for poll');

    const record = this.opStore.get(String(params.operation_id));
    if (!record) throw new Error(`Operation not found: ${params.operation_id}`);

    return this.opStore.toStatus(record);
  }

  /**
   * Concept §5.7: cancel — cancel async operation with partial result.
   */
  private async cancelOp(params: any): Promise<Record<string, any>> {
    if (!params.operation_id) throw new Error('operation_id is required for cancel');

    const record = this.opStore.cancel(String(params.operation_id));
    if (!record) throw new Error(`Operation not found: ${params.operation_id}`);

    return {
      status: 'cancelled',
      operation_id: record.operation_id,
      cancelled_at_progress: record.progress,
      partial_result: record.partial_result,
    };
  }

  /**
   * Concept §5.8: try-catch — error handling with fallback actions.
   */
  private async tryCatch(
    sessionId: string,
    page: Page,
    params: any,
    depth: number
  ): Promise<Record<string, any>> {
    if (depth >= 2) throw new Error('try nesting limit exceeded');
    if (!params.do?.action) throw new Error('try requires a "do" action');

    try {
      const result = await this.runStep(sessionId, page, params.do, 0, depth + 1);
      if (result.status === 'error') throw new Error(result.error);
      return {
        mode: 'try',
        branch: 'do',
        ...result,
      };
    } catch (error: any) {
      const { code } = classifyActionError(error);

      // Find matching catch block
      const catches: Array<{ error_code?: string | string[]; action?: FlowStep; fallback?: FlowStep }> =
        Array.isArray(params.catch) ? params.catch : (params.catch ? [params.catch] : []);

      for (const handler of catches) {
        if (handler.error_code) {
          const codes = Array.isArray(handler.error_code) ? handler.error_code : [handler.error_code];
          if (!codes.includes(code) && !codes.includes('*')) continue;
        }
        // Matched — execute fallback
        const fallbackAction = (handler.fallback ?? (typeof handler.action === 'object' ? handler.action : handler)) as FlowStep;
        if (!fallbackAction?.action || typeof fallbackAction.action !== 'string') {
          throw new Error('try catch handler requires fallback action');
        }
        const fallback = await this.runStep(sessionId, page, fallbackAction, 0, depth + 1);
        return {
          mode: 'try',
          branch: 'catch',
          caught_error: { code, message: error.message },
          ...fallback,
        };
      }

      // No matching catch — re-throw
      throw error;
    }
  }

  /**
   * Concept §5.8: define_script — register named parameterized sequence.
   */
  private async defineScript(params: any): Promise<Record<string, any>> {
    if (!params.name) throw new Error('name is required for define_script');
    if (!Array.isArray(params.steps)) throw new Error('steps array is required for define_script');

    const name = String(params.name);
    const declaredParams: string[] = params.params ?? params.parameters ?? [];
    this.scripts.define(name, params.steps, declaredParams);

    return {
      mode: 'define_script',
      name,
      steps_count: params.steps.length,
      params: declaredParams,
      registered: true,
    };
  }

  /**
   * Concept §5.8: call_script — execute named script with argument substitution.
   */
  private async callScript(
    sessionId: string,
    page: Page,
    params: any,
    depth: number
  ): Promise<Record<string, any>> {
    if (!params.name) throw new Error('name is required for call_script');

    const script = this.scripts.get(String(params.name));
    if (!script) throw new LlmBrowserError('SCRIPT_NOT_FOUND', `Script not found: ${params.name}`);

    const args = params.args ?? params.arguments ?? {};
    const instantiated = this.scripts.instantiate(script.steps, args);

    // Execute as sequence
    return this.sequence(sessionId, page, {
      steps: instantiated,
      stop_on_error: params.stop_on_error ?? true,
    }, depth);
  }

  private async upload(sessionId: string, page: Page, targetId: string | undefined, params: any): Promise<Record<string, any>> {
    if (!targetId) throw new Error('Target ID is required for upload action');
    const locator = await this.locatorForAny(page, targetId);
    await locator.waitFor({ state: 'attached', timeout: params.timeout_ms ?? 5000 });
    if (await locator.isDisabled().catch(() => false)) throw new Error(`Target ${targetId} is disabled`);

    const files = await this.collectUploadFiles(sessionId, params);
    if (files.length === 0) throw new Error('upload requires file_path, file_paths, files, or file_content');

    await locator.setInputFiles(files.map((file) => file.absolutePath), { timeout: params.timeout_ms ?? 5000 });
    await this.shortStabilization(page);
    return {
      files: files.map((file) => file.info),
      count: files.length,
    };
  }

  private async download(sessionId: string, page: Page, targetId: string | undefined, params: any): Promise<Record<string, any>> {
    const timeout = params.timeout_ms ?? 10000;
    const downloadPromise = page.waitForEvent('download', { timeout });

    if (params.url) {
      await page.evaluate(({ url, fileName }) => {
        const anchor = document.createElement('a');
        anchor.href = String(url);
        if (fileName) anchor.download = String(fileName);
        anchor.style.display = 'none';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      }, { url: params.url, fileName: params.file_name });
    } else {
      const locator = await this.resolveActionableLocator(page, targetId, 'download', params);
      await locator.click({ timeout });
    }

    const download = await downloadPromise;
    const failure = await download.failure();
    if (failure) throw new Error(`Download failed: ${failure}`);

    const target = await this.box.reserve(
      sessionId,
      'downloads',
      params.file_name ?? download.suggestedFilename() ?? `download-${Date.now()}`
    );
    await download.saveAs(target.absolutePath);
    return {
      file: await this.box.info(sessionId, target.absolutePath),
      suggested_filename: download.suggestedFilename(),
      url: download.url(),
    };
  }

  private async screenshotFile(
    sessionId: string,
    page: Page,
    targetId: string | undefined,
    params: any,
    action: string
  ): Promise<Record<string, any>> {
    const options = {
      type: 'png' as const,
      timeout: params.timeout_ms ?? 5000,
    };
    const buffer = targetId
      ? await (await this.resolveActionableLocator(page, targetId, action, params)).screenshot(options)
      : await page.screenshot({
          ...options,
          fullPage: params.full_page !== false,
        });
    const stored = await this.box.put(sessionId, 'shots', ensureExt(params.file_name ?? `shot-${Date.now()}`, '.png'), buffer);
    const viewport = page.viewportSize();
    return {
      file: stored.info,
      width: viewport?.width,
      height: viewport?.height,
      full_page: !targetId && params.full_page !== false,
    };
  }

  private async pdf(sessionId: string, page: Page, params: any): Promise<Record<string, any>> {
    const target = await this.box.reserve(sessionId, 'shots', ensureExt(params.file_name ?? `page-${Date.now()}`, '.pdf'));
    const options: any = {
      path: target.absolutePath,
      format: params.format ?? 'A4',
      printBackground: params.print_background !== false,
      landscape: Boolean(params.landscape),
    };
    if (params.scale !== undefined) options.scale = Number(params.scale);
    if (params.margin && typeof params.margin === 'object') options.margin = params.margin;
    await page.pdf(options);
    return {
      file: await this.box.info(sessionId, target.absolutePath),
      format: options.format,
      print_background: options.printBackground,
      landscape: options.landscape,
    };
  }

  private async fs(sessionId: string, params: any): Promise<Record<string, any>> {
    const operation = String(params.operation ?? params.op ?? 'list');
    const filePath = params.path ?? params.file_path ?? '.';

    switch (operation) {
      case 'list':
        return {
          operation,
          path: String(filePath),
          entries: await this.box.list(sessionId, String(filePath), Boolean(params.recursive)),
        };
      case 'read':
        if (!filePath) throw new Error('path is required for fs read');
        return {
          operation,
          file: await this.box.read(sessionId, String(filePath), params.encoding === 'base64' ? 'base64' : 'utf8'),
        };
      case 'write': {
        if (!filePath || filePath === '.') throw new Error('path is required for fs write');
        const content = contentBuffer(params);
        const written = await this.box.writePath(sessionId, String(filePath), content);
        return {
          operation,
          file: written.info,
        };
      }
      case 'delete':
        if (!filePath || filePath === '.') throw new Error('path is required for fs delete');
        return {
          operation,
          ...(await this.box.delete(sessionId, String(filePath))),
        };
      default:
        throw new Error(`Unsupported fs operation: ${operation}`);
    }
  }

  private async collectUploadFiles(sessionId: string, params: any): Promise<Array<{ info: Record<string, any>; absolutePath: string }>> {
    const files: Array<{ info: Record<string, any>; absolutePath: string }> = [];

    for (const requestedPath of toArray(params.file_paths ?? params.file_path ?? params.path)) {
      const absolutePath = await this.box.filePath(sessionId, requestedPath, 'uploads');
      files.push({
        absolutePath,
        info: await this.box.info(sessionId, absolutePath),
      });
    }

    for (const entry of arrayParam(params.files)) {
      if (entry.path || entry.file_path) {
        const absolutePath = await this.box.filePath(sessionId, String(entry.path ?? entry.file_path), 'uploads');
        files.push({
          absolutePath,
          info: await this.box.info(sessionId, absolutePath),
        });
      } else if (entry.content !== undefined || entry.file_content !== undefined || entry.base64 !== undefined) {
        const stored = await this.box.put(
          sessionId,
          'uploads',
          entry.name ?? entry.file_name ?? params.file_name,
          entry.base64 ? Buffer.from(String(entry.base64), 'base64') : String(entry.content ?? entry.file_content ?? '')
        );
        files.push(stored);
      }
    }

    if (params.file_content !== undefined || params.content !== undefined || params.base64 !== undefined) {
      const stored = await this.box.put(
        sessionId,
        'uploads',
        params.file_name,
        params.base64 ? Buffer.from(String(params.base64), 'base64') : String(params.file_content ?? params.content ?? '')
      );
      files.push(stored);
    }

    return files;
  }

  private async runStep(sessionId: string, page: Page, step: FlowStep, index: number, depth: number): Promise<FlowStepResult> {
    const started = performance.now();
    const params = stripRoutingParams(stepParams(step));
    const targetId = stepTarget(step);

    try {
      const data = await this.dispatch(sessionId, page, step.action, targetId, params, depth);
      return {
        index,
        action: step.action,
        target_id: targetId,
        status: 'success',
        duration_ms: Math.round(performance.now() - started),
        data,
      };
    } catch (error: any) {
      return {
        index,
        action: step.action,
        target_id: targetId,
        status: 'error',
        duration_ms: Math.round(performance.now() - started),
        error: error.message,
      };
    }
  }

  private async testCondition(page: Page, condition: any): Promise<boolean> {
    if (!condition || typeof condition !== 'object') throw new Error('condition object is required');

    switch (condition.type) {
      case 'element_exists':
        return (await (await this.locatorForAny(page, condition.element_id ?? condition.target_id)).count()) > 0;
      case 'element_visible':
        return (await this.locatorForAny(page, condition.element_id ?? condition.target_id)).isVisible().catch(() => false);
      case 'element_text_contains': {
        const text = await (await this.locatorForAny(page, condition.element_id ?? condition.target_id)).textContent().catch(() => '');
        return (text ?? '').includes(String(condition.text ?? condition.value ?? ''));
      }
      case 'element_text_matches': {
        const text = await (await this.locatorForAny(page, condition.element_id ?? condition.target_id)).textContent().catch(() => '');
        return new RegExp(String(condition.pattern ?? '')).test(text ?? '');
      }
      case 'element_state':
        return this.elementState(page, condition.element_id ?? condition.target_id, condition.state, condition.value);
      case 'url_contains':
        return page.url().includes(String(condition.value ?? condition.text ?? ''));
      case 'url_matches':
        return new RegExp(String(condition.pattern ?? condition.value ?? '')).test(page.url());
      case 'network_idle':
        return page.waitForLoadState('networkidle', { timeout: condition.timeout_ms ?? 1000 }).then(() => true).catch(() => false);
      case 'custom_javascript': {
        const expression = condition.expression ?? condition.script ?? condition.javascript;
        if (typeof expression !== 'string' || expression.trim() === '') {
          throw new Error('custom_javascript condition requires expression');
        }
        const timeoutMs = Math.min(Math.max(Number(condition.timeout_ms ?? 1000), 50), 5000);
        return Promise.race([
          page.evaluate((source) => {
            const fn = new Function(`return Boolean(${source});`);
            return Boolean(fn());
          }, expression),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]).catch(() => false);
      }
      default:
        throw new Error(`Unsupported condition: ${condition.type}`);
    }
  }

  private async findFormField(page: Page, formId: string, key: string): Promise<FieldRef> {
    const formLocator = await this.locatorForAny(page, formId);
    const prefix = formId.includes(':') ? `${formId.slice(0, formId.lastIndexOf(':'))}:` : '';
    const field = await formLocator.evaluate((formElement, { formId, key, prefix }) => {
      const semanticIdAttr = 'data-llm-browser-id';
      const state = window as unknown as { __llmBrowserNextId?: number };
      state.__llmBrowserNextId ??= 1;
      const escapeAttribute = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const norm = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const ensureId = (el: HTMLElement): string => {
        const existing = el.getAttribute(semanticIdAttr);
        if (existing && (!prefix || existing.startsWith(prefix))) return existing;
        if (!prefix && el.id) return el.id;
        const base = el.id || existing || `e${state.__llmBrowserNextId}`;
        if (!el.id && !existing) state.__llmBrowserNextId = (state.__llmBrowserNextId ?? 1) + 1;
        const id = `${prefix}${base}`;
        el.setAttribute(semanticIdAttr, id);
        return id;
      };
      const labelText = (el: HTMLElement): string => {
        const explicit = el.id ? document.querySelector(`label[for="${escapeAttribute(el.id)}"]`) : null;
        const implicit = el.closest('label');
        return norm((explicit ?? implicit)?.textContent);
      };
      const form = formElement;
      if (!(form instanceof HTMLElement)) throw new Error(`Form container not found: ${formId}`);

      const wanted = norm(key);
      const controls = Array.from(form.querySelectorAll('input, select, textarea')).filter(
        (el): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
          el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
      );
      const field = controls.find((el) => {
        const semanticId = el.getAttribute(semanticIdAttr);
        const values = [
          semanticId,
          el.id,
          el.getAttribute('name'),
          el.getAttribute('placeholder'),
          el.getAttribute('aria-label'),
          labelText(el),
        ].map(norm);
        return values.includes(wanted);
      });
      if (!field) throw new Error(`Field not found in ${formId}: ${key}`);

      const tag = field.tagName.toLowerCase();
      const type = field instanceof HTMLInputElement ? field.type : tag;
      const kind = tag === 'select' ? 'select' : type === 'checkbox' || type === 'radio' ? 'check' : 'text';
      return {
        id: ensureId(field),
        kind,
        type,
      };
    }, { formId, key, prefix });

    return field as FieldRef;
  }

  private async detectFormContainer(page: Page): Promise<string> {
    return page.evaluate(() => {
      const semanticIdAttr = 'data-llm-browser-id';
      const state = window as unknown as { __llmBrowserNextId?: number };
      state.__llmBrowserNextId ??= 1;
      const ensureId = (el: HTMLElement): string => {
        const existing = el.getAttribute(semanticIdAttr);
        if (existing) return existing;
        if (el.id) return el.id;
        const id = `login-form-${state.__llmBrowserNextId}`;
        state.__llmBrowserNextId = (state.__llmBrowserNextId ?? 1) + 1;
        el.setAttribute(semanticIdAttr, id);
        return id;
      };
      const forms = Array.from(document.querySelectorAll('form')) as HTMLFormElement[];
      const passwordForm = forms.find((form) => form.querySelector('input[type="password"]'));
      const form = passwordForm ?? forms[0];
      if (form) return ensureId(form);
      return ensureId(document.body);
    });
  }

  private async readField(page: Page, fieldId: string): Promise<FieldState> {
    const locator = await this.locatorForAny(page, fieldId);
    return locator.evaluate((el, fieldId) => {
      if (el instanceof HTMLSelectElement) {
        return {
          id: fieldId,
          kind: 'select',
          value: Array.from(el.selectedOptions).map((option) => option.value),
        };
      }
      if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) {
        return {
          id: fieldId,
          kind: 'check',
          checked: el.checked,
        };
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return {
          id: fieldId,
          kind: 'text',
          value: el.value,
        };
      }
      throw new Error(`Unsupported field: ${fieldId}`);
    }, fieldId) as Promise<FieldState>;
  }

  private async writeField(
    sessionId: string,
    page: Page,
    field: FieldRef,
    value: unknown,
    timeoutMs: number | undefined,
    depth: number
  ): Promise<void> {
    if (field.kind === 'select') {
      await this.dispatch(sessionId, page, 'select', field.id, { value, timeout_ms: timeoutMs }, depth + 1);
      return;
    }
    if (field.kind === 'check') {
      await this.setCheck(page, field.id, Boolean(value));
      await this.shortStabilization(page);
      return;
    }
    await this.dispatch(sessionId, page, 'type', field.id, { text: String(value), clear: true, timeout_ms: timeoutMs }, depth + 1);
  }

  private async setCheck(page: Page, fieldId: string, checked: boolean): Promise<void> {
    const locator = await this.locatorForAny(page, fieldId);
    await locator.evaluate((el, checked) => {
      if (!(el instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(el.type)) {
        throw new Error('Checkbox/radio not found');
      }
      if (el.checked !== checked) el.click();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, checked);
  }

  private async validateForm(page: Page, formId: string): Promise<{ valid: boolean; errors: any[] }> {
    const locator = await this.locatorForAny(page, formId);
    return locator.evaluate((form, formId) => {
      if (!(form instanceof HTMLElement)) throw new Error(`Form container not found: ${formId}`);

      const controls = Array.from(form.querySelectorAll('input, select, textarea')).filter(
        (el): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
          el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
      );
      const errors = controls
        .filter((field) => !field.validity.valid)
        .map((field) => ({
          id: field.id || field.getAttribute('data-llm-browser-id') || field.name,
          name: field.name || undefined,
          message: field.validationMessage,
        }));

      return {
        valid: form instanceof HTMLFormElement
          ? form.checkValidity()
          : controls.every((field) => field.validity.valid),
        errors,
      };
    }, formId);
  }

  private async restoreFields(page: Page, fields: FieldState[]): Promise<void> {
    for (const field of fields.reverse()) {
      const locator = await this.locatorForAny(page, field.id).catch(() => undefined);
      if (!locator) continue;
      await locator.evaluate((el, field) => {
        if (field.kind === 'select' && el instanceof HTMLSelectElement) {
          const values = new Set(Array.isArray(field.value) ? field.value.map(String) : [String(field.value ?? '')]);
          for (const option of Array.from(el.options)) option.selected = values.has(option.value);
        } else if (field.kind === 'check' && el instanceof HTMLInputElement) {
          el.checked = Boolean(field.checked);
        } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.value = String(field.value ?? '');
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, field).catch(() => undefined);
    }
  }

  private async elementState(page: Page, targetId: string | undefined, state: string, expected: unknown): Promise<boolean> {
    if (!targetId) return false;
    const locator = await this.locatorForAny(page, targetId);
    return locator.evaluate((el, { state, expected }) => {
      let actual: unknown;
      if (state === 'disabled') {
        actual = 'disabled' in el ? Boolean((el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled) : false;
      } else if (state === 'checked') {
        actual = el instanceof HTMLInputElement ? el.checked : false;
      } else if (state === 'selected') {
        actual = el instanceof HTMLOptionElement ? el.selected : false;
      } else if (state === 'visible') {
        const rect = (el as HTMLElement).getBoundingClientRect();
        actual = rect.width > 0 || rect.height > 0;
      } else {
        throw new Error(`Unsupported element state: ${state}`);
      }

      return expected === undefined ? Boolean(actual) : actual === expected;
    }, { state, expected });
  }

  private async pageSlice(page: Page, index: number): Promise<Record<string, any>> {
    return page.evaluate((index) => {
      const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      return {
        index,
        url: location.href,
        title: document.title,
        headings: Array.from(document.querySelectorAll('h1,h2,h3'))
          .slice(0, 12)
          .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
          .filter(Boolean),
        links: Array.from(document.querySelectorAll('a[href]'))
          .slice(0, 20)
          .map((el) => ({
            text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
            href: (el as HTMLAnchorElement).href,
          })),
        text: text.slice(0, 2000),
      };
    }, index);
  }

  private async resolveActionableLocator(
    page: Page,
    targetId: string | undefined,
    action: string,
    params: Record<string, any> = {}
  ): Promise<Locator> {
    if (!targetId) throw new Error(`Target ID is required for ${action} action`);

    const locator = await this.locatorForAny(page, targetId);
    await locator.waitFor({ state: 'visible', timeout: 5000 });

    const isDisabled = await locator.isDisabled().catch(() => false);
    if (isDisabled) throw new Error(`Target ${targetId} is disabled`);

    await this.assertPreconditions(page, locator, targetId, action, params);
    return locator;
  }

  private async assertPreconditions(
    page: Page,
    locator: Locator,
    targetId: string,
    action: string,
    params: Record<string, any>
  ): Promise<void> {
    const preconditions = new Set<string>([
      ...defaultPreconditions(action),
      ...toArray(params.preconditions),
    ]);

    if (preconditions.has('page_loaded')) {
      const ready = await page.evaluate(() => document.readyState !== 'loading').catch(() => false);
      if (!ready) throw new LlmBrowserError('PAGE_NOT_LOADED', 'Page is not loaded enough for action', { target_id: targetId, action });
    }

    if (preconditions.has('network_idle')) {
      const idle = await page.waitForLoadState('networkidle', { timeout: Number(params.precondition_timeout_ms ?? 1000) })
        .then(() => true)
        .catch(() => false);
      if (!idle) throw new LlmBrowserError('ACTION_PRECONDITION_FAILED', 'network_idle precondition failed', { target_id: targetId, action });
    }

    if (preconditions.has('no_modal_open')) {
      const blocked = await locator.evaluate((target) => {
        const visible = (el: Element) => {
          const style = window.getComputedStyle(el);
          const rect = (el as HTMLElement).getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const modals = Array.from(document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], [aria-modal="true"], .modal, [data-modal="true"]'))
          .filter((el) => visible(el) && !el.contains(target));
        return modals.length > 0;
      }).catch(() => false);
      if (blocked) throw new LlmBrowserError('MODAL_OPEN', 'A modal is open and blocks the target action', { target_id: targetId, action });
    }

    if (preconditions.has('element_stable')) {
      const stable = await this.isStable(locator);
      if (!stable) throw new LlmBrowserError('ELEMENT_NOT_STABLE', `Target ${targetId} is moving or animating`, { target_id: targetId, action });
    }
  }

  private async isStable(locator: Locator): Promise<boolean> {
    const before = await locator.boundingBox().catch(() => null);
    if (!before) return false;
    await new Promise((resolve) => setTimeout(resolve, 75));
    const after = await locator.boundingBox().catch(() => null);
    if (!after) return false;
    return Math.abs(before.x - after.x) <= 1
      && Math.abs(before.y - after.y) <= 1
      && Math.abs(before.width - after.width) <= 1
      && Math.abs(before.height - after.height) <= 1;
  }

  private async locatorForAny(page: Page, targetId: string): Promise<Locator> {
    const escaped = targetId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const selector = `[data-llm-browser-id="${escaped}"], [id="${escaped}"]`;
    const main = page.locator(selector).first();
    if ((await main.count().catch(() => 0)) > 0) return main;

    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const locator = frame.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0) return locator;
    }

    return main;
  }

  private async submitLocator(page: Page, locator: Locator, timeoutMs: number): Promise<void> {
    const navigation = page.waitForNavigation({ waitUntil: 'load', timeout: Math.min(timeoutMs, 2000) }).catch(() => undefined);
    let contextDestroyed = false;

    try {
      await locator.evaluate((element) => {
        const form = element instanceof HTMLFormElement ? element : element.closest('form');
        if (!form) throw new Error('Target is not inside a form');
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else {
          form.submit();
        }
      });
    } catch (error) {
      if (isContextDestroyed(error)) {
        contextDestroyed = true;
      } else {
        throw error;
      }
    }

    const nav = await navigation;
    await this.shortStabilization(page, contextDestroyed || Boolean(nav) ? 2000 : 1000);
  }

  private async shortStabilization(page: Page, timeoutMs = 1000): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 2000) }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined);
    await page.waitForTimeout(100);
  }

  private async scrollState(page: Page): Promise<Record<string, any>> {
    return page.evaluate(() => {
      const totalHeight = document.documentElement.scrollHeight;
      const viewportHeight = window.innerHeight;
      const maxScroll = Math.max(1, totalHeight - viewportHeight);

      return {
        scroll: {
          position: window.scrollY,
          viewport_height: viewportHeight,
          total_height: totalHeight,
          percentage: Number((window.scrollY / maxScroll).toFixed(4)),
        },
      };
    });
  }
}

interface FieldRef {
  id: string;
  kind: 'text' | 'select' | 'check';
  type?: string;
}

interface FieldState {
  id: string;
  kind: 'text' | 'select' | 'check';
  value?: unknown;
  checked?: boolean;
}

function stripRoutingParams(params: Record<string, any>): Record<string, any> {
  const clone = { ...params };
  delete clone.element_id;
  delete clone.target_id;
  return clone;
}

function isContextDestroyed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|Cannot find context|Target closed|Frame was detached/i.test(message);
}

function toArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function defaultPreconditions(action: string): string[] {
  if (['click', 'type', 'select', 'submit', 'hover', 'interact', 'download', 'screenshot'].includes(action)) {
    return ['element_visible', 'element_enabled', 'element_stable', 'no_modal_open', 'page_loaded'];
  }
  return [];
}

function arrayParam(value: unknown): any[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function ensureExt(name: string, ext: string): string {
  return name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`;
}

function contentBuffer(params: Record<string, any>): Buffer {
  if (params.base64 !== undefined) return Buffer.from(String(params.base64), 'base64');
  if (params.content !== undefined) return Buffer.from(String(params.content), 'utf8');
  if (params.file_content !== undefined) return Buffer.from(String(params.file_content), params.encoding === 'base64' ? 'base64' : 'utf8');
  throw new Error('content or base64 is required for fs write');
}

function resolvePageUrl(page: Page, url: string): string {
  if (/^(https?:|file:|data:|about:)/i.test(url)) return url;
  return new URL(url, page.url()).toString();
}

function substituteTemplate(value: unknown, args: Record<string, any>): unknown {
  if (Array.isArray(value)) return value.map((entry) => substituteTemplate(entry, args));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substituteTemplate(entry, args)])
    );
  }
  if (typeof value !== 'string') return value;

  const exact = value.match(/^\{\{(\w+)\}\}$/);
  if (exact) {
    if (args[exact[1]] === undefined) throw new Error(`Missing script parameter: {{${exact[1]}}}`);
    return args[exact[1]];
  }

  return value.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (args[key] === undefined) throw new Error(`Missing script parameter: {{${key}}}`);
    return String(args[key]);
  });
}
