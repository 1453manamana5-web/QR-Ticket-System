import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import React from 'react';
import {act,create} from 'react-test-renderer';
const require=createRequire(import.meta.url),ts=require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
test('print title treats event names as text and prints only once',async()=>{
  const name='文化祭</title><script>alert(1)</script>&体験';
  let html='',prints=0,load;
  const printDocument={open(){},write(value){html=value;},close(){},body:{appendChild(){}},readyState:'complete'};
  const popup={document:printDocument,closed:false,focus(){},print(){prints++;},addEventListener(_event,fn){load=fn;}};
  const window={open:()=>popup,setTimeout:fn=>fn()};
  const document={querySelector:()=>({cloneNode:()=>({style:{}})})};
  const exports={};
  new Function('exports','require','localStorage','window','document','alert',ts.transpileModule(readFileSync('management-app/src/TicketDesigner.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(exports,n=>n==='react'?React:n==='react/jsx-runtime'?require(n):n==='./LazyQrCode'?{default:()=>null}:{},{getItem:()=>null},window,document,()=>assert.fail('printing failed'));
  let renderer;await act(async()=>{renderer=create(React.createElement(exports.default,{eventName:name,tickets:[{id:'1',qrNumber:'1',valid:true,status:'unused'}],qrValue:()=>'',onClose(){}}));});
  const click=async text=>{const button=renderer.root.findAllByType('button').find(n=>n.children.join('')===text);assert.ok(button,text);await act(async()=>button.props.onClick());};
  try{
    await click('画像を使わず新規作成');await click('印刷');
    assert.equal(printDocument.title,name+' - 印刷');assert.equal(html.includes('<script>'),false);assert.equal(html.includes(name),false);
    load();assert.equal(prints,1);
  }finally{await act(async()=>renderer.unmount());}
});

function designerModule(storage){
  const out={};
  new Function('exports','require','localStorage','window','alert',ts.transpileModule(readFileSync('management-app/src/TicketDesigner.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(out,n=>n==='react'?React:n==='react/jsx-runtime'?require(n):n==='./LazyQrCode'?{default:()=>null}:{},{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},{confirm:()=>true},()=>{});
  return out;
}
const designTickets=Array.from({length:6},(_,i)=>({id:String(i),qrNumber:String(i+1),valid:true,status:'unused'}));
const designLabel=node=>node.children.map(child=>typeof child==='string'?child:designLabel(child)).join('');

test('designs are isolated by event ID, survive renaming, and migrate named designs without changing another event',async()=>{
  const storage=new Map([['qr-management-ticket-design-id-event-a',JSON.stringify({title:'Design A'})]]),module=designerModule(storage);
  let renderer;
  const mount=async(eventId,eventName)=>{await act(async()=>{renderer=create(React.createElement(module.default,{eventId,eventName,tickets:designTickets,qrValue:t=>t.id,onClose(){}}));});};
  await mount('event-a','Same name');
  assert.ok(renderer.root.findAll(node=>node.props.className==='ticket-design-title ticket-draggable-part ').length>0);
  assert.ok(JSON.stringify(renderer.toJSON()).includes('Design A'));
  await act(async()=>renderer.unmount());
  await mount('event-b','Same name');
  assert.equal(JSON.stringify(renderer.toJSON()).includes('Design A'),false);
  await act(async()=>renderer.unmount());
  await mount('event-a','Renamed event');assert.ok(JSON.stringify(renderer.toJSON()).includes('Design A'));
  await act(async()=>renderer.unmount());
  storage.set('qr-management-ticket-design-'+encodeURIComponent('Legacy name'),JSON.stringify({title:'Legacy design'}));
  await mount('event-c','Legacy name');
  await act(async()=>renderer.root.findAllByType('button').find(node=>designLabel(node)==='保存').props.onClick());
  assert.ok(storage.get('qr-management-ticket-design-id-event-c').includes('Legacy design'));
  await act(async()=>renderer.unmount());
});

test('malformed saved image lists and column counts cannot crash print layout',async()=>{
  const storage=new Map([['qr-management-ticket-design-id-damaged',JSON.stringify({title:'Recovered',images:{broken:true},cardsPerRow:0,printWidthMm:null,qrX:'bad'})]]),module=designerModule(storage);
  let renderer;await act(async()=>{renderer=create(React.createElement(module.default,{eventId:'damaged',eventName:'Damaged',tickets:designTickets,qrValue:t=>t.id,onClose(){}}));});
  try{assert.equal(renderer.root.findAll(node=>node.props.className==='ticket-print-card').length,6);}finally{await act(async()=>renderer.unmount());}
});

test('pink marker detection and containment mapping preserve the intended QR position',()=>{
  const out={};new Function('exports',ts.transpileModule(readFileSync('management-app/src/pinkQrMarkerDetection.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out);
  const pixels=new Uint8ClampedArray(100*60*4);
  for(let y=20;y<40;y++)for(let x=65;x<85;x++)pixels.set([255,0,170,255],(y*100+x)*4);
  const marker=out.detectPinkQrMarker(pixels,100,60);assert.equal(marker.centerXPercent,75);assert.equal(marker.centerYPercent,50);assert.equal(marker.sizePercent,20);
  assert.equal(out.findClosestTicketRatio(1600,900).cardRatio,'16:9');
  const mapped=out.mapMarkerToTicketRatio(marker,100,60,{width:16,height:9});assert.equal(mapped.centerXPercent,73.4375);
  assert.equal(out.detectPinkQrMarker(new Uint8ClampedArray(4),100,60),null);
});
