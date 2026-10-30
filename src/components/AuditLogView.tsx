import { Search, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { AuditLogDoc, RiskLevel } from '../types/agent.ts';

interface AuditLogViewProps {
  logs: AuditLogDoc[];
}

export function AuditLogView({ logs }: AuditLogViewProps) {
  const [riskFilter, setRiskFilter] = useState<'all' | RiskLevel>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredLogs = logs.filter((entry) => {
    if (riskFilter !== 'all' && entry.risk !== riskFilter) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        entry.toolName.toLowerCase().includes(q) ||
        entry.summary.toLowerCase().includes(q) ||
        entry.status.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 md:p-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b theme-border pb-5">
        <div className="space-y-1">
          <h1 className="font-display text-2xl sm:text-3xl font-semibold theme-text-primary">
            Zero-PII Tool Execution Audit Log
          </h1>
          <p className="text-xs sm:text-sm theme-text-secondary">
            Every tool invocation, confirmation pause, and execution outcome is recorded with metadata only—raw email bodies and file contents are never stored.
          </p>
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar snap-x rounded-xl border theme-border theme-surface p-1 max-w-full">
          {(['all', 'read', 'write', 'destructive'] as const).map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => setRiskFilter(level)}
              className={`snap-start min-h-[40px] sm:min-h-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                riskFilter === level
                  ? 'theme-elevated theme-text-primary shadow-xs font-semibold'
                  : 'theme-text-secondary hover:opacity-80'
              }`}
            >
              {level === 'all' ? 'All Events' : `${level.charAt(0).toUpperCase() + level.slice(1)} Risk`}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 theme-text-muted" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by tool name, status, or summary…"
            className="h-12 sm:h-10 w-full rounded-xl border theme-border theme-elevated pl-9 pr-4 text-base md:text-xs theme-text-primary placeholder:opacity-60 focus:outline-none"
          />
        </div>

        <p className="text-xs font-mono theme-text-muted tabular-nums">
          Showing {filteredLogs.length} of {logs.length} immutable records
        </p>
      </div>

      {filteredLogs.length === 0 ? (
        <div className="rounded-xl border theme-border theme-elevated p-10 text-center space-y-2">
          <ShieldCheck className="mx-auto h-7 w-7 theme-text-muted" />
          <h2 className="font-display text-base font-semibold theme-text-primary">
            No Audit Records Match This Filter
          </h2>
          <p className="text-xs theme-text-secondary max-w-md mx-auto">
            Run a tool in the Workspace chat (such as Google Search, Google Maps, Notes, Gmail, Docs, or Tasks) to populate real-time audit telemetry.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border theme-border theme-elevated">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b theme-border theme-surface theme-text-secondary font-mono">
                <th className="py-3 px-4 font-medium">Tool Name</th>
                <th className="py-3 px-4 font-medium">Risk Class</th>
                <th className="py-3 px-4 font-medium">Outcome Status</th>
                <th className="py-3 px-4 font-medium">Metadata Summary</th>
                <th className="py-3 px-4 font-medium text-right">Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y theme-border">
              {filteredLogs.map((log) => (
                <tr key={log.logId} className="hover:opacity-90 transition-opacity">
                  <td className="py-3 px-4 font-mono theme-text-primary whitespace-nowrap">
                    {log.toolName}
                  </td>
                  <td className="py-3 px-4 font-mono whitespace-nowrap">
                    <span
                      style={{
                        color:
                          log.risk === 'read'
                            ? 'var(--status-read)'
                            : log.risk === 'write'
                              ? 'var(--status-write)'
                              : 'var(--status-destructive)'
                      }}
                    >
                      {log.risk}
                    </span>
                  </td>
                  <td className="py-3 px-4 font-mono whitespace-nowrap">
                    <span
                      style={{
                        color:
                          log.status === 'success' || log.status === 'executed'
                            ? 'var(--status-read)'
                            : log.status === 'paused_for_confirm'
                              ? 'var(--status-write)'
                              : 'var(--status-destructive)'
                      }}
                    >
                      {log.status}
                    </span>
                  </td>
                  <td
                    className="py-3 px-4 theme-text-secondary max-w-lg truncate"
                    title={log.summary}
                  >
                    {log.summary}
                  </td>
                  <td className="py-3 px-4 font-mono theme-text-muted text-right tabular-nums whitespace-nowrap">
                    {log.durationMs}ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
