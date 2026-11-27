import type {EventDraft,LuxnoraSuggestion} from "../CounterEventPanels";
import type {SeriesAndDays} from "../counterEvents";

export function previousOperation(catalog:SeriesAndDays|null,draft:EventDraft):LuxnoraSuggestion|null {
  if(!catalog) return null;
  const date=draft.days[0]?.date, venue=draft.venue.trim(),name=draft.name.trim();
  const candidates=new Map(catalog.series.filter(row=>(!venue||row.venue===venue)&&(!name||row.name===name)).map(row=>[row.id,row]));
  const last=catalog.days.filter(day=>day.finalized!==null&&day.opened!==null&&day.ended!==null&&
    candidates.has(day.eventId)&&(!date||day.date<date)).sort((a,b)=>b.date.localeCompare(a.date))[0];
  const source=last&&candidates.get(last.eventId);
  if(!last||!source) return null;
  return {sourceDate:last.date,...(!name?{name:source.name}:{}),...(!venue?{venue:source.venue}:{}),
    ...(draft.days[0]?.start!==last.start?{start:last.start}:{}),...(draft.days[0]?.end!==last.end?{end:last.end}:{})};
}
