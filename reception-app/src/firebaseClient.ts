import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, type Auth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

function getFirebaseApp() {
  const missing = Object.entries(firebaseConfig)
    .filter(([, value]) => typeof value !== "string" || value.trim() === "")
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error("Firebase configuration is missing: " + missing.join(", "));
  }
  return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
}

let authReady: Promise<Auth> | undefined;

/**
 * The app uses a persistent anonymous Firebase identity. Server callables use
 * this UID to issue and validate a terminal installation grant; the browser
 * never writes trusted owner/approval records directly.
 */
export function ensureFirebaseAuth(): Promise<Auth> {
  if (!authReady) {
    const auth = getAuth(getFirebaseApp());
    authReady = (async () => {
      if (!auth.currentUser) await signInAnonymously(auth);
      return auth;
    })().catch((error) => {
      authReady = undefined;
      throw error;
    });
  }
  return authReady;
}

export function getFirebaseDb() {
  return getFirestore(getFirebaseApp());
}

export async function getFirebaseUid(): Promise<string> {
  const auth = await ensureFirebaseAuth();
  if (!auth.currentUser) throw new Error("FIREBASE_AUTH_NOT_READY");
  return auth.currentUser.uid;
}
