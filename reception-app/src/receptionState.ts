import type {LocalEventData} from "@qr-ticket-system/shared";
export type Screen="registration"|"auth"|"authScan"|"confirm"|"preparing"|"ready"|"reception"|"test";
export type Registration={approved:boolean;status:"online"|"offline"|"pending";name:string;eventId?:string};
export type ReceptionPhase="unregistered"|"approval-pending"|"preparing"|"ready"|"receiving"|"stopped";
export type ReceptionState={screen:Screen;registration:Registration|null;localEvent:LocalEventData|null;remoteStopped:boolean;stopped:boolean};
export type ReceptionAction=
  | {type:"registration";value:Registration|null}
  | {type:"event";value:LocalEventData|null}
  | {type:"screen";value:Screen}
  | {type:"remote-stop";value:boolean};
export const initialReceptionState:ReceptionState={screen:"registration",registration:null,localEvent:null,remoteStopped:false,stopped:false};
function matches(registration:Registration|null,event:LocalEventData|null):boolean{
  return registration?.approved===true && event?.dataReady===true &&
    registration.eventId===event.event.eventId;
}
export function canReceive(state:ReceptionState):boolean{
  return state.screen==="reception" && !state.remoteStopped && matches(state.registration,state.localEvent);
}
export function receptionPhase(state:ReceptionState):ReceptionPhase{
  if(!state.registration)return "unregistered";
  if(!state.registration.approved)return "approval-pending";
  if(state.remoteStopped||state.stopped)return "stopped";
  if(canReceive(state))return "receiving";
  if(state.screen==="ready"&&matches(state.registration,state.localEvent))return "ready";
  return "preparing";
}
export function receptionReducer(state:ReceptionState,action:ReceptionAction):ReceptionState{
  switch(action.type){
    case "registration":{
      const registration=action.value;
      const eventChanged=state.registration?.eventId!==registration?.eventId;
      if(!registration?.approved)return {...state,registration,screen:"registration",localEvent:null,remoteStopped:false,stopped:false};
      if(eventChanged)return {...state,registration,screen:"auth",localEvent:null,remoteStopped:false,stopped:false};
      return {...state,registration,screen:state.screen==="registration"?"auth":state.screen};
    }
    case "event":{
      if(!action.value)return {...state,localEvent:null,screen:state.registration?.approved?"auth":"registration",stopped:false};
      if(!matches(state.registration,action.value))return state;
      return {...state,localEvent:action.value};
    }
    case "screen":{
      if(!state.registration?.approved)return state.screen==="registration"?state:{...state,screen:"registration"};
      if((action.value==="ready"||action.value==="reception")&&!matches(state.registration,state.localEvent))return state;
      if(action.value==="reception"&&(state.remoteStopped||!["ready","reception"].includes(state.screen)))return state;
      return {...state,screen:action.value,stopped:action.value==="ready"&&state.screen==="reception"?true:action.value==="reception"?false:state.stopped};
    }
    case "remote-stop":return {...state,remoteStopped:action.value};
  }
}
