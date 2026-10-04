const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');
process.env.API_KEY='test-key';
test('native disconnect aborts upstream and stream failure emits error; bounded errors hide secrets',async()=>{
 let aborted;let release;const closed=new Promise(r=>aborted=r);
 const upstream=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
  if(body.model==='slow')return;
  if(body.model==='large'){res.setHeader('content-type','application/json');return res.end('x'.repeat(33*1024*1024));}
  if(body.model==='compact'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({object:'response.compaction',output:[{type:'compaction',encrypted_content:'opaque-test'}]}));}
  res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
  if(body.model==='broken'){setTimeout(()=>res.destroy(),20);return;}
  res.on('close',aborted);await new Promise(r=>release=r);res.end();
 });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 process.env.CODEX_UPSTREAM_BASE_URL=`http://127.0.0.1:${upstream.address().port}`;
 const auth=require('../dist/auth');auth.getAuth=async()=>({accessToken:'PRIVATE_TOKEN',accountId:'PRIVATE_ACCOUNT'});
 const {app}=require('../dist/index');const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url=`http://127.0.0.1:${server.address().port}/codex/responses`;
 const post=(model,suffix='')=>fetch(url+suffix,{signal:AbortSignal.timeout(2000),method:'POST',headers:{authorization:'Bearer test-key','content-type':'application/json'},body:JSON.stringify({model,input:[],stream:true,store:false})});
 try{
  const broken=await post('broken');assert.match(await broken.text(),/event: error/);
  const large=await post('large');assert.equal(large.status,502);assert.doesNotMatch(await large.text(),/PRIVATE_TOKEN|PRIVATE_ACCOUNT/);
  const compact=await post('compact','/compact');assert.equal(compact.status,200);assert.equal((await compact.json()).output[0].encrypted_content,'opaque-test');
  const abort=new AbortController();const response=await fetch(url,{method:'POST',signal:abort.signal,headers:{authorization:'Bearer test-key','content-type':'application/json'},body:JSON.stringify({model:'wait',input:[],stream:true,store:false})});
  await response.body.getReader().read();abort.abort();await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('upstream not cancelled')),1000))]);release();
  process.env.CODEX_TIMEOUT_MS='30';const timeout=await post('slow');assert.equal(timeout.status,504);delete process.env.CODEX_TIMEOUT_MS;
  auth.getAuth=async()=>{throw Error('PRIVATE_TOKEN PRIVATE_ACCOUNT');};const failed=await post('fail');assert.equal(failed.status,502);assert.doesNotMatch(await failed.text(),/PRIVATE_TOKEN|PRIVATE_ACCOUNT/);
 }finally{release?.();server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>upstream.close(r))]);}
});
