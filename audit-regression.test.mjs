// Security regressions use only loopback fixtures. No real model or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { once } from 'node:events';
import { createProxy, validateChat } from './server.mjs';

const key = 'synthetic-test-secret-'.repeat(3);
const basic = `Basic ${Buffer.from('opencode:fixture-password').toString('base64')}`;
const body = model => ({ model: model || 'zen/free', messages: [{ role: 'user', content: '日本語 fixture' }] });
const frame = 'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const rejectedCosts = {
  paid: { input: 1, output: 2 }, unknowncost: undefined, partialcost: { input: 0 },
  stringcost: { input: '0', output: 0 }, outputpaid: { input: 0, output: 1 },
  cachereadpaid: { input: 0, output: 0, cache: { read: 1, write: 0 } },
  cachewritepaid: { input: 0, output: 0, cache: { read: 0, write: 1 } },
  cacheunknown: { input: 0, output: 0, cache: { read: null, write: 0 } },
  cacheempty: { input: 0, output: 0, cache: {} },
  tierpaid: { input: 0, output: 0, context_over_200k: { input: 1, output: 0 } },
  tiercachepaid: { input: 0, output: 0, tiers: [{ input: 0, output: 0, cache: { read: 1 } }] },
  tierunknown: { input: 0, output: 0, tiers: [{ input: 0, output: 'unknown' }] },
  unknownpricing: { input: 0, output: 0, extra: { threshold: 200000, price: 0 } },
};
async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function harness(t, options = {}) {
  let entered;
  const state = { calls: [], payloads: [], fetches: [], hang: options.hang, failRefresh: false,
    messageStarted: new Promise(resolve => { entered = resolve; }) };
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.protocol, 'http:', 'tests must not call external HTTPS/model services');
    assert.equal(url.hostname, '127.0.0.1', 'tests must only call loopback fixtures');
    state.fetches.push(url.href);
    return originalFetch(input, init);
  });
  let base;
  const send = (res, value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  const chat = { api: { npm: '@ai-sdk/openai-compatible' }, cost: { input: 0, output: 0 },
    limit: { context: 200000, output: 2048 }, capabilities: { toolcall: true }, variants: { high: {} } };
  const ocURL = await listen(t, http.createServer((req, res) => {
    (async () => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const payload = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      state.calls.push({ path: req.url, payload, auth: req.headers.authorization });
      if (req.headers.authorization !== basic) return res.writeHead(401).end();
      if (state.failRefresh && req.url.startsWith('/config')) return res.writeHead(503).end();
      if (req.url === '/config/providers') return send(res, { providers: [
        { id: 'opencode', models: {
          free: chat,
          'big-pickle': { ...chat, id: 'big-pickle', providerID: 'opencode', cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
          tierfree: { ...chat, cost: { input: 0, output: 0, context_over_200k: { input: 0, output: 0, cache: { read: 0, write: 0 } } } },
          ...Object.fromEntries(Object.entries(rejectedCosts).map(([id, cost]) => [id, { ...chat, cost }])),
          nonchat: { ...chat, api: { npm: '@ai-sdk/anthropic' } },
          wrongsdk: { ...chat, api: { npm: '@openrouter/ai-sdk-provider' } },
          foreignowner: { ...chat, providerID: 'openrouter' },
          mismatchedid: { ...chat, id: 'paid-alias' },
          'vendor/model': chat, 'free?query': chat,
        } },
        { id: 'openrouter', models: { 'listed:free': { ...chat, api: { npm: '@openrouter/ai-sdk-provider' } }, free: chat } },
        { id: 'nvidia', models: { free: chat } }, { id: 'local', models: { curated: chat } },
      ] });
      if (req.url === '/config') return send(res, { agent: { 'dsh-bridge': { permission: { '*': 'deny' } } } });
      if (req.url === '/session') return send(res, { id: 'fixture-session' });
      if (req.url.endsWith('/message')) {
        entered();
        if (state.hang) return;
        const callback = `${base}/internal/bridge/${payload.system.slice('dsh-bridge:'.length)}`;
        const original = await fetch(callback).then(r => r.json());
        state.payloads.push(original);
        const posted = await fetch(callback, { method: 'POST', headers: { 'content-type': 'text/event-stream', 'x-upstream-status': String(options.upstreamStatus ?? 200) }, body: frame });
        await posted.arrayBuffer();
        return send(res, { parts: [{ type: 'text', text: 'Relayed.' }] });
      }
      return send(res, {});
    })().catch(err => res.destroy(err));
  }));
  const proxy = createProxy({ apiKey: key, ocURL, ocPassword: 'fixture-password', timeoutMs: 1000,
    maxBytes: options.maxBytes || 8192, maxConcurrent: options.maxConcurrent || 4 });
  base = await listen(t, proxy.server);
  await proxy.refresh();
  async function request(input = body(), headers = {}, endpoint = '/v1/chat/completions') {
    const data = typeof input === 'string' ? input : JSON.stringify(input);
    const allHeaders = { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers };
    // fetch rewrites Host: use raw HTTP to actually exercise hostile authorities.
    if (headers.host !== undefined) return new Promise((resolve, reject) => {
      const req = http.request(base + endpoint, { method: 'POST', headers: allHeaders }, res => {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.once('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      });
      req.once('error', reject); req.end(data);
    });
    return fetch(base + endpoint, { method: 'POST', headers: allHeaders, body: data, signal: AbortSignal.timeout(4000) });
  }
  return { ...proxy, base, state, request };
}

test('public API requires real token, rejects browser origins/Host rebinding, and health is cached', async t => {
  const h = await harness(t);
  for (const [headers, expected] of [
    [{ authorization: '' }, 401], [{ authorization: 'Bearer no-key' }, 401],
    [{ origin: 'https://attacker.example' }, 403], [{ origin: 'null' }, 403],
    [{ 'sec-fetch-site': 'cross-site' }, 403], [{ host: 'attacker.example:8099' }, 403], [{ host: '[' }, 403],
    [{ 'content-type': 'text/plain' }, 415], [{ 'content-type': 'application/jsonp' }, 415],
  ]) {
    const response = await h.request(body(), headers);
    assert.equal(response.status, expected, JSON.stringify(headers));
    await response.arrayBuffer();
  }
  assert.equal(h.state.calls.some(c => c.path === '/session'), false);
  const count = h.state.calls.length;
  for (let i = 0; i < 3; i++) assert.equal((await fetch(h.base + '/health').then(r => r.json())).ok, true);
  assert.equal(h.state.calls.length, count, 'health must not create upstream work');
  assert.equal((await fetch(h.base + '/v1/models')).status, 401);
  assert.equal((await h.request()).status, 200, 'server survives hostile Host');
});

test('only published OpenCode zero-cost Zen IDs are allowed, including big-pickle without a free suffix', async t => {
  const h = await harness(t);
  const models = await fetch(h.base + '/v1/models', { headers: { authorization: `Bearer ${key}` } }).then(r => r.json());
  assert.deepEqual(models.data.map(m => m.id).sort(), ['zen/big-pickle', 'zen/free', 'zen/nonchat', 'zen/tierfree', 'zen/wrongsdk']);
  assert.ok(models.data.every(m => m.providerID === 'opencode' && m.owned_by === 'freemodels:zen'));
  assert.equal(models.data.find(m => m.id === 'zen/free').maxTokens, 2048);
  for (const model of ['or/listed:free', 'or/free', 'nv/free', 'local/curated', 'openrouter/free', 'opencode/free',
    'zen/unknown', 'zen/foreignowner', 'zen/mismatchedid', 'zen/vendor/model', 'zen/free?query', 'zen/nonchat', 'zen/wrongsdk',
    ...Object.keys(rejectedCosts).map(id => `zen/${id}`)]) {
    const response = await h.request(body(model));
    assert.equal(response.status, 400, model); await response.arrayBuffer();
  }
  assert.equal(h.state.calls.some(c => c.path === '/session'), false);
  for (const model of ['zen/free', 'zen/big-pickle', 'zen/tierfree']) {
    const response = await h.request(body(model));
    assert.equal(response.status, 200, model); await response.arrayBuffer();
  }
  assert.ok(h.state.calls.filter(c => c.path.endsWith('/message')).every(c => c.payload.model.providerID === 'opencode'));
});

test('health reports the egress path and counts upstream refusals for the supervisor', async t => {
  const h = await harness(t, { upstreamStatus: 403 });
  const before = await fetch(h.base + '/health', { signal: AbortSignal.timeout(2000) }).then(r => r.json());
  assert.equal(typeof before.egress?.ipv6, 'boolean', 'the egress family must be reported');
  assert.equal(before.refusals?.count, 0);
  await h.request(body()).then(r => r.arrayBuffer());
  const after = await fetch(h.base + '/health', { signal: AbortSignal.timeout(2000) }).then(r => r.json());
  assert.equal(after.refusals.count, 1, 'a 403 from the upstream is what the relay recycles on');
  assert.match(after.refusals.lastAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('reusable proxy never reads credential files or forwards external provider API keys', async t => {
  const reads = t.mock.method(fs, 'readFileSync', () => { throw new Error('credential files must not be read'); });
  const externalKeys = ['OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'OPENCODE_API_KEY'];
  for (const name of externalKeys) {
    const old = process.env[name];
    process.env[name] = `synthetic-unused-${name}`;
    t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
  }
  const h = await harness(t);
  for (const model of ['or/listed:free', 'nv/free', 'local/curated']) {
    const response = await h.request(body(model));
    assert.equal(response.status, 400); await response.arrayBuffer();
  }
  const response = await h.request(body('zen/big-pickle'));
  assert.equal(response.status, 200); await response.arrayBuffer();
  assert.equal(reads.mock.calls.length, 0);
  assert.ok(h.state.calls.every(c => c.auth === basic));
  assert.doesNotMatch(JSON.stringify(h.state.calls), /synthetic-unused-/);
});

test('text-only and tool-history Chat requests BOTH use the Zen bridge, preserve messages and caller options', async t => {
  const h = await harness(t);
  const inputs = [{ ...body(), store: false }, { ...body('zen/big-pickle'), stream: true, temperature: 0.2, reasoning_effort: 'high',
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }],
    messages: [{ role: 'user', content: 'read fixture' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'private fixture result' }] }];
  for (const input of inputs) {
    const response = await h.request(input);
    assert.equal(response.status, 200); await response.arrayBuffer();
  }
  // Every caller field is relayed unchanged; a tool-less request additionally carries the one
  // realistic tool the gate requires (and a matching tool_choice), which the harness then strips.
  assert.equal(h.state.payloads.length, inputs.length);
  for (const [index, input] of inputs.entries()) {
    const { tools, tool_choice, ...rest } = h.state.payloads[index];
    const { tools: inputTools, tool_choice: inputChoice, ...inputRest } = input;
    assert.deepEqual(rest, inputRest, `caller fields must survive for input ${index}`);
    if (index === 0) {
      assert.equal(tools.length, 1);
      assert.equal(tools[0].function.name, 'read');
      assert.equal(tool_choice, 'none');
    } else {
      assert.deepEqual(tools, inputTools, 'caller tools must be relayed exactly');
      assert.deepEqual(tool_choice, inputChoice);
    }
  }
  for (const call of h.state.calls.filter(c => c.path.endsWith('/message'))) {
    assert.equal(call.payload.agent, 'dsh-bridge');
    assert.equal(call.payload.model.providerID, 'opencode');
    assert.match(call.payload.system, /^dsh-bridge:[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(call.payload), /private fixture|read fixture/);
  }
  assert.ok(h.state.calls.every(c => c.auth === basic));
});

test('JSON, schema and model selectors reject bad input before invoking OpenCode', async t => {
  const h = await harness(t, { maxBytes: 512 });
  for (const [input, expected] of [
    ['{broken', 400], ['null', 400], [[], 400], [{ ...body(), stream: 'false' }, 400], [{ ...body(), store: 'false' }, 400],
    [{ ...body(), messages: [] }, 400], [{ ...body(), messages: [null] }, 400],
    [{ ...body(), messages: [{ role: 'root', content: 'x' }] }, 400],
    [{ ...body(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://private/' } }] }] }, 400],
    [{ ...body(), messages: [{ role: 'tool', content: 'orphan' }] }, 400],
    [{ ...body(), tools: [null] }, 400], [{ ...body(), tool_choice: 'required' }, 400],
    [{ ...body(), max_tokens: -1 }, 400], [{ ...body(), max_tokens: 2049 }, 400], [{ ...body(), n: 100 }, 400],
    [{ ...body(), model: { providerID: 'openrouter', modelID: 'listed:free' } }, 400],
    [{ ...body(), model: ['zen/free', 'or/listed:free'] }, 400],
    ...['or/listed:free', 'nv/free', 'local/curated', 'zen/paid', 'zen/unknown'].flatMap(model => [
      [{ ...body(), models: [model] }, 400], [{ ...body(), provider: { model } }, 400],
      [`{"model":"zen/free","model":${JSON.stringify(model)},"messages":[{"role":"user","content":"x"}]}`, 400],
    ]),
    [{ ...body(), messages: [{ role: 'user', content: 'x'.repeat(1024) }] }, 413],
  ]) {
    const response = await h.request(input);
    assert.equal(response.status, expected, JSON.stringify(input).slice(0, 100)); await response.arrayBuffer();
  }
  assert.equal(h.state.calls.some(c => c.path === '/session'), false);
});

test('chunked request size is bounded as well as declared content-length', async t => {
  const h = await harness(t, { maxBytes: 128 });
  const response = await new Promise((resolve, reject) => {
    const req = http.request(h.base + '/v1/chat/completions', { method: 'POST', headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked',
    } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject); req.write('{"messages":"'); req.end('x'.repeat(256));
  });
  assert.equal(response, 413);
});

test('refresh failure disables cached Zen models instead of falling back to another provider', async t => {
  const h = await harness(t);
  h.state.failRefresh = true;
  await h.refresh();
  const health = await fetch(h.base + '/health').then(r => r.json());
  assert.equal(health.models, 0);
  assert.equal(health.upstreams.opencode, false);
  assert.equal((await h.request()).status, 400);
  assert.equal(h.state.calls.some(c => c.path === '/session'), false);
});

test('concurrency limit includes pending Zen work; timeout releases capacity', async t => {
  const h = await harness(t, { hang: true, maxConcurrent: 1 });
  const first = h.request();
  await h.state.messageStarted;
  const second = await h.request();
  assert.equal(second.status, 429); await second.arrayBuffer();
  const timedOut = await first;
  assert.equal(timedOut.status, 502); await timedOut.arrayBuffer();
  h.state.hang = false;
  const third = await h.request();
  assert.equal(third.status, 200); await third.arrayBuffer();
  assert.ok(h.state.calls.some(c => c.path.endsWith('/abort')));
});

test('validator accepts Zen text requests and rejects alternate provider/model syntax', () => {
  assert.doesNotThrow(() => validateChat({ ...body('zen/big-pickle'), messages: [{ role: 'developer', content: '' }, { role: 'user', content: [{ type: 'text', text: '日本語' }] }], stream: false }));
  for (const model of ['or/free', 'nv/free', 'local/free', 'opencode/free', 'zen/', 'zen/free/extra', 'zen/free?x', 'zen/free#x', 'zen/free\n']) {
    assert.throws(() => validateChat(body(model)), /zen\/<model-id>/, model);
  }
  assert.throws(() => createProxy({ apiKey: 'no-key' }), /32/);
  assert.throws(() => createProxy({ apiKey: ' '.repeat(64) }), /non-whitespace/);
  assert.throws(() => createProxy({ apiKey: key, ocURL: 'http://attacker.example' }), /loopback/);
});
