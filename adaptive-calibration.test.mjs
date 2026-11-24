import test from 'node:test';
import assert from 'node:assert/strict';
import {createCalibration, chooseRuntimeProfile, restoreProfileState, updateProfileState}
  from './reception-app/public/people-counter/adaptive-calibration.mjs';

const cases = {single:1, reverse:0, group:2};
function addTrials(calibration, profile, phase, {observed = cases, inferenceMs = [175,181,190], fps = 5} = {}) {
  for (const [kind, expected] of Object.entries(cases)) {
    const id = [profile, phase, kind].join(':');
    assert.equal(calibration.addEpisode({id, profile, phase, kind, expected, actual:observed[kind], inferenceMs, fps}),true);
  }
}

test('count errors cannot cancel across independent episodes, and accuracy outranks speed', () => {
  const calibration = createCalibration();
  addTrials(calibration,'baseline','train',{observed:{single:2,reverse:0,group:1},inferenceMs:[50,60,60],fps:9});
  addTrials(calibration,'detail','train');
  assert.equal(calibration.summary('baseline','train').missed,1);
  assert.equal(calibration.summary('baseline','train').extra,1);
  assert.equal(calibration.summary('baseline','train').incorrectEpisodes,2);
  assert.equal(calibration.recommend().profile,'detail');
});

test('recommendation requires baseline coverage and favors the baseline on ties', () => {
  const calibration = createCalibration();
  addTrials(calibration,'lighting','train');
  assert.equal(calibration.recommend(),null);
  addTrials(calibration,'baseline','train');
  assert.equal(calibration.recommend().profile,'baseline');
});

test('each profile must independently pass a complete, newly observed holdout', () => {
  const calibration = createCalibration();
  addTrials(calibration,'detail','train');
  assert.equal(calibration.approved('detail'),false);
  const sample = {profile:'detail',phase:'holdout',kind:'single',expected:1,actual:1,inferenceMs:[200,210,220],fps:4};
  assert.equal(calibration.addEpisode({...sample,id:'detail:train:single'}),false);
  addTrials(calibration,'detail','holdout');
  assert.equal(calibration.approved('detail'),true);
  assert.equal(calibration.approved('baseline'),false);
  assert.equal(calibration.addEpisode({...sample,phase:'train',id:'more-training'}),false);
});

test('one reverse false count or inadequate throughput prevents approval even when another episode makes totals match', () => {
  const calibration = createCalibration();
  for (const profile of ['baseline','detail','lighting']) addTrials(calibration,profile,'train');
  addTrials(calibration,'baseline','holdout',{observed:{single:1,reverse:1,group:1}});
  addTrials(calibration,'detail','holdout',{inferenceMs:[400,925,1300]});
  addTrials(calibration,'lighting','holdout',{fps:.5});
  for (const profile of ['baseline','detail','lighting']) assert.equal(calibration.approved(profile),false);
  const baseline = calibration.summary('baseline','holdout');
  assert.equal(baseline.reverseExtra,1);
  assert.equal(baseline.missed,1);
  assert.equal(baseline.extra,1);
  assert.equal(calibration.summary('detail','holdout').p95Ms,1300);
});

test('an exact holdout does not erase a reverse false count seen during training', () => {
  const calibration = createCalibration();
  addTrials(calibration,'baseline','train',{observed:{...cases,reverse:1}});
  addTrials(calibration,'baseline','holdout');
  assert.equal(calibration.recommend(),null);
  assert.equal(calibration.approved('baseline'),false);
});

test('unsupported and malformed episodes are rejected and trial memory is bounded', () => {
  const calibration = createCalibration();
  const sample = {profile:'baseline',phase:'train',kind:'reverse',expected:0,actual:0,inferenceMs:[1,2,3],fps:4};
  assert.equal(calibration.addEpisode({...sample,id:0,expected:1}),false);
  assert.equal(calibration.addEpisode({...sample,id:0,profile:'custom'}),false);
  assert.equal(calibration.addEpisode({...sample,id:0,inferenceMs:[Infinity]}),false);
  for (let id=0; id<12; id++) assert.equal(calibration.addEpisode({...sample,id}),true);
  assert.equal(calibration.addEpisode({...sample,id:12}),false);
  assert.equal(calibration.summary('baseline','train').episodes,12);
  assert.equal(calibration.recommend(),null);
});

test('runtime switches only between locally verified settings and respects cooldown, idle state and pin', () => {
  const initial = restoreProfileState();
  const baseline = updateProfileState(initial,{type:'approve',profile:'baseline',now:1,approved:true});
  assert.equal(updateProfileState(baseline,{type:'approve',profile:'detail',now:2,approved:false}),baseline);
  const detail = updateProfileState(baseline,{type:'approve',profile:'detail',now:500,approved:true});
  const automatic = updateProfileState(detail,{type:'automatic',enabled:true,now:1000});
  assert.equal(chooseRuntimeProfile(automatic,{preferred:'baseline',idle:true,now:30000}),'detail');
  assert.equal(chooseRuntimeProfile(automatic,{preferred:'baseline',idle:false,now:60000}),'detail');
  assert.equal(chooseRuntimeProfile(automatic,{preferred:'lighting',idle:true,now:60000}),'detail');
  const pinned = updateProfileState(automatic,{type:'pin',enabled:true,now:60000});
  assert.equal(chooseRuntimeProfile(pinned,{preferred:'baseline',idle:true,now:90000}),'detail');
  const released = updateProfileState(pinned,{type:'pin',enabled:false,now:90000});
  const adapted = updateProfileState(released,{type:'adapt',profile:'baseline',idle:true,now:90000});
  assert.equal(adapted.active,'baseline');
  assert.equal(adapted.previous,'detail');
  assert.equal(adapted.lastVerified,'detail');
});

test('manual rollback and restore work even when the initial baseline lacks local verification', () => {
  const initial = restoreProfileState({automatic:true});
  const detail = updateProfileState(initial,{type:'approve',profile:'detail',now:1000,approved:true});
  assert.equal(chooseRuntimeProfile(detail,{preferred:'baseline',idle:true,now:99000}),'detail');
  const rollback = updateProfileState(detail,{type:'rollback',now:99000});
  assert.equal(rollback.active,'baseline');
  const restored = updateProfileState(rollback,{type:'restore',now:100000});
  assert.equal(restored.active,'detail');
  assert.deepEqual(restored.history.map(row=>row.type),['approve','rollback','restore']);
});

test('restoration discards invalid settings and history retains only bounded configuration metadata', () => {
  const corrupt = restoreProfileState({active:'detail',verified:{includes:1},history:[null,{at:1,from:'baseline',to:'detail',type:'external'}]});
  assert.equal(corrupt.active,'baseline');
  assert.deepEqual(corrupt.history,[]);
  let state = restoreProfileState();
  for (let i=0; i<30; i++) state = updateProfileState(state,{type:'pin',now:i,enabled:!(i%2),aFace:'discard'});
  assert.equal(state.history.length,20);
  const saved = structuredClone(state);
  saved.history[0].extra = 'discard';
  assert.deepEqual(restoreProfileState(saved),state);
});
