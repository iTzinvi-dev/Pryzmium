import fs from 'node:fs';
import path from 'node:path';
import { getAllowlistedModel, ModelProvider } from '../models/registry.ts';

interface UserQuotaRecord {
  minuteTimestamps: number[];
  modelDailyCounts: Record<string, number>;
  providerDailyCounts: Record<ModelProvider, number>;
  dailyRequestCount: number;
  dailyTokensUsed: number;
  lastResetDate: string;
}

export const PROVIDER_DAILY_LIMITS_24H: Record<ModelProvider, number> = {
  openrouter: 25,
  gemini: 12,
  groq: 10,
  xkiro: 6
};

export const RATE_LIMIT_CONFIG = {
  maxRequestsPerMinute: 6,
  maxRequestsPerDay:
    PROVIDER_DAILY_LIMITS_24H.openrouter +
    PROVIDER_DAILY_LIMITS_24H.gemini +
    PROVIDER_DAILY_LIMITS_24H.groq +
    PROVIDER_DAILY_LIMITS_24H.xkiro,
  maxTokensPerDay: 60_000,
  maxMessageLength: 4_000
};

export const SIGN_IN_LIMIT_CONFIG = {
  maxAttempts: 5,
  windowMs: 5 * 60_000
};

export type EndpointBucketType =
  | 'signin'
  | 'auth'
  | 'chat'
  | 'tools'
  | 'shares'
  | 'models'
  | 'consent'
  | 'vault';

export const ENDPOINT_RATE_LIMITS: Record<
  EndpointBucketType,
  { maxRequests: number; windowMs: number; label: string }
> = {
  signin: {
    maxRequests: SIGN_IN_LIMIT_CONFIG.maxAttempts,
    windowMs: SIGN_IN_LIMIT_CONFIG.windowMs,
    label: 'Sign-in'
  },
  auth: {
    maxRequests: 10,
    windowMs: 60_000,
    label: 'Authentication endpoint'
  },
  chat: {
    maxRequests: RATE_LIMIT_CONFIG.maxRequestsPerMinute,
    windowMs: 60_000,
    label: 'Chat agent endpoint'
  },
  tools: {
    maxRequests: 15,
    windowMs: 60_000,
    label: 'Tool execution endpoint'
  },
  shares: {
    maxRequests: 20,
    windowMs: 60_000,
    label: 'Shared conversation endpoint'
  },
  models: {
    maxRequests: 60,
    windowMs: 60_000,
    label: 'Model catalog endpoint'
  },
  consent: {
    maxRequests: 30,
    windowMs: 60_000,
    label: 'Account consent endpoint'
  },
  vault: {
    maxRequests: 15,
    windowMs: 60_000,
    label: 'Token vault encryption endpoint'
  }
};

const PROVIDER_DISPLAY_LABELS: Record<ModelProvider, string> = {
  xkiro: 'alpha',
  groq: 'beta',
  openrouter: 'gama',
  gemini: 'delta'
};

const MAX_QUOTA_USERS = 5000;
const MAX_ENDPOINT_KEYS = 5000;
const PERSIST_FILE_PATH = path.resolve('/tmp', 'pryzmium-quota-store.json');

const quotaStore = new Map<string, UserQuotaRecord>();
const endpointStore = new Map<string, number[]>();

function getTodayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function createEmptyProviderCounts(): Record<ModelProvider, number> {
  return {
    openrouter: 0,
    groq: 0,
    xkiro: 0,
    gemini: 0
  };
}

