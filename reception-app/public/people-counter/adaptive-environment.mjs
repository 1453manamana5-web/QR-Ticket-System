// Input is a small canvas readback. The only image-derived state kept between
// samples is a coarse luma grid in memory, with no source pixels or identifiers.
const GRID_X = 12;
const GRID_Y = 8;
const GRID_SIZE = GRID_X * GRID_Y;

const labels = Object.freeze({
  dark: '暗い映像',
  partialDark: '部分的に暗い映像',
  backlight: '逆光の可能性',
  lightingShift: '照明が変化した可能性',
  cameraShift: 'カメラ位置・背景が変化した可能性',
  occlusion: 'レンズ遮蔽の可能性',
  blur: '映像のぼやけの可能性',
  motionBlur: '動体ブレの可能性',
  load: '処理の遅延が継続',
  confidence: '人物検出の信頼度が低い状態が継続',
  disagreement: '人物枠と身体確認の不一致が継続',
  tracking: '追跡の途切れが継続',
  direction: '通過方向の確認が難しい状態が継続',
  overlap: '人物の重なりが継続',
  clipping: '人物の見切れが継続',
  smallPeople: '人物が小さく映っている状態が継続',
  largePeople: '人物が近くに映っている状態が継続',
});

const emptyMetrics = Object.freeze({
  luma: null, quadrants: [], darkFraction: null, brightFraction: null, contrast: null, sharpness: null,
  centerLuma: null, motion: null, backgroundDrift: null, referenceReady: false,
  inferenceMs: null, fps: null, candidates: null, verified: null, meanConfidence: null,
  trackCount: null, trackLost: null, overlaps: null, clipped: null, medianHeight: null, directionUncertain: null,
});

function measureFrame(image) {
  const {data, width, height} = image || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < GRID_X || height < GRID_Y ||
      width > 96 || height > 72 || !data || data.length < width * height * 4) return null;
  const luma = new Uint8Array(width * height);
  const grid = new Float32Array(GRID_SIZE);
  const gridCounts = new Uint16Array(GRID_SIZE);
  const quadrantTotals = [0, 0, 0, 0];
  const quadrantCounts = [0, 0, 0, 0];
  let sum = 0, squares = 0, dark = 0, bright = 0, centerSum = 0, centerCount = 0;
  for (let y = 0; y < height; y++) {
    const gridRow = Math.floor(y * GRID_Y / height) * GRID_X;
    const lower = y >= height / 2 ? 2 : 0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const offset = i * 4;
      const value = (54 * data[offset] + 183 * data[offset + 1] + 19 * data[offset + 2]) >> 8;
      luma[i] = value;
      sum += value;
      squares += value * value;
      if (value < 48) dark++;
      if (value > 215) bright++;
      const quadrant = lower + Number(x >= width / 2);
      quadrantTotals[quadrant] += value;
      quadrantCounts[quadrant]++;
      const cell = gridRow + Math.floor(x * GRID_X / width);
      grid[cell] += value;
      gridCounts[cell]++;
      if (x >= width / 4 && x < width * 3 / 4 && y >= height / 4 && y < height * 3 / 4) {
        centerSum += value;
        centerCount++;
      }
    }
  }
  let edges = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      edges += Math.abs(4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width]);
    }
  }
  for (let i = 0; i < GRID_SIZE; i++) grid[i] /= gridCounts[i];
  const mean = sum / luma.length;
  return {
    luma: mean,
    quadrants: quadrantTotals.map((value, i) => value / quadrantCounts[i]),
    darkFraction: dark / luma.length,
    brightFraction: bright / luma.length,
    contrast: Math.sqrt(Math.max(0, squares / luma.length - mean * mean)),
    sharpness: edges / ((width - 2) * (height - 2)),
    centerLuma: centerSum / centerCount,
    grid,
  };
}

// Normalize cell contrast as well as mean so a uniform lighting change cannot
// be mistaken for a change in camera alignment.
function drift(from, to) {
  const fromScale = Math.max(12, from.contrast);
  const toScale = Math.max(12, to.contrast);
  let delta = 0;
  for (let i = 0; i < GRID_SIZE; i++) {
    delta += Math.abs((to.grid[i] - to.luma) / toScale - (from.grid[i] - from.luma) / fromScale);
  }
  return delta / GRID_SIZE;
}

export class EnvironmentMonitor {
  constructor({intervalMs = 500, confirmations = 3} = {}) {
    this.intervalMs = intervalMs;
    this.confirmations = confirmations;
    this.reset();
  }

  reset() {
    this.metrics = {...emptyMetrics};
    this.warnings = [];
    this.previous = null;
    this.reference = null;
    this.exposureStep = null;
    this.emptyRun = 0;
    this.lastSample = -Infinity;
    this.lastObservation = -Infinity;
    this.streaks = new Map();
  }

