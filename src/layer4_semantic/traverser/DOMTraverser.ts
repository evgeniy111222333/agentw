import { Frame, Page } from 'playwright';
import { ScrollState } from '../../common/types';
import { ConfigurationManager } from '../../config/ConfigurationManager';

export interface TraversedNode {
  id: string;
  type?: 'cached';
  _hash?: string;
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
    visible_ratio?: number;
  };
  lazy?: {
    lazy: boolean;
    loaded: boolean;
    trigger: 'scroll_into_view' | 'native_lazy' | 'unknown';
    reason: string[];
  };
  options?: Array<{ value: string; label: string; selected: boolean; disabled: boolean; optgroup?: string }>;
  form?: {
    action?: string;
    method?: string;
    fields: string[];
    field_details?: Array<{
      id: string;
      name: string;
      type: string;
      label?: string;
      required: boolean;
      placeholder?: string;
    }>;
    field_values?: Record<string, any>;
    errors?: string[];
    is_dirty?: boolean;
    is_valid?: boolean;
    completion_percentage?: number;
    submit_button_id?: string;
    enctype?: string;
    autocomplete?: string;
  };
  table?: {
    caption?: string;
    columns?: Array<{ id: string; label: string; sortable?: boolean; type?: string }>;
    rows: string[][];
    row_count: number;
    column_count: number;
    truncated: boolean;
    sorted_by?: string;
    sort_direction?: 'asc' | 'desc';
    total_rows?: number;
    pagination?: { page?: number; per_page?: number; total_pages?: number };
  };
  list?: {
    item_count: number;
    sample_items: string[];
  };
  dom?: {
    id?: string;
    classes?: string[];
    child_element_count: number;
    depth: number;
    descendant_interactive_count: number;
    descendant_image_count: number;
    descendant_link_count: number;
    nearest_form_id?: string;
    previous_label?: string;
  };
  computed?: {
    display?: string;
    cursor?: string;
    font_weight?: number;
    font_size_px?: number;
    background_color?: string;
    border_radius_px?: number;
    padding_px?: number;
    gap_px?: number;
  };
  media?: {
    kind: 'image' | 'video' | 'audio' | 'chart' | 'svg' | 'canvas' | string;
    src?: string;
    current_src?: string;
    sources?: string[];
    alt?: string;
    width?: number;
    height?: number;
    natural_width?: number;
    natural_height?: number;
    format?: string;
    loading?: string;
    clickable?: boolean;
    decorative?: boolean;
    icon?: boolean;
    context?: string;
    duration?: number;
    controls?: boolean;
    poster?: string;
    tracks?: Array<{ kind?: string; label?: string; src?: string; srclang?: string }>;
    media_state?: Record<string, any>;
    chart_type?: string;
    data_summary?: string;
    title?: string;
    description?: string;
    text_nodes?: string[];
    view_box?: string;
    has_bitmap?: boolean;
    pixel_hash?: string;
    vlm_status?: string;
    ocr_status?: string;
  };
  component?: {
    kind: string;
    title?: string;
    subtitle?: string;
    image_id?: string;
    actions?: string[];
    items?: Array<Record<string, any>>;
    pages?: Array<Record<string, any>>;
    current?: number | string;
    total?: number;
    current_page?: number;
    total_pages?: number;
    has_next?: boolean;
    has_prev?: boolean;
    sections?: Array<Record<string, any>>;
    slides?: Array<Record<string, any>>;
    current_slide?: number;
    value?: number;
    max?: number;
    count?: number;
    steps?: Array<Record<string, any>>;
    nav_type?: string;
    tabs?: Array<Record<string, any>>;
    active_panel_id?: string;
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
    iframe_in_output_count: number;
    iframe_extracted_count: number;
    iframe_skipped_ads: number;
    iframe_depth_limited: number;
    shadow_root_count: number;
    closed_shadow_roots: number;
    max_frame_depth: number;
    scroll?: ScrollState;
  };
}

export interface TraverseOptions {
  maxElements?: number;
  previousHashes?: Record<string, string>;
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
      previousHashes: options.previousHashes,
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

  async traverseNode(page: Page, targetSelector: string): Promise<TraversalResult> {
    const semanticConfig = ConfigurationManager.getInstance().getConfig().semantic;
    const runtimeConfig = {
      ...semanticConfig,
      include_shadow_dom: semanticConfig.include_shadow_dom !== false,
      include_iframes: semanticConfig.include_iframes !== false,
      max_frame_depth: Math.max(0, Number(semanticConfig.max_frame_depth ?? 3)),
    };

    const mainFrame = page.mainFrame();
    const result = await mainFrame.evaluate(evaluateDom, {
      config: runtimeConfig,
      context: {
        type: 'main',
        origin: 'main',
        idPrefix: '',
        rootParentId: undefined,
        frameDepth: 0,
        targetSelector,
      },
    });
    
    return result;
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
    iframe_in_output_count: nodes.filter(n => n.iframe).length,
    iframe_extracted_count: total.iframe_extracted_count + (result === first ? 0 : 1),
    iframe_skipped_ads: total.iframe_skipped_ads + result.stats.iframe_skipped_ads,
    iframe_depth_limited: total.iframe_depth_limited + result.stats.iframe_depth_limited,
    shadow_root_count: total.shadow_root_count + result.stats.shadow_root_count,
    closed_shadow_roots: total.closed_shadow_roots + result.stats.closed_shadow_roots,
    max_frame_depth: Math.max(total.max_frame_depth, result.stats.max_frame_depth),
    scroll: total.scroll,
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
    iframe_in_output_count: 0,
    iframe_extracted_count: 0,
    iframe_skipped_ads: 0,
    iframe_depth_limited: 0,
    shadow_root_count: 0,
    closed_shadow_roots: 0,
    max_frame_depth: 0,
    scroll: first?.stats.scroll ?? emptyScrollState(),
  });

  stats.iframe_count = Math.max(stats.iframe_count, frameDescriptors.length);
  stats.iframe_depth_limited += frameDescriptors.filter((frame) => frame.status === 'depth_limited').length;

  return {
    nodes,
    stats,
  };
}

function emptyScrollState(): ScrollState {
  return {
    position: 0,
    left: 0,
    viewport_height: 0,
    viewport_width: 0,
    total_height: 0,
    total_width: 0,
    percentage: 0,
    horizontal_percentage: 0,
  };
}

