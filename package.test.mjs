import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

test('manifest follows the published DSH author fields', () => {
  assert.equal(metadata.dsh.manifestVersion, 1);
  // engines.dsh and every enforced DSH peer must declare one identical host range.
  const range = metadata.engines.dsh;
  assert.match(range, /^\^0\.2\.0-rc\.2$/);
  for (const [name, value] of Object.entries(metadata.peerDependencies)) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) assert.equal(value, range, name);
  }
  assert.equal(metadata.exports['./package.json'], './package.json');
  assert.equal(metadata.exports['./locale/*.json'], './locale/*.json');
});

test('display metadata follows the reader contract: locale dictionaries plus a bounded icon', async () => {
  assert.equal(metadata.icon, './icon.svg');
  assert.ok(metadata.files.includes('locale/*.json') && metadata.files.includes('icon.svg'));
  // dsh-app-boot reads <specifier>/locale/en.json and each sibling <language>.json as { meta: { title, description } }.
  for (const language of ['en', 'ja']) {
    const parsed = JSON.parse(await fs.readFile(path.join(here, 'locale', `${language}.json`), 'utf8'));
    assert.equal(typeof parsed.meta?.title, 'string'); assert.ok(parsed.meta.title.length > 0, language);
    assert.equal(typeof parsed.meta?.description, 'string'); assert.ok(parsed.meta.description.length > 0, language);
    assert.deepEqual(Object.keys(parsed.meta).sort(), ['description', 'title']);
  }
  const icon = await fs.readFile(path.join(here, 'icon.svg'));
  assert.ok(icon.byteLength < 256 * 1024, 'icon must stay under the 256 KiB reader limit');
  assert.match(icon.toString(), /^<svg[\s>]/);
});

test("DSH's own reader resolves the localized title, description and icon from this directory", async () => {
  // The contract test that would have caught a wrong locale path or export pattern.
  const { readPluginMeta } = await import('@deepseek-ai/dsh-app-boot');
  const base = pathToFileURL(`${here}/`).href;
  const meta = readPluginMeta(metadata.name, base);
  assert.equal(meta.error, undefined);
  assert.deepEqual(meta.title, { en: 'OpenCode Zen (free)', ja: 'OpenCode Zen（無料）' });
  assert.match(meta.description.en, /authenticated loopback relay/);
  assert.match(meta.description.ja, /ローカル中継/);
  assert.match(meta.icon, /^data:image\/svg\+xml;base64,/);
  // A non-package specifier yields nothing rather than a bogus entry.
  assert.equal(readPluginMeta('./index.mjs', base), undefined);
});

test('npm payload contains the plugin, supervisor and tests but no state, credentials or historical routes', { timeout: 30000 }, () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: here, encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
  const files = JSON.parse(result.stdout)[0].files.map(file => file.path);
  for (const name of ['index.mjs', 'server.mjs', 'supervisor.mjs', 'setup.mjs', 'runtime-path.mjs', 'zen-limits.mjs', 'cordis.patch.yml', 'plugin.test.mjs', 'LICENSE', 'icon.svg', 'locale/en.json', 'locale/ja.json']) assert.ok(files.includes(name), name);
  for (const name of files) {
    assert.ok(!/(^|\/)(runtime|node_modules|\.env|\.credentials\.yaml)(\/|$)/.test(name), name);
    assert.ok(!/\.key$|auth\.json|\.bak|^bench_|catalog\.json|dsh-freemodels\.patch|oc-models/.test(name), name);
  }
});

test('published executable code has no personal checkout assumptions or foreign credential readers', async () => {
  for (const name of ['index.mjs', 'server.mjs', 'supervisor.mjs', 'setup.mjs', 'runtime-path.mjs', 'zen-limits.mjs']) {
    const source = await fs.readFile(path.join(here, name), 'utf8');
    assert.doesNotMatch(source, /\/home\/ryu|DSH OpenCode free|\.hermes\/auth|\.local\/share\/opencode\/auth/);
    assert.doesNotMatch(source, /NVIDIA_API_KEY|OPENROUTER_API_KEY|LOCAL_API_KEY/);
  }
});

test('plugin, relay and setup do not depend on the RDSH launcher', async () => {
  for (const name of ['index.mjs', 'server.mjs', 'supervisor.mjs', 'setup.mjs', 'runtime-path.mjs', 'zen-limits.mjs', 'opencode-plugin.mjs', 'opencode-bridge.mjs', 'bench-context.mjs']) {
    const source = await fs.readFile(path.join(here, name), 'utf8');
    // Comments may mention RDSH; executable code must not call or require it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\brdsh\b|rustdsh|RDSH_|tool-isolation/, name);
  }
  // The repository may document RDSH, but publishing must not require it.
  assert.deepEqual(metadata.bin, { 'dsh-opencode-zen-proxy': './supervisor.mjs', 'dsh-opencode-zen-setup': './setup.mjs' });
  assert.ok(metadata.scripts.test.includes('node --test'));
});

