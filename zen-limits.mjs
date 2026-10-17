// Measured Zen catalogue overrides.
//
// OpenCode silently truncates input above whatever its catalogue declares, and the
// published Zen metadata declares only 200k for these models on the client side.
// The relay itself accepts far more, so the dedicated OpenCode is given an explicit
// limit; otherwise a long session is truncated without any error.
//
// Keep the table per model: each entry must be measured, never assumed.
const MEASURED = {
  'deepseek-v4.1-flash-free': { context: 1_000_000, output: 32_000 },
  'glm-5.3-flash-free': { context: 1_000_000, output: 32_000 },
};

const ID = /^[a-z0-9][a-z0-9._:-]{0,200}$/i;

export function zenLimits(env = process.env) {
  const limits = { ...MEASURED };
  if (!env.FREEMODELS_ZEN_LIMITS) return limits;
  let extra;
  try { extra = JSON.parse(env.FREEMODELS_ZEN_LIMITS); }
  catch { throw new Error('FREEMODELS_ZEN_LIMITS must be a JSON object of model limits'); }
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('FREEMODELS_ZEN_LIMITS must be a JSON object');
  for (const [id, value] of Object.entries(extra)) {
    if (!ID.test(id)) throw new Error(`FREEMODELS_ZEN_LIMITS has an invalid model id: ${id.slice(0, 40)}`);
    if (!Number.isSafeInteger(value?.context) || value.context < 1 || value.context > 10_000_000
      || !Number.isSafeInteger(value?.output) || value.output < 1 || value.output > value.context) {
      throw new Error(`FREEMODELS_ZEN_LIMITS has invalid limits for ${id}`);
    }
    limits[id] = { context: value.context, output: value.output };
  }
  return limits;
}

/** The dedicated OpenCode config fragment that stops silent truncation. */
export function opencodeModelOverrides(env = process.env) {
  return Object.fromEntries(Object.entries(zenLimits(env)).map(([id, limit]) => [id, { limit }]));
}
