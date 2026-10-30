import {useEffect,useState} from 'react';
import {loadReservePackage,markReservePrintsSynced} from './reservePrintStore';
import {getFirebaseUid} from './firebaseClient';
import {markReserveTicketsPrinted} from './firebaseData';

export function useReservePrintLedger(eventId:string,enabled:boolean){
  const [state,setState]=useState({eventId:'',confirmed:[] as string[],reserved:[] as string[],unsynced:0});
  useEffect(()=>{
    if(!eventId||!enabled)return;
    let active=true,reading=false,syncing=false;
    const refresh=async()=>{
      if(reading)return;reading=true;
      try{
        const packet=await loadReservePackage(eventId);
        if(!active)return;
        const reserved=packet?.tickets.map(t=>t.id)??[],confirmed=packet?.confirmed??[],pending=confirmed.filter(id=>!packet?.synced?.includes(id));
        setState(old=>old.eventId===eventId&&old.confirmed.join('\0')===confirmed.join('\0')&&old.reserved.join('\0')===reserved.join('\0')&&old.unsynced===pending.length?old:{eventId,confirmed,reserved,unsynced:pending.length});
        if(!pending.length||navigator.onLine===false||syncing)return;
        syncing=true;
        void (async()=>{
          try{
            await getFirebaseUid();if(!active)return;
            await markReserveTicketsPrinted(eventId,pending);
            await markReservePrintsSynced(eventId,pending);
            if(active)void refresh();
          }catch{/* Keep local confirmations and retry on reconnection. */}finally{syncing=false;}
        })();
      }catch{/* A local read failure must not erase the last known ledger. */}finally{reading=false;}
    };
    void refresh();const timer=window.setInterval(()=>void refresh(),3000);
    window.addEventListener?.('online',refresh);
    return()=>{active=false;window.clearInterval(timer);window.removeEventListener?.('online',refresh);};
  },[eventId,enabled]);
  return state.eventId===eventId?state:{eventId,confirmed:[],reserved:[],unsynced:0};
}
