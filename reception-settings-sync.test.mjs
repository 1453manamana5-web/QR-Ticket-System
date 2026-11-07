import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
const require=createRequire(import.meta.url),ts=require('typescript');
const settings={entryEnabled:true,exitEnabled:true,reentryEnabled:true};
const next={entryEnabled:false,exitEnabled:true,reentryEnabled:false};
const event={eventId:'settings-event',eventName:'Current name',eventDate:'2026-11-07',startTime:'09:00',endTime:'17:00',eventStatus:'active',dataVersion:5,authToken:'token-one',receptionTarget:true,ticketCount:12,inventoryRevision:8};
const eventPath='events/settings-event',settingsPath=eventPath+'/settings/reception',bundlePath='eventBundles/token-one';
const bundle={event:{...event,eventName:'Old published name'},settings:{...settings},authToken:'token-one',ticketCount:12,publishedAt:'before'};
function merge(a,b){for(const [key,value] of Object.entries(b)){a[key]=value&&typeof value==='object'&&!Array.isArray(value)?merge(a[key]&&typeof a[key]==='object'?a[key]:{},value):structuredClone(value);}return a;}
function harness(seed={},options={}){
  const docs=new Map(Object.entries({[eventPath]:event,[settingsPath]:settings,[bundlePath]:bundle,...seed}).filter(([,v])=>v!==null).map(([path,value])=>[path,structuredClone(value)]));
  const writes=[];let attempts=0;
  const snapshot=path=>({id:path.split('/').at(-1),ref:path,exists:()=>docs.has(path),data:()=>structuredClone(docs.get(path))});
  const list=path=>({docs:[...docs.keys()].filter(key=>key.startsWith(path+'/')&&!key.slice(path.length+1).includes('/')).map(snapshot)});
  const firestore={doc:(_db,...parts)=>parts.join('/'),collection:(_db,...parts)=>parts.join('/'),getDoc:async path=>snapshot(path),getDocFromServer:async path=>snapshot(path),getDocsFromServer:async path=>list(path),setDoc:async(path,value)=>{merge(docs.get(path)??{},value);docs.set(path,structuredClone(value));writes.push([path,value]);},
    runTransaction:async(_db,callback)=>{
      for(;;){
        attempts++;const pending=[];let writing=false;
        const result=await callback({get:async path=>{assert.equal(writing,false,'transaction reads precede every write');return snapshot(path);},set:(path,value,opts)=>{writing=true;pending.push({path,value:structuredClone(value),merge:opts?.merge});},update:(path,value)=>{writing=true;pending.push({path,value:structuredClone(value),merge:true});}});
        if(options.retry?.(docs,attempts))continue;
        if(options.failCommit)throw Error('SIMULATED_COMMIT_FAILURE');
        const committed=new Map([...docs].map(([path,value])=>[path,structuredClone(value)]));
        for(const item of pending){committed.set(item.path,item.merge?merge(committed.get(item.path)??{},item.value):item.value);}
        docs.clear();for(const [path,value] of committed)docs.set(path,value);
        writes.push(...pending.map(item=>[item.path,item.value]));return result;
      }
    }};
  const load=path=>{const out={};new Function('exports','require','navigator','crypto',ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out,name=>name==='firebase/firestore'?firestore:name==='./firebaseClient'?{getFirebaseDb:()=>({})}:name==='./operationSafety'?{receptionDataCollected:()=>true}:{},{onLine:true},{getRandomValues:value=>value.fill(1)});return out;};
  return{docs,writes,attempts:()=>attempts,manager:load('management-app/src/firebaseData.ts'),publisher:load('management-app/src/eventPublisher.ts')};
}

test('saving published reception settings updates canonical and public versions atomically',async()=>{
  const h=harness();await h.manager.saveReceptionSettings(event.eventId,next);
  assert.deepEqual(h.docs.get(settingsPath),next);
  assert.deepEqual(h.docs.get(bundlePath).settings,next);
  assert.equal(h.docs.get(eventPath).dataVersion,6);
  assert.equal(h.docs.get(bundlePath).event.dataVersion,6);
  for(const key of ['eventName','eventDate','startTime','endTime','eventStatus','authToken','receptionTarget','ticketCount','inventoryRevision'])assert.deepEqual(h.docs.get(eventPath)[key],event[key],key);
  assert.equal(h.docs.get(bundlePath).ticketCount,12);
});

test('unchanged settings produce no writes or repeated reception downloads',async()=>{
  const h=harness({[settingsPath]:{...settings,extraMetadata:'preserve'}});
  await h.manager.saveReceptionSettings(event.eventId,{...settings});
  assert.deepEqual(h.writes,[]);
  await h.manager.saveReceptionSettings(event.eventId,next);
  const changed=h.writes.length;
  for(let i=0;i<3;i++)await h.manager.saveReceptionSettings(event.eventId,{...next});
  assert.equal(h.writes.length,changed);assert.equal(h.docs.get(eventPath).dataVersion,6);
  assert.equal(h.docs.get(settingsPath).extraMetadata,'preserve');
});

