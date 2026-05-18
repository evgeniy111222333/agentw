import { AvailableAction, SemanticElement, SemanticSnapshot } from '../common/types';
import { ACTION_RISK_SCORE } from './ActionExecutor';

/**
 * ActionValidator — Pre-flight validation of LLM actions against semantic state.
 *
 * From Concept 2.5.3 (Defensive Programming):
 *   "Every action is validated BEFORE execution. LLM never receives raw error
 *    messages — all errors are transformed into structured JSON objects with
 *    descriptions and suggestions."
 *
 * Concept §5.3: Three-stage validation:
 *   1. Syntactic — JSON matches spec (params schema)
 *   2. Semantic — element exists, visible, accessible
 *   3. Security — action doesn't violate policies
 *
 * Concept §6.3.2: Preconditions:
 *   element_visible, element_enabled, element_stable, no_modal_open, page_loaded, network_idle
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

/** Concept §5.5: Risk level thresholds for degraded states */
export type DegradationLevel = 'normal' | 'moderate' | 'severe';

/**
 * Required parameter schemas per action for syntactic validation (§5.3).
 */
const ACTION_PARAM_SCHEMAS: Record<string, { required?: string[]; optional?: string[] }> = {
  navigate: { required: ['url'], optional: ['wait_until', 'timeout', 'timeout_ms'] },
  click: { optional: ['button', 'click_count', 'timeout_ms'] },
  type: { required: ['text'], optional: ['clear', 'delay', 'press_enter', 'timeout_ms'] },
  select: { optional: ['value', 'label', 'timeout_ms'] },
  submit: { optional: ['timeout_ms'] },
  hover: { optional: ['timeout_ms'] },
  scroll: { optional: ['direction', 'amount'] },
  keyboard: { required: ['key'] },
  wait: { optional: ['ms', 'timeout', 'timeout_ms', 'condition', 'element_id', 'target_id'] },
  wait_for: { required: ['condition'], optional: ['timeout_ms', 'poll_interval_ms'] },
  fill_form: { required: ['fields'], optional: ['submit', 'rollback', 'on_failure', 'timeout_ms'] },
  fill_and_verify: { required: ['fields'], optional: ['on_failure', 'timeout_ms'] },
  multi_click: { optional: ['element_ids', 'target_ids', 'targets', 'continue_on_error'] },
  search_and_paginate: { required: ['query'], optional: ['submit', 'max_pages', 'collect_all_pages', 'next_id'] },
  navigate_and_extract: { required: ['url'], optional: ['extract_selector', 'wait_ms', 'timeout_ms', 'on_failure'] },
  login_flow: { optional: ['url', 'login_url', 'credentials', 'fields', 'form_id', 'submit_id', 'success_url', 'success_element', 'on_failure'] },
  async_navigate: { required: ['url'], optional: ['timeout_ms', 'estimated_time_ms'] },
  poll: { required: ['operation_id'] },
  cancel: { required: ['operation_id'] },
  sequence: { required: ['steps'], optional: ['stop_on_error'] },
  parallel: { optional: ['steps', 'actions', 'continue_on_error'] },
  'if': { required: ['condition'], optional: ['then', 'else'] },
  loop: { optional: ['while', 'condition', 'do', 'max_iterations', 'delay_ms'] },
  'try': { required: ['do'], optional: ['catch'] },
  define_script: { required: ['name', 'steps'], optional: ['params', 'parameters'] },
  call_script: { required: ['name'], optional: ['args', 'arguments', 'stop_on_error'] },
  upload: { optional: ['file_path', 'file_paths', 'file_content', 'file_name', 'files', 'timeout_ms'] },
  download: { optional: ['url', 'file_name', 'timeout_ms'] },
  screenshot: { optional: ['full_page', 'timeout_ms'] },
  screenshot_file: { optional: ['full_page', 'file_name', 'timeout_ms'] },
  pdf: { optional: ['file_name', 'format', 'landscape', 'print_background', 'scale', 'margin'] },
  fs: { optional: ['operation', 'op', 'path', 'file_path', 'content', 'base64', 'encoding', 'recursive'] },
  set_viewport: { optional: ['profile', 'width', 'height'] },
  go_forward: {},
  noop: {},
};

export class ActionValidator {
  /**
   * Validate an action against the current semantic snapshot.
   * Returns a structured result — never throws.
   */
  validate(
    action: string,
    targetId: string | undefined,
    params: any,
    snapshot: SemanticSnapshot | undefined,
    degradation: DegradationLevel = 'normal'
  ): ValidationResult {
    // Stage 1: Syntactic validation (§5.3)
    const syntactic = this.validateSyntax(action, params);
    if (!syntactic.valid) return syntactic;

    // Stage 3: Security / Risk validation (§8.4)
    const riskCheck = this.validateRisk(action, degradation);
    if (!riskCheck.valid) return riskCheck;

    // Actions that don't need a snapshot or target
    if (['navigate', 'go_back', 'go_forward', 'refresh', 'wait', 'keyboard', 'scroll', 'noop',
         'async_navigate', 'navigate_and_extract', 'login_flow',
         'poll', 'cancel', 'define_script', 'call_script', 'try'].includes(action) && !targetId) {
      return { valid: true };
    }

    // Target-based actions require a snapshot for pre-validation
    if (!snapshot) {
      return { valid: true }; // Can't validate without snapshot, let Playwright handle it
    }

    // Stage 2: Semantic validation (§5.3)
    if (targetId) {
      return this.validateTargetedAction(action, targetId, params, snapshot);
    }

    return { valid: true };
  }

