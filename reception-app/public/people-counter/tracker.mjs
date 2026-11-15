/**
 * Two-line people counter. Coordinates are normalized [0,1] inside the video.
 * A single moving detection must cross A and then B in the selected direction.
 * No face recognition, persistent person IDs, or video recording.
 */
export class LineTracker {
  constructor(onCount = () => {}) {
    this.onCount = onCount;
    this.configure({ axis: "x", direction: 1, first: 0.40, second: 0.60 });
  }

  configure({ axis = "x", direction = 1, first = 0.40, second = 0.60 } = {}) {
    if (!["x", "y"].includes(axis) || ![1, -1].includes(direction) ||
      first < 0.10 || second > 0.90 || second - first < 0.10) {
      throw new Error("計測ラインの設定が不正です。");
    }
    this.axis = axis;
    this.direction = direction;
    this.first = first;
    this.second = second;
    this.reset();
  }

  reset() {
    this.tracks = [];
    this.nextId = 1;
  }

  position(point) {
    const value = this.axis === "x" ? point.x : point.y;
    return this.direction === 1 ? value : 1 - value;
  }

  // points: [{x, y, w?, h?}] all normalized to 0..1.
  update(points, timeMs) {
    const now = Number.isFinite(timeMs) ? timeMs : Date.now();
    const recent = this.tracks.filter(track => now - track.lastSeen <= 1400);
    const candidates = [];
    recent.forEach((track, ti) => {
      points.forEach((point, pi) => {
        const dx = track.x - point.x;
        const dy = track.y - point.y;
        const distance = Math.hypot(dx, dy);
        const allowance = 0.13 + Math.min(0.12, Math.max(0, now - track.lastSeen) / 5000);
        if (distance <= allowance) candidates.push({ ti, pi, distance });
      });
    });
    candidates.sort((a, b) => a.distance - b.distance);
    const claimedTracks = new Set();
    const claimedPoints = new Set();
    for (const candidate of candidates) {
      if (claimedTracks.has(candidate.ti) || claimedPoints.has(candidate.pi)) continue;
      claimedTracks.add(candidate.ti);
      claimedPoints.add(candidate.pi);
      const track = recent[candidate.ti];
      const point = points[candidate.pi];
      const previous = this.position(track);
      const current = this.position(point);
      if (!track.counted) {
        if (previous < this.first && current >= this.first) {
          track.armedAt = now;
        }
        if (current < this.first - 0.035) track.armedAt = null;
        if (track.armedAt !== null && now - track.armedAt <= 12000 &&
            previous < this.second && current >= this.second) {
          track.counted = true;
          track.armedAt = null;
          this.onCount({ trackId: track.id, at: now });
        }
        if (track.armedAt !== null && now - track.armedAt > 12000) {
          track.armedAt = null;
        }
      }
      track.x = point.x;
      track.y = point.y;
      track.lastSeen = now;
      track.w = point.w || 0;
      track.h = point.h || 0;
    }
    points.forEach((point, index) => {
      if (claimedPoints.has(index)) return;
      recent.push({
        id: this.nextId++, x: point.x, y: point.y,
        w: point.w || 0, h: point.h || 0,
        lastSeen: now, counted: false, armedAt: null,
      });
    });
    this.tracks = recent;
    return this.tracks;
  }

  // Normalized visual position of a line, accounting for a reversed direction.
  lineAt(value) {
    return this.direction === 1 ? value : 1 - value;
  }
}
