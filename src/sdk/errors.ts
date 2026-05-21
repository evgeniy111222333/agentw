export class LlmBrowserApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly recoverable = false,
    readonly context: Record<string, any> = {}
  ) {
    super(message);
    this.name = 'LlmBrowserApiError';
  }
}

export class PrismApiError extends LlmBrowserApiError {
  constructor(
    message: string,
    code: string,
    status?: number,
    recoverable = false,
    context: Record<string, any> = {}
  ) {
    super(message, code, status, recoverable, context);
    this.name = 'PrismApiError';
  }
}

export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof LlmBrowserApiError)) return false;
  if (error.status === 429 || error.status === 408 || error.status === 502 || error.status === 503) return true;
  return error.recoverable;
}
