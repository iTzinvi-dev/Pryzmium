export type ErrorCategory = '4xx' | '5xx' | 'network';

export type CustomErrorCode =
  | 'INVALID_JSON_PAYLOAD'
  | 'PAYLOAD_TOO_LARGE'
  | 'VALIDATION_FAILED'
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_UID_MISMATCH'
  | 'AUTH_ACCOUNT_EXISTS'
  | 'FORBIDDEN_ORIGIN'
  | 'FORBIDDEN_ACTION'
  | 'RESOURCE_NOT_FOUND'
  | 'ENDPOINT_NOT_FOUND'
  | 'ACTION_EXPIRED'
  | 'SIGNATURE_TAMPERED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'QUOTA_EXHAUSTED'
  | 'TOOL_NOT_REGISTERED'
  | 'TOOL_EXECUTION_FAILED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_PROVIDER_ERROR'
  | 'INTERNAL_SERVER_ERROR';

export interface SerializedCustomError {
  ok: false;
  code: CustomErrorCode;
  statusCode: number;
  category: ErrorCategory;
  title: string;
  error: string;
  hint: string;
  endpoint: string;
  timestamp: string;
  retryAfterSec?: number;
}

const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z\-_]{25,}/g,
  /sk-or-v1-[0-9A-Za-z\-_]{20,}/g,
  /sk-[0-9A-Za-z\-_]{20,}/g,
  /gsk_[0-9A-Za-z\-_]{20,}/g,
  /xkiro_[0-9A-Za-z\-_]{16,}/g,
  /ya29\.[0-9A-Za-z\-_]+/g,
  /vkt1\.[0-9A-Za-z\-_.]+/g,
  /Bearer\s+[0-9A-Za-z\-._~+/]+=*/gi,
  /\b(GEMINI_API_KEY|OPENROUTER_API_KEY|GROQ_API_KEY|XKIRO_API_KEY|AGENT_SIGNING_SECRET|TOKEN_ENCRYPTION_KEY)\b/g
];

export function redactSensitiveData(input: unknown): string {
  const raw = typeof input === 'string' ? input : input instanceof Error ? input.message : String(input ?? '');
  if (!raw) {
    return '';
  }
  let sanitized = raw;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized.slice(0, 600);
}

export class AppError extends Error {
  readonly code: CustomErrorCode;
  readonly statusCode: number;
  readonly category: ErrorCategory;
  readonly title: string;
  readonly hint: string;
  readonly retryAfterSec?: number;

  constructor(params: {
    code: CustomErrorCode;
    statusCode: number;
    title: string;
    message: string;
    hint: string;
    retryAfterSec?: number;
  }) {
    const safeMessage = redactSensitiveData(params.message) || 'An unexpected error occurred.';
    super(safeMessage);
    this.name = 'AppError';
    this.code = params.code;
    this.statusCode = params.statusCode;
    this.category = params.statusCode >= 500 ? '5xx' : '4xx';
    this.title = redactSensitiveData(params.title) || `Request Error (${params.statusCode})`;
    this.hint =
      redactSensitiveData(params.hint) ||
      'Verify your request parameters and session status, then try again.';
    this.retryAfterSec = params.retryAfterSec;
  }

  toJSON(endpoint: string): SerializedCustomError {
    return {
      ok: false,
      code: this.code,
      statusCode: this.statusCode,
      category: this.category,
      title: this.title,
      error: this.message,
      hint: this.hint,
      endpoint,
      timestamp: new Date().toISOString(),
      ...(typeof this.retryAfterSec === 'number' ? { retryAfterSec: this.retryAfterSec } : {})
    };
  }
}

export function createValidationError(
  message: string,
  hint = 'Check the highlighted fields and ensure all inputs meet the required format.'
): AppError {
  return new AppError({
    code: 'VALIDATION_FAILED',
    statusCode: 400,
    title: 'Request Validation Error (400)',
    message,
    hint
  });
}

export function createAuthError(
  message: string,
  code: CustomErrorCode = 'AUTH_REQUIRED',
  hint = 'Sign out and sign back in to refresh your workspace authentication session.'
): AppError {
  return new AppError({
    code,
    statusCode: 401,
    title: 'Authentication Required (401)',
    message,
    hint
  });
}

export function createForbiddenError(
  message: string,
  code: CustomErrorCode = 'FORBIDDEN_ACTION',
  hint = 'Ensure you are signed in with the account that owns this workspace resource.'
): AppError {
  return new AppError({
    code,
    statusCode: 403,
    title: 'Access Denied (403)',
    message,
    hint
  });
}

