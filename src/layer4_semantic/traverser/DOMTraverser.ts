import { Frame, Page } from 'playwright';
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
  origin: string;
  context?: {
    type: 'main' | 'iframe' | 'shadow';
    frame_url?: string;
    frame_name?: string;
    frame_depth?: number;
    shadow_host_id?: string;
    shadow_mode?: 'open' | 'closed';
    parent_context_id?: string;
  };
  iframe?: {
    src?: string;
    url?: string;
    name?: string;
    title?: string;
    iframe_type: 'same_origin' | 'cross_origin' | 'content' | 'payment' | 'captcha' | 'auth' | 'ad' | 'unknown';
    embed_type?: 'youtube' | 'vimeo' | 'maps' | 'social' | 'video' | 'unknown';
    same_origin?: boolean;
    accessible?: boolean;
    status?: 'ready' | 'metadata_only' | 'blocked' | 'lazy' | 'depth_limited';
    depth?: number;
    width?: number;
    height?: number;
    video_id?: string;
    map_query?: string;
    sandbox?: string;
    loading?: string;
    referrer_policy?: string;
  };
  shadow?: {
    has_shadow: boolean;
    host_id?: string;
    mode?: 'open' | 'closed';
    content_count?: number;
  };
  slot_for?: string;
  slotted_in?: string;
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
    iframe_count: number;
    iframe_extracted_count: number;
    iframe_skipped_ads: number;
    iframe_depth_limited: number;
    shadow_root_count: number;
    closed_shadow_roots: number;
    max_frame_depth: number;
  };
}

export interface TraverseOptions {
  maxElements?: number;
}

interface FrameDescriptor {
  id?: string;
  src?: string;
  url?: string;
  name?: string;
  title?: string;
  selector?: string;
  iframe_type: TraversedNode['iframe'] extends infer T ? T extends { iframe_type: infer K } ? K : never : never;
  embed_type?: TraversedNode['iframe'] extends infer T ? T extends { embed_type?: infer K } ? K : never : never;
  same_origin: boolean;
  accessible: boolean;
  status: TraversedNode['iframe'] extends infer T ? T extends { status?: infer K } ? K : never : never;
  depth: number;
  width?: number;
  height?: number;
  video_id?: string;
  map_query?: string;
  sandbox?: string;
  loading?: string;
  referrer_policy?: string;
}

export class DOMTraverser {
  async traverse(page: Page, options: TraverseOptions = {}): Promise<TraversalResult> {
    const semanticConfig = ConfigurationManager.getInstance().getConfig().semantic;
    const runtimeConfig = {
      ...semanticConfig,
      include_shadow_dom: semanticConfig.include_shadow_dom !== false,
      include_iframes: semanticConfig.include_iframes !== false,
      max_frame_depth: Math.max(0, Number(semanticConfig.max_frame_depth ?? 3)),
      max_elements_override: options.maxElements,
    };

    const mainFrame = page.mainFrame();
    const main = await mainFrame.evaluate(evaluateDom, {
      config: runtimeConfig,
      context: {
        type: 'main',
        origin: 'main',
        idPrefix: '',
        rootParentId: undefined,
        frameDepth: 0,
      },
    });

    const frameResults: TraversalResult[] = [];
    const frameDescriptors: FrameDescriptor[] = [];
    if (runtimeConfig.include_iframes) {
      let extractedIndex = 0;
      for (const frame of page.frames()) {
        if (frame === mainFrame) continue;
        const depth = frameDepth(frame);
        const descriptor = await describeFrame(frame, page.url(), depth);
        frameDescriptors.push(descriptor);
        if (descriptor.id) {
          const parent = main.nodes.find((node) => node.id === descriptor.id);
          if (parent?.iframe) {
            parent.iframe = {
              ...parent.iframe,
              ...dropUndefined({
                url: descriptor.url,
                same_origin: descriptor.same_origin,
                accessible: descriptor.accessible,
                status: descriptor.status,
                depth,
              }),
            };
          }
        }

        if (!descriptor.id || descriptor.iframe_type === 'ad') continue;
        if (depth > runtimeConfig.max_frame_depth) continue;
        if (!descriptor.same_origin) continue;

        extractedIndex += 1;
        const prefix = `f${extractedIndex}:`;
        const result = await frame.evaluate(evaluateDom, {
          config: runtimeConfig,
          context: {
            type: 'iframe',
            origin: `iframe:${descriptor.url || descriptor.src || frame.url()}`,
            idPrefix: prefix,
            rootParentId: descriptor.id,
            frameUrl: descriptor.url || frame.url(),
            frameName: descriptor.name,
            frameDepth: depth,
            frameSelector: descriptor.selector,
          },
        }).catch(() => undefined);
        if (result) frameResults.push(result);
      }
    }

    return mergeResults([main, ...frameResults], frameDescriptors);
  }
}

