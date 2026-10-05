const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('auth module hot-reloading: picks up updated auth.json without process restart', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-auth-reload-'));
  try {
    process.env.PROXY_AUTH_DIR = tmpDir;
    delete require.cache[require.resolve('../dist/storage.js')];
    delete require.cache[require.resolve('../dist/auth.js')];
    const storage = require('../dist/storage.js');
    const auth = require('../dist/auth.js');

    // First auth state: token 1
    const token1Payload = { exp: Math.floor(Date.now() / 1000) + 3600, chatgpt_account_id: 'acc-1' };
    const jwt1 = 'header.' + Buffer.from(JSON.stringify(token1Payload)).toString('base64url') + '.sig';
    storage.write({
      type: 'oauth',
      access: jwt1,
      refresh: 'ref-1',
      expires: Date.now() + 3600000,
      accountId: 'acc-1'
    });

    const res1 = await auth.getAuth();
    assert.equal(res1.accessToken, jwt1);
    assert.equal(res1.accountId, 'acc-1');

    // Small delay to ensure mtime or file modification is detected
    await new Promise(r => setTimeout(r, 50));

    // Update auth file on disk (simulate CLI import or external sync)
    const token2Payload = { exp: Math.floor(Date.now() / 1000) + 7200, chatgpt_account_id: 'acc-2' };
    const jwt2 = 'header.' + Buffer.from(JSON.stringify(token2Payload)).toString('base64url') + '.sig';
    storage.write({
      type: 'oauth',
      access: jwt2,
      refresh: 'ref-2',
      expires: Date.now() + 7200000,
      accountId: 'acc-2'
    });

    // auth.getAuth should detect file change and return new tokens without restart
    const res2 = await auth.getAuth();
    assert.equal(res2.accessToken, jwt2);
    assert.equal(res2.accountId, 'acc-2');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PROXY_AUTH_DIR;
  }
});
