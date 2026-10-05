const {test}=require('node:test');const assert=require('node:assert/strict');
const {prepareChat}=require('../dist/services/openai.service');
const tool={type:'function',function:{name:'echo',parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}};
test('images and system/developer instructions survive conversion; cache key stays stable across turns',()=>{
 const base={model:'test',tools:[tool],messages:[{role:'system',content:'one'},{role:'developer',content:'two'},{role:'user',content:[{type:'text',text:'hi'},{type:'image_url',image_url:{url:'data:image/png;base64,AA==',detail:'low'}}]}]};
 const first=prepareChat(base).native;assert.equal(first.instructions,'one\n\ntwo');assert.equal(first.input[0].content[1].type,'input_image');
 const second=prepareChat({...base,messages:[...base.messages,{role:'assistant',content:'hi'},{role:'user',content:'next'}]}).native;
 assert.equal(first.prompt_cache_key,second.prompt_cache_key);assert.equal(first.store,false);assert.equal(first.stream,true);
});
test('tool conversation rejects unmatched/missing results and invalid historical arguments',()=>{
 const base={tools:[tool],messages:[{role:'user',content:'hi'}]};
 assert.throws(()=>prepareChat({...base,messages:[...base.messages,{role:'tool',tool_call_id:'missing',content:'x'}]}));
 const call={role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'echo',arguments:'{"text":"ok"}'}}]};
 assert.throws(()=>prepareChat({...base,messages:[...base.messages,call]}));
 const history=[...base.messages,call,{role:'tool',tool_call_id:'c1',content:'ok'}];assert.equal(prepareChat({...base,messages:history}).native.input.at(-1).type,'function_call_output');
 const bad={...call,tool_calls:[{...call.tool_calls[0],function:{name:'echo',arguments:'not-json'}}]};assert.throws(()=>prepareChat({...base,messages:[...base.messages,bad,{role:'tool',tool_call_id:'c1',content:'ok'}]}));
});
test('reasoning context and cache options preserve native fields',()=>{
 const item={type:'reasoning',id:'rs_1',encrypted_content:'opaque',summary:[]};
 const prepared=prepareChat({prompt_cache_options:{ttl:'30m'},messages:[{role:'user',content:'hi'},{role:'assistant',content:'ok',reasoning_details:[item]},{role:'user',content:'next'}]}).native;
 assert.deepEqual(prepared.input[1],item);assert.deepEqual(prepared.prompt_cache_options,{ttl:'30m'});assert.deepEqual(prepared.include,['reasoning.encrypted_content']);
});
test('unsupported fields and duplicate tools fail before inference',()=>{
 const base={messages:[{role:'user',content:'hi'}]};
 for(const extra of [{n:2},{response_format:{type:'json_object'}},{tools:[tool,tool]},{messages:[]},{messages:[{role:'unknown',content:'x'}]}])assert.throws(()=>prepareChat({...base,...extra}));
});
