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
async function printNormalTickets(page){
 await page.getByRole('button',{name:'印刷',exact:true}).click();
 await page.getByRole('button',{name:'次へ：印刷範囲を指定'}).click();
 await page.getByRole('button',{name:/この範囲を印刷する/}).click();
}
async function metrics(locator){return locator.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el.firstChild);const s=getComputedStyle(el);return {font:s.fontSize,family:s.fontFamily,weight:s.fontWeight,width:range.getBoundingClientRect().width,card:el.parentElement.getBoundingClientRect().width};});}

test('print opens selection first; only the chosen normal ticket range is sent to print',async()=>{
 const {context,page}=await open(820,'?count=6');
 try{
  const popups=[];
  page.on('popup',popup=>popups.push(popup));
  await page.getByRole('button',{name:'印刷',exact:true}).click();
  assert.equal(popups.length,0,'Opening print must not launch a print dialog');
  assert.equal(await page.locator('.ticket-print-kind-list button').count(),2);
  await page.getByRole('button',{name:'次へ：印刷範囲を指定'}).click();
  assert.equal(popups.length,0,'Choosing the type must not launch a print dialog');
  await page.getByLabel('印刷の開始番号').selectOption('1');
  await page.getByLabel('印刷の終了番号').selectOption('3');
  assert.match(await page.locator('.ticket-print-flow-summary').innerText(),/3枚/);
  const pending=page.waitForEvent('popup');
  await page.getByRole('button',{name:/この範囲を印刷する/}).click();
  const popup=await pending;
  await popup.locator('.ticket-print-sheet[data-artwork-ready="true"]').waitFor();
  const numbers=await popup.locator('.ticket-print-card .ticket-design-number').allTextContents();
  assert.deepEqual(numbers,['002','003','004']);
  await popup.close();
 }finally{await context.close();}
});

test('reserve selection opens the safe reserve workflow without printing anything',async()=>{
 const {context,page}=await open(820,'?count=6');
 try{
  const popups=[];
  page.on('popup',popup=>popups.push(popup));
  await page.getByRole('button',{name:'印刷',exact:true}).click();
  await page.getByRole('button',{name:/予備チケットを印刷/}).click();
  await page.getByRole('button',{name:'次へ：印刷範囲を指定'}).click();
  assert.equal(popups.length,0);
  assert.equal(await page.locator('.ticket-print-flow-reserve').count(),1);
  assert.ok((await page.locator('.ticket-print-flow-reserve').innerText()).includes('予備の指定方法'));
 }finally{await context.close();}
});

test('number glyph proportions match between the editor, actual size and the real print popup at desktop and iPad widths',async()=>{
 for(const width of [1440,820]){
  const {context,page}=await open(width);
  await page.locator('.studio-dock').getByRole('button',{name:/番号/}).click();const size=page.getByLabel('選択パーツのサイズ',{exact:true});await size.focus();await size.press('Home');for(let i=0;i<38;i++)await size.press('ArrowRight');assert.equal(await size.inputValue(),'48');
  const editor=await metrics(page.locator('.ticket-design-card > .ticket-design-number'));
  if(process.env.TICKET_SCREENSHOT_DIR)await page.locator('.ticket-design-card').screenshot({path:process.env.TICKET_SCREENSHOT_DIR+'/ticket-editor-'+width+'.png'});
  const pending=page.waitForEvent('popup');await printNormalTickets(page);const popup=await pending;await popup.waitForSelector('.ticket-print-sheet[data-artwork-ready="true"]');await popup.emulateMedia({media:'print'});
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
   const ready=page.waitForEvent('popup');await printNormalTickets(page);const popup=await ready;await popup.waitForSelector('.ticket-print-sheet[data-artwork-ready="true"]');await popup.emulateMedia({media:'print'});
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
  const ready=page.waitForEvent('popup');await printNormalTickets(page);const original=await ready;await original.waitForSelector('.ticket-print-sheet[data-artwork-ready="true"]');
  const packet=await original.evaluate(()=>({eventId:'reserve',eventName:'RESERVE',preparedAt:new Date().toISOString(),css:document.querySelector('style').textContent,template:document.querySelector('.ticket-print-card').outerHTML,sheetStyle:document.querySelector('.ticket-print-sheet').getAttribute('style')+';--ticket-print-gap:4mm',columns:4,confirmed:[],pending:{id:'batch',ids:Array.from({length:12},(_,i)=>'T'+i)},tickets:Array.from({length:12},(_,i)=>({id:'T'+i,number:String(i+1).padStart(3,'0'),svg:document.querySelector('.ticket-design-qr').innerHTML}))}));
  const pending=page.waitForEvent('popup');await page.evaluate(packet=>window.reserveProbe(packet),packet);const popup=await pending;await popup.waitForSelector('.ticket-print-sheet[data-artwork-ready="true"]');await popup.emulateMedia({media:'print'});
  assert.equal(await popup.locator('.ticket-print-row').count(),6);assert.equal(await popup.locator('.ticket-print-row').first().locator('.ticket-print-card').count(),2);
  const spacing=await popup.locator('.ticket-print-row').evaluateAll(rows=>rows.map(row=>({gap:getComputedStyle(row).gap,margin:getComputedStyle(row).marginBottom})));
  assert.ok(spacing.every(row=>row.gap==='0px'&&row.margin==='0px'));
  const pdf=await popup.pdf({preferCSSPageSize:true});assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length,2);
 }finally{await context.close();}
});


