const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
process.env.API_KEY='anthropic-test-key';

test('Anthropic clients: native envelopes, incremental tools, cache usage and safe failures',async()=>{
 const requests=[];
 const fake=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=raw?JSON.parse(raw):null;requests.push({url:req.url,headers:req.headers,body});
  if(req.url.includes('/models'))return res.end(JSON.stringify({models:[{slug:'test-model',display_name:'Test'}]}));
  if(body.model==='limited'){res.writeHead(429,{'content-type':'application/json','retry-after':'2'});return res.end('{"error":{"message":"limited"}}');}
  res.writeHead(200,{'content-type':'text/event-stream'});
  const send=(data)=>res.write('event: '+data.type+'\r\ndata: '+JSON.stringify(data)+'\r\n\r\n');
  send({type:'response.created',response:{id:'resp_test',status:'in_progress',output:[]}});
  const tool=body.tools?.length&&!body.input.some(x=>x.type==='function_call_output');
  const item=tool?{id:'fc_test',type:'function_call',call_id:'call_test',name:'echo',arguments:'{"text":"ok"}'}:{id:'msg_test',type:'message',role:'assistant',content:[{type:'output_text',text:'HELLO'}]};
  send({type:'response.output_item.added',output_index:0,item:{...item,...(tool?{arguments:''}:{content:[]})}});
  if(tool)send({type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:'{"text":'});
  else{send({type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:''}});send({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'HEL'});}
  setTimeout(()=>{
   if(body.model==='broken'){res.destroy();return;}
   if(tool)send({type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:'"ok"}'});
   else send({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'LO'});
   send({type:'response.output_item.done',output_index:0,item});
   send({type:'response.completed',response:{id:'resp_test',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:2,input_tokens_details:{cached_tokens:8}}}});res.end();
  },80);
 });
 await new Promise(r=>fake.listen(0,'127.0.0.1',r));
 process.env.CODEX_UPSTREAM_BASE_URL=`http://127.0.0.1:${fake.address().port}`;
 const auth=require('../dist/services/auth.service');auth.getAuth=async()=>({accessToken:'upstream-test-secret',accountId:'central-test-account'});
 const {app}=require('../dist/index');const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}/anthropic/v1`;
 const headers={'content-type':'application/json','x-api-key':'anthropic-test-key'};
 const post=(body,extra={})=>fetch(base+'/messages',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
 const body={model:'test-model',max_tokens:256,system:[{type:'text',text:'help',cache_control:{type:'ephemeral'}}],metadata:{user_id:'session-test'},messages:[{role:'user',content:'hi'}]};
 try{
  let response=await post(body,{'x-api-key':'wrong'});assert.equal(response.status,401);assert.equal((await response.json()).type,'error');assert.equal(requests.length,0);
  response=await post({...body,messages:[]});assert.equal(response.status,400);assert.equal(requests.length,0);
  response=await post(body);assert.equal(response.status,200);let data=await response.json();assert.equal(data.type,'message');assert.equal(data.content[0].text,'HELLO');assert.deepEqual(data.usage,{input_tokens:2,output_tokens:2,cache_creation_input_tokens:0,cache_read_input_tokens:8});assert.equal(data.stop_reason,'end_turn');
  assert.equal(requests[0].headers.authorization,'Bearer upstream-test-secret');assert.equal(requests[0].headers['x-api-key'],undefined);
  response=await post({...body,stream:true});const reader=response.body.getReader();const first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/message_start/);assert.doesNotMatch(first,/message_stop/);let text=first;for(;;){const chunk=await reader.read();if(chunk.done)break;text+=new TextDecoder().decode(chunk.value);}assert.match(text,/"text":"HEL"/);assert.match(text,/message_stop/);
  const withTools={...body,tools:[{name:'echo',input_schema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};
  data=await(await post(withTools)).json();assert.equal(data.stop_reason,'tool_use');assert.deepEqual(data.content[0],{type:'tool_use',id:'call_test',name:'echo',input:{text:'ok'}});
  data=await(await post({...withTools,messages:[...body.messages,{role:'assistant',content:data.content},{role:'user',content:[{type:'tool_result',tool_use_id:'call_test',content:'ok'}]}]})).json();assert.equal(data.content[0].text,'HELLO');
  response=await post({...withTools,stream:true});text=await response.text();assert.match(text,/input_json_delta/);assert.match(text,/"stop_reason":"tool_use"/);
  response=await fetch(base+'/models',{headers});data=await response.json();assert.equal(data.data[0].id,'test-model');assert.equal(data.has_more,false);
  response=await post({...body,model:'limited'});assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'2');assert.equal((await response.json()).error.type,'rate_limit_error');
  response=await post({...body,model:'broken',stream:true});text=await response.text();assert.match(text,/event: error/);assert.doesNotMatch(text,/message_stop/);assert.doesNotMatch(text,/upstream-test-secret/);
  response=await fetch(base+'/messages',{method:'POST',headers,body:'{'});assert.equal(response.status,400);assert.equal((await response.json()).type,'error');
 }finally{server.closeAllConnections();fake.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>fake.close(r))]);}
});
