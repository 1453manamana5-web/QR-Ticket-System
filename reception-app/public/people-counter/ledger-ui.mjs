import {analyze, csv, estimateClock, uploadPending} from './ledger.mjs';
import {initialConnection,observeConnection} from './connection.mjs?v=16';
import {sameStationScope,stationResults} from './station-command.mjs?v=16';
import {createVisionPipeline} from './vision.mjs?v=16';

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
let connection = initialConnection;
let activeCursor;
let loadedScope;
let lastSuccessfulPull = 0;
let syncError = '';
let lastClockSample = {wall: Date.now(), mono: performance.now()};
let clockChanged = false;
let remoteModule;
let remoteAttempts = 0;
let stationState = 'unchecked';
let assignedRole = loadAssignedRole(settings);
let deniedStation = loadDeniedStation(settings);
let stationNote = '';
let control = loadControl(settings);
let controlTimer;
let controlFlight;
let lastHeartbeat = -Infinity;
let heartbeatScope;
let activePending = 0;
let retainedPending = 0;
let stationCommandFlight;
let lastCommandPoll = -Infinity;
let lastCommandScope;
const dedicatedDay = cfg => /^[a-f0-9-]{36}_[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(cfg?.eventId ?? '');
const pairingKey = cfg => 'counter-pair-v1:' + cfg.eventId;
const commandResultKey = cfg => 'counter-command-result-v1:' + cfg.eventId;
const controlKey = cfg => 'counter-control-v1:' + cfg.eventId + ':' + cfg.mode;
function loadControl(cfg) {
  if (!cfg) return null;
  const cached = load('counter-control-v1:' + cfg.eventId + ':' + cfg.mode);
  if (!cached || ![cached.opened,cached.closed].every(value => value === null || Number.isSafeInteger(value)) ||
      typeof cached.paused !== 'boolean' || typeof cached.verified !== 'boolean') return null;
  return cached;
}
function loadAssignedRole(cfg) {
  if (!cfg) return null;
  const value = load('counter-role-v1:' + cfg.eventId);
  return ['in','out'].includes(value) ? value : null;
}
function loadDeniedStation(cfg) {
  if (!cfg) return '';
  const cached = load('counter-denied-v1:' + cfg.eventId);
  return ['rejected','revoked','mismatch'].includes(cached) ? cached : '';
}
function captureBlockReason() {
  if ((settings?.mode === 'live' || dedicatedDay(settings)) && deniedStation) return 'この端末の本番承認を確認してください。管理画面で再承認されるまで計測を待機します。';
  if (dedicatedDay(settings) &&
      (!control || !Number.isSafeInteger(control.version))) return '管理画面からの運用設定をまだ確認できません。';
  if (control?.closed != null && control.closed <= Date.now()) return '管理画面で閉場済みです。';
  if (control?.paused) return '管理画面で計測が一時停止されています。';
  if (assignedRole && settings?.role !== assignedRole) return '端末の設置区分が管理画面で変更されました。停止中に運用設定とA・Bの方向を確認してください。';
  return '';
}
function renderStation() {
  const statuses = {
    unchecked:'端末登録の状態を未確認', missing:'未申請', pending:'承認待ち', approved:'承認済み',
    rejected:'申請が却下されました', revoked:'端末承認が解除されました', mismatch:'このSafariの登録と端末IDが一致しません',
  };
  $('counterStationState').textContent = !settings ? '運用設定を保存すると端末登録を申請できます。'
    : (statuses[stationState] ?? statuses.unchecked) + (assignedRole ? ' · 管理側の指定 ' + (assignedRole === 'out' ? '出口' : '入口') : '') +
      (stationNote ? ' · ' + stationNote : '');
  const paired = dedicatedDay(settings);
  const invitation = paired ? load(pairingKey(settings)) : null;
  const remaining = invitation && device === invitation.device ? Math.max(0,300000 - (Date.now() - invitation.displayedAt)) : 0;
  $('counterStationApply').textContent = paired ? '接続コードを表示' : '端末登録を申請';
  $('counterStationApply').disabled = !settings || !device || !['unchecked','missing',...(paired ? ['pending','rejected','revoked'] : [])].includes(stationState) || remaining > 270000;
  $('counterPairCode').textContent = stationState === 'pending' && remaining > 0 ?
    '管理画面に入力する接続コード　' + invitation.code + '　残り約 ' + Math.ceil(remaining/60000) + '分' :
    stationState === 'pending' && paired ? '接続コードを再発行できます。' : '';
  $('counterRemoteControl').textContent = captureBlockReason() || (control ? '管理画面の集計期間を使用しています。' : '');
}
async function remoteApi() {
  return remoteModule ??= await import('./counter-sync.js?v=16&try=' + remoteAttempts++);
}
function storeControl(config, next) {
  if (settings !== config || (!next && (control?.paused || control?.closed != null))) return;
  if (JSON.stringify(control) === JSON.stringify(next)) return;
  control = next;
  try { localStorage.setItem(controlKey(config), JSON.stringify(next)); }
  catch { error('取得した管理設定を端末に保存できませんでした。'); }
  window.dispatchEvent(new Event('counter-control-changed'));
  changed();
}
function pollStationCommand(config, remote, station) {
  if (!dedicatedDay(config) || !Number.isSafeInteger(control?.version) || stationCommandFlight) return;
  const scope = config.eventId + ':' + config.mode;
  const now = performance.now();
  if (lastCommandScope === scope && now - lastCommandPoll < 12000) return;
  lastCommandScope = scope;
  lastCommandPoll = now;

  const run = async () => {
    const command = await deadline(remote.readStationCommand(config.eventId));
    if (!command || settings !== config || document.hidden) return;
    const saved = load(commandResultKey(config));
    if (command.state === 'running' && saved?.id === command.id &&
        saved.device === device && Object.prototype.hasOwnProperty.call(stationResults,saved.result)) {
      await deadline(remote.updateStationCommand(config.eventId,command.id,saved.result,saved.downtimeMs));
      return;
    }
    if (command.state !== 'issued' || !sameStationScope(command,station,config.mode,control?.version) ||
        !await deadline(remote.updateStationCommand(config.eventId,command.id))) return;
    let outcome = 'failed', downtimeMs;
    try {
      if (settings !== config || !sameStationScope(command,station,config.mode,control?.version)) outcome = 'stale';
      else if (document.hidden) outcome = 'interrupted';
      else if (command.action === 'sync') {
        const until = performance.now()+20000;
        while (busy && settings === config && performance.now() < until) {
          await new Promise(resolve => setTimeout(resolve,250));
        }
        if (settings !== config || document.hidden) outcome = 'stale';
        else outcome = busy ? 'busy' : await sync() ? 'ok' : 'failed';
      } else {
        const result = await window.counterStationAction?.(command.action);
        outcome = typeof result === 'string' ? result : result?.result ?? 'local';
        downtimeMs = result?.downtimeMs;
      }
    } catch {}
    try {localStorage.setItem(commandResultKey(config),JSON.stringify({id:command.id,device,result:outcome,downtimeMs}));}
    catch {error('遠隔操作の結果を端末に保存できませんでした。');}
    await deadline(remote.updateStationCommand(config.eventId,command.id,outcome,downtimeMs));
    lastHeartbeat = -Infinity;
    scheduleControl(500);
  };
  const flight = run();
  stationCommandFlight = flight;
  void flight.catch(() => {}).finally(() => {if (stationCommandFlight === flight) stationCommandFlight = null;});
}

function checkStation(config, remote) {
  if (controlFlight?.config === config) return controlFlight.promise;
  const promise = (async () => {
    const started=performance.now();
    const station = await deadline(remote.readCounterStation(config.eventId));
    if (settings !== config) return false;
    connection=observeConnection(connection,{success:true,roundTrip:performance.now()-started});
    stationNote = '';
    if (station && station.device !== device) {
      stationState = 'mismatch';
      assignedRole = null;
    } else {
      stationState = station?.status ?? 'missing';
      assignedRole = stationState === 'approved' && ['in','out'].includes(station?.role) ? station.role : null;
    }
    if (assignedRole) {
      try { localStorage.setItem('counter-role-v1:' + config.eventId,JSON.stringify(assignedRole)); } catch {}
    }
    const denial = ['rejected','revoked','mismatch'].includes(stationState) ? stationState : '';
    if (denial || stationState === 'approved') {
      deniedStation = denial;
      try { localStorage.setItem('counter-denied-v1:' + config.eventId,JSON.stringify(denial)); } catch {}
    }
    renderStation();
    window.dispatchEvent(new Event('counter-control-changed'));
    if (stationState !== 'approved') return false;
    storeControl(config, await deadline(remote.readCounterConfig(config.eventId,config.mode)));
    if (settings === config) pollStationCommand(config,remote,station);
    const scope = config.eventId + ':' + config.mode;
    const now = performance.now();
    if (settings === config && (heartbeatScope !== scope || now - lastHeartbeat >= 30000)) {
      heartbeatScope = scope;
      lastHeartbeat = now;
      const state = window.counterStationCamera?.() ?? {};
      const metrics = {
        version:'16', camera:state.camera === true, ai:state.ai === true,
        profile:['baseline','detail','lighting'].includes(state.profile) ? state.profile : 'unknown',
        pending:Math.min(activePending,1000000), mode:config.mode, configVersion:control?.version ?? null,
        ...(state.activity||state.fps!=null||state.inferenceMs!=null ? {lux:{
          fps:Number.isFinite(state.fps)?Math.min(240,Math.max(0,state.fps)):null,
          inferenceMs:Number.isSafeInteger(state.inferenceMs)?Math.min(60000,Math.max(0,state.inferenceMs)):null,
          activity:state.activity??null,
        }} : {}),
        alert:(control?.paused || control?.closed != null) ? 'paused' : captureBlockReason() ? 'setup'
          : ['recalibrate','camera','storage'].includes(state.alert) ? state.alert
          : network === '同期エラー' ? 'network' : 'none',
      };
      // The bounded heartbeat runs independently from the upload queue.
      void deadline(remote.heartbeatCounterStation(config.eventId,metrics)).catch(() => {});
    }
    return settings === config;
  })();
  const flight = {config,promise};
  controlFlight = flight;
  void promise.finally(() => { if (controlFlight === flight) controlFlight = null; }).catch(() => {});
  return promise;
}
function scheduleControl(ms = 15000) {
  clearTimeout(controlTimer);
  controlTimer = setTimeout(async () => {
    const config = settings;
    if (config && device && !document.hidden && navigator.onLine !== false) {
      try {
        const approved = await checkStation(config,await deadline(remoteApi()));
        if (approved && stationState === 'approved' && network === '未承認') schedule(0);
      } catch (error) {
        if (settings === config) {
          if (!String(error?.code ?? '').includes('permission-denied') && !busy) {
            connection=observeConnection(connection,{success:false,offline:navigator.onLine===false});renderState();
          }
          stationNote = 'サーバーに接続できません。端末内の記録を保持します。';
          renderStation();
        }
      }
    }
    scheduleControl();
  },ms);
}
const iso = ms => Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : '';
const minutes = ms => Number.isFinite(ms) ? (ms / 60000).toFixed(2) : '算出不可';
const localDate = ms => Number.isFinite(ms) ? iso(ms - new Date(ms).getTimezoneOffset() * 60000).slice(0,23) : '';
const error = message => { $('ledgerError').textContent = message; };
function renderState() {
  $('ledgerState').textContent = settings
    ? (settings.mode === 'live' ? '本番' : '試験') + ' · ' + (settings.role === 'in' ? '入口' : '出口') +
      ' · 通信 ' + connection.label + ' · 同期 ' + network + ' · 未同期 ' + pending + '件'
    : '運用設定を保存すると通過ごとの記録を始めます。';
  if (syncError) $('ledgerState').textContent += ' · ' + syncError;
  if (retainedPending) $('ledgerState').textContent += ' · 同期できない旧端末記録 ' + retainedPending +
    '件。CSVで確認し、人数カウント管理画面で必要な修正を行ってください。';
  $('adaptiveSync').textContent = syncError ? network + ' · 未同期 ' + pending + '件' : '';
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
    ...(Number.isSafeInteger(control?.version) ? {configVersion:control.version} : {}),
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
  activePending = rows.filter(r => !r.synced && r.eventId === config.eventId && r.mode === config.mode).length;
  retainedPending = rows.filter(r => !r.synced && r.eventId === config.eventId && r.mode === config.mode &&
    (!automaticPassage(r) || (assignedRole && r.station !== assignedRole))).length;
  const windowSettings = control ? {...config,...control} : config;
  result = analyze(rows, {...windowSettings, verified: windowSettings.verified && windowSettings.closed != null &&
    lastSuccessfulPull >= windowSettings.closed && network === 'オンライン'});
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
function automaticPassage(row) {
  return row.kind === 'passage' && row.source === 'auto' && row.person === 'visitor' && row.device === device && row.station === row.direction;
}
function schedule(ms) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void sync(), ms);
}
async function sync() {
  if (busy || !store || !settings || !device) return;
  const config = settings;
  busy = true;
  network = '同期中';
  renderState();
  try {
    if (navigator.onLine === false) throw new Error('インターネットに接続していません。');
    const remote = await deadline(remoteApi());
    if (!await checkStation(config,remote)) {
      network = '未承認';
      syncError = '';
      retry = 15000;
      return;
    }
    if (!clock || clockChanged || Date.now() - clock.measured > 600000) {
      const sent = Date.now(), mono = performance.now();
      try {
        const server = await deadline(remote.serverClock(config.eventId));
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
        if (settings !== config) break;
        let role = assignedRole;
        if (eventId !== config.eventId) {
          const other = await deadline(remote.readCounterStation(eventId));
          if (other?.status !== 'approved' || other.device !== device) continue;
          role = other.role;
        }
        const allowed = snapshot.filter(row => automaticPassage(row) && row.station === role);
        await uploadPending(store, allowed, eventId, mode, (...args) => deadline(remote.pushOperations(...args)));
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
    if (settings===config && !String(e?.code ?? '').includes('permission-denied')) {
      connection=observeConnection(connection,{success:false,offline:navigator.onLine===false});
    }
    network = navigator.onLine === false ? 'オフライン' : '同期エラー';
    syncError = '端末内の記録を保持して再試行します。 ' + e.message;
    retry = Math.min(retry * 2, 120000);
  } finally {
    busy = false;
    try {await refresh();} catch (e) {error(e.message);}
    schedule(network === 'オンライン' ? (activePending > retainedPending ? 3000 : 30000) : retry);
  }
  return network === 'オンライン' && settings === config;
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
  if (window.counterAdaptive?.isolated()) return error('認識設定の試験を終了してから通過記録を修正してください。');
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
  if (window.counterAdaptive?.isolated()) return error('認識設定の試験を終了してから運用設定を変更してください。');
  if ($('startButton').disabled || !$('stopButton').disabled) return error('カメラを停止してから設定してください。');
  const eventId = $('ledgerEvent').value.trim();
  const opened = new Date($('ledgerOpen').value).getTime();
  const closed = $('ledgerClose').value ? new Date($('ledgerClose').value).getTime() : null;
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(eventId) || !Number.isFinite(opened) ||
      (closed != null && (!Number.isFinite(closed) || closed < opened))) return error('イベントIDと開閉場時刻を確認してください。');
  if (settings?.eventId === eventId && assignedRole && $('ledgerRole').value !== assignedRole) {
    return error('管理画面で指定された入口・出口を選び、計測ラインの方向を確認してください。');
  }
  const next = {eventId, mode: $('ledgerMode').value, role: $('ledgerRole').value,
    opened, closed, verified: closed != null && $('ledgerVerified').checked};
  try {
    if (!device) {
      const id = crypto.randomUUID();
      localStorage.setItem('counter-device-v1', JSON.stringify(id));
      device = id;
    }
    localStorage.setItem(setupKey, JSON.stringify(next));
    const scopeChanged = !settings || settings.eventId !== next.eventId || settings.mode !== next.mode;
    settings = next;
    if (scopeChanged) {
      control = loadControl(settings);
      stationState = 'unchecked';
      deniedStation = loadDeniedStation(settings);
      assignedRole = null;
      stationNote = '';
    }
    renderStation();
    window.dispatchEvent(new Event('counter-control-changed'));
    window.dispatchEvent(new Event("counter-role-changed"));
    lastSuccessfulPull = 0;
    editing = false;
    $('ledgerTarget').value = '';
    error('');
    await refresh();
    selectRecord();
    schedule(0);
    scheduleControl(0);
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
    timeline: () => [['日時 UTC','滞在人数'],[iso(control ? control.opened : settings.opened),0],...timeline.map(r => [iso(r.at),r.occupancy])],
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
$('exportPendingJson').addEventListener('click', async () => {
  if (!settings || !store) return error('先に運用設定を保存してください。');
  const scope = settings;
  try {
    const rows = (await store.ledger()).filter(row => row.eventId === scope.eventId && row.mode === scope.mode && !row.synced);
    if (settings !== scope) return;
    if (!rows.length) return error('選択中のイベント・運用区分に未同期記録はありません。');
    const clip = row => {
      if (row.kind !== 'revision') return row;
      // Old local drafts carry additional fields copied from the automatic passage.
      const {direction,person,invalid,clockWarning,clockUncertainty,configVersion,...revision} = row;
      return revision;
    };
    const window = control ?? scope;
    const savedAt = Date.now();
    const from = window.opened ?? 0;
    const blob = new Blob([JSON.stringify({schema:'counter-day-backup',version:1,scope:scope.eventId,mode:scope.mode,
      name:'未同期記録',savedAt,window:{from,to:window.closed ?? Math.max(from,savedAt)},operations:rows.map(clip)},null,2)],{type:'application/json'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'counter-' + scope.eventId + '-' + scope.mode + '-pending.json';
    document.body.append(link);link.click();link.remove();
    setTimeout(() => URL.revokeObjectURL(url),30000);
    error('');
  } catch (cause) {error('未同期記録を出力できませんでした。 ' + cause.message);}
});
$('counterStationApply').addEventListener('click', async () => {
  if (!settings || !device || $('counterStationApply').disabled) return;
  const config = settings;
  const name = $('counterStationName').value.trim();
  if (!name || name.length > 40) return error('端末名を1〜40文字で入力してください。');
  if (navigator.onLine === false) return error('端末登録にはインターネット接続が必要です。');
  $('counterStationApply').disabled = true;
  try {
    const remote = await deadline(remoteApi());
    const code = await deadline(remote.enrollCounterStation(config.eventId,{name,device,role:config.role},dedicatedDay(config)));
    if (code && settings === config) localStorage.setItem(pairingKey(config),JSON.stringify({code,displayedAt:Date.now(),device}));
    if (settings === config) {
      error('');
      await checkStation(config,remote);
      schedule(0);
    }
  } catch (e) {
    if (settings === config) error('端末登録を申請できませんでした。 ' + e.message);
  } finally { renderStation(); }
});
$('syncLedger').addEventListener('click', () => schedule(0));
window.addEventListener('online', () => {scheduleControl(0); schedule(500);});
window.addEventListener('focus', () => {changed(); scheduleControl(0); schedule(500);});
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleControl(0); });
setInterval(() => {if (stationState === 'pending') renderStation();},5000);
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
  scheduleControl(500);
}
window.counterLedger = {capture, role: () => settings?.role, configured: () => !!settings, attach, changed, captureBlockReason};
if (window.counterRecordStore) attach(window.counterRecordStore);
fillRecord();
renderState();
renderStation();

const offlineState = $('offlineState');
const preparedKey = 'counter-offline-v10';
async function offlineLabel() {
  let ready = false;
  if (navigator.serviceWorker?.controller?.scriptURL.endsWith('/counter-offline.js') && load(preparedKey)) {
    try {
      const requests = await (await caches.open('counter-model-assets-v1')).keys();
      ready = (await caches.keys()).includes('counter-v16') &&
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
