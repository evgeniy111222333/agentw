export type LlmBrowserErrorCode =
  | 'ACCESS_DENIED'
  | 'ACTION_PRECONDITION_FAILED'
  | 'ELEMENT_NOT_FOUND'
  | 'EXTRACTION_FAILED'
  | 'INTERNAL_ERROR'
  | 'INVALID_ACTION'
  | 'INVALID_PARAMS'
  | 'MISSING_PARAM'
  | 'NAVIGATION_FAILED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'SECURITY_VIOLATION'
  | 'SESSION_NOT_FOUND'
  | 'TIMEOUT_ACTION';

const httpStatusByCode: Record<LlmBrowserErrorCode, number> = {
  ACCESS_DENIED: 403,
  ACTION_PRECONDITION_FAILED: 409,
  ELEMENT_NOT_FOUND: 404,
  EXTRACTION_FAILED: 500,
  INTERNAL_ERROR: 500,
  INVALID_ACTION: 400,
  INVALID_PARAMS: 400,
  MISSING_PARAM: 400,
  NAVIGATION_FAILED: 502,
  RATE_LIMIT_EXCEEDED: 429,
  SECURITY_VIOLATION: 403,
  SESSION_NOT_FOUND: 404,
  TIMEOUT_ACTION: 408,
};

const recoverableByCode: Record<LlmBrowserErrorCode, boolean> = {
  ACCESS_DENIED: false,
  ACTION_PRECONDITION_FAILED: true,
  ELEMENT_NOT_FOUND: true,
  EXTRACTION_FAILED: true,
  INTERNAL_ERROR: false,
  INVALID_ACTION: false,
  INVALID_PARAMS: false,
  MISSING_PARAM: false,
  NAVIGATION_FAILED: true,
  RATE_LIMIT_EXCEEDED: true,
  SECURITY_VIOLATION: false,
  SESSION_NOT_FOUND: false,
  TIMEOUT_ACTION: true,
};

export class LlmBrowserError extends Error {
  readonly httpStatus: number;
  readonly recoverable: boolean;

  constructor(
    readonly code: LlmBrowserErrorCode,
    message: string,
    readonly context: Record<string, any> = {}
  ) {
    super(message);
    this.name = 'LlmBrowserError';
    this.httpStatus = httpStatusByCode[code];
    this.recoverable = recoverableByCode[code];
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
  if (/timeout/i.test(message)) return 'TIMEOUT_ACTION';
  if (/not found|no element|locator/i.test(message)) return 'ELEMENT_NOT_FOUND';
  if (/navigation|goto|net::|url/i.test(message)) return 'NAVIGATION_FAILED';
  if (/target id|required|unsupported|unknown action/i.test(message)) return 'INVALID_ACTION';
  if (/disabled|visible|precondition/i.test(message)) return 'ACTION_PRECONDITION_FAILED';
  return 'INTERNAL_ERROR';
}
