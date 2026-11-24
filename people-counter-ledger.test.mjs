import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {openRecordStore} from './reception-app/public/people-counter/records.mjs';
import {analyze, reconcile, estimateClock, csv, uploadPending} from './reception-app/public/people-counter/ledger.mjs';

const config = {eventId:'festival',mode:'live',opened:0,closed:180000,now:200000,verified:true};
const passage = (id, at, direction, extra = {}) => ({
  id, eventId:'festival', mode:'live', kind:'passage', at, rawAt:at, direction,
  person:'visitor', device:direction, synced:true, ...extra,
});

test('out-of-order cross-device times agree by both formulas without pairing; trials and staff are excluded', () => {
  const rows = [passage('d',180000,'out'),passage('b',60000,'in'),passage('c',120000,'out'),passage('a',0,'in'),
    passage('test',80000,'in',{mode:'test'}), passage('staff',70000,'in',{person:'staff'})];
  const result = analyze(rows,config);
  assert.equal(result.sumAverage,120000);
  assert.equal(result.integralAverage,120000);
  assert.equal(result.area,240000);
  assert.equal(result.entries,2);
  assert.equal(result.occupancy,0);
});
test('open visits contribute accumulated time and are neither mismatch nor a finished average', () => {
  const rows = [passage('a',0,'in')];
  const result = analyze(rows,{...config,closed:null});
  assert.equal(result.area,200000);
  assert.equal(result.occupancy,1);
  assert.equal(result.sumAverage,null);
  assert.equal(result.estimate,null);
  assert.deepEqual(result.issues,[]);
  assert.equal(analyze(rows,config).issues[0].code,'閉場時の入退場数不一致');
});
test('occupancy remains negative on missing entry, and the average is suppressed', () => {
  const result = analyze([passage('a',0,'out'),passage('b',60000,'in')],config);
  assert.equal(result.timeline[0].occupancy,-1);
  assert.equal(result.sumAverage,null);
});
test('edits recompute average, conflicts preserve branches, and resolution produces an auditable result', () => {
  const rows = [passage('a',0,'in'),passage('b',120000,'out')];
  const edit = (id, at, extra) => ({...passage(id,140000,'out'),kind:'revision',target:'b',parent:'b',after:{at},...extra});
  rows.push(edit('e1',60000));
  assert.equal(analyze(rows,config).integralAverage,60000);
  rows.push(edit('e2',90000));
  assert.equal(analyze(rows,config).sumAverage,null);
  assert.equal(reconcile(rows,'festival','live').issues[0].code,'修正競合');
  rows.push(edit('e3',120000,{resolves:['e1','e2']}));
  assert.equal(analyze(rows,config).sumAverage,120000);
});
test('clock correction includes round-trip error and rejects wall clock jumps; CSV has BOM and formula protection', () => {
  assert.deepEqual(estimateClock(1000,1200,1600,200),{offset:500,uncertainty:100,measured:1200});
  assert.throws(() => estimateClock(1000,4000,3000,100));
  assert.equal(csv([['人数',' =1',-2]]),'\uFEFF"人数","\' =1","-2"');
});
test('offline records persist, upload resumes after failures, and events captured in flight remain pending', async () => {
  const indexedDB = new IDBFactory();
  const store = await openRecordStore({indexedDB,uuid:()=>crypto.randomUUID()});
  const add = () => store.append({delta:1,type:'manual',expectedSession:store.initial.session,
    passage:{eventId:'festival',mode:'live',device:'entrance',rawAt:100,at:100,direction:'in',person:'visitor'}});
  await add();
  const snapshot = await store.ledger();
  await assert.rejects(uploadPending(store,snapshot,'festival','live',async () => {throw new Error('offline');}));
  assert.equal((await store.ledger())[0].synced,false);
  const remote = new Map();
  await uploadPending(store,snapshot,'festival','live',async (_,__,batch) => {
    await add();
    for (const row of batch) remote.set(row.id,row);
  });
  await store.mergeLedger([...remote.values()]);
  store.close();
  const reopened = await openRecordStore({indexedDB,uuid:()=>crypto.randomUUID()});
  const rows = await reopened.ledger();
  assert.equal(rows.length,2);
  assert.equal(rows.filter(r => !r.synced).length,1);
  assert.deepEqual(rows.map(r => r.sequence).sort(),[1,2]);
  await assert.rejects(reopened.mergeLedger([{...snapshot[0],direction:'out'}]));
  reopened.close();
});

