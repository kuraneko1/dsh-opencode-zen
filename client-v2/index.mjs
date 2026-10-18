// OpenCode 2.x side of the bridge.
//
// OpenCode 1.x let a plugin replace `provider.options.fetch`, which is how the relay used to swap
// the outgoing request body. 2.x builds provider requests elsewhere and never consults that hook,
// but it exposes per-call session hooks instead: `http.request` hands the plugin the built Request
// (mutable) and `http.response` hands it the answered Response (also mutable). Both run inside the
// real client, so the upstream call keeps OpenCode's own URL, headers and credentials.
//
// One relay request = one session. The relay puts its single-use capability token in the prompt
// metadata; this plugin remembers it per session, swaps the body of the primary request for the
// payload the relay registered, posts the real upstream response back, and answers OpenCode with a
// canned stream so the session ends without OpenCode ever seeing (or executing) the caller's tools.

import fs from 'node:fs';

const MARKER = 'dshBridge';
const DEBUG = process.env.FREEMODELS_BRIDGE_DEBUG;
const debug = (...parts) => {
  if (!DEBUG) return;
  try { fs.appendFileSync(DEBUG, parts.map(part => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ') + '\n'); } catch { /* Debug only. */ }
};
const TOKEN = /^[a-f0-9]{64}$/;
const CANNED = `data: ${JSON.stringify({
  id: 'chatcmpl-dsh-relay', object: 'chat.completion.chunk', created: 0, model: 'dsh-relay',
  choices: [{ index: 0, delta: { role: 'assistant', content: 'Relayed.' }, finish_reason: 'stop' }],
})}\n\ndata: [DONE]\n\n`;

/** The relay origin must be a bare loopback HTTP origin; anything else is a misconfiguration. */
function bridgeOrigin(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('FREEMODELS_BRIDGE_URL must be a loopback HTTP origin');
  }
  return parsed.origin;
}

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default {
  id: 'dsh-opencode-zen-bridge',
  async setup(ctx) {
    const configured = process.env.FREEMODELS_BRIDGE_URL;
    if (!configured) return;
    const origin = bridgeOrigin(configured);
    const requestMs = positiveMs(process.env.REQUEST_TIMEOUT_MS, 300000);
    const stallMs = positiveMs(process.env.STALL_TIMEOUT_MS, 90000);
    const tokens = new Map(); // sessionID -> single-use capability token

    const internal = (token, init = {}) => fetch(`${origin}/internal/bridge/${token}`, { redirect: 'error', ...init });

    // The client starts before the relay, so the first hello usually arrives with nobody listening:
    // keep announcing until the relay answers, otherwise the catalog stays without bridge support.
    void (async () => {
      const body = JSON.stringify({ plugin: 'dsh-opencode-zen-bridge', opencode: ctx.app?.version ?? null });
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const announced = await fetch(`${origin}/internal/bridge/hello`, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: { 'content-type': 'application/json' }, body,
          });
          if (announced.ok) return;
        } catch { /* Still starting. */ }
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    })().catch(() => {});

    await ctx.session.hook('prompt', (input) => {
      const token = input.metadata?.[MARKER];
      if (typeof token === 'string' && TOKEN.test(token)) tokens.set(input.sessionID, token);
    });

    await ctx.session.hook('http.request', async (input) => {
      // Auxiliary calls (title, compaction) keep OpenCode's own body: only the agent loop is relayed.
      if (input.kind !== 'primary') return;
      if (DEBUG) {
        const original = await input.request.clone().text().catch(() => '');
        debug('incoming', input.sessionID, input.request.url, 'headers=', [...input.request.headers.keys()].join(','), 'authLen=', (input.request.headers.get('authorization') || '').length);
        try { fs.writeFileSync(`${DEBUG}.incoming.json`, original); } catch { /* Debug only. */ }
      }
      const token = tokens.get(input.sessionID);
      if (!token) return;
      const upstream = new AbortController();
      const signal = AbortSignal.any([upstream.signal, AbortSignal.timeout(requestMs)]);
      let payload;
      try {
        const registered = await internal(token, { signal });
        if (!registered.ok) throw new Error(`bridge request unavailable (${registered.status})`);
        payload = await registered.json();
      } catch (error) {
        throw new Error(`dsh bridge did not register this request: ${error.message}`);
      }
      const raw = await input.request.clone().text();
      const body = JSON.parse(raw);
      const outgoing = { ...payload, model: body.model, stream: true };
      if (payload.stream !== true) outgoing.stream_options = { include_usage: true };
      // Content-Length is recomputed: the relay's body is not the one OpenCode measured.
      const headers = new Headers(input.request.headers);
      headers.delete('content-length');
      headers.delete(MARKER.toLowerCase());
      debug('outgoing', input.sessionID, input.request.url, 'model=', outgoing.model, 'len=', JSON.stringify(outgoing).length, JSON.stringify(outgoing).slice(0, 400));
      try {
        input.request = new Request(input.request.url, {
          method: 'POST', headers, body: JSON.stringify(outgoing), redirect: 'error', signal,
        });
      } catch (error) {
        upstream.abort(error);
        throw error;
      }
    });

    await ctx.session.hook('http.response', async (input) => {
      if (input.kind !== 'primary') return;
      const token = tokens.get(input.sessionID);
      if (!token) return;
      tokens.delete(input.sessionID);
      const answered = input.response;
      debug('upstream', input.sessionID, answered.status, answered.headers.get('content-type'));
      if (DEBUG && answered.status >= 300) debug('upstream-body', (await answered.clone().text()).slice(0, 400));
      const idle = new AbortController();
      const signal = AbortSignal.any([idle.signal, AbortSignal.timeout(requestMs)]);
      let timer;
      const touch = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new Error('upstream stream stalled')), stallMs); };
      let posted = false;
      try {
        touch();
        const body = answered.body?.pipeThrough(new TransformStream({
          transform(chunk, controller) { touch(); controller.enqueue(chunk); },
        }));
        const retryAfter = answered.headers.get('retry-after');
        const ready = await internal(token, {
          method: 'POST', signal, duplex: 'half', body,
          headers: {
            'content-type': answered.headers.get('content-type') || 'application/json',
            'x-upstream-status': String(answered.status),
            ...(retryAfter ? { 'x-upstream-retry-after': retryAfter } : {}),
          },
        });
        posted = true;
        if (!ready.ok) throw new Error(`bridge response rejected (${ready.status})`);
        // OpenCode never sees the caller's tool calls; it only needs this turn to end.
        input.response = new Response(CANNED, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      } catch (error) {
        if (!posted) {
          await internal(token, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1000),
            headers: { 'content-type': 'application/json', 'x-upstream-status': '502' },
            body: JSON.stringify({ error: { type: 'bridge_error', message: String(error?.message || error) } }),
          }).catch(() => {});
        }
        throw error;
      } finally {
        clearTimeout(timer);
        idle.abort();
      }
    });
  },
};
