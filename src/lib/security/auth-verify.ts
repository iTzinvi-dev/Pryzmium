import crypto from 'crypto';
import fs from 'fs';
import net from 'node:net';
import path from 'path';
import { getEncryptionKey } from './crypto.ts';

const GOOGLE_SECURETOKEN_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const DEFAULT_PROJECT_ID = 'pryzmium-ai-agent';
const DEFAULT_CERTS_TTL_MS = 60 * 60 * 1000;
const MIN_CERTS_REFRESH_INTERVAL_MS = 60 * 1000;

function readLocalAppletConfig(): { projectId?: string; firestoreDatabaseId?: string } {
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        projectId?: string;
        firestoreDatabaseId?: string;
      };
    }
  } catch {
    return {};
  }
  return {};
}

const localConfig = readLocalAppletConfig();

export const BACKEND_FIREBASE_PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.VITE_FIREBASE_PROJECT_ID ||
  localConfig.projectId ||
  DEFAULT_PROJECT_ID;

export const BACKEND_FIRESTORE_DATABASE_ID =
  process.env.FIRESTORE_DATABASE_ID ||
  process.env.VITE_FIRESTORE_DATABASE_ID ||
  localConfig.firestoreDatabaseId ||
  '';

export function resolveExpectedFirebaseProjectId(): string {
  return (
    (process.env.FIREBASE_PROJECT_ID || '').trim() ||
    (process.env.VITE_FIREBASE_PROJECT_ID || '').trim() ||
    (localConfig.projectId || '').trim() ||
    DEFAULT_PROJECT_ID
  );
}

export interface RequestSecurityContext {
  method?: string;
  originHeader?: string | undefined;
  refererHeader?: string | undefined;
  hostHeader?: string | undefined;
  secFetchSiteHeader?: string | undefined;
  userAgentHeader?: string | undefined;
}

export interface OriginVerificationResult {
  allowed: boolean;
  reason?: string;
}

function normalizeIpAddress(rawIp: string | undefined): string {
  if (!rawIp || typeof rawIp !== 'string') {
    return '';
  }
  const trimmed = rawIp.trim();
  if (!trimmed) {
    return '';
  }
  const withoutZone = trimmed.includes('%') ? trimmed.split('%')[0] : trimmed;
  if (withoutZone.toLowerCase().startsWith('::ffff:')) {
    const mappedIpv4 = withoutZone.slice(7);
    if (net.isIP(mappedIpv4) === 4) {
      return mappedIpv4;
    }
  }
  return net.isIP(withoutZone) !== 0 ? withoutZone : '';
}

function isTrustedProxyPeer(ip: string): boolean {
  if (!ip) {
    return false;
  }
  if (ip === '127.0.0.1' || ip === '::1') {
    return true;
  }
  if (net.isIP(ip) === 4) {
    const octets = ip.split('.').map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((n) => !Number.isFinite(n))) {
      return false;
    }
    if (octets[0] === 10 || octets[0] === 127) {
      return true;
    }
    if (octets[0] === 192 && octets[1] === 168) {
      return true;
    }
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
      return true;
    }
    if (octets[0] === 169 && octets[1] === 254) {
      return true;
    }
    return false;
  }
  const lower = ip.toLowerCase();
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
}

export const DEFAULT_ALLOWED_ORIGINS = [
  'https://ais-dev-nsto32mkvjcqoiezkyx4qe-957588401103.asia-southeast1.run.app',
  'https://ais-pre-nsto32mkvjcqoiezkyx4qe-957588401103.asia-southeast1.run.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
] as const;

export function resolveConfiguredTrustProxyHops(explicitHops?: number): number {
  if (typeof explicitHops === 'number' && Number.isFinite(explicitHops)) {
    return Math.max(0, Math.min(5, Math.floor(explicitHops)));
  }
  const rawEnv = (process.env.TRUST_PROXY_HOPS || '').trim();
  if (rawEnv !== '') {
    const parsed = Number.parseInt(rawEnv, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(5, parsed));
    }
  }
  if (process.env.K_SERVICE || process.env.VERCEL || process.env.RENDER) {
    return 1;
  }
  return 0;
}

