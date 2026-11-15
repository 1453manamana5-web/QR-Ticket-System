import { LineTracker } from "./tracker.mjs?v=2";
import { PROFILES, peopleFromResult } from "./detection.mjs?v=2";

const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";
const SDK_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const DB_NAME = "koken-people-counter-prototype-v1";
const SESSION_KEY = "koken-counter-session-v1";
const OPTIONS_KEY = "koken-counter-options-v1";
const $ = id => document.getElementById(id);
const video = $("video"), canvas = $("overlay"), ctx = canvas.getContext("2d");
const startButton = $("startButton"), stopButton = $("stopButton");
const defaults = { movement: "x+", first: 40, second: 60, profile: "side" };

let db = null;
let session = "";
let events = [];
let counter = 0;
let detector = null;
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
function dbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function openDatabase() {
  if (!("indexedDB" in window)) throw new Error("このブラウザは端末内保存に対応していません。");
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains("events")) {
      database.createObjectStore("events", { keyPath: "id" });
    }
  };
  return dbRequest(request);
}
async function readRecords() {
  if (!db) return [];
  const transaction = db.transaction("events", "readonly");
  const records = await dbRequest(transaction.objectStore("events").getAll());
  return records.filter(record => record.session === session)
    .sort((a, b) => a.at.localeCompare(b.at));
}
async function persist(record) {
  if (!db) return false;
  await new Promise((resolve, reject) => {
    const tx = db.transaction("events", "readwrite");
    tx.objectStore("events").put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return true;
}
function renderRecords() {
  counter = Math.max(0, events.reduce((sum, item) => sum + item.delta, 0));
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
  eventQueue = eventQueue.then(async () => {
    if (delta < 0 && counter <= 0) return;
    const item = { id: uuid(), session, delta, type, at: new Date().toISOString() };
    try {
      if (db) await persist(item);
      else message("端末内保存が使えません。記録はこの画面だけに残ります。", true);
    } catch (error) {
      message("端末内保存に失敗しました。記録はこの画面だけに残ります: " + error.message, true);
    }
    events.push(item);
    renderRecords();
  }).catch(error => message("記録エラー: " + error.message, true));
}
function configureTracker() {
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
  $("viewHint").textContent = settings.profile === "side"
    ? "真横では頭から腰がなるべく映る距離に固定し、左右へ歩いてください。黄色い点がA→Bを越える位置に調整します。弱い検出は3回以上確認してから採用します。重なった人や画面外の人は数えられない場合があります。"
    : "斜め上から撮る場合の標準設定です。黄色い点がA→Bを越える位置に調整してください。";
  $("firstLine").value = String(settings.first);
  $("secondLine").value = String(settings.second);
  drawOverlay([]);
}
const tracker = new LineTracker(() => record(1, "auto"));

function drawOverlay(detections) {
  if (!canvas.width || !canvas.height) return;
  const w = canvas.width, h = canvas.height;
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
    ctx.strokeStyle = "#f9dc72";
    ctx.lineWidth = Math.max(2, w / 330);
    ctx.strokeRect(d.box.originX, d.box.originY, d.box.width, d.box.height);
    ctx.fillStyle = "#f9dc72";
    ctx.font = "bold " + Math.max(13, w / 57) + "px sans-serif";
    ctx.fillText("人物 " + Math.round(d.score * 100) + "%", d.box.originX + 3, Math.max(15, d.box.originY - 6));
    ctx.beginPath();
    ctx.arc(d.x * w, d.y * h, Math.max(4, w / 160), 0, Math.PI * 2);
    ctx.fill();
  }
}
function stopCamera() {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  video.pause();
  video.srcObject = null;
  video.style.display = "none";
  $("placeholder").hidden = false;
  stopButton.disabled = true;
  startButton.disabled = false;
  $("fps").textContent = "検出速度 —";
  $("tracking").textContent = "検出待ち";
  recentTimes = [];
  tracker.reset();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
function tick(now) {
  if (!running) return;
  raf = requestAnimationFrame(tick);
  if (document.hidden || video.readyState < 2 ||
    now - lastSample < PROFILES[settings.profile].sampleMs || video.currentTime === lastVideoTime) return;
  lastSample = now;
  lastVideoTime = video.currentTime;
  try {
    const result = detector.detectForVideo(video, now);
    const good = peopleFromResult(result, video.videoWidth, video.videoHeight, settings.profile);
    const tracks = tracker.update(good, now);
    drawOverlay(good);
    const confirmed = tracks.filter(t => t.lastSeen === now && t.hits >= tracker.minHits &&
      t.scoreSum / t.hits >= tracker.minMeanScore).length;
    $("tracking").textContent = good.length ? "人物 " + good.length + "人 · 追跡確認 " + confirmed + "人" : "人物を探しています";
    recentTimes.push(now);
    recentTimes = recentTimes.filter(t => now - t < 2000);
    $("fps").textContent = "検出速度 " + (recentTimes.length / 2).toFixed(1) + " 回/秒";
  } catch (error) {
    stopCamera();
    status("計測エラー", "bad");
    message("映像解析が停止しました: " + error.message, true);
  }
}
async function loadDetector() {
  if (detector) return;
  const { FilesetResolver, ObjectDetector } = await import(SDK_URL);
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO", scoreThreshold: 0.30, categoryAllowlist: ["person"], maxResults: 10,
  };
  try {
    detector = await ObjectDetector.createFromOptions(vision, options);
  } catch {
    options.baseOptions.delegate = "CPU";
    detector = await ObjectDetector.createFromOptions(vision, options);
  }
}
async function startCamera() {
  if (running) return;
  startButton.disabled = true;
  status("カメラを準備中", "loading");
  message("iPadのカメラを確認しています…");
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("HTTPS接続のSafariから開いてください。");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 24 } },
    });
    video.srcObject = stream;
    await video.play();
    $("cameraFrame").style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    video.style.display = "block";
    $("placeholder").hidden = true;
    status("AIモデル読込中", "loading");
    message("初回はネットワークからAIモデルを読み込みます。映像自体は送信しません。");
    await loadDetector();
    tracker.reset();
    running = true;
    lastSample = 0;
    lastVideoTime = -1;
    recentTimes = [];
    stopButton.disabled = false;
    status("自動計測中", "good");
    message("A→Bの通過で+1。カメラの画面を開いたまま試験してください。");
    raf = requestAnimationFrame(tick);
  } catch (error) {
    stopCamera();
    status("開始できません", "bad");
    message("開始に失敗しました: " + (error?.message || String(error)) + "。カメラ許可、ネット接続、校内Wi-Fiの制限を確認してください。", true);
  }
}
function updateSettings() {
  settings = {
    movement: $("movement").value,
    profile: $("viewMode").value,
    first: Number($("firstLine").value),
    second: Number($("secondLine").value),
  };
  localSet(OPTIONS_KEY, JSON.stringify(settings));
  configureTracker();
}
function csvCell(value) {
  return '"' + String(value).replaceAll('"', '""') + '"';
}
async function exportCSV() {
  await eventQueue;
  const rows = [
    ["session", "timestamp", "kind", "delta", "running_total"],
  ];
  let sum = 0;
  for (const e of events) {
    sum += e.delta;
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
  if (!confirm("新しい試験を開始しますか？ 現在の人数は0人になり、過去の試験は画面に表示されなくなります。必要なら先にCSV出力してください。")) return;
  await eventQueue;
  session = uuid();
  localSet(SESSION_KEY, session);
  events = [];
  renderRecords();
  tracker.reset();
  message("新しい試験を開始しました。旧記録は端末内に残りますが、この画面では集計されません。");
}
async function initialize() {
  try {
    const saved = JSON.parse(localGet(OPTIONS_KEY) || "null");
    if (saved && ["x+", "x-", "y+", "y-"].includes(saved.movement) &&
      Number.isFinite(saved.first) && Number.isFinite(saved.second) &&
      saved.first >= 20 && saved.first <= 48 && saved.second >= 52 && saved.second <= 80) {
      settings = { ...defaults, ...saved, profile: Object.hasOwn(PROFILES, saved.profile) ? saved.profile : defaults.profile };
    }
  } catch { /* corrupt settings: defaults */ }
  configureTracker();
  session = localGet(SESSION_KEY) || uuid();
  localSet(SESSION_KEY, session);
  try {
    db = await openDatabase();
    events = await readRecords();
  } catch (error) {
    message("端末内保存を使えません。試験結果は画面を閉じると失われます: " + error.message, true);
  }
  renderRecords();
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
for (const id of ["viewMode", "movement", "firstLine", "secondLine"]) {
  $(id).addEventListener("input", updateSettings);
}
document.addEventListener("visibilitychange", () => {
  if (running && document.hidden) tracker.reset();
});
window.addEventListener("pagehide", stopCamera);
void initialize();
