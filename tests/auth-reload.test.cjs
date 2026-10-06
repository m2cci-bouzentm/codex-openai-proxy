const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")

async function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-auth-race-"))
  const oldEnv = { PROXY_AUTH_DIR: process.env.PROXY_AUTH_DIR, CODEX_HOME: process.env.CODEX_HOME }
  const oldFetch = global.fetch
  process.env.PROXY_AUTH_DIR = dir
  process.env.CODEX_HOME = path.join(dir, "native")
  fs.mkdirSync(process.env.CODEX_HOME)
  for (const name of ["lib/auth-storage", "services/auth.service"])
    delete require.cache[require.resolve(`../dist/${name}.js`)]
  const storage = require("../dist/lib/auth-storage")
  const auth = require("../dist/services/auth.service")
  try {
    await run({ dir, storage, auth })
  } finally {
    global.fetch = oldFetch
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
const entry = (access = "A", expires = Date.now() + 3600000) => ({
  type: "oauth",
  access,
  refresh: `refresh-${access}`,
  expires,
  accountId: `account-${access}`,
  subscriptionType: "plus",
  scopes: ["scope-A"],
})
function deferredFetch() {
  let resolve
  global.fetch = () =>
    new Promise((r) => {
      resolve = r
    })
  return () =>
    resolve({
      ok: true,
      json: async () => ({ access_token: "refreshed-A", refresh_token: "rotated-A", expires_in: 3600 }),
    })
}

for (const change of ["delete", "invalid", "symlink"]) {
  test(`cached credentials fail closed after ${change}, without native fallback`, () =>
    fixture(async ({ dir, storage, auth }) => {
      const nativeToken =
        "header." +
        Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") +
        ".sig"
      fs.writeFileSync(
        storage.CODEX_CLI_AUTH,
        JSON.stringify({ tokens: { access_token: nativeToken, refresh_token: "native-refresh" } }),
      )
      storage.write(entry())
      await auth.getAuth()
      const file = storage.getAuthFile()
      if (change === "invalid") fs.writeFileSync(file, "{}")
      else {
        fs.unlinkSync(file)
        if (change === "symlink") {
          fs.writeFileSync(path.join(dir, "target"), JSON.stringify(entry("B")))
          fs.symlinkSync(path.join(dir, "target"), file)
        }
      }
      await assert.rejects(auth.getAuth(), /credentials/i)
    }))
  test(`pending refresh discards response after ${change}`, () =>
    fixture(async ({ dir, storage, auth }) => {
      storage.write(entry("A", 0))
      const release = deferredFetch()
      const pending = auth.getAuth()
      const rejected = assert.rejects(pending, /credentials/i)
      const file = storage.getAuthFile()
      if (change === "invalid") fs.writeFileSync(file, "{}")
      else {
        fs.unlinkSync(file)
        if (change === "symlink") {
          fs.writeFileSync(path.join(dir, "target"), JSON.stringify(entry("B")))
          fs.symlinkSync(path.join(dir, "target"), file)
        }
      }
      release()
      await rejected
      if (change === "delete") assert.equal(fs.existsSync(file), false)
      if (change === "invalid") assert.equal(fs.readFileSync(file, "utf8"), "{}")
      if (change === "symlink") assert.equal(fs.lstatSync(file).isSymbolicLink(), true)
    }))
}

test("pending refresh cannot overwrite replacement or mix its metadata", () =>
  fixture(async ({ storage, auth }) => {
    storage.write(entry("A", 0))
    const release = deferredFetch()
    const pending = auth.getAuth()
    storage.write(entry("B"))
    assert.equal((await auth.getAuth()).accessToken, "B")
    release()
    assert.equal((await pending).accessToken, "B")
    assert.deepEqual(storage.read(), entry("B", storage.read().expires))
  }))

test("successful refresh preserves snapshot metadata and subsequent reload matches disk", () =>
  fixture(async ({ storage, auth }) => {
    storage.write(entry("A", 0))
    const release = deferredFetch()
    const pending = auth.getAuth()
    release()
    assert.equal((await pending).accessToken, "refreshed-A")
    assert.equal(storage.read().subscriptionType, "plus")
    assert.deepEqual(storage.read().scopes, ["scope-A"])
    assert.deepEqual(await auth.getAuth(), { accessToken: storage.read().access, accountId: storage.read().accountId })
  }))

test("refresh-only canonical refreshes immediately; valid access-only does not fetch", () =>
  fixture(async ({ storage, auth }) => {
    storage.write({ type: "oauth", access: "", refresh: "refresh-only", expires: 0 })
    const release = deferredFetch()
    const pending = auth.getAuth()
    release()
    assert.equal((await pending).accessToken, "refreshed-A")
    storage.write({ ...entry("access-only"), refresh: "" })
    global.fetch = () => {
      throw new Error("unexpected fetch")
    }
    assert.equal((await auth.getAuth()).accessToken, "access-only")
  }))

test("pending refresh detects same-size in-place replacement with restored mtime", () =>
  fixture(async ({ storage, auth }) => {
    const file = storage.getAuthFile()
    storage.write(entry("A", 0))
    const before = fs.statSync(file)
    const release = deferredFetch()
    const pending = auth.getAuth()
    const replacement = fs.readFileSync(file, "utf8").replaceAll("A", "B")
    fs.writeFileSync(file, replacement)
    fs.utimesSync(file, before.atime, before.mtime)
    // Replacement remains expired, so response A must be discarded, then B refreshed.
    let refreshBody
    global.fetch = async (_url, options) => {
      refreshBody = options.body
      return { ok: true, json: async () => ({ access_token: "refreshed-B", expires_in: 3600 }) }
    }
    release()
    assert.equal((await pending).accessToken, "refreshed-B")
    assert.match(refreshBody, /refresh_token=refresh-B/)
    assert.equal(storage.read().accountId, "account-B")
    assert.equal(storage.read().refresh, "refresh-B")
  }))

test("same generation concurrent callers share refresh", () =>
  fixture(async ({ storage, auth }) => {
    storage.write(entry("A", 0))
    const release = deferredFetch()
    const fetchImpl = global.fetch
    let calls = 0
    global.fetch = (...args) => {
      calls++
      return fetchImpl(...args)
    }
    const first = auth.getAuth()
    const second = auth.getAuth()
    release()
    assert.deepEqual(await first, await second)
    assert.equal(calls, 1)
  }))

test("native valid tokens seed through storage parser", () =>
  fixture(async ({ storage, auth }) => {
    const token =
      "header." +
      Buffer.from(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, chatgpt_account_id: "native-account" }),
      ).toString("base64url") +
      ".sig"
    fs.writeFileSync(
      storage.CODEX_CLI_AUTH,
      JSON.stringify({ tokens: { access_token: token, refresh_token: "native-refresh" } }),
    )
    assert.deepEqual(await auth.getAuth(), { accessToken: token, accountId: "native-account" })
    assert.equal(storage.read().refresh, "native-refresh")
  }))