export function createNotFoundError(
  message: string,
  code: CustomErrorCode = 'RESOURCE_NOT_FOUND',
  hint = 'Verify the identifier or link and try again.'
): AppError {
  return new AppError({
    code,
    statusCode: 404,
    title: 'Resource Not Found (404)',
    message,
    hint
  });
}

export function createConflictError(
  message: string,
  code: CustomErrorCode = 'AUTH_ACCOUNT_EXISTS',
  hint = 'Switch to Sign In if you already registered this email address.'
): AppError {
  return new AppError({
    code,
    statusCode: 409,
    title: 'Resource Conflict (409)',
    message,
    hint
  });
}

export function createGoneError(
  message: string,
  hint = 'Re-run the prompt or click Retry Tool to generate a fresh confirmation card.'
): AppError {
  return new AppError({
    code: 'ACTION_EXPIRED',
    statusCode: 410,
    title: 'Confirmation Expired (410)',
    message,
    hint
  });
}

export function createRateLimitError(params: {
  message: string;
  retryAfterSec?: number;
  isQuota?: boolean;
  hint?: string;
}): AppError {
  const retryWait = params.retryAfterSec ? ` Please wait ${params.retryAfterSec}s before retrying.` : '';
  return new AppError({
    code: params.isQuota ? 'QUOTA_EXHAUSTED' : 'RATE_LIMIT_EXCEEDED',
    statusCode: 429,
    title: params.isQuota
      ? 'Daily or Provider Quota Reached (429)'
      : 'Rate Limit Threshold Reached (429)',
    message: params.message,
    hint:
      params.hint ||
      `Slow down rapid requests or switch to another active model in the Model Selector.${retryWait}`,
    retryAfterSec: params.retryAfterSec
  });
}

export function normalizeToAppError(err: unknown): AppError {
  if (err instanceof AppError) {
    return err;
  }

  if (err && typeof err === 'object') {
    const maybeSyntax = err as { type?: string; status?: number; statusCode?: number; message?: string };
    if (maybeSyntax.type === 'entity.too.large' || maybeSyntax.status === 413 || maybeSyntax.statusCode === 413) {
      return new AppError({
        code: 'PAYLOAD_TOO_LARGE',
        statusCode: 413,
        title: 'Request Payload Too Large (413)',
        message: 'The submitted request body exceeds the maximum allowed payload size (256 KB).',
        hint: 'Shorten your prompt or clear older messages from the conversation thread and try again.'
      });
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return new AppError({
        code: 'INVALID_JSON_PAYLOAD',
        statusCode: 400,
        title: 'Malformed JSON Request (400)',
        message: 'The request body could not be parsed as valid JSON.',
        hint: 'Ensure the request payload is valid JSON and try again.'
      });
    }
  }

  const rawMsg = redactSensitiveData(err instanceof Error ? err.message : String(err || 'Unexpected error'));
  const lower = rawMsg.toLowerCase();

  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota')) {
    return createRateLimitError({
      message: 'Upstream model rate limit reached. Please retry in a few moments or select another model.',
      retryAfterSec: 15,
      isQuota: true
    });
  }

  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('aborted')) {
    return new AppError({
      code: 'UPSTREAM_TIMEOUT',
      statusCode: 504,
      title: 'Upstream Model Timeout (504)',
      message: 'The AI model gateway did not respond within the allowed time window.',
      hint: 'Switch to a low-latency Flash or Instant model, or retry with a more concise prompt.'
    });
  }

  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('unauthenticated') ||
    lower.includes('invalid authentication credentials')
  ) {
    return createAuthError(
      'Your authentication or connected Google Workspace token is invalid or expired.',
      'AUTH_TOKEN_EXPIRED',
      'Reconnect Google Workspace in the Connectors tab or sign in again.'
    );
  }

  if (lower.includes('gateway error') || lower.includes('upstream')) {
    return new AppError({
      code: 'UPSTREAM_PROVIDER_ERROR',
      statusCode: 502,
      title: 'Upstream Provider Gateway Error (502)',
      message: rawMsg || 'The selected model provider returned an upstream gateway error.',
      hint: 'Switch to another active model in the Model Selector or retry shortly.'
    });
  }

  return new AppError({
    code: 'INTERNAL_SERVER_ERROR',
    statusCode: 500,
    title: 'Server Execution Error (500)',
    message: rawMsg || 'An unexpected server error occurred while processing your request.',
    hint: 'Retry the operation or switch to another active model if the issue persists.'
  });
}
