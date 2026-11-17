import { LineTracker } from "./tracker.mjs?v=7";
import { PROFILES, peopleFromResult } from "./detection.mjs?v=7";

import { verifyBodies } from "./body-check.mjs?v=7";
import { createVisionPipeline } from "./vision.mjs?v=7";

import { openRecordStore, totalOf } from "./records.mjs?v=7";
import { CameraHealth, MAX_INFERENCE_MS, withDeadline } from "./health.mjs?v=7";
const SESSION_KEY = "koken-counter-session-v1";
const OPTIONS_KEY = "koken-counter-options-v1";
const $ = id => document.getElementById(id);
const video = $("video"), canvas = $("overlay"), ctx = canvas.getContext("2d");
const startButton = $("startButton"), stopButton = $("stopButton");
let analysisFrame = document.createElement("canvas");
let analysisCtx = analysisFrame.getContext("2d");
const defaults = { movement: "x+", first: 40, second: 60, profile: "side", bodyMode: "torso" };

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
  const capturedSession = session || null;
  const owner = activeLeaseOwner;
  const at = Date.now();
  const ready = initialize();
  eventQueue = eventQueue.then(async () => {
    if (!await ready) return;
    const result = await recordStore.append({ delta, type, expectedSession: capturedSession || session, owner, now: at });
    applySnapshot(result.snapshot);
    if (result.status === "lease-lost" || result.status === "session-changed") {
      stopCamera(); status("計測を停止しました", "bad");
      message("別の画面で計測または試験が切り替わりました。人数を確認して再開してください。", true);
    }
    if (result.status === "saved") announce();
  }).catch(storageFailure);
  return eventQueue;
}
function resetTracking() { trackingEpoch++; tracker.reset(); }
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
  drawOverlay([]);
}
const tracker = new LineTracker(() => record(1, "auto"));

