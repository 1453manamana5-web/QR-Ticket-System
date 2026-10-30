import type {
  LocalEventData,
  ReceptionRecord,
  SyncQueueItem,
  Ticket,
} from "@qr-ticket-system/shared";

const DB_NAME = "qr-ticket-reception";
const DB_VERSION = 8;

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

      const queueStore = transaction!.objectStore(STORES.syncQueue);
      if (!queueStore.indexNames.contains("sequence")) queueStore.createIndex("sequence", "sequence", {unique:false});

      if (!database.objectStoreNames.contains(STORES.receptionErrors)) {
        const store = database.createObjectStore(STORES.receptionErrors, {keyPath: "errorId"});
        store.createIndex("eventId", "eventId", {unique: false});
        store.createIndex("category", "category", {unique: false});
        store.createIndex("timestamp", "timestamp", {unique: false});
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("ローカルデータベースを開けませんでした"));
  });
}

export async function saveLocalEvent(data: LocalEventData): Promise<void> {
  const database = await openDatabase();

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORES.event, "readwrite");
      transaction.objectStore(STORES.event).put(data);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("イベントデータを保存できませんでした"));
      transaction.onabort = () => reject(transaction.error ?? new Error("端末内保存が中断されました"));
    });
  } finally {
    database.close();
  }
}

export async function loadLocalEvent(validateInventory=false): Promise<LocalEventData | null> {
  const database = await openDatabase();
  try{
    return await new Promise<LocalEventData | null>((resolve,reject)=>{
      const tx=database.transaction([STORES.event,STORES.tickets],"readonly");
      const request=tx.objectStore(STORES.event).getAll();
      let value:LocalEventData|null=null;
      request.onsuccess=()=>{
        value=request.result[0]??null;
        if(validateInventory && value?.dataReady){
          const count=tx.objectStore(STORES.tickets).index("eventId").count(value.event.eventId);
          count.onsuccess=()=>{if(count.result!==value!.ticketCount){reject(new Error("LOCAL_EVENT_INCOMPLETE"));tx.abort();}};
        }
      };
      tx.oncomplete=()=>resolve(value);
      tx.onerror=()=>reject(tx.error??new Error("イベントデータを読み込めませんでした"));
      tx.onabort=()=>reject(tx.error??new Error("イベントデータの読み込みが中断されました"));
    });
  }finally{database.close();}
}

