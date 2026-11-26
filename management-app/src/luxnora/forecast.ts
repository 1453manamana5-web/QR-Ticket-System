export type Forecast = {at:number;occupancy:number;low:number;high:number;entries:number}[];
const minute=60000;
export function forecast(input:{now:number;opened:number;ends?:number;healthy:boolean;
  total:number;occupancy:number;events:{at:number;direction:"in"|"out";invalid:boolean;person:string}[]}):Forecast {
  const {now,opened,ends,healthy,total,occupancy,events}=input;
  const base=Math.floor(now/(5*minute))*5*minute;
  if (!healthy||base-opened<20*minute||occupancy<0||(ends!==undefined&&ends<=now)) return [];
  const bins=Array.from({length:4},()=>({in:0,out:0}));
  for(const event of events) {
    const i=Math.floor((event.at-(base-20*minute))/(5*minute));
    if(i>=0&&i<4&&!event.invalid&&event.person==="visitor") bins[i][event.direction]++;
  }
  if(bins.reduce((sum,bin)=>sum+bin.in+bin.out,0)<6) return [];
  const mean=(values:number[])=>values.reduce((sum,value)=>sum+value,0)/values.length;
  function predict(values:number[]) {
    const smooth=(v:number[])=>v.reduce((estimate,actual)=>.45*actual+.55*estimate);
    const test=values.slice(0,3);
    return Math.abs(smooth(test)-values[3])<Math.abs(mean(test)-values[3])?smooth(values):mean(values);
  }
  const enter=predict(bins.map(bin=>bin.in)),exit=predict(bins.map(bin=>bin.out));
  const pairs=bins.map(bin=>bin.in-bin.out),avg=mean(pairs);
  const spread=Math.max(1,Math.sqrt(mean(pairs.map(value=>(value-avg)**2))));
  const horizons=[5,15,30].map(value=>now+value*minute).filter(at=>at<=(ends??Infinity));
  if(ends!==undefined&&ends-now<=120*minute&&!horizons.includes(ends)) horizons.push(ends);
  return horizons.map(at=>{
    const steps=(at-now)/(5*minute),middle=Math.max(0,occupancy+steps*(enter-exit));
    const width=1.65*spread*Math.sqrt(steps)+Math.abs(enter-exit)*steps*.25;
    return {at,occupancy:Math.round(middle),low:Math.max(0,Math.floor(middle-width)),high:Math.ceil(middle+width),entries:total+Math.round(steps*enter)};
  });
}
