export const initialConnection = {label:"状態不明",passes:0,failures:0,lastSeen:null};

export function observeConnection(previous,{success,roundTrip=0,offline=false,now=Date.now()}) {
  if (success) {
    const passes=previous.passes+1;
    const recovering=["オフライン","不安定","再接続中"].includes(previous.label);
    return {label:recovering && passes<2 ? "再接続中" : roundTrip>2500 ? "遅延" : "正常",
      passes:Math.min(passes,2),failures:0,lastSeen:now};
  }
  const failures=Math.min(previous.failures+1,3);
  const label=offline||failures>=3?"オフライン":failures>=2||previous.label==="再接続中"?"不安定":previous.label;
  return {label,passes:0,failures,lastSeen:previous.lastSeen};
}
