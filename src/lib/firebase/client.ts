import { initializeApp } from 'firebase/app';
import {
  Auth,
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
  User
} from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import { ConnectorId } from '../../types/agent.ts';

interface FirebaseAppletConfig {
  projectId?: string;
  appId?: string;
  apiKey?: string;
  authDomain?: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
}

const ENCODED_WEB_CONFIG =
  'IXgqKDUwPzkuEz54YHgqKCMgNzMvN3c7M3c7PT80Lnh2eDsqKhM+eGB4a2BiaGttbGtrb25vaGlgLT84YGNrbW1jaDhoO24/PjxqOD5sOW84PD94dng7KjMRPyN4YHgbEyA7CSMZOGgLCAgwGTE3EBdrIzJjaBQuGAoFOG1uFio5IBNjIjV4dng7Ly4yHjU3OzM0eGB4KigjIDczLzd3OzN3Oz0/NC50PDMoPzg7KT87Kip0OTU3eHZ4PDMoPykuNSg/HjsuOzg7KT8TPnhgeDszdykuLz4zNXdqaWhiP2JsY3dpbzlid25tbml3Yj9rbnc4Pmtvaz5vamxrOGl4dngpLjUoOz0/GC85MT8ueGB4KigjIDczLzd3OzN3Oz0/NC50PDMoPzg7KT8pLjUoOz0/dDsqKnh2eDc/KSk7PTM0PQk/ND4/KBM+eGB4YmhrbWxra29ub2hpeCc=';

function decodeWebConfigFallback(): FirebaseAppletConfig {
  try {
    const binary = atob(ENCODED_WEB_CONFIG);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i) ^ 0x5a;
    }
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as FirebaseAppletConfig;
  } catch {
    return {};
  }
}

const localConfigModules = import.meta.glob<FirebaseAppletConfig>(
  '../../../firebase-applet-config.json',
  { eager: true, import: 'default' }
);
const localFirebaseConfig: FirebaseAppletConfig = {
  ...decodeWebConfigFallback(),
  ...(Object.values(localConfigModules)[0] || {})
};

const firebaseConfig = {
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || localFirebaseConfig.projectId || '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || localFirebaseConfig.appId || '',
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || localFirebaseConfig.apiKey || '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || localFirebaseConfig.authDomain || '',
  firestoreDatabaseId:
    import.meta.env.VITE_FIRESTORE_DATABASE_ID || localFirebaseConfig.firestoreDatabaseId || '',
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || localFirebaseConfig.storageBucket || '',
  messagingSenderId:
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || localFirebaseConfig.messagingSenderId || ''
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.apiKey.trim() && firebaseConfig.projectId
);

const app = initializeApp(
  isFirebaseConfigured
    ? firebaseConfig
    : {
        ...firebaseConfig,
        projectId: firebaseConfig.projectId || 'local-workspace'
      }
);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId || undefined);

let initializedAuth: Auth | null = null;
if (isFirebaseConfigured) {
  try {
    initializedAuth = getAuth(app);
  } catch {
    initializedAuth = null;
  }
}
export let auth: Auth | null = initializedAuth;

function ensureFirebaseAuth(): Auth {
  if (auth) {
    return auth;
  }
  if (isFirebaseConfigured) {
    try {
      auth = getAuth(app);
      return auth;
    } catch {
      auth = null;
    }
  }
  throw new Error(
    'Firebase Authentication is not initialized. Please sign in with Email & Password or verify your Firebase configuration.'
  );
}

async function testFirestoreConnection() {
  if (!isFirebaseConfigured) return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

void testFirestoreConnection();

export interface WorkspaceUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
  isServerSession?: boolean;
}

export const WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/tasks'
];

export const DEFAULT_LOCAL_CONNECTORS: ConnectorId[] = ['system', 'search', 'maps', 'notes'];
export const GOOGLE_OAUTH_CONNECTORS: ConnectorId[] = ['gmail', 'calendar', 'drive', 'docs', 'tasks'];

