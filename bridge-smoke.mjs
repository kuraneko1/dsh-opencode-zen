import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runtimeDirectory } from './runtime-path.mjs';

const base = process.env.PROXY_URL || 'http://127.0.0.1:8099';
const endpoint = new URL(base);
assert.ok(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname) && endpoint.pathname === '/' && !endpoint.username && !endpoint.password, 'probe requires a numeric loopback HTTP origin');
const key = process.env.FREEMODELS_API_KEY || fs.readFileSync(path.join(runtimeDirectory(), 'proxy.key'), 'utf8').trim();
assert.ok(key.length >= 32, 'a real proxy credential is required');
const model = process.env.PROBE_MODEL || 'zen/deepseek-v4.1-flash-free';
const nonce = randomBytes(8).toString('hex');
const tools = [{ type: 'function', function: {
  name: 'read', description: 'Read a UTF-8 text file and return line-numbered content.',
  parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false },
} }];
const messages = [
  { role: 'system', content: 'Follow the user instructions. Use read when requested. After receiving the tool result, output it exactly, without commentary.' },
  { role: 'user', content: `Use read to read /bridge-probe/${nonce}. You cannot know its result before calling it.` },
];

async function request(messages, tool_choice, stream) {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, tools, tool_choice, stream, max_tokens: 2048, reasoning_effort: 'low' }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response;
}

const first = await request(messages, { type: 'function', function: { name: 'read' } }, true);
const raw = await first.text();
let call;
let reasoning = '';
let content = '';
let finish;
for (const line of raw.split('\n')) {
  if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
  const data = JSON.parse(line.slice(6));
  if (data.error) throw new Error(JSON.stringify(data.error));
  const choice = data.choices?.[0];
  if (!choice) continue;
  finish = choice.finish_reason || finish;
  reasoning += choice.delta?.reasoning_content || choice.delta?.reasoning || '';
  content += choice.delta?.content || '';
  for (const delta of choice.delta?.tool_calls || []) {
    assert.equal(delta.index, 0, 'the probe requests only one tool');
    call ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
    call.id = delta.id || call.id;
    call.function.name += delta.function?.name || '';
    call.function.arguments += delta.function?.arguments || '';
  }
}
assert.equal(finish, 'tool_calls', raw);
assert.ok(call?.id, raw);
assert.equal(call.function.name, 'read');
assert.deepEqual(JSON.parse(call.function.arguments), { file_path: `/bridge-probe/${nonce}` });
console.log(`PASS ${model}: SSE tool_calls / id / arguments / finish_reason`);
const secret = `BRIDGE_OK_${randomBytes(12).toString('hex')}`;
const assistant = { role: 'assistant', content: content || null, tool_calls: [call] };
if (reasoning) assistant.reasoning_content = reasoning;
messages.push(assistant, { role: 'tool', tool_call_id: call.id, content: secret });
// The second phase requests the final answer, not another tool call.
const second = await request(messages, 'none', false);
const result = await second.json();
assert.equal(result.choices?.[0]?.message?.content?.trim(), secret, JSON.stringify(result));
assert.equal(result.choices[0].finish_reason, 'stop');
console.log(`PASS ${model}: tool result roundtrip / exact client-only secret`);
