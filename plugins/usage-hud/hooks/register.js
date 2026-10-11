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
import * as fmt from '../lib/format.js'
import { band, pane, textSummary, tickKey, cacheStatus, countdown, BREAKDOWN_MIN_BAND_ROWS } from '../lib/view.js'

const PANE = 'usage-hud'
const HOUR = 3_600_000
const FIVE_MIN = 300_000
const SCAN_EVERY_MS = 30_000

const pricer = createPricer()

let options = { context_soft_limit: 240_000, history_days: 30, live_seconds: false, cache_guard: true }
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
let lastTick = ''           // tickKey() at the last timer redraw
let lastStatus = null       // the status-line text last set (Desktop's ticking seconds)
let bandRows = 40           // the band's maxRows at its last draw, and its surface
let bandSurface = 'terminal'
let paneOpen = false        // the breakdown pane is showing
let softOverride = null     // `/usage-hud limit`, saved in the store; wins over the plugin setting
let guard = true            // ask before the first prompt after the cache expires; the HUD's switch, saved in the store

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
  const soft = softLimit()

  const model = (live && live.model) || (hs && hs.model) || null
  const used = (live && live.contextTokens) || (hs && hs.contextTokens) || 0
  const window = ctxWindow || (hs && hs.contextWindow) || (model ? pricer.contextWindow(model) : 1_000_000)

  const lastTs = (live && live.lastRequestTs) || (hs && hs.lastRequestTs) || 0
  const warmSince = (live && live.warmSince) || (hs && hs.warmSince) || lastTs

  const lastTurn = turn && turn.requests ? turn : hs && hs.lastTurn && hs.lastTurn.requests ? { ...hs.lastTurn, running: false } : null

  return {
    surface,
    now,
    guard,
    // The terminal redraws per second. Desktop's band redraws once a minute (each redraw flickers
    // its buttons) and the exact seconds go to the status line, unless live_seconds asks for both.
    tickSeconds: surface === 'terminal' || options.live_seconds === true,
    expanded: ui.expanded,
    paneOpen,
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
    cache: lastTs ? { lastTs, warmSince, ttlMs: ttlMs() } : null,
    turn: lastTurn,
  }
}

// A terminal band too short for the breakdown shows it in a pane instead.
function bandTooShort() {
  return bandSurface === 'terminal' && bandRows < BREAKDOWN_MIN_BAND_ROWS
}

// The breakdown is on demand. Desktop always shows it in a pane, since its band is short
// and the cards must stay in view; the terminal expands it above the cards when there's room.
async function toggleBreakdown($) {
  if (paneOpen) {
    await $.ui.close({ id: PANE })
    paneOpen = false
    $.ui.invalidate('ui.render')
    return
  }
  if (!ui.expanded && (bandSurface !== 'terminal' || bandTooShort())) {
    await $.ui.open({ id: PANE, title: 'Usage', focus: true, closeOnEscape: true })
    paneOpen = true
    $.ui.invalidate('ui.render')
    return
  }
  ui.expanded = !ui.expanded
  $.ui.invalidate('ui.render')
}

function softLimit() {
  return softOverride || Number(options.context_soft_limit) || 240_000
}

// "300k", "1.2m", "300000" -> tokens; null when it isn't a positive amount.
function parseTokens(s) {
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(String(s || '').trim().replace(/[,_]/g, ''))
  if (!m) return null
  const n = Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1))
  return n > 0 ? n : null
}

// Only the Cost/Tokens choice outlives a session; the breakdown always starts closed.
async function saveMetric($) {
  await $.store.set('ui', { metric: ui.metric })
}

// ------------------------------------------------------------------ cache guard

// The cache is cold when the last request is older than the TTL. Null when there is nothing
// to lose: no request yet, or an empty context.
function coldCache() {
  const hs = hist && hist.session && hist.session.id === sessionId ? hist.session : null
  const lastTs = (live && live.lastRequestTs) || (hs && hs.lastRequestTs) || 0
  const used = (live && live.contextTokens) || (hs && hs.contextTokens) || 0
  if (!lastTs || !used) return null
  const ago = Date.now() - (lastTs + ttlMs())
  if (ago <= 0) return null
  const model = (live && live.model) || (hs && hs.model) || null
  const rewrite = pricer.cost(model, { input: 0, output: 0, cacheRead: 0, cacheWrite5m: ttlMs() === HOUR ? 0 : used, cacheWrite1h: ttlMs() === HOUR ? used : 0 })
  const warm = pricer.cost(model, { input: 0, output: 0, cacheRead: used, cacheWrite5m: 0, cacheWrite1h: 0 })
  return { ago, used, rewrite, warm }
}

