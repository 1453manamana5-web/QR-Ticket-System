/** Two-line, short-lived tracking. No face recognition or persistent identity. */
export class LineTracker {
  constructor(onCount = () => {}) {
    this.onCount = onCount;
    this.configure();
  }

  configure({ axis = 'x', direction = 1, first = 0.40, second = 0.60,
    minHits = 2, minMeanScore = 0.45 } = {}) {
    if (!['x', 'y'].includes(axis) || ![1, -1].includes(direction) ||
      ![first, second, minHits, minMeanScore].every(Number.isFinite) ||
      first < 0.10 || second > 0.90 || second - first < 0.10 - 1e-9 ||
      minHits < 2 || minMeanScore < 0 || minMeanScore > 1) {
      throw new Error('計測ラインの設定が不正です。');
    }
    Object.assign(this, { axis, direction, first, second, minHits, minMeanScore });
    this.reset();
  }

  reset() { this.tracks = []; this.nextId = 1; this.lastUpdate = null; this.frameInterval = null; }

  position(point) {
    const value = point[this.axis];
    return this.direction === 1 ? value : 1 - value;
  }

  update(points, timeMs) {
    const now = Number.isFinite(timeMs) ? timeMs : Date.now();
    points = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    // After a long interruption, do not join a new visitor to an old track.
    const maxGap = this.frameInterval === null ? 1250 : Math.min(3000, Math.max(1000, this.frameInterval * 2.1));
    const recent = this.tracks.filter(t => now >= t.lastSeen && now - t.lastSeen <= maxGap);
    if (this.lastUpdate !== null) {
      const elapsed = now - this.lastUpdate;
      if (elapsed > 0 && elapsed <= 1500) this.frameInterval = this.frameInterval === null
        ? elapsed : this.frameInterval * 0.5 + elapsed * 0.5;
    }
    this.lastUpdate = now;
    const candidates = [];
    recent.forEach((track, ti) => {
      const dt = now - track.lastSeen;
      const horizon = Math.min(dt, 450);
      const predicted = { x: track.x + track.vx * horizon, y: track.y + track.vy * horizon };
      points.forEach((point, pi) => {
        const predictedDistance = Math.hypot(predicted.x - point.x, predicted.y - point.y);
        const rawDistance = Math.hypot(track.x - point.x, track.y - point.y);
        if (track.counted && this.position(point) < this.first) return;
        const along = Math.abs(point[this.axis] - track[this.axis]);
        const across = Math.abs(point[this.axis === 'x' ? 'y' : 'x'] - track[this.axis === 'x' ? 'y' : 'x']);
        // A wider gate only along the selected walking direction. Keep separate
        // lanes and similarly-sized neighbouring people from stealing a track.
        const allowance = Math.min(0.42, 0.22 + dt / 1800);
        const crossAllowance = Math.min(0.18, 0.09 + dt / 10000);
        const sizeRatio = track.w && point.w ? Math.max(track.w / point.w, point.w / track.w) : 1;
        if (across > crossAllowance || sizeRatio > 3 ||
          (predictedDistance > allowance && along > allowance) || rawDistance > 0.55) return;
        candidates.push({ ti, pi, distance: predictedDistance * 0.8 + rawDistance * 0.2 + Math.log(sizeRatio) * 0.025 });
      });
    });
    candidates.sort((a, b) => a.distance - b.distance);
    const claimedTracks = new Set(), claimedPoints = new Set();
    for (const candidate of candidates) {
      if (claimedTracks.has(candidate.ti) || claimedPoints.has(candidate.pi)) continue;
      claimedTracks.add(candidate.ti); claimedPoints.add(candidate.pi);
      const track = recent[candidate.ti], point = points[candidate.pi];
      const previous = this.position(track), current = this.position(point);
      const dt = Math.max(1, now - track.lastSeen);
      track.hits++;
      track.streak = (track.streak || 0) + 1;
      if (track.streak >= 2) track.continuousEvidence = true;
      track.scoreSum += point.score ?? 1;
      if (!track.counted) {
        if (previous < this.first && current >= this.first) track.armedAt = now;
        if (current < this.first - 0.035) { track.armedAt = null; track.pending = false; }
        if (track.armedAt !== null && now - track.armedAt > 12000) {
          track.armedAt = null; track.pending = false;
        }
        if (track.armedAt !== null && previous < this.second && current >= this.second) track.pending = true;
        // A fast crossing may reach B on its second observation. Confirm on a
        // subsequent frame without losing the completed crossing or counting twice.
        if (track.pending && current >= this.second && track.hits >= this.minHits && track.continuousEvidence &&
          track.scoreSum / track.hits >= this.minMeanScore) {
          track.counted = true; track.armedAt = null; track.pending = false;
          this.onCount({ trackId: track.id, at: now });
        }
      }
      track.vx = track.vx * 0.35 + ((point.x - track.x) / dt) * 0.65;
      track.vy = track.vy * 0.35 + ((point.y - track.y) / dt) * 0.65;
      Object.assign(track, { x: point.x, y: point.y, w: point.w || 0, h: point.h || 0, lastSeen: now });
    }
    recent.forEach((track, ti) => { if (!claimedTracks.has(ti)) track.streak = 0; });
    points.forEach((point, pi) => {
      if (claimedPoints.has(pi)) return;
      recent.push({ id: this.nextId++, x: point.x, y: point.y, w: point.w || 0, h: point.h || 0,
        vx: 0, vy: 0, hits: 1, streak: 1, scoreSum: point.score ?? 1, lastSeen: now,
        continuousEvidence: false, counted: false, armedAt: null, pending: false });
    });
    this.tracks = recent;
    return recent;
  }

  lineAt(value) { return this.direction === 1 ? value : 1 - value; }
}
