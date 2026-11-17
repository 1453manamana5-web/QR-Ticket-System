export const MAX_INFERENCE_MS = 1500;
export class CameraHealth {
  constructor(now = 0, videoTime = -1) { this.lastAdvance = now; this.videoTime = videoTime; }
  check(now, { videoTime, ended = false, inferenceStarted = null } = {}) {
    if (ended) return 'カメラの映像が停止しました。計測を再開してください。';
    if (videoTime !== this.videoTime) { this.videoTime = videoTime; this.lastAdvance = now; }
    if (inferenceStarted !== null && now - inferenceStarted >= MAX_INFERENCE_MS) {
      return '解析が遅いため計測を停止しました。ほかのアプリを閉じて再試行してください。';
    }
    if (now - this.lastAdvance >= 2500) return 'カメラの映像が更新されていません。計測を再開してください。';
    return null;
  }
}
export function withDeadline(work, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
