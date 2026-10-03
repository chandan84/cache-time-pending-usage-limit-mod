// Engine-free tests: `node --test plugins/usage-hud/tests/node`
import test from 'node:test'
import assert from 'node:assert/strict'
import { Ledger, HOUR, FIVE_MIN } from '../../lib/ledger.js'
import { createPricer, normalizeModel, normalizeUsage } from '../../lib/pricing.js'
import { band, pane, textSummary } from '../../lib/view.js'

const NOW = Date.now()
const iso = (ago) => new Date(NOW - ago).toISOString()
const asst = (sid, ago, id, model, usage, extra = {}) => JSON.stringify({ type: 'assistant', sessionId: sid, timestamp: iso(ago), requestId: 'r' + id, message: { id: 'm' + id, model, usage }, ...extra })

test('model ids normalize across providers and suffixes', () => {
  assert.equal(normalizeModel('claude-opus-4-5-20251101'), 'claude-opus-4-5')
  assert.equal(normalizeModel('us.anthropic.claude-sonnet-4-6'), 'claude-sonnet-4-6')
  assert.equal(normalizeModel('claude-opus-5-5[1m]'), 'claude-opus-5-5')
  const p = createPricer()
  assert.equal(p.rates('claude-opus-4-1-20250805').input, 15)
  assert.equal(p.contextWindow('claude-haiku-4-5'), 200_000)
  assert.equal(p.contextWindow('claude-opus-5-5'), 1_000_000)
})

test('unattributed cache writes follow the fallback TTL', () => {
  assert.deepEqual(normalizeUsage({ cache_creation_input_tokens: 100 }, '1h').cacheWrite1h, 100)
  assert.deepEqual(normalizeUsage({ cache_creation_input_tokens: 100 }).cacheWrite5m, 100)
})

test('cache TTL and warm streak come from the writes the API reported', () => {
  const l = new Ledger({ defaultTtlMs: FIVE_MIN })
  const w1h = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 } }
  const read = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }
  l.ingest(asst('s', 3 * HOUR, 1, 'claude-opus-5-5', w1h))       // old streak
  l.ingest(asst('s', 50 * 60_000, 2, 'claude-opus-5-5', read))   // > 1h gap: new streak starts here
  l.ingest(asst('s', 10 * 60_000, 3, 'claude-opus-5-5', read))   // 40 min later: still warm (1h TTL)
  const s = l.sessionState('s')
  assert.equal(s.ttlMs, HOUR)
  assert.equal(new Date(s.warmSince).toISOString(), iso(50 * 60_000))
})

test('ledger round-trips through JSON (scanner cache)', () => {
  const l = new Ledger()
  l.ingest(asst('s', 1000, 1, 'claude-sonnet-5', { input_tokens: 5, output_tokens: 5 }))
  const back = Ledger.fromJSON(JSON.parse(JSON.stringify(l.toJSON())))
  assert.equal(back.snapshot({ now: NOW }).total.requests, 1)
})

// Stub element constructors that record the tree, and a walker to search it.
const mk = (type) => (props) => ({ type, props })
const EL = { Box: mk('Box'), Text: mk('Text'), Button: mk('Button'), Svg: mk('Svg') }
const texts = (n, out = []) => {
  if (!n || typeof n !== 'object') return out
  if (n.type === 'Text') out.push((n.props.children || []).map((c) => (typeof c === 'string' ? c : texts(c).join(''))).join(''))
  for (const c of (n.props && n.props.children) || []) if (typeof c === 'object') texts(c, out)
  return out
}
const types = (n, out = new Set()) => { if (n && n.type) { out.add(n.type); for (const c of n.props.children || []) types(c, out) } return out }

function model(surface, extra = {}) {
  const l = new Ledger({ defaultTtlMs: HOUR })
  l.ingest(asst('s', 60_000, 1, 'claude-opus-5-5', { input_tokens: 2, output_tokens: 300, cache_read_input_tokens: 250_000, cache_creation_input_tokens: 1000 }))
  const snap = l.snapshot({ now: NOW, sessionId: 's' })
  return {
    surface, now: NOW, expanded: true, metric: 'cost', day: snap.today, currentSessionId: 's',
    todayCost: snap.todayAgg.cost, todayTokens: snap.todayAgg.tokens, totalCost: snap.total.cost,
    series: snap.series, sessionsByDay: snap.sessionsByDay, histError: null,
    ctx: { used: 251_302, window: 1_000_000, soft: 240_000 },
    cache: { lastTs: NOW - 60_000, warmSince: NOW - 600_000, ttlMs: HOUR },
    turn: { tokens: 251_302, cost: 0.06, requests: 1, running: false },
    ...extra,
  }
}
const H = { toggle() {}, metric() {}, prevDay() {}, nextDay() {}, today() {} }

test('terminal band draws text meters with the soft-limit arrow', () => {
  const tree = band(EL, model('terminal'), H, 140)
  const all = texts(tree).join('\n')
  assert.ok(!types(tree).has('Svg'))
  assert.match(all, /▼/)                     // soft-limit marker in the bar
  assert.match(all, /past 240K/)
  assert.match(all, /1H TTL/)
  assert.match(all, /SESSIONS · /)
})

