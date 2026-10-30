export type RiskLevel = 'read' | 'write' | 'destructive';
export type ConnectorId =
  | 'system'
  | 'search'
  | 'maps'
  | 'notes'
  | 'gmail'
  | 'calendar'
  | 'drive'
  | 'docs'
  | 'tasks';
export type ModelProvider = 'openrouter' | 'groq' | 'xkiro' | 'gemini';
export type CostTier = 'free' | 'low' | 'standard' | 'premium';
export type ThemeMode = 'cream' | 'dark';

export interface GroundingLink {
  title: string;
  uri: string;
  sourceType: 'web' | 'maps';
  snippet?: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: ModelProvider;
  providerModelName: string;
  supportsTools: boolean;
  costTier: CostTier;
  contextWindow: string;
  bestFor: string;
  dailyLimit24h: number;
  remaining24h?: number;
  providerLimit24h?: number;
  providerRemaining24h?: number;
  description: string;
  configuredOnServer: boolean;
  providerStatus?: 'active' | 'downtime';
}

export interface ToolInfo {
  name: string;
  connector: ConnectorId;
  description: string;
  risk: RiskLevel;
  requiredScopes: string[];
}

export interface UserProfileDoc {
  uid: string;
  email: string;
  displayName: string;
  plan: 'free' | 'pro';
  dailyRequestsCount: number;
  dailyTokensUsed: number;
  lastResetDate: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ChatSessionDoc {
  chatId: string;
  uid: string;
  title: string;
  modelId: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ChatMessageDoc {
  messageId: string;
  chatId: string;
  uid: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  modelId: string;
  fallbackNotice?: string;
  toolTraceSummary?: string;
  pendingActionId?: string;
  createdAt?: unknown;
}

export interface PendingActionDoc {
  actionId: string;
  uid: string;
  chatId: string;
  toolName: string;
  risk: 'write' | 'destructive';
  argsPreview: string;
  argsHash: string;
  serverSignature: string;
  warningText: string;
  status: 'pending' | 'executed' | 'rejected' | 'expired';
  expiresAtMs: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AuditLogDoc {
  logId: string;
  uid: string;
  chatId: string;
  toolName: string;
  risk: RiskLevel;
  summary: string;
  status: 'success' | 'paused_for_confirm' | 'executed' | 'rejected' | 'error';
  durationMs: number;
  createdAt?: unknown;
}

export interface ToolTraceItem {
  step: number;
  toolName: string;
  risk: RiskLevel;
  argsSummary: string;
  argsJson?: string;
  status: 'success' | 'paused_for_confirm' | 'error';
  durationMs: number;
}
