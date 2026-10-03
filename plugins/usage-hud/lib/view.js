// Builds the element trees for the band above the prompt and the breakdown pane.
// Pure: it receives the element constructors from `$.ui.resolve(e)`, a view model, and
// callbacks, so it holds no mods API calls of its own (those stay in register.js).

import * as fmt from './format.js'

// Mid-tone colors that read on both dark and light themes.
export const C = {
  accent: '#3987e5',   // series / bars
  select: '#eb6834',   // selected day
  good: '#0ca30c',     // context within the soft limit, warm cache
  over: '#8a8880',     // context past the soft limit (not optimal)
  warn: '#fab219',     // soft-limit marker, cache about to expire
  bad: '#d03b3b',      // cache expired
  track: '#5f5e5a',    // empty meter cells
  muted: '#8a8880',
  border: '#5f5e5a',
}

const SPARK = '▁▂▃▄▅▆▇█'
const EIGHTHS = ' ▁▂▃▄▅▆▇█'

// Runs of [char, color] -> one Text with a nested Text per color run.
function segments(el, cells, key) {
  const runs = []
  for (const [ch, color] of cells) {
    const last = runs[runs.length - 1]
    if (last && last.color === color) last.text += ch
    else runs.push({ color, text: ch })
  }
  return el.Text({
    key,
    wrap: 'truncate',
    children: runs.map((r) => el.Text({ color: r.color, children: [r.text] })),
  })
}

// Elements refuse props they don't know, and an explicit undefined is safest left out.
const clean = (props) => Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined))
const t = (el, text, props = {}) => el.Text(clean({ wrap: 'truncate', ...props, children: [text] }))
const row = (el, children, props = {}) => el.Box(clean({ flexDirection: 'row', ...props, children: children.filter(Boolean) }))
const col = (el, children, props = {}) => el.Box(clean({ flexDirection: 'column', ...props, children: children.filter(Boolean) }))

// ---------------------------------------------------------------- the three boxes

function sparkline(values) {
  const max = Math.max(...values, 0)
  if (max <= 0) return '·'.repeat(values.length)
  return values.map((v) => (v <= 0 ? '·' : SPARK[Math.min(7, Math.floor((v / max) * 7.999))])).join('')
}

function usageBox(el, m, h, width) {
  const series = m.series || []
  const last = series.slice(-14).map((d) => d.cost)
  const label = m.expanded ? '▾ Hide' : '▴ Breakdown'
  return col(el, [
    row(el, [t(el, 'Today · all sessions', { color: C.muted }), el.Box({ flexGrow: 1 }), el.Button({ key: 'toggle', label, plain: true, onPress: h.toggle })]),
    m.histError && !series.length
      ? t(el, m.histError, { color: C.warn })
      : row(el, [t(el, fmt.usd(m.todayCost), { bold: true }), t(el, '  ' + fmt.tokens(m.todayTokens) + ' tok', { color: C.muted })]),
    row(el, [
      t(el, sparkline(last), { color: C.accent }),
      t(el, '  14d · all time ' + fmt.usd(m.totalCost), { color: C.muted }),
    ]),
  ], { borderStyle: 'round', borderColor: C.border, paddingX: 1, width, flexShrink: 1 })
}

function contextBarCells(used, window, soft, cells) {
  const scale = window / cells
  const mark = Math.max(0, Math.min(cells, Math.round(soft / scale)))
  const filled = used > 0 ? Math.max(1, Math.min(cells, Math.round(used / scale))) : 0
  const out = []
  for (let i = 0; i < cells; i++) {
    if (i === mark) out.push(['▶', C.warn])
    out.push(i < filled ? ['█', i < mark ? C.good : C.over] : ['░', C.track])
  }
  if (mark >= cells) out.push(['▶', C.warn])
  return out
}

