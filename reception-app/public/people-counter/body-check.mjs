// A second, independent pose check for person detections. All coordinates are
// transient normalized image positions; no identity or landmarks are stored.
const MIN_VISIBILITY = 0.6;
const SIDES = [
  { shoulder: 11, hip: 23, heads: [0, 1, 2, 3, 7] },
  { shoulder: 12, hip: 24, heads: [0, 4, 5, 6, 8] },
];
function visible(point) {
  return point && [point.x, point.y, point.visibility].every(Number.isFinite) &&
    point.visibility >= MIN_VISIBILITY &&
    (!Number.isFinite(point.presence) || point.presence >= 0.6) &&
    point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}
function inside(point, detection, width, height) {
  const b = detection.box;
  const mx = Math.min(width * 0.02, b.width * 0.1);
  const my = Math.min(height * 0.02, b.height * 0.1);
  return point.x * width >= b.originX - mx && point.x * width <= b.originX + b.width + mx &&
    point.y * height >= b.originY - my && point.y * height <= b.originY + b.height + my;
}
function torsoForDetection(landmarks, detection, width, height) {
  const sides = [];
  for (const side of SIDES) {
    const shoulder = landmarks[side.shoulder], hip = landmarks[side.hip];
    if (!visible(shoulder) || !visible(hip)) continue;
    const head = side.heads.map(i => landmarks[i]).find(p => visible(p) &&
      inside(p, detection, width, height) && p.y < shoulder.y - 0.015);
    if (!head || !inside(shoulder, detection, width, height) || !inside(hip, detection, width, height)) continue;
    // Require a visible head above an upright trunk. Do not accept an inferred
    // off-screen hip, a bent arm mistaken for a trunk, or a horizontal object.
    const trunkY = (hip.y - shoulder.y) * height;
    const trunkX = Math.abs(hip.x - shoulder.x) * width;
    const headY = (shoulder.y - head.y) * height;
    if (trunkY < Math.max(20, height * 0.08) || trunkX > trunkY * 1.5 ||
      headY < 8 || headY > trunkY * 1.7 || Math.abs(head.x - shoulder.x) * width > trunkY) continue;
    sides.push({ shoulder, hip, head });
  }
  if (!sides.length) return null;
  const average = name => ({
    x: sides.reduce((sum, side) => sum + side[name].x, 0) / sides.length,
    y: sides.reduce((sum, side) => sum + side[name].y, 0) / sides.length,
  });
  const shoulder = average('shoulder'), hip = average('hip'), head = average('head');
  return { head, shoulder, hip,
    x: shoulder.x * 0.65 + hip.x * 0.35,
    y: shoulder.y * 0.65 + hip.y * 0.35 };
}

export function verifyBodies(detections, poseResult, width, height) {
  const poses = Array.isArray(poseResult?.landmarks) ? poseResult.landmarks : [];
  const candidates = [];
  if (width > 0 && height > 0) {
    detections.forEach((detection, di) => poses.forEach((landmarks, pi) => {
      if (!Array.isArray(landmarks)) return;
      // An isolated horizontal arm can also hallucinate a short, visible pose.
      // Reject extremely wide boxes before accepting that pose as a visitor.
      if (detection.box.height < detection.box.width * 0.65) return;
      const body = torsoForDetection(landmarks, detection, width, height);
      if (!body) return;
      // Prefer a detection centred on this trunk; an extra arm-only box must
      // never reuse the same body's confirmation as a second visitor.
      const distance = Math.hypot((body.x - detection.x) * width, (body.y - detection.y) * height);
      candidates.push({ di, pi, body, distance });
    }));
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const usedDetections = new Set(), usedPoses = new Set(), matches = new Map();
  for (const candidate of candidates) {
    if (usedDetections.has(candidate.di) || usedPoses.has(candidate.pi)) continue;
    usedDetections.add(candidate.di); usedPoses.add(candidate.pi);
    matches.set(candidate.di, candidate.body);
  }
  const annotated = detections.map((detection, index) => {
    const body = matches.get(index);
    return body ? { ...detection, x: body.x, y: body.y, body, bodyVerified: true }
      : { ...detection, bodyVerified: false };
  });
  return { annotated, accepted: annotated.filter(d => d.bodyVerified) };
}