test('desktop draws each card whole as a rounded SVG; the band holds only the cards', () => {
  const tree = band(EL, model('desktop'), H, 140)
  const svgs = []
  const walk = (n) => { if (n && n.type === 'Svg') svgs.push(n); for (const c of (n && n.props && n.props.children) || []) walk(c) }
  walk(tree)
  assert.equal(svgs.length, 3) // the three cards; the breakdown opens in a pane on Desktop
  for (const s of svgs) {
    assert.ok(s.props.alt)
    assert.match(s.props.source, /^<svg/)
    assert.match(s.props.source, /rx="14"/) // rounded card frame
    assert.ok(s.props.source.length < 131072)
  }
  const all = svgs.map((s) => s.props.source).join('')
  assert.match(all, /Over soft limit/) // quiet amber note, no chip
  assert.match(all, /TODAY · ALL SESSIONS/)
  assert.match(all, /PROMPT CACHE/)
  // The controls stay real buttons: the band has the toggle, the pane the breakdown's controls.
  const keys = (tree) => {
    const out = []
    const walkB = (n) => { if (n && n.type === 'Button') out.push(n.props.key); for (const c of (n && n.props && n.props.children) || []) walkB(c) }
    walkB(tree)
    return out
  }
  assert.deepEqual(keys(tree), ['toggle'])
  const paneKeys = keys(pane(EL, model('desktop'), H, 110))
  for (const k of ['m-cost', 'm-tok', 'prev', 'next', 'today', 'close']) assert.ok(paneKeys.includes(k), k)
})

test('narrow terminals stack the boxes; pane and text summary render', () => {
  assert.ok(band(EL, model('terminal', { expanded: false }), H, 80))
  assert.ok(pane(EL, model('terminal'), H, 90))
  assert.match(textSummary(model('text')), /Cache \(1h\): warm/)
})

test('no undefined props reach an element', () => {
  const bad = []
  const walk = (n) => { if (!n || typeof n !== 'object') return; for (const [k, v] of Object.entries(n.props || {})) if (v === undefined) bad.push(n.type + '.' + k); for (const c of n.props.children || []) walk(c) }
  walk(band(EL, model('terminal'), H, 140)); walk(band(EL, model('desktop', { ctx: null, cache: null, turn: null }), H, 140))
  assert.deepEqual(bad, [])
})

test('the expanded band fits maxRows so the boxes stay visible', () => {
  // Rough row count of a tree: Box columns stack children, rows take the tallest child, borders add 2.
  const height = (n) => {
    if (!n || typeof n !== 'object') return 0
    if (n.type !== 'Box') return n.type === 'Svg' ? 4 : 1
    const kids = (n.props.children || []).map(height)
    const inner = n.props.flexDirection === 'row' ? Math.max(0, ...kids) : kids.reduce((a, b) => a + b, 0)
    return inner + (n.props.borderStyle ? 2 : 0)
  }
  for (const cols of [80, 150]) for (const rows of [12, 16, 22, 30]) {
    const tree = band(EL, model('terminal'), H, cols, rows)
    assert.ok(height(tree) <= rows, `cols=${cols} rows=${rows} drew ${height(tree)}`)
  }
  // Too short for the breakdown: the cards alone (the hooks module opens a pane instead).
  assert.doesNotMatch(texts(band(EL, model('terminal'), H, 150, 10)).join('\n'), /SESSIONS · /)
})

test('an expanded band draws before the first history scan lands', () => {
  for (const surface of ['terminal', 'desktop']) {
    const m = model(surface, { series: [], sessionsByDay: {}, histError: 'Reading history…', todayCost: 0, todayTokens: 0, totalCost: 0 })
    const tree = band(EL, m, H, 150, 30)
    const svgText = []
    const walk = (n) => { if (n && n.type === 'Svg') svgText.push(n.props.source); for (const c of (n && n.props && n.props.children) || []) walk(c) }
    walk(tree)
    assert.match(texts(tree).join('\n') + svgText.join(''), /Reading history/)
    assert.ok(pane(EL, m, H, 100))
  }
})

test('the band only needs a timer redraw when the countdown text changes', async () => {
  const { tickKey, countdown } = await import('../../lib/view.js')
  const cache = { lastTs: NOW, warmSince: NOW, ttlMs: HOUR }
  const key = (msLater) => tickKey({ cache, now: NOW + msLater })
  // 50 minutes left: whole minutes, so 30 seconds later nothing changed
  assert.equal(key(10 * 60_000), key(10 * 60_000 + 30_000))
  assert.notEqual(key(10 * 60_000), key(11 * 60_000))
  // last two minutes: seconds
  assert.equal(countdown(90_000), '1:30')
  assert.equal(countdown(50 * 60_000), '50m')
  assert.notEqual(key(HOUR - 90_000), key(HOUR - 89_000))
})

test('no SVG is interactive (framed): frames flicker when the band redraws', () => {
  const svgs = []
  const walk = (n) => { if (n && n.type === 'Svg') svgs.push(n); for (const c of (n && n.props && n.props.children) || []) walk(c) }
  walk(band(EL, model('desktop', { expanded: false }), H, 140)); walk(band(EL, model('desktop', { expanded: true }), H, 140, 40)); walk(pane(EL, model('desktop'), H, 110))
  assert.ok(svgs.length >= 3)
  assert.ok(svgs.every((s) => !s.props.isInteractive))
})
