import type { Event, Ticket } from "@qr-ticket-system/shared";

/**
 * イベント・チケットの初期値と、画面表示に依存しないドメイン処理。
 * 振る舞いを変えずに App.tsx から分離しています。
 */
export const baseEvent: Event = {
  eventId: "",
  eventName: "",
  eventDate: "",
  startTime: "",
  endTime: "",
  eventStatus: "preparing",
  dataVersion: 1,
};

export function createEventId() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  const random = [...crypto.getRandomValues(new Uint32Array(2))].map(value=>value.toString(36).toUpperCase().padStart(7,"0")).join("");
  return `EV-${stamp}-${random}`;
}

export function createTickets(eventId: string, count: number, startNumber = 1, prefix = "TKT"): Ticket[] {
  return Array.from({ length: count }, (_, index) => {
    const ticketNumber = startNumber + index;
    const id = `${prefix}${String(ticketNumber).padStart(6, "0")}`;
    return {
      ticketId: id,
      eventId,
      basicInfo: { ticketNumber },
      currentStatus: "unused",
      valid: true,
      updatedAt: new Date().toISOString(),
    };
  });
}

/** Human-readable issue number; the stable ticketId stays untouched for QR/reception history. */
export function ticketDisplayNumber(ticket: Pick<Ticket, "ticketId" | "basicInfo">): string {
  const number = Number(ticket.basicInfo.ticketNumber);
  if (!Number.isSafeInteger(number) || number < 1) return ticket.ticketId;
  // Explicitly reissued tickets have a unique UUID suffix on their internal identity.
  const baseId = ticket.ticketId.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "");
  const match = baseId.match(/^([A-Za-z][A-Za-z0-9_-]*?)(\d{6,})$/);
  return `${match?.[1] || "TKT"}${String(number).padStart(6, "0")}`;
}

export function ticketQrValue(eventId: string, ticket: Ticket) {
  return JSON.stringify({
    type: "qr-ticket",
    eventId,
    ticketId: ticket.ticketId,
    ticketNumber: ticket.basicInfo.ticketNumber,
  });
}

export function nextStatus(status: Event["eventStatus"]): Event["eventStatus"] {
  if (status === "preparing") return "ready";
  if (status === "ready") return "active";
  if (status === "active") return "finalizing";
  if (status === "finalizing") return "finished";
  return "finished";
}

export function getAutomaticEventStatus(target: Event, now = Date.now()): Event["eventStatus"] | null {
  // The event timetable is Japan time, just like the reception trial boundary.
  const startAt = Date.parse(`${target.eventDate}T${target.startTime}:00+09:00`);
  const endAt = Date.parse(`${target.eventDate}T${target.endTime}:00+09:00`);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || !Number.isFinite(now) || endAt <= startAt) return null;

  if (now >= endAt && target.eventStatus !== "finalizing" && target.eventStatus !== "finished") return "finalizing";
  if (now >= startAt && (target.eventStatus === "preparing" || target.eventStatus === "ready")) return "active";
  return null;
}