export function extractTrustedClientIp(params: {
  socketRemoteAddress?: string | undefined;
  forwardedForHeader?: string | string[] | undefined;
  trustProxyHops?: number;
}): string {
  const socketIp = normalizeIpAddress(params.socketRemoteAddress);
  const configuredHops = resolveConfiguredTrustProxyHops(params.trustProxyHops);

  if (
    configuredHops >= 1 &&
    configuredHops <= 5 &&
    isTrustedProxyPeer(socketIp)
  ) {
    const rawForwarded = Array.isArray(params.forwardedForHeader)
      ? params.forwardedForHeader.join(',')
      : params.forwardedForHeader;

    if (typeof rawForwarded === 'string' && rawForwarded.trim()) {
      const chain = rawForwarded
        .split(',')
        .map((entry) => normalizeIpAddress(entry))
        .filter(Boolean);

      if (chain.length > 0) {
        const targetIndex = Math.max(0, chain.length - configuredHops);
        const candidate = chain[targetIndex];
        if (candidate) {
          return candidate.slice(0, 64);
        }
      }
    }
  }

  return (socketIp || 'local').slice(0, 64);
}

export function normalizeHostHeader(rawHost: string | undefined): string {
  if (!rawHost || typeof rawHost !== 'string') {
    return '';
  }
  const firstHost = rawHost.split(',')[0].trim().toLowerCase();
  if (!firstHost || !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(firstHost)) {
    return '';
  }
  return firstHost;
}

function extractHostFromUrlHeader(rawUrl: string | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.toLowerCase() === 'null') {
    return 'null';
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'null';
    }
    return parsed.host.toLowerCase();
  } catch {
    return 'null';
  }
}

function getAllowedHostsSet(hostHeader: string | undefined): Set<string> {
  const allowed = new Set<string>();
  const primaryHost = normalizeHostHeader(hostHeader);
  if (primaryHost) {
    allowed.add(primaryHost);
  }
  const envOrigins = (process.env.ALLOWED_ORIGINS || '').trim();
  const rawList = envOrigins
    ? envOrigins.split(',')
    : primaryHost
      ? []
      : [...DEFAULT_ALLOWED_ORIGINS];

  for (const item of rawList) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const parsedHost = extractHostFromUrlHeader(trimmed);
    if (parsedHost && parsedHost !== 'null') {
      allowed.add(parsedHost);
    } else {
      const normalized = normalizeHostHeader(trimmed);
      if (normalized) {
        allowed.add(normalized);
      }
    }
  }
  return allowed;
}

function computeUserAgentHash(userAgent: string | undefined): string {
  if (!userAgent || typeof userAgent !== 'string') {
    return '';
  }
  const trimmed = userAgent.trim();
  if (!trimmed) {
    return '';
  }
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 32);
}

export function verifyRequestOriginAndContext(
  context: RequestSecurityContext,
  options?: { requireSameOriginProof?: boolean }
): OriginVerificationResult {
  const method = (context.method || 'GET').toUpperCase();
  const isStateChanging =
    method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const allowedHosts = getAllowedHostsSet(context.hostHeader);

  const originHost = extractHostFromUrlHeader(context.originHeader);
  if (originHost !== null) {
    if (originHost === 'null') {
      return {
        allowed: false,
        reason: 'Requests with an opaque or null Origin header are not permitted.'
      };
    }
    if (allowedHosts.size > 0 && !allowedHosts.has(originHost)) {
      return {
        allowed: false,
        reason: 'Request Origin header does not match the authorized application host.'
      };
    }
  }

  const refererHost = extractHostFromUrlHeader(context.refererHeader);
  if (refererHost !== null) {
    if (refererHost === 'null') {
      return {
        allowed: false,
        reason: 'Request Referer header is malformed or uses an unsupported scheme.'
      };
    }
    if (allowedHosts.size > 0 && !allowedHosts.has(refererHost)) {
      return {
        allowed: false,
        reason: 'Request Referer header does not match the authorized application host.'
      };
    }
  }

  const secFetchSite =
    typeof context.secFetchSiteHeader === 'string'
      ? context.secFetchSiteHeader.trim().toLowerCase()
      : '';

  const hasMatchingOrigin =
    originHost !== null &&
    originHost !== 'null' &&
    allowedHosts.size > 0 &&
    allowedHosts.has(originHost);

  const hasMatchingReferer =
    refererHost !== null &&
    refererHost !== 'null' &&
    allowedHosts.size > 0 &&
    allowedHosts.has(refererHost);

  if (secFetchSite === 'cross-site' && !hasMatchingOrigin) {
    return {
      allowed: false,
      reason: 'Cross-site request blocked by Fetch Metadata policy.'
    };
  }

  if (options?.requireSameOriginProof && isStateChanging) {
    const hasSameOriginFetchSite = secFetchSite === 'same-origin';
    if (!hasMatchingOrigin && !hasMatchingReferer && !hasSameOriginFetchSite) {
      return {
        allowed: false,
        reason:
          'Cookie-authenticated state-changing request requires same-origin Origin or Referer verification.'
      };
    }
  }

  return { allowed: true };
}

