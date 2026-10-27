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
