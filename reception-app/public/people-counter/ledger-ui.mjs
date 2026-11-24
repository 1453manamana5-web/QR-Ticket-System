import {analyze, csv, estimateClock, uploadPending} from './ledger.mjs';
import {createVisionPipeline} from './vision.mjs?v=10';

const $ = id => document.getElementById(id);
const setupKey = 'counter-ledger-settings-v1';
function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
let settings = load(setupKey);
let clock = load('counter-clock-v1');
let device = load('counter-device-v1');
let store;
let result;
let editParent;
let editTimeSource;
let editing = false;
let busy = false;
let retry = 5000;
let syncTimer;
let pending = 0;
let network = '同期未確認';
let activeCursor;
let loadedScope;
let lastSuccessfulPull = 0;
let syncError = '';
let lastClockSample = {wall: Date.now(), mono: performance.now()};
let clockChanged = false;
let remoteModule;
let remoteAttempts = 0;
const iso = ms => Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : '';
const minutes = ms => Number.isFinite(ms) ? (ms / 60000).toFixed(2) : '算出不可';
const localDate = ms => Number.isFinite(ms) ? iso(ms - new Date(ms).getTimezoneOffset() * 60000).slice(0,23) : '';
const error = message => { $('ledgerError').textContent = message; };
function renderState() {
  $('ledgerState').textContent = settings
    ? (settings.mode === 'live' ? '本番' : '試験') + ' · ' + (settings.role === 'in' ? '入口' : '出口') +
      ' · ' + network + ' · 未同期 ' + pending + '件'
    : '運用設定を保存すると通過ごとの記録を始めます。';
  if (syncError) $('ledgerState').textContent += ' · ' + syncError;
  $('clockState').textContent = clock && !clockChanged
    ? '時刻補正 ' + Math.round(clock.offset) + ' ms · 通信による誤差の目安 ±' +
      Math.round(clock.uncertainty) + ' ms · 測定 ' + new Date(clock.measured).toLocaleString('ja-JP')
    : '時刻補正を確認できていません。';
}
function checkClock(rawAt) {
  const mono = performance.now();
  if (Math.abs(rawAt - lastClockSample.wall - (mono - lastClockSample.mono)) > 2500) clockChanged = true;
  if (clock && rawAt < clock.measured - 2500) clockChanged = true;
  lastClockSample = {wall: rawAt, mono};
}
function capture(rawAt, source) {
  if (!settings || !device) return undefined;
  checkClock(rawAt);
  const usable = clock && !clockChanged;
  return {eventId: settings.eventId, mode: settings.mode, rawAt,
    at: rawAt + (usable ? clock.offset : 0), device, station: settings.role, direction: settings.role,
    person: 'visitor', source, invalid: false, clockUncertainty: usable ? clock.uncertainty : null,
    clockWarning: clockChanged ? '端末の時計が変更された疑い' : !usable ? '時刻未補正'
      : rawAt - clock.measured > 3600000 ? '時刻補正が1時間以上前'
      : Math.abs(clock.offset) > 30000 ? '端末時刻差が30秒超（補正済み）' : ''};
}
let refreshTimer;
function changed() {
  if (!refreshTimer) refreshTimer = setTimeout(() => {refreshTimer = null; void refresh().catch(e => error(e.message));}, 300);
}
async function refresh() {
  if (!store || !settings) return;
  const config = settings;
  const rows = await store.ledger();
  if (config !== settings) return;
  pending = rows.filter(r => !r.synced).length;
  result = analyze(rows, {...config, verified: config.verified && config.closed != null &&
    lastSuccessfulPull >= config.closed && network === 'オンライン'});
  const {entries, exits, occupancy, area, sumAverage, integralAverage, estimate, issues} = result;
  $('ledgerSummary').textContent = [
    '入場 ' + entries + '人　退場 ' + exits + '人　滞在人数 ' + occupancy + '人',
    '累積滞在 ' + minutes(area) + ' 人・分',
    '確定平均（時刻差 / 人数積分） ' + minutes(sumAverage) + ' / ' + minutes(integralAverage) + ' 分',
    '暫定平均 ' + minutes(estimate) + ' 分。開場中に10件以上入場し、現在空室で、未同期や異常がない時点の累積人・分 ÷ 入場数。',
    '判定 ' + (sumAverage != null ? '確定可能' : '確定条件未充足') + ' · イベント内未同期 ' + result.pending + '件 · 異常 ' + issues.length + '件',
  ].join('\n');
  $('ledgerIssues').replaceChildren(...issues.slice(0, 50).map(({code,at,target}) => {
    const item = document.createElement('li');
    item.textContent = code + ' · ' + iso(at) + ' · ' + target;
    return item;
  }));
  if (!editing) {
    const previous = $('ledgerTarget').value;
    $('ledgerTarget').replaceChildren(new Option('新規通過記録',''), ...result.effective.slice()
      .sort((a,b) => b.at - a.at).map(r => new Option(
        iso(r.at) + ' · ' + (r.direction === 'in' ? '入場' : '退場') + (r.invalid ? ' · 無効' : '') + ' · ' + r.originalId.slice(-8),
        r.originalId)));
    if (result.effective.some(r => r.originalId === previous)) $('ledgerTarget').value = previous;
  }
  renderState();
}

