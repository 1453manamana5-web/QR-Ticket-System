// A deliberately small search space. Calibration stores only short-lived,
// per-trial totals and processing metrics in memory.
export const CALIBRATION_PROFILES = Object.freeze(['baseline', 'detail', 'lighting']);
export const CALIBRATION_KINDS = Object.freeze(['single', 'reverse', 'group', 'idle']);
const phases = ['train', 'holdout'];
const requiredKinds = ['single', 'reverse', 'group'];
const actions = ['approve', 'automatic', 'pin', 'rollback', 'restore', 'adapt'];
const maxEpisodesPerPhase = 12;
const maxInferenceSamples = 64;
const maxHistory = 20;
export const PROFILE_SWITCH_COOLDOWN_MS = 30000;

const isProfile = value => CALIBRATION_PROFILES.includes(value);
const isTime = value => Number.isFinite(value) && value >= 0;

function percentile(values, fraction) {
  return values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
}

function validExpected(kind, value) {
  if (!Number.isSafeInteger(value)) return false;
  if (kind === 'single') return value === 1;
  if (kind === 'group') return value >= 2;
  return value === 0;
}

export function createCalibration({maxP95Ms = 1200, minFps = 1} = {}) {
  const episodes = [];
  const ids = new Set();
  function addEpisode({id, profile, phase, kind, expected, actual, inferenceMs, fps}) {
    if (!((typeof id === 'string' && id.length > 0 && id.length <= 80) ||
      (Number.isSafeInteger(id) && id >= 0)) ||
      ids.has(id) || !isProfile(profile) || !phases.includes(phase) || !CALIBRATION_KINDS.includes(kind) ||
      !validExpected(kind, expected) || !Number.isSafeInteger(actual) || actual < 0 ||
      !Array.isArray(inferenceMs) || !inferenceMs.length || !inferenceMs.every(isTime) ||
      !Number.isFinite(fps) || fps <= 0) return false;
    const sameProfile = episodes.filter(episode => episode.profile === profile && episode.phase === phase);
    if (sameProfile.length >= maxEpisodesPerPhase) return false;
    if (phase === 'holdout' && !summary(profile, 'train').complete) return false;
    if (phase === 'train' && episodes.some(episode => episode.profile === profile && episode.phase === 'holdout')) return false;
    episodes.push({profile, phase, kind, expected, actual, inferenceMs: inferenceMs.slice(-maxInferenceSamples), fps});
    ids.add(id);
    return true;
  }

  function summary(profile, phase) {
    const selected = episodes.filter(episode => episode.profile === profile && episode.phase === phase);
    const kinds = Object.fromEntries(CALIBRATION_KINDS.map(kind =>
      [kind, selected.filter(episode => episode.kind === kind).length]));
    const complete = requiredKinds.every(kind => kinds[kind] > 0);
    const durations = selected.flatMap(episode => episode.inferenceMs).sort((a, b) => a - b);
    const p50Ms = percentile(durations, 0.5), p95Ms = percentile(durations, 0.95);
    const minimumFps = selected.length ? Math.min(...selected.map(episode => episode.fps)) : null;
    let missed = 0, extra = 0, reverseExtra = 0, incorrectEpisodes = 0;
    for (const episode of selected) {
      const difference = episode.actual - episode.expected;
      if (difference < 0) missed -= difference;
      if (difference > 0) extra += difference;
      if (episode.kind === 'reverse') reverseExtra += episode.actual;
      if (difference !== 0) incorrectEpisodes++;
    }
    return {profile, phase, episodes: selected.length, kinds, complete, missed, extra, reverseExtra,
      incorrectEpisodes, p50Ms, p95Ms, minFps: minimumFps, withinBudget: complete &&
        selected.every(episode => episode.inferenceMs.length >= 3) &&
        p95Ms <= maxP95Ms && minimumFps >= minFps};
  }

  function recommend() {
    if (!summary('baseline', 'train').complete) return null;
    const comparisons = CALIBRATION_PROFILES.map(profile => summary(profile, 'train'))
      .filter(candidate => candidate.withinBudget && candidate.reverseExtra === 0)
      .sort((a, b) => (a.missed + a.extra) - (b.missed + b.extra) ||
        a.incorrectEpisodes - b.incorrectEpisodes ||
        Math.floor(b.minFps * 2) - Math.floor(a.minFps * 2) ||
        Math.floor(a.p95Ms / 50) - Math.floor(b.p95Ms / 50) ||
        CALIBRATION_PROFILES.indexOf(a.profile) - CALIBRATION_PROFILES.indexOf(b.profile));
    return comparisons[0] ?? null;
  }

  function approved(profile) {
    const train = summary(profile, 'train');
    const holdout = summary(profile, 'holdout');
    return train.withinBudget && train.reverseExtra === 0 && holdout.withinBudget && holdout.incorrectEpisodes === 0;
  }

  return {addEpisode, summary, recommend, approved};
}

