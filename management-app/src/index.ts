import type { Event } from "@qr-ticket-system/shared";

export function getAppName(): string {
  return "QR Ticket System - Management";
}

export type ManagementEvent = Event;
