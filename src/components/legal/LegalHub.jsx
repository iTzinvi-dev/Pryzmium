import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Cookie,
  FileText,
  Lock,
  Menu,
  Printer,
  Scale,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LEGAL_DOCUMENTS, LEGAL_TABS } from '../../data/legalDocuments.js';
import { useLegalStore } from '../../store/useLegalStore.js';

function getTabIcon(tabId) {
  switch (tabId) {
    case 'terms':
      return <Scale className="h-4 w-4 shrink-0" />;
    case 'privacy':
      return <Lock className="h-4 w-4 shrink-0" />;
    case 'cookies':
      return <Cookie className="h-4 w-4 shrink-0" />;
    case 'safety':
      return <ShieldCheck className="h-4 w-4 shrink-0" />;
    default:
      return <FileText className="h-4 w-4 shrink-0" />;
  }
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHighlightedText(text, query) {
  const trimmed = (query || '').trim();
  if (!trimmed || !text) {
    return text;
  }

  const regex = new RegExp(`(${escapeRegExp(trimmed)})`, 'gi');
  const parts = text.split(regex);
  if (parts.length === 1) {
    return text;
  }

  const needle = trimmed.toLowerCase();
  return parts.map((part, idx) =>
    part.toLowerCase() === needle ? (
      <mark key={idx} className="chat-search-highlight">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

export function LegalHub({ onBackToApp = undefined, standalone = false } = {}) {
  const activeTab = useLegalStore((state) => state.activeTab);
  const setActiveTab = useLegalStore((state) => state.setActiveTab);
  const closeLegalHub = useLegalStore((state) => state.closeLegalHub);
  const openCookieModal = useLegalStore((state) => state.openCookieModal);
  const agreedToTermsVersion = useLegalStore((state) => state.agreedToTermsVersion);
  const setAgreedToTermsVersion = useLegalStore((state) => state.setAgreedToTermsVersion);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeSectionId, setActiveSectionId] = useState('');
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [acknowledgedNotice, setAcknowledgedNotice] = useState(false);

  const scrollContainerRef = useRef(null);

  const activeDocument = useMemo(
    () => LEGAL_DOCUMENTS[activeTab] || LEGAL_DOCUMENTS.terms,
    [activeTab]
  );

  const filteredSections = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return activeDocument.sections;
    }
    return activeDocument.sections.filter(
      (sec) =>
        sec.heading.toLowerCase().includes(q) ||
        sec.content.some((paragraph) => paragraph.toLowerCase().includes(q))
    );
  }, [activeDocument, searchQuery]);

  const crossDocMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return {};
    const counts = {};
    for (const tab of LEGAL_TABS) {
      const doc = LEGAL_DOCUMENTS[tab.id];
      if (!doc) continue;
      let matches = 0;
      for (const sec of doc.sections) {
        if (sec.heading.toLowerCase().includes(q)) matches += 1;
        for (const p of sec.content) {
          if (p.toLowerCase().includes(q)) matches += 1;
        }
      }
      counts[tab.id] = matches;
    }
    return counts;
  }, [searchQuery]);

  useEffect(() => {
    if (filteredSections.length > 0) {
      setActiveSectionId(filteredSections[0].id);
    }
  }, [activeTab, filteredSections]);

  useEffect(() => {
    const rootEl = scrollContainerRef.current;
    const sectionElements = filteredSections
      .map((sec) => document.getElementById(sec.id))
      .filter(Boolean);

    if (sectionElements.length === 0) {
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

        if (visible.length > 0 && visible[0].target?.id) {
          setActiveSectionId(visible[0].target.id);
        }
      },
      {
        root: rootEl || null,
        rootMargin: '-10% 0px -70% 0px',
        threshold: [0, 0.2, 0.5, 1]
      }
    );

    for (const el of sectionElements) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [filteredSections, activeTab]);

  const handleScrollToSection = (sectionId) => {
    setActiveSectionId(sectionId);
    setMobileDrawerOpen(false);
    const target = document.getElementById(sectionId);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handleReturnHome = () => {
    if (typeof onBackToApp === 'function') {
      onBackToApp();
    } else {
      closeLegalHub();
    }
  };

  const handleAcknowledgeVersion = () => {
    setAgreedToTermsVersion(activeDocument.version);
    setAcknowledgedNotice(true);
    window.setTimeout(() => setAcknowledgedNotice(false), 2500);
  };

  return (
    <div
      className={`${
        standalone ? 'min-h-[100dvh]' : 'fixed inset-0 z-50 h-[100dvh]'
      } w-full flex flex-col overflow-x-hidden theme-canvas theme-text-primary`}
      role="dialog"
      aria-modal="true"
      aria-label="Legal and Trust Center"
    >
      <header className="shrink-0 z-30 border-b theme-border theme-surface p-4 pt-[calc(0.75rem+env(safe-area-inset-top))] print:hidden">
        <div className="mx-auto flex max-w-7xl flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <nav
              aria-label="Legal Document Tabs"
              className="flex items-center gap-2 overflow-x-auto no-scrollbar snap-x min-w-0 flex-1"
            >
              {LEGAL_TABS.map((tab) => {
                const isSelected = activeTab === tab.id;
                const matchCount = crossDocMatches[tab.id] || 0;
                const shortLabel =
                  tab.id === 'terms'
                    ? 'Terms'
                    : tab.id === 'privacy'
                      ? 'Privacy'
                      : tab.id === 'cookies'
                        ? 'Cookies'
                        : 'Safety';
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`snap-start inline-flex h-10 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                      isSelected
                        ? 'theme-btn-primary border-transparent font-semibold'
                        : 'theme-border theme-elevated theme-text-secondary hover:opacity-85'
                    }`}
                  >
                    {getTabIcon(tab.id)}
                    <span className="sm:hidden">{shortLabel}</span>
                    <span className="hidden sm:inline">{tab.label}</span>
                    {searchQuery.trim() ? (
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                          isSelected
                            ? 'bg-black/15 text-current'
                            : 'theme-surface theme-text-primary'
                        }`}
                      >
                        {matchCount}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </nav>

            <button
              type="button"
              onClick={handleReturnHome}
              aria-label="Close Legal and Trust Center"
              className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-[40px] rounded-lg border theme-border theme-elevated text-xs font-semibold theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap"
            >
              <span>✕ Close</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={() => setMobileDrawerOpen((prev) => !prev)}
                aria-label="Open table of contents"
                className="inline-flex lg:hidden h-10 items-center gap-1.5 rounded-lg border theme-border theme-elevated px-3 text-xs font-medium theme-text-primary hover:opacity-85 transition-opacity shrink-0"
              >
                {mobileDrawerOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
                <span>Clauses ({filteredSections.length})</span>
              </button>

              <nav aria-label="Breadcrumb" className="hidden sm:flex items-center gap-2 text-xs min-w-0">
                <button
                  type="button"
                  onClick={handleReturnHome}
                  className="inline-flex items-center gap-1.5 font-medium theme-text-secondary hover:opacity-85 transition-opacity shrink-0"
                >
                  <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
                  <span>App Home</span>
                </button>
                <ChevronRight className="h-3.5 w-3.5 theme-text-muted shrink-0" />
                <span className="font-semibold theme-text-primary truncate">
                  Legal &amp; Trust Center
                </span>
                <ChevronRight className="h-3.5 w-3.5 theme-text-muted shrink-0" />
                <span className="font-mono text-xs theme-text-secondary truncate">
                  {activeDocument.title}
                </span>
              </nav>
            </div>

            <div className="flex flex-1 sm:flex-initial items-center justify-end gap-2 min-w-[200px]">
              <div className="flex flex-1 sm:w-64 items-center gap-2 rounded-lg border theme-border theme-elevated px-3 h-10">
                <Search className="h-3.5 w-3.5 shrink-0 theme-text-muted" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter clauses or keywords…"
                  aria-label="Search across legal documents"
                  className="w-full bg-transparent text-base md:text-xs theme-text-primary placeholder:opacity-60 focus:outline-none"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search query"
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded theme-text-muted hover:opacity-85"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => window.print()}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border theme-border theme-elevated px-3 text-xs font-semibold theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
              >
                <Printer className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                <span className="hidden sm:inline">Print / Save as PDF</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {mobileDrawerOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden flex flex-col justify-end bg-black/65 backdrop-blur-xs"
          onClick={() => setMobileDrawerOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Legal Document Table of Contents"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full rounded-t-2xl max-h-[85dvh] overflow-y-auto border-t theme-border theme-surface p-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] theme-text-primary shadow-2xl animate-modal-panel space-y-5"
          >
            <div className="w-10 h-1.5 rounded-full theme-subtle mx-auto" aria-hidden="true" />

            <div className="flex items-center justify-between border-b theme-border pb-3">
              <div>
                <h2 className="font-display text-base font-semibold theme-text-primary">
                  Document Navigation &amp; Clauses
                </h2>
                <p className="font-mono text-[11px] theme-text-muted">
                  {activeDocument.title} ({filteredSections.length} sections)
                </p>
              </div>
              <button
                type="button"
                onClick={() => setMobileDrawerOpen(false)}
                aria-label="Close table of contents sheet"
                className="inline-flex h-11 w-11 items-center justify-center rounded-xl border theme-border theme-elevated theme-text-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <ol className="space-y-1.5">
              {filteredSections.map((sec) => {
                const isActive = activeSectionId === sec.id;
                return (
                  <li key={sec.id}>
                    <button
                      type="button"
                      onClick={() => handleScrollToSection(sec.id)}
                      className={`w-full min-h-[48px] flex items-center rounded-xl border px-3.5 py-2.5 text-left text-xs transition-colors ${
                        isActive
                          ? 'theme-border-strong theme-elevated font-semibold theme-text-primary'
                          : 'theme-border theme-canvas theme-text-secondary hover:opacity-85'
                      }`}
                    >
                      <span className="line-clamp-1">{sec.heading}</span>
                    </button>
                  </li>
                );
              })}
            </ol>

            <div className="border-t theme-border pt-4 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setMobileDrawerOpen(false);
                  openCookieModal();
                }}
                className="w-full h-12 inline-flex items-center justify-center gap-2 rounded-xl theme-btn-primary px-4 text-xs font-semibold"
              >
                <Cookie className="h-4 w-4 shrink-0" />
                <span>Configure Cookie Preferences</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4 sm:p-6 scroll-smooth">
        <div className="mx-auto grid max-w-7xl grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 pb-[calc(2.5rem+env(safe-area-inset-bottom))]">
          <aside
            aria-label="Legal Document Navigation and Table of Contents"
            className="hidden lg:block lg:col-span-4 xl:col-span-3 print:hidden"
          >
            <div className="lg:sticky lg:top-6 space-y-6 rounded-2xl border theme-border theme-surface p-5">
              <div className="space-y-2">
                <p className="font-mono text-[11px] font-semibold uppercase tracking-wider theme-text-muted">
                  Document Switcher
                </p>
                <nav className="flex flex-col gap-1.5" aria-label="Legal Documents">
                  {LEGAL_TABS.map((tab) => {
                    const isSelected = activeTab === tab.id;
                    const matchCount = crossDocMatches[tab.id] || 0;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                        className={`flex min-h-[44px] items-center justify-between gap-2 rounded-xl px-3.5 py-2.5 text-left text-xs font-medium transition-all ${
                          isSelected
                            ? 'theme-btn-primary font-semibold shadow-2xs'
                            : 'border border-transparent theme-text-secondary hover:opacity-85'
                        }`}
                      >
                        <span className="flex items-center gap-2.5 truncate">
                          {getTabIcon(tab.id)}
                          <span className="truncate">{tab.label}</span>
                        </span>
                        {searchQuery.trim() ? (
                          <span
                            className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${
                              isSelected
                                ? 'border-transparent bg-black/15 text-current'
                                : 'theme-border theme-elevated theme-text-primary'
                            }`}
                          >
                            {matchCount}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </nav>
              </div>

              <div className="border-t theme-border pt-5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <p className="font-mono text-[11px] font-semibold uppercase tracking-wider theme-text-muted">
                    On-Page Clauses
                  </p>
                  <span className="font-mono text-[10px] theme-text-muted">
                    {filteredSections.length} sections
                  </span>
                </div>

                {filteredSections.length === 0 ? (
                  <p className="text-xs theme-text-muted py-2">
                    No matching sections in this document.
                  </p>
                ) : (
                  <ol className="space-y-1 border-l theme-border">
                    {filteredSections.map((sec) => {
                      const isActive = activeSectionId === sec.id;
                      return (
                        <li key={sec.id}>
                          <button
                            type="button"
                            onClick={() => handleScrollToSection(sec.id)}
                            className={`w-full border-l-2 py-2 pl-3 pr-2 text-left text-xs transition-all ${
                              isActive
                                ? 'theme-elevated font-semibold theme-text-primary'
                                : 'border-transparent theme-text-secondary hover:opacity-85'
                            }`}
                            style={{
                              borderLeftColor: isActive ? 'var(--accent-primary)' : 'transparent'
                            }}
                          >
                            <span className="line-clamp-1">{sec.heading}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>

              <div className="border-t theme-border pt-4 space-y-2.5">
                <div className="flex items-center justify-between text-[11px] font-mono theme-text-secondary">
                  <span>Agreed Version</span>
                  <span className="rounded border theme-border theme-elevated px-2 py-0.5 theme-text-primary">
                    {agreedToTermsVersion}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={openCookieModal}
                  className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border theme-border theme-elevated px-3 py-2 text-xs font-medium theme-text-primary hover:opacity-85 transition-opacity"
                >
                  <Cookie className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                  <span>Configure Cookie Preferences</span>
                </button>
              </div>
            </div>
          </aside>

          <main className="lg:col-span-8 xl:col-span-9">
            <article className="mx-auto max-w-3xl space-y-4 sm:space-y-6 text-sm sm:text-base leading-relaxed theme-text-secondary pb-16">
              <header className="space-y-4 border-b theme-border pb-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="inline-flex flex-wrap items-center gap-2 text-xs font-mono theme-text-secondary">
                    <span className="inline-flex items-center gap-1.5 rounded-lg border theme-border theme-elevated px-3 py-1 font-semibold theme-text-primary">
                      <BookOpen className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                      <span>Version {activeDocument.version}</span>
                    </span>
                    <span className="rounded-lg border theme-border theme-surface px-3 py-1 theme-text-secondary">
                      Last Updated: {activeDocument.effectiveDate}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={handleAcknowledgeVersion}
                    className="inline-flex h-11 sm:h-9 items-center gap-1.5 rounded-xl sm:rounded-lg border theme-border theme-elevated px-3.5 font-mono text-xs font-medium theme-text-primary hover:opacity-85 transition-opacity print:hidden"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--status-read)' }} />
                    <span>
                      {acknowledgedNotice
                        ? `Recorded ${activeDocument.version}`
                        : `Acknowledge ${activeDocument.version}`}
                    </span>
                  </button>
                </div>

                <h1 className="font-display text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight theme-text-primary">
                  {activeDocument.title}
                </h1>

                <p className="text-sm sm:text-base theme-text-secondary leading-relaxed">
                  Industrial Governance &amp; Compliance Architecture for Pryzmium AI Workspace.
                  Please review the plain-English summary and binding operational clauses below.
                </p>
              </header>

              <section
                aria-label="Executive Plain-English Summary"
                className="rounded-2xl border theme-border theme-elevated p-4 sm:p-6 space-y-3.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div
                    className="flex items-center gap-2 text-xs font-mono font-semibold uppercase tracking-wider"
                    style={{ color: 'var(--accent-primary)' }}
                  >
                    <Sparkles className="h-4 w-4 shrink-0" />
                    <span>Human-Readable Summary (TL;DR)</span>
                  </div>
                  <span className="font-mono text-[11px] theme-text-muted">
                    Plain-English Overview
                  </span>
                </div>

                <ul className="space-y-2.5 text-sm sm:text-base theme-text-secondary leading-relaxed">
                  {activeDocument.summary.map((point, index) => (
                    <li key={index} className="flex items-start gap-2.5">
                      <span
                        className="mt-2 h-1.5 w-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: 'var(--accent-primary)' }}
                        aria-hidden="true"
                      />
                      <span>{renderHighlightedText(point, searchQuery)}</span>
                    </li>
                  ))}
                </ul>
              </section>

              {filteredSections.length === 0 ? (
                <section className="rounded-2xl border theme-border theme-elevated p-6 sm:p-8 text-center space-y-3">
                  <ShieldAlert
                    className="mx-auto h-6 w-6"
                    style={{ color: 'var(--accent-primary)' }}
                  />
                  <h2 className="font-display text-base font-semibold theme-text-primary">
                    No clauses matched &ldquo;{searchQuery}&rdquo;
                  </h2>
                  <p className="text-xs theme-text-secondary">
                    Try clearing the filter or switching to another document tab above.
                  </p>
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="inline-flex h-12 sm:h-9 items-center justify-center rounded-xl sm:rounded-lg theme-btn-primary px-4 text-xs font-semibold"
                  >
                    Reset Filter
                  </button>
                </section>
              ) : (
                <div className="space-y-4 sm:space-y-6">
                  {filteredSections.map((section) => (
                    <section
                      key={section.id}
                      id={section.id}
                      className="scroll-mt-28 rounded-2xl border theme-border theme-elevated p-4 sm:p-6 md:p-7 space-y-4 transition-colors"
                    >
                      <h2 className="font-display text-lg sm:text-xl font-semibold theme-text-primary">
                        {renderHighlightedText(section.heading, searchQuery)}
                      </h2>
                      <div className="theme-text-secondary leading-relaxed space-y-4 text-sm sm:text-base">
                        {section.content.map((paragraph, pIdx) => (
                          <p key={pIdx}>{renderHighlightedText(paragraph, searchQuery)}</p>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}

              <footer className="rounded-2xl border theme-border theme-elevated p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs theme-text-secondary">
                <div>
                  <p className="font-semibold theme-text-primary">
                    Questions regarding compliance, data sovereignty, or OAuth verification?
                  </p>
                  <p className="mt-0.5">
                    Use the self-service Data &amp; Revocation controls in your Workspace Profile
                    or adjust your Cookie Preferences anytime.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleReturnHome}
                  className="inline-flex h-12 sm:h-10 items-center justify-center gap-1.5 rounded-xl theme-btn-primary px-4 text-xs font-semibold shrink-0 print:hidden"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  <span>Return to Workspace</span>
                </button>
              </footer>
            </article>
          </main>
        </div>
      </div>
    </div>
  );
}
