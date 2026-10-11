// Builds the element trees for the band above the prompt and the breakdown pane.
// Pure: it receives the element constructors from `$.ui.resolve(e)`, a view model, and
// callbacks, so it holds no mods API calls of its own (those stay in register.js).
//
// Terminal look: matte "cards" with their own dark surface (so they read the same on light
// and dark themes), solid color-filled meters instead of line art, and gradient charts, drawn
// with background-colored cells and half-cell edges. Desktop is drawn by desktop.js.

import * as fmt from './format.js'
import { P, countdown, cacheStatus, tickKey } from './theme.js'
import { desktopBand, desktopPane } from './desktop.js'

export { P, countdown, cacheStatus, tickKey }

// ------------------------------------------------------------------ small helpers

// Elements refuse props they don't know; an explicit undefined is safest left out.
const clean = (props) => Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined))
const t = (el, text, props = {}) => el.Text(clean({ wrap: 'truncate', ...props, children: [text] }))
const row = (el, children, props = {}) => el.Box(clean({ flexDirection: 'row', ...props, children: children.filter(Boolean) }))
const col = (el, children, props = {}) => el.Box(clean({ flexDirection: 'column', ...props, children: children.filter(Boolean) }))
const spacer = (el) => el.Box({ flexGrow: 1 })

function rgb(c) { return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) }
function lerp(a, b, f) {
  const x = rgb(a), y = rgb(b), k = Math.max(0, Math.min(1, f))
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, '0')).join('')
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Cells [{ ch, fg, bg }] -> one Text with a nested Text per run of identical styling.
function paint(el, cells, key) {
  const runs = []
  for (const c of cells) {
    const last = runs[runs.length - 1]
    if (last && last.fg === c.fg && last.bg === c.bg) last.text += c.ch
    else runs.push({ text: c.ch, fg: c.fg, bg: c.bg })
  }
  return el.Text(clean({ key, wrap: 'truncate', children: runs.map((r) => el.Text(clean({ color: r.fg, backgroundColor: r.bg, children: [r.text] }))) }))
}

// A solid meter `width` cells wide. Each cell is split in two halves, so edges land on half
// cells: equal halves draw a background-colored space, unequal ones a '▌' (left fg, right bg).
// segs: [{ to: value, color }] in ascending `to`; past the last one the track shows.
// mark: { at: value, ch, fg } draws a glyph in the cell holding `at`.
function meterCells(segs, total, width, track, mark) {
  const colorAt = (v) => {
    for (const s of segs) if (v < s.to) return s.color
    return track
  }
  const cells = []
  for (let i = 0; i < width; i++) {
    const l = colorAt(((i + 0.25) / width) * total)
    const r = colorAt(((i + 0.75) / width) * total)
    cells.push(l === r ? { ch: ' ', bg: l } : { ch: '▌', fg: l, bg: r })
  }
  if (mark) {
    const i = Math.max(0, Math.min(width - 1, Math.floor((mark.at / total) * width)))
    cells[i] = { ch: mark.ch, fg: mark.fg, bg: colorAt(((i + 0.5) / width) * total) }
  }
  return cells
}

const EIGHTHS = ' ▁▂▃▄▅▆▇█'

function sparkCells(values, bg) {
  const max = Math.max(...values, 0)
  return values.map((v) => {
    if (max <= 0 || v <= 0) return { ch: '▁', fg: P.track, bg }
    const f = v / max
    return { ch: EIGHTHS[Math.max(1, Math.round(f * 8))], fg: lerp(P.blueDeep, P.blueLight, f), bg }
  })
}

// A short label on a colored background.
const chip = (el, text, fg, bg) => t(el, ` ${text} `, { color: fg, backgroundColor: bg, bold: true })

function card(el, children, { width, bg = P.card, key } = {}) {
  return col(el, children, { key, backgroundColor: bg, paddingX: 2, width, flexShrink: 1 })
}
const label = (el, text) => t(el, text, { color: P.low, bold: true })

// ------------------------------------------------------------------ the three cards

