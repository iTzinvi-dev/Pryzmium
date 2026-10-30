import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig } from 'vite';

interface LocalFirebaseConfig {
  projectId?: string;
  appId?: string;
  apiKey?: string;
  authDomain?: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
}

function readLocalFirebaseConfig(): LocalFirebaseConfig {
  try {
    const configPath = path.resolve(__dirname, 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8')) as LocalFirebaseConfig;
    }
  } catch {
    return {};
  }
  return {};
}

export default defineConfig(() => {
  const localCfg = readLocalFirebaseConfig();

  const resolvedProjectId =
    process.env.VITE_FIREBASE_PROJECT_ID ||
    process.env.FIREBASE_PROJECT_ID ||
    localCfg.projectId ||
    '';
  const resolvedAppId = process.env.VITE_FIREBASE_APP_ID || localCfg.appId || '';
  const resolvedApiKey = process.env.VITE_FIREBASE_API_KEY || localCfg.apiKey || '';
  const resolvedAuthDomain =
    process.env.VITE_FIREBASE_AUTH_DOMAIN ||
    localCfg.authDomain ||
    (resolvedProjectId ? `${resolvedProjectId}.firebaseapp.com` : '');
  const resolvedDatabaseId =
    process.env.VITE_FIRESTORE_DATABASE_ID ||
    process.env.FIRESTORE_DATABASE_ID ||
    localCfg.firestoreDatabaseId ||
    '';
  const resolvedStorageBucket =
    process.env.VITE_FIREBASE_STORAGE_BUCKET || localCfg.storageBucket || '';
  const resolvedMessagingSenderId =
    process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || localCfg.messagingSenderId || '';

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_FIREBASE_PROJECT_ID': JSON.stringify(resolvedProjectId),
      'import.meta.env.VITE_FIREBASE_APP_ID': JSON.stringify(resolvedAppId),
      'import.meta.env.VITE_FIREBASE_API_KEY': JSON.stringify(resolvedApiKey),
      'import.meta.env.VITE_FIREBASE_AUTH_DOMAIN': JSON.stringify(resolvedAuthDomain),
      'import.meta.env.VITE_FIRESTORE_DATABASE_ID': JSON.stringify(resolvedDatabaseId),
      'import.meta.env.VITE_FIREBASE_STORAGE_BUCKET': JSON.stringify(resolvedStorageBucket),
      'import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID': JSON.stringify(resolvedMessagingSenderId)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.')
      }
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {}
    }
  };
});
