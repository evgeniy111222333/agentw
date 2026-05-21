export interface FlowStep {
  action: string;
  target_id?: string;
  element_id?: string;
  params?: Record<string, any>;
  action_params?: Record<string, any>;
  parameters?: Record<string, any>;
}

export interface FlowStepResult {
  index: number;
  action: string;
  target_id?: string;
  status: 'success' | 'error' | 'skipped';
  duration_ms: number;
  data?: Record<string, any>;
  error?: string;
  error_code?: string;
}

export interface FlowReport {
  mode: string;
  completed: number;
  failed: number;
  skipped: number;
  steps: FlowStepResult[];
}

export const FLOW_ACTIONS = new Set([
  'fill_form',
  'fill_and_verify',
  'multi_click',
  'sequence',
  'parallel',
  'if',
  'loop',
  'wait_for',
  'search_and_paginate',
  'navigate_and_extract',
  'login_flow',
  'async_navigate',
  'try',
  'define_script',
  'call_script',
  'noop',
]);

export const PAR_ACTIONS = new Set([
  'click',
  'hover',
  'keyboard',
  'scroll',
  'scroll_to_element',
  'select',
  'type',
  'wait',
]);

export function stepParams(step: FlowStep): Record<string, any> {
  return step.params ?? step.action_params ?? step.parameters ?? {};
}

export function stepTarget(step: FlowStep): string | undefined {
  const params = stepParams(step);
  return step.target_id ?? step.element_id ?? params.target_id ?? params.element_id;
}

export function assertSteps(value: unknown, label: string, max: number): FlowStep[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > max) throw new Error(`${label} exceeds max ${max}`);
  for (const [index, step] of value.entries()) {
    if (!step || typeof step !== 'object' || typeof step.action !== 'string') {
      throw new Error(`${label}[${index}] must include action`);
    }
  }
  return value as FlowStep[];
}

export function report(mode: string, steps: FlowStepResult[]): FlowReport {
  return {
    mode,
    completed: steps.filter((step) => step.status === 'success').length,
    failed: steps.filter((step) => step.status === 'error').length,
    skipped: steps.filter((step) => step.status === 'skipped').length,
    steps,
  };
}
