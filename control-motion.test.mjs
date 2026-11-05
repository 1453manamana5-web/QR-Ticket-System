import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import React from 'react';
import {act,create} from 'react-test-renderer';
const require=createRequire(import.meta.url),ts=require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;

// Load the actual application modules with isolated storage and no live adapters.
function loader(globals={},overrides={}){
  const cache=new Map();
  return function load(file){
    file=path.resolve(file);if(cache.has(file))return cache.get(file);
    const out={};cache.set(file,out);
    const source=readFileSync(file,'utf8').replace(/import\.meta\.env\.[A-Z_]+/g,JSON.stringify('/QR-Ticket-System/management-app/'));
    const dependency=name=>{
      if(name in overrides)return overrides[name];if(name.endsWith('.css'))return {};
      if(name.startsWith('.')){
        const target=path.resolve(path.dirname(file),name);
        if(path.extname(target))return load(target);
        try{return load(target+'.tsx');}catch(error){if(error.code!=='ENOENT')throw error;return load(target+'.ts');}
      }
      return require(name);
    };
    new Function('exports','require',...Object.keys(globals),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(out,dependency,...Object.values(globals));
    return out;
  };
}
const label=node=>node.children.map(child=>typeof child==='string'?child:label(child)).join('');
const flush=async()=>{await act(async()=>{for(let i=0;i<12;i++)await turn();});};
const noLive=new Proxy({}, {get:(_target,key)=>()=>assert.fail('Live adapter called: '+String(key))});
function environment(){
  const timers=new Map();let sequence=0;
  const storage={getItem:()=>assert.fail('Practice read live storage'),setItem:()=>assert.fail('Practice wrote live storage'),removeItem:()=>assert.fail('Practice removed live storage')};
  const window={addEventListener(){},removeEventListener(){},matchMedia:()=>({matches:false}),setTimeout:()=>++sequence,clearTimeout(){},setInterval:fn=>{timers.set(++sequence,fn);return sequence;},clearInterval:id=>timers.delete(id),confirm:()=>true,prompt:()=>null};
  const document={querySelector:()=>null,querySelectorAll:()=>[],activeElement:null};
  const load=loader({window,document,localStorage:storage,navigator:{onLine:false},crypto:webcrypto,alert(){},ResizeObserver:class{observe(){}disconnect(){}}},{'./firebaseData':noLive,'./eventPublisher':noLive,'./firebaseClient':noLive,'./reservePrintLedger':{useReservePrintLedger:()=>({confirmed:[],reserved:[],unsynced:0})},'./LazyQrCode':{default:()=>React.createElement('svg')}});
  return {load,timers};
}

test('the real settings switch has a native label/name and changes state without a delayed click adapter',async()=>{
  const {load,timers}=environment();const App=load('management-app/src/App.tsx').default;let renderer;
  await act(async()=>{renderer=create(React.createElement(App,{practice:true}));});await flush();
  try{
    const settings=renderer.root.findAllByType('button').find(node=>node.props['data-nav-label']==='設定');
    assert.ok(settings);await act(async()=>settings.props.onClick({currentTarget:null}));await flush();
    const getSwitch=()=>renderer.root.findAllByType('input').find(node=>node.props.role==='switch');
    let control=getSwitch();assert.ok(control);assert.equal(control.props.type,'checkbox');assert.equal(control.props['aria-label'],'試験機能をオンにする');
    let owner=control.parent;while(owner&&owner.type!=='label')owner=owner.parent;
    assert.ok(owner,'The whole visible setting must be associated with its native checkbox');
    assert.match(label(owner),/試験機能をオンにする/);assert.equal(owner.props.onClick,undefined,'Do not double-toggle native label activation');
    assert.equal(control.props.checked,false);
    await act(async()=>control.props.onChange({target:{checked:true}}));assert.equal(getSwitch().props.checked,true);
    await act(async()=>getSwitch().props.onChange({target:{checked:false}}));assert.equal(getSwitch().props.checked,false);
  }finally{await act(async()=>renderer.unmount());}assert.equal(timers.size,0);
});

test('designer tools report selection and panel close gestures never start a panel drag',async()=>{
  const {load}=environment();const Designer=load('management-app/src/TicketDesigner.tsx').default;
  const panel={style:{},offsetLeft:300,offsetTop:12,offsetWidth:288,offsetHeight:400,offsetParent:{clientWidth:1024,clientHeight:768}};
  const paper={getBoundingClientRect:()=>({left:0,top:0,width:500,height:300})};let renderer;
  await act(async()=>{renderer=create(React.createElement(Designer,{practice:true,eventId:'GUIDE-MOTION',eventName:'Motion practice',tickets:[{id:'one',qrNumber:'000001',valid:true,status:'unused'}],qrValue:ticket=>ticket.id,onClose(){}}),{createNodeMock:node=>typeof node.props.className==='string'&&node.props.className.startsWith('studio-panel ')?panel:node.props.className==='ticket-design-card'?paper:null});});
  const button=text=>renderer.root.findAllByType('button').find(node=>label(node)===text);
  const click=async text=>{const node=button(text);assert.ok(node,text);await act(async()=>node.props.onClick());};
  try{
    await click('画像を使わず新規作成');
    assert.equal(renderer.root.findByProps({'aria-label':'元に戻す'}).props.disabled,true);
    await click('▦QR');assert.equal(button('▦QR').props['aria-pressed'],true);assert.equal(button('T文字').props['aria-pressed'],false);
    await click('T文字');assert.equal(button('T文字').props['aria-pressed'],true);assert.equal(button('▦QR').props['aria-pressed'],false);
    await click('⚙設定');assert.equal(button('⚙設定').props['aria-expanded'],true);
    const section=renderer.root.findAllByType('section').find(node=>String(node.props.className).startsWith('studio-panel '));
    const header=section.findByType('header');let captures=0;const currentTarget={setPointerCapture(){captures++;}};
    const event={button:0,isPrimary:true,pointerId:7,clientX:100,clientY:100,currentTarget,target:{closest:()=>({tagName:'BUTTON'})}};
    await act(async()=>header.props.onPointerDown(event));await act(async()=>header.props.onPointerMove({...event,clientX:160,clientY:150}));
    assert.equal(captures,0);assert.equal(panel.style.left,undefined,'A close-button press must not move the panel');
    await act(async()=>header.props.onPointerDown({...event,target:{closest:()=>null}}));
    await act(async()=>header.props.onPointerMove({...event,clientX:160,clientY:150}));
    assert.equal(captures,1);assert.equal(panel.style.left,'360px');assert.equal(panel.style.top,'62px');
    await act(async()=>header.props.onPointerCancel());await act(async()=>header.props.onPointerMove({...event,clientX:180,clientY:180}));assert.equal(panel.style.left,'360px');
    await act(async()=>section.findByProps({'aria-label':'配置・サイズを閉じる'}).props.onClick());assert.equal(button('⚙設定').props['aria-expanded'],false);
  }finally{await act(async()=>renderer.unmount());}
});

// Minimal DOM fixtures exercise real target discovery across retained modal pictures.
class Node {
  constructor(tag='div',attrs={},text='',visible=true){this.tag=tag;this.attrs={...attrs};this.text=text;this.visible=visible;this.children=[];this.parentElement=null;this.focusCount=0;}
  append(...children){for(const child of children){child.parentElement=this;this.children.push(child);}return this;}
  get textContent(){return this.text+this.children.map(child=>child.textContent).join('');}
  getAttribute(name){return name in this.attrs?String(this.attrs[name]):null;}
  setAttribute(name,value){this.attrs[name]=String(value);}
  removeAttribute(name){delete this.attrs[name];}
  getClientRects(){return this.visible?[{}]:[];}
  matches(selector){return selector.split(',').some(part=>{part=part.trim();const tag=part.match(/^[a-z]+/i)?.[0];if(tag&&this.tag!==tag)return false;for(const className of [...part.matchAll(/\.([\w-]+)/g)].map(m=>m[1]))if(!String(this.attrs.class??'').split(' ').includes(className))return false;for(const [,name,value] of part.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g))if(!(name in this.attrs)||(value!==undefined&&String(this.attrs[name])!==value))return false;return true;});}
  closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  contains(node){for(let current=node;current;current=current.parentElement)if(current===this)return true;return false;}
  scrollIntoView(){}
  focus(){this.focusCount++;}
}

