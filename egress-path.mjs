// The egress path decides whether the upstream free-tier gate answers at all.
//
// Measured 2026-10-17: the same account, client version and request were accepted over a global
// IPv6 egress and refused with 403 FreeTierError over the IPv4 egress of a machine whose wired
// connection had IPv6 disabled. Two consequences are encoded here:
//
//   1. A machine with no usable global IPv6 can be refused purely because of its network.
//   2. The dedicated OpenCode client resolves the upstream once per process, so a client started
//      before IPv6 became available keeps egressing over the refused path until it is restarted.
//
// Both are reported (never hidden) and the second is repaired automatically, because a network
// change must not need a human to think of restarting a background service.
import os from 'node:os';

// Link-local (fe80::/10) and unique-local (fc00::/7, which includes Tailscale's fd7a::/48) do not
// route to the internet, so they must not count as usable IPv6.
export function isGlobalIPv6(address) {
  const value = String(address ?? '').toLowerCase();
  if (!value.includes(':')) return false;
  if (/^fe[89ab]/.test(value)) return false;
  if (/^f[cd]/.test(value)) return false;
  if (/^::1$/.test(value) || /^::$/.test(value)) return false;
  return true;
}

export function globalIPv6(interfaces = os.networkInterfaces()) {
  for (const list of Object.values(interfaces ?? {})) {
    for (const entry of list ?? []) {
      if (!entry || entry.internal) continue;
      const family = typeof entry.family === 'string' ? entry.family : entry.family === 6 ? 'IPv6' : '';
      if (family !== 'IPv6') continue;
      if (isGlobalIPv6(entry.address)) return true;
    }
  }
  return false;
}

// Restart the client when the upstream refused traffic and the machine has since gained the IPv6
// path that the client, started earlier, cannot be using. Bounded by a cooldown so a refused
// network cannot turn into a restart loop.
export function shouldRecycle({ grew = 0, ipv6AtStart = false, ipv6Now = false,
  sinceLastRecycleMs = Number.POSITIVE_INFINITY, threshold = 2, cooldownMs = 300_000 } = {}) {
  if (!Number.isFinite(grew) || grew < threshold) return false;
  if (!ipv6Now || ipv6AtStart) return false;
  return sinceLastRecycleMs >= cooldownMs;
}