function mergeResults(results: TraversalResult[], frameDescriptors: FrameDescriptor[]): TraversalResult {
  const first = results[0];
  const maxElements = first?.stats.max_elements ?? 1;
  const nodes: TraversedNode[] = [];
  for (const result of results) {
    for (const node of result.nodes) {
      if (nodes.length < maxElements) nodes.push(node);
    }
  }

  const stats = results.reduce((total, result) => ({
    dom_nodes_count: total.dom_nodes_count + result.stats.dom_nodes_count,
    semantic_nodes_count: nodes.length,
    semantic_nodes_total: total.semantic_nodes_total + result.stats.semantic_nodes_total,
    skipped_invisible: total.skipped_invisible + result.stats.skipped_invisible,
    skipped_noise: total.skipped_noise + result.stats.skipped_noise,
    below_fold_count: total.below_fold_count + result.stats.below_fold_count,
    raw_dom_bytes: total.raw_dom_bytes + result.stats.raw_dom_bytes,
    max_elements: maxElements,
    max_elements_requested: first?.stats.max_elements_requested,
    iframe_count: total.iframe_count + result.stats.iframe_count,
    iframe_extracted_count: total.iframe_extracted_count + (result === first ? 0 : 1),
    iframe_skipped_ads: total.iframe_skipped_ads + result.stats.iframe_skipped_ads,
    iframe_depth_limited: total.iframe_depth_limited + result.stats.iframe_depth_limited,
    shadow_root_count: total.shadow_root_count + result.stats.shadow_root_count,
    closed_shadow_roots: total.closed_shadow_roots + result.stats.closed_shadow_roots,
    max_frame_depth: Math.max(total.max_frame_depth, result.stats.max_frame_depth),
  }), {
    dom_nodes_count: 0,
    semantic_nodes_count: 0,
    semantic_nodes_total: 0,
    skipped_invisible: 0,
    skipped_noise: 0,
    below_fold_count: 0,
    raw_dom_bytes: 0,
    max_elements: maxElements,
    max_elements_requested: first?.stats.max_elements_requested,
    iframe_count: 0,
    iframe_extracted_count: 0,
    iframe_skipped_ads: 0,
    iframe_depth_limited: 0,
    shadow_root_count: 0,
    closed_shadow_roots: 0,
    max_frame_depth: 0,
  });

  stats.iframe_count = Math.max(stats.iframe_count, frameDescriptors.length);
  stats.iframe_depth_limited += frameDescriptors.filter((frame) => frame.status === 'depth_limited').length;

  return {
    nodes,
    stats,
  };
}