test('guide target lookup ignores closing/hidden scopes, labels and buttons and finds reopened targets',()=>{
  const {findGuideTarget}=loader()('management-app/src/ManagementGuide.tsx');
  const root=new Node(),closing=new Node('div',{class:'dialog',inert:''}),live=new Node('div',{class:'dialog'});
  const oldLabel=new Node('label',{},'イベント名'),newLabel=new Node('label',{},'イベント名');
  const oldInput=new Node('input',{'aria-label':'イベント名'}),newInput=new Node('input',{'aria-label':'イベント名'});
  oldLabel.append(oldInput);newLabel.append(newInput);
  const oldButton=new Node('button',{class:'action'},'保存'),newButton=new Node('button',{class:'action'},'保存');
  closing.append(oldLabel,oldButton);live.append(newLabel,newButton);root.append(closing,live);
  assert.equal(findGuideTarget(root,{scope:'.dialog',selector:'.action'}),newButton);
  assert.equal(findGuideTarget(root,{label:'イベント名'}),newInput);
  assert.equal(findGuideTarget(root,{text:'保存'}),newButton);
  closing.removeAttribute('inert');closing.setAttribute('aria-hidden','true');assert.equal(findGuideTarget(root,{text:'保存'}),newButton);
  closing.removeAttribute('aria-hidden');closing.setAttribute('hidden','');assert.equal(findGuideTarget(root,{label:'イベント名'}),newInput);
  closing.removeAttribute('hidden');assert.equal(findGuideTarget(root,{scope:'.dialog',text:'保存'}),oldButton);
  const uploadLabel=new Node('label',{},'画像'),input=new Node('input',{'aria-label':'画像を追加',type:'file'},'',false);uploadLabel.append(input);root.append(uploadLabel);
  assert.equal(findGuideTarget(root,{label:'画像を追加'}),uploadLabel);
  input.visible=true;input.setAttribute('style','opacity:0;position:absolute;inset:0');
  assert.equal(findGuideTarget(root,{label:'画像を追加'}),uploadLabel,'Transparent native upload inputs highlight their visible label, even with a rect');
  uploadLabel.setAttribute('inert','');assert.equal(findGuideTarget(root,{label:'画像を追加'}),null);
  const switchLabel=new Node('label',{},'試験機能をオンにする'),switchInput=new Node('input',{type:'checkbox',role:'switch',class:'setting-switch','aria-label':'試験機能をオンにする',style:'width:1px;height:1px;clip-path:inset(50%)'});switchLabel.append(switchInput);root.append(switchLabel);
  assert.equal(findGuideTarget(root,{selector:'input[type="checkbox"]'}),switchLabel,'Clipped native switch selectors highlight the usable row');
  assert.equal(findGuideTarget(root,{label:'試験機能をオンにする'}),switchLabel);
  switchLabel.setAttribute('aria-hidden','true');assert.equal(findGuideTarget(root,{selector:'input[type="checkbox"]'}),null);

});

