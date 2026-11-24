import { LineTracker } from "./tracker.mjs?v=13";
import { PROFILES, peopleFromResult } from "./detection.mjs?v=13";

import { verifyBodies } from "./body-check.mjs?v=13";
import { createVisionPipeline } from "./vision.mjs?v=13";

import { openRecordStore, totalOf } from "./records.mjs?v=13";
import { CameraHealth, MAX_INFERENCE_MS, withDeadline } from "./health.mjs?v=13";
const SESSION_KEY = "koken-counter-session-v1";
const OPTIONS_KEY = "koken-counter-options-v1";
const adaptive = window.counterAdaptive;
const $ = id => document.getElementById(id);
const video = $("video"), canvas = $("overlay"), ctx = canvas.getContext("2d");
const startButton = $("startButton"), stopButton = $("stopButton");
let analysisFrame = document.createElement("canvas");
let analysisCtx = analysisFrame.getContext("2d");
const defaults = { movement: "x+", first: 40, second: 60, profile: "side", bodyMode: "torso", left: 0, right: 100, top: 0, bottom: 100 };

let recordStore = null;
let initialized = false;
let readyPromise = null;
let revision = -1;
let activeLeaseOwner = null;
let leaseRelease = Promise.resolve();
let leaseTimer = null;
let healthTimer = null;
let health = null;
let inferenceStarted = null;
let pollTimer = null;
let channel = null;
let session = "";
let events = [];
let counter = 0;
let detector = null;
let detectorLoading = null;
let inferencePending = null;
let trackingEpoch = 0;
let startAttempt = 0;
let stream = null;
let running = false;
let raf = 0;
let lastSample = 0;
let lastVideoTime = -1;
let recentTimes = [];
let eventQueue = Promise.resolve();
let settings = { ...defaults };
let diagnosticFrame, diagnosticCtx;
let recoveryTimer, recoveryUsed = false;

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return String(Date.now()) + "-" + Math.random().toString(36).slice(2);
}
function status(label, kind = "") {
  const el = $("status");
  el.textContent = label;
  el.className = "state " + kind;
}
function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}
function localGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function localSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function setStorageBusy(busy) {
  for (const id of ["startButton", "addButton", "minusButton", "exportButton", "resetButton"]) $(id).disabled = busy;
  if (!busy) $("minusButton").disabled = counter < 1;
}
function applySnapshot(snapshot) {
  if (snapshot.revision < revision) return;
  const changed = session && snapshot.session !== session;
  if (changed && (running || stream || activeLeaseOwner)) {
    stopCamera(); status("試験が切り替わりました");
    message("別の画面で新しい試験が始まったため、計測を停止しました。", true);
  }
  session = snapshot.session; revision = snapshot.revision; events = snapshot.events;
  localSet(SESSION_KEY, session); // Compatibility hint only; IndexedDB is authoritative.
  if (changed) resetTracking();
  renderRecords();
}
function announce() { try { channel?.postMessage({ changed: true }); } catch {} }
async function refreshRecords() {
  if (!recordStore || !initialized) return;
  try { applySnapshot(await recordStore.read()); }
  catch (error) { storageFailure(error); }
}
function storageFailure(error) {
  stopCamera(); status("保存エラー", "bad");
  adaptive?.observeFault("保存エラー。計測を停止しました。");
  message("記録を保存・確認できないため計測を停止しました: " + (error?.message || String(error)), true);
}
function renderRecords() {
  counter = totalOf(events);
  $("total").textContent = counter.toLocaleString("ja-JP");
  const last = events.at(-1);
  $("latest").textContent = last ? new Date(last.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "まだありません";
  $("minusButton").disabled = counter < 1;
  const list = $("history");
  list.replaceChildren();
  if (!events.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "まだ記録がありません";
    list.append(empty);
    return;
  }
  for (const item of events.slice(-12).reverse()) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = item.type === "auto" ? "自動計測" : "手動訂正";
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = new Date(item.at).toLocaleTimeString("ja-JP");
    const delta = document.createElement("span");
    delta.className = "delta " + (item.delta > 0 ? "positive" : "negative");
    delta.textContent = (item.delta > 0 ? "+" : "") + item.delta;
    li.append(label, time, delta);
    list.append(li);
  }
}
function record(delta, type) {
  if (adaptive?.isolated() || (type === "auto" && window.counterLedger?.captureBlockReason?.())) return Promise.resolve();
  const capturedSession = session || null;
  const owner = activeLeaseOwner;
  const at = Date.now();
  const passage = delta > 0 ? window.counterLedger?.capture(at, type) : undefined;
  const ready = initialize();
  eventQueue = eventQueue.then(async () => {
    if (!await ready) return;
    const result = await recordStore.append({ delta, type, expectedSession: capturedSession || session, owner, now: at, passage });
    applySnapshot(result.snapshot);
    if (result.status === "lease-lost" || result.status === "session-changed") {
      stopCamera(); status("計測を停止しました", "bad");
      message("別の画面で計測または試験が切り替わりました。人数を確認して再開してください。", true);
    }
    if (result.status === "saved") {
      announce();
      if (passage) window.counterLedger?.changed();
    }
  }).catch(storageFailure);
  return eventQueue;
}
const trialAngles = { side: "真横", "25": "斜め25°", "45": "斜め45°" };
const areaEdges = ["left", "right", "top", "bottom"];
let trial = null;
let trialResults = [];
let testDirections = null;

