import type {Event,ReceptionRecord,Ticket} from './index';

/** School events are scheduled in Japan time, independent of device timezone. */
export function isBeforeEventStart(event: Pick<Event,'eventDate'|'startTime'>, at: string | number = Date.now()): boolean {
  const start=Date.parse(`${event.eventDate}T${event.startTime}:00+09:00`);
  const time=typeof at==='number'?at:Date.parse(at);
  return Number.isFinite(start)&&Number.isFinite(time)&&time<start;
}

export function productionReceptionRecords(records: readonly ReceptionRecord[], event: Event): ReceptionRecord[] {
  return records.filter(record=>record.eventId===event.eventId&&!isBeforeEventStart(event,record.timestamp));
}

/** Old versions may already have used a ticket during a pre-opening test. */
export function productionTicketStates(tickets: readonly Ticket[], event: Event): Ticket[] {
  return tickets.map(ticket=>ticket.eventId===event.eventId&&ticket.currentStatus!=='unused'&&isBeforeEventStart(event,ticket.updatedAt)
    ?{...ticket,currentStatus:'unused'}:ticket);
}
