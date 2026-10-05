#!/usr/bin/env python3
"""Opt-in real upstream E2E. Uses existing server-side Codex login, not mocks.
Runs temporary local server; never restarts deployed service or prints credentials.
"""
import argparse,base64,json,os,pathlib,secrets,socket,struct,subprocess,tempfile,time,urllib.error,urllib.request,zlib

parser=argparse.ArgumentParser();parser.add_argument('--output');args=parser.parse_args()
repo=pathlib.Path(__file__).resolve().parents[1];report={};key=secrets.token_hex(24)
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
with tempfile.TemporaryDirectory(prefix='codex-proxy-real-e2e-') as tmp:
    env={**os.environ,'PORT':str(port),'API_KEY':key,'CODEX_PROXY_HOME':tmp+'/proxy-auth'}
    env.pop('CODEX_UPSTREAM_BASE_URL',None)
    with tempfile.TemporaryFile() as log:
        server=subprocess.Popen(['node','dist/index.js'],cwd=repo,env=env,stdout=log,stderr=log)
        base=f'http://127.0.0.1:{port}'
        def call(path,body=None):
            request=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
            try:
                with urllib.request.urlopen(request,timeout=150) as response:return response.status,json.loads(response.read())
            except urllib.error.HTTPError as error:return error.code,json.loads(error.read())
        try:
            for _ in range(50):
                try:urllib.request.urlopen(base+'/health',timeout=1);break
                except Exception:time.sleep(.1)
            status,data=call('/openai/v1/models');report['openai_models']={'status':status,'count':len(data.get('data',[]))};assert status==200 and data.get('data')
            body={'model':'gpt-6.1-sol','reasoning_effort':'low','messages':[{'role':'user','content':'Reply exactly CODEX_PROXY_E2E_OK'}]}
            status,data=call('/openai/v1/chat/completions',body);text=data.get('choices',[{}])[0].get('message',{}).get('content');report['text']={'status':status,'output':text,'usage':data.get('usage')};assert status==200 and text=='CODEX_PROXY_E2E_OK'
            body.update(tools=[{'type':'function','function':{'name':'echo','description':'Echo text','parameters':{'type':'object','properties':{'text':{'type':'string'}},'required':['text'],'additionalProperties':False}}}],tool_choice={'type':'function','function':{'name':'echo'}},messages=[{'role':'user','content':'Call echo with text CODEX_TOOL_OK.'}])
            status,data=call('/openai/v1/chat/completions',body);assert status==200;message=data['choices'][0]['message'];calls=message.get('tool_calls',[]);assert len(calls)==1 and calls[0]['function']['name']=='echo'
            body.pop('tool_choice');body['messages'] += [message]+[{'role':'tool','tool_call_id':c['id'],'content':json.loads(c['function']['arguments'])['text']} for c in calls]
            status,data=call('/openai/v1/chat/completions',body);text=data.get('choices',[{}])[0].get('message',{}).get('content');report['tool_roundtrip']={'status':status,'output':text,'usage':data.get('usage')};assert status==200 and 'CODEX_TOOL_OK' in text
            def chunk(name,content):return struct.pack('>I',len(content))+name+content+struct.pack('>I',zlib.crc32(name+content)&0xffffffff)
            png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',256,256,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+b'\xff\0\0'*256)*256))+chunk(b'IEND',b'')
            image='data:image/png;base64,'+base64.b64encode(png).decode()
            status,data=call('/openai/v1/chat/completions',{'model':'gpt-6.1-sol','reasoning_effort':'low','messages':[{'role':'user','content':[{'type':'text','text':'Name dominant color in one word.'},{'type':'image_url','image_url':{'url':image}}]}]});text=data.get('choices',[{}])[0].get('message',{}).get('content');report['image']={'status':status,'output':text};assert status==200 and 'red' in text.lower()
            cache={'model':'gpt-6.1-sol','reasoning_effort':'low','prompt_cache_key':'codex-proxy-real-e2e-cache','messages':[{'role':'system','content':'Context for cache test. '+('Neutral reference context. '*1800)+' Reply only CACHE_E2E_OK.'},{'role':'user','content':'Reply now.'}]}
            report['cache_requests']=[]
            for _ in range(2):
                status,data=call('/openai/v1/chat/completions',cache);report['cache_requests'].append({'status':status,'usage':data.get('usage'),'error':data.get('error')});assert status==200
            report['cache_hit_observed']=any(x['usage'].get('prompt_tokens_details',{}).get('cached_tokens',0)>0 for x in report['cache_requests'])
        finally:
            server.terminate();server.wait(timeout=10)
            if args.output:pathlib.Path(args.output).write_text(json.dumps(report,indent=2)+'\n')
            print(json.dumps(report,indent=2))