function renderTrials(showResults = false) {
  $("trialStart").disabled = !running || !!trial || !!adaptive?.isolated();
  $("trialEnd").disabled = !trial || trial.ended;
  $("trialSave").disabled = !trial?.ended;
  $("trialDiscard").disabled = !trial;
  $("trialAngle").disabled = !!trial;
  $("trialNote").disabled = !!trial;
  const lock = !!trial || !!adaptive?.isolated();
  $("reverseDirection").disabled = lock;
  $("overlayTarget").disabled = lock;
  for (const id of ["viewMode", "bodyMode", "movement", "firstLine", "secondLine", ...areaEdges]) $(id).disabled = lock;
  $("trialStatus").textContent = trial
    ? trialAngles[trial.angle] + " · 自動 " + trial.count + "人" + (trial.ended ? " · 実人数を入力してください" : " · 検証中")
    : "カメラを開始し、設置角度を選んで検証を始めてください。";
  renderDirectionTest();
  adaptive?.render();
  if (!showResults) return;
  $("trialResults").replaceChildren();
  for (const result of trialResults) {
    const item = document.createElement("li");
    const diff = result.count - result.actual;
    item.textContent = trialAngles[result.angle] + " ／ 自動 " + result.count + "人 ／ 実際 " + result.actual +
      "人 ／ 差 " + (diff > 0 ? "+" : "") + diff + "人 ／ " + result.condition;
    $("trialResults").append(item);
  }
}
function endTrial(interrupted = false) {
  if (!trial || trial.ended) return;
  trial.ended = true;
  testDirections = null;
  if (interrupted) trial.condition += " ／ カメラ停止で終了";
  resetTracking();
  renderTrials();
}
function areaSettings(source) {
  const result = {};
  for (const edge of areaEdges) {
    const value = source[edge];
    result[edge] = Number.isInteger(value) && value >= 0 && value <= 100 ? value : defaults[edge];
  }
  if (result.right - result.left < 10 || result.bottom - result.top < 10) {
    return {left: 0, right: 100, top: 0, bottom: 100};
  }
  return result;
}
function areaContainsLines() {
  const a = Math.round(tracker.lineAt(tracker.first) * 100), b = Math.round(tracker.lineAt(tracker.second) * 100);
  const [lo, hi] = tracker.axis === "x" ? [settings.left, settings.right] : [settings.top, settings.bottom];
  return Math.min(a, b) > lo && Math.max(a, b) < hi;
}
function inArea(point) {
  return point.x * 100 >= settings.left && point.x * 100 <= settings.right &&
    point.y * 100 >= settings.top && point.y * 100 <= settings.bottom;
}
const entranceSides = {start: "廊下側", end: "展示室側", action: "入場"};
const exitSides = {start: "展示室側", end: "廊下側", action: "退場"};
function directionSides() {
  return window.counterLedger?.role?.() === "out" ? exitSides : entranceSides;
}
function renderDirections() {
  const {start, end, action} = directionSides();
  $("directionGuide").textContent = "正方向 A（" + start + "）→ B（" + end + "）は" + action +
    "を記録。逆方向 B → A は対象外。";
  drawOverlay([]);
}
function renderDirectionTest() {
  $("directionTest").textContent = testDirections
    ? "正方向 A→B " + (testDirections.forward ? "確認済み" : "待機") +
      " ／ 逆方向 B→A " + (testDirections.reverse ? "除外を確認" : "待機")
    : "";
}
function resetTracking() { trackingEpoch++; tracker.reset(); }
function suggestCalibrationLines() {
  const [low, high] = tracker.axis === "x" ? [settings.left, settings.right] : [settings.top, settings.bottom];
  const [start, end] = tracker.direction === 1 ? [low, high] : [100 - high, 100 - low];
  const first = Math.max(20,Math.min(48,Math.round(start + (end - start) * .33)));
  const second = Math.max(52,Math.min(80,Math.round(start + (end - start) * .67)));
  return start < first && end > second && second - first >= 10 ? {first,second} : null;
}
function syncAdaptiveScope() {
  if (!adaptive) return;
  const {movement,first,second,left,right,top,bottom,profile,bodyMode} = settings;
  const role = window.counterLedger?.role?.() ?? null;
  adaptive.setup(JSON.stringify([12,role,movement,first,second,left,right,top,bottom,profile,bodyMode]));
}
function configureTracker() {
  trackingEpoch++;
  const [axis, sign] = settings.movement.split("");
  tracker.configure({
    axis,
    direction: sign === "+" ? 1 : -1,
    first: settings.first / 100,
    second: settings.second / 100,
    minHits: PROFILES[settings.profile].minHits,
    minMeanScore: PROFILES[settings.profile].minMeanScore,
  });
  $("firstValue").textContent = settings.first + "%";
  $("secondValue").textContent = settings.second + "%";
  $("movement").value = settings.movement;
  $("viewMode").value = settings.profile;
  $("bodyMode").value = settings.bodyMode;
  $("bodyHint").textContent = settings.bodyMode === "legs"
    ? "胴体から太もも・すね・足先まで、見えている片側を追加確認します。足先まで映るように設置してください。脚や足が隠れると数えない場合があります。"
    : "肩〜腰の胴体で確認します。脚・足先が画面外でも使用できます。";
  $("viewHint").textContent = settings.profile === "side"
    ? "真横では肩〜腰の胴体が映る距離に固定し、左右へ歩いてください。頭は必須ではありません。脚・足先の条件は下で選べます。見えている側の胴体を確認し、黄色い点がA→Bを越えると加算します。灰色の候補は数えません。重なりや体の見切れで数え漏れる場合があります。"
    : "斜め上から撮る場合の標準設定です。肩〜腰の胴体が映るように設置してください。頭は必須ではありません。脚・足先の条件は下で選べます。胴体を確認した黄色い点がA→Bを越えると加算します。灰色の候補は数えません。";
  $("firstLine").value = String(settings.first);
  $("secondLine").value = String(settings.second);
  for (const edge of areaEdges) {
    $(edge).value = String(settings[edge]);
    $(edge + "Value").textContent = settings[edge] + "%";
  }
  $("areaStatus").textContent = areaContainsLines()
    ? "白枠の内側で人物を追跡します。"
    : "白枠にA・Bの両ラインと、その前後を含めてください。";
  renderDirections();
  syncAdaptiveScope();
}
const tracker = new LineTracker(({trackId}) => {
  if (adaptive?.isolated()) return adaptive.count();
  $("lastPassage").textContent = "ID " + trackId + " · A→Bを通過し、人物確認の条件を満たしました。";
  if (!trial) return record(1, "auto");
  if (!trial.ended) {
    trial.count++;
    testDirections.forward = true;
    renderTrials();
  }
});

