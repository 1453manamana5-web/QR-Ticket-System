const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {allowed,collect,seal,unseal,remove}=require('./reset-terminal-registrations.cjs');
test('terminal reset preserves events, tickets, reception records and unrelated approval collections',async()=>{
 const docs=new Map([['terminals/T-one',{}],['terminalOwners/T-one',{}],['terminalInstallations/uid',{}],['devices/T-one',{}],['terminalApplications/T-two',{}],['terminalHandoffRequests/a',{}],['terminalHandoffRateLimits/a',{}],['events/e/receptionApprovals/T-one',{}],['events/e',{name:'festival'}],['events/e/tickets/t',{valid:true}],['events/e/receptionRecords/r',{type:'entry'}],['other/o/receptionApprovals/x',{keep:true}],['eventBundles/b',{}],['receptionErrors/r',{}]]);
 const snapshot=paths=>({docs:paths.map(path=>({ref:{path},data:()=>docs.get(path)}))});
 const db={collection:name=>({get:async()=>snapshot([...docs.keys()].filter(p=>p.split('/').length===2&&p.startsWith(name+'/')))}),collectionGroup:name=>({get:async()=>snapshot([...docs.keys()].filter(p=>p.split('/').at(-2)===name))}),doc:path=>({path}),batch:()=>{const paths=[];return {delete:ref=>paths.push(ref.path),commit:async()=>{for(const p of paths)docs.delete(p);}};}};
 const records=await collect(db);assert.equal(records.length,8);assert.ok(records.every(r=>allowed(r.path)));
 await assert.rejects(remove(db,[{path:'events/e'}]),/Refusing/);assert.ok(docs.has('terminals/T-one'));
 await remove(db,records);assert.equal((await collect(db)).length,0);assert.equal(docs.size,6);assert.equal(docs.get('events/e').name,'festival');assert.equal(docs.get('events/e/tickets/t').valid,true);
});
test('backup is encrypted and scope checked before deletion',()=>{
 const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
 const records=[{path:'terminals/T-private',data:{name:'private device'}}];const encrypted=seal(records,privateKey);
 assert.ok(!JSON.stringify(encrypted).includes('private device'));assert.deepEqual(unseal(encrypted,privateKey),records);
 assert.throws(()=>unseal(seal([{path:'events/e',data:{}}],privateKey),privateKey),/scope/);
});
