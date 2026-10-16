import { randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PREFIX = '/internal/bridge/';
const DEFAULT_LIMITS = { maxFrameBytes: 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024, maxChoices: 16, maxToolCalls: 128 };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// One parser for buffered JSON and byte-preserving streaming validation.
function sseParser(options = {}, onChunk = () => {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data = [], frameBytes = 0, totalBytes = 0, done = false;
  const choices = new Map();
  const frame = () => {
    const text = data.join('\n');
    data = []; frameBytes = 0;
    if (!text) return;
    if (done) throw new Error('upstream data after [DONE]');
    if (text === '[DONE]') {
      if (!choices.size || [...choices.values()].some(finished => !finished)) throw new Error('upstream stream ended without finish_reason');
      done = true;
      return;
    }
    const chunk = JSON.parse(text);
    if (!object(chunk)) throw new Error('invalid upstream SSE object');
    if (chunk.error) throw new Error(typeof chunk.error.message === 'string' ? chunk.error.message : 'upstream stream error');
    if (chunk.choices !== undefined && !Array.isArray(chunk.choices)) throw new Error('invalid upstream choices');
    const seen = new Set();
    for (const part of chunk.choices || []) {
      if (!object(part) || !Number.isSafeInteger(part.index) || part.index < 0 || part.index >= limits.maxChoices || seen.has(part.index)) throw new Error('invalid choice index');
      seen.add(part.index);
      if (choices.get(part.index)) throw new Error('upstream data after finish_reason');
      if (part.finish_reason != null && (typeof part.finish_reason !== 'string' || !part.finish_reason)) throw new Error('invalid finish_reason');
      if (part.delta !== undefined && !object(part.delta)) throw new Error('invalid upstream delta');
      if (part.delta?.tool_calls !== undefined) {
        if (!Array.isArray(part.delta.tool_calls)) throw new Error('invalid tool calls');
        for (const call of part.delta.tool_calls) {
          if (!object(call) || !Number.isSafeInteger(call.index) || call.index < 0 || call.index >= limits.maxToolCalls) throw new Error('invalid tool call index');
          if (call.function !== undefined && !object(call.function)) throw new Error('invalid tool function');
          for (const value of [call.id, call.type, call.function?.name, call.function?.arguments]) {
            if (value !== undefined && typeof value !== 'string') throw new Error('invalid tool call delta');
          }
        }
      }
      choices.set(part.index, part.finish_reason != null);
    }
    onChunk(chunk);
  };
  const lines = final => {
    while (buffer.length) {
      const end = buffer.search(/[\r\n]/);
      if (end < 0 || (!final && buffer[end] === '\r' && end === buffer.length - 1)) break;
      const line = buffer.slice(0, end);
      const skip = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(end + skip);
      frameBytes += Buffer.byteLength(line) + skip;
      if (frameBytes > limits.maxFrameBytes) throw new Error('upstream SSE frame limit exceeded');
      if (!line) frame();
      else if (line === 'data' || line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (frameBytes + Buffer.byteLength(buffer) > limits.maxFrameBytes) throw new Error('upstream SSE frame limit exceeded');
  };
  return {
    feed(bytes) {
      totalBytes += bytes.byteLength;
      if (totalBytes > limits.maxTotalBytes) throw new Error('upstream response byte limit exceeded');
      buffer += decoder.decode(bytes, { stream: true });
      lines(false);
    },
    finish() {
      buffer += decoder.decode();
      lines(true);
      // Do not silently accept an incomplete last frame at normal HTTP EOF.
      if (buffer || data.length) throw new Error('upstream stream ended inside SSE frame');
      if (!choices.size || [...choices.values()].some(finished => !finished)) throw new Error('upstream stream ended without finish_reason');
      if (!done) throw new Error('upstream stream ended without [DONE]');
    },
  };
}

export function createSSEValidator(options = {}) {
  const parser = sseParser(options);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try { parser.feed(chunk); callback(null, chunk); } catch (err) { callback(err); }
    },
    flush(callback) { try { parser.finish(); callback(); } catch (err) { callback(err); } },
  });
}

export async function collectCompletion(stream, options = {}) {
  const result = { object: 'chat.completion' };
  const choices = new Map(), toolCalls = new Map();
  const metadata = ['id', 'created', 'model', 'system_fingerprint', 'service_tier', 'usage'];
  const textFields = new Set(['content', 'refusal', 'reasoning', 'reasoning_content', 'reasoning_text']);
  const parser = sseParser(options, chunk => {
    for (const key of metadata) if (Object.hasOwn(chunk, key)) result[key] = chunk[key];
    for (const part of chunk.choices || []) {
      let choice = choices.get(part.index);
      if (!choice) { choice = { index: part.index, message: { role: 'assistant', content: null }, finish_reason: null }; choices.set(part.index, choice); }
      if (part.finish_reason != null) choice.finish_reason = part.finish_reason;
      for (const [key, value] of Object.entries(part.delta || {})) {
        if (key === 'tool_calls') {
          if (!toolCalls.has(part.index)) toolCalls.set(part.index, new Map());
          const calls = toolCalls.get(part.index);
          for (const delta of value) {
            if (!calls.has(delta.index)) calls.set(delta.index, { id: '', type: 'function', function: { name: '', arguments: '' } });
            const call = calls.get(delta.index);
            if (delta.id) call.id = delta.id;
            if (delta.type) call.type = delta.type;
            call.function.name += delta.function?.name || '';
            call.function.arguments += delta.function?.arguments || '';
          }
        } else if (textFields.has(key) && typeof value === 'string') {
          choice.message[key] = (choice.message[key] || '') + value;
        } else if (['reasoning_details', 'annotations'].includes(key) && Array.isArray(value)) {
          choice.message[key] = (choice.message[key] || []).concat(value);
        }
      }
      if (object(part.logprobs)) {
        choice.logprobs ??= {};
        for (const key of ['content', 'refusal']) {
          if (Array.isArray(part.logprobs[key])) choice.logprobs[key] = (choice.logprobs[key] || []).concat(part.logprobs[key]);
          else if (part.logprobs[key] === null && !Object.hasOwn(choice.logprobs, key)) choice.logprobs[key] = null;
        }
      }
    }
  });
  for await (const chunk of stream) parser.feed(chunk);
  parser.finish();
  result.choices = [...choices.values()].sort((a, b) => a.index - b.index);
  for (const choice of result.choices) {
    const calls = toolCalls.get(choice.index);
    if (calls) choice.message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  }
  return result;
}

function abortable(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

// Capabilities are single-use and live only for the duration of one request.
export function createBridge({ oc, timeoutMs, log, limits = {} }) {
  const pending = new Map();
  async function handle(req, res, url) {
    if (!url.pathname.startsWith(PREFIX)) return false;
    const entry = pending.get(url.pathname.slice(PREFIX.length));
    if (!entry || entry.signal.aborted) { res.writeHead(404).end(); return true; }
    if (req.method === 'GET' && !entry.claimed) {
      entry.claimed = true;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(entry.payload));
      return true;
    }
    if (req.method !== 'POST' || !entry.claimed || entry.started) { res.writeHead(409).end(); return true; }
    const status = Number(req.headers['x-upstream-status']);
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      res.writeHead(400).end(); entry.reject(new Error('invalid bridge response status')); return true;
    }
    entry.started = true;
    const cancel = () => req.destroy(entry.signal.reason);
    entry.signal.addEventListener('abort', cancel, { once: true });
    try {
      const contentType = req.headers['content-type'] || 'application/json';
      const responseHeaders = { 'content-type': contentType, 'cache-control': 'no-cache' };
      const retry = req.headers['x-upstream-retry-after'];
      if (typeof retry === 'string' && retry.length > 0 && retry.length <= 128 && !/[^\x20-\x7e]/.test(retry)) responseHeaders['retry-after'] = retry;
      const sse = status < 300 && contentType.includes('text/event-stream');
      if (sse && entry.payload.stream !== true) {
        const completion = await collectCompletion(req, limits);
        entry.res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
        entry.res.end(JSON.stringify(completion));
      } else {
        entry.res.writeHead(status, responseHeaders);
        if (sse) await pipeline(req, createSSEValidator(limits), entry.res);
        else await pipeline(req, entry.res);
      }
      res.writeHead(204).end(); entry.resolve();
    } catch (err) {
      entry.reject(err); res.destroy();
    } finally { entry.signal.removeEventListener('abort', cancel); }
    return true;
  }

  async function complete(payload, providerID, modelID, res) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    const cancel = () => { if (!res.writableFinished) controller.abort(new Error('client disconnected')); };
    res.once('close', cancel);
    if (res.destroyed) controller.abort(new Error('client disconnected'));
    let sessionID, token;
    const t0 = Date.now();
    const call = (pathname, init) => abortable(Promise.resolve().then(() => {
      init.signal.throwIfAborted();
      return oc(pathname, init);
    }), init.signal);
    try {
      const session = await call('/session', { method: 'POST', body: JSON.stringify({ title: 'freemodels-proxy' }), signal });
      sessionID = session.id;
      token = randomBytes(32).toString('hex');
      let resolve, reject;
      const done = new Promise((yes, no) => { resolve = yes; reject = no; });
      done.catch(() => {});
      pending.set(token, { payload, res, resolve, reject, signal, claimed: false, started: false });
      const completion = call(`/session/${sessionID}/message`, {
        method: 'POST', signal,
        body: JSON.stringify({
          model: { providerID, modelID }, agent: 'dsh-bridge', system: `dsh-bridge:${token}`,
          parts: [{ type: 'text', text: 'Relay the registered request.' }],
          tools: {},
        }),
      });
      await abortable(Promise.race([
        done,
        completion.then(() => { throw new Error('OpenCode bridge plugin did not relay the request; restart the proxy stack'); }),
      ]), signal);
      await completion;
      log('req bridge %s/%s tools=%d total_ms=%d', providerID, modelID, payload.tools?.length || 0, Date.now() - t0);
    } finally {
      if (token) pending.delete(token);
      controller.abort(); res.removeListener('close', cancel);
      if (sessionID) {
        await call(`/session/${sessionID}/abort`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
        await call(`/session/${sessionID}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }).catch(() => {});
      }
    }
  }
  return { handle, complete };
}