test("native symlink must never seed canonical credentials", () =>
  fixture(async ({ dir, storage, auth }) => {
    const token =
      "header." +
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") +
      ".sig"
    const target = path.join(dir, "native-target")
    fs.writeFileSync(target, JSON.stringify({ tokens: { access_token: token, refresh_token: "native-refresh" } }))
    fs.symlinkSync(target, storage.CODEX_CLI_AUTH)
    await assert.rejects(auth.getAuth(), /credentials/i)
    assert.equal(fs.existsSync(storage.getAuthFile()), false)
  }))

test("auth module hot-reloading: picks up updated auth.json without process restart", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-auth-reload-"))
  try {
    process.env.PROXY_AUTH_DIR = tmpDir
    delete require.cache[require.resolve("../dist/lib/auth-storage")]
    delete require.cache[require.resolve("../dist/services/auth.service")]
    const storage = require("../dist/lib/auth-storage")
    const auth = require("../dist/services/auth.service")

    // First auth state: token 1
    const token1Payload = { exp: Math.floor(Date.now() / 1000) + 3600, chatgpt_account_id: "acc-1" }
    const jwt1 = "header." + Buffer.from(JSON.stringify(token1Payload)).toString("base64url") + ".sig"
    storage.write({
      type: "oauth",
      access: jwt1,
      refresh: "ref-1",
      expires: Date.now() + 3600000,
      accountId: "acc-1",
    })

    const res1 = await auth.getAuth()
    assert.equal(res1.accessToken, jwt1)
    assert.equal(res1.accountId, "acc-1")

    // Small delay to ensure mtime or file modification is detected
    await new Promise((r) => setTimeout(r, 50))

    // Update auth file on disk (simulate CLI import or external sync)
    const token2Payload = { exp: Math.floor(Date.now() / 1000) + 7200, chatgpt_account_id: "acc-2" }
    const jwt2 = "header." + Buffer.from(JSON.stringify(token2Payload)).toString("base64url") + ".sig"
    storage.write({
      type: "oauth",
      access: jwt2,
      refresh: "ref-2",
      expires: Date.now() + 7200000,
      accountId: "acc-2",
    })

    // auth.getAuth should detect file change and return new tokens without restart
    const res2 = await auth.getAuth()
    assert.equal(res2.accessToken, jwt2)
    assert.equal(res2.accountId, "acc-2")
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.PROXY_AUTH_DIR
  }
})
