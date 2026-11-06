import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {after, before, beforeEach, test} from 'node:test';
import {assertFails, assertSucceeds, initializeTestEnvironment} from '@firebase/rules-unit-testing';
import {collection, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc, writeBatch} from 'firebase/firestore';
import {assertIsolatedEnvironment} from './isolation.mjs';

// Every SDK context is explicitly pinned to the loopback emulator and a demo
// project. This file never uses production config or ambient credentials.
const projectId='demo-qr-red-rules';
const now='2026-11-06T00:00:00.000Z';
const huge='x'.repeat(200_000);
let env;
before(async()=>{
  assertIsolatedEnvironment();
  const rulesPath=process.env.QR_SECURITY_RULES_PATH||new URL('../firestore.rules',import.meta.url);
  env=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:8080,rules:await readFile(rulesPath,'utf8')}});
});
after(async()=>env?.cleanup());
const terminal=(uid,role='reception',flags={})=>({terminalId:'T-'+uid,requestedByUid:uid,requestedRole:role,name:uid,type:'Web / iPad',role,approved:true,managementApproved:role!=='reception',receptionApproved:role!=='management',admin:false,subAdmin:false,status:'online',mode:'停止',desiredMode:'停止',syncPendingCount:0,lastSeen:now,updatedAt:now,...flags});
const event=(id,published=true)=>({eventId:id,eventName:id,eventStatus:'active',receptionTarget:published,authToken:'token-'+id,dataVersion:1});
const ticket=(eventId)=>({ticketId:'one',eventId,basicInfo:{ticketNumber:1},currentStatus:'unused',valid:true,updatedAt:now});
const context=uid=>env.authenticatedContext(uid).firestore();
const pending=(uid,id,patch={})=>({terminalId:id,requestedByUid:uid,requestedRole:'reception',name:'Entrance',type:'Web / iPad',status:'pending',requestedAt:now,updatedAt:now,...patch});
async function createApplication(db,uid,id,patch={}){
  const app=pending(uid,id,patch),batch=writeBatch(db);
  batch.set(doc(db,'terminalApplications',id),app);
  batch.set(doc(db,'terminals',id),{...app,role:'reception',approved:false,managementApproved:false,receptionApproved:false,admin:false,subAdmin:false,mode:'停止',desiredMode:'停止',syncPendingCount:0});
  return batch.commit();
}
beforeEach(async()=>{
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c=>{
    const db=c.firestore();
    for(const [uid,role,flags] of [['admin','management',{admin:true}],['deputy','management',{subAdmin:true}],['manager','management',{}],['receiver','reception',{}],['other','reception',{}]]){
      await setDoc(doc(db,'terminals','T-'+uid),terminal(uid,role,flags));
      await setDoc(doc(db,'terminalOwners','T-'+uid),{terminalId:'T-'+uid,ownerUid:uid,enabled:true});
      await setDoc(doc(db,'terminalInstallations',uid),{terminalId:'T-'+uid,authUid:uid,approved:true});
    }
    for(const id of ['approved','unapproved']){
      await setDoc(doc(db,'events',id),event(id));
      await setDoc(doc(db,'events',id,'tickets','one'),ticket(id));
    }
    await setDoc(doc(db,'events','approved','receptionApprovals','T-receiver'),{eventId:'approved',terminalId:'T-receiver',requestedByUid:'receiver',name:'Entrance',status:'approved',requestedAt:now});
  });
});

test('red: unauthenticated and unapproved identities cannot enumerate or overwrite private data',async()=>{
  for(const db of [env.unauthenticatedContext().firestore(),context('stranger')]){
    await assertFails(getDocs(collection(db,'events')));
    await assertFails(getDoc(doc(db,'events','approved','tickets','one')));
    await assertFails(setDoc(doc(db,'devices','admin'),{admin:true}));
  }
});

test('red: attacker cannot forge an owner or approved installation mapping',async()=>{
  const db=context('stranger');
  await assertFails(setDoc(doc(db,'terminalOwners','T-admin'),{ownerUid:'stranger',enabled:true}));
  await assertFails(setDoc(doc(db,'terminalInstallations','stranger'),{terminalId:'T-admin',authUid:'stranger',approved:true}));
});

test('red: pending registration cannot self-approve or change its owner on update',async()=>{
  const db=context('stranger'),id='T-RED-PENDING-01';
  await assertSucceeds(createApplication(db,'stranger',id));
  await assertFails(updateDoc(doc(db,'terminals',id),{approved:true,managementApproved:true,role:'management',admin:true}));
  await assertFails(updateDoc(doc(db,'terminalApplications',id),{requestedByUid:'admin',status:'approved'}));
});

test('red: registration timestamps reject a bounded 200KB storage payload',async()=>{
  await assertFails(createApplication(context('stranger'),'stranger','T-RED-HUGE-0001',{requestedAt:huge,updatedAt:huge}));
});

test('red: approved heartbeat cannot store a bounded 200KB timestamp payload',async()=>{
  await assertFails(updateDoc(doc(context('receiver'),'terminals','T-receiver'),{lastSeen:huge,updatedAt:huge}));
});

