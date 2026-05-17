import { Locator, Page } from 'playwright';
import { BrowserCore } from '../layer1_browser_core/BrowserCore';
import { SemanticElement } from '../common/types';
import { globalEventBus } from '../common/EventBus';
import { FlowStep, FlowStepResult, PAR_ACTIONS, assertSteps, report, stepParams, stepTarget } from '../flow/Flow';
import { Box } from '../file/Box';

export interface ActionExecutionResult {
  action: string;
  target_id?: string;
  duration_ms: number;
  data?: Record<string, any>;
}

export class ActionExecutor {
  constructor(
    private browserCore: BrowserCore,
    private box = new Box()
  ) {}

  async executeAction(
    sessionId: string,
    action: string,
    targetId?: string,
    params?: any,
    _currentElements?: SemanticElement[]
  ): Promise<ActionExecutionResult> {
    const page = this.browserCore.getPage(sessionId);
    const started = performance.now();

    try {
      const data = await this.dispatch(sessionId, page, action, targetId, params ?? {});

      const result: ActionExecutionResult = {
        action,
        target_id: targetId,
        duration_ms: Math.round(performance.now() - started),
        data,
      };
      await globalEventBus.publish('action_completed', { session_id: sessionId, ...result });
      return result;
    } catch (error: any) {
      const duration_ms = Math.round(performance.now() - started);
      await globalEventBus.publish('action_failed', {
        session_id: sessionId,
        action,
        target_id: targetId,
        duration_ms,
        error: error.message,
      });
      throw new Error(`Failed to execute action ${action}: ${error.message}`);
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
        await page.goto(params.url, { waitUntil: 'load' });
        await page.waitForLoadState('networkidle', { timeout: params.timeout_ms ?? 5000 }).catch(() => undefined);
        return { url: page.url() };

      case 'click': {
        const locator = await this.resolveActionableLocator(page, targetId, action);
        await locator.click({ timeout: params.timeout_ms ?? 5000 });
        await this.shortStabilization(page);
        return;
      }

      case 'type': {
        const locator = await this.resolveActionableLocator(page, targetId, action);
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
        const locator = await this.resolveActionableLocator(page, targetId, action);
        if (params.value === undefined || params.value === null || params.value === '') {
          throw new Error('Value is required for select action');
        }
        const value = Array.isArray(params.value) ? params.value.map(String) : String(params.value);
        await locator.selectOption(value, { timeout: params.timeout_ms ?? 5000 });
        await this.shortStabilization(page);
        return { value: params.value };
      }

      case 'submit': {
        const locator = await this.resolveActionableLocator(page, targetId, action);
        await locator.evaluate((element) => {
          const form = element instanceof HTMLFormElement ? element : element.closest('form');
          if (!form) throw new Error('Target is not inside a form');
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
          } else {
            form.submit();
          }
        });
        await this.shortStabilization(page);
        return;
      }

      case 'hover': {
        const locator = await this.resolveActionableLocator(page, targetId, action);
        await locator.hover({ timeout: params.timeout_ms ?? 5000 });
        await this.shortStabilization(page);
        return;
      }

      case 'scroll':
      case 'scroll_to_element': {
        const amount = Number(params.amount ?? 720);
        const direction = params.direction === 'up' ? -1 : 1;
        if (targetId) {
          const locator = this.locatorFor(page, targetId);
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
        await page.waitForTimeout(Math.min(Number(params.ms ?? 500), 10000));
        return { waited_ms: Math.min(Number(params.ms ?? 500), 10000) };

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
          ? await (await this.resolveActionableLocator(page, targetId, action)).screenshot(screenshotOptions)
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

      case 'refresh':
        await page.reload({ waitUntil: 'load' });
        await this.shortStabilization(page);
        return { url: page.url() };

      case 'snapshot':
        return;

      default:
        throw new Error(`Unsupported action: ${action}`);
    }
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
      if (params.rollback !== false) {
        await this.restoreFields(page, changed);
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
    for (const id of ids) {
      const step = await this.runStep(sessionId, page, { action: 'click', target_id: id, params }, steps.length, depth + 1);
      steps.push(step);
      if (step.status === 'error' && params.continue_on_error === false) {
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
        const next = this.locatorFor(page, nextId);
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

  private async upload(sessionId: string, page: Page, targetId: string | undefined, params: any): Promise<Record<string, any>> {
    if (!targetId) throw new Error('Target ID is required for upload action');
    const locator = this.locatorFor(page, targetId);
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
      const locator = await this.resolveActionableLocator(page, targetId, 'download');
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
      ? await (await this.resolveActionableLocator(page, targetId, action)).screenshot(options)
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
        return (await this.locatorFor(page, condition.element_id ?? condition.target_id).count()) > 0;
      case 'element_visible':
        return this.locatorFor(page, condition.element_id ?? condition.target_id).isVisible().catch(() => false);
      case 'element_text_contains': {
        const text = await this.locatorFor(page, condition.element_id ?? condition.target_id).textContent().catch(() => '');
        return (text ?? '').includes(String(condition.text ?? condition.value ?? ''));
      }
      case 'element_text_matches': {
        const text = await this.locatorFor(page, condition.element_id ?? condition.target_id).textContent().catch(() => '');
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
      default:
        throw new Error(`Unsupported condition: ${condition.type}`);
    }
  }

  private async findFormField(page: Page, formId: string, key: string): Promise<FieldRef> {
    const field = await page.evaluate(({ formId, key }) => {
      const semanticIdAttr = 'data-llm-browser-id';
      const state = window as unknown as { __llmBrowserNextId?: number };
      state.__llmBrowserNextId ??= 1;
      const escapeAttribute = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const norm = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const find = (id: string): HTMLElement | null =>
        document.getElementById(id) ?? document.querySelector(`[${semanticIdAttr}="${escapeAttribute(id)}"]`);
      const ensureId = (el: HTMLElement): string => {
        if (el.id) return el.id;
        const existing = el.getAttribute(semanticIdAttr);
        if (existing) return existing;
        const next = `e${state.__llmBrowserNextId}`;
        state.__llmBrowserNextId = (state.__llmBrowserNextId ?? 1) + 1;
        el.setAttribute(semanticIdAttr, next);
        return next;
      };
      const labelText = (el: HTMLElement): string => {
        const explicit = el.id ? document.querySelector(`label[for="${escapeAttribute(el.id)}"]`) : null;
        const implicit = el.closest('label');
        return norm((explicit ?? implicit)?.textContent);
      };
      const form = find(formId);
      if (!(form instanceof HTMLFormElement)) throw new Error(`Form not found: ${formId}`);

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
    }, { formId, key });

    return field as FieldRef;
  }

  private async readField(page: Page, fieldId: string): Promise<FieldState> {
    return page.evaluate((fieldId) => {
      const el = findField(fieldId);
      if (!el) throw new Error(`Field not found: ${fieldId}`);

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

      function findField(id: string): Element | null {
        const escaped = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return document.getElementById(id) ?? document.querySelector(`[data-llm-browser-id="${escaped}"]`);
      }
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
    await page.evaluate(({ fieldId, checked }) => {
      const escaped = fieldId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const el = document.getElementById(fieldId) ?? document.querySelector(`[data-llm-browser-id="${escaped}"]`);
      if (!(el instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(el.type)) {
        throw new Error(`Checkbox/radio not found: ${fieldId}`);
      }
      if (el.checked !== checked) el.click();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { fieldId, checked });
  }

  private async validateForm(page: Page, formId: string): Promise<{ valid: boolean; errors: any[] }> {
    return page.evaluate((formId) => {
      const escaped = formId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const form = document.getElementById(formId) ?? document.querySelector(`[data-llm-browser-id="${escaped}"]`);
      if (!(form instanceof HTMLFormElement)) throw new Error(`Form not found: ${formId}`);

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
        valid: form.checkValidity(),
        errors,
      };
    }, formId);
  }

  private async restoreFields(page: Page, fields: FieldState[]): Promise<void> {
    for (const field of fields.reverse()) {
      await page.evaluate((field) => {
        const escaped = field.id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const el = document.getElementById(field.id) ?? document.querySelector(`[data-llm-browser-id="${escaped}"]`);
        if (!el) return;

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
    return page.evaluate(({ targetId, state, expected }) => {
      const escaped = targetId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const el = document.getElementById(targetId) ?? document.querySelector(`[data-llm-browser-id="${escaped}"]`);
      if (!el) return false;

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
    }, { targetId, state, expected });
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

  private async resolveActionableLocator(page: Page, targetId: string | undefined, action: string): Promise<Locator> {
    if (!targetId) throw new Error(`Target ID is required for ${action} action`);

    const locator = this.locatorFor(page, targetId);
    await locator.waitFor({ state: 'visible', timeout: 5000 });

    const isDisabled = await locator.isDisabled().catch(() => false);
    if (isDisabled) throw new Error(`Target ${targetId} is disabled`);

    return locator;
  }

  private locatorFor(page: Page, targetId: string): Locator {
    const escaped = targetId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return page.locator(`[data-llm-browser-id="${escaped}"], [id="${escaped}"]`).first();
  }

  private async shortStabilization(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle', { timeout: 1000 }).catch(() => undefined);
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

function toArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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