test('a large queue drains in bounded batches after intermittent disconnects without deleting local history', async () => {
  const store = await openRecordStore({indexedDB:new IDBFactory()});
  const records = Array.from({length:61},(_,i)=>passage('bulk-'+i,i,'in',{synced:false}));
  for (const row of records) await store.addLedger(row);
  const server = new Map();
  let calls = 0;
  const send = async (_,__,batch) => {
    assert.ok(batch.length <= 20);
    for (const row of batch) server.set(row.id,row);
    if (++calls === 2) throw Error('lost response after commit');
  };
  await assert.rejects(uploadPending(store,await store.ledger(),'festival','live',send));
  assert.equal((await store.ledger()).filter(r=>!r.synced).length,41);
  await uploadPending(store,await store.ledger(),'festival','live',send);
  assert.equal(server.size,61);
  assert.equal((await store.ledger()).filter(r=>r.synced).length,61);
  store.close();
});

test('a sequence gap, invalid time, and abandoned revision are surfaced without clamping', () => {
  const rows = [passage('a',0,'in',{sequence:1}),passage('b',60000,'in',{sequence:3}),
    passage('z',300000,'out'),{...passage('lost',100,'in'),kind:'revision',target:'unknown'}];
  const result = analyze(rows,config);
  assert.ok(result.issues.some(i=>i.code.includes('連番')));
  assert.ok(result.issues.some(i=>i.code.includes('範囲外')));
  assert.ok(result.issues.some(i=>i.code.includes('元記録')));
  assert.equal(result.sumAverage,null);
});

test('service worker serves a warmed model and page after network loss, but does not intercept sync requests', async () => {
  const {readFileSync} = await import('node:fs');
  const {runInNewContext} = await import('node:vm');
  const handlers = {};
  const byCache = new Map();
  let online = true;
  const key = req => typeof req === 'string' ? req : req.url;
  const caches = {open: async name => {
    if (!byCache.has(name)) byCache.set(name,new Map());
    const entries = byCache.get(name);
    return {
      addAll: async urls => urls.forEach(url => entries.set(url,new Response('page'))),
      match: async req => entries.get(key(req))?.clone(),
      put: async (req,value) => {entries.set(key(req),value);},
    };
  }};
  runInNewContext(readFileSync(new URL('./reception-app/public/people-counter/counter-offline.js',import.meta.url),'utf8'),{
    URL,caches,fetch:async () => {if (!online) throw Error('offline'); return new Response('model');},
    self:{registration:{scope:'https://example.test/people-counter/'},addEventListener:(kind,handler)=>{handlers[kind]=handler;},skipWaiting(){}},
  });
  let setup;
  handlers.install({waitUntil:promise=>{setup=promise;}});
  await setup;
  const fetchFromWorker = (url, mode = 'cors') => {
    let result;
    handlers.fetch({request:{url,mode,method:'GET'},respondWith:promise=>{result=promise;}});
    return result;
  };
  const model = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';
  assert.equal(await (await fetchFromWorker(model)).text(),'model');
  online = false;
  assert.equal(await (await fetchFromWorker(model)).text(),'model');
  assert.equal(await (await fetchFromWorker('https://example.test/people-counter/','navigate')).text(),'page');
  assert.equal(fetchFromWorker('https://firestore.googleapis.com/list'),undefined);
});
