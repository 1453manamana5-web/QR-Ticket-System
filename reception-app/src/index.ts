import type { ReceptionRecord, Ticket } from "@qr-ticket-system/shared";

export function getAppName(): string {
  return "QR Ticket System - Reception";
}

export type ReceptionTicket = Ticket;
export type ReceptionHistory = ReceptionRecord;
