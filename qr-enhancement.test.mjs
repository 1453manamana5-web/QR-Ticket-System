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
const {findMotionFocus,chooseDetailedCrop,boostQrContrast}=helper;

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
  assert.ok(data[0]<40);
  assert.ok(data[127*4]>160);
});
