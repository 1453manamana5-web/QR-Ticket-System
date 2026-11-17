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

// Verify the shoulder-to-waist region, independently of a visible head.
const { verifyBodies } = await import('./reception-app/public/people-counter/body-check.mjs');
const { createVisionPipeline } = await import('./reception-app/public/people-counter/vision.mjs');
function mask(rectangles = []) {
  const width = 100, height = 100, data = new Int32Array(width * height).fill(-1);
  for (const [left, top, rw, rh, part = 12] of rectangles) {
    for (let y = top; y < top + rh; y++) for (let x = left; x < left + rw; x++) data[y * width + x] = part;
  }
  return { width, height, data };
}
const bodyDetection = (x = 0.5) => ({ ...person(x), box: { originX: (x - 0.15) * 1000, originY: 150, width: 300, height: 700 } });
const torso = (x = 0.5, part = 12) => [Math.round(x * 100) - 4, 30, 8, 30, part];
const verify = (detections, parts) => verifyBodies(detections, parts, 1000, 1000);

test('shoulder-to-waist torso is accepted with no head, face or legs in the mask', () => {
  const result = verify([bodyDetection()], mask([torso()]));
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].bodyVerified, true);
});
test('the back of a torso is also accepted', () => {
  assert.equal(verify([bodyDetection()], mask([torso(0.5, 13)])).accepted.length, 1);
});
test('a narrow side-on torso is accepted', () => {
  assert.equal(verify([bodyDetection()], mask([[49, 25, 3, 40]])).accepted.length, 1);
});
test('a high-score person-labelled arm crossing both lines never counts', () => {
  const { tracker, counts } = counter();
  [0.25, 0.4, 0.55, 0.7].forEach((x, i) => {
    const arm = { ...bodyDetection(x), score: 0.99 };
    const result = verify([arm], mask([[Math.round(x * 100) - 4, 30, 8, 30, 4]]));
    assert.equal(result.annotated[0].bodyVerified, false);
    tracker.update(result.accepted, i * 120);
  });
  assert.equal(counts.length, 0);
});
test('face, arm, hand and leg pixels cannot supply torso evidence', () => {
  for (const part of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]) {
    assert.equal(verify([bodyDetection()], mask([torso(0.5, part)])).accepted.length, 0);
  }
});
test('small mislabelled torso patches cannot confirm an arm', () => {
  assert.equal(verify([bodyDetection()], mask([[49, 45, 2, 2]])).accepted.length, 0);
});
test('a horizontal patch labelled torso cannot confirm a visitor', () => {
  assert.equal(verify([bodyDetection()], mask([[40, 40, 20, 6]])).accepted.length, 0);
});
test('an extremely wide person-labelled arm box is rejected even with a torso-like patch', () => {
  const arm = { ...bodyDetection(), box: { originX: 100, originY: 250, width: 800, height: 200 } };
  assert.equal(verify([arm], mask([[47, 28, 6, 14]])).accepted.length, 0);
});
test('a nearby real torso cannot confirm an unrelated arm detection', () => {
  const arm = { ...bodyDetection(0.1), box: { originX: 0, originY: 150, width: 150, height: 700 } };
  const result = verify([arm, bodyDetection()], mask([torso()]));
  assert.equal(result.annotated[0].bodyVerified, false);
  assert.equal(result.accepted.length, 1);
});
test('overlapping boxes cannot reuse one torso to count two visitors', () => {
  assert.equal(verify([bodyDetection(), bodyDetection(0.51)], mask([torso()])).accepted.length, 1);
});
test('two separate torsos are independently accepted', () => {
  assert.equal(verify([bodyDetection(0.25), bodyDetection(0.75)], mask([torso(0.25), torso(0.75)])).accepted.length, 2);
});
test('moving the detection box by waving an arm does not move the torso anchor', () => {
  const { tracker, counts } = counter();
  [0.28, 0.42, 0.55, 0.68, 0.72].forEach((x, i) => {
    const d = { ...bodyDetection(), x, box: { originX: 100, originY: 50, width: 800, height: 900 } };
    const result = verify([d], mask([torso()]));
    assert.equal(result.accepted.length, 1);
    tracker.update(result.accepted, i * 120);
  });
  assert.equal(counts.length, 0);
});
test('a torso with no head crossing A then B counts once', () => {
  const { tracker, counts } = counter();
  [0.25, 0.4, 0.54, 0.69, 0.8].forEach((x, i) => {
    const result = verify([bodyDetection(x)], mask([torso(x)]));
    assert.equal(result.accepted.length, 1);
    tracker.update(result.accepted, i * 120);
  });
  assert.equal(counts.length, 1);
});
test('previous torso evidence is not reused on an arm or an empty frame', () => {
  assert.equal(verify([bodyDetection()], mask([torso()])).accepted.length, 1);
  assert.equal(verify([bodyDetection()], mask()).accepted.length, 0);
  assert.equal(verify([bodyDetection()], null).accepted.length, 0);
});
test('invalid segmentation dimensions are ignored', () => {
  assert.equal(verify([bodyDetection()], { width: 100, height: 100, data: [] }).accepted.length, 0);
});
const mockSDK = detector => ({
  FilesetResolver: { forVisionTasks: async () => ({}) },
  ObjectDetector: { createFromOptions: async () => detector },
});
test('blocked torso model closes the detector and never starts unverified counting', async () => {
  let closed = false;
  await assert.rejects(createVisionPipeline({ resolveSDK: async () => mockSDK({ close() { closed = true; } }),
    resolveTorso: async () => { throw new Error('model blocked'); } }), /model blocked/);
  assert.equal(closed, true);
});
test('the object detector and asynchronous torso verifier use the same snapshot', async () => {
  const calls = [], frame = {};
  const pipeline = await createVisionPipeline({ resolveSDK: async () => mockSDK({
    detectForVideo(f, t) { calls.push(['object', f, t]); return { detections: [detection(0.9)] }; }, close() {},
  }), resolveTorso: async () => ({ async detect(f) { calls.push(['torso', f]); return mask(); }, close() {} }) });
  const result = await pipeline.detectForVideo(frame, 123);
  assert.deepEqual(calls, [['object', frame, 123], ['torso', frame]]);
  assert.equal(verifyBodies(peopleFromResult(result.objects, 1000, 1000), result.parts, 1000, 1000).accepted.length, 0);
});
test('an empty object frame skips segmentation and returns no torso evidence', async () => {
  let called = false;
  const pipeline = await createVisionPipeline({ resolveSDK: async () => mockSDK({ detectForVideo() { return { detections: [] }; }, close() {} }),
    resolveTorso: async () => ({ async detect() { called = true; return mask([torso()]); }, close() {} }) });
  assert.equal((await pipeline.detectForVideo({}, 1)).parts, null);
  assert.equal(called, false);
});

