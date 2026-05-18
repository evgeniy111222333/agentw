import { Page } from 'playwright';
import { ConfigurationManager } from '../../config/ConfigurationManager';

export interface TraversedNode {
  id: string;
  tagName: string;
  role?: string;
  label?: string;
  text?: string;
  attributes: Record<string, string>;
  visible: boolean;
  disabled: boolean;
  required: boolean;
  parentId?: string;
  selector: string;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
    in_viewport: boolean;
  };
  options?: Array<{ value: string; label: string; selected: boolean; disabled: boolean }>;
  form?: {
    action?: string;
    method?: string;
    fields: string[];
    submit_button_id?: string;
    enctype?: string;
    autocomplete?: string;
  };
  table?: {
    rows: string[][];
    row_count: number;
    column_count: number;
    truncated: boolean;
  };
  list?: {
    item_count: number;
    sample_items: string[];
  };
}

export interface TraversalResult {
  nodes: TraversedNode[];
  stats: {
    dom_nodes_count: number;
    semantic_nodes_count: number;
    semantic_nodes_total: number;
    skipped_invisible: number;
    skipped_noise: number;
    below_fold_count: number;
    raw_dom_bytes: number;
    max_elements: number;
    max_elements_requested?: number;
  };
}

export interface TraverseOptions {
  maxElements?: number;
}

export class DOMTraverser {
  async traverse(page: Page, options: TraverseOptions = {}): Promise<TraversalResult> {
    const semanticConfig = ConfigurationManager.getInstance().getConfig().semantic;
    const runtimeConfig = {
      ...semanticConfig,
      max_elements_override: options.maxElements,
    };

    return page.evaluate((config) => {
      const semanticIdAttr = 'data-llm-browser-id';
      const windowWithState = window as unknown as { __llmBrowserNextId?: number };
      windowWithState.__llmBrowserNextId ??= 1;

      const trackedAttributes = new Set([
        'action',
        'alt',
        'aria-checked',
        'aria-disabled',
        'aria-expanded',
        'aria-label',
        'aria-labelledby',
        'aria-pressed',
        'aria-selected',
        'autocomplete',
        'contenteditable',
        'data-testid',
        'disabled',
        'download',
        'enctype',
        'href',
        'maxlength',
        'method',
        'multiple',
        'name',
        'pattern',
        'placeholder',
        'required',
        'role',
        'src',
        'tabindex',
        'target',
        'title',
        'type',
        'value',
        'max',
      ]);

      const escapeAttribute = (value: string) =>
        value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

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

      const selectorFor = (el: HTMLElement, id: string): string => {
        if (el.id) return `[id="${escapeAttribute(id)}"]`;
        return `[${semanticIdAttr}="${escapeAttribute(id)}"]`;
      };

      const normalizeText = (value: string | null | undefined, limit: number): string | undefined => {
        const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
        if (!normalized) return undefined;
        return normalized.length > limit ? `${normalized.slice(0, limit).trim()}...` : normalized;
      };

      const directText = (el: HTMLElement): string | undefined => {
        const value = Array.from(el.childNodes)
          .filter((child) => child.nodeType === Node.TEXT_NODE)
          .map((child) => child.textContent ?? '')
          .join(' ');
        return normalizeText(value, config.max_text_length);
      };

      const labelledByText = (el: HTMLElement): string | undefined => {
        const labelledBy = el.getAttribute('aria-labelledby');
        if (!labelledBy) return undefined;

        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
        return normalizeText(text, 200);
      };

      const associatedLabel = (el: HTMLElement): string | undefined => {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) {
          return undefined;
        }

        const explicit = el.id ? document.querySelector(`label[for="${escapeAttribute(el.id)}"]`) : null;
        const implicit = el.closest('label');
        return normalizeText((explicit ?? implicit)?.textContent, 200);
      };

      const accessibleLabel = (el: HTMLElement): string | undefined =>
        normalizeText(el.getAttribute('aria-label'), 200) ??
        labelledByText(el) ??
        associatedLabel(el) ??
        normalizeText(el.getAttribute('alt'), 200) ??
        normalizeText(el.getAttribute('title'), 200) ??
        normalizeText(el.getAttribute('placeholder'), 200) ??
        normalizeText(el.getAttribute('name'), 120);

      const isElementVisible = (el: HTMLElement, style: CSSStyleDeclaration, rect: DOMRect): boolean => {
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          return false;
        }
        if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') {
          return false;
        }
        if (rect.width <= 0 && rect.height <= 0) {
          return el instanceof HTMLInputElement && el.type === 'hidden' ? false : Boolean(accessibleLabel(el));
        }
        return true;
      };

