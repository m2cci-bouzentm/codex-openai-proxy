#!/usr/bin/env python3
import base64
import json
import os
import shutil
import importlib.util
from pathlib import Path
import socket
import threading
import uuid
from http.server import ThreadingHTTPServer
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
IMAGE_NAME = "codex-proxy:auth-test-" + uuid.uuid4().hex

def run_cmd(cmd, check=True, capture=True, stdin=None):
    p = subprocess.run(cmd, input=stdin, stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if capture else None, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(f"Command {cmd} failed with code {p.returncode}: {p.stderr}")
    return p

def main():
    print("=== Running Docker Integration Test for proxy-auth & /data/auth.json ===", flush=True)
    # Never depend on a pre-existing test tag: build current source every run.
    run_cmd(["docker", "build", "-t", IMAGE_NAME, str(ROOT)], capture=False)

    env = {**os.environ, "PROXY_AUTH_DIR": "/host/auth-must-not-be-mounted"}
    env.pop("PROXY_AUTH_VOLUME", None)
    compose_cmd = ["docker", "compose", "--project-directory", str(ROOT), "--env-file", str(ROOT / ".env.example"), "config", "--format", "json", "--no-env-resolution"]
    def compose():
        p = subprocess.run(compose_cmd, env=env, text=True, capture_output=True, check=True)
        return json.loads(p.stdout)["services"]["codex-proxy"]
    service = compose()
    assert service["environment"]["PROXY_AUTH_DIR"] == "/data"
    mount = next(v for v in service["volumes"] if v["target"] == "/data")
    assert mount["type"] == "volume" and mount["source"] == "codex-proxy-data", mount
    env["PROXY_AUTH_VOLUME"] = "/tmp/proxy-auth-compose-fixture"
    mount = next(v for v in compose()["volumes"] if v["target"] == "/data")
    assert mount["type"] == "bind" and mount["source"] == env["PROXY_AUTH_VOLUME"], mount
    help_text = run_cmd(["docker", "run", "--rm", IMAGE_NAME, "codex", "login", "--help"]).stdout
    assert "--device-auth" in help_text, help_text
    assert run_cmd(["docker", "run", "--rm", IMAGE_NAME, "codex", "--version"]).stdout.strip() == "codex-cli 0.160.0"
    entrypoint = run_cmd(["docker", "run", "--rm", IMAGE_NAME, "cat", "/usr/local/bin/docker-entrypoint.sh"]).stdout
    assert 'exec proxy-auth' in entrypoint and 'exec "$@"' in entrypoint
    spec = importlib.util.spec_from_file_location("provider_fixture", ROOT / "scripts/provider-mocked-e2e.py")
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    observed = []
    class Provider(fixture.Provider):
        def do_POST(self):
            observed.append((self.headers.get("Authorization"), self.headers.get("ChatGPT-Account-Id")))
            super().do_POST()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    def request(token, account):
        before = len(observed)
        body = json.dumps({"model": "gpt-6-astra", "messages": [{"role": "user", "content": "fixture"}]}).encode()
        req = urllib.request.Request(base + "/openai/v1/chat/completions", data=body,
              headers={"Authorization": "Bearer test-docker-key", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as response:
            result = json.load(response)
        assert result["choices"][0]["message"]["content"] == "PROXY_HTTP_OK", result
        assert len(observed) == before + 1, observed
        assert observed[-1] == (f"Bearer {token}", account), observed[-1]
    def state():
        info = json.loads(run_cmd(["docker", "inspect", container_name]).stdout)[0]
        return info["State"]["Pid"], info["State"]["StartedAt"], info["RestartCount"]

    data_dir = f"codex-proxy-auth-data-{uuid.uuid4().hex}"
    run_cmd(["docker", "volume", "create", data_dir])
    import_dir = tempfile.mkdtemp(prefix="codex_proxy_import_")
    container_name = f"codex-proxy-int-test-{uuid.uuid4().hex}"

    try:
        # Step 1: Initial status in container on empty volume
        print("[1] Verifying initial unconfigured status via proxy-auth...")
        p_status = run_cmd([
            "docker", "run", "--rm",
            "-v", f"{data_dir}:/data",
            IMAGE_NAME,
            "proxy-auth", "status"
        ])
        status = json.loads(p_status.stdout)
        assert status.get("configured") is False, f"Expected unconfigured status, got: {status}"

        # Step 2: Import native credentials file via mounted read-only volume
        print("[2] Importing native Codex credentials via proxy-auth import --file...")
        exp_sec = int(time.time()) + 3600
        jwt_payload = {
            "exp": exp_sec,
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "docker-acc-99"
            }
        }
        b64_payload = base64.urlsafe_b64encode(json.dumps(jwt_payload).encode()).decode().rstrip("=")
        native_jwt = f"eyJhbGciOiJSUzI1NiJ9.{b64_payload}.signature"

        native_creds = {
            "tokens": {
                "id_token": native_jwt,
                "access_token": native_jwt,
                "refresh_token": "docker-native-refresh-token"
            }
        }

        import_file_host = os.path.join(import_dir, "auth.json")
        with open(import_file_host, "w") as f:
            json.dump(native_creds, f)

        p_import = run_cmd([
            "docker", "run", "--rm",
            "-v", f"{data_dir}:/data",
            "-v", f"{import_dir}:/imports:ro",
            IMAGE_NAME,
            "proxy-auth", "import", "--file", "/imports/auth.json"
        ])
        import_res = json.loads(p_import.stdout)
        assert import_res.get("success") is True
        assert import_res.get("configured") is True
        assert import_res.get("accountIdPresent") is True
        assert "docker-native-refresh-token" not in p_import.stdout

        # Verify container sees configured file and mode is 0600
        p_inspect = run_cmd([
            "docker", "run", "--rm",
            "-v", f"{data_dir}:/data",
            IMAGE_NAME,
            "stat", "-c", "%a", "/data/auth.json"
        ])
        mode = p_inspect.stdout.strip()
        assert mode == "600", f"Expected mode 600, got: {mode}"

        # Step 3: Start server container with volume
        print("[3] Starting proxy container in background...")
        run_cmd([
            "docker", "run", "-d",
            "--name", container_name,
            "--network", "host",
            "-e", f"PORT={port}",
            "-e", "PROXY_AUTH_DIR=/data",
            "-e", f"CODEX_UPSTREAM_BASE_URL=http://127.0.0.1:{server.server_port}",
            "-e", "API_KEY=test-docker-key",
            "-v", f"{data_dir}:/data",
            IMAGE_NAME
        ])

        # Wait for container health / readiness
        ready = False
        for _ in range(30):
            try:
                req = urllib.request.Request(base + "/health")
                with urllib.request.urlopen(req, timeout=1) as resp:
                    if resp.status == 200:
                        ready = True
                        break
            except Exception:
                time.sleep(0.5)
        assert ready, "Proxy container failed to become ready"

        initial_state = state()
        request(native_jwt, "docker-acc-99")

        # Step 4: Live import while server container is running
        print("[4] Testing live import update while server is running...")
        new_jwt_payload = {
            "exp": exp_sec + 7200,
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "docker-acc-reloaded"
            }
        }
        b64_new = base64.urlsafe_b64encode(json.dumps(new_jwt_payload).encode()).decode().rstrip("=")
        new_jwt = f"eyJhbGciOiJSUzI1NiJ9.{b64_new}.signature2"
        updated_creds = {
            "type": "oauth",
            "access": new_jwt,
            "refresh": "docker-refreshed-token-2",
            "expires": (exp_sec + 7200) * 1000,
            "accountId": "docker-acc-reloaded"
        }
        with open(import_file_host, "w") as f:
            json.dump(updated_creds, f)

        # Run proxy-auth import in one-off container mounting same volume
        p_live_import = run_cmd([
            "docker", "run", "--rm", "-i",
            "-v", f"{data_dir}:/data",
            IMAGE_NAME,
            "import", "-"
        ], stdin=json.dumps(updated_creds))
        live_res = json.loads(p_live_import.stdout)
        assert live_res.get("success") is True
        assert live_res.get("accountIdPresent") is True

        # Verify proxy-auth status sees new account
        p_new_status = run_cmd([
            "docker", "run", "--rm",
            "-v", f"{data_dir}:/data",
            IMAGE_NAME,
            "status"
        ])
        new_status = json.loads(p_new_status.stdout)
        assert new_status.get("configured") is True
        assert new_status.get("accountIdPresent") is True

        request(new_jwt, "docker-acc-reloaded")
        assert state() == initial_state, (initial_state, state())
        assert initial_state[2] == 0, initial_state
        print(f"=== Docker integration test PASSED! image={IMAGE_NAME} PID={initial_state[0]} restarts=0; Authorization/account changed ===")

    finally:
        subprocess.run(["docker", "rm", "-f", container_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        run_cmd(["docker", "volume", "rm", data_dir], check=False)
        shutil.rmtree(import_dir, ignore_errors=True)
        server.shutdown()
        server.server_close()
        run_cmd(["docker", "image", "rm", IMAGE_NAME], check=False)

if __name__ == "__main__":
    main()
