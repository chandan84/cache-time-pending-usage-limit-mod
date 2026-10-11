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

function stubSession(on: any, scanOut: string, run: any = () => ({ value: { exitCode: 0, stdout: scanOut, stderr: '' } }), settings: any = { promptCacheTtl: '1h' }) {
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  const saved = new Map<string, unknown>()
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => { saved.set(e.key, e.value); return { value: undefined } })
  on('command.register', () => ({ value: undefined }))
  on('session.id', () => ({ value: SID }))
  on('settings.read', () => ({ value: settings }))
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
  const term = await $.ui.mount(BAND('terminal'))
  expect(await term.find({ type: 'Text', text: 'TODAY · ALL SESSIONS' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /^251K$/ })).toBeDefined()        // context used
  expect(await term.find({ type: 'Text', text: /past 240K/ })).toBeDefined()      // over the soft limit
  expect(await term.find({ type: 'Text', text: ' 1H TTL ' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /^started \d\d:\d\d · last hit/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: 'LAST TURN ' })).toBeDefined()
  await term.unmount()
  // Desktop: whole cards as SVG images; the engine validates the tree for that surface.
  const desk = await $.ui.mount(BAND('desktop'))
  const svg = await desk.find({ type: 'Svg' })
  expect(svg).toBeDefined()
  expect(svg.props.source).toMatch(/TODAY · ALL SESSIONS/)
  expect(await desk.find({ key: 'toggle' })).toBeDefined()
  await desk.unmount()
})

test('the breakdown starts closed every session, even if it was open last time', async ($, on) => {
  const saved = stubSession(on, JSON.stringify(fixtureLedger().snapshot({ now: NOW, sessionId: SID })))
  saved.set('ui', { expanded: true, metric: 'tokens' }) // what older versions stored
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/hud' })
  const ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /^SESSIONS · / })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'TODAY · ALL SESSIONS' })).toBeDefined()
})

test('on Desktop the breakdown opens and closes as a pane, and the cards stay', async ($, on) => {
  stubSession(on, JSON.stringify(fixtureLedger().snapshot({ now: NOW, sessionId: SID })))
  const calls: string[] = []
  on('ui.open', ($: any, e: any) => { calls.push('open ' + e.id); return { value: { isPlaced: true } } })
  on('ui.close', ($: any, e: any) => { calls.push('close ' + e.id); return { value: undefined } })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work/hud' })
  const ui = await $.ui.mount(BAND('desktop'))
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'toggle' })
  expect(calls).toEqual(['open usage-hud', 'close usage-hud'])
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
})

test('a band too short for the breakdown opens it in a pane instead', async ($, on) => {
  stubSession(on, JSON.stringify(fixtureLedger().snapshot({ now: NOW, sessionId: SID })))
  const opened: string[] = []
  on('ui.open', ($: any, e: any) => { opened.push(e.id); return { value: { isPlaced: true } } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/hud' })
  const ui = await $.ui.mount({ ...BAND('terminal'), props: { ...BAND('terminal').props, maxRows: 9 } })
  await ui.press({ key: 'toggle' })
  expect(opened).toEqual(['usage-hud'])
  expect(await ui.find({ type: 'Text', text: /^SESSIONS · / })).toBeUndefined()
})

test('the breakdown expands above the boxes and pages through days', async ($, on) => {
  const saved = stubSession(on, JSON.stringify(fixtureLedger().snapshot({ now: NOW, sessionId: SID })))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/hud' })
  const ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /^SESSIONS · / })).toBeUndefined()
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ type: 'Text', text: /^SESSIONS · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Build the HUD/ })).toBeDefined()
  expect(saved.get('ui')).toBeUndefined() // open/closed isn't remembered
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: 'No usage recorded on this day.' })).toBeDefined()
  await ui.press({ key: 'today' })
  await ui.press({ key: 'm-tok' })
  expect(saved.get('ui')).toEqual({ metric: 'tokens' })
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
  expect(await ui.find({ type: 'Text', text: 'THIS TURN ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ● WARM ' })).toBeDefined()
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

