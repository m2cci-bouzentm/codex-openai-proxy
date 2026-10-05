"""Fallback diagnostic only: real Node proxy, same cases, cache mutation RED/GREEN.
Not a substitute for Docker execution. Copies dist to temp; leaves source intact.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('mock_runner', ROOT / 'scripts/provider-mocked-e2e.py')
assert spec and spec.loader
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def run(mutation):
    server = runner.ThreadingHTTPServer(('127.0.0.1', 0), runner.Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix='proxy-local-fixture-') as directory:
        temp = Path(directory)
        shutil.copytree(ROOT / 'dist', temp / 'dist')
        if mutation:
            adapter = temp / 'dist/anthropic.js'
            compiled = adapter.read_text()
            anchor = 'input_tokens: Math.max(0, (u.input_tokens || 0) - cached)'
            assert anchor in compiled
            adapter.write_text(compiled.replace(anchor, 'input_tokens: (u.input_tokens || 0)', 1))
        (temp / 'auth.json').write_text(json.dumps({'type': 'oauth', 'access': 'synthetic', 'refresh': 'unused', 'expires': 4102444800000, 'accountId': 'fixture'}))
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        env = {**os.environ, 'NODE_PATH': str(ROOT / 'node_modules'), 'PORT': str(port), 'API_KEY': 'synthetic', 'CODEX_PROXY_HOME': str(temp), 'CODEX_UPSTREAM_BASE_URL': f'http://127.0.0.1:{server.server_port}'}
        process = subprocess.Popen(['node', str(temp / 'dist/index.js')], env=env, stdout=subprocess.DEVNULL)
        try:
            for _ in range(100):
                try:
                    runner.cases.request(f'http://127.0.0.1:{port}', '', '/health'); break
                except OSError: time.sleep(.1)
            return runner.cases.suite(f'http://127.0.0.1:{port}', 'synthetic', 'gpt-5.4', lambda: runner.CAPTURE)
        finally:
            process.terminate(); process.wait(); server.shutdown(); server.server_close()


if __name__ == '__main__':
    red = run(True)
    caught = [c for c in red['cases'] if c['name'] == 'anthropic:text:json' and c['status'] == 'failed' and 'cache' in c.get('error', '')]
    assert caught, 'cache mutation escaped regression case'
    baseline = run(False)
    print(json.dumps({'mutation': {'passed': red['passed'], 'failed': red['failed'], 'caught': caught}, 'baseline': baseline}, indent=2))
    assert baseline['failed'] == 0, 'baseline HTTP integration cases failed'
