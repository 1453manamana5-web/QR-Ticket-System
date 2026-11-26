export const stationActions: Readonly<{
  diagnose: string; sync: string; stop: string; camera: string; engine: string; recalibrate: string;
}>;
export const stationResults: Readonly<{
  ok: string; busy: string; local: string; interrupted: string; stale: string; failed: string;
}>;
export function pairingCode(random?: Pick<Crypto,"getRandomValues">): string;
