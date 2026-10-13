import type {
  LocalEventData,
  ReceptionRecord,
  SyncQueueItem,
  Ticket,
} from "@qr-ticket-system/shared";

const DB_NAME = "qr-ticket-reception";
const DB_VERSION = 7;

const STORES = {
  event: "event",
  tickets: "tickets",
  receptionRecords: "receptionRecords",
  syncQueue: "syncQueue",
  receptionErrors: "receptionErrors",
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

      if (!database.objectStoreNames.contains(STORES.receptionErrors)) {
        const store = database.createObjectStore(STORES.receptionErrors, {keyPath: "errorId"});
        store.createIndex("eventId", "eventId", {unique: false});
        store.createIndex("category", "category", {unique: false});
        store.createIndex("timestamp", "timestamp", {unique: false});
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
  const eventId = event.event.eventId;
  const ticketIds = new Set<string>();

  if (!eventId) {
    throw new Error("イベントIDがありません");
  }
  if (event.ticketCount !== tickets.length) {
    throw new Error(`取得したチケット件数がイベント情報と一致しません（${tickets.length}/${event.ticketCount}）`);
  }

  for (const ticket of tickets) {
    if (!ticket.ticketId || ticket.eventId !== eventId) {
      throw new Error("イベントIDまたはチケットIDが不正なデータを検出しました");
    }
    if (ticketIds.has(ticket.ticketId)) {
      throw new Error(`重複したチケットIDを検出しました（${ticket.ticketId}）`);
    }
    ticketIds.add(ticket.ticketId);
  }

  // イベント本体と全チケットは同じIndexedDBトランザクションで保存する。
  // トランザクションが完了した時点で両方が保存済みになるため、
  // 保存対象のイベントには準備完了状態を記録してよい。
  const readyEvent: LocalEventData = {
    ...event,
    dataReady: true,
    ticketCount: tickets.length,
  };
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
      eventStore.put(readyEvent);

      for (const ticket of tickets) {
        ticketStore.put(ticket);
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("イベント・チケットデータを保存できませんでした"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("イベント・チケットデータの保存が中断されました"));
    });
  } finally {
    database.close();
  }

  const savedEvent = await loadLocalEvent();
  const verifyDatabase = await openDatabase();
  let savedTickets: Ticket[];
  try {
    savedTickets = await new Promise<Ticket[]>((resolve, reject) => {
      const request = verifyDatabase
        .transaction(STORES.tickets, "readonly")
        .objectStore(STORES.tickets)
        .index("eventId")
        .getAll(eventId);
      request.onsuccess = () => resolve(request.result as Ticket[]);
      request.onerror = () =>
        reject(request.error ?? new Error("保存したチケットデータを再読み込みできませんでした"));
    });
  } finally {
    verifyDatabase.close();
  }

  const savedTicketIds = new Set(savedTickets.map(ticket => ticket.ticketId));
  const allTicketIdsMatch =
    savedTickets.length === tickets.length &&
    savedTicketIds.size === ticketIds.size &&
    [...ticketIds].every(ticketId => savedTicketIds.has(ticketId)) &&
    savedTickets.every(ticket => ticket.eventId === eventId);

  if (
    !savedEvent ||
    savedEvent.event.eventId !== eventId ||
    !savedEvent.dataReady ||
    savedEvent.ticketCount !== tickets.length ||
    !allTicketIdsMatch
  ) {
    await clearLocalEvent();
    throw new Error("イベント・チケットデータの保存後検証に失敗しました。ローカルデータを消去しました");
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


export type ReceptionErrorCategory =
  | "unknown_ticket"
  | "invalid_ticket"
  | "invalid_state"
  | "save_failed"
  | "camera_failed"
  | "event_load_failed"
  | "sync_failed";

export type ReceptionErrorLog = {
  errorId: string;
  eventId: string;
  terminalId: string;
  category: ReceptionErrorCategory;
  mode: "entry" | "exit";
  timestamp: string;
  syncedAt?: string;
};

export async function saveReceptionErrorLog(log: ReceptionErrorLog): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORES.receptionErrors, "readwrite");
      transaction.objectStore(STORES.receptionErrors).put(log);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("受付エラーログを保存できませんでした"));
      transaction.onabort = () => reject(transaction.error ?? new Error("受付エラーログの保存が中断されました"));
    });
  } finally {
    database.close();
  }
}

export async function getReceptionErrorLogs(): Promise<ReceptionErrorLog[]> {
  const database = await openDatabase();
  try {
    return await new Promise<ReceptionErrorLog[]>((resolve, reject) => {
      const request = database.transaction(STORES.receptionErrors, "readonly")
        .objectStore(STORES.receptionErrors).getAll();
      request.onsuccess = () => resolve(request.result as ReceptionErrorLog[]);
      request.onerror = () => reject(request.error ?? new Error("受付エラーログを読み込めませんでした"));
    });
  } finally {
    database.close();
  }
}

export async function getPendingReceptionErrorLogs(): Promise<ReceptionErrorLog[]> {
  const logs = await getReceptionErrorLogs();
  return logs.filter(log => !log.syncedAt);
}

export async function markReceptionErrorLogSynced(errorId: string): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORES.receptionErrors, "readwrite");
      const store = transaction.objectStore(STORES.receptionErrors);
      const request = store.get(errorId);
      request.onsuccess = () => {
        const log = request.result as ReceptionErrorLog | undefined;
        if (log) store.put({ ...log, syncedAt: new Date().toISOString() });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("受付エラーログの同期状態を保存できませんでした"));
      transaction.onabort = () => reject(transaction.error ?? new Error("受付エラーログの同期状態保存が中断されました"));
    });
  } finally {
    database.close();
  }
}

export async function clearLocalEvent(): Promise<void> {
  const database = await openDatabase();

  // イベントデータを消去しても、未同期の受付エラーログは保持する。
  const storesToClear = Object.values(STORES).filter(storeName => storeName !== "receptionErrors");

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storesToClear, "readwrite");

    for (const storeName of storesToClear) {
      transaction.objectStore(storeName).clear();
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("ローカルデータを削除できませんでした"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("ローカルデータの削除が中断されました"));
  });

  database.close();
}