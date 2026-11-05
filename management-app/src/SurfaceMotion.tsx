import {useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';

const motionAllowed=()=>typeof window!=='undefined'&&window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches===true;

function useMotionAllowed() {
  const [allowed,setAllowed]=useState(motionAllowed);
  useLayoutEffect(()=>{
    const media=window.matchMedia?.('(prefers-reduced-motion: no-preference)');
    if(!media)return;
    const update=()=>setAllowed(media.matches);
    update();media.addEventListener?.('change',update);
    return ()=>media.removeEventListener?.('change',update);
  },[]);
  return allowed;
}

/** Keep only the outgoing picture alive. The parent's open/save state changes immediately. */
export function SurfacePresence({children}:{children:ReactNode}) {
  const allowed=useMotionAllowed();
  const visible=Boolean(children);
  const [held,setHeld]=useState<ReactNode>(visible?children:null);
  const closing=!visible&&held!==null&&allowed;
  useLayoutEffect(()=>{
    if(visible){setHeld(children);return;}
    if(!allowed){setHeld(null);return;}
    if(held===null)return;
    // Also finish when CSS animations are unavailable or interrupted.
    const timer=window.setTimeout(()=>setHeld(null),220);
    return ()=>window.clearTimeout(timer);
  },[children,visible,held,allowed]);
  if(!visible&&!closing)return null;
  return <div className={`surface-presence${closing?' surface-closing':''}`} inert={closing?true:undefined} aria-hidden={closing?true:undefined}
    onAnimationEnd={event=>{if(closing&&event.animationName==='surface-backdrop-out')setHeld(null);}}>
    {visible?children:held}
  </div>;
}

export type TicketZoomOrigin={left:number;top:number;width:number;height:number};
export function TicketZoomSurface({origin,children}:{origin:TicketZoomOrigin|null;children:ReactNode}) {
  const allowed=useMotionAllowed();
  const ref=useRef<HTMLDivElement>(null);
  const [style,setStyle]=useState<CSSProperties>();
  useLayoutEffect(()=>{
    if(!origin||!allowed||!ref.current){setStyle(undefined);return;}
    const target=ref.current.getBoundingClientRect();
    if(!target.width||!target.height)return;
    setStyle({
      '--ticket-from-x':`${origin.left+origin.width/2-target.left-target.width/2}px`,
      '--ticket-from-y':`${origin.top+origin.height/2-target.top-target.height/2}px`,
      '--ticket-from-scale':Math.max(.15,Math.min(.9,origin.width/target.width)),
    } as CSSProperties);
  },[origin,allowed]);
  return <div ref={ref} className="ticket-modal ticket-qr-modal ticket-zoom-surface" data-zoom-ready={style?'true':undefined} style={style} onMouseDown={event=>event.stopPropagation()}>{children}</div>;
}
