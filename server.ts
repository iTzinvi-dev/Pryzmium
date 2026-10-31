import 'dotenv/config';
import crypto from 'crypto';
import dns from 'node:dns';
import net from 'node:net';
import express, { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { runBoundedAgentLoop } from './src/lib/agent/loop.ts';

dns.setDefaultResultOrder('ipv4first');
if (typeof net.setDefaultAutoSelectFamily === 'function') {
  net.setDefaultAutoSelectFamily(false);
}
import {
  getProviderHealthStatus,
  MODEL_ALLOWLIST,
  ModelProvider
} from './src/lib/models/registry.ts';
import {
  buildClearSessionCookieHeader,
  buildContentSecurityPolicyHeader,
  buildSessionCookieHeader,
  createServerSessionToken,
  extractTrustedClientIp,
  normalizeHostHeader,
  RequestSecurityContext,
  verifyFirebaseIdTokenHeader,
  verifyRequestOriginAndContext
} from './src/lib/security/auth-verify.ts';
import {
  assertCryptoConfiguration,
  canonicalizeArgs,
  computeArgsHash,
  decryptToken,
  encryptToken,
  signPendingAction,
  verifyPendingActionSignature
} from './src/lib/security/crypto.ts';
import {
  AppError,
  createAuthError,
  createConflictError,
  createForbiddenError,
  createGoneError,
  createNotFoundError,
  createRateLimitError,
  createValidationError,
  normalizeToAppError,
  redactSensitiveData
} from './src/lib/security/errors.ts';
import {
  addActualTokenUsage,
  checkAndConsumeRateLimit,
  checkEndpointRateLimit,
  EndpointBucketType,
  getEndpointRateLimitSnapshot,
  getUserModelUsageSnapshot,
  PROVIDER_DAILY_LIMITS_24H,
  RATE_LIMIT_CONFIG,
  resetUserQuotaRecord,
  SIGN_IN_LIMIT_CONFIG,
  syncUserQuotaBaseline
} from './src/lib/security/ratelimit.ts';
import {
  ALL_TOOLS,
  ConnectorId,
  getToolByName
} from './src/lib/tools/index.ts';

interface ServerAuthAccount {
  uid: string;
  email: string;
  displayName: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
}

const serverAuthAccountsByEmail = new Map<string, ServerAuthAccount>();
const acceptedConsentUids = new Set<string>();
const acceptedConsentEmails = new Set<string>();
const usedConfirmationSignatures = new Map<string, number>();

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

const sharedChatsStore = new Map<string, SharedChatSnapshot>();
const MAX_STORE_ENTRIES = 1000;

export function extractClientIp(req: Request): string {
  return extractTrustedClientIp({
    socketRemoteAddress: req.socket?.remoteAddress,
    forwardedForHeader: req.headers['x-forwarded-for']
  });
}

function resolveRequestHost(req: Request): string {
  const trustHops = Number.parseInt(process.env.TRUST_PROXY_HOPS || '0', 10);
  if (Number.isFinite(trustHops) && trustHops >= 1 && trustHops <= 5) {
    const forwardedHost = req.headers['x-forwarded-host'];
    if (typeof forwardedHost === 'string' && forwardedHost.trim()) {
      const normalized = normalizeHostHeader(forwardedHost);
      if (normalized) {
        return normalized;
      }
    }
  }
  return normalizeHostHeader(req.headers.host);
}

function isRequestSecure(req: Request): boolean {
  if (req.secure || process.env.NODE_ENV === 'production') {
    return true;
  }
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    return forwardedProto.split(',')[0].trim().toLowerCase() === 'https';
  }
  return false;
}

function buildRequestSecurityContext(req: Request): RequestSecurityContext {
  return {
    method: req.method,
    originHeader:
      typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
    refererHeader:
      typeof req.headers.referer === 'string' ? req.headers.referer : undefined,
    hostHeader: resolveRequestHost(req),
    secFetchSiteHeader:
      typeof req.headers['sec-fetch-site'] === 'string'
        ? req.headers['sec-fetch-site']
        : undefined,
    userAgentHeader:
      typeof req.headers['user-agent'] === 'string'
        ? req.headers['user-agent']
        : undefined
  };
}

function getIdTokenHeader(req: Request): string | undefined {
  const headerToken = req.headers['x-firebase-id-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  return undefined;
}

function sendCustomError(
  req: Request,
  res: Response,
  err: unknown,
  extraFields?: Record<string, unknown>
): void {
  const appErr = normalizeToAppError(err);
  if (typeof appErr.retryAfterSec === 'number' && appErr.retryAfterSec > 0) {
    res.setHeader('Retry-After', String(appErr.retryAfterSec));
  }
  const serialized = appErr.toJSON(req.originalUrl || req.path || '/api');
  res.status(appErr.statusCode).json({
    ...serialized,
    ...(extraFields || {})
  });
}

function enforceRateLimitBucket(
  req: Request,
  res: Response,
  bucket: EndpointBucketType,
  customIdentifier?: string
): boolean {
  const identifier = customIdentifier || extractClientIp(req);
  const check = checkEndpointRateLimit({
    bucket,
    identifier
  });

  res.setHeader('X-RateLimit-Limit', String(check.limit));
  res.setHeader('X-RateLimit-Remaining', String(check.remaining));
  res.setHeader('X-RateLimit-Reset', String(check.resetEpochSec));

  if (!check.allowed) {
    sendCustomError(
      req,
      res,
      createRateLimitError({
        message: check.reason || 'Too many requests to this endpoint.',
        retryAfterSec: check.retryAfterSec,
        isQuota: false
      })
    );
    return false;
  }
  return true;
}

function hashPasswordScrypt(password: string, saltHex?: string): { salt: string; hash: string } {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash: derived };
}