test('the visible background edges meet when the saved card ratio would add white bands',async()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="#29a6b0"/><path d="M0 0h400v100H0z" fill="none" stroke="#c93232" stroke-width="6"/></svg>';
 design=JSON.stringify({backgroundImage:'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'),title:'FULL ART',titleX:30,titleY:50,titleSize:12,numberSize:18,numberX:30,numberY:60,qrX:76,qrY:50,qrSize:16,textReferenceWidth:400,printWidthMm:90,cardRatio:'16:9',cardsPerRow:2});
 const {context,page}=await open(1440,'?count=23');
 try{
  const ready=page.waitForEvent('popup');await printNormalTickets(page);const popup=await ready;await popup.waitForSelector('.ticket-print-sheet[data-artwork-ready="true"]');await popup.emulateMedia({media:'print'});
  const geometry=await popup.locator('.ticket-print-card').evaluateAll(cards=>cards.map(card=>{
   const rect=card.getBoundingClientRect(),canvas=card.querySelector('.ticket-print-artwork').getBoundingClientRect();
   const top=canvas.top+(canvas.height-canvas.width/4)/2,bottom=top+canvas.width/4;
   const layers=[...card.querySelectorAll('.ticket-design-number,.ticket-design-qr,.ticket-design-title')].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
   return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,paintedTop:top,paintedBottom:bottom,layers};
  }));
  assert.equal(geometry.length,23);
  assert.equal(await popup.locator('.ticket-design-number').first().evaluate(el=>el.style.fontSize),'4.05mm');
  assert.ok(Math.abs(await popup.locator('.ticket-design-qr').first().evaluate(el=>el.getBoundingClientRect().width)-14.4*96/25.4)<.1,'QR physical size is unchanged');
  for(const card of geometry){
   assert.ok(Math.abs(card.paintedTop-card.top)<.05);assert.ok(Math.abs(card.paintedBottom-card.bottom)<.05,'no white band between artwork and cutting edge');
   for(const layer of card.layers)assert.ok(layer.left>=card.left-.1&&layer.right<=card.right+.1&&layer.top>=card.top-.1&&layer.bottom<=card.bottom+.1,'all text and the complete QR stay inside the cut ticket');
  }
  assert.ok(Math.abs(geometry[2].paintedTop-geometry[0].paintedBottom)<.05,'adjacent artwork must touch');
  const pdf=await popup.pdf({preferCSSPageSize:true,printBackground:true,...(process.env.TICKET_PDF_DIR?{path:process.env.TICKET_PDF_DIR+'/artwork-no-bands.pdf'}:{})});
  assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length,1);
  if(process.env.TICKET_SCREENSHOT_DIR)await popup.locator('.ticket-print-sheet').screenshot({path:process.env.TICKET_SCREENSHOT_DIR+'/artwork-no-bands.png'});
 }finally{await context.close();}
});


test('packing preserves layers outside the background and also works when popups are blocked',async()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="#29a6b0"/></svg>';
 design=JSON.stringify({backgroundImage:'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'),title:'KEEP THIS TITLE',titleX:35,titleY:15,titleSize:18,numberSize:18,numberX:30,numberY:60,qrX:76,qrY:50,qrSize:16,textReferenceWidth:400,printWidthMm:90,cardRatio:'16:9',cardsPerRow:2});
 const {context,page}=await open(1440,'?count=4');
 try{
  await page.evaluate(()=>{window.open=()=>null;window.print=()=>{window.fallbackPrints=(window.fallbackPrints||0)+1;};});
  await printNormalTickets(page);await page.waitForFunction(()=>window.fallbackPrints===1);await page.emulateMedia({media:'print'});
  const geometry=await page.locator('[data-print-copy] .ticket-print-card').evaluateAll(cards=>cards.map(card=>{
   const rect=card.getBoundingClientRect();return {top:rect.top,bottom:rect.bottom,layers:[...card.querySelectorAll('.ticket-design-number,.ticket-design-title,.ticket-design-qr')].map(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom};})};
  }));
  assert.equal(geometry.length,4);for(const card of geometry)for(const layer of card.layers)assert.ok(layer.top>=card.top-.1&&layer.bottom<=card.bottom+.1,'keep the title even when it extends beyond the background image');
  assert.equal(await page.locator('[data-print-copy] [data-artwork-packed]').count(),4);
  await page.evaluate(()=>dispatchEvent(new Event('afterprint')));assert.equal(await page.locator('[data-print-copy]').count(),0);await page.emulateMedia({media:'screen'});await page.locator('.studio-dock').getByRole('button',{name:/番号/}).click();
 }finally{await context.close();}
});
