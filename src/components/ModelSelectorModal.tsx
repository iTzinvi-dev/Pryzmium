import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useState } from 'react';
import { ModelInfo } from '../types/agent.ts';

interface ModelSelectorModalProps {
  models: ModelInfo[];
  selectedModelId: string;
  onSelectModel: (modelId: string) => void;
}

export type ModelPurpose = 'Coding' | 'Reasoning' | 'General' | 'Vision';

const PURPOSE_GROUPS: Array<{
  id: ModelPurpose;
  title: string;
}> = [
  { id: 'Coding', title: 'Coding' },
  { id: 'Reasoning', title: 'Reasoning' },
  { id: 'General', title: 'General' },
  { id: 'Vision', title: 'Vision' }
];

export function classifyModelPurpose(model: ModelInfo): ModelPurpose {
  const idLower = `${model.id} ${model.providerModelName} ${model.label}`.toLowerCase();

  if (
    idLower.includes('coder') ||
    idLower.includes('codestral') ||
    idLower.includes('devstral') ||
    idLower.includes('mini-code') ||
    idLower.includes('deepseek-r1-distill-qwen-32b') ||
    idLower.includes('qwen3.6-35b-a3b')
  ) {
    return 'Coding';
  }

  if (
    idLower.includes('vision') ||
    idLower.includes('-vl-') ||
    idLower.includes('whisper') ||
    idLower.includes('gemini-flash-latest') ||
    idLower.includes('omni-plus')
  ) {
    return 'Vision';
  }

  if (
    idLower.includes('reasoning') ||
    idLower.includes('deepseek-r1') ||
    idLower.includes('405b') ||
    idLower.includes('397b') ||
    idLower.includes('mistral-large') ||
    idLower.includes('mistral-medium') ||
    idLower.includes('qwen3.8-max') ||
    idLower.includes('qwen3.7-max') ||
    idLower.includes('qwen3.6-max') ||
    idLower.includes('qwen3-max') ||
    idLower.includes('qwen3.6-plus')
  ) {
    return 'Reasoning';
  }

  return 'General';
}

export function getModelPerformanceTags(model: ModelInfo): string[] {
  const idLower = `${model.id} ${model.providerModelName} ${model.label}`.toLowerCase();
  const ctxLower = (model.contextWindow || '').toLowerCase();
  const purpose = classifyModelPurpose(model);
  const tags: string[] = [];

  if (
    idLower.includes('flash') ||
    idLower.includes('instant') ||
    idLower.includes('8b') ||
    idLower.includes('9b') ||
    idLower.includes('3b') ||
    idLower.includes('4b') ||
    idLower.includes('mini') ||
    idLower.includes('nano') ||
    idLower.includes('turbo') ||
    model.provider === 'groq'
  ) {
    tags.push('Fast');
  }

  if (
    purpose === 'Reasoning' ||
    idLower.includes('reasoning') ||
    idLower.includes('deepseek-r1') ||
    idLower.includes('max') ||
    idLower.includes('large') ||
    idLower.includes('70b') ||
    idLower.includes('120b') ||
    idLower.includes('397b') ||
    idLower.includes('405b')
  ) {
    tags.push('Reasoning');
  }

  if (
    ctxLower.includes('1m') ||
    ctxLower.includes('256k') ||
    ctxLower.includes('131k') ||
    ctxLower.includes('128k') ||
    idLower.includes('397b') ||
    idLower.includes('405b') ||
    idLower.includes('120b') ||
    idLower.includes('90b') ||
    idLower.includes('80b') ||
    idLower.includes('70b')
  ) {
    tags.push('High Capacity');
  }

  if (purpose === 'Coding' && !tags.includes('Coding')) {
    tags.push('Coding');
  } else if (purpose === 'Vision' && !tags.includes('Vision')) {
    tags.push('Vision');
  }

  if (tags.length === 0) {
    tags.push('Fast', 'High Capacity');
  } else if (tags.length === 1) {
    tags.push(tags[0] === 'Fast' ? 'High Capacity' : 'Fast');
  }

  return tags.slice(0, 3);
}

function getModelOperationalStatus(model: ModelInfo): 'active' | 'downtime' {
  const remaining = model.remaining24h ?? model.dailyLimit24h;
  if (model.providerStatus === 'downtime' || remaining <= 0) {
    return 'downtime';
  }
  return 'active';
}

