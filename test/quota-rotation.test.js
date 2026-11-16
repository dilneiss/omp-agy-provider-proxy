'use strict';

/**
 * Deterministic rotation checks for the ambiguous-429 path in
 * postWithAccounts. Cloud Code answers a bare 429 for both a spent quota and a
 * per-account limit, so the account's quota lookup decides:
 *   - lookup unavailable/unknown -> short cooldown, next account is tried;
 *   - lookup explicitly 0 remaining -> exhausted until the real reset;
 *   - an exhausted account is selectable again once its reset has passed.
 * The upstream transport and the quota lookup are stubbed, so no network or
 * keyring access happens.
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-rotation-'));
process.env.AGY_STATE_DIR = stateDir;

const accounts = require('../lib/accounts');
const { postWithAccounts, rotationDeps, buildCloudRequest } = require('../server');

const MODEL = 'gemini-3.8-flash-high';
const AMBIGUOUS_429 = JSON.stringify({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'Resource has been exhausted (e.g. check quota).',
  },
});

const realQuotaStateFor = accounts.quotaStateFor;
const realRefreshAccountMeta = accounts.refreshAccountMeta;
const realCallAccount = rotationDeps.callAccount;

function seedVault(ids = ['a', 'b']) {
  accounts.saveVault({
    version: 1,
    active: ids[0] || null,
    blocked: null,
    pauses: {},
    accounts: Object.fromEntries(
      ids.map((id) => [
        id,
        { id, email: `${id}@example.test`, addedAt: new Date().toISOString(), quota: {} },
      ])
    ),
  });
}

/** First account answers a bare 429, every other account succeeds. */
function stubCallAccount(calls, first = 'a') {
  rotationDeps.callAccount = async (body, account) => {
    calls.push(account.id);
    if (account.id === first) {
      return { statusCode: 429, headers: {}, text: AMBIGUOUS_429 };
    }
    return { ok: true, res: { statusCode: 200 } };
  };
}

beforeEach(() => {
  seedVault();
  accounts.quotaStateFor = async () => null;
  accounts.refreshAccountMeta = async (account) => account;
  rotationDeps.callAccount = realCallAccount;
});

after(() => {
  accounts.quotaStateFor = realQuotaStateFor;
  accounts.refreshAccountMeta = realRefreshAccountMeta;
  rotationDeps.callAccount = realCallAccount;
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
});

test('ambiguous 429 rotates immediately without a serial quota lookup', async () => {
  const calls = [];
  let quotaLookups = 0;
  stubCallAccount(calls);
  accounts.quotaStateFor = async () => {
    quotaLookups += 1;
    return null;
  };

  const startedAt = Date.now();
  const result = await postWithAccounts({}, MODEL);

  assert.equal(result.res?.statusCode, 200);
  assert.equal(quotaLookups, 0, 'fallback must not wait for a second API call to inspect quota');
  assert.equal(result.account.id, 'b');
  assert.deepEqual(calls, ['a', 'b'], 'the second account must serve the request');

  const q = accounts.findAccount('a').quota?.[MODEL] || {};
  assert.equal(q.exhaustedUntil, undefined, 'unknown state must not park it as exhausted');
  assert.equal(q.remainingFraction ?? null, null, 'exhaustion must not overwrite the quota reading');
  assert.equal(q.cooldownUntil, undefined, 'an account that was not retried to the end must not be parked');
  assert.equal(accounts.nextResetFor(MODEL), null, 'no quota reset should be invented');
  assert.equal(accounts.getPause(MODEL), null, 'the model must not be paused');
});
test('429 diagnostics report request size without logging prompt contents', async () => {
  const calls = [];
  const originalWarn = console.warn;
  const logs = [];
  stubCallAccount(calls);
  console.warn = (...args) => logs.push(args.join(' '));
  try {
    await postWithAccounts(
      { prompt: 'PRIVATE_PROMPT_SENTINEL', project: 'aicode-consumers' },
      MODEL
    );
  } finally {
    console.warn = originalWarn;
  }

  const diagnostic = logs.find((line) => line.includes('429 diagnostics:'));
  assert.ok(diagnostic, 'a 429 diagnostic line should be emitted');
  assert.match(diagnostic, /inputEstimate=\d+ limit=30000 bodyBytes=\d+/);
  assert.ok(!logs.join('\n').includes('PRIVATE_PROMPT_SENTINEL'));
});

