import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createBridge, collectCompletion, createSSEValidator } from './opencode-bridge.mjs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import plugin from './opencode-plugin.mjs';

const MARKER = 'x-dsh-bridge-token';
const TOKEN = 'a'.repeat(64);
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(t, handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => handler(req, res)).catch(err => {
      if (res.headersSent) res.destroy(err);
      else res.writeHead(500).end(String(err.stack));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function readJSON(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function sendFragmentedSSE(res, content, truncate = false) {
  const bytes = Buffer.from(content);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  // Split JSON, SSE delimiters, and multibyte UTF-8 at arbitrary byte boundaries.
  for (let i = 0; i < bytes.length; i += 7) {
    res.write(bytes.subarray(i, i + 7));
    await new Promise(resolve => setImmediate(resolve));
  }
  if (truncate) res.destroy();
  else res.end();
}

async function loadPlugin(base) {
  const old = process.env.FREEMODELS_BRIDGE_URL;
  try {
    if (base === undefined) delete process.env.FREEMODELS_BRIDGE_URL;
    else process.env.FREEMODELS_BRIDGE_URL = base;
    return await plugin();
  } finally {
    if (old === undefined) delete process.env.FREEMODELS_BRIDGE_URL;
    else process.env.FREEMODELS_BRIDGE_URL = old;
  }
}

function payload(stream = true) {
  return {
    model: 'zen/client-model', stream,
    messages: [
      { role: 'system', content: 'Original DSH system 日本語' },
      { role: 'user', content: 'Inspect the file.' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_previous', type: 'function', function: { name: 'read_file', arguments: '{"path":"before.txt"}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_previous', content: 'previous tool result' },
      { role: 'user', content: 'Now inspect next.txt.' },
    ],
    tools: [{ type: 'function', function: {
      name: 'read_file', description: 'Read a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    } }],
    tool_choice: { type: 'function', function: { name: 'read_file' } },
    reasoning_effort: 'high', temperature: 0.17, max_tokens: 1234,
    parallel_tool_calls: false,
  };
}

async function harness(t, upstreamHandler) {
  const providerID = 'opencode';
  const state = {
    ocCalls: [], upstream: [], ocReplies: [], ocErrors: [], bridgeErrors: [],
    finished: deferred(), messageFinished: deferred(),
  };
  let bridge, hooks, config;
  const upstreamURL = await listen(t, async (req, res) => {
    const body = await readJSON(req);
    state.upstream.push({ body, headers: req.headers, url: req.url });
    await upstreamHandler(req, res, state);
  });
  const base = await listen(t, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (await bridge.handle(req, res, url)) return;
    if (url.pathname !== '/v1/chat/completions') return res.writeHead(404).end();
    const body = await readJSON(req);
    try {
      await bridge.complete(body, providerID, 'configured-model', res);
    } catch (err) {
      state.bridgeErrors.push(err);
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.destroy(err);
        else {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    } finally {
      state.finished.resolve();
    }
  });
  hooks = await loadPlugin(base);
  config = { provider: {
    [providerID]: { options: { fetch: globalThis.fetch } },
  } };
  await hooks.config(config);
  const oc = async (path, init) => {
    state.ocCalls.push({ path, init, body: init.body && JSON.parse(init.body) });
    if (path === '/session') return { id: 'session-test' };
    if (path === '/session/session-test/message') {
      state.signal = init.signal;
      const body = JSON.parse(init.body);
      state.token = body.system.slice('dsh-bridge:'.length);
      const output = { headers: { 'content-type': 'application/json', 'x-opencode-test': 'sdk-header' } };
      await hooks['chat.headers']({ agent: body.agent, model: body.model, message: { system: body.system } }, output);
      state.sdkHeaders = output.headers;
      const sdkBody = {
        model: 'upstream/resolved-model', stream: true,
        messages: [{ role: 'user', content: 'SDK placeholder, not the client conversation' }],
        tools: [{ type: 'function', function: { name: 'invalid', parameters: { type: 'object' } } }],
        tool_choice: 'auto', reasoning_effort: 'low', temperature: 0.9,
        max_tokens: 7, max_completion_tokens: 8, stream_options: { include_usage: true },
        parallel_tool_calls: true,
      };
      try {
        const response = await config.provider[providerID].options.fetch(`${upstreamURL}/v1/chat/completions`, {
          method: 'POST', headers: output.headers, body: JSON.stringify(sdkBody), signal: init.signal,
        });
        state.ocReplies.push({ status: response.status, contentType: response.headers.get('content-type'), text: await response.text() });
        return { parts: [{ type: 'text', text: 'Relayed.' }] };
      } catch (err) {
        state.ocErrors.push(err);
        throw err;
      } finally {
        state.messageFinished.resolve();
      }
    }
    if (path === '/session/session-test/abort' || (path === '/session/session-test' && init.method === 'DELETE')) return {};
    throw new Error(`unexpected OpenCode call: ${path}`);
  };
  bridge = createBridge({ oc, timeoutMs: 2000, log() {} });
  return { base, state, hooks, config };
}

async function complete(h, body) {
  return fetch(`${h.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
}

async function assertFinished(h) {
  await bounded(h.state.finished.promise, 'bridge completion');
  await bounded(h.state.messageFinished.promise, 'OpenCode dummy response');
  assert.deepEqual(h.state.bridgeErrors, []);
  assert.deepEqual(h.state.ocErrors, []);
  assert.equal(h.state.ocReplies.length, 1);
  const dummy = h.state.ocReplies[0];
  assert.equal(dummy.status, 200);
  assert.match(dummy.contentType, /text\/event-stream/);
  assert.doesNotMatch(dummy.text, /tool_calls|read_file|call_next|next\.txt/);
  const frames = dummy.text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]');
  assert.ok(frames.length > 0);
  assert.equal(frames.map(line => JSON.parse(line.slice(6)).choices[0].delta.content || '').join(''), 'Relayed.');
  const message = h.state.ocCalls.find(call => call.path.endsWith('/message')).body;
  assert.equal(message.agent, 'dsh-bridge');
  assert.match(message.system, /^dsh-bridge:[a-f0-9]{64}$/);
  assert.deepEqual(message.tools, {});
  assert.deepEqual(message.parts, [{ type: 'text', text: 'Relay the registered request.' }]);
  assert.doesNotMatch(JSON.stringify(message), /read_file|call_previous|previous tool result|next\.txt/);
  assert.ok(h.state.ocCalls.some(call => call.path.endsWith('/abort')));
  assert.ok(h.state.ocCalls.some(call => call.path === '/session/session-test' && call.init.method === 'DELETE'));
}

function assertUpstream(h, original) {
  assert.equal(h.state.upstream.length, 1);
  const received = h.state.upstream[0];
  assert.deepEqual(received.body, {
    ...original, model: 'upstream/resolved-model', stream: true,
    ...(original.stream === true ? {} : { stream_options: { include_usage: true } }),
  });
  assert.equal(received.headers[MARKER], undefined);
  assert.equal(received.headers['x-opencode-test'], 'sdk-header');
  assert.equal(h.state.sdkHeaders[MARKER], h.state.token);
  assert.ok(!JSON.stringify(received).includes(h.state.token));
}

test('plugin reads env, wraps only OpenCode Zen, and marks only exact dsh-bridge capabilities', async t => {
  assert.deepEqual(await loadPlugin(undefined), {});
  await assert.rejects(loadPlugin('https://example.com'), /loopback/);
  const upstreamRequests = [];
  const base = await listen(t, async (req, res) => {
    upstreamRequests.push({ headers: req.headers, body: await readJSON(req) });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ordinary":true}');
  });
  const hooks = await loadPlugin(base);
  const foreignFetch = async () => { throw new Error('foreign provider must stay untouched'); };
  const foreign = { options: { fetch: foreignFetch, apiKey: 'foreign-fixture' } };
  const config = { provider: { opencode: { options: { apiKey: 'keep-me' } }, foreign } };
  await hooks.config(config);
  assert.equal(config.provider.opencode.options.apiKey, 'keep-me');
  assert.equal(config.agent['dsh-bridge'].hidden, true);
  assert.equal(typeof config.provider.opencode.options.fetch, 'function');
  assert.deepEqual(Object.keys(config.provider).sort(), ['foreign', 'opencode']);
  assert.equal(config.provider.foreign, foreign);
  assert.equal(config.provider.foreign.options.fetch, foreignFetch);
  for (const [agent, system, marked] of [
    ['dsh-bridge', `dsh-bridge:${TOKEN}`, true],
    ['title', `dsh-bridge:${TOKEN}`, false],
    ['build', `dsh-bridge:${TOKEN}`, false],
    ['dsh-bridge', `prefix dsh-bridge:${TOKEN}`, false],
    ['dsh-bridge', `dsh-bridge:${TOKEN}\ntrailing`, false],
    ['dsh-bridge', `dsh-bridge:${TOKEN}\n`, false],
    ['dsh-bridge', `dsh-bridge:${TOKEN}\r\n`, false],
    ['dsh-bridge', `dsh-bridge:${'a'.repeat(63)}`, false],
    ['dsh-bridge', `dsh-bridge:${'A'.repeat(64)}`, false],
    ['dsh-bridge', undefined, false],
  ]) {
    const output = { headers: { existing: 'preserved' } };
    await hooks['chat.headers']({ agent, model: { providerID: 'opencode' }, message: { system } }, output);
    assert.deepEqual(output.headers, marked ? { existing: 'preserved', [MARKER]: TOKEN } : { existing: 'preserved' });
  }
  const titleHeaders = { headers: { 'content-type': 'application/json' } };
  await hooks['chat.headers']({ agent: 'title', model: { providerID: 'opencode' }, message: { system: `dsh-bridge:${TOKEN}` } }, titleHeaders);
  const ordinary = { model: 'title-model', messages: [{ role: 'user', content: 'title' }] };
  for (const providerID of ['foreign', undefined]) {
    const output = { headers: {} };
    await hooks['chat.headers']({ agent: 'dsh-bridge', model: { providerID }, message: { system: `dsh-bridge:${TOKEN}` } }, output);
    assert.deepEqual(output.headers, {});
  }
  const result = await config.provider.opencode.options.fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: titleHeaders.headers, body: JSON.stringify(ordinary),
  });
  assert.deepEqual(await result.json(), { ordinary: true });
  assert.equal(upstreamRequests.length, 1);
  for (const request of upstreamRequests) {
    assert.equal(request.headers[MARKER], undefined);
    assert.deepEqual(request.body, ordinary);
  }
});

test('fragmented SSE tool calls relay byte-for-byte; capabilities cannot be claimed twice or reused', async t => {
  const frames = [
    ': upstream comment\r\n\r\n',
    `data: ${JSON.stringify({ id: 'real', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_next', type: 'function', function: { name: 'read_file', arguments: '{"path":"' } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'real', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '日本語/next.txt"}' } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'real', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { completion_tokens: 9 } })}\n\ndata: [DONE]\n\n`,
  ];
  const bytes = Buffer.from(frames.join(''));
  const h = await harness(t, async (_req, res, state) => {
    const replay = await fetch(`${h.base}/internal/bridge/${state.token}`);
    state.secondClaimStatus = replay.status;
    await replay.arrayBuffer();
    await sendFragmentedSSE(res, bytes);
  });
  for (const method of ['GET', 'POST']) {
    const missing = await fetch(`${h.base}/internal/bridge/${TOKEN}`, { method });
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
  }
  const original = payload();
  const response = await complete(h, original);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get(MARKER), null);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await assertFinished(h);
  assertUpstream(h, original);
  assert.equal(h.state.secondClaimStatus, 409);
  for (const method of ['GET', 'POST']) {
    const replay = await fetch(`${h.base}/internal/bridge/${h.state.token}`, { method });
    assert.equal(replay.status, 404);
    await replay.arrayBuffer();
  }
});

test('Zen nonstream JSON and full tool history remain unchanged', async t => {
  const bytes = Buffer.from(' {"id":"json-result","choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_next","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"next.txt\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":41}}\n');
  const h = await harness(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(bytes);
  });
  const original = payload(false);
  const response = await complete(h, original);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const received = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(received, bytes);
  assert.equal(JSON.parse(received).choices[0].message.tool_calls[0].id, 'call_next');
  await assertFinished(h);
  assertUpstream(h, original);
});

test('nonstream caller receives aggregated fragmented SSE reasoning, parallel tools, content and usage', async t => {
  const meta = { id: 'aggregate-result', object: 'chat.completion.chunk', created: 123456,
    model: 'upstream/resolved-model', system_fingerprint: 'fp_test' };
  const chunks = [
    { ...meta, choices: [
      { index: 1, delta: { role: 'assistant', content: '日本' }, finish_reason: null },
      { index: 0, delta: { role: 'assistant', content: null, reasoning_content: '調査', tool_calls: [
        { index: 0, id: 'call_next', type: 'function', function: { name: 'read_', arguments: '{"path":"' } },
        { index: 1, id: 'call_second', type: 'function', function: { name: 'read_file', arguments: '{"path":"second' } },
      ] }, finish_reason: null },
    ] },
    { ...meta, choices: [
      { index: 0, delta: { reasoning_content: 'します', tool_calls: [
        { index: 1, function: { arguments: '.txt"}' } },
        { index: 0, function: { name: 'file', arguments: '日本語/next.txt"}' } },
      ] }, finish_reason: null },
      { index: 1, delta: { content: '語の回答' }, finish_reason: null },
    ] },
    { ...meta, choices: [
      { index: 1, delta: {}, finish_reason: 'stop' },
      { index: 0, delta: {}, finish_reason: 'tool_calls' },
    ] },
    { ...meta, choices: [], usage: { prompt_tokens: 23, completion_tokens: 17, total_tokens: 40,
      completion_tokens_details: { reasoning_tokens: 5 } } },
  ];
  const bytes = Buffer.from(': comment\r\n\r\n' + chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
  const h = await harness(t, (_req, res) => sendFragmentedSSE(res, bytes));
  const original = { ...payload(false), n: 2 };
  const response = await complete(h, original);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(response.headers.get(MARKER), null);
  assert.deepEqual(await response.json(), {
    ...meta, object: 'chat.completion',
    choices: [
      { index: 0, message: { role: 'assistant', content: null, reasoning_content: '調査します', tool_calls: [
        { id: 'call_next', type: 'function', function: { name: 'read_file', arguments: '{"path":"日本語/next.txt"}' } },
        { id: 'call_second', type: 'function', function: { name: 'read_file', arguments: '{"path":"second.txt"}' } },
      ] }, finish_reason: 'tool_calls' },
      { index: 1, message: { role: 'assistant', content: '日本語の回答' }, finish_reason: 'stop' },
    ],
    usage: chunks.at(-1).usage,
  });
  await assertFinished(h);
  assertUpstream(h, original);
});

test('nonstream incomplete or malformed SSE is 502, never a successful partial completion', async t => {
  const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({
    id: 'broken', choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`;
  for (const [name, content, error, truncate] of [
    ['missing finish_reason', frame({ role: 'assistant', content: 'partial' }) + 'data: [DONE]\n\n', /finish_reason/],
    ['malformed middle event', frame({ content: 'partial' }) + 'data: {broken-json}\n\n' + frame({}, 'stop'), /JSON|property name|Unexpected/i],
    ['truncated final event after finish', frame({ content: 'partial' }, 'stop') + 'data: {"usage":', /JSON|Unexpected|SSE frame/i],
    ['explicit upstream error', 'data: {"error":{"message":"provider stream failed"}}\n\n', /provider stream failed/],
    ['socket closed mid-event', frame({ content: 'partial' }) + 'data: {"choices":', /aborted|terminated|fetch|socket/i, true],
  ]) {
    await t.test(name, async subtest => {
      const h = await harness(subtest, (_req, res) => sendFragmentedSSE(res, content, truncate));
      const original = payload(false);
      const response = await complete(h, original);
      assert.equal(response.status, 502);
      assert.match(response.headers.get('content-type'), /application\/json/);
      const body = await response.json();
      assert.equal(Object.hasOwn(body, 'choices'), false);
      assert.match(JSON.stringify(body.error), error);
      await bounded(h.state.finished.promise, 'failed aggregation cleanup');
      await bounded(h.state.messageFinished.promise, 'failed callback cancellation');
      assert.equal(h.state.bridgeErrors.length, 1);
      assert.equal(h.state.ocReplies.length, 0);
      assert.equal(h.state.signal.aborted, true);
      assert.ok(h.state.ocCalls.some(call => call.path.endsWith('/abort')));
      assert.ok(h.state.ocCalls.some(call => call.path === '/session/session-test' && call.init.method === 'DELETE'));
      const replay = await fetch(`${h.base}/internal/bridge/${h.state.token}`);
      assert.equal(replay.status, 404);
      await replay.arrayBuffer();
      assertUpstream(h, original);
    });
  }
});

test('a tool-less request gets one realistic tool, and no caller options leak', async t => {
  const h = await harness(t, (_req, res) => sendFragmentedSSE(res,
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"plain"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  const original = { model: 'zen/text', messages: [{ role: 'user', content: 'hello' }] };
  const response = await complete(h, original);
  assert.equal((await response.json()).choices[0].message.content, 'plain');
  await assertFinished(h);
  const upstream = h.state.upstream[0].body;
  assert.deepEqual(upstream.messages, original.messages);
  assert.equal(upstream.model, 'upstream/resolved-model');
  assert.equal(upstream.stream, true);
  assert.deepEqual(upstream.stream_options, { include_usage: true });
  // The gate refuses a request with no tools at all, so one realistic tool goes upstream; the
  // caller asked for none, so tool_choice forbids calls and any call is stripped below.
  assert.equal(upstream.tools.length, 1);
  assert.equal(upstream.tools[0].function.name, 'read');
  assert.deepEqual(upstream.tools[0].function.parameters.required, ['file_path']);
  assert.equal(upstream.tool_choice, 'none');
  for (const key of ['max_tokens', 'max_completion_tokens', 'reasoning_effort', 'temperature', 'parallel_tool_calls']) {
    assert.equal(Object.hasOwn(upstream, key), false, `SDK default ${key} leaked into text-only request`);
  }
  assert.equal(h.state.upstream[0].headers[MARKER], undefined);
});

test('a tool call produced for a tool-less caller is stripped from JSON and SSE replies', async t => {
  const call = 'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"file_path\\":\\"/etc/hostname\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
  for (const stream of [false, true]) {
    await t.test(stream ? 'streaming caller' : 'JSON caller', async subtest => {
      const h = await harness(subtest, (_req, res) => sendFragmentedSSE(res, call));
      const response = await complete(h, { model: 'zen/text', stream, messages: [{ role: 'user', content: 'hi' }] });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.doesNotMatch(text, /tool_calls|call_1|hostname/, 'the synthetic tool call must not reach the caller');
      if (stream) {
        assert.match(text, /^data: /);
        assert.match(text, /data: \[DONE\]/);
      } else {
        const body = JSON.parse(text);
        assert.equal(body.choices[0].message.tool_calls, undefined);
        assert.equal(body.choices[0].finish_reason, 'stop');
      }
      await assertFinished(h);
      assert.equal(h.state.upstream[0].body.tools.length, 1, 'the gate shape was sent');
    });
  }
});

test('upstream 502 status and error body are preserved instead of converted to dummy success', async t => {
  const bytes = Buffer.from(' {"error":{"message":"upstream unavailable","code":"provider_down"}}\n');
  const h = await harness(t, (_req, res) => {
    res.writeHead(502, { 'content-type': 'application/json' }).end(bytes);
  });
  const original = payload(false);
  const response = await complete(h, original);
  assert.equal(response.status, 502);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await assertFinished(h);
  assertUpstream(h, original);
});

test('idle upstream times out before headers with 502 and after headers by terminating the stream', async t => {
  const old = process.env.STALL_TIMEOUT_MS;
  process.env.STALL_TIMEOUT_MS = '30';
  try {
    for (const afterHeaders of [false, true]) {
      await t.test(afterHeaders ? 'idle body terminates stream' : 'idle headers return 502', async subtest => {
        const upstreamClosed = deferred();
        const h = await harness(subtest, (_req, res) => {
          res.once('close', () => upstreamClosed.resolve());
          if (afterHeaders) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: {"choices":[{"index":0,"delta":{"content":"started"},"finish_reason":null}]}\n\n');
          }
          // Never finish: the plugin idle timer, not this fixture, must close the socket.
        });
        const response = await complete(h, payload());
        if (afterHeaders) {
          assert.equal(response.status, 200);
          const reader = response.body.getReader();
          assert.equal((await reader.read()).done, false);
          await assert.rejects(bounded(reader.read(), 'idle stream rejection'), /terminated|aborted|socket/i);
        } else {
          assert.equal(response.status, 502);
          const body = await response.json();
          assert.match(JSON.stringify(body.error), /stalled/i);
          assert.equal(Object.hasOwn(body, 'choices'), false);
        }
        await bounded(upstreamClosed.promise, 'idle upstream socket closed');
        await bounded(h.state.finished.promise, 'idle bridge cleanup');
        await bounded(h.state.messageFinished.promise, 'idle SDK fetch cancelled');
        assert.equal(h.state.ocReplies.length, 0);
        assert.equal(h.state.ocErrors.length, 1);
        assert.equal(h.state.signal.aborted, true);
        assert.ok(h.state.ocCalls.some(call => call.path.endsWith('/abort')));
        assert.ok(h.state.ocCalls.some(call => call.path === '/session/session-test' && call.init.method === 'DELETE'));
      });
    }
  } finally {
    if (old === undefined) delete process.env.STALL_TIMEOUT_MS;
    else process.env.STALL_TIMEOUT_MS = old;
  }
});

test('DSH cancellation aborts the real upstream stream and cleans up the OpenCode session', async t => {
  const upstreamClosed = deferred();
  const h = await harness(t, (_req, res) => {
    res.once('close', () => upstreamClosed.resolve());
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"started"},"finish_reason":null}]}\n\n');
    // Deliberately stay open until cancellation; no model endpoint is involved.
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${h.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload()), signal: controller.signal,
  });
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  controller.abort();
  await assert.rejects(reader.read());
  await bounded(upstreamClosed.promise, 'upstream cancellation');
  await bounded(h.state.finished.promise, 'cancelled bridge cleanup');
  await bounded(h.state.messageFinished.promise, 'cancelled SDK fetch');
  assert.equal(h.state.signal.aborted, true);
  assert.equal(h.state.ocReplies.length, 0);
  assert.ok(h.state.ocCalls.some(call => call.path.endsWith('/abort')));
  assert.ok(h.state.ocCalls.some(call => call.path === '/session/session-test' && call.init.method === 'DELETE'));
  const replay = await fetch(`${h.base}/internal/bridge/${h.state.token}`);
  assert.equal(replay.status, 404);
  await replay.arrayBuffer();
});

const validSSE = (content = 'safe') => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

async function validateBytes(bytes, options) {
  const output = [];
  await pipeline(Readable.from([Buffer.from(bytes)]), createSSEValidator(options), new Writable({
    write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); },
  }));
  return Buffer.concat(output);
}

test('shared streaming validator preserves valid bytes including CR-only SSE', async () => {
  for (const delimiter of ['\n', '\r\n', '\r']) {
    const bytes = validSSE('日本語').replaceAll('\n', delimiter);
    assert.equal((await validateBytes(bytes)).toString(), bytes);
  }
});

test('shared validator rejects normal EOF, malformed data, invalid indices and missing DONE', async t => {
  const partial = 'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
  const finished = validSSE().replace('data: [DONE]\n\n', '');
  for (const [name, input, expected] of [
    ['partial EOF', partial, /finish_reason/],
    ['missing DONE', finished, /DONE/],
    ['empty stream', '', /finish_reason/],
    ['malformed JSON', 'data: {broken}\n\n', /JSON|property|Unexpected/i],
    ['index limit', validSSE().replace('"index":0', '"index":1000000'), /choice index/],
    ['negative index', validSSE().replace('"index":0', '"index":-1'), /choice index/],
    ['trailing truncated frame', validSSE() + 'data: {', /SSE frame/],
    ['after DONE', validSSE() + validSSE(), /after \[DONE\]/],
    ['explicit error', 'data: {"error":{"message":"stream failed"}}\n\n', /stream failed/],
  ]) await t.test(name, () => assert.rejects(validateBytes(input), expected));
});

test('frame and total-byte limits apply to streaming and nonstream aggregation', async () => {
  const bytes = validSSE('x'.repeat(500));
  await assert.rejects(validateBytes(bytes, { maxFrameBytes: 200 }), /frame limit/);
  await assert.rejects(validateBytes(bytes, { maxTotalBytes: 200 }), /byte limit/);
  await assert.rejects(collectCompletion(Readable.from([Buffer.from(bytes)]), { maxFrameBytes: 200 }), /frame limit/);
  await assert.rejects(collectCompletion(Readable.from([Buffer.from(bytes)]), { maxTotalBytes: 200 }), /byte limit/);
});

test('collector ignores prototype and unexpected role/metadata keys and validates tool indices', async () => {
  const malicious = 'data: {"__proto__":{"polluted":true},"constructor":{"polluted":true},"choices":[{"index":0,"delta":{"__proto__":{"polluted":true},"constructor":"bad","role":"system","content":"safe"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const result = await collectCompletion(Readable.from([Buffer.from(malicious)]));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.getPrototypeOf(result.choices[0].message), Object.prototype);
  assert.equal(result.choices[0].message.role, 'assistant');
  assert.equal(Object.hasOwn(result, 'constructor'), false);
  assert.equal(Object.hasOwn(result.choices[0].message, 'constructor'), false);
  const invalid = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1000000}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
  await assert.rejects(collectCompletion(Readable.from([Buffer.from(invalid)])), /tool call index/);
});

test('streaming HTTP relay terminates rather than succeeding on normal incomplete EOF', async t => {
  const h = await harness(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
    setImmediate(() => res.end());
  });
  const response = await complete(h, payload());
  assert.equal(response.status, 200);
  await assert.rejects(response.text(), /terminated|socket|aborted/i);
  await bounded(h.state.finished.promise, 'invalid EOF cleanup');
  assert.equal(h.state.bridgeErrors.length, 1);
  assert.ok(h.state.ocCalls.some(call => call.path.endsWith('/abort')));
});

test('upstream 403 is returned unchanged and Retry-After survives callbacks', async t => {
  for (const status of [403, 429, 503]) {
    await t.test(String(status), async subtest => {
      const bytes = '{"error":{"message":"provider policy"}}';
      const h = await harness(subtest, (_req, res) => res.writeHead(status, {
        'content-type': 'application/json', 'retry-after': '30',
      }).end(bytes));
      const original = { model: 'zen/text', messages: [{ role: 'user', content: 'hello' }] };
      const response = await complete(h, original);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('retry-after'), '30');
      assert.equal(await response.text(), bytes);
      await assertFinished(h);
      assert.equal(h.state.upstream[0].body.tools.length, 1, 'the provider refusal is not caused by a missing manifest');
    });
  }
});

test('bridge deadline settles even when mocked OpenCode ignores cancellation', async t => {
  let signal;
  const cleaned = [];
  const bridge = createBridge({ timeoutMs: 20, log() {}, oc: async (pathname, init) => {
    if (pathname === '/session') return { id: 'ignored' };
    if (pathname.endsWith('/message')) { signal = init.signal; return new Promise(() => {}); }
    cleaned.push(pathname); return {};
  } });
  const base = await listen(t, async (_req, res) => {
    try { await bridge.complete(payload(), 'opencode', 'test', res); }
    catch { res.writeHead(502).end('deadline'); }
  });
  const response = await bounded(fetch(base), 'deadline despite ignored signal');
  assert.equal(response.status, 502); await response.text();
  assert.equal(signal.aborted, true);
  assert.deepEqual(cleaned, ['/session/ignored/abort', '/session/ignored']);
});

test('plugin refuses capability newlines and never follows upstream or callback redirects', async t => {
  for (const base of ['ftp://127.0.0.1', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1?query']) {
    await assert.rejects(loadPlugin(base), /loopback/);
  }
  const h = await harness(t, (_req, res) => res.writeHead(307, { location: 'http://127.0.0.1:1/never' }).end());
  const response = await complete(h, payload(false));
  assert.equal(response.status, 502);
  assert.match(await response.text(), /redirect|fetch|failed/i);
  await bounded(h.state.finished.promise, 'redirect cleanup');
  assert.equal(h.state.upstream.length, 1);
  assert.equal(h.state.upstream[0].headers[MARKER], undefined);
});

test('plugin refuses callback redirects without touching a redirect target or upstream', async t => {
  let targetCalls = 0, upstreamCalls = 0;
  const target = await listen(t, (_req, res) => { targetCalls++; res.end(); });
  const callback = await listen(t, (_req, res) => res.writeHead(307, { location: target }).end());
  const hooks = await loadPlugin(callback);
  const config = { provider: { opencode: { options: { fetch: async () => { upstreamCalls++; throw new Error('must not call upstream'); } } } } };
  await hooks.config(config);
  await assert.rejects(config.provider.opencode.options.fetch('http://127.0.0.1:1/v1/chat/completions', {
    method: 'POST', headers: { [MARKER]: TOKEN }, body: JSON.stringify({ model: 'fixture' }),
  }), /fetch|redirect|failed/i);
  assert.equal(targetCalls, 0);
  assert.equal(upstreamCalls, 0);
});

test('nonstream aggregation retains logprobs and structured reasoning across all chunks', async () => {
  const tokenA = { token: '日', logprob: -0.1 }, tokenB = { token: '本', logprob: -0.2 };
  const reasoningA = { type: 'reasoning.text', text: 'one' }, reasoningB = { type: 'reasoning.text', text: 'two' };
  const chunks = [
    { choices: [{ index: 0, delta: { content: '日', reasoning_details: [reasoningA] }, logprobs: { content: [tokenA], refusal: null }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: '本', reasoning_details: [reasoningB] }, logprobs: { content: [tokenB], refusal: null }, finish_reason: 'stop' }] },
  ];
  const response = await collectCompletion(Readable.from([Buffer.from(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n')]));
  assert.deepEqual(response.choices[0].logprobs.content, [tokenA, tokenB]);
  assert.deepEqual(response.choices[0].message.reasoning_details, [reasoningA, reasoningB]);
});
