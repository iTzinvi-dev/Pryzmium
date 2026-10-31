import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  buildClearSessionCookieHeader,
  buildContentSecurityPolicyHeader,
  buildSessionCookieHeader,
  clearFirebasePublicKeysForTest,
  createServerSessionToken,
  extractTrustedClientIp,
  registerFirebasePublicKeyForTest,
  resolveExpectedFirebaseProjectId,
  verifyFirebaseIdTokenHeader,
  verifyRequestOriginAndContext
} from './auth-verify.ts';
import {
  assertCryptoConfiguration,
  decryptToken,
  encryptToken,
  getEncryptionKey
} from './crypto.ts';

const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

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
  process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  const result = await verifyFirebaseIdTokenHeader({
    idTokenHeader: undefined,
    cookieHeader: undefined,
    expectedUid: 'usr_valid_user_123'
  });
  assert.equal(result.valid, false);
});

test('accepts a valid server session token and rejects tampered signatures', async () => {
  process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
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
  process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
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
  process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
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
  process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
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

test('getEncryptionKey() unconditionally throws if TOKEN_ENCRYPTION_KEY is undefined, empty, or too short', () => {
  const prevKey = process.env.TOKEN_ENCRYPTION_KEY;

  try {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    assert.throws(() => getEncryptionKey(), /TOKEN_ENCRYPTION_KEY environment variable is not defined/);
    assert.throws(() => assertCryptoConfiguration(), /TOKEN_ENCRYPTION_KEY environment variable is not defined/);

    process.env.TOKEN_ENCRYPTION_KEY = '   ';
    assert.throws(() => getEncryptionKey(), /TOKEN_ENCRYPTION_KEY environment variable is not defined/);

    process.env.TOKEN_ENCRYPTION_KEY = 'too-short-key';
    assert.throws(() => getEncryptionKey(), /must be at least 32 characters/);

    process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    const encrypted = encryptToken('oauth-secret-refresh-token');
    assert.equal(decryptToken(encrypted), 'oauth-secret-refresh-token');
  } finally {
    if (prevKey === undefined) {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.TOKEN_ENCRYPTION_KEY = prevKey;
    }
  }
});

test('extractTrustedClientIp ignores spoofed X-Forwarded-For by default and uses right-most hop when trusted proxy is configured', () => {
  const directUntrusted = extractTrustedClientIp({
    socketRemoteAddress: '::ffff:198.51.100.42',
    forwardedForHeader: '203.0.113.1, 203.0.113.2',
    trustProxyHops: 0
  });
  assert.equal(directUntrusted, '198.51.100.42');

  const spoofedFromPublicPeerEvenWithHops = extractTrustedClientIp({
    socketRemoteAddress: '198.51.100.42',
    forwardedForHeader: '203.0.113.99',
    trustProxyHops: 1
  });
  assert.equal(spoofedFromPublicPeerEvenWithHops, '198.51.100.42');

  const behindTrustedProxyWithSpoofedPrefix = extractTrustedClientIp({
    socketRemoteAddress: '10.0.0.5',
    forwardedForHeader: '1.2.3.4, 198.51.100.77',
    trustProxyHops: 1
  });
  assert.equal(behindTrustedProxyWithSpoofedPrefix, '198.51.100.77');
});

test('session cookies use SameSite=Lax and HttpOnly instead of SameSite=None', () => {
  const sessionCookie = buildSessionCookieHeader('vkt1.test.sig', {
    maxAgeSec: 3600,
    isSecure: true
  });
  assert.match(sessionCookie, /HttpOnly/);
  assert.match(sessionCookie, /SameSite=Lax/);
  assert.doesNotMatch(sessionCookie, /SameSite=None/i);

  const clearCookie = buildClearSessionCookieHeader({ isSecure: true });
  assert.match(clearCookie, /Max-Age=0/);
  assert.match(clearCookie, /SameSite=Lax/);
  assert.doesNotMatch(clearCookie, /SameSite=None/i);
});

test('Content-Security-Policy header removes unsafe-inline and unsafe-eval from script-src', () => {
  const csp = buildContentSecurityPolicyHeader();
  const scriptSrcDirective = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('script-src '));

  assert.ok(scriptSrcDirective, 'script-src directive must be present');
  assert.doesNotMatch(scriptSrcDirective, /'unsafe-inline'/);
  assert.doesNotMatch(scriptSrcDirective, /'unsafe-eval'/);
  assert.match(csp, /script-src-attr 'none'/);
  assert.match(csp, /form-action 'self'/);
});

test('enforces CSRF Origin/Referer validation and binds server session tokens to host and User-Agent', async () => {
  process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

  const crossOriginCheck = verifyRequestOriginAndContext({
    method: 'POST',
    hostHeader: 'app.pryzmium.dev',
    originHeader: 'https://evil-attacker.example',
    secFetchSiteHeader: 'cross-site'
  });
  assert.equal(crossOriginCheck.allowed, false);

  const boundToken = createServerSessionToken({
    uid: 'usr_bound_01',
    email: 'bound@example.com',
    displayName: 'Bound User',
    originHost: 'app.pryzmium.dev',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
  });

  const cookieWithoutOriginOnPost = await verifyFirebaseIdTokenHeader({
    idTokenHeader: undefined,
    cookieHeader: `vektor_session=${encodeURIComponent(boundToken)}`,
    expectedUid: 'usr_bound_01',
    requestContext: {
      method: 'POST',
      hostHeader: 'app.pryzmium.dev'
    }
  });
  assert.equal(cookieWithoutOriginOnPost.valid, false);

  const cookieFromEvilOrigin = await verifyFirebaseIdTokenHeader({
    idTokenHeader: undefined,
    cookieHeader: `vektor_session=${encodeURIComponent(boundToken)}`,
    expectedUid: 'usr_bound_01',
    requestContext: {
      method: 'POST',
      hostHeader: 'app.pryzmium.dev',
      originHeader: 'https://evil.example',
      secFetchSiteHeader: 'cross-site'
    }
  });
  assert.equal(cookieFromEvilOrigin.valid, false);

  const wrongHostReplay = await verifyFirebaseIdTokenHeader({
    idTokenHeader: boundToken,
    expectedUid: 'usr_bound_01',
    requestContext: {
      method: 'POST',
      hostHeader: 'other-host.example.com',
      originHeader: 'https://other-host.example.com',
      userAgentHeader: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    }
  });
  assert.equal(wrongHostReplay.valid, false);

  const wrongUserAgentReplay = await verifyFirebaseIdTokenHeader({
    idTokenHeader: boundToken,
    expectedUid: 'usr_bound_01',
    requestContext: {
      method: 'POST',
      hostHeader: 'app.pryzmium.dev',
      originHeader: 'https://app.pryzmium.dev',
      userAgentHeader: 'curl/8.5.0'
    }
  });
  assert.equal(wrongUserAgentReplay.valid, false);

  const validSameOriginRequest = await verifyFirebaseIdTokenHeader({
    idTokenHeader: undefined,
    cookieHeader: `vektor_session=${encodeURIComponent(boundToken)}`,
    expectedUid: 'usr_bound_01',
    requestContext: {
      method: 'POST',
      hostHeader: 'app.pryzmium.dev',
      originHeader: 'https://app.pryzmium.dev',
      secFetchSiteHeader: 'same-origin',
      userAgentHeader: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    }
  });
  assert.equal(validSameOriginRequest.valid, true);
  assert.equal(validSameOriginRequest.uid, 'usr_bound_01');
});

