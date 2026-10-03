// First-party Claude API list prices, USD per million tokens. Pure module: no Node APIs,
// so both the hooks module and the Node scanner import it.
//
// Cache writes are priced off the input rate: 5-minute TTL = 1.25x, 1-hour TTL = 2x.
// Cache reads have a per-model rate. On a Claude subscription you are not billed per token;
// these figures are the API-equivalent value of what you used.

export const DEFAULT_PRICING = {
  'claude-fable-5-1':  { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5':    { input: 10, output: 50, cacheRead: 1.0 },
  'claude-mythos-5':   { input: 10, output: 50, cacheRead: 1.0 },
  'claude-opus-5-5':   { input: 4,  output: 20, cacheRead: 0.2 },
  'claude-opus-5':     { input: 5,  output: 25, cacheRead: 0.5 },
  'claude-opus-4-8':   { input: 5,  output: 25, cacheRead: 0.5 },
  'claude-opus-4-7':   { input: 5,  output: 25, cacheRead: 0.5 },
  'claude-opus-4-6':   { input: 5,  output: 25, cacheRead: 0.5 },
  'claude-opus-4-5':   { input: 5,  output: 25, cacheRead: 0.5 },
  'claude-opus-4-1':   { input: 15, output: 75, cacheRead: 1.5 },
  'claude-opus-4':     { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-5-5': { input: 2,  output: 10, cacheRead: 0.2 },
  'claude-sonnet-5':   { input: 2,  output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3,  output: 15, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3,  output: 15, cacheRead: 0.3 },
  'claude-sonnet-4':   { input: 3,  output: 15, cacheRead: 0.3 },
  'claude-haiku-4-5':  { input: 1,  output: 5,  cacheRead: 0.1 },
  'claude-3-5-haiku':  { input: 0.8, output: 4, cacheRead: 0.08 },
}

// Context window sizes in tokens. Current models are 1M except Haiku.
export const DEFAULT_CONTEXT = {
  'claude-haiku-4-5': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-opus-4-1': 200_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-4': 200_000,
  '*': 1_000_000,
}

// Fast mode bills at 2x the standard rate.
const FAST_MODE_MULTIPLIER = 2

// "claude-opus-4-5-20251101", "us.anthropic.claude-sonnet-4-6", "claude-opus-5-5[1m]" -> base id
export function normalizeModel(model) {
  if (!model) return 'unknown'
  let m = String(model).toLowerCase()
  m = m.replace(/\[.*?\]$/, '')
  m = m.replace(/^.*?(claude-)/, '$1')
  m = m.replace(/[@-]\d{8}$/, '').replace(/-v\d+:\d+$/, '')
  return m
}

// Longest-prefix match, so "claude-opus-4-1-x" hits "claude-opus-4-1" rather than "claude-opus-4".
function lookup(table, model) {
  const m = normalizeModel(model)
  if (table[m]) return table[m]
  let best = null
  for (const key of Object.keys(table)) {
    if (key !== '*' && m.startsWith(key) && (!best || key.length > best.length)) best = key
  }
  return best ? table[best] : (table['*'] ?? null)
}

export function createPricer(overrides = {}) {
  const table = { ...DEFAULT_PRICING, ...(overrides.pricing || {}) }
  const ctx = { ...DEFAULT_CONTEXT, ...(overrides.contextWindows || {}) }
  const rates = (model) => lookup(table, model) || table['claude-sonnet-5']

  // u: { input, output, cacheRead, cacheWrite5m, cacheWrite1h }
  function cost(model, u, speed) {
    const r = rates(model)
    const c =
      (u.input * r.input +
        u.cacheWrite5m * r.input * 1.25 +
        u.cacheWrite1h * r.input * 2 +
        u.cacheRead * r.cacheRead +
        u.output * r.output) / 1e6
    return speed === 'fast' ? c * FAST_MODE_MULTIPLIER : c
  }

  return {
    cost,
    rates,
    contextWindow: (model) => lookup(ctx, model) || 1_000_000,
    isKnown: (model) => !!lookup(table, model),
  }
}

// Raw API usage (transcript or turn.step result) -> normalized counts.
// Without a TTL breakdown, unattributed cache writes count as 5-minute writes.
export function normalizeUsage(u, fallbackTtl = '5m') {
  if (!u) return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
  const cc = u.cache_creation || {}
  const total = u.cache_creation_input_tokens || 0
  let w1h = cc.ephemeral_1h_input_tokens || 0
  let w5m = cc.ephemeral_5m_input_tokens || 0
  const rest = total - w1h - w5m
  if (rest > 0) {
    if (fallbackTtl === '1h') w1h += rest
    else w5m += rest
  }
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
  }
}

export const totalTokens = (u) => u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h
export const contextTokens = (u) => u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h + u.output
