import { test } from "node:test";
import assert from "node:assert/strict";
import { activeServices, representativeDate, fitGtfsProfile, importGtfsNetwork, splitGtfsShape, type NetworkFeed } from "../src/lib/gtfsNetwork";
import { buildDailyTimetable, dailyStopDepartures, shiftDeparture } from "../src/lib/timetable";
import { parseProposal } from "../src/lib/proposal";
import { encodeStoredState, decodeStoredState } from "../src/lib/storageCodec";
import { mergeStopCatalogue } from "../src/lib/stopEditing";
import { saveState, loadState } from "../src/lib/persist";
import { readOsmCache } from "../src/lib/overpass";
import { dailyLineCost } from "../src/lib/costs";
import { useStore, projectSnapshot } from "../src/store";
import type { Coord, Stop } from "../src/types";

const csv = (columns: string[], rows: (string|number)[][]) => [columns.join(","),...rows.map((r)=>r.join(","))].join("\n");
function fixture(): NetworkFeed {
  const trips: (string|number)[][] = [], calls: (string|number)[][] = [];
  const time = (minute: number) => `${Math.floor(minute/60)}:${String(minute%60).padStart(2,"0")}:00`;
  const add = (prefix: string, ids: string[], direction: number, count: number, start: number, step = 15) => {
    for(let i=0;i<count;i++) {
      const id = `${prefix}${i}`; trips.push(["r","daily",id,direction,"shape"]);
      ids.forEach((stop,j)=>calls.push([id,time(start+i*step+j*3),time(start+i*step+j*3),stop,j+1]));
    }
  };
  add("full-out",["a","b","c"],0,12,362); add("full-in",["cr","br","ar"],1,12,369);
  add("short-out",["a","b"],0,4,365,30); add("short-in",["br","ar"],1,4,380,30);
  add("depot",["b","c"],0,1,400);
  const stopRows = [["a","Alpha","01",50.06,19.94],["ar","Alpha","02",50.0601,19.94],
    ["b","Beta","01",50.06,19.95],["br","Beta","02",50.0601,19.95],
    ["c","Gamma","01",50.06,19.96],["cr","Gamma","02",50.0601,19.96]];
  return { id:"T",mode:"tram",tables:{
    "stops.txt":csv(["stop_id","stop_name","platform_code","stop_lat","stop_lon"],stopRows),
    "routes.txt":csv(["route_id","route_short_name","route_type"],[["r","7",900]]),
    "calendar.txt":csv(["service_id","monday","tuesday","wednesday","thursday","friday","saturday","sunday","start_date","end_date"],[["daily",0,0,0,0,0,0,0,20260101,20261231]]),
    "calendar_dates.txt":csv(["service_id","date","exception_type"],[["daily",20261102,1],["daily",20261107,1]]),
    "trips.txt":csv(["route_id","service_id","trip_id","direction_id","shape_id"],trips),
    "stop_times.txt":csv(["trip_id","arrival_time","departure_time","stop_id","stop_sequence"],calls),
    "shapes.txt":csv(["shape_id","shape_pt_lat","shape_pt_lon","shape_pt_sequence"],[["shape",50.06,19.94,1],["shape",50.06,19.95,2],["shape",50.06,19.96,3],["shape",50.0601,19.95,4],["shape",50.0601,19.94,5]])
  }};
}

test("GTFS calendar exceptions add/remove services and choose an available upcoming day",()=>{
  const cal=[{service_id:"base",monday:"1",start_date:"20260101",end_date:"20261231"}];
  const exceptions=[{service_id:"base",date:"20261102",exception_type:"2"},{service_id:"special",date:"20261102",exception_type:"1"}];
  assert.deepEqual([...activeServices(cal,exceptions,"20261102")],["special"]);
  assert.equal(representativeDate(cal,exceptions,"20261031",false),"20261109");
  assert.throws(()=>representativeDate([],[],"20261031",true),/aktywnego/);
});

test("headways and independent direction phases fit the same rounded departure grid",()=>{
  const times=Array.from({length:12},(_,i)=>(362+i*15)*60);
  const fit=fitGtfsProfile(times,"wd_am")!;
  assert.equal(fit.headway,15);assert.equal(fit.phase,2);
  assert.equal(fitGtfsProfile(times,"wd_pm"),null);
  assert.equal(fitGtfsProfile([9*60,12*60].map(t=>t*60),"wd_mid")!.headway,180);
  const rounded=fitGtfsProfile([362,377,393,408,423,438].map(t=>t*60),"wd_am")!;
  assert.equal(rounded.headway,15);assert.ok(rounded.phase%0.5===0);
  const night=fitGtfsProfile([23*60+3,24*60+3,25*60+3].map(t=>t*60),"wd_night")!;
  assert.equal(night.headway,60);assert.equal(night.phase,3);assert.ok(night.window[1]<300);
});