// A session whose last request was three hours ago, so its 1h cache is long cold.
function coldSnapshot() {
  const l = new Ledger({ pricer: createPricer(), defaultTtlMs: HOUR })
  l.ingest(JSON.stringify({ type: 'user', sessionId: SID, timestamp: iso(3 * HOUR), cwd: '/work/hud', message: { role: 'user', content: 'hi' } }), '/p/x.jsonl')
  l.ingest(JSON.stringify({ type: 'assistant', sessionId: SID, timestamp: iso(3 * HOUR), requestId: 'c1', message: { id: 'c1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 80_000, cache_creation: { ephemeral_1h_input_tokens: 80_000, ephemeral_5m_input_tokens: 0 } } } }), '/p/x.jsonl')
  return JSON.stringify(l.snapshot({ now: NOW, sessionId: SID }))
}

const PROMPT = { text: 'carry on', wait: false, origin: { kind: 'composer' } } as const

test('after the cache expires, the next prompt asks first; Cancel drops it and keeps the text', async ($, on) => {
  stubSession(on, coldSnapshot())
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, ($: any, e: any) => {
    asked.push(e.questions[0].question)
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: 'Cancel' } } } as any
  })
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/hud' })
  const r: any = await $.prompt.submit(PROMPT as any)
  expect(asked.length).toBe(1)
  expect(asked[0]).toMatch(/cache expired/)
  expect(r.drop).toMatch(/carry on/)
})

test('with the guard off, an expired cache sends the prompt without asking', async ($, on) => {
  stubSession(on, coldSnapshot())
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, () => { asked++; return { result: {} } as any })
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  on('command.run', () => ({ text: '' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/hud' })
  const ui = await $.ui.mount(BAND('terminal'))
  await ui.press({ key: 'guard' })
  const r: any = await $.prompt.submit(PROMPT as any)
  expect(asked).toBe(0)
  expect(r.text).toBe('carry on')
})

test('a warm cache never asks', async ($, on) => {
  stubSession(on, JSON.stringify(fixtureLedger().snapshot({ now: NOW, sessionId: SID })))
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, () => { asked++; return { result: {} } as any })
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/hud' })
  await $.prompt.submit(PROMPT as any)
  expect(asked).toBe(0)
})

test('Continue sends the prompt on; "Continue and turn guard off" also switches the guard off', async ($, on) => {
  stubSession(on, coldSnapshot())
  let answer = 'Continue'
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, ($: any, e: any) => { asked++; return { result: { questions: e.questions, answers: { [e.questions[0].question]: answer } } } as any })
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/hud' })
  expect(((await $.prompt.submit(PROMPT as any)) as any).text).toBe('carry on')
  answer = 'Continue and turn guard off'
  expect(((await $.prompt.submit(PROMPT as any)) as any).text).toBe('carry on')
  expect(asked).toBe(2)
  await $.prompt.submit(PROMPT as any)
  expect(asked).toBe(2) // guard is off now
})

test('the TTL the API reports on a cache write beats the settings and an unmatched scan', async ($, on) => {
  // The scan knows no session and the settings say 5m: only the live step says 1h.
  stubSession(on, JSON.stringify(fixtureLedger().snapshot({ now: NOW, sessionId: 'someone-else' })), undefined, { promptCacheTtl: '5m' })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($: any, e: any) {
    return {
      turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 }, model: 'claude-opus-5-5' },
    }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/hud' })
  await $.turn.start({ turnId: 't1' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  const out = await $.command.run({ command: 'usage-hud', args: 'report' })
  expect(out.text).toMatch(/TTL: 1h \(reported by the API/)
  expect(out.text).toMatch(/Cache \(1h\)/)
})

test('/usage-hud guard test asks the question now and changes nothing', async ($, on) => {
  stubSession(on, coldSnapshot())
  on('tool.call', { tool: 'AskUserQuestion' }, ($: any, e: any) => ({ result: { questions: e.questions, answers: { [e.questions[0].question]: 'Cancel' } } } as any))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/hud' })
  const out = await $.command.run({ command: 'usage-hud', args: 'guard test' })
  expect(out.text).toMatch(/Guard test: you chose "Cancel"/)
})
