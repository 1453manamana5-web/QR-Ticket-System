import { getApp, getApps, initializeApp } from "firebase/app";
import { getFunctions, httpsCallable } from "firebase/functions";

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
  if (missing.length) {
    throw new Error("Firebase configuration is missing: " + missing.join(", "));
  }
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

/**
 * Typed entry point for the callable backend. Use this for terminal and
 * reception operations when migrating away from direct client writes.
 */
export async function callBackend<TInput extends Record<string, unknown>, TOutput>(
  name: string,
  input: TInput,
): Promise<TOutput> {
  const functions = getFunctions(getFirebaseApp());
  const callable = httpsCallable<TInput, TOutput>(functions, name);
  const result = await callable(input);
  return result.data;
}
