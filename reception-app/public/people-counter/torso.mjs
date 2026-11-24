import { inferPartMask } from './torso-decoder.mjs?v=11';
const TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/tf-backend-wasm.min.js';
const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/';
const BODY_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/body-pix@2.2.1/dist/body-pix.min.umd.js';
const scripts = new Map();
let runtimePromise = null;
function script(url) {
  if (scripts.has(url)) return scripts.get(url);
  const promise = new Promise((resolve, reject) => {
    const element = document.createElement('script');
    element.src = url; element.crossOrigin = 'anonymous';
    element.onload = resolve;
    element.onerror = () => { scripts.delete(url); element.remove(); reject(new Error('胴体確認のプログラムを読み込めませんでした')); };
    document.head.append(element);
  });
  scripts.set(url, promise); return promise;
}
async function runtime() {
  if (!runtimePromise) runtimePromise = (async () => {
    await script(TF_URL);
    const tf = globalThis.tf;
    try {
      await script(WASM_URL);
      tf.wasm.setWasmPaths(WASM_PATH);
      if (!await tf.setBackend('wasm')) throw new Error('WASM unavailable');
      await tf.ready();
    } catch {
      if (!await tf.setBackend('webgl')) throw new Error('このブラウザで胴体確認を実行できません。Safariを更新して再試行してください。');
      await tf.ready();
    }
    await script(BODY_URL);
    if (!globalThis['body-pix']?.load) throw new Error('胴体確認のプログラムを準備できませんでした');
    return globalThis['body-pix'];
  })().catch(error => { runtimePromise = null; throw error; });
  return runtimePromise;
}
export async function createTorsoVerifier() {
  const bodyPix = await runtime();
  const model = await bodyPix.load({ architecture: 'MobileNetV1', outputStride: 16, multiplier: 0.75, quantBytes: 2 });
  return {
    async detect(frame) {
      return inferPartMask(globalThis.tf, bodyPix, model, frame);
    },
    close() { model.dispose(); },
  };
}
