const { test } = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

// Shared by agy-openai-proxy, claude-ai-proxy and codex-openai-proxy; keep byte-identical.
const root = path.resolve(__dirname, "..")

const sharedFiles = {
  "src/schemas/contracts.schema.ts": "99b8fa7967ce4ffc9aa237d36c3d8cf54fcc2e5eda3c7ed56687011f4853d88d",
  "src/errors/proxy-error.ts": "e6fba4d6109500d058b71c4b59de4bca5966e5fbf6a7cd03fbbb5976bec94006",
  "src/lib/require-binary.ts": "c247b686dcff51f09f5f3f81a6bd6a1492a7e430b52764ec909907a504d5710c",
  ".oxlintrc.json": "7fc9edffe3d35b3183ef3008dd329f47b251dcd09ce8b12c305b94750fbc9a5f",
  ".prettierrc.json": "afb4726df805f93506ddd6216f13f5e9f7c855a2c7f5157367e702d806659d76",
  ".prettierignore": "9805dd6cede92f1b62f3a2cde86c7af0fa3fc10ac8a37040fe937132ac02eaff",
  ".editorconfig": "25c8697d37ab1e8bcd34528e5458f32adfe98433a290166e4355f833aeb5c5c3",
}

const requiredFiles = [
  "bin/proxy-auth",
  "src/index.ts",
  "src/cli.ts",
  "src/config/index.ts",
  "src/config/models.ts",
  "src/controllers/openai.controller.ts",
  "src/controllers/anthropic.controller.ts",
  "src/errors/proxy-error.ts",
  "src/jobs/index.ts",
  "src/jobs/refresh-auth.ts",
  "src/jobs/types.ts",
  "src/lib/auth-storage.ts",
  "src/lib/require-binary.ts",
  "src/middleware/auth.ts",
  "src/middleware/validate.ts",
  "src/routes/health.ts",
  "src/routes/openai.ts",
  "src/routes/anthropic.ts",
  "src/schemas/anthropic.schema.ts",
  "src/schemas/auth.schema.ts",
  "src/schemas/config.schema.ts",
  "src/schemas/contracts.schema.ts",
  "src/schemas/openai.schema.ts",
  "src/schemas/provider.schema.ts",
  "src/services/anthropic.service.ts",
  "src/services/auth.service.ts",
  "src/services/openai.service.ts",
  "src/types/anthropic.ts",
  "src/types/auth.ts",
  "src/types/http.ts",
  "src/types/openai.ts",
  "src/utils/abort.ts",
]

const forbiddenFiles = [
  "src/app.ts",
  "src/storage.ts",
  "src/jwt.ts",
  "src/auth.ts",
  "src/models.ts",
  "src/gateway.ts",
  "src/openai.ts",
  "src/anthropic.ts",
  "src/routes/chat.ts",
  "src/routes/tools.ts",
  "src/routes/models.ts",
  "src/controllers/chat.controller.ts",
  "src/controllers/tool.controller.ts",
  "src/services/chat.service.ts",
  "src/services/tool.service.ts",
  "src/schemas/chat.schema.ts",
  "src/schemas/tool.schema.ts",
  "src/types/chat.ts",
  "src/types/tool.ts",
  "src/errors/tool-error.ts",
  "src/utils/tool-error.ts",
  "src/middleware/body.ts",
  "eslint.config.mjs",
]

const sha256 = (file) =>
  crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(root, file)))
    .digest("hex")

test("shared architecture, tooling and protocol contract remain merge-compatible", () => {
  for (const file of requiredFiles)
    assert.ok(fs.statSync(path.join(root, file)).isFile(), `Required file missing: ${file}`)
  for (const file of forbiddenFiles)
    assert.ok(!fs.existsSync(path.join(root, file)), `Obsolete file must not exist: ${file}`)
  for (const [file, hash] of Object.entries(sharedFiles))
    assert.equal(sha256(file), hash, `Shared file drifted: ${file}`)

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  assert.equal(pkg.dependencies.zod, "4.3.6")
  assert.equal(pkg.dependencies.ajv, "8.20.0")
  for (const dependency of ["cors", "dotenv", "express", "node-cron"])
    assert.ok(pkg.dependencies[dependency], `Shared dependency missing: ${dependency}`)
  assert.equal(pkg.devDependencies.prettier, "3.6.2")
  assert.equal(pkg.devDependencies.oxlint, "1.60.0")
  assert.equal(pkg.scripts.lint, "oxlint")
  assert.equal(pkg.scripts["format:check"], "prettier --check .")
  assert.equal(pkg.bin?.["proxy-auth"], "./bin/proxy-auth")

  const index = fs.readFileSync(path.join(root, "src/index.ts"), "utf8")
  for (const symbol of ["healthRouter", "openaiRouter", "anthropicRouter", "startJobs"])
    assert.match(index, new RegExp(symbol))
  assert.match(index, /app\.use\(["']\/openai\/v1["']/)
  assert.match(index, /app\.use\(["']\/anthropic["']/)
  assert.doesNotMatch(index, /app\.use\(["']\/v1["']/)
  assert.doesNotMatch(index, /app\.use\(["']\/tools\/v1["']/)
})
