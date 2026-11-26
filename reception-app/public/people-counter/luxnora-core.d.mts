export const signals: Readonly<Record<"camera"|"inference"|"storage"|"network"|"configuration",string>>;
export function recoveryDecision(input:{verified:boolean;visible:boolean;tracking:number;attempts:number;enabled:boolean}):boolean;
export function appendActivity<T extends {at:number;reason:string;state:string}>(history:T[],item:T):T[];