  due(now) {
    return Number.isFinite(now) && now - this.lastSample >= this.intervalMs;
  }

  sample(image, now, {empty = false} = {}) {
    if (!this.due(now)) return this.metrics;
    const measured = measureFrame(image);
    this.lastSample = now;
    if (!measured) return this.metrics;
    const {grid, ...metrics} = measured;
    const previous = this.previous;
    const motion = previous ? drift(previous, measured) : null;
    const backgroundDrift = this.reference ? drift(this.reference, measured) : null;
    this.previous = {...metrics, grid};
    if (!this.reference) {
      // Establish a reference once from several successive empty, stable samples.
      // The image buffer is temporary. The coarse reference is cleared on reset.
      this.emptyRun = empty && metrics.contrast >= 10 && metrics.luma >= 25 &&
        (motion === null || (motion < 0.18 && Math.abs(previous.luma - metrics.luma) < 12))
        ? this.emptyRun + 1 : 0;
      if (this.emptyRun >= this.confirmations) this.reference = this.previous;
    }
    Object.assign(this.metrics, metrics, {motion, backgroundDrift, referenceReady: Boolean(this.reference)});
    const [min, max] = [Math.min(...metrics.quadrants), Math.max(...metrics.quadrants)];
    const reference = this.reference;
    const occlusion = metrics.contrast < 8 && (metrics.luma < 30 || metrics.luma > 225 ||
      (reference && reference.contrast > 24));
    if (this.exposureStep) {
      if (Math.abs(this.exposureStep.luma - metrics.luma) < 18 ||
        now - this.exposureStep.at > this.intervalMs * (this.confirmations + 2)) this.exposureStep = null;
    } else if (previous && motion < 0.32 && Math.abs(previous.luma - metrics.luma) >= 26 && !occlusion) {
      this.exposureStep = {at: now, luma: previous.luma};
    }
    const blur = reference && reference.sharpness >= 6 && metrics.sharpness < reference.sharpness * 0.42;
    this.update({
      dark: metrics.luma < 50,
      partialDark: min < 55 && max - min > 35,
      backlight: metrics.centerLuma + 36 < max && metrics.darkFraction > 0.12 && metrics.brightFraction > 0.10,
      lightingShift: !occlusion && (this.exposureStep ||
        (reference && Math.abs(reference.luma - metrics.luma) >= 26)),
      cameraShift: empty && reference && backgroundDrift > 0.55 && motion < 0.23 &&
        Math.abs(reference.luma - metrics.luma) < 20 && !occlusion,
      occlusion,
      blur: Boolean(blur && !occlusion),
      motionBlur: Boolean(blur && motion > 0.32 && !occlusion),
    });
    return this.metrics;
  }

  observe({now, inferenceMs, fps, sampleMs, candidates, verified, meanConfidence,
    trackLost, trackCount, overlaps, clipped, medianHeight, directionUncertain} = {}) {
    if (!Number.isFinite(now) || now - this.lastObservation < this.intervalMs) return this.warnings;
    this.lastObservation = now;
    const finite = value => Number.isFinite(value) ? value : null;
    Object.assign(this.metrics, {
      inferenceMs: finite(inferenceMs), fps: finite(fps), candidates: finite(candidates), verified: finite(verified),
      meanConfidence: finite(meanConfidence), trackLost: finite(trackLost), trackCount: finite(trackCount),
      overlaps: finite(overlaps), clipped: finite(clipped), medianHeight: finite(medianHeight),
      directionUncertain: finite(directionUncertain),
    });
    this.update({
      load: inferenceMs >= 700 || (fps > 0 && fps < 1.5 && inferenceMs > Math.max(280, sampleMs || 0)),
      confidence: candidates > 0 && Number.isFinite(meanConfidence) && meanConfidence < 0.48,
      disagreement: candidates > 0 && Number.isFinite(verified) && verified / candidates < 0.50,
      tracking: trackCount > 0 && trackLost / trackCount > 0.45,
      direction: trackCount > 0 && directionUncertain / trackCount > 0.45,
      overlap: overlaps > 0,
      clipping: clipped > 0,
      smallPeople: Number.isFinite(medianHeight) && medianHeight > 0 && medianHeight < 0.24,
      largePeople: medianHeight > 0.78,
    });
    return this.warnings;
  }

  update(conditions) {
    for (const [code, on] of Object.entries(conditions)) {
      const prior = this.streaks.get(code) || 0;
      if (on) this.streaks.set(code, Math.min(this.confirmations * 2, prior + 1));
      else if (prior > 0) this.streaks.set(code, prior - 1);
      else this.streaks.delete(code);
    }
    this.warnings = [...this.streaks]
      .filter(([, n]) => n >= this.confirmations)
      .map(([code]) => ({code, label: labels[code]}));
  }
}
