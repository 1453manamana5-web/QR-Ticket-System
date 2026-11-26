export const knowledge = {
  occupancy: ["今何人いる", "今何人おる", "部屋にどれくらい人がいる", "現在の滞在人数", "残ってる人は何人"],
  entries: ["今日何人来た", "何人入りましたか", "入った人数", "来場者の累計は", "今日の来場回数"],
  exits: ["何人出た", "帰った人の数", "退場者数", "何人退出した"],
  dwell: ["平均滞在時間", "どのくらい長居", "みんなどれくらい滞在してる"],
  stations: ["端末の状態を確認", "入口の調子はどう", "出口のカメラを調べて", "受付は動いている", "同期できてる"],
  issues: ["なんか人数おかしくない", "記録に異常はある", "計測漏れがないか確認", "数字が合わない"],
  forecast: ["この後混みそう", "混雑予測を見せて", "これからの人数予想", "何分後に混む"],
  briefing: ["今日の結果まとめといて", "今の状況をまとめて", "開催結果を報告して", "運営の状況"],
  routine: ["入口端末をしばらく見守って","問題が起きたら対応して","出口の通信を監視して"],
  readiness: ["もう開場できる", "準備できたか見て", "開場前のチェック", "始める準備はできた"],
  compare: ["去年より少なくない", "前年度と比べて", "去年との差を知りたい", "開催日ごとに比較"],
  graph: ["グラフにして", "グラフを表示して", "入退場の推移を見せて", "チャート開いて"],
  records: ["通過記録を開いて", "入退場履歴を見せて", "記録画面へ移動"],
  event: ["開催設定を開いて", "開場時間を変更して", "イベント編集画面", "閉場の設定を見せて"],
} as const;
export type Intent = keyof typeof knowledge;
export type Plan = {intent:Intent;role?:"in"|"out";period?:"am"|"pm"|number;focus:boolean;readOnly:boolean;operation?:"open"|"close";schedule?:{field:"start"|"end";time:string}};
export type Interpretation = {plans:Plan[];message?:string;reset?:boolean};

const normalize = (raw:string) => raw.normalize("NFKC").toLowerCase().replace(/[\s？！?!。]/g,"")
  .replace(/おおよそ|だいたい/g,"").replace(/きょう|本日/g,"今日").replace(/いま/g,"今")
  .replace(/入場者|来客数/g,"来場者").replace(/デバイス|ipad/g,"端末").replace(/カメラ―/g,"カメラ");
function grams(value:string) {
  const result = new Set<string>();
  for (const n of [1,2,3]) for(let i=0;i+n<=value.length;i++) result.add(value.slice(i,i+n));
  return result;
}
const samples = (Object.entries(knowledge) as [Intent,readonly string[]][]).flatMap(([intent,examples]) =>
  examples.map(text => ({intent,text:normalize(text),features:grams(normalize(text))})));
export function classify(value:string):Intent|undefined {
  const features=grams(value);
  const ranked=new Map<Intent,number>();
  for (const {intent,features:known,text} of samples) {
    let common=0;
    for(const item of features) if(known.has(item)) common+=item.length;
    const score=value.includes(text)?.93:common/(known.size+features.size);
    ranked.set(intent,Math.max(ranked.get(intent)??0,score));
  }
  const [first,second]=[...ranked].sort((a,b)=>b[1]-a[1]);
  return first[1]>=.34&&first[1]-second[1]>=.055?first[0]:undefined;
}
export function interpret(raw:string,previous?:Plan):Interpretation {
  if (raw.length>320) return {plans:[],message:"一度に入力できるのは320文字までです。"};
  if (/取り消|キャンセル|やっぱりいい|なしで$/.test(raw)) return {plans:[],reset:true,message:"依頼を取り消しました。"};
  const readOnly=/変えない|変更しない|触らない|そのまま|見るだけ|確認だけ|操作しない/.test(raw);
  if (/削除|消去|権限変更|管理者にして|無効化/.test(raw))
    return {plans:[],message:"この操作は該当する管理画面から確認してください。"};
  const clauses=raw.split(/(?:[。\n；;]|それから|そのあと|そして|続けて)/).map(normalize).filter(Boolean);
  if (clauses.length>4) return {plans:[],message:"一度に4件まで確認できます。"};
  const plans:Plan[]=[];
  for(const clause of clauses) {
    const prior=plans.at(-1)??previous;
    const role=clause.includes("入口")?"in":clause.includes("出口")?"out":undefined;
    const relative=clause.match(/(?:直近|過去)(\d{1,2})(分|時間)/);
    const period=clause.includes("午前")?"am":clause.includes("午後")?"pm":relative?Math.min(1440,Number(relative[1])*(relative[2]==="時間"?60:1)):undefined;
    const hours=/\d{1,2}(?:時|:)|昨日|来年|明日|先月|来月|先週/.test(clause.replace(/(?:直近|過去)\d{1,2}(?:分|時間)/g,""));
    if (hours && !(/開場|閉場/.test(clause)&&/変更|設定/.test(clause)))
      return {plans:[],message:"選択中の開催日の午前・午後、または直近の分・時間で指定してください。過去の開催日はイベント一覧から選べます。"};
    const operational=/開場して|閉場して|停止して|再起動|再開して|変えて|変更して|切り替えて/.test(clause);
    const time=/((?:[01]?\d|2[0-3]))(?:時|:)([0-5]\d)?(?:分)?/.exec(clause);
    if (operational&& !readOnly) {
      if (/開場|閉場/.test(clause)) {
        const field=clause.includes("閉場")?"end":"start";
        const schedule=time&&/変更|変え|設定/.test(clause)?{
          field,time:time[1].padStart(2,"0")+":"+(time[2]??"00"),
        } as const:undefined;
        const operation=!schedule&&!time&&/開場して|閉場して/.test(clause)?(field==="end"?"close":"open"):undefined;
        plans.push({intent:"event",focus:true,readOnly:false,operation,schedule});
        continue;
      }
      if (/入口|出口|端末|カメラ/.test(clause)) {
        plans.push({intent:"stations",role,focus:true,readOnly:true});
        continue;
      }
    }
    if (/設定は変えない|設定を変えない|設定はそのまま|操作しない/.test(clause) && !role&&!period) continue;
    let intent=classify(clause);
    if (role&&!intent&&/方も|も調べ|も見|はどう/.test(clause)) intent="stations";
    if (!intent&&/見守|監視|異常が起きたら/.test(clause)) intent="routine";
    if (!intent&&period!==undefined) intent=prior?.intent;
    if (!intent&&/それ|この結果|その結果/.test(clause)) intent=prior?.intent;
    if (!intent&&/何人/.test(clause)&&/今|おる|居る/.test(clause)) intent="occupancy";
    if (!intent&&/何人/.test(clause)&&/入|来/.test(clause)) intent="entries";
    if (!intent) return {plans:[],message:"依頼の対象を特定できませんでした。人数、時刻の範囲、または入口・出口などを指定してください。"};
    if (time&&intent==="event"&&readOnly) return {plans:[],message:"設定は変更しません。イベント管理で現在の予定を確認できます。"};
    plans.push({intent,role:role??(intent==="stations"?prior?.role:undefined),
      period:period??(intent===prior?.intent||intent==="graph"?prior?.period:undefined),
      focus:/見せ|確認して|開い|調べ|移動|グラフ/.test(clause)||["forecast","compare","graph","records","event"].includes(intent),readOnly});
  }
  return {plans,message:plans.length?undefined:"設定を保持しました。"};
}
