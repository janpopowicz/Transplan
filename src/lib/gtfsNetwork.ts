import { DEFAULT_TAKT, LINE_COLORS, PERIODS, TAKT_OPTIONS, type PeriodId } from "../constants";
import type { Coord, LineDirection, Stop, TransitLine } from "../types";
import { importGtfsStops, gtfsCsvRows, parseGtfsCsv, type GtfsRow } from "./gtfsStops";
import { gtfsTimeSeconds } from "./gtfsTravelTimes";
import { haversine } from "./geo";
import { modulo, periodEndMinute, periodStartMinute } from "./timetable";

export interface NetworkFeed { id: string; mode: "tram" | "bus"; tables: Record<string, string> }
export interface GtfsNetwork {
  version: 1; at: number; feeds: { id: string; version: string; weekday: string; weekend: string }[];
  lines: TransitLine[]; stops: Stop[];
  report: { variants: number; skippedPatterns: number; skippedTrips: number; clippedTrips: number; fallbackSegments: number };
}
const median = (values: number[]) => { const s = [...values].sort((a,b)=>a-b); return s.length ? (s[Math.floor((s.length-1)/2)] + s[Math.floor(s.length/2)]) / 2 : 0; };
const dateKey = (date: Date) => date.toISOString().slice(0,10).replace(/-/g, "");
export function activeServices(calendar: GtfsRow[], exceptions: GtfsRow[], date: string): Set<string> {
  const weekday = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][new Date(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6)}T12:00:00Z`).getUTCDay()];
  const active = new Set(calendar.filter((r) => r.start_date <= date && r.end_date >= date && r[weekday] === "1").map((r)=>r.service_id));
  for (const row of exceptions) if (row.date === date) { if (row.exception_type === "1") active.add(row.service_id); else if (row.exception_type === "2") active.delete(row.service_id); }
  return active;
}
/** Most common upcoming service calendar, avoiding a one-off holiday profile. */
export function representativeDate(calendar: GtfsRow[], exceptions: GtfsRow[], from: string, weekend: boolean): string {
  const groups = new Map<string, string[]>(), start = new Date(`${from.slice(0,4)}-${from.slice(4,6)}-${from.slice(6)}T12:00:00Z`);
  for (let i=0;i<21;i++) {
    const day = new Date(start.getTime()+i*86400000), w = day.getUTCDay();
    if (weekend ? w !== 6 : w === 0 || w === 6) continue;
    const date = dateKey(day), services = [...activeServices(calendar,exceptions,date)].sort();
    if (!services.length) continue;
    const key = services.join("\0"), dates = groups.get(key) ?? []; dates.push(date); groups.set(key,dates);
  }
  const selected = [...groups.values()].sort((a,b)=>b.length-a.length || a[0].localeCompare(b[0]))[0]?.[0];
  if (!selected) throw new Error("GTFS nie zawiera aktywnego reprezentatywnego dnia w najbliższych trzech tygodniach.");
  return selected;
}
export function fitGtfsProfile(departures: number[], period: PeriodId, forcedHeadway?: number) {
  const start = periodStartMinute(period), end = periodEndMinute(period);
  const times = [...new Set(departures.map((seconds) => {
    let t = seconds / 60 % 1440; if (end > 1440 && t < start) t += 1440; return t;
  }).filter((t)=>t>=start && t<end))].sort((a,b)=>a-b);
  if (!times.length) return null;
  const gaps = times.slice(1).map((time,i)=>time-times[i]).filter((g)=>g>0);
  const raw = gaps.length ? median(gaps) : 60;
  const headway = forcedHeadway ?? [...TAKT_OPTIONS].sort((a,b)=>Math.abs(a-raw)-Math.abs(b-raw) || a-b)[0];
  let phase = 0, best = Infinity;
  // Half-minute offsets and a circular residual score tolerate a few late trips.
  for (let candidate=0;candidate<headway;candidate+=.5) {
    const error = times.reduce((sum,t)=>{ const r = modulo(t-start-candidate+headway/2,headway)-headway/2; return sum+Math.min(r*r,headway*headway/9); },0);
    if (error < best) { best=error;phase=candidate; }
  }
  return { headway, phase, window: [Math.max(0,times[0]-start-headway/2),Math.min(end-start,times.at(-1)!-start+headway/2+.01)] as [number,number], count:times.length };
}
interface Call { id: string; time: number; arrival: number; sequence: number }
interface Trip { row: GtfsRow; calls: Call[]; days: number }
interface Pattern { ids: string[]; trips: Trip[]; direction: string }
const signature = (ids: string[]) => JSON.stringify(ids);

/** Split a shape monotonically along stops, including loops. Never snap an
 * imported shape to a different OSM street or create a chord through a loop. */
export function splitGtfsShape(shape: Coord[], stops: Stop[]): { geometry: Coord[]; fallback: boolean }[] {
  if (shape.length < 2) return stops.slice(1).map((s,i)=>({geometry:[[stops[i].lon,stops[i].lat],[s.lon,s.lat]],fallback:true}));
  const scale = 111195*Math.cos(stops[0].lat*Math.PI/180), xy=shape.map(([x,y])=>[x*scale,y*111195]);
  let previous = 0;
  const cuts = stops.map((stop)=>{
    const x=stop.lon*scale,y=stop.lat*111195; let best=Infinity,at=previous,point:Coord=[stop.lon,stop.lat];
    for(let j=Math.floor(previous);j<shape.length-1;j++) {
      const a=xy[j],b=xy[j+1],dx=b[0]-a[0],dy=b[1]-a[1];
      const t=Math.max(j===Math.floor(previous)?previous-j:0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy||1)));
      const distance=(x-a[0]-dx*t)**2+(y-a[1]-dy*t)**2;
      if(distance<best-1e-7){best=distance;at=j+t;point=[shape[j][0]+(shape[j+1][0]-shape[j][0])*t,shape[j][1]+(shape[j+1][1]-shape[j][1])*t];}
    }
    previous=at;return {at,point,distance:Math.sqrt(best)};
  });
  return stops.slice(1).map((stop,i)=>{
    const a=cuts[i],b=cuts[i+1],fallback=a.distance>200||b.distance>200||b.at<=a.at;
    if(fallback)return {geometry:[[stops[i].lon,stops[i].lat],[stop.lon,stop.lat]] as Coord[],fallback};
    const points:Coord[]=[a.point,...shape.slice(Math.floor(a.at)+1,Math.floor(b.at)+1),b.point];
    // Drop near-collinear/near-duplicate points without losing route bends.
    const simple:Coord[]=[points[0]];
    for(let k=1;k<points.length-1;k++) {
      const p=simple.at(-1)!,q=points[k],r=points[k+1];
      const dx=(r[0]-p[0])*scale,dy=(r[1]-p[1])*111195;
      const distance=Math.abs(dx*(q[1]-p[1])*111195-dy*(q[0]-p[0])*scale)/(Math.hypot(dx,dy)||1);
      if(distance>1.5 || haversine(p,q)>80) simple.push(q);
    }
    simple.push(points.at(-1)!);return {geometry:simple,fallback};
  });
}

export function importGtfsNetwork(feeds: NetworkFeed[], from: string, at = Date.now()): GtfsNetwork {
  const stops=importGtfsStops(feeds.map((f)=>({id:f.id,mode:f.mode,rows:parseGtfsCsv(f.tables["stops.txt"])})));
  const byId=new Map(stops.map((s)=>[s.id,s])), canonical=new Map(stops.flatMap((s)=>(s.gtfsIds??[]).map((id)=>[id,s.id] as const)));
  const result:GtfsNetwork={version:1,at,feeds:[],lines:[],stops,report:{variants:0,skippedPatterns:0,skippedTrips:0,clippedTrips:0,fallbackSegments:0}};
  for(const feed of feeds) {
    const table=(name:string)=>feed.tables[`${name}.txt`] ? parseGtfsCsv(feed.tables[`${name}.txt`]) : [];
    const calendar=table("calendar"),exceptions=table("calendar_dates");
    const weekday=representativeDate(calendar,exceptions,from,false),weekend=representativeDate(calendar,exceptions,from,true);
    const wd=activeServices(calendar,exceptions,weekday),we=activeServices(calendar,exceptions,weekend);
    result.feeds.push({id:feed.id,version:table("feed_info")[0]?.feed_version??"",weekday,weekend});
    const routes=new Map(table("routes").filter((r)=>feed.mode==="tram" ? ["0","900"].includes(r.route_type) : ["3","11","700"].includes(r.route_type)).map((r)=>[r.route_id,r]));
    const trips=new Map<string,Trip>();
    for(const row of table("trips")) {
      const days=(wd.has(row.service_id)?1:0)|(we.has(row.service_id)?2:0);
      if(days && routes.has(row.route_id))trips.set(row.trip_id,{row,calls:[],days});
    }
    for(const row of gtfsCsvRows(feed.tables["stop_times.txt"])) {
      const trip=trips.get(row.trip_id);if(!trip)continue;
      const arrival=gtfsTimeSeconds(row.arrival_time),departure=gtfsTimeSeconds(row.departure_time)??arrival;
      if(arrival===undefined||departure===undefined||!/^\d+$/.test(row.stop_sequence))continue;
      if(row.pickup_type==="1"&&row.drop_off_type==="1")continue;
      trip.calls.push({id:canonical.get(`${feed.id}:${row.stop_id}`)??"",time:departure,arrival,sequence:Number(row.stop_sequence)});
    }
    const patterns=new Map<string,Map<string,Pattern>>();
    for(const trip of trips.values()) {
      trip.calls.sort((a,b)=>a.sequence-b.sequence);
      if(trip.calls.some((c,i)=>i>0&&(c.sequence===trip.calls[i-1].sequence||c.time<trip.calls[i-1].time))){result.report.skippedTrips++;continue;}
      let current:Call[]=[],longest:Call[]=[];
      for(const call of trip.calls){if(!call.id){if(current.length>longest.length)longest=current;current=[];}else if(current.at(-1)?.id!==call.id)current.push(call);}
      if(current.length>longest.length)longest=current;
      if(longest.length<trip.calls.length)result.report.clippedTrips++;
      trip.calls=longest;if(longest.length<2){result.report.skippedTrips++;continue;}
      const ids=longest.map((c)=>c.id),dir=trip.row.direction_id||String(ids[0]>ids.at(-1)!?1:0);
      const list=patterns.get(trip.row.route_id)??new Map<string,Pattern>(),key=signature(ids);
      const pattern=list.get(key)??{ids,trips:[],direction:dir};pattern.trips.push(trip);list.set(key,pattern);patterns.set(trip.row.route_id,list);
    }
    const selected=new Map<string,Pattern[]>();
    for(const [route,list] of patterns) {
      const ordered=[...list.values()].sort((a,b)=>b.trips.length-a.trips.length || b.ids.length-a.ids.length || signature(a.ids).localeCompare(signature(b.ids)));
      const topByDir=new Map<string,number>();for(const p of ordered)if(!topByDir.has(p.direction))topByDir.set(p.direction,p.trips.length);
      const kept=ordered.filter((p)=>p.trips.length===topByDir.get(p.direction)||p.trips.length>=Math.max(4,Math.ceil(topByDir.get(p.direction)!*.1)));
      result.report.skippedPatterns+=ordered.length-kept.length;selected.set(route,kept);
    }
    const needed=new Set([...selected.values()].flatMap((p)=>p.flatMap((v)=>v.trips.map((t)=>t.row.shape_id))));
    const shapes=new Map<string,{sequence:number;coord:Coord}[]>();
    if(feed.tables["shapes.txt"])for(const row of gtfsCsvRows(feed.tables["shapes.txt"]))if(needed.has(row.shape_id)){
      const lat=Number(row.shape_pt_lat),lon=Number(row.shape_pt_lon),sequence=Number(row.shape_pt_sequence);
      if(!Number.isFinite(lat)||!Number.isFinite(lon)||!Number.isFinite(sequence))continue;
      const list=shapes.get(row.shape_id)??[];list.push({sequence,coord:[lon,lat]});shapes.set(row.shape_id,list);
    }
    const shapeCoords=new Map([...shapes].map(([id,rows])=>[id,rows.sort((a,b)=>a.sequence-b.sequence).map((r)=>r.coord)]));
    for(const [routeId,patterns] of selected) {
      const route=routes.get(routeId)!,remaining=[...patterns],pairs:Pattern[][]=[];
      while(remaining.length){
        const a=remaining.shift()!,start=byId.get(a.ids[0])!,end=byId.get(a.ids.at(-1)!)!;
        const candidates=remaining.map((b,i)=>{
          const bs=byId.get(b.ids[0])!,be=byId.get(b.ids.at(-1)!)!;
          const d1=haversine([start.lon,start.lat],[be.lon,be.lat]),d2=haversine([end.lon,end.lat],[bs.lon,bs.lat]);
          const forwardScore=haversine([start.lon,start.lat],[bs.lon,bs.lat])+haversine([end.lon,end.lat],[be.lon,be.lat]);
          // Some official routes label both directions with the same ID. A
          // clear physical reversal takes precedence over that broken label.
          const opposite=b.direction!==a.direction || d1+d2+20<forwardScore;
          return {i,b,score:d1+d2,valid:opposite&&d1<500&&d2<500};
        }).filter((v)=>v.valid).sort((x,y)=>x.score-y.score||y.b.trips.length-x.b.trips.length);
        const b=candidates[0];if(b){remaining.splice(b.i,1);pairs.push([a,b.b]);}else pairs.push([a]);
      }
      pairs.sort((a,b)=>b.reduce((n,p)=>n+p.trips.length,0)-a.reduce((n,p)=>n+p.trips.length,0));
      for(const [variant,pair] of pairs.entries()){
        pair.sort((a,b)=>a.direction.localeCompare(b.direction));
        const suffix=pairs.length>1?String.fromCharCode(65+variant):"",number=(route.route_short_name||routeId)+suffix;
        const id=`gtfs-line-${feed.id}-${routeId}-${variant}`, first=byId.get(pair[0].ids[0])!,last=byId.get(pair[0].ids.at(-1)!)!;
        const line:TransitLine={id,number,name:`${first.stationName} — ${last.stationName}`,mode:feed.mode,color:LINE_COLORS[(result.lines.length+(feed.mode==="tram"?0:7))%LINE_COLORS.length],
          vehicle:feed.mode==="tram"?"33m":"12m",visible:true,outboundStopIds:pair[0].ids,inboundStopIds:pair[1]?.ids??[],terminus1Id:first.id,terminus2Id:last.id,segments:[],
          takt:Object.fromEntries(Object.keys(DEFAULT_TAKT).map((p)=>[p,null])) as TransitLine["takt"],layoverMin:5,departureOffsets:{},serviceWindows:{},
          gtfsImport:{feed:feed.id,route:route.route_short_name||routeId,variant:suffix,weekday,weekend}};
        for(const [index,pattern] of pair.entries()){
          const direction:LineDirection=index?"inbound":"outbound",votes=new Map<string,number>();
          for(const t of pattern.trips)votes.set(t.row.shape_id,(votes.get(t.row.shape_id)??0)+1);
          const shape=[...votes].sort((a,b)=>b[1]-a[1])[0]?.[0];
          const legs=splitGtfsShape(shapeCoords.get(shape)??[],pattern.ids.map((id)=>byId.get(id)!));
          pattern.ids.slice(1).forEach((to,i)=>{
            const times=pattern.trips.map((t)=>(t.calls[i+1].time-t.calls[i].time)/60).filter((n)=>n>=0&&n<180);
            if(legs[i].fallback)result.report.fallbackSegments++;
            line.segments.push({id:`${id}-${direction}-${i}`,direction,fromStopId:pattern.ids[i],toStopId:to,geometry:legs[i].geometry.map((c): Coord => [Math.round(c[0]*1e6)/1e6, Math.round(c[1]*1e6)/1e6]),
              travelMin:Math.max(1,Math.round(median(times))),travelTimeSource:"gtfs-import",gtfsSamples:times.length||1});
          });
          for(const period of PERIODS){
            const bit=period.group==="weekday"?1:2;
            const fit=fitGtfsProfile(pattern.trips.filter((t)=>t.days&bit).map((t)=>t.calls[0].time),period.id);
            if(!fit)continue;
            line.takt[period.id]=line.takt[period.id]===null?fit.headway:Math.min(line.takt[period.id]!,fit.headway);
            (line.departureOffsets![period.id]??={})[direction]=fit.phase;
            (line.serviceWindows![period.id]??={})[direction]=fit.window;
          }
        }
        // Both directions use the editable line takt; refit phases to that same
        // grid when opposite directions had slightly different observed gaps.
        for (const [index,pattern] of pair.entries()) for (const period of PERIODS) {
          const direction: LineDirection = index ? "inbound" : "outbound", headway = line.takt[period.id];
          if (headway === null || !line.serviceWindows![period.id]?.[direction]) continue;
          const bit = period.group === "weekday" ? 1 : 2;
          const fit = fitGtfsProfile(pattern.trips.filter((t)=>t.days&bit).map((t)=>t.calls[0].time),period.id,headway)!;
          line.departureOffsets![period.id]![direction] = fit.phase;
          line.serviceWindows![period.id]![direction] = fit.window;
        }
        if(Object.values(line.takt).some((t)=>t!==null))result.lines.push(line);
      }
      result.report.variants+=Math.max(0,pairs.length-1);
    }
  }
  if(!result.lines.length)throw new Error("GTFS nie zawiera linii do zaimportowania.");
  return result;
}