function drawOverlay(detections, tracks = []) {
  if (!canvas.width || !canvas.height) return;
  const w = canvas.width, h = canvas.height;
  const sx = w / analysisFrame.width, sy = h / analysisFrame.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#f7f8fc";
  ctx.lineWidth = Math.max(2, w / 350);
  ctx.strokeRect(settings.left * w / 100, settings.top * h / 100,
    (settings.right - settings.left) * w / 100, (settings.bottom - settings.top) * h / 100);
  const {start, end} = directionSides();
  const lines = [
    { at: tracker.lineAt(tracker.first), name: "A " + start, color: "#3b82f6", labelY: 26 },
    { at: tracker.lineAt(tracker.second), name: "B " + end, color: "#00b79a", labelY: 50 },
  ];
  ctx.lineWidth = Math.max(2, w / 420);
  ctx.font = "bold " + Math.max(16, w / 42) + "px sans-serif";
  for (const line of lines) {
    ctx.strokeStyle = line.color;
    ctx.fillStyle = line.color;
    ctx.setLineDash([Math.max(8, w / 75), Math.max(5, w / 130)]);
    ctx.beginPath();
    if (tracker.axis === "x") {
      const x = line.at * w;
      ctx.moveTo(x, settings.top * h / 100); ctx.lineTo(x, settings.bottom * h / 100);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(line.name, Math.min(w - 90, x + 7), line.labelY);
    } else {
      const y = line.at * h;
      ctx.moveTo(settings.left * w / 100, y); ctx.lineTo(settings.right * w / 100, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(line.name, 11, Math.max(25, y - 9));
    }
  }
  ctx.setLineDash([]);
  const debug = $("showTracking").checked;
  const ids = debug ? new Map(tracks.map(track => [track.observation?.box, track.id])) : null;
  for (const d of detections) {
    const color = d.bodyVerified ? "#f9dc72" : "#a8b4c0";
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, w / 330);
    ctx.strokeRect(d.box.originX * sx, d.box.originY * sy, d.box.width * sx, d.box.height * sy);
    ctx.fillStyle = color;
    ctx.font = "bold " + Math.max(13, w / 57) + "px sans-serif";
    ctx.fillText((ids?.has(d.box) ? "ID " + ids.get(d.box) + " · " : "") + (d.bodyVerified ? (d.legVerified ? "人物・胴体＋脚足確認" : "人物・胴体確認") : "候補・人数に含めません"), d.box.originX * sx + 3, Math.max(15, d.box.originY * sy - 6));
    if (d.bodyVerified) {
      ctx.fillStyle = "rgba(249, 220, 114, 0.18)";
      ctx.fillRect(d.body.left * w, d.body.top * h, d.body.width * w, d.body.height * h);
      ctx.strokeRect(d.body.left * w, d.body.top * h, d.body.width * w, d.body.height * h);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(d.x * w, d.y * h, Math.max(4, w / 160), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (debug) for (const track of tracks) {
    ctx.strokeStyle = "#6ee7ff";
    ctx.beginPath();
    track.trail.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x * w, point.y * h);
      else ctx.lineTo(point.x * w, point.y * h);
    });
    ctx.stroke();
  }
}
function discardDetector(model = detector, pending = inferencePending) {
  if (detector === model) { detector = null; detectorLoading = null; }
  const close = () => { try { model?.close(); } catch {} };
  if (pending) void Promise.resolve(pending).then(close, close);
  else close();
}
function stopCamera() {
  clearTimeout(recoveryTimer);
  endTrial(true);
  startAttempt++;
  running = false;
  adaptive?.stopped();
  diagnosticFrame = diagnosticCtx = null;
  renderTrials();
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  clearInterval(healthTimer); healthTimer = null;
  clearInterval(leaseTimer); leaseTimer = null;
  health = null; inferenceStarted = null;
  const owner = activeLeaseOwner; activeLeaseOwner = null;
  if (owner && recordStore) leaseRelease = eventQueue.then(() => recordStore.releaseLease(owner)).catch(() => {});
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  video.pause(); video.srcObject = null; video.style.display = "none";
  $("placeholder").hidden = false;
  stopButton.disabled = true;
  startButton.disabled = !initialized;
  $("fps").textContent = "検出速度 —";
  $("diagnostics").textContent = "";
  $("lastPassage").textContent = "";
  $("tracking").textContent = "検出待ち";
  recentTimes = [];
  resetTracking();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
function scheduleRecovery() {
  recoveryUsed = true;
  const attempt = startAttempt;
  stopButton.disabled = false;
  recoveryTimer = setTimeout(() => {
    if (startAttempt !== attempt) return;
    if (document.hidden || !adaptive?.mayRecover()) stopButton.disabled = true;
    else void startCamera({automaticRetry:true});
  },1000);
}
function cameraFailure(text, discard = false, retry = true) {
  const recover = retry && !recoveryUsed && !document.hidden && tracker.tracks.length === 0 && adaptive?.mayRecover();
  if (discard) discardDetector();
  stopCamera(); status("計測停止", "bad"); message(text, true);
  adaptive?.observeFault(text);
  if (recover) scheduleRecovery();
}
function checkCameraHealth() {
  if (!running || !health) return;
  const ended = stream?.getTracks().some(track => track.readyState === "ended");
  const reason = health.check(performance.now(), { videoTime: video.currentTime, ended, inferenceStarted });
  if (reason) cameraFailure(reason, inferenceStarted !== null);
}
function readDiagnostics(now) {
  if (!adaptive?.due(now)) return null;
  try {
    if (!diagnosticFrame) {
      diagnosticFrame = document.createElement("canvas");
      diagnosticFrame.width = 48;
      diagnosticFrame.height = 32;
      diagnosticCtx = diagnosticFrame.getContext("2d", {willReadFrequently: true});
    }
    diagnosticCtx.drawImage(video, 0, 0, 48, 32);
    return diagnosticCtx.getImageData(0, 0, 48, 32);
  } catch {
    adaptive.diagnosticsUnavailable();
    return null;
  }
}
function frameStats(result, candidates, accepted, tracks, visibleTracks) {
  const heights = candidates.map(person => person.h).sort((a,b) => a-b);
  const clipped = candidates.filter(({box}) => box.originX === 0 || box.originY === 0 ||
    box.originX + box.width >= analysisFrame.width || box.originY + box.height >= analysisFrame.height).length;
  const overlaps = candidates.reduce((total, {box:a}, i) => total + candidates.slice(i + 1).filter(({box:b}) =>
    Math.min(a.originX + a.width,b.originX + b.width) > Math.max(a.originX,b.originX) &&
    Math.min(a.originY + a.height,b.originY + b.height) > Math.max(a.originY,b.originY)).length,0);
  return {candidates:result.objects.detections?.length ?? 0, verified:accepted.length, trackCount:tracks.length,
    trackLost:tracks.length-visibleTracks.length, overlaps, clipped, medianHeight:heights[Math.floor(heights.length / 2)],
    meanConfidence:candidates.length ? candidates.reduce((sum,p) => sum+p.score,0)/candidates.length : null,
    directionUncertain:tracks.filter(t => t.pending && !t.counted).length,
    total:counter, bodyRan:result.parts != null, fps:recentTimes.length / 2, sampleMs:PROFILES[settings.profile].sampleMs};
}
function drawAnalysis() {
  const mode = adaptive?.engine();
  if (mode) {
    const width = Math.min(mode.width,video.videoWidth);
    if (analysisFrame.width !== width) {
      analysisFrame.width = width;
      analysisFrame.height = Math.max(1,Math.round(video.videoHeight * width/video.videoWidth));
    }
  }
  analysisCtx.drawImage(video, 0, 0, analysisFrame.width, analysisFrame.height);
  if (mode?.lighting) {
    analysisCtx.save();
    analysisCtx.globalCompositeOperation = "screen";
    analysisCtx.fillStyle = "rgb(20,20,20)";
    if (analysisCtx.globalCompositeOperation === "screen") analysisCtx.fillRect(0,0,analysisFrame.width,analysisFrame.height);
    analysisCtx.restore();
  }
}
async function tick(now) {
  if (!running) return;
  raf = 0;
  const attempt = startAttempt, epoch = trackingEpoch;
  if (document.hidden || video.readyState < 2 ||
    now - lastSample < PROFILES[settings.profile].sampleMs || video.currentTime === lastVideoTime) {
    raf = requestAnimationFrame(tick); return;
  }
  lastSample = now;
  lastVideoTime = video.currentTime;
  const model = detector, started = performance.now();
  let modelWork = null;
  try {
    inferenceStarted = started;
    const pixels = readDiagnostics(now);
    drawAnalysis();
    const work = modelWork = Promise.resolve(model.detectForVideo(analysisFrame, now));
    inferencePending = work;
    let result;
    try { result = await withDeadline(work, MAX_INFERENCE_MS, "解析が応答しないため停止しました。もう一度計測を開始してください。"); }
    finally { if (inferencePending === work) inferencePending = null; }
    if (!running || attempt !== startAttempt || epoch !== trackingEpoch || document.hidden) return;
    const inferenceMs = performance.now() - started;
    if (inferenceMs >= MAX_INFERENCE_MS) throw new Error("解析が遅いため停止しました。ほかのアプリを閉じて再試行してください。");
    const candidates = peopleFromResult(result.objects, analysisFrame.width, analysisFrame.height, settings.profile);
    const { annotated, accepted } = verifyBodies(candidates, result.parts, analysisFrame.width, analysisFrame.height, settings.bodyMode);
    const eligible = accepted.filter(inArea);
    const tracks = trial?.ended || !areaContainsLines() ? [] : tracker.update(eligible, now);
    const visibleTracks = tracks.filter(t => t.lastSeen === now);
    if (testDirections && !testDirections.reverse && visibleTracks.some(t => t.reverseSeen)) {
      testDirections.reverse = true;
      renderDirectionTest();
    }
    drawOverlay(annotated.map(d => d.bodyVerified && !inArea(d) ? {...d, bodyVerified: false} : d), visibleTracks);
    if ($("showTracking").checked) {
      const raw = result.objects.detections?.length ?? 0;
      const states = tracks.map(t => {
        let reason = "Aの手前からの通過を待機";
        if (t.lastSeen !== now) reason = "一時的に見失い中";
        else if (t.counted) reason = "正方向の通過を計上済み";
        else if (t.reverseSeen) reason = "逆方向 B→A・対象外";
        else if (t.reverseArmedAt !== null) reason = "B通過・逆方向のA待ち";
        else if (t.pending) reason = "B到達・人物確認待ち";
        else if (t.armedAt !== null) reason = "A通過・B待ち";
        return "ID " + t.id + " " + reason;
      });
      $("diagnostics").textContent = [
        "AI " + raw + "人 → 候補 " + candidates.length + "人 → 身体確認 " + accepted.length +
          "人 → 白枠内 " + eligible.length + "人 → 追跡中 " + tracks.length + "人（映像内 " + visibleTracks.length + "人）",
        "候補除外 " + (raw - candidates.length) + "件・身体の根拠不足または重複 " + (candidates.length - accepted.length) +
          "件・白枠外 " + (accepted.length - eligible.length) + "件",
        ...states,
      ].join("\n");
    } else $("diagnostics").textContent = "";
    const confirmed = tracks.filter(t => t.lastSeen === now && t.hits >= tracker.minHits && t.continuousEvidence &&
      t.scoreSum / t.hits >= tracker.minMeanScore).length;
    $("tracking").textContent = candidates.length
      ? (settings.bodyMode === "legs" ? "胴体＋脚足確認 " : "胴体確認 ") + eligible.length + "人 · 追跡確認 " + confirmed + "人 · 対象外 " + (candidates.length - eligible.length) + "件"
      : "肩〜腰の胴体が映る人物を探しています";
    recentTimes.push(now);
    recentTimes = recentTimes.filter(t => now - t < 2000);
    if (adaptive) adaptive.frame({now,inferenceMs,pixels,reverseSeen:adaptive.isolated() && visibleTracks.some(t => t.reverseSeen),
      stats:() => frameStats(result,candidates,accepted,tracks,visibleTracks)});
    $("fps").textContent = "検出速度 " + (recentTimes.length / 2).toFixed(1) + " FPS · 推論 " + Math.round(inferenceMs) + " ms";
  } catch (error) {
    if (!running || attempt !== startAttempt) return;
    discardDetector(model, modelWork);
    cameraFailure("映像解析が停止しました: " + error.message, false);
    status("計測エラー", "bad");
  } finally {
    if (inferenceStarted === started) inferenceStarted = null;
    if (running && attempt === startAttempt) raf = requestAnimationFrame(tick);
  }
}
async function loadDetector() {
  if (detector) return;
  detectorLoading ||= createVisionPipeline({ onProgress: text => { if (stream) message(text); } });
  const pending = detectorLoading;
  try {
    const loaded = await pending;
    if (detectorLoading === pending) detector = loaded;
    else { try { loaded.close(); } catch {} }
  } finally { if (detectorLoading === pending) detectorLoading = null; }
}
function checkRemoteCapture() {
  const reason = window.counterLedger?.captureBlockReason?.();
  if (!reason) return false;
  if (running || stream || activeLeaseOwner || recoveryTimer || startButton.disabled) stopCamera();
  status("計測待機", "bad");
  message(reason, true);
  return true;
}
window.counterStationCamera = () => ({
  camera: Boolean(stream?.getTracks().some(track => track.readyState === "live")),
  ai: running && Boolean(detector),
  profile: adaptive?.stationStatus?.().profile,
  alert: $("status").textContent.includes("保存") && !initialized ? "storage" :
    adaptive?.stationStatus?.().alert,
});
async function startCamera({automaticRetry = false} = {}) {
  if (running || startButton.disabled || checkRemoteCapture()) return;
  if (!await initialize() || checkRemoteCapture()) return;
  clearTimeout(recoveryTimer);
  if (!automaticRetry) recoveryUsed = false;
  const attempt = ++startAttempt, owner = uuid(), capturedSession = session;
  startButton.disabled = true;
  status("カメラを準備中", "loading"); message("iPadのカメラを確認しています…");
  try {
    await eventQueue; await leaseRelease;
    if (inferencePending) {
      try { await withDeadline(inferencePending, MAX_INFERENCE_MS, "previous inference stalled"); }
      catch { discardDetector(); inferencePending = null; }
    }
    if (attempt !== startAttempt || checkRemoteCapture()) return;
    if (!await recordStore.acquireLease(owner, capturedSession)) {
      startButton.disabled = false; status("別の画面で計測中", "bad");
      message("この端末の別の画面で計測中、または試験が切り替わっています。ほかの画面を停止して再試行してください。", true);
      await refreshRecords(); return;
    }
    if (attempt !== startAttempt || checkRemoteCapture()) { await recordStore.releaseLease(owner); return; }
    activeLeaseOwner = owner;
    leaseTimer = setInterval(() => {
      void recordStore.renewLease(owner, capturedSession).then(ok => {
        if (!ok && activeLeaseOwner === owner) cameraFailure("別の画面で試験または計測が切り替わったため停止しました。", false, false);
      }).catch(error => { if (activeLeaseOwner === owner) storageFailure(error); });
    }, 3000);
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("HTTPS接続のSafariから開いてください。");
    const cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 960 }, height: { ideal: 720 }, frameRate: { ideal: 24 } } });
    if (attempt !== startAttempt) { cameraStream.getTracks().forEach(track => track.stop()); return; }
    stream = cameraStream; stopButton.disabled = false; video.srcObject = stream;
    for (const track of stream.getTracks()) track.addEventListener?.("ended", () => {
      if (attempt === startAttempt) cameraFailure("カメラが停止しました。もう一度計測を開始してください。");
    }, { once: true });
    await video.play();
    if (attempt !== startAttempt) return;
    if (!video.videoWidth || !video.videoHeight) throw new Error("カメラ映像の準備ができませんでした。再試行してください。");
    $("cameraFrame").style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    // A restart never overwrites a snapshot still held by an old timed-out model.
    analysisFrame = document.createElement("canvas"); analysisCtx = analysisFrame.getContext("2d");
    analysisFrame.width = Math.min(640, video.videoWidth);
    analysisFrame.height = Math.max(1, Math.round(video.videoHeight * analysisFrame.width / video.videoWidth));
    video.style.display = "block"; $("placeholder").hidden = true;
    status("AIモデル読込中", "loading");
    await withDeadline(loadDetector(), 45000, "モデル読込が応答しません。ネット接続を確認して画面を再読み込みしてください。");
    if (attempt !== startAttempt || checkRemoteCapture()) return;
    adaptive?.observeFault(automaticRetry ? "カメラと認識処理を再開しました。停止中の通過を確認してください。" : "");
    resetTracking(); running = true;
    renderTrials(); lastSample = 0; lastVideoTime = -1; recentTimes = [];
    health = new CameraHealth(performance.now(), video.currentTime);
    healthTimer = setInterval(checkCameraHealth, 500);
    status("自動計測中", "good");
    message("黄色は胴体を確認した人物です。A→Bの通過で+1。記録は端末に保存します。");
    raf = requestAnimationFrame(tick);
  } catch (error) {
    if (attempt !== startAttempt) return;
    discardDetector();
    stopCamera(); status("開始できません", "bad");
    message("開始に失敗しました: " + (error?.message || String(error)), true);
  }
}
function updateSettings(event) {
  if (trial || adaptive?.isolated()) return;
  let first = Number($("firstLine").value), second = Number($("secondLine").value);
  if (second - first < 10) {
    if (event?.target?.id === "secondLine") second = first + 10;
    else first = second - 10;
  }
  const area = Object.fromEntries(areaEdges.map(edge => [edge, Number($(edge).value)]));
  const edge = event?.target?.id;
  if (edge === "left") area.left = Math.min(area.left, area.right - 10);
  if (edge === "right") area.right = Math.max(area.right, area.left + 10);
  if (edge === "top") area.top = Math.min(area.top, area.bottom - 10);
  if (edge === "bottom") area.bottom = Math.max(area.bottom, area.top + 10);
  settings = {
    ...areaSettings(area),
    movement: $("movement").value,
    profile: $("viewMode").value,
    bodyMode: $("bodyMode").value === "legs" ? "legs" : "torso",
    first, second,
  };
  const saved = localSet(OPTIONS_KEY, JSON.stringify(settings));
  configureTracker();
  if (!saved) message("方向とラインの設定を端末に保存できませんでした。", true);
}
function csvCell(value) {
  return '"' + String(value).replaceAll('"', '""') + '"';
}
async function exportCSV() {
  await eventQueue;
  await refreshRecords();
  const rows = [
    ["session", "timestamp", "kind", "delta", "running_total"],
  ];
  let sum = 0;
  for (const e of events) {
    sum = Math.max(0, sum + e.delta);
    rows.push([e.session, e.at, e.type, String(e.delta), String(sum)]);
  }
  const content = "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "people-counter-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function newSession() {
  if (!confirm("新しい試験を開始しますか？ 現在の人数は0人になります。必要なら先にCSV出力してください。")) return;
  stopCamera();
  await eventQueue; await leaseRelease;
  if (!await initialize()) return;
  try { applySnapshot(await recordStore.newSession()); announce(); status("停止中"); message("新しい試験を開始しました。旧記録は端末内に残ります。"); }
  catch (error) { storageFailure(error); }
}
function initialize() {
  if (readyPromise) return readyPromise;
  setStorageBusy(true);
  status("保存を準備中", "loading");
  readyPromise = (async () => {
    try {
      const saved = JSON.parse(localGet(OPTIONS_KEY) || "null");
      if (saved && ["x+", "x-", "y+", "y-"].includes(saved.movement) &&
        Number.isFinite(saved.first) && Number.isFinite(saved.second) &&
        saved.first >= 20 && saved.first <= 48 && saved.second >= 52 && saved.second <= 80 && saved.second - saved.first >= 10) {
        settings = { ...defaults, ...saved, ...areaSettings(saved), profile: Object.hasOwn(PROFILES, saved.profile) ? saved.profile : defaults.profile,
          bodyMode: saved.bodyMode === "legs" ? "legs" : "torso" };
      }
    } catch {}
    try {
      const savedResults = JSON.parse(localGet("koken-counter-venue-trials-v1") || "[]");
      if (Array.isArray(savedResults)) trialResults = savedResults.filter(r => r && Object.hasOwn(trialAngles, r.angle) &&
        Number.isSafeInteger(r.count) && r.count >= 0 && Number.isSafeInteger(r.actual) && r.actual >= 0 && typeof r.condition === "string").slice(0, 30);
    } catch {}
    configureTracker();
    renderTrials(true);
    try {
      recordStore = await openRecordStore({ uuid, legacySession: localGet(SESSION_KEY), onClose: () => {
        initialized = false; readyPromise = null; stopCamera(); setStorageBusy(true);
        status("保存接続が終了しました", "bad"); message("画面を再読み込みしてください。", true);
      } });
      window.counterRecordStore = recordStore;
      window.counterLedger?.attach(recordStore);
      applySnapshot(recordStore.initial); initialized = true; setStorageBusy(false); status("待機中");
      startButton.textContent = "計測を開始";
      if (!pollTimer) pollTimer = setInterval(() => { if (!document.hidden) void refreshRecords(); }, 2000);
      return true;
    } catch (error) {
      initialized = false; readyPromise = null;
      status("保存を準備できません", "bad"); message("計測開始前に端末内保存が必要です: " + error.message, true);
      startButton.disabled = false; startButton.textContent = "保存を再試行";
      return false;
    }
  })();
  return readyPromise;
}
startButton.addEventListener("click", () => void startCamera());
stopButton.addEventListener("click", () => {
  stopCamera();
  status("停止中");
  message("計測を停止しました。人数の記録は保存されています。");
});
$("addButton").addEventListener("click", () => record(1, "manual"));
$("minusButton").addEventListener("click", () => {
  if (window.counterLedger?.configured()) message("通過記録の管理で対象の記録を無効化してください。");
  else record(-1, "manual");
});
$("exportButton").addEventListener("click", () => void exportCSV());
$("resetButton").addEventListener("click", () => void newSession());
for (const id of ["viewMode", "bodyMode", "movement", "firstLine", "secondLine", ...areaEdges]) {
  $(id).addEventListener("input", updateSettings);
}
$("reverseDirection").addEventListener("click", () => {
  if (trial || adaptive?.isolated()) return;
  const [axis, sign] = settings.movement;
  $("movement").value = axis + (sign === "+" ? "-" : "+");
  // Keep both thresholds at the same points in the camera image.
  $("firstLine").value = String(100 - settings.second);
  $("secondLine").value = String(100 - settings.first);
  updateSettings();
});
window.addEventListener("counter-control-changed", checkRemoteCapture);
window.addEventListener("counter-role-changed", () => {renderDirections(); syncAdaptiveScope();});
$("cameraFrame").addEventListener("click", event => {
  const target = $("overlayTarget").value;
  if (!running || trial || adaptive?.isolated() || !["firstLine", "secondLine", ...areaEdges].includes(target)) return;
  const bounds = $("cameraFrame").getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const line = target === "firstLine" || target === "secondLine";
  const horizontal = line ? tracker.axis === "x" : target === "left" || target === "right";
  let percent = horizontal ? (event.clientX - bounds.left) / bounds.width : (event.clientY - bounds.top) / bounds.height;
  if (line && tracker.direction === -1) percent = 1 - percent;
  const input = $(target);
  input.value = String(Math.max(Number(input.min), Math.min(Number(input.max), Math.round(percent * 100))));
  updateSettings({ target: input });
});
$("trialStart").addEventListener("click", () => {
  if (!running || trial || adaptive?.isolated()) return;
  const angle = $("trialAngle").value;
  if (!Object.hasOwn(trialAngles, angle)) return;
  const a = Math.round(tracker.lineAt(tracker.first) * 100), b = Math.round(tracker.lineAt(tracker.second) * 100);
  if (!areaContainsLines()) {
    message("検出エリアがA・Bの両ラインと、その前後を含むように調整してください。", true);
    return;
  }
  const condition = [
    $("viewMode").selectedOptions?.[0]?.textContent || settings.profile,
    $("bodyMode").selectedOptions?.[0]?.textContent || settings.bodyMode,
    $("movement").selectedOptions?.[0]?.textContent || settings.movement,
    "A " + a + "%・B " + b + "%",
    "エリア 横" + settings.left + "–" + settings.right + "%・縦" + settings.top + "–" + settings.bottom + "%",
    $("trialNote").value.trim().slice(0, 120),
  ].filter(Boolean).join(" ／ ");
  trial = {angle, condition, count: 0, ended: false};
  testDirections = {forward: false, reverse: false};
  resetTracking();
  message("検証中です。A→Bの通過だけを試験人数に加算します。");
  renderTrials();
});
$("trialEnd").addEventListener("click", () => endTrial());
$("trialSave").addEventListener("click", () => {
  if (!trial?.ended) return;
  const input = $("trialActual");
  const actual = Number(input.value);
  if (!input.value.trim() || !Number.isSafeInteger(actual) || actual < 0) {
    $("trialStatus").textContent = "正方向に通過した実人数を0以上の整数で入力してください。";
    return;
  }
  trialResults = [{...trial, actual}, ...trialResults].slice(0, 30);
  const saved = localSet("koken-counter-venue-trials-v1", JSON.stringify(trialResults));
  trial = null;
  input.value = "";
  resetTracking();
  renderTrials(true);
  message(saved ? "比較結果をこの端末に保存しました。" : "保存できませんでした。比較結果はこの画面を開いている間だけ表示されます。", !saved);
});
$("trialDiscard").addEventListener("click", () => {
  if (!trial) return;
  trial = null;
  testDirections = null;
  $("trialActual").value = "";
  resetTracking();
  renderTrials();
  message("検証を取り消しました。");
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (running || stream || activeLeaseOwner)) {
    stopCamera(); status("画面非表示のため停止"); message("画面が非表示になったため計測を停止しました。再開するには開始ボタンを押してください。");
  } else if (!document.hidden) void refreshRecords();
});
window.addEventListener("pagehide", stopCamera);
window.addEventListener("focus", () => void refreshRecords());
try {
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("koken-counter-records-v5");
    channel.onmessage = () => void refreshRecords();
  }
} catch {}
adaptive?.attach({
  status: () => ({running,trial:!!trial,geometry:areaContainsLines(),role:!!window.counterLedger?.role?.(),
    thresholds: "物体スコア " + PROFILES[settings.profile].threshold + " ／ 追跡必要フレーム " + tracker.minHits +
      " ／ 追跡平均スコア " + tracker.minMeanScore + " ／ 推論間隔の下限 " + PROFILES[settings.profile].sampleMs + "ms" +
      " ／ 確認部位 " + (settings.bodyMode === "legs" ? "胴体・脚" : "胴体") + " ／ " + $("directionGuide").textContent}),
  suggest: suggestCalibrationLines,
  applyLines: ({first,second}) => {
    $("firstLine").value = String(first);
    $("secondLine").value = String(second);
    updateSettings();
  },
  reset: resetTracking, controls: renderTrials,
});
void initialize();
