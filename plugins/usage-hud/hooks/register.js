// usage-hud: a three-box band above the prompt.
//   1. Tokens and API-equivalent cost today across every local session, with a daily and
//      per-session breakdown that expands above the band (or opens in a pane).
//   2. The context window: used vs. left, green up to a soft limit (240K by default), gray past it.
//   3. Prompt-cache warmth: when the warm streak started, time left before the cache expires,
//      and the last turn's tokens and cost.
//
// Live figures for this session come from `turn.step`. Cross-session history comes from the
// transcripts in ~/.claude/projects, read by scripts/scan.mjs through `$.process.run`, since a
// hooks module has no file APIs of its own and `$.fs.read` stops at 4 MiB.

import { createPricer, normalizeUsage, totalTokens, contextTokens } from '../lib/pricing.js'
import { localDay } from '../lib/format.js'
import { band, pane, textSummary } from '../lib/view.js'

const PANE = 'usage-hud'
const HOUR = 3_600_000
const FIVE_MIN = 300_000
const SCAN_EVERY_MS = 30_000

const pricer = createPricer()

let options = { context_soft_limit: 240_000, history_days: 30 }
let sessionId = null
let ttlSetting = null       // TTL the settings ask for: HOUR | FIVE_MIN | null
let ctxWindow = null        // from $.session.usage()
let hist = null             // scanner snapshot (all sessions)
let histError = null
let scanning = false
let bandSeen = false        // set once the engine raises AbovePrompt
let live = null             // this session, from turn.step: { model, contextTokens, lastRequestTs, warmSince }
let turn = null             // { tokens, cost, requests, startTs, running }
const ui = { expanded: false, metric: 'cost', day: null }

// ------------------------------------------------------------------ data

async function runScan($) {
  if (scanning) return
  scanning = true
  try {
    const argv = ['node', `${$.plugin.root}/scripts/scan.mjs`, '--days', String(options.history_days || 30), '--ttl', ttlSetting === HOUR ? '1h' : '5m']
    if (sessionId) argv.push('--session', sessionId)
    const r = await $.process.run(argv, { timeoutMs: 120_000 })
    const data = JSON.parse(r.stdout || '{}')
    if (data.error || r.exitCode !== 0) histError = 'History scan failed: ' + String(data.error || r.stderr).split('\n')[0]
    else { hist = data; histError = null }
  } catch (err) {
    histError = /ENOENT|not found|spawn/i.test(String(err)) ? 'History needs Node.js on PATH' : 'History scan failed: ' + String(err).split('\n')[0]
  } finally {
    scanning = false
    $.ui.invalidate('ui.render')
  }
}

async function loadSessionFacts($) {
  try { sessionId = await $.session.id() } catch { sessionId = null }
  try {
    const envTtl = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
    const settings = await $.settings.read()
    const v = envTtl || (settings && settings.promptCacheTtl)
    ttlSetting = v === '1h' ? HOUR : v === '5m' ? FIVE_MIN : null
  } catch { ttlSetting = null }
  await refreshContext($)
}

async function refreshContext($) {
  try {
    const u = await $.session.usage()
    if (u && u.context) {
      ctxWindow = u.context.window || ctxWindow
      if (typeof u.context.tokens === 'number' && u.context.tokens > 0) {
        live = { ...(live || {}), contextTokens: u.context.tokens }
      }
    }
  } catch { /* not every host keeps a ledger */ }
}

function ttlMs() {
  const s = hist && hist.session && hist.session.id === sessionId ? hist.session : null
  return (s && s.ttlMs) || ttlSetting || FIVE_MIN
}

function recordStep(e, usage) {
  const u = normalizeUsage(usage, ttlMs() === HOUR ? '1h' : '5m')
  const model = usage.model || e.model
  const now = Date.now()
  if (!turn) turn = { tokens: 0, cost: 0, requests: 0, startTs: now, running: true }
  turn.tokens += totalTokens(u)
  turn.cost += pricer.cost(model, u, usage.speed)
  turn.requests += 1
  if (e.agentId) return // subagents count toward the turn, not this conversation's context or cache
  const prev = live && live.lastRequestTs
  const histWarm = hist && hist.session && hist.session.id === sessionId ? hist.session.warmSince : null
  const warmSince = prev && now - prev <= ttlMs() ? (live.warmSince || histWarm || prev) : now
  live = { model, contextTokens: contextTokens(u), lastRequestTs: now, warmSince }
}

function currentDay() {
  return ui.day || (hist && hist.today) || localDay(Date.now())
}

function shiftDay(delta) {
  const series = (hist && hist.series) || []
  if (!series.length) return
  const i = series.findIndex((d) => d.day === currentDay())
  const j = Math.max(0, Math.min(series.length - 1, (i < 0 ? series.length - 1 : i) + delta))
  ui.day = j === series.length - 1 ? null : series[j].day
}

