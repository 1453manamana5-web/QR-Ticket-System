import type {LocalEventData} from "@qr-ticket-system/shared";

const DB_NAME = "qr-ticket-reception";
const DB_VERSION = 1;
const STORE = "event";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, {keyPath: "eventId"});
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("ローカルデータベースを開けませんでした"));
  });
}

export async function saveLocalEvent(data: LocalEventData): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(data);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("イベントデータを保存できませんでした"));
  });
  database.close();
}

export async function loadLocalEvent(): Promise<LocalEventData | null> {
  const database = await openDatabase();
  const value = await new Promise<LocalEventData | undefined>((resolve, reject) => {
    const request = database.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result[0]);
    request.onerror = () => reject(request.error ?? new Error("イベントデータを読み込めませんでした"));
  });
  database.close();
  return value ?? null;
}

export async function clearLocalEvent(): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("ローカルデータを削除できませんでした"));
  });
  database.close();
}