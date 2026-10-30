import { AlertTriangle, Check, Clock, ShieldAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PendingActionDoc } from '../types/agent.ts';

interface ConfirmActionCardProps {
  action: PendingActionDoc;
  onDecision: (action: PendingActionDoc, decision: 'approve' | 'reject') => Promise<void>;
}

export function ConfirmActionCard({ action, onDecision }: ConfirmActionCardProps) {
  const [remainingSeconds, setRemainingSeconds] = useState<number>(() =>
    Math.max(0, Math.floor((action.expiresAtMs - Date.now()) / 1000))
  );
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);

  useEffect(() => {
    if (action.status !== 'pending') return;
    const interval = setInterval(() => {
      const next = Math.max(0, Math.floor((action.expiresAtMs - Date.now()) / 1000));
      setRemainingSeconds(next);
    }, 1000);
    return () => clearInterval(interval);
  }, [action.expiresAtMs, action.status]);

  let parsedArgs: Record<string, unknown> = {};
  try {
    parsedArgs = JSON.parse(action.argsPreview);
  } catch {
    parsedArgs = {};
  }

  const isExpired =
    action.status === 'expired' || (action.status === 'pending' && remainingSeconds <= 0);
  const minutes = String(Math.floor(remainingSeconds / 60)).padStart(2, '0');
  const seconds = String(remainingSeconds % 60).padStart(2, '0');

  const handleAction = async (decision: 'approve' | 'reject') => {
    if (submitting || action.status !== 'pending' || isExpired) return;
    setSubmitting(decision);
    try {
      await onDecision(action, decision);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <section
      aria-label="Action Confirmation Card"
      className="mt-4 rounded-xl border theme-border theme-surface p-5 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b theme-border pb-3">
        <div className="flex items-center gap-2.5">
          <ShieldAlert
            className="h-4 w-4 shrink-0"
            style={{
              color:
                action.risk === 'destructive'
                  ? 'var(--status-destructive)'
                  : 'var(--status-write)'
            }}
          />
          <h4 className="font-display text-sm font-semibold theme-text-primary">
            Action Confirmation Required
          </h4>
        </div>

        <div className="flex items-center gap-2 text-xs theme-text-secondary font-mono tabular-nums">
          <span>{action.toolName}</span>
          <span aria-hidden="true">·</span>
          <span
            style={{
              color:
                action.risk === 'destructive'
                  ? 'var(--status-destructive)'
                  : 'var(--status-write)'
            }}
          >
            {action.risk} risk
          </span>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {action.status === 'pending' && !isExpired ? `${minutes}:${seconds} TTL` : action.status}
          </span>
        </div>
      </div>

      <div className="rounded-lg border theme-border theme-canvas px-3.5 py-2.5 text-xs theme-text-secondary flex items-start gap-2.5">
        <AlertTriangle
          className="h-4 w-4 shrink-0 mt-0.5"
          style={{ color: 'var(--status-write)' }}
        />
        <p className="leading-relaxed">{action.warningText}</p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium theme-text-secondary">
          Action Parameters
        </p>
        <dl className="grid grid-cols-1 gap-2 rounded-lg border theme-border theme-elevated p-3.5 text-xs">
          {Object.entries(parsedArgs).map(([key, value]) => (
            <div
              key={key}
              className="grid grid-cols-1 sm:grid-cols-4 gap-1 py-1.5 border-b theme-border last:border-b-0"
            >
              <dt className="font-mono theme-text-muted">{key}</dt>
              <dd className="sm:col-span-3 font-mono theme-text-primary break-words whitespace-pre-wrap">
                {typeof value === 'string' ? value : JSON.stringify(value)}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t theme-border">
        <p className="text-[11px] font-mono theme-text-muted">
          Explicit approval required before execution
        </p>

        {action.status === 'pending' && !isExpired ? (
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              disabled={submitting !== null}
              onClick={() => handleAction('reject')}
              className="inline-flex items-center gap-1.5 rounded-lg border theme-border theme-elevated px-3.5 py-2 text-xs font-medium theme-text-primary hover:opacity-80 transition-opacity whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              {submitting === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
            <button
              type="button"
              disabled={submitting !== null}
              onClick={() => handleAction('approve')}
              className="inline-flex items-center gap-1.5 rounded-lg theme-btn-primary px-4 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" />
              {submitting === 'approve'
                ? 'Verifying & Executing…'
                : action.risk === 'destructive'
                  ? 'Confirm & Execute Now'
                  : 'Approve & Execute'}
            </button>
          </div>
        ) : (
          <p className="text-xs font-mono theme-text-secondary">
            Status:{' '}
            <span
              style={{
                color:
                  action.status === 'executed'
                    ? 'var(--status-read)'
                    : action.status === 'rejected'
                      ? 'var(--status-destructive)'
                      : 'var(--status-write)'
              }}
            >
              {isExpired && action.status === 'pending' ? 'expired (10m limit)' : action.status}
            </span>
          </p>
        )}
      </div>
    </section>
  );
}
