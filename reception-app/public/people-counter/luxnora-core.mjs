export const signals = Object.freeze({
  camera:"カメラ・映像", inference:"認識処理", storage:"端末内保存",
  network:"通信・同期", configuration:"運用設定",
});
export function recoveryDecision({verified,visible,tracking,attempts,enabled}) {
  return Boolean(verified && visible && tracking===0 && attempts===0 && enabled);
}
export function recoveryBudget(attempts,now,verifiedAt) {
  const recent=attempts.filter(at=>now-at>=0&&now-at<3600000);
  const ready=recent.length===0||(recent.length<2&&verifiedAt!==null&&
    verifiedAt>=recent.at(-1)&&now-verifiedAt>=600000);
  return {recent,ready};
}
export function appendActivity(history,item) {
  if (!Object.hasOwnProperty.call(signals,item.reason) ||
      !["checking","recovering","verified","failed","continued"].includes(item.state) ||
      !Number.isFinite(item.at)) return history;
  const last=history.at(-1);
  if (last && last.reason===item.reason && last.state===item.state && item.at-last.at<60000) return history;
  return [...history.slice(-39),{at:item.at,reason:item.reason,state:item.state}];
}
