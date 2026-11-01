// Real WebGL regression check with an isolated Chromium profile and stubbed external services.
// Run after npm run build: npm run test:map-browser; add -- --dev for Vite.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../', import.meta.url));
const development=process.argv.includes('--dev');
const temp=await mkdtemp(join(tmpdir(),'transplan-map-qa-'));
const children=[];let ws;
async function startServer() {
 const child=spawn(process.execPath,development?['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','0']:['dist-server/index.mjs'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:'0',NO_COLOR:'1',TRANSPLAN_DATA_DIR:join(temp,'networks'),TRANSPLAN_OSM_CACHE_DIR:join(temp,'osm'),TRANSPLAN_GTFS_CACHE_DIR:join(temp,'gtfs')},stdio:['ignore','pipe','pipe']});children.push(child);
 return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),5000);child.stdout.on('data',d=>{const m=/(?:localhost|127\.0\.0\.1):(\d+)/.exec(String(d));if(m){clearTimeout(timer);resolve(Number(m[1]));}});child.once('error',reject);child.stderr.on('data',d=>process.stderr.write(d));});
}
let seq=0;const pending=new Map(),listeners=new Map();
function send(method,params={}) {return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},10000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id,method,params}));});}
function on(method,fn){listeners.set(method,fn);}
async function evaluate(expression){const value=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw Error(JSON.stringify(value.exceptionDetails));return value.result.value;}
try {
 const port=await startServer(), origin=`http://127.0.0.1:${port}`;
 await build({entryPoints:[join(root,'tests/render-fixture.ts')],outfile:join(temp,'fixtures.mjs'),platform:'node',bundle:true,format:'esm'});
 const f=await import('file://'+join(temp,'fixtures.mjs'));
 const proposal={lines:[f.local,f.express,f.branch],localStops:f.stops,localTracks:[],constructionOverrides:{}};
 const createdResponse=await fetch(origin+'/api/networks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({proposal})});assert.equal(createdResponse.status,201);const created=await createdResponse.json();
 const chrome=spawn(process.env.CHROMIUM_PATH || '/usr/bin/chromium',['--headless=new','--remote-debugging-port=0',`--user-data-dir=${join(temp,'chrome')}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--window-size=1440,1000','about:blank'],{stdio:['ignore','ignore','pipe']});children.push(chrome);let chromeErrors='';chrome.stderr.on('data',d=>{chromeErrors+=d;});
 let devtools;
 for(let i=0;i<100;i++){try{devtools=(await readFile(join(temp,'chrome','DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await new Promise(r=>setTimeout(r,50));}}
 if(!devtools)throw Error('Chrome not ready: '+chromeErrors.slice(-2000));
 const pages=await(await fetch(`http://127.0.0.1:${devtools}/json/list`)).json();
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await once(ws,'open');
 ws.addEventListener('message',({data})=>{const message=JSON.parse(data);if(message.id){const p=pending.get(message.id);pending.delete(message.id);if(message.error)p?.reject(Error(JSON.stringify(message.error)));else p?.resolve(message.result);}else{const listener=listeners.get(message.method);if(listener)Promise.resolve(listener(message.params)).catch(e=>process.stderr.write(String(e)+'\n'));}});
 const errors=[],tiles=[];
 on('Runtime.exceptionThrown',p=>errors.push(p.exceptionDetails.exception?.description||p.exceptionDetails.text));
 on('Log.entryAdded',p=>{if(p.entry.level==='error')errors.push(p.entry.text);});
 on('Fetch.requestPaused',async p=>{
  const url=new URL(p.request.url);let body,contentType='application/json';
  if(url.hostname==='tile.openstreetmap.org'){
   tiles.push({url:url.href,headers:p.request.headers});
   contentType='image/png';body='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
  }else if(url.pathname==='/overpass'){body=Buffer.from('{"elements":[]}').toString('base64');}
  else if(url.hostname==='protomaps.github.io'){contentType='application/x-protobuf';body='';}
  else if(!['127.0.0.1','localhost'].includes(url.hostname)){contentType='text/css';body='';}
  else {await send('Fetch.continueRequest',{requestId:p.requestId});return;}
  await send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:contentType},{name:'Access-Control-Allow-Origin',value:'*'},{name:'Cache-Control',value:'public, max-age=86400'}],body});
 });
 await send('Page.enable');await send('Runtime.enable');await send('Log.enable');await send('Network.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__gl=[];const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,options){const webgl=type==='webgl'||type==='webgl2';const context=original.call(this,type,webgl?{...options,preserveDrawingBuffer:true}:options);if(webgl&&context&&!window.__gl.includes(context))window.__gl.push(context);return context;};`});
 await send('Page.navigate',{url:origin+'/?network='+created.id});
 let pixels;
 for(let i=0;i<150;i++){
  await new Promise(r=>setTimeout(r,100));
  pixels=await evaluate(`(()=>{const gl=window.__gl?.find(c=>c.canvas.isConnected&&c.canvas.classList.contains('maplibregl-canvas'));if(!gl)return null;const p=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);const old=gl.getParameter(gl.FRAMEBUFFER_BINDING);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,p);gl.bindFramebuffer(gl.FRAMEBUFFER,old);let red=0,blue=0,green=0;for(let i=0;i<p.length;i+=4){const r=p[i],g=p[i+1],b=p[i+2];if(r>120&&r>g*1.5&&r>b*1.2)red++;if(b>100&&b>r*1.5&&b>g*1.2)blue++;if(g>65&&g>r*1.4&&g>b*.95)green++;}const rect=gl.canvas.getBoundingClientRect();return{red,blue,green,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,scale:1}};})()`);
  if(pixels&&pixels.red>100&&pixels.blue>100&&pixels.green>100)break;
 }
 const screenshot=await send('Page.captureScreenshot',{format:'png',...(pixels?.rect?.width>0&&pixels?.rect?.height>0?{clip:pixels.rect}:{})});if(process.env.MAP_QA_SCREENSHOT)await writeFile(process.env.MAP_QA_SCREENSHOT,Buffer.from(screenshot.data,'base64'));
 const summary={mode:development?'development':'production',origin,tiles:tiles.length,tileReferers:[...new Set(tiles.map(t=>t.headers.Referer||t.headers.referer||''))],tileNoCacheHeaders:tiles.filter(t=>t.headers['Cache-Control']||t.headers.Pragma).length,pixels,errors};
 console.log(JSON.stringify(summary,null,2));
 assert.ok(pixels&&pixels.red>100&&pixels.blue>100&&pixels.green>100,'Colored transit routes must be rendered');assert.ok(tiles.length>0);assert.deepEqual(summary.tileReferers,[origin+'/']);assert.equal(summary.tileNoCacheHeaders,0);assert.deepEqual(errors,[]);
}finally{ws?.close();await Promise.all(children.reverse().map(async child=>{if(child.exitCode===null&&child.signalCode===null){const end=once(child,'exit');child.kill('SIGTERM');await end;}}));await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
