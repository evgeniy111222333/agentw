import { SnapshotDiffer } from '../../src/layer4_semantic/diff/SnapshotDiffer';
import { SemanticSnapshot } from '../../src/common/types';

describe('SnapshotDiffer', () => {
  const differ = new SnapshotDiffer();

  it('returns undefined when snapshots are semantically identical', () => {
    const previous = snapshot([{ id: 'title', type: 'heading', text: 'A' }]);
    const next = snapshot([{ id: 'title', type: 'heading', text: 'A' }]);

    expect(differ.diff(previous, next)).toBeUndefined();
  });

  it('emits compact add, update, remove, and action replacement operations', () => {
    const previous = snapshot([
      { id: 'title', type: 'heading', text: 'A' },
      { id: 'old', type: 'button', text: 'Remove me' },
    ]);
    const next = snapshot(
      [
        { id: 'title', type: 'heading', text: 'B' },
        { id: 'new', type: 'button', text: 'Add me' },
      ],
      [{ action: 'click', target: 'new', label: 'Add me' }]
    );

    const delta = differ.diff(previous, next);

    expect(delta?.stats).toEqual({
      added: 1,
      removed: 1,
      updated: 1,
      actions_changed: true,
    });
    expect(delta?.operations).toContainEqual(expect.objectContaining({ op: 'element_add', element_id: 'new' }));
    expect(delta?.operations).toContainEqual(expect.objectContaining({
      op: 'element_remove',
      element_id: 'old',
    }));
    expect(delta?.operations).toContainEqual(expect.objectContaining({ op: 'update_attr', element_id: 'title' }));
    expect(delta?.operations).toContainEqual(expect.objectContaining({ op: 'action_add' }));
  });
});

function snapshot(elements: any[], actions: any[] = []): SemanticSnapshot {
  return {
    snapshot_id: 'snapshot',
    version: '2.1.0',
    url: 'https://example.test',
    title: 'Example',
    timestamp: '2026-05-17T00:00:00.000Z',
    elements,
    available_actions: actions,
    session: {
      session_id: 'session',
      tab_id: 'tab-1',
      tabs_count: 1,
      history_length: 1,
      cookies_count: 0,
    },
  };
}
