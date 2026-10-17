import test from 'node:test';
import assert from 'node:assert/strict';
import { isGlobalIPv6, globalIPv6, shouldRecycle } from './egress-path.mjs';

test('only routable global IPv6 addresses count', () => {
  assert.equal(isGlobalIPv6('2402:6b00:de28:e900:6775:4171:2388:fa86'), true);
  assert.equal(isGlobalIPv6('2001:db8::1'), true);
  // Link-local, unique-local (including Tailscale's fd7a::/48) and loopback cannot reach the internet.
  for (const address of ['fe80::1', 'fd7a:115c:a1e0::fd39:386e', 'fc00::1', '::1', '::']) {
    assert.equal(isGlobalIPv6(address), false, address);
  }
  assert.equal(isGlobalIPv6('219.8.20.246'), false);
  assert.equal(isGlobalIPv6(undefined), false);
});

test('interface inspection ignores internal, link-local and unique-local entries', () => {
  assert.equal(globalIPv6({ eth0: [{ address: '219.8.20.246', family: 'IPv4', internal: false }] }), false);
  assert.equal(globalIPv6({ lo: [{ address: '::1', family: 'IPv6', internal: true }] }), false);
  assert.equal(globalIPv6({ tailscale0: [{ address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false }] }), false);
  assert.equal(globalIPv6({ eth0: [
    { address: 'fe80::1', family: 'IPv6', internal: false },
    { address: '2402:6b00:de28:e900::5', family: 'IPv6', internal: false },
  ] }), true);
  // Node reports the family either as a string or as the number 6 depending on the version.
  assert.equal(globalIPv6({ eth0: [{ address: '2402:6b00::1', family: 6, internal: false }] }), true);
});

test('the client is recycled only when it started before the machine had IPv6 and the upstream refused', () => {
  const base = { grew: 2, ipv6AtStart: false, ipv6Now: true, sinceLastRecycleMs: Infinity };
  assert.equal(shouldRecycle(base), true);
  assert.equal(shouldRecycle({ ...base, grew: 1 }), false, 'one refusal is not a pattern');
  assert.equal(shouldRecycle({ ...base, ipv6Now: false }), false, 'nothing to switch to');
  assert.equal(shouldRecycle({ ...base, ipv6AtStart: true }), false, 'the client already had IPv6');
  assert.equal(shouldRecycle({ ...base, sinceLastRecycleMs: 1000 }), false, 'cooldown');
  assert.equal(shouldRecycle(), false);
});

test('only refused or dropped connections are retried, never a timeout', async () => {
  const { retryableConnectionError } = await import('./index.mjs');
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const dropped = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' }) });
  const timeout = new DOMException('The operation was aborted', 'TimeoutError');
  const badBody = new SyntaxError('Unexpected token');
  const happy = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new AggregateError([
    Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  ]), { name: 'AggregateError' }) });
  assert.equal(retryableConnectionError(refused), true);
  assert.equal(retryableConnectionError(dropped), true);
  assert.equal(retryableConnectionError(happy), true, 'Happy Eyeballs wraps the per-address failures');
  assert.equal(retryableConnectionError(timeout), false);
  assert.equal(retryableConnectionError(badBody), false);
  assert.equal(retryableConnectionError(undefined), false);
});
