import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  clearFirebasePublicKeysForTest,
  createServerSessionToken,
  registerFirebasePublicKeyForTest,
  resolveExpectedFirebaseProjectId,
  verifyFirebaseIdTokenHeader
} from './auth-verify.ts';
import {
  assertCryptoConfiguration,
  decryptToken,
  encryptToken,
  getEncryptionKey
} from './crypto.ts';

function signTestRs256Jwt(params: {
  privateKeyPem: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}): string {
  const headerB64 = Buffer.from(JSON.stringify(params.header), 'utf8').toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(params.payload), 'utf8').toString('base64url');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${headerB64}.${payloadB64}`, 'utf8');
  signer.end();
  const signatureB64 = signer.sign(params.privateKeyPem).toString('base64url');
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

test('rejects missing authentication token even when expectedUid is valid', async () => {
  const result = await verifyFirebaseIdTokenHeader({
    idTokenHeader: undefined,
    cookieHeader: undefined,
    expectedUid: 'usr_valid_user_123'
  });
  assert.equal(result.valid, false);
});

test('accepts a valid server session token and rejects tampered signatures', async () => {
  const token = createServerSessionToken({
    uid: 'usr_alice_01',
    email: 'alice@example.com',
    displayName: 'Alice'
  });

  const validResult = await verifyFirebaseIdTokenHeader({
    idTokenHeader: token,
    expectedUid: 'usr_alice_01'
  });
  assert.equal(validResult.valid, true);
  assert.equal(validResult.uid, 'usr_alice_01');

  const parts = token.split('.');
  const forgedSig = 'a'.repeat(64);
  const tamperedToken = `${parts[0]}.${parts[1]}.${forgedSig}`;

  const tamperedResult = await verifyFirebaseIdTokenHeader({
    idTokenHeader: tamperedToken,
    expectedUid: 'usr_alice_01'
  });
  assert.equal(tamperedResult.valid, false);
});

test('rejects server session token when expectedUid does not match token subject', async () => {
  const token = createServerSessionToken({
    uid: 'usr_alice_01',
    email: 'alice@example.com',
    displayName: 'Alice'
  });

  const mismatchResult = await verifyFirebaseIdTokenHeader({
    idTokenHeader: token,
    expectedUid: 'usr_bob_02'
  });
  assert.equal(mismatchResult.valid, false);
});

test('rejects expired server session token', async () => {
  const expiredToken = createServerSessionToken({
    uid: 'usr_alice_01',
    email: 'alice@example.com',
    displayName: 'Alice',
    ttlSeconds: -60
  });

  const result = await verifyFirebaseIdTokenHeader({
    idTokenHeader: expiredToken,
    expectedUid: 'usr_alice_01'
  });
  assert.equal(result.valid, false);
});

test('verifies RS256 Firebase ID token signature, issuer, audience, and expiration', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const { privateKey: attackerPrivateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const kid = 'test-firebase-kid-2026';
  registerFirebasePublicKeyForTest(kid, publicKey);

  try {
    const projectId = resolveExpectedFirebaseProjectId();
    const nowSec = Math.floor(Date.now() / 1000);

    const validJwt = signTestRs256Jwt({
      privateKeyPem: privateKey,
      header: { alg: 'RS256', kid, typ: 'JWT' },
      payload: {
        iss: `https://securetoken.google.com/${projectId}`,
        aud: projectId,
        sub: 'fb_user_999',
        user_id: 'fb_user_999',
        email: 'operator@example.com',
        iat: nowSec - 30,
        exp: nowSec + 3600
      }
    });

    const okResult = await verifyFirebaseIdTokenHeader({
      idTokenHeader: validJwt,
      expectedUid: 'fb_user_999'
    });
    assert.equal(okResult.valid, true);
    assert.equal(okResult.uid, 'fb_user_999');

    const forgedJwt = signTestRs256Jwt({
      privateKeyPem: attackerPrivateKey,
      header: { alg: 'RS256', kid, typ: 'JWT' },
      payload: {
        iss: `https://securetoken.google.com/${projectId}`,
        aud: projectId,
        sub: 'fb_user_999',
        iat: nowSec - 30,
        exp: nowSec + 3600
      }
    });

    const forgedResult = await verifyFirebaseIdTokenHeader({
      idTokenHeader: forgedJwt,
      expectedUid: 'fb_user_999'
    });
    assert.equal(forgedResult.valid, false);

    const wrongAudienceJwt = signTestRs256Jwt({
      privateKeyPem: privateKey,
      header: { alg: 'RS256', kid, typ: 'JWT' },
      payload: {
        iss: `https://securetoken.google.com/${projectId}`,
        aud: 'wrong-firebase-project',
        sub: 'fb_user_999',
        iat: nowSec - 30,
        exp: nowSec + 3600
      }
    });

    const wrongAudResult = await verifyFirebaseIdTokenHeader({
      idTokenHeader: wrongAudienceJwt,
      expectedUid: 'fb_user_999'
    });
    assert.equal(wrongAudResult.valid, false);

    const expiredJwt = signTestRs256Jwt({
      privateKeyPem: privateKey,
      header: { alg: 'RS256', kid, typ: 'JWT' },
      payload: {
        iss: `https://securetoken.google.com/${projectId}`,
        aud: projectId,
        sub: 'fb_user_999',
        iat: nowSec - 7200,
        exp: nowSec - 60
      }
    });

    const expiredResult = await verifyFirebaseIdTokenHeader({
      idTokenHeader: expiredJwt,
      expectedUid: 'fb_user_999'
    });
    assert.equal(expiredResult.valid, false);
  } finally {
    clearFirebasePublicKeysForTest();
  }
});

test('enforces mandatory TOKEN_ENCRYPTION_KEY in production and roundtrips AES-256-GCM', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevKey = process.env.TOKEN_ENCRYPTION_KEY;

  try {
    process.env.NODE_ENV = 'production';
    delete process.env.TOKEN_ENCRYPTION_KEY;
    assert.throws(() => assertCryptoConfiguration(), /TOKEN_ENCRYPTION_KEY/);
    assert.throws(() => getEncryptionKey(), /TOKEN_ENCRYPTION_KEY/);

    process.env.TOKEN_ENCRYPTION_KEY = 'short-key';
    assert.throws(() => assertCryptoConfiguration(), /at least 16 characters/);

    process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    const encrypted = encryptToken('oauth-secret-refresh-token');
    assert.equal(decryptToken(encrypted), 'oauth-secret-refresh-token');
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
    if (prevKey === undefined) {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.TOKEN_ENCRYPTION_KEY = prevKey;
    }
  }
});