export function restoreProfileState(saved) {
  const verified = Array.isArray(saved?.verified)
    ? CALIBRATION_PROFILES.filter(profile => saved.verified.includes(profile)) : [];
  const available = profile => profile === 'baseline' || verified.includes(profile);
  const active = available(saved?.active) ? saved.active : 'baseline';
  const previous = available(saved?.previous) ? saved.previous : 'baseline';
  const lastVerified = verified.includes(saved?.lastVerified) ? saved.lastVerified : null;
  const history = Array.isArray(saved?.history) ? saved.history.filter(record =>
    isTime(record?.at) && actions.includes(record.type) && isProfile(record.from) && isProfile(record.to))
    .slice(-maxHistory).map(({at, type, from, to, enabled}) => ({at, type, from, to,
      ...(typeof enabled === 'boolean' && ['automatic', 'pin'].includes(type) ? {enabled} : {})})) : [];
  return {active, previous, lastVerified, verified, automatic: saved?.automatic === true,
    pinned: saved?.pinned === true, lastSwitchAt: isTime(saved?.lastSwitchAt) ? saved.lastSwitchAt : 0, history};
}

export function chooseRuntimeProfile(state, {preferred, idle, now}) {
  if (!state.automatic || state.pinned || idle !== true || !isTime(now) ||
    now - state.lastSwitchAt < PROFILE_SWITCH_COOLDOWN_MS || !state.verified.includes(preferred)) {
    return state.active;
  }
  return preferred;
}

export function updateProfileState(state, {type, profile, now, approved, enabled, idle}) {
  if (!isTime(now) || !actions.includes(type)) return state;
  let next = state;
  if (type === 'approve' && isProfile(profile) && approved === true) {
    if (profile !== state.active || state.lastVerified !== profile || !state.verified.includes(profile)) {
      next = {...state, active: profile, lastVerified: profile,
        verified: [...new Set([...state.verified, profile])]};
    }
  } else if ((type === 'automatic' || type === 'pin') && typeof enabled === 'boolean') {
    const key = type === 'pin' ? 'pinned' : 'automatic';
    if (state[key] !== enabled) next = {...state, [key]: enabled};
  } else if (type === 'adapt') {
    const preferred = chooseRuntimeProfile(state, {preferred: profile, idle, now});
    if (preferred !== state.active) next = {...state, active: preferred};
  } else if (type === 'rollback' && state.previous !== state.active &&
    (state.previous === 'baseline' || state.verified.includes(state.previous))) {
    next = {...state, active: state.previous};
  } else if (type === 'restore' && state.lastVerified !== state.active && state.verified.includes(state.lastVerified)) {
    next = {...state, active: state.lastVerified};
  }
  if (next === state) return state;
  if (next.active !== state.active) {
    next.previous = state.active;
    next.lastSwitchAt = now;
  }
  next.history = [...state.history, {at: now, type, from: state.active, to: next.active,
    ...(type === 'automatic' || type === 'pin' ? {enabled} : {})}].slice(-maxHistory);
  return next;
}
