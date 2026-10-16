import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const metadata = JSON.parse(await fs.readFile(path.join(here, 'package.json'), 'utf8'));

test('package is a licensed native DSH bundle, not a private machine-specific setup script', async () => {
  assert.equal(metadata.name, 'dsh-opencode-zen'); assert.notEqual(metadata.private, true); assert.equal(metadata.license, 'MIT');
  assert.equal(metadata.exports['.'], './index.mjs');
  // OpenCode resolves the package's server entry even for an explicit file URL.
  assert.equal(metadata.exports['./server'], './opencode-plugin.mjs');
  assert.ok(metadata.peerDependencies['@deepseek-ai/dsh-llm-pi-ai']);
  const bundle = YAML.parse(await fs.readFile(path.join(here, metadata.dsh.bundle.patch), 'utf8'));
  assert.deepEqual(bundle[0].insert[0], { id: 'opencode-zen', name: 'dsh-opencode-zen',
    config: { proxyURL: 'http://127.0.0.1:8099/v1', apiKeyEnv: 'FREEMODELS_API_KEY' } });
  assert.match(await fs.readFile(path.join(here, 'LICENSE'), 'utf8'), /MIT License/);
});

test('npm payload contains the plugin, supervisor and tests but no state, credentials or historical routes', { timeout: 30000 }, () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: here, encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
  const files = JSON.parse(result.stdout)[0].files.map(file => file.path);
  for (const name of ['index.mjs', 'server.mjs', 'supervisor.mjs', 'setup.mjs', 'runtime-path.mjs', 'cordis.patch.yml', 'plugin.test.mjs', 'LICENSE']) assert.ok(files.includes(name), name);
  for (const name of files) {
    assert.ok(!/(^|\/)(runtime|node_modules|\.env|\.credentials\.yaml)(\/|$)/.test(name), name);
    assert.ok(!/\.key$|auth\.json|\.bak|^bench_|catalog\.json|dsh-freemodels\.patch|oc-models/.test(name), name);
  }
});

test('published executable code has no personal checkout assumptions or foreign credential readers', async () => {
  for (const name of ['index.mjs', 'server.mjs', 'supervisor.mjs', 'setup.mjs', 'runtime-path.mjs']) {
    const source = await fs.readFile(path.join(here, name), 'utf8');
    assert.doesNotMatch(source, /\/home\/ryu|DSH OpenCode free|\.hermes\/auth|\.local\/share\/opencode\/auth/);
    assert.doesNotMatch(source, /NVIDIA_API_KEY|OPENROUTER_API_KEY|LOCAL_API_KEY/);
  }
});

test('plugin, relay and setup do not depend on the RDSH launcher', async () => {  for (const name of ['index.mjs', 'server.mjs', 'supervisor.mjs', 'setup.mjs', 'runtime-path.mjs', 'opencode-plugin.mjs', 'opencode-bridge.mjs']) {
    const source = await fs.readFile(path.join(here, name), 'utf8');
    // Comments may mention RDSH; executable code must not call or require it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\brdsh\b|rustdsh|RDSH_|tool-isolation/, name);
  }
  // The repository may document RDSH, but publishing must not require it.
  assert.deepEqual(metadata.bin, { 'dsh-opencode-zen-proxy': './supervisor.mjs', 'dsh-opencode-zen-setup': './setup.mjs' });
  assert.ok(metadata.scripts.test.includes('node --test'));
});

test('bare-node entry points import only their own dependencies, never host-provided peers', async () => {  // index.mjs is the Cordis plugin and legitimately uses peers the DSH launcher resolves.
  const own = new Set(Object.keys(metadata.dependencies || {}));
  const bare = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  for (const name of ['setup.mjs', 'supervisor.mjs', 'server.mjs', 'runtime-path.mjs', 'opencode-plugin.mjs', 'opencode-bridge.mjs']) {
    const source = await fs.readFile(path.join(here, name), 'utf8');
    for (const match of source.matchAll(/^\s*(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      assert.ok(own.has(bare(specifier)), `${name} must declare ${specifier} as a dependency`);
      assert.ok(!metadata.peerDependencies[bare(specifier)], `${name} cannot rely on the peer ${specifier} outside the launcher`);
    }
  }
});

test('symlinked npm bin shims still run the CLIs instead of exiting silently', async () => {
  const root = await fs.mkdtemp(path.join(here, '.bin-test-'));
  try {
    await fs.mkdir(path.join(root, 'node_modules/.bin'), { recursive: true });
    const pkg = path.join(root, 'node_modules/dsh-opencode-zen');
    await fs.symlink(here, pkg, 'dir');
    for (const [bin, target] of [['dsh-opencode-zen-setup', 'setup.mjs'], ['dsh-opencode-zen-proxy', 'supervisor.mjs']]) {
      const shim = path.join(root, 'node_modules/.bin', bin);
      await fs.symlink(path.join('..', 'dsh-opencode-zen', target), shim);
      const result = spawnSync(process.execPath, [shim, '--help'], { encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, `${bin}: ${result.stderr}`);
      assert.ok(result.stdout.trim().length > 0, `${bin} produced no output through its bin shim`);
    }
  } finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), here);
    assert.ok(path.basename(resolved).startsWith('.bin-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
