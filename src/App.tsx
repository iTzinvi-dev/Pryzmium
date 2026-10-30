import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from 'firebase/firestore';
import {
  AlertCircle,
  ArrowDown,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Code2,
  Copy,
  Download,
  Eye,
  EyeOff,
  Keyboard,
  LayoutGrid,
  Link2,
  Loader2,
  LogOut,
  Mail,
  MessageSquarePlus,
  Mic,
  MicOff,
  Moon,
  Pencil,
  Plug,
  RotateCcw,
  ScrollText,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  Square,
  Sun,
  Terminal,
  Trash2,
  User,
  UserPlus,
  Wrench,
  X,
  XCircle
} from 'lucide-react';
import hljs from 'highlight.js';
import { AnimatePresence, motion } from 'motion/react';
import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
  UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { List, RowComponentProps, useDynamicRowHeight, useListRef } from 'react-window';
import { AuditLogView } from './components/AuditLogView.tsx';
import { ChatErrorBanner, ChatErrorState } from './components/ChatErrorBanner.tsx';
import { ConfirmActionCard } from './components/ConfirmActionCard.tsx';
import { ConnectionsView } from './components/ConnectionsView.tsx';
import { GovernanceView } from './components/GovernanceView.tsx';
import { LegalSecurityModal, LegalTabId } from './components/LegalSecurityModal.tsx';
import { CookieConsentBanner } from './components/legal/CookieConsentBanner.jsx';
import { LegalHub } from './components/legal/LegalHub.jsx';
import { ModelSelectorModal } from './components/ModelSelectorModal.tsx';
import { PryzmiumLogo } from './components/PryzmiumLogo.tsx';
import { useLegalStore } from './store/useLegalStore.js';
import {
  db,
  DEFAULT_LOCAL_CONNECTORS,
  emailPasswordSignIn,
  emailPasswordSignUp,
  getAccessToken,
  getConnectedProviders,
  getFirebaseIdToken,
  getSignInRateLimitStatus,
  GOOGLE_OAUTH_CONNECTORS,
  googleSignInBasic,
  googleSignInWithWorkspaceScopes,
  handleFirestoreError,
  hasAcceptedLegalConsent,
  initAuth,
  logoutUser,
  OperationType,
  recordLegalConsentAccepted,
  revokeGoogleAccessAndDisconnect,
  setConnectorEnabled,
  SignInRateLimitStatus,
  syncAccountLegalConsent,
  updateWorkspaceUsername,
  WorkspaceUser
} from './lib/firebase/client.ts';
import {
  CHAT_REQUEST_TIMEOUT_MS,
  ChatNetworkError,
  ChatRequestPayloadSchema,
  fetchChatWithTimeout,
  formatZodValidationBanner
} from './lib/network/chat-client.ts';
import {
  AuditLogDoc,
  ChatMessageDoc,
  ChatSessionDoc,
  ConnectorId,
  ModelInfo,
  PendingActionDoc,
  ThemeMode,
  ToolInfo,
  ToolTraceItem,
  UserProfileDoc
} from './types/agent.ts';

type ActiveTab = 'workspace' | 'connections' | 'audit' | 'profile' | 'settings';

interface SharedChatMessageItem {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  modelId: string;
  toolTraceSummary?: string;
}

interface SharedChatSnapshot {
  shareId: string;
  chatId: string;
  title: string;
  modelId: string;
  modelLabel: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  messages: SharedChatMessageItem[];
}

const PUBLIC_SHARES_STORAGE_KEY = 'vektor_public_shares_v1';

