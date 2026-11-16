'use strict';

/**
 * Behavioural checks for the extension's auto-compaction handler. The provider
 * is stubbed through global fetch and the omp session through a fake ctx, so
 * this exercises the real registered `turn_end` handler, not a copy of it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const providerAgy = require('../omp-extension/provider-agy.ts').default;

const LIMITS = { maxInputTokens: 30000, compactAtPercent: 80 };

function stubProvider(data = LIMITS) {
  global.fetch = async () => ({ ok: true, json: async () => data });
}

function makeSession(tokens) {
  const handlers = {};
  const notifications = [];
  let compactions = 0;
  providerAgy({
    on(name, handler) {
      handlers[name] = handler;
    },
  });
  const ctx = {
    hasUI: true,
    ui: { notify: (text, level) => notifications.push({ text, level }) },
    getContextUsage: () => ({ tokens, contextWindow: 1048576, percent: tokens / 1048576 }),
    compact: async () => {
      compactions += 1;
    },
  };
  return {
    turnEnd: () => handlers.turn_end({}, ctx),
    notifications,
    compactionCount: () => compactions,
  };
}

test('crossing 80% of the provider budget compacts the session', async () => {
  stubProvider();
  const session = makeSession(24000);

  await session.turnEnd();

  assert.equal(session.compactionCount(), 1, 'compaction must run once');
  assert.equal(session.notifications.length, 1);
  assert.match(session.notifications[0].text, /80%\s+of\s+30000/);
  assert.equal(session.notifications[0].level, 'warning');
});

test('a session below the threshold is left alone', async () => {
  stubProvider();
  const session = makeSession(23999);

  await session.turnEnd();

  assert.equal(session.compactionCount(), 0);
  assert.deepEqual(session.notifications, []);
});

test('compaction is not stacked while the session is still settling', async () => {
  stubProvider();
  const session = makeSession(29000);

  await session.turnEnd();
  await session.turnEnd();
  await session.turnEnd();

  assert.equal(session.compactionCount(), 1, 'the cooldown must stop repeated compactions');
});

test('a failing compaction is reported instead of throwing', async () => {
  stubProvider();
  const handlers = {};
  const notifications = [];
  providerAgy({ on: (name, handler) => (handlers[name] = handler) });
  const ctx = {
    hasUI: true,
    ui: { notify: (text, level) => notifications.push({ text, level }) },
    getContextUsage: () => ({ tokens: 29500 }),
    compact: async () => {
      throw new Error('compaction already in progress');
    },
  };

  await handlers.turn_end({}, ctx);

  assert.equal(notifications.at(-1).level, 'error');
  assert.match(notifications.at(-1).text, /already in progress/);
});

test('a provider without the limits route never compacts', async () => {
  global.fetch = async () => ({ ok: false, json: async () => ({}) });
  const session = makeSession(999999);

  await session.turnEnd();

  assert.equal(session.compactionCount(), 0);
});
