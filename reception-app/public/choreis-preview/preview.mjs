import {create,advance,receiver} from './engine.mjs';
const $=id=>document.getElementById(id), clock=()=>Date.now();
let counts={entries:124,exits:86},session=null,scope='summary',revision=0;
const change=event=>{if(session)session=advance(session,event,Math.max(clock(),session.updatedAt));render()};
function render(){
 $('entries').textContent=counts.entries;$('occupancy').textContent=counts.entries-counts.exits;
 const s=session,now=clock(),v=receiver(s,now);
 const states={offered:'受信側の確認待ち',active:'共有中',declined:'拒否されました',revoked:'共有を停止しました',expired:'有効期限が終了しました'};
 $('senderState').textContent=s?states[s.status]+(s.status==='active'?(s.mode==='live'?' · リアルタイム':' · 静的')+(s.online?'':' · 通信切断'):''):'共有していません';
 $('revoke').hidden=!s||!['active','offered'].includes(s.status);
 $('share').disabled=$('part').disabled=!!s&&['offered','active'].includes(s.status);
 $('receiverName').textContent=s?(s.target==='teacher'?'顧問用 iPad':'副管理者の端末'):'共有先';
 $('offer').hidden=s?.status!=='offered';
 $('received').hidden=!v;
 $('receiverState').textContent=v?(v.stale?'通信切断・古い情報':'閲覧専用 · '+(v.mode==='live'?'リアルタイム':'共有時点の情報')):s?states[s.status]:'共有待ち';
 $('receivedData').replaceChildren();
 if(v){for(const [key,n] of Object.entries(v.data)){const box=document.createElement('div'),number=document.createElement('strong');box.textContent={entries:'来場者数',exits:'退場者数',occupancy:'会場内'}[key];number.textContent=n;box.append(number);$('receivedData').append(box)}
 $('updated').textContent='最終更新 '+new Date(v.updatedAt).toLocaleTimeString('ja-JP')+' · 有効期限 '+new Date(s.expiresAt).toLocaleTimeString('ja-JP');
 $('network').textContent=s.online?'通信を切断（模擬）':'再接続（模擬）';}
}
function open(which){scope=which;$('scope').textContent=which==='entries'?'共有内容：来場者数のみ':'共有内容：人数の概要';$('panel').hidden=false;}
function publish(){revision++;change({type:'publish',revision,data:counts})}
$('share').onclick=()=>open('summary');$('part').onclick=()=>open('entries');$('cancel').onclick=()=>$('panel').hidden=true;
$('send').onclick=()=>{if(session&&['active','offered'].includes(session.status))return;session=create({target:document.querySelector('input[name=target]:checked').value,mode:$('live').checked?'live':'snapshot',scope,data:counts,now:clock()});$('panel').hidden=true;render()};
$('accept').onclick=()=>{change({type:'accept'});publish()};$('decline').onclick=()=>change({type:'decline'});$('revoke').onclick=()=>change({type:'revoke'});
$('enter').onclick=()=>{counts={...counts,entries:counts.entries+1};publish()};$('exit').onclick=()=>{if(counts.exits<counts.entries){counts={...counts,exits:counts.exits+1};publish()}};
$('network').onclick=()=>{if(session?.online)change({type:'disconnect'});else{change({type:'reconnect'});publish()}};
setInterval(()=>change({type:'tick'}),500);render();