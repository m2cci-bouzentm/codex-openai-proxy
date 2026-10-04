const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');
const {prepareChat}=require('../dist/openai');
test('equivalent array text and complete historical tools survive registry changes',()=>{
 const converted=prepareChat({messages:[{role:'system',content:[{type:'text',text:'system'}]},{role:'developer',content:[{type:'text',text:'developer'}]},{role:'assistant',content:[{type:'text',text:'old'}]},{role:'user',content:'next'}]}).native;
 assert.equal(converted.instructions,'system\n\ndeveloper');assert.equal(converted.input[0].content[0].type,'output_text');
 const history=[{role:'user',content:'hi'},{role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'retired',arguments:'{"old":1}'}}]},{role:'tool',tool_call_id:'c1',content:'done'},{role:'user',content:'next'}];
 assert.equal(prepareChat({messages:history}).native.input[1].name,'retired');
 assert.throws(()=>prepareChat({messages:[history[0],{...history[1],tool_calls:[{...history[1].tool_calls[0],function:{name:'retired',arguments:'not-json'}}]},...history.slice(2)]}));
});
test('chat buffering uses idle timeout, not a total generation deadline',async()=>{
 process.env.API_KEY='review-key';process.env.CODEX_TIMEOUT_MS='200';
 const fake=http.createServer(async(req,res)=>{
  for await(const c of req){};res.writeHead(200,{'content-type':'text/event-stream'});
  res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
  let n=0;const timer=setInterval(()=>{
   if(++n<12){res.write(': heartbeat\n\n');return;}
   clearInterval(timer);res.end('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'r',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'ACTIVE_OK'}]}],usage:{input_tokens:1,output_tokens:1}}})+'\n\n');
  },50);res.on('close',()=>clearInterval(timer));
 });await new Promise(r=>fake.listen(0,'127.0.0.1',r));
 process.env.CODEX_UPSTREAM_BASE_URL=`http://127.0.0.1:${fake.address().port}`;
 const auth=require('../dist/auth');auth.getAuth=async()=>({accessToken:'test-secret',accountId:'test-account'});
 const {app}=require('../dist/index');const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/openai/v1/chat/completions`,{signal:AbortSignal.timeout(5000),method:'POST',headers:{authorization:'Bearer review-key','content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'hi'}]})});
  assert.equal(response.status,200);assert.equal((await response.json()).choices[0].message.content,'ACTIVE_OK');
 }finally{delete process.env.CODEX_TIMEOUT_MS;server.closeAllConnections();fake.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>fake.close(r))]);}
});
