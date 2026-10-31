import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateJourney, scheduledDeparture } from "../src/lib/journey";
import { buildDailyTimetable, dailyStopDepartures, formatDeparture } from "../src/lib/timetable";
import { searchStops } from "../src/lib/places";
import { useStore } from "../src/store";
import { useJourneyState } from "../src/lib/journeyState";
import { DEFAULT_TAKT } from "../src/constants";
import type { Coord, Stop, TransitLine } from "../src/types";
import type { WalkingNetwork } from "../src/lib/walkingNetwork";
const stops: Stop[] = [0,1,2,3].map((i) => ({ id: `s${i}`, name: `Przystanek ${i}`, modes:["bus"], source:"local", lon:19.94+i*.04, lat:50.06 }));
const coord = (i:number):Coord => [stops[i].lon,stops[i].lat];
const network: WalkingNetwork = { coords: stops.flatMap((stop) => [[stop.lon,stop.lat],[stop.lon,stop.lat+.001]] as Coord[]),
  edges: stops.map((_,i) => ({from:i*2,to:i*2+1,meters:111.195,forward:true,backward:true})),fetchedAt:0 };
function line(id:string, ids:string[], minutes=3):TransitLine {
 return {id,number:id,name:id,mode:"bus",vehicle:"12m",color:"#123456",visible:true,outboundStopIds:ids,inboundStopIds:[],terminus1Id:ids[0],terminus2Id:ids.at(-1)!,
 takt:{...DEFAULT_TAKT,wd_am:10},layoverMin:5, segments:ids.slice(1).map((id,i)=>({id:`${i}`,fromStopId:ids[i],toStopId:id,travelMin:minutes,direction:"outbound",geometry:[]}))};
}
const request = {origin:{name:"Start",coord:coord(0)},destination:{name:"Cel",coord:coord(2)},departureMinute:361,day:"weekday" as const,stops,network};

test("journey uses concrete departure times, geometry, and one vehicle through multiple stops",()=>{
 const result=calculateJourney({...request,lines:[line("A",["s0","s1","s2"])]});
 assert.equal(result.arrivalMinute,376); assert.equal(result.waitMinutes,9); assert.equal(result.rideMinutes,6);
 assert.equal(result.transfers,0); const rides=result.legs.filter(l=>l.kind==="ride");
 assert.equal(rides.length,1);assert.equal(rides[0].stops,2);assert.deepEqual(rides[0].geometry,[coord(0),coord(1),coord(2)]);
 assert.equal(result.legs.reduce((sum,l)=>sum+l.arrivalMinute-l.departureMinute,0),15);
});

test("journey catches and misses real transfer departures",()=>{
 const a=line("A",["s0","s1"]),b={...line("B",["s1","s2"]),departureOffsetMin:4};
 const caught=calculateJourney({...request,lines:[a,b]});
 assert.equal(caught.arrivalMinute,377);assert.equal(caught.transfers,1);assert.equal(caught.waitMinutes,10);
 assert.equal(calculateJourney({...request,lines:[a,{...b,departureOffsetMin:2}]}).arrivalMinute,385);
});

test("crossing a period boundary retains the trip that departed in the previous period",()=>{
 const route=line("A",["s0","s1","s2"],25);
 const result=calculateJourney({...request,origin:{name:"Middle",coord:coord(1)},departureMinute:359,lines:[route]});
 assert.equal(result.legs.find(l=>l.kind==="ride")!.departureMinute,365);
 assert.equal(result.arrivalMinute,390);assert.equal(result.rideMinutes,25);
});

test("coordination does not allow free branch switches and ties prefer staying on the vehicle",()=>{
 const a={...line("A",["s0","s1","s2"]),coordinatedLineIds:["B"]};
 const b={...line("B",["s0","s1","s3"]),coordinatedLineIds:["A"]};
 const result=calculateJourney({...request,lines:[a,b]});
 assert.equal(result.arrivalMinute,376);assert.equal(result.transfers,0);
 assert.deepEqual(result.legs.filter(l=>l.kind==="ride").map(l=>l.lineId),["A"]);
 assert.equal(calculateJourney({...request,destination:{name:"Common",coord:coord(1)},lines:[a,b]}).arrivalMinute,368);
});

