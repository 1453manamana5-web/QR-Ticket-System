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

// The real detector may label an isolated arm as person, even at high scores.
// These tests exercise the mandatory body gate and the counter together.
const { verifyBodies } = await import('./reception-app/public/people-counter/body-check.mjs');
const { createVisionPipeline } = await import('./reception-app/public/people-counter/vision.mjs');
const landmark = (x, y, visibility = 0.95) => ({ x, y, visibility, presence: 0.95 });
function poseAt(x = 0.5, sideOnly = false) {
  const points = Array.from({ length: 33 }, () => landmark(0, 0, 0));
  points[0] = landmark(x, 0.15);
  points[7] = landmark(x - 0.02, 0.16);
  points[11] = landmark(x - 0.025, 0.3);
  points[23] = landmark(x - 0.02, 0.62);
  if (!sideOnly) {
    points[8] = landmark(x + 0.02, 0.16);
    points[12] = landmark(x + 0.025, 0.3);
    points[24] = landmark(x + 0.02, 0.62);
  }
  return points;
}
const bodyDetection = (x = 0.5) => ({ ...person(x), box: { originX: (x - 0.12) * 1000, originY: 80, width: 240, height: 820 } });
const verify = (detections, poses) => verifyBodies(detections, { landmarks: poses }, 1000, 1000);

test('a high-confidence person-labelled arm cannot count without a visible body', () => {
  const { tracker, counts } = counter();
  [0.25, 0.4, 0.55, 0.7].forEach((x, i) => {
    const arm = { ...bodyDetection(x), score: 0.99 };
    const { accepted, annotated } = verify([arm], []);
    assert.equal(annotated[0].bodyVerified, false);
    tracker.update(accepted, i * 120);
  });
  assert.equal(counts.length, 0);
  assert.equal(tracker.tracks.length, 0);
});
test('visible arm landmarks alone never pass as a trunk', () => {
  const points = Array.from({ length: 33 }, () => landmark(0, 0, 0));
  points[13] = landmark(0.4, 0.4); points[15] = landmark(0.6, 0.4);
  assert.equal(verify([bodyDetection()], [points]).accepted.length, 0);
});
test('a visible head, shoulder and hip on one side accept a side-on visitor', () => {
  const { accepted } = verify([bodyDetection()], [poseAt(0.5, true)]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].bodyVerified, true);
});
test('low-visibility or off-screen guessed hips cannot confirm an arm', () => {
  for (const hip of [landmark(0.5, 0.62, 0.1), landmark(0.5, 1.12)]) {
    const points = poseAt(0.5, true); points[23] = hip;
    assert.equal(verify([bodyDetection()], [points]).accepted.length, 0);
  }
});
test('a head and shoulders without a visible hip do not count', () => {
  const points = poseAt(); points[23].visibility = 0; points[24].visibility = 0;
  assert.equal(verify([bodyDetection()], [points]).accepted.length, 0);
});
test('a body whose head is outside the image is not accepted', () => {
  const points = poseAt();
  for (const i of [0, 7, 8]) points[i].y = -0.1;
  assert.equal(verify([bodyDetection()], [points]).accepted.length, 0);
});
test('an arm box next to a real body cannot borrow its confirmation', () => {
  const arm = { ...bodyDetection(), box: { originX: 450, originY: 280, width: 400, height: 80 } };
  const result = verify([arm, bodyDetection()], [poseAt()]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.annotated[0].bodyVerified, false);
  assert.equal(result.annotated[1].bodyVerified, true);
});
test('overlapping person boxes cannot reuse one pose to produce two visitors', () => {
  assert.equal(verify([bodyDetection(), bodyDetection(0.51)], [poseAt()]).accepted.length, 1);
});
test('separate visible bodies are both accepted', () => {
  assert.equal(verify([bodyDetection(0.25), bodyDetection(0.75)], [poseAt(0.25), poseAt(0.75)]).accepted.length, 2);
});
test('a waving arm moving a box across both lines does not move the torso anchor', () => {
  const { tracker, counts } = counter();
  [0.28, 0.42, 0.55, 0.68, 0.72].forEach((boxAnchor, i) => {
    const d = { ...bodyDetection(0.5), x: boxAnchor, box: { originX: 100, originY: 50, width: 800, height: 900 } };
    const { accepted } = verify([d], [poseAt(0.5)]);
    assert.equal(accepted.length, 1);
    tracker.update(accepted, i * 120);
  });
  assert.equal(counts.length, 0);
});
test('a verified side-on trunk crossing A then B counts once', () => {
  const { tracker, counts } = counter();
  [0.25, 0.4, 0.54, 0.69, 0.8].forEach((x, i) => {
    const { accepted } = verify([bodyDetection(x)], [poseAt(x, true)]);
    assert.equal(accepted.length, 1);
    tracker.update(accepted, i * 120);
  });
  assert.equal(counts.length, 1);
});
test('body confirmation from a prior frame is never reused for an arm', () => {
  assert.equal(verify([bodyDetection()], [poseAt()]).accepted.length, 1);
  assert.equal(verify([bodyDetection()], []).accepted.length, 0);
});

test('a blocked body model closes the object detector and refuses an unverified pipeline', async () => {
  let closed = false;
  const sdk = {
    FilesetResolver: { forVisionTasks: async () => ({}) },
    ObjectDetector: { createFromOptions: async () => ({ close() { closed = true; } }) },
    PoseLandmarker: { createFromOptions: async () => { throw new Error('model blocked'); } },
  };
  await assert.rejects(createVisionPipeline({ resolveSDK: async () => sdk }), /model blocked/);
  assert.equal(closed, true);
});
test('both models inspect the same frame and CPU fallback retains the body gate', async () => {
  const calls = [];
  const frame = {};
  const sdk = {
    FilesetResolver: { forVisionTasks: async () => ({}) },
    ObjectDetector: { createFromOptions: async () => ({
      detectForVideo(f, t) { calls.push(['object', f, t]); return { detections: [detection(0.9)] }; }, close() {},
    }) },
    PoseLandmarker: { createFromOptions: async (_, options) => {
      if (options.baseOptions.delegate === 'GPU') throw new Error('GPU unavailable');
      return { detectForVideo(f, t) { calls.push(['body', f, t]); return { landmarks: [] }; }, close() {} };
    } },
  };
  const pipeline = await createVisionPipeline({ resolveSDK: async () => sdk });
  const result = pipeline.detectForVideo(frame, 123);
  assert.deepEqual(calls, [['object', frame, 123], ['body', frame, 123]]);
  const candidates = peopleFromResult(result.objects, 1000, 1000);
  assert.equal(verifyBodies(candidates, result.poses, 1000, 1000).accepted.length, 0);
});
test('real arm false-positive with a hallucinated visible pose is rejected by its wide box', () => {
  // Coordinates observed using both released models on the arm-only sample.
  const points = Array.from({ length: 33 }, () => landmark(0, 0, 0));
  points[0] = landmark(0.35725, 0.50339);
  points[7] = landmark(0.36007, 0.50649);
  points[8] = landmark(0.33564, 0.52313);
  points[11] = landmark(0.36943, 0.50235);
  points[12] = landmark(0.33459, 0.53362);
  points[23] = landmark(0.37562, 0.60116);
  points[24] = landmark(0.35268, 0.61909);
  const d = { x: 0.497, y: 0.498, score: 0.603, w: 0.708, h: 147 / 667,
    box: { originX: 143, originY: 281, width: 708, height: 147 } };
  assert.equal(verifyBodies([d], { landmarks: [points] }, 1000, 667).accepted.length, 0);
});
