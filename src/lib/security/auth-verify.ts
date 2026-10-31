import crypto from 'crypto';
import fs from 'fs';
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
}): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const ttl =
    typeof params.ttlSeconds === 'number' && Number.isFinite(params.ttlSeconds)
      ? Math.floor(params.ttlSeconds)
      : 7 * 24 * 3600;

  const payload: ServerSessionPayload = {
    uid: params.uid.trim(),
    email: params.email.trim().toLowerCase(),
    displayName: params.displayName.trim(),
    projectId: resolveExpectedFirebaseProjectId(),
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
  cleanExpectedUid: string
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
}): Promise<TokenVerificationResult> {
  const { idTokenHeader, cookieHeader, expectedUid } = params;
  const cleanExpectedUid = typeof expectedUid === 'string' ? expectedUid.trim() : '';

  if (cleanExpectedUid !== '') {
    if (cleanExpectedUid.length < 3 || cleanExpectedUid.length > 254) {
      return { valid: false, reason: 'Invalid user identifier length.' };
    }
    if (!/^[a-zA-Z0-9_.:@-]+$/.test(cleanExpectedUid)) {
      return { valid: false, reason: 'User identifier contains invalid characters.' };
    }
  }

  let effectiveToken =
    idTokenHeader && typeof idTokenHeader === 'string' ? idTokenHeader.trim() : '';

  if (!effectiveToken && cookieHeader && typeof cookieHeader === 'string') {
    const match = cookieHeader.match(/(?:^|;\s*)vektor_session=([^;]+)/);
    if (match && match[1]) {
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

  if (effectiveToken.startsWith('vkt1.')) {
    return verifyServerSessionToken(effectiveToken, cleanExpectedUid);
  }

  return verifyFirebaseJwtToken(effectiveToken, cleanExpectedUid);
}