test("unreachable goals, walking-only trips and zero-length journeys have explicit outcomes",()=>{
 assert.throws(()=>calculateJourney({...request,lines:[]}),/Nie znaleziono/);
 const point:Coord=[stops[0].lon,stops[0].lat+.001];
 const walk=calculateJourney({...request,lines:[],destination:{name:"Walk",coord:point}});
 assert.ok(Math.abs(walk.walkMinutes-111.195/80)<1e-6);assert.equal(walk.transfers,0);assert.equal(walk.legs[0].kind,"walk");
 const same=calculateJourney({...request,lines:[],destination:request.origin});assert.equal(same.arrivalMinute,361);assert.deepEqual(same.legs,[]);
 assert.throws(()=>calculateJourney({...request,lines:[],departureMinute:NaN}),/godzinę/);
});

test("day timetable covers all periods for exactly one selected platform and day type",()=>{
 const route={...line("A",["s0","s1"],3),departureOffsetMin:2.5};
 const runs=buildDailyTimetable([route],"weekday");
 const first=dailyStopDepartures(runs,"A","outbound","s0"),second=dailyStopDepartures(runs,"A","outbound","s1");
 assert.equal(formatDeparture(first[0]),"04:02:30");assert.equal(formatDeparture(second[0]),"04:05:30");
 assert.ok(first.some(t=>t>=360&&t<540));assert.ok(first.some(t=>t>=1080&&t<1380));
 assert.ok(first.every(t=>t<1380));assert.deepEqual(dailyStopDepartures(runs,"A","inbound","s0"),[]);
 const weekend=dailyStopDepartures(buildDailyTimetable([route],"weekend"),"A","outbound","s0");
 assert.equal(formatDeparture(weekend[0]),"06:02:30");
 const inactive={...route,takt:{...route.takt,wd_am:null}};
 assert.ok(dailyStopDepartures(buildDailyTimetable([inactive],"weekday"),"A","outbound","s0").every(t=>t<360||t>=540));
});

test("finite schedules never invent a departure beyond the final trip",()=>{
 assert.equal(scheduledDeparture([360,370],361),370);assert.equal(scheduledDeparture([360,370],373,3),373);
 assert.equal(scheduledDeparture([360,370],374,3),Infinity);assert.equal(scheduledDeparture([],360),Infinity);
});

test("stop search is accent-insensitive and point selection supports swapping without editing the project",()=>{
 const catalogue=[{...stops[0],name:"Łagiewniki SKA 01"}];
 assert.equal(searchStops(catalogue,"lagiewniki")[0].name,"Łagiewniki SKA 01");assert.deepEqual(searchStops(catalogue,"x"),[]);
 const previous=useStore.getState();useStore.setState({access:"read"});useStore.getState().setTool("journey");assert.equal(useStore.getState().tool,"journey");useStore.setState(previous);
 useJourneyState.getState().setPoint(0,request.origin);useJourneyState.getState().setPoint(1,request.destination);useJourneyState.getState().swap();
 assert.deepEqual(useJourneyState.getState().points,[request.destination,request.origin]);
 useJourneyState.setState({points:[null,null],picking:0});
});

import { clockMinutes, clockString, warsawNow } from "../src/lib/journeyTime";
test("quick time editing supports 24-hour text, compact input and midnight shifts",()=>{
 assert.equal(clockMinutes("8:30"),510);assert.equal(clockMinutes("0830"),510);assert.equal(clockMinutes("930"),570);
 assert.equal(clockMinutes("8"),480);assert.equal(clockMinutes("8:3"),483);
 for(const invalid of ["24:00","08:60","noon",""])assert.equal(clockMinutes(invalid),null);
 assert.equal(clockString(clockMinutes("23:55")!+15),"00:10");assert.equal(clockString(-5),"23:55");
 assert.deepEqual(warsawNow(new Date("2026-10-31T12:34:00Z")),{time:"13:34",day:"weekend"});
 assert.deepEqual(warsawNow(new Date("2026-10-30T12:34:00Z")),{time:"13:34",day:"weekday"});
});
