import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGeocodeHandler } from "../server/geocode.mjs";

test("place search is bounded to Krakow, cached, rate limited, and rejects invalid input",async()=>{
 let calls=0,clock=1000;
 const handler=createGeocodeHandler({now:()=>clock,fetchImpl:async(url:URL,init:RequestInit)=>{
  calls++;assert.equal(url.hostname,"photon.komoot.io");assert.equal(url.searchParams.get("bbox"),"19.68,49.92,20.28,50.18");
  assert.match(String((init.headers as Record<string,string>)["User-Agent"]),/Transplan/);
  return new Response(JSON.stringify({features:[{geometry:{coordinates:[19.937,50.061]},properties:{name:"Rynek Główny",city:"Kraków"}},
   {geometry:{coordinates:[2,48]},properties:{name:"Outside"}}]}));
 }});
 const server=createServer((req,res)=>{void handler(req,res,()=>res.writeHead(404).end());});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/geocode`;
 try{
  assert.equal((await fetch(`${url}?q=aa`)).status,400);
  assert.deepEqual(await(await fetch(`${url}?q=Rynek`)).json(),[{name:"Rynek Główny, Kraków",coord:[19.937,50.061]}]);
  assert.equal((await fetch(`${url}?q=rynek`)).status,200);assert.equal(calls,1);
  assert.equal((await fetch(`${url}?q=Wawel`)).status,429);clock+=1001;
  assert.equal((await fetch(`${url}?q=Wawel`)).status,200);assert.equal(calls,2);
  assert.equal((await fetch(url,{method:"POST"})).status,405);
 }finally{await new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});}
});
