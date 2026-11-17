// BodyPix part IDs 12/13 represent the front/back of the torso. Heads, arms,
// hands and legs never contribute evidence. Masks are transient, never stored.
const isTorso = value => value === 12 || value === 13;

function torsoRegions(parts) {
  const { width, height, data } = parts || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
    !data || data.length !== width * height) return [];
  const visited = new Uint8Array(data.length), queue = new Int32Array(data.length), regions = [];
  for (let i = 0; i < data.length; i++) {
    if (visited[i] || !isTorso(data[i])) continue;
    let read = 0, end = 1, sumX = 0, sumY = 0;
    let left = width, right = 0, top = height, bottom = 0;
    queue[0] = i; visited[i] = 1;
    while (read < end) {
      const at = queue[read++], x = at % width, y = Math.floor(at / width);
      sumX += x; sumY += y;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      const visit = next => {
        if (!visited[next] && isTorso(data[next])) { visited[next] = 1; queue[end++] = next; }
      };
      if (x > 0) visit(at - 1);
      if (x + 1 < width) visit(at + 1);
      if (y > 0) visit(at - width);
      if (y + 1 < height) visit(at + width);
    }
    const rw = right - left + 1, rh = bottom - top + 1;
    // A substantial, connected upright area; a few mislabelled arm pixels
    // cannot establish a visitor. No head or full-body landmarks are required.
    if (end < Math.max(16, width * height * 0.0007) || rw < 3 ||
      rh < Math.max(6, height * 0.06) || rh < rw * 0.65 || end / (rw * rh) < 0.2) continue;
    // Require substantial torso material throughout its height, rather than a
    // blob with a thin one-pixel bridge or an isolated shoulder-sized patch.
    const bands = new Uint32Array(3);
    for (let q = 0; q < end; q++) {
      const y = Math.floor(queue[q] / width);
      bands[Math.min(2, Math.floor((y - top) * 3 / rh))]++;
    }
    if (bands.some(count => count < end * 0.12)) continue;
    regions.push({ left: left / width, top: top / height, width: rw / width, height: rh / height,
      x: (sumX / end + 0.5) / width, y: (sumY / end + 0.5) / height,
      pixels: end, pixelArea: width * height });
  }
  return regions;
}

// BodyPix IDs: upper legs 14..17, lower legs 18..21, feet 22/23.
// A side-on person needs only one visible, connected upper-leg → lower-leg →
// foot chain. Never borrow disconnected feet or another person's lower body.
function legRegions(parts) {
  const { width, height, data } = parts || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data?.length !== width * height) return [];
  const visited = new Uint8Array(data.length), queue = new Int32Array(data.length), regions = [];
  const isLeg = id => id >= 14 && id <= 23;
  for (let i = 0; i < data.length; i++) {
    if (visited[i] || !isLeg(data[i])) continue;
    let read = 0, end = 1, left = width, right = 0, top = height, bottom = 0;
    const sides = [Array.from({length: 3}, () => ({n: 0, x: 0, y: 0})), Array.from({length: 3}, () => ({n: 0, x: 0, y: 0}))];
    queue[0] = i; visited[i] = 1;
    while (read < end) {
      const at = queue[read++], x = at % width, y = Math.floor(at / width), id = data[at];
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      const side = id < 18 ? Math.floor((id - 14) / 2) : id < 22 ? Math.floor((id - 18) / 2) : id - 22;
      const band = id < 18 ? 0 : id < 22 ? 1 : 2, group = sides[side][band];
      group.n++; group.x += x + 0.5; group.y += y + 0.5;
      const visit = next => { if (!visited[next] && isLeg(data[next])) {visited[next] = 1; queue[end++] = next;} };
      if (x) visit(at - 1); if (x + 1 < width) visit(at + 1);
      if (y) visit(at - width); if (y + 1 < height) visit(at + width);
    }
    const chains = sides.filter(groups => groups.every(g => g.n >= Math.max(3, width * height * 0.0001)))
      .map(groups => groups.map(g => ({x: g.x / g.n / width, y: g.y / g.n / height})));
    if (chains.length) regions.push({left: left / width, right: (right + 1) / width, top: top / height,
      bottom: (bottom + 1) / height, chains});
  }
  return regions;
}
function matchingLeg(legs, body, box, width, height) {
  const dl = box.originX / width, dt = box.originY / height, dr = dl + box.width / width, db = dt + box.height / height;
  return legs.findIndex(leg => {
    const bottom = body.top + body.height;
    if (leg.top < body.y || leg.top > bottom + Math.max(0.02, body.height * 0.15) ||
      leg.bottom - leg.top < Math.max(body.height * 0.55, box.height / height * 0.25)) return false;
    return leg.chains.some(([upper, lower, foot]) =>
      upper.y > body.y && lower.y > upper.y + body.height * 0.05 && foot.y > lower.y + body.height * 0.05 &&
      Math.abs(upper.x - body.x) <= body.width * 0.75 + 0.025 && foot.y > bottom + body.height * 0.4 &&
      [upper, lower, foot].every(p => p.x >= dl - 0.02 && p.x <= dr + 0.02 && p.y >= dt && p.y <= db + 0.02));
  });
}

export function verifyBodies(detections, parts, width, height, mode = 'torso') {
  const regions = torsoRegions(parts), legs = mode === 'legs' ? legRegions(parts) : [], candidates = [];
  if (width > 0 && height > 0) detections.forEach((d, di) => {
    const b = d.box;
    if (!b || ![b.originX, b.originY, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height < b.width * 0.65) return;
    const dl = b.originX / width, dt = b.originY / height;
    const dw = b.width / width, dh = b.height / height;
    regions.forEach((body, ri) => {
      if (body.height < dh * 0.20 || body.y > dt + dh * 0.8) return;
      const overlapW = Math.max(0, Math.min(dl + dw, body.left + body.width) - Math.max(dl, body.left));
      const overlapH = Math.max(0, Math.min(dt + dh, body.top + body.height) - Math.max(dt, body.top));
      if (overlapW * overlapH < body.width * body.height * 0.65 ||
        body.pixels / body.pixelArea < dw * dh * 0.03) return;
      const legIndex = mode === 'legs' ? matchingLeg(legs, body, b, width, height) : -1;
      if (mode === 'legs' && legIndex < 0) return;
      candidates.push({ di, ri, body, legIndex, distance: Math.hypot(body.x - d.x, body.y - d.y) });
    });
  });
  candidates.sort((a, b) => a.distance - b.distance);
  const usedDetections = new Set(), usedRegions = new Set(), usedLegs = new Set(), matches = new Map();
  for (const c of candidates) {
    if (usedDetections.has(c.di) || usedRegions.has(c.ri) || (c.legIndex >= 0 && usedLegs.has(c.legIndex))) continue;
    usedDetections.add(c.di); usedRegions.add(c.ri); usedLegs.add(c.legIndex); matches.set(c.di, c);
  }
  const annotated = detections.map((d, i) => {
    const match = matches.get(i), body = match?.body;
    return body ? { ...d, x: body.x, y: body.y, body, legs: match.legIndex >= 0 ? legs[match.legIndex] : null,
      legVerified: match.legIndex >= 0, bodyVerified: true } : { ...d, bodyVerified: false, legVerified: false };
  });
  return { annotated, accepted: annotated.filter(d => d.bodyVerified) };
}
