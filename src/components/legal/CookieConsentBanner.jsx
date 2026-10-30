import { Check, Cookie, Lock, Settings2, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLegalStore } from '../../store/useLegalStore.js';

const COOKIE_CATEGORIES = [
  {
    key: 'essential',
    title: 'Strictly Necessary (Locked)',
    badge: 'Always Active',
    locked: true,
    description:
      'Required for cryptographic session authentication, sign-in rate-limit protection, CSRF/replay verification, and storing your privacy consent state.'
  },
  {
    key: 'analytics',
    title: 'Performance & Analytics',
    badge: 'Optional',
    locked: false,
    description:
      'Measures model inference latency, token throughput, and gateway reliability metrics so we can optimize multi-provider routing performance.'
  },
  {
    key: 'functional',
    title: 'Functional Preferences',
    badge: 'Optional',
    locked: false,
    description:
      'Remembers workspace UI preferences including Cream/Dark theme, automatic chat scroll, compact message density, and composer keybindings.'
  }
];

export function CookieConsentBanner({ hidden = false } = {}) {
  const cookiePreferences = useLegalStore((state) => state.cookiePreferences);
  const hasAcceptedCookies = useLegalStore((state) => state.hasAcceptedCookies);
  const isCookieModalOpen = useLegalStore((state) => state.isCookieModalOpen);
  const isLegalHubOpen = useLegalStore((state) => state.isLegalHubOpen);
  const acceptAllCookies = useLegalStore((state) => state.acceptAllCookies);
  const acceptEssentialOnly = useLegalStore((state) => state.acceptEssentialOnly);
  const saveCookiePreferences = useLegalStore((state) => state.saveCookiePreferences);
  const closeCookieModal = useLegalStore((state) => state.closeCookieModal);
  const openLegalHub = useLegalStore((state) => state.openLegalHub);

  const [isManageExpanded, setIsManageExpanded] = useState(false);
  const [draftPreferences, setDraftPreferences] = useState(cookiePreferences);

  useEffect(() => {
    setDraftPreferences(cookiePreferences);
  }, [cookiePreferences, isCookieModalOpen]);

  useEffect(() => {
    if (isCookieModalOpen) {
      setIsManageExpanded(true);
    }
  }, [isCookieModalOpen]);

  const shouldRender = (!hasAcceptedCookies || isCookieModalOpen) && !isLegalHubOpen && !hidden;
  if (!shouldRender) {
    return null;
  }

  const handleToggleDraft = (key) => {
    if (key === 'essential') return;
    setDraftPreferences((prev) => ({
      ...prev,
      [key]: !prev[key],
      essential: true
    }));
  };

  const handleSaveCustom = () => {
    saveCookiePreferences(draftPreferences);
    setIsManageExpanded(false);
  };

  return (
    <aside
      role="region"
      aria-label="Cookie and Privacy Consent Manager"
      className="fixed inset-x-3 bottom-3 sm:left-auto sm:right-5 sm:bottom-5 z-40 max-w-none sm:max-w-md max-h-[80dvh] overflow-y-auto rounded-xl sm:rounded-2xl border theme-border-strong theme-elevated p-4 sm:p-5 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-5 theme-text-primary shadow-2xl backdrop-blur-xl transition-all animate-modal-panel"
    >
      <div className="sm:hidden w-10 h-1.5 rounded-full theme-subtle mx-auto mb-3" aria-hidden="true" />
      <div className="space-y-4">
        <header className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-10 w-10 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-xl border theme-border theme-surface"
              style={{ color: 'var(--accent-primary)' }}
            >
              <Cookie className="h-4 w-4" />
            </div>
            <div>
              <h2 className="font-display text-sm font-semibold tracking-tight theme-text-primary">
                Cookie &amp; Storage Preferences
              </h2>
              <p className="font-mono text-[11px] theme-text-secondary">
                GDPR &amp; Industrial Data Governance
              </p>
            </div>
          </div>

          {hasAcceptedCookies && isCookieModalOpen && (
            <button
              type="button"
              onClick={closeCookieModal}
              aria-label="Close cookie preferences"
              className="inline-flex min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 items-center justify-center rounded-lg border theme-border theme-surface p-2 sm:p-1.5 theme-text-secondary hover:opacity-80 transition-opacity"
            >
              <X className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
            </button>
          )}
        </header>

        <p className="text-xs theme-text-secondary leading-relaxed">
          We use strictly necessary storage to secure your session and enforce workspace rate
          limits. You may opt in to functional and performance telemetry or inspect our{' '}
          <button
            type="button"
            onClick={() => openLegalHub('cookies')}
            className="font-semibold theme-text-primary underline underline-offset-2 hover:opacity-80"
          >
            Cookie Policy
          </button>{' '}
          and{' '}
          <button
            type="button"
            onClick={() => openLegalHub('privacy')}
            className="font-semibold theme-text-primary underline underline-offset-2 hover:opacity-80"
          >
            Privacy Policy
          </button>
          .
        </p>

        {isManageExpanded && (
          <div className="space-y-2.5 rounded-xl border theme-border theme-surface p-3.5">
            {COOKIE_CATEGORIES.map((cat) => {
              const isChecked = cat.locked ? true : Boolean(draftPreferences[cat.key]);
              return (
                <div
                  key={cat.key}
                  className="rounded-lg border theme-border theme-canvas p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {cat.locked ? (
                        <Lock
                          className="h-3.5 w-3.5 shrink-0"
                          style={{ color: 'var(--accent-primary)' }}
                        />
                      ) : (
                        <ShieldCheck
                          className="h-3.5 w-3.5 shrink-0"
                          style={{ color: 'var(--status-read)' }}
                        />
                      )}
                      <span className="text-xs font-semibold theme-text-primary truncate">
                        {cat.title}
                      </span>
                    </div>

                    {cat.locked ? (
                      <span className="rounded border theme-border theme-elevated px-2 py-0.5 font-mono text-[10px] font-semibold theme-text-primary">
                        {cat.badge}
                      </span>
                    ) : (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isChecked}
                        aria-label={`Toggle ${cat.title}`}
                        onClick={() => handleToggleDraft(cat.key)}
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors ${
                          isChecked
                            ? 'theme-btn-primary border-transparent'
                            : 'theme-border theme-surface'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-xs transition-transform ${
                            isChecked ? 'translate-x-5' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    )}
                  </div>

                  <p className="text-[11px] theme-text-secondary leading-relaxed">
                    {cat.description}
                  </p>
                </div>
              );
            })}

            <div className="pt-1 flex justify-end">
              <button
                type="button"
                onClick={handleSaveCustom}
                className="inline-flex h-12 sm:h-9 w-full sm:w-auto items-center justify-center gap-1.5 rounded-xl sm:rounded-lg theme-btn-primary px-4 text-xs font-semibold transition-colors"
              >
                <Check className="h-3.5 w-3.5" />
                <span>Save Selected Preferences</span>
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 pt-1">
          <button
            type="button"
            onClick={acceptAllCookies}
            className="inline-flex h-12 sm:h-9 items-center justify-center gap-1.5 rounded-xl theme-btn-primary px-3 text-xs font-semibold transition-colors whitespace-nowrap"
          >
            <Check className="h-3.5 w-3.5 shrink-0" />
            <span>Accept All</span>
          </button>

          <button
            type="button"
            onClick={acceptEssentialOnly}
            className="inline-flex h-12 sm:h-9 items-center justify-center rounded-xl border theme-border theme-surface px-3 text-xs font-semibold theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap"
          >
            <span>Essential Only</span>
          </button>

          <button
            type="button"
            onClick={() => setIsManageExpanded((prev) => !prev)}
            aria-expanded={isManageExpanded}
            className="inline-flex h-12 sm:h-9 items-center justify-center gap-1.5 rounded-xl border theme-border theme-surface px-3 text-xs font-medium theme-text-secondary hover:opacity-85 transition-opacity whitespace-nowrap"
          >
            <Settings2 className="h-3.5 w-3.5 shrink-0" />
            <span>{isManageExpanded ? 'Hide' : 'Manage'}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
