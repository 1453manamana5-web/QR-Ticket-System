import test from 'node:test';
import assert from 'node:assert/strict';
import { LineTracker } from './reception-app/public/people-counter/tracker.mjs';
import { peopleFromResult, PROFILES } from './reception-app/public/people-counter/detection.mjs';

const person = (x, y = 0.45, score = 0.38) => ({ x, y, score, w: 0.14, h: 0.55 });
function counter(options = {}) {
  const counts = [];
  const tracker = new LineTracker(event => counts.push(event));
  tracker.configure({ ...PROFILES.side, ...options });
  return { tracker, counts };
}
function pass(tracker, positions, start = 0, dt = 120, y = 0.45, score = 0.38) {
  positions.forEach((x, i) => tracker.update([person(x, y, score)], start + i * dt));
}
for (const [axis, direction] of [['x', 1], ['x', -1], ['y', 1], ['y', -1]]) {
  test(`A→B counts once for ${axis}/${direction}`, () => {
    const { tracker, counts } = counter({ axis, direction });
    [0.2, 0.34, 0.47, 0.63, 0.75].forEach((position, i) => {
      const value = direction === 1 ? position : 1 - position;
      tracker.update([axis === 'x' ? person(value) : { ...person(0.45), y: value }], i * 120);
    });
    assert.equal(counts.length, 1);
  });
}
test('a fast side passage and a short missed detection preserve identity', () => {
  const { tracker, counts } = counter();
  tracker.update([person(0.22)], 0);
  tracker.update([person(0.49)], 120);
  tracker.update([], 240);
  tracker.update([person(0.77)], 360);
  assert.equal(counts.length, 1);
  assert.equal(tracker.tracks.length, 1);
});
test('crossing on the second frame waits for a third confirmation', () => {
  const { tracker, counts } = counter();
  tracker.update([person(0.38)], 0);
  tracker.update([person(0.64)], 120);
  assert.equal(counts.length, 0);
  tracker.update([person(0.73)], 240);
  assert.equal(counts.length, 1);
});
test('one or two uncertain detections never count', () => {
  const { tracker, counts } = counter();
  pass(tracker, [0.38, 0.64]);
  tracker.update([], 2000);
  assert.equal(counts.length, 0);
});
test('continuously very weak scores never count', () => {
  const { tracker, counts } = counter();
  pass(tracker, [0.25, 0.38, 0.5, 0.65, 0.76], 0, 120, 0.45, 0.31);
  assert.equal(counts.length, 0);
});
test('reverse travel and turning back at A do not count', () => {
  for (const path of [[0.75, 0.62, 0.48, 0.34, 0.2], [0.25, 0.37, 0.48, 0.36, 0.25]]) {
    const { tracker, counts } = counter();
    pass(tracker, path);
    assert.equal(counts.length, 0);
  }
});
test('starting between lines never counts', () => {
  const { tracker, counts } = counter();
  pass(tracker, [0.48, 0.57, 0.64, 0.74]);
  assert.equal(counts.length, 0);
});
test('a long detection gap never bridges different visitors', () => {
  const { tracker, counts } = counter();
  pass(tracker, [0.3, 0.45]);
  tracker.update([person(0.66)], 2000);
  assert.equal(counts.length, 0);
});
test('standing and shaking around B never counts twice', () => {
  const { tracker, counts } = counter();
  pass(tracker, [0.28, 0.4, 0.51, 0.62, 0.59, 0.61, 0.59, 0.65]);
  assert.equal(counts.length, 1);
});
test('a new visitor behind a counted track is not swallowed by it', () => {
  const { tracker, counts } = counter();
  pass(tracker, [0.3, 0.45, 0.63]);
  pass(tracker, [0.34, 0.47, 0.64, 0.8], 360);
  assert.equal(counts.length, 2);
});
test('two people in different lanes count separately regardless of detection order', () => {
  const { tracker, counts } = counter();
  [0.25, 0.39, 0.51, 0.65, 0.78].forEach((x, i) => {
    const points = [person(x, 0.25), person(x - 0.04, 0.7)];
    tracker.update(i % 2 ? points.reverse() : points, i * 120);
  });
  assert.equal(counts.length, 2);
});
test('timeout and configuration changes drop unfinished passages', () => {
  const { tracker, counts } = counter();
  pass(tracker, [0.3, 0.45]);
  for (let i = 1; i <= 14; i++) tracker.update([person(0.5)], 120 + i * 1000);
  tracker.update([person(0.65)], 14240);
  assert.equal(counts.length, 0);
  tracker.configure({ ...PROFILES.side });
  pass(tracker, [0.51, 0.65, 0.75], 15000);
  assert.equal(counts.length, 0);
});
test('invalid configuration and coordinates are rejected', () => {
  const { tracker } = counter();
  assert.throws(() => tracker.configure({ first: NaN }));
  assert.throws(() => tracker.configure({ first: 0.5, second: 0.55 }));
  tracker.update([{ x: NaN, y: 0.5 }], 0);
  assert.equal(tracker.tracks.length, 0);
});
const detection = (score, box = { originX: 100, originY: 100, width: 200, height: 800 }, categoryName = 'person') =>
  ({ boundingBox: box, categories: [{ categoryName, score }] });
test('side mode retains lower-confidence people while standard mode filters them', () => {
  const result = { detections: [detection(0.38), detection(0.9, undefined, 'chair'), detection(0.2)] };
  assert.equal(peopleFromResult(result, 1000, 1000, 'side').length, 1);
  assert.equal(peopleFromResult(result, 1000, 1000, 'standard').length, 0);
});
test('upper anchor stays correct for a box extending past the bottom of the image', () => {
  const result = { detections: [detection(0.8, { originX: 100, originY: 100, width: 200, height: 1200 })] };
  const [point] = peopleFromResult(result, 1000, 1000);
  assert.equal(point.y, 0.52);
  assert.equal(point.box.height, 900);
});
test('malformed boxes and invalid frame dimensions produce no detections', () => {
  const result = { detections: [detection(0.8, { originX: NaN, originY: 0, width: 10, height: 20 }),
    detection(0.8, { originX: 1200, originY: 0, width: 10, height: 20 })] };
  assert.deepEqual(peopleFromResult(result, 1000, 1000), []);
  assert.deepEqual(peopleFromResult(result, 0, 0), []);
});
