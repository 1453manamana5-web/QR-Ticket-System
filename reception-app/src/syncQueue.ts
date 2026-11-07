import {getPendingSyncItems, getReceptionRecord, markSyncStatus} from "./localDb";
import {syncReceptionRecord} from "./receptionSync";

let running: Promise<void> | null = null;
let requested = false;

function isConnectionFailure(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as {code?: unknown}).code : undefined;
  return code === "unavailable" || code === "deadline-exceeded" || code === "auth/network-request-failed";
}

/** All immediate, timer and reconnect uploads use the same ordered worker. */
export function syncPendingReceptionRecords(): Promise<void> {
  requested = true;
  if (running) return running;
  let deferUntilNextRequest = false;
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
        // Only the canonical event checked by syncReceptionRecord can classify
        // a persisted scan as a trial. Cached timetables may be stale in either
        // direction and must never silently acknowledge a genuine visit.
        const key = JSON.stringify([record.eventId, record.ticketId]);
        // An exit must never overtake a failed entry for the same ticket.
        if (blockedTickets.has(key)) continue;
        try {
          const outcome = await syncReceptionRecord(record);
          await markSyncStatus(item.recordId, "synced", item.retryCount, outcome === "trial" ? "trial" : "saved");
        } catch (error) {
          blockedTickets.add(key);
          deferUntilNextRequest = isConnectionFailure(error);
          await markSyncStatus(item.recordId, "failed", item.retryCount + 1);
          console.error("受付記録のFirebase同期に失敗しました", error);
          // One blocked connection affects every ticket. Keep the remaining
          // queue intact until the next reconnect/timer request, rather than
          // spending a full network timeout on each queued receipt.
          if (deferUntilNextRequest) return;
        }
      }
    }
  })().finally(() => {
    running = null;
    // A new scan can request work after the loop's final condition, before
    // this completion callback runs. Do not lose that last upload request.
    if (!deferUntilNextRequest && requested && navigator.onLine) return syncPendingReceptionRecords();
  });
  return running;
}