function contextSvg(used, window, soft, w = 300) {
  const H = 30, y = 10, bh = 10
  const x = (v) => Math.max(0, Math.min(w, (v / window) * w))
  const okW = x(Math.min(used, soft))
  const overW = used > soft ? x(used) - x(soft) : 0
  const mx = x(soft)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}">
  <defs><pattern id="h" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="${C.over}"/><line x1="0" y1="0" x2="0" y2="4" stroke="#6b6a66" stroke-width="2"/></pattern></defs>
  <rect x="0" y="${y}" width="${w}" height="${bh}" rx="3" fill="${C.track}" opacity="0.45"/>
  <rect x="0" y="${y}" width="${okW}" height="${bh}" rx="3" fill="${C.good}"><title>${fmt.tokens(Math.min(used, soft))} within ${fmt.tokens(soft)}</title></rect>
  ${overW > 0 ? `<rect x="${mx}" y="${y}" width="${overW}" height="${bh}" fill="url(#h)"><title>${fmt.tokens(used - soft)} past ${fmt.tokens(soft)}: not optimal</title></rect>` : ''}
  <line x1="${mx}" y1="${y - 2}" x2="${mx}" y2="${y + bh + 2}" stroke="${C.warn}" stroke-width="1.5"/>
  <path d="M ${mx - 7} ${y - 8} L ${mx - 1} ${y - 4.5} L ${mx - 7} ${y - 1} Z" fill="${C.warn}"><title>${fmt.tokens(soft)} soft limit</title></path>
  <text x="${Math.min(w - 2, mx + 3)}" y="${y - 2}" font-family="sans-serif" font-size="9" fill="${C.muted}" text-anchor="${mx > w - 40 ? 'end' : 'start'}">${fmt.tokens(soft)}</text>
