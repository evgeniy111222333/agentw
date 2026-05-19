import { TokenBudgetManager } from '../../../src/layer4_semantic/budget/TokenBudgetManager';
import { SemanticElement } from '../../../src/common/types';

describe('TokenBudgetManager', () => {
  const manager = new TokenBudgetManager();

  const createElements = (count: number, type: string, extraLength = 0): SemanticElement[] => {
    return Array.from({ length: count }).map((_, i) => ({
      id: `${type}-${i}`,
      type: type as any,
      text: 'x'.repeat(extraLength),
    }));
  };

  it('should not prune if within budget', () => {
    const elements = [
      ...createElements(10, 'text', 50),
      ...createElements(5, 'button', 10),
    ];

    const result = manager.applyBudget(elements, { max_tokens: 8000 });
    
    expect(result.pruning_applied).toBe(false);
    expect(result.pruned_count).toBe(0);
    expect(result.elements.length).toBe(15);
  });

  it('should prune low priority elements when over budget', () => {
    const elements = [
      ...createElements(50, 'text', 100), // Low priority, heavy (~25 tokens each)
      ...createElements(10, 'button', 10), // High priority (~5 tokens each)
      ...createElements(5, 'form', 10),    // Critical priority
    ];

    // Tiny budget that forces pruning
    const result = manager.applyBudget(elements, { max_tokens: 2300, reserved_tokens: 2000 }); // Budget = 300 tokens

    expect(result.pruning_applied).toBe(true);
    expect(result.pruned_count).toBeGreaterThan(0);
    
    // Check priorities: forms > buttons > text
    const formsKept = result.elements.filter(e => e.type === 'form').length;
    const buttonsKept = result.elements.filter(e => e.type === 'button').length;
    const textKept = result.elements.filter(e => e.type === 'text').length;

    expect(formsKept).toBe(5); // All critical kept
    expect(buttonsKept).toBe(10); // High priority kept
    expect(textKept).toBeLessThan(50); // Low priority pruned
  });

  it('should NEVER prune critical elements even if it exceeds budget', () => {
    const elements = [
      ...createElements(50, 'form', 100), // Heavy critical elements
      ...createElements(50, 'error', 100), // Heavy critical elements
    ];

    const result = manager.applyBudget(elements, { max_tokens: 2050, reserved_tokens: 2000 }); // Budget = 50 tokens
    
    expect(result.elements.length).toBe(100);
    expect(result.estimated_tokens).toBeGreaterThan(50);
  });

  it('should boost priority of elements with validation errors', () => {
    const el1: SemanticElement = { id: 't1', type: 'text', text: 'normal text' };
    const el2: SemanticElement = { 
      id: 't2', 
      type: 'text', 
      text: 'error text',
      validation_errors: ['Required field']
    } as any;

    const result = manager.applyBudget([el1, el2], { max_tokens: 2020, reserved_tokens: 2000 }); // Budget = 20 tokens
    
    // Only one fits, the one with error should win
    expect(result.elements.length).toBe(1);
    expect(result.elements[0].id).toBe('t2');
  });

  it('should accurately estimate element tokens', () => {
    const el: SemanticElement = {
      id: 'btn-1', // 3 / 4 = 1
      type: 'button', // 6 / 4 = 2
      label: 'Submit form', // 11 / 4 = 3
    };

    // Base overhead (4) + ceil(5/4)=2 + ceil(6/4)=2 + ceil(11/4)=3 = 11
    const tokens = manager.estimateElementTokens(el);
    expect(tokens).toBe(11);
  });
});
