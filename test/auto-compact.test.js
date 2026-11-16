'use strict';

/**
 * The provider enforces a budget far below the model's advertised window, so
 * the client's own accounting never reaches a threshold on its own. The
 * extension therefore compares the session's context usage against the budget
 * the provider reports; these checks pin that boundary.
 *
 * Run with --experimental-strip-types so the extension's TypeScript can be
 * imported directly (see the `test` script).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldCompact } = require('../omp-extension/provider-agy.ts');

const BUDGET = { maxInputTokens: 30000, compactAtPercent: 80 };

test('compaction starts exactly at the configured share of the budget', () => {
  assert.equal(shouldCompact(23999, BUDGET), false);
  assert.equal(shouldCompact(24000, BUDGET), true);
  assert.equal(shouldCompact(30000, BUDGET), true);
});

test('a different percentage moves the trigger', () => {
  const half = { maxInputTokens: 30000, compactAtPercent: 50 };
  assert.equal(shouldCompact(14999, half), false);
  assert.equal(shouldCompact(15000, half), true);
  assert.equal(shouldCompact(15000, BUDGET), false);
});

test('missing or nonsense readings never trigger compaction', () => {
  assert.equal(shouldCompact(0, BUDGET), false);
  assert.equal(shouldCompact(-5, BUDGET), false);
  assert.equal(shouldCompact(Number.NaN, BUDGET), false);
  assert.equal(shouldCompact(25000, null), false);
  assert.equal(shouldCompact(25000, { maxInputTokens: 0, compactAtPercent: 80 }), false);
});

test('an unset percentage falls back to 80%', () => {
  const legacy = { maxInputTokens: 10000 };
  assert.equal(shouldCompact(7999, legacy), false);
  assert.equal(shouldCompact(8000, legacy), true);
});
