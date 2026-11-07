import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {before, beforeEach, after, test} from 'node:test';
import {initializeTestEnvironment, assertFails, assertSucceeds} from '@firebase/rules-unit-testing';
import {doc, collection, getDoc, getDocs, setDoc, updateDoc, writeBatch} from 'firebase/firestore';

// Refuse to connect outside an explicitly isolated emulator, even if a local
// Firebase configuration or credential is present on the test machine.
const emulator = process.env.FIRESTORE_EMULATOR_HOST;
if (!emulator || !/^(127\.0\.0\.1|localhost):\d+$/.test(emulator)) throw Error('A loopback Firestore emulator is required');
const [host, port] = emulator.split(':');
let env;
before(async()=>{env=await initializeTestEnvironment({projectId:'qr-ticket-security-attacks-test',firestore:{host,port:Number(port),rules:await readFile('firestore.rules','utf8')}});});
beforeEach(async()=>env.clearFirestore());
after(async()=>env?.cleanup());

const now='2026-11-07T00:00:00.000Z';
function application(uid,terminalId,changes={}){return {terminalId,requestedByUid:uid,requestedRole:'reception',name:'Isolated test',type:'Web / iPad',status:'pending',requestedAt:now,updatedAt:now,...changes};}
function pendingTerminal(uid,id,changes={}){return {...application(uid,id),role:'reception',approved:false,managementApproved:false,receptionApproved:false,admin:false,subAdmin:false,mode:'停止',desiredMode:'停止',syncPendingCount:0,...changes};}
async function seed(){
  await env.withSecurityRulesDisabled(async context=>{
    const db=context.firestore();
    for(const [uid,id,role] of [['manager','T-MANAGER','management'],['reception','T-RECEPTION','reception']]){
      await setDoc(doc(db,'terminalInstallations',uid),{authUid:uid,terminalId:id,approved:true});
      await setDoc(doc(db,'terminalOwners',id),{terminalId:id,ownerUid:uid,enabled:true});
      await setDoc(doc(db,'terminals',id),{terminalId:id,requestedByUid:uid,approved:true,managementApproved:role==='management',receptionApproved:role==='reception',role,admin:role==='management',subAdmin:false});
    }
    for(const id of ['event-a','event-b']){
      await setDoc(doc(db,'events',id),{eventId:id,eventName:id,receptionTarget:true,eventStatus:'active',dataVersion:1});
      await setDoc(doc(db,'events',id,'tickets','ticket-one'),{eventId:id,ticketId:'ticket-one',currentStatus:'unused',valid:true,basicInfo:{name:'Test'}});
    }
    await setDoc(doc(db,'events','event-a','receptionApprovals','T-RECEPTION'),{eventId:'event-a',terminalId:'T-RECEPTION',requestedByUid:'reception',name:'Test',status:'approved',requestedAt:now});
  });
}
function entry(db,{eventId='event-a',terminalId='T-RECEPTION',recordId='record-one',ticketChanges={},recordChanges={}}={}){
  const batch=writeBatch(db);
  batch.update(doc(db,'events',eventId,'tickets','ticket-one'),{currentStatus:'inside',updatedAt:now,lastReceptionRecordId:recordId,...ticketChanges});
  batch.set(doc(db,'events',eventId,'receptionRecords',recordId),{recordId,eventId,ticketId:'ticket-one',terminalId,type:'entry',timestamp:now,...recordChanges});
  return batch.commit();
}
async function unchanged(eventId='event-a'){
  await env.withSecurityRulesDisabled(async context=>{
    const db=context.firestore();
    assert.equal((await getDoc(doc(db,'events',eventId,'tickets','ticket-one'))).data().currentStatus,'unused');
    assert.equal((await getDocs(collection(db,'events',eventId,'receptionRecords'))).size,0);
  });
}

test('anonymous callers and forged admin claims cannot create trusted grants or read management data',async()=>{
  await seed();
  for(const db of [env.unauthenticatedContext().firestore(),env.authenticatedContext('attacker',{admin:true,role:'management',terminalId:'T-MANAGER'}).firestore()]){
    await assertFails(getDocs(collection(db,'events')));
    await assertFails(setDoc(doc(db,'terminalInstallations','attacker'),{authUid:'attacker',terminalId:'T-MANAGER',approved:true}));
    await assertFails(setDoc(doc(db,'terminalOwners','T-MANAGER'),{terminalId:'T-MANAGER',ownerUid:'attacker',enabled:true}));
    await assertFails(updateDoc(doc(db,'terminals','T-MANAGER'),{admin:true,requestedByUid:'attacker'}));
    await assertFails(entry(db));
  }
  await unchanged();
});

