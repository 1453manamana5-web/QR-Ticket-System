// Local-only design prototype. Never use this as an authorization boundary.
const fail = message => { throw new Error(message); };
const integer = n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000;
export function payload(value) {
  if (!value || !integer(value.entries) || !integer(value.exits) || value.exits > value.entries) fail('Invalid demo count');
  return {entries:value.entries, exits:value.exits};
}
const scoped = (value,scope) => {const p=payload(value);return scope==='entries'?{entries:p.entries}:p;};
export function create({target,mode,scope,data,now,ttl=120000}) {
  if (!['teacher','manager'].includes(target) || !['snapshot','live'].includes(mode) ||
      !['summary','entries'].includes(scope) || !Number.isFinite(now) ||
      !Number.isFinite(ttl) || ttl<=0 || ttl>900000) fail('Invalid request');
  return {target,mode,scope,status:'offered',revision:0,expiresAt:now+ttl,updatedAt:now,
    online:true,fresh:true,data:scoped(data,scope)};
}
export function advance(s, event, now) {
  if (!s || !Number.isFinite(now) || now<s.updatedAt) fail('Invalid time');
  if (['revoked','expired','declined'].includes(s.status)) return s;
  if(now>=s.expiresAt)return {...s,status:'expired',data:null};
  if(event.type==='revoke')return {...s,status:'revoked',data:null};
  if(event.type==='tick')return s;
  if(event.type==='decline'&&s.status==='offered')return {...s,status:'declined',data:null};
  if(event.type==='accept'&&s.status==='offered'&&s.online)return {...s,status:'active'};
  if(event.type==='disconnect')return {...s,online:false,fresh:false};
  if(event.type==='reconnect')return {...s,online:true};
  if(event.type==='publish'&&s.status==='active'&&s.mode==='live'&&s.online&&Number.isSafeInteger(event.revision)&&event.revision>s.revision)
    return {...s,revision:event.revision,data:scoped(event.data,s.scope),updatedAt:now,fresh:true};
  return s;
}
export function receiver(s,now) {
  if (!s || s.status!=='active' || now>=s.expiresAt || !s.data) return null;
  const data=s.scope==='entries'?{entries:s.data.entries}:{...s.data,occupancy:s.data.entries-s.data.exits};
  return {data,stale:s.mode==='live'&&(!s.online||!s.fresh),updatedAt:s.updatedAt,mode:s.mode,revision:s.revision};
}
