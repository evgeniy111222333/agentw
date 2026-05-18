export type LlmBrowserErrorCode =
  | 'ACCESS_DENIED'
  | 'ACTION_PRECONDITION_FAILED'
  | 'ELEMENT_DISABLED'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'ELEMENT_NOT_STABLE'
  | 'ELEMENT_NOT_VISIBLE'
  | 'EXTRACTION_FAILED'
  | 'INTERNAL_ERROR'
  | 'INVALID_ACTION'
  | 'INVALID_PARAMS'
  | 'MISSING_PARAM'
  | 'MODAL_OPEN'
  | 'NAVIGATION_FAILED'
  | 'NETWORK_ERROR'
  | 'PAGE_NOT_LOADED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'SCRIPT_NOT_FOUND'
  | 'SECURITY_VIOLATION'
  | 'SESSION_NOT_FOUND'
  | 'STALE_ELEMENT'
  | 'TIMEOUT_ACTION'
  | 'TYPE_MISMATCH'
  | 'VALIDATION_ERROR';

/**
 * Concept §5.5: Error Classification
 * Three classes determine retry behavior.
 */
export type ActionErrorClass = 'transient' | 'permanent' | 'external';

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  backoffMultiplier: number;
}

export const RETRY_CONFIG: Record<ActionErrorClass, RetryConfig> = {
  transient: { maxAttempts: 3, baseDelayMs: 100, backoffMultiplier: 2 },
  permanent: { maxAttempts: 1, baseDelayMs: 0, backoffMultiplier: 1 },
  external:  { maxAttempts: 3, baseDelayMs: 1000, backoffMultiplier: 2 },
};

const httpStatusByCode: Record<LlmBrowserErrorCode, number> = {
  ACCESS_DENIED: 403,
  ACTION_PRECONDITION_FAILED: 409,
  ELEMENT_DISABLED: 409,
  ELEMENT_NOT_FOUND: 404,
  ELEMENT_NOT_INTERACTABLE: 409,
  ELEMENT_NOT_STABLE: 409,
  ELEMENT_NOT_VISIBLE: 409,
  EXTRACTION_FAILED: 500,
  INTERNAL_ERROR: 500,
  INVALID_ACTION: 400,
  INVALID_PARAMS: 400,
  MISSING_PARAM: 400,
  MODAL_OPEN: 409,
  NAVIGATION_FAILED: 502,
  NETWORK_ERROR: 502,
  PAGE_NOT_LOADED: 409,
  RATE_LIMIT_EXCEEDED: 429,
  SCRIPT_NOT_FOUND: 404,
  SECURITY_VIOLATION: 403,
  SESSION_NOT_FOUND: 404,
  STALE_ELEMENT: 409,
  TIMEOUT_ACTION: 408,
  TYPE_MISMATCH: 400,
  VALIDATION_ERROR: 400,
};

const errorClassByCode: Record<LlmBrowserErrorCode, ActionErrorClass> = {
  ACCESS_DENIED: 'permanent',
  ACTION_PRECONDITION_FAILED: 'transient',
  ELEMENT_DISABLED: 'permanent',
  ELEMENT_NOT_FOUND: 'permanent',
  ELEMENT_NOT_INTERACTABLE: 'permanent',
  ELEMENT_NOT_STABLE: 'transient',
  ELEMENT_NOT_VISIBLE: 'transient',
  EXTRACTION_FAILED: 'transient',
  INTERNAL_ERROR: 'permanent',
  INVALID_ACTION: 'permanent',
  INVALID_PARAMS: 'permanent',
  MISSING_PARAM: 'permanent',
  MODAL_OPEN: 'transient',
  NAVIGATION_FAILED: 'external',
  NETWORK_ERROR: 'external',
  PAGE_NOT_LOADED: 'transient',
  RATE_LIMIT_EXCEEDED: 'external',
  SCRIPT_NOT_FOUND: 'permanent',
  SECURITY_VIOLATION: 'permanent',
  SESSION_NOT_FOUND: 'permanent',
  STALE_ELEMENT: 'transient',
  TIMEOUT_ACTION: 'transient',
  TYPE_MISMATCH: 'permanent',
  VALIDATION_ERROR: 'permanent',
};

