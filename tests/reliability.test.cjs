const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');
process.env.API_KEY='test-key';
test('chat disconnect aborts upstream; bounded errors and timeouts hide secrets',async()=>{
 let aborted,started;const closed=new Promise(r=>aborted=r);const received=new Promise(r=>started=r);
 const upstream=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
  if(body.model==='slow')return;
  if(body.model==='large'){res.setHeader('content-type','application/json');return res.end('x'.repeat(33*1024*1024));}
  res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
  if(body.model==='broken'){setTimeout(()=>res.destroy(),20);return;}
  res.on('close',aborted);started();
 });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 process.env.CODEX_UPSTREAM_BASE_URL=`http://127.0.0.1:${upstream.address().port}`;
 const auth=require('../dist/services/auth.service');auth.getAuth=async()=>({accessToken:'PRIVATE_TOKEN',accountId:'PRIVATE_ACCOUNT'});
 const {app}=require('../dist/index');const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url=`http://127.0.0.1:${server.address().port}/openai/v1/chat/completions`;
 const headers={authorization:'Bearer test-key','content-type':'application/json'};
 const body=model=>JSON.stringify({model,messages:[{role:'user',content:'hi'}],stream:true});
 const post=model=>fetch(url,{signal:AbortSignal.timeout(2000),method:'POST',headers,body:body(model)});
 try{
  const broken=await post('broken');assert.equal(broken.status,502);
  const large=await post('large');assert.equal(large.status,502);assert.doesNotMatch(await large.text(),/PRIVATE_TOKEN|PRIVATE_ACCOUNT/);
  const abort=new AbortController();const pending=fetch(url,{method:'POST',signal:abort.signal,headers,body:body('wait')}).catch(e=>e);
  await received;abort.abort();await pending;await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('upstream not cancelled')),1000))]);
  process.env.CODEX_TIMEOUT_MS='30';const timeout=await post('slow');assert.equal(timeout.status,502);delete process.env.CODEX_TIMEOUT_MS;
  auth.getAuth=async()=>{throw Error('PRIVATE_TOKEN PRIVATE_ACCOUNT');};const failed=await post('fail');assert.equal(failed.status,502);assert.doesNotMatch(await failed.text(),/PRIVATE_TOKEN|PRIVATE_ACCOUNT/);
 }finally{delete process.env.CODEX_TIMEOUT_MS;server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>upstream.close(r))]);}
});
