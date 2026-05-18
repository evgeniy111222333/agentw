import { ElementType } from '../../common/types';
import { TraversedNode } from '../traverser/DOMTraverser';

export class ContentExtractor {
  extract(node: TraversedNode, type: ElementType): Record<string, any> {
    const content: Record<string, any> = {
      visible: node.visible,
      disabled: node.disabled,
      origin: node.origin,
    };

    if (node.label) content.label = node.label;
    if (node.parentId) content.parent_id = node.parentId;
    if (node.required) content.required = true;
    if (node.context) content.context = node.context;
    if (node.slot_for) content.slot_for = node.slot_for;
    if (node.slotted_in) content.slotted_in = node.slotted_in;
    if (node.dom) content.dom = node.dom;

    if (TEXT_TYPES.has(type) && node.text) content.text = node.text;

    if (type === 'link') this.extractLink(node, content);
    if (type === 'button' || type === 'menu_item') this.extractButton(node, content);
    if (type === 'input' || type === 'textarea') this.extractInput(node, type, content);
    if (type === 'select') this.extractSelect(node, content);
    if (type === 'form') this.extractForm(node, content);
    if (type === 'image') this.extractImage(node, content);
    if (type === 'video') this.extractVideo(node, content);
    if (type === 'audio') this.extractAudio(node, content);
    if (type === 'chart') this.extractChart(node, content);
    if (type === 'iframe' || type === 'embed') this.extractFrame(node, content);
    if (type === 'shadow_host') content.shadow = node.shadow;
    if (type === 'heading') content.level = Number(node.tagName.replace('h', '')) || inferHeadingLevel(node);
    if (type === 'table') this.extractTable(node, content);
    if (type === 'list') this.extractList(node, content);
    if (type === 'progress') this.extractProgress(node, content);
    if (type === 'navigation') this.extractNavigation(node, content);
    if (type === 'tab_group') this.extractTabGroup(node, content);
    if (type === 'card') this.extractCard(node, content);
    if (type === 'pagination') this.extractPagination(node, content);
    if (type === 'breadcrumb') this.extractBreadcrumb(node, content);
    if (type === 'accordion') this.extractAccordion(node, content);
    if (type === 'carousel') this.extractCarousel(node, content);
    if (type === 'rating') this.extractRating(node, content);
    if (type === 'stepper') this.extractStepper(node, content);
    if (type === 'skeleton') content.loading = true;
    if (type === 'modal' || type === 'dialog' || type === 'menu' || type === 'badge' || type === 'tooltip') this.extractComponent(node, content);

    if (node.boundingBox?.in_viewport === false) content.in_viewport = false;
    if (node.boundingBox?.visible_ratio !== undefined) content.visible_ratio = node.boundingBox.visible_ratio;
    if (node.lazy) content.lazy = node.lazy;

    return dropUndefined(content);
  }

  private extractLink(node: TraversedNode, content: Record<string, any>): void {
    content.url = node.attributes.href;
    content.target = node.attributes.target;
    content.rel = node.attributes.rel;
    content.download = node.attributes.download;
    content.external = isExternalLink(node.attributes.href, node.attributes.target);
    content.visited = parseBooleanState(node.attributes['data-visited']);
    content.icon = Boolean(node.dom?.descendant_image_count);
  }

  private extractButton(node: TraversedNode, content: Record<string, any>): void {
    content.pressed = parseBooleanState(node.attributes['aria-pressed']);
    content.expanded = parseBooleanState(node.attributes['aria-expanded']);
    content.variant = inferButtonVariant(node);
    content.destructive = isDestructive(node);
    content.loading = node.attributes['aria-busy'] === 'true' || /loading|spinner|busy/.test(classBlob(node));
    content.tooltip = node.attributes.title || node.attributes['aria-describedby'];
    content.icon = Boolean(node.dom?.descendant_image_count || /icon|svg/.test(classBlob(node)));
  }

