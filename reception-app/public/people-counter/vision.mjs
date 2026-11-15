const SDK_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const OBJECT_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

async function createTask(Task, vision, options) {
  try {
    return await Task.createFromOptions(vision, { ...options,
      canvas: globalThis.document?.createElement('canvas'),
      baseOptions: { ...options.baseOptions, delegate: 'GPU' } });
  } catch {
    return Task.createFromOptions(vision, { ...options,
      canvas: globalThis.document?.createElement('canvas'),
      baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
  }
}

export async function createVisionPipeline({ resolveSDK = () => import(SDK_URL), onProgress = () => {} } = {}) {
  const { FilesetResolver, ObjectDetector, PoseLandmarker } = await resolveSDK();
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  let detector = null, verifier = null;
  try {
    onProgress('人物検出モデルを読み込み中…');
    detector = await createTask(ObjectDetector, vision, {
      baseOptions: { modelAssetPath: OBJECT_MODEL }, runningMode: 'VIDEO',
      scoreThreshold: 0.30, categoryAllowlist: ['person'], maxResults: 10,
    });
    onProgress('頭・胴体の確認モデルを読み込み中…');
    verifier = await createTask(PoseLandmarker, vision, {
      baseOptions: { modelAssetPath: POSE_MODEL }, runningMode: 'VIDEO', numPoses: 4,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.6,
      minTrackingConfidence: 0.5, outputSegmentationMasks: false,
    });
  } catch (error) {
    detector?.close(); verifier?.close();
    throw new Error('人物確認モデルの準備に失敗しました: ' + (error?.message || String(error)));
  }
  return {
    detectForVideo(frame, timestamp) {
      const objects = detector.detectForVideo(frame, timestamp);
      // Always use a same-frame confirmation; never reuse a body's previous
      // confirmation when only an arm or another object is visible now.
      const poses = objects.detections?.length
        ? verifier.detectForVideo(frame, timestamp) : { landmarks: [] };
      return { objects, poses };
    },
    close() { detector.close(); verifier.close(); },
  };
}
