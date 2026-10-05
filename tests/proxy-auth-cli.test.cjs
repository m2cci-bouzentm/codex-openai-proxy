const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

test('proxy-auth CLI: status subcommand output envelope and security', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-auth-cli-'));
  try {
    const cliPath = path.resolve(__dirname, '../bin/proxy-auth');

    // Run status on unconfigured directory
    const env = { ...process.env, PROXY_AUTH_DIR: tmpDir };
    const resUnconf = spawnSync(process.execPath, [cliPath, 'status'], { env, encoding: 'utf-8' });
    assert.equal(resUnconf.status, 0);
    const statusUnconf = JSON.parse(resUnconf.stdout);
    assert.equal(statusUnconf.configured, false);

    // Import valid normalized OAuth via --file
    const authPayload = {
      type: 'oauth',
      access: 'valid-access-token-123',
      refresh: 'valid-refresh-token-456',
      expires: Date.now() + 1800000,
      accountId: 'acc-test-789'
    };
    const importFile = path.join(tmpDir, 'import.json');
    fs.writeFileSync(importFile, JSON.stringify(authPayload));

    const resImport = spawnSync(process.execPath, [cliPath, 'import', '--file', importFile], { env, encoding: 'utf-8' });
    assert.equal(resImport.status, 0);
    const importOutput = JSON.parse(resImport.stdout);
    assert.equal(importOutput.success, true);
    assert.equal(importOutput.configured, true);
    assert.equal(importOutput.accountIdPresent, true);
    // Never leak token secrets
    assert.equal(importOutput.access, undefined);
    assert.equal(importOutput.refresh, undefined);
    assert.equal(resImport.stdout.includes('valid-access-token-123'), false);
    assert.equal(resImport.stdout.includes('valid-refresh-token-456'), false);

    // Run status again
    const resConf = spawnSync(process.execPath, [cliPath, 'status'], { env, encoding: 'utf-8' });
    assert.equal(resConf.status, 0);
    const statusConf = JSON.parse(resConf.stdout);
    assert.equal(statusConf.configured, true);
    assert.equal(statusConf.accountIdPresent, true);
    assert.equal(statusConf.accountId, 'acc-test-789');
    assert.equal(resConf.stdout.includes('valid-access-token-123'), false);
    assert.equal(resConf.stdout.includes('valid-refresh-token-456'), false);

    // Check auth.json permissions
    const authFile = path.join(tmpDir, 'auth.json');
    const stat = fs.statSync(authFile);
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('proxy-auth CLI: import via stdin and rejection of invalid/secrets in argv', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-auth-stdin-'));
  try {
    const cliPath = path.resolve(__dirname, '../bin/proxy-auth');
    const env = { ...process.env, PROXY_AUTH_DIR: tmpDir };

    const nativeTokens = {
      tokens: {
        id_token: 'header.' + Buffer.from(JSON.stringify({ chatgpt_account_id: 'native-acc' })).toString('base64url') + '.sig',
        access_token: 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.sig',
        refresh_token: 'native-ref-123'
      }
    };

    // Stdin import
    const resStdin = spawnSync(process.execPath, [cliPath, 'import', '-'], {
      env,
      input: JSON.stringify(nativeTokens),
      encoding: 'utf-8'
    });
    assert.equal(resStdin.status, 0);
    const out = JSON.parse(resStdin.stdout);
    assert.equal(out.success, true);
    assert.equal(out.configured, true);
    assert.equal(out.accountId, 'native-acc');
    assert.equal(resStdin.stdout.includes('native-ref-123'), false);

    // Rejection of invalid payload
    const resBad = spawnSync(process.execPath, [cliPath, 'import', '-'], {
      env,
      input: 'not-json',
      encoding: 'utf-8'
    });
    assert.notEqual(resBad.status, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('proxy-auth CLI: login with mocked codex CLI binary handles --device and --browser', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-auth-login-'));
  try {
    const cliPath = path.resolve(__dirname, '../bin/proxy-auth');
    const fakeBinDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });

    // Create a fake `codex` executable
    const fakeCodex = path.join(fakeBinDir, 'codex');
    const fakeScript = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);

// Check if called as 'login'
if (args[0] === 'login') {
  // Save fake tokens to CODEX_HOME/auth.json
  const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const payload = {
    tokens: {
      id_token: 'id-tok',
      access_token: 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200, chatgpt_account_id: 'login-acc-1' })).toString('base64url') + '.sig',
      refresh_token: 'login-refresh-tok'
    }
  };
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(payload));
  // Record invoked arguments for assertion
  fs.writeFileSync(path.join(codexHome, 'invoked_args.json'), JSON.stringify(args));
  console.log('Login successful in fake codex');
  process.exit(0);
}
process.exit(1);
`;
    fs.writeFileSync(fakeCodex, fakeScript, { mode: 0o755 });

    const authDir = path.join(tmpDir, 'data');
    const env = {
      ...process.env,
      PROXY_AUTH_DIR: authDir,
      PATH: `${fakeBinDir}:${process.env.PATH}`
    };

    // 1. Default / --device login
    const resLogin = spawnSync(process.execPath, [cliPath, 'login', '--device'], { env, encoding: 'utf-8' });
    assert.equal(resLogin.status, 0);
    const loginOut = JSON.parse(resLogin.stdout);
    assert.equal(loginOut.success, true);
    assert.equal(loginOut.configured, true);
    assert.equal(loginOut.accountId, 'login-acc-1');
    assert.equal(resLogin.stdout.includes('login-refresh-tok'), false);

    // Verify isolated CODEX_HOME was used underneath authDir
    const expectedCodexHome = path.join(authDir, '.codex');
    assert.ok(fs.existsSync(path.join(expectedCodexHome, 'invoked_args.json')));
    const invokedArgs = JSON.parse(fs.readFileSync(path.join(expectedCodexHome, 'invoked_args.json'), 'utf-8'));
    assert.ok(invokedArgs.includes('login'));
    assert.ok(invokedArgs.includes('--device-auth'));

    // Check canonical auth.json exists in authDir
    assert.ok(fs.existsSync(path.join(authDir, 'auth.json')));
    const canonical = JSON.parse(fs.readFileSync(path.join(authDir, 'auth.json'), 'utf-8'));
    assert.equal(canonical.type, 'oauth');
    assert.equal(canonical.refresh, 'login-refresh-tok');
    assert.equal(canonical.accountId, 'login-acc-1');

    // 2. --browser login invokes without --device-auth
    const resBrowser = spawnSync(process.execPath, [cliPath, 'login', '--browser'], { env, encoding: 'utf-8' });
    assert.equal(resBrowser.status, 0);
    const browserArgs = JSON.parse(fs.readFileSync(path.join(expectedCodexHome, 'invoked_args.json'), 'utf-8'));
    assert.ok(!browserArgs.includes('--device-auth'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
