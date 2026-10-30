import {
  Calendar,
  CheckCircle2,
  CheckSquare,
  FileText,
  FolderSearch,
  Globe,
  Link2,
  Link2Off,
  Mail,
  MapPin,
  NotebookPen,
  Terminal
} from 'lucide-react';
import { useState } from 'react';
import { ConnectorId, ToolInfo } from '../types/agent.ts';

interface ConnectionsViewProps {
  uid: string;
  hasGoogleToken: boolean;
  connectedProviders: ConnectorId[];
  tools: ToolInfo[];
  onConnectGoogleWorkspace: () => Promise<void>;
  onToggleConnector: (connector: ConnectorId, enabled: boolean) => void;
  onDisconnectAllGoogle: () => Promise<void>;
}

export function ConnectionsView({
  hasGoogleToken,
  connectedProviders,
  tools,
  onConnectGoogleWorkspace,
  onToggleConnector,
  onDisconnectAllGoogle
}: ConnectionsViewProps) {
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'google_oauth' | 'skills'>('all');

  const handleConnectClick = async () => {
    setConnecting(true);
    setStatusMessage(null);
    try {
      await onConnectGoogleWorkspace();
      setStatusMessage(
        'Google Workspace integrations (Gmail, Calendar, Drive, Docs, Tasks) authorized.'
      );
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Failed to connect Google Workspace.');
    } finally {
      setConnecting(false);
    }
  };

  const handleRevokeClick = async () => {
    setDisconnecting(true);
    setStatusMessage(null);
    try {
      await onDisconnectAllGoogle();
      setStatusMessage('Disconnected Google Workspace apps.');
    } catch (err) {
      setStatusMessage(
        err instanceof Error ? err.message : 'Failed to disconnect Google Workspace.'
      );
    } finally {
      setDisconnecting(false);
    }
  };

  const connectorDefinitions: Array<{
    id: ConnectorId;
    title: string;
    category: 'google_oauth' | 'skills';
    subtitle: string;
    scopes: string[];
    icon: typeof Mail;
    requiresGoogleOAuth: boolean;
    alwaysOn?: boolean;
  }> = [
    {
      id: 'gmail',
      title: 'Gmail',
      category: 'google_oauth',
      subtitle: 'Search up to 20 message headers, read sanitized emails, create drafts, and send confirmed emails.',
      scopes: ['gmail.readonly', 'gmail.compose'],
      icon: Mail,
      requiresGoogleOAuth: true
    },
    {
      id: 'calendar',
      title: 'Google Calendar',
      category: 'google_oauth',
      subtitle: 'List upcoming primary calendar events and schedule confirmed meetings with attendees.',
      scopes: ['calendar.events'],
      icon: Calendar,
      requiresGoogleOAuth: true
    },
    {
      id: 'drive',
      title: 'Google Drive',
      category: 'google_oauth',
      subtitle: 'Search files and document metadata across your Google Drive workspace.',
      scopes: ['drive.readonly'],
      icon: FolderSearch,
      requiresGoogleOAuth: true
    },
    {
      id: 'docs',
      title: 'Google Docs',
      category: 'google_oauth',
      subtitle: 'Read structural paragraph text from Google Docs and create new documents with confirmation.',
      scopes: ['documents'],
      icon: FileText,
      requiresGoogleOAuth: true
    },
    {
      id: 'tasks',
      title: 'Google Tasks',
      category: 'google_oauth',
      subtitle: 'Inspect to-do items and create new tasks with due dates on your primary Google Tasks list.',
      scopes: ['tasks'],
      icon: CheckSquare,
      requiresGoogleOAuth: true
    },
    {
      id: 'notes',
      title: 'Workspace Notes',
      category: 'skills',
      subtitle: 'Create, list, filter by tag, and manage persistent notes in your private agent vault.',
      scopes: ['vault.notes'],
      icon: NotebookPen,
      requiresGoogleOAuth: false
    },
    {
      id: 'maps',
      title: 'Google Maps Skill',
      category: 'skills',
      subtitle: 'Search real-world places, addresses, local businesses, and reviews with verified Maps links.',
      scopes: ['maps.grounding'],
      icon: MapPin,
      requiresGoogleOAuth: false
    },
    {
      id: 'search',
      title: 'Google Search Skill',
      category: 'skills',
      subtitle: 'Live web search grounding returning up-to-date facts and verified source citation links.',
      scopes: ['search.grounding'],
      icon: Globe,
      requiresGoogleOAuth: false
    },
    {
      id: 'system',
      title: 'System Runtime Utilities',
      category: 'skills',
      subtitle: 'IANA timezone clock inspection and HTTPS-only sanitized webpage summary fetcher.',
      scopes: ['runtime.core'],
      icon: Terminal,
      requiresGoogleOAuth: false,
      alwaysOn: true
    }
  ];

  const visibleConnectors = connectorDefinitions.filter((c) =>
    categoryFilter === 'all' ? true : c.category === categoryFilter
  );

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 md:p-8 space-y-6 sm:space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4 sm:gap-6 border-b theme-border pb-5 sm:pb-6">
        <div className="space-y-1.5">
          <h1 className="font-display text-2xl sm:text-3xl font-semibold theme-text-primary">
            Connectors &amp; Agent Skills
          </h1>
          <p className="text-xs sm:text-sm theme-text-secondary max-w-2xl leading-relaxed">
            Manage Google Workspace OAuth integrations (Gmail, Calendar, Drive, Docs, Tasks) and built-in skills (Notes, Google Maps, Google Search). Only active connectors attach their tools to the agent loop.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto shrink-0">
          {hasGoogleToken && (
            <button
              type="button"
              disabled={disconnecting}
              onClick={handleRevokeClick}
              className="inline-flex h-12 sm:h-10 flex-1 sm:flex-initial items-center justify-center gap-2 rounded-xl border theme-border theme-surface px-4 text-xs font-medium theme-text-primary hover:opacity-80 transition-opacity whitespace-nowrap shrink-0"
            >
              <Link2Off className="h-3.5 w-3.5" style={{ color: 'var(--status-destructive)' }} />
              {disconnecting ? 'Revoking…' : 'Disconnect Google OAuth'}
            </button>
          )}
          <button
            type="button"
            disabled={connecting}
            onClick={handleConnectClick}
            className="inline-flex h-12 sm:h-10 flex-1 sm:flex-initial items-center justify-center gap-2 rounded-xl theme-btn-primary px-4 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
          >
            <Link2 className="h-3.5 w-3.5" />
            {connecting
              ? 'Authorizing…'
              : hasGoogleToken
                ? 'Refresh Google OAuth'
                : 'Connect Google Workspace'}
          </button>
        </div>
      </div>

      {statusMessage && (
        <div className="rounded-xl border theme-border theme-surface px-4 py-3 text-xs theme-text-primary">
          {statusMessage}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar snap-x rounded-xl border theme-border theme-surface p-1 max-w-full">
          {(
            [
              { id: 'all', label: 'All Connectors (9)' },
              { id: 'google_oauth', label: 'Google Workspace OAuth (5)' },
              { id: 'skills', label: 'Built-in Skills & Notes (4)' }
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setCategoryFilter(tab.id)}
              className={`snap-start min-h-[40px] sm:min-h-0 rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                categoryFilter === tab.id
                  ? 'theme-elevated theme-text-primary shadow-xs font-semibold'
                  : 'theme-text-secondary hover:opacity-80'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <p className="text-xs font-mono theme-text-muted tabular-nums">
          Active in Agent Loop: {connectedProviders.length} / {connectorDefinitions.length}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
        {visibleConnectors.map((conn) => {
          const Icon = conn.icon;
          const isEnabled =
            conn.alwaysOn ||
            (conn.requiresGoogleOAuth
              ? hasGoogleToken && connectedProviders.includes(conn.id)
              : connectedProviders.includes(conn.id));
          const connectorTools = tools.filter((t) => t.connector === conn.id);

          return (
            <article
              key={conn.id}
              className="rounded-xl border theme-border theme-elevated p-4 sm:p-5 flex flex-col justify-between gap-4 sm:gap-5"
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg border theme-border theme-surface">
                      <Icon className="h-4 w-4" style={{ color: 'var(--accent-primary)' }} />
                    </div>
                    <div>
                      <h2 className="font-display text-sm font-semibold theme-text-primary">
                        {conn.title}
                      </h2>
                      <p className="text-[11px] font-mono theme-text-muted">
                        {isEnabled ? 'Active · Tools Attached' : 'Inactive · Tools Omitted'}
                      </p>
                    </div>
                  </div>

                  {!conn.alwaysOn ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (conn.requiresGoogleOAuth && !hasGoogleToken) {
                          handleConnectClick();
                        } else {
                          onToggleConnector(conn.id, !isEnabled);
                        }
                      }}
                      className={`min-h-[40px] sm:min-h-0 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        isEnabled
                          ? 'border theme-border theme-surface theme-text-primary hover:opacity-80'
                          : 'theme-btn-primary'
                      }`}
                    >
                      {conn.requiresGoogleOAuth && !hasGoogleToken
                        ? 'Connect OAuth'
                        : isEnabled
                          ? 'Disable'
                          : 'Enable'}
                    </button>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1 text-xs font-mono whitespace-nowrap shrink-0"
                      style={{ color: 'var(--status-read)' }}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Core
                    </span>
                  )}
                </div>

                <p className="text-xs theme-text-secondary leading-relaxed">{conn.subtitle}</p>

                <div className="pt-2 border-t theme-border">
                  <p className="text-[11px] font-mono theme-text-muted">
                    Scope: {conn.scopes.join(' · ')}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5 pt-3 border-t theme-border">
                <p className="text-[11px] font-medium theme-text-muted">Registered Tools</p>
                <ul className="space-y-1">
                  {connectorTools.map((t) => (
                    <li
                      key={t.name}
                      className="flex items-center justify-between text-xs font-mono theme-text-primary"
                    >
                      <span>{t.name}</span>
                      <span
                        style={{
                          color:
                            t.risk === 'read'
                              ? 'var(--status-read)'
                              : t.risk === 'write'
                                ? 'var(--status-write)'
                                : 'var(--status-destructive)'
                        }}
                      >
                        {t.risk}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
