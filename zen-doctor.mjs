// Tells you whether this network can actually use the Zen free lane through the relay.
//
//   node zen-doctor.mjs
//
// Reads the relay URL and token like bench-context.mjs, sends one tiny request with a realistic
// tool, and reports the provider's verdict with the likely reason. It also asks
// api64.ipify.org which address family this machine egresses with, because the free-tier gate
// was measured to accept one family and refuse the other (see AUDIT.md).
import fs from 'node:fs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runtimeDirectory } from './runtime-path.mjs';

export function classify(status, body) {
  if (status === 200 && Array.isArray(body?.choices) && body.choices.length > 0) return 'ok';
  // Trust the explicit provider type over the status: the relay passes the upstream code through.
  const type = body?.error?.type ?? body?.type;
  if (type === 'FreeTierError') return 'free-tier';
  if (status === 401 || status === 403) return 'auth';
  return `http-${status}`;
}

export function diagnose(outcome, family) {
  if (outcome === 'ok') return 'the free lane accepts this network; nothing to fix';
  if (outcome === 'free-tier' && family === 'IPv4') {
    return 'the provider refuses this IPv4 egress. Measured on 2026-10-17: the same account and client '
      + 'succeeded over native IPv6 (2402:6b00:…) and failed over IPv4 (219.8.20.246). Enable IPv6 on this '
      + 'network, or use a relay on a host whose egress is accepted';
  }
  if (outcome === 'free-tier') {
    return 'the provider refuses the free tier for this network. Nothing on this side can change that '
      + '(this project does not impersonate the client)';
  }
  if (outcome === 'auth') return 'the relay rejected the local token; check FREEMODELS_API_KEY and the relay URL';
  return `unexpected result (${outcome}); see the relay log`;
}

async function main() {
  const base = process.env.PROXY_URL || 'http://127.0.0.1:8099';
  const model = process.argv[2] || 'zen/deepseek-v4.1-flash-free';
  const key = process.env.FREEMODELS_API_KEY || fs.readFileSync(path.join(runtimeDirectory(), 'proxy.key'), 'utf8').trim();

  const health = await fetch(`${base}/health`, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    .then(response => response.json()).catch(error => ({ error: error.message }));
  console.log(`relay: ${base}`);
  console.log(health.error ? `  health: unreachable (${health.error})` : `  health: ok, ${health.models} models`);

  let family = 'unknown';
  try {
    const ip = (await fetch('https://api64.ipify.org', { redirect: 'error', signal: AbortSignal.timeout(10_000) }).then(r => r.text())).trim();
    family = ip.includes(':') ? 'IPv6' : /^\d+\./.test(ip) ? 'IPv4' : 'unknown';
    console.log(`  this machine's egress family: ${family} (asked api64.ipify.org)`);
  } catch {
    console.log('  this machine\'s egress family: unknown (api64.ipify.org unreachable)');
  }
  console.log('  note: if the relay runs on another host, run this there for its egress family');

  const started = Date.now();
  let outcome;
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, max_tokens: 16, stream: false, tool_choice: 'auto',
        // The free-tier gate rejects a placeholder tool, so send a realistic one with a required field.
        tools: [{ type: 'function', function: {
          name: 'read', description: 'Read a UTF-8 text file and return line-numbered content.',
          parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false },
        } }],
        messages: [{ role: 'user', content: 'Reply with exactly: DOCTOR-OK' }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json().catch(() => ({}));
    outcome = classify(response.status, body);
    const detail = body?.error?.message ?? body?.choices?.[0]?.message?.content?.trim() ?? '';
    console.log(`  probe: ${response.status} ${outcome} in ${Date.now() - started}ms${detail ? ` — ${String(detail).slice(0, 120)}` : ''}`);
  } catch (error) {
    outcome = 'unreachable';
    console.log(`  probe: failed after ${Date.now() - started}ms — ${error.message}`);
  }
  console.log(`diagnosis: ${diagnose(outcome, family)}`);
  process.exit(outcome === 'ok' ? 0 : 1);
}

// npm/pnpm bin shims are symlinks, so compare real paths: a plain resolve() would make this a silent no-op.
function isEntryPoint() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isEntryPoint()) await main();
