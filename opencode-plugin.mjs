const MARKER = 'x-dsh-bridge-token';

export default async function DshBridgePlugin() {
  const base = process.env.FREEMODELS_BRIDGE_URL;
  if (!base) return {};
  const parsedBase = new URL(base);
  if (!['http:', 'https:'].includes(parsedBase.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(parsedBase.hostname)
    || parsedBase.username || parsedBase.password || parsedBase.pathname !== '/' || parsedBase.search || parsedBase.hash) {
    throw new Error('FREEMODELS_BRIDGE_URL must be a loopback HTTP origin');
  }
  const localFetch = globalThis.fetch.bind(globalThis);

  return {
    async config(config) {
      config.agent ??= {};
      config.agent['dsh-bridge'] = {
        mode: 'primary', hidden: true,
        prompt: 'Relay the registered request. Do not use tools.',
      };
      config.provider ??= {};
      const provider = config.provider.opencode ??= {};
      const options = provider.options ??= {};
      const upstreamFetch = options.fetch || localFetch;
      options.fetch = async (input, init = {}) => {
        const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
        const token = headers.get(MARKER);
        if (!token) return upstreamFetch(input, { ...init, redirect: 'error' });
        headers.delete(MARKER);
        if (token.length !== 64 || !/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid bridge capability');
        const callback = `${parsedBase.origin}/internal/bridge/${token}`;
        let posting = false;
        const idle = new AbortController();
        const signal = AbortSignal.any([
          ...(init.signal ? [init.signal] : []), idle.signal,
          AbortSignal.timeout(Number(process.env.REQUEST_TIMEOUT_MS || 300000)),
        ]);
        let timer;
        const touch = () => {
          clearTimeout(timer);
          timer = setTimeout(() => idle.abort(new Error('upstream stream stalled')),
            Number(process.env.STALL_TIMEOUT_MS || 90000));
        };
        let upstream;
        try {
          touch();
          const registered = await localFetch(callback, { signal, redirect: 'error' });
          if (!registered.ok) throw new Error(`bridge request unavailable (${registered.status})`);
          const upstreamURL = new URL(input instanceof Request ? input.url : String(input));
          if (!['http:', 'https:'].includes(upstreamURL.protocol) || !upstreamURL.pathname.endsWith('/chat/completions')) {
            throw new Error('bridge supports OpenAI chat/completions models only');
          }
          const payload = await registered.json();
          const sdkBody = JSON.parse(init.body);
          const outgoing = { ...payload, model: sdkBody.model, stream: true };
          if (payload.stream !== true) outgoing.stream_options = { include_usage: true };
          // Send exactly the tools the relay registered. When the caller sent none, the relay
          // attaches one realistic tool so the request has agent shape and strips any resulting call.
          touch();
          upstream = await upstreamFetch(input, {
            ...init, signal, headers, body: JSON.stringify(outgoing), redirect: 'error',
          });
          const body = upstream.body?.pipeThrough(new TransformStream({
            transform(chunk, controller) { touch(); controller.enqueue(chunk); },
          }));
          posting = true;
          const posted = await localFetch(callback, {
            method: 'POST', signal, redirect: 'error', duplex: 'half', body,
            headers: {
              'content-type': upstream.headers.get('content-type') || 'application/json',
              'x-upstream-status': String(upstream.status),
              ...(upstream.headers.has('retry-after') ? { 'x-upstream-retry-after': upstream.headers.get('retry-after') } : {}),
            },
          });
          if (!posted.ok) throw new Error(`bridge response rejected (${posted.status})`);
          // OpenCode never sees or executes the client's real tool calls.
          const frame = {
            id: 'chatcmpl-dsh-relay', object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model: sdkBody.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: 'Relayed.' }, finish_reason: 'stop' }],
          };
          return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          });
        } catch (err) {
          // An idle abort must not prevent reporting a pre-header failure. This
          // short independent callback is still bounded and never redirects.
          if (!posting && !init.signal?.aborted) {
            await localFetch(callback, {
              method: 'POST', signal: AbortSignal.timeout(1000), redirect: 'error',
              headers: { 'content-type': 'application/json', 'x-upstream-status': '502' },
              body: JSON.stringify({ error: { type: 'bridge_error', message: String(err.message || err) } }),
            }).catch(() => {});
          }
          throw err;
        } finally {
          idle.abort();
          if (upstream?.body && !upstream.body.locked) void upstream.body.cancel().catch(() => {});
          clearTimeout(timer);
        }
      };
    },
    async 'chat.headers'(input, output) {
      if (input.agent !== 'dsh-bridge' || input.model?.providerID !== 'opencode') return;
      const system = input.message.system;
      if (typeof system !== 'string' || system.length !== 'dsh-bridge:'.length + 64) return;
      const match = /^dsh-bridge:([a-f0-9]{64})$/.exec(system);
      if (match) output.headers[MARKER] = match[1];
    },
  };
}
