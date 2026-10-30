import { z } from 'zod';
import { ChatErrorState } from '../../components/ChatErrorBanner.tsx';

export const ALLOWED_CONNECTOR_IDS = [
  'gmail',
  'calendar',
  'drive',
  'docs',
  'tasks',
  'keep',
  'system',
  'search',
  'maps',
  'notes'
] as const;

export const ChatHistoryMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z
    .string()
    .trim()
    .min(1, 'History message content cannot be empty.')
    .max(4000, 'History message content exceeds 4,000 characters.')
});

export const ChatRequestPayloadSchema = z.object({
  uid: z
    .string()
    .trim()
    .min(3, 'User ID (uid) must be at least 3 characters.')
    .max(128, 'User ID (uid) cannot exceed 128 characters.')
    .regex(/^[a-zA-Z0-9_.:@-]+$/, 'User ID (uid) contains invalid characters.'),
  modelId: z
    .string()
    .trim()
    .min(3, 'Model ID must be at least 3 characters.')
    .max(160, 'Model ID cannot exceed 160 characters.'),
  message: z
    .string()
    .trim()
    .min(1, 'Prompt message cannot be empty.')
    .max(4000, 'Prompt message cannot exceed 4,000 characters.'),
  history: z
    .array(ChatHistoryMessageSchema)
    .max(10, 'Conversation history window cannot exceed 10 messages.'),
  connectedProviders: z
    .array(z.enum(ALLOWED_CONNECTOR_IDS))
    .min(1, 'At least one workspace or system connector must be enabled.')
    .max(16, 'Too many connected providers specified.')
});

export type ValidatedChatRequestPayload = z.infer<typeof ChatRequestPayloadSchema>;

export const CHAT_REQUEST_TIMEOUT_MS = 45_000;

export type NetworkFailureKind = 'timeout' | 'offline' | 'dns' | 'unreachable' | 'aborted';

export class ChatNetworkError extends Error {
  readonly failureKind: NetworkFailureKind;
  readonly statusCode: number;
  readonly title: string;
  readonly hint: string;
  readonly diagnosticPreview: string;

  constructor(params: {
    failureKind: NetworkFailureKind;
    statusCode: number;
    title: string;
    message: string;
    hint: string;
    diagnosticPreview: string;
  }) {
    super(params.message);
    this.name = 'ChatNetworkError';
    this.failureKind = params.failureKind;
    this.statusCode = params.statusCode;
    this.title = params.title;
    this.hint = params.hint;
    this.diagnosticPreview = params.diagnosticPreview;
  }
}

export function formatZodValidationBanner(
  issues: z.ZodIssue[],
  modelId: string,
  _rawPayload?: unknown
): ChatErrorState {
  const formattedIssues = issues.map((issue) => issue.message);

  return {
    statusCode: 400,
    category: '4xx',
    failureKind: 'validation',
    title: 'Invalid Request Format (400)',
    message: formattedIssues.join(' | '),
    hint: 'Ensure your user session is active, a valid AI model is selected, and your message is between 1 and 4,000 characters.',
    modelId,
    endpoint: '/api/chat',
    timestamp: new Date().toISOString()
  };
}

function classifyNetworkFailure(
  err: unknown,
  timedOut: boolean,
  userAborted: boolean,
  _endpoint: string,
  _elapsedMs: number
): ChatNetworkError {
  const isBrowserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const rawMessage = err instanceof Error ? err.message : String(err || 'Unknown network failure');
  const rawName = err instanceof Error ? err.name : 'Error';
  const normalized = `${rawName} ${rawMessage}`.toLowerCase();

  if (userAborted && !timedOut) {
    return new ChatNetworkError({
      failureKind: 'aborted',
      statusCode: 499,
      title: 'Generation Stopped by User',
      message: 'You cancelled the active request before completion.',
      hint: 'Send a new prompt or click Retry when you are ready.',
      diagnosticPreview: ''
    });
  }

  if (timedOut || rawName === 'TimeoutError' || normalized.includes('timed out') || normalized.includes('timeout')) {
    return new ChatNetworkError({
      failureKind: 'timeout',
      statusCode: 408,
      title: 'Request Timed Out (408)',
      message: 'The request did not receive a response within the timeout window.',
      hint: 'Try switching to a low-latency Flash or Instant model, or retry your request.',
      diagnosticPreview: ''
    });
  }

  if (isBrowserOffline) {
    return new ChatNetworkError({
      failureKind: 'offline',
      statusCode: 0,
      title: 'Browser Network Offline',
      message: 'Your browser reports no active internet connection.',
      hint: 'Reconnect to your network and click Retry to resend your prompt.',
      diagnosticPreview: ''
    });
  }

  const isDnsOrResolutionFailure =
    normalized.includes('err_name_not_resolved') ||
    normalized.includes('enotfound') ||
    normalized.includes('eai_again') ||
    normalized.includes('dns') ||
    normalized.includes('name not resolved');

  if (isDnsOrResolutionFailure) {
    return new ChatNetworkError({
      failureKind: 'dns',
      statusCode: 0,
      title: 'Network Lookup Failure',
      message: 'Hostname lookup failed while attempting to connect to the workspace service.',
      hint: 'Verify your network or DNS configuration and retry.',
      diagnosticPreview: ''
    });
  }

  return new ChatNetworkError({
    failureKind: 'unreachable',
    statusCode: 503,
    title: 'Service Temporarily Unreachable',
    message: 'Could not establish a connection to the workspace service.',
    hint: 'Please check your internet connection and try again.',
    diagnosticPreview: ''
  });
}

export interface ChatFetchResult {
  response: Response;
  rawBody: string;
  elapsedMs: number;
}

export async function fetchChatWithTimeout(params: {
  endpoint: string;
  headers: Record<string, string>;
  payload: ValidatedChatRequestPayload;
  userSignal: AbortSignal;
  timeoutMs?: number;
}): Promise<ChatFetchResult> {
  const { endpoint, headers, payload, userSignal, timeoutMs = CHAT_REQUEST_TIMEOUT_MS } = params;
  const startedAt = Date.now();

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw classifyNetworkFailure(
      new TypeError('Failed to fetch: browser is offline'),
      false,
      false,
      endpoint,
      0
    );
  }

  const requestController = new AbortController();
  let timedOut = false;
  let userAborted = userSignal.aborted;

  const onUserAbort = () => {
    userAborted = true;
    requestController.abort(new DOMException('Request aborted by user', 'AbortError'));
  };

  if (userSignal.aborted) {
    onUserAbort();
  } else {
    userSignal.addEventListener('abort', onUserAbort, { once: true });
  }

  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    requestController.abort(
      new DOMException(`Connection to ${endpoint} timed out after ${timeoutMs}ms`, 'TimeoutError')
    );
  }, timeoutMs);

  const combinedSignal =
    typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal && 'any' in AbortSignal
      ? AbortSignal.any([requestController.signal, AbortSignal.timeout(timeoutMs)])
      : requestController.signal;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: combinedSignal,
      body: JSON.stringify(payload)
    });

    const rawBody = await response.text();
    const elapsedMs = Date.now() - startedAt;

    return {
      response,
      rawBody,
      elapsedMs
    };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    throw classifyNetworkFailure(err, timedOut, userAborted, endpoint, elapsedMs);
  } finally {
    globalThis.clearTimeout(timeoutId);
    userSignal.removeEventListener('abort', onUserAbort);
  }
}
