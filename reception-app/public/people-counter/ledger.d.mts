export type CounterMode = "live" | "test";
export type CounterDirection = "in" | "out";
export type CounterPerson = "visitor" | "staff";
export type CounterPassageFields = {
  at: number;
  direction: CounterDirection;
  person: CounterPerson;
  invalid: boolean;
  clockWarning?: string;
  clockUncertainty?: number | null;
};
type CounterBase = {
  id: string;
  eventId: string;
  mode: CounterMode;
  device: string;
  rawAt: number;
  createdAt?: number;
  actorUid?: string;
  synced?: boolean;
  station?: CounterDirection;
};
export type CounterPassage = CounterBase & CounterPassageFields & {
  kind: "passage";
  source: "auto" | "manual";
  passageId?: string;
  sequence?: number;
  reason?: string;
};
export type CounterRevision = CounterBase & {
  kind: "revision";
  target: string;
  parent: string;
  reason: string;
  resolves?: string[];
  before: CounterPassageFields;
  after: CounterPassageFields;
};
export type CounterOperation = CounterPassage | CounterRevision;
export type EffectiveCounterPassage = CounterPassage & {originalId: string; modified: boolean};
export type CounterIssue = {code: string; at: number; target: string};

export function analyze(rows: CounterOperation[], context: {
  eventId: string;
  mode: CounterMode;
  opened: number;
  closed?: number | null;
  now?: number;
  verified?: boolean;
}): {
  effective: EffectiveCounterPassage[];
  selected: CounterOperation[];
  issues: CounterIssue[];
  pending: number;
  timeline: {at: number; occupancy: number}[];
  hours: {at: number; entries: number; exits: number}[];
  entries: number;
  exits: number;
  occupancy: number;
  area: number | null;
  sumAverage: number | null;
  integralAverage: number | null;
  estimate: number | null;
};
export function reconcile(rows: CounterOperation[], eventId: string, mode: CounterMode): Pick<ReturnType<typeof analyze>, "effective" | "selected" | "issues">;
export function csv(rows: unknown[][]): string;
export function estimateClock(sent: number, received: number, server: number, elapsed?: number): {
  offset: number; uncertainty: number; measured: number;
};
export function uploadPending(store: {mergeLedger(rows: CounterOperation[]): Promise<void>}, rows: CounterOperation[], eventId: string, mode: CounterMode,
  send: (eventId: string, mode: CounterMode, batch: CounterOperation[]) => Promise<unknown>): Promise<void>;
