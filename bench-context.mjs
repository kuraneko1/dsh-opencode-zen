// Measures how much input the live relay actually accepts for one Zen model, so a
// declared context limit is never based on the published metadata alone.
//
//   node bench-context.mjs [model] [approxTokens]
//
// Consumes free-tier quota and sends ~4 characters per requested token.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runtimeDirectory } from './runtime-path.mjs';

const base = process.env.PROXY_URL || 'http://127.0.0.1:8099';
const model = process.argv[2] || 'zen/deepseek-v4.1-flash-free';
const target = Number(process.argv[3] || 250_000);
assert.ok(Number.isSafeInteger(target) && target > 0, 'approxTokens must be a positive integer');
const key = process.env.FREEMODELS_API_KEY || fs.readFileSync(path.join(runtimeDirectory(), 'proxy.key'), 'utf8').trim();

const filler = Array.from({ length: Math.ceil(target * 4 / 48) },
  (_, index) => `line ${index}: the quick brown fox jumps over the lazy dog`).join('\n');
// The free-tier gate rejects a trivial placeholder tool (403 FreeTierError), so send one
// realistic tool with a required parameter, matching what the DSH agent actually sends.
const tools = [{ type: 'function', function: {
  name: 'read', description: 'Read a UTF-8 text file and return line-numbered content.',
  parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false },
} }];
const started = Date.now();
let response;
try {
  response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, max_tokens: 16, stream: false, tool_choice: 'auto', tools,
      messages: [{ role: 'user', content: `${filler}\n\nReply with exactly: OK` }],
    }),
    signal: AbortSignal.timeout(600_000),
  });
} catch (error) {
  throw new Error(`request to ${model} failed: ${error.message || error}`);
}
const body = await response.json();
assert.equal(response.status, 200, JSON.stringify(body).slice(0, 400));
const prompt = body.usage?.prompt_tokens ?? 0;
console.log(JSON.stringify({ model, characters: filler.length, requestedTokens: target, promptTokens: prompt,
  completion: body.choices?.[0]?.message?.content?.trim(), ms: Date.now() - started }));
// The dedicated OpenCode truncates silently above its declared client limit, so long input must prove itself.
if (target > 200_000) assert.ok(prompt > 200_000, `input appears truncated: ${prompt} tokens for a ~${target}-token prompt`);