function usageCard(el, m, h, width, inner) {
  const series = m.series || []
  const last14 = series.slice(-14).map((d) => d.cost)
  const visual = paint(el, sparkCells(last14.length ? last14 : [0], P.card), 'spark')
  return card(el, [
    row(el, [label(el, 'TODAY · ALL SESSIONS'), spacer(el), el.Button({ key: 'toggle', label: m.expanded ? '▼ Hide' : '▲ Breakdown', plain: true, onPress: h.toggle })]),
    m.histError && !series.length
      ? t(el, m.histError, { color: P.amber })
      : row(el, [t(el, fmt.usd(m.todayCost), { bold: true, color: P.hi }), t(el, '  ' + fmt.tokens(m.todayTokens) + ' tokens', { color: P.mid })]),
    row(el, [visual, spacer(el), t(el, '14d', { color: P.low })], { columnGap: 1 }),
    row(el, [t(el, 'all time ', { color: P.low }), t(el, fmt.usd(m.totalCost), { color: P.mid, bold: true })]),
  ], { width, key: 'usage' })
}

function contextCard(el, m, width, inner) {
  const c = m.ctx
  if (!c) {
    const win = m.ctxWindow || 1_000_000
    return card(el, [
      label(el, 'CONTEXT WINDOW'),
      t(el, 'Waiting for the first response', { color: P.mid }),
      paint(el, meterCells([], win, inner, P.track, { at: m.softLimit || 240_000, ch: '▼', fg: P.amber }), 'ctxbar'),
      t(el, `${fmt.tokens(win)} window · soft limit ${fmt.tokens(m.softLimit || 240_000)}`, { color: P.low }),
    ], { width, key: 'ctx' })
  }
  const over = c.used > c.soft
  const pct = Math.round((c.used / c.window) * 100)
  const segs = [{ to: Math.min(c.used, c.soft), color: P.teal }]
  if (over) segs.push({ to: c.used, color: P.slate })
  const meter = paint(el, meterCells(segs, c.window, inner, P.track, { at: c.soft, ch: '▼', fg: P.amber }), 'ctxbar')
  return card(el, [
    row(el, [label(el, 'CONTEXT WINDOW'), spacer(el), over ? chip(el, 'PAST SOFT LIMIT', P.hi, P.slate) : chip(el, `${pct}%`, P.card, P.teal)]),
    row(el, [
      t(el, fmt.tokens(c.used), { bold: true, color: over ? P.mid : P.hi }),
      t(el, ` / ${fmt.tokens(c.window)}`, { color: P.mid }),
      spacer(el),
      t(el, `${fmt.tokens(Math.max(0, c.window - c.used))} free`, { color: P.mid }),
    ]),
    meter,
    row(el, [
      t(el, over ? `${fmt.tokens(c.used - c.soft)} past ${fmt.tokens(c.soft)}` : `${fmt.tokens(c.soft - c.used)} to ${fmt.tokens(c.soft)}`, { color: over ? P.amber : P.low }),
      spacer(el),
      t(el, '▼ ', { color: P.amber }), t(el, `${fmt.tokens(c.soft)} soft limit`, { color: P.low }),
    ]),
  ], { width, key: 'ctx' })
}

function cacheCard(el, m, width, inner, h) {
  const c = m.cache
  const s = cacheStatus(c, m.now)
  const ttlMs = c ? c.ttlMs : m.ttlMs
  const ttl = ttlMs ? (ttlMs >= 3_600_000 ? '1H TTL' : '5M TTL') : 'TTL –'
  const turn = m.turn && m.turn.requests ? m.turn : null
  const has = !!(c && c.lastTs)
  const drain = has ? paint(el, meterCells([{ to: s.frac, color: s.color }], 1, Math.max(8, Math.floor(inner * 0.35)), P.track), 'drain') : null
  const head = row(el, [
    label(el, inner >= 44 ? 'PROMPT CACHE' : 'CACHE'), t(el, ' '), chip(el, ttl, P.mid, P.raised), spacer(el),
    h ? el.Button({ key: 'guard', label: m.guard ? 'GUARD ON' : 'GUARD OFF', plain: true, onPress: h.guard }) : null, t(el, ' '),
    chip(el, s.label, P.card, s.color),
  ])
  const timeRow = row(el, [
    t(el, has ? countdown(s.remaining) : '–', { bold: true, color: P.hi }),
    t(el, has ? ' left  ' : '', { color: P.mid }),
    drain,
    spacer(el),
    t(el, has ? `ends ${fmt.clockZ(c.lastTs + c.ttlMs)}` : 'starts with the first response', { color: P.mid }),
  ])
  const startRow = t(el, has ? `started ${fmt.clock(c.warmSince || c.lastTs)} · last hit ${fmt.clock(c.lastTs)}` : ' ', { color: P.low })
  const turnRow = turn
    ? row(el, [
      label(el, turn.running ? 'THIS TURN ' : 'LAST TURN '),
      t(el, fmt.tokens(turn.tokens), { bold: true, color: P.hi }), t(el, ' tok  ', { color: P.mid }),
      t(el, fmt.usd(turn.cost), { bold: true, color: P.hi }),
      spacer(el), t(el, `${turn.requests} req`, { color: P.low }),
    ])
    : row(el, [label(el, 'LAST TURN '), t(el, '–', { color: P.low })])
  return card(el, [head, timeRow, startRow, turnRow], { width, key: 'cache' })
}

