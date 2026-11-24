import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyBodies } from './reception-app/public/people-counter/body-check.mjs';

const frameSize = 1000;
const maskSize = 100;
const touchingPeople = [[40, 33, 10, 27], [51, 36, 10, 27], [49, 46, 3, 2]];
const detection = (id, x, y = .46) => ({id, x, y, score: .92,
  box: {originX: (x - .09) * frameSize, originY: (y - .18) * frameSize, width: 180, height: 580}});
const pair = () => [detection('left', .45), detection('right', .56, .48)];
function mask(rectangles) {
  const data = new Int32Array(maskSize * maskSize).fill(-1);
  for (const [x, y, w, h] of rectangles) {
    for (let row = y; row < y + h; row++) data.fill(12, row * maskSize + x, row * maskSize + x + w);
  }
  return {width: maskSize, height: maskSize, data};
}
const verify = (detections, parts, separate = true) => verifyBodies(detections, parts, frameSize, frameSize, 'torso', separate);
const confirmed = result => result.accepted.map(d => d.id).sort();

test('an unsupported distant detection does not prevent a touching pair from recovering', () => {
  const detections = [detection('unverified', .14), ...pair(), detection('alone', .82)];
  const parts = mask([...touchingPeople, [78, 34, 8, 30]]);
  const baseline = verify(detections, parts, false);
  const result = verify(detections, parts);
  assert.equal(baseline.accepted.length, 2);
  assert.deepEqual(confirmed(result), ['alone', 'left', 'right']);
  assert.deepEqual(result.accepted.find(d => d.id === 'alone'), baseline.accepted.find(d => d.id === 'alone'));
  assert.equal(result.annotated[0].bodyVerified, false);
  assert.equal(result.annotated.length, detections.length);
});

test('a near-duplicate still counts once without suppressing an independent overlapping group', () => {
  const detections = [detection('duplicate', .81), ...pair(), detection('other', .82)];
  const parts = mask([...touchingPeople, [78, 34, 8, 30]]);
  for (const order of [detections, detections.slice().reverse()]) {
    const result = verify(order, parts);
    assert.equal(result.accepted.length, 3);
    const ids = confirmed(result);
    assert.ok(ids.includes('left') && ids.includes('right'));
    assert.notEqual(ids.includes('duplicate'), ids.includes('other'));
  }
});

test('an unsupported box inside an overlapping group leaves that group on its original associations', () => {
  const detections = [...pair(), detection('unverified', .69)];
  const parts = mask(touchingPeople);
  const baseline = verify(detections, parts, false);
  assert.equal(baseline.accepted.length, 1);
  assert.deepEqual(verify(detections, parts), baseline);
});
