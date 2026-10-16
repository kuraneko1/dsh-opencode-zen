#!/usr/bin/env node
// Node >=22. OpenCode owns upstream identity; only the caller executes real tools.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { createBridge } from './opencode-bridge.mjs';
import { runtimeDirectory } from './runtime-path.mjs';

// Unlike $, the final assertion does not accept a trailing newline.
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?![\s\S])/;
const ZEN_MODEL = /^zen\/[a-zA-Z0-9][a-zA-Z0-9._-]*(?![\s\S])/;
const FIELDS = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options',
  'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'reasoning',
  'parallel_tool_calls', 'frequency_penalty', 'presence_penalty', 'stop', 'seed', 'n',
  'response_format', 'logprobs', 'top_logprobs', 'user', 'store']);
const fail = (status, message) => Object.assign(new Error(message), { status });
const json = (res, status, payload) => {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(payload));
};

function equal(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function readBody(req, maxBytes) {
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw fail(413, 'request body too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw fail(413, 'request body too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw fail(400, 'invalid JSON body'); }
}

export function validateChat(body) {
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const name = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(x);
  if (!object(body) || typeof body.model !== 'string' || !ZEN_MODEL.test(body.model)) {
    throw fail(400, 'model must be zen/<model-id>; only OpenCode Zen is supported');
  }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 10000) {
    throw fail(400, 'messages must be a nonempty OpenAI chat/completions array');
  }
  for (const key of Object.keys(body)) if (!FIELDS.has(key)) throw fail(400, `unsupported field: ${key.slice(0, 80)}`);
  for (const key of ['stream', 'store']) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw fail(400, `${key} must be boolean`);
  for (const key of ['max_tokens', 'max_completion_tokens', 'n']) {
    if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1)) throw fail(400, `${key} must be a positive integer`);
  }
  if ((body.n || 1) > 4) throw fail(400, 'n must not exceed 4');
  for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) {
    if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key]))) throw fail(400, `${key} must be a finite number`);
  }
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') throw fail(400, 'parallel_tool_calls must be boolean');
  for (const m of body.messages) {
    if (!object(m) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)) throw fail(400, 'invalid message role');
    if (!(typeof m.content === 'string' || (m.role === 'assistant' && m.content == null)
      || (Array.isArray(m.content) && m.content.every(p => object(p) && p.type === 'text' && typeof p.text === 'string')))) {
      throw fail(400, 'only text message content is supported');
    }
    if (m.role === 'tool' && (typeof m.tool_call_id !== 'string' || !m.tool_call_id)) throw fail(400, 'tool message requires tool_call_id');
    if (m.tool_calls !== undefined && (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.some(c =>
      !object(c) || typeof c.id !== 'string' || !c.id || c.type !== 'function' || !object(c.function)
      || !name(c.function.name) || typeof c.function.arguments !== 'string'))) throw fail(400, 'invalid tool_calls');
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 256
    || body.tools.some(t => !object(t) || t.type !== 'function' || !object(t.function)
      || !name(t.function.name) || !object(t.function.parameters)))) throw fail(400, 'invalid function tools');
  const names = (body.tools || []).map(t => t.function.name);
  if (new Set(names).size !== names.length) throw fail(400, 'duplicate tool names');
  if (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(body.tool_choice)
    && !(object(body.tool_choice) && body.tool_choice.type === 'function' && names.includes(body.tool_choice.function?.name))) {
    throw fail(400, 'invalid tool_choice');
  }
  if (!names.length && body.tool_choice !== undefined && body.tool_choice !== 'none' && body.tool_choice !== 'auto') throw fail(400, 'tool_choice requires tools');
}

// Missing optional prices are allowed; every published cache/tier price must be
// known zero. Unrecognized pricing metadata fails closed rather than risking spend.
function zeroPrices(value, depth = 0) {
  if (value === 0) return true;
  if (!value || typeof value !== 'object' || depth > 16) return false;
  const prices = Object.values(value);
  return prices.length > 0 && prices.every(price => zeroPrices(price, depth + 1));
}

