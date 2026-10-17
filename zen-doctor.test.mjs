import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, diagnose } from './zen-doctor.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('the doctor classifies provider verdicts', () => {
  assert.equal(classify(200, { choices: [{ message: { content: 'ok' } }] }), 'ok');
  assert.equal(classify(403, { error: { type: 'FreeTierError', message: 'x' } }), 'free-tier');
  assert.equal(classify(401, { error: { type: 'unauthorized' } }), 'auth');
  assert.equal(classify(500, {}), 'http-500');
  // A 200 without choices is not proof that the lane works.
  assert.equal(classify(200, { error: { type: 'FreeTierError' } }), 'free-tier');
});

test('the diagnosis names the measured difference between address families', () => {
  assert.match(diagnose('ok', 'IPv6'), /accepts this network/);
  const v4 = diagnose('free-tier', 'IPv4');
  assert.match(v4, /refuses this IPv4 egress/);
  assert.match(v4, /IPv6/);
  assert.match(diagnose('free-tier', 'IPv6'), /Nothing on this side can change that/);
  assert.match(diagnose('auth', 'IPv4'), /local token/);
});

test('the package ships the doctor, and no text claims anonymous access is impossible', async () => {
  const metadata = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));
  assert.ok(metadata.files.includes('zen-doctor.mjs'));
  for (const name of ['README.md', 'README.en.md', 'AUDIT.md']) {
    const text = await readFile(path.join(here, name), 'utf8');
    assert.doesNotMatch(text, /refuses anonymous clients/i, name);
  }
});
