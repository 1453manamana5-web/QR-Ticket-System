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

export function verifyBodies(detections, parts, width, height) {
  const regions = torsoRegions(parts), candidates = [];
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
      candidates.push({ di, ri, body, distance: Math.hypot(body.x - d.x, body.y - d.y) });
    });
  });
  candidates.sort((a, b) => a.distance - b.distance);
  const usedDetections = new Set(), usedRegions = new Set(), matches = new Map();
  for (const c of candidates) {
    if (usedDetections.has(c.di) || usedRegions.has(c.ri)) continue;
    usedDetections.add(c.di); usedRegions.add(c.ri); matches.set(c.di, c.body);
  }
  const annotated = detections.map((d, i) => {
    const body = matches.get(i);
    return body ? { ...d, x: body.x, y: body.y, body, bodyVerified: true } : { ...d, bodyVerified: false };
  });
  return { annotated, accepted: annotated.filter(d => d.bodyVerified) };
}
