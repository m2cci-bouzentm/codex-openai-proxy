#!/usr/bin/env python3
"""Opt-in live Docker HTTP E2E. Copies credentials outside build context; keeps container.
Requires explicit user authorization for real external inference. No provider mocks.
"""
import argparse, importlib.util, json, os, pathlib, secrets, shutil, subprocess, time, uuid
ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('http_cases', ROOT / 'scripts/http-cases.py')
assert spec and spec.loader
cases = importlib.util.module_from_spec(spec); spec.loader.exec_module(cases)

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--artifact-dir', required=True)
    p.add_argument('--auth-file', default=str(pathlib.Path.home() / '.codex/auth.json'))
    p.add_argument('--image', default='codex-proxy:live-e2e')
    p.add_argument('--no-build', action='store_true')
    args = p.parse_args()
    out = pathlib.Path(args.artifact_dir).absolute()
    if any(part.is_symlink() for part in [out, *out.parents]): raise SystemExit('Artifact path must not contain symlinks')
    if out.exists() and any(part.is_symlink() for part in out.rglob('*')): raise SystemExit('Artifact directory must not contain symlinks')
    if out == ROOT or ROOT in out.parents: raise SystemExit('Artifact directory must be outside repository')
    out.mkdir(parents=True, exist_ok=True); out.chmod(0o700)
    creds = out / 'credentials'; creds.mkdir(exist_ok=True); creds.chmod(0o700)
    source = pathlib.Path(args.auth_file).resolve()
    target = creds / 'auth.json'
    if source == target: raise SystemExit('Credential source must differ from copy')
    shutil.copyfile(source, target); target.chmod(0o600)
    key = secrets.token_hex(24)
    envfile = out / 'container.env'
    envfile.write_text('API_KEY='+key+'\nCODEX_HOME=/credentials\nCODEX_PROXY_HOME=/proxy-auth\n'); envfile.chmod(0o600)
    name = 'hermes-codex-e2e-' + uuid.uuid4().hex[:12]
    report = {'container': name, 'image': args.image, 'base_url': None, 'status': 'blocked', 'http': None, 'cache': {}, 'cli': {}}
    try:
        if not args.no_build: subprocess.run(['docker','build','-t',args.image,str(ROOT)],check=True,stdout=subprocess.DEVNULL)
        subprocess.run(['docker','run','-d','--name',name,'--env-file',str(envfile),'-p','127.0.0.1::3033','-v',str(creds)+':/credentials:ro',args.image],check=True,stdout=subprocess.DEVNULL)
        port = subprocess.check_output(['docker','port',name,'3033/tcp'],text=True).strip().rsplit(':',1)[1]
        base = 'http://127.0.0.1:'+port; report['base_url']=base
        for _ in range(100):
            try:
                if cases.request(base,key,'/health')[0]==200: break
            except OSError: pass
            time.sleep(.1)
        else: raise RuntimeError('Container readiness failed')
        status, _, raw = cases.request(base,key,'/openai/v1/models')
        if status != 200: raise RuntimeError('Live catalog HTTP '+str(status))
        catalog=json.loads(raw)['data']; model=catalog[0]['id']; report['model']=model
        report['http']=cases.suite(base,key,model)
        prefix='Reference facts; do not repeat them.\n'+''.join(f'Fact {n}: Stable reference sentence for upstream prompt caching verification.\n' for n in range(180))
        for protocol, route in [('openai','/openai/v1/chat/completions'),('anthropic','/anthropic/v1/messages')]:
            body={'model':model,'messages':[{'role':'user','content':prefix+'\nReply only CACHE_OK.'}]}
            if protocol=='anthropic': body['max_tokens']=64
            usages=[]
            for _ in range(3):
                status,_,text=cases.request(base,key,route,body)
                if status!=200: raise RuntimeError(protocol+' cache HTTP '+str(status))
                usages.append(json.loads(text)['usage'])
            cached=[u.get('prompt_tokens_details',{}).get('cached_tokens',0) if protocol=='openai' else u.get('cache_read_input_tokens',0) for u in usages]
            report['cache'][protocol]={'usage':usages,'cached_tokens':cached,'passed':max(cached)>0}
        # Installed Codex supports Responses only; intentionally exercise rejected chat config.
        codex_home=out/'codex-cli'; codex_home.mkdir(exist_ok=True)
        codex_home.joinpath('config.toml').write_text('model = "'+model+'"\nmodel_provider = "proxy"\n[model_providers.proxy]\nname = "proxy"\nbase_url = "'+base+'/openai/v1"\nwire_api = "chat"\nenv_key = "OPENAI_API_KEY"\n')
        env={k:v for k,v in os.environ.items() if not k.startswith(('ANTHROPIC_','CLAUDE_','OPENAI_','CODEX_'))}; env.update(CODEX_HOME=str(codex_home),OPENAI_API_KEY=key)
        result=subprocess.run(['codex','exec','--skip-git-repo-check','Reply CLI_OK'],env=env,capture_output=True,text=True,timeout=60)
        report['cli']['codex']={'exit_code':result.returncode,'incompatible_chat': 'unknown variant `chat`' in result.stderr or '`wire_api = "chat"` is no longer supported' in result.stderr, 'stderr':result.stderr.replace(key,'[REDACTED]')[:1500]}
        ccdir=out/'claude-cli'; ccdir.mkdir(exist_ok=True)
        env.update(HOME=str(ccdir),CLAUDE_CONFIG_DIR=str(ccdir),ANTHROPIC_BASE_URL=base+'/anthropic',ANTHROPIC_AUTH_TOKEN=key,ANTHROPIC_MODEL=model,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')
        for label,prompt in [('text','Reply only CLI_OK.'),('bash','Use Bash to run printf CLI_TOOL_OK, then report result.')]:
            result=subprocess.run(['claude','--bare','-p','--output-format','stream-json','--verbose','--tools','Bash','--allowedTools','Bash(printf CLI_TOOL_OK)','--',prompt],cwd=ccdir,env=env,capture_output=True,text=True,timeout=120)
            events=[]
            for line in result.stdout.splitlines():
                try: events.append(json.loads(line))
                except ValueError: pass
            evidence=json.dumps(events).replace(key,'[REDACTED]'); (out/('claude-'+label+'.json')).write_text(evidence)
            blocks=[block for event in events for block in event.get('message',{}).get('content',[]) if isinstance(block,dict)]
            calls={b['id'] for b in blocks if b.get('type')=='tool_use' and b.get('name')=='Bash' and b.get('input',{}).get('command')=='printf CLI_TOOL_OK'}
            successful=any(b.get('type')=='tool_result' and b.get('tool_use_id') in calls and not b.get('is_error') and 'CLI_TOOL_OK' in str(b.get('content','')) for b in blocks)
            terminal=any(e.get('type')=='result' and not e.get('is_error') for e in events)
            report['cli']['claude_'+label]={'exit_code':result.returncode,'tool_use':bool(calls),'tool_result':successful,'passed':result.returncode==0 and terminal and (successful if label=='bash' else 'CLI_OK' in evidence)}
        report['status']='passed' if report['http']['failed']==0 and all(c['passed'] for c in report['cache'].values()) and report['cli']['claude_bash']['passed'] and report['cli']['claude_text']['passed'] else 'failed'
    except Exception as error:
        report['error']=type(error).__name__+': '+str(error).replace(key,'[REDACTED]')[:1200]
    finally:
        (out/'report.json').write_text(json.dumps(report,indent=2)); print(json.dumps(report,indent=2))
    raise SystemExit(report['status']!='passed')
if __name__=='__main__': main()