async function describeFrame(frame: Frame, pageUrl: string, depth: number): Promise<FrameDescriptor> {
  const frameUrl = frame.url();
  const handle = await frame.frameElement().catch(() => undefined);
  const element = handle
    ? await handle.evaluate((el: Element) => {
        const semanticIdAttr = 'data-llm-browser-id';
        const html = el as HTMLIFrameElement;
        const rect = html.getBoundingClientRect();
        const id = html.id || html.getAttribute(semanticIdAttr) || undefined;
        const selector = id
          ? html.id
            ? `[id="${html.id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
            : `[${semanticIdAttr}="${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
          : undefined;
        return {
          id,
          selector,
          src: html.getAttribute('src') || html.getAttribute('data-src') || undefined,
          name: html.getAttribute('name') || undefined,
          title: html.getAttribute('title') || html.getAttribute('aria-label') || undefined,
          width: Math.round(rect.width || Number(html.getAttribute('width')) || 0) || undefined,
          height: Math.round(rect.height || Number(html.getAttribute('height')) || 0) || undefined,
          sandbox: html.getAttribute('sandbox') || undefined,
          loading: html.getAttribute('loading') || undefined,
          referrer_policy: html.getAttribute('referrerpolicy') || undefined,
        };
      }).catch(() => undefined)
    : undefined;
  await handle?.dispose().catch(() => undefined);

  const src = element?.src || frameUrl;
  const classified = classifyFrame(src, frameUrl, element?.width, element?.height, element);
  const sameOrigin = isSameOrigin(pageUrl, frameUrl) || frameUrl === 'about:blank' || frameUrl === 'about:srcdoc';
  const depthLimited = depth > ConfigurationManager.getInstance().getConfig().semantic.max_frame_depth;
  return dropUndefined({
    ...element,
    url: frameUrl,
    src,
    iframe_type: classified.iframe_type === 'unknown' && sameOrigin ? 'same_origin' : classified.iframe_type,
    embed_type: classified.embed_type,
    same_origin: sameOrigin,
    accessible: sameOrigin && !depthLimited,
    status: depthLimited ? 'depth_limited' : sameOrigin ? 'ready' : classified.status,
    depth,
    video_id: classified.video_id,
    map_query: classified.map_query,
  }) as FrameDescriptor;
}

function frameDepth(frame: Frame): number {
  let depth = 0;
  let current = frame.parentFrame();
  while (current) {
    depth += 1;
    current = current.parentFrame();
  }
  return depth;
}

function isSameOrigin(parentUrl: string, childUrl: string): boolean {
  try {
    if (!childUrl || childUrl === 'about:blank' || childUrl === 'about:srcdoc') return true;
    return new URL(parentUrl).origin === new URL(childUrl, parentUrl).origin;
  } catch {
    return false;
  }
}

function classifyFrame(
  src: string | undefined,
  resolvedUrl: string | undefined,
  width?: number,
  height?: number,
  attrs: Record<string, any> = {}
): Partial<FrameDescriptor> {
  const value = `${src ?? ''} ${resolvedUrl ?? ''}`.toLowerCase();
  const adSize = `${width ?? ''}x${height ?? ''}`;
  if (
    /doubleclick\.net|googlesyndication\.com|googleadservices\.com|amazon-adsystem\.com|adservice\.|adnxs\.com|taboola|outbrain/.test(value) ||
    ['728x90', '300x250', '160x600', '320x50', '970x250'].includes(adSize) ||
    attrs['data-ad-client'] ||
    attrs['data-ad-slot']
  ) {
    return { iframe_type: 'ad', status: 'blocked' };
  }
  if (/youtube\.com|youtu\.be|youtube-nocookie\.com/.test(value)) {
    return { iframe_type: 'content', embed_type: 'youtube', status: 'metadata_only', video_id: youtubeId(src ?? resolvedUrl ?? '') };
  }
  if (/vimeo\.com|dailymotion\.com/.test(value)) return { iframe_type: 'content', embed_type: 'vimeo', status: 'metadata_only' };
  if (/google\.[^/]+\/maps|maps\.googleapis\.com|openstreetmap|mapbox/.test(value)) {
    return { iframe_type: 'content', embed_type: 'maps', status: 'metadata_only', map_query: mapQuery(src ?? resolvedUrl ?? '') };
  }
  if (/facebook\.com|platform\.twitter\.com|x\.com\/i\/frames|instagram\.com|linkedin\.com/.test(value)) {
    return { iframe_type: 'content', embed_type: 'social', status: 'metadata_only' };
  }
  if (/stripe\.com|paypal\.com|checkout|payment|braintree|adyen|klarna/.test(value)) {
    return { iframe_type: 'payment', status: 'metadata_only' };
  }
  if (/recaptcha|hcaptcha|captcha|arkoselabs/.test(value)) return { iframe_type: 'captcha', status: 'metadata_only' };
  if (/okta|auth0|login\.microsoftonline|accounts\.google|signin|sso/.test(value)) return { iframe_type: 'auth', status: 'metadata_only' };
  return { iframe_type: 'unknown', status: 'metadata_only' };
}

function youtubeId(value: string): string | undefined {
  try {
    const url = new URL(value, 'https://example.test');
    if (url.searchParams.get('v')) return url.searchParams.get('v') ?? undefined;
    const match = url.pathname.match(/\/(?:embed|shorts|watch|v)\/([^/?#]+)/) ?? (url.hostname.match(/youtu\.be/) && url.pathname.match(/^\/([^/?#]+)/));
    return match?.[1];
  } catch {
    return value.match(/(?:embed\/|youtu\.be\/|v=)([A-Za-z0-9_-]+)/)?.[1];
  }
}

function mapQuery(value: string): string | undefined {
  try {
    const url = new URL(value, 'https://example.test');
    return url.searchParams.get('q') ?? url.searchParams.get('query') ?? url.pathname.split('/').filter(Boolean).slice(-1)[0];
  } catch {
    return undefined;
  }
}

function evaluateDom(input: { config: any; context: any }): TraversalResult {
  const { config, context: rootContext } = input;
  const semanticIdAttr = 'data-llm-browser-id';
  const windowWithState = window as unknown as { __llmBrowserNextId?: number; __llmBrowserShadowRoots?: any };
  windowWithState.__llmBrowserNextId ??= 1;

  const safeId = (value: string): string => value.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);
  const localDropUndefined = <T extends Record<string, any>>(value: T): T => {
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) delete value[key];
      if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) localDropUndefined(value[key]);
    }
    return value;
  };
  const safeUrl = (value: string, base: string): string | undefined => {
    try {
      return new URL(value, base).toString();
    } catch {
      return value;
    }
  };
  const sameOriginInPage = (parentUrl: string, childUrl: string): boolean => {
    try {
      return new URL(parentUrl).origin === new URL(childUrl, parentUrl).origin;
    } catch {
      return false;
    }
  };
  const youtubeIdInPage = (value: string): string | undefined => {
    try {
      const url = new URL(value, 'https://example.test');
      if (url.searchParams.get('v')) return url.searchParams.get('v') ?? undefined;
      const match = url.pathname.match(/\/(?:embed|shorts|watch|v)\/([^/?#]+)/) ?? (url.hostname.match(/youtu\.be/) && url.pathname.match(/^\/([^/?#]+)/));
      return match?.[1];
    } catch {
      return value.match(/(?:embed\/|youtu\.be\/|v=)([A-Za-z0-9_-]+)/)?.[1];
    }
  };
  const mapQueryInPage = (value: string): string | undefined => {
    try {
      const url = new URL(value, 'https://example.test');
      return url.searchParams.get('q') ?? url.searchParams.get('query') ?? url.pathname.split('/').filter(Boolean).slice(-1)[0];
    } catch {
      return undefined;
    }
  };
  const classifyFrameInPage = (src: string | undefined, resolvedUrl: string | undefined, width?: number, height?: number, el?: Element): any => {
    const value = `${src ?? ''} ${resolvedUrl ?? ''}`.toLowerCase();
    const adSize = `${width ?? ''}x${height ?? ''}`;
    if (
      /doubleclick\.net|googlesyndication\.com|googleadservices\.com|amazon-adsystem\.com|adservice\.|adnxs\.com|taboola|outbrain/.test(value) ||
      ['728x90', '300x250', '160x600', '320x50', '970x250'].includes(adSize) ||
      el?.getAttribute('data-ad-client') ||
      el?.getAttribute('data-ad-slot')
    ) {
      return { iframe_type: 'ad', status: 'blocked' };
    }
    if (/youtube\.com|youtu\.be|youtube-nocookie\.com/.test(value)) {
      return { iframe_type: 'content', embed_type: 'youtube', status: 'metadata_only', video_id: youtubeIdInPage(src ?? resolvedUrl ?? '') };
    }
    if (/vimeo\.com|dailymotion\.com/.test(value)) return { iframe_type: 'content', embed_type: 'vimeo', status: 'metadata_only' };
    if (/google\.[^/]+\/maps|maps\.googleapis\.com|openstreetmap|mapbox/.test(value)) {
      return { iframe_type: 'content', embed_type: 'maps', status: 'metadata_only', map_query: mapQueryInPage(src ?? resolvedUrl ?? '') };
    }
    if (/facebook\.com|platform\.twitter\.com|x\.com\/i\/frames|instagram\.com|linkedin\.com/.test(value)) {
      return { iframe_type: 'content', embed_type: 'social', status: 'metadata_only' };
    }
    if (/stripe\.com|paypal\.com|checkout|payment|braintree|adyen|klarna/.test(value)) return { iframe_type: 'payment', status: 'metadata_only' };
    if (/recaptcha|hcaptcha|captcha|arkoselabs/.test(value)) return { iframe_type: 'captcha', status: 'metadata_only' };
    if (/okta|auth0|login\.microsoftonline|accounts\.google|signin|sso/.test(value)) return { iframe_type: 'auth', status: 'metadata_only' };
    return { iframe_type: 'unknown', status: 'metadata_only' };
  };
  const extractAttributes = (el: HTMLElement, attrs: Set<string>): Record<string, string> => {
    const attributes: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      if (attrs.has(attr.name) || attr.name.startsWith('data-semantic-')) attributes[attr.name] = attr.value;
    }
    return attributes;
  };
  const extractSelectOptions = (el: HTMLElement, normalize: (value: string | null | undefined, limit: number) => string | undefined) => {
    if (!(el instanceof HTMLSelectElement)) return undefined;
    return Array.from(el.options)
      .slice(0, 50)
      .map((option) => ({
        value: option.value,
        label: normalize(option.label || option.textContent, 120) ?? option.value,
        selected: option.selected,
        disabled: option.disabled,
      }));
  };
  const extractForm = (el: HTMLElement, ensureId: (el: HTMLElement) => string) => {
    if (!(el instanceof HTMLFormElement)) return undefined;
    const fields = Array.from(el.querySelectorAll('input, select, textarea'))
      .filter((field): field is HTMLElement => field instanceof HTMLElement)
      .map((field) => ensureId(field));
    const submit = el.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    return {
      action: el.getAttribute('action') ?? undefined,
      method: (el.getAttribute('method') ?? 'GET').toUpperCase(),
      fields,
      submit_button_id: submit instanceof HTMLElement ? ensureId(submit) : undefined,
      enctype: el.getAttribute('enctype') ?? undefined,
      autocomplete: el.getAttribute('autocomplete') ?? undefined,
    };
  };
  const extractTable = (el: HTMLElement, normalize: (value: string | null | undefined, limit: number) => string | undefined) => {
    if (!(el instanceof HTMLTableElement)) return undefined;
    const rows = Array.from(el.rows).map((row) => Array.from(row.cells).map((cell) => normalize(cell.textContent, 120) ?? ''));
    const visibleRows = rows.length > 8 ? [...rows.slice(0, 5), ['...'], ...rows.slice(-3)] : rows;
    return {
      rows: visibleRows,
      row_count: rows.length,
      column_count: Math.max(0, ...rows.map((row) => row.length)),
      truncated: rows.length > visibleRows.length,
    };
  };
  const extractList = (el: HTMLElement, normalize: (value: string | null | undefined, limit: number) => string | undefined) => {
    if (!(el instanceof HTMLUListElement || el instanceof HTMLOListElement)) return undefined;
    const items = Array.from(el.querySelectorAll(':scope > li'))
      .map((item) => normalize(item.textContent, 160))
      .filter((item): item is string => Boolean(item));
    return {
      item_count: items.length,
      sample_items: items.slice(0, 8),
    };
  };
  const rawDomWithShadow = (all: Array<{ el: HTMLElement }>): string => {
    const clone = document.documentElement?.cloneNode(true) as Element | undefined;
    for (const el of Array.from(clone?.querySelectorAll('[data-llm-browser-id]') ?? [])) el.removeAttribute('data-llm-browser-id');
    const shadowHtml = all
      .map(({ el }) => {
        const root = el.shadowRoot ?? windowWithState.__llmBrowserShadowRoots?.rootFor?.(el);
        return root ? `<shadow host="${el.id || el.tagName.toLowerCase()}">${root.innerHTML}</shadow>` : '';
      })
      .join('');
    return `${clone?.outerHTML ?? ''}${shadowHtml}`;
  };

  const trackedAttributes = new Set([
    'action',
    'allow',
    'allowfullscreen',
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
    'data-ad-client',
    'data-ad-slot',
    'data-src',
    'data-testid',
    'disabled',
    'download',
    'enctype',
    'height',
    'href',
    'loading',
    'maxlength',
    'method',
    'multiple',
    'name',
    'pattern',
    'placeholder',
    'referrerpolicy',
    'required',
    'role',
    'sandbox',
    'slot',
    'src',
    'srcdoc',
    'tabindex',
    'target',
    'title',
    'type',
    'value',
    'max',
    'width',
  ]);

  const escapeAttribute = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const getSemanticId = (el: HTMLElement, entryContext = rootContext): string => {
    const prefix = String(entryContext.idPrefix ?? '');
    const existing = el.getAttribute(semanticIdAttr);
    if (existing && (!prefix || existing.startsWith(prefix))) return existing;
    if (!prefix && el.id) return el.id;

    let base = el.id || existing || '';
    if (!base) {
      do {
        const nextId = windowWithState.__llmBrowserNextId ?? 1;
        base = `e${nextId}`;
        windowWithState.__llmBrowserNextId = nextId + 1;
      } while (document.querySelector(`[${semanticIdAttr}="${escapeAttribute(`${prefix}${base}`)}"]`));
    }

    const id = `${prefix}${base}`;
    el.setAttribute(semanticIdAttr, id);
    return id;
  };

  const selectorFor = (el: HTMLElement, id: string, entryContext: any): string => {
    const local = el.getAttribute(semanticIdAttr) === id
      ? `[${semanticIdAttr}="${escapeAttribute(id)}"]`
      : el.id
        ? `[id="${escapeAttribute(el.id)}"]`
        : `[${semanticIdAttr}="${escapeAttribute(id)}"]`;
    return entryContext.frameSelector ? `${entryContext.frameSelector} >> ${local}` : local;
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
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    if (rect.width <= 0 && rect.height <= 0) {
      return el instanceof HTMLInputElement && el.type === 'hidden' ? false : Boolean(accessibleLabel(el));
    }
    return true;
  };

  const actionTags = new Set(['a', 'button', 'details', 'form', 'input', 'label', 'option', 'select', 'summary', 'textarea']);
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
    'slot',
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

  const shadowHosts = new Map<HTMLElement, { hostId: string; mode: 'open' | 'closed'; contentCount: number }>();
  type Entry = { el: HTMLElement; context: any };
  const entries: Entry[] = [];

  const shadowRootFor = (el: HTMLElement): { root: ShadowRoot; mode: 'open' | 'closed' } | undefined => {
    if (!config.include_shadow_dom) return undefined;
    if (el.shadowRoot) return { root: el.shadowRoot, mode: 'open' };
    const store = windowWithState.__llmBrowserShadowRoots;
    const closed = store?.rootFor?.(el);
    if (closed) return { root: closed, mode: store?.modeFor?.(el) === 'open' ? 'open' : 'closed' };
    return undefined;
  };

  const walk = (root: ParentNode, entryContext: any) => {
    for (const child of Array.from(root.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const slotted = entryContext.lightShadowHostId && child.getAttribute('slot')
        ? `shadow:${entryContext.lightShadowHostId}#slot:${child.getAttribute('slot') || 'default'}`
        : entryContext.slottedIn;
      const childContext = { ...entryContext, slottedIn: slotted };
      entries.push({ el: child, context: childContext });

      let shadowHostId: string | undefined;
      const shadow = shadowRootFor(child);
      if (shadow) {
        shadowHostId = getSemanticId(child, childContext);
        shadowHosts.set(child, {
          hostId: shadowHostId,
          mode: shadow.mode,
          contentCount: shadow.root.childElementCount,
        });
        walk(shadow.root, {
          ...childContext,
          type: 'shadow',
          origin: `shadow:${shadowHostId}`,
          idPrefix: `${childContext.idPrefix ?? ''}s${safeId(shadowHostId)}:`,
          rootParentId: shadowHostId,
          shadowHostId,
          shadowMode: shadow.mode,
          lightShadowHostId: undefined,
        });
      }

      walk(child, {
        ...childContext,
        lightShadowHostId: shadowHostId ?? childContext.lightShadowHostId,
      });
    }
  };

  walk(document.body ?? document.documentElement, rootContext);

  const hardLimit = Math.max(1, Number(config.max_elements_hard_limit ?? config.max_elements));
  const requestedMax = config.max_elements_override === undefined ? undefined : Math.max(1, Number(config.max_elements_override));
  const baseMax = Math.min(hardLimit, requestedMax ?? Math.max(1, Number(config.max_elements)));
  const adaptiveMax = config.adaptive_max_elements && requestedMax === undefined
    ? Math.max(baseMax, Math.ceil(Math.sqrt(entries.length) * 10))
    : baseMax;
  const maxElements = Math.min(hardLimit, adaptiveMax);
  const nodes: TraversedNode[] = [];
  let skippedInvisible = 0;
  let skippedNoise = 0;
  let belowFoldCount = 0;
  let semanticCandidates = 0;
  let iframeCount = 0;
  let iframeSkippedAds = 0;

  for (const entry of entries) {
    const { el, context: entryContext } = entry;
    const tagName = el.tagName.toLowerCase();
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const iframe = tagName === 'iframe' ? iframeInfo(el, rect) : undefined;
    if (iframe) {
      iframeCount += 1;
      if (iframe.iframe_type === 'ad') {
        iframeSkippedAds += 1;
        skippedNoise += 1;
        continue;
      }
    }

    const visible = isElementVisible(el, style, rect);
    if (!visible) {
      skippedInvisible += 1;
      if (config.visible_only) continue;
    }

    const inViewport = rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    if (!inViewport) belowFoldCount += 1;

    const role = el.getAttribute('role');
    const textSource = ['input', 'select', 'textarea'].includes(tagName)
      ? undefined
      : directText(el) ?? normalizeText(el.innerText, 240);
    const label = accessibleLabel(el) ?? textSource;
    const shadow = shadowHosts.get(el);

    if (!isMeaningful(el, tagName, role, textSource, label, Boolean(shadow), Boolean(iframe))) {
      skippedNoise += 1;
      continue;
    }

    semanticCandidates += 1;
    if (nodes.length >= maxElements) continue;

    const id = getSemanticId(el, entryContext);
    const parent = el.parentElement?.closest(`[${semanticIdAttr}], [id]`);
    const parentId = parent instanceof HTMLElement ? getSemanticId(parent, entryContext) : entryContext.rootParentId;
    const attributes = extractAttributes(el, trackedAttributes);
    const ariaDisabled = el.getAttribute('aria-disabled') === 'true';
    const nativeDisabled =
      (el instanceof HTMLButtonElement ||
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLOptionElement) &&
      el.disabled;

    nodes.push(localDropUndefined({
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
      selector: selectorFor(el, id, entryContext),
      origin: entryContext.origin ?? 'main',
      context: localDropUndefined({
        type: entryContext.type ?? 'main',
        frame_url: entryContext.frameUrl,
        frame_name: entryContext.frameName,
        frame_depth: entryContext.frameDepth,
        shadow_host_id: entryContext.shadowHostId,
        shadow_mode: entryContext.shadowMode,
        parent_context_id: entryContext.rootParentId,
      }),
      iframe,
      shadow: shadow ? {
        has_shadow: true,
        host_id: shadow.hostId,
        mode: shadow.mode,
        content_count: shadow.contentCount,
      } : undefined,
      slot_for: tagName === 'slot' ? el.getAttribute('name') || 'default' : undefined,
      slotted_in: entryContext.slottedIn,
      boundingBox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        in_viewport: inViewport,
      },
      options: extractSelectOptions(el, normalizeText),
      form: extractForm(el, getSemanticId),
      table: extractTable(el, normalizeText),
      list: extractList(el, normalizeText),
    }));
  }

  const rawDomBytes = new TextEncoder().encode(rawDomWithShadow(entries)).length;

  return {
    nodes,
    stats: {
      dom_nodes_count: entries.length,
      semantic_nodes_count: nodes.length,
      semantic_nodes_total: semanticCandidates,
      skipped_invisible: skippedInvisible,
      skipped_noise: skippedNoise,
      below_fold_count: belowFoldCount,
      raw_dom_bytes: rawDomBytes,
      max_elements: maxElements,
      max_elements_requested: requestedMax,
      iframe_count: iframeCount,
      iframe_extracted_count: 0,
      iframe_skipped_ads: iframeSkippedAds,
      iframe_depth_limited: 0,
      shadow_root_count: shadowHosts.size,
      closed_shadow_roots: Array.from(shadowHosts.values()).filter((shadow) => shadow.mode === 'closed').length,
      max_frame_depth: Number(rootContext.frameDepth ?? 0),
    },
  };

  function isMeaningful(
    el: HTMLElement,
    tagName: string,
    role: string | null,
    text?: string,
    label?: string,
    hasShadow = false,
    hasIframe = false
  ): boolean {
    if (hasShadow || hasIframe) return true;
    if (actionTags.has(tagName) || semanticTags.has(tagName)) return true;
    if (role && usefulRoles.has(role)) return true;
    if (el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') return true;
    if (el.isContentEditable) return true;
    return Boolean(label || text);
  }

  function iframeInfo(el: HTMLElement, rect: DOMRect): TraversedNode['iframe'] {
    const src = el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('srcdoc') || undefined;
    const resolved = src && !el.getAttribute('srcdoc') ? safeUrl(src, location.href) : undefined;
    const classified = classifyFrameInPage(src, resolved, Math.round(rect.width), Math.round(rect.height), el);
    return localDropUndefined({
      src,
      url: resolved,
      name: el.getAttribute('name') || undefined,
      title: el.getAttribute('title') || el.getAttribute('aria-label') || undefined,
      iframe_type: classified.iframe_type,
      embed_type: classified.embed_type,
      same_origin: resolved ? sameOriginInPage(location.href, resolved) : true,
      accessible: classified.iframe_type !== 'ad' && classified.iframe_type !== 'payment' && classified.iframe_type !== 'captcha',
      status: classified.status,
      depth: Number(rootContext.frameDepth ?? 0) + 1,
      width: Math.round(rect.width) || undefined,
      height: Math.round(rect.height) || undefined,
      video_id: classified.video_id,
      map_query: classified.map_query,
      sandbox: el.getAttribute('sandbox') || undefined,
      loading: el.getAttribute('loading') || undefined,
      referrer_policy: el.getAttribute('referrerpolicy') || undefined,
    });
  }
}

function extractAttributes(el: HTMLElement, trackedAttributes: Set<string>): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (trackedAttributes.has(attr.name) || attr.name.startsWith('data-semantic-')) {
      attributes[attr.name] = attr.value;
    }
  }
  return attributes;
}

function extractSelectOptions(el: HTMLElement, normalizeText: (value: string | null | undefined, limit: number) => string | undefined) {
  if (!(el instanceof HTMLSelectElement)) return undefined;
  return Array.from(el.options)
    .slice(0, 50)
    .map((option) => ({
      value: option.value,
      label: normalizeText(option.label || option.textContent, 120) ?? option.value,
      selected: option.selected,
      disabled: option.disabled,
    }));
}

function extractForm(el: HTMLElement, getSemanticId: (el: HTMLElement) => string) {
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
}

function extractTable(el: HTMLElement, normalizeText: (value: string | null | undefined, limit: number) => string | undefined) {
  if (!(el instanceof HTMLTableElement)) return undefined;
  const rows = Array.from(el.rows).map((row) => Array.from(row.cells).map((cell) => normalizeText(cell.textContent, 120) ?? ''));
  const visibleRows = rows.length > 8 ? [...rows.slice(0, 5), ['...'], ...rows.slice(-3)] : rows;
  return {
    rows: visibleRows,
    row_count: rows.length,
    column_count: Math.max(0, ...rows.map((row) => row.length)),
    truncated: rows.length > visibleRows.length,
  };
}

function extractList(el: HTMLElement, normalizeText: (value: string | null | undefined, limit: number) => string | undefined) {
  if (!(el instanceof HTMLUListElement || el instanceof HTMLOListElement)) return undefined;
  const items = Array.from(el.querySelectorAll(':scope > li'))
    .map((item) => normalizeText(item.textContent, 160))
    .filter((item): item is string => Boolean(item));
  return {
    item_count: items.length,
    sample_items: items.slice(0, 8),
  };
}

function classifyFrameInPage(src: string | undefined, url: string | undefined, width?: number, height?: number, el?: Element): any {
  const attrs = el
    ? {
        'data-ad-client': el.getAttribute('data-ad-client'),
        'data-ad-slot': el.getAttribute('data-ad-slot'),
      }
    : {};
  return classifyFrame(src, url, width, height, attrs);
}

function safeUrl(value: string, base: string): string | undefined {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

function sameOriginInPage(parentUrl: string, childUrl: string): boolean {
  try {
    return new URL(parentUrl).origin === new URL(childUrl, parentUrl).origin;
  } catch {
    return false;
  }
}

function rawDomWithShadow(entries: Array<{ el: HTMLElement }>): string {
  const clone = document.documentElement?.cloneNode(true) as Element | undefined;
  for (const el of Array.from(clone?.querySelectorAll('[data-llm-browser-id]') ?? [])) {
    el.removeAttribute('data-llm-browser-id');
  }
  const shadowHtml = entries
    .map(({ el }) => {
      const root = el.shadowRoot ?? (window as any).__llmBrowserShadowRoots?.rootFor?.(el);
      return root ? `<shadow host="${el.id || el.tagName.toLowerCase()}">${root.innerHTML}</shadow>` : '';
    })
    .join('');
  return `${clone?.outerHTML ?? ''}${shadowHtml}`;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);
}

function dropUndefined<T extends Record<string, any>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
    if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) dropUndefined(value[key]);
  }
  return value;
}