function saveLocalSharedSnapshot(snapshot: SharedChatSnapshot): void {
  try {
    const raw = localStorage.getItem(PUBLIC_SHARES_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, SharedChatSnapshot>) : {};
    parsed[snapshot.shareId] = snapshot;
    localStorage.setItem(PUBLIC_SHARES_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    return;
  }
}

function loadLocalSharedSnapshot(shareId: string): SharedChatSnapshot | null {
  try {
    const raw = localStorage.getItem(PUBLIC_SHARES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, SharedChatSnapshot>;
    return parsed[shareId] || null;
  } catch {
    return null;
  }
}

interface SpeechRecognitionAlternativeItem {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultItem {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeItem;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultItem;
}

interface BrowserSpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

interface BrowserSpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message?: string;
}

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function getSpeechRecognitionConstructor(): BrowserSpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const win = window as unknown as {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

function sanitizeAssistantOutput(rawContent: string): string {
  if (!rawContent) {
    return '';
  }
  return rawContent
    .replace(
      /[^\n]*gateway unreachable\s*\([\s\S]*?\)\.\s*Seamlessly routed via high-speed backup engine\.?\s*/gi,
      ''
    )
    .trim();
}

const DEFAULT_GEMINI_FREE_MODEL_ID = 'gemini-3.8-flash';

function normalizeWorkspaceModelId(rawModelId?: string | null): string {
  if (!rawModelId || typeof rawModelId !== 'string') {
    return DEFAULT_GEMINI_FREE_MODEL_ID;
  }
  const trimmed = rawModelId.trim();
  if (
    !trimmed ||
    trimmed === 'openrouter/google/gemini-pro-1.5:free' ||
    trimmed === 'openrouter/google/gemini-flash-1.5:free' ||
    trimmed.includes('gemini-1.5') ||
    trimmed.includes('gemini-pro-1.5') ||
    trimmed.includes('gemini-flash-1.5')
  ) {
    return DEFAULT_GEMINI_FREE_MODEL_ID;
  }
  return trimmed;
}

function makeSafeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

function getTodayUtcString(): string {
  return new Date().toISOString().slice(0, 10);
}

function computePasswordStrength(pw: string): {
  score: number;
  label: string;
} {
  if (!pw) return { score: 0, label: 'Enter password' };
  let score = 0;
  if (pw.length >= 6) score += 1;
  if (pw.length >= 10) score += 1;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score += 1;
  if (/[0-9]/.test(pw) || /[^A-Za-z0-9]/.test(pw)) score += 1;
  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
  return { score, label: labels[score] || 'Good' };
}

interface LocalVaultData {
  profile: UserProfileDoc;
  chats: ChatSessionDoc[];
  messagesByChat: Record<string, ChatMessageDoc[]>;
  pendingActions: Record<string, PendingActionDoc>;
  auditLogs: AuditLogDoc[];
}

function loadLocalVault(user: WorkspaceUser): LocalVaultData {
  const key = `vektor_local_vault_${user.uid}`;
  const today = getTodayUtcString();
  const defaultVault: LocalVaultData = {
    profile: {
      uid: user.uid,
      email: user.email || 'user@example.com',
      displayName: user.displayName || 'Workspace Operator',
      plan: 'free',
      dailyRequestsCount: 0,
      dailyTokensUsed: 0,
      lastResetDate: today
    },
    chats: [],
    messagesByChat: {},
    pendingActions: {},
    auditLogs: []
  };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaultVault;
    const parsed = JSON.parse(raw) as Partial<LocalVaultData>;
    const rawProfile = parsed.profile || defaultVault.profile;
    const normalizedProfile: UserProfileDoc =
      rawProfile.lastResetDate !== today
        ? {
            ...rawProfile,
            dailyRequestsCount: 0,
            dailyTokensUsed: 0,
            lastResetDate: today
          }
        : rawProfile;
    const normalizedChats = Array.isArray(parsed.chats)
      ? parsed.chats.map((c) => ({
          ...c,
          modelId: normalizeWorkspaceModelId(c.modelId)
        }))
      : [];
    return {
      profile: normalizedProfile,
      chats: normalizedChats,
      messagesByChat: parsed.messagesByChat || {},
      pendingActions: parsed.pendingActions || {},
      auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : []
    };
  } catch {
    return defaultVault;
  }
}

function saveLocalVault(uid: string, data: LocalVaultData) {
  try {
    localStorage.setItem(`vektor_local_vault_${uid}`, JSON.stringify(data));
  } catch {
    return;
  }
}

type ToolVisualStatus = 'executing' | 'awaiting approval' | 'success' | 'failed';

interface MessageToolStatusItem {
  toolName: string;
  risk: string;
  visualStatus: ToolVisualStatus;
  durationMs?: number;
  argsJson?: string;
}

const KNOWN_AGENT_TOOL_RISK: Record<string, 'read' | 'write' | 'destructive'> = {
  get_current_time: 'read',
  web_fetch_summary: 'read',
  google_search_grounding: 'read',
  google_maps_grounding: 'read',
  google_maps_places: 'read',
  notes_list: 'read',
  notes_list_notes: 'read',
  notes_create: 'write',
  notes_create_note: 'write',
  notes_delete: 'destructive',
  notes_delete_note: 'destructive',
  docs_read_document: 'read',
  docs_get_document: 'read',
  docs_create_document: 'write',
  tasks_list_items: 'read',
  tasks_list_tasks: 'read',
  tasks_create_item: 'write',
  tasks_create_task: 'write',
  gmail_search: 'read',
  gmail_search_messages: 'read',
  gmail_read_message: 'read',
  gmail_create_draft: 'write',
  gmail_send_email: 'destructive',
  gmail_send_message: 'destructive',
  calendar_list_events: 'read',
  calendar_create_event: 'write',
  drive_search_files: 'read'
};

function mapRawStatusToVisualStatus(rawStatus: string): ToolVisualStatus {
  const normalized = rawStatus.trim().toLowerCase();
  if (normalized === 'executing' || normalized === 'running' || normalized === 'in_progress') {
    return 'executing';
  }
  if (
    normalized === 'paused_for_confirm' ||
    normalized === 'pending' ||
    normalized === 'awaiting_approval' ||
    normalized === 'awaiting approval'
  ) {
    return 'awaiting approval';
  }
  if (
    normalized === 'error' ||
    normalized === 'failed' ||
    normalized === 'rejected' ||
    normalized === 'expired'
  ) {
    return 'failed';
  }
  return 'success';
}

function resolvePendingActionVisualStatus(
  action: PendingActionDoc,
  confirmingActionId: string | null
): ToolVisualStatus {
  if (confirmingActionId === action.actionId) {
    return 'executing';
  }
  if (action.status === 'executed') {
    return 'success';
  }
  if (
    action.status === 'rejected' ||
    action.status === 'expired' ||
    (action.status === 'pending' && action.expiresAtMs <= Date.now())
  ) {
    return 'failed';
  }
  return 'awaiting approval';
}

function inferExecutingToolsFromPrompt(promptText: string): string[] {
  const lower = promptText.toLowerCase();
  const inferred: string[] = [];
  if (lower.includes('google search') || lower.includes('search the web')) {
    inferred.push('google_search_grounding');
  }
  if (lower.includes('google maps') || lower.includes('maps') || lower.includes('places')) {
    inferred.push('google_maps_grounding');
  }
  if (lower.includes('note') || lower.includes('notes')) {
    if (lower.includes('delete') || lower.includes('remove')) {
      inferred.push('notes_delete');
    } else if (lower.includes('create') || lower.includes('save') || lower.includes('add')) {
      inferred.push('notes_create');
    } else {
      inferred.push('notes_list');
    }
  }
  if (lower.includes('google doc') || lower.includes('document') || lower.includes('docs')) {
    if (lower.includes('create') || lower.includes('new')) {
      inferred.push('docs_create_document');
    } else {
      inferred.push('docs_read_document');
    }
  }
  if (lower.includes('task') || lower.includes('tasks')) {
    if (lower.includes('create') || lower.includes('add')) {
      inferred.push('tasks_create_item');
    } else {
      inferred.push('tasks_list_items');
    }
  }
  if (lower.includes('gmail') || lower.includes('email')) {
    if (lower.includes('send')) {
      inferred.push('gmail_send_email');
    } else if (lower.includes('draft')) {
      inferred.push('gmail_create_draft');
    } else {
      inferred.push('gmail_search');
    }
  }
  if (lower.includes('calendar') || lower.includes('event')) {
    if (lower.includes('create') || lower.includes('schedule')) {
      inferred.push('calendar_create_event');
    } else {
      inferred.push('calendar_list_events');
    }
  }
  if (lower.includes('drive') || lower.includes('files')) {
    inferred.push('drive_search_files');
  }
  return inferred;
}

function resolveMessageToolStatuses(
  msg: ChatMessageDoc,
  options: {
    isLatestMessage: boolean;
    isRunningAgent: boolean;
    confirmingActionId: string | null;
    retryingToolKey: string | null;
    pendingActionsMap: Record<string, PendingActionDoc>;
    auditLogs: AuditLogDoc[];
    knownTools: ToolInfo[];
  }
): MessageToolStatusItem[] {
  const {
    isLatestMessage,
    isRunningAgent,
    confirmingActionId,
    retryingToolKey,
    pendingActionsMap,
    auditLogs,
    knownTools
  } = options;
  const items: MessageToolStatusItem[] = [];
  const seenTools = new Set<string>();
  const linkedAction = msg.pendingActionId ? pendingActionsMap[msg.pendingActionId] : undefined;

  if (msg.toolTraceSummary) {
    const lines = msg.toolTraceSummary
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const parts = line.split('·').map((part) => part.trim());
      const toolName = parts[0] || 'tool';
      const risk = parts[1] || KNOWN_AGENT_TOOL_RISK[toolName] || 'read';
      const rawStatus = parts[2] || 'success';
      const durationRaw = parts[3] ? Number.parseInt(parts[3].replace(/[^0-9]/g, ''), 10) : NaN;
      let decodedArgs: string | undefined;
      if (parts[4]) {
        try {
          decodedArgs = decodeURIComponent(parts[4]);
        } catch {
          decodedArgs = parts[4];
        }
      }

      let visualStatus = mapRawStatusToVisualStatus(rawStatus);
      if (linkedAction && linkedAction.toolName === toolName) {
        if (rawStatus !== 'success' && rawStatus !== 'executed') {
          visualStatus = resolvePendingActionVisualStatus(linkedAction, confirmingActionId);
        }
        if (!decodedArgs) {
          decodedArgs = linkedAction.argsPreview;
        }
      }

      if (retryingToolKey === `${msg.messageId}:${toolName}`) {
        visualStatus = 'executing';
      }

      items.push({
        toolName,
        risk,
        visualStatus,
        durationMs: Number.isFinite(durationRaw) ? durationRaw : undefined,
        argsJson: decodedArgs
      });
      seenTools.add(toolName);
    }
  }

  if (linkedAction && !seenTools.has(linkedAction.toolName)) {
    const isRetrying = retryingToolKey === `${msg.messageId}:${linkedAction.toolName}`;
    items.push({
      toolName: linkedAction.toolName,
      risk: linkedAction.risk,
      visualStatus: isRetrying
        ? 'executing'
        : resolvePendingActionVisualStatus(linkedAction, confirmingActionId),
      argsJson: linkedAction.argsPreview
    });
    seenTools.add(linkedAction.toolName);
  }

  const allKnownNames = new Set<string>([
    ...Object.keys(KNOWN_AGENT_TOOL_RISK),
    ...knownTools.map((t) => t.name)
  ]);

  for (const toolName of allKnownNames) {
    if (seenTools.has(toolName)) continue;
    const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (!regex.test(msg.content)) continue;

    const toolInfo = knownTools.find((t) => t.name === toolName);
    const risk = toolInfo?.risk || KNOWN_AGENT_TOOL_RISK[toolName] || 'read';

    let visualStatus: ToolVisualStatus = 'success';
    let argsJson: string | undefined;
    if (msg.role === 'user' && isLatestMessage && isRunningAgent) {
      visualStatus = 'executing';
    } else {
      const matchingPending = Object.values(pendingActionsMap).find(
        (pa) => pa.chatId === msg.chatId && pa.toolName === toolName
      );
      if (matchingPending) {
        visualStatus = resolvePendingActionVisualStatus(matchingPending, confirmingActionId);
        argsJson = matchingPending.argsPreview;
      } else {
        const matchingAudit = auditLogs.find(
          (log) => log.chatId === msg.chatId && log.toolName === toolName
        );
        if (matchingAudit) {
          visualStatus = mapRawStatusToVisualStatus(matchingAudit.status);
        }
      }
    }

    if (retryingToolKey === `${msg.messageId}:${toolName}`) {
      visualStatus = 'executing';
    }

    items.push({
      toolName,
      risk,
      visualStatus,
      argsJson
    });
    seenTools.add(toolName);
  }

  if (msg.role === 'user' && isLatestMessage && isRunningAgent && items.length === 0) {
    const inferred = inferExecutingToolsFromPrompt(msg.content);
    for (const toolName of inferred) {
      if (seenTools.has(toolName)) continue;
      items.push({
        toolName,
        risk: KNOWN_AGENT_TOOL_RISK[toolName] || 'read',
        visualStatus: 'executing'
      });
      seenTools.add(toolName);
    }
  }

  return items;
}

function renderToolStatusBadge(
  status: ToolVisualStatus,
  options?: {
    onRetry?: () => void;
    isRetrying?: boolean;
  }
): ReactNode {
  const statusStyles: Record<
    ToolVisualStatus,
    {
      color: string;
      icon: ReactNode;
    }
  > = {
    executing: {
      color: 'var(--accent-primary)',
      icon: <Loader2 className="h-3 w-3 animate-spin shrink-0" />
    },
    'awaiting approval': {
      color: 'var(--status-write)',
      icon: <Clock className="h-3 w-3 shrink-0" />
    },
    success: {
      color: 'var(--status-read)',
      icon: <CheckCircle2 className="h-3 w-3 shrink-0" />
    },
    failed: {
      color: 'var(--status-destructive)',
      icon: <XCircle className="h-3 w-3 shrink-0" />
    }
  };

  const current = statusStyles[status];
  const isExecuting = status === 'executing';

  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      <span
        role="status"
        aria-label={`Tool status: ${status}`}
        className={`inline-flex items-center gap-1 rounded-md border theme-border theme-elevated px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap shrink-0 transition-opacity duration-200 ${
          isExecuting ? 'animate-tool-processing' : ''
        }`}
        style={{ color: current.color }}
      >
        {current.icon}
        <span>{status}</span>
      </span>

      {status === 'failed' && options?.onRetry && (
        <button
          type="button"
          disabled={options.isRetrying}
          onClick={options.onRetry}
          title="Re-trigger this tool call with its original arguments"
          className="inline-flex items-center gap-1 rounded-md border theme-border theme-surface px-2 py-0.5 font-mono text-[10px] font-semibold theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0 disabled:opacity-50"
        >
          <RotateCcw
            className={`h-2.5 w-2.5 shrink-0 ${options.isRetrying ? 'animate-spin' : ''}`}
            style={{ color: 'var(--accent-primary)' }}
          />
          <span>Retry Tool</span>
        </button>
      )}
    </span>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightTextMatches(text: string, searchQuery?: string): ReactNode {
  const trimmed = searchQuery?.trim();
  if (!trimmed || !text) {
    return text;
  }

  const regex = new RegExp(`(${escapeRegExp(trimmed)})`, 'gi');
  const parts = text.split(regex);
  if (parts.length === 1) {
    return text;
  }

  const lowerNeedle = trimmed.toLowerCase();
  return parts.map((part, idx) =>
    part.toLowerCase() === lowerNeedle ? (
      <mark key={idx} className="chat-search-highlight">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

function renderMessageWithClickableLinks(
  text: string,
  toolStatusLookup?: Map<string, ToolVisualStatus>,
  searchQuery?: string,
  onRetryByToolName?: Map<string, () => void>
): ReactNode[] {
  const urlRegex = /(https?:\/\/[^\s)]+)/g;
  const parts = text.split(urlRegex);
  return parts.map((part, idx) => {
    if (/^https?:\/\//.test(part)) {
      return (
        <a
          key={idx}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 underline underline-offset-2 font-medium hover:opacity-80"
          style={{ color: 'var(--accent-primary)' }}
        >
          <span className="break-all">{highlightTextMatches(part, searchQuery)}</span>
          <ArrowUpRight className="h-3 w-3 shrink-0" />
        </a>
      );
    }

    if (!toolStatusLookup || toolStatusLookup.size === 0) {
      return <span key={idx}>{highlightTextMatches(part, searchQuery)}</span>;
    }

    const toolNames = Array.from(toolStatusLookup.keys());
    const escapedNames = toolNames.map((n) => escapeRegExp(n));
    const toolRegex = new RegExp(`(\\b(?:${escapedNames.join('|')})\\b)`, 'g');
    const subParts = part.split(toolRegex);

    return (
      <span key={idx}>
        {subParts.map((subPart, subIdx) => {
          const matchedStatus = toolStatusLookup.get(subPart);
          if (matchedStatus) {
            return (
              <span
                key={subIdx}
                className="inline-flex items-center gap-1.5 align-baseline mx-0.5"
              >
                <code className="rounded border theme-border theme-canvas px-1.5 py-0.5 font-mono text-xs theme-text-primary">
                  {highlightTextMatches(subPart, searchQuery)}
                </code>
                {renderToolStatusBadge(matchedStatus, {
                  onRetry: onRetryByToolName?.get(subPart)
                })}
              </span>
            );
          }
          return <span key={subIdx}>{highlightTextMatches(subPart, searchQuery)}</span>;
        })}
      </span>
    );
  });
}

interface ParsedTextSegment {
  type: 'text';
  text: string;
}

interface ParsedCodeSegment {
  type: 'code';
  language: string;
  code: string;
}

type MessageSegment = ParsedTextSegment | ParsedCodeSegment;

async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      void 0;
    }
  }

  if (typeof document === 'undefined') {
    return false;
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function normalizeCodeBlock(rawCode: string): string {
  const unified = rawCode.replace(/\r\n/g, '\n').replace(/\t/g, '  ');
  const lines = unified.split('\n');

  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  if (lines.length === 0) {
    return '';
  }

  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const minIndent = nonEmptyLines.reduce((acc, line) => {
    const match = line.match(/^[ ]*/);
    const leadingSpaces = match ? match[0].length : 0;
    return Math.min(acc, leadingSpaces);
  }, Number.POSITIVE_INFINITY);

  const normalizedLines =
    Number.isFinite(minIndent) && minIndent > 0
      ? lines.map((line) => (line.length >= minIndent ? line.slice(minIndent) : line.trimStart()))
      : lines;

  return normalizedLines.map((line) => line.replace(/[ \t]+$/g, '')).join('\n');
}

function parseMessageSegments(content: string): MessageSegment[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const fenceRegex = /```([a-zA-Z0-9_+.#-]*)?[ \t]*\n?([\s\S]*?)```/g;
  const segments: MessageSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(normalized)) !== null) {
    if (match.index > lastIndex) {
      const precedingText = normalized.slice(lastIndex, match.index);
      if (precedingText.trim().length > 0) {
        segments.push({
          type: 'text',
          text: precedingText.trim()
        });
      }
    }

    const rawLang = (match[1] || '').trim().toLowerCase();
    const cleanedCode = normalizeCodeBlock(match[2] || '');

    if (cleanedCode.length > 0) {
      segments.push({
        type: 'code',
        language: rawLang || 'code',
        code: cleanedCode
      });
    }

    lastIndex = fenceRegex.lastIndex;
  }

  if (lastIndex < normalized.length) {
    const trailing = normalized.slice(lastIndex);
    const unclosedFenceMatch = trailing.match(/```([a-zA-Z0-9_+.#-]*)?[ \t]*\n([\s\S]+)$/);

    if (unclosedFenceMatch && typeof unclosedFenceMatch.index === 'number') {
      const beforeFence = trailing.slice(0, unclosedFenceMatch.index).trim();
      if (beforeFence.length > 0) {
        segments.push({
          type: 'text',
          text: beforeFence
        });
      }
      const unclosedCode = normalizeCodeBlock(unclosedFenceMatch[2] || '');
      if (unclosedCode.length > 0) {
        segments.push({
          type: 'code',
          language: (unclosedFenceMatch[1] || 'code').trim().toLowerCase(),
          code: unclosedCode
        });
      }
    } else if (trailing.trim().length > 0) {
      segments.push({
        type: 'text',
        text: trailing.trim()
      });
    }
  }

  if (segments.length === 0) {
    segments.push({
      type: 'text',
      text: normalized
    });
  }

  return segments;
}

function renderInlineCodeAndLinks(
  text: string,
  toolStatusLookup?: Map<string, ToolVisualStatus>,
  searchQuery?: string,
  onRetryByToolName?: Map<string, () => void>
): ReactNode[] {
  const inlineCodeRegex = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  const tokens = text.split(inlineCodeRegex);

  return tokens.map((token, idx) => {
    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      const codeContent = token.slice(1, -1);
      return (
        <code
          key={idx}
          className="rounded border theme-border theme-canvas px-1.5 py-0.5 font-mono text-xs theme-text-primary"
        >
          {highlightTextMatches(codeContent, searchQuery)}
        </code>
      );
    }

    if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      const boldContent = token.slice(2, -2);
      return (
        <strong key={idx} className="font-semibold theme-text-primary">
          {renderMessageWithClickableLinks(
            boldContent,
            toolStatusLookup,
            searchQuery,
            onRetryByToolName
          )}
        </strong>
      );
    }

    return (
      <span key={idx}>
        {renderMessageWithClickableLinks(token, toolStatusLookup, searchQuery, onRetryByToolName)}
      </span>
    );
  });
}

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  html: 'xml',
  svg: 'xml',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  rs: 'rust',
  rb: 'ruby',
  kt: 'kotlin',
  golang: 'go'
};

function highlightCodeSegment(
  code: string,
  rawLanguage: string
): {
  html: string;
  detectedLanguage: string;
} {
  const normalizedTag = rawLanguage.trim().toLowerCase();
  const mappedLanguage = LANGUAGE_ALIASES[normalizedTag] || normalizedTag;

  try {
    if (
      mappedLanguage &&
      mappedLanguage !== 'code' &&
      mappedLanguage !== 'text' &&
      hljs.getLanguage(mappedLanguage)
    ) {
      const highlighted = hljs.highlight(code, {
        language: mappedLanguage,
        ignoreIllegals: true
      });
      return {
        html: highlighted.value,
        detectedLanguage: normalizedTag || mappedLanguage
      };
    }

    const autoHighlighted = hljs.highlightAuto(code);
    return {
      html: autoHighlighted.value,
      detectedLanguage:
        autoHighlighted.language ||
        (normalizedTag && normalizedTag !== 'code' ? normalizedTag : 'plaintext')
    };
  } catch {
    const escaped = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return {
      html: escaped,
      detectedLanguage: normalizedTag || 'plaintext'
    };
  }
}

function escapeHtmlText(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unescapeHtmlText(encoded: string): string {
  return encoded
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&amp;/g, '&');
}

function highlightMatchesInHtml(html: string, searchQuery?: string): string {
  const trimmed = searchQuery?.trim();
  if (!trimmed || !html) {
    return html;
  }

  const regex = new RegExp(`(${escapeRegExp(trimmed)})`, 'gi');
  const lowerNeedle = trimmed.toLowerCase();

  return html.replace(/(<[^>]+>)|([^<]+)/g, (_full, tag: string | undefined, textNode: string | undefined) => {
    if (tag) {
      return tag;
    }
    if (!textNode) {
      return '';
    }
    const decoded = unescapeHtmlText(textNode);
    const parts = decoded.split(regex);
    if (parts.length === 1) {
      return textNode;
    }
    return parts
      .map((part) =>
        part.toLowerCase() === lowerNeedle
          ? `<mark class="chat-search-highlight">${escapeHtmlText(part)}</mark>`
          : escapeHtmlText(part)
      )
      .join('');
  });
}

const EXTENSION_BY_LANGUAGE: Record<string, string> = {
  python: 'py',
  py: 'py',
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  html: 'html',
  xml: 'xml',
  svg: 'svg',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  json: 'json',
  yaml: 'yml',
  yml: 'yml',
  toml: 'toml',
  markdown: 'md',
  md: 'md',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  zsh: 'sh',
  powershell: 'ps1',
  ps1: 'ps1',
  sql: 'sql',
  go: 'go',
  golang: 'go',
  rust: 'rs',
  rs: 'rs',
  java: 'java',
  kotlin: 'kt',
  kt: 'kt',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  csharp: 'cs',
  cs: 'cs',
  php: 'php',
  ruby: 'rb',
  rb: 'rb',
  r: 'R',
  dart: 'dart',
  lua: 'lua',
  dockerfile: 'Dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
  ini: 'ini',
  plaintext: 'txt',
  text: 'txt',
  txt: 'txt'
};

function detectCodeFilename(
  code: string,
  rawLanguage: string | undefined,
  detectedLanguage: string,
  blockIndex: number
): string {
  const normalizedLang = (rawLanguage || detectedLanguage || 'txt').trim().toLowerCase();
  const ext = EXTENSION_BY_LANGUAGE[normalizedLang] || EXTENSION_BY_LANGUAGE[detectedLanguage.toLowerCase()] || 'txt';

  const lines = code.split('\n').slice(0, 6);
  for (const line of lines) {
    const trimmed = line.trim();
    const commentMatch = trimmed.match(
      /^(?:\/\/|#|\/\*+|<!--|--)\s*(?:file(?:name)?\s*[:=]\s*)?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)\s*(?:\*+\/|-->)?$/i
    );
    if (commentMatch?.[1]) {
      const base = commentMatch[1].split('/').pop();
      if (base && /^[a-zA-Z0-9_.-]+$/.test(base)) {
        return base;
      }
    }
  }

  if (ext === 'Dockerfile') {
    return 'Dockerfile';
  }

  const componentMatch = code.match(
    /(?:export\s+default\s+function|export\s+function|function|class|interface)\s+([A-Z][a-zA-Z0-9_]*)/
  );
  if (componentMatch?.[1]) {
    return `${componentMatch[1]}.${ext}`;
  }

  const pyClassOrDef = code.match(/(?:^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)|^\s*def\s+([A-Za-z_][A-Za-z0-9_]*))/m);
  if (ext === 'py' && (pyClassOrDef?.[1] || pyClassOrDef?.[2])) {
    const symbol = (pyClassOrDef[1] || pyClassOrDef[2]).toLowerCase();
    return `${symbol}.${ext}`;
  }

  const fnMatch = code.match(/(?:const|let|function)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[=(]/);
  if (fnMatch?.[1] && fnMatch[1].length <= 32) {
    return `${fnMatch[1]}.${ext}`;
  }

  if (ext === 'html') return blockIndex === 1 ? 'index.html' : `snippet-${blockIndex}.html`;
  if (ext === 'css') return blockIndex === 1 ? 'styles.css' : `styles-${blockIndex}.css`;
  if (ext === 'json') return blockIndex === 1 ? 'config.json' : `data-${blockIndex}.json`;
  if (ext === 'sql') return blockIndex === 1 ? 'query.sql' : `query-${blockIndex}.sql`;
  if (ext === 'sh') return blockIndex === 1 ? 'script.sh' : `script-${blockIndex}.sh`;
  if (ext === 'py') return blockIndex === 1 ? 'main.py' : `script_${blockIndex}.py`;

  return `snippet-${blockIndex}.${ext}`;
}

function downloadCodeAsFile(filename: string, code: string): void {
  const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderStructuredMessageContent(params: {
  messageId: string;
  segments: MessageSegment[];
  toolStatusLookup?: Map<string, ToolVisualStatus>;
  onRetryByToolName?: Map<string, () => void>;
  copiedKey: string | null;
  searchQuery?: string;
  onCopy: (key: string, text: string) => void;
}): ReactNode {
  const {
    messageId,
    segments,
    toolStatusLookup,
    onRetryByToolName,
    copiedKey,
    searchQuery,
    onCopy
  } = params;
  let codeBlockCounter = 0;

  return (
    <div className="mt-3.5 space-y-3.5 text-sm theme-text-primary leading-relaxed">
      {segments.map((segment, index) => {
        if (segment.type === 'code') {
          codeBlockCounter += 1;
          const blockCopyKey = `code_${messageId}_${codeBlockCounter}`;
          const isBlockCopied = copiedKey === blockCopyKey;
          const codeLines = segment.code.split('\n');
          const { html: highlightedHtml, detectedLanguage } = highlightCodeSegment(
            segment.code,
            segment.language
          );
          const finalCodeHtml = highlightMatchesInHtml(highlightedHtml, searchQuery);
          const autoFilename = detectCodeFilename(
            segment.code,
            segment.language,
            detectedLanguage,
            codeBlockCounter
          );

          return (
            <figure
              key={`${messageId}_seg_${index}`}
              className="overflow-hidden rounded-xl border theme-border theme-canvas"
            >
              <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b theme-border theme-surface px-3.5 py-2 text-xs font-mono">
                <div className="flex items-center gap-2 min-w-0">
                  <Code2
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: 'var(--accent-primary)' }}
                  />
                  <span className="font-semibold uppercase tracking-wider theme-text-primary">
                    {detectedLanguage}
                  </span>
                  <span className="truncate text-[11px] theme-text-secondary">
                    ({autoFilename})
                  </span>
                  <span className="text-[11px] theme-text-muted shrink-0">
                    · {codeLines.length} {codeLines.length === 1 ? 'line' : 'lines'}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => onCopy(blockCopyKey, segment.code)}
                    className="inline-flex items-center gap-1.5 rounded-lg border theme-border theme-elevated px-2.5 py-1 text-[11px] font-medium theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
                    title="Copy only this generated code block"
                  >
                    {isBlockCopied ? (
                      <>
                        <Check
                          className="h-3.5 w-3.5 shrink-0"
                          style={{ color: 'var(--status-read)' }}
                        />
                        <span style={{ color: 'var(--status-read)' }}>Copied Code</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5 shrink-0 theme-text-secondary" />
                        <span>Copy Code</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => downloadCodeAsFile(autoFilename, segment.code)}
                    className="inline-flex items-center gap-1.5 rounded-lg border theme-border theme-elevated px-2.5 py-1 text-[11px] font-medium theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
                    title={`Download code as ${autoFilename}`}
                    aria-label={`Download code as ${autoFilename}`}
                  >
                    <Download className="h-3.5 w-3.5 shrink-0 theme-text-secondary" />
                    <span>Download</span>
                  </button>
                </div>
              </figcaption>

              <pre className="flex overflow-x-auto p-4 font-mono text-xs leading-relaxed theme-text-primary">
                <div
                  aria-hidden="true"
                  className="select-none pr-4 text-right font-mono text-xs leading-relaxed theme-text-muted opacity-60 shrink-0"
                >
                  {codeLines.map((_, lineIdx) => (
                    <div key={lineIdx}>{lineIdx + 1}</div>
                  ))}
                </div>
                <code
                  className={`hljs language-${detectedLanguage} block min-w-0 flex-1 whitespace-pre font-mono text-xs leading-relaxed`}
                  dangerouslySetInnerHTML={{ __html: finalCodeHtml || ' ' }}
                />
              </pre>
            </figure>
          );
        }

        return (
          <div key={`${messageId}_seg_${index}`} className="whitespace-pre-wrap">
            {renderInlineCodeAndLinks(
              segment.text,
              toolStatusLookup,
              searchQuery,
              onRetryByToolName
            )}
          </div>
        );
      })}
    </div>
  );
}

interface ChatMessageRowData {
  messages: ChatMessageDoc[];
  models: ModelInfo[];
  pendingActionsMap: Record<string, PendingActionDoc>;
  isRunningAgent: boolean;
  confirmingActionId: string | null;
  retryingToolKey: string | null;
  auditLogs: AuditLogDoc[];
  tools: ToolInfo[];
  copiedKey: string | null;
  searchQuery: string;
  focusedMatchMessageId: string | null;
  showToolTraces: boolean;
  compactMessages: boolean;
  onCopy: (key: string, text: string) => void;
  onDecision: (action: PendingActionDoc, decision: 'approve' | 'reject') => Promise<void>;
  onRetryTool: (msg: ChatMessageDoc, item: MessageToolStatusItem) => Promise<void>;
}

function VirtualizedChatMessageRow({
  ariaAttributes,
  index,
  style,
  messages,
  models,
  pendingActionsMap,
  isRunningAgent,
  confirmingActionId,
  retryingToolKey,
  auditLogs,
  tools,
  copiedKey,
  searchQuery,
  focusedMatchMessageId,
  showToolTraces,
  compactMessages,
  onCopy,
  onDecision,
  onRetryTool
}: RowComponentProps<ChatMessageRowData>): ReactElement | null {
  const msg = messages[index];
  if (!msg) {
    return null;
  }

  const linkedAction = msg.pendingActionId
    ? pendingActionsMap[msg.pendingActionId]
    : undefined;
  const isLatestMessage = index === messages.length - 1;
  const messageToolItems = resolveMessageToolStatuses(msg, {
    isLatestMessage,
    isRunningAgent,
    confirmingActionId,
    retryingToolKey,
    pendingActionsMap,
    auditLogs,
    knownTools: tools
  });
  const toolStatusLookup = new Map<string, ToolVisualStatus>(
    messageToolItems.map((item) => [item.toolName, item.visualStatus])
  );
  const onRetryByToolName = new Map<string, () => void>(
    messageToolItems.map((item) => [item.toolName, () => void onRetryTool(msg, item)])
  );
  const cleanedMessageContent =
    msg.role === 'assistant' ? sanitizeAssistantOutput(msg.content) : msg.content;
  const parsedSegments = parseMessageSegments(cleanedMessageContent);
  const extractedCodeBlocks = parsedSegments.filter(
    (seg): seg is ParsedCodeSegment => seg.type === 'code'
  );
  const combinedCodeOnlyText = extractedCodeBlocks.map((block) => block.code).join('\n\n');
  const fullMsgCopyKey = `msg_${msg.messageId}`;
  const allCodeCopyKey = `allcode_${msg.messageId}`;
  const isFullMsgCopied = copiedKey === fullMsgCopyKey;
  const isAllCodeCopied = copiedKey === allCodeCopyKey;
  const isFocusedSearchMatch =
    Boolean(searchQuery.trim()) && focusedMatchMessageId === msg.messageId;
  const matchedModelLabel = models.find((m) => m.id === msg.modelId)?.label;

  return (
    <div style={style} {...ariaAttributes} className="px-4 sm:px-6">
      <div className={`mx-auto max-w-3xl ${compactMessages ? 'pb-3' : 'pb-6'}`}>
        <article
          className={`rounded-2xl border ${compactMessages ? 'p-3.5' : 'p-5'} transition-colors ${
            isFocusedSearchMatch ? 'theme-border-strong' : 'theme-border'
          } ${msg.role === 'user' ? 'theme-surface ml-6 sm:ml-10' : 'theme-elevated mr-2 sm:mr-4'}`}
        >
          <header className="flex flex-wrap items-center justify-between gap-2 text-xs theme-text-muted font-mono pb-2.5 border-b theme-border">
            <span className="font-medium theme-text-secondary">
              {msg.role === 'user' ? 'You' : 'Pryzmium'}
            </span>
            {matchedModelLabel && <span>{matchedModelLabel}</span>}
          </header>

          {showToolTraces && messageToolItems.length > 0 && (
            <section
              aria-label="Agent Tool Execution Status"
              className="mt-3 rounded-xl border theme-border theme-canvas px-3.5 py-2.5 text-xs font-mono theme-text-secondary space-y-2 tabular-nums"
            >
              <div className="flex items-center justify-between gap-2">
                <div
                  className="flex items-center gap-1.5 text-[11px] font-medium"
                  style={{ color: 'var(--accent-primary)' }}
                >
                  <Wrench className="h-3 w-3 shrink-0" />
                  <span>Agent Tool Execution Trace</span>
                </div>
                <span className="text-[10px] theme-text-muted">
                  {messageToolItems.length}{' '}
                  {messageToolItems.length === 1 ? 'tool' : 'tools'}
                </span>
              </div>

              <ul className="space-y-1.5">
                {messageToolItems.map((item, idx) => (
                  <li
                    key={`${item.toolName}-${idx}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border theme-border theme-surface px-2.5 py-1.5"
                  >
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="text-[10px] theme-text-muted">
                        {String(idx + 1).padStart(2, '0')}
                      </span>
                      <span className="font-semibold theme-text-primary truncate">
                        {item.toolName}
                      </span>
                      <span
                        className="text-[10px]"
                        style={{
                          color:
                            item.risk === 'destructive'
                              ? 'var(--status-destructive)'
                              : item.risk === 'write'
                                ? 'var(--status-write)'
                                : 'var(--status-read)'
                        }}
                      >
                        {item.risk} risk
                      </span>
                      {typeof item.durationMs === 'number' && (
                        <span className="text-[10px] theme-text-muted">
                          {item.durationMs}ms
                        </span>
                      )}
                    </div>

                    {renderToolStatusBadge(item.visualStatus, {
                      onRetry: () => void onRetryTool(msg, item),
                      isRetrying: retryingToolKey === `${msg.messageId}:${item.toolName}`
                    })}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {renderStructuredMessageContent({
            messageId: msg.messageId,
            segments: parsedSegments,
            toolStatusLookup,
            onRetryByToolName,
            copiedKey,
            searchQuery,
            onCopy
          })}

          {linkedAction && (
            <ConfirmActionCard
              action={linkedAction}
              onDecision={onDecision}
            />
          )}

          <footer className="mt-4 pt-3 border-t theme-border flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onCopy(fullMsgCopyKey, cleanedMessageContent)}
                className="inline-flex items-center gap-1.5 rounded-lg border theme-border theme-surface px-2.5 py-1 text-[11px] font-medium theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
                title="Copy the entire message content"
              >
                {isFullMsgCopied ? (
                  <>
                    <Check
                      className="h-3.5 w-3.5 shrink-0"
                      style={{ color: 'var(--status-read)' }}
                    />
                    <span style={{ color: 'var(--status-read)' }}>Copied Message</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5 shrink-0 theme-text-secondary" />
                    <span>Copy Message</span>
                  </>
                )}
              </button>

              {extractedCodeBlocks.length > 0 && (
                <button
                  type="button"
                  onClick={() => onCopy(allCodeCopyKey, combinedCodeOnlyText)}
                  className="inline-flex items-center gap-1.5 rounded-lg border theme-border theme-surface px-2.5 py-1 text-[11px] font-medium theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
                  title="Copy only the generated code without markdown backticks or surrounding text"
                >
                  {isAllCodeCopied ? (
                    <>
                      <Check
                        className="h-3.5 w-3.5 shrink-0"
                        style={{ color: 'var(--status-read)' }}
                      />
                      <span style={{ color: 'var(--status-read)' }}>Copied Code Only</span>
                    </>
                  ) : (
                    <>
                      <Code2
                        className="h-3.5 w-3.5 shrink-0"
                        style={{ color: 'var(--accent-primary)' }}
                      />
                      <span>Copy Code Only</span>
                    </>
                  )}
                </button>
              )}
            </div>

            <span className="text-[11px] theme-text-muted">
              {extractedCodeBlocks.length > 0
                ? `${extractedCodeBlocks.length} ${
                    extractedCodeBlocks.length === 1 ? 'code block' : 'code blocks'
                  }`
                : `${cleanedMessageContent.length} chars`}
            </span>
          </footer>
        </article>
      </div>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'cream';
    try {
      const saved = localStorage.getItem('vektor_workspace_theme');
      return saved === 'dark' ? 'dark' : 'cream';
    } catch {
      return 'cream';
    }
  });
  const [user, setUser] = useState<WorkspaceUser | null>(null);
  const [authInitialized, setAuthInitialized] = useState(false);
  const [profileReady, setProfileReady] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [confirmPasswordInput, setConfirmPasswordInput] = useState('');
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [acceptedAuthPolicy, setAcceptedAuthPolicy] = useState(false);
  const [authPolicyModalOpen, setAuthPolicyModalOpen] = useState(false);
  const [authPolicyInitialTab, setAuthPolicyInitialTab] = useState<LegalTabId>('privacy');

  const [needsConsentGate, setNeedsConsentGate] = useState(false);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);
  const [reportIssueModalOpen, setReportIssueModalOpen] = useState(false);
  const [issueCategory, setIssueCategory] = useState<'bug' | 'ui' | 'connector' | 'other'>('bug');
  const [issueDescription, setIssueDescription] = useState('');
  const [issueCopied, setIssueCopied] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isMenuSettingsOpen, setIsMenuSettingsOpen] = useState(false);
  const isLegalHubOpen = useLegalStore((state) => state.isLegalHubOpen);
  const closeLegalHub = useLegalStore((state) => state.closeLegalHub);
  const openLegalHub = useLegalStore((state) => state.openLegalHub);
  const openCookieModal = useLegalStore((state) => state.openCookieModal);
  const cookiePreferences = useLegalStore((state) => state.cookiePreferences);

  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [activeShareId, setActiveShareId] = useState<string | null>(null);
  const [isCreatingShare, setIsCreatingShare] = useState(false);

  const [sharedViewId, setSharedViewId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const param = new URLSearchParams(window.location.search).get('share');
    return param && param.trim() ? param.trim() : null;
  });
  const [sharedSnapshot, setSharedSnapshot] = useState<SharedChatSnapshot | null>(null);
  const [sharedLoading, setSharedLoading] = useState(false);
  const [sharedError, setSharedError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<ActiveTab>('workspace');
  const [hasGoogleToken, setHasGoogleToken] = useState(false);
  const [connectedProviders, setConnectedProviders] = useState<ConnectorId[]>(
    DEFAULT_LOCAL_CONNECTORS
  );

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [limits, setLimits] = useState({
    maxRequestsPerMinute: 6,
    maxRequestsPerDay: 53,
    maxTokensPerDay: 60000,
    maxMessageLength: 4000
  });
  const [signInLimitStatus, setSignInLimitStatus] = useState<SignInRateLimitStatus>(() =>
    getSignInRateLimitStatus()
  );

  const [profile, setProfile] = useState<UserProfileDoc | null>(null);
  const [chats, setChats] = useState<ChatSessionDoc[]>([]);
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [isBatchDeletingChats, setIsBatchDeletingChats] = useState(false);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingChatTitle, setEditingChatTitle] = useState('');
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string>(
    DEFAULT_GEMINI_FREE_MODEL_ID
  );
  const [messages, setMessages] = useState<ChatMessageDoc[]>([]);
  const [pendingActionsMap, setPendingActionsMap] = useState<Record<string, PendingActionDoc>>({});
  const [confirmingActionId, setConfirmingActionId] = useState<string | null>(null);
  const [retryingToolKey, setRetryingToolKey] = useState<string | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogDoc[]>([]);

  const [promptInput, setPromptInput] = useState('');
  const [isDictating, setIsDictating] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [isRunningAgent, setIsRunningAgent] = useState(false);
  const [chatBannerError, setChatBannerError] = useState<ChatErrorState | null>(null);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      const saved = localStorage.getItem('vektor_auto_scroll_enabled');
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  const [enterToSend, setEnterToSend] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      const saved = localStorage.getItem('vektor_enter_to_send');
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  const [showToolTraces, setShowToolTraces] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      const saved = localStorage.getItem('vektor_show_tool_traces');
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  const [compactMessages, setCompactMessages] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      const saved = localStorage.getItem('vektor_compact_messages');
      return saved === 'true';
    } catch {
      return false;
    }
  });
  const promptInputRef = useRef<HTMLInputElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const dictationBasePromptRef = useRef<string>('');
  const userScrolledUpRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const distanceFromBottomRef = useRef(0);
  const isProgrammaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const messagesListRef = useListRef(null);
  const dynamicRowHeight = useDynamicRowHeight({
    defaultRowHeight: 220,
    key: activeChatId ?? 'workspace'
  });

  useEffect(() => {
    if (!sharedViewId) {
      setSharedSnapshot(null);
      setSharedError(null);
      setSharedLoading(false);
      return;
    }

    let cancelled = false;
    setSharedLoading(true);
    setSharedError(null);

    fetch(`/api/shares/${encodeURIComponent(sharedViewId)}`, {
      credentials: 'same-origin'
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          share?: SharedChatSnapshot;
          error?: string;
          hint?: string;
        };
        if (!res.ok || !data.share) {
          throw new Error(
            data.error
              ? `${data.error}${data.hint ? ` ${data.hint}` : ''}`
              : 'This shared conversation link was not found or has expired.'
          );
        }
        if (!cancelled) {
          saveLocalSharedSnapshot(data.share);
          setSharedSnapshot(data.share);
          setSharedLoading(false);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const localFallback = loadLocalSharedSnapshot(sharedViewId);
        if (localFallback) {
          setSharedSnapshot(localFallback);
          setSharedLoading(false);
        } else {
          setSharedError(
            err instanceof Error
              ? err.message
              : 'This shared conversation link was not found or has expired.'
          );
          setSharedLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sharedViewId]);

  const stopVoiceDictation = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onend = null;
        recognitionRef.current.stop();
      } catch {
        void 0;
      }
      recognitionRef.current = null;
    }
    setIsDictating(false);
  }, []);

  useEffect(() => {
    return () => {
      stopVoiceDictation();
    };
  }, [stopVoiceDictation]);

  const handleToggleVoiceDictation = useCallback(() => {
    setSpeechError(null);

    if (isDictating) {
      stopVoiceDictation();
      return;
    }

    const SpeechRecognitionCtor = getSpeechRecognitionConstructor();
    if (!SpeechRecognitionCtor) {
      setSpeechError(
        'Voice dictation is not supported in this browser. Please use Chrome, Edge, or Safari.'
      );
      return;
    }

    try {
      const recognition = new SpeechRecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang =
        typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';

      dictationBasePromptRef.current = promptInput.trim();

      recognition.onresult = (event: BrowserSpeechRecognitionEvent) => {
        let finalizedTranscript = '';
        let interimTranscript = '';

        for (let i = 0; i < event.results.length; i += 1) {
          const result = event.results[i];
          const piece = result?.[0]?.transcript || '';
          if (result?.isFinal) {
            finalizedTranscript += piece;
          } else {
            interimTranscript += piece;
          }
        }

        const spokenText = `${finalizedTranscript}${interimTranscript}`.trim();
        const baseText = dictationBasePromptRef.current;
        const combined = baseText
          ? spokenText
            ? `${baseText} ${spokenText}`
            : baseText
          : spokenText;

        setPromptInput(combined.slice(0, limits.maxMessageLength));
      };

      recognition.onerror = (event: BrowserSpeechRecognitionErrorEvent) => {
        if (event.error === 'aborted' || event.error === 'no-speech') {
          setIsDictating(false);
          recognitionRef.current = null;
          return;
        }
        const reason =
          event.error === 'not-allowed' || event.error === 'service-not-allowed'
            ? 'Microphone permission was denied. Allow microphone access in your browser settings to use Voice Dictation.'
            : `Voice dictation stopped (${event.error}).`;
        setSpeechError(reason);
        setIsDictating(false);
        recognitionRef.current = null;
      };

      recognition.onend = () => {
        setIsDictating(false);
        recognitionRef.current = null;
      };

      recognitionRef.current = recognition;
      recognition.start();
      setIsDictating(true);
    } catch (err) {
      setSpeechError(
        err instanceof Error ? err.message : 'Unable to start browser voice dictation.'
      );
      setIsDictating(false);
      recognitionRef.current = null;
    }
  }, [isDictating, limits.maxMessageLength, promptInput, stopVoiceDictation]);

  const handleCopyText = useCallback(async (key: string, textToCopy: string) => {
    const ok = await copyToClipboard(textToCopy);
    if (!ok) return;
    setCopiedKey(key);
    if (copyTimerRef.current) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 2000);
  }, []);

  const getMessageRowKey = useCallback(
    (index: number, data: ChatMessageRowData) => data.messages[index]?.messageId ?? index,
    []
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    if (user) return;
    const refreshSignInStatus = () => {
      setSignInLimitStatus(getSignInRateLimitStatus());
    };
    refreshSignInStatus();
    const timer = window.setInterval(refreshSignInStatus, 5000);
    return () => window.clearInterval(timer);
  }, [user]);

  useEffect(() => {
    if (!user?.uid) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const idToken = await getFirebaseIdToken();
        const headers: Record<string, string> = {};
        if (idToken) {
          headers['X-Firebase-Id-Token'] = idToken;
        }
        const params = new URLSearchParams({ uid: user.uid });
        if (typeof profile?.dailyRequestsCount === 'number' && profile.dailyRequestsCount > 0) {
          params.set('requestsToday', String(profile.dailyRequestsCount));
        }
        if (typeof profile?.dailyTokensUsed === 'number' && profile.dailyTokensUsed > 0) {
          params.set('tokensToday', String(profile.dailyTokensUsed));
        }
        const res = await fetch(`/api/models?${params.toString()}`, {
          credentials: 'same-origin',
          headers,
          signal: controller.signal
        });
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data.models)) setModels(data.models);
        if (Array.isArray(data.tools)) setTools(data.tools);
        if (data.limits) setLimits(data.limits);
        if (data.quota) {
          const serverRequests =
            typeof data.quota.requestsToday === 'number' ? data.quota.requestsToday : 0;
          const serverTokens =
            typeof data.quota.tokensToday === 'number' ? data.quota.tokensToday : 0;
          setProfile((prev) => {
            if (!prev) return prev;
            const mergedRequests = Math.max(prev.dailyRequestsCount || 0, serverRequests);
            const mergedTokens = Math.max(prev.dailyTokensUsed || 0, serverTokens);
            if (
              mergedRequests === prev.dailyRequestsCount &&
              mergedTokens === prev.dailyTokensUsed
            ) {
              return prev;
            }
            const nextProfile: UserProfileDoc = {
              ...prev,
              dailyRequestsCount: mergedRequests,
              dailyTokensUsed: mergedTokens
            };
            const localData = loadLocalVault(user);
            localData.profile = nextProfile;
            saveLocalVault(user.uid, localData);
            if (!user.isServerSession) {
              void updateDoc(doc(db, 'users', user.uid), {
                dailyRequestsCount: mergedRequests,
                dailyTokensUsed: mergedTokens,
                updatedAt: serverTimestamp()
              }).catch(() => void 0);
            }
            return nextProfile;
          });
        }
      } catch {
        return;
      }
    })();
    return () => controller.abort();
  }, [user, activeTab, profileReady]);

  const evaluateAccountConsent = useCallback(async (acct: WorkspaceUser) => {
    if (hasAcceptedLegalConsent(acct.uid, acct.email)) {
      setNeedsConsentGate(false);
      return;
    }
    setNeedsConsentGate(true);
    const serverAccepted = await syncAccountLegalConsent(acct.uid, acct.email);
    if (serverAccepted) {
      setNeedsConsentGate(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = initAuth(async (workspaceUser, token) => {
      setUser(workspaceUser);
      setHasGoogleToken(Boolean(token));
      setConnectedProviders(getConnectedProviders());
      setAuthInitialized(true);

      if (!workspaceUser) {
        setProfileReady(false);
        setProfile(null);
        setChats([]);
        setMessages([]);
        setPendingActionsMap({});
        setAuditLogs([]);
        setActiveChatId(null);
        setNeedsConsentGate(false);
        return;
      }

      void evaluateAccountConsent(workspaceUser);

      if (workspaceUser.isServerSession) {
        const localData = loadLocalVault(workspaceUser);
        setProfile(localData.profile);
        setChats(localData.chats);
        const initialChatId = localData.chats[0]?.chatId || null;
        setActiveChatId(initialChatId);
        setMessages(initialChatId ? localData.messagesByChat[initialChatId] || [] : []);
        setPendingActionsMap(localData.pendingActions);
        setAuditLogs(localData.auditLogs);
        setProfileReady(true);
        return;
      }

      const userPath = `users/${workspaceUser.uid}`;
      try {
        const userRef = doc(db, 'users', workspaceUser.uid);
        const snap = await getDoc(userRef);
        const today = getTodayUtcString();

        if (!snap.exists()) {
          const safeEmail = (workspaceUser.email || 'user@example.com').trim().slice(0, 254);
          const safeName = (
            workspaceUser.displayName ||
            safeEmail.split('@')[0] ||
            'Workspace Operator'
          )
            .trim()
            .slice(0, 120);

          await setDoc(userRef, {
            uid: workspaceUser.uid,
            email: safeEmail.length >= 3 ? safeEmail : 'user@example.com',
            displayName: safeName.length >= 1 ? safeName : 'Workspace Operator',
            plan: 'free',
            dailyRequestsCount: 0,
            dailyTokensUsed: 0,
            lastResetDate: today,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        } else {
          const existingData = snap.data() as UserProfileDoc;
          if (existingData.lastResetDate !== today) {
            await updateDoc(userRef, {
              dailyRequestsCount: 0,
              dailyTokensUsed: 0,
              lastResetDate: today,
              updatedAt: serverTimestamp()
            });
          }
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, userPath);
        const localData = loadLocalVault(workspaceUser);
        setProfile(localData.profile);
        setChats(localData.chats);
        const initialChatId = localData.chats[0]?.chatId || null;
        setActiveChatId(initialChatId);
        setMessages(initialChatId ? localData.messagesByChat[initialChatId] || [] : []);
        setPendingActionsMap(localData.pendingActions);
        setAuditLogs(localData.auditLogs);
      } finally {
        setProfileReady(true);
      }
    });

    return () => unsubscribe();
  }, [evaluateAccountConsent]);

  useEffect(() => {
    if (!user || !profileReady || user.isServerSession) return;
    const uid = user.uid;

    const unsubProfile = onSnapshot(
      doc(db, 'users', uid),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as UserProfileDoc;
          const today = getTodayUtcString();
          if (data.lastResetDate !== today) {
            setProfile({
              ...data,
              dailyRequestsCount: 0,
              dailyTokensUsed: 0,
              lastResetDate: today
            });
            void updateDoc(doc(db, 'users', uid), {
              dailyRequestsCount: 0,
              dailyTokensUsed: 0,
              lastResetDate: today,
              updatedAt: serverTimestamp()
            }).catch(() => void 0);
          } else {
            setProfile(data);
          }
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, `users/${uid}`)
    );

    const chatsQuery = query(collection(db, 'users', uid, 'chats'), where('uid', '==', uid));
    const unsubChats = onSnapshot(
      chatsQuery,
      (snap) => {
        const list = snap.docs.map((d) => d.data() as ChatSessionDoc);
        list.sort((a, b) => (b.chatId > a.chatId ? 1 : -1));
        if (list.length > 0) {
          setChats(list);
          const localData = loadLocalVault(user);
          localData.chats = list;
          saveLocalVault(uid, localData);
          setActiveChatId((current) => {
            if (current && list.some((c) => c.chatId === current)) return current;
            let savedChatId: string | null = null;
            try {
              savedChatId = localStorage.getItem(`vektor_active_chat_${uid}`);
            } catch {
              savedChatId = null;
            }
            if (savedChatId && list.some((c) => c.chatId === savedChatId)) {
              return savedChatId;
            }
            return list[0]?.chatId || null;
          });
        } else {
          const localData = loadLocalVault(user);
          if (localData.chats.length > 0) {
            setChats(localData.chats);
            setActiveChatId((current) => {
              if (current && localData.chats.some((c) => c.chatId === current)) return current;
              return localData.chats[0]?.chatId || null;
            });
          } else {
            setChats([]);
            setActiveChatId(null);
          }
        }
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `users/${uid}/chats`)
    );

    const actionsQuery = query(
      collection(db, 'users', uid, 'pendingActions'),
      where('uid', '==', uid)
    );
    const unsubActions = onSnapshot(
      actionsQuery,
      (snap) => {
        const map: Record<string, PendingActionDoc> = {};
        for (const d of snap.docs) {
          const data = d.data() as PendingActionDoc;
          map[data.actionId] = data;
        }
        setPendingActionsMap(map);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `users/${uid}/pendingActions`)
    );

    const auditQuery = query(collection(db, 'users', uid, 'auditLog'), where('uid', '==', uid));
    const unsubAudit = onSnapshot(
      auditQuery,
      (snap) => {
        const list = snap.docs.map((d) => d.data() as AuditLogDoc);
        list.sort((a, b) => (b.logId > a.logId ? 1 : -1));
        setAuditLogs(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `users/${uid}/auditLog`)
    );

    return () => {
      unsubProfile();
      unsubChats();
      unsubActions();
      unsubAudit();
    };
  }, [user, profileReady]);

  useEffect(() => {
    if (!user || !profile) return;
    const checkUtcMidnightRollover = () => {
      const today = getTodayUtcString();
      if (profile.lastResetDate === today) return;

      const resetProfile: UserProfileDoc = {
        ...profile,
        dailyRequestsCount: 0,
        dailyTokensUsed: 0,
        lastResetDate: today
      };
      setProfile(resetProfile);

      const localData = loadLocalVault(user);
      localData.profile = resetProfile;
      saveLocalVault(user.uid, localData);

      if (!user.isServerSession) {
        void updateDoc(doc(db, 'users', user.uid), {
          dailyRequestsCount: 0,
          dailyTokensUsed: 0,
          lastResetDate: today,
          updatedAt: serverTimestamp()
        }).catch(() => void 0);
      }

      void (async () => {
        try {
          const idToken = await getFirebaseIdToken();
          const headers: Record<string, string> = {};
          if (idToken) {
            headers['X-Firebase-Id-Token'] = idToken;
          }
          const res = await fetch(`/api/models?uid=${encodeURIComponent(user.uid)}`, {
            credentials: 'same-origin',
            headers
          });
          if (!res.ok) return;
          const data = await res.json();
          if (Array.isArray(data.models)) setModels(data.models);
        } catch {
          return;
        }
      })();
    };

    checkUtcMidnightRollover();
    const timer = window.setInterval(checkUtcMidnightRollover, 30_000);
    return () => window.clearInterval(timer);
  }, [profile, user]);

  useEffect(() => {
    if (!user || !profileReady || !activeChatId) {
      setMessages([]);
      return;
    }

    const activeChat = chats.find((c) => c.chatId === activeChatId);
    if (activeChat && activeChat.modelId) {
      setSelectedModelId(normalizeWorkspaceModelId(activeChat.modelId));
    }

    try {
      localStorage.setItem(`vektor_active_chat_${user.uid}`, activeChatId);
    } catch {
      void 0;
    }

    if (user.isServerSession) {
      const localData = loadLocalVault(user);
      setMessages(localData.messagesByChat[activeChatId] || []);
      return;
    }

    const uid = user.uid;
    const msgQuery = query(
      collection(db, 'users', uid, 'chats', activeChatId, 'messages'),
      where('uid', '==', uid)
    );

    const unsubMessages = onSnapshot(
      msgQuery,
      (snap) => {
        const list = snap.docs.map((d) => d.data() as ChatMessageDoc);
        list.sort((a, b) => (a.messageId > b.messageId ? 1 : -1));
        if (list.length > 0) {
          setMessages(list);
          const localData = loadLocalVault(user);
          localData.messagesByChat[activeChatId] = list;
          saveLocalVault(uid, localData);
        } else {
          const localData = loadLocalVault(user);
          const cachedMsgs = localData.messagesByChat[activeChatId];
          setMessages(cachedMsgs && cachedMsgs.length > 0 ? cachedMsgs : []);
        }
      },
      (err) =>
        handleFirestoreError(
          err,
          OperationType.LIST,
          `users/${uid}/chats/${activeChatId}/messages`
        )
    );

    return () => unsubMessages();
  }, [user, profileReady, activeChatId]);

  const markProgrammaticScroll = useCallback(() => {
    isProgrammaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }
    programmaticScrollTimerRef.current = window.setTimeout(() => {
      isProgrammaticScrollRef.current = false;
      programmaticScrollTimerRef.current = null;
    }, 450);
  }, []);

  useEffect(() => {
    return () => {
      if (programmaticScrollTimerRef.current) {
        window.clearTimeout(programmaticScrollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    userScrolledUpRef.current = false;
    distanceFromBottomRef.current = 0;
    lastScrollTopRef.current = 0;
    setIsUserScrolledUp(false);
  }, [activeChatId]);

  const handleChatScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const currentScrollTop = el.scrollTop;
    const distanceFromBottom = Math.max(0, el.scrollHeight - currentScrollTop - el.clientHeight);
    const scrolledUpward = currentScrollTop < lastScrollTopRef.current - 2;

    lastScrollTopRef.current = currentScrollTop;
    distanceFromBottomRef.current = distanceFromBottom;

    if (isProgrammaticScrollRef.current) {
      return;
    }

    if (scrolledUpward && distanceFromBottom > 80) {
      userScrolledUpRef.current = true;
      setIsUserScrolledUp(true);
    } else if (distanceFromBottom <= 32) {
      userScrolledUpRef.current = false;
      setIsUserScrolledUp(false);
    }
  }, []);

  const handleJumpToBottom = useCallback(() => {
    userScrolledUpRef.current = false;
    distanceFromBottomRef.current = 0;
    setIsUserScrolledUp(false);

    if (messages.length === 0) return;

    markProgrammaticScroll();
    try {
      messagesListRef.current?.scrollToRow({
        index: messages.length - 1,
        align: 'end',
        behavior: 'smooth'
      });
    } catch {
      const el = messagesListRef.current?.element;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      }
    }
  }, [markProgrammaticScroll, messages.length, messagesListRef]);

  const handleToggleAutoScroll = useCallback(() => {
    setAutoScrollEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('vektor_auto_scroll_enabled', String(next));
      } catch {
        void 0;
      }
      if (next) {
        userScrolledUpRef.current = false;
        distanceFromBottomRef.current = 0;
        setIsUserScrolledUp(false);
        if (messages.length > 0) {
          markProgrammaticScroll();
          try {
            messagesListRef.current?.scrollToRow({
              index: messages.length - 1,
              align: 'end',
              behavior: 'smooth'
            });
          } catch {
            const el = messagesListRef.current?.element;
            if (el) {
              el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            }
          }
        }
      }
      return next;
    });
  }, [markProgrammaticScroll, messages.length, messagesListRef]);

  useEffect(() => {
    if (messages.length === 0) {
      userScrolledUpRef.current = false;
      distanceFromBottomRef.current = 0;
      setIsUserScrolledUp(false);
      return;
    }

    if (!autoScrollEnabled) {
      if (distanceFromBottomRef.current > 80) {
        setIsUserScrolledUp(true);
      }
      return;
    }

    if (userScrolledUpRef.current || distanceFromBottomRef.current > 80) {
      userScrolledUpRef.current = true;
      setIsUserScrolledUp(true);
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      markProgrammaticScroll();
      try {
        messagesListRef.current?.scrollToRow({
          index: messages.length - 1,
          align: 'end',
          behavior: 'smooth'
        });
      } catch {
        isProgrammaticScrollRef.current = false;
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [
    autoScrollEnabled,
    messages.length,
    activeChatId,
    isRunningAgent,
    markProgrammaticScroll,
    messagesListRef
  ]);

  const handleChangeTheme = useCallback((nextTheme: ThemeMode) => {
    setTheme(nextTheme);
    try {
      localStorage.setItem('vektor_workspace_theme', nextTheme);
    } catch {
      void 0;
    }
  }, []);

  const handleToggleEnterToSend = useCallback(() => {
    setEnterToSend((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('vektor_enter_to_send', String(next));
      } catch {
        void 0;
      }
      return next;
    });
  }, []);

  const handleToggleShowToolTraces = useCallback(() => {
    setShowToolTraces((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('vektor_show_tool_traces', String(next));
      } catch {
        void 0;
      }
      return next;
    });
  }, []);

  const handleToggleCompactMessages = useCallback(() => {
    setCompactMessages((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('vektor_compact_messages', String(next));
      } catch {
        void 0;
      }
      return next;
    });
  }, []);

  const handleGoogleBasicLogin = async () => {
    if (!acceptedAuthPolicy) {
      setAuthError(
        'You must accept the Privacy Policy, Cookie Policy & Terms of User Agreement before signing in or creating an account.'
      );
      setAuthPolicyModalOpen(true);
      return;
    }
    setIsSigningIn(true);
    setAuthError(null);
    try {
      const result = await googleSignInBasic();
      recordLegalConsentAccepted(result.user.uid, result.user.email);
      setUser(result.user);
      setHasGoogleToken(Boolean(result.accessToken));
      setConnectedProviders(result.connectedProviders);
      setNeedsConsentGate(false);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Google sign-in failed.');
    } finally {
      setSignInLimitStatus(getSignInRateLimitStatus());
      setIsSigningIn(false);
    }
  };

  const handleGoogleWorkspaceLogin = async () => {
    if (!acceptedAuthPolicy) {
      setAuthError(
        'You must accept the Privacy Policy, Cookie Policy & Terms of User Agreement before signing in or creating an account.'
      );
      setAuthPolicyModalOpen(true);
      return;
    }
    setIsSigningIn(true);
    setAuthError(null);
    try {
      const result = await googleSignInWithWorkspaceScopes(GOOGLE_OAUTH_CONNECTORS);
      recordLegalConsentAccepted(result.user.uid, result.user.email);
      setUser(result.user);
      setHasGoogleToken(Boolean(result.accessToken));
      setConnectedProviders(result.connectedProviders);
      setNeedsConsentGate(false);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Google Workspace sign-in failed.');
    } finally {
      setSignInLimitStatus(getSignInRateLimitStatus());
      setIsSigningIn(false);
    }
  };

  const handleEmailAuthSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!emailInput.trim() || !passwordInput) return;

    if (!acceptedAuthPolicy) {
      setAuthError(
        'You must accept the Privacy Policy, Cookie Policy & Terms of User Agreement before signing in or creating an account.'
      );
      setAuthPolicyModalOpen(true);
      return;
    }

    if (authMode === 'signup') {
      if (passwordInput.length < 6) {
        setAuthError('Password must be at least 6 characters long.');
        return;
      }
      if (passwordInput !== confirmPasswordInput) {
        setAuthError('Passwords do not match. Please verify your confirm password field.');
        return;
      }
    }

    setIsSigningIn(true);
    setAuthError(null);
    try {
      if (authMode === 'signin') {
        const res = await emailPasswordSignIn(emailInput, passwordInput);
        recordLegalConsentAccepted(res.user.uid, res.user.email);
        setUser(res.user);
        setConnectedProviders(res.connectedProviders);
        setNeedsConsentGate(false);
        if (res.user.isServerSession) {
          const localData = loadLocalVault(res.user);
          setProfile(localData.profile);
          setChats(localData.chats);
          setActiveChatId(localData.chats[0]?.chatId || null);
          setPendingActionsMap(localData.pendingActions);
          setAuditLogs(localData.auditLogs);
          setProfileReady(true);
        }
      } else {
        const res = await emailPasswordSignUp(emailInput, passwordInput, displayNameInput);
        recordLegalConsentAccepted(res.user.uid, res.user.email);
        setUser(res.user);
        setConnectedProviders(res.connectedProviders);
        setNeedsConsentGate(false);
        if (res.user.isServerSession) {
          const localData = loadLocalVault(res.user);
          setProfile(localData.profile);
          setChats(localData.chats);
          setActiveChatId(localData.chats[0]?.chatId || null);
          setPendingActionsMap(localData.pendingActions);
          setAuditLogs(localData.auditLogs);
          setProfileReady(true);
        }
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setSignInLimitStatus(getSignInRateLimitStatus());
      setIsSigningIn(false);
    }
  };

  const handleCreateNewSession = async (): Promise<string | null> => {
    if (!user) return null;
    const chatId = makeSafeId('chat');
    const cleanModelId = normalizeWorkspaceModelId(selectedModelId);

    const newChat: ChatSessionDoc = {
      chatId,
      uid: user.uid,
      title: 'New Agent Session',
      modelId: cleanModelId
    };

    const localData = loadLocalVault(user);
    localData.chats = [newChat, ...localData.chats.filter((c) => c.chatId !== chatId)];
    localData.messagesByChat[chatId] = [];
    saveLocalVault(user.uid, localData);

    setChats(localData.chats);
    setActiveChatId(chatId);
    setMessages([]);
    setChatBannerError(null);
    setLastFailedPrompt(null);
    setActiveTab('workspace');

    if (user.isServerSession) {
      return chatId;
    }

    const chatPath = `users/${user.uid}/chats/${chatId}`;
    try {
      await setDoc(doc(db, 'users', user.uid, 'chats', chatId), {
        chatId,
        uid: user.uid,
        title: 'New Agent Session',
        modelId: cleanModelId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, chatPath);
    }
    return chatId;
  };

  useEffect(() => {
    if (!user?.uid) {
      setSelectedChatIds([]);
      setEditingChatId(null);
      setEditingChatTitle('');
    }
  }, [user?.uid]);

  useEffect(() => {
    setSelectedChatIds((prev) => {
      if (prev.length === 0) return prev;
      const validIds = new Set(chats.map((c) => c.chatId));
      const next = prev.filter((id) => validIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [chats]);

  const handleRenameChat = async (chatId: string, rawTitle: string) => {
    setEditingChatId(null);
    if (!user) return;

    const cleanTitle = rawTitle.trim().slice(0, 160);
    if (!cleanTitle) return;

    const existingChat = chats.find((c) => c.chatId === chatId);
    if (existingChat && existingChat.title === cleanTitle) return;

    setChats((prev) =>
      prev.map((c) => (c.chatId === chatId ? { ...c, title: cleanTitle } : c))
    );

    const localData = loadLocalVault(user);
    if (localData.chats.some((c) => c.chatId === chatId)) {
      localData.chats = localData.chats.map((c) =>
        c.chatId === chatId ? { ...c, title: cleanTitle } : c
      );
      saveLocalVault(user.uid, localData);
    }

    if (user.isServerSession) {
      return;
    }

    try {
      await updateDoc(doc(db, 'users', user.uid, 'chats', chatId), {
        title: cleanTitle,
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}/chats/${chatId}`);
    }
  };

  const handleToggleSelectChat = useCallback((chatId: string) => {
    setSelectedChatIds((prev) =>
      prev.includes(chatId) ? prev.filter((id) => id !== chatId) : [...prev, chatId]
    );
  }, []);

  const handleToggleSelectAllSessions = useCallback((visibleChatIds: string[]) => {
    if (visibleChatIds.length === 0) return;
    setSelectedChatIds((prev) => {
      const prevSet = new Set(prev);
      const allVisibleSelected = visibleChatIds.every((id) => prevSet.has(id));
      if (allVisibleSelected) {
        const visibleSet = new Set(visibleChatIds);
        return prev.filter((id) => !visibleSet.has(id));
      }
      const merged = new Set([...prev, ...visibleChatIds]);
      return Array.from(merged);
    });
  }, []);

  const handleBatchDeleteSelectedChats = async () => {
    if (!user || selectedChatIds.length === 0 || isBatchDeletingChats) return;
    const idsToDelete = [...selectedChatIds];
    const deleteSet = new Set(idsToDelete);

    setIsBatchDeletingChats(true);
    try {
      const remainingChats = chats.filter((c) => !deleteSet.has(c.chatId));
      const nextActiveChatId =
        activeChatId && !deleteSet.has(activeChatId)
          ? activeChatId
          : remainingChats[0]?.chatId || null;

      if (editingChatId && deleteSet.has(editingChatId)) {
        setEditingChatId(null);
        setEditingChatTitle('');
      }

      const localData = loadLocalVault(user);
      localData.chats = localData.chats.filter((c) => !deleteSet.has(c.chatId));
      for (const id of idsToDelete) {
        delete localData.messagesByChat[id];
      }
      saveLocalVault(user.uid, localData);

      setSelectedChatIds([]);
      setChats(remainingChats);
      if (activeChatId !== nextActiveChatId) {
        setActiveChatId(nextActiveChatId);
        if (user.isServerSession) {
          setMessages(nextActiveChatId ? localData.messagesByChat[nextActiveChatId] || [] : []);
        } else if (!nextActiveChatId) {
          setMessages([]);
        }
      }

      if (!user.isServerSession) {
        for (const chatId of idsToDelete) {
          try {
            const msgSnap = await getDocs(
              query(
                collection(db, 'users', user.uid, 'chats', chatId, 'messages'),
                where('uid', '==', user.uid)
              )
            );
            for (const m of msgSnap.docs) {
              await deleteDoc(m.ref);
            }
            await deleteDoc(doc(db, 'users', user.uid, 'chats', chatId));
          } catch (err) {
            handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/chats/${chatId}`);
          }
        }
      }
    } finally {
      setIsBatchDeletingChats(false);
    }
  };

  const handleDeleteChat = async (chatId: string) => {
    if (!user) return;
    setSelectedChatIds((prev) => prev.filter((id) => id !== chatId));
    if (editingChatId === chatId) {
      setEditingChatId(null);
      setEditingChatTitle('');
    }
    if (user.isServerSession) {
      const localData = loadLocalVault(user);
      localData.chats = localData.chats.filter((c) => c.chatId !== chatId);
      delete localData.messagesByChat[chatId];
      saveLocalVault(user.uid, localData);
      setChats(localData.chats);
      if (activeChatId === chatId) {
        const nextId = localData.chats[0]?.chatId || null;
        setActiveChatId(nextId);
        setMessages(nextId ? localData.messagesByChat[nextId] || [] : []);
      }
      return;
    }

    try {
      const msgSnap = await getDocs(
        query(
          collection(db, 'users', user.uid, 'chats', chatId, 'messages'),
          where('uid', '==', user.uid)
        )
      );
      for (const m of msgSnap.docs) {
        await deleteDoc(m.ref);
      }
      await deleteDoc(doc(db, 'users', user.uid, 'chats', chatId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/chats/${chatId}`);
    }
  };

  const handleModelSwitch = async (nextModelId: string) => {
    setSelectedModelId(nextModelId);
    if (!user || !activeChatId) return;

    if (user.isServerSession) {
      const localData = loadLocalVault(user);
      localData.chats = localData.chats.map((c) =>
        c.chatId === activeChatId ? { ...c, modelId: nextModelId } : c
      );
      saveLocalVault(user.uid, localData);
      setChats(localData.chats);
      return;
    }

    try {
      await updateDoc(doc(db, 'users', user.uid, 'chats', activeChatId), {
        modelId: nextModelId,
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}/chats/${activeChatId}`);
    }
  };

  const handleStopStream = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsRunningAgent(false);
    }
  };

  const handleSendMessage = async (e?: FormEvent, overridePrompt?: string) => {
    if (e) e.preventDefault();
    if (isDictating) {
      stopVoiceDictation();
    }
    setSpeechError(null);
    const rawPrompt = (overridePrompt !== undefined ? overridePrompt : promptInput).trim();
    if (!rawPrompt || !user || isRunningAgent) return;

    setChatBannerError(null);
    setLastFailedPrompt(null);

    const uid = user.uid;
    const priorHistory = messages
      .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
      .slice(-8)
      .map((m) => ({
        role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: m.content.trim().slice(0, 4000)
      }));

    const effectiveModelId = normalizeWorkspaceModelId(selectedModelId);
    if (effectiveModelId !== selectedModelId) {
      setSelectedModelId(effectiveModelId);
    }

    const candidatePayload = {
      uid,
      modelId: effectiveModelId,
      message: rawPrompt,
      history: priorHistory,
      connectedProviders:
        connectedProviders.length > 0 ? connectedProviders : DEFAULT_LOCAL_CONNECTORS
    };

    const validationResult = ChatRequestPayloadSchema.safeParse(candidatePayload);
    if (!validationResult.success) {
      setLastFailedPrompt(rawPrompt);
      setChatBannerError(
        formatZodValidationBanner(validationResult.error.issues, effectiveModelId)
      );
      return;
    }

    const requestPayload = validationResult.data;

    if (overridePrompt === undefined) {
      setPromptInput('');
    }
    setIsRunningAgent(true);

    const targetChatId = activeChatId || makeSafeId('chat');
    const isCreatingNewChat = !activeChatId;

    const userMsgId = makeSafeId('msg');
    const optimisticUserMsg: ChatMessageDoc = {
      messageId: userMsgId,
      chatId: targetChatId,
      uid: requestPayload.uid,
      role: 'user',
      content: requestPayload.message,
      modelId: requestPayload.modelId
    };

    if (isCreatingNewChat) {
      setActiveChatId(targetChatId);
    }
    setMessages((prev) => [...prev, optimisticUserMsg]);

    let useLocalPersistence = Boolean(user.isServerSession);

    const existingTargetChat = chats.find((c) => c.chatId === targetChatId);
    const hasCustomTitle =
      Boolean(existingTargetChat?.title) && existingTargetChat?.title !== 'New Agent Session';

    try {
      const initialLocalData = loadLocalVault(user);
      if (!initialLocalData.chats.some((c) => c.chatId === targetChatId)) {
        const newChat: ChatSessionDoc = {
          chatId: targetChatId,
          uid,
          title: requestPayload.message.slice(0, 64),
          modelId: requestPayload.modelId
        };
        initialLocalData.chats = [newChat, ...initialLocalData.chats];
        initialLocalData.messagesByChat[targetChatId] = [];
      } else if (
        (initialLocalData.messagesByChat[targetChatId] || []).length === 0 &&
        !hasCustomTitle
      ) {
        initialLocalData.chats = initialLocalData.chats.map((c) =>
          c.chatId === targetChatId
            ? {
                ...c,
                title: requestPayload.message.slice(0, 64),
                modelId: requestPayload.modelId
              }
            : c
        );
      }
      initialLocalData.messagesByChat[targetChatId] = [
        ...(initialLocalData.messagesByChat[targetChatId] || []),
        optimisticUserMsg
      ];
      saveLocalVault(uid, initialLocalData);
      setChats([...initialLocalData.chats]);

      if (!useLocalPersistence) {
        try {
          const chatDocRef = doc(db, 'users', uid, 'chats', targetChatId);
          const chatSnap = isCreatingNewChat ? null : await getDoc(chatDocRef);
          if (isCreatingNewChat || !chatSnap || !chatSnap.exists()) {
            await setDoc(chatDocRef, {
              chatId: targetChatId,
              uid,
              title: requestPayload.message.slice(0, 64),
              modelId: requestPayload.modelId.slice(0, 120),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
          } else if (messages.length === 0 && !hasCustomTitle) {
            await updateDoc(chatDocRef, {
              title: requestPayload.message.slice(0, 64),
              modelId: requestPayload.modelId.slice(0, 120),
              updatedAt: serverTimestamp()
            });
          }

          await setDoc(doc(db, 'users', uid, 'chats', targetChatId, 'messages', userMsgId), {
            messageId: userMsgId,
            chatId: targetChatId,
            uid,
            role: 'user',
            content: requestPayload.message,
            modelId: requestPayload.modelId.slice(0, 120),
            createdAt: serverTimestamp()
          });
        } catch {
          useLocalPersistence = true;
        }
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;

      const googleToken = getAccessToken();
      const firebaseIdToken = await getFirebaseIdToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (googleToken) {
        headers.Authorization = `Bearer ${googleToken}`;
      }
      if (firebaseIdToken) {
        headers['X-Firebase-Id-Token'] = firebaseIdToken;
      }

      const {
        response: res,
        rawBody: rawResponseBody
      } = await fetchChatWithTimeout({
        endpoint: '/api/chat',
        headers,
        payload: requestPayload,
        userSignal: controller.signal,
        timeoutMs: CHAT_REQUEST_TIMEOUT_MS
      });

      let data: Record<string, any> = {};
      try {
        data = rawResponseBody ? JSON.parse(rawResponseBody) : {};
      } catch {
        data = {};
      }

      if (Array.isArray(data.models)) {
        setModels(data.models);
      }
      if (data.quota) {
        setProfile((prev) =>
          prev
            ? {
                ...prev,
                dailyRequestsCount:
                  typeof data.quota.requestsToday === 'number'
                    ? data.quota.requestsToday
                    : prev.dailyRequestsCount + 1,
                dailyTokensUsed:
                  typeof data.quota.tokensToday === 'number'
                    ? data.quota.tokensToday
                    : prev.dailyTokensUsed + Number(data.tokensUsed || 250)
              }
            : null
        );
      }

      if (!res.ok) {
        const is5xx = res.status >= 500;
        setLastFailedPrompt(rawPrompt);
        setChatBannerError({
          statusCode: res.status,
          category: is5xx ? '5xx' : '4xx',
          failureKind: 'http',
          title:
            typeof data.title === 'string'
              ? data.title
              : is5xx
                ? `Workspace Server Error (${res.status})`
                : `Request Error (${res.status})`,
          message:
            typeof data.error === 'string'
              ? data.error
              : `The request returned status ${res.status}.`,
          hint: typeof data.hint === 'string' ? data.hint : undefined,
          modelId: requestPayload.modelId,
          endpoint: '/api/chat',
          timestamp: new Date().toISOString()
        });
        setIsRunningAgent(false);
        return;
      }

      const traceSummary =
        Array.isArray(data.toolTraces) && data.toolTraces.length > 0
          ? (data.toolTraces as ToolTraceItem[])
              .map(
                (t) =>
                  `${t.toolName} · ${t.risk} · ${t.status} · ${t.durationMs}ms${
                    t.argsJson ? ` · ${encodeURIComponent(t.argsJson)}` : ''
                  }`
              )
              .join('\n')
          : undefined;

      const assistantMsgId = makeSafeId('msg');
      let savedPendingActionId: string | undefined;
      if (data.pendingAction) {
        savedPendingActionId = data.pendingAction.actionId;
        const pa = data.pendingAction;
        setPendingActionsMap((prev) => ({
          ...prev,
          [pa.actionId]: {
            actionId: pa.actionId,
            uid,
            chatId: targetChatId,
            toolName: pa.toolName,
            risk: pa.risk,
            argsPreview: pa.argsPreview,
            argsHash: pa.argsHash,
            serverSignature: pa.serverSignature,
            warningText: pa.warningText,
            status: 'pending',
            expiresAtMs: pa.expiresAtMs
          }
        }));
      }

      const cleanReply = sanitizeAssistantOutput(String(data.reply || 'Done.')).slice(0, 15000);

      const assistantMsgObj: ChatMessageDoc = {
        messageId: assistantMsgId,
        chatId: targetChatId,
        uid,
        role: 'assistant',
        content: cleanReply || 'Done.',
        modelId: String(data.usedModelId || requestPayload.modelId).slice(0, 120),
        ...(traceSummary ? { toolTraceSummary: traceSummary.slice(0, 4000) } : {}),
        ...(savedPendingActionId ? { pendingActionId: savedPendingActionId } : {})
      };

      setMessages((prev) => {
        if (prev.some((m) => m.messageId === assistantMsgId)) return prev;
        return [...prev, assistantMsgObj];
      });

      if (!useLocalPersistence && targetChatId) {
        try {
          if (Array.isArray(data.auditEntries)) {
            for (const entry of data.auditEntries) {
              const safeLogId = makeSafeId('log');
              await setDoc(doc(db, 'users', uid, 'auditLog', safeLogId), {
                logId: safeLogId,
                uid,
                chatId: targetChatId,
                toolName: String(entry.toolName || 'tool').slice(0, 80),
                risk: entry.risk || 'read',
                summary: String(entry.summary || 'Executed tool').slice(0, 600),
                status: entry.status || 'success',
                durationMs: Number(entry.durationMs || 0),
                createdAt: serverTimestamp()
              });
            }
          }

          if (data.pendingAction) {
            const pa = data.pendingAction;
            await setDoc(doc(db, 'users', uid, 'pendingActions', pa.actionId), {
              actionId: pa.actionId,
              uid,
              chatId: targetChatId,
              toolName: pa.toolName,
              risk: pa.risk,
              argsPreview: pa.argsPreview,
              argsHash: pa.argsHash,
              serverSignature: pa.serverSignature,
              warningText: pa.warningText,
              status: 'pending',
              expiresAtMs: pa.expiresAtMs,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
          }

          const assistantPayload: Record<string, unknown> = {
            messageId: assistantMsgId,
            chatId: targetChatId,
            uid,
            role: 'assistant',
            content: assistantMsgObj.content,
            modelId: assistantMsgObj.modelId,
            createdAt: serverTimestamp()
          };
          if (assistantMsgObj.toolTraceSummary) {
            assistantPayload.toolTraceSummary = assistantMsgObj.toolTraceSummary;
          }
          if (assistantMsgObj.pendingActionId) {
            assistantPayload.pendingActionId = assistantMsgObj.pendingActionId;
          }

          await setDoc(
            doc(db, 'users', uid, 'chats', targetChatId, 'messages', assistantMsgId),
            assistantPayload
          );

          if (profile) {
            const today = getTodayUtcString();
            const isNewDay = profile.lastResetDate !== today;
            const fallbackRequests = isNewDay ? 1 : (profile.dailyRequestsCount || 0) + 1;
            const fallbackTokens =
              (isNewDay ? 0 : profile.dailyTokensUsed || 0) + Number(data.tokensUsed || 250);
            const nextRequests =
              typeof data.quota?.requestsToday === 'number'
                ? Math.max(fallbackRequests, data.quota.requestsToday)
                : fallbackRequests;
            const nextTokens =
              typeof data.quota?.tokensToday === 'number'
                ? Math.max(fallbackTokens, data.quota.tokensToday)
                : fallbackTokens;

            await updateDoc(doc(db, 'users', uid), {
              dailyRequestsCount: nextRequests,
              dailyTokensUsed: nextTokens,
              lastResetDate: today,
              updatedAt: serverTimestamp()
            });
          }
        } catch {
          useLocalPersistence = true;
        }
      }

      if (targetChatId) {
        const localData = loadLocalVault(user);
        if (Array.isArray(data.auditEntries)) {
          for (const entry of data.auditEntries) {
            localData.auditLogs.unshift({
              logId: makeSafeId('log'),
              uid,
              chatId: targetChatId,
              toolName: String(entry.toolName || 'tool').slice(0, 80),
              risk: entry.risk || 'read',
              summary: String(entry.summary || 'Executed tool').slice(0, 600),
              status: entry.status || 'success',
              durationMs: Number(entry.durationMs || 0)
            });
          }
        }

        if (data.pendingAction) {
          const pa = data.pendingAction;
          localData.pendingActions[pa.actionId] = {
            actionId: pa.actionId,
            uid,
            chatId: targetChatId,
            toolName: pa.toolName,
            risk: pa.risk,
            argsPreview: pa.argsPreview,
            argsHash: pa.argsHash,
            serverSignature: pa.serverSignature,
            warningText: pa.warningText,
            status: 'pending',
            expiresAtMs: pa.expiresAtMs
          };
        }

        const existingMsgs = localData.messagesByChat[targetChatId] || [];
        if (!existingMsgs.some((m) => m.messageId === assistantMsgObj.messageId)) {
          localData.messagesByChat[targetChatId] = [...existingMsgs, assistantMsgObj];
        }

        const today = getTodayUtcString();
        const isNewDay = localData.profile.lastResetDate !== today;
        const fallbackLocalReqs = isNewDay ? 1 : (localData.profile.dailyRequestsCount || 0) + 1;
        const fallbackLocalTokens =
          (isNewDay ? 0 : localData.profile.dailyTokensUsed || 0) +
          Number(data.tokensUsed || 250);
        localData.profile = {
          ...localData.profile,
          dailyRequestsCount:
            typeof data.quota?.requestsToday === 'number'
              ? Math.max(fallbackLocalReqs, data.quota.requestsToday)
              : fallbackLocalReqs,
          dailyTokensUsed:
            typeof data.quota?.tokensToday === 'number'
              ? Math.max(fallbackLocalTokens, data.quota.tokensToday)
              : fallbackLocalTokens,
          lastResetDate: today
        };

        saveLocalVault(uid, localData);
        setProfile({ ...localData.profile });
        if (useLocalPersistence) {
          setPendingActionsMap({ ...localData.pendingActions });
          setAuditLogs([...localData.auditLogs]);
        }
      }
    } catch (err) {
      if (err instanceof ChatNetworkError) {
        if (err.failureKind === 'aborted') {
          setChatBannerError({
            statusCode: err.statusCode,
            category: '4xx',
            failureKind: 'aborted',
            title: err.title,
            message: err.message,
            hint: err.hint,
            modelId: requestPayload.modelId,
            endpoint: '/api/chat',
            timestamp: new Date().toISOString()
          });
        } else {
          setLastFailedPrompt(rawPrompt);
          setChatBannerError({
            statusCode: err.statusCode,
            category: 'network',
            failureKind: err.failureKind,
            title: err.title,
            message: err.message,
            hint: err.hint,
            modelId: requestPayload.modelId,
            endpoint: '/api/chat',
            timestamp: new Date().toISOString()
          });
        }
      } else {
        setLastFailedPrompt(rawPrompt);
        setChatBannerError({
          statusCode: 503,
          category: 'network',
          failureKind: 'unreachable',
          title: 'Service Temporarily Unreachable',
          message: err instanceof Error ? err.message : 'Could not complete the request.',
          hint: 'Verify your network connection and try again.',
          modelId: requestPayload.modelId,
          endpoint: '/api/chat',
          timestamp: new Date().toISOString()
        });
      }
    } finally {
      abortControllerRef.current = null;
      setIsRunningAgent(false);
    }
  };

  const handleConfirmDecision = async (
    action: PendingActionDoc,
    decision: 'approve' | 'reject'
  ) => {
    if (!user) return;
    const uid = user.uid;
    setChatBannerError(null);
    setConfirmingActionId(action.actionId);

    try {
      const googleToken = getAccessToken();
      const firebaseIdToken = await getFirebaseIdToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (googleToken) {
        headers.Authorization = `Bearer ${googleToken}`;
      }
      if (firebaseIdToken) {
        headers['X-Firebase-Id-Token'] = firebaseIdToken;
      }

      const res = await fetch('/api/actions/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({
          uid,
          actionId: action.actionId,
          decision,
          toolName: action.toolName,
          argsPreview: action.argsPreview,
          argsHash: action.argsHash,
          serverSignature: action.serverSignature,
          expiresAtMs: action.expiresAtMs
        })
      });

      const data = await res.json().catch(() => ({}));

      if (user.isServerSession) {
        const localData = loadLocalVault(user);
        if (res.status === 410) {
          if (localData.pendingActions[action.actionId]) {
            localData.pendingActions[action.actionId].status = 'expired';
          }
          saveLocalVault(uid, localData);
          setPendingActionsMap({ ...localData.pendingActions });
          setChatBannerError({
            statusCode: 410,
            category: '4xx',
            title: data.title || 'Confirmation Card Expired (410)',
            message: data.error || 'Confirmation card expired.',
            hint:
              data.hint ||
              'Click Retry Tool on the execution trace badge to re-run with the original arguments.',
            endpoint: '/api/actions/confirm',
            timestamp: new Date().toISOString()
          });
          return;
        }
        if (!res.ok) {
          setChatBannerError({
            statusCode: res.status,
            category: res.status >= 500 ? '5xx' : '4xx',
            title: data.title || `Action Confirmation Error (${res.status})`,
            message: data.error || 'Confirmation failed.',
            hint: data.hint,
            endpoint: '/api/actions/confirm',
            timestamp: new Date().toISOString()
          });
          return;
        }
        const nextStatus = decision === 'approve' ? 'executed' : 'rejected';
        const durationMs = Number(data.auditEntry?.durationMs || 0);
        if (localData.pendingActions[action.actionId]) {
          localData.pendingActions[action.actionId].status = nextStatus;
        }
        if (data.auditEntry) {
          localData.auditLogs.unshift({
            logId: makeSafeId('log'),
            uid,
            chatId: action.chatId,
            toolName: action.toolName,
            risk: action.risk,
            summary: String(data.auditEntry.summary || `Action ${nextStatus}`).slice(0, 600),
            status: nextStatus,
            durationMs
          });
        }
        const followUpMsg: ChatMessageDoc = {
          messageId: makeSafeId('msg'),
          chatId: action.chatId,
          uid,
          role: 'assistant',
          content: String(data.reply || `Action ${nextStatus}.`).slice(0, 4000),
          modelId: selectedModelId,
          toolTraceSummary: `${action.toolName} · ${action.risk} · ${nextStatus} · ${durationMs}ms · ${encodeURIComponent(
            action.argsPreview
          )}`
        };
        localData.messagesByChat[action.chatId] = [
          ...(localData.messagesByChat[action.chatId] || []),
          followUpMsg
        ];
        saveLocalVault(uid, localData);
        setPendingActionsMap({ ...localData.pendingActions });
        setAuditLogs([...localData.auditLogs]);
        if (activeChatId === action.chatId) {
          setMessages([...localData.messagesByChat[action.chatId]]);
        }
        return;
      }

      if (res.status === 410) {
        await updateDoc(doc(db, 'users', uid, 'pendingActions', action.actionId), {
          status: 'expired',
          updatedAt: serverTimestamp()
        });
        setChatBannerError({
          statusCode: 410,
          category: '4xx',
          title: data.title || 'Confirmation Card Expired (410)',
          message: data.error || 'Confirmation card expired.',
          hint:
            data.hint ||
            'Click Retry Tool on the execution trace badge to re-run with the original arguments.',
          endpoint: '/api/actions/confirm',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (!res.ok) {
        setChatBannerError({
          statusCode: res.status,
          category: res.status >= 500 ? '5xx' : '4xx',
          title: data.title || `Action Confirmation Error (${res.status})`,
          message: data.error || 'Confirmation failed.',
          hint: data.hint,
          endpoint: '/api/actions/confirm',
          timestamp: new Date().toISOString()
        });
        if (data.auditEntry) {
          const errLogId = makeSafeId('log');
          await setDoc(doc(db, 'users', uid, 'auditLog', errLogId), {
            logId: errLogId,
            uid,
            chatId: action.chatId,
            toolName: action.toolName,
            risk: action.risk,
            summary: String(data.auditEntry.summary || 'Confirmation failed').slice(0, 600),
            status: 'error',
            durationMs: Number(data.auditEntry.durationMs || 0),
            createdAt: serverTimestamp()
          });
        }
        return;
      }

      const nextStatus = decision === 'approve' ? 'executed' : 'rejected';
      const durationMs = Number(data.auditEntry?.durationMs || 0);
      await updateDoc(doc(db, 'users', uid, 'pendingActions', action.actionId), {
        status: nextStatus,
        updatedAt: serverTimestamp()
      });

      if (data.auditEntry) {
        const confirmLogId = makeSafeId('log');
        await setDoc(doc(db, 'users', uid, 'auditLog', confirmLogId), {
          logId: confirmLogId,
          uid,
          chatId: action.chatId,
          toolName: action.toolName,
          risk: action.risk,
          summary: String(data.auditEntry.summary || `Action ${nextStatus}`).slice(0, 600),
          status: nextStatus,
          durationMs,
          createdAt: serverTimestamp()
        });
      }

      const followUpMsgId = makeSafeId('msg');
      await setDoc(doc(db, 'users', uid, 'chats', action.chatId, 'messages', followUpMsgId), {
        messageId: followUpMsgId,
        chatId: action.chatId,
        uid,
        role: 'assistant',
        content: String(data.reply || `Action ${nextStatus}.`).slice(0, 4000),
        modelId: selectedModelId,
        toolTraceSummary: `${action.toolName} · ${action.risk} · ${nextStatus} · ${durationMs}ms · ${encodeURIComponent(
          action.argsPreview
        )}`,
        createdAt: serverTimestamp()
      });
    } catch (err) {
      setChatBannerError({
        statusCode: 500,
        category: '5xx',
        title: 'Action Confirmation Error',
        message: err instanceof Error ? err.message : 'Failed to process confirmation.',
        endpoint: '/api/actions/confirm',
        timestamp: new Date().toISOString()
      });
    } finally {
      setConfirmingActionId(null);
    }
  };

  const handleRetryToolCall = useCallback(
    async (msg: ChatMessageDoc, item: MessageToolStatusItem) => {
      if (!user) return;
      const uid = user.uid;
      const retryKey = `${msg.messageId}:${item.toolName}`;
      setRetryingToolKey(retryKey);
      setChatBannerError(null);

      const linkedAction = msg.pendingActionId
        ? pendingActionsMap[msg.pendingActionId]
        : Object.values(pendingActionsMap).find(
            (pa) => pa.chatId === msg.chatId && pa.toolName === item.toolName
          );
      const rawArgsJson = item.argsJson || linkedAction?.argsPreview;

      try {
        const googleToken = getAccessToken();
        const firebaseIdToken = await getFirebaseIdToken();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        };
        if (googleToken) {
          headers.Authorization = `Bearer ${googleToken}`;
        }
        if (firebaseIdToken) {
          headers['X-Firebase-Id-Token'] = firebaseIdToken;
        }

        const res = await fetch('/api/tools/retry', {
          method: 'POST',
          credentials: 'same-origin',
          headers,
          body: JSON.stringify({
            uid,
            toolName: item.toolName,
            args: rawArgsJson,
            fallbackPrompt: msg.content
          })
        });

        const data = await res.json().catch(() => ({}));
        const isPausedForConfirm =
          res.ok && data.ok && data.status === 'paused_for_confirm' && data.pendingAction;
        const nextStatus = isPausedForConfirm
          ? 'paused_for_confirm'
          : res.ok && data.ok
            ? 'success'
            : 'error';
        const durationMs = Number(data.durationMs || data.auditEntry?.durationMs || 0);
        const finalArgsJson =
          typeof data.argsJson === 'string' ? data.argsJson : rawArgsJson || '{}';

        const updatedTraceLine = `${item.toolName} · ${item.risk} · ${nextStatus} · ${durationMs}ms · ${encodeURIComponent(
          finalArgsJson
        )}`;

        const existingLines = (msg.toolTraceSummary || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        let replaced = false;
        const nextLines = existingLines.map((line) => {
          const lineTool = line.split('·')[0]?.trim();
          if (lineTool === item.toolName && !replaced) {
            replaced = true;
            return updatedTraceLine;
          }
          return line;
        });
        if (!replaced) {
          nextLines.push(updatedTraceLine);
        }
        const nextTraceSummary = nextLines.join('\n');

        const nextContent =
          (nextStatus === 'success' || isPausedForConfirm) &&
          typeof data.reply === 'string' &&
          !msg.content.includes(data.reply)
            ? `${msg.content}\n\n${data.reply}`.slice(0, 15000)
            : msg.content;

        const newPendingActionId = isPausedForConfirm
          ? String(data.pendingAction.actionId)
          : msg.pendingActionId;

        if (isPausedForConfirm) {
          const pa = data.pendingAction;
          setPendingActionsMap((prev) => ({
            ...prev,
            [pa.actionId]: {
              actionId: pa.actionId,
              uid,
              chatId: msg.chatId,
              toolName: pa.toolName,
              risk: pa.risk,
              argsPreview: pa.argsPreview,
              argsHash: pa.argsHash,
              serverSignature: pa.serverSignature,
              warningText: pa.warningText,
              status: 'pending',
              expiresAtMs: pa.expiresAtMs
            }
          }));
        } else if (linkedAction && nextStatus === 'success') {
          setPendingActionsMap((prev) => ({
            ...prev,
            [linkedAction.actionId]: {
              ...linkedAction,
              status: 'executed'
            }
          }));
        }

        setMessages((prev) =>
          prev.map((m) =>
            m.messageId === msg.messageId
              ? {
                  ...m,
                  content: nextContent,
                  toolTraceSummary: nextTraceSummary,
                  ...(newPendingActionId ? { pendingActionId: newPendingActionId } : {})
                }
              : m
          )
        );

        const localData = loadLocalVault(user);
        const chatMsgs = localData.messagesByChat[msg.chatId] || [];
        localData.messagesByChat[msg.chatId] = chatMsgs.map((m) =>
          m.messageId === msg.messageId
            ? {
                ...m,
                content: nextContent,
                toolTraceSummary: nextTraceSummary,
                ...(newPendingActionId ? { pendingActionId: newPendingActionId } : {})
              }
            : m
        );
        if (isPausedForConfirm) {
          const pa = data.pendingAction;
          localData.pendingActions[pa.actionId] = {
            actionId: pa.actionId,
            uid,
            chatId: msg.chatId,
            toolName: pa.toolName,
            risk: pa.risk,
            argsPreview: pa.argsPreview,
            argsHash: pa.argsHash,
            serverSignature: pa.serverSignature,
            warningText: pa.warningText,
            status: 'pending',
            expiresAtMs: pa.expiresAtMs
          };
        } else if (
          linkedAction &&
          nextStatus === 'success' &&
          localData.pendingActions[linkedAction.actionId]
        ) {
          localData.pendingActions[linkedAction.actionId].status = 'executed';
        }
        if (data.auditEntry) {
          localData.auditLogs.unshift({
            logId: makeSafeId('log'),
            uid,
            chatId: msg.chatId,
            toolName: item.toolName,
            risk: (item.risk as 'read' | 'write' | 'destructive') || 'read',
            summary: String(data.auditEntry.summary || `Retried ${item.toolName}`).slice(0, 600),
            status: nextStatus,
            durationMs
          });
        }
        saveLocalVault(uid, localData);
        if (user.isServerSession) {
          setAuditLogs([...localData.auditLogs]);
        } else {
          try {
            if (isPausedForConfirm) {
              const pa = data.pendingAction;
              await setDoc(doc(db, 'users', uid, 'pendingActions', pa.actionId), {
                actionId: pa.actionId,
                uid,
                chatId: msg.chatId,
                toolName: pa.toolName,
                risk: pa.risk,
                argsPreview: pa.argsPreview,
                argsHash: pa.argsHash,
                serverSignature: pa.serverSignature,
                warningText: pa.warningText,
                status: 'pending',
                expiresAtMs: pa.expiresAtMs,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
              });
            } else if (linkedAction && nextStatus === 'success') {
              await updateDoc(doc(db, 'users', uid, 'pendingActions', linkedAction.actionId), {
                status: 'executed',
                updatedAt: serverTimestamp()
              });
            }
            if (data.auditEntry) {
              const retryLogId = makeSafeId('log');
              await setDoc(doc(db, 'users', uid, 'auditLog', retryLogId), {
                logId: retryLogId,
                uid,
                chatId: msg.chatId,
                toolName: item.toolName,
                risk: item.risk || 'read',
                summary: String(data.auditEntry.summary || `Retried ${item.toolName}`).slice(0, 600),
                status: nextStatus,
                durationMs,
                createdAt: serverTimestamp()
              });
            }
          } catch {
            void 0;
          }
        }

        if (!res.ok || !data.ok) {
          setChatBannerError({
            statusCode: res.status || 502,
            category: res.status >= 500 ? '5xx' : '4xx',
            title: data.title || `Tool Retry Failed (${item.toolName})`,
            message: data.error || `Failed to retry ${item.toolName}.`,
            hint:
              data.hint ||
              'Check that the required connector is enabled in Connectors and try again.',
            endpoint: '/api/tools/retry',
            timestamp: new Date().toISOString()
          });
        }
      } catch (err) {
        setChatBannerError({
          statusCode: 500,
          category: '5xx',
          title: `Tool Retry Error (${item.toolName})`,
          message: err instanceof Error ? err.message : 'Failed to retry tool call.',
          endpoint: '/api/tools/retry',
          timestamp: new Date().toISOString()
        });
      } finally {
        setRetryingToolKey(null);
      }
    },
    [pendingActionsMap, user]
  );

  const handleUpdateUsername = async (nextUsername: string) => {
    if (!user) return;
    const cleanName = nextUsername.trim().slice(0, 80);
    if (!cleanName) {
      throw new Error('Username cannot be empty.');
    }

    const uid = user.uid;
    await updateWorkspaceUsername(cleanName);

    const localData = loadLocalVault(user);
    localData.profile = {
      ...localData.profile,
      displayName: cleanName
    };
    saveLocalVault(uid, localData);

    setUser((prev) => (prev ? { ...prev, displayName: cleanName } : prev));
    setProfile((prev) => (prev ? { ...prev, displayName: cleanName } : localData.profile));

    if (!user.isServerSession) {
      try {
        await updateDoc(doc(db, 'users', uid), {
          displayName: cleanName,
          updatedAt: serverTimestamp()
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${uid}`);
      }
    }
  };

  const handleClearAllConversations = async () => {
    if (!user) return;
    const uid = user.uid;

    const localData = loadLocalVault(user);
    localData.chats = [];
    localData.messagesByChat = {};
    saveLocalVault(uid, localData);

    if (!user.isServerSession) {
      try {
        const chatIdsToDelete = new Set<string>(chats.map((c) => c.chatId));
        const chatsSnap = await getDocs(
          query(collection(db, 'users', uid, 'chats'), where('uid', '==', uid))
        );
        for (const chatDoc of chatsSnap.docs) {
          chatIdsToDelete.add(chatDoc.id);
        }

        for (const chatId of chatIdsToDelete) {
          const msgSnap = await getDocs(
            query(
              collection(db, 'users', uid, 'chats', chatId, 'messages'),
              where('uid', '==', uid)
            )
          );
          for (const msgDoc of msgSnap.docs) {
            await deleteDoc(msgDoc.ref);
          }
          await deleteDoc(doc(db, 'users', uid, 'chats', chatId));
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `users/${uid}/chats`);
      }
    }

    setChats([]);
    setMessages([]);
    setActiveChatId(null);
    setChatBannerError(null);
    setLastFailedPrompt(null);
  };

  const handleDeleteAllUserData = async () => {
    if (!user) return;
    const uid = user.uid;

    try {
      const idToken = await getFirebaseIdToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (idToken) {
        headers['X-Firebase-Id-Token'] = idToken;
      }
      const resetRes = await fetch('/api/quota/reset', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({ uid })
      });
      if (resetRes.ok) {
        const resetData = await resetRes.json().catch(() => ({}));
        if (Array.isArray(resetData.models)) {
          setModels(resetData.models);
        }
      }
    } catch {
      void 0;
    }

    if (user.isServerSession) {
      localStorage.removeItem(`vektor_local_vault_${uid}`);
      const fresh = loadLocalVault(user);
      setProfile(fresh.profile);
      setChats([]);
      setMessages([]);
      setPendingActionsMap({});
      setAuditLogs([]);
      await revokeGoogleAccessAndDisconnect();
      setHasGoogleToken(false);
      setConnectedProviders(DEFAULT_LOCAL_CONNECTORS);
      setActiveChatId(null);
      setActiveTab('workspace');
      return;
    }

    try {
      localStorage.removeItem(`vektor_local_vault_${uid}`);
      for (const c of chats) {
        const msgSnap = await getDocs(
          query(
            collection(db, 'users', uid, 'chats', c.chatId, 'messages'),
            where('uid', '==', uid)
          )
        );
        for (const m of msgSnap.docs) {
          await deleteDoc(m.ref);
        }
        await deleteDoc(doc(db, 'users', uid, 'chats', c.chatId));
      }

      const pendingSnap = await getDocs(
        query(collection(db, 'users', uid, 'pendingActions'), where('uid', '==', uid))
      );
      for (const p of pendingSnap.docs) {
        await deleteDoc(p.ref);
      }

      const auditSnap = await getDocs(
        query(collection(db, 'users', uid, 'auditLog'), where('uid', '==', uid))
      );
      for (const a of auditSnap.docs) {
        await deleteDoc(a.ref);
      }

      await updateDoc(doc(db, 'users', uid), {
        dailyRequestsCount: 0,
        dailyTokensUsed: 0,
        lastResetDate: getTodayUtcString(),
        updatedAt: serverTimestamp()
      });

      await revokeGoogleAccessAndDisconnect();
      setHasGoogleToken(false);
      setConnectedProviders(DEFAULT_LOCAL_CONNECTORS);
      setActiveChatId(null);
      setActiveTab('workspace');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `users/${uid}`);
    }
  };

  const activeModelObj = models.find((m) => m.id === selectedModelId) || models[0];
  const pwStrength = computePasswordStrength(passwordInput);
  const activeChatObj = chats.find((c) => c.chatId === activeChatId) || null;

  const handleShareCurrentSession = useCallback(async () => {
    if (!user) return;
    setIsCreatingShare(true);

    const targetChatId = activeChatId || `chat_${user.uid.slice(0, 10)}`;
    const deterministicShareId = `shr_${targetChatId.replace(/[^a-zA-Z0-9]/g, '').slice(-16)}`;
    const sessionTitle =
      activeChatObj?.title ||
      (messages[0]?.content ? messages[0].content.slice(0, 64) : 'Shared Pryzmium Session');
    const modelLabel =
      models.find((m) => m.id === selectedModelId)?.label ||
      activeModelObj?.label ||
      'Pryzmium';
    const authorName =
      (profile?.displayName || user.displayName || user.email?.split('@')[0] || 'Workspace Operator')
        .trim()
        .slice(0, 80);

    const sanitizedMessages: SharedChatMessageItem[] = messages.map((m) => ({
      messageId: m.messageId,
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.role === 'assistant' ? sanitizeAssistantOutput(m.content) : m.content,
      modelId: m.modelId,
      ...(m.toolTraceSummary ? { toolTraceSummary: m.toolTraceSummary } : {})
    }));

    const nowIso = new Date().toISOString();
    const localSnapshot: SharedChatSnapshot = {
      shareId: deterministicShareId,
      chatId: targetChatId,
      title: sessionTitle,
      modelId: selectedModelId,
      modelLabel,
      authorName,
      createdAt: nowIso,
      updatedAt: nowIso,
      messages: sanitizedMessages
    };

    let finalShareId = deterministicShareId;

    try {
      const idToken = await getFirebaseIdToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (idToken) {
        headers['X-Firebase-Id-Token'] = idToken;
      }
      const res = await fetch('/api/shares', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({
          shareId: deterministicShareId,
          chatId: targetChatId,
          title: sessionTitle,
          modelId: selectedModelId,
          modelLabel,
          authorName,
          messages: sanitizedMessages
        })
      });
      if (res.ok) {
        const data = (await res.json()) as { shareId?: string; share?: SharedChatSnapshot };
        if (data.shareId) {
          finalShareId = data.shareId;
        }
        if (data.share) {
          saveLocalSharedSnapshot(data.share);
          setSharedSnapshot(data.share);
        } else {
          saveLocalSharedSnapshot(localSnapshot);
        }
      } else {
        saveLocalSharedSnapshot(localSnapshot);
      }
    } catch {
      saveLocalSharedSnapshot(localSnapshot);
    } finally {
      setIsCreatingShare(false);
    }

    const generatedUrl = `${window.location.origin}${window.location.pathname}?share=${encodeURIComponent(
      finalShareId
    )}`;
    setActiveShareId(finalShareId);
    setShareUrl(generatedUrl);
    setShareModalOpen(true);
    void handleCopyText('share-session-url', generatedUrl);
  }, [
    activeChatId,
    activeChatObj?.title,
    activeModelObj?.label,
    handleCopyText,
    messages,
    models,
    profile?.displayName,
    selectedModelId,
    user
  ]);

  const handleExitSharedView = useCallback(() => {
    setSharedViewId(null);
    setSharedSnapshot(null);
    setSharedError(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('share');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      return;
    }
  }, []);

  useEffect(() => {
    if (!user || needsConsentGate || sharedViewId) return;

    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const isMod = event.ctrlKey || event.metaKey;

      if (event.key === 'Escape') {
        if (shortcutsModalOpen) {
          event.preventDefault();
          setShortcutsModalOpen(false);
          return;
        }
        if (shareModalOpen) {
          event.preventDefault();
          setShareModalOpen(false);
          return;
        }
        if (isRunningAgent) {
          event.preventDefault();
          handleStopStream();
          return;
        }
      }

      if (isMod && (event.key === '/' || event.code === 'Slash')) {
        event.preventDefault();
        setShortcutsModalOpen((prev) => !prev);
        return;
      }

      if (activeTab !== 'workspace') return;

      if (isMod && event.key.toLowerCase() === 'k' && !event.shiftKey) {
        event.preventDefault();
        setPromptInput('');
        setSpeechError(null);
        promptInputRef.current?.focus();
        return;
      }

      if (isMod && event.key === 'Enter') {
        if (promptInput.trim() && !isRunningAgent) {
          event.preventDefault();
          void handleSendMessage();
        }
        return;
      }

      if (isMod && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void handleCreateNewSession();
        return;
      }

      if (isMod && event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleShareCurrentSession();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [
    activeTab,
    handleShareCurrentSession,
    isRunningAgent,
    needsConsentGate,
    promptInput,
    shareModalOpen,
    sharedViewId,
    shortcutsModalOpen,
    user
  ]);

  if (sharedViewId) {
    return (
      <div className="min-h-[100dvh] theme-canvas flex flex-col overflow-x-hidden">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b theme-border theme-surface px-4 sm:px-6 py-3.5">
          <div className="flex items-center gap-3 min-w-0">
            <PryzmiumLogo />
            <span
              className="rounded-md border theme-border theme-elevated px-2.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap shrink-0"
              style={{ color: 'var(--accent-primary)' }}
            >
              Read-Only Shared Session
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() =>
                handleCopyText(
                  'shared-header-link',
                  `${window.location.origin}${window.location.pathname}?share=${encodeURIComponent(
                    sharedViewId
                  )}`
                )
              }
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border theme-border theme-elevated px-3.5 text-xs font-medium theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
            >
              {copiedKey === 'shared-header-link' ? (
                <>
                  <Check className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--status-read)' }} />
                  <span>Link Copied</span>
                </>
              ) : (
                <>
                  <Link2 className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                  <span>Copy Public URL</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleExitSharedView}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl theme-btn-primary px-4 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
            >
              <span>{user ? 'Return to Workspace' : 'Open Pryzmium Workspace'}</span>
              <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-6 py-8">
          <div className="mx-auto max-w-3xl space-y-6">
            {sharedLoading ? (
              <section className="rounded-2xl border theme-border theme-elevated p-8 text-center space-y-3">
                <Loader2
                  className="h-5 w-5 animate-spin mx-auto"
                  style={{ color: 'var(--accent-primary)' }}
                />
                <p className="font-mono text-xs theme-text-secondary">
                  Loading shared conversation snapshot…
                </p>
              </section>
            ) : sharedError || !sharedSnapshot ? (
              <section className="rounded-2xl border theme-border theme-elevated p-8 space-y-4">
                <div className="flex items-start gap-3">
                  <AlertCircle
                    className="h-5 w-5 shrink-0 mt-0.5"
                    style={{ color: 'var(--status-destructive)' }}
                  />
                  <div className="space-y-1">
                    <h1 className="font-display text-lg font-semibold theme-text-primary">
                      Shared Conversation Unavailable
                    </h1>
                    <p className="text-xs theme-text-secondary leading-relaxed">
                      {sharedError || 'This shared session link could not be found.'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleExitSharedView}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl theme-btn-primary px-4 text-xs font-semibold"
                >
                  <span>Go to Pryzmium Workspace</span>
                </button>
              </section>
            ) : (
              <>
                <section className="rounded-2xl border theme-border theme-elevated p-6 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono theme-text-muted tabular-nums">
                    <span>Shared by {sharedSnapshot.authorName}</span>
                    <span>
                      {sharedSnapshot.modelLabel} · {sharedSnapshot.messages.length}{' '}
                      {sharedSnapshot.messages.length === 1 ? 'message' : 'messages'}
                    </span>
                  </div>
                  <h1 className="font-display text-xl sm:text-2xl font-semibold theme-text-primary">
                    {sharedSnapshot.title}
                  </h1>
                  <p className="text-xs theme-text-secondary">
                    Public read-only snapshot · Updated{' '}
                    {new Date(sharedSnapshot.updatedAt).toLocaleString()}
                  </p>
                </section>

                {sharedSnapshot.messages.length === 0 ? (
                  <section className="rounded-2xl border theme-border theme-surface p-6 text-xs theme-text-secondary">
                    This shared session does not contain any messages yet.
                  </section>
                ) : (
                  <div className="space-y-4">
                    {sharedSnapshot.messages.map((msg) => {
                      const cleaned =
                        msg.role === 'assistant'
                          ? sanitizeAssistantOutput(msg.content)
                          : msg.content;
                      const parsedSegments = parseMessageSegments(cleaned);
                      const codeBlocks = parsedSegments.filter(
                        (seg): seg is ParsedCodeSegment => seg.type === 'code'
                      );
                      const allCodeOnly = codeBlocks.map((b) => b.code).join('\n\n');
                      const msgCopyKey = `shared-msg-${msg.messageId}`;
                      const codeCopyKey = `shared-code-${msg.messageId}`;
                      const msgModelLabel =
                        models.find((m) => m.id === msg.modelId)?.label ||
                        sharedSnapshot.modelLabel ||
                        'Pryzmium';

                      return (
                        <article
                          key={msg.messageId}
                          className={`rounded-2xl border theme-border p-5 space-y-3 ${
                            msg.role === 'user' ? 'theme-elevated' : 'theme-surface'
                          }`}
                        >
                          <header className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono theme-text-muted">
                            <span className="uppercase tracking-wider font-semibold theme-text-primary">
                              {msg.role === 'user' ? sharedSnapshot.authorName : 'Pryzmium'}
                            </span>
                            <span>{msgModelLabel}</span>
                          </header>

                          <div className="text-sm leading-relaxed">
                            {renderStructuredMessageContent({
                              messageId: msg.messageId,
                              segments: parsedSegments,
                              copiedKey,
                              onCopy: handleCopyText
                            })}
                          </div>

                          <footer className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t theme-border text-xs font-mono">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleCopyText(msgCopyKey, cleaned)}
                                className="inline-flex items-center gap-1.5 rounded-lg border theme-border theme-canvas px-2.5 py-1 text-[11px] font-medium theme-text-secondary hover:opacity-90 transition-opacity"
                              >
                                {copiedKey === msgCopyKey ? (
                                  <>
                                    <Check
                                      className="h-3.5 w-3.5"
                                      style={{ color: 'var(--status-read)' }}
                                    />
                                    <span style={{ color: 'var(--status-read)' }}>
                                      Copied Message
                                    </span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-3.5 w-3.5" />
                                    <span>Copy Message</span>
                                  </>
                                )}
                              </button>

                              {codeBlocks.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => handleCopyText(codeCopyKey, allCodeOnly)}
                                  className="inline-flex items-center gap-1.5 rounded-lg border theme-border theme-canvas px-2.5 py-1 text-[11px] font-medium theme-text-secondary hover:opacity-90 transition-opacity"
                                >
                                  {copiedKey === codeCopyKey ? (
                                    <>
                                      <Check
                                        className="h-3.5 w-3.5"
                                        style={{ color: 'var(--status-read)' }}
                                      />
                                      <span style={{ color: 'var(--status-read)' }}>
                                        Copied Code Only
                                      </span>
                                    </>
                                  ) : (
                                    <>
                                      <Code2
                                        className="h-3.5 w-3.5"
                                        style={{ color: 'var(--accent-primary)' }}
                                      />
                                      <span>Copy Code Only</span>
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                            <span className="text-[11px] theme-text-muted tabular-nums">
                              {cleaned.length} chars
                            </span>
                          </footer>
                        </article>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </main>
      </div>
    );
  }

  if (!authInitialized) {
    return (
      <div className="min-h-[100dvh] theme-canvas flex items-center justify-center p-6 overflow-x-hidden">
        <p className="font-mono text-xs theme-text-secondary">
          Initializing Pryzmium Workspace…
        </p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-[100dvh] w-full theme-canvas flex flex-col justify-between p-4 sm:p-6 overflow-y-auto overflow-x-hidden">
        <LegalSecurityModal
          open={authPolicyModalOpen}
          mode="consent"
          initialTab={authPolicyInitialTab}
          accountLabel={displayNameInput || emailInput || undefined}
          onAcceptAll={() => {
            setAcceptedAuthPolicy(true);
            setAuthPolicyModalOpen(false);
            setAuthError(null);
          }}
          onClose={() => setAuthPolicyModalOpen(false)}
          onDeclineAndSignOut={() => {
            setAcceptedAuthPolicy(false);
            setAuthPolicyModalOpen(false);
          }}
        />

        <header className="relative z-10 w-full max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-2 pb-4 border-b theme-border">
          <PryzmiumLogo />
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] theme-text-muted">
              One-Time Mandatory Compliance Onboarding
            </span>
            <button
              type="button"
              onClick={() => openLegalHub('privacy')}
              className="inline-flex items-center gap-1.5 rounded-lg border theme-border theme-surface px-2.5 py-1 text-[11px] font-medium theme-text-primary hover:opacity-85 transition-opacity"
            >
              <ShieldCheck
                className="h-3.5 w-3.5 shrink-0"
                style={{ color: 'var(--accent-primary)' }}
              />
              <span>Legal Center</span>
            </button>
          </div>
        </header>

        <main className="relative z-10 w-full flex-1 flex items-center justify-center py-6">
          <section
            aria-labelledby="auth-heading"
            className="w-full max-w-md mx-auto my-auto theme-elevated border theme-border rounded-2xl p-5 sm:p-8 flex flex-col gap-5 shadow-xs animate-view-enter"
          >
            <header className="space-y-1.5">
              <h1
                id="auth-heading"
                className="font-display text-2xl sm:text-3xl font-bold tracking-tight theme-text-primary"
              >
                {authMode === 'signin' ? 'Sign in to Pryzmium' : 'Create your account'}
              </h1>
              <p className="text-xs theme-text-secondary">
                {authMode === 'signin'
                  ? 'Continue with Google or enter your account credentials.'
                  : 'Register a workspace account with email and password.'}
              </p>
            </header>

            <div
              role="tablist"
              aria-label="Authentication mode"
              className="grid grid-cols-2 gap-1 rounded-xl border theme-border theme-surface p-1"
            >
              <button
                type="button"
                role="tab"
                aria-selected={authMode === 'signin'}
                onClick={() => {
                  setAuthMode('signin');
                  setAuthError(null);
                }}
                className={`h-11 rounded-lg text-xs font-medium transition-colors ${
                  authMode === 'signin'
                    ? 'theme-btn-primary font-semibold'
                    : 'theme-text-secondary hover:opacity-85'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={authMode === 'signup'}
                onClick={() => {
                  setAuthMode('signup');
                  setAuthError(null);
                }}
                className={`h-11 rounded-lg text-xs font-medium transition-colors ${
                  authMode === 'signup'
                    ? 'theme-btn-primary font-semibold'
                    : 'theme-text-secondary hover:opacity-85'
                }`}
              >
                Create Account
              </button>
            </div>

            <div className="rounded-xl border theme-border theme-surface p-3.5 space-y-2.5 text-xs theme-text-primary">
              <label className="flex items-start gap-2.5 cursor-pointer select-none theme-text-primary">
                <input
                  type="checkbox"
                  checked={acceptedAuthPolicy}
                  onChange={(e) => {
                    setAcceptedAuthPolicy(e.target.checked);
                    if (e.target.checked) setAuthError(null);
                  }}
                  className="mt-0.5 h-4 w-4 rounded shrink-0"
                  style={{ accentColor: 'var(--accent-primary)' }}
                />
                <span className="leading-relaxed theme-text-secondary">
                  I accept the mandatory{' '}
                  <strong className="font-semibold theme-text-primary">
                    Privacy Policy, Cookie Policy &amp; Terms of User Agreement
                  </strong>{' '}
                  required by international data protection regulations before using the web app.
                </span>
              </label>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t theme-border">
                <span className="text-[11px] font-mono theme-text-muted">
                  One-time onboarding consent
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setAuthPolicyInitialTab('privacy');
                    setAuthPolicyModalOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold underline underline-offset-2 hover:opacity-80"
                  style={{ color: 'var(--accent-primary)' }}
                >
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                  <span>Read Full Policy &amp; Agreement</span>
                </button>
              </div>
            </div>

            {authError && (
              <div
                role="alert"
                className="rounded-xl border theme-border theme-surface px-3.5 py-2.5 text-xs theme-text-primary flex items-start gap-2"
              >
                <AlertCircle
                  className="h-4 w-4 shrink-0 mt-0.5"
                  style={{ color: 'var(--status-destructive)' }}
                />
                <span>{authError}</span>
              </div>
            )}

            <div className="space-y-2">
              <button
                type="button"
                disabled={isSigningIn || !signInLimitStatus.allowed}
                onClick={handleGoogleBasicLogin}
                className="w-full h-12 inline-flex items-center justify-center gap-2.5 rounded-xl border theme-border theme-surface px-4 text-xs font-semibold theme-text-primary hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                <svg
                  version="1.1"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 48 48"
                  className="h-4 w-4 shrink-0"
                  aria-hidden="true"
                >
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                </svg>
                <span>{isSigningIn ? 'Signing in…' : 'Continue with Google'}</span>
              </button>
            </div>

            <div className="flex items-center gap-3 text-[11px] font-mono theme-text-muted">
              <div className="flex-1 border-t theme-border" />
              <span>OR EMAIL</span>
              <div className="flex-1 border-t theme-border" />
            </div>

            <form onSubmit={handleEmailAuthSubmit} className="flex flex-col gap-3.5">
              {authMode === 'signup' && (
                <div>
                  <label
                    htmlFor="auth-display-name"
                    className="block text-xs font-medium theme-text-secondary mb-1"
                  >
                    Display Name
                  </label>
                  <input
                    id="auth-display-name"
                    type="text"
                    required
                    autoComplete="name"
                    enterKeyHint="next"
                    value={displayNameInput}
                    onChange={(e) => setDisplayNameInput(e.target.value)}
                    placeholder="Your name"
                    maxLength={80}
                    className="h-12 w-full rounded-xl border theme-border theme-canvas px-3.5 text-base md:text-xs theme-text-primary placeholder:opacity-50 focus:outline-none"
                  />
                </div>
              )}

              <div>
                <label
                  htmlFor="auth-email"
                  className="block text-xs font-medium theme-text-secondary mb-1"
                >
                  Email Address
                </label>
                <input
                  id="auth-email"
                  type="email"
                  inputMode="email"
                  required
                  autoComplete="email"
                  enterKeyHint="next"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="you@example.com"
                  className="h-12 w-full rounded-xl border theme-border theme-canvas px-3.5 text-base md:text-xs theme-text-primary placeholder:opacity-50 focus:outline-none"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="auth-password"
                    className="text-xs font-medium theme-text-secondary"
                  >
                    Password
                  </label>
                  {authMode === 'signup' && passwordInput && (
                    <span className="font-mono text-[10px] theme-text-muted">
                      {pwStrength.label}
                    </span>
                  )}
                </div>
                <div className="flex items-center h-12 w-full rounded-xl border theme-border theme-canvas overflow-hidden">
                  <input
                    id="auth-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={6}
                    autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'}
                    enterKeyHint={authMode === 'signin' ? 'go' : 'next'}
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    placeholder="Minimum 6 characters"
                    className="flex-1 h-full min-w-0 bg-transparent px-3.5 text-base md:text-xs theme-text-primary placeholder:opacity-50 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="inline-flex min-w-[44px] min-h-[44px] items-center justify-center theme-text-muted hover:opacity-80 shrink-0"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>

                {authMode === 'signup' && (
                  <div className="grid grid-cols-4 gap-1.5 mt-1.5">
                    {[1, 2, 3, 4].map((bar) => (
                      <div
                        key={bar}
                        className="h-1 rounded-full transition-colors"
                        style={{
                          backgroundColor:
                            pwStrength.score >= bar
                              ? pwStrength.score >= 3
                                ? 'var(--status-read)'
                                : 'var(--status-write)'
                              : 'var(--border-hairline)'
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>

              {authMode === 'signup' && (
                <div>
                  <label
                    htmlFor="auth-confirm-password"
                    className="block text-xs font-medium theme-text-secondary mb-1"
                  >
                    Confirm Password
                  </label>
                  <input
                    id="auth-confirm-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={6}
                    autoComplete="new-password"
                    enterKeyHint="go"
                    value={confirmPasswordInput}
                    onChange={(e) => setConfirmPasswordInput(e.target.value)}
                    placeholder="Re-enter password"
                    className="h-12 w-full rounded-xl border theme-border theme-canvas px-3.5 text-base md:text-xs theme-text-primary placeholder:opacity-50 focus:outline-none"
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={isSigningIn || !signInLimitStatus.allowed}
                className="w-full h-12 inline-flex items-center justify-center gap-2 rounded-xl theme-btn-primary px-4 text-xs font-semibold transition-colors disabled:opacity-50"
              >
                {isSigningIn ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : authMode === 'signin' ? (
                  <Mail className="h-4 w-4" />
                ) : (
                  <UserPlus className="h-4 w-4" />
                )}
                <span>
                  {isSigningIn
                    ? 'Signing in…'
                    : authMode === 'signin'
                      ? 'Sign In'
                      : 'Create Account'}
                </span>
              </button>

              <div className="rounded-xl border theme-border theme-surface px-3.5 py-3 text-xs theme-text-secondary text-center leading-relaxed">
                <span>By signing in, you agree to our</span>{' '}
                <button
                  type="button"
                  onClick={() => openLegalHub('terms')}
                  className="underline font-medium theme-text-primary hover:opacity-80 p-1"
                >
                  Terms of Service
                </button>
                ,{' '}
                <button
                  type="button"
                  onClick={() => openLegalHub('privacy')}
                  className="underline font-medium theme-text-primary hover:opacity-80 p-1"
                >
                  Privacy Policy
                </button>
                , and{' '}
                <button
                  type="button"
                  onClick={() => openLegalHub('safety')}
                  className="underline font-medium theme-text-primary hover:opacity-80 p-1"
                >
                  Safety Rules
                </button>
                .
              </div>
            </form>
          </section>
        </main>

        <CookieConsentBanner hidden={isLegalHubOpen || authPolicyModalOpen} />
        {isLegalHubOpen && <LegalHub onBackToApp={closeLegalHub} />}
      </div>
    );
  }

  if (needsConsentGate) {
    return (
      <div className="min-h-[100dvh] theme-canvas flex items-center justify-center p-6 overflow-x-hidden">
        <LegalSecurityModal
          open={true}
          accountLabel={profile?.displayName || user.displayName || user.email || undefined}
          onAcceptAll={() => {
            recordLegalConsentAccepted(user.uid, user.email);
            setNeedsConsentGate(false);
          }}
          onDeclineAndSignOut={() => {
            void logoutUser();
          }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] theme-canvas flex flex-col overflow-x-hidden">
      {shortcutsModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          style={{ backgroundColor: 'rgba(12, 12, 14, 0.72)', backdropFilter: 'blur(6px)' }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="keyboard-shortcuts-title"
          onClick={() => setShortcutsModalOpen(false)}
        >
          <article
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-t-2xl sm:rounded-2xl border theme-border theme-surface shadow-2xl overflow-hidden max-h-[85dvh] overflow-y-auto animate-modal-panel pb-[env(safe-area-inset-bottom)] sm:pb-0"
          >
            <div className="sm:hidden pt-3 pb-1 theme-elevated">
              <div className="w-10 h-1.5 rounded-full mx-auto" style={{ backgroundColor: 'var(--border-strong)' }} />
            </div>

            <header className="flex items-center justify-between gap-4 border-b theme-border theme-elevated px-4 sm:px-6 py-4">
              <div className="flex items-center gap-2.5">
                <Keyboard className="h-4 w-4 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                <div>
                  <h2
                    id="keyboard-shortcuts-title"
                    className="font-display text-base font-semibold theme-text-primary"
                  >
                    Workspace Keyboard Shortcuts
                  </h2>
                  <p className="text-xs theme-text-secondary">
                    Navigate and control Pryzmium without leaving the keyboard
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShortcutsModalOpen(false)}
                aria-label="Close keyboard shortcuts help"
                className="inline-flex min-h-[40px] min-w-[40px] sm:min-h-0 sm:min-w-0 items-center justify-center rounded-lg border theme-border theme-surface p-1.5 theme-text-secondary hover:opacity-80"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <section className="p-4 sm:p-6 space-y-2.5 text-xs">
              {[
                { keys: ['Ctrl', 'Enter'], description: 'Send current chat prompt' },
                { keys: ['Ctrl', 'K'], description: 'Clear chat input and focus prompt box' },
                { keys: ['Ctrl', '/'], description: 'Open or close Keyboard Shortcuts Help' },
                { keys: ['Ctrl', 'Shift', 'O'], description: 'Create a new chat session' },
                { keys: ['Ctrl', 'Shift', 'S'], description: 'Share read-only public session URL' },
                { keys: ['Esc'], description: 'Close active modal or stop agent loop' }
              ].map((item) => (
                <div
                  key={item.description}
                  className="flex items-center justify-between gap-4 rounded-xl border theme-border theme-canvas px-4 py-2.5"
                >
                  <span className="theme-text-primary font-medium">{item.description}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    {item.keys.map((k) => (
                      <kbd
                        key={k}
                        className="rounded-md border theme-border theme-elevated px-2 py-1 font-mono text-[11px] font-semibold theme-text-primary"
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                </div>
              ))}
            </section>

            <footer className="flex items-center justify-between border-t theme-border theme-elevated px-4 sm:px-6 py-3.5 text-xs">
              <span className="font-mono text-[11px] theme-text-muted">
                macOS users can also use Cmd (⌘) in place of Ctrl
              </span>
              <button
                type="button"
                onClick={() => setShortcutsModalOpen(false)}
                className="inline-flex h-11 sm:h-8 items-center justify-center rounded-xl theme-btn-primary px-4 text-xs font-semibold"
              >
                Done
              </button>
            </footer>
          </article>
        </div>
      )}

      {shareModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          style={{ backgroundColor: 'rgba(12, 12, 14, 0.72)', backdropFilter: 'blur(6px)' }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="share-session-title"
          onClick={() => setShareModalOpen(false)}
        >
          <article
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-t-2xl sm:rounded-2xl border theme-border theme-surface shadow-2xl overflow-hidden max-h-[85dvh] overflow-y-auto animate-modal-panel pb-[env(safe-area-inset-bottom)] sm:pb-0"
          >
            <div className="sm:hidden pt-3 pb-1 theme-elevated">
              <div className="w-10 h-1.5 rounded-full mx-auto" style={{ backgroundColor: 'var(--border-strong)' }} />
            </div>

            <header className="flex items-center justify-between gap-4 border-b theme-border theme-elevated px-4 sm:px-6 py-4">
              <div className="flex items-center gap-2.5">
                <Share2 className="h-4 w-4 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                <div>
                  <h2
                    id="share-session-title"
                    className="font-display text-base font-semibold theme-text-primary"
                  >
                    Share Read-Only Chat Session
                  </h2>
                  <p className="text-xs theme-text-secondary">
                    Anyone with this unique public URL can view a read-only snapshot of this conversation
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShareModalOpen(false)}
                aria-label="Close share session modal"
                className="inline-flex min-h-[40px] min-w-[40px] sm:min-h-0 sm:min-w-0 items-center justify-center rounded-lg border theme-border theme-surface p-1.5 theme-text-secondary hover:opacity-80"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <section className="p-4 sm:p-6 space-y-4 text-xs">
              <div className="rounded-xl border theme-border theme-canvas p-3.5 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display font-semibold theme-text-primary truncate">
                    {activeChatObj?.title ||
                      (messages[0]?.content
                        ? messages[0].content.slice(0, 64)
                        : 'Current Agent Session')}
                  </span>
                  <span className="font-mono text-[11px] theme-text-muted tabular-nums shrink-0">
                    {messages.length} {messages.length === 1 ? 'message' : 'messages'}
                  </span>
                </div>
                <p className="text-[11px] theme-text-secondary">
                  Credentials, OAuth tokens, and write-action approvals are stripped from public shared snapshots.
                </p>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="public-share-url-input"
                  className="block font-mono text-[11px] uppercase tracking-wider theme-text-secondary"
                >
                  Unique Public Read-Only URL
                </label>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <input
                    id="public-share-url-input"
                    type="text"
                    readOnly
                    value={shareUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="h-12 sm:h-10 flex-1 rounded-xl border theme-border theme-canvas px-3.5 font-mono text-base md:text-xs theme-text-primary focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => handleCopyText('share-session-url', shareUrl)}
                    className="inline-flex h-12 sm:h-10 items-center justify-center gap-1.5 rounded-xl theme-btn-primary px-4 text-xs font-semibold whitespace-nowrap shrink-0"
                  >
                    {copiedKey === 'share-session-url' ? (
                      <>
                        <Check className="h-3.5 w-3.5 shrink-0" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5 shrink-0" />
                        <span>Copy URL</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </section>

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t theme-border theme-elevated px-4 sm:px-6 py-3.5 text-xs">
              <button
                type="button"
                onClick={() => {
                  if (activeShareId) {
                    setShareModalOpen(false);
                    setSharedViewId(activeShareId);
                    try {
                      const url = new URL(window.location.href);
                      url.searchParams.set('share', activeShareId);
                      window.history.replaceState({}, '', `${url.pathname}${url.search}`);
                    } catch {
                      return;
                    }
                  }
                }}
                className="inline-flex h-11 sm:h-9 items-center justify-center gap-1.5 rounded-xl border theme-border theme-surface px-3.5 text-xs font-medium theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
              >
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                <span>Preview Read-Only View</span>
              </button>

              <button
                type="button"
                onClick={() => setShareModalOpen(false)}
                className="inline-flex h-11 sm:h-9 items-center justify-center rounded-xl border theme-border theme-surface px-4 text-xs font-medium theme-text-secondary hover:opacity-85 transition-opacity"
              >
                Close
              </button>
            </footer>
          </article>
        </div>
      )}

      {reportIssueModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          style={{ backgroundColor: 'rgba(12, 12, 14, 0.72)', backdropFilter: 'blur(6px)' }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="report-issue-modal-title"
          onClick={() => setReportIssueModalOpen(false)}
        >
          <article
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-t-2xl sm:rounded-2xl border theme-border theme-surface theme-text-primary shadow-2xl overflow-hidden max-h-[85dvh] overflow-y-auto animate-modal-panel pb-[env(safe-area-inset-bottom)] sm:pb-0"
          >
            <header className="flex items-center justify-between gap-4 border-b theme-border theme-elevated px-4 sm:px-6 py-4">
              <div className="flex items-center gap-2.5">
                <AlertCircle className="h-4 w-4 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                <div>
                  <h2
                    id="report-issue-modal-title"
                    className="font-display text-base font-semibold theme-text-primary"
                  >
                    Report Issue &amp; Workspace Feedback
                  </h2>
                  <p className="text-xs theme-text-secondary">
                    Send an issue report or feedback directly to the engineering team
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setReportIssueModalOpen(false)}
                aria-label="Close report issue modal"
                className="inline-flex items-center justify-center rounded-lg border theme-border theme-surface px-3 py-1.5 text-xs font-semibold theme-text-primary hover:opacity-85 transition-opacity"
              >
                <span>✕ Close</span>
              </button>
            </header>

            <section className="p-4 sm:p-6 space-y-4 text-xs">
              <div className="space-y-1.5">
                <label
                  htmlFor="issue-category-select"
                  className="block font-mono text-[11px] uppercase tracking-wider theme-text-secondary"
                >
                  Issue Category
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {(
                    [
                      { id: 'bug', label: 'Bug / Error' },
                      { id: 'ui', label: 'Mobile / UI' },
                      { id: 'connector', label: 'Connectors' },
                      { id: 'other', label: 'General' }
                    ] as const
                  ).map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setIssueCategory(cat.id)}
                      className={`h-10 rounded-xl border px-3 text-xs font-medium transition-colors ${
                        issueCategory === cat.id
                           ? 'theme-btn-primary border-transparent font-semibold'
                           : 'theme-border theme-canvas theme-text-secondary hover:opacity-85'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="issue-description-textarea"
                  className="block font-mono text-[11px] uppercase tracking-wider theme-text-secondary"
                >
                  Issue Details
                </label>
                <textarea
                  id="issue-description-textarea"
                  rows={4}
                  value={issueDescription}
                  onChange={(e) => setIssueDescription(e.target.value)}
                  placeholder="Describe what happened, steps to reproduce, or what you would like improved…"
                  className="w-full rounded-xl border theme-border theme-canvas p-3.5 text-base md:text-xs theme-text-primary placeholder:opacity-50 focus:outline-none"
                />
              </div>

              <div className="rounded-xl border theme-border theme-elevated p-3 text-[11px] theme-text-secondary leading-relaxed">
                Clicking <strong className="theme-text-primary">Send via Email</strong> opens your email client pre-filled with your report details, or you can copy the report text directly.
              </div>
            </section>

            <footer className="flex flex-wrap items-center justify-between gap-2.5 border-t theme-border theme-elevated px-4 sm:px-6 py-3.5 text-xs">
              <button
                type="button"
                onClick={async () => {
                  const activeModelLabel =
                    models.find((m) => m.id === selectedModelId)?.label || 'Active AI Model';
                  const reportBody = `Category: ${issueCategory.toUpperCase()}\nAccount: ${
                    user.email || user.displayName || 'Workspace User'
                  }\nModel: ${activeModelLabel}\n\nDetails:\n${
                    issueDescription.trim() || '(No description provided)'
                  }`;
                  const ok = await copyToClipboard(reportBody);
                  if (ok) {
                    setIssueCopied(true);
                    window.setTimeout(() => setIssueCopied(false), 2000);
                  }
                }}
                className="inline-flex h-11 sm:h-9 items-center justify-center gap-1.5 rounded-xl border theme-border theme-surface px-3.5 text-xs font-medium theme-text-primary hover:opacity-85 transition-opacity"
              >
                {issueCopied ? (
                  <>
                    <Check className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--status-read)' }} />
                    <span>Copied Report</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5 shrink-0" />
                    <span>Copy Report</span>
                  </>
                )}
              </button>

              <div className="flex items-center gap-2">
                <a
                  href={`mailto:itzinvi.official@gmail.com?subject=${encodeURIComponent(
                    `[Pryzmium ${issueCategory.toUpperCase()}] Issue Report`
                  )}&body=${encodeURIComponent(
                    `Category: ${issueCategory.toUpperCase()}\nAccount: ${
                      user.email || user.displayName || 'Workspace User'
                    }\nActive Model: ${
                      models.find((m) => m.id === selectedModelId)?.label || 'Active AI Model'
                    }\n\nDescription:\n${
                      issueDescription.trim() || 'Please describe the issue here...'
                    }`
                  )}`}
                  onClick={() => setReportIssueModalOpen(false)}
                  className="inline-flex h-11 sm:h-9 items-center justify-center gap-1.5 rounded-xl theme-btn-primary px-4 text-xs font-semibold transition-colors"
                >
                  <Mail className="h-3.5 w-3.5 shrink-0" />
                  <span>Send via Email</span>
                </a>
              </div>
            </footer>
          </article>
        </div>
      )}

      <AnimatePresence>
        {isMenuOpen && (
          <div
            className="fixed inset-0 z-50 flex"
            role="dialog"
            aria-modal="true"
            aria-label="Workspace navigation and settings menu"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className="fixed inset-0"
              style={{ backgroundColor: 'rgba(12, 12, 14, 0.55)', backdropFilter: 'blur(4px)' }}
              onClick={() => setIsMenuOpen(false)}
              aria-hidden="true"
            />

            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 360, damping: 34 }}
              className="relative z-10 flex h-full w-80 max-w-[88vw] flex-col justify-between border-r theme-border theme-surface shadow-2xl"
            >
              <div className="flex flex-col min-h-0 flex-1">
                <div className="flex items-center justify-between gap-3 border-b theme-border px-4 py-3.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <button
                      type="button"
                      onClick={() => setIsMenuOpen(false)}
                      aria-label="Close navigation menu"
                      className="group relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border theme-border theme-elevated theme-text-primary transition-colors hover:opacity-85"
                    >
                      <span className="relative flex h-4 w-4 flex-col items-center justify-center">
                        <span className="absolute h-[1.75px] w-4 rotate-45 rounded-full bg-current transition-transform duration-200" />
                        <span className="absolute h-[1.75px] w-4 -rotate-45 rounded-full bg-current transition-transform duration-200" />
                      </span>
                    </button>
                    <PryzmiumLogo />
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      void handleCreateNewSession();
                      setIsMenuOpen(false);
                    }}
                    title="Start New Session (Ctrl+Shift+O)"
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl theme-btn-primary px-3 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" />
                    <span>New Chat</span>
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto px-3 py-3 space-y-5">
                  <nav aria-label="Main Menu Navigation" className="space-y-1">
                    <p className="px-2.5 pb-1 text-[11px] font-mono uppercase tracking-wider theme-text-muted">
                      Menu
                    </p>
                    {(
                      [
                        { id: 'workspace', label: 'Workspace', icon: LayoutGrid },
                        { id: 'connections', label: 'Connectors', icon: Plug },
                        { id: 'audit', label: 'Audit Logs', icon: ScrollText },
                        { id: 'profile', label: 'Profile', icon: User }
                      ] as const
                    ).map((item) => {
                      const Icon = item.icon;
                      const isActive = activeTab === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            setActiveTab(item.id);
                            setIsMenuOpen(false);
                          }}
                          aria-current={isActive ? 'page' : undefined}
                          className={`relative flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-xs font-medium transition-colors ${
                            isActive
                              ? 'theme-elevated theme-text-primary font-semibold border theme-border'
                              : 'theme-text-secondary hover:opacity-85'
                          }`}
                        >
                          <span className="flex items-center gap-2.5">
                            <Icon
                              className="h-4 w-4 shrink-0"
                              style={{
                                color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)'
                              }}
                            />
                            <span>{item.label}</span>
                          </span>
                          {item.id === 'workspace' && (
                            <span className="font-mono text-[11px] theme-text-muted tabular-nums">
                              {chats.length}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </nav>

                  <div className="space-y-2.5 border-t theme-border pt-3">
                    <div className="flex items-center justify-between px-2">
                      <span className="text-[11px] font-mono uppercase tracking-wider theme-text-muted">
                        Recent Chats
                      </span>
                      <span className="text-[11px] font-mono theme-text-muted tabular-nums">
                        {chats.length}
                      </span>
                    </div>

                    {(() => {
                      const allChatIds = chats.map((c) => c.chatId);
                      const selectedSet = new Set(selectedChatIds);
                      const allSelected =
                        allChatIds.length > 0 && allChatIds.every((id) => selectedSet.has(id));

                      if (chats.length === 0) {
                        return (
                          <p className="px-2 text-xs theme-text-muted leading-relaxed">
                            No saved threads yet. Send a prompt to begin a persistent session.
                          </p>
                        );
                      }

                      return (
                        <div className="space-y-1.5 px-1">
                          <div className="flex items-center justify-between gap-2 rounded-lg border theme-border theme-canvas px-2.5 py-1.5">
                            <label className="inline-flex items-center gap-2 text-[11px] font-medium theme-text-secondary cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={allSelected}
                                onChange={() => handleToggleSelectAllSessions(allChatIds)}
                                aria-label="Select all sessions"
                                className="h-3.5 w-3.5 rounded border theme-border accent-indigo-600 cursor-pointer"
                              />
                              <span>
                                {selectedChatIds.length > 0
                                  ? `Selected (${selectedChatIds.length})`
                                  : 'Select all'}
                              </span>
                            </label>

                            {selectedChatIds.length > 0 && (
                              <button
                                type="button"
                                onClick={handleBatchDeleteSelectedChats}
                                disabled={isBatchDeletingChats}
                                className="inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 whitespace-nowrap shrink-0"
                                style={{
                                  borderColor: 'var(--status-destructive)',
                                  color: 'var(--status-destructive)',
                                  backgroundColor: 'rgba(220, 38, 38, 0.08)'
                                }}
                              >
                                {isBatchDeletingChats ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3 w-3" />
                                )}
                                <span>Delete ({selectedChatIds.length})</span>
                              </button>
                            )}
                          </div>

                          <ul className="space-y-1">
                            {chats.map((chat) => {
                              const isSelected = selectedSet.has(chat.chatId);
                              const isActive = activeChatId === chat.chatId;
                              const isEditing = editingChatId === chat.chatId;
                              const primaryToolLog = auditLogs.find(
                                (log) => log.chatId === chat.chatId && log.toolName
                              );
                              const rawModelSlug = (chat.modelId || 'gemini-3.8-flash')
                                .split('/')
                                .pop()
                                ?.replace(/:free$/i, '') || 'model';
                              const badgeLabel = primaryToolLog
                                ? primaryToolLog.toolName.replace(/_/g, ' ')
                                : rawModelSlug;
                              const badgeTooltip = primaryToolLog
                                ? `Tool: ${primaryToolLog.toolName} · Model: ${chat.modelId}`
                                : `Model: ${chat.modelId}`;

                              return (
                                <li
                                  key={chat.chatId}
                                  className={`group flex items-center gap-1.5 rounded-xl px-2.5 py-2 transition-colors ${
                                    isActive
                                      ? 'theme-elevated theme-text-primary font-semibold border theme-border'
                                      : 'theme-text-secondary hover:opacity-90'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => handleToggleSelectChat(chat.chatId)}
                                    aria-label={`Select session ${chat.title}`}
                                    className="h-3.5 w-3.5 shrink-0 rounded border theme-border accent-indigo-600 cursor-pointer"
                                  />

                                  {isEditing ? (
                                    <input
                                      type="text"
                                      value={editingChatTitle}
                                      maxLength={160}
                                      autoFocus
                                      aria-label="Rename session title"
                                      onChange={(e) => setEditingChatTitle(e.target.value)}
                                      onBlur={() => void handleRenameChat(chat.chatId, editingChatTitle)}
                                      onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
                                        if (e.key === 'Enter') {
                                          e.preventDefault();
                                          void handleRenameChat(chat.chatId, editingChatTitle);
                                        } else if (e.key === 'Escape') {
                                          e.preventDefault();
                                          setEditingChatId(null);
                                          setEditingChatTitle('');
                                        }
                                      }}
                                      className="h-7 flex-1 min-w-0 rounded-md border theme-border-strong theme-canvas px-2 text-xs font-medium theme-text-primary focus:outline-none"
                                    />
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setActiveChatId(chat.chatId);
                                        setActiveTab('workspace');
                                        setIsMenuOpen(false);
                                      }}
                                      className={`flex-1 min-w-0 flex items-center justify-between gap-1.5 text-left text-xs py-0.5 ${
                                        isActive
                                          ? 'font-semibold theme-text-primary'
                                          : 'theme-text-secondary'
                                      }`}
                                    >
                                      <span className="truncate">{chat.title}</span>
                                      <span
                                        title={badgeTooltip}
                                        className="shrink-0 max-w-[82px] truncate rounded border theme-border theme-canvas px-1.5 py-0.5 font-mono text-[10px] font-normal theme-text-muted"
                                      >
                                        {badgeLabel}
                                      </span>
                                    </button>
                                  )}

                                  <div className="flex items-center gap-0.5 shrink-0">
                                    {!isEditing && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setEditingChatId(chat.chatId);
                                          setEditingChatTitle(chat.title);
                                        }}
                                        title="Rename chat session"
                                        aria-label={`Rename ${chat.title}`}
                                        className="rounded-md p-1 theme-text-muted hover:opacity-80"
                                      >
                                        <Pencil className="h-3 w-3" />
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => void handleDeleteChat(chat.chatId)}
                                      title="Delete chat session"
                                      aria-label={`Delete ${chat.title}`}
                                      className="rounded-md p-1 theme-text-muted hover:opacity-80"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>

              <div className="border-t theme-border theme-elevated p-3 space-y-2.5 text-xs">
                <AnimatePresence initial={false}>
                  {isMenuSettingsOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.22, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      <div className="rounded-xl border theme-border theme-surface p-3 space-y-3 mb-1">
                        <div className="flex items-center justify-between border-b theme-border pb-2">
                          <span className="font-display text-xs font-semibold theme-text-primary">
                            Quick Settings
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setActiveTab('settings');
                                setIsMenuSettingsOpen(false);
                                setIsMenuOpen(false);
                              }}
                              className="text-[11px] font-semibold hover:underline"
                              style={{ color: 'var(--accent-primary)' }}
                            >
                              Full Settings
                            </button>
                            <button
                              type="button"
                              onClick={() => setIsMenuSettingsOpen(false)}
                              aria-label="Close settings panel"
                              className="rounded p-0.5 theme-text-muted hover:opacity-80"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-medium theme-text-primary">Workspace Theme</p>
                            <div className="flex h-7 items-center gap-1 rounded-lg border theme-border theme-canvas p-0.5">
                              <button
                                type="button"
                                onClick={() => handleChangeTheme('cream')}
                                aria-pressed={theme === 'cream'}
                                className={`inline-flex h-full items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors ${
                                  theme === 'cream'
                                    ? 'theme-elevated theme-text-primary font-semibold'
                                    : 'theme-text-muted hover:opacity-85'
                                }`}
                              >
                                <Sun className="h-3 w-3" />
                                <span>Cream</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleChangeTheme('dark')}
                                aria-pressed={theme === 'dark'}
                                className={`inline-flex h-full items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors ${
                                  theme === 'dark'
                                    ? 'theme-elevated theme-text-primary font-semibold'
                                    : 'theme-text-muted hover:opacity-85'
                                }`}
                              >
                                <Moon className="h-3 w-3" />
                                <span>Dark</span>
                              </button>
                            </div>
                          </div>
                          <p className="text-[11px] theme-text-muted leading-snug">
                            Switches surface contrast between Cream White and Soft Dark across the app.
                          </p>
                        </div>

                        <div className="space-y-1 pt-2 border-t theme-border">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-medium theme-text-primary">Auto-Scroll Chat</p>
                            <button
                              type="button"
                              onClick={handleToggleAutoScroll}
                              aria-pressed={autoScrollEnabled}
                              className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 font-mono text-[11px] transition-colors ${
                                autoScrollEnabled
                                  ? 'theme-btn-primary font-semibold'
                                  : 'theme-border theme-canvas theme-text-secondary'
                              }`}
                            >
                              <span>{autoScrollEnabled ? 'On' : 'Off'}</span>
                            </button>
                          </div>
                          <p className="text-[11px] theme-text-muted leading-snug">
                            Automatically follows new assistant messages to the bottom of the chat view.
                          </p>
                        </div>

                        <div className="rounded-lg border theme-border theme-canvas p-2.5 space-y-1.5 theme-text-primary">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[10px] font-semibold uppercase tracking-wider theme-text-primary">
                              Storage &amp; Telemetry
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setIsMenuSettingsOpen(false);
                                setIsMenuOpen(false);
                                openCookieModal();
                              }}
                              className="rounded border theme-border theme-elevated px-2 py-0.5 font-mono text-[10px] font-semibold theme-text-primary hover:opacity-85 transition-opacity"
                            >
                              Manage
                            </button>
                          </div>
                          <p className="font-mono text-[10px] theme-text-secondary">
                            Essential: On · Analytics: {cookiePreferences?.analytics ? 'On' : 'Off'} · Functional: {cookiePreferences?.functional ? 'On' : 'Off'}
                          </p>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab('settings');
                      setIsMenuOpen(false);
                    }}
                    className={`flex flex-1 items-center justify-between rounded-xl border px-3 py-2.5 text-xs font-medium transition-colors ${
                      activeTab === 'settings'
                        ? 'theme-border-strong theme-surface theme-text-primary font-semibold'
                        : 'theme-border theme-canvas theme-text-primary hover:opacity-90'
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <Settings
                        className="h-4 w-4 shrink-0"
                        style={{ color: 'var(--accent-primary)' }}
                      />
                      <span>Settings</span>
                    </span>
                    <span className="text-[11px] font-mono theme-text-muted">
                      {theme === 'cream' ? 'Cream' : 'Dark'} · {autoScrollEnabled ? 'Scroll On' : 'Scroll Off'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsMenuSettingsOpen((prev) => !prev)}
                    aria-expanded={isMenuSettingsOpen}
                    aria-label="Toggle quick settings drawer"
                    title="Quick settings slider"
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border theme-border theme-canvas theme-text-secondary hover:opacity-85 transition-opacity"
                  >
                    {isMenuSettingsOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronUp className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setIsMenuOpen(false);
                      setReportIssueModalOpen(true);
                    }}
                    className="flex flex-1 items-center justify-between rounded-xl border theme-border theme-canvas px-3 py-2.5 text-xs font-medium theme-text-primary hover:opacity-90 transition-colors"
                  >
                    <span className="flex items-center gap-2.5">
                      <AlertCircle
                        className="h-4 w-4 shrink-0"
                        style={{ color: 'var(--accent-primary)' }}
                      />
                      <span>Report Issue</span>
                    </span>
                    <span className="font-mono text-[11px] theme-text-muted">Feedback</span>
                  </button>

                  <a
                    href="mailto:itzinvi.official@gmail.com?subject=Pryzmium%20Workspace%20Issue%20Report"
                    title="Email support directly (itzinvi.official@gmail.com)"
                    aria-label="Email issue report directly"
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border theme-border theme-canvas theme-text-secondary hover:opacity-85 transition-opacity"
                  >
                    <Mail className="h-3.5 w-3.5" />
                  </a>
                </div>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab('profile');
                      setIsMenuOpen(false);
                    }}
                    className="inline-flex min-w-0 flex-1 items-center gap-2 rounded-xl border theme-border theme-canvas px-3 py-2 text-left text-xs font-medium theme-text-primary hover:opacity-85 transition-opacity"
                  >
                    <User className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                    <span className="truncate">
                      {profile?.displayName || user.displayName || user.email}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={logoutUser}
                    title="Sign out"
                    aria-label="Sign out"
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border theme-border theme-canvas px-3 text-xs font-medium theme-text-secondary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
                  >
                    <LogOut className="h-3.5 w-3.5 shrink-0" />
                    <span>Sign out</span>
                  </button>
                </div>
              </div>
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-2 border-b theme-border theme-surface px-3.5 sm:px-6 min-h-16 sm:min-h-14 py-2">
        <div className="flex items-center gap-2.5 sm:gap-3.5 min-w-0">
          <motion.button
            type="button"
            whileTap={{ scale: 0.94 }}
            onClick={() => setIsMenuOpen((prev) => !prev)}
            aria-expanded={isMenuOpen}
            aria-label="Open navigation and settings menu"
            title="Navigation & Settings Menu"
            className={`group relative inline-flex h-11 w-11 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-xl border shadow-xs touch-manipulation select-none transition-colors duration-150 focus-visible:outline-none ${
              isMenuOpen
                ? 'theme-btn-primary border-transparent'
                : 'theme-border-strong theme-elevated theme-text-primary hover:opacity-90'
            }`}
          >
            <span className="relative flex w-4.5 flex-col items-start justify-center gap-[4.5px] overflow-hidden">
              <motion.span
                initial={false}
                animate={
                  isMenuOpen
                    ? { rotate: 45, y: 6.25, x: 0, width: 18 }
                    : { rotate: 0, y: 0, x: 0, width: 18 }
                }
                transition={{ type: 'spring', stiffness: 420, damping: 30 }}
                className="h-[1.75px] rounded-full bg-current block origin-center"
              />
              <motion.span
                initial={false}
                animate={
                  isMenuOpen
                    ? { opacity: 0, x: -12, width: 0 }
                    : { opacity: 1, x: 0, width: 13 }
                }
                transition={{ type: 'spring', stiffness: 420, damping: 30 }}
                className="h-[1.75px] rounded-full bg-current block group-hover:w-[18px] transition-[width] duration-200"
              />
              <motion.span
                initial={false}
                animate={
                  isMenuOpen
                    ? { rotate: -45, y: -6.25, x: 0, width: 18 }
                    : { rotate: 0, y: 0, x: 0, width: 15 }
                }
                transition={{ type: 'spring', stiffness: 420, damping: 30 }}
                className="h-[1.75px] rounded-full bg-current block origin-center group-hover:w-[18px] transition-[width] duration-200"
              />
            </span>
          </motion.button>

          <span
            aria-hidden="true"
            className="h-6 w-px shrink-0"
            style={{ backgroundColor: 'var(--border-strong)' }}
          />

          <a
            href="#workspace"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('workspace');
            }}
            aria-label="Pryzmium Workspace"
            className="inline-flex items-center shrink-0 pl-0.5"
          >
            <PryzmiumLogo />
          </a>

          {activeTab === 'workspace' ? (
            <div className="min-w-0">
              <ModelSelectorModal
                models={models}
                selectedModelId={selectedModelId}
                onSelectModel={handleModelSwitch}
              />
            </div>
          ) : (
            <span className="text-xs font-mono theme-text-muted capitalize truncate">
              ·{' '}
              {activeTab === 'connections'
                ? 'Connectors'
                : activeTab === 'audit'
                  ? 'Audit Logs'
                  : activeTab === 'settings'
                    ? 'Settings'
                    : 'Profile'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {activeTab === 'workspace' && (
            <button
              type="button"
              disabled={isCreatingShare}
              onClick={handleShareCurrentSession}
              title="Share read-only session link"
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border theme-border theme-elevated px-3 text-xs font-medium theme-text-primary whitespace-nowrap shrink-0 hover:opacity-85 transition-opacity disabled:opacity-50"
            >
              <Share2 className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
              <span className="hidden sm:inline">{isCreatingShare ? 'Sharing…' : 'Share'}</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleCreateNewSession}
            title="Start New Session (Ctrl+Shift+O)"
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl theme-btn-primary px-3 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
          >
            <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" />
            <span className="hidden sm:inline">New Chat</span>
          </button>
        </div>
      </header>

      {activeTab === 'connections' && (
        <main className="flex-1 overflow-y-auto animate-view-enter">
          <ConnectionsView
            uid={user.uid}
            hasGoogleToken={hasGoogleToken}
            connectedProviders={connectedProviders}
            tools={tools}
            onConnectGoogleWorkspace={async () => {
              const res = await googleSignInWithWorkspaceScopes(GOOGLE_OAUTH_CONNECTORS);
              setHasGoogleToken(Boolean(res.accessToken));
              setConnectedProviders(res.connectedProviders);
            }}
            onToggleConnector={(conn, enabled) => {
              const updated = setConnectorEnabled(conn, enabled);
              setConnectedProviders(updated);
            }}
            onDisconnectAllGoogle={async () => {
              await revokeGoogleAccessAndDisconnect();
              setHasGoogleToken(false);
              setConnectedProviders(DEFAULT_LOCAL_CONNECTORS);
            }}
          />
        </main>
      )}

      {activeTab === 'audit' && (
        <main className="flex-1 overflow-y-auto animate-view-enter">
          <AuditLogView logs={auditLogs} />
        </main>
      )}

      {activeTab === 'profile' && (
        <main className="flex-1 overflow-y-auto animate-view-enter">
          <GovernanceView
            uid={user.uid}
            email={user.email}
            displayName={profile?.displayName || user.displayName || 'Workspace Operator'}
            profile={profile}
            chatCount={chats.length}
            hasGoogleToken={hasGoogleToken}
            isServerSession={user.isServerSession}
            limits={limits}
            models={models}
            onUpdateUsername={handleUpdateUsername}
            onClearAllConversations={handleClearAllConversations}
            onDeleteAllUserData={handleDeleteAllUserData}
            onSignOut={logoutUser}
          />
        </main>
      )}

      {activeTab === 'settings' && (
        <main className="flex-1 overflow-y-auto animate-view-enter">
          <div className="mx-auto max-w-4xl px-4 sm:px-6 py-6 sm:py-10 space-y-6 sm:space-y-8">
            <header className="space-y-1.5 border-b theme-border pb-6">
              <p
                className="text-xs font-mono uppercase tracking-wider"
                style={{ color: 'var(--accent-primary)' }}
              >
                Workspace Configuration
              </p>
              <h1 className="font-display text-2xl font-semibold theme-text-primary">
                Settings &amp; Interface Preferences
              </h1>
              <p className="text-sm theme-text-secondary max-w-2xl leading-relaxed">
                All workspace appearance, scrolling behavior, composer keybindings, and message display options are configured exclusively here. Each setting includes a summary of how it works.
              </p>
            </header>

            <section aria-label="Workspace Settings List" className="space-y-4">
              <article className="rounded-2xl border theme-border theme-elevated p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1 max-w-xl">
                  <h2 className="font-display text-base font-semibold theme-text-primary">
                    1. Workspace Color Theme
                  </h2>
                  <p className="text-xs theme-text-secondary leading-relaxed">
                    Controls the surface color palette and contrast across the entire application. Choose Cream White for warm daylight clarity or Soft Dark to reduce eye strain in low-light environments.
                  </p>
                </div>

                <div
                  role="group"
                  aria-label="Workspace Color Theme"
                  className="flex h-10 items-center gap-1 rounded-xl border theme-border theme-surface p-1 shrink-0"
                >
                  <button
                    type="button"
                    onClick={() => handleChangeTheme('cream')}
                    aria-pressed={theme === 'cream'}
                    className={`inline-flex h-full items-center gap-1.5 rounded-lg px-3.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      theme === 'cream'
                        ? 'theme-btn-primary font-semibold'
                        : 'theme-text-secondary hover:opacity-85'
                    }`}
                  >
                    <Sun className="h-3.5 w-3.5 shrink-0" />
                    <span>Cream White</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleChangeTheme('dark')}
                    aria-pressed={theme === 'dark'}
                    className={`inline-flex h-full items-center gap-1.5 rounded-lg px-3.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      theme === 'dark'
                        ? 'theme-btn-primary font-semibold'
                        : 'theme-text-secondary hover:opacity-85'
                    }`}
                  >
                    <Moon className="h-3.5 w-3.5 shrink-0" />
                    <span>Soft Dark</span>
                  </button>
                </div>
              </article>

              <article className="rounded-2xl border theme-border theme-elevated p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1 max-w-xl">
                  <h2 className="font-display text-base font-semibold theme-text-primary">
                    2. Automatic Chat Scrolling
                  </h2>
                  <p className="text-xs theme-text-secondary leading-relaxed">
                    Automatically scrolls the active conversation to the newest line as the assistant generates replies. Disable this option if you prefer to read earlier messages without the view jumping downward.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleToggleAutoScroll}
                  aria-pressed={autoScrollEnabled}
                  className={`inline-flex h-10 items-center justify-center gap-2 rounded-xl border px-4 font-mono text-xs transition-colors shrink-0 ${
                    autoScrollEnabled
                      ? 'theme-btn-primary font-semibold'
                      : 'theme-border theme-surface theme-text-secondary hover:opacity-85'
                  }`}
                >
                  <span>{autoScrollEnabled ? 'Auto-Scroll: On' : 'Auto-Scroll: Off'}</span>
                </button>
              </article>

              <article className="rounded-2xl border theme-border theme-elevated p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1 max-w-xl">
                  <h2 className="font-display text-base font-semibold theme-text-primary">
                    3. Enter Key Sends Prompt
                  </h2>
                  <p className="text-xs theme-text-secondary leading-relaxed">
                    Determines how the chat input box responds when you press Enter. When enabled, pressing Enter immediately dispatches your message; when disabled, only Ctrl+Enter (or Cmd+Enter) sends the prompt.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleToggleEnterToSend}
                  aria-pressed={enterToSend}
                  className={`inline-flex h-10 items-center justify-center gap-2 rounded-xl border px-4 font-mono text-xs transition-colors shrink-0 ${
                    enterToSend
                      ? 'theme-btn-primary font-semibold'
                      : 'theme-border theme-surface theme-text-secondary hover:opacity-85'
                  }`}
                >
                  <span>{enterToSend ? 'Enter to Send: On' : 'Ctrl+Enter Only'}</span>
                </button>
              </article>

              <article className="rounded-2xl border theme-border theme-elevated p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1 max-w-xl">
                  <h2 className="font-display text-base font-semibold theme-text-primary">
                    4. Agent Tool Execution Traces
                  </h2>
                  <p className="text-xs theme-text-secondary leading-relaxed">
                    Shows or hides the inline tool execution trace cards inside assistant replies, including tool names, read/write risk classifications, and execution duration in milliseconds.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleToggleShowToolTraces}
                  aria-pressed={showToolTraces}
                  className={`inline-flex h-10 items-center justify-center gap-2 rounded-xl border px-4 font-mono text-xs transition-colors shrink-0 ${
                    showToolTraces
                      ? 'theme-btn-primary font-semibold'
                      : 'theme-border theme-surface theme-text-secondary hover:opacity-85'
                  }`}
                >
                  <span>{showToolTraces ? 'Traces: Visible' : 'Traces: Hidden'}</span>
                </button>
              </article>

              <article className="rounded-2xl border theme-border theme-elevated p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1 max-w-xl">
                  <h2 className="font-display text-base font-semibold theme-text-primary">
                    5. Conversation Message Density
                  </h2>
                  <p className="text-xs theme-text-secondary leading-relaxed">
                    Adjusts vertical spacing and card padding between chat messages. Compact mode reduces whitespace so you can scan more messages and code blocks at once.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleToggleCompactMessages}
                  aria-pressed={compactMessages}
                  className={`inline-flex h-10 items-center justify-center gap-2 rounded-xl border px-4 font-mono text-xs transition-colors shrink-0 ${
                    compactMessages
                      ? 'theme-btn-primary font-semibold'
                      : 'theme-border theme-surface theme-text-secondary hover:opacity-85'
                  }`}
                >
                  <span>{compactMessages ? 'Density: Compact' : 'Density: Standard'}</span>
                </button>
              </article>

              <article className="rounded-2xl border theme-border theme-elevated p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1 max-w-xl">
                  <h2 className="font-display text-base font-semibold theme-text-primary">
                    6. Workspace Keyboard Shortcuts
                  </h2>
                  <p className="text-xs theme-text-secondary leading-relaxed">
                    Displays the reference guide of keyboard hotkeys for sending prompts (Ctrl+Enter), clearing the composer (Ctrl+K), starting a new chat (Ctrl+Shift+O), and sharing sessions (Ctrl+Shift+S).
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setShortcutsModalOpen(true)}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border theme-border theme-surface px-4 font-mono text-xs font-semibold theme-text-primary hover:opacity-85 transition-opacity shrink-0"
                >
                  <Keyboard className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                  <span>View Shortcuts (Ctrl+/)</span>
                </button>
              </article>

              <article className="rounded-2xl border theme-border theme-elevated p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 theme-text-primary">
                <div className="space-y-2 max-w-xl">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-display text-base font-semibold theme-text-primary">
                      7. Cookie &amp; Storage Performance Governance
                    </h2>
                    <span className="rounded-md border theme-border theme-surface px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider theme-text-primary">
                      Essential Active
                    </span>
                    <span className="rounded-md border theme-border theme-canvas px-2 py-0.5 font-mono text-[10px] theme-text-secondary">
                      Analytics: {cookiePreferences?.analytics ? 'Enabled' : 'Disabled'}
                    </span>
                    <span className="rounded-md border theme-border theme-canvas px-2 py-0.5 font-mono text-[10px] theme-text-secondary">
                      Functional: {cookiePreferences?.functional ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  <p className="text-xs theme-text-secondary leading-relaxed">
                    Configure local storage, performance telemetry, and functional preference persistence, or inspect the full Legal &amp; Trust Center documentation.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={openCookieModal}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-xl theme-btn-primary px-4 font-mono text-xs font-semibold transition-colors"
                  >
                    <span>Cookie Preferences</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openLegalHub('terms')}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border theme-border theme-surface px-4 font-mono text-xs font-semibold theme-text-primary hover:opacity-85 transition-opacity"
                  >
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                    <span>Legal Center</span>
                  </button>
                </div>
              </article>
            </section>
          </div>
        </main>
      )}

      {activeTab === 'workspace' && (
        <div className="flex-1 flex overflow-hidden animate-view-enter">
          <main className="flex-1 flex flex-col overflow-hidden theme-canvas">
            <div className="flex-1 min-h-0 flex flex-col">
              {messages.length === 0 ? (
                <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-10">
                  <div className="mx-auto max-w-3xl space-y-6">
                    <div className="rounded-2xl border theme-border theme-elevated p-5 sm:p-7 space-y-5">
                      <div className="space-y-1.5">
                        <h2 className="font-display text-lg sm:text-xl font-semibold theme-text-primary">
                          How can I help you today?
                        </h2>
                        <p className="text-xs theme-text-secondary leading-relaxed">
                          Choose a model above or start with a workspace task below. Open the top-left menu anytime to switch sessions, manage connectors, inspect audit logs, or adjust settings.
                        </p>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {[
                          {
                            title: 'Google Search Grounding',
                            prompt:
                              'Use Google Search to find the latest breakthroughs in solid-state batteries in 2026 and list the source links.'
                          },
                          {
                            title: 'Google Maps Places',
                            prompt:
                              'Use Google Maps to find top-rated specialty coffee roasters in San Francisco and include their Maps links.'
                          },
                          {
                            title: 'Save a Workspace Note',
                            prompt:
                              'List my current Workspace Notes, then create a new note titled "Q4 Launch Checklist" with tag "product" and content "Verify OAuth scopes for Docs and Tasks."'
                          },
                          {
                            title: 'Create a Google Doc',
                            prompt:
                              'Create a new Google Doc titled "Weekly Engineering Sync" with initial content "Agenda: 1. Agent Connectors 2. Security Audit".'
                          },
                          {
                            title: 'Check Tasks & Calendar',
                            prompt:
                              'List my items in Google Tasks and check my upcoming events on Google Calendar.'
                          },
                          {
                            title: 'Summarize Recent Gmail',
                            prompt:
                              'Search my Gmail for the latest 5 emails and summarize them clearly.'
                          }
                        ].map((item) => (
                          <button
                            key={item.title}
                            type="button"
                            onClick={() => handleSendMessage(undefined, item.prompt)}
                            className="flex items-center justify-between gap-3 rounded-xl border theme-border theme-surface p-3.5 sm:p-4 text-left hover:opacity-85 transition-opacity"
                          >
                            <div className="space-y-1 min-w-0">
                              <p className="font-display text-xs font-semibold theme-text-primary">
                                {item.title}
                              </p>
                              <p className="text-[11px] theme-text-secondary line-clamp-2 leading-relaxed">
                                {item.prompt}
                              </p>
                            </div>
                            <ChevronRight className="h-4 w-4 theme-text-muted shrink-0" />
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="relative flex-1 min-h-0">
                  <List
                    listRef={messagesListRef}
                    onScroll={handleChatScroll}
                    rowCount={messages.length}
                    rowHeight={dynamicRowHeight}
                    rowKey={getMessageRowKey}
                    rowComponent={VirtualizedChatMessageRow}
                    rowProps={{
                      messages,
                      models,
                      pendingActionsMap,
                      isRunningAgent,
                      confirmingActionId,
                      retryingToolKey,
                      auditLogs,
                      tools,
                      copiedKey,
                      searchQuery: '',
                      focusedMatchMessageId: null,
                      showToolTraces,
                      compactMessages,
                      onCopy: handleCopyText,
                      onDecision: handleConfirmDecision,
                      onRetryTool: handleRetryToolCall
                    }}
                    overscanCount={4}
                    className="py-4 sm:py-6"
                    style={{ height: '100%', width: '100%' }}
                  />
                  {isUserScrolledUp && (
                    <button
                      type="button"
                      onClick={handleJumpToBottom}
                      aria-label="Jump to Bottom"
                      className="absolute bottom-4 right-4 sm:right-6 z-20 inline-flex items-center gap-1.5 rounded-xl border theme-border theme-surface px-3.5 py-2 text-xs font-medium theme-text-primary shadow-md hover:opacity-90 transition-opacity"
                    >
                      <ArrowDown
                        className="h-3.5 w-3.5"
                        style={{ color: 'var(--accent-primary)' }}
                      />
                      <span>Jump to Bottom</span>
                    </button>
                  )}
                </div>
              )}

              {(isRunningAgent || chatBannerError) && (
                <div className="px-3.5 sm:px-6 pb-3">
                  <div className="mx-auto max-w-3xl space-y-2.5">
                    {isRunningAgent && (
                      <div className="rounded-xl border theme-border theme-elevated p-3 sm:p-3.5 flex items-center justify-between gap-3 theme-text-primary">
                        <div className="flex items-center gap-2 text-xs font-mono theme-text-primary truncate">
                          <Terminal className="h-4 w-4 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                          <span className="truncate">Generating response…</span>
                        </div>
                        <button
                          type="button"
                          onClick={handleStopStream}
                          className="inline-flex items-center gap-1.5 rounded-lg border theme-border theme-surface px-3 py-1.5 text-xs font-medium theme-text-primary hover:opacity-85 transition-opacity whitespace-nowrap shrink-0"
                        >
                          <Square className="h-3 w-3" style={{ color: 'var(--status-destructive)' }} />
                          <span>Stop</span>
                        </button>
                      </div>
                    )}

                    <ChatErrorBanner
                      error={chatBannerError}
                      onDismiss={() => setChatBannerError(null)}
                      onRetry={
                        lastFailedPrompt
                          ? () => handleSendMessage(undefined, lastFailedPrompt)
                          : undefined
                      }
                    />
                  </div>
                </div>
              )}
            </div>

            <form
              onSubmit={(e) => handleSendMessage(e)}
              className="border-t theme-border theme-surface px-3.5 sm:px-6 py-3 sm:py-4"
            >
              <div className="mx-auto max-w-3xl space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    ref={promptInputRef}
                    type="text"
                    enterKeyHint="send"
                    value={promptInput}
                    onChange={(e) => setPromptInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                        if (!enterToSend) {
                          e.preventDefault();
                          return;
                        }
                      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        if (promptInput.trim() && !isRunningAgent) {
                          void handleSendMessage();
                        }
                      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                        e.preventDefault();
                        setPromptInput('');
                        setSpeechError(null);
                      }
                    }}
                    maxLength={limits.maxMessageLength}
                    placeholder="Message Pryzmium…"
                    className="flex-1 min-w-0 h-12 sm:h-11 rounded-xl border theme-border theme-elevated px-3.5 sm:px-4 text-base md:text-sm theme-text-primary placeholder:opacity-60 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleToggleVoiceDictation}
                    aria-label={isDictating ? 'Stop voice dictation' : 'Start voice dictation'}
                    aria-pressed={isDictating}
                    title={isDictating ? 'Stop voice dictation' : 'Voice dictation'}
                    className={`inline-flex h-12 sm:h-11 min-w-[48px] sm:min-w-0 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      isDictating
                        ? 'theme-surface font-semibold'
                        : 'theme-border theme-elevated theme-text-primary hover:opacity-85'
                    }`}
                    style={
                      isDictating
                        ? {
                            borderColor: 'var(--status-destructive)',
                            color: 'var(--status-destructive)'
                          }
                        : undefined
                    }
                  >
                    {isDictating ? (
                      <>
                        <MicOff className="h-4 w-4 shrink-0 animate-pulse" />
                        <span className="hidden sm:inline">Stop</span>
                      </>
                    ) : (
                      <Mic
                        className="h-4 w-4 shrink-0"
                        style={{ color: 'var(--accent-primary)' }}
                      />
                    )}
                  </button>
                  {isRunningAgent ? (
                    <button
                      type="button"
                      onClick={handleStopStream}
                      className="inline-flex h-12 sm:h-11 items-center justify-center gap-1.5 rounded-xl px-4 text-xs font-semibold text-white transition-opacity hover:opacity-90 whitespace-nowrap shrink-0"
                      style={{ backgroundColor: 'var(--status-destructive)' }}
                    >
                      <Square className="h-3.5 w-3.5" />
                      <span>Stop</span>
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!promptInput.trim()}
                      title="Send prompt (Ctrl+Enter)"
                      className="inline-flex h-12 sm:h-11 min-w-[48px] sm:min-w-0 items-center justify-center gap-1.5 rounded-xl theme-btn-primary px-4 sm:px-5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
                    >
                      <Send className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Send</span>
                    </button>
                  )}
                </div>

                {(isDictating || speechError) && (
                  <div className="flex items-center justify-between gap-2 rounded-xl border theme-border theme-elevated px-3.5 py-2 text-xs font-mono theme-text-primary">
                    {isDictating ? (
                      <span className="theme-text-primary">
                        Listening… Speak clearly to transcribe into the prompt.
                      </span>
                    ) : (
                      <span style={{ color: 'var(--status-destructive)' }}>{speechError}</span>
                    )}
                    {speechError && (
                      <button
                        type="button"
                        onClick={() => setSpeechError(null)}
                        className="theme-text-secondary hover:opacity-80"
                        aria-label="Dismiss voice dictation notice"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </form>
          </main>
        </div>
      )}

      <CookieConsentBanner hidden={isLegalHubOpen || authPolicyModalOpen || reportIssueModalOpen} />
      {isLegalHubOpen && <LegalHub onBackToApp={closeLegalHub} />}
    </div>
  );
}

