#!/usr/bin/env python3
"""Real Docker proxy + isolated local fake provider. No real auth/network provider.
Run: python scripts/provider-mocked-e2e.py [--image IMAGE] [--mutation]
Mutation mounts a changed compiled adapter only, never modifies production files.
"""
import argparse
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('http_cases', ROOT / 'scripts/http-cases.py')
assert spec and spec.loader
cases = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cases)
CAPTURE = []


MOCK_MODELS = [
    {'slug': 'gpt-6-astra', 'display_name': 'GPT-6-Astra', 'context_window': 272000},
    {'slug': 'gpt-6-sol', 'display_name': 'GPT-6-Sol', 'context_window': 272000},
    {'slug': 'gpt-6-luna', 'display_name': 'GPT-6-Luna', 'context_window': 272000},
    {'slug': 'gpt-reserve', 'display_name': 'GPT-Reserve', 'context_window': 272000},
    {'slug': 'gpt-5.6-sol', 'display_name': 'GPT-5.6-Sol', 'context_window': 272000},
    {'slug': 'gpt-5.6-terra', 'display_name': 'GPT-5.6-Terra', 'context_window': 272000},
    {'slug': 'gpt-5.6-luna', 'display_name': 'GPT-5.6-Luna', 'context_window': 272000},
    {'slug': 'gpt-5.5', 'display_name': 'GPT-5.5', 'context_window': 272000},
    {'slug': 'codex-auto-review', 'display_name': 'Codex Auto Review', 'context_window': 272000},
]


class Provider(BaseHTTPRequestHandler):
    def log_message(self, format, *args): pass
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'models': MOCK_MODELS}).encode())
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        CAPTURE.append({'path': self.path, 'body': body})
        tool = isinstance(body.get('tool_choice'), dict) and body['tool_choice'].get('name') == 'echo'
        item = {'type': 'function_call', 'id': 'fc_fixture', 'call_id': 'call_mock', 'name': 'echo', 'arguments': '{"value":"PROXY_HTTP_OK"}', 'status': 'completed'} if tool else {'type': 'message', 'id': 'msg_fixture', 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': 'PROXY_HTTP_OK', 'annotations': []}]}
        response = {'id': 'resp_fixture', 'object': 'response', 'model': body.get('model', 'gpt-6-astra'), 'status': 'completed', 'output': [item], 'usage': {'input_tokens': 100, 'output_tokens': 5, 'total_tokens': 105, 'input_tokens_details': {'cached_tokens': 40}}}
        events = [{'type': 'response.created', 'response': {**response, 'output': [], 'status': 'in_progress'}}, {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'arguments': ''} if tool else {**item, 'content': []}}]
        if tool:
            events += [{'type': 'response.function_call_arguments.delta', 'item_id': item['id'], 'output_index': 0, 'delta': item['arguments']}, {'type': 'response.function_call_arguments.done', 'item_id': item['id'], 'output_index': 0, 'arguments': item['arguments']}]
        else:
            events += [{'type': 'response.content_part.added', 'item_id': item['id'], 'output_index': 0, 'content_index': 0, 'part': {'type': 'output_text', 'text': ''}}, {'type': 'response.output_text.delta', 'item_id': item['id'], 'output_index': 0, 'content_index': 0, 'delta': 'PROXY_HTTP_OK'}, {'type': 'response.output_text.done', 'item_id': item['id'], 'output_index': 0, 'content_index': 0, 'text': 'PROXY_HTTP_OK'}]
        events += [{'type': 'response.output_item.done', 'output_index': 0, 'item': item}, {'type': 'response.completed', 'response': response}]
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        for event in events:
            self.wfile.write(('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n').encode()); self.wfile.flush()


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def run(image, mutation=False):
    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    name = 'proxy-http-fixture-' + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix='proxy-http-') as directory:
        temp = pathlib.Path(directory)
        # Explicitly synthetic, unexpired fixture; never reads home/auth credentials.
        (temp / 'auth.json').write_text(json.dumps({'type': 'oauth', 'access': 'synthetic-provider-fixture', 'refresh': 'unused-fixture', 'expires': 4102444800000, 'accountId': 'fixture-account'}))
        mount = []
        if mutation:
            compiled = docker('run', '--rm', '--entrypoint', 'cat', image, '/app/dist/anthropic.js')
            original = 'input_tokens: Math.max(0, (u.input_tokens || 0) - cached)'
            if original not in compiled: raise RuntimeError('cache mutation anchor absent')
            (temp / 'anthropic.js').write_text(compiled.replace(original, 'input_tokens: (u.input_tokens ?? 0)', 1))
            mount = ['-v', f'{temp / "anthropic.js"}:/app/dist/anthropic.js:ro']
        try:
            # Linux host networking keeps fake provider loopback-only.
            import socket
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
            docker('run', '-d', '--name', name, '--network', 'host', '-e', f'PORT={port}', '-e', 'API_KEY=synthetic-http-fixture', '-e', 'CODEX_PROXY_HOME=/fixture', '-e', f'CODEX_UPSTREAM_BASE_URL=http://127.0.0.1:{server.server_port}', '-v', f'{temp}:/fixture:ro', *mount, image)
            base = f'http://127.0.0.1:{port}'
            for attempt in range(100):
                try:
                    if cases.request(base, '', '/health')[0] == 200: break
                except OSError: pass
                time.sleep(.1)
            else: raise RuntimeError('Docker proxy failed readiness')
            return cases.suite(base, 'synthetic-http-fixture', 'gpt-6-astra', provider_observer=lambda: CAPTURE)
        finally:
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            server.shutdown(); server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default='codex-proxy:http-fixture')
    parser.add_argument('--no-build', action='store_true')
    parser.add_argument('--mutation', action='store_true')
    args = parser.parse_args()
    if not args.no_build:
        subprocess.run(['docker', 'build', '-t', args.image, str(ROOT)], check=True, stdout=subprocess.DEVNULL)
    report = run(args.image, args.mutation)
    print(json.dumps(report, indent=2))
    if args.mutation:
        caught = any(c['name'] == 'anthropic:text:json' and c['status'] == 'failed' and 'cache' in c.get('error', '') for c in report['cases'])
        raise SystemExit(0 if caught else 1)
    raise SystemExit(bool(report['failed']))


if __name__ == '__main__': main()
