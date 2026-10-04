export type TicketStatus = "unused" | "inside" | "exited";

export type ReceptionType = "entry" | "exit" | "reentry";

export type EventAuthPayload = {
  type: "qr-ticket-event-auth";
  eventId: string;
  eventName: string;
  dataVersion: number;
  authToken: string;
};

export interface Ticket {
  ticketId: string;
  eventId: string;
  basicInfo: Record<string, unknown>;
  currentStatus: TicketStatus;
  valid: boolean;
  updatedAt: string;
}

export interface ReceptionRecord {
  recordId: string;
  eventId: string;
  ticketId: string;
  type: ReceptionType;
  timestamp: string;
  terminalId: string;
}

export interface SyncQueueItem {
  recordId: string;
  status: "pending" | "syncing" | "synced" | "failed";
  retryCount: number;
  lastAttemptAt?: string;
}

export interface Event {
  eventId: string;
  eventName: string;
  eventDate: string;
  startTime: string;
  endTime: string;
  eventStatus: "preparing" | "ready" | "active" | "finalizing" | "finished";
  dataVersion: number;
}

export interface ReceptionSettings {
  entryEnabled: boolean;
  exitEnabled: boolean;
  reentryEnabled: boolean;
}

export interface LocalEventData {
  event: Event;
  settings: ReceptionSettings;
  terminalId: string;
  authenticatedAt: string;
  dataReady: boolean;
  ticketCount: number;
}