const SERVER_SESSION_STORAGE_KEY = 'vektor_server_auth_session_v1';
const LEGAL_CONSENT_STORAGE_KEY = 'vektor_account_cookie_policy_consent_v3';
const SIGNIN_RATE_LIMIT_STORAGE_KEY = 'vektor_signin_rate_limit_v1';
export const SIGNIN_MAX_ATTEMPTS = 5;
export const SIGNIN_WINDOW_MS = 5 * 60_000;

export interface SignInRateLimitStatus {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
}

function readLocalSignInTimestamps(): number[] {
  try {
    const raw = localStorage.getItem(SIGNIN_RATE_LIMIT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter((ts): ts is number => typeof ts === 'number' && now - ts < SIGNIN_WINDOW_MS);
  } catch {
    return [];
  }
}

function writeLocalSignInTimestamps(timestamps: number[]): void {
  try {
    localStorage.setItem(SIGNIN_RATE_LIMIT_STORAGE_KEY, JSON.stringify(timestamps));
  } catch {
    return;
  }
}

export function getSignInRateLimitStatus(): SignInRateLimitStatus {
  const now = Date.now();
  const active = readLocalSignInTimestamps();
  writeLocalSignInTimestamps(active);
  const remaining = Math.max(0, SIGNIN_MAX_ATTEMPTS - active.length);
  const oldest = active[0] || now;
  const retryAfterSec =
    remaining <= 0 ? Math.max(1, Math.ceil((SIGNIN_WINDOW_MS - (now - oldest)) / 1000)) : 0;

  return {
    allowed: remaining > 0,
    limit: SIGNIN_MAX_ATTEMPTS,
    remaining,
    retryAfterSec
  };
}

export async function enforceSignInAttemptLimit(): Promise<SignInRateLimitStatus> {
  const status = getSignInRateLimitStatus();
  if (!status.allowed) {
    throw new Error(
      `Sign-in rate limit exceeded (${SIGNIN_MAX_ATTEMPTS} attempts per 5 minutes). Please wait ${status.retryAfterSec}s before trying again.`
    );
  }

  try {
    const res = await fetch('/api/auth/signin-check', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        retryAfterSec?: number;
      };
      const waitSec = data.retryAfterSec || 60;
      const filled = Array.from({ length: SIGNIN_MAX_ATTEMPTS }, () => Date.now());
      writeLocalSignInTimestamps(filled);
      throw new Error(
        data.error ||
          `Sign-in rate limit exceeded (${SIGNIN_MAX_ATTEMPTS} attempts per 5 minutes). Please wait ${waitSec}s before trying again.`
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('rate limit')) {
      throw err;
    }
  }

  const next = [...readLocalSignInTimestamps(), Date.now()];
  writeLocalSignInTimestamps(next);
  const remaining = Math.max(0, SIGNIN_MAX_ATTEMPTS - next.length);
  return {
    allowed: true,
    limit: SIGNIN_MAX_ATTEMPTS,
    remaining,
    retryAfterSec: 0
  };
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write'
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): FirestoreErrorInfo {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid,
      email: auth?.currentUser?.email,
      emailVerified: auth?.currentUser?.emailVerified,
      isAnonymous: auth?.currentUser?.isAnonymous,
      tenantId: auth?.currentUser?.tenantId,
      providerInfo:
        auth?.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email
        })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  return errInfo;
}