function loadPersistedQuotaStore(): void {
  try {
    if (!fs.existsSync(PERSIST_FILE_PATH)) {
      return;
    }
    const raw = fs.readFileSync(PERSIST_FILE_PATH, 'utf8');
    if (!raw.trim()) {
      return;
    }
    const parsed = JSON.parse(raw) as {
      quota?: Record<string, UserQuotaRecord>;
      endpoints?: Record<string, number[]>;
    };
    const today = getTodayUtcDate();
    if (parsed.quota && typeof parsed.quota === 'object') {
      for (const [uid, rec] of Object.entries(parsed.quota)) {
        if (!rec || typeof rec !== 'object') continue;
        if (rec.lastResetDate !== today) continue;
        quotaStore.set(uid, {
          minuteTimestamps: Array.isArray(rec.minuteTimestamps) ? rec.minuteTimestamps : [],
          modelDailyCounts:
            rec.modelDailyCounts && typeof rec.modelDailyCounts === 'object'
              ? rec.modelDailyCounts
              : {},
          providerDailyCounts: {
            ...createEmptyProviderCounts(),
            ...(rec.providerDailyCounts || {})
          },
          dailyRequestCount: Number(rec.dailyRequestCount) || 0,
          dailyTokensUsed: Number(rec.dailyTokensUsed) || 0,
          lastResetDate: today
        });
      }
    }
    if (parsed.endpoints && typeof parsed.endpoints === 'object') {
      const now = Date.now();
      for (const [key, timestamps] of Object.entries(parsed.endpoints)) {
        if (!Array.isArray(timestamps)) continue;
        const active = timestamps.filter((ts) => typeof ts === 'number' && now - ts < 10 * 60_000);
        if (active.length > 0) {
          endpointStore.set(key, active);
        }
      }
    }
  } catch {
    return;
  }
}

function persistQuotaStore(): void {
  try {
    const quotaObj: Record<string, UserQuotaRecord> = {};
    for (const [uid, rec] of quotaStore.entries()) {
      quotaObj[uid] = rec;
    }
    const endpointObj: Record<string, number[]> = {};
    for (const [key, timestamps] of endpointStore.entries()) {
      endpointObj[key] = timestamps;
    }
    fs.writeFileSync(
      PERSIST_FILE_PATH,
      JSON.stringify({ quota: quotaObj, endpoints: endpointObj }),
      'utf8'
    );
  } catch {
    return;
  }
}

loadPersistedQuotaStore();

function normalizeUserRecordTotals(rec: UserQuotaRecord): void {
  const providerSum =
    (rec.providerDailyCounts.openrouter || 0) +
    (rec.providerDailyCounts.gemini || 0) +
    (rec.providerDailyCounts.groq || 0) +
    (rec.providerDailyCounts.xkiro || 0);
  if (providerSum > rec.dailyRequestCount) {
    rec.dailyRequestCount = providerSum;
  }
}

function getOrInitRecord(uid: string): UserQuotaRecord {
  const safeUid = (uid || 'anonymous').slice(0, 128);
  const today = getTodayUtcDate();
  let rec = quotaStore.get(safeUid);

  if (!rec) {
    if (quotaStore.size >= MAX_QUOTA_USERS) {
      const oldestKey = quotaStore.keys().next().value;
      if (oldestKey) {
        quotaStore.delete(oldestKey);
      }
    }
    rec = {
      minuteTimestamps: [],
      modelDailyCounts: {},
      providerDailyCounts: createEmptyProviderCounts(),
      dailyRequestCount: 0,
      dailyTokensUsed: 0,
      lastResetDate: today
    };
    quotaStore.set(safeUid, rec);
    return rec;
  }

  if (rec.lastResetDate !== today) {
    rec.dailyRequestCount = 0;
    rec.dailyTokensUsed = 0;
    rec.modelDailyCounts = {};
    rec.providerDailyCounts = createEmptyProviderCounts();
    rec.lastResetDate = today;
    persistQuotaStore();
  }

  if (!rec.providerDailyCounts) {
    rec.providerDailyCounts = createEmptyProviderCounts();
  }

  normalizeUserRecordTotals(rec);
  return rec;
}

export interface EndpointRateLimitResult {
  allowed: boolean;
  bucket: EndpointBucketType;
  limit: number;
  remaining: number;
  resetEpochSec: number;
  retryAfterSec: number;
  reason?: string;
}

