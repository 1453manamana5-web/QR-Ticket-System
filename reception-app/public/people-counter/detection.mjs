// Pure detection/coordinate helpers shared by the camera loop and regression tests.
export const PROFILES = Object.freeze({
  standard: { threshold: 0.45, minHits: 2, minMeanScore: 0.45, sampleMs: 170, anchorY: 0.5 },
  side: { threshold: 0.30, minHits: 3, minMeanScore: 0.34, sampleMs: 100, anchorY: 0.35 },
});

export function peopleFromResult(result, width, height, profile = 'side') {
  const options = PROFILES[profile] || PROFILES.side;
  if (!(width > 0 && height > 0)) return [];
  return (result.detections || []).flatMap(detection => {
    const score = Math.max(0, ...(detection.categories || [])
      .filter(c => c.categoryName?.toLowerCase() === 'person')
      .map(c => Number.isFinite(c.score) ? c.score : 0));
    const box = detection.boundingBox;
    if (score < options.threshold || !box ||
      ![box.originX, box.originY, box.width, box.height].every(Number.isFinite) ||
      box.width <= 0 || box.height <= 0) return [];
    const left = Math.max(0, box.originX), top = Math.max(0, box.originY);
    const right = Math.min(width, box.originX + box.width);
    const bottom = Math.min(height, box.originY + box.height);
    if (right <= left || bottom <= top) return [];
    return [{
      box: { originX: left, originY: top, width: right - left, height: bottom - top },
      // Anchor relative to the original detection: clipping feet at the image edge
      // should not pull the anchor towards the edge of the frame.
      x: Math.min(1, Math.max(0, (box.originX + box.width / 2) / width)),
      y: Math.min(1, Math.max(0, (box.originY + box.height * options.anchorY) / height)),
      verticalCrop: top === 0 || bottom === height,
      w: (right - left) / width, h: (bottom - top) / height, score,
    }];
  });
}
