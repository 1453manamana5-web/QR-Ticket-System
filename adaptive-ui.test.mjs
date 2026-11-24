import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as calibration from './reception-app/public/people-counter/adaptive-calibration.mjs';
import {EnvironmentMonitor} from './reception-app/public/people-counter/adaptive-environment.mjs';

const source = readFileSync(new URL('./reception-app/public/people-counter/adaptive-ui.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '');

function setup({stored = null, luma = 90} = {}) {
  const elements = new Map();
  const values = [];
  let current = {running:true, trial:false, geometry:true, role:true};
  let now = 0, wall = 60000, uuid = 0, resets = 0;
  const status = () => current;
  const createElement = () => ({
    textContent:'', checked:false, value:'2',
    addEventListener(type, listener) { this[type] = listener; },
  });
  const element = id => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  };
  const window = {};
  const context = {window, document:{getElementById:element}, EnvironmentMonitor, ...calibration,
    crypto:{randomUUID:() => 'private-test-id-' + ++uuid},
    Date:class extends Date { static now() { return wall; } },
    localStorage:{
      getItem:() => stored && JSON.stringify(stored),
      setItem(_, value) { values.push(JSON.parse(value)); },
    }};
  vm.runInNewContext(source, context);
  const api = window.counterAdaptive;
  api.attach({status, reset:() => {resets++;}, controls() {}});
  api.setup('test-geometry');
  const pixels = {
    width:48, height:32,
    data:new Uint8ClampedArray(48 * 32 * 4).fill(luma),
  };
  return {
    api, element, values,
    status(patch) { current = {...current, ...patch}; api.render(); },
    resets:() => resets,
    frame({inferenceMs = 155, reverseSeen = false, ...crowd} = {}) {
      now += 250;
      wall += 250;
      const stats = {fps:4, total:0, candidates:0, verified:0, trackCount:0, bodyRan:false, ...crowd};
      api.frame({now, inferenceMs, reverseSeen, pixels:api.due(now) ? pixels : null, stats:() => stats});
    },
  };
}

test('real assistant validates separate episodes before saving only the chosen profile state', () => {
  const h = setup();
  h.frame();
  assert.match(h.element('adaptiveMetrics').textContent, /155ms/);
  h.element('adaptiveStart').click();
  assert.equal(h.api.isolated(),true);

  let rounds = 0, sawTrain = false, sawHoldout = false;
  while (!h.element('adaptiveBegin').disabled) {
    assert.ok(++rounds <= 24, 'assistant advances through a bounded number of episodes');
    const instruction = h.element('adaptiveInstructions').textContent;
    const training = instruction.includes('比較用試験');
    sawTrain ||= training;
    sawHoldout ||= instruction.includes('別の通過で再検証');
    const reverseSeen = instruction.includes('逆方向に1人');
    const group = instruction.includes('正方向に2人');
    const baseline = instruction.includes('従来設定');
    h.element('adaptiveBegin').click();
    const counted = instruction.includes('正方向に1人') ? 1 : group ? (baseline && training ? 1 : 2) : 0;
    for (let n = 0; n < counted; n++) h.api.count();
    for (let n = 0; n < 8; n++) h.frame({inferenceMs:instruction.includes('暗部補助') ? 270 : 155, reverseSeen});
    h.element('adaptiveFinish').click();
    assert.equal(h.values.length,0, 'trial samples and results are still only in memory');
  }

  assert.ok(sawTrain && sawHoldout);
  assert.equal(h.element('adaptiveAccept').disabled,false);
  assert.doesNotMatch(h.element('adaptiveResult').textContent, /NaN/);
  assert.match(h.element('adaptiveInstructions').textContent, /細部優先/);
  h.element('adaptiveAccept').click();
  assert.equal(h.api.isolated(),false);
  const last = h.values.at(-1);
  assert.equal(last.state.active,'detail');
  assert.deepEqual(last.state.verified,['baseline','detail']);
  assert.ok(h.values.every(value => {
    const string = JSON.stringify(value);
    return !/(private-test-id|reverse|samples|measurements|pixels|episodes|trackId)/.test(string);
  }));
  h.api.setup('changed-doorway');
  assert.equal(h.api.engine().width,640);
  assert.match(h.element('adaptiveState').textContent,/未検証/);
});

test('an interrupted trial is discarded without any written calibration data', () => {
  const h = setup();
  h.element('adaptiveStart').click();
  h.element('adaptiveBegin').click();
  h.api.count();
  h.frame();
  h.status({running:false});
  h.api.stopped();
  assert.equal(h.api.isolated(),true);
  assert.equal(h.element('adaptiveFinish').disabled,true);
  assert.match(h.element('adaptiveNotice').textContent, /破棄/);
  h.status({running:true});
  assert.match(h.element('adaptiveInstructions').textContent,/1\//);
  h.element('adaptiveCancel').click();
  assert.equal(h.api.isolated(),false);
  assert.deepEqual(h.values,[]);
});

test('runtime overload retains the profile during tracked passages and falls back only after an idle boundary', () => {
  const h = setup({stored:{scope:'test-geometry',state:{
    active:'detail', previous:'baseline', verified:['baseline','detail'], automatic:true, lastSwitchAt:1000,
  }}});
  const resetsBefore = h.resets();
  for (let n = 0; n < 10; n++) h.frame({inferenceMs:820, candidates:2, verified:2, trackCount:2});
  assert.equal(h.api.engine().width,736);
  assert.deepEqual(h.values,[]);
  assert.equal(h.resets(),resetsBefore);
  for (let n = 0; n < 8; n++) h.frame({inferenceMs:820});
  assert.equal(h.api.engine().width,640);
  assert.equal(h.values.at(-1).state.history.at(-1).type,'adapt');
  assert.equal(h.values.at(-1).state.previous,'detail');
  assert.equal(h.resets(),resetsBefore + 1);
});

test('a zero count without an observed reverse crossing cannot complete a reverse trial', () => {
  const h = setup();
  h.element('adaptiveStart').click();
  h.element('adaptiveBegin').click();
  h.api.count();
  for (let n = 0; n < 8; n++) h.frame();
  h.element('adaptiveFinish').click();
  assert.match(h.element('adaptiveInstructions').textContent,/逆方向に1人/);
  h.element('adaptiveBegin').click();
  for (let n = 0; n < 8; n++) h.frame();
  h.element('adaptiveFinish').click();
  assert.match(h.element('adaptiveInstructions').textContent,/逆方向に1人/);
  assert.deepEqual(h.values,[]);
});

test('turning automatic selection on or pinning the current profile leaves active tracking intact', () => {
  const h = setup();
  const before = h.resets();
  const automatic = h.element('adaptiveAuto'), pin = h.element('adaptivePin');
  automatic.checked = true;
  automatic.change({target:automatic});
  pin.checked = true;
  pin.change({target:pin});
  assert.equal(h.resets(),before);
  assert.equal(h.values.at(-1).state.automatic,true);
  assert.equal(h.values.at(-1).state.pinned,true);
  assert.equal(h.values.at(-1).state.active,'baseline');
});

test('startup keeps an already verified lighting profile in darkness while diagnostics stabilizes', () => {
  const h = setup({luma:35,stored:{scope:'test-geometry',validatedLighting:true,state:{
    active:'lighting', previous:'baseline', verified:['baseline','lighting'], automatic:true, lastSwitchAt:1000,
  }}});
  for (let n = 0; n < 10; n++) h.frame();
  assert.equal(h.api.engine().lighting,true);
  assert.deepEqual(h.values,[]);
});