// Everything the view draws, from the live state and the latest scan.
function viewModel(surface) {
  const now = Date.now()
  const hs = hist && hist.session && hist.session.id === sessionId ? hist.session : null
  const soft = Number(options.context_soft_limit) || 240_000

  const model = (live && live.model) || (hs && hs.model) || null
  const used = (live && live.contextTokens) || (hs && hs.contextTokens) || 0
  const window = ctxWindow || (hs && hs.contextWindow) || (model ? pricer.contextWindow(model) : 1_000_000)

  const lastTs = (live && live.lastRequestTs) || (hs && hs.lastRequestTs) || 0
  const warmSince = (live && live.warmSince) || (hs && hs.warmSince) || lastTs

  const lastTurn = turn && turn.requests ? turn : hs && hs.lastTurn && hs.lastTurn.requests ? { ...hs.lastTurn, running: false } : null

  return {
    surface,
    now,
    expanded: ui.expanded,
    metric: ui.metric,
    day: currentDay(),
    currentSessionId: sessionId,
    todayCost: hist ? hist.todayAgg.cost : 0,
    todayTokens: hist ? hist.todayAgg.tokens : 0,
    totalCost: hist ? hist.total.cost : 0,
    series: (hist && hist.series) || [],
    sessionsByDay: (hist && hist.sessionsByDay) || {},
    histError: histError || (!hist ? 'Reading history…' : null),
    ctx: used > 0 ? { used, window, soft } : null,
    ctxWindow: window,
    softLimit: soft,
    ttlMs: ttlMs(),
    cache: lastTs ? { lastTs, warmSince, ttlMs: ttlMs(), active: !!(turn && turn.running) } : null,
    turn: lastTurn,
  }
}

// ------------------------------------------------------------------ hooks

export function register(on, opts) {
  options = { ...options, ...(opts || {}) }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-hud',
      description: 'Usage HUD: toggle the daily/session breakdown, or `pane`, `report`, `refresh`',
      argumentHint: '[pane|report|refresh]',
      immediate: true,
    })
    const saved = await $.store.get('ui')
    if (saved && typeof saved === 'object') {
      ui.expanded = !!saved.expanded
      if (saved.metric === 'tokens' || saved.metric === 'cost') ui.metric = saved.metric
    }
    await loadSessionFacts($)
    await runScan($)
    // Countdown and "time left" need a redraw every second; history refreshes in the background.
    $.clock.every(1000, () => $.ui.invalidate('ui.render'))
    $.clock.every(SCAN_EVERY_MS, () => runScan($))
    // Hosts that don't raise the band (older Desktop builds): show the HUD as a pane instead.
    $.clock.after(4000, async () => {
      if (bandSeen) return
      const surfaces = await $.session.surfaces()
      if (surfaces.some((s) => s !== 'terminal')) await $.ui.open({ id: PANE, title: 'Usage' })
    })
    return next(e)
  })

  // /clear, /resume and /branch start a new conversation without a new session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    live = null
    turn = null
    await loadSessionFacts($)
    await runScan($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turn = { tokens: 0, cost: 0, requests: 0, startTs: Date.now(), running: true }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result && result.usage) {
      recordStep(e, result.usage)
      $.ui.invalidate('ui.render')
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      if (turn) turn.running = false
      await refreshContext($)
      // Let the transcript flush, then pick up this turn in the all-sessions totals.
      $.clock.after(1500, () => runScan($))
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('command.run', { command: 'usage-hud' }, async ($, e) => {
    const arg = String(e.args || '').trim().toLowerCase()
    if (arg === 'pane') {
      await $.ui.open({ id: PANE, title: 'Usage', focus: true, closeOnEscape: true })
      return {}
    }
    if (arg === 'refresh') {
      await runScan($)
      return { text: histError || 'History refreshed.' }
    }
    if (arg === 'report') {
      await runScan($)
      return { text: textSummary(viewModel('text')) }
    }
    ui.expanded = !ui.expanded
    await $.store.set('ui', { expanded: ui.expanded, metric: ui.metric })
    $.ui.invalidate('ui.render')
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    bandSeen = true
    const el = $.ui.resolve(e)
    const h = {
      toggle: async () => {
        ui.expanded = !ui.expanded
        $.ui.invalidate('ui.render')
        await $.store.set('ui', { expanded: ui.expanded, metric: ui.metric })
      },
      metric: async (k) => {
        ui.metric = k
        $.ui.invalidate('ui.render')
        await $.store.set('ui', { expanded: ui.expanded, metric: ui.metric })
      },
      prevDay: () => { shiftDay(-1); $.ui.invalidate('ui.render') },
      nextDay: () => { shiftDay(1); $.ui.invalidate('ui.render') },
      today: () => { ui.day = null; $.ui.invalidate('ui.render') },
    }
    const mine = band(el, viewModel(e.surface), h, e.props.bodyColumns || 120, e.props.maxRows || 40)
    // Keep whatever other mods draw in the band, under ours.
    const theirs = await next(e)
    return theirs ? el.Box({ flexDirection: 'column', children: [mine, theirs] }) : mine
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const el = $.ui.resolve(e)
    const h = {
      toggle: async () => { await $.ui.close({ id: PANE }) },
      metric: (k) => { ui.metric = k; $.ui.invalidate('ui.render') },
      prevDay: () => { shiftDay(-1); $.ui.invalidate('ui.render') },
      nextDay: () => { shiftDay(1); $.ui.invalidate('ui.render') },
      today: () => { ui.day = null; $.ui.invalidate('ui.render') },
    }
    return pane(el, viewModel(e.surface), h, e.props.bodyColumns || 100)
  })
}