function drawOverlay(detections) {
  if (!canvas.width || !canvas.height) return;
  const w = canvas.width, h = canvas.height;
  const sx = w / analysisFrame.width, sy = h / analysisFrame.height;
  ctx.clearRect(0, 0, w, h);
  const lines = [
    { at: tracker.lineAt(tracker.first), name: "A", color: "#3b82f6" },
    { at: tracker.lineAt(tracker.second), name: "B", color: "#00b79a" },
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
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(line.name, Math.min(w - 30, x + 7), 29);
    } else {
      const y = line.at * h;
      ctx.moveTo(0, y); ctx.lineTo(w, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(line.name, 11, Math.max(25, y - 9));
    }
  }
  ctx.setLineDash([]);
  for (const d of detections) {
    const color = d.bodyVerified ? "#f9dc72" : "#a8b4c0";
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, w / 330);
    ctx.strokeRect(d.box.originX * sx, d.box.originY * sy, d.box.width * sx, d.box.height * sy);
    ctx.fillStyle = color;
    ctx.font = "bold " + Math.max(13, w / 57) + "px sans-serif";
    ctx.fillText(d.bodyVerified ? (d.legVerified ? "人物・胴体＋脚足確認" : "人物・胴体確認") : "候補・人数に含めません", d.box.originX * sx + 3, Math.max(15, d.box.originY * sy - 6));
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
}
function discardDetector(model = detector, pending = inferencePending) {
  if (detector === model) { detector = null; detectorLoading = null; }
  const close = () => { try { model?.close(); } catch {} };
  if (pending) void Promise.resolve(pending).then(close, close);
  else close();
}
function stopCamera() {
  startAttempt++;
  running = false;
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
  $("tracking").textContent = "検出待ち";
  recentTimes = [];
  resetTracking();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
function cameraFailure(text, discard = false) {
  if (discard) discardDetector();
  stopCamera(); status("計測停止", "bad"); message(text, true);
}
function checkCameraHealth() {
  if (!running || !health) return;
  const ended = stream?.getTracks().some(track => track.readyState === "ended");
  const reason = health.check(performance.now(), { videoTime: video.currentTime, ended, inferenceStarted });
  if (reason) cameraFailure(reason, inferenceStarted !== null);
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
    analysisCtx.drawImage(video, 0, 0, analysisFrame.width, analysisFrame.height);
    const work = modelWork = Promise.resolve(model.detectForVideo(analysisFrame, now));
    inferencePending = work;
    let result;
    try { result = await withDeadline(work, MAX_INFERENCE_MS, "解析が応答しないため停止しました。もう一度計測を開始してください。"); }
    finally { if (inferencePending === work) inferencePending = null; }
    if (!running || attempt !== startAttempt || epoch !== trackingEpoch || document.hidden) return;
    if (performance.now() - started >= MAX_INFERENCE_MS) throw new Error("解析が遅いため停止しました。ほかのアプリを閉じて再試行してください。");
    const candidates = peopleFromResult(result.objects, analysisFrame.width, analysisFrame.height, settings.profile);
    const { annotated, accepted } = verifyBodies(candidates, result.parts, analysisFrame.width, analysisFrame.height, settings.bodyMode);
    const tracks = tracker.update(accepted, now);
    drawOverlay(annotated);
    const confirmed = tracks.filter(t => t.lastSeen === now && t.hits >= tracker.minHits && t.continuousEvidence &&
      t.scoreSum / t.hits >= tracker.minMeanScore).length;
    $("tracking").textContent = candidates.length
      ? (settings.bodyMode === "legs" ? "胴体＋脚足確認 " : "胴体確認 ") + accepted.length + "人 · 追跡確認 " + confirmed + "人 · 対象外 " + (candidates.length - accepted.length) + "件"
      : "肩〜腰の胴体が映る人物を探しています";
    recentTimes.push(now);
    recentTimes = recentTimes.filter(t => now - t < 2000);
    $("fps").textContent = "検出速度 " + (recentTimes.length / 2).toFixed(1) + " 回/秒";
  } catch (error) {
    if (!running || attempt !== startAttempt) return;
    discardDetector(model, modelWork);
    stopCamera();
    status("計測エラー", "bad");
    message("映像解析が停止しました: " + error.message, true);
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
async function startCamera() {
  if (running || startButton.disabled) return;
  if (!await initialize()) return;
  const attempt = ++startAttempt, owner = uuid(), capturedSession = session;
  startButton.disabled = true;
  status("カメラを準備中", "loading"); message("iPadのカメラを確認しています…");
  try {
    await eventQueue; await leaseRelease;
    if (inferencePending) {
      try { await withDeadline(inferencePending, MAX_INFERENCE_MS, "previous inference stalled"); }
      catch { discardDetector(); inferencePending = null; }
    }
    if (attempt !== startAttempt) return;
    if (!await recordStore.acquireLease(owner, capturedSession)) {
      startButton.disabled = false; status("別の画面で計測中", "bad");
      message("この端末の別の画面で計測中、または試験が切り替わっています。ほかの画面を停止して再試行してください。", true);
      await refreshRecords(); return;
    }
    if (attempt !== startAttempt) { await recordStore.releaseLease(owner); return; }
    activeLeaseOwner = owner;
    leaseTimer = setInterval(() => {
      void recordStore.renewLease(owner, capturedSession).then(ok => {
        if (!ok && activeLeaseOwner === owner) cameraFailure("別の画面で試験または計測が切り替わったため停止しました。");
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
    if (attempt !== startAttempt) return;
    resetTracking(); running = true; lastSample = 0; lastVideoTime = -1; recentTimes = [];
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
  let first = Number($("firstLine").value), second = Number($("secondLine").value);
  if (second - first < 10) {
    if (event?.target?.id === "secondLine") second = first + 10;
    else first = second - 10;
  }
  settings = {
    movement: $("movement").value,
    profile: $("viewMode").value,
    bodyMode: $("bodyMode").value === "legs" ? "legs" : "torso",
    first, second,
  };
  localSet(OPTIONS_KEY, JSON.stringify(settings));
  configureTracker();
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
        settings = { ...defaults, ...saved, profile: Object.hasOwn(PROFILES, saved.profile) ? saved.profile : defaults.profile,
          bodyMode: saved.bodyMode === "legs" ? "legs" : "torso" };
      }
    } catch {}
    configureTracker();
    try {
      recordStore = await openRecordStore({ uuid, legacySession: localGet(SESSION_KEY), onClose: () => {
        initialized = false; readyPromise = null; stopCamera(); setStorageBusy(true);
        status("保存接続が終了しました", "bad"); message("画面を再読み込みしてください。", true);
      } });
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
$("minusButton").addEventListener("click", () => record(-1, "manual"));
$("exportButton").addEventListener("click", () => void exportCSV());
$("resetButton").addEventListener("click", () => void newSession());
for (const id of ["viewMode", "bodyMode", "movement", "firstLine", "secondLine"]) {
  $(id).addEventListener("input", updateSettings);
}
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
void initialize();
