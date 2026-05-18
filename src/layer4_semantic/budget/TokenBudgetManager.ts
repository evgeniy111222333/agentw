import { SemanticElement, SemanticSnapshot } from '../../common/types';
import { globalMetrics } from '../../common/MetricsRegistry';

/**
 * TokenBudgetManager — Controls and optimizes token spending.
 *
 * From Concept 2.7: "Token budget management ensures that the semantic
 * snapshot never exceeds the LLM's context window capacity. Elements are
 * prioritized by semantic importance, and low-value elements are pruned."
 *
 * Strategy:
 *   1. Each element type has a token weight (estimated characters / 4)
 *   2. Elements are scored by semantic importance (interactable > text > decorative)
 *   3. Budget is enforced by pruning lowest-priority elements first
 *   4. Critical elements (forms, errors, auth) are never pruned
 */

export interface TokenBudget {
  max_tokens: number;
  reserved_tokens: number;  // For metadata, actions, session info
  element_budget: number;   // max_tokens - reserved_tokens
}

export interface BudgetResult {
  elements: SemanticElement[];
  original_count: number;
  pruned_count: number;
  estimated_tokens: number;
  budget_used_pct: number;
  pruning_applied: boolean;
}

// Token weight estimates per element field (characters / 4 ≈ tokens)
const FIELD_WEIGHTS: Record<string, number> = {
  id: 3,
  type: 2,
  label: 5,
  text: 15,
  value: 5,
  placeholder: 4,
  href: 8,
  src: 8,
  action: 4,
  method: 1,
  role: 2,
  aria_label: 5,
  validation_errors: 10,
  fields: 20,
  options: 15,
  rows: 30,
  base_overhead: 8, // JSON structure per element
};

// Priority scores — higher = more important = kept first
const TYPE_PRIORITY: Record<string, number> = {
  // Critical — never pruned
  form: 100,
  notification: 100,
  modal: 100,
  dialog: 100,
  alert: 95,
  error: 95,

  // High — interactive elements the LLM needs
  input: 90,
  textarea: 90,
  select: 85,
  button: 85,
  combobox: 85,
  checkbox: 80,
  radio: 80,
  link: 75,
  search: 75,
  tab: 70,

  // Medium — structural/content
  heading: 60,
  navigation: 55,
  breadcrumb: 55,
  pagination: 55,
  card: 52,
  menu: 50,
  tab_group: 50,
  accordion: 50,
  table: 50,
  chart: 50,
  list: 45,
  listbox: 45,

  // Low — informational
  text: 30,
  image: 25,
  video: 35,
  audio: 35,
  rating: 30,
  stepper: 30,
  carousel: 30,
  badge: 25,
  tooltip: 20,
  skeleton: 12,
  iframe: 35,
  embed: 35,
  shadow_host: 35,
  icon: 15,
  separator: 10,
  decorative: 5,
};

export class TokenBudgetManager {
  private defaultBudget: TokenBudget = {
    max_tokens: 8000,      // ~8K tokens for element content
    reserved_tokens: 2000,  // Metadata, actions, session
    element_budget: 6000,
  };

  /**
   * Apply token budget to a list of elements.
   * Returns pruned list + metrics.
   */
  applyBudget(
    elements: SemanticElement[],
    budget?: Partial<TokenBudget>
  ): BudgetResult {
    const activeBudget = this.resolveBudget(budget);
    const originalCount = elements.length;

    // Score and sort by priority
    const scored = elements.map((el) => ({
      element: el,
      priority: this.elementPriority(el),
      tokens: this.estimateElementTokens(el),
    }));

    // Sort: highest priority first, then by token efficiency (priority/tokens)
    scored.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return (b.priority / b.tokens) - (a.priority / a.tokens);
    });

    // Greedily pack elements within budget
    const kept: SemanticElement[] = [];
    let usedTokens = 0;

    for (const item of scored) {
      if (usedTokens + item.tokens <= activeBudget.element_budget) {
        kept.push(item.element);
        usedTokens += item.tokens;
      } else if (item.priority >= 95) {
        // Critical elements are ALWAYS included
        kept.push(item.element);
        usedTokens += item.tokens;
      }
    }

    const prunedCount = originalCount - kept.length;

    globalMetrics.increment('llm_browser_token_budget_total');
    if (prunedCount > 0) {
      globalMetrics.increment('llm_browser_token_budget_pruned_total');
      globalMetrics.observe('llm_browser_token_budget_pruned_elements', prunedCount);
    }

    return {
      elements: kept,
      original_count: originalCount,
      pruned_count: prunedCount,
      estimated_tokens: usedTokens,
      budget_used_pct: Number(((usedTokens / activeBudget.element_budget) * 100).toFixed(1)),
      pruning_applied: prunedCount > 0,
    };
  }

  /**
   * Estimate total tokens for a snapshot (elements + metadata).
   */
  estimateSnapshotTokens(snapshot: SemanticSnapshot): number {
    const metadataTokens = this.estimateMetadataTokens(snapshot);
    const elementTokens = snapshot.elements.reduce(
      (total: number, el: SemanticElement) => total + this.estimateElementTokens(el),
      0
    );
    return metadataTokens + elementTokens;
  }

  /**
   * Estimate tokens for a single element.
   */
  estimateElementTokens(element: SemanticElement): number {
    let tokens = FIELD_WEIGHTS.base_overhead;

    for (const [key, value] of Object.entries(element)) {
      if (value === undefined || value === null) continue;

      if (typeof value === 'string') {
        tokens += Math.ceil(value.length / 4);
      } else if (Array.isArray(value)) {
        tokens += Math.ceil(JSON.stringify(value).length / 4);
      } else if (typeof value === 'object') {
        tokens += Math.ceil(JSON.stringify(value).length / 4);
      } else {
        tokens += 1;
      }
    }

    return tokens;
  }

  // --- Private ---

  private elementPriority(element: SemanticElement): number {
    let priority = TYPE_PRIORITY[element.type] ?? 20;

    // Boost elements with validation errors
    if ((element as any).validation_errors?.length > 0) priority += 20;

    // Boost elements with labels (more useful to LLM)
    if (element.label) priority += 5;

    // Boost disabled interactive elements (LLM needs to know they exist)
    if (element.disabled) priority += 3;

    // Penalize very long text content (diminishing returns)
    if (element.text && element.text.length > 200) priority -= 10;

    return priority;
  }

  private estimateMetadataTokens(snapshot: SemanticSnapshot): number {
    let tokens = 100; // Base: url, title, snapshot_id, version, timestamp
    tokens += Math.ceil((snapshot.available_actions?.length ?? 0) * 25); // ~25 tokens per action
    tokens += snapshot.session ? 30 : 0;
    tokens += snapshot.meta ? 40 : 0;
    tokens += snapshot.delta ? Math.ceil(JSON.stringify(snapshot.delta).length / 4) : 0;
    return tokens;
  }

  private resolveBudget(override?: Partial<TokenBudget>): TokenBudget {
    const budget = { ...this.defaultBudget, ...override };
    budget.element_budget = budget.max_tokens - budget.reserved_tokens;
    return budget;
  }
}