export async function prepareLocalEventData(event: LocalEventData, tickets: Ticket[]): Promise<void> {
  const eventId = event.event.eventId;
  const ticketIds = new Set<string>();

  if (!eventId || !event.terminalId || !event.settings ||
      ![event.settings.entryEnabled,event.settings.exitEnabled,event.settings.reentryEnabled].every(value => typeof value === "boolean")) {
    throw new Error("イベントIDがありません");
  }
  if (event.ticketCount !== tickets.length) {
    throw new Error(`取得したチケット件数がイベント情報と一致しません（${tickets.length}/${event.ticketCount}）`);
  }

  for (const ticket of tickets) {
    if (!ticket.ticketId || ticket.eventId !== eventId || typeof ticket.valid !== "boolean" ||
        !["unused","inside","exited"].includes(ticket.currentStatus) || !ticket.basicInfo || typeof ticket.basicInfo !== "object") {
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
        [STORES.event, STORES.tickets, STORES.syncQueue, STORES.receptionRecords],
        "readwrite"
      );
      const eventStore = transaction.objectStore(STORES.event);
      const ticketStore = transaction.objectStore(STORES.tickets);
      const currentEventRequest=eventStore.getAll();

      const abort=(message:string)=>{reject(new Error(message));transaction.abort();};

      // Refresh inventory without rolling back locally accepted, unsent scans.
      const queueRequest = transaction.objectStore(STORES.syncQueue).getAll();
      queueRequest.onsuccess = () => {
        const pendingQueue = (queueRequest.result as SyncQueueItem[]).filter(item => item.status !== "synced");
        const pendingIds = new Set(pendingQueue.map(item => item.recordId));
        const sequences = new Map(pendingQueue.map(item => [item.recordId, item.sequence]));
        // Queue entries point to records; read them in this same transaction.
        const pendingRecords = new Map<string, {record: ReceptionRecord; sequence?: number}>();
        let remaining = pendingIds.size;
        const storeInventory = () => {
          const current=(currentEventRequest.result as LocalEventData[])[0];
          if(current?.event.eventId===eventId && current.event.dataVersion>readyEvent.event.dataVersion){
            abort("LOCAL_EVENT_VERSION_CHANGED");return;
          }
          eventStore.clear();
          ticketStore.clear();
          eventStore.put(readyEvent);
          for (const ticket of tickets) {
            const pending = pendingRecords.get(ticket.ticketId)?.record;
            ticketStore.put(pending
              ? {...ticket, currentStatus: pending.type === "exit" ? "exited" : "inside",
                updatedAt: pending.timestamp}
              : ticket);
          }
          // Verify within the same transaction. A later refresh in another tab
          // must never make this refresh delete that tab's committed inventory.
          const savedEvent=eventStore.get(eventId);
          const savedTickets=ticketStore.index("eventId").getAll(eventId);
          savedTickets.onsuccess=()=>{
            const saved=savedEvent.result as LocalEventData|undefined;
            const inventory=savedTickets.result as Ticket[];
            const ids=new Set(inventory.map(ticket=>ticket.ticketId));
            if(!saved?.dataReady || saved.ticketCount!==tickets.length || inventory.length!==tickets.length ||
                ids.size!==ticketIds.size || [...ticketIds].some(id=>!ids.has(id))){
              abort("イベント・チケットデータの保存後検証に失敗しました。直前の保存済みデータを保持しました");
            }
          };
        };
        if (!remaining) { storeInventory(); return; }
        for (const recordId of pendingIds) {
          const request = transaction.objectStore(STORES.receptionRecords).get(recordId);
          request.onsuccess = () => {
            const record = request.result as ReceptionRecord | undefined;
            if (record?.eventId === eventId) {
              const previous = pendingRecords.get(record.ticketId);
              const sequence = sequences.get(recordId);
              const newer = !previous || (sequence !== undefined
                ? previous.sequence === undefined || sequence > previous.sequence
                : previous.sequence === undefined && record.timestamp >= previous.record.timestamp);
              if (newer) pendingRecords.set(record.ticketId, {record, sequence});
            }
            if (--remaining === 0) storeInventory();
          };
        }
      };

      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("イベント・チケットデータを保存できませんでした"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("イベント・チケットデータの保存が中断されました"));
    });
  } finally {
    database.close();
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

  try {
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
      transaction.onabort = () => reject(transaction.error ?? new Error("端末内保存が中断されました"));
    });
  } finally {
    database.close();
  }
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
  record: ReceptionRecord,
  expectedLocalTicket?: Ticket | null
): Promise<void> {
  const database = await openDatabase();

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        [STORES.event, STORES.tickets, STORES.receptionRecords, STORES.syncQueue],
        "readwrite"
      );

      const ticketStore=transaction.objectStore(STORES.tickets);
      const currentTicket=ticketStore.get(ticket.ticketId);
      const eventRequest=transaction.objectStore(STORES.event).get(record.eventId);
      currentTicket.onsuccess=()=>{
        const current=currentTicket.result as Ticket | undefined;
        if(expectedLocalTicket!==undefined){
          const same=expectedLocalTicket===null?!current:Boolean(current)&&["ticketId","eventId","currentStatus","valid","updatedAt"].every(key=>current![key as keyof Ticket]===expectedLocalTicket[key as keyof Ticket]);
          if(!same){reject(new Error("LOCAL_TICKET_CHANGED"));transaction.abort();return;}
        }
      };
      eventRequest.onsuccess=()=>{
        const saved=eventRequest.result as LocalEventData | undefined;
        if(expectedLocalTicket!==undefined && (!saved?.dataReady || saved.event.eventId!==record.eventId)){
          reject(new Error("LOCAL_EVENT_CHANGED"));transaction.abort();return;
        }
        if(!currentTicket.result && saved){
          transaction.objectStore(STORES.event).put({...saved,ticketCount:saved.ticketCount+1});
        }
        ticketStore.put(ticket);
        transaction.objectStore(STORES.receptionRecords).put(record);
        const queueStore=transaction.objectStore(STORES.syncQueue);
        const existing=queueStore.index("sequence").openCursor(null,"prev");
        existing.onsuccess=()=>{
          const sequence=((existing.result?.value as SyncQueueItem | undefined)?.sequence??0)+1;
          queueStore.put({recordId:record.recordId,status:"pending",retryCount:0,sequence} satisfies SyncQueueItem);
        };
      };

      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("受付データを保存できませんでした"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("受付データの保存が中断されました"));
    });
  } finally {
    database.close();
  }
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
  try {
    return await new Promise<SyncQueueItem[]>((resolve, reject) => {
      const tx = database.transaction([STORES.syncQueue, STORES.receptionRecords], "readonly");
      const timestamps = new Map<string, number>();
      const pending: SyncQueueItem[] = [];
      const statusIndex = tx.objectStore(STORES.syncQueue).index("status");
      for (const status of ["pending","failed","syncing"]) {
        const queue = statusIndex.getAll(status);
        queue.onsuccess = () => {
          for (const item of queue.result as SyncQueueItem[]) {
            pending.push(item);
            const record = tx.objectStore(STORES.receptionRecords).get(item.recordId);
            record.onsuccess = () => {
              const parsed = Date.parse((record.result as ReceptionRecord | undefined)?.timestamp ?? "");
              timestamps.set(item.recordId, Number.isFinite(parsed) ? parsed : 0);
            };
          }
        };
      }
      tx.oncomplete = () => resolve(pending.sort((a, b) => {
        if (a.sequence !== undefined && b.sequence !== undefined) return a.sequence - b.sequence;
        // Queues captured by older app versions have no insertion sequence.
        if (a.sequence !== undefined) return 1;
        if (b.sequence !== undefined) return -1;
        return (timestamps.get(a.recordId) ?? 0) - (timestamps.get(b.recordId) ?? 0) ||
          a.recordId.localeCompare(b.recordId);
      }));
      tx.onerror = () => reject(tx.error ?? new Error("同期キューを読み込めませんでした"));
      tx.onabort = () => reject(tx.error ?? new Error("同期キューの読み込みが中断されました"));
    });
  } finally {
    database.close();
  }
}

export async function markSyncStatus(
  recordId: string,
  status: SyncQueueItem["status"],
  retryCount: number
): Promise<void> {
  const database = await openDatabase();

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORES.syncQueue, "readwrite");
      const store = transaction.objectStore(STORES.syncQueue);
      const request = store.get(recordId);
      request.onsuccess = () => {
        const previous = request.result as SyncQueueItem | undefined;
        if (previous) store.put({...previous, status, retryCount, lastAttemptAt: new Date().toISOString()});
      };

      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("同期状態を保存できませんでした"));
      transaction.onabort = () => reject(transaction.error ?? new Error("端末内保存が中断されました"));
    });
  } finally {
    database.close();
  }
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

  // Event replacement must never erase unsent records or error logs.
  const storesToClear = [STORES.event, STORES.tickets];

  try {
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
  } finally {
    database.close();
  }
}
