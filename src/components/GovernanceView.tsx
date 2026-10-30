import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Cpu,
  Gauge,
  LogOut,
  Mail,
  RotateCcw,
  Trash2,
  UserCheck
} from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { ModelInfo, ModelProvider, UserProfileDoc } from '../types/agent.ts';

interface GovernanceViewProps {
  uid: string;
  email: string | null;
  displayName: string;
  profile: UserProfileDoc | null;
  models?: ModelInfo[];
  chatCount: number;
  hasGoogleToken?: boolean;
  isServerSession?: boolean;
  limits: {
    maxRequestsPerMinute: number;
    maxRequestsPerDay: number;
    maxTokensPerDay: number;
    maxMessageLength: number;
  };
  onUpdateUsername: (nextUsername: string) => Promise<void>;
  onClearAllConversations: () => Promise<void>;
  onDeleteAllUserData: () => Promise<void>;
  onSignOut: () => Promise<void>;
}

const PROVIDER_RATE_CAPS: Array<{
  providerKey: ModelProvider;
  label: string;
  defaultLimit: number;
  defaultModelCount: number;
}> = [
  { providerKey: 'xkiro', label: 'alpha', defaultLimit: 6, defaultModelCount: 45 },
  { providerKey: 'groq', label: 'beta', defaultLimit: 10, defaultModelCount: 13 },
  { providerKey: 'openrouter', label: 'gama', defaultLimit: 25, defaultModelCount: 10 },
  { providerKey: 'gemini', label: 'delta', defaultLimit: 12, defaultModelCount: 3 }
];