export function getEndpointRateLimitSnapshot(params: {
  bucket: EndpointBucketType;
  identifier: string;
}): EndpointRateLimitResult {
  const config = ENDPOINT_RATE_LIMITS[params.bucket];
  const now = Date.now();
  const safeId = (params.identifier || 'anon').trim().slice(0, 140);
  const storeKey = `${params.bucket}:${safeId}`;

  const existing = endpointStore.get(storeKey) || [];
  const activeTimestamps = existing.filter((ts) => now - ts < config.windowMs);
  endpointStore.set(storeKey, activeTimestamps);

  const remaining = Math.max(0, config.maxRequests - activeTimestamps.length);
  const oldest = activeTimestamps[0] || now;
  const retryAfterMs =
    activeTimestamps.length >= config.maxRequests
      ? Math.max(1000, config.windowMs - (now - oldest))
      : 0;
  const retryAfterSec = retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 0;
  const resetEpochSec = Math.ceil((now + (retryAfterMs || config.windowMs)) / 1000);

  return {
    allowed: remaining > 0,
    bucket: params.bucket,
    limit: config.maxRequests,
    remaining,
    resetEpochSec,
    retryAfterSec,
    ...(remaining <= 0
      ? {
          reason: `${config.label} rate limit exceeded (${config.maxRequests} attempts per ${Math.round(
            config.windowMs / 60_000
          )} min). Retry in ${retryAfterSec}s.`
        }
      : {})
  };
}

export function checkEndpointRateLimit(params: {
  bucket: EndpointBucketType;
  identifier: string;
}): EndpointRateLimitResult {
  const config = ENDPOINT_RATE_LIMITS[params.bucket];
  const now = Date.now();
  const safeId = (params.identifier || 'anon').trim().slice(0, 140);
  const storeKey = `${params.bucket}:${safeId}`;

  const existing = endpointStore.get(storeKey) || [];
  const activeTimestamps = existing.filter((ts) => now - ts < config.windowMs);

  if (activeTimestamps.length >= config.maxRequests) {
    endpointStore.set(storeKey, activeTimestamps);
    persistQuotaStore();
    const oldest = activeTimestamps[0] || now;
    const retryAfterMs = Math.max(1000, config.windowMs - (now - oldest));
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);
    const resetEpochSec = Math.ceil((now + retryAfterMs) / 1000);
    const windowDesc =
      config.windowMs >= 60_000 && config.windowMs % 60_000 === 0
        ? `${Math.round(config.windowMs / 60_000)}m`
        : `${Math.round(config.windowMs / 1000)}s`;

    return {
      allowed: false,
      bucket: params.bucket,
      limit: config.maxRequests,
      remaining: 0,
      resetEpochSec,
      retryAfterSec,
      reason: `${config.label} rate limit exceeded (${config.maxRequests} requests per ${windowDesc}). Retry in ${retryAfterSec}s.`
    };
  }

  activeTimestamps.push(now);
  if (!endpointStore.has(storeKey) && endpointStore.size >= MAX_ENDPOINT_KEYS) {
    const oldestKey = endpointStore.keys().next().value;
    if (oldestKey) {
      endpointStore.delete(oldestKey);
    }
  }
  endpointStore.set(storeKey, activeTimestamps);
  persistQuotaStore();

  const remaining = Math.max(0, config.maxRequests - activeTimestamps.length);
  const resetEpochSec = Math.ceil((now + config.windowMs) / 1000);

  return {
    allowed: true,
    bucket: params.bucket,
    limit: config.maxRequests,
    remaining,
    resetEpochSec,
    retryAfterSec: 0
  };
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfterSec?: number;
  remainingMinute: number;
  remainingDay: number;
  remainingModel24h: number;
  modelLimit24h: number;
  requestsToday: number;
  tokensToday: number;
  modelCountsToday: Record<string, number>;
  providerCountsToday: Record<ModelProvider, number>;
}