async function deadline(work) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('サーバーが応答しません')), 15000);
    })]);
  } finally {clearTimeout(timer);}
}
function schedule(ms) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void sync(), ms);
}
async function sync() {
  if (busy || !store || !settings) return;
  const config = settings;
  busy = true;
  network = '同期中';
  renderState();
  try {
    const remote = remoteModule ??= await import('./counter-sync.js?v=10&try=' + remoteAttempts++);
    if (!clock || clockChanged || Date.now() - clock.measured > 600000) {
      const sent = Date.now(), mono = performance.now();
      try {
        const server = await deadline(remote.serverClock());
        clock = estimateClock(sent, Date.now(), server, performance.now() - mono);
        clockChanged = false;
        lastClockSample = {wall: Date.now(), mono: performance.now()};
        try {localStorage.setItem('counter-clock-v1', JSON.stringify(clock));} catch {}
      } catch (e) { error(e.message + '。時刻補正を確認してください。'); }
    }
    const snapshot = await store.ledger();
    const scopes = new Map(snapshot.filter(row => !row.synced).map(row => [JSON.stringify([row.eventId,row.mode]), [row.eventId,row.mode]]));
    const activeScope = JSON.stringify([config.eventId,config.mode]);
    scopes.set(activeScope, [config.eventId,config.mode]);
    let scopeError;
    for (const [scope,[eventId,mode]] of scopes) {
      try {
        await uploadPending(store, snapshot, eventId, mode, (...args) => deadline(remote.pushOperations(...args)));
        if (scope !== activeScope) continue;
        if (loadedScope !== scope) {activeCursor = undefined; loadedScope = scope;}
        do {
          const page = await deadline(remote.pullOperations(eventId,mode,activeCursor));
          await store.mergeLedger(page.rows);
          activeCursor = page.cursor;
          if (page.rows.length < 200) break;
        } while (settings === config);
      } catch (e) { scopeError = e; }
    }
    if (scopeError) throw scopeError;
    network = 'オンライン';
    syncError = '';
    if (settings === config) lastSuccessfulPull = Date.now() + (clock?.offset ?? 0);
    retry = 5000;
  } catch (e) {
    network = navigator.onLine === false ? 'オフライン' : '同期エラー';
    syncError = '端末内の記録を保持して再試行します。 ' + e.message;
    retry = Math.min(retry * 2, 120000);
  } finally {
    busy = false;
    try {await refresh();} catch (e) {error(e.message);}
    schedule(network === 'オンライン' ? (pending ? 3000 : 30000) : retry);
  }
}

