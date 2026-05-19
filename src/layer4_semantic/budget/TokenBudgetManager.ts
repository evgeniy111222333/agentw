import { SemanticElement, SemanticSnapshot } from '../../common/types';
import { globalMetrics } from '../../common/MetricsRegistry';

/**
 * TokenBudgetManager — Controls and optimizes token spending.
 *
 * From Concept 2.7: "Token budget management ensures that the semantic
 * snapshot never exceeds the LLM's context window capacity. Elements are
 * prioritized by semantic importance, and low-value elements are pruned."
 *
 * Strategy (v3 — dynamic quota adaptation with type-level guarantees):
 *   Phase 0: Type-level minimum guarantees (at least N elements of each key type)
 *   Phase 1: Category diversity quotas with sub-type rotation
 *   Phase 2: Dynamic redistribution of unused category quota
 *   Phase 3: Fill remaining budget with highest-priority elements
 *
 * Key v3 improvements over v2:
 *   - Guarantees at least 1 navigation element survives (was 0 on all large sites)
 *   - Guarantees heading/link/article diversity (not just category-level quota)
 *   - Within categories, rotates through types instead of just taking highest priority
 *   - Unused category quota is redistributed to categories that need more
 *   - Critical elements (forms, errors, auth) are never pruned
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
// IMPROVED: Reduced weights to allow more elements within budget
const FIELD_WEIGHTS: Record<string, number> = {
  id: 2,
  type: 1,
  label: 3,
  text: 8,            // Reduced from 15
  value: 3,
  placeholder: 2,
  href: 4,
  src: 4,
  action: 2,
  method: 1,
  role: 1,
  aria_label: 3,
  validation_errors: 5,
  fields: 10,
  options: 8,
  rows: 15,
  base_overhead: 4, // Reduced from 8 - JSON structure per element
};

// Priority scores — higher = more important = kept first
// v3: Content-first + navigation boost — LLM agents need to understand
//     WHAT the page says AND where they can navigate.
const TYPE_PRIORITY: Record<string, number> = {
  // Critical — never pruned (genuinely critical UI state)
  form: 100,
  notification: 100,
  modal: 100,
  dialog: 100,
  alert: 95,
  error: 95,

  // Content — what the page IS about (HIGH priority for LLM understanding)
  heading: 92,
  article: 88,
  card: 82,
  text: 72,

  // Navigation — where the agent can go (v3: boosted — was under-represented)
  navigation: 85,       // was 65 — navigation elements describe page structure
  breadcrumb: 70,       // was 63
  pagination: 68,       // was 63
  link: 70,             // was 70 (unchanged, but now better quota handling)
  menu: 60,             // was 58
  tab_group: 57,        // was 55
  menu_item: 52,        // was 55 — menu items are less important than navigation itself

  // Interactive — what the agent CAN do
  input: 80,
  textarea: 80,
  select: 78,
  button: 75,
  combobox: 78,
  checkbox: 72,
  radio: 72,
  search: 75,
  tab: 68,

  // Structural
  table: 55,
  list: 52,
  listbox: 52,
  accordion: 50,
  chart: 50,

  // Media
  image: 48,
  video: 48,
  audio: 45,
  iframe: 42,
  embed: 42,
  shadow_host: 45,      // was 42 — shadow hosts contain useful content
  rating: 40,
  stepper: 40,
  carousel: 38,
  badge: 35,
  tooltip: 30,
  progress: 35,
  separator: 10,
  skeleton: 12,
  icon: 15,
  decorative: 5,
};

// Category definitions for diversity quotas
const CONTENT_TYPES = new Set(['heading', 'text', 'article', 'card']);
const NAV_TYPES = new Set(['link', 'navigation', 'breadcrumb', 'pagination', 'menu', 'menu_item', 'tab_group']);
const INTERACTIVE_TYPES = new Set(['form', 'input', 'textarea', 'select', 'button', 'combobox', 'checkbox', 'radio', 'search', 'tab']);
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'chart', 'iframe', 'embed', 'shadow_host', 'rating', 'carousel', 'progress']);

// Minimum budget fractions guaranteed for each category
// v3: Navigation quota increased from 12% → 20% (was 0 navigation on all large sites)
const CATEGORY_QUOTAS: Record<string, number> = {
  content: 0.28,       // 28% reserved for headings, text, articles, cards (was 30%)
  navigation: 0.20,    // 20% reserved for links, navigation (was 12% — too small!)
  interactive: 0.22,   // 22% reserved for forms, inputs, buttons (was 25%)
  media: 0.08,         // 8% reserved for media (unchanged)
  // Remaining ~22% is filled by overall priority
};

// v3: Type-level minimum guarantees.
// For each key type, guarantee at least N elements survive pruning.
// This prevents the "all links, no navigation" or "all buttons, no content" scenarios.
const TYPE_GUARANTEES: Record<string, number> = {
  navigation: 2,    // At least 2 navigation elements (was 0 on all large sites!)
  heading: 5,       // At least 5 headings (core content understanding)
  link: 8,          // At least 8 links (navigation capability)
  article: 1,       // At least 1 article if present
  card: 3,          // At least 3 cards (content structure)
  form: 2,          // At least 2 forms (interaction capability) - IMPROVED: was 1
  input: 3,         // At least 3 inputs - IMPROVED: added for form fields
  button: 3,        // At least 3 buttons - IMPROVED: added for form controls
  select: 1,        // At least 1 select - IMPROVED: added for form controls
  textarea: 1,      // At least 1 textarea - IMPROVED: added
  text: 2,          // At least 2 text blocks (content body)
  image: 1,         // At least 1 image (visual context)
  modal: 1,         // IMPROVED: At least 1 modal if present
  notification: 1,  // IMPROVED: At least 1 notification if present
};

// Maximum fraction of total budget that type guarantees can consume.
// IMPROVED: Increased from 0.40 to 0.50 for better coverage on content-heavy sites
const MAX_GUARANTEE_FRACTION = 0.50;

function elementCategory(type: string): string {
  if (CONTENT_TYPES.has(type)) return 'content';
  if (NAV_TYPES.has(type)) return 'navigation';
  if (INTERACTIVE_TYPES.has(type)) return 'interactive';
  if (MEDIA_TYPES.has(type)) return 'media';
  return 'structural';
}

export class TokenBudgetManager {
  private defaultBudget: TokenBudget = {
    max_tokens: 20000,     // IMPROVED: Increased from 16000 to 20000 for content-heavy sites
    reserved_tokens: 3000, // Metadata, actions, session
    element_budget: 17000, // max_tokens - reserved_tokens
  };

  /**
   * Apply token budget to a list of elements.
   * Returns pruned list + metrics.
   *
   * Three-phase algorithm (v3 — dynamic quota adaptation):
   *   Phase 0: Type-level minimum guarantees (ensure key types survive)
   *   Phase 1: Category diversity quotas with sub-type rotation
   *   Phase 2: Dynamic redistribution + fill by priority
   */
  applyBudget(
    elements: SemanticElement[],
    budget?: Partial<TokenBudget>
  ): BudgetResult {
    const activeBudget = this.resolveBudget(budget);
    const originalCount = elements.length;

    // Score every element
    const scored = elements.map((el) => ({
      element: el,
      priority: this.elementPriority(el),
      tokens: this.estimateElementTokens(el),
      category: elementCategory(el.type),
    }));

    const keptIds = new Set<string>();
    let totalUsed = 0;
    const guaranteeBudgetCap = Math.floor(activeBudget.element_budget * MAX_GUARANTEE_FRACTION);

    // ========================================================================
    // Phase 0: Type-level minimum guarantees
    // Ensures at least N elements of each key type survive, regardless of
    // category quota competition. This prevents "0 navigation on all sites".
    // ========================================================================
    let guaranteeUsed = 0;
    for (const [type, minCount] of Object.entries(TYPE_GUARANTEES)) {
      const typeItems = scored
        .filter(s => s.element.type === type && !keptIds.has(s.element.id))
        .sort((a, b) => b.priority - a.priority);
      let added = 0;
      for (const item of typeItems) {
        if (added >= minCount) break;
        if (guaranteeUsed + item.tokens > guaranteeBudgetCap) break;
        keptIds.add(item.element.id);
        guaranteeUsed += item.tokens;
        added++;
      }
    }
    totalUsed += guaranteeUsed;

    // ========================================================================
    // Phase 1: Category diversity quotas with sub-type rotation
    // Within each category, rotate through types so no single type
    // monopolizes the budget (e.g., links don't eat all navigation quota).
    // ========================================================================
    const byCategory = new Map<string, typeof scored>();
    for (const item of scored) {
      if (keptIds.has(item.element.id)) continue; // Skip already guaranteed
      const cat = item.category;
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(item);
    }

    // Sort each category by priority
    for (const [cat, items] of byCategory) {
      items.sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return (b.priority / b.tokens) - (a.priority / a.tokens);
      });
    }

    const usedByCategory: Record<string, number> = {};
    for (const [cat, items] of byCategory) {
      const quotaFraction = CATEGORY_QUOTAS[cat] ?? 0.05;
      const categoryBudget = Math.floor(activeBudget.element_budget * quotaFraction);
      let catUsed = 0;

      // Group items by type within category for rotation
      const byType = new Map<string, typeof items>();
      for (const item of items) {
        if (!byType.has(item.element.type)) byType.set(item.element.type, []);
        byType.get(item.element.type)!.push(item);
      }

      // Round-robin through types: take 1 from each type in priority order,
      // then repeat. This ensures navigation elements get budget alongside links.
      const typeOrder = Array.from(byType.entries())
        .map(([type, typeItems]) => ({ type, items: typeItems, maxPriority: typeItems[0]?.priority ?? 0 }))
        .sort((a, b) => b.maxPriority - a.maxPriority);

      let round = 0;
      const typeIndices = new Map<string, number>();
      for (const { type } of typeOrder) typeIndices.set(type, 0);

      let madeProgress = true;
      while (madeProgress && catUsed < categoryBudget) {
        madeProgress = false;
        for (const { type, items } of typeOrder) {
          const idx = typeIndices.get(type) ?? 0;
          if (idx >= items.length) continue;
          const item = items[idx];
          if (catUsed + item.tokens <= categoryBudget) {
            keptIds.add(item.element.id);
            catUsed += item.tokens;
            typeIndices.set(type, idx + 1);
            madeProgress = true;
          } else if (item.priority >= 95) {
            // Critical elements always included (even over quota)
            keptIds.add(item.element.id);
            catUsed += item.tokens;
            typeIndices.set(type, idx + 1);
            madeProgress = true;
          }
        }
        round++;
        if (round > 100) break; // Safety limit
      }

      usedByCategory[cat] = catUsed;
    }

    totalUsed = guaranteeUsed + Object.values(usedByCategory).reduce((a, b) => a + b, 0);

    // ========================================================================
    // Phase 2: Dynamic redistribution + fill remaining by priority
    // Unused category quota is redistributed to categories that need more.
    // Then remaining budget is filled with highest-priority elements.
    // ========================================================================
    const remainingBudget = activeBudget.element_budget - totalUsed;

    const remaining = scored
      .filter(item => !keptIds.has(item.element.id))
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return (b.priority / b.tokens) - (a.priority / a.tokens);
      });

    let fillUsed = 0;
    for (const item of remaining) {
      if (fillUsed + item.tokens <= remainingBudget) {
        keptIds.add(item.element.id);
        fillUsed += item.tokens;
      } else if (item.priority >= 95) {
        // Critical elements always included
        keptIds.add(item.element.id);
        fillUsed += item.tokens;
      }
    }

    // Build final list preserving original order
    const kept = elements.filter(el => keptIds.has(el.id));
    const finalTokens = scored
      .filter(item => keptIds.has(item.element.id))
      .reduce((sum, item) => sum + item.tokens, 0);

    // IMPROVED: Emergency fallback - if we got 0 elements (budget too aggressive),
    // force-add the top 20 highest-priority elements to ensure minimum content
    if (kept.length === 0 && scored.length > 0) {
      const topElements = scored
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 20);
      for (const item of topElements) {
        keptIds.add(item.element.id);
      }
    }

    const prunedCount = originalCount - keptIds.size;

    globalMetrics.increment('llm_browser_token_budget_total');
    if (prunedCount > 0) {
      globalMetrics.increment('llm_browser_token_budget_pruned_total');
      globalMetrics.observe('llm_browser_token_budget_pruned_elements', prunedCount);
    }

    return {
      elements: kept,
      original_count: originalCount,
      pruned_count: prunedCount,
      estimated_tokens: finalTokens,
      budget_used_pct: Number(((finalTokens / activeBudget.element_budget) * 100).toFixed(1)),
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