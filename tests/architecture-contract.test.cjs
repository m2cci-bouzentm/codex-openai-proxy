const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const CONTRACT_SHA256 = 'd27bead37d2e48ca147455d0c5684927ea0a6c0d09c676c58f7c53d98ce16e22';

const requiredDirs = [
  'src/config', 'src/controllers', 'src/errors', 'src/jobs', 'src/lib',
  'src/middleware', 'src/routes', 'src/schemas', 'src/services', 'src/types', 'src/utils',
];
const requiredFiles = [
  'src/index.ts', 'src/cli.ts',
  'src/config/index.ts', 'src/config/models.ts',
  'src/controllers/openai.controller.ts', 'src/controllers/anthropic.controller.ts',
  'src/errors/proxy-error.ts',
  'src/jobs/index.ts', 'src/jobs/refresh-auth.ts', 'src/jobs/types.ts',
  'src/lib/auth-storage.ts',
  'src/middleware/auth.ts', 'src/middleware/validate.ts',
  'src/routes/health.ts', 'src/routes/openai.ts', 'src/routes/anthropic.ts',
  'src/schemas/auth.schema.ts', 'src/schemas/config.schema.ts',
  'src/schemas/contracts.schema.ts', 'src/schemas/openai.schema.ts',
  'src/schemas/anthropic.schema.ts', 'src/schemas/provider.schema.ts',
  'src/services/auth.service.ts', 'src/services/openai.service.ts', 'src/services/anthropic.service.ts',
  'src/types/auth.ts', 'src/types/http.ts', 'src/types/openai.ts', 'src/types/anthropic.ts',
  'src/utils/abort.ts',
];
const forbiddenFiles = [
  'src/storage.ts', 'src/jwt.ts', 'src/auth.ts', 'src/models.ts',
  'src/gateway.ts', 'src/openai.ts', 'src/anthropic.ts', 'src/codex.ts',
  'src/routes/chat.ts', 'src/controllers/chat.controller.ts',
];

test('shared architecture and protocol contract remain merge-compatible', () => {
  for (const dir of requiredDirs) {
    assert.ok(fs.statSync(path.join(root, dir)).isDirectory(), `Required directory missing: ${dir}`);
  }
  for (const file of requiredFiles) {
    assert.ok(fs.statSync(path.join(root, file)).isFile(), `Required file missing: ${file}`);
  }
  for (const file of forbiddenFiles) {
    assert.ok(!fs.existsSync(path.join(root, file)), `Obsolete module must not exist: ${file}`);
  }
  const source = fs.readFileSync(path.join(root, 'src/schemas/contracts.schema.ts'));
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), CONTRACT_SHA256);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies.zod, '4.3.6');
  for (const dependency of ['ajv', 'cors', 'dotenv', 'express', 'node-cron', 'zod']) {
    assert.ok(pkg.dependencies[dependency], `Shared dependency missing: ${dependency}`);
  }
  const index = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
  for (const symbol of ['healthRouter', 'openaiRouter', 'anthropicRouter', 'startJobs']) {
    assert.match(index, new RegExp(symbol));
  }
  assert.doesNotMatch(index, /app\.use\(['"]\/v1['"]/);
  assert.doesNotMatch(index, /app\.use\(['"]\/tools\/v1['"]/);
});