function fillRecord(row) {
  editTimeSource = row;
  $('editAt').value = localDate(row?.at ?? Date.now());
  $('editDirection').value = row?.direction ?? settings?.role ?? 'in';
  $('editPerson').value = row?.person ?? 'visitor';
  $('editInvalid').checked = !!row?.invalid;
}
function selectRecord() {
  const id = $('ledgerTarget').value;
  const row = result?.effective.find(entry => entry.originalId === id);
  editParent = row?.id;
  editing = !!id;
  fillRecord(row);
  $('editHistory').textContent = (result?.selected ?? []).filter(r => r.kind === 'revision' && r.target === id)
    .map(r => iso(r.rawAt) + ' · ' + r.device + ' · ' + r.reason + '\n' + JSON.stringify(r.before) + ' → ' + JSON.stringify(r.after)).join('\n');
}
$('ledgerTarget').addEventListener('change', selectRecord);
$('restoreLedger').addEventListener('click', () => {
  const original = result?.selected.find(r => r.id === $('ledgerTarget').value);
  if (original) fillRecord(original);
});
$('ledgerEdit').addEventListener('submit', async event => {
  event.preventDefault();
  if (!store || !settings) return error('先に運用設定を保存してください。');
  const at = new Date($('editAt').value).getTime();
  const reason = $('editReason').value.trim();
  if (!Number.isFinite(at) || !reason) return error('通過時刻と理由を入力してください。');
  const id = $('ledgerTarget').value, now = Date.now();
  const keptTime = editTimeSource && Math.trunc(editTimeSource.at) === at;
  const after = {at: keptTime ? editTimeSource.at : at, direction: $('editDirection').value,
    person: $('editPerson').value, invalid: $('editInvalid').checked,
    clockWarning: keptTime ? editTimeSource.clockWarning : '',
    clockUncertainty: keptTime ? editTimeSource.clockUncertainty : null};
  const base = {...capture(now,'manual'), synced: false};
  const parent = editParent;
  const conflictIds = result?.selected.filter(r => r.target === id && r.parent === parent).map(r => r.id) ?? [];
  try {
    const before = result?.effective.find(r => r.originalId === id && r.id === parent);
    if (id && !before) return error('対象が更新されました。選び直してください。');
    if (id && conflictIds.length > 1 && !confirm('競合した修正を残し、フォームの内容を採用しますか？')) return;
    const row = id ? {...base, kind: 'revision', id: 'edit:' + crypto.randomUUID(), target: id, parent,
      reason, resolves: conflictIds.length > 1 ? conflictIds : [],
      before: Object.fromEntries(Object.keys(after).map(k => [k,before[k] ?? null])), after}
      : {...base, ...after, rawAt: at, createdAt: now, kind: 'passage', id: 'ledger:' + crypto.randomUUID(), reason};
    await store.addLedger(row);
    editing = false;
    $('ledgerTarget').value = '';
    $('editReason').value = '';
    await refresh();
    selectRecord();
    schedule(500);
  } catch (e) {error('保存できませんでした。 ' + e.message);}
});

$('ledgerSetup').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('startButton').disabled || !$('stopButton').disabled) return error('カメラを停止してから設定してください。');
  const eventId = $('ledgerEvent').value.trim();
  const opened = new Date($('ledgerOpen').value).getTime();
  const closed = $('ledgerClose').value ? new Date($('ledgerClose').value).getTime() : null;
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(eventId) || !Number.isFinite(opened) ||
      (closed != null && (!Number.isFinite(closed) || closed < opened))) return error('イベントIDと開閉場時刻を確認してください。');
  const next = {eventId, mode: $('ledgerMode').value, role: $('ledgerRole').value,
    opened, closed, verified: closed != null && $('ledgerVerified').checked};
  try {
    if (!device) {
      const id = crypto.randomUUID();
      localStorage.setItem('counter-device-v1', JSON.stringify(id));
      device = id;
    }
    localStorage.setItem(setupKey, JSON.stringify(next));
    settings = next;
    lastSuccessfulPull = 0;
    editing = false;
    $('ledgerTarget').value = '';
    error('');
    await refresh();
    selectRecord();
    schedule(0);
  } catch (e) {error('運用設定を保存できませんでした。 ' + e.message);}
});

