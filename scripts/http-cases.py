"""Stdlib HTTP contract cases shared by live and provider-mocked Docker runners.
Import with importlib.util.spec_from_file_location. suite never prints secrets.
provider_observer() optionally returns captured upstream request dictionaries.
"""
import json
import urllib.request
import urllib.error
from typing import Any

PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII='
PROMPT = 'Reply with exactly PROXY_HTTP_OK. No other text.'
SCHEMA = {'type': 'object', 'properties': {'value': {'type': 'string'}}, 'required': ['value'], 'additionalProperties': False}


def request(base, key, path, body=None, authenticated=True):
    headers = {'Content-Type': 'application/json', 'anthropic-version': '2023-06-01'}
    if authenticated:
        headers.update({'Authorization': 'Bearer ' + key, 'x-api-key': key})
    req = urllib.request.Request(base.rstrip('/') + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        response = urllib.request.urlopen(req, timeout=90)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, dict(response.headers), response.read().decode()


def sse(text):
    return [json.loads(line[5:].strip()) for line in text.splitlines() if line.startswith('data:') and line[5:].strip() != '[DONE]']


def suite(base, key, model, provider_observer=None):
    results = []
    def check(name, fn):
        try:
            fn()
            results.append({'name': name, 'status': 'passed'})
        except Exception as error:
            # Exception text from HTTP libraries can include URL; do not include headers or bodies.
            results.append({'name': name, 'status': 'failed', 'error': type(error).__name__ + ': ' + str(error)[:240]})
    def expect(condition, message):
        if not condition:
            raise AssertionError(message)
    def call(path, body=None, code=200, authenticated=True):
        status, headers, text = request(base, key, path, body, authenticated)
        expect(status == code, f'{path}: expected HTTP {code}, got {status}')
        return headers, text
    def catalog(path):
        _, text = call(path)
        data = json.loads(text)
        expect(any(item['id'] == model for item in data['data']), 'requested model absent from catalog')
    for path in ['/openai/v1/models', '/anthropic/v1/models']:
        check(path + ':models', lambda p=path: catalog(p))
        check(path + ':auth', lambda p=path: call(p, code=401, authenticated=False))
    for path in ['/v1/models', '/v1/chat/completions', '/v1/responses', '/responses', '/chat/completions', '/models']:
        check(path + ':removed', lambda p=path: call(p, {} if 'models' not in p else None, code=404))
    for protocol, path in [('openai', '/openai/v1/chat/completions'), ('anthropic', '/anthropic/v1/messages'), ('codex', '/codex/responses')]:
        def payload(mode, stream=False, p=protocol):
            if p == 'codex':
                b = {'model': model, 'instructions': 'Follow instructions.', 'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': PROMPT}]}], 'store': False, 'stream': stream}
            else:
                b = {'model': model, 'messages': [{'role': 'user', 'content': PROMPT}], 'stream': stream}
                if p == 'anthropic': b['max_tokens'] = 256
            if mode == 'image':
                if p == 'codex': b['input'][0]['content'].append({'type': 'input_image', 'image_url': 'data:image/png;base64,' + PNG})
                elif p == 'openai': b['messages'][0]['content'] = [{'type': 'text', 'text': PROMPT}, {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + PNG}}]
                else: b['messages'][0]['content'] = [{'type': 'text', 'text': PROMPT}, {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': PNG}}]
            if mode in ('tool', 'result'):
                if p == 'anthropic':
                    b['tools'] = [{'name': 'echo', 'description': 'Echo value', 'input_schema': SCHEMA}]
                    b['tool_choice'] = {'type': 'tool', 'name': 'echo'} if mode == 'tool' else {'type': 'none'}
                elif p == 'openai':
                    b['tools'] = [{'type': 'function', 'function': {'name': 'echo', 'description': 'Echo value', 'parameters': SCHEMA}}]
                    b['tool_choice'] = {'type': 'function', 'function': {'name': 'echo'}} if mode == 'tool' else 'none'
                else:
                    b['tools'] = [{'type': 'function', 'name': 'echo', 'parameters': SCHEMA}]
                    b['tool_choice'] = {'type': 'function', 'name': 'echo'} if mode == 'tool' else 'none'
                if mode == 'tool':
                    if p == 'codex': b['input'][0]['content'][0]['text'] = 'Call echo with value PROXY_HTTP_OK.'
                    else: b['messages'][0]['content'] = 'Call echo with value PROXY_HTTP_OK.'
                else:
                    if p == 'codex': b['input'] += [{'type': 'function_call', 'call_id': 'call_fixture', 'name': 'echo', 'arguments': '{"value":"PROXY_HTTP_OK"}'}, {'type': 'function_call_output', 'call_id': 'call_fixture', 'output': 'PROXY_HTTP_OK'}, {'role': 'user', 'content': PROMPT}]
                    elif p == 'openai': b['messages'] += [{'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'call_fixture', 'type': 'function', 'function': {'name': 'echo', 'arguments': '{"value":"PROXY_HTTP_OK"}'}}]}, {'role': 'tool', 'tool_call_id': 'call_fixture', 'content': 'PROXY_HTTP_OK'}, {'role': 'user', 'content': PROMPT}]
                    else: b['messages'] += [{'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'call_fixture', 'name': 'echo', 'input': {'value': 'PROXY_HTTP_OK'}}]}, {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'call_fixture', 'content': 'PROXY_HTTP_OK'}, {'type': 'text', 'text': PROMPT}]}]
            return b
        def exercise(mode, stream, p=protocol, route=path, make=payload):
            headers, text = call(route, make(mode, stream))
            streaming = 'text/event-stream' in headers.get('Content-Type', '')
            if stream: expect(streaming, 'stream request not SSE')
            events = sse(text) if streaming else []
            data: Any = events if streaming else json.loads(text)
            encoded = json.dumps(data)
            expect('PROXY_HTTP_OK' in encoded, 'expected marker absent')
            if mode == 'tool':
                expect(('tool_calls' if p == 'openai' else 'tool_use' if p == 'anthropic' else 'function_call') in encoded, 'tool output absent')
                if p == 'openai' and not streaming: json.loads(data['choices'][0]['message']['tool_calls'][0]['function']['arguments'])
                if p == 'anthropic' and not streaming: expect(data['stop_reason'] == 'tool_use', 'wrong tool stop reason')
            if streaming:
                expect(len(events) >= 2, 'SSE lifecycle incomplete')
                if p == 'openai':
                    expect('[DONE]' in text, 'missing SSE done sentinel')
                    if mode == 'tool':
                        arguments = ''.join(call.get('function', {}).get('arguments', '') for event in events for choice in event.get('choices', []) for call in choice.get('delta', {}).get('tool_calls', []))
                        expect(isinstance(json.loads(arguments), dict), 'invalid streamed tool arguments')
                elif p == 'anthropic':
                    expect('message_start' in encoded and 'message_stop' in encoded, 'missing Messages lifecycle')
                    if mode == 'tool':
                        arguments = ''.join(event.get('delta', {}).get('partial_json', '') for event in events)
                        expect(isinstance(json.loads(arguments), dict), 'invalid streamed tool input')
                else: expect('response.completed' in encoded, 'missing Responses completion')
            if provider_observer:
                last = provider_observer()[-1]['body']
                if mode == 'image': expect(PNG in json.dumps(last['input']), 'image lost before upstream')
                if mode == 'result': expect('function_call_output' in json.dumps(last['input']) and 'call_fixture' in json.dumps(last['input']), 'tool result lost before upstream')
                if mode == 'tool': expect(any(t.get('name') == 'echo' for t in last.get('tools', [])), 'tool definition lost')
                if mode == 'text' and not streaming:
                    if p == 'openai': expect(data['usage']['prompt_tokens_details']['cached_tokens'] == 40, 'cached usage lost')
                    elif p == 'anthropic': expect(data['usage']['cache_read_input_tokens'] == 40 and data['usage']['input_tokens'] == 60, 'cached usage double counted')
        check(protocol + ':auth', lambda r=path: call(r, {}, code=401, authenticated=False))
        for mode in ['text', 'tool', 'result', 'image']:
            for stream in [False, True]:
                check(f'{protocol}:{mode}:{"sse" if stream else "json"}', lambda m=mode, s=stream, fn=exercise: fn(m, s))
    return {'passed': sum(r['status'] == 'passed' for r in results), 'failed': sum(r['status'] == 'failed' for r in results), 'skipped': 0, 'cases': results}
