import assert from 'node:assert/strict';
import test from 'node:test';
import {EnvironmentMonitor} from './reception-app/public/people-counter/adaptive-environment.mjs';

function frame(pixel, width = 48, height = 32) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = pixel(x, y);
      const offset = 4 * (y * width + x);
      data[offset] = data[offset + 1] = data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return {data, width, height};
}
const stripes = frame(x => x < 24 ? 70 : 150);
const horizontalStripes = frame((_, y) => y < 16 ? 70 : 150);
const codes = monitor => monitor.warnings.map(({code}) => code);
function frames(monitor, image, {start = 0, count = 3, empty = true} = {}) {
  for (let i = 0; i < count; i++) monitor.sample(image, start + i * 500, {empty});
}

test('reports luma, contrast and local darkness from a small frame without retaining original bytes', () => {
  const monitor = new EnvironmentMonitor();
  const darkHalf = frame(x => x < 24 ? 30 : 150);
  frames(monitor, darkHalf);
  assert.equal(monitor.metrics.luma, 90);
  assert.equal(monitor.metrics.contrast, 60);
  assert.deepEqual(monitor.metrics.quadrants, [30, 150, 30, 150]);
  assert.equal(monitor.metrics.darkFraction, 0.5);
  assert.deepEqual(codes(monitor), ['partialDark']);
  assert.equal(monitor.metrics.grid, undefined);
  assert.equal(monitor.previous.grid.length, 96);
  assert.equal(monitor.previous.data, undefined);
});

test('builds a stationary empty reference without classifying uniform exposure gain as a camera shift', () => {
  const monitor = new EnvironmentMonitor();
  frames(monitor, stripes);
  assert.equal(monitor.metrics.referenceReady, true);
  const brighter = frame(x => x < 24 ? 105 : 185);
  frames(monitor, brighter, {start: 1500});
  assert.equal(monitor.metrics.motion, 0);
  assert.equal(monitor.metrics.backgroundDrift, 0);
  assert.ok(codes(monitor).includes('lightingShift'));
  assert.ok(!codes(monitor).includes('cameraShift'));
});

test('debounces a camera shift only after the new empty view stabilizes', () => {
  const monitor = new EnvironmentMonitor();
  frames(monitor, stripes);
  frames(monitor, horizontalStripes, {start: 1500});
  assert.ok(!codes(monitor).includes('cameraShift'));
  frames(monitor, horizontalStripes, {start: 3000, count: 1});
  assert.ok(codes(monitor).includes('cameraShift'));
  assert.ok(!codes(monitor).includes('lightingShift'));
});

test('avoids creating a background reference from frames with detected people', () => {
  const monitor = new EnvironmentMonitor();
  frames(monitor, stripes, {empty: false, count: 8});
  assert.equal(monitor.metrics.backgroundDrift, null);
  assert.equal(monitor.metrics.referenceReady, false);
  monitor.reset();
  assert.equal(monitor.previous, null);
  assert.equal(monitor.reference, null);
});

test('recognizes sustained darkness and possible lens obstruction', () => {
  const monitor = new EnvironmentMonitor();
  const veryDark = frame(() => 8);
  frames(monitor, veryDark, {count: 2});
  assert.deepEqual(codes(monitor), []);
  frames(monitor, veryDark, {start: 1000, count: 1});
  assert.deepEqual(codes(monitor), ['dark', 'occlusion']);
});

test('warns about a bright periphery paired with a dark central region', () => {
  const monitor = new EnvironmentMonitor();
  const lightBehind = frame((x, y) => x < 12 || x >= 36 || y < 8 || y >= 24 ? 235 : 25);
  frames(monitor, lightBehind);
  assert.equal(monitor.metrics.centerLuma, 25);
  assert.ok(codes(monitor).includes('backlight'));
});

test('recognizes sustained relative edge loss separately from motion between samples', () => {
  const monitor = new EnvironmentMonitor();
  frames(monitor, frame((x, y) => y < 16 ? 55 + (x % 2) * 50 : 140 + (x % 2) * 50));
  const edgeLoss = frame((x, y) => y < 16 ? 80 : 165);
  frames(monitor, edgeLoss, {start: 1500});
  assert.ok(codes(monitor).includes('blur'));
  assert.ok(!codes(monitor).includes('motionBlur'));
});

test('debounces sustained load, confidence, disagreement and tracking signals, then recovers', () => {
  const monitor = new EnvironmentMonitor();
  const problem = {inferenceMs: 800, fps: 1, candidates: 4, verified: 1, meanConfidence: 0.40,
    trackCount: 3, trackLost: 2, overlaps: 1, clipped: 1, medianHeight: 0.8, directionUncertain: 2};
  for (const now of [0, 100, 200, 500]) monitor.observe({now, ...problem});
  assert.deepEqual(codes(monitor), []);
  monitor.observe({now: 1000, ...problem});
  assert.deepEqual(codes(monitor), ['load', 'confidence', 'disagreement', 'tracking', 'direction', 'overlap', 'clipping', 'largePeople']);
  monitor.observe({now: 1500, inferenceMs: 100, fps: 6, candidates: 0, verified: 0, trackCount: 0});
  assert.deepEqual(codes(monitor), []);
  assert.equal(monitor.metrics.fps, 6);
});

test('a high or zero flow of people alone is not treated as an anomaly', () => {
  const monitor = new EnvironmentMonitor();
  for (const now of [0, 500, 1000]) monitor.observe({now, candidates: 10, verified: 10, fps: 5, trackCount: 10});
  for (const now of [1500, 2000, 2500]) monitor.observe({now, candidates: 0, verified: 0, fps: 5, trackCount: 0});
  assert.deepEqual(codes(monitor), []);
});

test('ignores malformed or full-resolution image buffers to bound diagnostic CPU cost', () => {
  const monitor = new EnvironmentMonitor();
  monitor.sample(null, 0);
  monitor.sample({width: 640, height: 480, data: []}, 500);
  assert.equal(monitor.metrics.luma, null);
  assert.equal(monitor.previous, null);
  monitor.sample(stripes, 1000);
  assert.equal(monitor.metrics.luma, 110);
});

test('detects a persistent lighting step without requiring an empty room', () => {
  const monitor = new EnvironmentMonitor();
  frames(monitor, stripes, {empty: false});
  const brighter = frame(x => x < 24 ? 105 : 185);
  frames(monitor, brighter, {start: 1500, empty: false});
  assert.equal(monitor.metrics.referenceReady, false);
  assert.ok(codes(monitor).includes('lightingShift'));
  assert.ok(!codes(monitor).includes('cameraShift'));
  frames(monitor, stripes, {start: 3000, empty: false, count: 12});
  assert.ok(!codes(monitor).includes('lightingShift'));
});

test('identifies possible motion blur when picture changes coincide with sustained edge loss', () => {
  const monitor = new EnvironmentMonitor();
  frames(monitor, frame((x, y) => y < 16 ? 55 + (x % 2) * 50 : 140 + (x % 2) * 50));
  const upper = frame((x, y) => y < 16 ? 80 : 165);
  const lower = frame((x, y) => y < 16 ? 165 : 80);
  for (let i = 0; i < 4; i++) monitor.sample(i % 2 ? upper : lower, 1500 + i * 500);
  assert.ok(codes(monitor).includes('motionBlur'));
});
