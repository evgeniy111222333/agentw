import { ConfigurationManager } from '../../src/config/ConfigurationManager';
import { SemanticLayer } from '../../src/layer4_semantic/SemanticLayer';
import { TraversalResult } from '../../src/layer4_semantic/traverser/DOMTraverser';

describe('SemanticLayer snapshot shaping', () => {
  const configManager = ConfigurationManager.getInstance();
  const originalSemantic = { ...configManager.getConfig().semantic };

  beforeEach(() => {
    configManager.updateConfig({
      semantic: {
        ...configManager.getConfig().semantic,
        cache_enabled: false,
      },
    });
  });

  afterAll(() => {
    configManager.updateConfig({ semantic: originalSemantic });
  });

  it('passes requested max_elements through and records truncation metadata', async () => {
    const traverser = {
      traverse: jest.fn(async (_page, options) => traversal([
        { id: 'h', tagName: 'h1', text: 'Checkout', label: 'Checkout', attributes: {} },
      ], {
        semantic_nodes_total: 20,
        max_elements: 10,
        max_elements_requested: options.maxElements,
      })),
    };
    const layer = new SemanticLayer({
      traverser: traverser as any,
      pluginRegistry: passPlugin() as any,
      authTracker: authTracker() as any,
    });

    const snapshot = await layer.createSnapshot(page('', 'https://app.test/checkout') as any, {
      session,
      maxElements: 10,
    });

    expect(traverser.traverse).toHaveBeenCalledWith(expect.anything(), { maxElements: 10 });
    expect(snapshot.title).toBe('Checkout');
    expect(snapshot.meta).toEqual(expect.objectContaining({
      incomplete: true,
      max_elements: 10,
      max_elements_requested: 10,
      semantic_nodes_total: 20,
    }));
  });

  it('infers navigation headings from meaningful story links when markup lacks heading tags', async () => {
    const layer = new SemanticLayer({
      traverser: {
        traverse: jest.fn(async () => traversal([
          {
            id: 'story',
            tagName: 'a',
            text: 'A detailed release note for a real project',
            label: 'A detailed release note for a real project',
            attributes: { href: 'https://news.test/item?id=1' },
          },
        ])),
      } as any,
      pluginRegistry: passPlugin() as any,
      authTracker: authTracker() as any,
    });

    const snapshot = await layer.createSnapshot(page('News', 'https://news.test') as any, { session });

    expect(snapshot.navigation.headings).toContainEqual(expect.objectContaining({
      id: 'story',
      inferred: true,
      text: 'A detailed release note for a real project',
    }));
  });
});

const session = {
  session_id: 'session',
  tab_id: 'tab-1',
  tabs_count: 1,
  history_length: 0,
  cookies_count: 0,
};

function page(title: string, url: string): Record<string, any> {
  return {
    title: jest.fn(async () => title),
    url: jest.fn(() => url),
    waitForLoadState: jest.fn(async () => undefined),
    waitForTimeout: jest.fn(async () => undefined),
  };
}

function passPlugin(): Record<string, any> {
  return {
    applyPageLoad: jest.fn(async (input) => ({
      elements: input.elements,
      available_actions: input.available_actions,
      stats: { actions: 0, elements: 0, warnings: 0 },
      metadata: {},
    })),
  };
}

function authTracker(): Record<string, any> {
  return {
    inspect: jest.fn(async () => ({
      authenticated: false,
      confidence: 0.5,
      indicators: [],
      cookies: [],
      updated_at: '2026-05-18T00:00:00.000Z',
    })),
  };
}

function traversal(
  nodes: Array<Partial<TraversalResult['nodes'][number]>>,
  stats: Partial<TraversalResult['stats']> = {}
): TraversalResult {
  return {
    nodes: nodes.map((node) => ({
      id: node.id ?? 'node',
      tagName: node.tagName ?? 'p',
      text: node.text,
      label: node.label,
      role: node.role,
      attributes: node.attributes ?? {},
      visible: true,
      disabled: false,
      required: false,
      selector: `#${node.id ?? 'node'}`,
    })),
    stats: {
      dom_nodes_count: stats.dom_nodes_count ?? nodes.length,
      semantic_nodes_count: stats.semantic_nodes_count ?? nodes.length,
      semantic_nodes_total: stats.semantic_nodes_total ?? nodes.length,
      skipped_invisible: 0,
      skipped_noise: 0,
      below_fold_count: 0,
      raw_dom_bytes: 1000,
      max_elements: stats.max_elements ?? 300,
      max_elements_requested: stats.max_elements_requested,
    },
  };
}
