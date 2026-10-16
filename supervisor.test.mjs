// Lifecycle regressions run copied scripts in verified disposable workspace fixtures.
// The executable OpenCode fixture serves metadata only. No real model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COPIED = ['supervisor.mjs', 'server.mjs', 'opencode-bridge.mjs', 'opencode-plugin.mjs', 'runtime-path.mjs'];
const FAKE_OC = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const plugin = (await import(config.plugin[0])).default;
await (await plugin()).config(config);
if (fs.existsSync(path.join(here, 'invalid-config'))) config.permission['*'] = 'allow';
const authFile = path.join(process.env.XDG_DATA_HOME, 'opencode/auth.json');
fs.writeFileSync(path.join(here, 'oc-observation.json'), JSON.stringify({ pid: process.pid, env: process.env,
  config, authKeys: Object.keys(JSON.parse(fs.readFileSync(authFile))), authMode: fs.statSync(authFile).mode & 0o777 }), { mode: 0o600 });
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const authorization = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const server = http.createServer((req, res) => {
  fs.appendFileSync(path.join(here, 'oc-requests.txt'), req.url + '\\n', { mode: 0o600 });
  if (req.headers.authorization !== authorization) return res.writeHead(401).end();
  let value;
  if (req.url === '/global/health') value = { healthy: true };
  else if (req.url === '/config') value = config;
  else if (req.url === '/config/providers') value = { providers: [{ id: 'opencode', models: {
    free: { api: { npm: '@ai-sdk/openai-compatible' }, cost: { input: 0, output: 0 }, capabilities: { toolcall: true } }
  } }] };
  else return res.writeHead(500).end('model/session endpoints forbidden in lifecycle fixture');
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
});
server.listen(port, '127.0.0.1');
process.once('SIGTERM', () => {
  fs.writeFileSync(path.join(here, 'oc-stopped'), 'SIGTERM', { mode: 0o600 });
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
`;

async function bounded(promise, label, timeout = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function child(command, args, options = {}) {
  const processChild = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let output = '';
  const listeners = new Set();
  for (const stream of [processChild.stdout, processChild.stderr]) stream.on('data', bytes => {
    output = (output + bytes.toString()).slice(-12000);
    for (const listener of listeners) listener();
  });
  const finished = new Promise(resolve => {
    processChild.once('exit', (code, signal) => resolve({ code, signal }));
    processChild.once('error', error => resolve({ error }));
  });
  return { process: processChild, finished, output: () => output, async waitFor(text) {
    if (output.includes(text)) return;
    let listener;
    try {
      await bounded(Promise.race([
        new Promise(resolve => { listener = () => { if (output.includes(text)) resolve(); }; listeners.add(listener); }),
        finished.then(() => { throw new Error(`process exited before ${text}: ${output}`); }),
      ]), `process output ${text}`);
    } finally { if (listener) listeners.delete(listener); }
  } };
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function close(server) { await new Promise(resolve => server.close(resolve)); }
async function ports() {
  const first = net.createServer(), second = net.createServer();
  try { return [await listen(first), await listen(second)]; }
  finally { await close(first); await close(second); }
}
function ticks(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(HERE, '.supervisor-test-'));
  const managed = [];
  const ownPids = new Set();
  t.after(async () => {
    for (const entry of managed) {
      if (entry.process.exitCode === null && entry.process.signalCode === null) entry.process.kill('SIGTERM');
      try { await bounded(entry.finished, 'fixture process cleanup', 7000); }
      catch { entry.process.kill('SIGKILL'); await bounded(entry.finished, 'forced fixture process cleanup', 2000); }
    }
    // Only kill verified fixture children; never use a test-controlled PID record.
    for (const pid of ownPids) {
      if (!alive(pid)) continue;
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (args.some(arg => arg === path.join(root, 'fake-opencode.mjs') || arg === path.join(root, 'server.mjs'))) process.kill(pid, 'SIGKILL');
    }
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), HERE, 'cleanup must stay inside source workspace');
    assert.ok(path.basename(resolved).startsWith('.supervisor-test-'));
    assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false);
    assert.equal(fs.realpathSync(resolved), resolved, 'cleanup target must be the created fixture');
    fs.rmSync(resolved, { recursive: true });
  });
  for (const name of COPIED) fs.copyFileSync(path.join(HERE, name), path.join(root, name));
  fs.writeFileSync(path.join(root, 'fake-opencode.mjs'), FAKE_OC, { mode: 0o700 });
  const home = path.join(root, 'source-home');
  const authDirectory = path.join(home, '.local/share/opencode');
  fs.mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
  const auth = {
    opencode: { type: 'api', key: 'synthetic-zen-key', unrelated: 'not-copied' },
    openrouter: { type: 'api', key: 'synthetic-router-key' },
    unrelated: { type: 'api', key: 'synthetic-unrelated-key' },
    otherOauth: { type: 'oauth', access: 'synthetic-oauth-token' },
  };
  fs.writeFileSync(path.join(authDirectory, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
  const [ocPort, proxyPort] = await ports();
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, LANG: 'C',
    OC_PORT: String(ocPort), PROXY_PORT: String(proxyPort), OPENCODE_BIN: path.join(root, 'fake-opencode.mjs'),
    FREEMODELS_RUNTIME_DIR: path.join(root, 'runtime'),
    OPENCODE_CONFIG: path.join(root, 'unrelated-config.json'), OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"allow"}}',
    AWS_SECRET_ACCESS_KEY: 'synthetic-unrelated-secret', GITHUB_TOKEN: 'synthetic-unrelated-token',
    NVIDIA_API_KEY: 'synthetic-nvidia-key', LOCAL_API_KEY: 'synthetic-local-key',
    OPENROUTER_API_KEY: 'synthetic-router-env', OPENCODE_API_KEY: 'synthetic-zen-env',
    REQUEST_TIMEOUT_MS: '1000', STALL_TIMEOUT_MS: '1000', ...overrides,
  };
  const start = (mode = 'run') => {
    const entry = child(process.execPath, [path.join(root, 'supervisor.mjs'), mode], { cwd: root, env });
    managed.push(entry); return entry;
  };
  const observeChildren = supervisor => {
    const file = `/proc/${supervisor.process.pid}/task/${supervisor.process.pid}/children`;
    const pids = fs.readFileSync(file, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
    for (const pid of pids) ownPids.add(pid);
    return pids;
  };
  return { root, home, env, auth, ocPort, proxyPort, start, managed, observeChildren,
    runtime: path.join(root, 'runtime'), supervisor: path.join(root, 'supervisor.mjs') };
}

test('supervisor isolates HOME/env/auth, becomes actually ready and SIGTERM cleans both children', { timeout: 20000 }, async t => {
  const f = await fixture(t); const owner = f.start();
  await owner.waitFor('supervised proxy:');
  const observed = JSON.parse(fs.readFileSync(path.join(f.root, 'oc-observation.json')));
  const childPids = f.observeChildren(owner);
  assert.equal(childPids.length, 2);
  assert.ok(childPids.includes(observed.pid));
  assert.equal(observed.env.HOME, path.join(f.runtime, 'oc-home'));
  assert.equal(observed.env.OPENCODE_CONFIG, undefined);
  for (const name of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'NVIDIA_API_KEY', 'LOCAL_API_KEY', 'FREEMODELS_API_KEY']) assert.equal(observed.env[name], undefined, name);
  assert.equal(observed.env.OPENROUTER_API_KEY, undefined);
  assert.equal(observed.env.OPENCODE_API_KEY, undefined);
  assert.equal(observed.env.OPENCODE_DISABLE_PROJECT_CONFIG, 'true');
  assert.equal(observed.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM, 'false');
  assert.equal(observed.config.permission['*'], 'deny');
  assert.equal(observed.config.agent['dsh-bridge'].permission['*'], 'deny');
  assert.deepEqual(observed.config.plugin, [new URL('./opencode-plugin.mjs', `file://${f.root}/`).href]);
  assert.deepEqual(observed.config.enabled_providers, ['opencode']);
  assert.deepEqual(observed.authKeys, []);
  assert.equal(observed.authMode, 0o600);
  const copiedAuth = path.join(f.runtime, 'oc-data/opencode/auth.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(copiedAuth)), {});
  for (const name of ['proxy.key', 'opencode.key', 'stack.json']) assert.equal(fs.statSync(path.join(f.runtime, name)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.runtime).mode & 0o777, 0o700);
  const key = fs.readFileSync(path.join(f.runtime, 'proxy.key'), 'utf8').trim();
  const base = `http://127.0.0.1:${f.proxyPort}`;
  const health = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) }).then(r => r.json());
  assert.equal(health.upstreams.opencode, true); assert.equal(health.upstreams.bridge, true);
  assert.equal((await fetch(base + '/v1/models', { signal: AbortSignal.timeout(2000) })).status, 401);
  const models = await fetch(base + '/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(2000) }).then(r => r.json());
  assert.ok(models.data.some(model => model.id === 'zen/free'), 'catalog must already exist when ready');
  owner.process.kill('SIGTERM');
  assert.deepEqual(await bounded(owner.finished, 'normal supervisor shutdown'), { code: 0, signal: null });
  assert.equal(fs.existsSync(copiedAuth), false); assert.equal(fs.existsSync(path.join(f.runtime, 'stack.json')), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'oc-stopped'), 'utf8'), 'SIGTERM');
  for (const pid of childPids) assert.equal(alive(pid), false, 'owned child must exit');
  for (const port of [f.ocPort, f.proxyPort]) await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, '.local/share/opencode/auth.json'))), f.auth, 'source credentials must remain unchanged');
  assert.doesNotMatch(fs.readFileSync(path.join(f.root, 'oc-requests.txt'), 'utf8'), /session|message|chat\/completions/);
});