test("GTFS imports tram type 900, pairs directions, splits meaningful short variants and skips rare depot patterns",()=>{
  const network=importGtfsNetwork([fixture()],"20261031",123);
  assert.deepEqual(network.lines.map(l=>l.number),["7A","7B"]);
  assert.equal(network.report.skippedPatterns,1);assert.equal(network.report.variants,1);
  assert.equal(network.stops.length,6);assert.equal(network.lines[0].mode,"tram");
  const line=network.lines[0];assert.equal(line.outboundStopIds.length,3);assert.equal(line.inboundStopIds.length,3);
  assert.equal(line.takt.wd_am,15);assert.equal(line.departureOffsets!.wd_am!.outbound,2);assert.equal(line.departureOffsets!.wd_am!.inbound,9);
  assert.ok(line.segments.every(s=>s.travelTimeSource==="gtfs-import" && s.travelMin===3));
  const proposal={lines:network.lines,localStops:[],movedStops:network.stops,localTracks:[],constructionOverrides:{}};
  assert.deepEqual(parseProposal(proposal),proposal);
  const runs=buildDailyTimetable(network.lines,"weekday");
  assert.equal(dailyStopDepartures(runs,line.id,"outbound",line.outboundStopIds[0]).length,12);
  assert.equal(dailyLineCost(line,"weekday").vehicleKm>0,true);
});

test("shape splitting follows loops monotonically and marks missing shapes for direct fallback",()=>{
  const shape:Coord[]=[[19.94,50.06],[19.95,50.06],[19.95,50.07],[19.94,50.06]];
  const stops:Stop[]=shape.filter((_,i)=>i!==1).map(([lon,lat],i)=>({id:String(i),name:String(i),lon,lat,source:"local",modes:["bus"]}));
  const result=splitGtfsShape(shape,stops);
  assert.ok(result.every(s=>!s.fallback));assert.ok(result[0].geometry.length>=3);
  assert.ok(splitGtfsShape([],stops).every(s=>s.fallback));
});

test("imported service windows prevent invented reverse trips and survive changing phases",()=>{
  const line=importGtfsNetwork([fixture()],"20261031").lines[0];
  line.serviceWindows!.wd_am={outbound:[0,180]};
  const runs=buildDailyTimetable([line],"weekday");
  assert.ok(runs.every(r=>r.direction==="outbound"));
  const shifted=shiftDeparture([line],line.id,7,"wd_am","outbound")[0];
  assert.equal(shifted.departureOffsets!.wd_am!.outbound,7);
  assert.equal(shifted.departureOffsets!.wd_am!.inbound,14);
  assert.deepEqual(shifted.serviceWindows,line.serviceWindows);
});

test("night schedules cover midnight without duplicating departures or extending daytime service all night",()=>{
  const line=importGtfsNetwork([fixture()],"20261031").lines[0];
  line.takt.wd_night=60;line.departureOffsets!.wd_night={outbound:3};line.serviceWindows!.wd_night={outbound:[0,181]};
  const runs=buildDailyTimetable([line],"weekday");
  const times=dailyStopDepartures(runs,line.id,"outbound",line.outboundStopIds[0]);
  assert.ok(times.includes(3));assert.ok(times.includes(63));assert.ok(times.includes(1383));assert.ok(!times.includes(183));
  assert.ok(runs.find(r=>r.period==="wd_night")!.departures.includes(-57));
});

test("large project storage round-trips exact coordinates and legacy JSON stays readable",()=>{
  const network=importGtfsNetwork([fixture()],"20261031");
  const raw=JSON.stringify(network), packed=encodeStoredState(network);
  assert.ok(packed.length<raw.length/2);assert.deepEqual(decodeStoredState(packed),network);assert.deepEqual(decodeStoredState(raw),network);
  const proposal={lines:network.lines,localStops:[],localTracks:[],constructionOverrides:{}};
  const old=JSON.parse(JSON.stringify(proposal));delete old.lines[0].takt.wd_night;delete old.lines[0].takt.we_night;
  assert.equal(parseProposal(old).lines[0].takt.wd_night,null);
});

test("new GTFS stops retain canonical identity when reopening against an older catalogue",()=>{
  const network=importGtfsNetwork([fixture()],"20261031");
  const merged=mergeStopCatalogue(network.stops.slice(0,1),network.stops.map(s=>({...s,originalPosition:[s.lon,s.lat] as Coord})),network.lines);
  assert.equal(merged.stops.length,network.stops.length);assert.ok(merged.stops.every(s=>s.source==="gtfs"));
});

