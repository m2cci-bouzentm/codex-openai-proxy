#!/usr/bin/env python3
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

IMAGE_NAME = "codex-openai-proxy:test"

def run_cmd(cmd, check=True, capture=True):
    p = subprocess.run(cmd, stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if capture else None, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(f"Command {cmd} failed with code {p.returncode}: {p.stderr}")
    return p

def main():
    print("=== Running Docker Integration Test for proxy-auth & /data/auth.json ===")

    data_dir = tempfile.mkdtemp(prefix="codex_proxy_data_")
    import_dir = tempfile.mkdtemp(prefix="codex_proxy_import_")
    container_name = f"codex-proxy-int-test-{int(time.time())}"

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
        assert import_res.get("accountId") == "docker-acc-99"
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
            "-p", "13033:3033",
            "-e", "PORT=3033",
            "-e", "API_KEY=test-docker-key",
            "-v", f"{data_dir}:/data",
            IMAGE_NAME
        ])

        # Wait for container health / readiness
        ready = False
        for _ in range(30):
            try:
                req = urllib.request.Request("http://127.0.0.1:13033/health")
                with urllib.request.urlopen(req, timeout=1) as resp:
                    if resp.status == 200:
                        ready = True
                        break
            except Exception:
                time.sleep(0.5)
        assert ready, "Proxy container failed to become ready"

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
            "docker", "run", "--rm",
            "-v", f"{data_dir}:/data",
            "-v", f"{import_dir}:/imports:ro",
            IMAGE_NAME,
            "proxy-auth", "import", "--file", "/imports/auth.json"
        ])
        live_res = json.loads(p_live_import.stdout)
        assert live_res.get("success") is True
        assert live_res.get("accountId") == "docker-acc-reloaded"

        # Verify proxy-auth status sees new account
        p_new_status = run_cmd([
            "docker", "run", "--rm",
            "-v", f"{data_dir}:/data",
            IMAGE_NAME,
            "proxy-auth", "status"
        ])
        new_status = json.loads(p_new_status.stdout)
        assert new_status.get("configured") is True
        assert new_status.get("accountId") == "docker-acc-reloaded"

        print("=== Docker integration test PASSED! ===")

    finally:
        subprocess.run(["docker", "rm", "-f", container_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # Clear volume dir with docker if root owned
        subprocess.run(["docker", "run", "--rm", "-v", f"{data_dir}:/data", "node:22-slim", "rm", "-rf", "/data/auth.json", "/data/.codex"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(data_dir, ignore_errors=True)
        shutil.rmtree(import_dir, ignore_errors=True)

if __name__ == "__main__":
    main()
