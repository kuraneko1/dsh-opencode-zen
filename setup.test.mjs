import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, symlink as symlinkFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import YAML from 'yaml';
import { integrate, mergePatch, mergeCredentials, serviceUnit } from './setup.mjs';
import { runtimeDirectory } from './runtime-path.mjs';

const inheritedKey = process.env.FREEMODELS_API_KEY;
delete process.env.FREEMODELS_API_KEY;
after(() => { if (inheritedKey === undefined) delete process.env.FREEMODELS_API_KEY; else process.env.FREEMODELS_API_KEY = inheritedKey; });
const key = 'synthetic-test-proxy-key-'.repeat(3);
const config = { proxyURL: 'http://127.0.0.1:8099/v1', apiKeyEnv: 'FREEMODELS_API_KEY' };
const model = { id: 'zen/test', route: 'zen', chat: true, tools: true };
const patch = `# Keep all unrelated providers and defaults.\n- id: llm-pi-ai\n  config:\n    providers:\n      existing: { models: [{id: keep}] }\n      freemodels:\n        models: [{id: 'or/unwanted:free'}, {id: 'nv/unwanted'}, {id: 'zen/test'}]\n- id: agent-default-model\n  config: { provider: existing, model: keep }\n- id: expression\n  config: { value: !!js process.env.UNEVALUATED }\n`;
function rows(text) { return YAML.parseDocument(text).toJS(); }
async function fixture(t, bundled = false) {
  const base = dirname(fileURLToPath(import.meta.url));
  const home = await mkdtemp(join(base, '.zen-setup-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(home)), base);
    assert.ok(home.startsWith(join(base, '.zen-setup-test-')));
    await rm(home, { recursive: true, force: true });
  });
  const profile = join(home, 'profiles/web');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { 'dsh-opencode-zen': 'file:fixture' },
    dsh: { profile: { bundles: bundled ? ['dsh-opencode-zen'] : [] } } }));
  await writeFile(join(profile, 'cordis.patch.yml'), patch);
  const keyFile = join(home, 'proxy.key'); await writeFile(keyFile, key, { mode: 0o600 });
  return { home, profile, options: { dshHome: home, keyFile, fetchImpl: async (_url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${key}`); assert.equal(init.redirect, 'error');
    return { ok: true, json: async () => ({ data: [model, { ...model, id: 'or/excluded:free', route: 'or' }] }) };
  } } };
}

test('native plugin setup removes only its legacy mixed route and preserves defaults, comments and !!js', () => {
  const output = mergePatch(patch, config);
  const result = rows(output);
  assert.deepEqual(result[0].config.providers, { existing: { models: [{ id: 'keep' }] } });
  assert.deepEqual(result[1], rows(patch)[1]);
  assert.match(output, /# Keep/); assert.match(output, /!!js process.env.UNEVALUATED/);
  assert.deepEqual(result.at(-1), { insert: [{ id: 'opencode-zen', name: 'dsh-opencode-zen', config }] });
  assert.equal(mergePatch(output, config), output);
});
test('bundle-backed setup overrides the existing row rather than inserting a duplicate plugin', () => {
  const output = mergePatch('[]\n', config, true);
  assert.deepEqual(rows(output), [{ id: 'opencode-zen', config }]);
  assert.equal(mergePatch(output, config, true), output);
});
test('duplicate, disabled, expression-based or wrong-module rows fail closed', () => {
  for (const text of ['- id: opencode-zen\n- id: opencode-zen\n', '- id: opencode-zen\n  disabled: true\n',
    '- id: opencode-zen\n  name: unexpected\n', '- id: llm-pi-ai\n  config: !!js unsafe()\n',
    '- id: llm-pi-ai\n  config:\n    providers: !!js unsafe()\n', '- id: opencode-zen\n  config: !!js unsafe()\n', '{}\n']) assert.throws(() => mergePatch(text, config));
});
test('credential merge preserves unrelated values and diagnostics never echo secrets', () => {
  const original = 'version: 1\nrefs: {OTHER: keep}\nrecords: {other: {kind: api-key, key: keep}}\n';
  const changed = mergeCredentials(original, key);
  assert.equal(rows(changed).refs.OTHER, 'keep'); assert.deepEqual(rows(changed).records, rows(original).records);
  assert.equal(rows(changed).refs.FREEMODELS_API_KEY, key); assert.equal(mergeCredentials(changed, key), changed);
  assert.throws(() => mergeCredentials(`version: 1\nrefs: [${key}\n`, key), e => !e.message.includes(key));
  assert.throws(() => mergeCredentials('OLD: value\n', key), /version: 1/);
});
test('runtime state lives outside the npm package and rejects relative overrides', () => {
  assert.equal(runtimeDirectory({ XDG_STATE_HOME: '/tmp/zen-state' }), '/tmp/zen-state/dsh-opencode-zen');
  assert.equal(runtimeDirectory({ FREEMODELS_RUNTIME_DIR: '/tmp/custom-zen' }), '/tmp/custom-zen');
  assert.throws(() => runtimeDirectory({ FREEMODELS_RUNTIME_DIR: 'relative' }), /absolute/);
  assert.throws(() => runtimeDirectory({ XDG_STATE_HOME: 'relative' }), /absolute/);
});
test('dry-run does not change files and reports only Zen model count', async t => {
  const f = await fixture(t); const result = await integrate(f.options);
  assert.equal(result.mode, 'dry-run'); assert.equal(result.provider, 'opencode-zen'); assert.equal(result.models, 1);
  assert.equal(result.excluded, 1); assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch);
  assert.ok(!(await readdir(f.home)).includes('.credentials.yaml')); assert.ok(!JSON.stringify(result).includes(key));
});
test('install is private, backed up, preserves the default and is idempotent', async t => {
  const f = await fixture(t, true);
  const first = await integrate({ ...f.options, install: true }); assert.equal(first.defaultModelChanged, false);
  const output = await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8');
  assert.deepEqual(rows(output)[1], rows(patch)[1]); assert.equal(rows(output).at(-1).id, 'opencode-zen');
  const files = await readdir(f.profile); assert.equal(files.filter(x => x.includes('.bak-opencode-zen-')).length, 1);
  for (const file of ['cordis.patch.yml', ...files.filter(x => x.includes('.bak-opencode-zen-'))]) assert.equal((await stat(join(f.profile, file))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.home, '.credentials.yaml'))).mode & 0o777, 0o600);
  const second = await integrate({ ...f.options, install: true }); assert.equal(second.patchChanged, false); assert.equal(second.credentialChanged, false);
});
test('unsafe URL, bad key, absent package, host overrides and empty Zen catalog do not write', async t => {
  const f = await fixture(t);
  for (const baseURL of ['https://external.example/v1', 'http://localhost/v1', 'http://user@127.0.0.1/v1']) await assert.rejects(integrate({ ...f.options, baseURL }), /loopback/);
  await assert.rejects(integrate({ ...f.options, fetchImpl: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
  await assert.rejects(integrate({ ...f.options, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ ...model, id: 'or/nope', route: 'or' }] }) }) }), /No tool-capable/);
  await writeFile(join(f.home, 'cordis.patch.yml'), '- id: opencode-zen\n  config: {}\n');
  await assert.rejects(integrate({ ...f.options, install: true }), /higher-priority/);
  assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch);
});
test('setup uses a real authenticated HTTP request without DSH runtime path assumptions', async t => {
  const f = await fixture(t);
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${key}`); assert.equal(req.url, '/v1/models');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [model] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const result = await integrate({ ...f.options, fetchImpl: fetch, baseURL: `http://127.0.0.1:${server.address().port}/v1` });
  assert.equal(result.models, 1);
});
test('generated systemd unit is absolute, portable and hardened', () => {
  const unit = serviceUnit({ node: '/usr/bin/node', script: '/opt/dsh zen/supervisor.mjs', opencodeDir: '/opt/bin',
    opencodeBin: '/opt/bin/opencode', runtimeDir: '/home/operator/.local/state/dsh-opencode-zen',
    opencodeAuthFile: '/home/operator/.local/share/opencode/auth.json' });
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/opt\/dsh zen\/supervisor\.mjs" run$/m);
  assert.match(unit, /^Environment="PATH=\/opt\/bin:\/usr\/bin:/m);
  // The supervisor spawns by name, so the unit must name the binary it verified.
  assert.match(unit, /^Environment="OPENCODE_BIN=\/opt\/bin\/opencode"$/m);
  // The service must use the same state directory that setup reads proxy.key from.
  assert.match(unit, /^Environment="FREEMODELS_RUNTIME_DIR=\/home\/operator\/\.local\/state\/dsh-opencode-zen"$/m);
  assert.match(unit, /^Environment="OPENCODE_AUTH_FILE=\/home\/operator\/\.local\/share\/opencode\/auth\.json"$/m);
  for (const line of ['Type=simple', 'Restart=on-failure', 'UMask=0077', 'NoNewPrivileges=yes', 'PrivateTmp=yes', 'WorkingDirectory=/tmp', 'WantedBy=default.target']) {
    assert.ok(unit.includes(line), line);
  }
  assert.doesNotMatch(unit, /\/home\/ryu/);
  for (const bad of [{ node: 'node', script: '/s', opencodeDir: '/b', opencodeBin: '/b/opencode' },
    { node: '/n', script: 'relative', opencodeDir: '/b', opencodeBin: '/b/opencode' },
    { node: '/n', script: '/s', opencodeDir: '/b', opencodeBin: '/b/opencode' + '"\nExecStart=/bin/sh' },
    // % introduces systemd specifiers, so a path containing one is refused too.
    { node: '/n', script: '/s', opencodeDir: '/b', opencodeBin: '/b/%i' },
    { node: '/n', script: '/s', opencodeDir: '/b', opencodeBin: '/b/opencode', runtimeDir: 'relative', opencodeAuthFile: '/a' },
    { node: '/n', script: '/s', opencodeDir: '/b', opencodeBin: '/b/opencode', runtimeDir: '/r', opencodeAuthFile: 'relative' }])
    assert.throws(() => serviceUnit(bad), /cannot generate a systemd unit/);
});
test('--service without --install and missing opencode/systemctl fail before any write', async t => {
  const f = await fixture(t);
  await assert.rejects(integrate({ ...f.options, service: true }), /--service requires --install/);
  for (const missing of ['opencode', 'systemctl']) {
    await assert.rejects(integrate({ ...f.options, install: true, service: true, unitDir: join(f.home, 'systemd'),
      which: async name => (name === missing ? null : `/usr/bin/${name}`) }), new RegExp(`${missing} was not found`));
  }
  assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch);
  assert.deepEqual(await readdir(f.home), ['profiles', 'proxy.key']);
});
test('--service writes the unit, starts it through systemctl and then registers the provider', async t => {
  const f = await fixture(t);
  const calls = [];
  const server = createServer((req, res) => {
    if (req.url === '/health') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, upstreams: { opencode: true, bridge: true } }));
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [model] })); }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const unitDir = join(f.home, 'systemd');
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const result = await integrate({ ...f.options, install: true, service: true, unitDir, fetchImpl: fetch,
    baseURL, which: async name => `/usr/bin/${name}`,
    run: async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, output: '' }; } });
  assert.deepEqual(calls, ['systemctl --user daemon-reload', 'systemctl --user enable --now dsh-opencode-zen.service']);
  assert.equal(result.relay, 'systemd:dsh-opencode-zen.service');
  const unit = await readFile(join(unitDir, 'dsh-opencode-zen.service'), 'utf8');
  assert.ok(unit.includes(`"${process.execPath}"`));
  const registered = rows(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8')).flatMap(row => (row.insert ? row.insert : [row]));
  assert.equal(registered.at(-1).id, 'opencode-zen');
  assert.deepEqual(registered.at(-1).config, { proxyURL: baseURL, apiKeyEnv: 'FREEMODELS_API_KEY' });
  assert.equal(rows(await readFile(join(f.home, '.credentials.yaml'), 'utf8')).refs.FREEMODELS_API_KEY, key);
});

