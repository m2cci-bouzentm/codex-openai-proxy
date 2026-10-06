const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { findBinary, requireBinary } = require("../dist/lib/require-binary")

test("requireBinary finds executables on PATH and explains how to install missing ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bin-"))
  const exe = path.join(dir, "fake-cli")
  fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 })
  assert.equal(findBinary("fake-cli", dir), exe)
  assert.equal(findBinary("fake-cli", ""), undefined)
  assert.throws(
    () => requireBinary("definitely-missing-cli-xyz", "npm i -g x"),
    /not found on PATH\. Install it first: npm i -g x/,
  )
  fs.rmSync(dir, { recursive: true, force: true })
})

test("proxy-auth login aborts with install instructions when codex is missing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "auth-"))
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "proxy-auth"), "login"], {
    env: { PATH: "", HOME: home, PROXY_AUTH_DIR: path.join(home, "auth"), CODEX_PROXY_HOME: path.join(home, "auth") },
    encoding: "utf8",
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /'codex' is required .* Install it first/)
  assert.equal(fs.existsSync(path.join(home, "auth", "auth.json")), false)
  fs.rmSync(home, { recursive: true, force: true })
})
