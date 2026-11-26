import {EnvironmentMonitor} from './adaptive-environment.mjs?v=14';
import {createCalibration, restoreProfileState, updateProfileState, chooseRuntimeProfile} from './adaptive-calibration.mjs?v=14';

const $ = id => document.getElementById(id);
const monitor = new EnvironmentMonitor();
const modes = {
  baseline: {label:'従来設定・無補正', width:640, lighting:false},
  detail: {label:'細部優先・入力幅最大736px', width:736, lighting:false},
  lighting: {label:'暗部補助・入力幅最大640px', width:640, lighting:true},
};
const episodeNames = {single:'正方向に1人', reverse:'逆方向に1人', group:'正方向に2人以上で横並び', idle:'立ち止まり・引き返し・荷物の移動'};
const required = Object.keys(episodeNames);
const key = 'counter-adaptive-v12';
let hooks, scope, state = restoreProfileState(null);
let wizard = null, episode = null;
let lastFault = '';
let lastNotice = '', lastReport = '';
let brightSamples = 0;
let suggestedLines;
let view = null;
let pixelsUnavailable = false;
let nextObservation = 0;
let validatedLighting = false;
let cameraDrift = false;

function save(next) {
  try {
    localStorage.setItem(key, JSON.stringify({scope,state:next,validatedLighting}));
    state = next;
    lastNotice = '';
    return true;
  } catch {
    lastNotice = '設定を保存できませんでした。前の設定を保持しています。';
    return false;
  }
}
function action(payload) {
  const next = updateProfileState(state,{...payload,now:Date.now()});
  return next !== state && save(next);
}
function setup(signature) {
  if (scope === signature) return;
  scope = signature;
  wizard = episode = null;
  monitor.reset();
  nextObservation = brightSamples = 0;
  suggestedLines = null;
  lastReport = '';
  validatedLighting = cameraDrift = false;
  try {
    const previous = JSON.parse(localStorage.getItem(key));
    state = restoreProfileState(previous?.scope === scope ? previous.state : null);
    validatedLighting = previous?.scope === scope && previous.validatedLighting === true;
  } catch { state = restoreProfileState(null); }
  renderWizard();
}
function engine() {
  return modes[episode?.profile ?? (wizard ? 'baseline' : state.active)] ?? modes.baseline;
}
function status() {
  return hooks?.status() ?? {running:false, trial:false, geometry:false, role:false};
}
function observeFault(reason) {
  lastFault = reason;
  renderDiagnostic();
}
function stopped() {
  const interrupted = !!episode;
  episode = null;
  monitor.reset();
  nextObservation = brightSamples = 0;
  pixelsUnavailable = false;
  view = null;
  if (interrupted) lastNotice = 'カメラが停止したため、途中の試験を破棄しました。';
  renderWizard();
  renderDiagnostic();
}
function isolated() { return !!wizard; }
function count() {
  if (episode) episode.count++;
}
function beginWizard() {
  const {trial, geometry, role} = status();
  if (trial || !geometry || !role) {
    lastNotice = '入口または出口を設定し、白枠にA・Bの前後を含めてから開始してください。';
    return renderWizard();
  }
  wizard = {calibration:createCalibration(), phase:'train', index:0, profiles:Object.keys(modes), recommendation:null, environment:{}};
  lastNotice = '';
  lastReport = '';
  hooks.reset();
  hooks.controls();
  renderWizard();
}
function selection() {
  if (!wizard || wizard.phase === 'review') return null;
  return {profile:wizard.profiles[Math.floor(wizard.index / required.length)],kind:required[wizard.index % required.length]};
}
function beginEpisode() {
  const selected = selection();
  if (!selected || !status().running || episode) return;
  const expected = selected.kind === 'group' ? Number($('adaptiveActual').value) : selected.kind === 'single' ? 1 : 0;
  if (!Number.isInteger(expected) || expected < 0 || expected > 10 || (selected.kind === 'group' && expected < 2)) {
    lastNotice = '正方向に通る実人数を2〜10人で入力してください。';
    return renderWizard();
  }
  episode = {...selected, expected, count:0, measurements:[], first:null,last:null,frames:0,lowLight:0,lightSamples:0,reverseSeen:false};
  lastNotice = '';
  hooks.reset();
  renderWizard();
}
function finishEpisode() {
  if (!episode || !wizard) return;
  const {first,last,frames} = episode;
  if (first === null || last - first < 800 || frames < 4) {
    lastNotice = '映像を1秒以上確認してから試験を終了してください。';
    return renderWizard();
  }
  if (episode.kind === 'reverse' && !episode.reverseSeen && episode.count === 0) {
    lastNotice = '逆方向の成立を画面で確認できませんでした。検出エリアの外からもう一度通過してください。';
    return renderWizard();
  }
  const {profile,kind,expected,count:actual,measurements:inferenceMs} = episode;
  if (!wizard.calibration.addEpisode({id:crypto.randomUUID(),profile,kind,expected,actual,inferenceMs,
    fps:(frames - 1) * 1000 / (last - first),phase:wizard.phase})) {
    lastNotice = '試験データを集計できませんでした。';
    return renderWizard();
  }
  if (wizard.phase === 'holdout' && kind !== 'reverse') {
    const light = wizard.environment[profile] ??= {low:0,total:0};
    light.low += episode.lowLight;
    light.total += episode.lightSamples;
  }
  lastNotice = '今回の正方向通過　目視 ' + expected + '人 ／ 判定 ' + actual + '人';
  episode = null;
  hooks.reset();
  wizard.index++;
  if (wizard.index === required.length * wizard.profiles.length) {
    if (wizard.phase === 'train') {
      const recommended = wizard.calibration.recommend();
      wizard.recommendation = typeof recommended === 'string' ? recommended : recommended?.profile ?? null;
      wizard.profiles = [...new Set(['baseline',wizard.recommendation].filter(Boolean))];
      wizard.phase = 'holdout';
      wizard.index = 0;
    } else wizard.phase = 'review';
  }
  renderWizard();
}
function endWizard() {
  wizard = episode = null;
  hooks.reset();
  hooks.controls();
  renderWizard();
}
function accept() {
  if (!wizard || wizard.phase !== 'review') return;
  const selectable = eligibleWinner();
  if (!selectable) return;
  const now = Date.now();
  let next = state;
  if (selectable !== 'baseline' && wizard.calibration.approved('baseline') && !state.verified.includes('baseline')) {
    next = updateProfileState(next,{type:'approve',profile:'baseline',now,approved:true});
  }
  next = updateProfileState(next,{type:'approve',profile:selectable,now,approved:true});
  const previous = validatedLighting;
  if (selectable === 'lighting') {
    const light = wizard.environment.lighting;
    validatedLighting = !!light?.total && light.low / light.total >= 0.7;
  }
  if (!save(next)) {
    validatedLighting = previous;
    return renderWizard();
  }
  cameraDrift = false;
  lastReport = trainingReport();
  lastNotice = '検証済みの設定を保存しました。';
  endWizard();
}
function trainingReport() {
  if (!wizard) return '';
  return Object.keys(modes).map(id => {
    const describe = phase => {
      const row = wizard.calibration.summary(id,phase);
      return row ? formatSummary(row) : '未測定';
    };
    return modes[id].label + '\n  比較用 ' + describe('train') + ' ／ 別試験 ' + describe('holdout');
  }).join('\n');
}
function eligibleWinner() {
  const candidate = wizard?.recommendation;
  if (candidate && wizard.calibration.approved(candidate)) {
    const trial = wizard.calibration.summary(candidate,'holdout');
    const base = wizard.calibration.summary('baseline','holdout');
    if (base.complete && trial.p95Ms <= 1.25 * base.p95Ms + 35 && trial.minFps >= base.minFps * 0.75) return candidate;
  }
  return wizard?.calibration.approved('baseline') ? 'baseline' : null;
}
function renderWizard() {
  const current = status(), selected = selection();
  $('adaptiveStart').disabled = !!wizard || current.trial;
  $('adaptiveCancel').disabled = !wizard;
  $('adaptiveBegin').disabled = !selected || !!episode || !current.running;
  $('adaptiveFinish').disabled = !episode;
  $('adaptiveAccept').disabled = wizard?.phase !== 'review' || !eligibleWinner();
  $('adaptiveActual').disabled = !selected || selected.kind !== 'group' || !!episode;
  $('adaptiveAuto').disabled = !!wizard;
  $('adaptivePin').disabled = !!wizard;
  $('adaptiveRollback').disabled = !!wizard || !state.previous;
  $('adaptiveRestore').disabled = !!wizard || !state.lastVerified;
  $('adaptiveAuto').checked = !!state.automatic;
  $('adaptivePin').checked = !!state.pinned;
  $('adaptiveInstructions').textContent = selected
    ? (wizard.phase === 'train' ? '比較用試験' : '別の通過で再検証') + '　' +
      (wizard.index + 1) + '/' + (required.length * wizard.profiles.length) + ' · ' +
      modes[selected.profile].label + ' · ' + episodeNames[selected.kind] +
      (episode ? '。試験中です。歩き終えたら「今回の試験を終了」。' : '。準備できたら「今回の試験を開始」。')
    : wizard ? (eligibleWinner() ? '独立した試験を通過。適用候補は「' + modes[eligibleWinner()].label + '」。'
      : '安全に適用できる候補を確認できませんでした。設置を見直して再試験してください。')
    : '入口・出口、A・Bと白枠を確認してから開始。設定比較中は本番集計を停止します。';
  $('adaptiveResult').textContent = wizard ? trainingReport() : lastReport;
  $('adaptiveLineSuggest').disabled = !!wizard || current.running || current.trial;
  $('adaptiveLineApply').disabled = $('adaptiveLineSuggest').disabled || !suggestedLines;
  $('adaptiveNotice').textContent = lastNotice;
  renderDiagnostic();
}
function lowLight(metrics) {
  return Number.isFinite(metrics?.luma) && (metrics.luma < 65 ||
    (metrics.centerLuma < 100 && metrics.brightFraction >= 0.22));
}
function frame({now,inferenceMs,stats,pixels,reverseSeen}) {
  if (episode) {
    episode.first ??= now;
    episode.last = now;
    episode.frames++;
    episode.reverseSeen ||= reverseSeen;
    episode.measurements.push(inferenceMs);
    if (episode.measurements.length > 64) episode.measurements.shift();
  }
  if (now < nextObservation) return;
  nextObservation = now + 500;
  const measured = stats();
  if (pixels) {
    const metrics = monitor.sample(pixels,now,{empty:measured.candidates === 0 && measured.trackCount === 0});
    if (episode && episode.kind !== 'reverse') {
      episode.lightSamples++;
      if (lowLight(metrics)) episode.lowLight++;
    }
  }
  const warnings = monitor.observe({now,inferenceMs,...measured});
  view = {...measured,inferenceMs,warnings};
  cameraDrift ||= warnings.some(w => w.code === 'cameraShift');
  renderDiagnostic();
  if (wizard || status().trial || !state.automatic || state.pinned) return;
  const idle = measured.candidates === 0 && measured.trackCount === 0;
  const overloaded = warnings.some(w => w.code === 'load');
  const dark = warnings.some(w => ['dark','partialDark','backlight'].includes(w.code)) && lowLight(monitor.metrics);
  if (pixels) brightSamples = !lowLight(monitor.metrics) ? Math.min(3,brightSamples + 1) : 0;
  const preferred = overloaded || cameraDrift || (brightSamples >= 3 && state.active === 'lighting')
    ? 'baseline'
    : dark && !pixelsUnavailable && validatedLighting && state.active === 'baseline' ? 'lighting' : state.active;
  if (chooseRuntimeProfile(state,{preferred,idle,now:Date.now()}) !== state.active &&
      action({type:'adapt',profile:preferred,idle})) {
    lastNotice = '検証済みの設定に切り替えました。';
    hooks.reset();
    renderWizard();
  }
}
function renderDiagnostic() {
  const current = status();
  $('adaptiveCamera').textContent = current.running ? 'カメラ接続済み' : 'カメラ停止中';
  $('adaptiveState').textContent = engine().label + (wizard ? ' · 試験中'
    : state.verified.includes(state.active) ? ' · 設置条件を検証済み' : ' · 設置条件は未検証');
  $('adaptiveThresholds').textContent = current.thresholds ?? '';
  const metrics = monitor.metrics;
  $('adaptiveMetrics').textContent = view ? [
    '物体検出 ' + view.candidates + '人 ／ 胴体確認 ' + view.verified + '人 ／ 追跡 ' + view.trackCount + '人 ／ この端末の計測 ' + view.total + '人',
    'BodyPix ' + (view.bodyRan ? '実行' : '待機') + ' ／ 推論 ' + Math.round(view.inferenceMs) + 'ms ／ 処理 ' + view.fps.toFixed(1) + ' FPS',
    formatMetrics(metrics,view),
  ].join('\n') : 'カメラを開始すると計測値が表示されます。';
  const warnings = (view?.warnings ?? []).map(w => '要確認　' + w.label);
  if (pixelsUnavailable) warnings.push('このブラウザでは映像品質の数値を取得できません。');
  if (cameraDrift) warnings.push('設置位置を確認し、必要に応じて再試験してください。');
  $('adaptiveWarnings').textContent = warnings.join('\n');
  $('adaptiveFault').textContent = lastFault;
  $('adaptiveHistory').textContent = state.history.map(row =>
    new Date(row.at).toLocaleString('ja-JP') + '　' + (modes[row.from]?.label ?? '—') + ' → ' +
    (modes[row.to]?.label ?? '—')).join('\n');
}
function manual(type, control) {
  if (wizard) return;
  if (['rollback','restore'].includes(type) && (status().running || status().trial)) {
    lastNotice = '計測を停止してから設定を切り替えてください。';
  } else {
    const previous = state.active;
    if (action({type,enabled:control?.checked}) && state.active !== previous) hooks.reset();
  }
  renderWizard();
}

