import { ActionValidator } from '../../../src/layer2_action_execution/ActionValidator';
import { SemanticSnapshot } from '../../../src/common/types';

describe('ActionValidator', () => {
  const validator = new ActionValidator();

  const snapshot: SemanticSnapshot = {
    snapshot_id: 'snap-1',
    version: '2.2.0',
    url: 'https://shop.example.com/products',
    title: 'Products',
    timestamp: new Date().toISOString(),
    session: { session_id: 's1', tab_id: 't1', tabs_count: 1, history_length: 1, cookies_count: 0 },
    available_actions: [],
    elements: [
      { id: 'search-input', type: 'input', label: 'Search', visible: true },
      { id: 'buy-btn', type: 'button', label: 'Buy Now', visible: true },
      { id: 'disabled-btn', type: 'button', label: 'Out of Stock', visible: true, disabled: true },
      { id: 'hidden-panel', type: 'text', text: 'Secret content', visible: false },
      { id: 'product-title', type: 'heading', text: 'Premium Widget' },
      { id: 'category-select', type: 'select', label: 'Category' },
      { id: 'search-btn', type: 'button', label: 'Search' },
    ],
  };

  describe('Element existence checks', () => {
    it('should pass for existing element', () => {
      const result = validator.validate('click', 'buy-btn', {}, snapshot);
      expect(result.valid).toBe(true);
    });

    it('should fail for non-existent element with suggestions', () => {
      const result = validator.validate('click', 'buy-btn-x', {}, snapshot);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('ELEMENT_NOT_FOUND');
      // Should suggest similar elements
      expect(result.error?.suggestion).toContain('buy-btn');
    });

    it('should fail for completely unknown element', () => {
      const result = validator.validate('click', 'zzz-nonexistent-xyz', {}, snapshot);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('ELEMENT_NOT_FOUND');
    });
  });

  describe('Visibility checks', () => {
    it('should fail when element is not visible', () => {
      const result = validator.validate('click', 'hidden-panel', {}, snapshot);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('ELEMENT_NOT_VISIBLE');
      expect(result.error?.suggestion).toContain('Scroll');
    });
  });

  describe('Disabled state checks', () => {
    it('should fail when clicking disabled element', () => {
      const result = validator.validate('click', 'disabled-btn', {}, snapshot);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('ELEMENT_DISABLED');
    });

    it('should fail when typing into disabled element', () => {
      const result = validator.validate('type', 'disabled-btn', { text: 'hello' }, snapshot);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('ELEMENT_DISABLED');
    });
  });

  describe('Type mismatch checks', () => {
    it('should fail when typing into a heading', () => {
      const result = validator.validate('type', 'product-title', { text: 'hello' }, snapshot);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('TYPE_MISMATCH');
      expect(result.error?.suggestion).toContain('input');
    });

    it('should pass when typing into an input', () => {
      const result = validator.validate('type', 'search-input', { text: 'hello' }, snapshot);
      expect(result.valid).toBe(true);
    });

    it('should fail when selecting on a button', () => {
      const result = validator.validate('select', 'buy-btn', { value: 'x' }, snapshot);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('TYPE_MISMATCH');
    });

    it('should pass when selecting on a select element', () => {
      const result = validator.validate('select', 'category-select', { value: 'electronics' }, snapshot);
      expect(result.valid).toBe(true);
    });
  });

  describe('Parameter validation', () => {
    it('should fail navigate without url', () => {
      const result = validator.validate('navigate', undefined, {}, undefined);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAM');
    });

    it('should pass navigate with url', () => {
      const result = validator.validate('navigate', undefined, { url: 'https://x.com' }, undefined);
      expect(result.valid).toBe(true);
    });

    it('should fail type without text', () => {
      const result = validator.validate('type', 'search-input', {}, snapshot);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAM');
    });

    it('should fail keyboard without key', () => {
      const result = validator.validate('keyboard', undefined, {}, undefined);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAM');
    });
  });

  describe('No snapshot fallback', () => {
    it('should pass when no snapshot available (let Playwright handle)', () => {
      const result = validator.validate('click', 'some-btn', {}, undefined);
      expect(result.valid).toBe(true);
    });
  });
});
