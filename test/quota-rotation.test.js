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
  assert.match(diagnostic, /inputEstimate=\d+ limit=\d+ bodyBytes=\d+/);
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
  assert.ok(systemText.includes('truncated by provider-agy'));
});

test('a huge tool-result history is reduced under the budget', () => {
  // One user turn followed by large tool results: there is no second turn
  // boundary, so only payload truncation can bring this under the limit. This
  // is the shape that reached the backend at ~167k tokens and got a 429.
  const messages = [{ role: 'user', content: 'leia os arquivos' }];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'tool', tool_call_id: `call_${i}`, name: 'read', content: 'y'.repeat(60_000) });
  }

  const { body } = buildCloudRequest({ model: MODEL, messages });
  const bytes = Buffer.byteLength(JSON.stringify(body));
  assert.ok(bytes < 200_000, `the request must shrink, got ${bytes} bytes`);

  const serialized = JSON.stringify(body);
  assert.ok(serialized.includes('"truncated":true'), 'oversized tool payloads must be truncated');
});

test('large text does not monopolize trimming ahead of tool results', () => {
  const messages = [{ role: 'user', content: 'x'.repeat(200_000) }];
  for (let i = 0; i < 12; i++) {
    messages.push({ role: 'tool', tool_call_id: `large_${i}`, name: 'read', content: 'y'.repeat(30_000) });
  }
  const { body } = buildCloudRequest({ model: MODEL, messages });
  const estimate = Math.ceil(JSON.stringify(body).length / 3.5);
  assert.ok(estimate <= 30_000, `request still exceeds the budget: ${estimate}`);
  assert.ok(JSON.stringify(body).includes('"truncated":true'), 'large tool results must also be reduced');
});

test('the trim terminates when the tool schemas alone exceed the budget', () => {
  // Regression: shrinking the system prompt near its floor re-added a marker
  // each pass, so the body never shrank and the event loop spun forever.
  const tools = [];
  for (let i = 0; i < 40; i++) {
    tools.push({
      type: 'function',
      function: {
        name: `tool_${i}`,
        description: 'D'.repeat(15000),
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    });
  }

  const started = Date.now();
  const { body } = buildCloudRequest({
    model: MODEL,
    messages: [{ role: 'system', content: 'S'.repeat(6000) }, { role: 'user', content: 'ok' }],
    tools,
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5000, `the trim must terminate, took ${elapsed}ms`);
  const bytes = Buffer.byteLength(JSON.stringify(body));
  assert.ok(bytes < 200_000, `tool descriptions must be truncated, got ${bytes} bytes`);
  assert.ok(JSON.stringify(body).includes('truncated by provider-agy'));
});

test('large nested tool parameter descriptions shrink without changing the schema', () => {
  const { body } = buildCloudRequest({
    model: MODEL,
    messages: [{ role: 'user', content: 'continue' }],
    tools: [{ type: 'function', function: {
      name: 'read',
      parameters: { type: 'object', required: ['path'], properties: {
        path: { type: 'string', description: 'x'.repeat(550_000) },
      } },
    } }],
  });
  const declaration = body.request.tools[0].functionDeclarations[0];
  assert.equal(declaration.name, 'read');
  assert.deepEqual(declaration.parameters.required, ['path']);
  assert.equal(declaration.parameters.properties.path.type, 'STRING');
  assert.equal(declaration.parameters.properties.path.description, undefined);
  assert.ok(Math.ceil(JSON.stringify(body).length / 3.5) <= 30_000);
});

test('irreducible oversized tool schemas fail locally instead of rotating accounts', () => {
  assert.throws(() => buildCloudRequest({
    model: MODEL,
    messages: [{ role: 'user', content: 'continue' }],
    tools: [{ type: 'function', function: {
      name: 'choose',
      parameters: { type: 'string', enum: ['x'.repeat(550_000)] },
    } }],
  }), /context exceeds provider budget/);
});

test('an AI-agent self-identification is neutralized before forwarding', () => {
  // Cloud Code answers a bare 429 RESOURCE_EXHAUSTED for this exact sentence,
  // which made every account look exhausted while quota was intact.
  const { body } = buildCloudRequest({
    model: MODEL,
    messages: [
      { role: 'system', content: "You are omp's trusted coding assistant.\n\n# Engineering\n- be brief" },
      { role: 'user', content: 'continue' },
    ],
  });
  const systemText = body.request.systemInstruction.parts[0].text;
  assert.ok(!/trusted coding assistant/i.test(systemText), 'the self-identification must not be forwarded');
  assert.ok(systemText.includes('Assistente') || systemText.includes('assistente'));
  assert.ok(systemText.includes('# Engineering'), 'the rest of the prompt must survive');
});

test('ordinary system prompts are forwarded unchanged', () => {
  const prompt = 'Você é um assistente de programação. Responda em português.';
  const { body } = buildCloudRequest({
    model: MODEL,
    messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'ok' }],
  });
  assert.equal(body.request.systemInstruction.parts[0].text, prompt);
});

test('a small request is sent unchanged', () => {
  const { body } = buildCloudRequest({
    model: MODEL,
    messages: [{ role: 'user', content: 'responda OK' }],
  });

  assert.equal(body.request.contents.length, 1);
  assert.equal(body.request.contents[0].parts[0].text, 'responda OK');
});

test('large base64 images are preserved instead of counted as text tokens', () => {
  const data = 'A'.repeat(120_000);
  const { body } = buildCloudRequest({
    model: MODEL,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'continue' },
      ...Array.from({ length: 5 }, () => ({
        type: 'image_url', image_url: { url: `data:image/png;base64,${data}` },
      })),
    ] }],
  });
  const images = body.request.contents.flatMap((entry) => entry.parts).filter((part) => part.inlineData);
  assert.equal(images.length, 5);
  assert.equal(images[0].inlineData.data, data);
});
