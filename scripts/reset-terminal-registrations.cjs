const crypto=require('node:crypto');
const fs=require('node:fs');
const PROJECT='qr-ticket-system-5ba69';
const OPERATION='terminal-reset-20261105-a29d8e71';
const COLLECTIONS=['terminalInstallations','terminalOwners','terminals','devices','terminalApplications','terminalHandoffRequests','terminalHandoffRateLimits'];
const allowed=path=>{const p=path.split('/');return (p.length===2&&COLLECTIONS.includes(p[0])&&!!p[1])||(p.length===4&&p[0]==='events'&&!!p[1]&&p[2]==='receptionApprovals'&&!!p[3]);};
async function collect(db){
 const records=[];
 for(const name of COLLECTIONS){const snap=await db.collection(name).get();for(const doc of snap.docs)records.push({path:doc.ref.path,data:doc.data()});}
 const approvals=await db.collectionGroup('receptionApprovals').get();
 for(const doc of approvals.docs)if(allowed(doc.ref.path))records.push({path:doc.ref.path,data:doc.data()});
 return records;
}
function seal(records,privateKey){
 const key=crypto.randomBytes(32),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
 const encrypted=Buffer.concat([cipher.update(JSON.stringify({project:PROJECT,operation:OPERATION,records}),'utf8'),cipher.final()]);
 return {version:1,wrappedKey:crypto.publicEncrypt({key:crypto.createPublicKey(privateKey),oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')};
}
function unseal(envelope,privateKey){
 const key=crypto.privateDecrypt({key:privateKey,oaepHash:'sha256'},Buffer.from(envelope.wrappedKey,'base64'));
 const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
 const data=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8'));
 if(data.project!==PROJECT||data.operation!==OPERATION||!Array.isArray(data.records)||data.records.some(r=>!allowed(r.path)))throw Error('Backup scope mismatch');
 return data.records;
}
async function remove(db,records){
 if(records.some(r=>!allowed(r.path)))throw Error('Refusing non-terminal data');
 const sorted=[...records].sort((a,b)=>COLLECTIONS.indexOf(a.path.split('/')[0])-COLLECTIONS.indexOf(b.path.split('/')[0]));
 for(let i=0;i<sorted.length;i+=300){const batch=db.batch();for(const record of sorted.slice(i,i+300))batch.delete(db.doc(record.path));await batch.commit();}
 const remaining=await collect(db);
 if(remaining.length)throw Error('Terminal records remain or a new registration arrived; reset not marked complete');
}
async function main(){
 const account=JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT||'null');if(!account?.private_key||!account.client_email)throw Error('Firebase admin credential missing');
 const adminRequire=require('node:module').createRequire(require('node:path').resolve(__dirname,'../functions/package.json'));
 const {initializeApp,cert}=adminRequire('firebase-admin/app');
 const {getFirestore}=adminRequire('firebase-admin/firestore');
 initializeApp({credential:cert(account),projectId:PROJECT});const db=getFirestore();
 const audit=db.doc('maintenanceOperations/'+OPERATION),backup=process.env.RESET_BACKUP_PATH;
 if(!backup)throw Error('Encrypted backup path required');
 if(process.argv[2]==='plan'){
  const state=await audit.get();
  if(state.exists&&state.get('status')==='completed'){
   if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'ready=false\n');
   console.log('This one-time reset already completed; no changes.');return;
  }
  const records=await collect(db);fs.writeFileSync(backup,JSON.stringify(seal(records,account.private_key)),{mode:0o600});
  const counts={};for(const r of records){const name=r.path.split('/').length===4?'eventReceptionApprovals':r.path.split('/')[0];counts[name]=(counts[name]||0)+1;}
  await audit.set({status:'planned',project:PROJECT,plannedAt:new Date().toISOString(),counts});
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'ready=true\n');
  console.log(JSON.stringify({project:PROJECT,targetCounts:counts,encryptedBackup:true}));return;
 }
 if(process.argv[2]!=='apply'||process.env.RESET_CONFIRM!=='RESET_ALL_TERMINALS')throw Error('Explicit terminal-only reset confirmation required');
 const state=await audit.get();if(state.exists&&state.get('status')==='completed'){console.log('Already completed; no changes.');return;}
 const records=unseal(JSON.parse(fs.readFileSync(backup,'utf8')),account.private_key);
 await remove(db,records);await audit.set({status:'completed',completedAt:new Date().toISOString(),remainingTerminalRecords:0,deletedRecords:records.length},{merge:true});
 console.log(JSON.stringify({project:PROJECT,resetCompleted:true,deletedRecords:records.length,remainingTerminalRecords:0,businessDataUntouched:true}));
}
module.exports={COLLECTIONS,allowed,collect,seal,unseal,remove};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
