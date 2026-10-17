import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import * as piAiPlugin from '@deepseek-ai/dsh-llm-pi-ai';
const { PiAiAdapter } = piAiPlugin;
import * as plugin from './index.mjs';

const zen = (id = 'zen/example', extra = {}) => ({
  id, route: 'zen', chat: true, tools: true, contextWindow: 131072, maxTokens: 32768,
  reasoningEfforts: ['none', 'low', 'high', 'future-variant'], ...extra,
});
const collect = async (iterable) => { const result = []; for await (const item of iterable) result.push(item); return result; };

async function host(t, options = {}) {
  const state = { catalog: [zen()], key: 'test-proxy-key', requests: [], completions: [], ...options };
  const server = createServer(async (req, res) => {
    state.requests.push({ url: req.url, authorization: req.headers.authorization });
    if (state.refuseFirst > 0) { state.refuseFirst--; req.socket.destroy(); return; }
    if (req.headers.authorization !== `Bearer ${state.key}`) { res.writeHead(401).end(); return; }
    if (req.url === '/v1/models') {
      if (state.hang) return;
      if (state.redirect) { res.writeHead(302, { location: state.redirect }).end(); return; }
      res.writeHead(state.status ?? 200, { 'content-type': 'application/json' });
      res.end(state.raw ?? JSON.stringify({ object: 'list', data: state.catalog }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      state.completions.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk',
        created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.end(chunk({ role: 'assistant', content: 'ok' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const proxyURL = `http://127.0.0.1:${server.address().port}/v1`;
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  state.references = [];
  ctx.provide('credentials', { resolve: async (ref) => {
    state.references.push(ref);
    return state.credentialMissing ? undefined : { value: state.key, source: 'test' };
  } });
  await ctx.plugin(LlmRuntime);
  let adapter;
  const register = ctx.llm.registerAdapter;
  ctx.llm.registerAdapter = function (routes, candidate) {
    adapter = candidate;
    return Reflect.apply(register, this, [routes, candidate]);
  };
  const fiber = ctx.plugin(plugin, { proxyURL, ...(options.config ?? {}) });
  await fiber;
  return { ctx, fiber, adapter, state, proxyURL };
}

const request = (extra = {}) => ({ provider: plugin.name, model: 'zen/example',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], ...extra });

test('a refused relay connection is retried instead of blanking the model list', async (t) => {
  // A relay restart refuses connections for a moment; that must not cost the session its models.
  const { adapter, state } = await host(t, { refuseFirst: 1 });
  const models = await adapter.listModels(plugin.name);
  assert.equal(models.length, 1);
  assert.equal(state.requests.filter(request => request.url === '/v1/models').length, 2, 'one refusal is retried');
});

test('a timeout or a bad body is not retried, so a real answer stays fast', async (t) => {
  const { adapter, state } = await host(t, { status: 500 });
  await assert.rejects(adapter.listModels(plugin.name), { code: 'CATALOG_UNAVAILABLE' });
  assert.equal(state.requests.filter(request => request.url === '/v1/models').length, 1);
});

test('standard Cordis plugin uses the public PiAiAdapter and owns only opencode-zen', async (t) => {
  const { ctx, fiber, adapter, state } = await host(t);
  assert.ok(adapter instanceof PiAiAdapter);
  assert.deepEqual(ctx.llm.listProviders(), [{ id: 'opencode-zen', name: 'OpenCode Zen (free)' }]);
  assert.deepEqual(ctx.llm.listConfigurableProviders(), []);
  assert.equal(state.requests.length, 0, 'mounting does not require a running proxy');
  assert.deepEqual(plugin.inject, ['llm', 'credentials']);
  assert.deepEqual(plugin.Config({}), { proxyURL: 'http://127.0.0.1:8099/v1', apiKeyEnv: 'FREEMODELS_API_KEY' });
  await fiber.dispose();
  assert.deepEqual(ctx.llm.listProviders(), []);
});

test('real builtin llm-pi-ai plugin and its OpenCode directory coexist without conflicts', async (t) => {
  const { ctx } = await host(t);
  const builtin = ctx.plugin(piAiPlugin, { providers: {} });
  await builtin;
  const directory = ctx.llm.listConfigurableProviders();
  assert.ok(directory.some(({ provider }) => provider === 'opencode'));
  assert.ok(!directory.some(({ provider }) => provider === 'opencode-zen'));
  assert.deepEqual(ctx.llm.listProviders().map(({ id }) => id), ['opencode-zen']);
  await builtin.dispose();
  assert.deepEqual(ctx.llm.listConfigurableProviders(), []);
  assert.deepEqual(ctx.llm.listProviders().map(({ id }) => id), ['opencode-zen']);
});

test('host LlmRuntime accepts exact metadata and prepared calls from the plugin', async (t) => {
  const { ctx, state } = await host(t);
  assert.equal((await ctx.llm.listModels(plugin.name))[0].id, 'zen/example');
  const metadata = await ctx.llm.resolveModelInfo(plugin.name, 'zen/example');
  assert.deepEqual(metadata.context, { contextWindow: 131072 });
  assert.deepEqual(metadata.inputModalities, ['text']);
  const prepared = await ctx.llm.prepareCall({ provider: plugin.name, model: 'zen/example', reasoningEffort: 'low' });
  assert.deepEqual(prepared.context, { contextWindow: 131072 });
  await collect(prepared.stream(request({ reasoningEffort: 'low' })));
  assert.equal(state.completions[0].reasoning_effort, 'low');
  await assert.rejects(ctx.llm.prepareCall({ provider: plugin.name, model: 'zen/not-listed' }), { code: 'UNKNOWN_MODEL' });
});

test('catalog is authenticated and selects only Zen tool-capable Chat models', async (t) => {
  const { adapter, state } = await host(t, { config: { apiKeyEnv: 'OPENCODE_ZEN_PROXY_KEY' }, catalog: [
    zen('zen/z-last'), zen('zen/a-first'), zen('or/paid', { route: 'or' }),
    zen('nv/model', { route: 'nv' }), zen('zen/no-tools', { tools: false }),
    zen('zen/non-chat', { chat: false }), zen('zen/truthy', { tools: 1 }),
  ] });
  const models = await adapter.listModels(plugin.name);
  assert.deepEqual(models.map(({ id }) => id), ['zen/a-first', 'zen/z-last']);
  assert.deepEqual(models[0], { provider: 'opencode-zen', id: 'zen/a-first', name: 'zen/a-first', inputModalities: ['text'] });
  assert.deepEqual(state.references, ['OPENCODE_ZEN_PROXY_KEY']);
  assert.deepEqual(state.requests, [{ url: '/v1/models', authorization: 'Bearer test-proxy-key' }]);
  const resolved = await adapter.resolveModel(plugin.name, 'zen/a-first');
  assert.deepEqual(resolved.context, { contextWindow: 131072 });
  assert.deepEqual(resolved.reasoning.efforts.map(({ id }) => id), ['off', 'low', 'high']);
  assert.equal(resolved.defaultMaxTokens, undefined, 'capacity is not a per-request output cap');
  await assert.rejects(adapter.prepareCall(plugin.name, 'zen/not-listed'), { code: 'UNKNOWN_MODEL' });
  await assert.rejects(adapter.resolveModel('opencode', 'zen/a-first'), { code: 'NO_ADAPTER' });
});

test('empty and unknown-only variants do not invent reasoning support', async (t) => {
  const { adapter } = await host(t, { catalog: [zen('zen/plain', { reasoningEfforts: [] }),
    zen('zen/future', { reasoningEfforts: ['future-variant'] }), zen('zen/none', { reasoningEfforts: ['none'] })] });
  for (const id of ['zen/plain', 'zen/future', 'zen/none']) {
    assert.equal((await adapter.resolveModel(plugin.name, id)).reasoning, undefined);
  }
});

test('rejects malformed eligible model capacities, IDs, duplicate IDs, and variants', async (t) => {
  const { adapter, state } = await host(t);
  for (const extra of [
    { id: 'or/other' }, { id: 'zen/' }, { id: 'zen/bad\nname' }, { contextWindow: 0 },
    { contextWindow: Number.MAX_SAFE_INTEGER + 1 }, { maxTokens: 0 }, { maxTokens: 200000 },
    { reasoningEfforts: 'high' }, { reasoningEfforts: [null] }, { reasoningEfforts: ['bad\n'] },
    { reasoningEfforts: Array(101).fill('low') },
  ]) {
    state.catalog = [zen('zen/example', extra)];
    await assert.rejects(adapter.listModels(plugin.name), { code: 'CATALOG_UNAVAILABLE' });
  }
  state.catalog = [zen(), zen()];
  await assert.rejects(adapter.listModels(plugin.name), { code: 'CATALOG_UNAVAILABLE' });
  state.catalog = {};
  await assert.rejects(adapter.listModels(plugin.name), { code: 'CATALOG_UNAVAILABLE' });
});

test('concurrent operations share a catalog request; TTL refresh removes disappeared models', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { adapter, state } = await host(t);
  await Promise.all([adapter.listModels(plugin.name), adapter.resolveModel(plugin.name, 'zen/example'),
    adapter.prepareCall(plugin.name, 'zen/example')]);
  assert.equal(state.requests.length, 1);
  state.catalog = [zen('zen/replacement')];
  now += 59_999;
  assert.equal((await adapter.listModels(plugin.name))[0].id, 'zen/example');
  now += 1;
  assert.equal((await adapter.listModels(plugin.name))[0].id, 'zen/replacement');
  await assert.rejects(adapter.prepareCall(plugin.name, 'zen/example'), { code: 'UNKNOWN_MODEL' });
  state.catalog = [];
  now += 60_000;
  assert.deepEqual(await adapter.listModels(plugin.name), []);
  await assert.rejects(adapter.prepareCall(plugin.name, 'zen/replacement'), { code: 'UNKNOWN_MODEL' });
});

test('expired catalog failures do not use stale models and recover on the next operation', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { adapter, state } = await host(t);
  await adapter.listModels(plugin.name);
  now += 60_000;
  state.status = 503;
  await assert.rejects(adapter.prepareCall(plugin.name, 'zen/example'), { code: 'CATALOG_UNAVAILABLE' });
  await assert.rejects(collect(adapter.stream(request())), { code: 'CATALOG_UNAVAILABLE' });
  assert.equal(state.completions.length, 0);
  state.status = 200;
  state.catalog = [zen('zen/new')];
  assert.equal((await adapter.listModels(plugin.name))[0].id, 'zen/new');
});

test('missing and unusable credentials fail without disclosing a secret or falling back', async (t) => {
  const { adapter, state } = await host(t, { credentialMissing: true });
  await assert.rejects(adapter.listModels(plugin.name), { code: 'MISSING_CREDENTIAL' });
  assert.equal(state.requests.length, 0);
  state.credentialMissing = false;
  state.key = 'private-secret\nwith-newline';
  await assert.rejects(adapter.listModels(plugin.name), (error) => error.code === 'INVALID_CREDENTIAL'
    && !error.message.includes('private-secret'));
  assert.equal(state.requests.length, 0);
});

test('catalog rejects redirects, malformed JSON, oversized bodies, and bounded-timeout failures', async (t) => {
  const { adapter, state, proxyURL } = await host(t);
  state.redirect = `${proxyURL}/forbidden`;
  await assert.rejects(adapter.listModels(plugin.name), { code: 'CATALOG_UNAVAILABLE' });
  assert.equal(state.requests.length, 1, 'redirect target was not requested with the credential');
  state.redirect = undefined;
  state.raw = '{invalid';
  await assert.rejects(adapter.listModels(plugin.name), { code: 'CATALOG_UNAVAILABLE' });
  state.raw = ' '.repeat(2 * 1024 * 1024 + 1);
  await assert.rejects(adapter.listModels(plugin.name), { code: 'CATALOG_UNAVAILABLE' });
  state.raw = undefined;
  const timeoutCalls = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    timeoutCalls.push(milliseconds);
    return AbortSignal.abort(new DOMException('test timeout', 'TimeoutError'));
  });
  await assert.rejects(adapter.listModels(plugin.name), { code: 'CATALOG_UNAVAILABLE' });
  assert.deepEqual(timeoutCalls, [5000]);
});

test('configuration accepts only loopback /v1 URLs and credential references', () => {
  for (const proxyURL of ['https://example.com/v1', 'file:///v1', 'http://127.0.0.1/v2',
    'http://user:secret@127.0.0.1/v1', 'http://127.0.0.1/v1?secret=x', 'http://127.0.0.1/v1#x']) {
    assert.throws(() => plugin.apply({}, { proxyURL }), /proxyURL/);
  }
  assert.throws(() => plugin.apply({}, { apiKeyEnv: 'plain-secret-not-a-reference' }), /credential/i);
});

test('real public adapter streams only to the mock proxy and resolves rotated credentials per call', async (t) => {
  const { adapter, state } = await host(t);
  await adapter.listModels(plugin.name);
  state.key = 'rotated-proxy-key';
  const chunks = await collect(adapter.stream(request({ reasoningEffort: 'high' })));
  assert.ok(chunks.length > 0);
  assert.equal(state.completions[0].model, 'zen/example');
  assert.equal(state.completions[0].reasoning_effort, 'high');
  assert.equal(state.requests.at(-1).authorization, 'Bearer rotated-proxy-key');
  assert.equal(state.references.length, 2, 'catalog lookup and stream each resolve the credential');
  await assert.rejects(collect(adapter.stream(request({ reasoningEffort: 'medium' }))), { code: 'UNSUPPORTED_REASONING_EFFORT' });
  assert.equal(state.completions.length, 1);
});

test('prepared calls keep their model snapshot while later discovery refreshes', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { adapter, state } = await host(t);
  const prepared = await adapter.prepareCall(plugin.name, 'zen/example');
  state.catalog = [zen('zen/new')];
  now += 60_000;
  await adapter.listModels(plugin.name);
  await assert.rejects(adapter.prepareCall(plugin.name, 'zen/example'), { code: 'UNKNOWN_MODEL' });
  await collect(prepared.stream(request()));
  assert.equal(state.completions[0].model, 'zen/example');
});

test('disposing the plugin aborts an in-flight catalog lookup', { timeout: 2000 }, async (t) => {
  const { adapter, state, fiber } = await host(t, { hang: true });
  const reachedServer = new Promise((resolve) => {
    const original = state.requests.push.bind(state.requests);
    state.requests.push = (...args) => { resolve(); return original(...args); };
  });
  const lookup = adapter.listModels(plugin.name);
  const rejected = assert.rejects(lookup, { code: 'CATALOG_UNAVAILABLE' });
  await reachedServer;
  await fiber.dispose();
  await rejected;
});
