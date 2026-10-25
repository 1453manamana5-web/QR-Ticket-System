import { getFunctions, httpsCallable } from "firebase/functions";
import { ensureFirebaseAuth, getFirebaseApp } from "./firebaseClient";

/**
 * Typed entry point for the callable backend. Use this for terminal and
 * reception operations when migrating away from direct client writes.
 */
export async function callBackend<TInput extends Record<string, unknown>, TOutput>(
  name: string,
  input: TInput,
): Promise<TOutput> {
  await ensureFirebaseAuth();
  const functions = getFunctions(getFirebaseApp());
  const callable = httpsCallable<TInput, TOutput>(functions, name);
  const result = await callable(input);
  return result.data;
}