      const actionTags = new Set([
        'a',
        'button',
        'details',
        'form',
        'input',
        'label',
        'option',
        'select',
        'summary',
        'textarea',
      ]);
      const semanticTags = new Set([
        'article',
        'aside',
        'canvas',
        'dialog',
        'figure',
        'form',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'iframe',
        'img',
        'main',
        'nav',
        'ol',
        'progress',
        'section',
        'svg',
        'table',
        'ul',
        'video',
      ]);
      const usefulRoles = new Set([
        'alert',
        'button',
        'checkbox',
        'combobox',
        'dialog',
        'grid',
        'link',
        'listbox',
        'menu',
        'menuitem',
        'navigation',
        'option',
        'progressbar',
        'radio',
        'searchbox',
        'separator',
        'switch',
        'tab',
        'tablist',
        'textbox',
      ]);

      const isMeaningful = (el: HTMLElement, tagName: string, role: string | null, text?: string, label?: string): boolean => {
        if (actionTags.has(tagName) || semanticTags.has(tagName)) return true;
        if (role && usefulRoles.has(role)) return true;
        if (el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') return true;
        if (el.isContentEditable) return true;
        return Boolean(label || text);
      };

      const extractAttributes = (el: HTMLElement): Record<string, string> => {
        const attributes: Record<string, string> = {};
        for (const attr of Array.from(el.attributes)) {
          if (trackedAttributes.has(attr.name) || attr.name.startsWith('data-semantic-')) {
            attributes[attr.name] = attr.value;
          }
        }
        return attributes;
      };

      const extractSelectOptions = (el: HTMLElement) => {
        if (!(el instanceof HTMLSelectElement)) return undefined;

        return Array.from(el.options)
          .slice(0, 50)
          .map((option) => ({
            value: option.value,
            label: normalizeText(option.label || option.textContent, 120) ?? option.value,
            selected: option.selected,
            disabled: option.disabled,
          }));
      };

      const extractForm = (el: HTMLElement) => {
        if (!(el instanceof HTMLFormElement)) return undefined;

        const fields = Array.from(el.querySelectorAll('input, select, textarea'))
          .filter((field): field is HTMLElement => field instanceof HTMLElement)
          .map((field) => getSemanticId(field));

        const submit = el.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
        const submit_button_id = submit instanceof HTMLElement ? getSemanticId(submit) : undefined;

        return {
          action: el.getAttribute('action') ?? undefined,
          method: (el.getAttribute('method') ?? 'GET').toUpperCase(),
          fields,
          submit_button_id,
          enctype: el.getAttribute('enctype') ?? undefined,
          autocomplete: el.getAttribute('autocomplete') ?? undefined,
        };
      };

      const extractTable = (el: HTMLElement) => {
        if (!(el instanceof HTMLTableElement)) return undefined;

        const rows = Array.from(el.rows).map((row) =>
          Array.from(row.cells).map((cell) => normalizeText(cell.textContent, 120) ?? '')
        );
        const visibleRows = rows.length > 8 ? [...rows.slice(0, 5), ['...'], ...rows.slice(-3)] : rows;

        return {
          rows: visibleRows,
          row_count: rows.length,
          column_count: Math.max(0, ...rows.map((row) => row.length)),
          truncated: rows.length > visibleRows.length,
        };
      };

      const extractList = (el: HTMLElement) => {
        if (!(el instanceof HTMLUListElement || el instanceof HTMLOListElement)) return undefined;

        const items = Array.from(el.querySelectorAll(':scope > li'))
          .map((item) => normalizeText(item.textContent, 160))
          .filter((item): item is string => Boolean(item));

        return {
          item_count: items.length,
          sample_items: items.slice(0, 8),
        };
      };

      const allElements = Array.from(document.body?.querySelectorAll('*') ?? []).filter(
        (el): el is HTMLElement => el instanceof HTMLElement
      );
      const hardLimit = Math.max(1, Number(config.max_elements_hard_limit ?? config.max_elements));
      const requestedMax =
        config.max_elements_override === undefined ? undefined : Math.max(1, Number(config.max_elements_override));
      const baseMax = Math.min(hardLimit, requestedMax ?? Math.max(1, Number(config.max_elements)));
      const adaptiveMax = config.adaptive_max_elements && requestedMax === undefined
        ? Math.max(baseMax, Math.ceil(Math.sqrt(allElements.length) * 10))
        : baseMax;
      const maxElements = Math.min(hardLimit, adaptiveMax);
      const nodes: TraversedNode[] = [];
      let skippedInvisible = 0;
      let skippedNoise = 0;
      let belowFoldCount = 0;
      let semanticCandidates = 0;

      for (const el of allElements) {
        const tagName = el.tagName.toLowerCase();
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const visible = isElementVisible(el, style, rect);

        if (!visible) {
          skippedInvisible += 1;
          if (config.visible_only) continue;
        }

        const inViewport =
          rect.bottom >= 0 &&
          rect.right >= 0 &&
          rect.top <= window.innerHeight &&
          rect.left <= window.innerWidth;
        if (!inViewport) belowFoldCount += 1;

        const role = el.getAttribute('role');
        const textSource = ['input', 'select', 'textarea'].includes(tagName) ? undefined : directText(el) ?? normalizeText(el.innerText, 240);
        const label = accessibleLabel(el) ?? textSource;

        if (!isMeaningful(el, tagName, role, textSource, label)) {
          skippedNoise += 1;
          continue;
        }

        semanticCandidates += 1;
        if (nodes.length >= maxElements) continue;

        const id = getSemanticId(el);
        const parent = el.parentElement?.closest(`[${semanticIdAttr}], [id]`);
        const parentId = parent instanceof HTMLElement ? getSemanticId(parent) : undefined;
        const attributes = extractAttributes(el);
        const ariaDisabled = el.getAttribute('aria-disabled') === 'true';
        const nativeDisabled =
          (el instanceof HTMLButtonElement ||
            el instanceof HTMLInputElement ||
            el instanceof HTMLSelectElement ||
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLOptionElement) &&
          el.disabled;

        nodes.push({
          id,
          tagName,
          role: role ?? undefined,
          label,
          text: textSource,
          attributes,
          visible,
          disabled: Boolean(nativeDisabled || ariaDisabled),
          required:
            (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) &&
            el.required,
          parentId,
          selector: selectorFor(el, id),
          boundingBox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            in_viewport: inViewport,
          },
          options: extractSelectOptions(el),
          form: extractForm(el),
          table: extractTable(el),
          list: extractList(el),
        });
      }

      const rawDomBytes = new TextEncoder().encode(document.documentElement?.outerHTML ?? '').length;

      return {
        nodes,
        stats: {
          dom_nodes_count: allElements.length,
          semantic_nodes_count: nodes.length,
          semantic_nodes_total: semanticCandidates,
          skipped_invisible: skippedInvisible,
          skipped_noise: skippedNoise,
          below_fold_count: belowFoldCount,
          raw_dom_bytes: rawDomBytes,
          max_elements: maxElements,
          max_elements_requested: requestedMax,
        },
      };
    }, runtimeConfig);
  }
}
