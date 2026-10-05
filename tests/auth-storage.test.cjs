const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

test('storage contract: paths, permissions, parsing, and status', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-auth-test-'));
  try {
    process.env.PROXY_AUTH_DIR = tmpDir;
    // Delete require cache to reload storage
    delete require.cache[require.resolve('../dist/lib/auth-storage')];
    const storage = require('../dist/lib/auth-storage');

    assert.equal(storage.getAuthDir(), tmpDir);
    assert.equal(storage.getAuthFile(), path.join(tmpDir, 'auth.json'));

    // Check directory created with 0700 if not existing
    const customDir = path.join(tmpDir, 'nested-auth');
    process.env.PROXY_AUTH_DIR = customDir;
    delete require.cache[require.resolve('../dist/lib/auth-storage')];
    const storage2 = require('../dist/lib/auth-storage');
    storage2.ensureAuthDir();
    const dirStat = fs.statSync(customDir);
    assert.equal(dirStat.mode & 0o777, 0o700);

    // Initial status: not configured
    let status = storage2.getStatus();
    assert.equal(status.configured, false);

    // Save normalized oauth
    const sampleOAuth = {
      type: 'oauth',
      access: 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, chatgpt_account_id: 'acc-123' })).toString('base64url') + '.sig',
      refresh: 'ref-token-xyz',
      expires: Date.now() + 3600000,
      accountId: 'acc-123'
    };
    storage2.write(sampleOAuth);

    const fileStat = fs.statSync(storage2.getAuthFile());
    assert.equal(fileStat.mode & 0o777, 0o600);

    status = storage2.getStatus();
    assert.equal(status.configured, true);
    assert.equal(status.type, 'oauth');
    assert.equal(status.accountIdPresent, true);
    assert.equal(typeof status.expiresAt, 'string');
    // Ensure tokens are NEVER leaked in status
    assert.equal(status.access, undefined);
    assert.equal(status.refresh, undefined);
    assert.equal(status.tokens, undefined);

    // Test rejection of symlinks
    const linkTarget = path.join(tmpDir, 'target.json');
    fs.writeFileSync(linkTarget, '{}');
    const linkFile = path.join(customDir, 'symlink-auth.json');
    fs.symlinkSync(linkTarget, linkFile);
    assert.throws(() => storage2.assertSafeFile(linkFile), /symlink/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PROXY_AUTH_DIR;
  }
});

test('storage normalizeAndSave: handles native Codex tokens and normalized OAuth, rejects invalid', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-auth-norm-'));
  try {
    process.env.PROXY_AUTH_DIR = tmpDir;
    delete require.cache[require.resolve('../dist/lib/auth-storage')];
    const storage = require('../dist/lib/auth-storage');

    const expSec = Math.floor(Date.now() / 1000) + 7200;
    const jwtPayload = {
      exp: expSec,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'org-abc'
      }
    };
    const b64Payload = Buffer.from(JSON.stringify(jwtPayload)).toString('base64url');
    const dummyJwt = `eyJhbGciOiJSUzI1NiJ9.${b64Payload}.dummySig`;

    // 1. Native Codex tokens format
    const nativeInput = {
      tokens: {
        id_token: dummyJwt,
        access_token: dummyJwt,
        refresh_token: 'native-refresh-token'
      }
    };
    const saved1 = storage.normalizeAndSave(nativeInput);
    assert.equal(saved1.type, 'oauth');
    assert.equal(saved1.access, dummyJwt);
    assert.equal(saved1.refresh, 'native-refresh-token');
    assert.equal(saved1.accountId, 'org-abc');
    assert.equal(saved1.expires, expSec * 1000);

    // 2. Normalized format input
    const normalizedInput = {
      type: 'oauth',
      access: dummyJwt,
      refresh: 'direct-refresh',
      expires: (expSec + 100) * 1000,
      accountId: 'custom-acc'
    };
    const saved2 = storage.normalizeAndSave(normalizedInput);
    assert.equal(saved2.access, dummyJwt);
    assert.equal(saved2.refresh, 'direct-refresh');
    assert.equal(saved2.accountId, 'custom-acc');
    assert.equal(saved2.expires, (expSec + 100) * 1000);

    // 3. Invalid inputs: empty tokens, malformed JSON, missing refresh
    assert.throws(() => storage.normalizeAndSave({}), /invalid/i);
    assert.throws(() => storage.normalizeAndSave({ tokens: { access_token: '' } }), /invalid/i);
    assert.throws(() => storage.normalizeAndSave({ type: 'oauth', access: 'foo' }), /invalid/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PROXY_AUTH_DIR;
  }
});
