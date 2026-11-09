import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
let browser,server,origin;
let design=JSON.stringify({title:'Print check',numberSize:20,textReferenceWidth:400,printWidthMm:100});
const subscribers=new Set();
before(async()=>{
 const built=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Designer,{TicketQrPreview} from './management-app/src/TicketDesigner.tsx';import './management-app/src/styles.css';import {openReservePrint} from './management-app/src/ReservePrinting.tsx';window.reserveProbe=packet=>openReservePrint(packet,window.open('','_blank'));
 const subscribe=(next,error)=>{const source=new EventSource('/design');source.onmessage=e=>next(JSON.parse(e.data));source.onerror=error;return()=>source.close();};
 const save=async value=>{const response=await fetch('/design',{method:'POST',body:value});if(!response.ok)throw Error('Save failed');};
 const props={eventId:'browser-print',eventName:'Print check',subscribeSharedDesign:subscribe};
 createRoot(document.getElementById('root')).render(location.search.includes('qr')?<TicketQrPreview {...props} ticketNumber="001" qrValue="T1"/>:<Designer {...props} tickets={Array.from({length:Number(new URLSearchParams(location.search).get('count')||1)},(_,i)=>({id:'T'+(i+1),qrNumber:String(i+1).padStart(3,'0'),valid:true,status:'unused'}))} qrValue={t=>t.id} onClose={()=>{}} saveSharedDesign={save}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,outfile:'/tmp/fixture.js',jsx:'automatic',define:{'import.meta.env':'{}'},logLevel:'silent'});
 const files=new Map(built.outputFiles.map(file=>['/'+file.path.split('/').at(-1),file.contents]));
 server=createServer(async(req,res)=>{
  if(req.url==='/design'){
   if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;design=body;for(const sub of subscribers)sub.write(`data: ${JSON.stringify(design)}\n\n`);res.end('ok');return;}
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});subscribers.add(res);res.write(`data: ${JSON.stringify(design)}\n\n`);req.on('close',()=>subscribers.delete(res));return;
  }
  const file=files.get(req.url);res.setHeader('Content-Type',req.url.endsWith('.js')?'application/javascript':req.url.endsWith('.css')?'text/css':'text/html');
  res.end(file??'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.TICKET_TEST_CHROMIUM?{executablePath:process.env.TICKET_TEST_CHROMIUM}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
});
after(async()=>{await browser?.close();for(const res of subscribers)res.end();await new Promise(resolve=>server?.close(resolve));});
async function open(width,query=''){
 const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});context.setDefaultTimeout(10000);
 await context.addInitScript(()=>{window.print=()=>{};});const page=await context.newPage();await page.goto(origin+query);await page.waitForSelector('.ticket-design-number');return {context,page};
}
async function metrics(locator){return locator.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el.firstChild);const s=getComputedStyle(el);return {font:s.fontSize,family:s.fontFamily,weight:s.fontWeight,width:range.getBoundingClientRect().width,card:el.parentElement.getBoundingClientRect().width};});}
test('number glyph proportions match between the editor, actual size and the real print popup at desktop and iPad widths',async()=>{
 for(const width of [1440,820]){
  const {context,page}=await open(width);
  await page.locator('.studio-dock').getByRole('button',{name:/番号/}).click();const size=page.getByLabel('選択パーツのサイズ',{exact:true});await size.focus();await size.press('Home');for(let i=0;i<38;i++)await size.press('ArrowRight');assert.equal(await size.inputValue(),'48');
  const editor=await metrics(page.locator('.ticket-design-card > .ticket-design-number'));
  if(process.env.TICKET_SCREENSHOT_DIR)await page.locator('.ticket-design-card').screenshot({path:process.env.TICKET_SCREENSHOT_DIR+'/ticket-editor-'+width+'.png'});
  const pending=page.waitForEvent('popup');await page.getByRole('button',{name:'印刷',exact:true}).click();const popup=await pending;await popup.waitForSelector('.ticket-design-number');await popup.emulateMedia({media:'print'});
  await popup.evaluate(()=>document.fonts.ready);
  const printed=await metrics(popup.locator('.ticket-design-number').first());
  const usedFonts=[];
  for(const [p,selector] of [[page,'.ticket-design-card > .ticket-design-number'],[popup,'.ticket-design-number']]){
   const cdp=await p.context().newCDPSession(p);await cdp.send('DOM.enable');await cdp.send('CSS.enable');
   const dom=await cdp.send('DOM.getDocument'),node=await cdp.send('DOM.querySelector',{nodeId:dom.root.nodeId,selector});
   const {fonts}=await cdp.send('CSS.getPlatformFontsForNode',{nodeId:node.nodeId});usedFonts.push(fonts.map(font=>font.postScriptName).sort());await cdp.detach();
  }
  assert.deepEqual(usedFonts[0],usedFonts[1],'the actual rendered font must match, as well as its CSS declaration');
  if(process.env.TICKET_SCREENSHOT_DIR)await popup.locator('.ticket-print-card').screenshot({path:process.env.TICKET_SCREENSHOT_DIR+'/ticket-printed-'+width+'.png'});
  await page.getByRole('button',{name:'実寸確認',exact:true}).click();const actual=await metrics(page.locator('.ticket-actual-size-preview > .ticket-design-number'));
  console.log(JSON.stringify({viewport:width,editor,actual,printed}));
  for(const other of [actual,printed])assert.ok(Math.abs((editor.width/editor.card)/(other.width/other.card)-1)<0.02,'number proportions must match the edited design');
  assert.equal(editor.family,printed.family);assert.equal(editor.weight,printed.weight);
  await context.close();
 }
});
test('Save changes another already open browser and QR preview with separate browser storage',async()=>{
 const a=await open(1440),b=await open(820),qr=await open(820,'?qr');
 try{
  await a.page.locator('.studio-dock').getByRole('button',{name:/文字/}).click();await a.page.getByLabel('イベント名の文字',{exact:true}).fill('Saved on the first device');
  await a.page.getByRole('button',{name:'保存',exact:true}).click();
  await b.page.getByText('Saved on the first device',{exact:true}).first().waitFor();await qr.page.getByText('Saved on the first device',{exact:true}).first().waitFor();
  assert.equal(JSON.parse(await b.page.evaluate(()=>localStorage.getItem('qr-management-ticket-design-id-browser-print'))).title,'Saved on the first device');
 }finally{await a.context.close();await b.context.close();await qr.context.close();}
});