test('the guide waits for a live after-target, observes inert changes and skips closing controls in its Tab loop',async()=>{
  const action=new Node('button',{class:'action'},'開く'),closing=new Node('div',{inert:''}),done=new Node('div',{class:'done'}),closingButton=new Node('button',{},'旧閉じる');closing.append(done,closingButton);
  const first=new Node('button',{},'最初'),last=new Node('button',{},'最後'),host=new Node().append(action,closing),dialogNode=new Node().append(closing,first,last);
  let observeOptions,notify,disconnected=false;const document={activeElement:last};
  const MutationObserver=class{constructor(callback){notify=callback;}observe(_host,options){observeOptions=options;}disconnect(){disconnected=true;}};
  const steps=[{chapter:'イベント',title:'開く',body:'練習',event:'click',target:{selector:'.action'},after:'.done'}];
  const load=loader({MutationObserver,document,window:{setInterval:()=>1,clearInterval(){}}},{'./guideSteps':{managementGuideSteps:steps,chapterStart:()=>0}});
  const Guide=load('management-app/src/ManagementGuide.tsx').default;let renderer;
  await act(async()=>{renderer=create(React.createElement(Guide,{controller:{step:0,topic:null,saveError:false,pause(){},restartChapter(){},next(){}},renderWorkspace:()=>React.createElement('div')}),{createNodeMock:node=>node.props.className==='guide-workspace'?host:node.props.className==='management-guide'?dialogNode:node.type==='h2'?new Node('h2'):null});});
  try{
    const workspace=renderer.root.findByProps({className:'guide-workspace'});
    await act(async()=>workspace.props.onClickCapture({target:action,type:'click'}));
    assert.equal(renderer.root.findByProps({className:'guide-next'}).props.disabled,true,'A retained outgoing after-target is not completion');
    assert.ok(observeOptions.attributeFilter.includes('inert'));assert.ok(observeOptions.attributeFilter.includes('aria-hidden'));
    closing.removeAttribute('inert');await act(async()=>notify());assert.equal(renderer.root.findByProps({className:'guide-next'}).props.disabled,false);
    closing.setAttribute('aria-hidden','true');let prevented=0;
    await act(async()=>renderer.root.findByProps({className:'management-guide'}).props.onKeyDown({key:'Tab',shiftKey:false,preventDefault(){prevented++;}}));
    assert.equal(prevented,1);assert.equal(first.focusCount,1);assert.equal(closingButton.focusCount,0);
  }finally{await act(async()=>renderer.unmount());}assert.equal(disconnected,true);
});

test('changing Reduce Motion during dismissal removes the outgoing surface and releases its pending timer',async()=>{
  const listeners=new Set(),timers=new Map();let next=0;const media={matches:true,addEventListener:(_name,fn)=>listeners.add(fn),removeEventListener:(_name,fn)=>listeners.delete(fn)};
  const window={matchMedia:()=>media,setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)};
  const {SurfacePresence}=loader({window})('management-app/src/SurfaceMotion.tsx');let renderer;
  await act(async()=>{renderer=create(React.createElement(SurfacePresence,null,React.createElement('button',null,'保存')));});
  try{
    await act(async()=>renderer.update(React.createElement(SurfacePresence,null,null)));assert.equal(timers.size,1);assert.equal(renderer.root.findByType('div').props.inert,true);
    media.matches=false;await act(async()=>{for(const listener of listeners)listener();});assert.equal(renderer.toJSON(),null);assert.equal(timers.size,0);
  }finally{await act(async()=>renderer.unmount());}assert.equal(listeners.size,0);
});
