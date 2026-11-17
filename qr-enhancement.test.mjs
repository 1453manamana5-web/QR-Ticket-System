import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const ts=require('typescript');
const source=readFileSync(new URL('./reception-app/src/qrEnhancement.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{
  module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022
}}).outputText;
const helper={};
new Function('exports','require',compiled)(helper,require);
const {findMotionFocus,chooseDetailedCrop,boostQrContrast,adaptiveQrThreshold}=helper;

function pixels(w,h,value=35) {
  const data=new Uint8ClampedArray(w*h*4);
  for(let i=0;i<data.length;i+=4){
    data[i]=data[i+1]=data[i+2]=value;
    data[i+3]=255;
  }
  return data;
}
test('a small moving ticket-like patch suggests a position without calling it a QR',()=>{
  const w=64,h=36,prev=pixels(w,h),next=pixels(w,h);
  for(let y=18;y<25;y++)for(let x=12;x<24;x++){
    const i=(y*w+x)*4;
    next[i]=next[i+1]=next[i+2]=220;
  }
  const focus=findMotionFocus(prev,next,w,h);
  assert.ok(focus);
  assert.ok(Math.abs(focus.x-18/w)<0.03);
  assert.ok(Math.abs(focus.y-21.5/h)<0.04);
});
test('stationary scenes and global exposure changes do not create false focus',()=>{
  const blank=pixels(64,36);
  assert.equal(findMotionFocus(blank,blank,64,36),null);
  assert.equal(findMotionFocus(blank,pixels(64,36,245),64,36),null);
  assert.equal(findMotionFocus(null,blank,64,36),null);
  assert.equal(findMotionFocus(blank,pixels(10,10),64,36),null);
});
test('native crops remain in bounds at all phases and on rotated iPads',()=>{
  for(const [w,h] of [[1920,1080],[1080,1920],[1280,720]])for(let n=0;n<20;n++){
    const crop=chooseDetailedCrop(w,h,n,{x:.99,y:.01});
    assert.ok(crop);
    assert.ok(crop.x>=0&&crop.y>=0);
    assert.ok(crop.x+crop.size<=w);
    assert.ok(crop.y+crop.size<=h);
    assert.ok(crop.size<=880);
  }
  assert.equal(chooseDetailedCrop(800,600,1,null),null);
});
test('tracked focus has priority sometimes but scanning still sweeps',()=>{
  const focused=chooseDetailedCrop(1920,1080,3,{x:.9,y:.4});
  const untracked=chooseDetailedCrop(1920,1080,3,null);
  assert.notEqual(focused.x,untracked.x);
  const sweep=chooseDetailedCrop(1920,1080,4,{x:.9,y:.4});
  assert.deepEqual(sweep,chooseDetailedCrop(1920,1080,4,null));
});
test('contrast rescue preserves alpha and enlarges a compressed range',()=>{
  const data=new Uint8ClampedArray(128*4);
  for(let i=0;i<128;i++){
    const v=50+Math.round(i*100/127);
    data[i*4]=data[i*4+1]=data[i*4+2]=v;
    data[i*4+3]=255;
  }
  boostQrContrast({data});
  assert.equal(data[3],255);
  assert.equal(data[127*4+3],255);
  assert.ok(data[0]<50);
  assert.ok(data[127*4]>160);
  assert.ok(data[127*4]-data[0]>130);
});

test('adaptive threshold rescues uneven backgrounds without changing alpha',()=>{
  const w=40,h=32,data=pixels(w,h,150);
  for(let y=12;y<17;y++)for(let x=15;x<20;x++){
    const i=(y*w+x)*4;
    data[i]=data[i+1]=data[i+2]=20;
  }
  adaptiveQrThreshold({data,width:w,height:h});
  assert.equal(data[(14*w+17)*4],0);
  assert.equal(data[(3*w+3)*4],255);
  assert.equal(data[(14*w+17)*4+3],255);
});

function prepareWorker(fakeDecode){
  const workerSource=readFileSync(new URL('./reception-app/src/qrDecodeWorker.ts',import.meta.url),'utf8');
  const workerCompiled=ts.transpileModule(workerSource,{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,
    esModuleInterop:true
  }}).outputText;
  const output=[];
  const scope={onmessage:null,postMessage:message=>output.push(message)};
  new Function('exports','require','self',workerCompiled)({},name=>{
    if(name==='jsqr')return {__esModule:true,default:fakeDecode};
    if(name==='./qrEnhancement')return helper;
    throw Error('Unexpected worker dependency: '+name);
  },scope);
  return {scope,output};
}
test('worker returns a QR on the first pass without unnecessary enhancements',()=>{
  let calls=0;
  const {scope,output}=prepareWorker(()=>{
    calls++;
    return {data:'ticket-42',location:{
      topLeftCorner:{x:10,y:20},topRightCorner:{x:30,y:20},
      bottomLeftCorner:{x:10,y:40},bottomRightCorner:{x:30,y:40}
    }};
  });
  scope.onmessage({data:{id:3,width:100,height:100,
    pixels:pixels(100,100).buffer,detailed:true}});
  assert.equal(calls,1);
  assert.deepEqual(output,[{id:3,text:'ticket-42',x:0.2,y:0.3}]);
});
test('worker tries expensive rescue only for failed detail images',()=>{
  let calls=0;
  const {scope,output}=prepareWorker(()=>{
    calls++;
    return null;
  });
  const image=()=>pixels(64,64).buffer;
  scope.onmessage({data:{id:1,width:64,height:64,pixels:image(),detailed:false}});
  assert.equal(calls,1);
  scope.onmessage({data:{id:2,width:64,height:64,pixels:image(),detailed:true}});
  assert.equal(calls,4);
  assert.deepEqual(output,[{id:1,text:null},{id:2,text:null}]);
  scope.onmessage({data:{id:3,width:64,height:64,pixels:new ArrayBuffer(5),detailed:true}});
  assert.equal(calls,4);
  assert.deepEqual(output.at(-1),{id:3,text:null});
});
