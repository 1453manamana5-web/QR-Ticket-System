export function estimateClock(sent, received, server, elapsed = received - sent) {
  const uncertainty = (received - sent) / 2;
  if (!Number.isFinite(server) || uncertainty < 0 || uncertainty > 2500 ||
      Math.abs(received - sent - elapsed) > 1000) throw new Error('サーバー時刻を測定できませんでした');
  return {offset: server - (sent + received) / 2, uncertainty, measured: received};
}

export function reconcile(rows, eventId, mode) {
  const selected = rows.filter(r => r.eventId === eventId && r.mode === mode);
  const issues = [];
  const issue = (code, at, target) => issues.push({code, at, target});
  const seen = new Set();
  const originals = new Map();
  const revisions = new Map();
  for (const row of selected) {
    if (seen.has(row.id)) { issue('ID重複', row.rawAt, row.id); continue; }
    seen.add(row.id);
    if (row.kind === 'passage') originals.set(row.id, row);
    if (row.kind === 'revision') {
      const entries = revisions.get(row.target) || [];
      entries.push(row);
      revisions.set(row.target, entries);
    }
  }
  const effective = [];
  for (const [id, original] of originals) {
    let current = original;
    const edits = revisions.get(id) || [];
    const applied = new Set();
    while (true) {
      const next = edits.filter(edit => edit.parent === current.id);
      if (!next.length) break;
      const winners = next.filter(edit => next.every(other => other === edit || edit.resolves?.includes(other.id)));
      if (winners.length !== 1) { issue('修正競合', Math.min(...next.map(r => r.rawAt)), id); break; }
      const [edit] = winners;
      if (applied.has(edit.id)) break;
      for (const sibling of next) applied.add(sibling.id);
      applied.add(edit.id);
      current = {...original, ...edit.after, id: edit.id, synced: edit.synced};
    }
    if (edits.length > applied.size && !issues.some(i => i.target === id && i.code === '修正競合')) issue('修正履歴の欠損', original.rawAt, id);
    effective.push({...current, originalId: id, modified: current.id !== id});
  }
  for (const [id, edits] of revisions) {
    if (!originals.has(id)) issue('元記録の欠損', edits[0].rawAt, id);
  }
  return {effective, selected, issues};
}

export function analyze(rows, {eventId, mode, opened, closed, now = Date.now(), verified = false}) {
  const {effective, selected, issues} = reconcile(rows, eventId, mode);
  const warn = (code, at, target = eventId) => issues.push({code, at, target});
  const end = closed ?? now;
  const validWindow = Number.isFinite(opened) && Number.isFinite(end) && opened <= end && end <= now;
  if (!validWindow) warn('開閉場時刻を確認してください', now);
  for (const row of selected) {
    const queuedAt = row.createdAt ?? row.rawAt;
    if (!row.synced && now - queuedAt > 300000) warn('未同期が5分以上', queuedAt, row.id);
  }
  const sequences = new Map();
  for (const row of selected) {
    if (row.kind !== 'passage' || !Number.isSafeInteger(row.sequence)) continue;
    const list = sequences.get(row.device) || [];
    list.push(row);
    sequences.set(row.device, list);
  }
  for (const [device, list] of sequences) {
    list.sort((a,b) => a.sequence - b.sequence);
    list.forEach((row, index) => {
      if (row.sequence !== (list[index - 1]?.sequence ?? 0) + 1) warn('端末の連番に欠損または重複', row.rawAt, device);
    });
  }
  let previous = opened, occupancy = 0, area = 0, entries = 0, exits = 0, entrySum = 0, exitSum = 0;
  const timeline = [], hours = new Map(), signatures = new Set();
  const visits = effective.filter(r => !r.invalid && r.person === 'visitor');
  const corrected = visits.filter(r => {
    if (!validWindow || !Number.isFinite(r.at) || r.at < opened || r.at > end) {
      warn('通過時刻が集計範囲外', r.rawAt, r.originalId);
      return false;
    }
    if (r.clockWarning) warn(r.clockWarning, r.rawAt, r.originalId);
    if (!['in','out'].includes(r.direction)) {warn('通過方向が不正', r.rawAt, r.originalId); return false;}
    const signature = JSON.stringify([r.device, r.direction, r.at]);
    if (signatures.has(signature) && r.source === 'manual') warn('同時刻の手動記録を確認', r.at, r.originalId);
    signatures.add(signature);
    return true;
  }).sort((a,b) => a.at - b.at);
  for (let i = 0; i < corrected.length;) {
    const timestamp = corrected[i].at;
    area += occupancy * (timestamp - previous);
    previous = timestamp;
    const hour = Math.floor((timestamp + 9 * 3600000) / 3600000) * 3600000 - 9 * 3600000;
    const slot = hours.get(hour) || {at: hour, entries: 0, exits: 0};
    while (i < corrected.length && corrected[i].at === timestamp) {
      const visit = corrected[i++];
      if (visit.direction === 'in') { entries++; entrySum += timestamp - opened; occupancy++; slot.entries++; }
      else { exits++; exitSum += timestamp - opened; occupancy--; slot.exits++; }
    }
    hours.set(hour, slot);
    if (occupancy < 0) warn('滞在人数が負。欠損または時計ずれの疑い', timestamp);
    timeline.push({at: timestamp, occupancy});
  }
  if (validWindow) area += occupancy * (end - previous);
  if (closed != null && occupancy !== 0) warn('閉場時の入退場数不一致', end);
  if (closed != null && entries && entries === exits && Math.abs(exitSum - entrySum - area) > 1) warn('滞在時間の計算が不一致', end);
  const pending = selected.filter(r => !r.synced).length;
  const complete = validWindow && verified && closed != null && entries > 0 && occupancy === 0 && !issues.some(i => i.code !== '端末時刻差が30秒超（補正済み）') && !pending;
  const provisional = validWindow && closed == null && entries >= 10 && occupancy === 0 && !issues.some(i => i.code !== '端末時刻差が30秒超（補正済み）') && !pending;
  return {effective, selected, issues, pending, timeline, hours: [...hours.values()], entries, exits, occupancy,
    area: validWindow ? area : null, sumAverage: complete ? (exitSum - entrySum) / entries : null,
    integralAverage: complete ? area / entries : null, estimate: provisional ? area / entries : null};
}

export function csv(rows) {
  return '\uFEFF' + rows.map(row => row.map(value => {
    const raw = String(value ?? '');
    const safe = typeof value === 'string' && /^[\s]*[=+@-]|^[\t\r\n]/.test(raw) ? "'" + raw : raw;
    return '"' + safe.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n');
}

/** Read a snapshot once. Entries committed during upload remain in the local queue. */
export async function uploadPending(store, rows, eventId, mode, send) {
  const pending = rows.filter(row => !row.synced && row.eventId === eventId && row.mode === mode);
  for (let i = 0; i < pending.length; i += 20) {
    const batch = pending.slice(i, i + 20);
    await send(eventId, mode, batch);
    await store.mergeLedger(batch);
  }
}