export function checkAndConsumeRateLimit(
  uid: string,
  modelId: string,
  estimatedTokens = 300
): RateLimitResult {
  const now = Date.now();
  const rec = getOrInitRecord(uid);
  const modelEntry = getAllowlistedModel(modelId);
  const provider = modelEntry.provider;
  const providerCap24h = PROVIDER_DAILY_LIMITS_24H[provider] ?? modelEntry.dailyLimit24h;
  const modelCap24h = providerCap24h;

  rec.minuteTimestamps = rec.minuteTimestamps.filter((ts) => now - ts < 60_000);

  const currentProviderUsed = rec.providerDailyCounts[provider] || 0;
  const currentModelUsed = rec.modelDailyCounts[modelEntry.id] || 0;
  const effectiveUsed = Math.max(currentProviderUsed, currentModelUsed);

  if (rec.minuteTimestamps.length >= RATE_LIMIT_CONFIG.maxRequestsPerMinute) {
    const oldest = rec.minuteTimestamps[0] || now;
    const retryAfterSec = Math.max(1, Math.ceil((60_000 - (now - oldest)) / 1000));
    return {
      allowed: false,
      reason: `Burst rate limit exceeded (${RATE_LIMIT_CONFIG.maxRequestsPerMinute} requests/min). Wait ${retryAfterSec}s and try again.`,
      retryAfterSec,
      remainingMinute: 0,
      remainingDay: Math.max(0, RATE_LIMIT_CONFIG.maxRequestsPerDay - rec.dailyRequestCount),
      remainingModel24h: Math.max(0, modelCap24h - effectiveUsed),
      modelLimit24h: modelCap24h,
      requestsToday: rec.dailyRequestCount,
      tokensToday: rec.dailyTokensUsed,
      modelCountsToday: { ...rec.modelDailyCounts },
      providerCountsToday: { ...rec.providerDailyCounts }
    };
  }

  if (currentProviderUsed >= providerCap24h || currentModelUsed >= modelCap24h) {
    const providerLabel = PROVIDER_DISPLAY_LABELS[provider] || provider;
    return {
      allowed: false,
      reason: `${providerLabel} (${provider}) 24-hour shared API limit reached (${providerCap24h}/${providerCap24h} requests used today across all ${provider} models). Select a model from another active provider or wait until 00:00 UTC reset.`,
      retryAfterSec: 60,
      remainingMinute: Math.max(
        0,
        RATE_LIMIT_CONFIG.maxRequestsPerMinute - rec.minuteTimestamps.length
      ),
      remainingDay: Math.max(0, RATE_LIMIT_CONFIG.maxRequestsPerDay - rec.dailyRequestCount),
      remainingModel24h: 0,
      modelLimit24h: modelCap24h,
      requestsToday: rec.dailyRequestCount,
      tokensToday: rec.dailyTokensUsed,
      modelCountsToday: { ...rec.modelDailyCounts },
      providerCountsToday: { ...rec.providerDailyCounts }
    };
  }

  if (rec.dailyRequestCount >= RATE_LIMIT_CONFIG.maxRequestsPerDay) {
    return {
      allowed: false,
      reason: `Workspace daily request quota reached (${RATE_LIMIT_CONFIG.maxRequestsPerDay} requests/day). Resets at 00:00 UTC.`,
      retryAfterSec: 60,
      remainingMinute: Math.max(
        0,
        RATE_LIMIT_CONFIG.maxRequestsPerMinute - rec.minuteTimestamps.length
      ),
      remainingDay: 0,
      remainingModel24h: Math.max(0, modelCap24h - effectiveUsed),
      modelLimit24h: modelCap24h,
      requestsToday: rec.dailyRequestCount,
      tokensToday: rec.dailyTokensUsed,
      modelCountsToday: { ...rec.modelDailyCounts },
      providerCountsToday: { ...rec.providerDailyCounts }
    };
  }

  if (rec.dailyTokensUsed + estimatedTokens > RATE_LIMIT_CONFIG.maxTokensPerDay) {
    return {
      allowed: false,
      reason: `Daily token budget reached (${RATE_LIMIT_CONFIG.maxTokensPerDay.toLocaleString()} tokens/day). Resets at 00:00 UTC.`,
      retryAfterSec: 60,
      remainingMinute: Math.max(
        0,
        RATE_LIMIT_CONFIG.maxRequestsPerMinute - rec.minuteTimestamps.length
      ),
      remainingDay: Math.max(0, RATE_LIMIT_CONFIG.maxRequestsPerDay - rec.dailyRequestCount),
      remainingModel24h: Math.max(0, modelCap24h - effectiveUsed),
      modelLimit24h: modelCap24h,
      requestsToday: rec.dailyRequestCount,
      tokensToday: rec.dailyTokensUsed,
      modelCountsToday: { ...rec.modelDailyCounts },
      providerCountsToday: { ...rec.providerDailyCounts }
    };
  }

  rec.minuteTimestamps.push(now);
  rec.dailyRequestCount += 1;
  rec.dailyTokensUsed += estimatedTokens;
  rec.modelDailyCounts[modelEntry.id] = currentModelUsed + 1;
  rec.providerDailyCounts[provider] = currentProviderUsed + 1;
  normalizeUserRecordTotals(rec);
  persistQuotaStore();

  const updatedProviderUsed = rec.providerDailyCounts[provider];

  return {
    allowed: true,
    remainingMinute: Math.max(
      0,
      RATE_LIMIT_CONFIG.maxRequestsPerMinute - rec.minuteTimestamps.length
    ),
    remainingDay: Math.max(0, RATE_LIMIT_CONFIG.maxRequestsPerDay - rec.dailyRequestCount),
    remainingModel24h: Math.max(0, modelCap24h - updatedProviderUsed),
    modelLimit24h: modelCap24h,
    requestsToday: rec.dailyRequestCount,
    tokensToday: rec.dailyTokensUsed,
    modelCountsToday: { ...rec.modelDailyCounts },
    providerCountsToday: { ...rec.providerDailyCounts }
  };
}

