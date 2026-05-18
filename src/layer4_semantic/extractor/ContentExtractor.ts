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

    if (['heading', 'text', 'button', 'link', 'badge', 'notification', 'menu_item'].includes(type) && node.text) {
      content.text = node.text;
    }

    if (type === 'link') {
      content.url = node.attributes.href;
      content.target = node.attributes.target;
      content.download = node.attributes.download;
    }

    if (type === 'button' || type === 'menu_item') {
      content.pressed = parseBooleanState(node.attributes['aria-pressed']);
      content.expanded = parseBooleanState(node.attributes['aria-expanded']);
    }

    if (type === 'input') {
      content.input_type = node.attributes.type || inferInputTypeFromRole(node.role);
      content.name = node.attributes.name;
      content.placeholder = node.attributes.placeholder;
      content.value = maskSensitiveValue(content.input_type, node.attributes.value);
      content.checked = parseBooleanState(node.attributes['aria-checked']);
      content.autocomplete = node.attributes.autocomplete;
      content.pattern = node.attributes.pattern;
      content.maxlength = node.attributes.maxlength ? Number(node.attributes.maxlength) : undefined;
    }

    if (type === 'select') {
      content.name = node.attributes.name;
      content.value = node.attributes.value;
      content.options = node.options ?? [];
      content.multiple = node.attributes.multiple !== undefined;
    }

    if (type === 'form') {
      content.action = node.form?.action;
      content.method = node.form?.method ?? 'GET';
      content.fields = node.form?.fields ?? [];
      content.submit_button_id = node.form?.submit_button_id;
      content.enctype = node.form?.enctype;
      content.autocomplete = node.form?.autocomplete;
    }

    if (type === 'image') {
      content.src = node.attributes.src;
      content.alt = node.attributes.alt ?? node.label;
    }

    if (type === 'iframe' || type === 'embed') {
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

    if (type === 'shadow_host') {
      content.shadow = node.shadow;
    }

    if (type === 'heading') {
      content.level = Number(node.tagName.replace('h', '')) || 1;
    }

    if (type === 'table') {
      content.rows = node.table?.rows ?? [];
      content.row_count = node.table?.row_count ?? 0;
      content.column_count = node.table?.column_count ?? 0;
      content.truncated = node.table?.truncated ?? false;
    }

    if (type === 'list') {
      content.item_count = node.list?.item_count ?? 0;
      content.sample_items = node.list?.sample_items ?? [];
    }

    if (type === 'progress') {
      content.value = node.attributes.value ? Number(node.attributes.value) : undefined;
      content.max = node.attributes.max ? Number(node.attributes.max) : undefined;
    }

    if (node.boundingBox?.in_viewport === false) {
      content.in_viewport = false;
    }

    return dropUndefined(content);
  }
}

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

function dropUndefined<T extends Record<string, any>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}