test('OPENCODE_BIN names a binary that is not on PATH, and the unit carries its directory', async t => {
  const f = await fixture(t);
  const previous = process.env.OPENCODE_BIN;
  const binDir = join(f.home, 'vendor');
  await mkdir(binDir, { recursive: true });
  const binary = join(binDir, 'opencode');
  // nvm and npm install the command as a symlink; that normal shape must be accepted.
  await writeFile(join(binDir, 'opencode-real'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await symlinkFile(join(binDir, 'opencode-real'), binary);
  const calls = [];
  const server = createServer((req, res) => {
    if (req.url === '/health') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ upstreams: { opencode: true, bridge: true } }));
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [model] })); }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const unitDir = join(f.home, 'systemd');
  try {
    process.env.OPENCODE_BIN = binary;
    // `which` deliberately finds no opencode, proving the explicit binary is what is used.
    const result = await integrate({ ...f.options, install: true, service: true, unitDir, fetchImpl: fetch,
      baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      which: async name => (name === 'opencode' ? null : `/usr/bin/${name}`),
      run: async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, output: '' }; } });
    assert.equal(result.relay, 'systemd:dsh-opencode-zen.service');
    const unit = await readFile(join(unitDir, 'dsh-opencode-zen.service'), 'utf8');
    assert.ok(unit.includes(`Environment="PATH=${binDir}:`), unit.slice(0, 400));
    assert.deepEqual(calls, ['systemctl --user daemon-reload', 'systemctl --user enable --now dsh-opencode-zen.service']);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BIN; else process.env.OPENCODE_BIN = previous;
  }
});