// "Cache 49:12 · ends 19:19 ET" while the cache is warm; cleared when it isn't.
function setStatus($, m) {
  const st = cacheStatus(m.cache, m.now)
  const text = m.cache && st.remaining > 0 ? `Cache ${countdown(st.remaining)} · ends ${fmt.clockZ(m.cache.lastTs + m.cache.ttlMs)}` : undefined
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

async function setGuard($, on) {
  guard = on
  await $.store.set('guard', on)
  $.ui.invalidate('ui.render')
}

// ------------------------------------------------------------------ hooks

export function register(on, opts) {
  options = { ...options, ...(opts || {}) }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-hud',
      description: 'Usage HUD: toggle the daily/session breakdown, or `pane`, `report`, `refresh`, `guard on|off` (ask after the cache expires), `limit 300k` (context soft limit)',
      argumentHint: '[pane|report|refresh|guard [on|off]|limit <tokens>|limit reset]',
      immediate: true,
    })
    const saved = await $.store.get('ui')
    ui.expanded = false
    if (saved && (saved.metric === 'tokens' || saved.metric === 'cost')) ui.metric = saved.metric
    const limit = await $.store.get('softLimit')
    softOverride = typeof limit === 'number' && limit > 0 ? limit : null
    const savedGuard = await $.store.get('guard')
    guard = typeof savedGuard === 'boolean' ? savedGuard : options.cache_guard !== false
    await loadSessionFacts($)
    await runScan($)
    // Check each second and redraw only when what the band shows has changed: every second in
    // a terminal, once a minute on Desktop. Desktop's exact m:ss ticks in the status line, which
    // costs no band redraw.
    $.clock.every(1000, () => {
      const m = viewModel(bandSurface)
      if (bandSurface !== 'terminal') setStatus($, m)
      const key = tickKey(m)
      if (key === lastTick) return
      lastTick = key
      $.ui.invalidate('ui.render')
    })
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

  // The cache guard: the first prompt after the prompt cache expires re-reads the whole context
  // at the uncached rate, so ask before sending it on in the same session.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin && e.origin.kind
    if (!guard || (kind && kind !== 'composer' && kind !== 'bridge') || e.turnId || /^\s*\//.test(e.text)) return next(e)
    const cold = coldCache()
    if (!cold) return next(e)
    const mins = Math.max(1, Math.round(cold.ago / 60_000))
    let answer
    try {
      answer = await $.ui.ask(
        `The prompt cache expired ${mins} min ago. Sending this re-reads ${fmt.tokens(cold.used)} tokens of context at the uncached rate: about ${fmt.usd(cold.rewrite)}, against ${fmt.usd(cold.warm)} while the cache was warm. Continue in this session?`,
        { header: 'Cache guard', options: ['Continue', 'Continue and turn guard off', 'Cancel'] },
      )
    } catch {
      answer = 'Cancel'
    }
    if (answer === 'Continue' || answer === 'Continue and turn guard off') {
      if (answer !== 'Continue') await setGuard($, false)
      return next(e)
    }
    return { drop: `Not sent: the prompt cache expired. Send again to continue.

${fmt.truncate(e.text, 300)}` }
  })

  on('command.run', { command: 'usage-hud' }, async ($, e) => {
    const arg = String(e.args || '').trim().toLowerCase()
    if (arg === 'pane') {
      await $.ui.open({ id: PANE, title: 'Usage', focus: true, closeOnEscape: true })
      paneOpen = true
      return {}
    }
    if (arg === 'limit' || arg.startsWith('limit ')) {
      const v = arg.slice(5).trim()
      if (v === 'reset' || v === 'default') {
        softOverride = null
        await $.store.set('softLimit', null)
      } else if (v) {
        const n = parseTokens(v)
        if (!n) return { text: `Not a token amount: "${v}". Try /usage-hud limit 300k` }
        softOverride = n
        await $.store.set('softLimit', n)
      }
      $.ui.invalidate('ui.render')
      return { text: `Context soft limit: ${softLimit().toLocaleString('en-US')} tokens${softOverride ? '' : ' (plugin setting)'}.` }
    }
    if (arg === 'guard' || arg.startsWith('guard ')) {
      const v = arg.slice(5).trim()
      await setGuard($, v === 'on' ? true : v === 'off' ? false : !guard)
      return { text: guard ? 'Cache guard on: I will ask before the first prompt after the prompt cache expires.' : 'Cache guard off.' }
    }
    if (arg === 'refresh') {
      await runScan($)
      return { text: histError || 'History refreshed.' }
    }
    if (arg === 'report') {
      await runScan($)
      return { text: textSummary(viewModel('text')) }
    }
    await toggleBreakdown($)
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    bandSeen = true
    const el = $.ui.resolve(e)
    const h = {
      toggle: () => toggleBreakdown($),
      metric: async (k) => {
        ui.metric = k
        $.ui.invalidate('ui.render')
        await saveMetric($)
      },
      prevDay: () => { shiftDay(-1); $.ui.invalidate('ui.render') },
      nextDay: () => { shiftDay(1); $.ui.invalidate('ui.render') },
      today: () => { ui.day = null; $.ui.invalidate('ui.render') },
      guard: () => setGuard($, !guard),
    }
    bandRows = e.props.maxRows || 40
    bandSurface = e.surface
    const mine = band(el, viewModel(e.surface), h, e.props.bodyColumns || 120, bandRows)
    // Keep whatever other mods draw in the band, under ours.
    const theirs = await next(e)
    return theirs ? el.Box({ flexDirection: 'column', children: [mine, theirs] }) : mine
  })

  // Esc or the pane's own close: keep the Breakdown button's label in step.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      paneOpen = false
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const el = $.ui.resolve(e)
    const h = {
      toggle: () => toggleBreakdown($),
      metric: async (k) => {
        ui.metric = k
        $.ui.invalidate('ui.render')
        await saveMetric($)
      },
      prevDay: () => { shiftDay(-1); $.ui.invalidate('ui.render') },
      nextDay: () => { shiftDay(1); $.ui.invalidate('ui.render') },
      today: () => { ui.day = null; $.ui.invalidate('ui.render') },
      guard: () => setGuard($, !guard),
    }
    return pane(el, viewModel(e.surface), h, e.props.bodyColumns || 100)
  })
}