test('a cached zero quota excludes the account until its real reset without a lookup', async () => {
  const calls = [];
  stubCallAccount(calls);
  const resetTime = new Date(Date.now() + 42 * 60 * 1000).toISOString();
  accounts.findAccount('a').quota[MODEL] = { remainingFraction: 0, resetTime };
  accounts.saveVault(accounts.loadVault());
  accounts.quotaStateFor = async () => {
    throw new Error('account A must remain unavailable until its known reset');
  };

  const result = await postWithAccounts({}, MODEL);

  assert.equal(result.account.id, 'b');
  assert.deepEqual(calls, ['b']);
  const q = accounts.findAccount('a').quota[MODEL];
  assert.equal(q.remainingFraction, 0);
  assert.equal(q.resetTime, resetTime);
  assert.equal(accounts.nextResetFor(MODEL), resetTime);
});

test('an exhausted account becomes selectable again once its reset has passed', () => {
  const past = new Date(Date.now() - 1000).toISOString();
  accounts.markExhausted('a', MODEL, past, 'quota exhausted');

  const order = accounts.selectAccountsFor(MODEL).map((a) => a.id);
  assert.ok(order.includes('a'), 'the reset account must be eligible again');
  assert.equal(order[0], 'a', 'and it should lead the queue');
  assert.equal(accounts.nextResetFor(MODEL), null);
});

test('a parked account reports its real cooldown as retry-after instead of a fixed 30s', async () => {
  seedVault(['a']);
  const calls = [];
  rotationDeps.callAccount = async (body, account) => {
    calls.push(account.id);
    return { statusCode: 429, headers: { 'retry-after': '2' }, text: AMBIGUOUS_429 };
  };
  accounts.quotaStateFor = async () => null;

  const startedAt = Date.now();
  const result = await postWithAccounts({}, MODEL);

  assert.equal(result.statusCode, 429);
  const retryAfter = Number(result.headers['retry-after']);
  assert.ok(retryAfter >= 1 && retryAfter <= 2, `retry-after should follow the cooldown, got ${retryAfter}`);

  const q = accounts.findAccount('a').quota[MODEL];
  const cooldownMs = Date.parse(q.cooldownUntil) - startedAt;
  assert.ok(cooldownMs > 0 && cooldownMs <= 2000 + 500, `upstream Retry-After should bound the cooldown, got ${cooldownMs}ms`);
  assert.equal(q.exhaustedUntil, undefined);
  assert.equal(accounts.getPause(MODEL), null);
});

test('the usage report is built from cached quota without refreshing accounts', async () => {
  // A different model keeps the report throttle used by the previous test out
  // of the way, so the report path really runs here.
  const reportModel = 'claude-sonnet-4-6';
  seedVault(['a']);
  const q = accounts.findAccount('a').quota;
  q[reportModel] = { remainingFraction: 0.42, resetTime: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
  accounts.saveVault();

  let refreshes = 0;
  accounts.refreshAccountMeta = async (account) => {
    refreshes += 1;
    return account;
  };
  accounts.quotaStateFor = async () => null;
  rotationDeps.callAccount = async () => ({
    statusCode: 429,
    headers: {},
    text: AMBIGUOUS_429,
  });

  const startedAt = Date.now();
  const result = await postWithAccounts({}, reportModel);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.statusCode, 429);
  assert.equal(refreshes, 0, 'the failure report must not refresh accounts serially');
  assert.ok(elapsedMs < 4000, `the 429 must not wait for quota refreshes, took ${elapsedMs}ms`);
  // The cached reading is still what the report saw.
  assert.equal(accounts.findAccount('a').quota[reportModel].remainingFraction, 0.42);
});

test('an oversized Retry-After is bounded to five minutes', async () => {
  seedVault(['a']);
  rotationDeps.callAccount = async () => ({
    statusCode: 429,
    headers: { 'retry-after': '3600' },
    text: AMBIGUOUS_429,
  });
  accounts.quotaStateFor = async () => null;

  const startedAt = Date.now();
  await postWithAccounts({}, MODEL);

  const q = accounts.findAccount('a').quota[MODEL];
  const cooldownMs = Date.parse(q.cooldownUntil) - startedAt;
  assert.ok(cooldownMs > 4 * 60 * 1000 && cooldownMs <= 5 * 60 * 1000 + 500, `got ${cooldownMs}ms`);
  assert.equal(q.exhaustedUntil, undefined);
});
test('large OMP system prompts are trimmed below the backend context limit', () => {
  const prompt = 'x'.repeat(140_000);
  const { body } = buildCloudRequest({
    model: MODEL,
    messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'test' }],
  });

  const systemText = body.request.systemInstruction.parts[0].text;
  assert.ok(systemText.length < prompt.length, 'oversized OMP system content must be trimmed');
  assert.ok(systemText.includes('skills/MCP catalog truncated by provider-agy'));
});
