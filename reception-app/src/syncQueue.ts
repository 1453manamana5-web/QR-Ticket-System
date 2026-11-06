import {getPendingSyncItems, getReceptionRecord, markSyncStatus,loadLocalEvent} from "./localDb";
import {isBeforeEventStart} from '../../shared/src/receptionTiming';
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
        if (!navigator.onLine) break;
        const record = await getReceptionRecord(item.recordId);
        if (!record) {
          // Keep the queue entry for recovery, but make missing local history
          // visible instead of silently reporting a permanently pending upload.
          await markSyncStatus(item.recordId, "failed", item.retryCount + 1);
          console.error("受付記録が見つからないため同期できませんでした", item.recordId);
          continue;
        }
        const localEvent=await loadLocalEvent();
        if(localEvent?.event.eventId===record.eventId&&isBeforeEventStart(localEvent.event,record.timestamp)){
          await markSyncStatus(item.recordId,'synced',item.retryCount);
          continue;
        }
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
  })().finally(() => {
    running = null;
    // A new scan can request work after the loop's final condition, before
    // this completion callback runs. Do not lose that last upload request.
    if (requested && navigator.onLine) return syncPendingReceptionRecords();
  });
  return running;
}
