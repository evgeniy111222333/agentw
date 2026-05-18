import { StateReconciler } from '../../../src/layer3_state_management/StateReconciler';
import { SemanticSnapshot, SemanticElement } from '../../../src/common/types';

describe('StateReconciler', () => {
  const mockSnapshot: SemanticSnapshot = {
    version: '1.0',
    url: 'http://test.com',
    title: 'Test',
    timestamp: '2025-01-01T00:00:00Z',
    session: { session_id: 's1', tab_id: 't1', tabs_count: 1, history_length: 1, cookies_count: 0 },
    available_actions: [],
    elements: [
      { id: 'btn1', type: 'button', label: 'Submit' },
      { id: 'input1', type: 'input', required: true }
    ]
  };

  describe('Phase 1: performFastCheck', () => {
    it('should return true when IDs and types match exactly', () => {
      const currentSummary = [
        { id: 'btn1', type: 'button' },
        { id: 'input1', type: 'input' }
      ];
      expect(StateReconciler.performFastCheck(mockSnapshot, currentSummary)).toBe(true);
    });

    it('should return false when lengths differ', () => {
      const currentSummary = [
        { id: 'btn1', type: 'button' }
      ];
      expect(StateReconciler.performFastCheck(mockSnapshot, currentSummary)).toBe(false);
    });

    it('should return false when a type is different', () => {
      const currentSummary = [
        { id: 'btn1', type: 'link' }, // Mismatch here
        { id: 'input1', type: 'input' }
      ];
      expect(StateReconciler.performFastCheck(mockSnapshot, currentSummary)).toBe(false);
    });
  });

  describe('Phase 2: performDeepCheck', () => {
    it('should return true for deeply equal element arrays', () => {
      const currentElements: SemanticElement[] = [
        { id: 'btn1', type: 'button', label: 'Submit' },
        { id: 'input1', type: 'input', required: true }
      ];
      expect(StateReconciler.performDeepCheck(mockSnapshot.elements, currentElements)).toBe(true);
    });

    it('should return false for different properties', () => {
      const currentElements: SemanticElement[] = [
        { id: 'btn1', type: 'button', label: 'Loading...' }, // Label changed
        { id: 'input1', type: 'input', required: true }
      ];
      expect(StateReconciler.performDeepCheck(mockSnapshot.elements, currentElements)).toBe(false);
    });
  });
});