test('tickets meet edge to edge and move intact to the next A4 sheet, including old saved spacing',async()=>{
 for(const [width,height,requested,columns,count] of [[90,50.625,2,2,23],[100,60,4,1,11],[48,60,4,4,35]]){
  design=JSON.stringify({title:'CUT-CHECK',cardRatio:'custom',customWidth:width,customHeight:height,printWidthMm:width,printHeightMm:height,printGapMm:4,cardsPerRow:requested,numberSize:24,textReferenceWidth:400});
  const {context,page}=await open(1440,'?count='+count);
  try{
   const ready=page.waitForEvent('popup');await page.getByRole('button',{name:'印刷',exact:true}).click();const popup=await ready;await popup.waitForSelector('.ticket-print-card');await popup.emulateMedia({media:'print'});
   const rows=await popup.locator('.ticket-print-row').evaluateAll(rows=>rows.map(row=>({gap:getComputedStyle(row).gap,margin:getComputedStyle(row).marginBottom,cards:[...row.children].map(card=>{const r=card.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})})));
   assert.equal(rows[0].cards.length,columns);
   for(let i=0;i<rows.length;i++){
    assert.equal(rows[i].gap,'0px');assert.equal(rows[i].margin,'0px');
    for(let j=1;j<rows[i].cards.length;j++)assert.ok(Math.abs(rows[i].cards[j].x-rows[i].cards[j-1].x-rows[i].cards[j-1].width)<0.02);
    if(i)assert.ok(Math.abs(rows[i].cards[0].y-rows[i-1].cards[0].y-rows[i-1].cards[0].height)<0.02);
    assert.ok(rows[i].cards.reduce((sum,card)=>sum+card.width,0)<=194*96/25.4+0.1,'row must fit inside the safe A4 width');
   }
   const pdf=await popup.pdf({preferCSSPageSize:true,printBackground:true,...(process.env.TICKET_PDF_DIR?{path:process.env.TICKET_PDF_DIR+'/tickets-'+width+'.pdf'}:{})});
   const pages=(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length;
   const expected=Math.ceil(Math.ceil(count/columns)/Math.floor(281/height));assert.equal(pages,expected,'rows must not split or create blank pages');
   console.log(JSON.stringify({width,height,columns,count,pages,gap:0}));
  }finally{await context.close();}
 }
});


test('old offline reserve templates also print without gaps and fit within A4',async()=>{
 design=JSON.stringify({title:'RESERVE',printWidthMm:90,cardsPerRow:4,numberSize:24,textReferenceWidth:400});
 const {context,page}=await open(1440,'?count=12');
 try{
  const ready=page.waitForEvent('popup');await page.getByRole('button',{name:'印刷',exact:true}).click();const original=await ready;await original.waitForSelector('.ticket-print-card');
  const packet=await original.evaluate(()=>({eventId:'reserve',eventName:'RESERVE',preparedAt:new Date().toISOString(),css:document.querySelector('style').textContent,template:document.querySelector('.ticket-print-card').outerHTML,sheetStyle:document.querySelector('.ticket-print-sheet').getAttribute('style')+';--ticket-print-gap:4mm',columns:4,confirmed:[],pending:{id:'batch',ids:Array.from({length:12},(_,i)=>'T'+i)},tickets:Array.from({length:12},(_,i)=>({id:'T'+i,number:String(i+1).padStart(3,'0'),svg:document.querySelector('.ticket-design-qr').innerHTML}))}));
  const pending=page.waitForEvent('popup');await page.evaluate(packet=>window.reserveProbe(packet),packet);const popup=await pending;await popup.waitForSelector('.ticket-print-card');await popup.emulateMedia({media:'print'});
  assert.equal(await popup.locator('.ticket-print-row').count(),6);assert.equal(await popup.locator('.ticket-print-row').first().locator('.ticket-print-card').count(),2);
  const spacing=await popup.locator('.ticket-print-row').evaluateAll(rows=>rows.map(row=>({gap:getComputedStyle(row).gap,margin:getComputedStyle(row).marginBottom})));
  assert.ok(spacing.every(row=>row.gap==='0px'&&row.margin==='0px'));
  const pdf=await popup.pdf({preferCSSPageSize:true});assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length,2);
 }finally{await context.close();}
});
