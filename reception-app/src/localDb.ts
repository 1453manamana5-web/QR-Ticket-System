import type {
  LocalEventData,
  ReceptionRecord,
  SyncQueueItem,
  Ticket,
} from "@qr-ticket-system/shared";

const DB_NAME = "qr-ticket-reception";
const DB_VERSION = 6;

const STORES = {
  event: "event",
  tickets: "tickets",
  receptionRecords: "receptionRecords",
  syncQueue: "syncQueue",
} as const;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      const transaction = request.transaction;

      if (!database.objectStoreNames.contains(STORES.event)) {
        database.createObjectStore(STORES.event, {keyPath: "event.eventId"});
      } else {
        const existingStore = transaction!.objectStore(STORES.event);

        // Version 5までのevent Storeは「eventId」をトップ階層のキーとして
        // 定義していましたが、LocalEventDataは「event.eventId」に
        // イベントIDを持つため、ここで正しいkeyPathへ作り直します。
        if (existingStore.keyPath !== "event.eventId") {
          database.deleteObjectStore(STORES.event);
          database.createObjectStore(STORES.event, {keyPath: "event.eventId"});
        }
      }

      if (!database.objectStoreNames.contains(STORES.tickets)) {
        const store = database.createObjectStore(STORES.tickets, {keyPath: "ticketId"});
        store.createIndex("eventId", "eventId", {unique: false});
      } else {
        const store = transaction!.objectStore(STORES.tickets);
        if (!store.indexNames.contains("eventId")) {
          store.createIndex("eventId", "eventId", {unique: false});
        }
      }

      if (!database.objectStoreNames.contains(STORES.receptionRecords)) {
        const store = database.createObjectStore(STORES.receptionRecords, {keyPath: "recordId"});
        store.createIndex("eventId", "eventId", {unique: false});
        store.createIndex("ticketId", "ticketId", {unique: false});
      }

      if (!database.objectStoreNames.contains(STORES.syncQueue)) {
        const store = database.createObjectStore(STORES.syncQueue, {keyPath: "recordId"});
        store.createIndex("status", "status", {unique: false});
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("ローカルデータベースを開けませんでした"));
  });
}

export async function saveLocalEvent(data: LocalEventData): Promise<void> {
  const database = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORES.event, "readwrite");
    transaction.objectStore(STORES.event).put(data);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("イベントデータを保存できませんでした"));
  });

  database.close();
}

export async function loadLocalEvent(): Promise<LocalEventData | null> {
  const database = await openDatabase();

  const value = await new Promise<LocalEventData | undefined>((resolve, reject) => {
    const request = database
      .transaction(STORES.event, "readonly")
      .objectStore(STORES.event)
      .getAll();

    request.onsuccess = () => resolve(request.result[0]);
    request.onerror = () =>
      reject(request.error ?? new Error("イベントデータを読み込めませんでした"));
  });

  database.close();
  return value ?? null;
}

export async function prepareLocalEventData(event: LocalEventData, tickets: Ticket[]): Promise<void> {
  const database = await openDatabase();

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        [STORES.event, STORES.tickets],
        "readwrite"
      );
      const eventStore = transaction.objectStore(STORES.event);
      const ticketStore = transaction.objectStore(STORES.tickets);

      eventStore.clear();
      ticketStore.clear();
      eventStore.put(event);

      for (const ticket of tickets) {
        ticketStore.put(ticket);
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("イベントデータを保存できませんでした"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("イベントデータの保存が中断されました"));
    });
  } finally {
    database.close();
  }

  const savedEvent = await loadLocalEvent();
  const savedTicketCount = await countTickets(event.event.eventId);

  if (!savedEvent) {
    throw new Error("イベント本体をIndexedDBから再読み込みできませんでした");
  }
  if (savedEvent.event.eventId !== event.event.eventId) {
    throw new Error("保存したイベントIDが一致しません");
  }
  if (!savedEvent.dataReady) {
    throw new Error("保存したイベントが準備完了状態ではありません");
  }
  if (savedTicketCount !== tickets.length) {
    throw new Error(`チケット保存件数が一致しません（${savedTicketCount}/${tickets.length}）`);
  }
}

export async function countTickets(eventId: string): Promise<number> {
  const database = await openDatabase();

  try {
    return await new Promise<number>((resolve, reject) => {
      const request = database
        .transaction(STORES.tickets, "readonly")
        .objectStore(STORES.tickets)
        .index("eventId")
        .count(eventId);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("チケット件数を確認できませんでした"));
    });
  } finally {
    database.close();
  }
}

export async function replaceTickets(tickets: Ticket[]): Promise<void> {
  const database = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORES.tickets, "readwrite");
    const store = transaction.objectStore(STORES.tickets);
    store.clear();

    for (const ticket of tickets) {
      store.put(ticket);
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("チケットデータを保存できませんでした"));
  });

  database.close();
}

export async function getTicket(ticketId: string): Promise<Ticket | null> {
  const database = await openDatabase();

  const ticket = await new Promise<Ticket | undefined>((resolve, reject) => {
    const request = database
      .transaction(STORES.tickets, "readonly")
      .objectStore(STORES.tickets)
      .get(ticketId);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("チケットデータを読み込めませんでした"));
  });

  database.close();
  return ticket ?? null;
}

export async function saveReceptionTransaction(
  ticket: Ticket,
  record: ReceptionRecord
): Promise<void> {
  const database = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(
      [STORES.tickets, STORES.receptionRecords, STORES.syncQueue],
      "readwrite"
    );

    transaction.objectStore(STORES.tickets).put(ticket);
    transaction.objectStore(STORES.receptionRecords).put(record);

    const queue: SyncQueueItem = {
      recordId: record.recordId,
      status: "pending",
      retryCount: 0,
    };
    transaction.objectStore(STORES.syncQueue).put(queue);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("受付データを保存できませんでした"));
  });

  database.close();
}

export async function getReceptionRecord(recordId: string): Promise<ReceptionRecord | null> {
  const database = await openDatabase();
  try {
    const record = await new Promise<ReceptionRecord | undefined>((resolve, reject) => {
      const request = database.transaction(STORES.receptionRecords, "readonly").objectStore(STORES.receptionRecords).get(recordId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("受付記録を読み込めませんでした"));
    });
    return record ?? null;
  } finally {
    database.close();
  }
}

export async function getPendingSyncItems(): Promise<SyncQueueItem[]> {
  const database = await openDatabase();

  const items = await new Promise<SyncQueueItem[]>((resolve, reject) => {
    const request = database
      .transaction(STORES.syncQueue, "readonly")
      .objectStore(STORES.syncQueue)
      .getAll();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("同期キューを読み込めませんでした"));
  });

  database.close();
  return items.filter((item) => item.status !== "synced");
}

export async function markSyncStatus(
  recordId: string,
  status: SyncQueueItem["status"],
  retryCount: number
): Promise<void> {
  const database = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORES.syncQueue, "readwrite");
    transaction.objectStore(STORES.syncQueue).put({
      recordId,
      status,
      retryCount,
      lastAttemptAt: new Date().toISOString(),
    } satisfies SyncQueueItem);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("同期状態を保存できませんでした"));
  });

  database.close();
}

export async function clearLocalEvent(): Promise<void> {
  const database = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(Object.values(STORES), "readwrite");

    for (const storeName of Object.values(STORES)) {
      transaction.objectStore(storeName).clear();
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("ローカルデータを削除できませんでした"));
  });

  database.close();
}