export function formatFirebaseAuthError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('auth/popup-closed-by-user') || msg.includes('auth/cancelled-popup-request')) {
    return 'Sign-in popup was closed before completing authentication. Please try again.';
  }
  if (msg.includes('auth/popup-blocked')) {
    return 'Browser blocked the sign-in popup. Please allow popups for this site and try again.';
  }
  if (
    msg.includes('auth/operation-not-allowed') ||
    msg.includes('auth/configuration-not-found')
  ) {
    return 'Google Sign-In provider is not enabled for this Firebase project. Enable the Google provider in Firebase Console > Authentication > Sign-in method, or sign in with Email & Password.';
  }
  if (msg.includes('auth/unauthorized-domain')) {
    return 'This domain is not authorized for Google OAuth in Firebase Console. Add this domain under Authentication > Settings > Authorized domains, or sign in with Email & Password.';
  }
  if (msg.includes('auth/invalid-api-key')) {
    return 'Firebase API key is invalid or missing. Please sign in with Email & Password.';
  }
  if (
    msg.includes('auth/invalid-credential') ||
    msg.includes('auth/wrong-password') ||
    msg.includes('auth/user-not-found')
  ) {
    return 'Invalid email or password. Please check your credentials or switch to Create Account.';
  }
  if (msg.includes('auth/email-already-in-use')) {
    return 'An account with this email already exists. Switch to "Sign In" to log in.';
  }
  if (msg.includes('auth/weak-password')) {
    return 'Password must be at least 6 characters long.';
  }
  return msg;
}

let isSigningIn = false;
let cachedAccessToken: string | null = null;
let cachedServerSessionToken: string | null = null;
let cachedServerUser: WorkspaceUser | null = null;
let activeConnectors: Set<ConnectorId> = new Set(DEFAULT_LOCAL_CONNECTORS);

function loadPersistedServerSession(): { user: WorkspaceUser; sessionToken: string } | null {
  try {
    const raw =
      sessionStorage.getItem(SERVER_SESSION_STORAGE_KEY) ||
      localStorage.getItem(SERVER_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { user?: WorkspaceUser; sessionToken?: string };
    if (parsed?.user?.uid && parsed?.sessionToken) {
      return { user: parsed.user, sessionToken: parsed.sessionToken };
    }
    return null;
  } catch {
    return null;
  }
}

function savePersistedServerSession(user: WorkspaceUser | null, sessionToken: string | null) {
  try {
    if (user && sessionToken) {
      const serialized = JSON.stringify({ user, sessionToken });
      sessionStorage.setItem(SERVER_SESSION_STORAGE_KEY, serialized);
      localStorage.setItem(SERVER_SESSION_STORAGE_KEY, serialized);
    } else {
      sessionStorage.removeItem(SERVER_SESSION_STORAGE_KEY);
      localStorage.removeItem(SERVER_SESSION_STORAGE_KEY);
    }
  } catch {
    return;
  }
}

interface StoredAccountConsentMap {
  uids: string[];
  emails: string[];
  updatedAt: string;
}

function readAccountConsentMap(): StoredAccountConsentMap {
  try {
    const raw = localStorage.getItem(LEGAL_CONSENT_STORAGE_KEY);
    if (!raw) {
      return { uids: [], emails: [], updatedAt: '' };
    }
    const parsed = JSON.parse(raw) as Partial<StoredAccountConsentMap>;
    return {
      uids: Array.isArray(parsed.uids) ? parsed.uids.filter((v): v is string => typeof v === 'string') : [],
      emails: Array.isArray(parsed.emails) ? parsed.emails.filter((v): v is string => typeof v === 'string') : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
    };
  } catch {
    return { uids: [], emails: [], updatedAt: '' };
  }
}

export function hasAcceptedLegalConsent(uid?: string, email?: string | null): boolean {
  const cleanUid = typeof uid === 'string' ? uid.trim() : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!cleanUid && !cleanEmail) {
    return false;
  }

  const data = readAccountConsentMap();
  if (cleanUid && data.uids.includes(cleanUid)) {
    return true;
  }
  if (cleanEmail && data.emails.includes(cleanEmail)) {
    return true;
  }
  return false;
}

