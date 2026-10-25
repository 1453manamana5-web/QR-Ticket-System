import { getFunctions, httpsCallable } from "firebase/functions";
import { ensureFirebaseAuth, getFirebaseApp } from "./firebaseClient";

export async function callBackend<TInput extends Record<string, unknown>, TOutput>(
  name: string,
  input: TInput,
): Promise<TOutput> {
  await ensureFirebaseAuth();
  const callable = httpsCallable<TInput, TOutput>(getFunctions(getFirebaseApp()), name);
  return (await callable(input)).data;
}
