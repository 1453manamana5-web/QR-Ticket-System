import {getPendingSyncItems, getReceptionRecord, markSyncStatus} from "./localDb";
import {syncReceptionRecord} from "./receptionSync";

let running: Promise<void> | null = null;
let requested = false;

/** All immediate, timer and reconnect uploads use the same ordered worker. */
export function syncPendingReceptionRecords(): Promise<void> {
  requested = true;
  if (running) return running;
  running = (async () => {
    while (requested && navigator.onLine) {
      requested = false;
      const blockedTickets = new Set<string>();
      for (const item of await getPendingSyncItems()) {
        const record = await getReceptionRecord(item.recordId);
        if (!record) continue;
        const key = JSON.stringify([record.eventId, record.ticketId]);
        // An exit must never overtake a failed entry for the same ticket.
        if (blockedTickets.has(key)) continue;
        try {
          await syncReceptionRecord(record);
          await markSyncStatus(item.recordId, "synced", item.retryCount);
        } catch (error) {
          blockedTickets.add(key);
          await markSyncStatus(item.recordId, "failed", item.retryCount + 1);
          console.error("受付記録のFirebase同期に失敗しました", error);
        }
      }
    }
  })().finally(() => { running = null; });
  return running;
}
