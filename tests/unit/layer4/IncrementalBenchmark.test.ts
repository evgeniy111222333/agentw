import { SnapshotDiffer, generateChecksum } from '../../../src/layer4_semantic/diff/SnapshotDiffer';
import { SemanticSnapshot, SemanticElement } from '../../../src/common/types';

/**
 * Concept Benchmarks: Token Efficiency & Delta Protocol
 *
 * Goals from concept:
 *   - tokens_compressed < 1000
 *   - delta < 200 tokens (for typical single-element change)
 *   - compression_ratio < 0.5
 *   - 6-10x token savings with delta vs full
 */
describe('Incremental Update Benchmarks', () => {
  const differ = new SnapshotDiffer();

  // Realistic page: 30 elements (form, nav, headings, text, buttons)
  const realisticPage = (overrides: Partial<SemanticSnapshot> = {}): SemanticSnapshot => ({
    snapshot_id: 'snap-base',
    version: '2.2.0',
    url: 'https://app.example.com/dashboard',
    title: 'Dashboard — App',
    timestamp: new Date().toISOString(),
    session: { session_id: 's1', tab_id: 't1', tabs_count: 1, history_length: 3, cookies_count: 5 },
    elements: [
      { id: 'nav', type: 'navigation', text: 'Home | Dashboard | Settings | Profile | Help' },
      { id: 'h1', type: 'heading', text: 'Welcome to your Dashboard' },
      { id: 'alert-1', type: 'notification', text: 'You have 3 new notifications' },
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `card-${i}`, type: 'text' as const,
        text: `Project ${['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'][i]}: Status is ${['active', 'paused', 'completed', 'active', 'draft'][i]}. Last updated ${i + 1} hours ago.`,
      })),
      { id: 'search', type: 'input', label: 'Search projects', value: '' },
      { id: 'filter-status', type: 'input', label: 'Filter by status', value: 'all' },
      { id: 'btn-new', type: 'button', label: 'New Project' },
      { id: 'btn-export', type: 'button', label: 'Export Data' },
      { id: 'form-quick', type: 'form', label: 'Quick Add', value: '' },
      { id: 'input-name', type: 'input', label: 'Project name', value: '' },
      { id: 'input-desc', type: 'input', label: 'Description', value: '' },
      { id: 'select-priority', type: 'input', label: 'Priority', value: 'medium' },
      { id: 'btn-submit', type: 'button', label: 'Create Project' },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `row-${i}`, type: 'text' as const,
        text: `Row ${i + 1}: Task "${['Review PR', 'Deploy v2', 'Write docs', 'Fix bug #42', 'Update deps', 'Run tests', 'Code review', 'Plan sprint'][i]}" assigned to ${['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Hank'][i]}.`,
      })),
      { id: 'pagination', type: 'navigation', text: '1 | 2 | 3 | ... | 10' },
      { id: 'footer', type: 'text', text: '© 2026 App Inc. Privacy Policy | Terms of Service' },
    ],
    available_actions: [
      { action_id: 'click-new', action: 'click', target: 'btn-new', label: 'New Project' },
      { action_id: 'click-export', action: 'click', target: 'btn-export', label: 'Export Data' },
      { action_id: 'type-search', action: 'type', target: 'search', label: 'Search' },
      { action_id: 'submit-form', action: 'submit', target: 'form-quick', label: 'Create' },
    ],
    ...overrides,
  });

  it('Benchmark: single input change (type action) — delta vs full', () => {
    const before = realisticPage({ snapshot_id: 'snap-1' });
    const after = realisticPage({
      snapshot_id: 'snap-2',
      elements: before.elements.map(el =>
        el.id === 'search' ? { ...el, value: 'deployment pipeline' } : el
      ),
    });

    const delta = differ.diff(before, after)!;
    expect(delta).toBeDefined();

    const fullSize = JSON.stringify(after.elements).length;
    const deltaSize = JSON.stringify(delta.operations).length;
    const fullTokens = Math.ceil(fullSize / 4);
    const deltaTokens = Math.ceil(deltaSize / 4);
    const ratio = deltaTokens / fullTokens;

    console.log('\n=== BENCHMARK: Single Input Change (type action) ===');
    console.log(`Full elements:   ${fullSize} bytes  (~${fullTokens} tokens)`);
    console.log(`Delta operations: ${deltaSize} bytes  (~${deltaTokens} tokens)`);
    console.log(`Token savings:    ${((1 - ratio) * 100).toFixed(1)}%`);
    console.log(`Ratio:            ${ratio.toFixed(3)} (target < 0.5)`);
    console.log(`Delta ops:        ${delta.operations.length}`);
    console.log(`Delta type:       ${delta.operations[0]?.op}`);

    // Concept targets
    expect(deltaTokens).toBeLessThan(200); // delta < 200 tokens
    expect(ratio).toBeLessThan(0.5); // compression_ratio < 0.5
    expect(delta.operations.length).toBe(1);
    expect(delta.operations[0].op).toBe('update_attr');
  });

  it('Benchmark: form fill (3 fields changed) — delta vs full', () => {
    const before = realisticPage({ snapshot_id: 'snap-1' });
    const after = realisticPage({
      snapshot_id: 'snap-2',
      elements: before.elements.map(el => {
        if (el.id === 'input-name') return { ...el, value: 'Project Zeta' };
        if (el.id === 'input-desc') return { ...el, value: 'A new project for Q3 planning' };
        if (el.id === 'select-priority') return { ...el, value: 'high' };
        return el;
      }),
    });

    const delta = differ.diff(before, after)!;
    expect(delta).toBeDefined();

    const fullSize = JSON.stringify(after.elements).length;
    const deltaSize = JSON.stringify(delta.operations).length;
    const fullTokens = Math.ceil(fullSize / 4);
    const deltaTokens = Math.ceil(deltaSize / 4);

    console.log('\n=== BENCHMARK: Form Fill (3 fields) ===');
    console.log(`Full elements:   ${fullSize} bytes  (~${fullTokens} tokens)`);
    console.log(`Delta operations: ${deltaSize} bytes  (~${deltaTokens} tokens)`);
    console.log(`Token savings:    ${((1 - deltaTokens / fullTokens) * 100).toFixed(1)}%`);
    console.log(`Delta ops:        ${delta.operations.length}`);

    expect(delta.operations.length).toBe(3);
    expect(delta.operations.every(op => op.op === 'update_attr')).toBe(true);
    expect(deltaTokens).toBeLessThan(fullTokens * 0.3); // >70% savings
  });

  it('Benchmark: toast notification added — delta vs full', () => {
    const before = realisticPage({ snapshot_id: 'snap-1' });
    const after = realisticPage({
      snapshot_id: 'snap-2',
      elements: [
        ...before.elements,
        { id: 'toast-1', type: 'notification', text: 'Project created successfully!' },
      ],
    });

    const delta = differ.diff(before, after)!;
    expect(delta).toBeDefined();

    const fullSize = JSON.stringify(after.elements).length;
    const deltaSize = JSON.stringify(delta.operations).length;
    const fullTokens = Math.ceil(fullSize / 4);
    const deltaTokens = Math.ceil(deltaSize / 4);

    console.log('\n=== BENCHMARK: Toast Notification Added ===');
    console.log(`Full elements:   ${fullSize} bytes  (~${fullTokens} tokens)`);
    console.log(`Delta operations: ${deltaSize} bytes  (~${deltaTokens} tokens)`);
    console.log(`Token savings:    ${((1 - deltaTokens / fullTokens) * 100).toFixed(1)}%`);
    console.log(`Added op has after_id: ${Boolean(delta.operations[0]?.after_id)}`);

    expect(delta.stats.added).toBe(1);
    expect(delta.operations[0].after_id).toBeDefined(); // Positional info
    expect(deltaTokens).toBeLessThan(fullTokens * 0.15); // >85% savings
  });

  it('Benchmark: 40% threshold triggers full snapshot fallback', () => {
    const before = realisticPage({ snapshot_id: 'snap-1' });
    // Change >40% of elements
    const changedElements = before.elements.map((el, i) =>
      i < Math.ceil(before.elements.length * 0.5)
        ? { ...el, text: `CHANGED: ${el.text ?? el.label}` }
        : el
    );
    const after = realisticPage({
      snapshot_id: 'snap-2',
      elements: changedElements,
    });

    const delta = differ.diff(before, after);
    expect(delta).toBeDefined();

    // Simulate the 40% check that SemanticLayer performs
    const totalElements = Math.max(before.elements.length, after.elements.length);
    const changed = delta!.stats.added + delta!.stats.removed + delta!.stats.updated;
    const changeRatio = changed / totalElements;
    const shouldFallback = changeRatio > 0.4;

    console.log('\n=== BENCHMARK: 40% Threshold Check ===');
    console.log(`Total elements:   ${totalElements}`);
    console.log(`Changed elements: ${changed}`);
    console.log(`Change ratio:     ${(changeRatio * 100).toFixed(1)}%`);
    console.log(`Fallback to full: ${shouldFallback}`);

    expect(shouldFallback).toBe(true);
    expect(changeRatio).toBeGreaterThan(0.4);
  });

  it('Benchmark: checksum generation and validation', () => {
    const snap = realisticPage();
    const checksum = generateChecksum(snap.elements);

    // Same elements → same checksum
    const snap2 = realisticPage();
    const checksum2 = generateChecksum(snap2.elements);
    expect(checksum).toBe(checksum2);

    // Different elements → different checksum
    const snap3 = realisticPage({
      elements: [...snap.elements, { id: 'extra', type: 'text', text: 'extra' }],
    });
    const checksum3 = generateChecksum(snap3.elements);
    expect(checksum).not.toBe(checksum3);

    console.log('\n=== BENCHMARK: Checksum ===');
    console.log(`Checksum (base):    ${checksum}`);
    console.log(`Checksum (same):    ${checksum2} — match: ${checksum === checksum2}`);
    console.log(`Checksum (changed): ${checksum3} — match: ${checksum === checksum3}`);
  });

  it('Benchmark: end-to-end delta response size comparison', () => {
    const before = realisticPage({ snapshot_id: 'snap-1' });
    const after = realisticPage({
      snapshot_id: 'snap-2',
      elements: before.elements.map(el =>
        el.id === 'search' ? { ...el, value: 'test query' } : el
      ),
    });

    const delta = differ.diff(before, after)!;

    // Full MCP response (what CommandRouter returns without delta)
    const fullResponse = JSON.stringify({
      snapshot_id: after.snapshot_id,
      url: after.url,
      title: after.title,
      elements: after.elements,
      available_actions: after.available_actions,
    });

    // Delta-only response (what CommandRouter returns with delta-by-default)
    const deltaResponse = JSON.stringify({
      snapshot_id: after.snapshot_id,
      url: after.url,
      title: after.title,
      checksum: generateChecksum(after.elements),
      delta,
      elements: [], // stripped
    });

    const fullTokens = Math.ceil(fullResponse.length / 4);
    const deltaTokens = Math.ceil(deltaResponse.length / 4);
    const multiplier = fullTokens / deltaTokens;

    console.log('\n=== BENCHMARK: End-to-End Response Comparison ===');
    console.log(`Full response:    ${fullResponse.length} bytes  (~${fullTokens} tokens)`);
    console.log(`Delta response:   ${deltaResponse.length} bytes  (~${deltaTokens} tokens)`);
    console.log(`Token multiplier: ${multiplier.toFixed(1)}x savings`);
    console.log(`\nConcept target: 6-10x savings`);

    // The concept says 6-10x savings for real pages
    expect(multiplier).toBeGreaterThan(3); // Conservative for 30-element test page
    expect(deltaTokens).toBeLessThan(200); // delta < 200 tokens
  });
});
