import { createTorsoVerifier } from './torso.mjs?v=4';
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const OBJECT_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';
async function createObjectDetector(Task, vision) {
  const options = { baseOptions: { modelAssetPath: OBJECT_MODEL, delegate: 'GPU' },
    canvas: globalThis.document?.createElement('canvas'), runningMode: 'VIDEO',
    scoreThreshold: 0.30, categoryAllowlist: ['person'], maxResults: 10 };
  try { return await Task.createFromOptions(vision, options); }
  catch { return Task.createFromOptions(vision, { ...options,
    canvas: globalThis.document?.createElement('canvas'), baseOptions: { ...options.baseOptions, delegate: 'CPU' } }); }
}
export async function createVisionPipeline({ resolveSDK = () => import(SDK_URL),
  resolveTorso = createTorsoVerifier, onProgress = () => {} } = {}) {
  let detector = null, verifier = null;
  try {
    const { FilesetResolver, ObjectDetector } = await resolveSDK();
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    onProgress('人物検出モデルを読み込み中…');
    detector = await createObjectDetector(ObjectDetector, vision);
    onProgress('肩〜腰の胴体確認モデルを読み込み中…');
    verifier = await resolveTorso();
  } catch (error) {
    detector?.close(); verifier?.close();
    throw new Error('胴体確認モデルの準備に失敗しました: ' + (error?.message || String(error)));
  }
  return {
    async detectForVideo(frame, timestamp) {
      const objects = detector.detectForVideo(frame, timestamp);
      const parts = objects.detections?.length ? await verifier.detect(frame) : null;
      return { objects, parts };
    },
    close() { detector.close(); verifier.close(); },
  };
}
