import { getApp, getApps, initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, signInAnonymously, type User } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

function validateConfig() {
  const missing = Object.entries(firebaseConfig)
    .filter(([, value]) => typeof value !== "string" || value.trim() === "")
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error("Firebase configuration is missing: " + missing.join(", "));
  }
}

export function getFirebaseDb() {
  validateConfig();
  const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  return getFirestore(app);
}

/**
 * Creates a stable Firebase Auth identity for this browser installation.
 * Safari and a Home Screen web app may have separate storage and therefore
 * separate UIDs; that is intentional. A UID or terminal ID alone must never
 * be treated as approval to use an existing terminal.
 * Enable Anonymous sign-in in Firebase Authentication before calling this.
 */
export async function ensureInstallationAuth(): Promise<User> {
  validateConfig();
  const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  const auth = getAuth(app);
  if (auth.currentUser) return auth.currentUser;
  const credential = await signInAnonymously(auth);
  return credential.user;
}
