const {test}=require('node:test');const assert=require('node:assert/strict');
process.env.API_KEY='surface-test';
const {app}=require('../dist/index');
test('OpenAI inference surface exposes chat completions, not duplicate Responses',async()=>{
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={'content-type':'application/json',authorization:'Bearer surface-test'};
  const duplicate=await fetch(base+'/openai/v1/responses',{method:'POST',headers,body:'{}'});assert.equal(duplicate.status,404);
  for(const path of ['/codex/responses','/codex/responses/compact'])assert.equal((await fetch(base+path,{method:'POST',headers,body:'{}'})).status,404);
  for(const path of ['/codex/models','/codex/usage'])assert.equal((await fetch(base+path,{headers})).status,404);
  const chat=await fetch(base+'/openai/v1/chat/completions',{method:'POST',headers,body:'{}'});assert.equal(chat.status,400);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