// ------------------------------------------------------------------ breakdown

function columnsTerminal(el, m, width, height) {
  const series = m.series
  const vals = series.map((d) => (m.metric === 'cost' ? d.cost : d.tokens))
  const max = Math.max(...vals, 0)
  const unit = Math.floor(width / series.length)
  const barW = unit >= 3 ? 2 : 1
  const gap = unit >= 2 ? 1 : 0
  const lines = []
  for (let r = height - 1; r >= 0; r--) {
    const cells = []
    const f = r / Math.max(1, height - 1)
    series.forEach((d, i) => {
      const sel = d.day === m.day
      const color = sel ? lerp(P.coralDeep, P.coral, f) : lerp(P.blueDeep, P.blueLight, f)
      const e = max > 0 ? Math.round((vals[i] / max) * height * 8) : 0
      const lvl = Math.max(0, Math.min(8, e - r * 8))
      for (let k = 0; k < barW; k++) {
        if (lvl === 8) cells.push({ ch: ' ', bg: color })
        else if (lvl > 0) cells.push({ ch: EIGHTHS[lvl], fg: color, bg: P.card })
        else if (r === 0) cells.push({ ch: '▁', fg: vals[i] > 0 ? color : sel ? P.coral : P.track, bg: P.card })
        else cells.push({ ch: ' ', bg: P.card })
      }
      if (gap) cells.push({ ch: ' ', bg: P.card })
    })
    const yl = r === height - 1 ? (m.metric === 'cost' ? fmt.usd(max) : fmt.tokens(max)) : r === 0 ? (m.metric === 'cost' ? '$0' : '0') : ''
    lines.push(row(el, [paint(el, cells, 'c' + r), t(el, ' ' + yl, { color: P.low })]))
  }
  const span = series.length * (barW + gap)
  const a = fmt.shortDay(series[0].day), z = fmt.shortDay(series[series.length - 1].day)
  lines.push(t(el, a + ' '.repeat(Math.max(1, span - a.length - z.length)) + z, { color: P.low }))
  return col(el, lines)
}

function sessionsTerminal(el, m, rows, width) {
  if (!rows.length) return [t(el, 'No usage recorded on this day.', { color: P.mid })]
  const key = m.metric === 'cost' ? 'cost' : 'tokens'
  const max = Math.max(...rows.map((r) => r[key]), 0) || 1
  const barW = Math.max(10, Math.min(28, Math.floor(width * 0.3)))
  const titleW = Math.max(12, width - barW - 24)
  return rows.map((r, i) => {
    const cur = r.id === m.currentSessionId
    const total = r[key] / max
    const subFrac = key === 'cost' && r.cost > 0 ? Math.min(1, (r.subagentCost || 0) / r.cost) : 0
    const segs = [{ to: total * (1 - subFrac), color: cur ? P.coral : P.blue }, { to: total, color: P.violet }]
    const bg = i % 2 ? P.zebra : P.card
    return row(el, [
      t(el, '● ', { color: cur ? P.coral : r.id === '_other' ? P.low : P.blue, backgroundColor: bg }),
      t(el, fmt.truncate(r.title, titleW).padEnd(titleW), { color: r.id === '_other' ? P.mid : P.hi, backgroundColor: bg }),
      t(el, ' ', { backgroundColor: bg }),
      paint(el, meterCells(segs, 1, barW, P.track), 'sb' + i),
      t(el, (' ' + fmt.usd(r.cost)).padStart(10), { color: P.hi, bold: true, backgroundColor: bg }),
      t(el, (' ' + fmt.tokens(r.tokens)).padStart(8), { color: P.mid, backgroundColor: bg }),
      el.Box({ flexGrow: 1, backgroundColor: bg }),
    ], { key: 's' + i })
  })
}

