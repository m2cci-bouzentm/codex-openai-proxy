const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('CLI security: secret leakage prevention and argument injection resistance', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-auth-sec-'));
  try {
    const cliPath = path.resolve(__dirname, '../bin/proxy-auth');
    const env = { ...process.env, PROXY_AUTH_DIR: tmpDir };

    const secretValue = 'SECRET_TOKEN_VALUE_DO_NOT_LEAK_99999';
    const importPayload = {
      type: 'oauth',
      access: secretValue,
      refresh: 'SECRET_REFRESH_VALUE_DO_NOT_LEAK_88888',
      expires: Date.now() + 3600000,
      accountId: 'acc-secret'
    };

    const importFile = path.join(tmpDir, 'auth-secret.json');
    fs.writeFileSync(importFile, JSON.stringify(importPayload));

    // Run import
    const res = spawnSync(process.execPath, [cliPath, 'import', '--file', importFile], { env, encoding: 'utf-8' });
    assert.equal(res.status, 0);

    // Verify neither stdout nor stderr contains the secret values
    assert.ok(!res.stdout.includes(secretValue), 'stdout must not contain secret access token');
    assert.ok(!res.stdout.includes('SECRET_REFRESH_VALUE_DO_NOT_LEAK_88888'), 'stdout must not contain secret refresh token');
    assert.ok(!res.stderr.includes(secretValue), 'stderr must not contain secret access token');
    assert.ok(!res.stderr.includes('SECRET_REFRESH_VALUE_DO_NOT_LEAK_88888'), 'stderr must not contain secret refresh token');

    // Run status
    const resStatus = spawnSync(process.execPath, [cliPath, 'status'], { env, encoding: 'utf-8' });
    assert.equal(resStatus.status, 0);
    assert.ok(!resStatus.stdout.includes(secretValue));
    assert.ok(!resStatus.stdout.includes('SECRET_REFRESH_VALUE_DO_NOT_LEAK_88888'));
    assert.ok(!resStatus.stderr.includes(secretValue));
    assert.ok(!resStatus.stderr.includes('SECRET_REFRESH_VALUE_DO_NOT_LEAK_88888'));

    // Test rejection of symlinked import file
    const symlinkImport = path.join(tmpDir, 'symlink-import.json');
    fs.symlinkSync(importFile, symlinkImport);
    const resSym = spawnSync(process.execPath, [cliPath, 'import', '--file', symlinkImport], { env, encoding: 'utf-8' });
    assert.notEqual(resSym.status, 0);
    assert.match(resSym.stderr, /symlink|symbolic/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
