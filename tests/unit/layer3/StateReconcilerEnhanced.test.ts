import { StateReconciler } from '../../../src/layer3_state_management/StateReconciler';
import { SemanticSnapshot } from '../../../src/common/types';

describe('StateReconciler', () => {
  const reconciler = new StateReconciler();

  const mockSnapshot: SemanticSnapshot = {
    snapshot_id: 'snap-1',
    version: '2.2.0',
    url: 'https://shop.example.com/products',
    title: 'Products',
    timestamp: new Date().toISOString(),
    session: { session_id: 's1', tab_id: 't1', tabs_count: 1, history_length: 1, cookies_count: 0 },
    available_actions: [],
    elements: [
      { id: 'search-input', type: 'input', label: 'Search' },
      { id: 'buy-btn', type: 'button', label: 'Buy' },
      { id: 'title', type: 'heading', text: 'Products' },
    ],
  };

  describe('URL drift detection', () => {
    it('should detect URL drift and invalidate cache', async () => {
      const mockPage = {
        url: () => 'https://shop.example.com/cart',
        evaluate: jest.fn(),
      } as any;

      const result = await reconciler.reconcile(mockPage, 's1', mockSnapshot);
      expect(result.valid).toBe(false);
      expect(result.phase).toBe('url_drift');
      expect(result.reason).toContain('URL changed');
    });

    it('should NOT drift on hash changes (SPA hash routing)', async () => {
      const mockPage = {
        url: () => 'https://shop.example.com/products#section2',
        evaluate: jest.fn().mockResolvedValue([
          { id: 'search-input', type: 'input' },
          { id: 'buy-btn', type: 'button' },
          { id: 'title', type: 'h1' },
        ]),
      } as any;

      // Same origin+pathname — hash differs — NOT a drift per SPA rules
      const result = await reconciler.reconcile(mockPage, 's1', mockSnapshot);
      // Should pass URL check and move to fast check
      expect(result.phase).not.toBe('url_drift');
    });
  });

  describe('Fast element check', () => {
    it('should detect element count mismatch', async () => {
      const mockPage = {
        url: () => 'https://shop.example.com/products',
        evaluate: jest.fn().mockResolvedValue([
          { id: 'search-input', type: 'input' },
          // Only 1 element vs 3 in snapshot
        ]),
      } as any;

      const result = await reconciler.reconcile(mockPage, 's1', mockSnapshot);
      expect(result.valid).toBe(false);
      expect(result.phase).toBe('fast_check');
    });

    it('should pass when elements match', async () => {
      const mockPage = {
        url: () => 'https://shop.example.com/products',
        evaluate: jest.fn().mockResolvedValue([
          { id: 'search-input', type: 'input' },
          { id: 'buy-btn', type: 'button' },
          { id: 'title', type: 'heading' },
        ]),
      } as any;

      const result = await reconciler.reconcile(mockPage, 's1', mockSnapshot);
      expect(result.valid).toBe(true);
      expect(result.phase).toBe('fast_check');
    });
  });

  describe('No cached snapshot', () => {
    it('should skip reconciliation when no cached snapshot', async () => {
      const mockPage = { url: () => 'about:blank' } as any;

      const result = await reconciler.reconcile(mockPage, 's1', undefined);
      expect(result.valid).toBe(true);
      expect(result.phase).toBe('skipped');
    });
  });

  describe('DOM access failure', () => {
    it('should invalidate when page.evaluate fails (navigation in progress)', async () => {
      const mockPage = {
        url: () => 'https://shop.example.com/products',
        evaluate: jest.fn().mockRejectedValue(new Error('Execution context was destroyed')),
      } as any;

      const result = await reconciler.reconcile(mockPage, 's1', mockSnapshot);
      expect(result.valid).toBe(false);
      expect(result.phase).toBe('fast_check');
      expect(result.reason).toContain('DOM access failed');
    });
  });

  describe('Static methods (backward compatibility)', () => {
    it('performFastCheck should detect mismatches', () => {
      const result = StateReconciler.performFastCheck(mockSnapshot, [
        { id: 'search-input', type: 'input' },
        { id: 'buy-btn', type: 'button' },
      ]);
      expect(result).toBe(false);
    });

    it('performFastCheck should pass for matching elements', () => {
      const result = StateReconciler.performFastCheck(mockSnapshot, [
        { id: 'search-input', type: 'input' },
        { id: 'buy-btn', type: 'button' },
        { id: 'title', type: 'heading' },
      ]);
      expect(result).toBe(true);
    });

    it('performDeepCheck should detect field-level differences', () => {
      const elements = mockSnapshot.elements.map((e) => ({ ...e }));
      elements[0] = { ...elements[0], label: 'Changed Label' };
      expect(StateReconciler.performDeepCheck(mockSnapshot.elements, elements)).toBe(false);
    });
  });

  describe('Result tracking', () => {
    it('should store and retrieve last reconciliation result', async () => {
      const mockPage = {
        url: () => 'https://shop.example.com/products',
        evaluate: jest.fn().mockResolvedValue([
          { id: 'search-input', type: 'input' },
          { id: 'buy-btn', type: 'button' },
          { id: 'title', type: 'heading' },
        ]),
      } as any;

      await reconciler.reconcile(mockPage, 'track-test', mockSnapshot);
      const lastResult = reconciler.getLastResult('track-test');
      expect(lastResult).toBeDefined();
      expect(lastResult!.valid).toBe(true);
    });
  });
});