// rows: the height budget. Fixed rows: header, axis labels and the sessions heading; the chart
// and the session list share the rest.
export function breakdown(el, m, h, { columns, compact, rows = 40 }) {
  // The breakdown can be open (saved from a past session) before the first scan lands.
  if (!m.series || !m.series.length) {
    return card(el, [label(el, 'DAILY'), t(el, m.histError || 'Reading history…', { color: m.histError ? P.amber : P.mid })], { key: 'breakdown' })
  }
  const sel = m.series.find((d) => d.day === m.day) || { cost: 0, tokens: 0, requests: 0 }
  const inner = Math.max(30, columns - 4)
  const header = row(el, [
    label(el, 'DAILY '),
    el.Button({ key: 'm-cost', label: 'Cost', plain: true, dimColor: m.metric !== 'cost', onPress: () => h.metric('cost') }),
    t(el, ' │ ', { color: P.low }),
    el.Button({ key: 'm-tok', label: 'Tokens', plain: true, dimColor: m.metric !== 'tokens', onPress: () => h.metric('tokens') }),
    t(el, '    '),
    el.Button({ key: 'prev', label: '‹', plain: true, onPress: h.prevDay }),
    chip(el, fmt.shortDay(m.day), P.card, P.coral),
    el.Button({ key: 'next', label: '›', plain: true, onPress: h.nextDay }),
    t(el, '  '),
    el.Button({ key: 'today', label: 'Today', plain: true, onPress: h.today }),
    spacer(el),
    t(el, fmt.usd(sel.cost), { bold: true, color: P.hi }),
    t(el, `  ${fmt.tokens(sel.tokens)} tokens · ${sel.requests} req`, { color: P.mid }),
  ])
  const dayRows = (m.sessionsByDay && m.sessionsByDay[m.day]) || []

  const chartRows = Math.max(2, Math.min(compact ? 5 : 8, rows - 6))
  const sessionCount = Math.max(1, Math.min(compact ? 6 : 14, rows - 3 - chartRows))
  return card(el, [
    header,
    columnsTerminal(el, m, inner - 8, chartRows),
    row(el, [label(el, `SESSIONS · ${fmt.shortDay(m.day)}`), spacer(el), t(el, '■ main  ', { color: P.blue }), t(el, '■ subagents  ', { color: P.violet }), t(el, '■ this session', { color: P.coral })]),
    ...sessionsTerminal(el, m, dayRows.slice(0, sessionCount), inner),
    m.histError ? t(el, m.histError, { color: P.amber }) : null,
  ], { key: 'breakdown' })
}

// ------------------------------------------------------------------ sites

// Narrow terminals: one card, one line per tracker.
function compactCard(el, m, h, columns) {
  const c = m.ctx
  const s = cacheStatus(m.cache, m.now)
  const ttlMs = m.cache ? m.cache.ttlMs : m.ttlMs
  const turn = m.turn && m.turn.requests ? m.turn : null
  const barCells = Math.max(10, Math.min(28, columns - 46))
  return card(el, [
    row(el, [
      label(el, 'TODAY '), t(el, fmt.usd(m.todayCost), { bold: true, color: P.hi }),
      t(el, `  ${fmt.tokens(m.todayTokens)} tok · all time ${fmt.usd(m.totalCost)}`, { color: P.mid }),
      spacer(el),
      el.Button({ key: 'toggle', label: m.expanded ? '▼ Hide' : '▲ Breakdown', plain: true, onPress: h.toggle }),
    ]),
    c
      ? row(el, [
        label(el, 'CONTEXT '), t(el, fmt.tokens(c.used), { bold: true, color: P.hi }), t(el, '/' + fmt.tokens(c.window) + ' ', { color: P.mid }),
        paint(el, meterCells(c.used > c.soft ? [{ to: c.soft, color: P.teal }, { to: c.used, color: P.slate }] : [{ to: c.used, color: P.teal }], c.window, barCells, P.track, { at: c.soft, ch: '▼', fg: P.amber }), 'ctxbar'),
        t(el, ' ' + (c.used <= c.soft ? `${fmt.tokens(c.soft - c.used)} to ${fmt.tokens(c.soft)}` : `${fmt.tokens(c.used - c.soft)} past ${fmt.tokens(c.soft)}`), { color: c.used <= c.soft ? P.low : P.amber }),
      ])
      : row(el, [label(el, 'CONTEXT '), t(el, 'waiting for the first response', { color: P.mid })]),
    row(el, [
      label(el, 'CACHE '), chip(el, ttlMs >= 3_600_000 ? '1H' : '5M', P.mid, P.raised), t(el, ' '), chip(el, s.label, P.card, s.color),
      t(el, m.cache && m.cache.lastTs ? ` ${countdown(s.remaining)} left · ends ${fmt.clockZ(m.cache.lastTs + m.cache.ttlMs)} ` : '', { color: P.mid }),
      el.Button({ key: 'guard', label: m.guard ? 'GUARD ON' : 'GUARD OFF', plain: true, onPress: h.guard }),
      spacer(el),
      t(el, turn ? `${turn.running ? 'turn' : 'last turn'} ${fmt.tokens(turn.tokens)} · ${fmt.usd(turn.cost)}` : '', { color: P.hi }),
    ]),
  ], { key: 'compact' })
}