export function buildSessionCookieHeader(
  sessionToken: string,
  options?: { maxAgeSec?: number; isSecure?: boolean }
): string {
  const maxAge =
    typeof options?.maxAgeSec === 'number' && Number.isFinite(options.maxAgeSec)
      ? Math.max(0, Math.floor(options.maxAgeSec))
      : 7 * 24 * 3600;
  const isSecure =
    typeof options?.isSecure === 'boolean'
      ? options.isSecure
      : process.env.NODE_ENV === 'production';

  const parts = [
    `vektor_session=${encodeURIComponent(sessionToken)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (isSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function buildClearSessionCookieHeader(options?: { isSecure?: boolean }): string {
  const isSecure =
    typeof options?.isSecure === 'boolean'
      ? options.isSecure
      : process.env.NODE_ENV === 'production';

  const parts = ['vektor_session=', 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (isSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function buildContentSecurityPolicyHeader(): string {
  return [
    "default-src 'self'",
    "script-src 'self' https://apis.google.com https://accounts.google.com",
    "script-src-attr 'none'",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.firebaseapp.com wss://*.firebaseio.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.cdnfonts.com",
    "font-src 'self' data: https://fonts.gstatic.com https://fonts.cdnfonts.com",
    "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');
}

interface DecodedJwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface DecodedFirebaseJwtPayload {
  iss?: string;
  aud?: string;
  sub?: string;
  user_id?: string;
  exp?: number;
  iat?: number;
  auth_time?: number;
  email?: string;
}

export interface ServerSessionPayload {
  uid: string;
  email: string;
  displayName: string;
  projectId: string;
  originHost?: string;
  uaHash?: string;
  iat: number;
  exp: number;
}

export interface TokenVerificationResult {
  valid: boolean;
  uid?: string;
  email?: string;
  reason?: string;
}

let cachedGoogleCerts: Record<string, string> = {};
let cachedCertsExpiresAtMs = 0;
let lastCertsFetchMs = 0;
const customPublicKeysForTest = new Map<string, string>();

export function registerFirebasePublicKeyForTest(kid: string, publicKeyPem: string): void {
  customPublicKeysForTest.set(kid, publicKeyPem);
}

export function clearFirebasePublicKeysForTest(): void {
  customPublicKeysForTest.clear();
}

async function getFirebaseSigningKeyPem(kid: string): Promise<string | null> {
  if (customPublicKeysForTest.has(kid)) {
    return customPublicKeysForTest.get(kid) || null;
  }

  const now = Date.now();
  if (now < cachedCertsExpiresAtMs && cachedGoogleCerts[kid]) {
    return cachedGoogleCerts[kid];
  }

  if (now - lastCertsFetchMs < MIN_CERTS_REFRESH_INTERVAL_MS && cachedGoogleCerts[kid]) {
    return cachedGoogleCerts[kid];
  }

  try {
    lastCertsFetchMs = now;
    const response = await fetch(GOOGLE_SECURETOKEN_CERTS_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      return cachedGoogleCerts[kid] || null;
    }

    const certs = (await response.json()) as Record<string, string>;
    if (certs && typeof certs === 'object') {
      cachedGoogleCerts = certs;
      const cacheControl = response.headers.get('cache-control') || '';
      const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
      const maxAgeSec = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
      const ttlMs =
        Number.isFinite(maxAgeSec) && maxAgeSec > 60
          ? maxAgeSec * 1000
          : DEFAULT_CERTS_TTL_MS;
      cachedCertsExpiresAtMs = now + ttlMs;
    }
  } catch {
    return cachedGoogleCerts[kid] || null;
  }

  return cachedGoogleCerts[kid] || null;
}

function decodeBase64UrlJson<T>(segment: string): T | null {
  try {
    if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) {
      return null;
    }
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export function createServerSessionToken(params: {
  uid: string;
  email: string;
  displayName: string;
  ttlSeconds?: number;
  originHost?: string;
  userAgent?: string;
}): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const ttl =
    typeof params.ttlSeconds === 'number' && Number.isFinite(params.ttlSeconds)
      ? Math.floor(params.ttlSeconds)
      : 7 * 24 * 3600;

  const normalizedOriginHost = normalizeHostHeader(params.originHost);
  const uaHash = computeUserAgentHash(params.userAgent);

  const payload: ServerSessionPayload = {
    uid: params.uid.trim(),
    email: params.email.trim().toLowerCase(),
    displayName: params.displayName.trim(),
    projectId: resolveExpectedFirebaseProjectId(),
    ...(normalizedOriginHost ? { originHost: normalizedOriginHost } : {}),
    ...(uaHash ? { uaHash } : {}),
    iat: nowSec,
    exp: nowSec + ttl
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getEncryptionKey())
    .update(`vkt1.${payloadB64}`, 'utf8')
    .digest('hex');

  return `vkt1.${payloadB64}.${sig}`;
}

function verifyServerSessionToken(
  token: string,
  cleanExpectedUid: string,
  requestContext?: RequestSecurityContext
): TokenVerificationResult {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'vkt1') {
    return { valid: false, reason: 'Malformed server session token.' };
  }

  const [, payloadB64, providedSig] = parts;
  if (!payloadB64 || !providedSig || !/^[0-9a-fA-F]{64}$/.test(providedSig)) {
    return { valid: false, reason: 'Invalid server session token signature format.' };
  }

  const expectedSig = crypto
    .createHmac('sha256', getEncryptionKey())
    .update(`vkt1.${payloadB64}`, 'utf8')
    .digest('hex');

  const providedBuf = Buffer.from(providedSig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return { valid: false, reason: 'Invalid server session token cryptographic signature.' };
  }

  const payload = decodeBase64UrlJson<ServerSessionPayload>(payloadB64);
  if (!payload || typeof payload.uid !== 'string' || payload.uid.trim().length < 3) {
    return { valid: false, reason: 'Unable to parse server session claims.' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= nowSec) {
    return { valid: false, reason: 'Server session token has expired.' };
  }

  if (typeof payload.iat === 'number' && payload.iat > nowSec + 300) {
    return { valid: false, reason: 'Server session token issue timestamp is invalid.' };
  }

  const expectedProjectId = resolveExpectedFirebaseProjectId();
  if (payload.projectId && payload.projectId !== expectedProjectId) {
    return { valid: false, reason: 'Server session token project binding mismatch.' };
  }

  if (payload.originHost && requestContext?.hostHeader) {
    const currentHost = normalizeHostHeader(requestContext.hostHeader);
    if (currentHost && currentHost !== payload.originHost) {
      return {
        valid: false,
        reason: 'Server session token host binding does not match request host.'
      };
    }
  }

  if (payload.uaHash && requestContext?.userAgentHeader) {
    const currentUaHash = computeUserAgentHash(requestContext.userAgentHeader);
    if (currentUaHash && currentUaHash !== payload.uaHash) {
      return {
        valid: false,
        reason: 'Server session token client context (User-Agent) mismatch.'
      };
    }
  }

  const tokenUid = payload.uid.trim();
  const tokenEmail = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';

  if (cleanExpectedUid) {
    const matchesUid = tokenUid === cleanExpectedUid;
    const matchesEmail = Boolean(tokenEmail) && tokenEmail === cleanExpectedUid.toLowerCase();
    if (!matchesUid && !matchesEmail) {
      return {
        valid: false,
        reason: 'Authenticated session token UID does not match requested user identifier.'
      };
    }
  }

  return {
    valid: true,
    uid: tokenUid,
    email: tokenEmail || undefined
  };
}

async function verifyFirebaseJwtToken(
  token: string,
  cleanExpectedUid: string
): Promise<TokenVerificationResult> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { valid: false, reason: 'Malformed Firebase ID token.' };
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeBase64UrlJson<DecodedJwtHeader>(headerB64);
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid.trim()) {
    return {
      valid: false,
      reason: 'Invalid Firebase ID token header: RS256 algorithm and key ID (kid) are required.'
    };
  }

  const payload = decodeBase64UrlJson<DecodedFirebaseJwtPayload>(payloadB64);
  if (!payload) {
    return { valid: false, reason: 'Unable to parse Firebase ID token claims.' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= nowSec) {
    return { valid: false, reason: 'Firebase ID token has expired.' };
  }

  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > nowSec + 300) {
    return { valid: false, reason: 'Firebase ID token issue timestamp (iat) is invalid.' };
  }

  if (typeof payload.auth_time === 'number' && payload.auth_time > nowSec + 300) {
    return { valid: false, reason: 'Firebase ID token auth_time claim is in the future.' };
  }

  const expectedProjectId = resolveExpectedFirebaseProjectId();
  const expectedIssuer = `https://securetoken.google.com/${expectedProjectId}`;

  if (payload.aud !== expectedProjectId) {
    return {
      valid: false,
      reason: 'Firebase ID token audience (aud) does not match configured Firebase project.'
    };
  }

  if (payload.iss !== expectedIssuer) {
    return {
      valid: false,
      reason: 'Firebase ID token issuer (iss) does not match configured Firebase project.'
    };
  }

  const subClaim = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  const userIdClaim = typeof payload.user_id === 'string' ? payload.user_id.trim() : '';
  if (!subClaim || subClaim.length > 128) {
    return { valid: false, reason: 'Missing or invalid subject (sub) claim in Firebase ID token.' };
  }
  if (userIdClaim && userIdClaim !== subClaim) {
    return { valid: false, reason: 'Firebase ID token user_id does not match subject (sub).' };
  }

  const tokenEmail = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (cleanExpectedUid) {
    const matchesUid = subClaim === cleanExpectedUid;
    const matchesEmail = Boolean(tokenEmail) && tokenEmail === cleanExpectedUid.toLowerCase();
    if (!matchesUid && !matchesEmail) {
      return {
        valid: false,
        reason: 'Firebase ID token subject (sub) does not match requested user identifier.'
      };
    }
  }

  const publicKeyPem = await getFirebaseSigningKeyPem(header.kid.trim());
  if (!publicKeyPem) {
    return {
      valid: false,
      reason: 'Unable to resolve trusted Google signing certificate for token key ID (kid).'
    };
  }

  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`, 'utf8');
    verifier.end();
    const signatureBytes = Buffer.from(signatureB64, 'base64url');
    const isSignatureValid = verifier.verify(publicKeyPem, signatureBytes);
    if (!isSignatureValid) {
      return {
        valid: false,
        reason: 'Invalid Firebase ID token RS256 cryptographic signature.'
      };
    }
  } catch {
    return {
      valid: false,
      reason: 'Failed to verify Firebase ID token cryptographic signature.'
    };
  }

  return {
    valid: true,
    uid: subClaim,
    email: tokenEmail || undefined
  };
}

export async function verifyFirebaseIdTokenHeader(params: {
  idTokenHeader: string | undefined;
  cookieHeader?: string | undefined;
  expectedUid?: string;
  requestContext?: RequestSecurityContext;
}): Promise<TokenVerificationResult> {
  const { idTokenHeader, cookieHeader, expectedUid, requestContext } = params;
  const cleanExpectedUid = typeof expectedUid === 'string' ? expectedUid.trim() : '';

  if (cleanExpectedUid !== '') {
    if (cleanExpectedUid.length < 3 || cleanExpectedUid.length > 254) {
      return { valid: false, reason: 'Invalid user identifier length.' };
    }
    if (!/^[a-zA-Z0-9_.:@-]+$/.test(cleanExpectedUid)) {
      return { valid: false, reason: 'User identifier contains invalid characters.' };
    }
  }

  const explicitHeaderToken =
    idTokenHeader && typeof idTokenHeader === 'string' ? idTokenHeader.trim() : '';
  let effectiveToken = explicitHeaderToken;
  let usingCookieFallback = false;

  if (!effectiveToken && cookieHeader && typeof cookieHeader === 'string') {
    const match = cookieHeader.match(/(?:^|;\s*)vektor_session=([^;]+)/);
    if (match && match[1]) {
      usingCookieFallback = true;
      try {
        effectiveToken = decodeURIComponent(match[1].trim());
      } catch {
        effectiveToken = match[1].trim();
      }
    }
  }

  if (!effectiveToken) {
    return { valid: false, reason: 'Missing authentication token or session cookie.' };
  }

  if (requestContext) {
    const originCheck = verifyRequestOriginAndContext(requestContext, {
      requireSameOriginProof: usingCookieFallback
    });
    if (!originCheck.allowed) {
      return {
        valid: false,
        reason: originCheck.reason || 'Request origin or browser context verification failed.'
      };
    }
  }

  if (effectiveToken.startsWith('vkt1.')) {
    return verifyServerSessionToken(effectiveToken, cleanExpectedUid, requestContext);
  }

  return verifyFirebaseJwtToken(effectiveToken, cleanExpectedUid);
}