function verifyPasswordScrypt(password: string, salt: string, expectedHash: string): boolean {
  const { hash } = hashPasswordScrypt(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function buildModelsListForUser(uid?: string) {
  const snapshot = uid
    ? getUserModelUsageSnapshot(uid)
    : {
        requestsToday: 0,
        tokensToday: 0,
        modelCountsToday: {} as Record<string, number>,
        providerCountsToday: {
          openrouter: 0,
          groq: 0,
          xkiro: 0,
          gemini: 0
        } as Record<ModelProvider, number>
      };

  return MODEL_ALLOWLIST.map((m) => {
    const providerCap24h = PROVIDER_DAILY_LIMITS_24H[m.provider] ?? m.dailyLimit24h;
    const effectiveModelLimit24h = providerCap24h;
    const usedByModel = snapshot.modelCountsToday[m.id] || 0;
    const usedByProvider = snapshot.providerCountsToday?.[m.provider] || 0;
    const effectiveUsed = Math.max(usedByModel, usedByProvider);
    const remaining24h = Math.max(0, effectiveModelLimit24h - effectiveUsed);
    const providerRemaining24h = Math.max(0, providerCap24h - usedByProvider);
    const providerHealth = getProviderHealthStatus(m.provider);
    const effectiveStatus: 'active' | 'downtime' =
      providerHealth === 'downtime' || remaining24h <= 0 ? 'downtime' : 'active';

    return {
      ...m,
      dailyLimit24h: effectiveModelLimit24h,
      remaining24h,
      providerLimit24h: providerCap24h,
      providerRemaining24h,
      configuredOnServer: true,
      providerStatus: effectiveStatus
    };
  });
}

const ALL_CONNECTOR_IDS = [
  'system',
  'search',
  'maps',
  'notes',
  'gmail',
  'calendar',
  'drive',
  'docs',
  'tasks'
] as const;

const DEFAULT_ENABLED_CONNECTORS: Array<(typeof ALL_CONNECTOR_IDS)[number]> = [
  'system',
  'search',
  'maps',
  'notes'
];

const ChatRequestSchema = z.object({
  uid: z.string().trim().min(3).max(128),
  modelId: z.string().trim().min(3).max(160),
  message: z.string().min(1).max(RATE_LIMIT_CONFIG.maxMessageLength),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(4000)
      })
    )
    .max(12)
    .default([]),
  connectedProviders: z
    .array(z.enum(ALL_CONNECTOR_IDS))
    .default(DEFAULT_ENABLED_CONNECTORS)
});

const ConfirmActionSchema = z.object({
  uid: z.string().min(3).max(128),
  actionId: z.string().min(4).max(120),
  decision: z.enum(['approve', 'reject']),
  toolName: z.string().min(2).max(80),
  argsPreview: z.string().min(2).max(8000),
  argsHash: z.string().length(64),
  serverSignature: z.string().length(64),
  expiresAtMs: z.number().int().positive()
});

const EncryptDemoSchema = z.object({
  uid: z.string().min(3).max(128),
  provider: z.enum(['gmail', 'calendar', 'drive', 'docs', 'tasks']),
  token: z.string().min(5).max(4096)
});

const RetryToolCallSchema = z.object({
  uid: z.string().min(3).max(128),
  toolName: z.string().min(2).max(80),
  args: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  fallbackPrompt: z.string().max(4000).optional()
});

const ServerRegisterSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address.').max(254),
  password: z.string().min(6, 'Password must be at least 6 characters long.').max(128),
  displayName: z.string().trim().min(1).max(80).optional()
});

const ServerLoginSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address.').max(254),
  password: z.string().min(1, 'Password is required.').max(128)
});

const ShareCreateSchema = z.object({
  shareId: z
    .string()
    .trim()
    .regex(/^shr_[a-zA-Z0-9_-]{6,64}$/)
    .optional(),
  chatId: z.string().trim().min(2).max(128),
  title: z.string().trim().min(1).max(160),
  modelId: z.string().trim().min(2).max(160),
  modelLabel: z.string().trim().min(1).max(120),
  authorName: z.string().trim().min(1).max(100),
  messages: z
    .array(
      z.object({
        messageId: z.string().min(1).max(128),
        role: z.enum(['user', 'assistant']),
        content: z.string().max(15000),
        modelId: z.string().max(160),
        toolTraceSummary: z.string().max(4000).optional()
      })
    )
    .max(100)
});

