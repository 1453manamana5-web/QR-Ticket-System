export type TicketStatus = "unused" | "inside" | "exited";

export type ReceptionType = "entry" | "exit" | "reentry";

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

export interface Event {
  eventId: string;
  eventName: string;
  eventStatus: "preparing" | "ready" | "active" | "finalizing" | "finished";
  dataVersion: number;
}