  private extractInput(node: TraversedNode, type: ElementType, content: Record<string, any>): void {
    const inputType = type === 'textarea' ? 'textarea' : node.attributes.type || inferInputTypeFromRole(node.role);
    content.input_type = inputType;
    content.name = node.attributes.name;
    content.placeholder = node.attributes.placeholder;
    content.value = maskSensitiveValue(inputType, node.attributes.value);
    content.checked = parseBooleanState(node.attributes.checked ?? node.attributes['aria-checked']);
    content.autocomplete = node.attributes.autocomplete;
    content.pattern = node.attributes.pattern;
    content.min = numericOrString(node.attributes.min);
    content.max = numericOrString(node.attributes.max);
    content.step = numericOrString(node.attributes.step);
    content.accept = node.attributes.accept;
    content.maxlength = numberOrUndefined(node.attributes.maxlength);
    content.readonly = node.attributes.readonly !== undefined;
    content.validation_error = validationError(node);
    content.group_id = ['radio', 'checkbox'].includes(inputType) ? node.attributes.name : undefined;
    content.rows = type === 'textarea' ? numberOrUndefined(node.attributes.rows) : undefined;
    content.cols = type === 'textarea' ? numberOrUndefined(node.attributes.cols) : undefined;
  }

  private extractSelect(node: TraversedNode, content: Record<string, any>): void {
    content.name = node.attributes.name;
    content.value = node.attributes.value;
    content.options = node.options ?? [];
    content.optgroups = Array.from(new Set((node.options ?? []).map((option) => option.optgroup).filter(Boolean)));
    content.multiple = node.attributes.multiple !== undefined;
    content.required = node.required || undefined;
    content.disabled = node.disabled;
    content.validation_error = validationError(node);
  }

  private extractForm(node: TraversedNode, content: Record<string, any>): void {
    content.action = node.form?.action;
    content.method = node.form?.method ?? 'GET';
    content.fields = node.form?.fields ?? [];
    content.field_values = node.form?.field_values;
    content.errors = node.form?.errors ?? [];
    content.is_dirty = node.form?.is_dirty;
    content.is_valid = node.form?.is_valid;
    content.completion_percentage = node.form?.completion_percentage;
    content.submit_button_id = node.form?.submit_button_id;
    content.enctype = node.form?.enctype;
    content.autocomplete = node.form?.autocomplete;
  }

  private extractImage(node: TraversedNode, content: Record<string, any>): void {
    const media = node.media;
    content.src = media?.src ?? node.attributes.src;
    content.current_src = media?.current_src;
    content.alt = media?.alt ?? node.attributes.alt ?? node.label;
    content.width = media?.width ?? numberOrUndefined(node.attributes.width);
    content.height = media?.height ?? numberOrUndefined(node.attributes.height);
    content.natural_width = media?.natural_width;
    content.natural_height = media?.natural_height;
    content.format = media?.format;
    content.loading = media?.loading ?? node.attributes.loading;
    content.clickable = media?.clickable;
    content.decorative = media?.decorative;
    content.icon = media?.icon;
    content.context_text = media?.context;
    content.generated_description = content.alt ? undefined : imageDescriptionFromContext(node);
    content.vlm_status = media?.vlm_status;
    content.ocr_status = media?.ocr_status;
    content.svg = media?.kind === 'svg' ? {
      title: media.title,
      description: media.description,
      text_nodes: media.text_nodes,
      view_box: media.view_box,
    } : undefined;
  }

  private extractVideo(node: TraversedNode, content: Record<string, any>): void {
    const media = node.media;
    content.src = media?.src ?? node.attributes.src;
    content.current_src = media?.current_src;
    content.sources = media?.sources;
    content.duration = media?.duration;
    content.controls = media?.controls ?? node.attributes.controls !== undefined;
    content.poster = media?.poster ?? node.attributes.poster;
    content.tracks = media?.tracks;
    content.format = media?.format;
    content.media_state = media?.media_state;
    content.vlm_status = media?.vlm_status;
  }

  private extractAudio(node: TraversedNode, content: Record<string, any>): void {
    const media = node.media;
    content.src = media?.src ?? node.attributes.src;
    content.current_src = media?.current_src;
    content.sources = media?.sources;
    content.duration = media?.duration;
    content.controls = media?.controls ?? node.attributes.controls !== undefined;
    content.tracks = media?.tracks;
    content.format = media?.format;
    content.media_state = media?.media_state;
  }

