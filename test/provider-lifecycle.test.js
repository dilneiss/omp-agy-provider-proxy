'use strict';

/**
 * The provider is long-lived: the omp extension only starts it when /health
 * does not answer, so a process started before an edit keeps serving stale
 * code forever. These checks pin the handshake that lets the extension notice
 * that and replace the process.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 18700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lifecycle-'));

let child = null;

function expectedBuild() {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(path.join(ROOT, 'server.js')));
  hash.update(fs.readFileSync(path.join(ROOT, 'lib', 'accounts.js')));
  return hash.digest('hex').slice(0, 12);
}

async function waitUp(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) });
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('provider did not answer /health');
}

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, AGY_PROVIDER_PORT: String(PORT), AGY_STATE_DIR: stateDir },
  });
});

after(() => {
  try { child?.kill(); } catch {}
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
});

test('health reports the build derived from the files on disk', async () => {
  const health = await waitUp();
  assert.equal(health.build, expectedBuild(), 'the extension compares exactly this fingerprint');
  assert.equal(health.pid, child.pid);
  assert.ok(health.startedAt, 'a start time lets an operator see a stale process');
});

test('the budget endpoint agrees with the enforcement constants', async () => {
  const res = await fetch(`${BASE}/v1/limits`);
  assert.equal(res.status, 200);
  const limits = await res.json();
  assert.ok(limits.maxInputTokens > 0);
  assert.ok(limits.compactAtPercent >= 50 && limits.compactAtPercent <= 95);
  assert.equal(limits.trim, 'on');
});

test('shutdown stops the process so a fresh build can start', async () => {
  const res = await fetch(`${BASE}/v1/shutdown`, { method: 'POST' });
  assert.equal(res.status, 200);

  const exited = new Promise((resolve) => child.once('exit', resolve));
  const code = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
  ]);
  assert.notEqual(code, 'timeout', 'the provider must exit on its own');

  let stillUp = true;
  try {
    await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
  } catch {
    stillUp = false;
  }
  assert.equal(stillUp, false, 'the port must be released');
});
