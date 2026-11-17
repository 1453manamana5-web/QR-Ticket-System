// Low-cost QR region proposals, inspired by the detect -> track -> inspect flow
// used by the people counter. This module does NOT use a person detector.
export type ScanFocus = { x: number; y: number };
export type DetailedCrop = { x: number; y: number; size: number };

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/**
 * Find the center of a small moving region in a tiny video thumbnail.
 * This only proposes where to inspect; it never claims that motion is a QR.
 * Global camera movement/exposure changes and empty frames are ignored.
 */
export function findMotionFocus(
  previous: Uint8ClampedArray | null,
  current: Uint8ClampedArray,
  width: number,
  height: number
): ScanFocus | null {
  const total = width * height;
  if (!previous || width < 8 || height < 8 ||
      previous.length !== total * 4 || current.length !== total * 4) return null;
  let changed = 0, sumX = 0, sumY = 0;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const before = (previous[i] * 77 + previous[i + 1] * 150 + previous[i + 2] * 29) >> 8;
      const after = (current[i] * 77 + current[i + 1] * 150 + current[i + 2] * 29) >> 8;
      if (Math.abs(after - before) < 38) continue;
      changed++; sumX += x; sumY += y;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  if (changed < Math.max(10, total * 0.005) || changed > total * 0.32) return null;
  if (maxX - minX > width * 0.85 || maxY - minY > height * 0.85) return null;
  return { x: clamp((sumX / changed + 0.5) / width, 0, 1),
    y: clamp((sumY / changed + 0.5) / height, 0, 1) };
}

/**
 * Select a native-resolution crop rather than upscaling a blurry downsample.
 * Rotate through central and off-center positions, even when no motion is seen.
 */
export function chooseDetailedCrop(
  videoWidth: number, videoHeight: number, scanNumber: number,
  focus: ScanFocus | null
): DetailedCrop | null {
  if (!Number.isFinite(videoWidth) || !Number.isFinite(videoHeight) ||
      videoWidth < 1 || videoHeight < 1 ||
      Math.max(videoWidth, videoHeight) < 1100) return null;
  const size = Math.floor(Math.min(880, videoWidth, videoHeight));
  if (size < 400) return null;
  const locations: ScanFocus[] = [
    { x: 0.5, y: 0.5 }, { x: 0.17, y: 0.5 },
    { x: 0.83, y: 0.5 }, { x: 0.5, y: 0.18 },
    { x: 0.5, y: 0.82 }
  ];
  const index = Math.abs(Math.trunc(scanNumber)) % locations.length;
  // A tracked region receives priority periodically, but cannot monopolize scanning.
  const target = focus && index % 3 === 0 &&
    Number.isFinite(focus.x) && Number.isFinite(focus.y) ? focus : locations[index];
  return {
    x: Math.round(clamp(target.x * videoWidth - size / 2, 0, videoWidth - size)),
    y: Math.round(clamp(target.y * videoHeight - size / 2, 0, videoHeight - size)),
    size
  };
}

/** Occasional contrast rescue for faded/poorly illuminated printed tickets. */
export function boostQrContrast(image: ImageData): void {
  const data = image.data;
  const histogram = new Uint32Array(256);
  let sampled = 0;
  for (let i = 0; i < data.length; i += 32) {
    const intensity = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    histogram[intensity]++;
    sampled++;
  }
  if (!sampled) return;
  const lowerCount = sampled * 0.04, upperCount = sampled * 0.96;
  let cumulative = 0, low = 0, high = 255;
  for (let v = 0; v < 256; v++) {
    cumulative += histogram[v];
    if (cumulative >= lowerCount) { low = v; break; }
  }
  cumulative = 0;
  for (let v = 0; v < 256; v++) {
    cumulative += histogram[v];
    if (cumulative >= upperCount) { high = v; break; }
  }
  const range = high - low;
  if (range < 40 || range > 238) return;
  const factor = Math.min(1.7, 220 / range);
  const midpoint = (low + high) / 2;
  for (let i = 0; i < data.length; i += 4) {
    const intensity = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    const value = clamp(Math.round((intensity - midpoint) * factor + 128), 0, 255);
    data[i] = value; data[i + 1] = value; data[i + 2] = value;
  }
}