test("enabling a previously absent import period creates editable service in both physical directions",()=>{
  const previous=useStore.getState(),line=importGtfsNetwork([fixture()],"20261031").lines[0];
  try {
    useStore.setState({access:"local",lines:[line],stops:[],tracks:[]});
    useStore.getState().setTakt(line.id,"wd_mid",20);
    const updated=useStore.getState().lines[0];
    assert.ok(buildDailyTimetable([updated],"weekday").some(r=>r.period==="wd_mid"&&r.direction==="inbound"));
    assert.ok(projectSnapshot(useStore.getState()).lines[0].gtfsImport);
  } finally {useStore.setState(previous);}
});

test("import replaces lines atomically, downloads the previous proposal and preserves local infrastructure",()=>{
  const previous=useStore.getState(),descriptor=Object.getOwnPropertyDescriptor(globalThis,"document");
  let downloaded=false;
  Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement:()=>({click:()=>{downloaded=true;}})}});
  const network=importGtfsNetwork([fixture()],"20261031");
  const local:Stop={id:"custom",name:"Custom",lon:19.93,lat:50.05,modes:["bus"],source:"local"};
  try {
    useStore.setState({access:"local",lines:[{...network.lines[0],id:"old-custom"}],stops:[local],
      tracks:[{id:"custom-track",geometry:[[19.93,50.05],[19.94,50.05]],source:"local",construction:false}],constructionOverrides:{}});
    useStore.getState().importGtfs(network);
    assert.ok(downloaded);assert.deepEqual(useStore.getState().lines.map(l=>l.id),network.lines.map(l=>l.id));
    assert.ok(useStore.getState().stops.some(s=>s.id===local.id));assert.equal(useStore.getState().tracks[0].id,"custom-track");
    const snapshot=projectSnapshot(useStore.getState());
    assert.ok(snapshot.movedStops!.every(s=>s.originalPosition));
    useStore.setState({access:"read"});useStore.getState().importGtfs({...network,lines:[]});
    assert.equal(useStore.getState().lines.length,2);
  } finally {useStore.setState(previous);if(descriptor)Object.defineProperty(globalThis,"document",descriptor);else Reflect.deleteProperty(globalThis,"document");}
});


test("saving a large GTFS project compacts old base caches and remains reloadable within the browser quota",()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,"localStorage");
  const network=importGtfsNetwork([fixture()],"20261031");
  const proposal={lines:Array.from({length:400},()=>network.lines).flat(),localStops:[],localTracks:[],constructionOverrides:{}};
  const cache={at:Date.now(),stops:[],tracks:[],padding:"x".repeat(200000)};
  const values=new Map([["transplan-base-cache-v6",JSON.stringify(cache)],["user-backup","keep me"]]);
  const quota=JSON.stringify(cache).length+Math.floor(encodeStoredState(proposal).length/2);
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{
    const total=[...values].filter(([k])=>k!==key).reduce((sum,[,v])=>sum+v.length,0)+value.length;
    if(total>quota)throw new DOMException("Quota exceeded","QuotaExceededError");values.set(key,value);
  }}});
  try{
    saveState(proposal,true);
    assert.ok(values.get("transplan-base-cache-v6")!.startsWith("transplan-lz:"));
    assert.equal(values.get("user-backup"),"keep me");assert.equal(loadState()!.lines.length,proposal.lines.length);
    assert.deepEqual(readOsmCache(),cache);
  }finally{if(descriptor)Object.defineProperty(globalThis,"localStorage",descriptor);else Reflect.deleteProperty(globalThis,"localStorage");}
});


test("incorrect equal GTFS direction IDs do not split two reversed routes into fake A/B variants",()=>{
  const feed=fixture();
  feed.tables["trips.txt"]=feed.tables["trips.txt"].replaceAll(",1,shape",",0,shape");
  const network=importGtfsNetwork([feed],"20261031");
  assert.deepEqual(network.lines.map(l=>l.number),["7A","7B"]);
  assert.ok(network.lines.every(l=>l.outboundStopIds.length>=2&&l.inboundStopIds.length>=2));
});


test("the same ordered platforms with inconsistent direction labels form one pattern",()=>{
  const feed=fixture(),trips=feed.tables["trips.txt"].split("\n"),calls=feed.tables["stop_times.txt"].split("\n");
  for(let i=0;i<4;i++) {
    trips.push(`r,daily,duplicate${i},1,shape`);
    for(const row of calls.filter(r=>r.startsWith(`full-out${i},`))) calls.push(row.replace(`full-out${i},`,`duplicate${i},`));
  }
  feed.tables["trips.txt"]=trips.join("\n");feed.tables["stop_times.txt"]=calls.join("\n");
  const network=importGtfsNetwork([feed],"20261031");
  assert.equal(network.lines.length,2);assert.equal(network.report.variants,1);
});