export function createProxy({ apiKey, ocURL = 'http://127.0.0.1:4096', ocPassword = '',
  timeoutMs = 300000, maxBytes = 16 * 1024 * 1024, maxConcurrent = 4, log = () => {} }) {
  if (typeof apiKey !== 'string' || apiKey.length < 32 || apiKey.length > 4096 || /\s|[\x00-\x1f\x7f]/.test(apiKey)) throw new Error('FREEMODELS_API_KEY must contain 32..4096 non-whitespace characters');
  const upstreamURL = new URL(ocURL);
  if (upstreamURL.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(upstreamURL.hostname)
    || upstreamURL.username || upstreamURL.password || upstreamURL.pathname !== '/') throw new Error('OpenCode URL must be a numeric HTTP loopback origin');
  for (const value of [timeoutMs, maxBytes, maxConcurrent]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid proxy limit');
  const health = { opencode: false, bridge: false, checkedAt: null };
  let models = new Map();
  let active = 0, refreshing;
  async function oc(endpoint, init = {}) {
    const response = await fetch(new URL(endpoint, upstreamURL), { ...init, redirect: 'error',
      headers: { 'content-type': 'application/json', ...(ocPassword ? { authorization: `Basic ${Buffer.from(`opencode:${ocPassword}`).toString('base64')}` } : {}) },
      signal: init.signal || AbortSignal.timeout(Math.min(timeoutMs, 10000)) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenCode HTTP ${response.status}`); }
    return response.status === 204 ? {} : response.json();
  }
  const bridge = createBridge({ oc, timeoutMs, log });
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const next = new Map();
      try {
        const [providers, config] = await Promise.all([oc('/config/providers'), oc('/config')]);
        health.opencode = true;
        health.bridge = Boolean(config.agent?.['dsh-bridge']);
        for (const p of providers.providers || []) {
          if (p.id !== 'opencode') continue;
          for (const [id, m] of Object.entries(p.models || {})) {
            if (!MODEL_ID.test(id) || !m || (m.id !== undefined && m.id !== id)
              || (m.providerID !== undefined && m.providerID !== 'opencode')
              || m.cost?.input !== 0 || m.cost?.output !== 0 || !zeroPrices(m.cost)) continue;
            const chat = m.api?.npm === '@ai-sdk/openai-compatible';
            next.set(`zen/${id}`, { id, route: 'zen', providerID: 'opencode', chat,
              tools: health.bridge && chat && m.capabilities?.toolcall !== false,
              contextWindow: m.limit?.context, maxTokens: m.limit?.output,
              reasoningEfforts: Object.keys(m.variants || {}) });
          }
        }
      } catch {
        health.opencode = false;
        health.bridge = false;
        log('catalog refresh failed; OpenCode routes disabled');
      }
      models = next;
      health.checkedAt = new Date().toISOString();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function handle(req, res) {
    // Authentication is not CORS: also reject browser-origin requests and DNS rebinding.
    const host = req.headers.host;
    if (!host || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) throw fail(403, 'invalid Host');
    if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) throw fail(403, 'browser requests are not supported');
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw fail(403, 'loopback clients only');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.origin !== 'http://127.0.0.1') throw fail(400, 'absolute request targets are not supported');
    // Internal one-use capabilities are separate from the public API key.
    if (await bridge.handle(req, res, url)) return;
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, upstreams: health, models: models.size, active });
    if (!equal(req.headers.authorization, `Bearer ${apiKey}`)) throw fail(401, 'authentication required');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: [...models].map(([id, m]) => ({ ...m, id, object: 'model', owned_by: `freemodels:${m.route}` })) });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') throw fail(404, 'not found');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'application/json required');
    if (active >= maxConcurrent) throw fail(429, 'proxy concurrency limit reached');
    active++;
    try {
      const body = await readBody(req, maxBytes);
      validateChat(body);
      const model = models.get(body.model);
      if (!model) throw fail(400, 'model is not a published zero-cost OpenCode Zen model');
      for (const key of ['max_tokens', 'max_completion_tokens']) {
        if (model.maxTokens && body[key] > model.maxTokens) throw fail(400, `${key} exceeds model output limit`);
      }
      if ((body.tools?.length || body.messages.some(m => m.tool_calls?.length || m.role === 'tool')) && !model.tools) throw fail(400, 'model does not support tool relay');
      if (!model.chat) throw fail(400, 'only Chat Completions OpenCode models are supported; no legacy agent fallback');
      if (!health.bridge) throw fail(503, 'OpenCode bridge plugin unavailable');
      if (res.destroyed) return;
      await bridge.complete(body, model.providerID, model.id, res);
    } finally { active--; }
  }
  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => handle(req, res)).catch(err => {
      log(`request failed status=${err.status || 502}`);
      json(res, err.status || 502, { error: { type: err.status ? 'invalid_request_error' : 'upstream_error',
        message: err.status ? err.message : 'upstream request failed' } });
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxRequestsPerSocket = 100;
  return { server, refresh };
}

// Symlinked bin shims must still start the server.
function isEntryPoint() {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isEntryPoint()) {
  const runtime = runtimeDirectory();
  const secret = name => {
    const file = path.join(runtime, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('secret must be an owner-only regular file');
    return fs.readFileSync(file, 'utf8').trim();
  };
  if (process.env.HOST && process.env.HOST !== '127.0.0.1') throw new Error('HOST must be 127.0.0.1');
  const apiKey = process.env.FREEMODELS_API_KEY || secret('proxy.key');
  const ocPassword = process.env.OPENCODE_SERVER_PASSWORD || secret('opencode.key');
  if (ocPassword.length < 32) throw new Error('OpenCode server password is required');
  const port = Number(process.env.PORT || 8099);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid PORT');
  const proxy = createProxy({ apiKey, ocPassword, ocURL: process.env.OPENCODE_URL || 'http://127.0.0.1:4096',
    timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 300000), log: (...args) => console.error(`${new Date().toISOString()} ${format(...args)}`) });
  await proxy.refresh();
  proxy.server.listen(port, '127.0.0.1', () => {
    console.error(`freemodels-proxy listening on http://127.0.0.1:${port}`);
  });
  const timer = setInterval(() => proxy.refresh(), 10 * 60 * 1000).unref();
  const shutdown = () => {
    clearInterval(timer);
    proxy.server.close(() => process.exit(0));
    setTimeout(() => { proxy.server.closeAllConnections(); process.exit(0); }, 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
