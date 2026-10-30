import { CheckCircle2, Cookie, FileCheck, Lock, LogOut, Scale, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LEGAL_DOCUMENTS } from '../data/legalDocuments.js';

export type LegalTabId = 'terms' | 'privacy' | 'cookies' | 'safety' | 'agreement';

interface LegalSecurityModalProps {
  open: boolean;
  mode?: 'consent' | 'review';
  initialTab?: LegalTabId;
  accountLabel?: string;
  onAcceptAll: () => void;
  onClose?: () => void;
  onDeclineAndSignOut?: () => void;
}

function normalizeTabId(tab: LegalTabId): 'terms' | 'privacy' | 'cookies' | 'safety' {
  if (tab === 'agreement' || tab === 'terms') return 'terms';
  if (tab === 'cookies') return 'cookies';
  if (tab === 'safety') return 'safety';
  return 'privacy';
}

export function LegalSecurityModal({
  open,
  mode = 'consent',
  initialTab = 'privacy',
  accountLabel,
  onAcceptAll,
  onClose,
  onDeclineAndSignOut
}: LegalSecurityModalProps) {
  const [activeTab, setActiveTab] = useState<'terms' | 'privacy' | 'cookies' | 'safety'>(
    normalizeTabId(initialTab)
  );
  const [checkedCookies, setCheckedCookies] = useState(false);
  const [checkedAgreement, setCheckedAgreement] = useState(false);

  useEffect(() => {
    if (open) {
      setActiveTab(normalizeTabId(initialTab));
      setCheckedCookies(false);
      setCheckedAgreement(false);
    }
  }, [open, initialTab, accountLabel]);

  if (!open) return null;

  const canProceed = checkedCookies && checkedAgreement;
  const isReviewMode = mode === 'review';
  const activeDocument = LEGAL_DOCUMENTS[activeTab] || LEGAL_DOCUMENTS.privacy;

  return (
    <div
      className="fixed inset-0 z-50 theme-canvas theme-text-primary flex flex-col h-[100dvh] w-full overflow-x-hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-policy-modal-title"
    >
      <header className="shrink-0 z-30 p-4 pt-[calc(0.75rem+env(safe-area-inset-top))] border-b theme-border theme-surface flex items-center justify-between gap-3">
        <nav
          aria-label="Policy sections"
          className="flex items-center gap-2 overflow-x-auto no-scrollbar snap-x min-w-0 flex-1"
        >
          {(
            [
              { id: 'terms', label: 'Terms', icon: Scale },
              { id: 'privacy', label: 'Privacy', icon: FileCheck },
              { id: 'cookies', label: 'Cookies', icon: Cookie },
              { id: 'safety', label: 'Safety', icon: ShieldCheck }
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const isSelected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`snap-start inline-flex h-10 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  isSelected
                    ? 'theme-btn-primary border-transparent font-semibold'
                    : 'theme-border theme-elevated theme-text-secondary hover:opacity-85'
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close legal and privacy modal"
            className="shrink-0 inline-flex items-center justify-center px-3 py-1.5 min-h-[40px] rounded-lg border theme-border theme-elevated text-xs font-semibold theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap"
          >
            <span>✕ Close</span>
          </button>
        )}
      </header>

      <section className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-3xl space-y-4 text-sm sm:text-base leading-relaxed theme-text-secondary pb-6">
          <div className="rounded-2xl border theme-border theme-elevated p-4 sm:p-6 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono theme-text-muted">
              <span style={{ color: 'var(--accent-primary)' }}>
                {isReviewMode
                  ? 'Mandatory International Compliance Policy'
                  : 'One-Time Mandatory Onboarding Acceptance'}
              </span>
              <span>
                Version {activeDocument.version} &middot; {activeDocument.effectiveDate}
              </span>
            </div>
            <h2
              id="legal-policy-modal-title"
              className="font-display text-xl sm:text-2xl font-bold theme-text-primary"
            >
              {activeDocument.title}
            </h2>
            <p className="text-xs sm:text-sm theme-text-secondary leading-relaxed">
              Written in clear language: what data we collect, why we collect it, retention schedules, cookie safety controls, and workspace operational rules.
            </p>
          </div>

          <div className="rounded-2xl border theme-border theme-elevated p-4 sm:p-6 space-y-3">
            <h3
              className="font-mono text-xs font-semibold uppercase tracking-wider"
              style={{ color: 'var(--accent-primary)' }}
            >
              Executive Summary (TL;DR)
            </h3>
            <ul className="space-y-2 text-sm sm:text-base theme-text-secondary leading-relaxed">
              {activeDocument.summary.map((item: string, idx: number) => (
                <li key={idx} className="flex items-start gap-2.5">
                  <span
                    className="mt-2 h-1.5 w-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: 'var(--accent-primary)' }}
                    aria-hidden="true"
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-4">
            {activeDocument.sections.map(
              (sec: { id: string; heading: string; content: string[] }) => (
                <article
                  key={sec.id}
                  className="rounded-2xl border theme-border theme-elevated p-4 sm:p-6 space-y-3"
                >
                  <h4 className="font-display text-base sm:text-lg font-semibold theme-text-primary">
                    {sec.heading}
                  </h4>
                  <div className="space-y-3 text-sm sm:text-base leading-relaxed theme-text-secondary">
                    {sec.content.map((p: string, pIdx: number) => (
                      <p key={pIdx}>{p}</p>
                    ))}
                  </div>
                </article>
              )
            )}
          </div>
        </div>
      </section>

      <footer className="shrink-0 border-t theme-border theme-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-6">
        <div className="mx-auto max-w-3xl space-y-3">
          {isReviewMode ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs theme-text-secondary">
                <Lock className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--status-read)' }} />
                <span>
                  Your account consent is active. You can manage or delete your workspace data anytime in Profile.
                </span>
              </div>
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex h-11 sm:h-9 w-full sm:w-auto items-center justify-center rounded-xl theme-btn-primary px-4 text-xs font-semibold transition-opacity hover:opacity-90 whitespace-nowrap shrink-0"
                >
                  Close Policy View
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <label className="flex items-start gap-2.5 text-xs theme-text-primary cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={checkedCookies}
                    onChange={(e) => setCheckedCookies(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded accent-[var(--accent-primary)] shrink-0"
                  />
                  <span>
                    I have read and accept the <strong>Cookie Policy &amp; Safety Terms</strong> (strictly necessary session, preference, and local search history storage only).
                  </span>
                </label>
                <label className="flex items-start gap-2.5 text-xs theme-text-primary cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={checkedAgreement}
                    onChange={(e) => setCheckedAgreement(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded accent-[var(--accent-primary)] shrink-0"
                  />
                  <span>
                    I have read and accept the <strong>Privacy Policy, Terms of Service &amp; Safety Rules</strong>.
                  </span>
                </label>
              </div>

              <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center justify-between gap-2.5 pt-1">
                {onDeclineAndSignOut ? (
                  <button
                    type="button"
                    onClick={onDeclineAndSignOut}
                    className="inline-flex h-11 sm:h-9 w-full sm:w-auto items-center justify-center gap-1.5 rounded-xl border theme-border theme-elevated px-3.5 text-xs font-medium theme-text-secondary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
                  >
                    <LogOut
                      className="h-3.5 w-3.5 shrink-0"
                      style={{ color: 'var(--status-destructive)' }}
                    />
                    <span>Decline</span>
                  </button>
                ) : (
                  <div />
                )}

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  {!canProceed && (
                    <button
                      type="button"
                      onClick={() => {
                        setCheckedCookies(true);
                        setCheckedAgreement(true);
                      }}
                      className="inline-flex h-11 sm:h-9 items-center justify-center rounded-xl border theme-border theme-elevated px-3.5 text-xs font-medium theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
                    >
                      Check All Policies
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={!canProceed}
                    onClick={onAcceptAll}
                    className="inline-flex h-11 sm:h-9 items-center justify-center gap-1.5 rounded-xl theme-btn-primary px-4 text-xs font-semibold transition-opacity disabled:opacity-40 whitespace-nowrap shrink-0"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    <span>Accept Policies &amp; Continue</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}
