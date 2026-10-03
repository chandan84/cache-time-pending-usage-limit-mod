import { expect, mock, test } from 'claude-code/testing'
import { Ledger, HOUR } from '../lib/ledger.js'
import { createPricer } from '../lib/pricing.js'

const SID = 'sess-a'
const NOW = Date.now()
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

// Transcript lines as Claude Code writes them: one response split over two lines (deduped),
// a human prompt, a subagent request, and a second session.
function fixtureLedger() {
  const l = new Ledger({ pricer: createPricer(), defaultTtlMs: HOUR })
  const lines = [
    { type: 'custom-title', customTitle: 'Build the HUD', sessionId: SID },
    { type: 'user', sessionId: SID, timestamp: iso(120_000), cwd: '/work/hud', message: { role: 'user', content: 'build it' } },
    { type: 'assistant', sessionId: SID, timestamp: iso(110_000), requestId: 'r1', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 50_000, cache_creation: { ephemeral_1h_input_tokens: 50_000, ephemeral_5m_input_tokens: 0 } } } },
    { type: 'assistant', sessionId: SID, timestamp: iso(110_000), requestId: 'r1', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 50_000, cache_creation: { ephemeral_1h_input_tokens: 50_000, ephemeral_5m_input_tokens: 0 } } } },
    { type: 'assistant', sessionId: SID, isSidechain: true, timestamp: iso(100_000), requestId: 'r2', message: { id: 'm2', model: 'claude-haiku-4-5', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'assistant', sessionId: SID, timestamp: iso(60_000), requestId: 'r3', message: { id: 'm3', model: 'claude-opus-5-5', usage: { input_tokens: 2, output_tokens: 300, cache_read_input_tokens: 250_000, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } } } },
    { type: 'assistant', sessionId: 'sess-b', timestamp: iso(30_000), requestId: 'r4', message: { id: 'm4', model: 'claude-sonnet-5', usage: { input_tokens: 500, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ]
  for (const line of lines) l.ingest(JSON.stringify(line), '/p/x.jsonl')
  return l
}

function stubSession(on: any, scanOut: string, run: any = () => ({ value: { exitCode: 0, stdout: scanOut, stderr: '' } })) {
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  const saved = new Map<string, unknown>()
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => { saved.set(e.key, e.value); return { value: undefined } })
  on('command.register', () => ({ value: undefined }))
  on('session.id', () => ({ value: SID }))
  on('settings.read', () => ({ value: { promptCacheTtl: '1h' } }))
  on('session.usage', () => ({ value: { context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('process.run', run)
  on('session.start', () => ({ cwd: '/work/hud' }))
  // What other mods (none here) would draw in the band beneath ours
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  return saved
}

const BAND = (surface: 'terminal' | 'desktop', bodyColumns = 140) => ({
  plugin: 'usage-hud',
  component: 'AbovePrompt',
  surface,
  viewport: { columns: bodyColumns, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}) as const

test('ledger dedupes split responses and prices cache writes by TTL', async () => {
  const snap = fixtureLedger().snapshot({ now: NOW, sessionId: SID })
  // m1 counted once, with its final output (900), not 5 + 900
  expect(snap.total.requests).toBe(4)
  expect(snap.total.output).toBe(900 + 100 + 300 + 500)
  // Session A: main context is the last main request, the subagent doesn't count toward it
  expect(snap.session.contextTokens).toBe(2 + 250_000 + 1000 + 300)
  expect(snap.session.ttlMs).toBe(HOUR)
  expect(snap.session.title).toBe('Build the HUD')
  // Last turn spans everything since the prompt, subagent included
  expect(snap.session.lastTurn.requests).toBe(3)
  // Per-session split for today, most expensive first
  const today = snap.sessionsByDay[snap.today]
  expect(today.map((r: any) => r.id)).toEqual([SID, 'sess-b'])
  // Opus 5.5: 1h write = 2x input ($8/MTok); 50K -> $0.40 plus output 900 * $20/MTok
  const r1 = 10 * 4e-6 + 50_000 * 8e-6 + 900 * 20e-6
  expect(Math.abs(today[0].cost - (r1 + 1000 * 1e-6 + 100 * 5e-6 + 2 * 4e-6 + 250_000 * 0.2e-6 + 1000 * 8e-6 + 300 * 20e-6)) < 1e-9).toBe(true)
})

test('the band draws all three boxes on both surfaces', async ($, on) => {
  stubSession(on, JSON.stringify(fixtureLedger().snapshot({ now: NOW, sessionId: SID })))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/hud' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(BAND(surface))
    expect(await ui.find({ type: 'Text', text: 'Today · all sessions' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^251K$/ })).toBeDefined()        // context used
    expect(await ui.find({ type: 'Text', text: /past 240K/ })).toBeDefined()      // over the soft limit
    expect(await ui.find({ type: 'Text', text: /^Cache 1h $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^start \d\d:\d\d · last/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Last turn ' })).toBeDefined()
    await ui.unmount()
  }
})

test('the breakdown expands above the boxes and pages through days', async ($, on) => {
  const saved = stubSession(on, JSON.stringify(fixtureLedger().snapshot({ now: NOW, sessionId: SID })))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/hud' })
  const ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /^Sessions on/ })).toBeUndefined()
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ type: 'Text', text: /^Sessions on/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Build the HUD/ })).toBeDefined()
  expect(saved.get('ui')).toEqual({ expanded: true, metric: 'cost' })
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: 'No usage recorded on this day.' })).toBeDefined()
  await ui.press({ key: 'today' })
  await ui.press({ key: 'm-tok' })
  expect(saved.get('ui')).toEqual({ expanded: true, metric: 'tokens' })
})

test('turn.step updates context, cache and the running turn live', async ($, on) => {
  stubSession(on, JSON.stringify(fixtureLedger().snapshot({ now: NOW, sessionId: SID })))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($: any, e: any) {
    return {
      turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 1000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 2000, model: 'claude-opus-5-5' },
    }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/hud' })
  await $.turn.start({ turnId: 't1' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()

  const ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /^403K$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'This turn ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '● refreshing' })).toBeDefined()
})

test('/usage-hud report prints a text summary', async ($, on) => {
  stubSession(on, JSON.stringify(fixtureLedger().snapshot({ now: NOW, sessionId: SID })))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/hud' })
  const out = await $.command.run({ command: 'usage-hud', args: 'report' })
  expect(out.text).toMatch(/^Today \(all sessions\): \$/)
  expect(out.text).toMatch(/Context: 251K \/ 1.00M/)
  expect(out.text).toMatch(/Cache \(1h\): warm/)
})

test('a missing node shows a hint instead of failing', async ($, on) => {
  stubSession(on, '', () => ({ deny: 'spawn node ENOENT' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/hud' })
  const ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /History/ })).toBeDefined()
})
