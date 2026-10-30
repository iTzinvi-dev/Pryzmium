import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const rawKey = process.env.TOKEN_ENCRYPTION_KEY || '';
  if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }
  return crypto.createHash('sha256').update(rawKey || 'vektor-agent-default-kms-seed-2026').digest();
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export function encryptToken(plaintext: string): EncryptedPayload {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    keyVersion: 1
  };
}

export function decryptToken(payload: EncryptedPayload): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(payload.iv, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = sortDeep(obj[key]);
    }
    return result;
  }
  return value;
}

export function canonicalizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(sortDeep(args));
}

export function computeArgsHash(args: Record<string, unknown>): string {
  const canonical = canonicalizeArgs(args);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function signPendingAction(params: {
  uid: string;
  actionId: string;
  toolName: string;
  argsHash: string;
  expiresAtMs: number;
}): string {
  const key = getEncryptionKey();
  const message = `${params.uid}:${params.actionId}:${params.toolName}:${params.argsHash}:${params.expiresAtMs}`;
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

export function verifyPendingActionSignature(params: {
  uid: string;
  actionId: string;
  toolName: string;
  argsHash: string;
  expiresAtMs: number;
  signature: string;
}): boolean {
  if (!params.signature || !/^[0-9a-fA-F]{64}$/.test(params.signature)) {
    return false;
  }
  const expected = signPendingAction(params);
  if (expected.length !== params.signature.length) {
    return false;
  }
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(params.signature, 'hex');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}
