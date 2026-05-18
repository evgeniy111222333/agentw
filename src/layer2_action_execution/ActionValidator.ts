import { AvailableAction, SemanticElement, SemanticSnapshot } from '../common/types';

/**
 * ActionValidator — Pre-flight validation of LLM actions against semantic state.
 *
 * From Concept 2.5.3 (Defensive Programming):
 *   "Every action is validated BEFORE execution. LLM never receives raw error
 *    messages — all errors are transformed into structured JSON objects with
 *    descriptions and suggestions."
 *
 * This validator uses the CURRENT semantic snapshot to catch problems
 * before they reach Playwright, saving ~150ms per failed action and
 * providing better error messages to the LLM.
 */

export interface ValidationResult {
  valid: boolean;
  error?: {
    code: string;
    message: string;
    suggestion?: string;
    context?: Record<string, any>;
  };
}

export class ActionValidator {
  /**
   * Validate an action against the current semantic snapshot.
   * Returns a structured result — never throws.
   */
  validate(
    action: string,
    targetId: string | undefined,
    params: any,
    snapshot: SemanticSnapshot | undefined
  ): ValidationResult {
    // Actions that don't need a snapshot or target
    if (['navigate', 'go_back', 'refresh', 'wait', 'keyboard', 'scroll'].includes(action) && !targetId) {
      return this.validateParams(action, params);
    }

    // Target-based actions require a snapshot for pre-validation
    if (!snapshot) {
      return { valid: true }; // Can't validate without snapshot, let Playwright handle it
    }

    if (targetId) {
      return this.validateTargetedAction(action, targetId, params, snapshot);
    }

    return { valid: true };
  }

  private validateTargetedAction(
    action: string,
    targetId: string,
    params: any,
    snapshot: SemanticSnapshot
  ): ValidationResult {
    // Find element in snapshot
    const element = snapshot.elements.find((el) => el.id === targetId);
    if (!element) {
      // Try to find similar elements for suggestion
      const similar = this.findSimilar(targetId, snapshot.elements);
      return {
        valid: false,
        error: {
          code: 'ELEMENT_NOT_FOUND',
          message: `Element "${targetId}" not found in current page snapshot.`,
          suggestion: similar.length > 0
            ? `Did you mean one of: ${similar.map((s) => `"${s.id}" (${s.type}: ${s.label || s.text || ''})`).join(', ')}?`
            : 'Use browser_snapshot to get the current page state before acting.',
          context: { available_count: snapshot.elements.length },
        },
      };
    }

    // Check visibility
    if (element.visible === false) {
      return {
        valid: false,
        error: {
          code: 'ELEMENT_NOT_VISIBLE',
          message: `Element "${targetId}" exists but is not visible.`,
          suggestion: 'Scroll to make the element visible, or try a different element.',
          context: { element_type: element.type },
        },
      };
    }

    // Check disabled state
    if (element.disabled === true && ['click', 'type', 'submit', 'select', 'fill_form'].includes(action)) {
      return {
        valid: false,
        error: {
          code: 'ELEMENT_DISABLED',
          message: `Element "${targetId}" is disabled and cannot receive "${action}".`,
          suggestion: 'Check if there are prerequisite fields to fill or conditions to meet before this element becomes active.',
          context: { element_type: element.type, element_label: element.label },
        },
      };
    }

    // Semantic type checks
    const typeErrors = this.validateActionElementType(action, element);
    if (typeErrors) return typeErrors;

    // Action-specific parameter validation
    return this.validateParams(action, params);
  }

  private validateActionElementType(action: string, element: SemanticElement): ValidationResult | null {
    switch (action) {
      case 'type':
        if (!['input', 'textarea', 'combobox', 'search'].includes(element.type)) {
          return {
            valid: false,
            error: {
              code: 'TYPE_MISMATCH',
              message: `Cannot type into element "${element.id}" of type "${element.type}".`,
              suggestion: `Look for an input or textarea element instead. This element is a ${element.type}.`,
              context: { element_type: element.type },
            },
          };
        }
        break;

      case 'select':
        if (!['select', 'combobox', 'listbox'].includes(element.type)) {
          return {
            valid: false,
            error: {
              code: 'TYPE_MISMATCH',
              message: `Cannot select on element "${element.id}" of type "${element.type}".`,
              suggestion: 'Look for a <select> dropdown or listbox element.',
              context: { element_type: element.type },
            },
          };
        }
        break;

      case 'submit':
        if (!['form', 'button', 'input'].includes(element.type)) {
          return {
            valid: false,
            error: {
              code: 'TYPE_MISMATCH',
              message: `Cannot submit element "${element.id}" of type "${element.type}".`,
              suggestion: 'Look for a form or submit button.',
              context: { element_type: element.type },
            },
          };
        }
        break;
    }

    return null;
  }

  private validateParams(action: string, params: any): ValidationResult {
    switch (action) {
      case 'navigate':
        if (!params?.url) {
          return {
            valid: false,
            error: {
              code: 'MISSING_PARAM',
              message: 'URL is required for navigate action.',
              suggestion: 'Provide a url parameter: { "url": "https://example.com" }',
            },
          };
        }
        break;

      case 'type':
        if (params?.text === undefined) {
          return {
            valid: false,
            error: {
              code: 'MISSING_PARAM',
              message: 'Text is required for type action.',
              suggestion: 'Provide a text parameter: { "text": "your text" }',
            },
          };
        }
        break;

      case 'select':
        if (params?.value === undefined || params.value === null || params.value === '') {
          return {
            valid: false,
            error: {
              code: 'MISSING_PARAM',
              message: 'Value is required for select action.',
              suggestion: 'Provide a value parameter: { "value": "option_value" }',
            },
          };
        }
        break;

      case 'keyboard':
        if (!params?.key) {
          return {
            valid: false,
            error: {
              code: 'MISSING_PARAM',
              message: 'Key is required for keyboard action.',
              suggestion: 'Provide a key parameter: { "key": "Enter" }',
            },
          };
        }
        break;
    }

    return { valid: true };
  }

  private findSimilar(targetId: string, elements: SemanticElement[]): SemanticElement[] {
    const target = targetId.toLowerCase();
    return elements
      .filter((el) => {
        if (!el.id) return false;
        const id = el.id.toLowerCase();
        // Fuzzy match: contains part of the target or target contains part of the id
        return id.includes(target) || target.includes(id) || this.levenshteinSimilar(id, target);
      })
      .slice(0, 3);
  }

  private levenshteinSimilar(a: string, b: string): boolean {
    if (Math.abs(a.length - b.length) > 5) return false;
    let diff = 0;
    const min = Math.min(a.length, b.length);
    for (let i = 0; i < min; i++) {
      if (a[i] !== b[i]) diff++;
    }
    diff += Math.abs(a.length - b.length);
    return diff <= 3;
  }
}