</svg>`
}

function contextBox(el, m, width, barCells) {
  const c = m.ctx
  if (!c) {
    return col(el, [t(el, 'Context window', { color: C.muted }), t(el, 'waiting for the first response…', { color: C.muted }), t(el, ' ')],
      { borderStyle: 'round', borderColor: C.border, paddingX: 1, width, flexShrink: 1 })
  }
  const left = Math.max(0, c.window - c.used)
  const toSoft = c.soft - c.used
  const pct = Math.round((c.used / c.window) * 100)
  const meter = m.surface === 'terminal' || !el.Svg
    ? segments(el, contextBarCells(c.used, c.window, c.soft, barCells), 'ctxbar')
    : el.Svg({ source: contextSvg(c.used, c.window, c.soft), alt: `Context ${fmt.tokens(c.used)} of ${fmt.tokens(c.window)}, soft limit ${fmt.tokens(c.soft)}`, width: 300, height: 30, isInteractive: true })
  return col(el, [
    row(el, [
      t(el, 'Context ', { color: C.muted }),
      t(el, fmt.tokens(c.used), { bold: true, color: c.used > c.soft ? C.over : undefined }),
      t(el, ` / ${fmt.tokens(c.window)} · ${pct}%`, { color: C.muted }),
    ]),
    meter,
    t(el, `${fmt.tokens(left)} left · ` + (toSoft >= 0 ? `${fmt.tokens(toSoft)} to ${fmt.tokens(c.soft)}` : `${fmt.tokens(-toSoft)} past ${fmt.tokens(c.soft)}`),
      { color: toSoft >= 0 ? C.muted : C.over }),
  ], { borderStyle: 'round', borderColor: C.border, paddingX: 1, width, flexShrink: 1 })
}

export function cacheStatus(cache, now) {
  if (!cache || !cache.lastTs) return { label: 'no cache yet', color: C.muted, remaining: 0 }
  if (cache.active) return { label: '● refreshing', color: C.good, remaining: cache.ttlMs }
  const remaining = cache.lastTs + cache.ttlMs - now
  if (remaining <= 0) return { label: '○ expired', color: C.bad, remaining: 0 }
  if (remaining < Math.min(5 * 60_000, cache.ttlMs * 0.2)) return { label: '● expiring', color: C.warn, remaining }
  return { label: '● warm', color: C.good, remaining }
}

function cacheBox(el, m, width) {
  const c = m.cache
  const s = cacheStatus(c, m.now)
  const ttl = c ? (c.ttlMs >= 3_600_000 ? '1h' : '5m') : '–'
  const turn = m.turn
  return col(el, [
    row(el, [
      t(el, `Cache ${ttl} `, { color: C.muted }),
      t(el, s.label, { color: s.color }),
      t(el, '  '),
      t(el, c && c.lastTs ? fmt.duration(s.remaining) : '–', { bold: true }),
      t(el, c && c.lastTs ? ' left' : '', { color: C.muted }),
    ]),
    t(el, c && c.lastTs
      ? `start ${fmt.clock(c.warmSince || c.lastTs)} · last ${fmt.clock(c.lastTs)} · ends ${fmt.clock(c.lastTs + c.ttlMs)}`
      : 'starts with the first response', { color: C.muted }),
    turn && turn.requests
      ? row(el, [
        t(el, turn.running ? 'This turn ' : 'Last turn ', { color: C.muted }),
        t(el, fmt.tokens(turn.tokens), { bold: true }),
        t(el, ' tok · ', { color: C.muted }),
        t(el, fmt.usd(turn.cost), { bold: true }),
        t(el, ` · ${turn.requests} req`, { color: C.muted }),
      ])
      : t(el, 'Last turn –', { color: C.muted }),
  ], { borderStyle: 'round', borderColor: C.border, paddingX: 1, width, flexShrink: 1 })
}

// ---------------------------------------------------------------- breakdown (daily + sessions)

function dailyTerminal(el, m, width, height) {
  const series = m.series
  const vals = series.map((d) => (m.metric === 'cost' ? d.cost : d.tokens))
  const max = Math.max(...vals, 0)
  const step = width >= series.length * 2 ? 2 : 1
  const rows = []
  for (let r = height - 1; r >= 0; r--) {
    const cells = []
    series.forEach((d, i) => {
      const eighths = max > 0 ? Math.round((vals[i] / max) * height * 8) : 0
      const lvl = Math.max(0, Math.min(8, eighths - r * 8))
      const ch = lvl === 0 && r === 0 && vals[i] > 0 ? '▁' : EIGHTHS[lvl]
      cells.push([ch, d.day === m.day ? C.select : C.accent])
      if (step === 2) cells.push([' ', C.accent])
    })
    rows.push(row(el, [segments(el, cells, 'r' + r), r === height - 1 ? t(el, ' ' + (m.metric === 'cost' ? fmt.usd(max) : fmt.tokens(max)), { color: C.muted }) : null]))
  }
  const first = fmt.shortDay(series[0].day)
  const last = fmt.shortDay(series[series.length - 1].day)
  const span = series.length * step
  rows.push(t(el, first + ' '.repeat(Math.max(1, span - first.length - last.length)) + last, { color: C.muted }))
  return col(el, rows)
}

function dailySvg(m, w = 640, h = 130) {
  const series = m.series
  const vals = series.map((d) => (m.metric === 'cost' ? d.cost : d.tokens))
  const max = Math.max(...vals, 0) || 1
  const padL = 44, padB = 18, padT = 6
  const bw = (w - padL) / series.length
  const y = (v) => padT + (h - padT - padB) * (1 - v / max)
  const label = (v) => (m.metric === 'cost' ? fmt.usd(v) : fmt.tokens(v))
  const bars = series.map((d, i) => {
    const v = vals[i]
    const bh = Math.max(v > 0 ? 2 : 0, h - padB - y(v))
    const x = padL + i * bw + 1
    const fill = d.day === m.day ? C.select : C.accent
    return `<rect x="${x.toFixed(1)}" y="${(h - padB - bh).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${fill}"><title>${fmt.shortDay(d.day)}: ${fmt.usd(d.cost)} · ${fmt.tokens(d.tokens)} tok · ${d.requests} req</title></rect>`
  }).join('')
  const grid = [0, 0.5, 1].map((p) => `<line x1="${padL}" x2="${w}" y1="${y(max * p).toFixed(1)}" y2="${y(max * p).toFixed(1)}" stroke="${C.track}" stroke-opacity="0.35"/><text x="${padL - 4}" y="${(y(max * p) + 3).toFixed(1)}" font-size="9" font-family="sans-serif" fill="${C.muted}" text-anchor="end">${label(max * p)}</text>`).join('')
  const xl = [0, Math.floor(series.length / 2), series.length - 1].map((i) => `<text x="${(padL + i * bw + bw / 2).toFixed(1)}" y="${h - 4}" font-size="9" font-family="sans-serif" fill="${C.muted}" text-anchor="middle">${fmt.shortDay(series[i].day)}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${grid}${bars}${xl}</svg>`
}

function sessionRows(el, m, maxRows, barCells, titleWidth) {
  const rows = (m.sessionsByDay && m.sessionsByDay[m.day]) || []
  if (!rows.length) return [t(el, 'No usage recorded on this day.', { color: C.muted })]
  const key = m.metric === 'cost' ? 'cost' : 'tokens'
  const max = Math.max(...rows.map((r) => r[key]), 0) || 1
  return rows.slice(0, maxRows).map((r, i) => {
    const n = Math.max(r[key] > 0 ? 1 : 0, Math.round((r[key] / max) * barCells))
    const bar = '█'.repeat(n) + ' '.repeat(barCells - n)
    const sub = r.subagentCost > 0.0005 ? ` (+agents ${fmt.usd(r.subagentCost)})` : ''
    return row(el, [
      t(el, bar, { color: r.id === m.currentSessionId ? C.select : C.accent }),
      t(el, ' ' + fmt.usd(r.cost).padStart(8) + ' ' + fmt.tokens(r.tokens).padStart(6) + '  '),
      t(el, fmt.truncate(r.title, titleWidth) + sub, { color: r.id === '_other' ? C.muted : undefined }),
    ], { key: 's' + i })
  })
}

export function breakdown(el, m, h, { columns, compact }) {
  const sel = m.series.find((d) => d.day === m.day) || { cost: 0, tokens: 0, requests: 0 }
  const controls = row(el, [
    t(el, 'Daily ', { bold: true }),
    el.Button({ key: 'm-cost', label: 'Cost', plain: true, dimColor: m.metric !== 'cost', onPress: () => h.metric('cost') }),
    t(el, ' · ', { color: C.muted }),
    el.Button({ key: 'm-tok', label: 'Tokens', plain: true, dimColor: m.metric !== 'tokens', onPress: () => h.metric('tokens') }),
    t(el, '   '),
    el.Button({ key: 'prev', label: '◀', plain: true, onPress: h.prevDay }),
    t(el, ' ' + fmt.shortDay(m.day) + ' ', { bold: true, color: C.select }),
    el.Button({ key: 'next', label: '▶', plain: true, onPress: h.nextDay }),
    t(el, '  '),
    el.Button({ key: 'today', label: 'Today', plain: true, onPress: h.today }),
    t(el, `   ${fmt.usd(sel.cost)} · ${fmt.tokens(sel.tokens)} tok · ${sel.requests} req`, { color: C.muted }),
  ], { columnGap: 0 })

  const chart = m.surface === 'terminal' || !el.Svg
    ? dailyTerminal(el, m, Math.max(20, columns - 10), compact ? 4 : 6)
    : el.Svg({ source: dailySvg(m, Math.min(720, Math.max(320, columns * 7)), compact ? 110 : 150), alt: `Daily ${m.metric} for the last ${m.series.length} days`, isInteractive: true })

  const titleWidth = Math.max(16, columns - 36)
  return col(el, [
    controls,
    chart,
    t(el, `Sessions on ${fmt.shortDay(m.day)}`, { bold: true }),
    ...sessionRows(el, m, compact ? 6 : 14, 12, titleWidth),
    m.histError ? t(el, m.histError, { color: C.warn }) : null,
  ], { borderStyle: 'round', borderColor: C.border, paddingX: 1, flexShrink: 1 })
}

// ---------------------------------------------------------------- sites

export function band(el, m, h, columns) {
  const wide = columns >= 110
  const boxes = wide
    ? row(el, [
      usageBox(el, m, h, '28%'),
      contextBox(el, m, '38%', Math.max(12, Math.floor(columns * 0.38) - 6)),
      cacheBox(el, m, '34%'),
    ])
    : col(el, [usageBox(el, m, h), contextBox(el, m, undefined, Math.max(12, columns - 8)), cacheBox(el, m)])
  return col(el, [m.expanded ? breakdown(el, m, h, { columns, compact: true }) : null, boxes])
}

export function pane(el, m, h, columns) {
  return col(el, [
    breakdown(el, m, h, { columns, compact: false }),
    contextBox(el, m, undefined, Math.max(12, columns - 8)),
    cacheBox(el, m),
  ])
}

// Plain-text summary for `/usage-hud report` and surfaces that draw nothing.
export function textSummary(m) {
  const lines = []
  lines.push(`Today (all sessions): ${fmt.usd(m.todayCost)} · ${fmt.tokens(m.todayTokens)} tokens · all time ${fmt.usd(m.totalCost)}`)
  if (m.ctx) lines.push(`Context: ${fmt.tokens(m.ctx.used)} / ${fmt.tokens(m.ctx.window)} (${fmt.tokens(Math.max(0, m.ctx.window - m.ctx.used))} left, soft limit ${fmt.tokens(m.ctx.soft)})`)
  if (m.cache && m.cache.lastTs) {
    const s = cacheStatus(m.cache, m.now)
    lines.push(`Cache (${m.cache.ttlMs >= 3_600_000 ? '1h' : '5m'}): ${s.label.replace(/^[●○] /, '')}, ${fmt.duration(s.remaining)} left · start ${fmt.clock(m.cache.warmSince || m.cache.lastTs)} · ends ${fmt.clock(m.cache.lastTs + m.cache.ttlMs)}`)
  }
  if (m.turn && m.turn.requests) lines.push(`Last turn: ${fmt.tokens(m.turn.tokens)} tokens · ${fmt.usd(m.turn.cost)} · ${m.turn.requests} requests`)
  const days = (m.series || []).filter((d) => d.requests).slice(-7)
  if (days.length) {
    lines.push('', 'Last days:')
    for (const d of days) lines.push(`  ${fmt.shortDay(d.day).padEnd(7)} ${fmt.usd(d.cost).padStart(9)}  ${fmt.tokens(d.tokens).padStart(7)} tok`)
  }
  return lines.join('\n')
}
