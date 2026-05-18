import { IncrementalUpdater } from '../../../src/layer4_semantic/diff/IncrementalUpdater';
import { globalEventBus } from '../../../src/common/EventBus';
import { SemanticSnapshot } from '../../../src/common/types';

describe('IncrementalUpdater', () => {
  let updater: IncrementalUpdater;
  let mockTraverser: any;
  let mockClassifier: any;
  let mockExtractor: any;
  let mockPage: any;

  beforeEach(() => {
    mockTraverser = { traverseNode: jest.fn() };
    mockClassifier = { classify: jest.fn().mockReturnValue('button') };
    mockExtractor = { extract: jest.fn().mockReturnValue({ text: 'New Button' }) };
    mockPage = {};
    
    updater = new IncrementalUpdater(mockTraverser, mockClassifier, mockExtractor);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should patch form input values on form_state_updated', async () => {
    const snapshot: SemanticSnapshot = {
      version: '1.0',
      url: 'http://test',
      title: 'Test',
      timestamp: '2025-01-01T00:00:00Z',
      session: { session_id: 's1', tab_id: 't1', tabs_count: 1, history_length: 1, cookies_count: 0 },
      available_actions: [],
      elements: [
        { id: 'input1', type: 'input', value: 'old' }
      ]
    };

    updater.registerSession('s1', mockPage, snapshot);

    await globalEventBus.publish('form_state_updated', {
      session_id: 's1',
      data: { elementId: 'input1', type: 'text', value: 'new_value' }
    });

    const updated = updater.getSnapshot('s1');
    expect(updated?.elements.find(e => e.id === 'input1')?.value).toBe('new_value');
  });

  it('should fetch and append new node on dom_mutated childList', async () => {
    const snapshot: SemanticSnapshot = {
      version: '1.0',
      url: 'http://test',
      title: 'Test',
      timestamp: '2025-01-01T00:00:00Z',
      session: { session_id: 's1', tab_id: 't1', tabs_count: 1, history_length: 1, cookies_count: 0 },
      available_actions: [],
      elements: [
        { id: 'container1', type: 'text' }
      ]
    };

    updater.registerSession('s1', mockPage, snapshot);

    mockTraverser.traverseNode.mockResolvedValue({
      nodes: [{ id: 'new_btn1', tagName: 'button' }]
    });

    await globalEventBus.publish('dom_mutated', {
      session_id: 's1',
      mutations: [
        { type: 'childList', target: 'container1' }
      ]
    });

    const updated = updater.getSnapshot('s1');
    expect(mockTraverser.traverseNode).toHaveBeenCalledWith(mockPage, 'container1');
    
    const newBtn = updated?.elements.find(e => e.id === 'new_btn1');
    expect(newBtn).toBeDefined();
    expect(newBtn?.type).toBe('button');
    expect(newBtn?.text).toBe('New Button');
  });
});
