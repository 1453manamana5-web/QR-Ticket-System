export type ReceptionTerminalState = {
  terminalId: string;
  approved: boolean;
  role?: string;
  receptionApproved?: boolean;
  status: string;
  lastSeen: string | null;
  syncPendingCount?: number;
  receptionMode?: "entry" | "exit" | "stopped";
  receptionEventId?: string;
  receptionReportedAt?: string | {toMillis:()=>number};
};

/** An old zero count is not proof that an offline terminal has uploaded its records. */
export function receptionDataCollected(terminals: ReceptionTerminalState[], eventId: string, now = Date.now()): boolean {
  return terminals.filter(terminal => terminal.approved && (
    ((terminal.role === "reception" || terminal.role === "both") && terminal.receptionApproved !== false) ||
    (terminal.receptionEventId === eventId && terminal.receptionMode !== undefined)
  )).every(terminal => {
    const reported = terminal.receptionReportedAt;
    const reportedAt = typeof reported === "string" ? Date.parse(reported) : reported?.toMillis();
    const age = now - (reportedAt ?? NaN);
    return terminal.status === "online" && Number.isFinite(age) && age >= -5000 && age <= 30000 &&
      terminal.syncPendingCount === 0 && terminal.receptionMode === "stopped" &&
      terminal.receptionEventId === eventId;
  });
}

export function localDateValue(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}

export function csvCell(value: unknown): string {
  let text=String(value??"");
  if(/^[\s]*[=+@-]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