export function addActualTokenUsage(uid: string, additionalTokens: number): void {
  const rec = getOrInitRecord(uid);
  rec.dailyTokensUsed += Math.max(0, additionalTokens);
  persistQuotaStore();
}

export function syncUserQuotaBaseline(params: {
  uid: string;
  clientRequestsToday?: number;
  clientTokensToday?: number;
}): void {
  const rec = getOrInitRecord(params.uid);
  let changed = false;

  if (
    typeof params.clientRequestsToday === 'number' &&
    Number.isFinite(params.clientRequestsToday) &&
    params.clientRequestsToday > rec.dailyRequestCount
  ) {
    rec.dailyRequestCount = Math.min(
      RATE_LIMIT_CONFIG.maxRequestsPerDay,
      Math.max(0, Math.floor(params.clientRequestsToday))
    );
    changed = true;
  }

  if (
    typeof params.clientTokensToday === 'number' &&
    Number.isFinite(params.clientTokensToday) &&
    params.clientTokensToday > rec.dailyTokensUsed
  ) {
    rec.dailyTokensUsed = Math.min(
      RATE_LIMIT_CONFIG.maxTokensPerDay,
      Math.max(0, Math.floor(params.clientTokensToday))
    );
    changed = true;
  }

  const providerSum =
    (rec.providerDailyCounts.openrouter || 0) +
    (rec.providerDailyCounts.gemini || 0) +
    (rec.providerDailyCounts.groq || 0) +
    (rec.providerDailyCounts.xkiro || 0);

  if (rec.dailyRequestCount > providerSum) {
    const diff = rec.dailyRequestCount - providerSum;
    const geminiCap = PROVIDER_DAILY_LIMITS_24H.gemini;
    const currentGemini = rec.providerDailyCounts.gemini || 0;
    const addGemini = Math.min(diff, Math.max(0, geminiCap - currentGemini));
    rec.providerDailyCounts.gemini = currentGemini + addGemini;
    changed = true;
  }

  normalizeUserRecordTotals(rec);
  if (changed) {
    persistQuotaStore();
  }
}

export function resetUserQuotaRecord(uid: string): void {
  const safeUid = (uid || 'anonymous').slice(0, 128);
  const today = getTodayUtcDate();
  quotaStore.set(safeUid, {
    minuteTimestamps: [],
    modelDailyCounts: {},
    providerDailyCounts: createEmptyProviderCounts(),
    dailyRequestCount: 0,
    dailyTokensUsed: 0,
    lastResetDate: today
  });
  persistQuotaStore();
}

export function getUserModelUsageSnapshot(uid: string): {
  requestsToday: number;
  tokensToday: number;
  modelCountsToday: Record<string, number>;
  providerCountsToday: Record<ModelProvider, number>;
} {
  const rec = getOrInitRecord(uid);
  return {
    requestsToday: rec.dailyRequestCount,
    tokensToday: rec.dailyTokensUsed,
    modelCountsToday: { ...rec.modelDailyCounts },
    providerCountsToday: { ...rec.providerDailyCounts }
  };
}
