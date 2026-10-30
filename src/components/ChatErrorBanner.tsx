import {
  AlertCircle,
  AlertTriangle,
  Clock,
  RefreshCw,
  ServerCrash,
  ShieldAlert,
  WifiOff,
  X
} from 'lucide-react';

export interface ChatErrorState {
  statusCode: number;
  category: '4xx' | '5xx' | 'network';
  failureKind?: 'timeout' | 'offline' | 'dns' | 'unreachable' | 'aborted' | 'validation' | 'http';
  title: string;
  message: string;
  hint?: string;
  modelId?: string;
  endpoint: string;
  rawBodyPreview?: string;
  timestamp: string;
}

interface ChatErrorBannerProps {
  error: ChatErrorState | null;
  onDismiss: () => void;
  onRetry?: () => void;
}

function resolveStatusGuidance(error: ChatErrorState): {
  badgeLabel: string;
  defaultTitle: string;
  defaultHint: string;
} {
  const { statusCode, category, failureKind, hint } = error;

  if (failureKind === 'timeout' || statusCode === 408) {
    return {
      badgeLabel: '408 Connection Timeout',
      defaultTitle: 'Request Timed Out',
      defaultHint:
        hint ||
        'The AI model did not respond in time. Try switching to a faster model or click Retry.'
    };
  }

  if (failureKind === 'dns') {
    return {
      badgeLabel: 'DNS Resolution Error',
      defaultTitle: 'Network Host Lookup Failed',
      defaultHint:
        hint ||
        'The browser could not resolve the server address. Check your network, VPN, or proxy settings.'
    };
  }

  if (failureKind === 'offline') {
    return {
      badgeLabel: 'Network Offline',
      defaultTitle: 'No Active Network Connection Detected',
      defaultHint:
        hint ||
        'Your device appears to be offline. Reconnect to the internet and retry your message.'
    };
  }

  if (category === 'network' || failureKind === 'unreachable' || statusCode === 0) {
    return {
      badgeLabel: 'Network Unreachable',
      defaultTitle: 'Service Temporarily Unreachable',
      defaultHint:
        hint ||
        'A network interruption prevented your browser from reaching the workspace service. Please try again.'
    };
  }

  if (failureKind === 'validation') {
    return {
      badgeLabel: '400 Validation Error',
      defaultTitle: 'Invalid Request Format (400)',
      defaultHint:
        hint ||
        'Ensure your user session is active, a valid AI model is selected, and your message is within the character limit.'
    };
  }

  if (statusCode === 400) {
    return {
      badgeLabel: '400 Bad Request',
      defaultTitle: 'Invalid Chat Request (400)',
      defaultHint:
        hint ||
        'Verify that your prompt is non-empty and within the 4,000-character limit.'
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    return {
      badgeLabel: `${statusCode} Unauthorized`,
      defaultTitle: `Authentication Verification Failed (${statusCode})`,
      defaultHint:
        hint ||
        'Your session expired or could not be verified. Sign out and sign back in to refresh your session.'
    };
  }

  if (statusCode === 429) {
    return {
      badgeLabel: '429 Rate Limit',
      defaultTitle: 'Model or Daily Quota Threshold Reached (429)',
      defaultHint:
        hint ||
        'You have reached the rolling 24-hour or per-minute limit for this model. Open the Model Selector to switch to another free model.'
    };
  }

  if (statusCode >= 400 && statusCode < 500) {
    return {
      badgeLabel: `${statusCode} Request Error`,
      defaultTitle: `Request Rejected (${statusCode})`,
      defaultHint:
        hint ||
        'The request could not be processed. Please review your input and try again.'
    };
  }

  if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return {
      badgeLabel: `${statusCode} Service Busy`,
      defaultTitle: `AI Model Temporarily Unavailable (${statusCode})`,
      defaultHint:
        hint ||
        'The selected model endpoint timed out or is temporarily busy. Try switching to another model or retry.'
    };
  }

  if (statusCode >= 500) {
    return {
      badgeLabel: `${statusCode} Server Error`,
      defaultTitle: `Workspace Execution Error (${statusCode})`,
      defaultHint:
        hint ||
        'An unexpected error occurred while processing your request. Please retry or select another model.'
    };
  }

  return {
    badgeLabel: 'Connection Interrupted',
    defaultTitle: 'Chat Connection Interrupted',
    defaultHint:
      hint ||
      'Could not complete the request. Verify your network connection and try again.'
  };
}

export function ChatErrorBanner({ error, onDismiss, onRetry }: ChatErrorBannerProps) {
  if (!error) return null;

  const isNetwork =
    error.category === 'network' ||
    error.failureKind === 'timeout' ||
    error.failureKind === 'dns' ||
    error.failureKind === 'offline' ||
    error.failureKind === 'unreachable' ||
    error.statusCode === 0 ||
    error.statusCode === 408;
  const is5xx = !isNetwork && (error.category === '5xx' || error.statusCode >= 500);
  const is4xx =
    !isNetwork && (error.category === '4xx' || (error.statusCode >= 400 && error.statusCode < 500));
  const guidance = resolveStatusGuidance(error);

  const accentColor =
    is5xx || isNetwork
      ? 'var(--status-destructive)'
      : is4xx
        ? 'var(--status-write)'
        : 'var(--status-destructive)';

  const IconComponent =
    error.failureKind === 'timeout' || error.statusCode === 408
      ? Clock
      : isNetwork
        ? WifiOff
        : is5xx
          ? ServerCrash
          : error.statusCode === 401 || error.statusCode === 403
            ? ShieldAlert
            : is4xx
              ? AlertTriangle
              : AlertCircle;

  return (
    <aside
      role="alert"
      aria-live="assertive"
      className="rounded-2xl border theme-elevated p-4 shadow-xs transition-all"
      style={{ borderColor: accentColor }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div
            className="mt-0.5 rounded-lg p-2 shrink-0 border theme-surface"
            style={{ borderColor: accentColor, color: accentColor }}
          >
            <IconComponent className="h-4 w-4" />
          </div>

          <section className="space-y-1.5 min-w-0 flex-1">
            <header className="flex flex-wrap items-center gap-2">
              <span
                className="inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-white"
                style={{ backgroundColor: accentColor }}
              >
                {guidance.badgeLabel}
              </span>
            </header>

            <h3 className="font-display text-xs font-semibold theme-text-primary">
              {error.title || guidance.defaultTitle}
            </h3>

            <p className="text-xs theme-text-primary leading-relaxed break-words">
              {error.message}
            </p>

            <p className="text-[11px] theme-text-secondary leading-relaxed">
              <strong className="font-semibold">Why this happened:</strong> {guidance.defaultHint}
            </p>
          </section>
        </div>

        <nav aria-label="Error banner actions" className="flex items-center gap-1.5 shrink-0">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 rounded-lg border theme-border theme-surface px-2.5 py-1.5 text-[11px] font-medium theme-text-primary hover:opacity-80 transition-opacity"
              title="Retry last message"
            >
              <RefreshCw className="h-3 w-3" />
              <span>Retry</span>
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss error banner"
            className="inline-flex items-center gap-1 rounded-lg border theme-border theme-surface px-2.5 py-1.5 text-[11px] font-medium theme-text-secondary hover:opacity-80 transition-opacity"
          >
            <X className="h-3.5 w-3.5" />
            <span>Dismiss</span>
          </button>
        </nav>
      </div>
    </aside>
  );
}