test('red: a released installation cannot continue updating its terminal through the owner branch',async()=>{
  const db=context('receiver');
  await assertSucceeds(updateDoc(doc(db,'terminalInstallations','receiver'),{approved:false,releasedAt:now}));
  await assertFails(updateDoc(doc(db,'terminals','T-receiver'),{lastSeen:'2026-11-06T00:01:00.000Z',updatedAt:'2026-11-06T00:01:00.000Z',syncPendingCount:0}));
});

test('red: an approved installation cannot heartbeat after its trusted owner is disabled',async()=>{
  await env.withSecurityRulesDisabled(async c=>{
    await updateDoc(doc(c.firestore(),'terminalOwners','T-receiver'),{enabled:false});
  });
  const db=context('receiver');
  await assertFails(updateDoc(doc(db,'terminals','T-receiver'),{lastSeen:'2026-11-06T00:01:00.000Z',updatedAt:'2026-11-06T00:01:00.000Z',syncPendingCount:0}));
  await env.withSecurityRulesDisabled(async c=>{
    await updateDoc(doc(c.firestore(),'terminalOwners','T-receiver'),{enabled:true});
  });
  await assertSucceeds(updateDoc(doc(db,'terminals','T-receiver'),{lastSeen:now,updatedAt:now,syncPendingCount:0}));
});

test('red: a released installation cannot store a bounded 200KB release boundary',async()=>{
  await assertFails(updateDoc(doc(context('receiver'),'terminalInstallations','receiver'),{approved:false,releasedAt:huge}));
});

test('red: reception release cannot smuggle a bounded 200KB timestamp through another update branch',async()=>{
  await assertFails(updateDoc(doc(context('receiver'),'terminals','T-receiver'),{
    receptionApproved:false,receptionApprovalVersion:1,approved:false,
    mode:'停止',desiredMode:'停止',desiredModeUpdatedAt:now,
    updatedAt:huge,approvalUpdatedAt:now,approvalUpdatedByUid:'receiver',
  }));
});

test('red: registration cannot impersonate a different authenticated applicant',async()=>{
  await assertFails(createApplication(context('stranger'),'admin','T-RED-IMPERSONATE'));
});

test('red: event approval for one event never grants the next event or self-approval',async()=>{
  const db=context('receiver');
  await assertSucceeds(getDoc(doc(db,'events','approved','tickets','one')));
  await assertFails(getDoc(doc(db,'events','unapproved','tickets','one')));
  await assertFails(setDoc(doc(db,'events','unapproved','receptionApprovals','T-receiver'),{eventId:'unapproved',terminalId:'T-receiver',requestedByUid:'receiver',name:'Entrance',status:'approved',requestedAt:now}));
});

function entry(db,{recordId='entry',terminalId='T-receiver',eventId='approved',extraTicket={},extraRecord={}}={}){
  const batch=writeBatch(db);
  batch.update(doc(db,'events',eventId,'tickets','one'),{currentStatus:'inside',updatedAt:now,lastReceptionRecordId:recordId,...extraTicket});
  batch.set(doc(db,'events',eventId,'receptionRecords',recordId),{recordId,eventId,ticketId:'one',terminalId,type:'entry',timestamp:now,...extraRecord});
  return batch.commit();
}
test('red: atomic reception rejects forged identity, schema pollution and validity tampering',async()=>{
  const db=context('receiver');
  for(const patch of [{terminalId:'T-other'},{extraRecord:{admin:true}},{extraTicket:{valid:false}},{extraTicket:{basicInfo:{ticketNumber:2}}}])await assertFails(entry(db,patch));
  assert.equal((await getDoc(doc(db,'events','approved','tickets','one'))).data().currentStatus,'unused');
});

test('red: duplicate receipt replay cannot append or count a second entry',async()=>{
  const db=context('receiver');
  await assertSucceeds(entry(db));
  await assertFails(entry(db));
  await assertFails(entry(db,{recordId:'another-entry'}));
  assert.equal((await getDoc(doc(db,'events','approved','tickets','one'))).data().currentStatus,'inside');
});

test('red: ordinary manager cannot perform administrator-only remote mode changes',async()=>{
  await assertFails(updateDoc(doc(context('manager'),'terminals','T-receiver'),{desiredMode:'入口受付',desiredModeUpdatedAt:now}));
});

test('red: deputy cannot promote an ordinary manager or become the primary administrator',async()=>{
  const db=context('deputy');
  await assertFails(updateDoc(doc(db,'terminals','T-manager'),{subAdmin:true,subAdminUpdatedAt:now,subAdminUpdatedByUid:'deputy'}));
  await assertFails(updateDoc(doc(db,'terminals','T-deputy'),{admin:true}));
});

test('red: receiver cannot forge heartbeat metadata for another terminal',async()=>{
  await assertFails(updateDoc(doc(context('receiver'),'terminals','T-other'),{lastSeen:now,updatedAt:now,syncPendingCount:0,receptionMode:'stopped',receptionEventId:'approved',receptionReportedAt:serverTimestamp()}));
});

test('documented residual: one anonymous UID can submit two pending applications but cannot approve either',async()=>{
  const db=context('stranger');
  for(const id of ['T-RED-REQUEST-01','T-RED-REQUEST-02']){
    await assertSucceeds(createApplication(db,'stranger',id));
    const saved=await getDoc(doc(db,'terminalApplications',id));
    assert.equal(saved.data().status,'pending');
    await assertFails(updateDoc(doc(db,'terminals',id),{approved:true,admin:true}));
  }
});