async function describeFrame(frame: Frame, pageUrl: string, depth: number): Promise<FrameDescriptor> {
  const frameUrl = frame.url();
  const handle = await frame.frameElement().catch(() => undefined);
  const element = handle
    ? await handle.evaluate((el: Element) => {
        const semanticIdAttr = 'data-prism-id';
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
  // Auth/payment/captcha MUST be checked before content embeds —
  // a Google sign-in iframe with "youtube.com" in its continue= param
  // must be classified as 'auth', not as 'content/youtube'.
  if (/stripe\.com|paypal\.com|checkout|payment|braintree|adyen|klarna/.test(value)) {
    return { iframe_type: 'payment', status: 'metadata_only' };
  }
  if (/recaptcha|hcaptcha|captcha|arkoselabs/.test(value)) return { iframe_type: 'captcha', status: 'metadata_only' };
  if (/okta|auth0|login\.microsoftonline|accounts\.google|signin|sso/.test(value)) return { iframe_type: 'auth', status: 'metadata_only' };
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
  const semanticIdAttr = 'data-prism-id';
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
    // Auth/payment/captcha MUST be checked before content embeds —
    // a Google sign-in iframe with "youtube.com" in its continue= param
    // must be classified as 'auth', not as 'content/youtube'.
    if (/stripe\.com|paypal\.com|checkout|payment|braintree|adyen|klarna/.test(value)) return { iframe_type: 'payment', status: 'metadata_only' };
    if (/recaptcha|hcaptcha|captcha|arkoselabs/.test(value)) return { iframe_type: 'captcha', status: 'metadata_only' };
    if (/okta|auth0|login\.microsoftonline|accounts\.google|signin|sso/.test(value)) return { iframe_type: 'auth', status: 'metadata_only' };
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
    return { iframe_type: 'unknown', status: 'metadata_only' };
  };
  const extractAttributes = (el: HTMLElement, attrs: Set<string>): Record<string, string> => {
    const attributes: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      if (attrs.has(attr.name) || attr.name.startsWith('data-semantic-')) attributes[attr.name] = attr.value;
    }
    if (el instanceof HTMLInputElement) {
      if (el.value) attributes.value = el.value;
      if (el.checked) attributes.checked = 'true';
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value) attributes.value = el.value;
      attributes.rows = String(el.rows);
      attributes.cols = String(el.cols);
    } else if (el instanceof HTMLSelectElement) {
      attributes.value = el.value;
    }
    return attributes;
  };
  const extractSelectOptions = (el: HTMLElement, normalize: (value: string | null | undefined, limit: number) => string | undefined) => {
    if (!(el instanceof HTMLSelectElement)) return undefined;
    return Array.from(el.options)
      .slice(0, 50)
      .map((option) => {
        const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : undefined;
        return localDropUndefined({
          value: option.value,
          label: normalize(option.label || option.textContent, 120) ?? option.value,
          selected: option.selected,
          disabled: option.disabled || Boolean(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
          optgroup: normalize(group, 120),
        });
      });
  };
  const extractForm = (el: HTMLElement, ensureId: (el: HTMLElement) => string) => {
    if (!(el instanceof HTMLFormElement)) return undefined;
    const controls = Array.from(el.querySelectorAll('input, select, textarea'))
      .filter((field): field is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
        field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement
      );
    const fields = controls.map((field) => ensureId(field));

    // IMPROVED: Extract richer field metadata
    const fieldDetails: Array<{
      id: string;
      name: string;
      type: string;
      label?: string;
      required: boolean;
      placeholder?: string;
    }> = controls.map((field) => {
      const fieldId = ensureId(field);
      let label: string | undefined;
      // Try to find label
      if (field.id) {
        const labelEl = el.querySelector(`label[for="${field.id}"]`);
        if (labelEl) label = normalizeText(labelEl.textContent, 120);
      }
      if (!label && field instanceof HTMLInputElement) {
        const parentLabel = field.closest('label');
        if (parentLabel) label = normalizeText(parentLabel.textContent, 120);
      }
      return {
        id: fieldId,
        name: field.name || field.id || fieldId,
        type: field instanceof HTMLSelectElement ? 'select' :
              field instanceof HTMLTextAreaElement ? 'textarea' :
              (field as HTMLInputElement).type || 'text',
        label,
        required: field.required,
        placeholder: field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.placeholder : undefined,
      };
    });

    const fieldValues: Record<string, any> = {};
    const errors: string[] = [];
    let required = 0;
    let completed = 0;
    let dirty = false;
    for (const field of controls) {
      const key = field.name || field.id || ensureId(field);
      const value = formControlValue(field);
      fieldValues[key] = maskFormValue(field, value);
      if (field.required) {
        required += 1;
        if (field instanceof HTMLInputElement && ['checkbox', 'radio'].includes(field.type)) {
          if (field.checked) completed += 1;
        } else if (String(value ?? '').trim()) {
          completed += 1;
        }
      }
      const initial = field.getAttribute('data-llm-initial-value');
      if (initial !== null && String(value) !== initial) dirty = true;
      if (!field.validity.valid && field.validationMessage) errors.push(`${key}: ${field.validationMessage}`);
      if (field.getAttribute('aria-invalid') === 'true') errors.push(`${key}: invalid`);
      const visualError = field.closest('.error, .invalid, [aria-invalid="true"]') ||
        field.parentElement?.querySelector('.error, .invalid, .field-error, [role="alert"]');
      if (visualError instanceof HTMLElement) {
        const message = normalizeText(visualError.textContent, 180);
        if (message) errors.push(`${key}: ${message}`);
      }
    }

    // IMPROVED: Better submit button detection with role and text matching
    let submit = el.querySelector('button[type="submit"], input[type="submit"]');
    if (!submit) {
      // Try buttons with submit-related text
      const allButtons = el.querySelectorAll('button');
      for (const btn of allButtons) {
        const text = btn.textContent?.toLowerCase() ?? '';
        if (/submit|send|post|save|register|sign up|log in|login|create|apply|search/i.test(text)) {
          submit = btn;
          break;
        }
      }
    }
    if (!submit) {
      submit = el.querySelector('button:not([type])');
    }

    return {
      action: el.getAttribute('action') ?? undefined,
      method: (el.getAttribute('method') ?? 'GET').toUpperCase(),
      fields,
      field_details: fieldDetails,
      field_values: fieldValues,
      errors: Array.from(new Set(errors)).slice(0, 20),
      is_dirty: dirty,
      is_valid: errors.length === 0 && controls.every((field) => field.validity.valid),
      completion_percentage: required > 0 ? Math.round((completed / required) * 100) : 100,
      submit_button_id: submit instanceof HTMLElement ? ensureId(submit) : undefined,
      enctype: el.getAttribute('enctype') ?? undefined,
      autocomplete: el.getAttribute('autocomplete') ?? undefined,
    };
  };
  const formControlValue = (field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): any => {
    if (field instanceof HTMLInputElement && field.type === 'checkbox') return field.checked;
    if (field instanceof HTMLInputElement && field.type === 'radio') return field.checked ? field.value : false;
    if (field instanceof HTMLSelectElement && field.multiple) {
      return Array.from(field.selectedOptions).map((option) => option.value);
    }
    return field.value;
  };
  const maskFormValue = (field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: any): any => {
    if (field instanceof HTMLInputElement && ['password', 'hidden'].includes(field.type)) return value ? '[masked]' : value;
    return value;
  };
  const extractTable = (el: HTMLElement, normalize: (value: string | null | undefined, limit: number) => string | undefined) => {
    if (!(el instanceof HTMLTableElement)) return undefined;
    const rows = Array.from(el.rows).map((row) => Array.from(row.cells).map((cell) => normalize(cell.textContent, 120) ?? ''));
    const visibleRows = rows.length > 8 ? [...rows.slice(0, 5), ['...'], ...rows.slice(-3)] : rows;
    const headerCells = Array.from(el.tHead?.rows?.[0]?.cells ?? el.rows[0]?.cells ?? []);
    const columns = headerCells.map((cell, index) => {
      const text = normalize(cell.textContent, 120) ?? `Column ${index + 1}`;
      const ariaSort = cell.getAttribute('aria-sort');
      return localDropUndefined({
        id: cell.id || text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `col_${index + 1}`,
        label: text,
        sortable: cell.getAttribute('aria-sort') !== null || cell.querySelector('[aria-sort], button, a') !== null || /\bsort/.test(cell.className),
        type: inferColumnType(rows.slice(1).map((row) => row[index])),
        sorted: ariaSort && ariaSort !== 'none' ? ariaSort : undefined,
      });
    });
    const sorted = columns.find((column: any) => column.sorted);
    const page = numberFrom(el.getAttribute('data-page') ?? el.closest('[data-page]')?.getAttribute('data-page'));
    const perPage = numberFrom(el.getAttribute('data-per-page') ?? el.closest('[data-per-page]')?.getAttribute('data-per-page'));
    const totalPages = numberFrom(el.getAttribute('data-total-pages') ?? el.closest('[data-total-pages]')?.getAttribute('data-total-pages'));
    return {
      caption: normalize(el.caption?.textContent, 180),
      columns: columns.map(({ sorted, ...column }: any) => column),
      rows: visibleRows,
      row_count: rows.length,
      column_count: Math.max(0, ...rows.map((row) => row.length)),
      truncated: rows.length > visibleRows.length,
      sorted_by: sorted?.id,
      sort_direction: sorted?.sorted === 'descending' ? 'desc' : sorted?.sorted === 'ascending' ? 'asc' : undefined,
      total_rows: numberFrom(el.getAttribute('data-total-rows') ?? el.closest('[data-total-rows]')?.getAttribute('data-total-rows')) ?? rows.length,
      pagination: page || perPage || totalPages ? localDropUndefined({ page, per_page: perPage, total_pages: totalPages }) : undefined,
    } as TraversedNode['table'];
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
  const numberFrom = (value: string | null | undefined): number | undefined => {
    if (!value) return undefined;
    const parsed = Number(String(value).replace(/[^\d.-]+/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const inferColumnType = (values: string[]): string | undefined => {
    const sample = values.filter(Boolean).slice(0, 8);
    if (sample.length === 0) return undefined;
    if (sample.every((value) => /^[-+]?\$?\d[\d,]*(\.\d+)?%?$/.test(value.trim()))) return 'number';
    if (sample.every((value) => /^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(value.trim()))) return 'date';
    if (sample.every((value) => /^(true|false|yes|no|enabled|disabled)$/i.test(value.trim()))) return 'boolean';
    return 'text';
  };
  const rawDomWithShadow = (all: Array<{ el: HTMLElement }>): string => {
    const clone = document.documentElement?.cloneNode(true) as Element | undefined;
    for (const el of Array.from(clone?.querySelectorAll('[data-prism-id], [data-llm-browser-id]') ?? [])) {
      el.removeAttribute('data-prism-id');
      el.removeAttribute('data-llm-browser-id');
    }
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
    'aria-busy',
    'alt',
    'aria-checked',
    'aria-controls',
    'aria-current',
    'aria-describedby',
    'aria-disabled',
    'aria-expanded',
    'aria-haspopup',
    'aria-hidden',
    'aria-invalid',
    'aria-label',
    'aria-labelledby',
    'aria-modal',
    'aria-pressed',
    'aria-selected',
    'aria-valuemax',
    'aria-valuemin',
    'aria-valuenow',
    'aria-valuetext',
    'autocomplete',
    'class',
    'checked',
    'cols',
    'contenteditable',
    'controls',
    'data-ad-client',
    'data-ad-slot',
    'data-chart-data',
    'data-chart-type',
    'data-current',
    'data-max',
    'data-page',
    'data-per-page',
    'data-rating',
    'data-src',
    'data-subtitle',
    'data-testid',
    'data-title',
    'data-total',
    'data-total-pages',
    'data-total-rows',
    'disabled',
    'download',
    'enctype',
    'height',
    'href',
    'id',
    'kind',
    'label',
    'loading',
    'max',
    'maxlength',
    'method',
    'min',
    'multiple',
    'name',
    'open',
    'pattern',
    'placeholder',
    'poster',
    'readonly',
    'referrerpolicy',
    'rel',
    'required',
    'role',
    'rows',
    'sandbox',
    'slot',
    'src',
    'srcdoc',
    'srclang',
    'step',
    'tabindex',
    'target',
    'title',
    'type',
    'value',
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
  const cssNumber = (value: string | null | undefined): number | undefined => {
    if (!value) return undefined;
    const parsed = Number(String(value).replace(/[^\d.-]+/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const cssPixels = (value: string | null | undefined): number | undefined => {
    const parsed = cssNumber(value);
    return parsed === undefined ? undefined : Math.round(parsed);
  };
  const compactText = (value: string | undefined): string => (value ?? '').toLowerCase();
  const classSignal = (el: HTMLElement): string =>
    `${el.id} ${el.className} ${el.getAttribute('data-testid') ?? ''} ${el.getAttribute('data-title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
  const hasSignal = (el: HTMLElement, pattern: RegExp): boolean => pattern.test(classSignal(el));
  const isClickable = (el: HTMLElement, style?: CSSStyleDeclaration): boolean =>
    el instanceof HTMLButtonElement ||
    el instanceof HTMLAnchorElement ||
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement ||
    el.hasAttribute('onclick') ||
    el.getAttribute('role') === 'button' ||
    el.getAttribute('tabindex') === '0' ||
    style?.cursor === 'pointer';
  const computedInfo = (style: CSSStyleDeclaration): TraversedNode['computed'] => {
    const fontWeightValue = Number(style.fontWeight);
    return localDropUndefined({
      display: style.display,
      cursor: style.cursor,
      font_weight: Number.isFinite(fontWeightValue) ? fontWeightValue : /bold/i.test(style.fontWeight) ? 700 : undefined,
      font_size_px: cssPixels(style.fontSize),
      background_color: style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' ? style.backgroundColor : undefined,
      border_radius_px: cssPixels(style.borderTopLeftRadius),
      padding_px: Math.max(
        cssPixels(style.paddingTop) ?? 0,
        cssPixels(style.paddingRight) ?? 0,
        cssPixels(style.paddingBottom) ?? 0,
        cssPixels(style.paddingLeft) ?? 0
      ) || undefined,
      gap_px: cssPixels(style.gap),
    });
  };
  const descendantCount = (el: HTMLElement, selector: string): number => el.querySelectorAll(selector).length;
  const domInfo = (el: HTMLElement, entryContext: any): TraversedNode['dom'] => {
    const form = el.closest('form');
    const previousLabel = el.previousElementSibling instanceof HTMLLabelElement
      ? normalizeText(el.previousElementSibling.textContent, 160)
      : undefined;
    return localDropUndefined({
      id: el.id || undefined,
      classes: Array.from(el.classList).slice(0, 20),
      child_element_count: el.childElementCount,
      depth: Math.max(0, elPathDepth(el)),
      descendant_interactive_count: descendantCount(el, 'a, button, input, select, textarea, [role="button"], [tabindex="0"], [onclick]'),
      descendant_image_count: descendantCount(el, 'img, picture, svg, canvas, video'),
      descendant_link_count: descendantCount(el, 'a[href], [role="link"]'),
      nearest_form_id: form instanceof HTMLElement ? getSemanticId(form, entryContext) : undefined,
      previous_label: previousLabel,
    });
  };
  const elPathDepth = (el: HTMLElement): number => {
    let depth = 0;
    let current: HTMLElement | null = el.parentElement;
    while (current) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  };
  const fileFormat = (src: string | undefined): string | undefined => {
    if (!src) return undefined;
    const clean = src.split(/[?#]/)[0]?.toLowerCase() ?? '';
    const match = clean.match(/\.([a-z0-9]+)$/);
    return match?.[1];
  };
  const mediaTracks = (el: HTMLMediaElement): TraversedNode['media'] extends infer T
    ? T extends { tracks?: infer K } ? K : never
    : never => Array.from(el.querySelectorAll('track')).slice(0, 12).map((track) => localDropUndefined({
      kind: track.getAttribute('kind') || undefined,
      label: track.getAttribute('label') || undefined,
      src: track.getAttribute('src') || undefined,
      srclang: track.getAttribute('srclang') || undefined,
    }));
  const extractMedia = (
    el: HTMLElement,
    tagName: string,
    rect: DOMRect,
    style: CSSStyleDeclaration,
    text?: string,
    label?: string
  ): TraversedNode['media'] | undefined => {
    const contextText = normalizeText((el.closest('figure, article, section, li, div') as HTMLElement | null)?.innerText, 240);
    if (el instanceof HTMLImageElement) {
      const src = el.getAttribute('src') || el.currentSrc || undefined;
      const width = Math.round(rect.width || el.naturalWidth || Number(el.getAttribute('width')) || 0) || undefined;
      const height = Math.round(rect.height || el.naturalHeight || Number(el.getAttribute('height')) || 0) || undefined;
      const alt = normalizeText(el.getAttribute('alt'), 240);
      const decorative = el.getAttribute('role') === 'presentation' || el.getAttribute('aria-hidden') === 'true' || el.getAttribute('alt') === '';
      const icon = Boolean(width && height && width < 32 && height < 32);
      return localDropUndefined({
        kind: 'image',
        src,
        current_src: el.currentSrc || undefined,
        alt,
        width,
        height,
        natural_width: el.naturalWidth || undefined,
        natural_height: el.naturalHeight || undefined,
        format: fileFormat(src),
        loading: el.getAttribute('loading') || undefined,
        clickable: Boolean(el.closest('a, button') || isClickable(el, style)),
        decorative,
        icon,
        context: contextText,
        vlm_status: alt && !/^image|img|photo|picture$/i.test(alt) ? 'not_needed' : 'not_configured',
        ocr_status: 'not_configured',
      });
    }
    if (el instanceof HTMLVideoElement) {
      const src = el.currentSrc || el.getAttribute('src') || el.querySelector('source')?.getAttribute('src') || undefined;
      return localDropUndefined({
        kind: 'video',
        src,
        current_src: el.currentSrc || undefined,
        sources: Array.from(el.querySelectorAll('source')).map((source) => source.getAttribute('src') || '').filter(Boolean).slice(0, 8),
        width: Math.round(rect.width || el.videoWidth || Number(el.getAttribute('width')) || 0) || undefined,
        height: Math.round(rect.height || el.videoHeight || Number(el.getAttribute('height')) || 0) || undefined,
        duration: Number.isFinite(el.duration) ? Number(el.duration.toFixed(3)) : undefined,
        controls: el.controls,
        poster: el.getAttribute('poster') || undefined,
        tracks: mediaTracks(el),
        format: fileFormat(src),
        media_state: {
          current_time: Number(el.currentTime.toFixed(3)),
          paused: el.paused,
          ended: el.ended,
          muted: el.muted,
          volume: Number(el.volume.toFixed(2)),
          playback_rate: Number(el.playbackRate.toFixed(2)),
        },
        vlm_status: 'not_configured',
      });
    }
    if (el instanceof HTMLAudioElement) {
      const src = el.currentSrc || el.getAttribute('src') || el.querySelector('source')?.getAttribute('src') || undefined;
      return localDropUndefined({
        kind: 'audio',
        src,
        current_src: el.currentSrc || undefined,
        sources: Array.from(el.querySelectorAll('source')).map((source) => source.getAttribute('src') || '').filter(Boolean).slice(0, 8),
        duration: Number.isFinite(el.duration) ? Number(el.duration.toFixed(3)) : undefined,
        controls: el.controls,
        tracks: mediaTracks(el),
        format: fileFormat(src),
        media_state: {
          current_time: Number(el.currentTime.toFixed(3)),
          paused: el.paused,
          ended: el.ended,
          muted: el.muted,
          volume: Number(el.volume.toFixed(2)),
          playback_rate: Number(el.playbackRate.toFixed(2)),
        },
      });
    }
    if (tagName === 'canvas') {
      const chart = extractChartSummary(el, text, label);
      const width = Math.round(rect.width || Number(el.getAttribute('width')) || 0) || undefined;
      const height = Math.round(rect.height || Number(el.getAttribute('height')) || 0) || undefined;
      const decorative = !chart && (el.getAttribute('aria-hidden') === 'true' || hasSignal(el, /\b(background|particle|confetti|decorative)\b/));
      return localDropUndefined({
        kind: chart ? 'chart' : 'canvas',
        width,
        height,
        chart_type: chart?.chart_type,
        data_summary: chart?.data_summary,
        decorative,
        has_bitmap: Boolean(width && height),
        pixel_hash: fnv1a(`${width}x${height}:${el.getAttribute('data-chart-data') ?? ''}:${el.getAttribute('aria-label') ?? ''}`),
        vlm_status: chart ? 'not_needed' : 'not_configured',
        ocr_status: 'not_configured',
      });
    }
    if (tagName === 'svg') {
      const svg = el as unknown as SVGSVGElement;
      const width = Math.round(rect.width || Number(el.getAttribute('width')) || 0) || undefined;
      const height = Math.round(rect.height || Number(el.getAttribute('height')) || 0) || undefined;
      const title = normalizeText(el.querySelector('title')?.textContent, 240);
      const description = normalizeText(el.querySelector('desc')?.textContent, 320);
      const textNodes = Array.from(el.querySelectorAll('text'))
        .map((node) => normalizeText(node.textContent, 120))
        .filter((value): value is string => Boolean(value))
        .slice(0, 12);
      const chart = extractChartSummary(el, title ?? text, description ?? label);
      const icon = Boolean(width && height && width < 32 && height < 32 && !title && textNodes.length === 0);
      const decorative = el.getAttribute('role') === 'presentation' || el.getAttribute('aria-hidden') === 'true';
      return localDropUndefined({
        kind: chart ? 'chart' : 'svg',
        width,
        height,
        title,
        description,
        text_nodes: textNodes,
        view_box: svg.getAttribute('viewBox') || undefined,
        chart_type: chart?.chart_type,
        data_summary: chart?.data_summary,
        decorative,
        icon,
        vlm_status: title || description || textNodes.length > 0 ? 'not_needed' : 'not_configured',
        ocr_status: 'not_configured',
      });
    }
    return undefined;
  };
  const extractChartSummary = (el: HTMLElement, text?: string, label?: string): { chart_type?: string; data_summary?: string } | undefined => {
    const signal = `${classSignal(el)} ${el.getAttribute('data-chart-type') ?? ''} ${el.getAttribute('data-chart-data') ?? ''}`.toLowerCase();
    const chartLike = /\b(chart|graph|plot|sparkline|d3|chartjs|visualization|viz)\b/.test(signal);
    if (!chartLike && !el.getAttribute('data-chart-data') && !el.getAttribute('aria-label')) return undefined;
    const chartType = el.getAttribute('data-chart-type') || signal.match(/\b(line|bar|pie|area|scatter|sparkline|donut|heatmap)\b/)?.[1] || undefined;
    const rawData = el.getAttribute('data-chart-data') || el.getAttribute('aria-label') || el.getAttribute('title') || text || label;
    return localDropUndefined({
      chart_type: chartType,
      data_summary: normalizeText(rawData, 360) ?? (chartType ? `${chartType} chart` : 'Chart detected without readable data'),
    });
  };
  const mediaIsNoise = (media: TraversedNode['media'] | undefined, el: HTMLElement): boolean => {
    if (!media) return false;
    if (media.kind === 'chart' || media.kind === 'video' || media.kind === 'audio') return false;
    if (media.decorative) return true;
    if (media.icon && !el.closest('button, a, [role="button"]')) return true;
    return false;
  };
  const visibleRatio = (rect: DOMRect): number => {
    const area = Math.max(1, rect.width * rect.height);
    const x1 = Math.max(0, rect.left);
    const y1 = Math.max(0, rect.top);
    const x2 = Math.min(window.innerWidth, rect.right);
    const y2 = Math.min(window.innerHeight, rect.bottom);
    const visibleWidth = Math.max(0, x2 - x1);
    const visibleHeight = Math.max(0, y2 - y1);
    return Number(((visibleWidth * visibleHeight) / area).toFixed(4));
  };
  const lazyInfo = (el: HTMLElement, tagName: string, rect: DOMRect): TraversedNode['lazy'] | undefined => {
    const reasons: string[] = [];
    const hasDataSrc = el.hasAttribute('data-src') || el.hasAttribute('data-srcset') || el.hasAttribute('data-lazy-src');
    const nativeLazy = el.getAttribute('loading') === 'lazy';
    const placeholder = /\b(lazy|placeholder|blur|skeleton|unloaded)\b/i.test(`${el.className} ${el.getAttribute('src') ?? ''}`);
    const emptyBelowFold = rect.top > window.innerHeight && !normalizeText(el.textContent, 60) && el.childElementCount === 0;
    if (hasDataSrc) reasons.push('data_src');
    if (nativeLazy) reasons.push('native_loading_lazy');
    if (placeholder) reasons.push('placeholder');
    if (emptyBelowFold) reasons.push('empty_below_fold');
    if (reasons.length === 0) return undefined;
    const src = el.getAttribute('src') || '';
    return {
      lazy: true,
      loaded: Boolean(src && !hasDataSrc && !placeholder),
      trigger: nativeLazy ? 'native_lazy' : 'scroll_into_view',
      reason: reasons,
    };
  };
  const scrollState = (lazyNodes: TraversedNode[]): ScrollState => {
    const totalHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight);
    const totalWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, window.innerWidth);
    const maxScrollY = Math.max(1, totalHeight - window.innerHeight);
    const maxScrollX = Math.max(1, totalWidth - window.innerWidth);
    const sentinel = document.querySelector('[data-infinite-scroll], [data-testid*="sentinel"], .infinite-scroll-sentinel, .load-more-sentinel, [class*="sentinel"]') as HTMLElement | null;
    const hasPagination = Boolean(document.querySelector('[class*="pagination"], [aria-label*="pagination" i], nav[aria-label*="page" i]'));
    return {
      position: Math.round(window.scrollY),
      left: Math.round(window.scrollX),
      viewport_height: window.innerHeight,
      viewport_width: window.innerWidth,
      total_height: totalHeight,
      total_width: totalWidth,
      percentage: Number((window.scrollY / maxScrollY).toFixed(4)),
      horizontal_percentage: Number((window.scrollX / maxScrollX).toFixed(4)),
      lazy_count: lazyNodes.length,
      lazy_unloaded_count: lazyNodes.filter((node) => node.lazy?.loaded === false).length,
      infinite_scroll: sentinel || (!hasPagination && totalHeight > window.innerHeight * 2)
        ? {
            detected: true,
            sentinel_id: sentinel ? getSemanticId(sentinel) : undefined,
            reason: sentinel ? 'sentinel' : 'long_page_without_pagination',
          }
        : { detected: false },
    };
  };
  const extractComponent = (
    el: HTMLElement,
    tagName: string,
    role: string | null,
    text?: string,
    label?: string,
    media?: TraversedNode['media']
  ): TraversedNode['component'] | undefined => {
    if (hasSignal(el, /\b(skeleton|shimmer|placeholder-loading|loading-placeholder|react-loading-skeleton)\b/)) {
      return { kind: 'skeleton', title: label ?? text };
    }
    if (role === 'tablist' || hasSignal(el, /\b(tabs|tab-list|tablist|segmented-control)\b/)) {
      return localDropUndefined({
        kind: 'tab_group',
        tabs: Array.from(el.querySelectorAll('[role="tab"], button, a')).slice(0, 20).map((tab) => {
          const item = tab as HTMLElement;
          return localDropUndefined({
            id: getSemanticId(item),
            label: normalizeText(item.innerText || item.textContent, 120) ?? item.getAttribute('aria-label') ?? item.id,
            active: item.getAttribute('aria-selected') === 'true' || item.classList.contains('active'),
            controls: item.getAttribute('aria-controls') || undefined,
          });
        }),
        active_panel_id: el.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-controls') || undefined,
      });
    }
    if (isBreadcrumbElement(el, tagName, role)) return extractBreadcrumb(el);
    if (isPaginationElement(el)) return extractPagination(el);
    if (isAccordionElement(el, tagName)) return extractAccordion(el);
    if (isCarouselElement(el)) return extractCarousel(el);
    if (isRatingElement(el, text, label)) return extractRating(el, text, label);
    if (isStepperElement(el)) return extractStepper(el);
    if (media?.kind === 'chart' || hasSignal(el, /\b(chart|graph|plot|sparkline|visualization|viz)\b/)) {
      return localDropUndefined({
        kind: 'chart',
        title: label ?? text,
        items: media?.data_summary ? [{ data_summary: media.data_summary, chart_type: media.chart_type }] : undefined,
      });
    }
    if (role === 'menu' || role === 'menubar' || hasSignal(el, /\b(menu|dropdown-menu|context-menu|command-palette)\b/)) {
      return localDropUndefined({
        kind: 'menu',
        title: label ?? text,
        items: Array.from(el.querySelectorAll('[role="menuitem"], a, button')).slice(0, 30).map((item) => {
          const html = item as HTMLElement;
          return localDropUndefined({
            id: getSemanticId(html),
            label: normalizeText(html.innerText || html.textContent, 120) ?? html.getAttribute('aria-label') ?? html.id,
            disabled: html.getAttribute('aria-disabled') === 'true' || html.hasAttribute('disabled'),
          });
        }),
      });
    }
    if (tagName === 'dialog' || role === 'dialog' || hasSignal(el, /\b(modal|dialog|overlay|drawer|lightbox|popover|sheet)\b/)) {
      return localDropUndefined({
        kind: hasSignal(el, /\b(modal|overlay|drawer|lightbox)\b/) || el.getAttribute('aria-modal') === 'true' ? 'modal' : 'dialog',
        title: firstText(el, '[data-title], [aria-label], h1, h2, h3, .title, .modal-title, .dialog-title') ?? label ?? text,
        actions: childActionIds(el),
      });
    }
    if (hasSignal(el, /\b(badge|pill|tag|chip|status-label)\b/)) {
      return { kind: 'badge', title: label ?? text };
    }
    if (isCardElement(el, text, label)) return extractCard(el, text, label);
    if (tagName === 'nav') return extractNavigation(el, text, label);
    return undefined;
  };
  const isBreadcrumbElement = (el: HTMLElement, tagName: string, role: string | null): boolean =>
    tagName === 'nav' && /breadcrumb|crumb|trail/i.test(`${el.getAttribute('aria-label') ?? ''} ${el.className}`) ||
    role === 'navigation' && /breadcrumb|crumb|trail/i.test(`${el.getAttribute('aria-label') ?? ''} ${el.className}`) ||
    hasSignal(el, /\b(breadcrumb|breadcrumbs|crumbs|trail)\b/);
  const isPaginationElement = (el: HTMLElement): boolean =>
    hasSignal(el, /\b(pagination|pager|paginator|page-nav|pages)\b/) ||
    (descendantCount(el, 'a[href], button') >= 3 && /\b(next|prev|previous|page)\b/i.test(el.innerText || ''));
  const isAccordionElement = (el: HTMLElement, tagName: string): boolean =>
    tagName === 'details' || hasSignal(el, /\b(accordion|collapse|collapsible|disclosure|faq-item|expander)\b/) ||
    descendantCount(el, 'summary, [aria-expanded]') >= 2;
  const isCarouselElement = (el: HTMLElement): boolean =>
    hasSignal(el, /\b(carousel|slider|slideshow|swiper|glide|splide)\b/) ||
    descendantCount(el, '[aria-roledescription="slide"], .slide, [data-slide]') >= 2;
  const isRatingElement = (el: HTMLElement, text?: string, label?: string): boolean =>
    hasSignal(el, /\b(rating|stars|star-rating|review-score|score-stars)\b/) ||
    /[★☆]{2,}/.test(`${text ?? ''} ${label ?? ''}`) ||
    /\bout of 5\b/i.test(`${text ?? ''} ${label ?? ''} ${el.getAttribute('aria-label') ?? ''}`);
  const isStepperElement = (el: HTMLElement): boolean =>
    hasSignal(el, /\b(stepper|steps|wizard|progress-steps|timeline-steps)\b/) ||
    descendantCount(el, '[aria-current="step"], .step, [data-step]') >= 2;
  const isCardElement = (el: HTMLElement, text?: string, label?: string): boolean => {
    if (hasSignal(el, /\b(card|product-card|profile-card|news-card|article-card|tile|result-card|item-card|listing-item)\b/)) return true;
    const content = `${text ?? ''} ${label ?? ''} ${el.innerText ?? ''}`;
    return el.childElementCount >= 2 &&
      content.length > 20 &&
      (descendantCount(el, 'img, picture, svg, canvas') > 0 || descendantCount(el, 'a, button, [role="button"]') > 0) &&
      /(\$|€|£|₴|\bprice\b|\bproduct\b|\barticle\b|\bprofile\b|\bread more\b|\badd to cart\b)/i.test(content);
  };
  const firstText = (el: HTMLElement, selector: string): string | undefined => {
    const found = el.querySelector(selector) as HTMLElement | null;
    if (!found) return undefined;
    return normalizeText(found.getAttribute('data-title') || found.getAttribute('aria-label') || found.innerText || found.textContent, 180);
  };
  const childActionIds = (el: HTMLElement): string[] => Array.from(el.querySelectorAll('button, a[href], [role="button"], input[type="submit"]'))
    .filter((item): item is HTMLElement => item instanceof HTMLElement)
    .slice(0, 12)
    .map((item) => getSemanticId(item));
  const extractCard = (el: HTMLElement, text?: string, label?: string): TraversedNode['component'] => {
    const image = el.querySelector('img, picture, svg, canvas') as HTMLElement | null;
    return localDropUndefined({
      kind: 'card',
      title: el.getAttribute('data-title') || firstText(el, '[data-title], h1, h2, h3, h4, .title, .card-title, [class*="title"]') || label || text,
      subtitle: el.getAttribute('data-subtitle') || firstText(el, '[data-subtitle], .subtitle, .card-subtitle, .description, [class*="subtitle"]'),
      image_id: image ? getSemanticId(image) : undefined,
      actions: childActionIds(el),
    });
  };
  const extractPagination = (el: HTMLElement): TraversedNode['component'] => {
    const controls = Array.from(el.querySelectorAll('a[href], button, [aria-current], [data-page]'))
      .filter((item): item is HTMLElement => item instanceof HTMLElement)
      .slice(0, 50);
    const pages = controls.map((item) => {
      const textValue = normalizeText(item.innerText || item.textContent || item.getAttribute('aria-label'), 80);
      const pageNumber = numberFrom(item.getAttribute('data-page') || textValue);
      const current = item.getAttribute('aria-current') === 'page' || item.classList.contains('active') || item.classList.contains('current');
      return localDropUndefined({
        id: getSemanticId(item),
        label: textValue,
        page: pageNumber,
        url: item instanceof HTMLAnchorElement ? item.href : undefined,
        current,
        disabled: item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('disabled'),
      });
    });
    const numericPages = pages.map((page: any) => Number(page.page)).filter((page) => Number.isFinite(page));
    const currentPage = (pages.find((page: any) => page.current) as any)?.page ?? numberFrom(el.getAttribute('data-current'));
    const totalPages = numberFrom(el.getAttribute('data-total-pages')) ?? (numericPages.length ? Math.max(...numericPages) : undefined);
    return localDropUndefined({
      kind: 'pagination',
      pages,
      current: currentPage,
      total: totalPages,
      current_page: currentPage,
      total_pages: totalPages,
      has_next: controls.some((item) => /next|›|»/i.test(item.innerText || item.getAttribute('aria-label') || '')),
      has_prev: controls.some((item) => /prev|previous|‹|«/i.test(item.innerText || item.getAttribute('aria-label') || '')),
    });
  };
  const extractBreadcrumb = (el: HTMLElement): TraversedNode['component'] => {
    const items = Array.from(el.querySelectorAll('a[href], li, [aria-current]'))
      .filter((item): item is HTMLElement => item instanceof HTMLElement)
      .slice(0, 30)
      .map((item) => localDropUndefined({
        id: getSemanticId(item),
        label: normalizeText(item.innerText || item.textContent || item.getAttribute('aria-label'), 120),
        url: item instanceof HTMLAnchorElement ? item.href : undefined,
        active: item.getAttribute('aria-current') === 'page' || item.classList.contains('active'),
      }))
      .filter((item) => item.label || item.url);
    return { kind: 'breadcrumb', items };
  };
  const extractAccordion = (el: HTMLElement): TraversedNode['component'] => {
    const details = Array.from(el.matches('details') ? [el] : el.querySelectorAll('details, [aria-expanded]'))
      .filter((item): item is HTMLElement => item instanceof HTMLElement)
      .slice(0, 30);
    const sections = details.map((item) => localDropUndefined({
      id: getSemanticId(item),
      title: firstText(item, 'summary, button, [class*="title"], [class*="header"]') || normalizeText(item.getAttribute('aria-label'), 120),
      expanded: item instanceof HTMLDetailsElement ? item.open : item.getAttribute('aria-expanded') === 'true',
      content_element_id: getSemanticId(item),
    }));
    return localDropUndefined({ kind: 'accordion', sections });
  };
  const extractCarousel = (el: HTMLElement): TraversedNode['component'] => {
    const slides = Array.from(el.querySelectorAll('[aria-roledescription="slide"], .slide, [data-slide], [role="group"]'))
      .filter((item): item is HTMLElement => item instanceof HTMLElement)
      .slice(0, 30)
      .map((item, index) => localDropUndefined({
        id: getSemanticId(item),
        index,
        label: normalizeText(item.getAttribute('aria-label') || item.innerText || item.textContent, 160),
        active: item.getAttribute('aria-hidden') === 'false' || item.classList.contains('active') || item.getAttribute('data-active') === 'true',
      }));
    return localDropUndefined({
      kind: 'carousel',
      slides,
      current_slide: slides.find((slide: any) => slide.active)?.index ?? numberFrom(el.getAttribute('data-current-slide')),
      actions: childActionIds(el),
    });
  };
  const extractRating = (el: HTMLElement, text?: string, label?: string): TraversedNode['component'] => {
    const source = `${el.getAttribute('aria-label') ?? ''} ${text ?? ''} ${label ?? ''}`;
    const value = numberFrom(el.getAttribute('data-rating') || el.getAttribute('aria-valuenow')) ??
      numberFrom(source.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:out of|\/)\s*([0-9]+)/i)?.[1]) ??
      ((source.match(/★/g) ?? []).length || undefined);
    const max = numberFrom(el.getAttribute('data-max') || el.getAttribute('aria-valuemax')) ??
      numberFrom(source.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:out of|\/)\s*([0-9]+)/i)?.[2]) ??
      (/[★☆]/.test(source) ? 5 : undefined);
    return localDropUndefined({
      kind: 'rating',
      title: label ?? text,
      value,
      max,
      count: numberFrom(el.getAttribute('data-count') || source.match(/([0-9,]+)\s*(reviews?|ratings?)/i)?.[1]),
    });
  };
  const extractStepper = (el: HTMLElement): TraversedNode['component'] => {
    const steps = Array.from(el.querySelectorAll('[aria-current="step"], .step, [data-step], li'))
      .filter((item): item is HTMLElement => item instanceof HTMLElement)
      .slice(0, 40)
      .map((item, index) => {
        const current = item.getAttribute('aria-current') === 'step' || item.classList.contains('active') || item.classList.contains('current');
        return localDropUndefined({
          id: getSemanticId(item),
          index: numberFrom(item.getAttribute('data-step')) ?? index + 1,
          label: normalizeText(item.innerText || item.textContent || item.getAttribute('aria-label'), 120),
          current,
          completed: item.classList.contains('done') || item.classList.contains('complete') || item.getAttribute('data-complete') === 'true',
        });
      });
    return localDropUndefined({
      kind: 'stepper',
      steps,
      current: (steps.find((step: any) => step.current) as any)?.index,
      total: steps.length || undefined,
    });
  };
  const extractNavigation = (el: HTMLElement, text?: string, label?: string): TraversedNode['component'] => {
    const items = Array.from(el.querySelectorAll('a[href], button'))
      .filter((item): item is HTMLElement => item instanceof HTMLElement)
      .slice(0, 50)
      .map((item) => localDropUndefined({
        id: getSemanticId(item),
        label: normalizeText(item.innerText || item.textContent || item.getAttribute('aria-label'), 120),
        url: item instanceof HTMLAnchorElement ? item.href : undefined,
        active: item.getAttribute('aria-current') === 'page' || item.classList.contains('active'),
        icon: Boolean(item.querySelector('svg, img')),
      }));
    const signal = classSignal(el);
    const navType = /footer/.test(signal) ? 'footer' : /sidebar|side-nav/.test(signal) ? 'sidebar' : /pagination|pager/.test(signal) ? 'pagination' : 'main';
    return localDropUndefined({ kind: 'navigation', title: label ?? text, nav_type: navType, items });
  };

  const fnv1a = (str: string): string => {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  };

  const actionTags = new Set(['a', 'area', 'button', 'details', 'form', 'input', 'label', 'option', 'select', 'summary', 'textarea']);
  const semanticTags = new Set([
    'article',
    'aside',
    'audio',
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
    'alertdialog',
    'article',
    'button',
    'checkbox',
    'combobox',
    'dialog',
    'grid',
    'img',
    'link',
    'list',
    'listitem',
    'listbox',
    'log',
    'menu',
    'menubar',
    'menuitem',
    'navigation',
    'option',
    'progressbar',
    'radio',
    'searchbox',
    'separator',
    'slider',
    'status',
    'switch',
    'tab',
    'tablist',
    'tabpanel',
    'textbox',
    'tooltip',
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
      if (!(child instanceof HTMLElement) && !(child instanceof SVGElement)) continue;
      const element = child as HTMLElement;
      const slotted = entryContext.lightShadowHostId && element.getAttribute('slot')
        ? `shadow:${entryContext.lightShadowHostId}#slot:${element.getAttribute('slot') || 'default'}`
        : entryContext.slottedIn;
      const childContext = { ...entryContext, slottedIn: slotted };
      entries.push({ el: element, context: childContext });

      let shadowHostId: string | undefined;
      const shadow = shadowRootFor(element);
      if (shadow) {
        shadowHostId = getSemanticId(element, childContext);
        shadowHosts.set(element, {
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

  if (rootContext.targetSelector) {
    const targetEl =
      document.querySelector(`[data-prism-id="${rootContext.targetSelector}"]`) ||
      document.querySelector(`[data-llm-browser-id="${rootContext.targetSelector}"]`) ||
      document.querySelector(rootContext.targetSelector);
    if (targetEl && targetEl.parentNode) {
      // Walk the target element itself by passing its parent and filtering in the walk,
      // or just add it to entries. For simplicity, if we have a target, we just want it and its subtree.
      entries.push({ el: targetEl as HTMLElement, context: rootContext });
      walk(targetEl, rootContext);
    }
  } else {
    walk(document.body ?? document.documentElement, rootContext);
  }

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
  const lazyNodes: TraversedNode[] = [];

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
      const importantIframe = iframe && ['auth', 'payment', 'captcha', 'content'].includes(iframe.iframe_type);
      if (config.visible_only && !importantIframe) continue;
    }

    const inViewport = rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    if (!inViewport) belowFoldCount += 1;
    const ratio = visibleRatio(rect);

    const role = el.getAttribute('role');
    const textSource = ['input', 'select', 'textarea'].includes(tagName)
      ? undefined
      : directText(el) ?? normalizeText((el as any).innerText ?? el.textContent, 240);
    const label = accessibleLabel(el) ?? textSource;
    const shadow = shadowHosts.get(el);
    const media = extractMedia(el, tagName, rect, style, textSource, label);
    const lazy = lazyInfo(el, tagName, rect);
    if (mediaIsNoise(media, el)) {
      skippedNoise += 1;
      continue;
    }
    const component = extractComponent(el, tagName, role, textSource, label, media);

    if (!isMeaningful(el, tagName, role, textSource, label, Boolean(shadow), Boolean(iframe), media, component, entryContext.type === 'shadow')) {
      skippedNoise += 1;
      continue;
    }

    semanticCandidates += 1;
    // v3: Elements inside shadow roots (entryContext.type === 'shadow') should also
    // be high priority so they survive the maxElements cap. Previously only shadow
    // HOST elements were high priority, but shadow CONTENT elements were not.
    // IMPROVED: Also prioritize form-related elements, critical interactive elements,
    // and elements in viewport
    const isFormElement = tagName === 'form' || tagName === 'input' || tagName === 'select' ||
                          tagName === 'textarea' || tagName === 'button';
    const isImportantInteractive = role && ['button', 'link', 'checkbox', 'radio', 'textbox', 'combobox'].includes(role);
    // IMPROVED: Prioritize viewport elements - elements partially or fully visible are more important
    const isInViewport = rect.top <= window.innerHeight && rect.left <= window.innerWidth && rect.bottom >= 0 && rect.right >= 0;
    const isHighPriority = Boolean(iframe) || Boolean(shadow) || entryContext.type === 'shadow' ||
                          isFormElement || isImportantInteractive || (inViewport && visible);
    if (nodes.length >= maxElements && !isHighPriority) continue;

    const id = getSemanticId(el, entryContext);

    // Concept §3.7.1 Incremental Extraction (FNV-1a Hash)
    let attrsStr = '';
    for (let i = 0; i < el.attributes.length; i++) {
      attrsStr += `${el.attributes[i].name}=${el.attributes[i].value};`;
    }
    const textSample = (el.textContent || '').substring(0, 100);
    const hashStr = `${tagName}|${el.childElementCount}|${textSample}|${attrsStr}`;
    const _hash = fnv1a(hashStr);

    if (config.previousHashes?.[id] === _hash) {
      nodes.push({ id, tagName, type: 'cached', _hash } as any);
      continue;
    }

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

    const node = localDropUndefined({
      id,
      _hash,
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
        visible_ratio: ratio,
      },
      lazy,
      options: extractSelectOptions(el, normalizeText),
      form: extractForm(el, getSemanticId),
      table: extractTable(el, normalizeText),
      list: extractList(el, normalizeText),
      dom: domInfo(el, entryContext),
      computed: computedInfo(style),
      media,
      component,
    });
    if (node.lazy) lazyNodes.push(node);
    nodes.push(node);
  }

  // Prioritize iframe and shadow_host nodes so they survive the maxElements cap
  // applied by mergeResults. Without this, iframes at the end of DOM get cut.
  nodes.sort((a, b) => {
    const aPriority = (a.iframe || a.shadow) ? 0 : 1;
    const bPriority = (b.iframe || b.shadow) ? 0 : 1;
    return aPriority - bPriority;
  });

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
      iframe_in_output_count: nodes.filter(n => n.iframe).length,
      iframe_extracted_count: 0,
      iframe_skipped_ads: iframeSkippedAds,
      iframe_depth_limited: 0,
      shadow_root_count: shadowHosts.size,
      closed_shadow_roots: Array.from(shadowHosts.values()).filter((shadow) => shadow.mode === 'closed').length,
      max_frame_depth: Number(rootContext.frameDepth ?? 0),
      scroll: scrollState(lazyNodes),
    },
  };

  function isMeaningful(
    el: HTMLElement,
    tagName: string,
    role: string | null,
    text?: string,
    label?: string,
    hasShadow = false,
    hasIframe = false,
    media?: TraversedNode['media'],
    component?: TraversedNode['component'],
    isInsideShadow = false
  ): boolean {
    // v3: Elements inside shadow roots are always meaningful — they represent
    // content that would otherwise be invisible to the LLM agent.
    if (isInsideShadow) return true;
    if (hasShadow || hasIframe) return true;
    if (component || media) return true;
    if (actionTags.has(tagName) || semanticTags.has(tagName)) return true;
    if (role && usefulRoles.has(role)) return true;
    if (el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') return true;
    if (el.isContentEditable) return true;
    if (hasSignal(el, /\b(card|pagination|pager|breadcrumb|accordion|collapse|carousel|rating|stepper|skeleton|chart|graph|modal|dialog|badge|tooltip|tabs)\b/)) return true;
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
  for (const el of Array.from(clone?.querySelectorAll('[data-prism-id], [data-llm-browser-id]') ?? [])) {
    el.removeAttribute('data-prism-id');
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
