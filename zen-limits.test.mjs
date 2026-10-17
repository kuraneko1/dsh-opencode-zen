import test from 'node:test';
import assert from 'node:assert/strict';
import { zenLimits, opencodeModelOverrides } from './zen-limits.mjs';

test('measured Zen models get a 1M client limit instead of the published 200k', () => {
  const limits = zenLimits({});
  assert.deepEqual(limits['deepseek-v4.1-flash-free'], { context: 1_000_000, output: 32_000 });
  assert.deepEqual(limits['glm-5.3-flash-free'], { context: 1_000_000, output: 32_000 });
  // Unmeasured models keep whatever the catalogue declares; nothing is invented here.
  assert.equal(limits['cat-jam-free'], undefined);
  assert.equal(Object.keys(limits).length, 2);
});

test('the dedicated OpenCode config fragment carries the limits in its own shape', () => {
  const overrides = opencodeModelOverrides({});
  assert.deepEqual(overrides['glm-5.3-flash-free'], { limit: { context: 1_000_000, output: 32_000 } });
  assert.equal(Object.keys(overrides).length, 2);
});

test('environment overrides extend the table but must be valid', () => {
  const extra = JSON.stringify({ 'nemotron-3-ultra-free': { context: 900_000, output: 65_536 } });
  const limits = zenLimits({ FREEMODELS_ZEN_LIMITS: extra });
  assert.deepEqual(limits['nemotron-3-ultra-free'], { context: 900_000, output: 65_536 });
  assert.deepEqual(limits['glm-5.3-flash-free'], { context: 1_000_000, output: 32_000 }, 'measured entries survive');
  for (const bad of ['{', '[]', 'null', '{"id with space":{"context":1,"output":1}}',
    '{"ok":{"context":0,"output":1}}', '{"ok":{"context":10,"output":11}}',
    '{"ok":{"context":10000001,"output":1}}', '{"ok":{"context":1.5,"output":1}}', '{"ok":{"context":10}}']) {
    assert.throws(() => zenLimits({ FREEMODELS_ZEN_LIMITS: bad }), /FREEMODELS_ZEN_LIMITS/, bad);
  }
});