test('verified stop command signals its owner rather than legacy child PID files', { timeout: 20000 }, async t => {
  const f = await fixture(t); const owner = f.start(); await owner.waitFor('supervised proxy:');
  const childPids = f.observeChildren(owner);
  fs.writeFileSync(path.join(f.runtime, 'opencode.pid'), '1');
  fs.writeFileSync(path.join(f.runtime, 'proxy.pid'), '1');
  const stop = f.start('stop');
  assert.equal((await bounded(stop.finished, 'verified stop')).code, 0);
  assert.match(stop.output(), /verified supervisor/);
  assert.equal((await bounded(owner.finished, 'owner stopped by command')).code, 0);
  for (const pid of childPids) assert.equal(alive(pid), false);
  assert.equal(fs.existsSync(path.join(f.runtime, 'stack.json')), false);
});

test('stale and foreign supervisor records refuse signals to a live unrelated process', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  fs.mkdirSync(f.runtime, { mode: 0o700 });
  const sentinel = child(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(77));setInterval(()=>{},1000)'], { env: { PATH: f.env.PATH } });
  f.managed.push(sentinel);
  for (const start of ['stale-start-time', ticks(sentinel.process.pid)]) {
    fs.writeFileSync(path.join(f.runtime, 'stack.json'), JSON.stringify({ pid: sentinel.process.pid, start, script: f.supervisor }), { mode: 0o600 });
    const stop = f.start('stop');
    assert.equal((await bounded(stop.finished, 'foreign record refusal')).code, 1);
    assert.match(stop.output(), /stale or foreign PID record/);
    assert.equal(sentinel.process.exitCode, null); assert.equal(alive(sentinel.process.pid), true);
  }
});

