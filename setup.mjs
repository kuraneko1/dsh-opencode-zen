#!/usr/bin/env node
// Setup CLI for dsh-opencode-zen. The plugin needs only DSH; dsh and rdsh are both supported launchers.
import { readFile, lstat, stat, writeFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { runtimeDirectory } from './runtime-path.mjs';
import { opencodeAuthFile, readFreeTierCredential } from './opencode-auth.mjs';

const REF = 'FREEMODELS_API_KEY';
const PACKAGE = 'dsh-opencode-zen';
const UNIT_NAME = 'dsh-opencode-zen.service';
const here = dirname(fileURLToPath(import.meta.url));
class SafeError extends Error {}
const fail = message => { throw new SafeError(message); };

function document(text, label) {
  let doc;
  try { doc = YAML.parseDocument(text, { uniqueKeys: true }); } catch { fail(`${label} is invalid YAML; nothing was changed.`); }
  if (doc.errors.length) fail(`${label} is invalid YAML; nothing was changed.`);
  return doc;
}

export function mergePatch(text, config, bundled = false) {
  const doc = document(text, 'Profile patch');
  if (!YAML.isSeq(doc.contents)) fail('Profile patch must be a YAML list.');
  const rows = [...doc.contents.items];
  for (const row of doc.contents.items) {
    if (YAML.isMap(row) && YAML.isSeq(row.get('insert', true))) rows.push(...row.get('insert', true).items);
  }
  // Remove only the route introduced by the previous all-provider prototype.
  for (const row of rows.filter(row => YAML.isMap(row) && row.get('id') === 'llm-pi-ai')) {
    const adapter = row.get('config', true);
    if (!adapter) continue;
    if (!YAML.isMap(adapter) || adapter.tag) fail('Cannot safely migrate an expression-based legacy adapter config.');
    const providers = adapter.get('providers', true);
    if (!providers) continue;
    if (!YAML.isMap(providers) || providers.tag) fail('Cannot safely migrate an expression-based legacy providers map.');
    providers.delete('freemodels');
  }
  const matches = rows.filter(row => YAML.isMap(row) && row.get('id') === 'opencode-zen');
  if (matches.length > 1) fail('Duplicate opencode-zen rows; reconcile them first.');
  if (matches[0]) {
    const row = matches[0];
    if (row.get('disabled') === true || (row.has('name') && row.get('name') !== PACKAGE)) fail('Existing opencode-zen row is disabled or names another module.');
    const previous = row.get('config', true);
    if (previous?.tag) fail('Cannot overwrite an expression-based plugin config.');
    if (!previous || JSON.stringify(previous.toJSON()) !== JSON.stringify(config)) row.set('config', doc.createNode(config));
  } else if (bundled) {
    doc.contents.add(doc.createNode({ id: 'opencode-zen', config }));
  } else {
    doc.contents.add(doc.createNode({ insert: [{ id: 'opencode-zen', name: PACKAGE, config }] }));
  }
  return JSON.stringify(doc.toJS()) === JSON.stringify(document(text, 'Profile patch').toJS()) ? text : doc.toString();
}

export function mergeCredentials(text, key) {
  const doc = document(text || 'version: 1\nrefs: {}\n', 'Credential store');
  if (!YAML.isMap(doc.contents) || doc.get('version') !== 1) fail('Expected a version: 1 credential store; migrate legacy stores with DSH first.');
  if (doc.contents.items.some(pair => !['version', 'refs', 'records'].includes(pair.key?.value))) fail('Unexpected credential store fields.');
  if (!doc.has('refs')) doc.set('refs', doc.createNode({}));
  const refs = doc.get('refs', true);
  if (!YAML.isMap(refs) || refs.tag) fail('Credential refs must be a mapping.');
  if (refs.get(REF) === key) return text;
  refs.set(REF, key);
  return doc.toString();
}

/** Deterministic unit text; only absolute, quote-safe paths are accepted. */
export function serviceUnit({ node, script, opencodeDir, opencodeBin, runtimeDir, opencodeAuthFile }) {
  for (const [label, value] of [['node', node], ['script', script], ['opencodeDir', opencodeDir], ['opencodeBin', opencodeBin],
    ['runtimeDir', runtimeDir], ['opencodeAuthFile', opencodeAuthFile]]) {
    if (typeof value !== 'string' || !value.startsWith('/') || /["\\\r\n%]/.test(value)) fail(`cannot generate a systemd unit from ${label}`);
  }
  const path = [...new Set([opencodeDir, dirname(node), '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
  return `[Unit]
Description=OpenCode Zen free-model relay for DSH
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Restart=on-failure
RestartSec=3
KillMode=control-group
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
Environment="PATH=${path}"
Environment="OPENCODE_BIN=${opencodeBin}"
Environment="FREEMODELS_RUNTIME_DIR=${runtimeDir}"
Environment="OPENCODE_AUTH_FILE=${opencodeAuthFile}"
WorkingDirectory=/tmp
ExecStart="${node}" "${script}" run
TimeoutStartSec=180
TimeoutStopSec=60

[Install]
WantedBy=default.target
`;
}

function runProcess(command, args, env) {
  return new Promise((ok, no) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', no);
    child.once('exit', code => ok({ code, output }));
  });
}

async function findExecutable(name) {
  for (const dir of String(process.env.PATH || '').split(':').filter(Boolean)) {
    const candidate = join(dir, name);
    // Follow symlinks: nvm and npm install commands that way, so lstat would miss them.
    try { const target = await stat(candidate); if (target.isFile() && (target.mode & 0o111)) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

async function waitForRelay(baseURL, timeoutMs = 180_000) {
  // /health lives at the origin root, not under the /v1 API prefix.
  const healthURL = `${new URL(baseURL).origin}/health`;
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthURL, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      if (!response.ok) last = `HTTP ${response.status}`;
      else {
        const health = await response.json();
        if (health?.upstreams?.opencode === true && health?.upstreams?.bridge === true) return;
        last = JSON.stringify(health?.upstreams ?? health).slice(0, 200);
      }
    } catch (error) { last = String(error.message || error); }
    await new Promise(ok => setTimeout(ok, 500));
  }
  fail(`relay did not become healthy within ${timeoutMs}ms (${last}); check: systemctl --user status ${UNIT_NAME}`);
}

// The upstream gate only accepts the real OpenCode client, so its binary is mandatory here.
// OPENCODE_BIN lets a caller name one that is not on PATH; the unit then carries its directory.
async function opencodeBinary(which) {
  const explicit = process.env.OPENCODE_BIN;
  if (explicit === undefined || explicit === '') return which('opencode');
  if (!explicit.startsWith('/')) fail('OPENCODE_BIN must be an absolute path');
  // Follow symlinks: nvm and npm install the command as one, and that is the normal shape.
  const target = await stat(explicit).catch(() => undefined);
  if (!target?.isFile() || (target.mode & 0o111) === 0) fail(`OPENCODE_BIN is not an executable file: ${explicit}`);
  return explicit;
}

async function startRelayService({ baseURL, profileDir, unitDir, run, which, authFile }) {
  if (process.platform !== 'linux') fail('--service installs a Linux systemd user unit; start the relay manually on other systems.');
  const opencode = await opencodeBinary(which);
  if (!opencode) fail('opencode was not found on PATH; install OpenCode or set OPENCODE_BIN to its binary.');
  if (!(await which('systemctl'))) fail('systemctl was not found on PATH; start the relay manually instead of --service.');
  const installed = join(profileDir, 'node_modules', PACKAGE, 'supervisor.mjs');
  const script = await lstat(installed).then(stat => stat.isFile() ? installed : join(here, 'supervisor.mjs')).catch(() => join(here, 'supervisor.mjs'));
  const content = serviceUnit({ node: process.execPath, script, opencodeDir: dirname(opencode), opencodeBin: opencode,
    runtimeDir: runtimeDirectory(), opencodeAuthFile: resolve(authFile) });
  const file = join(unitDir, UNIT_NAME);
  await mkdir(unitDir, { recursive: true, mode: 0o755 });
  const before = await readFile(file, 'utf8').catch(() => null);
  if (before !== content) {
    if (before !== null) await writeFile(`${file}.bak-opencode-zen-${randomUUID()}`, before, { mode: 0o644, flag: 'wx' });
    await writeFile(file, content, { mode: 0o644 });
  }
  // `enable --now` leaves an already-running unit alone, so an upgrade would keep serving the
  // previous version's code; enable and restart so the new code is the code that runs.
  for (const args of [['daemon-reload'], ['enable', UNIT_NAME], ['restart', UNIT_NAME]]) {
    const result = await run('systemctl', ['--user', ...args], process.env);
    if (result.code !== 0) fail(`systemctl --user ${args.join(' ')} failed: ${String(result.output).trim().slice(0, 300)}`);
  }
  await waitForRelay(baseURL);
  return file;
}

async function existingFile(file, secret = false) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('Refusing a non-regular configuration/key file.');
    if (secret && ((stat.mode & 0o077) || stat.uid !== process.getuid())) fail('Secret files must be owner-only (0600) and owned by this user.');
    return await readFile(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function save(file, before, after) {
  if (before === after) return false;
  if (before !== null) await writeFile(`${file}.bak-opencode-zen-${randomUUID()}`, before, { mode: 0o600, flag: 'wx' });
  await writeFileAtomic(file, after, { mode: 0o600 });
  return true;
}

export async function integrate({ install = false, service = false, dshHome = process.env.DSH_HOME || join(homedir(), '.dsh'),
  profile = 'web', baseURL = 'http://127.0.0.1:8099/v1', keyFile = join(runtimeDirectory(), 'proxy.key'),
  authFile = opencodeAuthFile(), fetchImpl = fetch, run = runProcess, which = findExecutable,
  unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user') } = {}) {
  if (service && !install) fail('--service requires --install; it writes a systemd user unit and starts the relay.');
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) fail('Invalid profile name.');
  let url;
  try { url = new URL(baseURL); } catch { fail('Invalid proxy URL.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/v1') fail('Proxy must be a numeric loopback HTTP /v1 endpoint.');
  baseURL = url.href.replace(/\/$/, '');
  const home = resolve(dshHome), patch = join(home, 'profiles', profile, 'cordis.patch.yml'), credentials = join(home, '.credentials.yaml');
  // Everything that can be checked without a running relay is checked before anything is started.
  if (install) await validateProfile();
  const unitFile = service ? await startRelayService({ baseURL, profileDir: join(home, 'profiles', profile), unitDir, run, which, authFile }) : null;
  const key = process.env[REF] ?? (await existingFile(resolve(keyFile), true))?.trim();
  if (typeof key !== 'string' || key.length < 32 || key.length > 4096 || /\s|[\x00-\x1f\x7f]/.test(key)) {
    fail('A private proxy key of at least 32 non-whitespace characters is required; start the relay (or pass --service) so it creates one.');
  }
  let response;
  try { response = await fetchImpl(`${baseURL}/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
  catch { fail('Could not fetch the authenticated proxy catalog; is the relay running? Redirects are refused.'); }
  if (!response.ok) fail(`Proxy catalog returned HTTP ${response.status}; no files changed.`);
  let catalog;
  try { catalog = await response.json(); } catch { fail('Proxy catalog is not JSON.'); }
  if (!Array.isArray(catalog.data) || catalog.data.length > 10000) fail('Invalid proxy catalog.');
  const models = catalog.data.filter(m => m?.route === 'zen' && typeof m.id === 'string' && /^zen\/[^\s?#]+$/.test(m.id) && m.chat === true && m.tools === true);
  if (!models.length) fail('No tool-capable OpenCode Zen Chat models are available.');
  const config = { proxyURL: baseURL, apiKeyEnv: REF };
  async function validateProfile() {
    const manifestText = await existingFile(join(home, 'profiles', profile, 'package.json'));
    if (manifestText === null) fail(`Initialize the profile and add ${PACKAGE} to it first (dsh plugin --profile ${profile} add <package>).`);
    let manifest;
    try { manifest = JSON.parse(manifestText); } catch { fail('Invalid profile manifest.'); }
    if (!manifest.dependencies?.[PACKAGE] && !manifest.devDependencies?.[PACKAGE]) fail(`Install ${PACKAGE} into this profile before applying setup.`);
    const homeText = await existingFile(join(home, 'cordis.patch.yml'));
    if (homeText !== null) {
      const doc = document(homeText, 'Home patch');
      if (!YAML.isSeq(doc.contents)) fail('Home patch must be a YAML list.');
      if (doc.contents.items.some(row => YAML.isMap(row) && row.get('id') === 'opencode-zen')) fail('A higher-priority home opencode-zen override exists; reconcile it first.');
    }
    if (await existingFile(patch) === null) fail('Initialize this profile first.');
    return manifest;
  }
  async function prepare() {
    const manifest = await validateProfile();
    const oldPatch = await existingFile(patch), oldCredentials = await existingFile(credentials, true);
    return { oldPatch, newPatch: mergePatch(oldPatch, config, manifest.dsh?.profile?.bundles?.includes(PACKAGE) === true),
      oldCredentials, newCredentials: mergeCredentials(oldCredentials, key) };
  }
  let patchChanged, credentialChanged;
  if (install) await withFileLock(patch, () => withFileLock(credentials, async () => {
    const plan = await prepare();
    credentialChanged = await save(credentials, plan.oldCredentials, plan.newCredentials);
    patchChanged = await save(patch, plan.oldPatch, plan.newPatch);
  }));
  else {
    const plan = await prepare();
    patchChanged = plan.oldPatch !== plan.newPatch; credentialChanged = plan.oldCredentials !== plan.newCredentials;
  }
  // Anonymous access works on some networks and not others, so this is reported, not required.
  const zenCredential = readFreeTierCredential(resolve(authFile)) !== null;
  return { mode: install ? 'installed' : 'dry-run', profile, provider: 'opencode-zen', models: models.length,
    excluded: catalog.data.length - models.length, patchChanged, credentialChanged, defaultModelChanged: false, zenCredential,
    relay: unitFile ? `systemd:${UNIT_NAME}` : 'external', ...(unitFile ? { unitFile } : {}) };
}

async function main() {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--install') options.install = true;
    else if (arg === '--service') options.service = true;
    else if (arg === '--dry-run') options.install = false;
    else if (arg === '--help') {
      console.log(`dsh-opencode-zen-setup [--install] [--service] [--profile web] [--dsh-home DIR] [--base-url http://127.0.0.1:8099/v1] [--key-file FILE]

Default: dry-run preview; nothing is written.
  --install   write the opencode-zen row and the local proxy key reference.
  --service   with --install, also install/start a systemd user unit for the relay.
Requires the package to be installed in the profile first, for example:
  dsh plugin --profile web add dsh-opencode-zen-0.2.0.tgz`);
      return;
    } else {
      const names = { '--profile': 'profile', '--dsh-home': 'dshHome', '--base-url': 'baseURL', '--key-file': 'keyFile' };
      if (!names[arg] || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) fail('Unknown or incomplete option; use --help.');
      options[names[arg]] = process.argv[++i];
    }
  }
  const result = await integrate(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.zenCredential) {
    console.log("");
    console.log("note: no stored OpenCode credential was found. That is fine where the provider accepts anonymous");
    console.log("      requests; if calls fail with 403 FreeTierError, run 'opencode auth login --provider opencode'");
    console.log("      once (it stores a credential for the 'opencode' provider only) and restart the relay.");
    console.log("      The gate also depends on the network: run 'node zen-doctor.mjs' to see which side you are on.");
  }
}
// npm/pnpm bin shims are symlinks, so compare real paths: a plain resolve() would make this a silent no-op.
function isEntryPoint() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isEntryPoint()) main().catch(error => {
  console.error(error instanceof SafeError ? error.message : 'Setup failed; files may have partially committed. Check private backups. No credential values were logged.');
  process.exitCode = 1;
});