  private extractChart(node: TraversedNode, content: Record<string, any>): void {
    const media = node.media;
    content.chart_type = media?.chart_type ?? node.attributes['data-chart-type'];
    content.data_summary = media?.data_summary ?? node.attributes['data-chart-data'] ?? node.label ?? node.text;
    content.width = media?.width ?? numberOrUndefined(node.attributes.width);
    content.height = media?.height ?? numberOrUndefined(node.attributes.height);
    content.source_element = node.id;
    content.pixel_hash = media?.pixel_hash;
    content.has_bitmap = media?.has_bitmap;
    content.vlm_status = media?.vlm_status;
    content.ocr_status = media?.ocr_status;
  }

  private extractFrame(node: TraversedNode, content: Record<string, any>): void {
    content.src = node.iframe?.src ?? node.attributes.src;
    content.url = node.iframe?.url ?? node.attributes.src;
    content.iframe_type = node.iframe?.iframe_type;
    content.embed_type = node.iframe?.embed_type;
    content.same_origin = node.iframe?.same_origin;
    content.accessible = node.iframe?.accessible;
    content.status = node.iframe?.status;
    content.depth = node.iframe?.depth;
    content.video_id = node.iframe?.video_id;
    content.map_query = node.iframe?.map_query;
    content.sandbox = node.iframe?.sandbox;
    content.loading = node.iframe?.loading;
    content.referrer_policy = node.iframe?.referrer_policy;
    content.width = node.iframe?.width;
    content.height = node.iframe?.height;
    if (node.iframe?.iframe_type === 'payment') {
      content.available_actions = [{ action: 'interact', description: 'Payment form requires secure user interaction' }];
    } else if (node.iframe?.iframe_type === 'captcha') {
      content.available_actions = [{ action: 'interact', description: 'CAPTCHA challenge requires user interaction' }];
    } else if (node.iframe?.iframe_type === 'auth') {
      content.available_actions = [{ action: 'interact', description: 'Authentication iframe requires sign-in flow' }];
    } else if (node.iframe?.embed_type === 'youtube' || node.iframe?.embed_type === 'vimeo') {
      content.available_actions = [{ action: 'interact', description: 'Embedded video player' }];
    }
  }

  private extractTable(node: TraversedNode, content: Record<string, any>): void {
    content.caption = node.table?.caption;
    content.columns = node.table?.columns ?? [];
    content.rows = node.table?.rows ?? [];
    content.row_count = node.table?.row_count ?? 0;
    content.column_count = node.table?.column_count ?? 0;
    content.truncated = node.table?.truncated ?? false;
    content.sorted_by = node.table?.sorted_by;
    content.sort_direction = node.table?.sort_direction;
    content.total_rows = node.table?.total_rows ?? node.table?.row_count;
    content.pagination = node.table?.pagination;
  }

  private extractList(node: TraversedNode, content: Record<string, any>): void {
    content.item_count = node.list?.item_count ?? 0;
    content.sample_items = node.list?.sample_items ?? [];
  }

  private extractProgress(node: TraversedNode, content: Record<string, any>): void {
    content.value = numberOrUndefined(node.attributes.value ?? node.attributes['aria-valuenow']);
    content.min = numberOrUndefined(node.attributes.min ?? node.attributes['aria-valuemin']);
    content.max = numberOrUndefined(node.attributes.max ?? node.attributes['aria-valuemax']);
    content.text = node.attributes['aria-valuetext'] ?? content.text;
  }

  private extractNavigation(node: TraversedNode, content: Record<string, any>): void {
    content.nav_type = node.component?.nav_type;
    content.items = node.component?.items;
  }

  private extractTabGroup(node: TraversedNode, content: Record<string, any>): void {
    content.tabs = node.component?.tabs ?? [];
    content.active_panel_id = node.component?.active_panel_id;
  }

  private extractCard(node: TraversedNode, content: Record<string, any>): void {
    content.title = node.component?.title ?? node.label ?? node.text;
    content.subtitle = node.component?.subtitle;
    content.image_id = node.component?.image_id;
    content.actions = node.component?.actions ?? [];
  }

  private extractPagination(node: TraversedNode, content: Record<string, any>): void {
    content.current = node.component?.current;
    content.total = node.component?.total;
    content.current_page = node.component?.current_page;
    content.total_pages = node.component?.total_pages;
    content.pages = node.component?.pages ?? node.component?.items ?? [];
    content.has_next = node.component?.has_next;
    content.has_prev = node.component?.has_prev;
  }