// The cards take 4 rows; the breakdown gets what maxRows leaves (less a 1-row gap), so the
// cards never scroll out of view.
const CARD_ROWS = 4
const MIN_BREAKDOWN_ROWS = 7

// Terminal bands shorter than this can't hold the breakdown above the cards; the hooks
// module opens the breakdown as a pane instead.
export const BREAKDOWN_MIN_BAND_ROWS = CARD_ROWS + 1 + MIN_BREAKDOWN_ROWS

// Desktop draws whole cards as SVG (desktop.js); everything below is the terminal.
const isDesktop = (m, el) => m.surface !== 'terminal' && !!el.Svg

export function band(el, m, h, columns, maxRows = 40) {
  if (isDesktop(m, el)) return desktopBand(el, m, h, columns)
  const wide = columns >= 110
  let cards
  if (wide) {
    const avail = columns - 2 // two 1-column gaps
    const w1 = Math.floor(avail * 0.29), w2 = Math.floor(avail * 0.36), w3 = avail - w1 - w2
    cards = row(el, [
      usageCard(el, m, h, w1, w1 - 4),
      contextCard(el, m, w2, w2 - 4),
      cacheCard(el, m, w3, w3 - 4, h),
    ], { columnGap: 1 })
  } else {
    cards = compactCard(el, m, h, columns)
  }
  // Too short for the breakdown: the hooks module shows it in a pane, so draw the cards alone.
  const spare = maxRows - CARD_ROWS - 1
  const top = m.expanded && spare >= MIN_BREAKDOWN_ROWS ? breakdown(el, m, h, { columns, compact: true, rows: spare }) : null
  return col(el, [top, cards], { rowGap: top ? 1 : 0 })
}

export function pane(el, m, h, columns) {
  if (isDesktop(m, el)) return desktopPane(el, m, h, columns)
  const w = Math.max(30, columns)
  return col(el, [
    breakdown(el, m, h, { columns: w, compact: false }),
    contextCard(el, m, undefined, w - 4),
    cacheCard(el, m, undefined, w - 4, h),
  ], { rowGap: 1 })
}

// Plain-text summary for `/usage-hud report` and surfaces that draw nothing.
export function textSummary(m) {
  const lines = []
  lines.push(`Today (all sessions): ${fmt.usd(m.todayCost)} · ${fmt.tokens(m.todayTokens)} tokens · all time ${fmt.usd(m.totalCost)}`)
  if (m.ctx) lines.push(`Context: ${fmt.tokens(m.ctx.used)} / ${fmt.tokens(m.ctx.window)} (${fmt.tokens(Math.max(0, m.ctx.window - m.ctx.used))} left, soft limit ${fmt.tokens(m.ctx.soft)})`)
  if (m.cache && m.cache.lastTs) {
    const s = cacheStatus(m.cache, m.now)
    lines.push(`Cache (${m.cache.ttlMs >= 3_600_000 ? '1h' : '5m'}): ${s.label.replace(/^[●○] /, '').toLowerCase()}, ${fmt.duration(s.remaining)} left · started ${fmt.clock(m.cache.warmSince || m.cache.lastTs)} · ends ${fmt.clockZ(m.cache.lastTs + m.cache.ttlMs)}`)
    lines.push(`Cache guard: ${m.guard ? 'on (asks before the first prompt after the cache expires)' : 'off'}`)
  }
  if (m.turn && m.turn.requests) lines.push(`Last turn: ${fmt.tokens(m.turn.tokens)} tokens · ${fmt.usd(m.turn.cost)} · ${m.turn.requests} requests`)
  const days = (m.series || []).filter((d) => d.requests).slice(-7)
  if (days.length) {
    lines.push('', 'Last days:')
    for (const d of days) lines.push(`  ${fmt.shortDay(d.day).padEnd(7)} ${fmt.usd(d.cost).padStart(9)}  ${fmt.tokens(d.tokens).padStart(7)} tok`)
  }
  return lines.join('\n')
}
