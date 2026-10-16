#!/usr/bin/env node
// Optional setup/migration CLI. The provider itself is the native plugin in index.mjs.
import { readFile, lstat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { runtimeDirectory } from './runtime-path.mjs';

const REF = 'FREEMODELS_API_KEY';
const PACKAGE = 'dsh-opencode-zen';
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
  const output = doc.toString();
  // Preserve exact original bytes when this is already the intended configuration.
  return JSON.stringify(doc.toJS()) === JSON.stringify(document(text, 'Profile patch').toJS()) ? text : output;
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
export async function integrate({ install = false, dshHome = process.env.DSH_HOME || join(homedir(), '.dsh'),
  profile = 'web', baseURL = 'http://127.0.0.1:8099/v1', keyFile = join(runtimeDirectory(), 'proxy.key'), fetchImpl = fetch } = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) fail('Invalid profile name.');
  let url;
  try { url = new URL(baseURL); } catch { fail('Invalid proxy URL.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/v1') fail('Proxy must be a numeric loopback HTTP /v1 endpoint.');
  baseURL = url.href.replace(/\/$/, '');
  const key = process.env[REF] ?? (await existingFile(resolve(keyFile), true))?.trim();
  if (typeof key !== 'string' || key.length < 32 || key.length > 4096 || /\s|[\x00-\x1f\x7f]/.test(key)) fail('A private proxy key of at least 32 non-whitespace characters is required.');
  let response;
  try { response = await fetchImpl(`${baseURL}/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
  catch { fail('Could not fetch the authenticated proxy catalog; redirects are refused.'); }
  if (!response.ok) fail(`Proxy catalog returned HTTP ${response.status}; no files changed.`);
  let catalog;
  try { catalog = await response.json(); } catch { fail('Proxy catalog is not JSON.'); }
  if (!Array.isArray(catalog.data) || catalog.data.length > 10000) fail('Invalid proxy catalog.');
  const models = catalog.data.filter(m => m?.route === 'zen' && typeof m.id === 'string' && /^zen\/[^\s?#]+$/.test(m.id) && m.chat === true && m.tools === true);
  if (!models.length) fail('No tool-capable OpenCode Zen Chat models are available.');
  const home = resolve(dshHome), patch = join(home, 'profiles', profile, 'cordis.patch.yml'), credentials = join(home, '.credentials.yaml');
  const config = { proxyURL: baseURL, apiKeyEnv: REF };
  async function prepare() {
    const manifestText = await existingFile(join(home, 'profiles', profile, 'package.json'));
    if (manifestText === null) fail('Initialize and install the package in this profile first.');
    let manifest;
    try { manifest = JSON.parse(manifestText); } catch { fail('Invalid profile manifest.'); }
    if (!manifest.dependencies?.[PACKAGE] && !manifest.devDependencies?.[PACKAGE]) fail('Install dsh-opencode-zen into this profile before applying setup.');
    const homeText = await existingFile(join(home, 'cordis.patch.yml'));
    if (homeText !== null) {
      const doc = document(homeText, 'Home patch');
      if (!YAML.isSeq(doc.contents)) fail('Home patch must be a YAML list.');
      if (doc.contents.items.some(row => YAML.isMap(row) && row.get('id') === 'opencode-zen')) fail('A higher-priority home opencode-zen override exists; reconcile it first.');
    }
    const oldPatch = await existingFile(patch), oldCredentials = await existingFile(credentials, true);
    if (oldPatch === null) fail('Initialize this profile first.');
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
  return { mode: install ? 'installed' : 'dry-run', profile, provider: 'opencode-zen', models: models.length,
    excluded: catalog.data.length - models.length, patchChanged, credentialChanged, defaultModelChanged: false };
}
async function main() {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--install') options.install = true;
    else if (arg === '--dry-run') options.install = false;
    else if (arg === '--help') {
      console.log('dsh-opencode-zen-setup [--install] [--profile web] [--dsh-home DIR] [--base-url http://127.0.0.1:8099/v1] [--key-file FILE]\nDefault: dry-run. Install the native plugin package into the profile before applying setup.');
      return;
    } else {
      const names = { '--profile': 'profile', '--dsh-home': 'dshHome', '--base-url': 'baseURL', '--key-file': 'keyFile' };
      if (!names[arg] || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) fail('Unknown or incomplete option; use --help.');
      options[names[arg]] = process.argv[++i];
    }
  }
  console.log(JSON.stringify(await integrate(options), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error instanceof SafeError ? error.message : 'Setup failed; files may have partially committed. Check private backups. No credential values were logged.');
  process.exitCode = 1;
});