export function recordLegalConsentAccepted(uid?: string, email?: string | null): void {
  const cleanUid = typeof uid === 'string' ? uid.trim() : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!cleanUid && !cleanEmail) {
    return;
  }

  try {
    const current = readAccountConsentMap();
    const nextUids = cleanUid && !current.uids.includes(cleanUid)
      ? [...current.uids, cleanUid]
      : current.uids;
    const nextEmails = cleanEmail && !current.emails.includes(cleanEmail)
      ? [...current.emails, cleanEmail]
      : current.emails;

    localStorage.setItem(
      LEGAL_CONSENT_STORAGE_KEY,
      JSON.stringify({
        uids: nextUids,
        emails: nextEmails,
        updatedAt: new Date().toISOString()
      })
    );
  } catch {
    void 0;
  }

  void (async () => {
    try {
      const idToken = await getFirebaseIdToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (idToken) {
        headers['X-Firebase-Id-Token'] = idToken;
      }
      await fetch('/api/auth/consent', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({ uid: cleanUid, email: cleanEmail })
      });
    } catch {
      void 0;
    }
  })();
}

export async function syncAccountLegalConsent(
  uid: string,
  email?: string | null
): Promise<boolean> {
  if (hasAcceptedLegalConsent(uid, email)) {
    return true;
  }
  try {
    const idToken = await getFirebaseIdToken();
    const headers: Record<string, string> = {};
    if (idToken) {
      headers['X-Firebase-Id-Token'] = idToken;
    }
    const params = new URLSearchParams();
    if (uid) params.set('uid', uid);
    if (email) params.set('email', email.trim().toLowerCase());
    const res = await fetch(`/api/auth/consent?${params.toString()}`, {
      credentials: 'same-origin',
      headers
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accepted?: boolean };
    if (data?.accepted) {
      recordLegalConsentAccepted(uid, email);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function toWorkspaceUser(fbUser: User): WorkspaceUser {
  return {
    uid: fbUser.uid,
    email: fbUser.email,
    displayName: fbUser.displayName || fbUser.email?.split('@')[0] || 'Workspace Operator',
    emailVerified: fbUser.emailVerified,
    isServerSession: false
  };
}

export function initAuth(
  onAuthReady: (user: WorkspaceUser | null, token: string | null) => void
) {
  if (auth?.currentUser) {
    onAuthReady(toWorkspaceUser(auth.currentUser), cachedAccessToken);
  } else {
    const immediateServer = loadPersistedServerSession();
    if (immediateServer) {
      cachedServerUser = immediateServer.user;
      cachedServerSessionToken = immediateServer.sessionToken;
      onAuthReady(immediateServer.user, null);
    } else if (!auth) {
      onAuthReady(null, null);
    }
  }

  if (!auth) {
    return () => {};
  }

  return onAuthStateChanged(auth, (fbUser: User | null) => {
    if (fbUser) {
      cachedServerUser = null;
      cachedServerSessionToken = null;
      savePersistedServerSession(null, null);
      onAuthReady(toWorkspaceUser(fbUser), cachedAccessToken);
      return;
    }

    const persistedServer = loadPersistedServerSession();
    if (persistedServer) {
      cachedServerUser = persistedServer.user;
      cachedServerSessionToken = persistedServer.sessionToken;
      onAuthReady(persistedServer.user, null);
      return;
    }

    cachedAccessToken = null;
    activeConnectors = new Set(DEFAULT_LOCAL_CONNECTORS);
    onAuthReady(null, null);
  });
}

export async function updateWorkspaceUsername(newDisplayName: string): Promise<string> {
  const cleanName = newDisplayName.trim().slice(0, 80);
  if (!cleanName) {
    throw new Error('Username cannot be empty.');
  }

  if (auth?.currentUser) {
    await updateProfile(auth.currentUser, { displayName: cleanName });
  }

  if (cachedServerUser) {
    cachedServerUser = {
      ...cachedServerUser,
      displayName: cleanName
    };
    savePersistedServerSession(cachedServerUser, cachedServerSessionToken);
  } else {
    const persisted = loadPersistedServerSession();
    if (persisted) {
      const updatedUser: WorkspaceUser = {
        ...persisted.user,
        displayName: cleanName
      };
      cachedServerUser = updatedUser;
      cachedServerSessionToken = persisted.sessionToken;
      savePersistedServerSession(updatedUser, persisted.sessionToken);
    }
  }

  return cleanName;
}

export async function googleSignInBasic(): Promise<{
  user: WorkspaceUser;
  accessToken: string | null;
  connectedProviders: ConnectorId[];
}> {
  try {
    isSigningIn = true;
    await enforceSignInAttemptLimit();
    const activeAuth = ensureFirebaseAuth();

    if (typeof GoogleAuthProvider !== 'function') {
      throw new Error(
        'Google authentication provider is unavailable. Please sign in with Email & Password.'
      );
    }

    const provider = new GoogleAuthProvider();
    provider.addScope('email');
    provider.addScope('profile');
    provider.setCustomParameters({
      prompt: 'select_account'
    });

    const result = await signInWithPopup(activeAuth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) {
      cachedAccessToken = credential.accessToken;
    }

    return {
      user: toWorkspaceUser(result.user),
      accessToken: cachedAccessToken,
      connectedProviders: Array.from(activeConnectors)
    };
  } catch (err) {
    throw new Error(formatFirebaseAuthError(err));
  } finally {
    isSigningIn = false;
  }
}

export async function googleSignInWithWorkspaceScopes(
  connectorsToEnable: ConnectorId[] = GOOGLE_OAUTH_CONNECTORS
): Promise<{
  user: WorkspaceUser;
  accessToken: string | null;
  connectedProviders: ConnectorId[];
}> {
  try {
    isSigningIn = true;
    await enforceSignInAttemptLimit();
    const activeAuth = ensureFirebaseAuth();

    if (typeof GoogleAuthProvider !== 'function') {
      throw new Error(
        'Google Workspace authentication provider is unavailable.'
      );
    }

    const provider = new GoogleAuthProvider();
    for (const scope of WORKSPACE_SCOPES) {
      provider.addScope(scope);
    }
    provider.setCustomParameters({
      prompt: 'consent'
    });

    const result = await signInWithPopup(activeAuth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) {
      cachedAccessToken = credential.accessToken;
      activeConnectors = new Set<ConnectorId>([...DEFAULT_LOCAL_CONNECTORS, ...connectorsToEnable]);
    } else {
      activeConnectors = new Set<ConnectorId>(DEFAULT_LOCAL_CONNECTORS);
    }

    return {
      user: toWorkspaceUser(result.user),
      accessToken: cachedAccessToken,
      connectedProviders: Array.from(activeConnectors)
    };
  } catch (err) {
    throw new Error(formatFirebaseAuthError(err));
  } finally {
    isSigningIn = false;
  }
}

export async function emailPasswordSignIn(
  email: string,
  password: string
): Promise<{ user: WorkspaceUser; connectedProviders: ConnectorId[] }> {
  try {
    isSigningIn = true;
    await enforceSignInAttemptLimit();
    const cleanEmail = email.trim();
    try {
      if (!auth) {
        throw new Error('server-auth-fallback');
      }
      const result = await signInWithEmailAndPassword(auth, cleanEmail, password);
      activeConnectors = new Set<ConnectorId>(DEFAULT_LOCAL_CONNECTORS);
      return {
        user: toWorkspaceUser(result.user),
        connectedProviders: Array.from(activeConnectors)
      };
    } catch (fbErr) {
      const errMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
      const isExplicitWrongPassword = errMsg.includes('auth/wrong-password');
      if (isExplicitWrongPassword) {
        throw fbErr;
      }

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail, password })
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        user?: WorkspaceUser;
        sessionToken?: string;
      };
      if (!res.ok || !data.user || !data.sessionToken) {
        throw new Error(
          data.error ||
            (errMsg === 'server-auth-fallback'
              ? 'Unable to complete sign-in. Please verify your email and password.'
              : formatFirebaseAuthError(fbErr))
        );
      }

      cachedServerUser = data.user;
      cachedServerSessionToken = data.sessionToken;
      savePersistedServerSession(data.user, data.sessionToken);
      activeConnectors = new Set<ConnectorId>(DEFAULT_LOCAL_CONNECTORS);

      return {
        user: data.user,
        connectedProviders: Array.from(activeConnectors)
      };
    }
  } catch (err) {
    throw new Error(formatFirebaseAuthError(err));
  } finally {
    isSigningIn = false;
  }
}

export async function emailPasswordSignUp(
  email: string,
  password: string,
  displayName?: string
): Promise<{ user: WorkspaceUser; connectedProviders: ConnectorId[] }> {
  try {
    isSigningIn = true;
    await enforceSignInAttemptLimit();
    const cleanEmail = email.trim();
    const cleanName =
      (displayName && displayName.trim()) || cleanEmail.split('@')[0] || 'Workspace Operator';

    try {
      if (!auth) {
        throw new Error('server-auth-fallback');
      }
      const result = await createUserWithEmailAndPassword(auth, cleanEmail, password);
      await updateProfile(result.user, {
        displayName: cleanName.slice(0, 80)
      });
      activeConnectors = new Set<ConnectorId>(DEFAULT_LOCAL_CONNECTORS);
      return {
        user: {
          uid: result.user.uid,
          email: result.user.email || cleanEmail,
          displayName: cleanName.slice(0, 80),
          emailVerified: result.user.emailVerified,
          isServerSession: false
        },
        connectedProviders: Array.from(activeConnectors)
      };
    } catch (fbErr) {
      const errMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
      if (errMsg.includes('auth/email-already-in-use') || errMsg.includes('auth/weak-password')) {
        throw fbErr;
      }

      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: cleanEmail,
          password,
          displayName: cleanName
        })
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        user?: WorkspaceUser;
        sessionToken?: string;
      };
      if (!res.ok || !data.user || !data.sessionToken) {
        throw new Error(
          data.error ||
            (errMsg === 'server-auth-fallback'
              ? 'Unable to create account right now. Please try again.'
              : formatFirebaseAuthError(fbErr))
        );
      }

      cachedServerUser = data.user;
      cachedServerSessionToken = data.sessionToken;
      savePersistedServerSession(data.user, data.sessionToken);
      activeConnectors = new Set<ConnectorId>(DEFAULT_LOCAL_CONNECTORS);

      return {
        user: data.user,
        connectedProviders: Array.from(activeConnectors)
      };
    }
  } catch (err) {
    throw new Error(formatFirebaseAuthError(err));
  } finally {
    isSigningIn = false;
  }
}

