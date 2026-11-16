'use strict';

/**
 * The failure this pins: a provider started before an update keeps answering
 * /health, so the extension used to leave it running and every fix stayed on
 * disk. The provider here answers like an older build (no `build`, no
 * /v1/shutdown) and must be replaced without any manual step.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 18800 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stale-'));

process.env.AGY_PROVIDER_URL = BASE;
process.env.AGY_PROVIDER_PORT = String(PORT);
process.env.AGY_PROVIDER_DIR = ROOT;
process.env.AGY_STATE_DIR = stateDir;

const { ensureProvider } = require('../omp-extension/provider-agy.ts');

function expectedBuild() {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(path.join(ROOT, 'server.js')));
  hash.update(fs.readFileSync(path.join(ROOT, 'lib', 'accounts.js')));
  return hash.digest('hex').slice(0, 12);
}

async function waitFor(check, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

const LEGACY_SOURCE = `
const http = require('node:http');
const port = Number(process.env.LEGACY_PORT);
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, provider: 'provider-agy', version: '1.5.8' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
}).listen(port, '127.0.0.1');
`;

/** An older build running as its own node process, so killing it is safe. */
function startLegacyProvider() {
  const file = path.join(stateDir, 'legacy.js');
  fs.writeFileSync(file, LEGACY_SOURCE);
  const child = spawn(process.execPath, [file], {
    stdio: 'ignore',
    env: { ...process.env, LEGACY_PORT: String(PORT) },
  });
  return child;
}

let legacy = null;
let replacementPid = null;

after(async () => {
  try { legacy?.kill(); } catch {}
  if (replacementPid) {
    try { await fetch(`${BASE}/v1/shutdown`, { method: 'POST' }); } catch {}
  }
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
});

test('a provider from older code is killed and replaced with the current one', async () => {
  legacy = startLegacyProvider();
  const legacyPid = legacy.pid;

  const up = await waitFor(async () => {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) });
      return res.ok;
    } catch {
      return false;
    }
  });
  assert.ok(up, 'the legacy provider must be listening');

  const before = await (await fetch(`${BASE}/health`)).json();
  assert.equal(before.build, undefined, 'the legacy provider advertises no build');
  assert.equal(legacy.exitCode, null, 'it is still running before the handshake');

  const result = await ensureProvider();
  assert.equal(result.ok, true);
  assert.equal(result.started, true, 'a fresh provider must start after the stale one stops');

  const health = await waitFor(async () => {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) });
      if (!res.ok) return false;
      const data = await res.json();
      return data.build === expectedBuild() ? data : false;
    } catch {
      return false;
    }
  });
  assert.ok(health, 'the replacement must report the build of the files on disk');
  replacementPid = health.pid;
  assert.notEqual(replacementPid, legacyPid, 'a new process must serve the port');

  const log = fs.readFileSync(path.join(stateDir, 'extension.log'), 'utf8');
  assert.match(log, /build differs from disk/);
  assert.match(log, /killed stale provider/);
});