export function GovernanceView({
  email,
  displayName,
  profile,
  models = [],
  chatCount,
  hasGoogleToken = false,
  limits,
  onUpdateUsername,
  onClearAllConversations,
  onDeleteAllUserData,
  onSignOut
}: GovernanceViewProps) {
  const effectiveName = (profile?.displayName || displayName || 'Workspace Operator').trim();
  const effectiveEmail = profile?.email || email || 'user@example.com';

  const [usernameDraft, setUsernameDraft] = useState(effectiveName);
  const [savingUsername, setSavingUsername] = useState(false);
  const [usernameStatus, setUsernameStatus] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const [confirmDeleteStep, setConfirmDeleteStep] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [clearingChats, setClearingChats] = useState(false);
  const [clearChatsNotice, setClearChatsNotice] = useState<string | null>(null);
  const [dataActionError, setDataActionError] = useState<string | null>(null);

  useEffect(() => {
    setUsernameDraft(effectiveName);
  }, [effectiveName]);

  const providerRows = PROVIDER_RATE_CAPS.map((item) => {
    const matchedModels = models.filter((m) => m.provider === item.providerKey);
    const modelCount =
      matchedModels.length > 0 ? matchedModels.length : item.defaultModelCount;
    const limit24h = Math.max(
      1,
      matchedModels[0]?.providerLimit24h ??
        matchedModels[0]?.dailyLimit24h ??
        item.defaultLimit
    );
    const remaining24h = Math.max(
      0,
      Math.min(
        limit24h,
        matchedModels[0]?.providerRemaining24h ??
          matchedModels[0]?.remaining24h ??
          limit24h
      )
    );
    const used24h = Math.max(0, limit24h - remaining24h);
    const usedPercent24h = Math.min(100, Math.round((used24h / limit24h) * 100));
    const isExhausted = remaining24h <= 0;
    const isAtOrAbove90 = isExhausted || usedPercent24h >= 90;
    const isApproaching90 = !isAtOrAbove90 && usedPercent24h >= 80;
    const showWarningAlert = isAtOrAbove90 || isApproaching90;

    return {
      ...item,
      modelCount,
      limit24h,
      remaining24h,
      used24h,
      usedPercent24h,
      isExhausted,
      isAtOrAbove90,
      isApproaching90,
      showWarningAlert
    };
  });

  const syncedProviderUsedTotal = providerRows.reduce((sum, row) => sum + row.used24h, 0);
  const syncedProviderLimitTotal = providerRows.reduce((sum, row) => sum + row.limit24h, 0);

  const requestsUsed = Math.max(profile?.dailyRequestsCount || 0, syncedProviderUsedTotal);
  const requestsMax = Math.max(1, limits.maxRequestsPerDay || syncedProviderLimitTotal);
  const requestsPercent = Math.min(100, Math.round((requestsUsed / requestsMax) * 100));

  const tokensUsed = profile?.dailyTokensUsed || 0;
  const tokensMax = Math.max(1, limits.maxTokensPerDay);
  const tokensPercent = Math.min(100, Math.round((tokensUsed / tokensMax) * 100));

  const resetDateLabel = profile?.lastResetDate || new Date().toISOString().slice(0, 10);
  const trimmedDraft = usernameDraft.trim();
  const isUsernameUnchanged = trimmedDraft === effectiveName;

  const monogram =
    effectiveName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || '')
      .join('') || 'VO';

  const handleUsernameSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setUsernameStatus(null);

    if (!trimmedDraft) {
      setUsernameStatus({
        type: 'error',
        message: 'Please enter a valid username (1–80 characters).'
      });
      return;
    }

    if (trimmedDraft.length > 80) {
      setUsernameStatus({
        type: 'error',
        message: 'Username must be 80 characters or fewer.'
      });
      return;
    }

    setSavingUsername(true);
    try {
      await onUpdateUsername(trimmedDraft);
      setUsernameStatus({
        type: 'success',
        message: `Username updated to "${trimmedDraft}".`
      });
    } catch (err) {
      setUsernameStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Unable to update username.'
      });
    } finally {
      setSavingUsername(false);
    }
  };

  const handleClearConversationsClick = async () => {
    setClearingChats(true);
    setClearChatsNotice(null);
    setDataActionError(null);
    try {
      await onClearAllConversations();
      setClearChatsNotice(
        'All local and cloud conversation threads and message history have been cleared.'
      );
    } catch (err) {
      setDataActionError(
        err instanceof Error ? err.message : 'Failed to clear conversation history.'
      );
    } finally {
      setClearingChats(false);
    }
  };

  const handleConfirmPurge = async () => {
    setDeleting(true);
    setDataActionError(null);
    try {
      await onDeleteAllUserData();
      setConfirmDeleteStep(false);
    } catch (err) {
      setDataActionError(
        err instanceof Error ? err.message : 'Failed to purge workspace data.'
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6 md:p-8 space-y-6 sm:space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b theme-border pb-5 sm:pb-6">
        <div className="space-y-1.5">
          <p
            className="text-xs font-mono uppercase tracking-wider"
            style={{ color: 'var(--accent-primary)' }}
          >
            Account &amp; Workspace Profile
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold theme-text-primary">
            Profile, Usage Quotas &amp; Data Controls
          </h1>
          <p className="text-xs sm:text-sm theme-text-secondary max-w-2xl leading-relaxed">
            Manage your display username, monitor daily request and token consumption, inspect 24-hour provider rate caps, and control your workspace sessions and connected data access.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onSignOut}
            className="inline-flex h-12 sm:h-9 items-center justify-center gap-1.5 rounded-xl border theme-border theme-surface px-4 text-xs font-medium theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
          >
            <LogOut className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--status-destructive)' }} />
            <span>Sign Out</span>
          </button>
        </div>
      </header>

      <section
        aria-label="Identity and Username Settings"
        className="rounded-2xl border theme-border theme-elevated p-4 sm:p-6"
      >
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 items-center">
          <div className="lg:col-span-5 flex items-center gap-4">
            <div
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border theme-border theme-surface font-display text-lg font-bold"
              style={{ color: 'var(--accent-primary)' }}
              aria-hidden="true"
            >
              {monogram}
            </div>

            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-lg font-semibold theme-text-primary truncate">
                  {effectiveName}
                </h2>
                <span className="rounded-md border theme-border theme-surface px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider theme-text-secondary whitespace-nowrap shrink-0">
                  {profile?.plan === 'pro' ? 'Pro Plan' : 'Free Plan'}
                </span>
              </div>

              <p className="flex items-center gap-1.5 text-xs theme-text-secondary truncate">
                <Mail className="h-3.5 w-3.5 shrink-0 theme-text-muted" />
                <span className="truncate">{effectiveEmail}</span>
              </p>

              <p className="font-mono text-[11px] theme-text-muted tabular-nums">
                {hasGoogleToken ? 'Google Workspace Connected' : 'Standard Session'} · {chatCount}{' '}
                {chatCount === 1 ? 'Active Thread' : 'Active Threads'}
              </p>
            </div>
          </div>

          <form
            onSubmit={handleUsernameSubmit}
            className="lg:col-span-7 lg:border-l theme-border lg:pl-6 space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="profile-username-input"
                className="flex items-center gap-1.5 text-xs font-semibold theme-text-primary"
              >
                <UserCheck
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: 'var(--accent-primary)' }}
                />
                <span>Display Username</span>
              </label>
              <span className="font-mono text-[11px] theme-text-muted tabular-nums">
                {trimmedDraft.length}/80 chars
              </span>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <input
                id="profile-username-input"
                type="text"
                value={usernameDraft}
                onChange={(e) => {
                  setUsernameDraft(e.target.value);
                  if (usernameStatus) setUsernameStatus(null);
                }}
                maxLength={80}
                placeholder="Enter your preferred username"
                className="h-12 sm:h-10 flex-1 rounded-xl border theme-border theme-canvas px-3.5 text-base md:text-xs font-medium theme-text-primary placeholder:opacity-60 focus:outline-none"
              />

              <div className="flex items-center gap-2 shrink-0">
                {!isUsernameUnchanged && (
                  <button
                    type="button"
                    disabled={savingUsername}
                    onClick={() => {
                      setUsernameDraft(effectiveName);
                      setUsernameStatus(null);
                    }}
                    className="inline-flex h-12 sm:h-10 flex-1 sm:flex-initial items-center justify-center rounded-xl border theme-border theme-surface px-3.5 text-xs font-medium theme-text-secondary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
                  >
                    Reset
                  </button>
                )}

                <button
                  type="submit"
                  disabled={savingUsername || !trimmedDraft || isUsernameUnchanged}
                  className="inline-flex h-12 sm:h-10 flex-1 sm:flex-initial items-center justify-center gap-1.5 rounded-xl theme-btn-primary px-4 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-45"
                >
                  <Check className="h-3.5 w-3.5 shrink-0" />
                  <span>{savingUsername ? 'Saving…' : 'Save Username'}</span>
                </button>
              </div>
            </div>

            {usernameStatus ? (
              <div
                role="status"
                className="flex items-center gap-2 rounded-lg border theme-border theme-canvas px-3 py-2 text-xs font-mono"
                style={{
                  color:
                    usernameStatus.type === 'success'
                      ? 'var(--status-read)'
                      : 'var(--status-destructive)'
                }}
              >
                {usernameStatus.type === 'success' ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                )}
                <span>{usernameStatus.message}</span>
              </div>
            ) : (
              <p className="text-[11px] theme-text-muted">
                Your username is displayed across your workspace sessions and shared conversation links.
              </p>
            )}
          </form>
        </div>
      </section>

      <section
        aria-label="Quota and Rate Cap Telemetry"
        className="grid grid-cols-1 md:grid-cols-3 gap-5"
      >
        <article className="rounded-2xl border theme-border theme-elevated p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium theme-text-secondary">
                <Gauge
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: 'var(--accent-primary)' }}
                />
                <span>Daily Request Quota</span>
              </span>
              <span
                className="inline-flex items-center gap-1 font-mono text-xs font-semibold tabular-nums"
                style={{
                  color:
                    requestsPercent >= 90
                      ? 'var(--status-destructive)'
                      : requestsPercent >= 80
                        ? 'var(--status-write)'
                        : 'var(--status-read)'
                }}
              >
                {requestsPercent >= 80 && (
                  <span
                    className="inline-flex items-center shrink-0"
                    title="Approaching or exceeding 90% of daily request quota"
                    aria-label="Daily request quota warning"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  </span>
                )}
                <span>{requestsPercent}% used</span>
              </span>
            </div>

            <p className="font-mono text-2xl font-semibold theme-text-primary tabular-nums">
              {requestsUsed.toLocaleString()}{' '}
              <span className="text-sm font-normal theme-text-muted">
                / {limits.maxRequestsPerDay.toLocaleString()}
              </span>
            </p>

            <div className="h-2 w-full rounded-full overflow-hidden border theme-border theme-surface">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${Math.max(requestsUsed > 0 ? 4 : 0, requestsPercent)}%`,
                  backgroundColor:
                    requestsPercent >= 90
                      ? 'var(--status-destructive)'
                      : requestsPercent >= 75
                        ? 'var(--status-write)'
                        : 'var(--status-read)'
                }}
              />
            </div>
          </div>

          <div className="pt-3 border-t theme-border flex items-center justify-between text-xs font-mono theme-text-muted tabular-nums">
            <span>Burst Cap · 00:00 UTC Reset</span>
            <span className="theme-text-primary">{limits.maxRequestsPerMinute} req / min</span>
          </div>
        </article>

        <article className="rounded-2xl border theme-border theme-elevated p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium theme-text-secondary">
                <Activity
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: 'var(--accent-primary)' }}
                />
                <span>Daily Token Consumption</span>
              </span>
              <span
                className="inline-flex items-center gap-1 font-mono text-xs font-semibold tabular-nums"
                style={{
                  color:
                    tokensPercent >= 90
                      ? 'var(--status-destructive)'
                      : tokensPercent >= 80
                        ? 'var(--status-write)'
                        : 'var(--accent-primary)'
                }}
              >
                {tokensPercent >= 80 && (
                  <span
                    className="inline-flex items-center shrink-0"
                    title="Approaching or exceeding 90% of daily token limit"
                    aria-label="Daily token quota warning"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  </span>
                )}
                <span>{tokensPercent}% used</span>
              </span>
            </div>

            <p className="font-mono text-2xl font-semibold theme-text-primary tabular-nums">
              {tokensUsed.toLocaleString()}{' '}
              <span className="text-sm font-normal theme-text-muted">
                / {limits.maxTokensPerDay.toLocaleString()}
              </span>
            </p>

            <div className="h-2 w-full rounded-full overflow-hidden border theme-border theme-surface">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${Math.max(tokensUsed > 0 ? 4 : 0, tokensPercent)}%`,
                  backgroundColor:
                    tokensPercent >= 90
                      ? 'var(--status-destructive)'
                      : tokensPercent >= 75
                        ? 'var(--status-write)'
                        : 'var(--accent-primary)'
                }}
              />
            </div>
          </div>

          <div className="pt-3 border-t theme-border flex items-center justify-between text-xs font-mono theme-text-muted tabular-nums">
            <span>Daily 00:00 UTC Reset</span>
            <span className="theme-text-primary">00:00 UTC · {resetDateLabel}</span>
          </div>
        </article>

        <article className="rounded-2xl border theme-border theme-elevated p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            {(() => {
              const hasCriticalProvider = providerRows.some((r) => r.isAtOrAbove90);
              const hasApproachingProvider = providerRows.some((r) => r.isApproaching90);

              return (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium theme-text-secondary">
                      <Cpu
                        className="h-3.5 w-3.5 shrink-0"
                        style={{ color: 'var(--accent-primary)' }}
                      />
                      <span>24h Provider Rate Caps</span>
                      {(hasCriticalProvider || hasApproachingProvider) && (
                        <span
                          className="inline-flex items-center shrink-0"
                          style={{
                            color: hasCriticalProvider
                              ? 'var(--status-destructive)'
                              : 'var(--status-write)'
                          }}
                          title="One or more providers are approaching or have reached 90% of their 24h rate cap"
                          aria-label="Provider rate cap alert"
                        >
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        </span>
                      )}
                    </span>
                    <span
                      className="inline-flex items-center gap-1 font-mono text-xs font-semibold tabular-nums"
                      style={{
                        color: hasCriticalProvider
                          ? 'var(--status-destructive)'
                          : hasApproachingProvider
                            ? 'var(--status-write)'
                            : 'var(--status-read)'
                      }}
                    >
                      {hasCriticalProvider
                        ? '90%+ Alert'
                        : hasApproachingProvider
                          ? 'Near 90% Cap'
                          : '00:00 UTC'}
                    </span>
                  </div>

                  <dl className="space-y-3 pt-1">
                    {providerRows.map((row) => {
                      const barColor = row.isAtOrAbove90
                        ? 'var(--status-destructive)'
                        : row.isApproaching90 || row.usedPercent24h >= 75
                          ? 'var(--status-write)'
                          : 'var(--accent-primary)';

                      const textColor = row.isAtOrAbove90
                        ? 'var(--status-destructive)'
                        : row.isApproaching90
                          ? 'var(--status-write)'
                          : row.used24h > 0
                            ? 'var(--accent-primary)'
                            : 'var(--text-primary)';

                      const alertTitle = row.isExhausted
                        ? `${row.label} has reached 100% of its 24h rate cap`
                        : row.isAtOrAbove90
                          ? `Alert: ${row.label} has reached ${row.usedPercent24h}% (≥90%) of its 24h limit`
                          : `Warning: ${row.label} is approaching 90% (${row.usedPercent24h}% used) of its 24h limit`;

                      return (
                        <div
                          key={row.providerKey}
                          className="space-y-1.5 text-xs font-mono tabular-nums"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <dt className="flex items-center gap-1.5 theme-text-secondary truncate">
                              {row.showWarningAlert && (
                                <span
                                  className="inline-flex items-center shrink-0"
                                  style={{
                                    color: row.isAtOrAbove90
                                      ? 'var(--status-destructive)'
                                      : 'var(--status-write)'
                                  }}
                                  title={alertTitle}
                                  aria-label={alertTitle}
                                >
                                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                </span>
                              )}
                              <span className="font-semibold theme-text-primary">{row.label}</span>
                              <span className="text-[10px] theme-text-muted">
                                ({row.modelCount} {row.modelCount === 1 ? 'model' : 'models'})
                              </span>
                            </dt>
                            <dd
                              className="inline-flex items-center gap-1.5 font-semibold shrink-0 text-[11px]"
                              style={{ color: textColor }}
                            >
                              {row.showWarningAlert && (
                                <span
                                  className="inline-flex items-center shrink-0"
                                  title={alertTitle}
                                  aria-hidden="true"
                                >
                                  <AlertCircle className="h-3 w-3 shrink-0" />
                                </span>
                              )}
                              <span>
                                {row.used24h}/{row.limit24h} used ({row.usedPercent24h}%)
                              </span>
                            </dd>
                          </div>

                          <div
                            role="progressbar"
                            aria-label={`${row.label} 24-hour provider usage`}
                            aria-valuenow={row.usedPercent24h}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            className="h-1.5 w-full rounded-full overflow-hidden border theme-border theme-surface"
                          >
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{
                                width: `${Math.max(row.used24h > 0 ? 6 : 0, row.usedPercent24h)}%`,
                                backgroundColor: barColor
                              }}
                            />
                          </div>

                          {row.showWarningAlert && (
                            <p
                              className="flex items-center gap-1 text-[10px] leading-tight"
                              style={{
                                color: row.isAtOrAbove90
                                  ? 'var(--status-destructive)'
                                  : 'var(--status-write)'
                              }}
                            >
                              <AlertTriangle className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                              <span>
                                {row.isExhausted
                                  ? '24h limit reached — resets at 00:00 UTC'
                                  : row.isAtOrAbove90
                                    ? '90% threshold reached — only ' +
                                      row.remaining24h +
                                      ' req left until 00:00 UTC'
                                    : 'Approaching 90% threshold — ' +
                                      row.remaining24h +
                                      ' req remaining'}
                              </span>
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </dl>
                </>
              );
            })()}
          </div>

          <div className="pt-3 border-t theme-border flex items-center justify-between text-xs font-mono theme-text-muted tabular-nums">
            <span>Synced AI Models</span>
            <span className="theme-text-primary">
              {models.length > 0 ? `${models.length} models active` : '71 models active'} ·{' '}
              {limits.maxMessageLength.toLocaleString()} chars max
            </span>
          </div>
        </article>
      </section>

      {dataActionError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl border theme-elevated px-4 py-3 text-xs font-mono"
          style={{
            borderColor: 'var(--status-destructive)',
            color: 'var(--status-destructive)'
          }}
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{dataActionError}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section
          aria-label="Conversation History Reset"
          className="rounded-2xl border theme-border theme-elevated p-6 flex flex-col justify-between space-y-5"
        >
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-base font-semibold theme-text-primary">
                Conversation History — Clear All Threads
              </h2>
              <span className="rounded-md border theme-border theme-surface px-2.5 py-0.5 font-mono text-[11px] theme-text-secondary tabular-nums whitespace-nowrap shrink-0">
                {chatCount} active {chatCount === 1 ? 'thread' : 'threads'}
              </span>
            </div>

            <p className="text-xs theme-text-secondary leading-relaxed">
              Perform a one-click conversation reset that wipes all local and cloud chat history while preserving your connected Google Workspace skills, audit trail, and account profile.
            </p>
          </div>

          {clearChatsNotice && (
            <div
              role="status"
              className="flex items-center gap-2 rounded-xl border theme-border theme-canvas px-3.5 py-2.5 text-xs font-mono"
              style={{ color: 'var(--status-read)' }}
            >
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span>{clearChatsNotice}</span>
            </div>
          )}

          <div className="pt-3 border-t theme-border flex items-center justify-between gap-4">
            <span className="font-mono text-[11px] theme-text-muted">
              Preserves profile &amp; connectors
            </span>

            <button
              type="button"
              disabled={clearingChats}
              onClick={handleClearConversationsClick}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border theme-border theme-surface px-4 text-xs font-semibold theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <RotateCcw
                className={`h-3.5 w-3.5 shrink-0 ${clearingChats ? 'animate-spin' : ''}`}
                style={{ color: 'var(--accent-primary)' }}
              />
              <span>{clearingChats ? 'Clearing Conversations…' : 'Clear All Conversations'}</span>
            </button>
          </div>
        </section>

        <section
          aria-label="My Data and Revoke Workspace Access"
          className="rounded-2xl border theme-border theme-elevated p-6 flex flex-col justify-between space-y-5"
        >
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2
                className="font-display text-base font-semibold"
                style={{ color: 'var(--status-destructive)' }}
              >
                My Data &amp; Revoke Workspace Access
              </h2>
              <span className="rounded-md border theme-border theme-surface px-2.5 py-0.5 font-mono text-[11px] theme-text-secondary whitespace-nowrap shrink-0">
                Full Account Reset
              </span>
            </div>

            <p className="text-xs theme-text-secondary leading-relaxed">
              Permanently deletes all chat sessions, messages, pending confirmation records, and audit logs, resets daily usage counters, and revokes any active Google Workspace OAuth token.
            </p>
          </div>

          <div className="pt-3 border-t theme-border flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-[11px] theme-text-muted">
              {hasGoogleToken ? 'OAuth token active' : 'No OAuth token cached'}
            </span>

            {!confirmDeleteStep ? (
              <button
                type="button"
                onClick={() => setConfirmDeleteStep(true)}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border theme-border theme-surface px-4 text-xs font-semibold theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
              >
                <Trash2
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: 'var(--status-destructive)' }}
                />
                <span>Revoke &amp; Delete My Data</span>
              </button>
            ) : (
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => setConfirmDeleteStep(false)}
                  className="inline-flex h-10 items-center justify-center rounded-xl border theme-border theme-surface px-3.5 text-xs font-medium theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={handleConfirmPurge}
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl px-4 text-xs font-semibold text-white transition-opacity hover:opacity-90 whitespace-nowrap shrink-0"
                  style={{ backgroundColor: 'var(--status-destructive)' }}
                >
                  <Trash2 className="h-3.5 w-3.5 shrink-0" />
                  <span>{deleting ? 'Purging All Data…' : 'Confirm Permanent Deletion'}</span>
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