test('symlink runtime is rejected without touching its target', { timeout: 10000 }, async t => {
  const f = await fixture(t); const target = path.join(f.root, 'outside-runtime');
  fs.mkdirSync(target, { mode: 0o755 }); fs.writeFileSync(path.join(target, 'sentinel'), 'unchanged');
  fs.symlinkSync(target, f.runtime);
  const owner = f.start(); assert.equal((await bounded(owner.finished, 'symlink refusal')).code, 1);
  assert.match(owner.output(), /symlink/);
  assert.deepEqual(fs.readdirSync(target), ['sentinel']);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
});

test('occupied loopback port fails before creating auth, keys or a PID state', { timeout: 10000 }, async t => {
  const occupied = net.createServer(); const occupiedPort = await listen(occupied);
  t.after(() => close(occupied));
  const f = await fixture(t, { OC_PORT: String(occupiedPort) });
  const owner = f.start(); assert.equal((await bounded(owner.finished, 'occupied port refusal')).code, 1);
  assert.match(owner.output(), /EADDRINUSE|address already in use/i);
  assert.deepEqual(fs.readdirSync(f.runtime), []);
  assert.equal(occupied.listening, true, 'conflicting service must remain alive');
});

test('failed resolved-config isolation shuts down OpenCode and removes copied credentials/state', { timeout: 15000 }, async t => {
  const f = await fixture(t); fs.writeFileSync(path.join(f.root, 'invalid-config'), 'tamper fixture');
  const owner = f.start(); assert.equal((await bounded(owner.finished, 'isolation startup refusal')).code, 1);
  assert.match(owner.output(), /isolation verification failed/);
  const observed = JSON.parse(fs.readFileSync(path.join(f.root, 'oc-observation.json')));
  assert.equal(alive(observed.pid), false);
  assert.equal(fs.existsSync(path.join(f.runtime, 'oc-data/opencode/auth.json')), false);
  assert.equal(fs.existsSync(path.join(f.runtime, 'stack.json')), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'oc-stopped'), 'utf8'), 'SIGTERM');
  await assert.rejects(fetch(`http://127.0.0.1:${f.proxyPort}/health`, { signal: AbortSignal.timeout(1000) }));
});