export function ModelSelectorModal({
  models,
  selectedModelId,
  onSelectModel
}: ModelSelectorModalProps) {
  const [open, setOpen] = useState(false);
  const [activePurpose, setActivePurpose] = useState<'all' | ModelPurpose>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const currentModel = models.find((m) => m.id === selectedModelId) || models[0];
  const activeCount = models.filter((m) => getModelOperationalStatus(m) === 'active').length;

  const purposeFiltered =
    activePurpose === 'all'
      ? models
      : models.filter((m) => classifyModelPurpose(m) === activePurpose);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredModels = normalizedQuery
    ? purposeFiltered.filter(
        (m) =>
          m.label.toLowerCase().includes(normalizedQuery) ||
          m.bestFor.toLowerCase().includes(normalizedQuery) ||
          classifyModelPurpose(m).toLowerCase().includes(normalizedQuery)
      )
    : purposeFiltered;

  const groupedSections = PURPOSE_GROUPS.map((group) => ({
    ...group,
    items: filteredModels.filter((m) => classifyModelPurpose(m) === group.id)
  })).filter((section) => section.items.length > 0);

  const currentModelStatus = currentModel ? getModelOperationalStatus(currentModel) : 'active';
  const isCurrentModelActive = currentModelStatus === 'active';
  const currentRemaining = currentModel
    ? (currentModel.remaining24h ?? currentModel.dailyLimit24h)
    : 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group inline-flex min-h-[38px] sm:min-h-[34px] items-center gap-2 rounded-lg border theme-border theme-canvas hover:theme-surface px-3 py-1.5 text-xs theme-text-primary transition-colors whitespace-nowrap shrink-0 max-w-[68vw] sm:max-w-none overflow-hidden"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full shrink-0 ${
            isCurrentModelActive ? 'status-dot-active' : 'status-dot-downtime'
          }`}
          aria-label={isCurrentModelActive ? 'Model active' : 'Model unavailable'}
        />
        <span className="font-display font-medium tracking-tight truncate">
          {currentModel ? currentModel.label : 'Select Model'}
        </span>
        {currentModel && (
          <span className="hidden sm:inline font-mono text-[11px] theme-text-muted tabular-nums">
            · {currentRemaining}/{currentModel.dailyLimit24h}
          </span>
        )}
        <ChevronDown className="h-3.5 w-3.5 theme-text-muted shrink-0 transition-transform duration-150 group-hover:translate-y-0.5" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
          style={{ backgroundColor: 'rgba(18, 19, 24, 0.5)', backdropFilter: 'blur(4px)' }}
          onClick={() => setOpen(false)}
        >
          <section
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-3xl max-h-[85dvh] sm:max-h-[82dvh] flex flex-col rounded-t-2xl sm:rounded-2xl border theme-border theme-elevated shadow-xl overflow-hidden animate-modal-panel pb-[env(safe-area-inset-bottom)] sm:pb-0"
          >
            <div className="sm:hidden pt-3 pb-1 theme-surface">
              <div
                className="w-9 h-1 rounded-full mx-auto"
                style={{ backgroundColor: 'var(--border-strong)' }}
              />
            </div>

            <header className="flex items-center justify-between gap-4 border-b theme-border theme-surface px-5 sm:px-6 py-4">
              <div className="flex items-baseline gap-3">
                <h2 className="font-display text-base font-semibold tracking-tight theme-text-primary">
                  Models
                </h2>
                <span className="font-mono text-[11px] theme-text-muted tabular-nums">
                  {activeCount}/{models.length} online · resets 00:00 UTC
                </span>
              </div>

              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg theme-text-secondary hover:theme-text-primary hover:theme-elevated transition-colors"
                aria-label="Close modal"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <nav className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b theme-border theme-surface px-5 sm:px-6 py-3">
              <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
                <button
                  type="button"
                  onClick={() => setActivePurpose('all')}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                    activePurpose === 'all'
                      ? 'theme-elevated theme-text-primary border theme-border'
                      : 'theme-text-muted hover:theme-text-primary'
                  }`}
                >
                  All
                </button>
                {PURPOSE_GROUPS.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => setActivePurpose(group.id)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                      activePurpose === group.id
                        ? 'theme-elevated theme-text-primary border theme-border'
                        : 'theme-text-muted hover:theme-text-primary'
                    }`}
                  >
                    {group.title}
                  </button>
                ))}
              </div>

              <div className="relative w-full sm:w-56">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 theme-text-muted" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search models..."
                  className="w-full rounded-lg border theme-border theme-canvas pl-8 pr-7 py-1.5 text-xs theme-text-primary placeholder:theme-text-muted focus:outline-none"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 theme-text-muted hover:theme-text-primary"
                    aria-label="Clear search"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </nav>

            <div className="flex-1 overflow-y-auto px-5 sm:px-6 py-5 space-y-6">
              {groupedSections.length === 0 ? (
                <div className="py-12 text-center space-y-2">
                  <p className="text-xs theme-text-secondary">
                    No models match the current filter.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setActivePurpose('all');
                      setSearchQuery('');
                    }}
                    className="text-xs font-medium underline underline-offset-4 theme-text-primary"
                  >
                    Reset filters
                  </button>
                </div>
              ) : (
                groupedSections.map((section) => (
                  <section key={section.id} className="space-y-2.5">
                    <div className="flex items-center justify-between border-b theme-border pb-1.5">
                      <h3 className="font-mono text-[11px] font-medium uppercase tracking-wider theme-text-muted">
                        {section.title}
                      </h3>
                      <span className="font-mono text-[11px] theme-text-muted tabular-nums">
                        {section.items.length}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {section.items.map((m) => {
                        const isSelected = m.id === selectedModelId;
                        const status = getModelOperationalStatus(m);
                        const isActive = status === 'active';
                        const remaining = m.remaining24h ?? m.dailyLimit24h;

                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              onSelectModel(m.id);
                              setOpen(false);
                            }}
                            className={`group flex flex-col justify-between gap-1.5 rounded-xl border px-4 py-3 text-left transition-colors ${
                              isSelected
                                ? 'theme-surface theme-border-strong'
                                : 'theme-canvas theme-border hover:theme-surface'
                            } ${!isActive ? 'opacity-60' : ''}`}
                          >
                            <div className="flex items-center justify-between gap-2 w-full">
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                                    isActive ? 'status-dot-active' : 'status-dot-downtime'
                                  }`}
                                />
                                <span className="font-display text-[13px] font-semibold tracking-tight theme-text-primary truncate">
                                  {m.label}
                                </span>
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                <span className="font-mono text-[11px] theme-text-muted tabular-nums">
                                  {m.contextWindow} · {remaining}/{m.dailyLimit24h}
                                </span>
                                {isSelected && (
                                  <Check className="h-3.5 w-3.5 shrink-0 theme-text-primary" />
                                )}
                              </div>
                            </div>

                            <p className="text-xs theme-text-secondary line-clamp-1 pl-3.5">
                              {m.bestFor}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
