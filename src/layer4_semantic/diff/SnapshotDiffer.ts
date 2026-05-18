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

    for (const [id, element] of nextElements) {
      const before = previousElements.get(id);
      if (!before) {
        operations.push({ op: 'element_add', element_id: id, element });
        added += 1;
      } else if (stableStringify(normalizeElement(before)) !== stableStringify(normalizeElement(element))) {
        operations.push({
          op: 'element_update',
          element_id: id,
          before: compactElement(before),
          after: compactElement(element),
        });
        updated += 1;
      }
    }

    for (const [id, element] of previousElements) {
      if (!nextElements.has(id)) {
        operations.push({ op: 'element_remove', element_id: id, before: compactElement(element) });
        removed += 1;
      }
    }

    const actionsChanged = actionsSignature(previous.available_actions) !== actionsSignature(next.available_actions);
    if (actionsChanged) {
      operations.push({ op: 'actions_replace', actions: next.available_actions });
    }

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

    return {
      from_snapshot_id: previous.snapshot_id,
      to_snapshot_id: next.snapshot_id ?? '',
      timestamp: next.timestamp,
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
