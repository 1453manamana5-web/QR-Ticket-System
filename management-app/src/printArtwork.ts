/** Remove only the empty bands introduced by background-size:contain.
 * Keep a fixed-size inner canvas so QR squares, text and images never stretch. */
export async function preparePrintedArtwork(sheet:HTMLElement,win:Window):Promise<void>{
  if(typeof sheet.querySelectorAll!=="function")return;
  try{
    const cards=Array.from(sheet.querySelectorAll<HTMLElement>('.ticket-print-row > .ticket-print-card'));
    if(!cards.length||cards.some(card=>card.dataset.artworkPacked))return;
    const style=win.getComputedStyle(cards[0]),background=style.backgroundImage;
    const url=/^url\(["']?(.*?)["']?\)$/.exec(background)?.[1];
    if(!url||style.backgroundSize!=="contain")return;
    const image=await new Promise<HTMLImageElement|null>(resolve=>{
      const image=win.document.createElement('img'),timer=setTimeout(()=>resolve(null),4000);
      image.onload=()=>{clearTimeout(timer);resolve(image);};image.onerror=()=>{clearTimeout(timer);resolve(null);};image.src=url;
    });
    if(!image?.naturalWidth||!image.naturalHeight)return;
    await win.document.fonts?.ready;
    const added=Array.from(sheet.querySelectorAll('img'));
    await Promise.all(added.filter(img=>!img.complete).map(img=>new Promise<void>(resolve=>{
      const timer=setTimeout(resolve,4000),done=()=>{clearTimeout(timer);resolve();};img.addEventListener('load',done,{once:true});img.addEventListener('error',done,{once:true});
    })));
    if(added.some(img=>!img.complete||!img.naturalWidth))return;
    const first=cards[0].getBoundingClientRect(),width=first.width,height=first.height;
    if(!width||!height)return;
    const scale=Math.min(width/image.naturalWidth,height/image.naturalHeight);
    const imageWidth=image.naturalWidth*scale,imageHeight=image.naturalHeight*scale;
    let left=(width-imageWidth)/2,top=(height-imageHeight)/2,right=left+imageWidth,bottom=top+imageHeight;
    const layers='.ticket-design-qr,.ticket-design-number,.ticket-design-title,.studio-image';
    // Use the union across every ticket: a longer number must never be cut off.
    for(const card of cards){
      const rect=card.getBoundingClientRect(),css=win.getComputedStyle(card);
      if(css.backgroundImage!==background||Math.abs(rect.width-width)>.1||Math.abs(rect.height-height)>.1)return;
      for(const layer of card.querySelectorAll<HTMLElement>(layers)){
        const r=layer.getBoundingClientRect();if(!r.width||!r.height)continue;
        // Respect the existing canvas clipping of intentionally off-canvas layers.
        left=Math.min(left,Math.max(0,r.left-rect.left-.25));top=Math.min(top,Math.max(0,r.top-rect.top-.25));
        right=Math.max(right,Math.min(width,r.right-rect.left+.25));bottom=Math.max(bottom,Math.min(height,r.bottom-rect.top+.25));
      }
    }
    // Background edges meet exactly; only drawn layers receive a subpixel safety guard.
    if(left<.5&&top<.5&&width-right<.5&&height-bottom<.5)return;
    const cropWidth=right-left,cropHeight=bottom-top;
    const backgroundStyle={backgroundImage:style.backgroundImage,backgroundSize:style.backgroundSize,backgroundPosition:style.backgroundPosition,backgroundRepeat:style.backgroundRepeat,backgroundColor:style.backgroundColor};
    for(const card of cards){
      const inner=win.document.createElement('div');
      inner.className='ticket-print-artwork';
      Object.assign(inner.style,{position:'absolute',left:`${-left}px`,top:`${-top}px`,width:`${width}px`,height:`${height}px`,overflow:'hidden',boxSizing:'border-box',...backgroundStyle});
      while(card.firstChild)inner.appendChild(card.firstChild);
      card.appendChild(inner);card.style.backgroundImage='none';
      card.style.setProperty('--ticket-print-width',`${cropWidth}px`);card.style.setProperty('--ticket-print-height',`${cropHeight}px`);
      card.dataset.artworkPacked='true';
    }
  }catch(error){console.warn('印刷の余白調整を完了できませんでした。元の配置を使用します。',error);}
  finally{sheet.dataset.artworkReady='true';}
}
