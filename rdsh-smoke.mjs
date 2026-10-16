// Opt-in live integration: temporary RDSH profile, real isolated inspection, exact nonce proof.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { integrate } from './rdsh-plugin.mjs';
import { runtimeDirectory } from './runtime-path.mjs';
// RDSH rejects shell wrappers: it audits the real @deepseek-ai/dsh lib/bin.js path.
const dshBin = process.env.RDSH_ORIG_BIN || process.env.DSH_ORIG_BIN
  || path.join(process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh'),
    'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = runtimeDirectory();
const scratch = path.join(root, `rdsh-smoke-${randomUUID()}`);
const expected = `RDSH_TOOL_OK_${randomBytes(16).toString('hex')}`;
const proof = path.join(scratch, 'proof.txt');
const baseURL = process.env.PROXY_URL || 'http://127.0.0.1:8099';
const model = process.env.PROBE_MODEL || 'zen/deepseek-v4.1-flash-free';
try {
  await fs.mkdir(path.join(scratch, 'profiles/headless'), { recursive: true, mode: 0o700 });
  const profile = path.join(scratch, 'profiles/headless');
  await fs.mkdir(path.join(profile, 'node_modules'), { recursive: true });
  await fs.symlink(here, path.join(profile, 'node_modules/dsh-opencode-zen'), 'dir');
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'proxy-smoke-headless', private: true,
    dependencies: { 'dsh-opencode-zen': `file:${here}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-opencode-zen'] } } }), { mode: 0o600 });
  await fs.writeFile(path.join(scratch, 'profiles/headless/cordis.patch.yml'), '[]\n', { mode: 0o600 });
  await fs.writeFile(proof, expected + '\n', { mode: 0o600 });
  await integrate({ install: true, dshHome: scratch, profile: 'headless', baseURL: baseURL.replace(/\/$/, '') + '/v1' });
  const overlay = path.join(scratch, 'selection.yml');
  await fs.writeFile(overlay, JSON.stringify([{ id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model',
    config: { provider: 'opencode-zen', model } }]), { mode: 0o600 });
  const executable = process.env.RDSH_BIN || 'rdsh';
  await fs.access(dshBin).catch(() => {
    throw new Error(`RDSH audits the real DSH runtime; set DSH_ORIG_BIN to its lib/bin.js (tried ${dshBin})`);
  });
  const args = ['--share-file', 'proof.txt', '--profile', 'headless', '--patch', overlay, '--json',
    'Use rdsh_inspect with command "cat /workspace/proof.txt" to inspect the explicitly shared file in its read-only, network-denying sandbox. Then reply with exactly the file content, no commentary. Do not use read, bash, or any other tool.'];
  const child = spawn(executable, args, { cwd: scratch, env: { ...process.env, DSH_HOME: scratch,
    DSH_ORIG_BIN: dshBin, DSH_TELEMETRY_DISABLED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(120000) });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill('SIGTERM'); });
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill('SIGTERM'); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, `RDSH failed: ${stderr.slice(-3000)}\n${stdout.slice(-3000)}`);
  const events = stdout.split('\n').filter(x => x.startsWith('{')).map(x => JSON.parse(x));
  const call = events.find(e => e.type === 'tool_call' && e.tool === 'rdsh_inspect');
  assert.ok(call, 'no secure rdsh_inspect tool call');
  const toolResult = events.find(e => e.type === 'tool_result' && e.callId === call.callId);
  assert.equal(toolResult?.status, 'completed', `isolated inspection did not complete: ${JSON.stringify(toolResult)}`);
  const inspected = JSON.parse(toolResult.result);
  assert.equal(inspected.exitCode, 0, `sandbox command failed: ${inspected.stderr}`);
  assert.equal(inspected.stdout.trim(), expected, 'isolated tool did not read the shared nonce');
  const final = events.findLast(e => e.type === 'final');
  assert.ok(final && Object.values(final).some(x => typeof x === 'string' && x.trim() === expected), 'final answer did not match the file-only nonce');
  console.log(`PASS RDSH: ${model}, secure rdsh_inspect completed, exact file-only nonce, isolated credentials/profile`);
} finally {
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), root);
  assert.ok(path.basename(resolved).startsWith('rdsh-smoke-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