$('adaptiveLineSuggest').addEventListener('click', () => {
  suggestedLines = hooks.suggest?.();
  $('adaptiveLineText').textContent = suggestedLines
    ? '白枠の中央付近に A ' + suggestedLines.first + '% ／ B ' + suggestedLines.second +
      '% を提案します。方向は現在の設定を使用します。'
    : '現在の白枠から提案を作れません。A・Bの前後が映るように白枠を広げてください。';
  renderWizard();
});
$('adaptiveLineApply').addEventListener('click', () => {
  if (!suggestedLines || status().running || wizard) return;
  hooks.applyLines(suggestedLines);
  suggestedLines = null;
  $('adaptiveLineText').textContent = '提案を反映しました。映像上の位置を確認してから通過試験を行ってください。';
  renderWizard();
});
$('adaptiveStart').addEventListener('click',beginWizard);
$('adaptiveBegin').addEventListener('click',beginEpisode);
$('adaptiveFinish').addEventListener('click',finishEpisode);
$('adaptiveCancel').addEventListener('click',() => {lastNotice = '設定の試験を終了しました。';endWizard();});
$('adaptiveAccept').addEventListener('click',accept);
$('adaptiveRollback').addEventListener('click',() => manual('rollback'));
$('adaptiveRestore').addEventListener('click',() => manual('restore'));
$('adaptiveAuto').addEventListener('change',event => manual('automatic',event.target));
$('adaptivePin').addEventListener('change',event => manual('pin',event.target));

