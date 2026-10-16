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
  for (const name of ['index.mjs', 'server.mjs', 'supervisor.mjs', 'rdsh-plugin.mjs', 'runtime-path.mjs', 'cordis.patch.yml', 'plugin.test.mjs', 'LICENSE']) assert.ok(files.includes(name), name);
  for (const name of files) {
    assert.ok(!/(^|\/)(runtime|node_modules|\.env|\.credentials\.yaml)(\/|$)/.test(name), name);
    assert.ok(!/\.key$|auth\.json|\.bak|^bench_|catalog\.json|dsh-freemodels\.patch|oc-models/.test(name), name);
  }
});

test('published executable code has no personal checkout assumptions or foreign credential readers', async () => {
  for (const name of ['index.mjs', 'server.mjs', 'supervisor.mjs', 'rdsh-plugin.mjs', 'runtime-path.mjs']) {
    const source = await fs.readFile(path.join(here, name), 'utf8');
    assert.doesNotMatch(source, /\/home\/ryu|DSH OpenCode free|\.hermes\/auth|\.local\/share\/opencode\/auth/);
    assert.doesNotMatch(source, /NVIDIA_API_KEY|OPENROUTER_API_KEY|LOCAL_API_KEY/);
  }
});