const recoverableByCode: Record<LlmBrowserErrorCode, boolean> = {
  ACCESS_DENIED: false,
  ACTION_PRECONDITION_FAILED: true,
  ELEMENT_DISABLED: false,
  ELEMENT_NOT_FOUND: false,
  ELEMENT_NOT_INTERACTABLE: false,
  ELEMENT_NOT_STABLE: true,
  ELEMENT_NOT_VISIBLE: true,
  EXTRACTION_FAILED: true,
  INTERNAL_ERROR: false,
  INVALID_ACTION: false,
  INVALID_PARAMS: false,
  MISSING_PARAM: false,
  MODAL_OPEN: true,
  NAVIGATION_FAILED: true,
  NETWORK_ERROR: true,
  PAGE_NOT_LOADED: true,
  RATE_LIMIT_EXCEEDED: true,
  SCRIPT_NOT_FOUND: false,
  SECURITY_VIOLATION: false,
  SESSION_NOT_FOUND: false,
  STALE_ELEMENT: true,
  TIMEOUT_ACTION: true,
  TYPE_MISMATCH: false,
  VALIDATION_ERROR: false,
};

export class LlmBrowserError extends Error {
  readonly httpStatus: number;
  readonly recoverable: boolean;
  readonly errorClass: ActionErrorClass;

  constructor(
    readonly code: LlmBrowserErrorCode,
    message: string,
    readonly context: Record<string, any> = {}
  ) {
    super(message);
    this.name = 'LlmBrowserError';
    this.httpStatus = httpStatusByCode[code];
    this.recoverable = recoverableByCode[code];
    this.errorClass = errorClassByCode[code];
  }
}

export function normalizeError(error: unknown, context: Record<string, any> = {}): LlmBrowserError {
  if (error instanceof LlmBrowserError) {
    return new LlmBrowserError(error.code, error.message, { ...error.context, ...context });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new LlmBrowserError(classifyErrorCode(message), message, context);
}

export function classifyErrorCode(message: string): LlmBrowserErrorCode {
  if (/rate limit/i.test(message)) return 'RATE_LIMIT_EXCEEDED';
  if (/access denied|permission/i.test(message)) return 'ACCESS_DENIED';
  if (/security|blocked|whitelist|blacklist|domain/i.test(message)) return 'SECURITY_VIOLATION';
  if (/stale|detached|disposed/i.test(message)) return 'STALE_ELEMENT';
  if (/not visible|invisible|hidden/i.test(message)) return 'ELEMENT_NOT_VISIBLE';
  if (/disabled/i.test(message)) return 'ELEMENT_DISABLED';
  if (/not interactable/i.test(message)) return 'ELEMENT_NOT_INTERACTABLE';
  if (/timeout/i.test(message)) return 'TIMEOUT_ACTION';
  if (/not found|no element|locator/i.test(message)) return 'ELEMENT_NOT_FOUND';
  if (/net::|dns|econnrefused|enotfound/i.test(message)) return 'NETWORK_ERROR';
  if (/navigation|goto|url/i.test(message)) return 'NAVIGATION_FAILED';
  if (/target id|required|unsupported|unknown action/i.test(message)) return 'INVALID_ACTION';
  if (/precondition/i.test(message)) return 'ACTION_PRECONDITION_FAILED';
  if (/modal|dialog/i.test(message)) return 'MODAL_OPEN';
  if (/type mismatch/i.test(message)) return 'TYPE_MISMATCH';
  if (/validation/i.test(message)) return 'VALIDATION_ERROR';
  return 'INTERNAL_ERROR';
}

/**
 * Concept §5.5: Classify an error for retry strategy.
 * Returns the error class that determines retry behavior.
 */
export function classifyActionError(error: unknown): { code: LlmBrowserErrorCode; errorClass: ActionErrorClass } {
  if (error instanceof LlmBrowserError) {
    return { code: error.code, errorClass: error.errorClass };
  }
  const code = classifyErrorCode(error instanceof Error ? error.message : String(error));
  return { code, errorClass: errorClassByCode[code] };
}

/**
 * Concept §5.5: Calculate retry delay with exponential backoff.
 */
export function retryDelay(errorClass: ActionErrorClass, attempt: number): number {
  const config = RETRY_CONFIG[errorClass];
  return config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);
}

/**
 * Concept §5.5: Check if an error class allows retry.
 */
export function shouldRetry(errorClass: ActionErrorClass, attempt: number): boolean {
  return attempt < RETRY_CONFIG[errorClass].maxAttempts - 1;
}
