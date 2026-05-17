import type { AvailableAction, ElementType, SemanticElement } from '../../common/types';
import type { PluginPageContext, PluginPageContribution, SemanticPlugin } from '../PluginRegistry';

export class SemanticActionMarkupPlugin implements SemanticPlugin {
  metadata = {
    name: 'semantic-action-markup',
    version: '0.1.0',
    priority: 100,
    kind: 'extractor',
    description: 'Reference implementation for Semantic Action Markup (SAM).',
    capabilities: ['sam:data-attributes', 'sam:script-actions', 'dynamic-actions'],
  };

  registerExtractors() {
    return [
      {
        type: 'sam_action',
        selector: '[data-semantic-action], script[type="application/llm-actions+json"]',
        description: 'Extracts explicit LLM actions from SAM data attributes and JSON action blocks.',
      },
    ];
  }

  async onPageLoad(context: PluginPageContext): Promise<PluginPageContribution> {
    const existingElementIds = new Set(context.elements.map((element) => element.id));
    const extracted = await context.page.evaluate(() => {
      type ExtractedAction = AvailableAction & { target?: string };
      type ExtractedElement = SemanticElement;

      const semanticIdAttr = 'data-llm-browser-id';
      const coreActions = new Set([
        'click',
        'go_back',
        'hover',
        'keyboard',
        'navigate',
        'refresh',
        'screenshot',
        'scroll',
        'scroll_to_element',
        'select',
        'snapshot',
        'submit',
        'type',
        'wait',
      ]);
      const windowWithState = window as unknown as { __llmBrowserNextId?: number };
      windowWithState.__llmBrowserNextId ??= 1;

      const escapeAttribute = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const normalizeText = (value: string | null | undefined, limit = 240): string | undefined => {
        const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
        if (!normalized) return undefined;
        return normalized.length > limit ? `${normalized.slice(0, limit).trim()}...` : normalized;
      };
      const normalizeActionName = (value: unknown): string | undefined => {
        const normalized = String(value ?? '')
          .trim()
          .replace(/\s+/g, '_')
          .replace(/[^\w:.-]/g, '');
        return normalized || undefined;
      };
      const getSemanticId = (el: HTMLElement): string => {
        if (el.id) return el.id;

        const existing = el.getAttribute(semanticIdAttr);
        if (existing) return existing;

        let id = '';
        do {
          const nextId = windowWithState.__llmBrowserNextId ?? 1;
          id = `e${nextId}`;
          windowWithState.__llmBrowserNextId = nextId + 1;
        } while (document.querySelector(`[${semanticIdAttr}="${escapeAttribute(id)}"]`));

        el.setAttribute(semanticIdAttr, id);
        return id;
      };
      const parseJson = (value: string | null | undefined): any => {
        if (!value) return undefined;
        try {
          return JSON.parse(value);
        } catch {
          return undefined;
        }
      };
      const parseList = (value: string | null | undefined): string[] | undefined => {
        const items = (value ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        return items.length > 0 ? items : undefined;
      };
      const riskOf = (value: unknown): 'low' | 'medium' | 'high' => {
        if (value === 'medium' || value === 'high' || value === 'low') return value;
        return 'low';
      };
      const elementTypeFor = (el: HTMLElement): ElementType => {
        const role = el.getAttribute('role')?.toLowerCase();
        const tag = el.tagName.toLowerCase();
        if (role === 'link' || tag === 'a') return 'link';
        if (role === 'textbox' || tag === 'input' || tag === 'textarea') return 'input';
        if (role === 'combobox' || tag === 'select') return 'select';
        if (tag === 'form') return 'form';
        if (role === 'button' || tag === 'button') return 'button';
        return 'button';
      };
      const labelFor = (el: HTMLElement, fallback?: string): string => {
        return (
          normalizeText(el.getAttribute('data-semantic-label'), 200) ??
          normalizeText(el.getAttribute('aria-label'), 200) ??
          normalizeText(el.getAttribute('title'), 200) ??
          normalizeText(el.textContent, 200) ??
          fallback ??
          'Semantic action'
        );
      };
      const isDisabled = (el: HTMLElement): boolean => {
        const nativeDisabled =
          (el instanceof HTMLButtonElement ||
            el instanceof HTMLInputElement ||
            el instanceof HTMLSelectElement ||
            el instanceof HTMLTextAreaElement) &&
          el.disabled;
        return Boolean(nativeDisabled || el.getAttribute('aria-disabled') === 'true');
      };
      const buildElement = (el: HTMLElement, actionName: string): ExtractedElement => {
        const id = getSemanticId(el);
        const rect = el.getBoundingClientRect();
        return {
          id,
          type: elementTypeFor(el),
          role: el.getAttribute('role') ?? undefined,
          label: labelFor(el, actionName),
          text: normalizeText(el.textContent, 240),
          visible: rect.width > 0 || rect.height > 0,
          disabled: isDisabled(el),
          source: {
            type: 'sam',
            plugin: 'semantic-action-markup',
            standard: 'SAM',
          },
        };
      };
      const executionFor = (
        el: HTMLElement | null,
        actionName: string,
        explicitExecution: any,
        endpoint?: string
      ): { action: string; target?: string; params?: Record<string, any> } => {
        const explicitAction =
          typeof explicitExecution === 'string'
            ? explicitExecution
            : typeof explicitExecution?.action === 'string'
              ? explicitExecution.action
              : undefined;
        const explicitParams =
          typeof explicitExecution === 'object' && explicitExecution?.params && typeof explicitExecution.params === 'object'
            ? explicitExecution.params
            : {};

        if (explicitAction) {
          return {
            action: explicitAction,
            target: explicitExecution?.target,
            params: explicitParams,
          };
        }

        if (endpoint) {
          return {
            action: 'navigate',
            params: { url: endpoint },
          };
        }

        if (coreActions.has(actionName)) return { action: actionName };

        if (el instanceof HTMLAnchorElement && el.href) {
          return {
            action: 'navigate',
            target: getSemanticId(el),
            params: { url: el.href },
          };
        }

        if (el instanceof HTMLFormElement) {
          return {
            action: 'submit',
            target: getSemanticId(el),
          };
        }

        if (el instanceof HTMLSelectElement) {
          return {
            action: 'select',
            target: getSemanticId(el),
          };
        }

        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (el instanceof HTMLInputElement && ['checkbox', 'radio', 'button', 'submit'].includes(el.type)) {
            return {
              action: 'click',
              target: getSemanticId(el),
            };
          }
          return {
            action: 'type',
            target: getSemanticId(el),
          };
        }

        return {
          action: 'click',
          target: el ? getSemanticId(el) : undefined,
        };
      };
      const buildAction = (input: {
        actionName: string;
        label: string;
        target?: string;
        params?: Record<string, any>;
        preconditions?: string[];
        risk?: 'low' | 'medium' | 'high';
        actionId?: string;
        execution?: { action: string; target?: string; params?: Record<string, any> };
      }): ExtractedAction => {
        const execution = input.execution ?? { action: input.actionName, target: input.target };
        return {
          action_id: input.actionId ?? `sam_${input.actionName}_${input.target ?? 'page'}`,
          action: input.actionName,
          target: input.target,
          label: input.label,
          params: input.params,
          preconditions: input.preconditions,
          risk: input.risk ?? 'low',
          source: {
            type: 'sam',
            plugin: 'semantic-action-markup',
            standard: 'SAM',
          },
          execution: {
            ...execution,
            target: execution.target ?? input.target,
          },
        };
      };

      const actions: ExtractedAction[] = [];
      const elements: ExtractedElement[] = [];
      const warnings: string[] = [];

      for (const el of Array.from(document.querySelectorAll('[data-semantic-action]'))) {
        if (!(el instanceof HTMLElement)) continue;
        const actionNames = parseList(el.getAttribute('data-semantic-action')) ?? [];
        for (const rawAction of actionNames) {
          const actionName = normalizeActionName(rawAction);
          if (!actionName) continue;

          const target = getSemanticId(el);
          const execution = executionFor(
            el,
            actionName,
            parseJson(el.getAttribute('data-semantic-execution')) ?? el.getAttribute('data-semantic-exec'),
            el.getAttribute('data-semantic-endpoint') ?? undefined
          );

          elements.push(buildElement(el, actionName));
          actions.push(
            buildAction({
              actionName,
              target,
              label: labelFor(el, actionName),
              params: parseJson(el.getAttribute('data-semantic-params')),
              preconditions: parseList(el.getAttribute('data-semantic-preconditions')),
              risk: riskOf(el.getAttribute('data-semantic-risk')),
              execution,
            })
          );
        }
      }

      const scripts = Array.from(document.querySelectorAll('script[type="application/llm-actions+json"]'));
      scripts.forEach((script, index) => {
        const parsed = parseJson(script.textContent);
        const specs = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.actions) ? parsed.actions : [];
        if (!Array.isArray(specs)) {
          warnings.push(`script ${index} does not contain an actions array`);
          return;
        }

        specs.forEach((spec: any, actionIndex: number) => {
          const actionName = normalizeActionName(spec?.action ?? spec?.name);
          if (!actionName) {
            warnings.push(`script ${index} action ${actionIndex} is missing action/name`);
            return;
          }

          const targetElement =
            typeof spec.selector === 'string'
              ? document.querySelector(spec.selector)
              : typeof spec.target === 'string'
                ? document.getElementById(spec.target) ?? document.querySelector(`[${semanticIdAttr}="${escapeAttribute(spec.target)}"]`)
                : null;
          const htmlTarget = targetElement instanceof HTMLElement ? targetElement : null;
          const target = spec.target_id ?? (htmlTarget ? getSemanticId(htmlTarget) : undefined);
          const execution = executionFor(htmlTarget, actionName, spec.execution ?? spec.exec, spec.endpoint);

          if (htmlTarget) elements.push(buildElement(htmlTarget, actionName));

          actions.push(
            buildAction({
              actionName,
              target,
              label: spec.label ?? (htmlTarget ? labelFor(htmlTarget, actionName) : actionName),
              params: spec.params ?? spec.parameters ?? spec.schema,
              preconditions: Array.isArray(spec.preconditions) ? spec.preconditions : undefined,
              risk: riskOf(spec.risk),
              actionId: spec.action_id,
              execution,
            })
          );
        });
      });

      return { actions, elements, warnings };
    });

    const elements = extracted.elements.filter((element) => !existingElementIds.has(element.id));

    return {
      elements,
      actions: extracted.actions,
      warnings: extracted.warnings,
      metadata: {
        actions: extracted.actions.length,
        elements: elements.length,
        warnings: extracted.warnings.length,
      },
    };
  }
}
