#!/usr/bin/env python3
"""Opt-in Anthropic/Codex E2E with temporary proxy and isolated Claude Code home."""
import argparse,base64,json,os,pathlib,secrets,socket,struct,subprocess,tempfile,time,urllib.request,urllib.error,zlib
p=argparse.ArgumentParser();p.add_argument('--output');args=p.parse_args()
repo=pathlib.Path(__file__).resolve().parents[1];report={};key=secrets.token_hex(24)
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
with tempfile.TemporaryDirectory(prefix='anthropic-codex-e2e-') as tmp:
 env={**os.environ,'PORT':str(port),'API_KEY':key,'CODEX_PROXY_HOME':tmp+'/proxy-auth'};env.pop('CODEX_UPSTREAM_BASE_URL',None)
 with tempfile.TemporaryFile() as log:
  server=subprocess.Popen(['node','dist/index.js'],cwd=repo,env=env,stdout=log,stderr=log)
  base=f'http://127.0.0.1:{port}'
  def call(path,body=None):
   req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'x-api-key':key,'Content-Type':'application/json'})
   try:
    with urllib.request.urlopen(req,timeout=150) as response:
     raw=response.read().decode();return response.status,raw if body and body.get('stream') else json.loads(raw)
   except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
  try:
   for _ in range(50):
    try:urllib.request.urlopen(base+'/health',timeout=1);break
    except Exception:time.sleep(.1)
   status,data=call('/anthropic/v1/models');report['models']={'status':status,'count':len(data.get('data',[]))};assert status==200 and data.get('data')
   models=data['data'];model=next((m['id'] for m in models if m['id']=='gpt-6-sol'),models[0]['id']);report['model']=model
   body={'model':model,'max_tokens':1024,'messages':[{'role':'user','content':'Reply exactly ANTHROPIC_CODEX_OK.'}]}
   status,data=call('/anthropic/v1/messages',body);report['text']={'status':status,'content':data.get('content'),'usage':data.get('usage'),'error':data.get('error')};assert status==200 and any('ANTHROPIC_CODEX_OK' in x.get('text','') for x in data['content'])
   status,data=call('/anthropic/v1/messages',{**body,'stream':True});report['stream']={'status':status,'message_start':'event: message_start' in data,'text_delta':'text_delta' in data,'message_stop':'event: message_stop' in data};assert status==200 and all(report['stream'][x] for x in ['message_start','text_delta','message_stop'])
   tool={**body,'tools':[{'name':'echo','description':'Return the given text','input_schema':{'type':'object','properties':{'text':{'type':'string'}},'required':['text'],'additionalProperties':False}}],'tool_choice':{'type':'tool','name':'echo'},'messages':[{'role':'user','content':'Call echo with text TOOL_OK.'}]}
   status,data=call('/anthropic/v1/messages',tool);report['tool']={'status':status,'stop_reason':data.get('stop_reason'),'content':data.get('content'),'error':data.get('error')};assert status==200 and data['stop_reason']=='tool_use'
   b=next(x for x in data['content'] if x['type']=='tool_use');follow={**tool,'tool_choice':{'type':'auto'},'messages':tool['messages']+[{'role':'assistant','content':data['content']},{'role':'user','content':[{'type':'tool_result','tool_use_id':b['id'],'content':'TOOL_OK'}]}]}
   status,data=call('/anthropic/v1/messages',follow);report['tool_roundtrip']={'status':status,'content':data.get('content'),'error':data.get('error')};assert status==200
   def chunk(kind,data):return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
   png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',256,256,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+b'\xff\0\0'*256)*256))+chunk(b'IEND',b'')
   image={**body,'messages':[{'role':'user','content':[{'type':'image','source':{'type':'base64','media_type':'image/png','data':base64.b64encode(png).decode()}},{'type':'text','text':'What is the dominant color? Reply one word.'}]}]}
   status,data=call('/anthropic/v1/messages',image);report['image']={'status':status,'content':data.get('content'),'error':data.get('error')};assert status==200 and 'red' in json.dumps(data.get('content')).lower()
   cache={**body,'metadata':{'user_id':'anthropic-e2e-cache'},'system':[{'type':'text','text':'Neutral reference. '*1800+' Reply CACHE_OK.','cache_control':{'type':'ephemeral'}}]}
   report['cache']=[]
   for _ in range(2):
    status,data=call('/anthropic/v1/messages',cache);report['cache'].append({'status':status,'usage':data.get('usage')});assert status==200
   report['cache_hit_observed']=any(x['usage']['cache_read_input_tokens']>0 for x in report['cache'])
   home=pathlib.Path(tmp)/'claude-home';home.mkdir();cli_env={**os.environ,'HOME':str(home),'CLAUDE_CONFIG_DIR':str(home/'.claude'),'ANTHROPIC_BASE_URL':base+'/anthropic','ANTHROPIC_API_KEY':key,'MAX_THINKING_TOKENS':'0','DISABLE_TELEMETRY':'1','DISABLE_ERROR_REPORTING':'1','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','ANTHROPIC_DEFAULT_SONNET_MODEL':model,'ANTHROPIC_DEFAULT_HAIKU_MODEL':model,'ANTHROPIC_DEFAULT_OPUS_MODEL':model}
   for name in ['CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY']:cli_env.pop(name,None)
   common=['claude','--bare','-p','--no-session-persistence','--setting-sources','','--output-format','stream-json','--verbose','--model',model,'--max-turns','4','--system-prompt','Follow instructions precisely. Use Bash only when requested.']
   for name,prompt,options in [('text','Reply exactly CLAUDE_CODE_VIA_CODEX_OK.',['--tools','']),('tool','Use Bash to run printf CLAUDE_CODE_TOOL_OK, then reply exactly that output. Do not modify files.',['--tools','Bash','--allowedTools','Bash'])]:
    r=subprocess.run(common+options+['--',prompt],cwd=tmp,env=cli_env,text=True,capture_output=True,timeout=180)
    try:
     events=[json.loads(line) for line in r.stdout.splitlines() if line.strip()]
     parsed=next((e for e in reversed(events) if e.get('type')=='result'),{})
    except ValueError:events=[];parsed={'result':r.stdout.strip(),'stderr':r.stderr[-1500:]}
    report['claude_code_'+name]={'exit_code':r.returncode,'result':parsed.get('result'),'is_error':parsed.get('is_error'),'usage':parsed.get('usage'),'errors':parsed.get('errors'),'stderr':r.stderr[-2000:].replace(key,'[REDACTED]')}
    assert r.returncode==0 and not parsed.get('is_error'), report['claude_code_'+name]
    assert ('CLAUDE_CODE_VIA_CODEX_OK' if name=='text' else 'CLAUDE_CODE_TOOL_OK') in parsed.get('result','')
    if name=='tool':
     blocks=[b for e in events for b in e.get('message',{}).get('content',[]) if isinstance(b,dict)]
     report['claude_code_tool']['bash_call_observed']=any(b.get('type')=='tool_use' and b.get('name')=='Bash' for b in blocks)
     report['claude_code_tool']['bash_result_observed']=any(b.get('type')=='tool_result' and 'CLAUDE_CODE_TOOL_OK' in str(b.get('content')) and not b.get('is_error') for b in blocks)
     assert report['claude_code_tool']['bash_call_observed'] and report['claude_code_tool']['bash_result_observed']
  finally:
   server.terminate();server.wait(timeout=10)
   if args.output:pathlib.Path(args.output).write_text(json.dumps(report,indent=2)+'\n')
   print(json.dumps(report,indent=2))
