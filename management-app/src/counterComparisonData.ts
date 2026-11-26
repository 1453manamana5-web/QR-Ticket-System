import {collection,doc,getDocFromServer,getDocsFromServer} from "firebase/firestore";
import {getFirebaseDb} from "../../reception-app/src/firebaseClient";
import type {Day} from "./counterLifecycle";
import {decodeConfig,decodeOperation,type CounterOperation} from "./counterManagementData";
import {summarizeCounterDay,type ComparisonDay} from "./counterComparisonMetrics";

export async function readComparisonDays(days:Day[],signal:AbortSignal):Promise<ComparisonDay[]> {
  const db=getFirebaseDb();
  const results:ComparisonDay[]=[];
  // Each comparison loads at most two explicitly selected events. Read a day at
  // a time to avoid many overlapping Firestore requests on the school network.
  for (const day of days) {
    if (signal.aborted) break;
    try {
      const config=decodeConfig((await getDocFromServer(doc(db,"events",day.id,"counterConfig","live"))).data());
      if (!config || config.opened===null) {
        results.push({id:day.id,date:day.date,status:config?"unopened":"unavailable"});
        continue;
      }
      if (signal.aborted) break;
      const snapshot=await getDocsFromServer(collection(db,"events",day.id,"counterRuns","live","operations"));
      const rows:CounterOperation[]=[];
      let invalid=0;
      for (const row of snapshot.docs) {
        const operation=decodeOperation(row.id,day.id,"live",row.get("payload"));
        if (operation) rows.push(operation);
        else invalid++;
      }
      results.push(summarizeCounterDay(day.id,day.date,{...config,opened:config.opened},rows,Date.now(),invalid));
    } catch {
      results.push({id:day.id,date:day.date,status:"unavailable"});
    }
  }
  return results;
}