// Exercise the real camera loop while the new async model is still working.
const { readFileSync } = await import('node:fs');
const { withDeadline, MAX_INFERENCE_MS } = await import('./reception-app/public/people-counter/health.mjs');
function cameraLoopHarness(pipeline) {
  const ctx = Object.fromEntries(['clearRect', 'drawImage', 'setLineDash', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fillText', 'strokeRect', 'fillRect', 'arc', 'fill'].map(name => [name, () => {}]));
  const elements = new Map(), scheduled = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { width: 320, height: 213, style: {}, classList: { toggle() {} },
      addEventListener() {}, getContext() { return ctx; }, pause() {}, readyState: 2, currentTime: 1 });
    return elements.get(id);
  };
  const document = { hidden: false, getElementById: element, createElement: () => element('analysis'), addEventListener() {} };
  const source = readFileSync(new URL('./reception-app/public/people-counter/app.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('void initialize();', '');
  const load = new Function('document', 'window', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame',
    'LineTracker', 'PROFILES', 'peopleFromResult', 'verifyBodies', 'createVisionPipeline', 'withDeadline', 'MAX_INFERENCE_MS', 'BroadcastChannel', source +
    '\nreturn {tick, stopCamera, configureTracker, activate(p){detector=p;running=true;}, tracks(){return tracker.tracks.length;}};');
  const api = load(document, { addEventListener() {} }, {}, fn => { scheduled.push(fn); return scheduled.length; }, () => {},
    LineTracker, PROFILES, peopleFromResult, verifyBodies, createVisionPipeline, withDeadline, MAX_INFERENCE_MS);
  api.activate(pipeline);
  return { api, scheduled };
}
const cameraFrameResult = () => ({ objects: { detections: [detection(0.9, { originX: 110, originY: 20, width: 100, height: 180 })] }, parts: mask([torso()]) });
test('async camera loop schedules the next frame only after the current model finishes', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { api, scheduled } = cameraLoopHarness({ detectForVideo() { return pending; } });
  const runningTick = api.tick(100);
  assert.equal(scheduled.length, 0);
  finish(cameraFrameResult()); await runningTick;
  assert.equal(api.tracks(), 1);
  assert.equal(scheduled.length, 1);
});
test('stopping during async inference discards the late result and schedules no frame', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { api, scheduled } = cameraLoopHarness({ detectForVideo() { return pending; } });
  const runningTick = api.tick(100); api.stopCamera();
  finish(cameraFrameResult()); await runningTick;
  assert.equal(api.tracks(), 0);
  assert.equal(scheduled.length, 0);
});
test('changing the counting lines during inference drops the old frame before tracking', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { api, scheduled } = cameraLoopHarness({ detectForVideo() { return pending; } });
  const runningTick = api.tick(100); api.configureTracker();
  finish(cameraFrameResult()); await runningTick;
  assert.equal(api.tracks(), 0);
  assert.equal(scheduled.length, 1);
});

