import assert from "node:assert/strict";
import test from "node:test";
import {pairingCode,sameStationScope} from "./reception-app/public/people-counter/station-command.mjs";

test("station codes retain leading zeroes and discard biased random draws", () => {
  const sequence=[4294967295,12];
  assert.equal(pairingCode({getRandomValues(values){values[0]=sequence.shift();}}),"000012");
  assert.equal(sequence.length,0);
});

test("remote command matches the particular role, device, mode, config and assignment", () => {
  const epoch={isEqual: other=>other===1};
  const command={device:"ipad",role:"in",mode:"live",configVersion:7,assignment:epoch};
  const station={device:"ipad",role:"in",updatedAt:1};
  assert.equal(sameStationScope(command,station,"live",7),true);
  assert.equal(sameStationScope(command,station,"test",7),false);
  assert.equal(sameStationScope(command,station,"live",6),false);
  for(const changed of [{role:"out"},{device:"other"},{updatedAt:2}]) {
    assert.equal(sameStationScope(command,{...station,...changed},"live",7),false);
  }
});