test('bare-node entry points import only their own dependencies, never host-provided peers', async () => {
  // index.mjs is the Cordis plugin and legitimately uses peers the DSH launcher resolves.
  const own = new Set(Object.keys(metadata.dependencies || {}));
  const bare = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  for (const name of ['setup.mjs', 'supervisor.mjs', 'server.mjs', 'runtime-path.mjs', 'zen-limits.mjs', 'opencode-plugin.mjs', 'opencode-bridge.mjs', 'bench-context.mjs']) {
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

test('the default README is Japanese and the one-command installer is shippable', async () => {
  const readme = await fs.readFile(path.join(here, 'README.md'), 'utf8');
  assert.match(readme, /[\u3040-\u30ff\u4e00-\u9faf]/, 'README.md is the default page and must be Japanese');
  assert.match(readme, /install\.sh/, 'the default README must show the one-command install');
  for (const name of ['README.en.md', 'install.sh']) assert.ok(metadata.files.includes(name), name);
  // Docs must never point at an older tarball than the package itself.
  for (const name of ['README.md', 'README.en.md', 'install.sh']) {
    const text = await fs.readFile(path.join(here, name), 'utf8');
    assert.ok(text.includes(metadata.version), `${name} must mention version ${metadata.version}`);
  }
  assert.match(await fs.readFile(path.join(here, 'README.md'), 'utf8'), new RegExp(`releases/download/v${metadata.version}/dsh-opencode-zen-${metadata.version}\\.tgz`));
  const installer = await fs.readFile(path.join(here, 'install.sh'), 'utf8');
  assert.match(installer, /set -euo pipefail/);
  assert.match(installer, /dsh-opencode-zen-\$\{VERSION\}\.tgz/, 'installer must fetch the released tarball');
  assert.doesNotMatch(installer, /\/home\/ryu|kuraneko1@/);
  const syntax = spawnSync('bash', ['-n', path.join(here, 'install.sh')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('the installer repairs a stale local specifier that would block every pnpm operation', async () => {
  const script = await fs.readFile(path.join(here, 'install.sh'), 'utf8');
  const body = script.split('# --- repair: begin ---')[1]?.split('# --- repair: end ---')[0]?.split('\n').slice(1).join('\n');
  assert.ok(body, 'install.sh must keep the marked repair section');
  const root = await fs.mkdtemp(path.join(here, '.repair-test-'));
  try {
    const repair = path.join(root, 'repair.sh');
    await fs.writeFile(repair, `set -euo pipefail\n${body}\nrepair_stale_local_specifier\n`, { mode: 0o755 });
    const manifest = path.join(root, 'package.json');
    const run = (url, file, name) => spawnSync('bash', [repair], { encoding: 'utf8',
      env: { ...process.env, MANIFEST: file, TARBALL: url, PACKAGE: name } });
    const url = 'https://example.test/dsh-opencode-zen-1.0.0.tgz';
    // A missing file: specifier is repaired and backed up.
    await fs.writeFile(manifest, JSON.stringify({ dependencies: { 'dsh-opencode-zen': `file:${root}/gone.tgz`, other: 'keep' } }));
    const fixed = run(url, manifest, 'dsh-opencode-zen');
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.match(fixed.stderr, /replaced the missing local specifier/);
    const rewritten = JSON.parse(await fs.readFile(manifest, 'utf8'));
    assert.equal(rewritten.dependencies['dsh-opencode-zen'], url);
    assert.equal(rewritten.dependencies.other, 'keep');
    assert.equal((await fs.readdir(root)).filter(x => x.includes('.bak-opencode-zen-')).length, 1);
    // Already correct, a different package, or an existing local file: nothing to do.
    assert.equal(run(url, manifest, 'dsh-opencode-zen').status, 1);
    await fs.writeFile(manifest, JSON.stringify({ dependencies: { 'dsh-opencode-zen': 'file:./present.tgz' } }));
    await fs.writeFile(path.join(root, 'present.tgz'), 'x');
    assert.equal(run(url, manifest, 'dsh-opencode-zen').status, 1);
    assert.equal(run(url, manifest, 'some-other-package').status, 1);
  } finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), here);
    assert.ok(path.basename(resolved).startsWith('.repair-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
