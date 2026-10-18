#!/usr/bin/env node
// One foreground owner; never trust an old child PID file to stop a process.
import fs from 'node:fs';
import path from 'node:path';
import { globalIPv6, shouldRecycle } from './egress-path.mjs';
import { runtimeDirectory, stateToken } from './runtime-path.mjs';
import { opencodeAuthFile, readFreeTierCredential } from './opencode-auth.mjs';
import { opencodeModelOverrides } from './zen-limits.mjs';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const script = fileURLToPath(import.meta.url);
const here = path.dirname(script);
const runtime = runtimeDirectory();
const stateFile = path.join(runtime, 'stack.json');
const mode = process.argv[2] || 'run';

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error('runtime directory must not be a symlink');
  fs.chmodSync(dir, 0o700);
}
function privateFile(file, content, flags = 'w') {
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error('refusing non-regular runtime file');
  const fd = fs.openSync(file, (flags === 'wx' ? fs.constants.O_EXCL : fs.constants.O_TRUNC) | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, content); } finally { fs.closeSync(fd); }
}
function secret(name) {
  return stateToken(runtime, name);
}
// The child's environment is the object we passed, unless something on PATH is a wrapper script:
// a shell launcher adds its own variables (PWD/SHLVL and whatever else it exports) before exec.
// Print the names only, never values, so an unexpected host variable is visible instead of silent.
const SHELL_INJECTED = new Set(['PWD', 'SHLVL', 'OLDPWD', '_']);
function reportInheritedEnvironment(pid, expected) {
  if (!pid) return;
  let extras;
  try {
    extras = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
      .map(entry => entry.slice(0, entry.indexOf('=')))
      .filter(name => name.length > 0 && !expected.has(name) && !SHELL_INJECTED.has(name));
  } catch {
    return; // No /proc (non-Linux) or the child already exited: nothing to report.
  }
  if (extras.length > 0) console.warn(`warning: the OpenCode launcher added environment variable(s) ${[...new Set(extras)].sort().join(', ')}; check for a wrapper script on PATH (values are not shown)`);
}
function removeExact(file) {
  // Only these owned files can ever be removed; no recursive credential deletion.
  const allowed = [stateFile, path.join(runtime, 'oc-data/opencode/auth.json')];
  if (!allowed.includes(path.resolve(file))) throw new Error('refusing unexpected cleanup path');
  if (fs.existsSync(file)) {
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('refusing non-regular cleanup target');
    fs.unlinkSync(file);
  }
}
/** 2.x hands back config documents with normalized key order; compare them structurally. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortDeep(value[key])]));
}
function ticks(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
}
function owned(state) {
  if (!Number.isSafeInteger(state?.pid) || state.pid <= 1 || state.script !== script || typeof state.start !== 'string') return false;
  try {
    const args = fs.readFileSync(`/proc/${state.pid}/cmdline`, 'utf8').split('\0');
    return ticks(state.pid) === state.start && args[1] === script && (args[2] === 'run' || !args[2]);
  } catch { return false; }
}
function readState() {
  if (!fs.existsSync(stateFile)) return null;
  if (!fs.lstatSync(stateFile).isFile() || fs.lstatSync(stateFile).isSymbolicLink()) throw new Error('unsafe state file');
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}
function port(value, fallback) {
  const n = Number(value || fallback);
  if (!Number.isSafeInteger(n) || n < 1024 || n > 65535) throw new Error('ports must be integers in 1024..65535');
  return n;
}
// Which client API the installed OpenCode speaks. The version string is the only thing available
// before the client starts, and the config key names differ between the two: 1.x takes `plugin`
// (a module URL) and `provider`, 2.x takes `plugins` (directories) and `providers`.
function clientGeneration(command) {
  let output = '';
  try { output = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return 'v1'; }
  const match = /(\d+)\.\d+\.\d+/.exec(output);
  return match !== null && Number(match[1]) >= 2 ? 'v2' : 'v1';
}

async function freePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

async function run() {
  privateDir(runtime);
  const previous = readState();
  if (previous && owned(previous)) throw new Error('proxy supervisor is already running');
  if (previous) removeExact(stateFile);
  const ocPort = port(process.env.OC_PORT, 4096), proxyPort = port(process.env.PROXY_PORT, 8099);
  if (ocPort === proxyPort) throw new Error('OpenCode and proxy ports must differ');
  await freePort(ocPort); await freePort(proxyPort);
  const apiKey = process.env.FREEMODELS_API_KEY || secret('proxy.key');
  const password = secret('opencode.key');
  if (apiKey.length < 32 || apiKey.length > 4096 || /\s|[\x00-\x1f\x7f]/.test(apiKey)) throw new Error('FREEMODELS_API_KEY must contain 32..4096 non-whitespace characters');
  privateFile(stateFile, JSON.stringify({ pid: process.pid, start: ticks(process.pid), script, ocPort, proxyPort }) + '\n', 'wx');
  const children = [];
  let stopping = false;
  let recycling = false;
  // Recorded before the client starts: a client that began on a refused path keeps using it until
  // it is restarted, which is exactly what happened when this host gained IPv6 at 18:40 today.
  const ipv6AtStart = globalIPv6();
  const cleanup = () => { removeExact(path.join(runtime, 'oc-data/opencode/auth.json')); removeExact(stateFile); };
  async function shutdown(code) {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? null : new Promise(resolve => child.once('exit', resolve)))), delay(5000)]);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    cleanup();
    process.exit(code);
  }
  process.once('SIGTERM', () => shutdown(0));
  process.once('SIGINT', () => shutdown(0));
  const start = (command, args, env, cwd = runtime) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    children.push(child);
    child.once('error', err => { console.error(`startup failed: ${err.message}`); shutdown(1); });
    child.once('exit', () => { if (!stopping && !recycling) shutdown(1); });
    return child;
  };
  try {
    for (const dir of ['oc-home', 'oc-config', 'oc-config/opencode', 'oc-data', 'oc-data/opencode', 'oc-cache', 'oc-state', 'oc-workdir']) privateDir(path.join(runtime, dir));
    // Zen free access needs no provider key; never read or copy the user's credentials.
    // Adopt only the operator's own free-tier provider entry, never their other credentials.
    const adopted = readFreeTierCredential(opencodeAuthFile());
    privateFile(path.join(runtime, 'oc-data/opencode/auth.json'), JSON.stringify(adopted ?? {}));
    console.error(adopted === null
      ? "warning: no stored OpenCode credential; if the provider answers 403 FreeTierError, run 'opencode auth login --provider opencode' once and restart"
      : 'supervised: adopted the stored OpenCode credential for the free tier');
    const requested = process.env.OPENCODE_BIN;
    if (requested !== undefined && requested !== '') {
      // Same rule as setup: an explicit binary must be an absolute, executable file.
      if (!path.isAbsolute(requested)) throw new Error('OPENCODE_BIN must be an absolute path');
      const target = fs.statSync(requested, { throwIfNoEntry: false });
      if (!target?.isFile() || (target.mode & 0o111) === 0) throw new Error(`OPENCODE_BIN is not an executable file: ${requested}`);
    }
    const generation = clientGeneration(requested || 'opencode');
    console.error(`supervised: the installed OpenCode speaks the ${generation === 'v2' ? '2.x' : '1.x'} API`);
    const picked = names => Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
    const common = picked(['PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUEST_TIMEOUT_MS', 'STALL_TIMEOUT_MS', 'FREEMODELS_BRIDGE_DEBUG']);
    const baseEnv = { ...common, HOME: path.join(runtime, 'oc-home'), FREEMODELS_RUNTIME_DIR: runtime,
      FREEMODELS_API_KEY: apiKey, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_GENERATION: generation };
    const config = generation === 'v2' ? {
      // 2.x loads local plugins from a directory and names model limits under `providers`.
      $schema: 'https://opencode.ai/config.json',
      plugins: [path.join(here, 'client-v2')],
      update: 'disable', share: 'disabled', compaction: { auto: false },
      providers: { opencode: { models: opencodeModelOverrides() } },
    } : { plugin: [pathToFileURL(path.join(here, 'opencode-plugin.mjs')).href],
      // No permission deny anywhere: measured 2026-10-17, denying shell/read makes the upstream
      // free-tier gate answer 403 for every request. Nothing can execute anyway, because the relay
      // sends `tools: {}`; the caller's tools are re-attached only to the upstream request body.
      default_agent: 'dsh-bridge', autoupdate: false,
      share: 'disabled', enabled_providers: ['opencode'], compaction: { auto: false, prune: false },
      // Without this, OpenCode truncates long input at the published 200k client limit.
      provider: { opencode: { models: opencodeModelOverrides() } } };
    const opencodeEnv = { ...common, HOME: path.join(runtime, 'oc-home'),
      OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode',
      XDG_DATA_HOME: path.join(runtime, 'oc-data'), XDG_CONFIG_HOME: path.join(runtime, 'oc-config'),
      XDG_CACHE_HOME: path.join(runtime, 'oc-cache'), XDG_STATE_HOME: path.join(runtime, 'oc-state'),
      OPENCODE_CONFIG_DIR: path.join(runtime, 'oc-config/opencode'), OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_EXPERIMENTAL_NATIVE_LLM: 'false',
      FREEMODELS_BRIDGE_URL: `http://127.0.0.1:${proxyPort}`,
    };
    let opencode;
    const spawnOpencode = () => {
      opencode = start(requested || 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(ocPort)], opencodeEnv, path.join(runtime, 'oc-workdir'));
      return opencode;
    };
    opencode = spawnOpencode();
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    // Bound by wall-clock, not by a fixed number of attempts: on a cold cache the client fetches
    // its model metadata first and can ignore a short probe for a minute or more (measured in a
    // fresh container, where the old 120-attempt loop gave up while the server was still working).
    const healthPath = generation === 'v2' ? '/api/info' : '/global/health';
    const clientReady = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${ocPort}${healthPath}`, { headers: { authorization }, signal: AbortSignal.timeout(3000), redirect: 'error' });
        if (!response.ok) return false;
        const body = await response.json().catch(() => null);
        // A socket that answers is not ready: 2.x serves its SPA for unknown paths, so the body decides.
        return generation === 'v2' ? typeof body?.version === 'string' : body?.healthy === true;
      } catch { return false; }
    };
    let ready = false;
    const deadline = Date.now() + 150_000;
    while (!stopping && Date.now() < deadline) {
      ready = await clientReady();
      if (ready) break;
      await delay(500);
    }
    if (!ready) throw new Error('dedicated OpenCode did not become ready within 150s');
    // Read this only once the client is up: a shell wrapper is still running when spawn returns.
    reportInheritedEnvironment(opencode.pid, new Set(Object.keys(opencodeEnv)));
    // Readiness only means the socket answers; a cold client can still be busy loading its
    // metadata, so give this one a short retry window instead of a single 5s attempt.
    const readResolved = async () => {
      const until = Date.now() + 60_000;
      let last;
      const path = generation === 'v2' ? '/api/config' : '/config';
      while (Date.now() < until) {
        try { return await fetch(`http://127.0.0.1:${ocPort}${path}`, { headers: { authorization }, signal: AbortSignal.timeout(5000), redirect: 'error' }).then(r => r.json()); }
        catch (error) { last = error; await delay(1000); }
      }
      throw last ?? new Error('dedicated OpenCode did not answer its config endpoint');
    };
    const resolved = await readResolved();
    if (generation === 'v2') {
      // 2.x reports every configuration source instead of the merged document: the inline document
      // has to be ours, and no directory source may smuggle in another document or plugin.
      const same = (a, b) => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
      const documents = resolved.filter(source => source?.info !== undefined);
      const matches = documents.length === 1 && same(documents[0].info, config);
      const foreign = [];
      for (const source of resolved) {
        if (typeof source?.path !== 'string') continue;
        for (const name of ['opencode.json', 'opencode.jsonc', 'config.json']) {
          const file = path.join(source.path, name);
          if (fs.existsSync(file)) foreign.push(file);
        }
        for (const name of ['plugin', 'plugins']) {
          const dir = path.join(source.path, name);
          if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) foreign.push(dir);
        }
      }
      if (!matches || foreign.length > 0) throw new Error(`dedicated OpenCode isolation verification failed: ${JSON.stringify({ documentMatches: matches, documents: documents.length, foreign })}`);
    } else {
      if (resolved.plugin?.length !== 1 || resolved.plugin[0] !== config.plugin[0]) {
        throw new Error(`dedicated OpenCode isolation verification failed: ${JSON.stringify({ pluginCount: resolved.plugin?.length,
          pluginMatches: resolved.plugin?.[0] === config.plugin[0] })}`);
      }
      // Pin everything a launcher or a planted runtime file could have added: an extra enabled
      // provider, MCP server, agent, endpoint override or share setting would move traffic elsewhere.
      const pinned = {
        onlyZenProvider: Array.isArray(resolved.enabled_providers) && resolved.enabled_providers.length === 1 && resolved.enabled_providers[0] === 'opencode',
        noExtraProviders: Object.keys(resolved.provider ?? {}).join() === 'opencode',
        noEndpointOverride: Object.keys(resolved.provider?.opencode?.options ?? {}).length === 0,
        noMcpServers: Object.keys(resolved.mcp ?? {}).length === 0,
        onlyBridgeAgent: Object.keys(resolved.agent ?? {}).join() === 'dsh-bridge',
        shareDisabled: resolved.share === 'disabled',
        autoupdateOff: resolved.autoupdate === false,
      };
      const unpinned = Object.entries(pinned).filter(([, ok]) => ok !== true);
      if (unpinned.length > 0) throw new Error(`dedicated OpenCode isolation verification failed: ${JSON.stringify(Object.fromEntries(unpinned))}`);
    }
    start(process.execPath, [path.join(here, 'server.mjs')], { ...baseEnv, PORT: String(proxyPort), OPENCODE_URL: `http://127.0.0.1:${ocPort}` });
    ready = false;
    for (let i = 0; i < 240 && !stopping; i++) {
      try {
        const health = await fetch(`http://127.0.0.1:${proxyPort}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' }).then(r => r.json());
        ready = health.upstreams?.opencode === true && health.upstreams?.bridge === true;
      } catch { /* Proxy is still starting. */ }
      if (ready) break;
      await delay(250);
    }
    if (!ready) throw new Error('proxy did not become ready');
    console.error(`supervised proxy: http://127.0.0.1:${proxyPort}/v1 (private credentials; Ctrl-C to stop)`);
    if (!ipv6AtStart) console.error('supervised: this machine has no global IPv6 address; if the provider refuses the free tier (403 FreeTierError), the network path is the cause');
    let refusalsSeen = 0, lastRecycleAt = 0, lastHintAt = 0;
    const watch = setInterval(async () => {
      if (stopping || recycling) return;
      let snapshot;
      try {
        snapshot = await fetch(`http://127.0.0.1:${proxyPort}/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' }).then(r => r.json());
      } catch { return; }
      const refusals = Number(snapshot?.refusals?.count ?? 0);
      if (!Number.isFinite(refusals) || refusals <= refusalsSeen) return;
      const grew = refusals - refusalsSeen;
      refusalsSeen = refusals;
      const now = Date.now();
      if (shouldRecycle({ grew, ipv6AtStart, ipv6Now: globalIPv6(), sinceLastRecycleMs: now - lastRecycleAt })) {
        lastRecycleAt = now;
        console.error('supervised: recycling the dedicated OpenCode - this machine gained a global IPv6 address after it started, and the upstream refused the free tier');
        recycling = true;
        try {
          opencode.kill('SIGTERM');
          await Promise.race([new Promise(resolve => opencode.once('exit', resolve)), delay(5000)]);
          if (opencode.exitCode === null && opencode.signalCode === null) opencode.kill('SIGKILL');
          const index = children.indexOf(opencode);
          if (index >= 0) children.splice(index, 1);
          await delay(500);
          spawnOpencode();
          const deadline = Date.now() + 150_000;
          let up = false;
          while (!stopping && Date.now() < deadline) {
            up = await clientReady();
            if (up) break;
            await delay(500);
          }
          console.error(up ? 'supervised: dedicated OpenCode restarted; it now resolves the upstream over the new network path'
            : 'supervised: dedicated OpenCode did not come back after recycling');
        } catch (error) {
          console.error(`supervised: recycling the dedicated OpenCode failed: ${error.message}`);
        } finally { recycling = false; }
        return;
      }
      if (now - lastHintAt >= 300_000) {
        lastHintAt = now;
        console.error(`supervised: the upstream refused the free tier ${grew} more time(s) (403 FreeTierError); globalIPv6=${globalIPv6()} - run the bundled doctor if this keeps happening`);
      }
    }, 10_000);
    watch.unref?.();
  } catch (err) { console.error(err.message); await shutdown(1); }
}

async function main() {
  if (mode === '--help' || mode === '-h') return console.log('dsh-opencode-zen-proxy [run|stop|status]\nRequires Node 22+ and opencode on PATH. State: $FREEMODELS_RUNTIME_DIR or $XDG_STATE_HOME/dsh-opencode-zen.');
  if (mode === 'run') return run();
  if (!['stop', 'status'].includes(mode)) throw new Error('usage: node supervisor.mjs [run|stop|status]');
  const state = readState();
  if (mode === 'stop') {
    if (!state) return console.log('no managed supervisor');
    if (!owned(state)) throw new Error('stale or foreign PID record; refusing to signal any process');
    process.kill(state.pid, 'SIGTERM');
    return console.log('stop requested for verified supervisor');
  }
  console.log(`supervisor: ${owned(state) ? 'running (verified)' : 'not running in this PID namespace'}`);
  const p = port(process.env.PROXY_PORT || state?.proxyPort, 8099);
  const response = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  console.log(JSON.stringify(await response.json(), null, 2));
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