test('a relative or non-executable OPENCODE_BIN is refused', async t => {
  const f = await fixture(t);
  const previous = process.env.OPENCODE_BIN;
  const notExecutable = join(f.home, 'opencode');
  await writeFile(notExecutable, 'x', { mode: 0o644 });
  try {
    for (const value of ['opencode', notExecutable]) {
      process.env.OPENCODE_BIN = value;
      await assert.rejects(integrate({ ...f.options, install: true, service: true, unitDir: join(f.home, 'systemd'),
        which: async name => `/usr/bin/${name}` }), /OPENCODE_BIN/);
    }
    delete process.env.OPENCODE_BIN;
    await assert.rejects(integrate({ ...f.options, install: true, service: true, unitDir: join(f.home, 'systemd'),
      which: async name => (name === 'opencode' ? null : `/usr/bin/${name}`) }), /install OpenCode or set OPENCODE_BIN/);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BIN; else process.env.OPENCODE_BIN = previous;
  }
});

test('a symlinked opencode on PATH is found, as nvm and npm install it', async t => {
  const f = await fixture(t);
  const dir = join(f.home, 'only-bin');
  await mkdir(dir, { recursive: true });
  const real = join(f.home, 'opencode-real');
  await writeFile(real, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await symlinkFile(real, join(dir, 'opencode'));
  const previous = process.env.PATH;
  process.env.PATH = dir;
  try {
    // With only a symlinked opencode visible, the failure must be about systemctl, which proves
    // the symlink itself was accepted as the OpenCode binary.
    await assert.rejects(integrate({ ...f.options, install: true, service: true, unitDir: join(f.home, 'systemd') }),
      /systemctl was not found/);
  } finally {
    process.env.PATH = previous;
  }
});
