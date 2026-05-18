import {
  AvailableAction,
  SemanticDelta,
  SemanticDeltaOperation,
  SemanticElement,
  SemanticSnapshot,
} from '../../common/types';

export class SnapshotDiffer {
  diff(previous: SemanticSnapshot | undefined, next: SemanticSnapshot): SemanticDelta | undefined {
    if (!previous) return undefined;

    const operations: SemanticDeltaOperation[] = [];
    const previousElements = new Map(previous.elements.map((element) => [element.id, element]));
    const nextElements = new Map(next.elements.map((element) => [element.id, element]));
    let added = 0;
    let removed = 0;
    let updated = 0;

    let lastSeenId: string | undefined = undefined;

    for (const element of next.elements) {
      const id = element.id;
      const before = previousElements.get(id);
      
      if (!before) {
        operations.push({ op: 'element_add', element_id: id, element, after_id: lastSeenId });
        added += 1;
      } else {
        const normBefore = normalizeElement(before);
        const normAfter = normalizeElement(element);
        if (stableStringify(normBefore) !== stableStringify(normAfter)) {
          // Detect specific attribute changes (Concept §6.4 update_attr)
          const changes: Array<{attr: string, old_value: any, new_value: any}> = [];
          for (const key of Object.keys(normAfter)) {
            if (stableStringify((normBefore as any)[key]) !== stableStringify((normAfter as any)[key])) {
              changes.push({ attr: key, old_value: (normBefore as any)[key], new_value: (normAfter as any)[key] });
            }
          }
          // If only specific attributes changed (not the whole structure or type), use update_attr
          const isStructural = changes.some(c => ['id', 'type', 'tagName', 'iframe', 'shadow'].includes(c.attr));
          if (!isStructural && changes.length > 0) {
            operations.push({
              op: 'update_attr',
              element_id: id,
              changes
            });
          } else {
            operations.push({
              op: 'element_update',
              element_id: id,
              before: compactElement(before),
              after: compactElement(element),
            });
          }
          updated += 1;
        }
      }
      lastSeenId = id;
    }

    for (const [id, element] of previousElements) {
      if (!nextElements.has(id)) {
        operations.push({ op: 'element_remove', element_id: id });
        removed += 1;
      }
    }

    const prevActions = new Map(previous.available_actions.map(a => [a.action_id || a.action, a]));
    const nextActions = new Map(next.available_actions.map(a => [a.action_id || a.action, a]));
    
    // Concept §6.4 Action additions and removals
    for (const [id, action] of nextActions) {
      if (!prevActions.has(id)) {
        operations.push({ op: 'action_add', action });
      }
    }
    for (const [id, action] of prevActions) {
      if (!nextActions.has(id)) {
        operations.push({ op: 'action_remove', action });
      }
    }
    const actionsChanged = operations.some(o => o.op === 'action_add' || o.op === 'action_remove');

    if (previous.url !== next.url || previous.title !== next.title) {
      operations.push({
        op: 'metadata_update',
        metadata: {
          url: next.url,
          title: next.title,
        },
      });
    }

    if (operations.length === 0) return undefined;

    // Concept §6.4 Checksum generation
    const checksum = generateChecksum(next.elements);

    return {
      from_snapshot_id: previous.snapshot_id,
      to_snapshot_id: next.snapshot_id ?? '',
      timestamp: next.timestamp,
      checksum,
      operations,
      stats: {
        added,
        removed,
        updated,
        actions_changed: actionsChanged,
      },
    };
  }
}

export function generateChecksum(elements: SemanticElement[]): string {
  let hash = 2166136261;
  const str = elements.map(e => e.id).join('|');
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function compactElement(element: SemanticElement): Partial<SemanticElement> {
  const { id, type, label, text, value, disabled, visible, url } = element;
  return dropUndefined({ id, type, label, text, value, disabled, visible, url });
}

function normalizeElement(element: SemanticElement): SemanticElement {
  const clone = { ...element };
  delete clone.boundingBox;
  return clone;
}

function actionsSignature(actions: AvailableAction[]): string {
  return stableStringify(
    actions.map((action) => ({
      action_id: action.action_id,
      action: action.action,
      target: action.target,
      params: action.params,
      preconditions: action.preconditions,
    }))
  );
}

function stableStringify(value: any): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function dropUndefined<T extends Record<string, any>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}
