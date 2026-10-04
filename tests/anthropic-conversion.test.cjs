const {test}=require('node:test');
const assert=require('node:assert/strict');
const {prepareAnthropic}=require('../dist/anthropic');
test('Claude Code Draft 2020-12 tools validate the declared schema rather than downgrading it',()=>{
 const prepared=prepareAnthropic({model:'test-model',max_tokens:256,messages:[{role:'user',content:'hi'}],tools:[{name:'Bash',input_schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false}}]});
 const valid=prepared.validators.get('Bash');assert.ok(valid({command:'printf OK'}));assert.equal(valid({command:3}),false);
});