test('a copied terminal ID and forged claims cannot turn a reception installation into management',async()=>{
  await seed();const db=env.authenticatedContext('reception',{admin:true,role:'management'}).firestore();
  for(const changes of [{admin:true},{subAdmin:true},{role:'both'},{managementApproved:true},{requestedByUid:'manager'}])await assertFails(updateDoc(doc(db,'terminals','T-RECEPTION'),changes));
  await assertFails(updateDoc(doc(db,'terminalInstallations','reception'),{terminalId:'T-MANAGER'}));
  await assertFails(updateDoc(doc(db,'terminalOwners','T-RECEPTION'),{ownerUid:'manager'}));
  await assertFails(setDoc(doc(db,'events','event-a','settings','ticketDesign'),{data:'malicious'}));
  await assertFails(getDocs(collection(db,'events','event-a','members')));
  await assertSucceeds(entry(db)); // Positive control: intended reception still works.
});

for(const [name,options] of [
  ['another event without its approval',{eventId:'event-b'}],
  ['another terminal ID',{terminalId:'T-MANAGER'}],
  ['ticket validity changes',{ticketChanges:{valid:false}}],
  ['ticket data injection',{ticketChanges:{'basicInfo.name':'forged'}}],
  ['extra receipt authority fields',{recordChanges:{admin:true}}],
  ['an unrelated ticket pointer',{recordChanges:{ticketId:'other-ticket'}}],
])test('atomic receipt forgery is rejected without partial writes: '+name,async()=>{
  await seed();await assertFails(entry(env.authenticatedContext('reception').firestore(),options));await unchanged(options.eventId);
});

for(const state of ['pending','wrong-uid','released','disabled-owner'])test('stale or altered authority cannot be replayed: '+state,async()=>{
  await seed();
  await env.withSecurityRulesDisabled(async context=>{
    const db=context.firestore();
    if(state==='pending')await updateDoc(doc(db,'events','event-a','receptionApprovals','T-RECEPTION'),{status:'pending'});
    if(state==='wrong-uid')await updateDoc(doc(db,'events','event-a','receptionApprovals','T-RECEPTION'),{requestedByUid:'manager'});
    if(state==='released')await updateDoc(doc(db,'terminalInstallations','reception'),{approved:false});
    if(state==='disabled-owner')await updateDoc(doc(db,'terminalOwners','T-RECEPTION'),{enabled:false});
  });
  await assertFails(entry(env.authenticatedContext('reception').firestore()));await unchanged();
});

test('replaying a successful entry under a new receipt ID cannot double-count it',async()=>{
  await seed();const db=env.authenticatedContext('reception').firestore();await assertSucceeds(entry(db));await assertFails(entry(db,{recordId:'replayed-entry'}));
  await env.withSecurityRulesDisabled(async context=>assert.equal((await getDocs(collection(context.firestore(),'events','event-a','receptionRecords'))).size,1));
});

for(const field of ['requestedAt','updatedAt'])for(const value of ['', 'X'.repeat(32768)])for(const target of ['application','terminal']){
  test(`unapproved registration cannot store ${value.length?'oversized':'empty'} ${target} ${field}`,async()=>{
    const uid='new-client',id='T-BOUNDED';const db=env.authenticatedContext(uid).firestore();
    if(target==='application')await assertFails(setDoc(doc(db,'terminalApplications',id),application(uid,id,{[field]:value})));
    else{
      const batch=writeBatch(db);batch.set(doc(db,'terminalApplications',id),application(uid,id));batch.set(doc(db,'terminals',id),pendingTerminal(uid,id,{[field]:value}));await assertFails(batch.commit());
    }
  });
}
test('unapproved registration cannot use an oversized terminal path segment',async()=>{
  const id='T-'+ 'X'.repeat(159),db=env.authenticatedContext('new-client').firestore();await assertFails(setDoc(doc(db,'terminalApplications',id),application('new-client',id)));
});
test('bounded pending registration remains available but cannot be updated into an admin grant',async()=>{
  const uid='new-client',id='T-BOUNDED',db=env.authenticatedContext(uid).firestore();const batch=writeBatch(db);
  batch.set(doc(db,'terminalApplications',id),application(uid,id));batch.set(doc(db,'terminals',id),pendingTerminal(uid,id));await assertSucceeds(batch.commit());
  await assertFails(updateDoc(doc(db,'terminalApplications',id),{status:'approved',decidedByUid:uid,decidedAt:now}));
  await assertFails(updateDoc(doc(db,'terminals',id),{admin:true,approved:true,managementApproved:true}));
});