  /**
   * Concept §5.3: Syntactic validation — check required params exist.
   */
  private validateSyntax(action: string, params: any): ValidationResult {
    const schema = ACTION_PARAM_SCHEMAS[action];
    if (!schema) return { valid: true }; // Unknown action — let dispatch handle it

    if (schema.required) {
      for (const key of schema.required) {
        if (params?.[key] === undefined) {
          return {
            valid: false,
            error: {
              code: 'MISSING_PARAM',
              message: `Parameter "${key}" is required for ${action} action.`,
              suggestion: `Provide a ${key} parameter.`,
              context: { action, required: schema.required },
            },
          };
        }
      }
    }

    if (action === 'select' && params?.value === undefined && params?.label === undefined) {
      return {
        valid: false,
        error: {
          code: 'MISSING_PARAM',
          message: 'select requires either value or label.',
          suggestion: 'Provide params.value or params.label.',
          context: { action },
        },
      };
    }

    if (action === 'click' && params?.button !== undefined && !['left', 'right', 'middle'].includes(params.button)) {
      return {
        valid: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'click button must be left, right, or middle.',
          suggestion: 'Use button: "left", "right", or "middle".',
          context: { action, button: params.button },
        },
      };
    }

    if (['fill_form', 'fill_and_verify', 'login_flow'].includes(action) && params?.on_failure !== undefined
      && !['rollback', 'continue', 'fail', 'fail_fast'].includes(params.on_failure)) {
      return {
        valid: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'on_failure must be rollback, continue, fail, or fail_fast.',
          suggestion: 'Use rollback for atomic behavior or continue for partial results.',
          context: { action, on_failure: params.on_failure },
        },
      };
    }

    return { valid: true };
  }

  /**
   * Concept §8.4: Risk-based degradation.
   * - moderate: block medium/high-risk (score >= 30) actions
   * - severe: also blocks medium/high-risk, leaving low-risk declarative actions only
   */
  private validateRisk(action: string, degradation: DegradationLevel): ValidationResult {
    if (degradation === 'normal') return { valid: true };

    const score = ACTION_RISK_SCORE[action] ?? 50;
    const threshold = 30;

    if (score >= threshold) {
      return {
        valid: false,
        error: {
          code: 'ACTION_PRECONDITION_FAILED',
          message: `Action "${action}" blocked due to ${degradation} degradation (risk_score=${score}, threshold=${threshold}).`,
          suggestion: degradation === 'severe'
            ? 'Only low-risk actions are allowed during severe degradation.'
            : 'Reduce risk by using simpler actions or wait for system recovery.',
          context: { risk_score: score, degradation, threshold },
        },
      };
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

    // Check visibility (precondition: element_visible)
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

    // Check disabled state (precondition: element_enabled)
    if (element.disabled === true && ['click', 'type', 'submit', 'select', 'fill_form', 'fill_and_verify'].includes(action)) {
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

    const available = snapshot.available_actions.find((candidate) =>
      candidate.target === targetId && (candidate.action === action || candidate.execution?.action === action)
    );
    const preconditions = new Set<string>([
      ...defaultPreconditions(action),
      ...(available?.preconditions ?? []),
      ...preconditionsFromParams(params),
    ]);

    if (preconditions.has('element_stable') && element.stable === false) {
      return {
        valid: false,
        error: {
          code: 'ELEMENT_NOT_STABLE',
          message: `Element "${targetId}" is not stable enough for "${action}".`,
          suggestion: 'Wait for animation/layout changes to finish, then retry.',
          context: { element_type: element.type },
        },
      };
    }

    if (preconditions.has('no_modal_open') && this.hasBlockingModal(snapshot, element)) {
      return {
        valid: false,
        error: {
          code: 'MODAL_OPEN',
          message: `A modal is open and may block "${targetId}".`,
          suggestion: 'Close or interact with the modal before targeting background content.',
          context: { target_id: targetId },
        },
      };
    }

    // Semantic type checks
    const typeErrors = this.validateActionElementType(action, element);
    if (typeErrors) return typeErrors;

    return { valid: true };
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

  private hasBlockingModal(snapshot: SemanticSnapshot, element: SemanticElement): boolean {
    const byId = new Map(snapshot.elements.map((candidate) => [candidate.id, candidate]));
    const ancestors = new Set<string>();
    let cursor: SemanticElement | undefined = element;
    while (cursor?.parent_id) {
      ancestors.add(cursor.parent_id);
      cursor = byId.get(cursor.parent_id);
    }
    return snapshot.elements.some((candidate) =>
      ['modal', 'dialog'].includes(candidate.type)
      && candidate.visible !== false
      && candidate.id !== element.id
      && !ancestors.has(candidate.id)
    );
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

function defaultPreconditions(action: string): string[] {
  if (['click', 'type', 'select', 'submit', 'hover', 'interact', 'fill_form', 'fill_and_verify'].includes(action)) {
    return ['element_visible', 'element_enabled', 'element_stable', 'no_modal_open', 'page_loaded'];
  }
  return [];
}

function preconditionsFromParams(params: any): string[] {
  const value = params?.preconditions;
  if (!value) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}
