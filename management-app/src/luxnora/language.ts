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
export type Plan = {intent:Intent;role?:"in"|"out";period?:"am"|"pm"|number|{from:number;to:number};focus:boolean;readOnly:boolean;operation?:"open"|"close";schedule?:{field:"start"|"end";time:string}};
export type Interpretation = {plans:Plan[];message?:string;reset?:boolean};

const normalize = (raw:string) => raw.normalize("NFKC").toLowerCase().replace(/[\s？！?!。]/g,"")
  .replace(/おおよそ|だいたい/g,"").replace(/きょう|本日/g,"今日").replace(/いま/g,"今")
  .replace(/何名|何にん|何ニン/g,"何人").replace(/足を運んだ|お越しになった|来はった|来よった/g,"来た")
  .replace(/帰っちゃった|帰らはった|出ていった/g,"帰った").replace(/この先|このあと/g,"この後")
  .replace(/受付の機械|受付の端末/g,"受付端末")
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
function timeOfDay(value:string) {
  const parts=/^(?:(午前|午後))?(\d{1,2})(?:時|:)(半|[0-5]?\d)?(?:分)?$/.exec(value);
  if(!parts) return null;
  const hour=Number(parts[2]),minute=parts[3]==="半"?30:Number(parts[3]??0);
  if(hour>=24||minute>=60||(parts[1]&&hour>12)) return null;
  return (parts[1]?hour%12+(parts[1]==="午後"?12:0):hour)*60+minute;
}

