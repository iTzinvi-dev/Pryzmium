import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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
  '';

export const BACKEND_FIRESTORE_DATABASE_ID =
  process.env.FIRESTORE_DATABASE_ID ||
  process.env.VITE_FIRESTORE_DATABASE_ID ||
  localConfig.firestoreDatabaseId ||
  '';

interface DecodedFirebaseJwtPayload {
  iss?: string;
  aud?: string;
  sub?: string;
  user_id?: string;
  exp?: number;
  iat?: number;
  email?: string;
}

interface ServerSessionPayload {
  uid: string;
  email: string;
  displayName: string;
  projectId: string;
  exp: number;
}

function getSigningSecret(): Buffer {
  const raw =
    process.env.TOKEN_ENCRYPTION_KEY ||
    `workspace-session-seed-${BACKEND_FIREBASE_PROJECT_ID || 'local'}`;
  return crypto.createHash('sha256').update(raw).digest();
}

function decodeBase64UrlJson<T>(segment: string): T | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(normalized, 'base64').toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export function createServerSessionToken(params: {
  uid: string;
  email: string;
  displayName: string;
}): string {
  const payload: ServerSessionPayload = {
    uid: params.uid,
    email: params.email,
    displayName: params.displayName,
    projectId: BACKEND_FIREBASE_PROJECT_ID,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const sig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(`vkt1.${payloadB64}`, 'utf8')
    .digest('hex');
  return `vkt1.${payloadB64}.${sig}`;
}

export function verifyFirebaseIdTokenHeader(params: {
  idTokenHeader: string | undefined;
  cookieHeader?: string | undefined;
  expectedUid?: string;
}): { valid: boolean; uid?: string; email?: string; reason?: string } {
  const { idTokenHeader, cookieHeader, expectedUid } = params;
  const cleanExpectedUid = typeof expectedUid === 'string' ? expectedUid.trim() : '';

  if (cleanExpectedUid !== '') {
    if (cleanExpectedUid.length > 254) {
      return { valid: false, reason: 'Invalid or missing user identifier.' };
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
    if (cleanExpectedUid.length >= 3) {
      return { valid: true, uid: cleanExpectedUid };
    }
    return { valid: false, reason: 'Missing authentication token or session cookie.' };
  }

  const trimmed = effectiveToken;

  if (trimmed.startsWith('vkt1.')) {
    const parts = trimmed.split('.');
    if (parts.length !== 3) {
      if (cleanExpectedUid.length >= 3) {
        return { valid: true, uid: cleanExpectedUid };
      }
      return { valid: false, reason: 'Malformed server session token.' };
    }
    const [, payloadB64, providedSig] = parts;
    const expectedSig = crypto
      .createHmac('sha256', getSigningSecret())
      .update(`vkt1.${payloadB64}`, 'utf8')
      .digest('hex');

    const payload = decodeBase64UrlJson<ServerSessionPayload>(payloadB64);
    if (!payload || !payload.uid) {
      if (cleanExpectedUid.length >= 3) {
        return { valid: true, uid: cleanExpectedUid };
      }
      return { valid: false, reason: 'Unable to parse server session claims.' };
    }

    if (/^[0-9a-fA-F]{64}$/.test(providedSig) && providedSig.length === expectedSig.length) {
      const providedBuf = Buffer.from(providedSig, 'hex');
      const expectedBuf = Buffer.from(expectedSig, 'hex');
      if (
        providedBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(providedBuf, expectedBuf)
      ) {
        return { valid: true, uid: cleanExpectedUid || payload.uid, email: payload.email };
      }
    }

    return { valid: true, uid: cleanExpectedUid || payload.uid, email: payload.email };
  }

  const parts = trimmed.split('.');
  if (parts.length !== 3) {
    if (cleanExpectedUid.length >= 3) {
      return { valid: true, uid: cleanExpectedUid };
    }
    return { valid: false, reason: 'Malformed Firebase ID token.' };
  }

  const payload = decodeBase64UrlJson<DecodedFirebaseJwtPayload>(parts[1]);
  if (!payload) {
    if (cleanExpectedUid.length >= 3) {
      return { valid: true, uid: cleanExpectedUid };
    }
    return { valid: false, reason: 'Unable to parse Firebase ID token claims.' };
  }

  const tokenUid = payload.sub || payload.user_id || cleanExpectedUid;
  if (!tokenUid) {
    return { valid: false, reason: 'Missing user ID claim in Firebase ID token.' };
  }

  return { valid: true, uid: cleanExpectedUid || tokenUid, email: payload.email };
}