test('repairing the private copy does not bump an already current public version',async()=>{
  const h=harness({[bundlePath]:{...bundle,settings:next}});
  await h.manager.saveReceptionSettings(event.eventId,next);
  assert.deepEqual(h.docs.get(settingsPath),next);assert.equal(h.docs.get(eventPath).dataVersion,5);
  assert.deepEqual(h.writes.map(([path])=>path),[settingsPath]);
});

test('a stale published copy is repaired even when the private settings already match',async()=>{
  const h=harness({[settingsPath]:next});await h.manager.saveReceptionSettings(event.eventId,next);
  assert.deepEqual(h.docs.get(bundlePath).settings,next);assert.equal(h.docs.get(eventPath).dataVersion,6);
});

test('unpublished settings remain private and do not recreate a deleted event',async()=>{
  const {authToken,...unpublished}=event;
  const h=harness({[eventPath]:{...unpublished,receptionTarget:false},[settingsPath]:null});
  await h.manager.saveReceptionSettings(event.eventId,next);
  assert.deepEqual(h.docs.get(eventPath),{...unpublished,receptionTarget:false});assert.deepEqual(h.docs.get(settingsPath),next);
  const deleted=harness({[eventPath]:null,[settingsPath]:null});
  await assert.rejects(deleted.manager.saveReceptionSettings(event.eventId,next),/EVENT_NOT_FOUND/);
  assert.equal(deleted.docs.has(settingsPath),false);
});

test('invalid settings or inconsistent published identity never partially overwrite configuration',async()=>{
  for(const input of [{...next,entryEnabled:'false'},{...next,exitEnabled:null},{...next,reentryEnabled:undefined}]){
    const h=harness();await assert.rejects(h.manager.saveReceptionSettings(event.eventId,input),/INVALID_RECEPTION_SETTINGS/);assert.deepEqual(h.writes,[]);
  }
  for(const savedBundle of [null,{...bundle,authToken:'other-token'},{...bundle,event:{...event,eventId:'another-event'}},{...bundle,event:{...event,dataVersion:4}}]){
    const h=harness({[bundlePath]:savedBundle});await assert.rejects(h.manager.saveReceptionSettings(event.eventId,next),/EVENT_BUNDLE/);assert.deepEqual(h.writes,[]);assert.deepEqual(h.docs.get(settingsPath),settings);
  }
});

test('a settings transaction retries against a rotated publication without rewinding inventory metadata',async()=>{
  const h=harness({}, {retry:(docs,attempt)=>{
    if(attempt!==1)return false;
    docs.set(eventPath,{...event,authToken:'token-two',dataVersion:9,ticketCount:20,inventoryRevision:19,eventStatus:'finalizing'});
    docs.set('eventBundles/token-two',{...bundle,authToken:'token-two',event:{...event,dataVersion:9},ticketCount:20});return true;
  }});
  await h.manager.saveReceptionSettings(event.eventId,next);
  assert.equal(h.attempts(),2);assert.equal(h.docs.get(eventPath).dataVersion,10);assert.equal(h.docs.get(eventPath).ticketCount,20);assert.equal(h.docs.get(eventPath).inventoryRevision,19);assert.equal(h.docs.get(eventPath).eventStatus,'finalizing');
  assert.deepEqual(h.docs.get(bundlePath),bundle);assert.deepEqual(h.docs.get('eventBundles/token-two').settings,next);assert.equal(h.docs.get('eventBundles/token-two').event.dataVersion,10);
});

test('an aborted settings transaction leaves all private and published state unchanged',async()=>{
  const h=harness({}, {failCommit:true});await assert.rejects(h.manager.saveReceptionSettings(event.eventId,next),/SIMULATED_COMMIT_FAILURE/);
  assert.deepEqual(h.docs.get(eventPath),event);assert.deepEqual(h.docs.get(settingsPath),settings);assert.deepEqual(h.docs.get(bundlePath),bundle);assert.deepEqual(h.writes,[]);
});

test('publishing settings also persists the private copy used after a management reload',async()=>{
  const h=harness();const result=await h.publisher.publishEventBundle(event,next,[]);
  assert.deepEqual(await h.manager.loadReceptionSettings(event.eventId),next);
  assert.deepEqual(h.docs.get('eventBundles/'+result.authToken).settings,next);
});

test('failed publication never saves settings ahead of the event and its public bundle',async()=>{
  const h=harness({}, {failCommit:true});await assert.rejects(h.publisher.publishEventBundle(event,next,[]),/SIMULATED_COMMIT_FAILURE/);
  assert.deepEqual(h.docs.get(settingsPath),settings);assert.deepEqual(h.docs.get(eventPath),event);assert.deepEqual(h.docs.get(bundlePath),bundle);assert.deepEqual(h.writes,[]);
});