export function interpret(raw:string,previous?:Plan):Interpretation {
  if (raw.length>320) return {plans:[],message:"一度に入力できるのは320文字までです。"};
  if (/取り消|キャンセル|やっぱりいい|なしで$/.test(raw.trim().replace(/[。？！?!]+$/,""))) return {plans:[],reset:true,message:"依頼を取り消しました。"};
  const readOnly=/変えない|変更しない|触らない|そのまま|見るだけ|確認だけ|操作しない|開けない|開場しない|閉場しない|停止しない|しないで|せんといて|しないでください/.test(raw);
  if (/削除|消去|権限変更|管理者にして|無効化/.test(raw))
    return {plans:[],message:"この操作は該当する管理画面から確認してください。"};
  const clauses=raw.split(/(?:[。\n；;]|それから|そのあと|そして|続けて)/).map(normalize).filter(Boolean);
  if (clauses.length>4) return {plans:[],message:"一度に4件まで確認できます。"};
  const plans:Plan[]=[];
  for(const clause of clauses) {
    const prior=plans.at(-1)??previous;
    const role=clause.includes("入口")?"in":clause.includes("出口")?"out":undefined;
    const relative=clause.match(/(?:直近|過去|ここ)(\d{1,3})(分|時間)/);
    const clock=/((?:午前|午後)?\d{1,2}(?:時|:)(?:半|[0-5]?\d)?(?:分)?)(?:から|〜|~|－|–|—|-)((?:午前|午後)?\d{1,2}(?:時|:)(?:半|[0-5]?\d)?(?:分)?)/.exec(clause);
    const from=clock?timeOfDay(clock[1]):null, to=clock?timeOfDay(clock[2]):null;
    if(clock&&(from===null||to===null||from>=to)) return {plans:[],message:"時刻は同じ開催日で、終了を開始より後に指定してください。"};
    const period=from!==null&&to!==null?{from,to}:clause.includes("午前")?"am":clause.includes("午後")?"pm":relative?Math.min(1440,Number(relative[1])*(relative[2]==="時間"?60:1)):undefined;
    const operational=/開場して|閉場して|停止して|再起動|再開して|変えて|変更して|切り替えて|変更しよ|変えといて/.test(clause);
    const timed=/(?:午前|午後)?\d{1,2}(?:時|:)(?:半|[0-5]?\d)?(?:分)?/.exec(clause);
    const time=timed?timeOfDay(timed[0]):null;
    const futureDate=/昨日|来年|明日|先月|来月|先週|\d{1,2}月\d{1,2}日/.test(clause);
    if (futureDate || (/\d{1,2}(?:時(?!間)|:)/.test(clause)&&!clock&&!(/開場|閉場/.test(clause)&&/変更|設定|変え/.test(clause))))
      return {plans:[],message:"対象の開催日をイベント一覧から選んでください。時間帯は午前・午後、または「10時から12時」のように指定できます。"};
    if (/開場してもいい|開場して大丈夫|開けてもええ|開場できる/.test(clause)) {
      plans.push({intent:"readiness",focus:true,readOnly:true});
      continue;
    }
    if (operational&&!readOnly) {
      if (/開場|閉場/.test(clause)) {
        const field=clause.includes("閉場")?"end":"start";
        const schedule=time!==null&&!clock&&/変更|変え|設定/.test(clause)?{
          field,time:String(Math.floor(time/60)).padStart(2,"0")+":"+String(time%60).padStart(2,"0"),
        } as const:undefined;
        const operation=!schedule&&!timed&&!clock&&/開場して|閉場して/.test(clause)?(field==="end"?"close":"open"):undefined;
        plans.push({intent:"event",focus:true,readOnly:false,operation,schedule});
        continue;
      }
      if (/入口|出口|端末|カメラ/.test(clause)) {
        plans.push({intent:"stations",role,focus:true,readOnly:true});
        continue;
      }
    }
    if (/設定は変えない|設定を変えない|設定はそのまま|操作しない/.test(clause) && !role&&!period) continue;
    let intent:Intent|undefined;
    const question=/何人|人数|どのくらい|どれくらい|何回/.test(clause);
    if(question&&/帰った|退場|退出/.test(clause)&&!/入退場/.test(clause)) intent="exits";
    else if(question&&/来た|来場|入った|入場/.test(clause)&&!/入退場/.test(clause)) intent="entries";
    else if(/この後|これから/.test(clause)&&/増え|減り|混|予想/.test(clause)) intent="forecast";
    else if(/端末|受付/.test(clause)&&/調子|状態|動い|同期/.test(clause)) intent="stations";
    else if(/前年差|前年比|前年度|前年|昨年|去年/.test(clause)&&/差|違い|比|増|減|少|多/.test(clause)) intent="compare";
    else if(/整合性|矛盾|不一致|おかし|異常/.test(clause)&&/記録|数|集計/.test(clause)) intent="issues";
    else if(/通過|入退場/.test(clause)&&/履歴|記録/.test(clause)) intent="records";
    else if(/結果|実績|状況/.test(clause)&&/まとめ|要約|報告/.test(clause)) intent="briefing";
    else if(/受付|開場|運用/.test(clause)&&/準備|始められ|開始でき/.test(clause)) intent="readiness";
    intent??=classify(clause);
    if (role&&!intent&&/方も|も調べ|も見|はどう/.test(clause)) intent="stations";
    if (!intent&&/見守|監視|異常が起きたら/.test(clause)) intent="routine";
    if (!intent&&period!==undefined) intent=prior?.intent;
    if (!intent&&/それ|この結果|その結果/.test(clause)) intent=prior?.intent;
    if (!intent&&/何人/.test(clause)&&/今|おる|居る/.test(clause)) intent="occupancy";
    if (!intent&&/何人/.test(clause)&&/入|来/.test(clause)) intent="entries";
    if (!intent) return {plans:[],message:"依頼の対象を特定できませんでした。人数、時刻の範囲、または入口・出口などを指定してください。"};
    if (timed&&intent==="event"&&readOnly) return {plans:[],message:"設定は変更しません。イベント管理で現在の予定を確認できます。"};
    plans.push({intent,role:role??(intent==="stations"?prior?.role:undefined),
      period:period??(intent===prior?.intent||intent==="graph"?prior?.period:undefined),
      focus:/見せ|確認して|開い|調べ|移動|グラフ/.test(clause)||["forecast","compare","graph","records","event"].includes(intent),readOnly});
  }
  return {plans,message:plans.length?undefined:"設定を保持しました。"};
}
