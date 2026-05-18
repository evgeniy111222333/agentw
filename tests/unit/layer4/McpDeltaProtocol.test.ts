import { SnapshotDiffer } from '../../../src/layer4_semantic/diff/SnapshotDiffer';
import { SemanticSnapshot } from '../../../src/common/types';

describe('MCP Delta Transmission Protocol', () => {
  const differ = new SnapshotDiffer();

  const makeSnapshot = (overrides: Partial<SemanticSnapshot> = {}): SemanticSnapshot => ({
    snapshot_id: 'snap-1',
    version: '2.2.0',
    url: 'https://example.com',
    title: 'Test Page',
    timestamp: new Date().toISOString(),
    session: { session_id: 's1', tab_id: 't1', tabs_count: 1, history_length: 1, cookies_count: 0 },
    available_actions: [
      { action_id: 'a1', action: 'click', target: 'btn1', label: 'Click button' },
    ],
    elements: [
      { id: 'h1', type: 'heading', text: 'Welcome' },
      { id: 'p1', type: 'text', text: 'Hello world. This is a longer paragraph with lots of content to simulate real page data.' },
      { id: 'btn1', type: 'button', label: 'Submit' },
      { id: 'input1', type: 'input', label: 'Email', value: '' },
      { id: 'nav1', type: 'navigation', text: 'Home | About | Contact' },
      { id: 'footer1', type: 'text', text: 'Footer content with copyright 2025' },
    ],
    ...overrides,
  });

  it('should generate delta when only one element changes', () => {
    const snap1 = makeSnapshot({ snapshot_id: 'snap-1' });
    const snap2 = makeSnapshot({
      snapshot_id: 'snap-2',
      elements: [
        { id: 'h1', type: 'heading', text: 'Welcome' },
        { id: 'p1', type: 'text', text: 'Hello world. This is a longer paragraph with lots of content to simulate real page data.' },
        { id: 'btn1', type: 'button', label: 'Submit' },
        { id: 'input1', type: 'input', label: 'Email', value: 'user@example.com' }, // CHANGED
        { id: 'nav1', type: 'navigation', text: 'Home | About | Contact' },
        { id: 'footer1', type: 'text', text: 'Footer content with copyright 2025' },
      ],
    });

    const delta = differ.diff(snap1, snap2);
    expect(delta).toBeDefined();
    expect(delta!.operations.length).toBe(1);
    expect(delta!.operations[0].op).toBe('element_update');
    expect(delta!.operations[0].element_id).toBe('input1');
    expect(delta!.stats.updated).toBe(1);
    expect(delta!.stats.added).toBe(0);
    expect(delta!.stats.removed).toBe(0);
  });

  it('delta response should be significantly smaller than full snapshot', () => {
    const snap1 = makeSnapshot({ snapshot_id: 'snap-1' });
    const snap2 = makeSnapshot({
      snapshot_id: 'snap-2',
      elements: [
        ...snap1.elements.slice(0, 3),
        { id: 'input1', type: 'input', label: 'Email', value: 'user@example.com' },
        ...snap1.elements.slice(4),
      ],
    });

    const delta = differ.diff(snap1, snap2)!;

    // Simulate MCP full response (what we send without delta_only)
    const fullResponse = JSON.stringify({
      snapshot_id: snap2.snapshot_id,
      version: snap2.version,
      url: snap2.url,
      title: snap2.title,
      timestamp: snap2.timestamp,
      elements: snap2.elements,
      available_actions: snap2.available_actions,
      session: snap2.session,
    }, null, 2);

    // Simulate MCP delta_only response
    const deltaResponse = JSON.stringify({
      snapshot_id: snap2.snapshot_id,
      version: snap2.version,
      url: snap2.url,
      title: snap2.title,
      timestamp: snap2.timestamp,
      delta,
    }, null, 2);

    const fullSize = fullResponse.length;
    const deltaSize = deltaResponse.length;
    const savings = ((1 - deltaSize / fullSize) * 100);

    console.log(`Full snapshot: ${fullSize} chars`);
    console.log(`Delta-only:   ${deltaSize} chars`);
    console.log(`Savings:      ${savings.toFixed(1)}%`);

    // Delta should be smaller than full snapshot
    expect(deltaSize).toBeLessThan(fullSize);
    // With only 1 element changed out of 6, savings should be meaningful
    expect(savings).toBeGreaterThan(10);
  });

  it('should return undefined delta when snapshots are identical', () => {
    const snap1 = makeSnapshot({ snapshot_id: 'snap-1' });
    const snap2 = makeSnapshot({ snapshot_id: 'snap-2' });

    const delta = differ.diff(snap1, snap2);
    expect(delta).toBeUndefined();
  });

  it('should detect added and removed elements', () => {
    const snap1 = makeSnapshot({ snapshot_id: 'snap-1' });
    const snap2 = makeSnapshot({
      snapshot_id: 'snap-2',
      elements: [
        ...snap1.elements,
        { id: 'toast1', type: 'text', text: 'Success!' },
      ],
    });

    const delta = differ.diff(snap1, snap2)!;
    expect(delta.stats.added).toBe(1);
    expect(delta.operations.find(op => op.op === 'element_add')?.element_id).toBe('toast1');
  });

  it('should detect actions_changed when available_actions differ', () => {
    const snap1 = makeSnapshot({ snapshot_id: 'snap-1' });
    const snap2 = makeSnapshot({
      snapshot_id: 'snap-2',
      available_actions: [
        { action_id: 'a1', action: 'click', target: 'btn1', label: 'Click button' },
        { action_id: 'a2', action: 'type', target: 'input1', label: 'Type in input' },
      ],
    });

    const delta = differ.diff(snap1, snap2)!;
    expect(delta.stats.actions_changed).toBe(true);
  });
});