window.counterAdaptive = {
  attach(api) { hooks = api; renderWizard(); },
  setup, engine, isolated, count, stopped, frame, observeFault, render:renderWizard,
  due: now => !pixelsUnavailable && now >= nextObservation,
  diagnosticsUnavailable() { pixelsUnavailable = true; },
  stationStatus: () => ({profile: episode?.profile ?? state.active,
    alert: lastFault.includes('保存') ? 'storage' : lastFault ? 'camera' : cameraDrift ? 'recalibrate' : 'none'}),
  mayRecover: () => !wizard && !status().trial && state.automatic && !state.pinned &&
    state.verified.includes(state.active) && !cameraDrift,
};

function formatMetrics(metrics,view) {
  const number = value => Number.isFinite(value) ? Math.round(value) : '—';
  return '明るさ ' + number(metrics?.luma) + '/255 ／ コントラスト ' + number(metrics?.contrast) +
    ' ／ 鮮明度 ' + number(metrics?.sharpness) + ' ／ 前フレームとの差 ' + (Number.isFinite(metrics?.motion) ? metrics.motion.toFixed(2) : '—') +
    ' ／ 候補信頼度 ' + number(view.meanConfidence === null ? null : view.meanConfidence * 100) + '%\n' +
    '局所明るさ ' + (metrics?.quadrants ?? []).map(number).join('／') +
    ' ／ 重なり ' + view.overlaps + '組 ／ 画面端 ' + view.clipped + '件 ／ 一時見失い ' + view.trackLost + '人' +
    ' ／ 背景差 ' + (Number.isFinite(metrics?.backgroundDrift) ? metrics.backgroundDrift.toFixed(2) : '—');
}
function formatSummary(row) {
  if (!row.episodes) return '未測定';
  return '漏れ側 ' + row.missed + '・過大側 ' + row.extra +
    ' ／ p95 ' + Math.round(row.p95Ms) + 'ms ／ 最低 ' + Number(row.minFps).toFixed(1) + ' FPS';
}
