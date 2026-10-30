import { Cookie, ShieldCheck } from 'lucide-react';
import { useLegalStore } from '../../store/useLegalStore.js';

export function MinimalFooter({ onOpenLegalTab = undefined, visible = false } = {}) {
  const openLegalHub = useLegalStore((state) => state.openLegalHub);
  const openCookieModal = useLegalStore((state) => state.openCookieModal);
  const agreedToTermsVersion = useLegalStore((state) => state.agreedToTermsVersion);

  if (!visible) {
    return null;
  }

  const handleOpenTab = (tabId) => {
    if (typeof onOpenLegalTab === 'function') {
      onOpenLegalTab(tabId);
    }
    openLegalHub(tabId);
  };

  return (
    <footer
      aria-label="Legal and Trust Center Quick Links"
      className="relative w-full py-4 mt-auto border-t theme-border theme-surface px-4 text-[11px] theme-text-secondary print:hidden"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-mono text-[10px] theme-text-muted">
          <ShieldCheck
            className="h-3.5 w-3.5 shrink-0"
            style={{ color: 'var(--accent-primary)' }}
          />
          <span>
            Pryzmium AI outputs may be inaccurate. Verify critical actions &middot; Policy{' '}
            {agreedToTermsVersion}
          </span>
        </div>

        <nav
          aria-label="Legal center links"
          className="flex flex-wrap items-center gap-2 font-mono text-[11px]"
        >
          <button
            type="button"
            onClick={() => handleOpenTab('terms')}
            className="theme-text-secondary hover:theme-text-primary transition-colors"
          >
            Terms
          </button>
          <span className="theme-text-muted" aria-hidden="true">
            &middot;
          </span>
          <button
            type="button"
            onClick={() => handleOpenTab('privacy')}
            className="theme-text-secondary hover:theme-text-primary transition-colors"
          >
            Privacy
          </button>
          <span className="theme-text-muted" aria-hidden="true">
            &middot;
          </span>
          <button
            type="button"
            onClick={() => handleOpenTab('cookies')}
            className="theme-text-secondary hover:theme-text-primary transition-colors"
          >
            Cookies
          </button>
          <span className="theme-text-muted" aria-hidden="true">
            &middot;
          </span>
          <button
            type="button"
            onClick={() => handleOpenTab('safety')}
            className="theme-text-secondary hover:theme-text-primary transition-colors"
          >
            Safety
          </button>
          <span className="theme-text-muted" aria-hidden="true">
            &middot;
          </span>
          <button
            type="button"
            onClick={openCookieModal}
            className="inline-flex items-center gap-1 font-semibold theme-text-primary hover:opacity-85 transition-opacity"
          >
            <Cookie
              className="h-3 w-3 shrink-0"
              style={{ color: 'var(--accent-primary)' }}
            />
            <span>Cookie Settings</span>
          </button>
        </nav>
      </div>
    </footer>
  );
}