test('a following visitor first seen just before A is counted separately', () => {
  const { tracker, counts } = counter();
  pass(tracker, [0.25, 0.4, 0.55, 0.65]);
  pass(tracker, [0.38, 0.5, 0.65, 0.8], 480);
  assert.equal(counts.length, 2);
});
test('steady 1.1-second processing cadence does not lose every track', () => {
  const { tracker, counts } = counter();
  pass(tracker, [0.25, 0.4, 0.55, 0.7], 0, 1100);
  assert.equal(counts.length, 1);
});

// Adversarial masks: the detector itself may still label these as a person.
test('a small torso-labelled patch inside a large person box is insufficient', () => {
  assert.equal(verify([bodyDetection()], mask([[46,40,8,8]])).accepted.length, 0);
});
test('a thin stalk joined to a wide base is not a complete torso', () => {
  assert.equal(verify([bodyDetection()], mask([[46,25,1,40],[46,57,10,8]])).accepted.length, 0);
});
test('torso labels at the foot of a full-height detection cannot verify a person', () => {
  assert.equal(verify([bodyDetection()], mask([[46,68,8,17]])).accepted.length, 0);
});
test('isolated ghost detections separated by empty frames never count', () => {
  const {tracker,counts}=counter();
  [.25,.4,.55,.7].forEach((x,i)=>{tracker.update([person(x)],i*240);tracker.update([],i*240+120);});
  assert.equal(counts.length,0);
});
test('a briefly occluded real visitor can confirm again and count once', () => {
  const {tracker,counts}=counter();
  tracker.update([person(.25)],0);tracker.update([person(.4)],120);tracker.update([],240);
  tracker.update([person(.55)],360);tracker.update([person(.7)],480);tracker.update([person(.8)],600);
  assert.equal(counts.length,1);
});

const legMask = (side = 'left') => mask([torso(), [47,60,6,10,side === 'left' ? 14 : 16],
  [47,70,6,10,side === 'left' ? 18 : 20], [47,80,9,5,side === 'left' ? 22 : 23]]);
const verifyLegs = (parts, detections = [bodyDetection()]) => verifyBodies(detections, parts, 1000, 1000, 'legs');
test('either visible leg can confirm torso, upper leg, lower leg and foot in side view', () => {
  for (const side of ['left','right']) {
    const r=verifyLegs(legMask(side));assert.equal(r.accepted.length,1);assert.equal(r.accepted[0].legVerified,true);
    assert.equal(r.accepted[0].y,verify([bodyDetection()],legMask(side)).accepted[0].y);
  }
});
test('leg mode rejects torso only but default mode still accepts a cropped shoulder-to-waist view', () => {
  assert.equal(verifyLegs(mask([torso()])).accepted.length,0);
  assert.equal(verify([bodyDetection()],mask([torso()])).accepted.length,1);
});
test('feet alone or arms attached below a torso cannot verify legs', () => {
  assert.equal(verifyLegs(mask([[47,80,9,5,22]])).accepted.length,0);
  assert.equal(verifyLegs(mask([torso(),[47,60,6,20,4],[47,80,9,5,22]])).accepted.length,0);
});
test('missing feet, disconnected feet and inverted limb order are rejected', () => {
  for (const rects of [
    [torso(),[47,60,6,10,14],[47,70,6,15,18]],
    [torso(),[47,60,6,10,14],[47,70,6,7,18],[47,82,9,3,22]],
    [torso(),[47,60,6,5,22],[47,65,6,10,18],[47,75,6,10,14]],
    [torso(),[47,60,6,10,14],[47,70,6,10,20],[47,80,9,5,23]],
  ]) assert.equal(verifyLegs(mask(rects)).accepted.length,0);
});
test('a nearby persons legs cannot complete this torso', () => {
  assert.equal(verifyLegs(mask([torso(),[65,60,6,10,14],[65,70,6,10,18],[65,80,9,5,22]])).accepted.length,0);
});
test('overlapping detections cannot reuse the same torso and foot chain', () => {
  assert.equal(verifyLegs(legMask(),[bodyDetection(),bodyDetection(.51)]).accepted.length,1);
});
test('a fully verified leg-mode passage counts once', () => {
  const {tracker,counts}=counter();
  [.25,.4,.55,.7].forEach((x,i)=>{
    const p=legMask(),delta=Math.round((x-.5)*100),data=new Int32Array(10000).fill(-1);
    for(let y=0;y<100;y++)for(let xx=0;xx<100;xx++)if(xx+delta>=0&&xx+delta<100)data[y*100+xx+delta]=p.data[y*100+xx];
    tracker.update(verifyBodies([bodyDetection(x)],{...p,data},1000,1000,'legs').accepted,i*120);
  });assert.equal(counts.length,1);
});