$('exportLedger').addEventListener('click', async () => {
  if (!settings || !store) return error('先に運用設定を保存してください。');
  try {await refresh();} catch (e) {return error(e.message);}
  const kind = $('ledgerExport').value;
  const {effective, selected, hours, timeline, issues, sumAverage, integralAverage, area, estimate, pending} = result;
  const reports = {
    passages: () => [['記録ID','イベント','運用','元の日時 UTC','補正日時 UTC','端末','設置区分','方向','来場者区分','自動・手動','同期','修正','無効','時刻誤差ms'],
      ...effective.map(r => [r.originalId,r.eventId,r.mode,iso(r.rawAt),iso(r.at),r.device,r.station,r.direction,r.person,r.source,
        selected.filter(op => op.id === r.originalId || op.target === r.originalId).every(op => op.synced) ? '同期済み' : '未同期',
        r.modified,r.invalid,r.clockUncertainty])],
    edits: () => [['修正ID','元記録ID','直前版ID','修正時刻 UTC','端末','理由','修正前','修正後','同期済み'],
      ...selected.filter(r => r.kind === 'revision').map(r => [r.id,r.target,r.parent,iso(r.rawAt),r.device,r.reason,JSON.stringify(r.before),JSON.stringify(r.after),r.synced])],
    hours: () => [['時刻 JST','入場','退場'], ...hours.map(r => [iso(r.at + 32400000).replace('Z','+09:00'),r.entries,r.exits])],
    timeline: () => [['日時 UTC','滞在人数'],[iso(settings.opened),0],...timeline.map(r => [iso(r.at),r.occupancy])],
    average: () => [['イベント','運用','確定時刻差 分','確定積分 分','累積 人分','暫定 分','未同期','異常数'],
      [settings.eventId,settings.mode,minutes(sumAverage),minutes(integralAverage),minutes(area),minutes(estimate),pending,issues.length]],
    issues: () => [['異常','日時 UTC','対象'], ...issues.map(r => [r.code,iso(r.at),r.target])],
  };
  const url = URL.createObjectURL(new Blob([csv(reports[kind]())], {type: 'text/csv;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'counter-' + settings.eventId + '-' + settings.mode + '-' + kind + '.csv';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});
$('syncLedger').addEventListener('click', () => schedule(0));
window.addEventListener('online', () => schedule(500));
window.addEventListener('focus', () => {changed(); schedule(500);});
setInterval(() => {
  checkClock(Date.now());
  changed();
}, 30000);

if (settings) {
  $('ledgerEvent').value = settings.eventId;
  $('ledgerMode').value = settings.mode;
  $('ledgerRole').value = settings.role;
  $('ledgerOpen').value = localDate(settings.opened).slice(0,16);
  $('ledgerClose').value = localDate(settings.closed).slice(0,16);
  $('ledgerVerified').checked = settings.verified;
}
function attach(value) {
  store = value;
  changed();
  schedule(500);
}
window.counterLedger = {capture, configured: () => !!settings, attach, changed};
if (window.counterRecordStore) attach(window.counterRecordStore);
fillRecord();
renderState();

const offlineState = $('offlineState');
const preparedKey = 'counter-offline-v10';
async function offlineLabel() {
  let ready = false;
  if (navigator.serviceWorker?.controller?.scriptURL.endsWith('/counter-offline.js') && load(preparedKey)) {
    try {
      const requests = await (await caches.open('counter-model-assets-v1')).keys();
      ready = (await caches.keys()).includes('counter-v10') &&
        requests.some(r => r.url.endsWith('/efficientdet_lite0.tflite')) &&
        requests.some(r => r.url.endsWith('/quant2/075/model-stride16.json'));
    } catch {}
  }
  offlineState.textContent = ready
    ? 'モデルのオフライン準備済み。カメラを使う前に通信を切って起動確認できます。'
    : '初回はオンラインでモデルのオフライン準備を行ってください。';
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./counter-offline.js').then(offlineLabel)
    .catch(e => {offlineState.textContent = 'オフライン準備に失敗しました。 ' + e.message;});
  navigator.serviceWorker.addEventListener('controllerchange', offlineLabel);
}
$('prepareOffline').addEventListener('click', async () => {
  if (!navigator.serviceWorker?.controller?.scriptURL.endsWith('/counter-offline.js')) {
    offlineState.textContent = 'オフライン準備の起動中です。少し待って再試行してください。';
    return;
  }
  if ($('startButton').disabled) {
    offlineState.textContent = 'カメラを停止してからオフライン準備を行ってください。';
    return;
  }
  const button = $('prepareOffline');
  button.disabled = true;
  $('startButton').disabled = true;
  let pipeline;
  try {
    pipeline = await createVisionPipeline({onProgress: message => {offlineState.textContent = message;}});
    localStorage.setItem(preparedKey, 'true');
    offlineLabel();
  } catch (e) {offlineState.textContent = 'オフライン準備に失敗しました。 ' + e.message;}
  finally {
    pipeline?.close();
    button.disabled = false;
    $('startButton').disabled = false;
  }
});