export const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Content-Security-Policy', buildContentSecurityPolicyHeader());
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      const method = req.method.toUpperCase();
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const originCheck = verifyRequestOriginAndContext(buildRequestSecurityContext(req));
        if (!originCheck.allowed) {
          sendCustomError(
            req,
            res,
            createForbiddenError(
              originCheck.reason || 'Cross-origin state-changing request rejected.',
              'FORBIDDEN_ORIGIN',
              'Reload the workspace application from its primary origin and try again.'
            )
          );
          return;
        }
      }
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      status: 'operational'
    });
  });

  app.get('/api/auth/signin-status', (req, res) => {
    const identifier = extractClientIp(req);
    const status = getEndpointRateLimitSnapshot({
      bucket: 'signin',
      identifier
    });
    res.json({
      ok: true,
      allowed: status.allowed,
      limit: status.limit,
      remaining: status.remaining,
      retryAfterSec: status.retryAfterSec,
      windowSec: Math.round(SIGN_IN_LIMIT_CONFIG.windowMs / 1000)
    });
  });

  app.post('/api/auth/signin-check', (req, res) => {
    if (!enforceRateLimitBucket(req, res, 'signin')) {
      return;
    }
    const identifier = extractClientIp(req);
    const status = getEndpointRateLimitSnapshot({
      bucket: 'signin',
      identifier
    });
    res.json({
      ok: true,
      allowed: true,
      limit: status.limit,
      remaining: status.remaining,
      retryAfterSec: status.retryAfterSec,
      windowSec: Math.round(SIGN_IN_LIMIT_CONFIG.windowMs / 1000)
    });
  });

  app.post('/api/auth/register', (req, res) => {
    if (!enforceRateLimitBucket(req, res, 'signin')) {
      return;
    }
    if (!enforceRateLimitBucket(req, res, 'auth')) {
      return;
    }

    const parsed = ServerRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message || 'Invalid registration details.';
      sendCustomError(req, res, createValidationError(issue));
      return;
    }

    const normalizedEmail = parsed.data.email.toLowerCase();
    if (serverAuthAccountsByEmail.has(normalizedEmail)) {
      sendCustomError(
        req,
        res,
        createConflictError(
          'An account with this email already exists. Switch to "Sign In" to log in.',
          'AUTH_ACCOUNT_EXISTS'
        )
      );
      return;
    }

    const uid = `usr_${crypto.createHash('sha256').update(normalizedEmail).digest('hex').slice(0, 20)}`;
    const displayName =
      parsed.data.displayName || normalizedEmail.split('@')[0] || 'Workspace Operator';
    const { salt, hash } = hashPasswordScrypt(parsed.data.password);

    const account: ServerAuthAccount = {
      uid,
      email: normalizedEmail,
      displayName,
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: new Date().toISOString()
    };

    if (serverAuthAccountsByEmail.size >= MAX_STORE_ENTRIES) {
      const oldestKey = serverAuthAccountsByEmail.keys().next().value;
      if (oldestKey) serverAuthAccountsByEmail.delete(oldestKey);
    }
    serverAuthAccountsByEmail.set(normalizedEmail, account);
    acceptedConsentUids.add(uid);
    acceptedConsentEmails.add(normalizedEmail);

    const sessionToken = createServerSessionToken({
      uid,
      email: normalizedEmail,
      displayName,
      originHost: resolveRequestHost(req),
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined
    });
    res.setHeader(
      'Set-Cookie',
      buildSessionCookieHeader(sessionToken, {
        maxAgeSec: 7 * 24 * 3600,
        isSecure: isRequestSecure(req)
      })
    );

    res.json({
      ok: true,
      user: {
        uid,
        email: normalizedEmail,
        displayName,
        emailVerified: true,
        isServerSession: true
      },
      sessionToken
    });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!enforceRateLimitBucket(req, res, 'signin')) {
      return;
    }
    if (!enforceRateLimitBucket(req, res, 'auth')) {
      return;
    }

    const parsed = ServerLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message || 'Invalid login payload.';
      sendCustomError(req, res, createValidationError(issue));
      return;
    }

    const normalizedEmail = parsed.data.email.toLowerCase();
    let existing = serverAuthAccountsByEmail.get(normalizedEmail);
    if (!existing) {
      const uid = `usr_${crypto.createHash('sha256').update(normalizedEmail).digest('hex').slice(0, 20)}`;
      const displayName = normalizedEmail.split('@')[0] || 'Workspace Operator';
      const { salt, hash } = hashPasswordScrypt(parsed.data.password);
      existing = {
        uid,
        email: normalizedEmail,
        displayName,
        passwordSalt: salt,
        passwordHash: hash,
        createdAt: new Date().toISOString()
      };
      serverAuthAccountsByEmail.set(normalizedEmail, existing);
      acceptedConsentUids.add(uid);
      acceptedConsentEmails.add(normalizedEmail);
    } else {
      const valid = verifyPasswordScrypt(
        parsed.data.password,
        existing.passwordSalt,
        existing.passwordHash
      );
      if (!valid) {
        sendCustomError(
          req,
          res,
          createAuthError(
            'Incorrect password. Please double-check your password and try again.',
            'AUTH_INVALID_CREDENTIALS',
            'Verify Caps Lock is off and re-enter your password.'
          )
        );
        return;
      }
    }

    const sessionToken = createServerSessionToken({
      uid: existing.uid,
      email: existing.email,
      displayName: existing.displayName,
      originHost: resolveRequestHost(req),
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined
    });

    res.setHeader(
      'Set-Cookie',
      buildSessionCookieHeader(sessionToken, {
        maxAgeSec: 7 * 24 * 3600,
        isSecure: isRequestSecure(req)
      })
    );

    res.json({
      ok: true,
      user: {
        uid: existing.uid,
        email: existing.email,
        displayName: existing.displayName,
        emailVerified: true,
        isServerSession: true
      },
      sessionToken
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (!enforceRateLimitBucket(req, res, 'auth')) {
      return;
    }
    res.setHeader(
      'Set-Cookie',
      buildClearSessionCookieHeader({ isSecure: isRequestSecure(req) })
    );
    res.json({ ok: true });
  });

  app.get('/api/auth/consent', async (req, res) => {
    if (!enforceRateLimitBucket(req, res, 'consent')) {
      return;
    }

    const uid = typeof req.query.uid === 'string' ? req.query.uid.trim() : '';
    const email =
      typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';

    if (!uid && !email) {
      sendCustomError(
        req,
        res,
        createValidationError('A valid uid or email query parameter is required.')
      );
      return;
    }

    const verified = await verifyFirebaseIdTokenHeader({
      idTokenHeader: getIdTokenHeader(req),
      cookieHeader: req.headers.cookie,
      expectedUid: uid || email,
      requestContext: buildRequestSecurityContext(req)
    });
    if (!verified.valid) {
      sendCustomError(
        req,
        res,
        createAuthError(
          verified.reason || 'Authentication required to query account consent status.',
          'AUTH_REQUIRED'
        )
      );
      return;
    }

    const accepted =
      (Boolean(uid) && acceptedConsentUids.has(uid)) ||
      (Boolean(email) && acceptedConsentEmails.has(email));

    res.json({ ok: true, accepted });
  });

  app.post('/api/auth/consent', async (req, res) => {
    if (!enforceRateLimitBucket(req, res, 'consent')) {
      return;
    }

    const uid = typeof req.body?.uid === 'string' ? req.body.uid.trim().slice(0, 128) : '';
    const email =
      typeof req.body?.email === 'string'
        ? req.body.email.trim().toLowerCase().slice(0, 254)
        : '';

    if (!uid && !email) {
      sendCustomError(
        req,
        res,
        createValidationError('Either uid or email is required to record legal consent.')
      );
      return;
    }

    const verified = await verifyFirebaseIdTokenHeader({
      idTokenHeader: getIdTokenHeader(req),
      cookieHeader: req.headers.cookie,
      expectedUid: uid || email,
      requestContext: buildRequestSecurityContext(req)
    });
    if (!verified.valid) {
      sendCustomError(
        req,
        res,
        createAuthError(
          verified.reason || 'Authentication required to update legal consent.',
          'AUTH_REQUIRED'
        )
      );
      return;
    }

    if (uid) {
      if (acceptedConsentUids.size >= MAX_STORE_ENTRIES) {
        const oldest = acceptedConsentUids.values().next().value;
        if (oldest) acceptedConsentUids.delete(oldest);
      }
      acceptedConsentUids.add(uid);
    }
    if (email) {
      if (acceptedConsentEmails.size >= MAX_STORE_ENTRIES) {
        const oldest = acceptedConsentEmails.values().next().value;
        if (oldest) acceptedConsentEmails.delete(oldest);
      }
      acceptedConsentEmails.add(email);
    }
    res.json({ ok: true, accepted: true });
  });

  app.get('/api/models', async (req, res) => {
    const uid = typeof req.query.uid === 'string' ? req.query.uid.trim() : undefined;
    if (!enforceRateLimitBucket(req, res, 'models', uid)) {
      return;
    }

    const verified = await verifyFirebaseIdTokenHeader({
      idTokenHeader: getIdTokenHeader(req),
      cookieHeader: req.headers.cookie,
      expectedUid: uid,
      requestContext: buildRequestSecurityContext(req)
    });
    if (!verified.valid || !verified.uid) {
      sendCustomError(
        req,
        res,
        createAuthError(
          verified.reason || 'Authentication is required to access model catalog and quota telemetry.',
          'AUTH_REQUIRED'
        )
      );
      return;
    }

    const clientRequestsToday =
      typeof req.query.requestsToday === 'string' ? Number(req.query.requestsToday) : undefined;
    const clientTokensToday =
      typeof req.query.tokensToday === 'string' ? Number(req.query.tokensToday) : undefined;

    if (
      (typeof clientRequestsToday === 'number' && Number.isFinite(clientRequestsToday)) ||
      (typeof clientTokensToday === 'number' && Number.isFinite(clientTokensToday))
    ) {
      syncUserQuotaBaseline({
        uid: verified.uid,
        clientRequestsToday,
        clientTokensToday
      });
    }

    const snapshot = getUserModelUsageSnapshot(verified.uid);

    res.json({
      models: buildModelsListForUser(verified.uid),
      tools: ALL_TOOLS.map((t) => ({
        name: t.name,
        connector: t.connector,
        description: t.description,
        risk: t.risk,
        requiredScopes: t.requiredScopes
      })),
      limits: RATE_LIMIT_CONFIG,
      providerLimits24h: PROVIDER_DAILY_LIMITS_24H,
      quota: snapshot
    });
  });

  app.post('/api/quota/reset', async (req, res) => {
    const uid = typeof req.body?.uid === 'string' ? req.body.uid.trim() : undefined;
    if (!enforceRateLimitBucket(req, res, 'models', uid)) {
      return;
    }

    const verified = await verifyFirebaseIdTokenHeader({
      idTokenHeader: getIdTokenHeader(req),
      cookieHeader: req.headers.cookie,
      expectedUid: uid,
      requestContext: buildRequestSecurityContext(req)
    });
    if (!verified.valid || !verified.uid) {
      sendCustomError(
        req,
        res,
        createAuthError(
          verified.reason || 'Authentication required to reset usage quota.',
          'AUTH_REQUIRED'
        )
      );
      return;
    }

    resetUserQuotaRecord(verified.uid);
    res.json({
      ok: true,
      quota: getUserModelUsageSnapshot(verified.uid),
      models: buildModelsListForUser(verified.uid),
      limits: RATE_LIMIT_CONFIG
    });
  });

  app.post('/api/shares', async (req, res) => {
    if (!enforceRateLimitBucket(req, res, 'shares')) {
      return;
    }

    const verified = await verifyFirebaseIdTokenHeader({
      idTokenHeader: getIdTokenHeader(req),
      cookieHeader: req.headers.cookie,
      requestContext: buildRequestSecurityContext(req)
    });
    if (!verified.valid || !verified.uid) {
      sendCustomError(
        req,
        res,
        createAuthError(
          verified.reason || 'You must be signed in to create a shared conversation link.',
          'AUTH_REQUIRED'
        )
      );
      return;
    }

    const parsed = ShareCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      sendCustomError(
        req,
        res,
        createValidationError('Invalid conversation snapshot payload for sharing.')
      );
      return;
    }

    const data = parsed.data;
    const shareId =
      data.shareId ||
      `shr_${crypto.createHash('sha256').update(`${verified.uid}:${data.chatId}`).digest('hex').slice(0, 16)}`;

    const nowIso = new Date().toISOString();
    const existing = sharedChatsStore.get(shareId);

    const snapshot: SharedChatSnapshot = {
      shareId,
      chatId: data.chatId,
      title: data.title,
      modelId: data.modelId,
      modelLabel: data.modelLabel,
      authorName: data.authorName,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
      messages: data.messages
    };

    if (!sharedChatsStore.has(shareId) && sharedChatsStore.size >= MAX_STORE_ENTRIES) {
      const oldestKey = sharedChatsStore.keys().next().value;
      if (oldestKey) sharedChatsStore.delete(oldestKey);
    }
    sharedChatsStore.set(shareId, snapshot);
    res.json({ ok: true, shareId, share: snapshot });
  });

  app.get('/api/shares/:shareId', (req, res) => {
    if (!enforceRateLimitBucket(req, res, 'shares')) {
      return;
    }

    const shareId = typeof req.params.shareId === 'string' ? req.params.shareId.trim() : '';
    if (!shareId || !/^shr_[a-zA-Z0-9_-]{6,64}$/.test(shareId)) {
      sendCustomError(
        req,
        res,
        createValidationError(
          'Invalid shared conversation identifier format.',
          'Verify that the share URL was copied completely.'
        )
      );
      return;
    }

    const snapshot = sharedChatsStore.get(shareId);
    if (!snapshot) {
      sendCustomError(
        req,
        res,
        createNotFoundError(
          'Shared conversation not found or has expired.',
          'RESOURCE_NOT_FOUND',
          'Ask the conversation author to generate an updated share link.'
        )
      );
      return;
    }
    res.json({ ok: true, share: snapshot });
  });

  app.post('/api/chat', async (req, res) => {
    try {
      const parsed = ChatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        const formattedIssues = parsed.error.issues
          .map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`)
          .join(' | ');
        sendCustomError(
          req,
          res,
          createValidationError(
            `Invalid request payload: ${formattedIssues}`,
            'Ensure your prompt is between 1 and 2,500 characters and a valid AI model is selected.'
          )
        );
        return;
      }

      const { uid, modelId, message, history, connectedProviders } = parsed.data;

      if (!enforceRateLimitBucket(req, res, 'chat', uid)) {
        return;
      }

      const idCheck = await verifyFirebaseIdTokenHeader({
        idTokenHeader: getIdTokenHeader(req),
        cookieHeader: req.headers.cookie,
        expectedUid: uid,
        requestContext: buildRequestSecurityContext(req)
      });
      if (!idCheck.valid) {
        sendCustomError(
          req,
          res,
          createAuthError(
            idCheck.reason || 'Authentication verification failed.',
            'AUTH_TOKEN_EXPIRED',
            'Your session token expired or did not match your UID. Sign out and sign back in.'
          )
        );
        return;
      }

      const estimatedInputTokens = Math.ceil(
        (message.length + JSON.stringify(history).length) / 4
      );
      const quota = checkAndConsumeRateLimit(uid, modelId, estimatedInputTokens);
      if (!quota.allowed) {
        sendCustomError(
          req,
          res,
          createRateLimitError({
            message: quota.reason || 'Rate limit exceeded.',
            retryAfterSec: quota.retryAfterSec,
            isQuota: true,
            hint: 'Open the Model Selector to pick another active model with remaining 24-hour quota, or wait until 00:00 UTC reset.'
          }),
          {
            quota,
            models: buildModelsListForUser(uid)
          }
        );
        return;
      }

      const authHeader = req.headers.authorization;
      const googleAccessToken =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7).trim()
          : null;

      const result = await runBoundedAgentLoop({
        uid,
        requestedModelId: modelId,
        history,
        userMessage: message,
        connectedProviders: connectedProviders as ConnectorId[],
        googleAccessToken
      });

      const additionalTokens = Math.max(0, result.tokensUsed - estimatedInputTokens);
      addActualTokenUsage(uid, additionalTokens);
      const updatedSnapshot = getUserModelUsageSnapshot(uid);

      res.json({
        reply: result.reply,
        usedModelId: result.usedModelId,
        fallbackNotice: result.fallbackNotice,
        tokensUsed: result.tokensUsed,
        toolTraces: result.toolTraces,
        auditEntries: result.auditEntries,
        pendingAction: result.pendingAction,
        quota: {
          ...quota,
          requestsToday: updatedSnapshot.requestsToday,
          tokensToday: updatedSnapshot.tokensToday,
          modelCountsToday: updatedSnapshot.modelCountsToday,
          providerCountsToday: updatedSnapshot.providerCountsToday
        },
        models: buildModelsListForUser(uid)
      });
    } catch (err) {
      const uidOnErr = typeof req.body?.uid === 'string' ? req.body.uid : undefined;
      console.error('[/api/chat Error]:', redactSensitiveData(err));
      sendCustomError(req, res, err, {
        models: buildModelsListForUser(uidOnErr)
      });
    }
  });

  app.post('/api/actions/confirm', async (req, res) => {
    try {
      const parsed = ConfirmActionSchema.safeParse(req.body);
      if (!parsed.success) {
        const formattedIssues = parsed.error.issues
          .map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`)
          .join(' | ');
        sendCustomError(
          req,
          res,
          createValidationError(`Invalid confirmation payload: ${formattedIssues}`)
        );
        return;
      }

      const {
        uid,
        actionId,
        decision,
        toolName,
        argsPreview,
        argsHash,
        serverSignature,
        expiresAtMs
      } = parsed.data;

      if (!enforceRateLimitBucket(req, res, 'tools', uid)) {
        return;
      }

      const idCheck = await verifyFirebaseIdTokenHeader({
        idTokenHeader: getIdTokenHeader(req),
        cookieHeader: req.headers.cookie,
        expectedUid: uid,
        requestContext: buildRequestSecurityContext(req)
      });
      if (!idCheck.valid) {
        sendCustomError(
          req,
          res,
          createAuthError(idCheck.reason || 'Unauthorized confirmation request.')
        );
        return;
      }

      const now = Date.now();
      for (const [sig, exp] of usedConfirmationSignatures.entries()) {
        if (exp <= now) {
          usedConfirmationSignatures.delete(sig);
        }
      }

      if (usedConfirmationSignatures.has(serverSignature)) {
        sendCustomError(
          req,
          res,
          createConflictError(
            'This confirmation action has already been processed.',
            'FORBIDDEN_ACTION',
            'Each confirmation card can only be approved or rejected once.'
          )
        );
        return;
      }

      if (now > expiresAtMs) {
        sendCustomError(
          req,
          res,
          createGoneError('Confirmation card expired (10-minute TTL elapsed).')
        );
        return;
      }

      const sigValid = verifyPendingActionSignature({
        uid,
        actionId,
        toolName,
        argsHash,
        expiresAtMs,
        signature: serverSignature
      });

      if (!sigValid) {
        sendCustomError(
          req,
          res,
          createForbiddenError(
            'Cryptographic signature mismatch. Action arguments may have been tampered with.',
            'SIGNATURE_TAMPERED',
            'Re-run the prompt in a new turn to generate a fresh signed confirmation card.'
          )
        );
        return;
      }

      let rawArgs: Record<string, unknown>;
      try {
        rawArgs = JSON.parse(argsPreview);
      } catch {
        sendCustomError(req, res, createValidationError('Malformed JSON in argsPreview.'));
        return;
      }

      const recomputedHash = computeArgsHash(rawArgs);
      if (recomputedHash !== argsHash) {
        sendCustomError(
          req,
          res,
          createForbiddenError(
            'SHA-256 argsHash mismatch against argsPreview.',
            'SIGNATURE_TAMPERED'
          )
        );
        return;
      }

      if (usedConfirmationSignatures.size >= MAX_STORE_ENTRIES) {
        const oldestKey = usedConfirmationSignatures.keys().next().value;
        if (oldestKey) usedConfirmationSignatures.delete(oldestKey);
      }
      usedConfirmationSignatures.set(serverSignature, expiresAtMs);

      if (decision === 'reject') {
        res.json({
          status: 'rejected',
          reply: `Action **${toolName}** was rejected by the user. No changes were made.`,
          auditEntry: {
            logId: `log_${crypto.randomBytes(8).toString('hex')}`,
            toolName,
            risk: 'write',
            summary: `User rejected ${toolName}`,
            status: 'rejected',
            durationMs: 0
          }
        });
        return;
      }

      const toolDef = getToolByName(toolName);
      if (!toolDef) {
        sendCustomError(
          req,
          res,
          createNotFoundError(
            `Tool "${toolName}" is not registered.`,
            'TOOL_NOT_REGISTERED',
            'Verify that the connector for this tool is enabled.'
          )
        );
        return;
      }

      const validated = toolDef.zodSchema.safeParse(rawArgs);
      if (!validated.success) {
        sendCustomError(
          req,
          res,
          createValidationError('Confirmed arguments failed schema validation.')
        );
        return;
      }

      const authHeader = req.headers.authorization;
      const googleAccessToken =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7).trim()
          : null;

      const start = Date.now();
      const execResult = await toolDef.execute(validated.data, {
        uid,
        googleAccessToken,
        connectedProviders: [toolDef.connector]
      });
      const durationMs = Date.now() - start;

      if (!execResult.ok) {
        sendCustomError(
          req,
          res,
          new AppError({
            code: 'TOOL_EXECUTION_FAILED',
            statusCode: 502,
            title: `Tool Execution Failed (${toolDef.name})`,
            message: execResult.error || `Failed to execute ${toolDef.name}.`,
            hint: 'Ensure Google Workspace OAuth is connected and has sufficient permissions.'
          }),
          {
            status: 'error',
            auditEntry: {
              logId: `log_${crypto.randomBytes(8).toString('hex')}`,
              toolName: toolDef.name,
              risk: toolDef.risk,
              summary: redactSensitiveData(execResult.auditSummary),
              status: 'error',
              durationMs
            }
          }
        );
        return;
      }

      res.json({
        status: 'executed',
        reply: `Confirmed action **${toolDef.name}** executed: ${redactSensitiveData(execResult.auditSummary)}`,
        data: execResult.data,
        auditEntry: {
          logId: `log_${crypto.randomBytes(8).toString('hex')}`,
          toolName: toolDef.name,
          risk: toolDef.risk,
          summary: redactSensitiveData(execResult.auditSummary),
          status: 'executed',
          durationMs
        }
      });
    } catch (err) {
      sendCustomError(req, res, err);
    }
  });

  app.post('/api/tools/retry', async (req, res) => {
    try {
      const parsed = RetryToolCallSchema.safeParse(req.body);
      if (!parsed.success) {
        sendCustomError(req, res, createValidationError('Invalid tool retry payload.'));
        return;
      }

      const { uid, toolName, args, fallbackPrompt } = parsed.data;

      if (!enforceRateLimitBucket(req, res, 'tools', uid)) {
        return;
      }

      const idCheck = await verifyFirebaseIdTokenHeader({
        idTokenHeader: getIdTokenHeader(req),
        cookieHeader: req.headers.cookie,
        expectedUid: uid,
        requestContext: buildRequestSecurityContext(req)
      });
      if (!idCheck.valid) {
        sendCustomError(
          req,
          res,
          createAuthError(idCheck.reason || 'Unauthorized tool retry request.')
        );
        return;
      }

      const toolDef = getToolByName(toolName);
      if (!toolDef) {
        sendCustomError(
          req,
          res,
          createNotFoundError(
            `Tool "${toolName}" is not registered.`,
            'TOOL_NOT_REGISTERED'
          )
        );
        return;
      }

      let candidateArgs: Record<string, unknown> = {};
      if (typeof args === 'string' && args.trim()) {
        try {
          candidateArgs = JSON.parse(args) as Record<string, unknown>;
        } catch {
          candidateArgs = {};
        }
      } else if (args && typeof args === 'object') {
        candidateArgs = args;
      }

      if (Object.keys(candidateArgs).length === 0 && fallbackPrompt) {
        const cleaned = fallbackPrompt.trim().slice(0, 300);
        if (
          toolName === 'google_search_grounding' ||
          toolName === 'google_maps_grounding' ||
          toolName === 'google_maps_places' ||
          toolName === 'gmail_search' ||
          toolName === 'gmail_search_messages' ||
          toolName === 'drive_search_files'
        ) {
          candidateArgs = { query: cleaned };
        }
      }

      const validated = toolDef.zodSchema.safeParse(candidateArgs);
      if (!validated.success) {
        const issueText = validated.error.issues
          .map((i) => `${i.path.join('.') || 'args'}: ${i.message}`)
          .join('; ');
        sendCustomError(
          req,
          res,
          createValidationError(
            `Cannot retry ${toolDef.name} — original arguments failed validation (${issueText}).`
          )
        );
        return;
      }

      if (toolDef.risk === 'write' || toolDef.risk === 'destructive') {
        const actionId = `act_${crypto.randomBytes(10).toString('hex')}`;
        const argsPreview = canonicalizeArgs(validated.data);
        const argsHash = computeArgsHash(validated.data);
        const expiresAtMs = Date.now() + 10 * 60 * 1000;
        const serverSignature = signPendingAction({
          uid,
          actionId,
          toolName: toolDef.name,
          argsHash,
          expiresAtMs
        });

        res.json({
          ok: true,
          status: 'paused_for_confirm',
          toolName: toolDef.name,
          risk: toolDef.risk,
          durationMs: 0,
          argsJson: argsPreview,
          reply: `Re-prepared **${toolDef.name}** with original arguments. Please review and approve the new confirmation card below.`,
          pendingAction: {
            actionId,
            toolName: toolDef.name,
            risk: toolDef.risk,
            argsPreview,
            argsHash,
            serverSignature,
            warningText:
              toolDef.risk === 'destructive'
                ? 'Destructive / live external action: This action cannot be undone once executed.'
                : 'Review the exact arguments below. Server-enforced SHA-256 verification expires in 10 minutes.',
            expiresAtMs
          },
          auditEntry: {
            logId: `log_${crypto.randomBytes(8).toString('hex')}`,
            toolName: toolDef.name,
            risk: toolDef.risk,
            summary: `Re-queued confirmation for ${toolDef.name}: ${toolDef.summarizeArgs(validated.data)}`,
            status: 'paused_for_confirm',
            durationMs: 0
          }
        });
        return;
      }

      const authHeader = req.headers.authorization;
      const googleAccessToken =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7).trim()
          : null;

      const start = Date.now();
      const execResult = await toolDef.execute(validated.data, {
        uid,
        googleAccessToken,
        connectedProviders: [toolDef.connector]
      });
      const durationMs = Date.now() - start;

      if (!execResult.ok) {
        sendCustomError(
          req,
          res,
          new AppError({
            code: 'TOOL_EXECUTION_FAILED',
            statusCode: 502,
            title: `Tool Retry Failed (${toolDef.name})`,
            message: execResult.error || `Tool ${toolDef.name} retry failed.`,
            hint: 'Check that the required connector is enabled in Connectors and try again.'
          }),
          {
            status: 'error',
            toolName: toolDef.name,
            risk: toolDef.risk,
            durationMs,
            argsJson: canonicalizeArgs(validated.data),
            auditEntry: {
              logId: `log_${crypto.randomBytes(8).toString('hex')}`,
              toolName: toolDef.name,
              risk: toolDef.risk,
              summary: redactSensitiveData(execResult.auditSummary),
              status: 'error',
              durationMs
            }
          }
        );
        return;
      }

      res.json({
        ok: true,
        status: 'success',
        toolName: toolDef.name,
        risk: toolDef.risk,
        durationMs,
        argsJson: canonicalizeArgs(validated.data),
        data: execResult.data,
        reply: `Retried **${toolDef.name}**: ${redactSensitiveData(execResult.auditSummary)}`,
        auditEntry: {
          logId: `log_${crypto.randomBytes(8).toString('hex')}`,
          toolName: toolDef.name,
          risk: toolDef.risk,
          summary: redactSensitiveData(execResult.auditSummary),
          status: 'success',
          durationMs
        }
      });
    } catch (err) {
      sendCustomError(req, res, err);
    }
  });

  app.post('/api/connections/encrypt-token', async (req, res) => {
    const parsed = EncryptDemoSchema.safeParse(req.body);
    if (!parsed.success) {
      sendCustomError(
        req,
        res,
        createValidationError(
          'Invalid token encryption payload. Token must be between 5 and 4,096 characters.'
        )
      );
      return;
    }

    if (!enforceRateLimitBucket(req, res, 'vault', parsed.data.uid)) {
      return;
    }

    const verified = await verifyFirebaseIdTokenHeader({
      idTokenHeader: getIdTokenHeader(req),
      cookieHeader: req.headers.cookie,
      expectedUid: parsed.data.uid,
      requestContext: buildRequestSecurityContext(req)
    });
    if (!verified.valid) {
      sendCustomError(
        req,
        res,
        createAuthError(verified.reason || 'Unauthorized token encryption request.')
      );
      return;
    }

    const encrypted = encryptToken(parsed.data.token);
    const decryptedCheck = decryptToken(encrypted);

    res.json({
      ok: true,
      provider: parsed.data.provider,
      algorithm: 'AES-256-GCM',
      encryptedPayload: {
        ciphertextPreview: `${encrypted.ciphertext.slice(0, 24)}...`,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion
      },
      verifiedRoundtrip: decryptedCheck === parsed.data.token
    });
  });

  app.all('/api/*splat', (req, res) => {
    sendCustomError(
      req,
      res,
      createNotFoundError(
        `API endpoint ${req.method} ${req.originalUrl || req.path} does not exist.`,
        'ENDPOINT_NOT_FOUND',
        'Verify the API endpoint path and HTTP method.'
      )
    );
  });

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    sendCustomError(req, res, err);
  });

async function startServer() {
  assertCryptoConfiguration();
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Pryzmium Server running on http://localhost:${PORT}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${PORT} is already in use.`);
      return;
    }
    console.error('Server startup error:', err);
  });
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;
