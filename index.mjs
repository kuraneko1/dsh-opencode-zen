import Schema from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmError, assertUsableApiKey, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { createProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export const name = 'opencode-zen';
export const inject = ['llm', 'credentials'];
export const Config = Schema.object({
  proxyURL: Schema.string().default('http://127.0.0.1:8099/v1')
    .description('Loopback OpenCode Zen proxy endpoint; start the proxy separately.'),
  apiKeyEnv: Schema.string().default('FREEMODELS_API_KEY')
    .description('Credential reference resolved through the host; never put a secret here.'),
});

const DISPLAY_NAME = 'OpenCode Zen (free)';
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const TTL_MS = 60_000;
// A relay restart must not blank the model list for the life of a session. Only a refused or
// unreachable socket is retried: a timeout, an HTTP status or a bad body is a real answer, and the
// next listModels call retries again anyway.
const CATALOG_RETRY_WAITS = [0, 500, 1500];
// Measured shapes: a stopped relay gives TypeError('fetch failed') with cause.code ECONNREFUSED, a
// relay that drops the socket gives cause.code UND_ERR_SOCKET, and a timeout arrives as a
// TimeoutError DOMException - which is a real answer and must not be retried.
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT']);
const NOT_RETRYABLE_NAMES = new Set(['TimeoutError', 'AbortError']);
export function retryableConnectionError(error) {
  const walk = (node, depth) => {
    if (!node || depth > 4) return false;
    if (NOT_RETRYABLE_NAMES.has(node.name)) return false;
    if (RETRYABLE_CODES.has(String(node.code ?? ''))) return true;
    if (Array.isArray(node.errors) && node.errors.some(inner => walk(inner, depth + 1))) return true;
    return walk(node.cause, depth + 1);
  };
  return walk(error, 0);
}
async function fetchCatalog(url, headers, signal) {
  let last;
  for (const wait of CATALOG_RETRY_WAITS) {
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    signal.throwIfAborted();
    try {
      return await fetch(url, { redirect: 'error', headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
    } catch (error) {
      if (error instanceof LlmError || !retryableConnectionError(error)) throw error;
      last = error;
    }
  }
  throw last ?? new LlmError('opencode-zen: proxy catalog request failed', 'CATALOG_UNAVAILABLE');
}
const TIMEOUT_MS = 5_000;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('opencode-zen: invalid proxyURL'); }
  if (!['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash
    || !/^\/v1\/?$/.test(url.pathname)) {
    throw new Error('opencode-zen: proxyURL must be a loopback HTTP(S) /v1 endpoint without credentials, query, or fragment');
  }
  return url.href.replace(/\/$/, '');
}

function catalogModels(data, baseURL) {
  if (!Array.isArray(data) || data.length > 10_000) throw new Error('Invalid catalog');
  const seen = new Set();
  const models = [];
  for (const model of data) {
    // The proxy discovers zero-cost Zen models; other routes and non-agent models never enter DSH.
    if (model?.route !== 'zen' || model.chat !== true || model.tools !== true) continue;
    if (typeof model.id !== 'string' || !model.id.startsWith('zen/') || model.id.length <= 4
      || model.id.length > 512 || /[\x00-\x20\x7f]/.test(model.id) || seen.has(model.id)
      || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0
      || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0 || model.maxTokens > model.contextWindow
      || !Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.length > 100
      || model.reasoningEfforts.some((level) => typeof level !== 'string' || !level.length || level.length > 100
        || /[\x00-\x1f\x7f]/.test(level))) throw new Error('Invalid Zen model metadata');
    seen.add(model.id);
    // Unknown upstream variants are not selectable until the host vocabulary supports them.
    const efforts = new Map(model.reasoningEfforts.map((wire) => [wire === 'none' ? 'off' : wire, wire]));
    const reasoning = LEVELS.some((level) => level !== 'off' && efforts.has(level));
    models.push({
      id: model.id, name: model.id, provider: name, api: 'openai-completions', baseUrl: baseURL,
      input: ['text'], contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning,
      ...(reasoning ? { thinkingLevelMap: Object.fromEntries(LEVELS.map((level) => [level, efforts.get(level) ?? null])) } : {}),
      compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: reasoning,
        supportsUsageInStreaming: true, maxTokensField: 'max_tokens', thinkingFormat: 'openai' },
    });
  }
  return models.sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

async function readCatalog(response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Catalog unavailable');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_CATALOG_BYTES) throw new Error('Catalog too large');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return body?.data;
}

/** Standard Cordis plugin: no profile writes, child processes, or second llm-pi-ai instance. */
export function apply(ctx, rawConfig) {
  const config = Config(rawConfig ?? {});
  const baseURL = endpoint(config.proxyURL);
  const ref = credentialRef(config.apiKeyEnv);
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort());
  const resolveApiKey = async () => {
    const hit = await ctx.credentials.resolve(ref);
    if (!hit?.value) throw new LlmError(`opencode-zen: credential reference ${ref} is not configured`, 'MISSING_CREDENTIAL');
    return assertUsableApiKey(hit.value, name, ref);
  };
  const auth = {
    // This local API-key-only route has no OAuth state or ambient credential fallback.
    credentials: new InMemoryCredentialStore(),
    authContext: { env: async () => undefined, fileExists: async () => false },
  };
  const profilesFor = (models) => new Map([[name, {
    provider: name, displayName: DISPLAY_NAME, apiKeyEnv: ref,
    api: 'openai-completions', baseURL, timeoutMs: 300_000, streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024, requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024, retryPolicy: resolveRetryPolicy(undefined, name),
    modelErrors: new Map(), configuredMaxTokens: new Map(),
    piProvider: createProvider({ id: name, name: DISPLAY_NAME, baseUrl: baseURL, models,
      auth: { apiKey: { name: DISPLAY_NAME, resolve: async ({ credential }) => ({
        auth: credential?.key ? { apiKey: credential.key } : {}, source: DISPLAY_NAME,
      }) } }, api: openAICompletionsApi() }),
  }]]);
  let profiles = profilesFor([]);
  let expires = 0;
  let refreshing;
  const refresh = () => {
    lifetime.signal.throwIfAborted();
    if (refreshing) return refreshing;
    if (Date.now() < expires) return Promise.resolve();
    refreshing = (async () => {
      try {
        const key = await resolveApiKey();
        const response = await fetchCatalog(`${baseURL}/models`,
          { authorization: `Bearer ${key}`, accept: 'application/json' }, lifetime.signal);
        profiles = profilesFor(catalogModels(await readCatalog(response), baseURL));
        expires = Date.now() + TTL_MS;
      } catch (error) {
        profiles = profilesFor([]);
        expires = 0;
        if (error instanceof LlmError && ['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL'].includes(error.code)) throw error;
        throw new LlmError('opencode-zen: authenticated proxy catalog unavailable or invalid; no stale models will be used', 'CATALOG_UNAVAILABLE');
      }
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
  class ZenAdapter extends PiAiAdapter {
    async listModels(provider) {
      await refresh();
      return super.listModels(provider);
    }
    async resolveModel(provider, model, signal) {
      signal?.throwIfAborted();
      await refresh();
      signal?.throwIfAborted();
      return super.resolveModel(provider, model, signal);
    }
    async prepareCall(provider, model, signal) {
      signal?.throwIfAborted();
      await refresh();
      signal?.throwIfAborted();
      // The public adapter rejects unknown IDs and freezes this catalog for the prepared step.
      return super.prepareCall(provider, model, signal);
    }
    async *stream(options) {
      options.signal?.throwIfAborted();
      await refresh();
      options.signal?.throwIfAborted();
      yield* super.stream(options);
    }
  }
  ctx.llm.registerAdapter([name], new ZenAdapter({ profiles: () => profiles, resolveApiKey, auth }));
}