export async function getFirebaseIdToken(): Promise<string | null> {
  if (cachedServerSessionToken) {
    return cachedServerSessionToken;
  }
  const persisted = loadPersistedServerSession();
  if (persisted?.sessionToken) {
    cachedServerSessionToken = persisted.sessionToken;
    cachedServerUser = persisted.user;
    return persisted.sessionToken;
  }
  if (!auth?.currentUser) return null;
  try {
    return await auth.currentUser.getIdToken();
  } catch {
    try {
      return await auth.currentUser.getIdToken(true);
    } catch {
      return null;
    }
  }
}

export function getAccessToken(): string | null {
  return cachedAccessToken;
}

export function getConnectedProviders(): ConnectorId[] {
  return Array.from(activeConnectors);
}

export function setConnectorEnabled(connector: ConnectorId, enabled: boolean): ConnectorId[] {
  if (connector === 'system') return Array.from(activeConnectors);
  if (enabled) {
    activeConnectors.add(connector);
  } else {
    activeConnectors.delete(connector);
  }
  return Array.from(activeConnectors);
}

export async function revokeGoogleAccessAndDisconnect(): Promise<void> {
  if (cachedAccessToken) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(cachedAccessToken)}`, {
        method: 'POST',
        headers: { 'Content-type': 'application/x-www-form-urlencoded' }
      });
    } catch {
      return;
    }
  }
  cachedAccessToken = null;
  activeConnectors = new Set(DEFAULT_LOCAL_CONNECTORS);
}

export async function logoutUser(): Promise<void> {
  await revokeGoogleAccessAndDisconnect();
  cachedServerUser = null;
  cachedServerSessionToken = null;
  savePersistedServerSession(null, null);
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    return;
  }
  if (auth) {
    await auth.signOut();
  }
  if (!isSigningIn) {
    cachedAccessToken = null;
  }
}