  private extractBreadcrumb(node: TraversedNode, content: Record<string, any>): void {
    content.items = node.component?.items ?? [];
  }

  private extractAccordion(node: TraversedNode, content: Record<string, any>): void {
    content.sections = node.component?.sections ?? [];
    content.expanded = (node.component?.sections ?? []).some((section) => section.expanded);
  }

  private extractCarousel(node: TraversedNode, content: Record<string, any>): void {
    content.slides = node.component?.slides ?? [];
    content.current_slide = node.component?.current_slide;
    content.actions = node.component?.actions ?? [];
  }

  private extractRating(node: TraversedNode, content: Record<string, any>): void {
    content.value = node.component?.value;
    content.max = node.component?.max;
    content.count = node.component?.count;
  }

  private extractStepper(node: TraversedNode, content: Record<string, any>): void {
    content.steps = node.component?.steps ?? [];
    content.current = node.component?.current;
    content.total = node.component?.total;
  }

  private extractComponent(node: TraversedNode, content: Record<string, any>): void {
    content.title = node.component?.title ?? node.label ?? node.text;
    content.items = node.component?.items;
    content.actions = node.component?.actions;
  }
}

const TEXT_TYPES = new Set<ElementType>([
  'heading',
  'text',
  'button',
  'link',
  'badge',
  'notification',
  'menu_item',
  'card',
  'dialog',
  'modal',
  'tooltip',
  'skeleton',
]);

function parseBooleanState(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function inferInputTypeFromRole(role: string | undefined): string {
  if (role === 'checkbox' || role === 'switch') return 'checkbox';
  if (role === 'radio') return 'radio';
  if (role === 'searchbox') return 'search';
  return 'text';
}

function maskSensitiveValue(inputType: string, value: string | undefined): string | undefined {
  if (!value) return value;
  if (['password', 'hidden'].includes(inputType)) return '[masked]';
  return value;
}

function validationError(node: TraversedNode): string | undefined {
  if (node.attributes['aria-invalid'] === 'true') {
    return node.attributes['aria-describedby'] || 'invalid';
  }
  return undefined;
}

function inferButtonVariant(node: TraversedNode): string | undefined {
  const blob = classBlob(node);
  if (/\b(primary|btn-primary|button-primary)\b/.test(blob)) return 'primary';
  if (/\b(secondary|btn-secondary|button-secondary)\b/.test(blob)) return 'secondary';
  if (/\b(danger|destructive|delete|remove|btn-danger)\b/.test(blob)) return 'danger';
  if (/\b(ghost|tertiary|link-button)\b/.test(blob)) return 'ghost';
  return undefined;
}

function isDestructive(node: TraversedNode): boolean | undefined {
  const value = `${classBlob(node)} ${node.text ?? ''} ${node.label ?? ''}`.toLowerCase();
  return /\b(delete|remove|destroy|danger|destructive|erase|discard)\b/.test(value) || undefined;
}

function classBlob(node: TraversedNode): string {
  return `${node.attributes.class ?? ''} ${node.attributes.id ?? ''} ${(node.dom?.classes ?? []).join(' ')}`.toLowerCase();
}

function numberOrUndefined(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numericOrString(value: string | undefined): string | number | undefined {
  return numberOrUndefined(value) ?? value;
}

function isExternalLink(href: string | undefined, target: string | undefined): boolean | undefined {
  if (!href) return undefined;
  if (target === '_blank') return true;
  return /^https?:\/\//i.test(href) || undefined;
}

function imageDescriptionFromContext(node: TraversedNode): string | undefined {
  const context = node.media?.context ?? node.label ?? node.attributes.title;
  if (!context) return undefined;
  return `Image near: ${context}`;
}

function inferHeadingLevel(node: TraversedNode): number {
  const size = node.computed?.font_size_px ?? 16;
  if (size >= 32) return 1;
  if (size >= 26) return 2;
  if (size >= 22) return 3;
  return 4;
}

function dropUndefined<T extends Record<string, any>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
    if (Array.isArray(value[key]) && value[key].length === 0) delete value[key];
  }
  return value;
}
