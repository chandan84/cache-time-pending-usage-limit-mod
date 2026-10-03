// Desktop renderer. Box elements have square corners and the host's own type, so on Desktop
// each card is drawn whole as one SVG image: rounded corners, a hairline edge, and its own
// typography. Images (not interactive frames) keep redraws from flickering; the sources only
// change when the figures do. Buttons stay real elements, in a slim row above the cards.
//
// Pure: element constructors, a view model and callbacks in; element trees out.

import * as fmt from './format.js'
import { P, cacheStatus, countdown } from './theme.js'

const FONT = "'Segoe UI Variable Text', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif"
const PX_PER_COL = 7.4   // CSS px per layout column, to size the cards to the band
const CARD_H = 116
const GAP_PX = 10

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const clean = (props) => Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined))
const row = (el, children, props = {}) => el.Box(clean({ flexDirection: 'row', ...props, children: children.filter(Boolean) }))
const col = (el, children, props = {}) => el.Box(clean({ flexDirection: 'column', ...props, children: children.filter(Boolean) }))

// Rough text width, for placing text after text and truncating titles.
const textW = (s, size, weight = 400, spacing = 0) => String(s).length * (size * (weight >= 600 ? 0.6 : 0.55) + spacing)

function text(x, y, s, { size = 12, weight = 400, fill = P.mid, anchor = 'start', spacing = 0 } = {}) {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc(s)}</text>`
}
const label = (x, y, s) => text(x, y, s, { size: 10, weight: 600, fill: '#8a887f', spacing: 0.9 })

// One <text> of styled runs, laid out by the renderer: [{ s, size, weight, fill, dx, spacing }].
function runs(x, y, parts, anchor = 'start') {
  const spans = parts.map((p) => `<tspan${p.dx ? ` dx="${p.dx}"` : ''} font-size="${p.size || 12}" font-weight="${p.weight || 400}" fill="${p.fill || P.mid}"${p.spacing ? ` letter-spacing="${p.spacing}"` : ''}>${esc(p.s)}</tspan>`).join('')
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}">${spans}</text>`
}
const LABEL = { size: 10, weight: 600, fill: '#8a887f', spacing: 0.9 }

// A pill: soft tint of its color behind colored text, optional leading dot.
function pill(xRight, y, s, color, { dot = false, solid = false } = {}) {
  const size = 10.5
  const w = textW(s, size, 600) + (dot ? 16 : 12)
  const x = xRight - w
  return `<rect x="${x.toFixed(1)}" y="${y - 12}" width="${w.toFixed(1)}" height="18" rx="9" fill="${color}" fill-opacity="${solid ? 1 : 0.16}"/>` +
    (dot ? `<circle cx="${(x + 9).toFixed(1)}" cy="${y - 3}" r="3" fill="${color}"/>` : '') +
    text(x + (dot ? 15 : 6), y + 1, s, { size, weight: 600, fill: solid ? P.card : color })
}

function frame(w, h, body, defs = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#21252d"/><stop offset="1" stop-color="#181b20"/></linearGradient>${defs}</defs>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14" fill="url(#bg)" stroke="#ffffff" stroke-opacity="0.07"/>
${body}</svg>`
}

// ------------------------------------------------------------------ cards

function usageSvg(m, w) {
  const vals = (m.series || []).slice(-14).map((d) => d.cost)
  const sx = Math.round(w * 0.52), sw = w - sx - 18, sy = 36, sh = 46
  const max = Math.max(...vals, 0) || 1
  const step = vals.length > 1 ? sw / (vals.length - 1) : sw
  const pts = vals.map((v, i) => [sx + i * step, sy + sh - (v / max) * (sh - 4)])
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1] || [sx + sw, sy + sh]
  const spark = vals.length
    ? `<path d="${line} L${(sx + sw).toFixed(1)},${sy + sh} L${sx},${sy + sh} Z" fill="url(#sp)"/>
<path d="${line}" fill="none" stroke="${P.blueLight}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.2" fill="${P.blueLight}" stroke="#1b1e24" stroke-width="1.5"/>`
    : ''
  const body = label(18, 28, 'TODAY · ALL SESSIONS') +
    (m.histError && !(m.series || []).length
      ? text(18, 62, m.histError, { size: 12, fill: P.amber })
      : text(18, 62, fmt.usd(m.todayCost), { size: 26, weight: 600, fill: P.hi }) +
        text(18, 82, `${fmt.tokens(m.todayTokens)} tokens`, { size: 12 })) +
    spark +
    `<line x1="${sx}" x2="${sx + sw}" y1="${sy + sh + 0.5}" y2="${sy + sh + 0.5}" stroke="#ffffff" stroke-opacity="0.06"/>` +
    text(sx + sw, sy + sh + 14, '14 days', { size: 9.5, fill: P.low, anchor: 'end' }) +
    runs(18, 104, [{ s: 'All time', size: 11, fill: P.low }, { s: fmt.usd(m.totalCost), dx: 5, size: 11, weight: 600, fill: P.mid }])
  return frame(w, CARD_H, body, `<linearGradient id="sp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.blue}" stop-opacity="0.45"/><stop offset="1" stop-color="${P.blue}" stop-opacity="0"/></linearGradient>`)
}

function contextSvg(m, w) {
  const c = m.ctx
  const soft = c ? c.soft : m.softLimit || 240_000
  const win = c ? c.window : m.ctxWindow || 1_000_000
  const used = c ? c.used : 0
  const over = used > soft
  const mx = 18, mw = w - 36, my = 84, mh = 8
  const x = (v) => mx + Math.max(0, Math.min(mw, (v / win) * mw))
  const sx = x(soft)
  const okEnd = x(Math.min(used, soft))
  const right = sx > mx + mw - 50
  let body = label(18, 28, 'CONTEXT WINDOW')
  if (!c) {
    body += text(18, 60, 'Waiting for the first response', { size: 13, fill: P.mid })
  } else {
    // A quiet amber note, not a chip: a dot and words, smaller than the figures.
    body += over
      ? runs(w - 18, 28, [{ s: '●', size: 8, fill: P.amber }, { s: 'Over soft limit', dx: 5, size: 10.5, weight: 500, fill: P.amber }], 'end')
      : runs(w - 18, 28, [{ s: `${Math.round((used / win) * 100)}% used`, size: 10.5, weight: 500, fill: P.teal }], 'end')
    body += runs(18, 60, [{ s: fmt.tokens(used), size: 26, weight: 600, fill: P.hi }, { s: `/ ${fmt.tokens(win)}`, dx: 7, size: 13, fill: P.low }]) +
      text(w - 18, 60, `${fmt.tokens(Math.max(0, win - used))} free`, { size: 12, fill: P.mid, anchor: 'end' })
  }
  // Meter: teal within the soft limit, hatched slate past it, amber marker with a ► at the limit.
  body += `<rect x="${mx}" y="${my}" width="${mw}" height="${mh}" rx="4" fill="#2b3039"/>
<g clip-path="url(#mc)">
${used > 0 ? `<rect x="${mx}" y="${my}" width="${(okEnd - mx).toFixed(1)}" height="${mh}" fill="url(#ok)"/>` : ''}
${over ? `<rect x="${sx.toFixed(1)}" y="${my}" width="${(x(used) - sx).toFixed(1)}" height="${mh}" fill="url(#ov)"/>` : ''}
</g>
<rect x="${(sx - 0.75).toFixed(1)}" y="${my - 4}" width="1.5" height="${mh + 8}" rx="0.75" fill="${P.amber}"/>
<path d="M${(sx - 7.5).toFixed(1)},${my - 11} L${(sx - 1.5).toFixed(1)},${my - 7.5} L${(sx - 7.5).toFixed(1)},${my - 4} Z" fill="${P.amber}"/>` +
    text(right ? sx - 10 : sx + 4, my - 5, fmt.tokens(soft), { size: 9.5, weight: 600, fill: P.amber, anchor: right ? 'end' : 'start' })
  if (c) {
    body += over
      ? text(18, 108, `${fmt.tokens(used - soft)} past ${fmt.tokens(soft)}`, { size: 11, fill: P.amber })
      : text(18, 108, `${fmt.tokens(soft - used)} to ${fmt.tokens(soft)}`, { size: 11, fill: P.low })
  }
  body += text(w - 18, 108, `${fmt.tokens(soft)} soft limit`, { size: 11, fill: P.low, anchor: 'end' })
  return frame(w, CARD_H, body, `<linearGradient id="ok" x1="0" x2="1"><stop offset="0" stop-color="${P.tealDeep}"/><stop offset="1" stop-color="${P.teal}"/></linearGradient>
<pattern id="ov" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${P.slate}"/><rect width="2.5" height="6" fill="#585c66"/></pattern>
<clipPath id="mc"><rect x="${mx}" y="${my}" width="${mw}" height="${mh}" rx="4"/></clipPath>`)
}

function cacheSvg(m, w) {
  const c = m.cache
  const s = cacheStatus(c, m.now)
  const has = !!(c && c.lastTs)
  const ttlMs = c ? c.ttlMs : m.ttlMs
  const ttl = ttlMs >= 3_600_000 ? '1h TTL' : '5m TTL'
  const turn = m.turn && m.turn.requests ? m.turn : null
  const ttlW = textW(ttl, 9.5, 600) + 12
  const ttlX = 18 + textW('PROMPT CACHE', 10, 600, 0.9) + 10
  let body = label(18, 28, 'PROMPT CACHE') +
    `<rect x="${ttlX.toFixed(1)}" y="16" width="${ttlW.toFixed(1)}" height="17" rx="8.5" fill="#2c3039"/>` +
    text(ttlX + ttlW / 2, 28, ttl, { size: 9.5, weight: 600, fill: P.mid, anchor: 'middle' }) +
    pill(w - 18, 28, s.word, s.color, { dot: true })
  // Ring gauge: share of the TTL left.
  const cx = 44, cy = 72, r = 22, circ = 2 * Math.PI * r
  body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#2b3039" stroke-width="5"/>` +
    (has ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(circ * s.frac).toFixed(2)} ${circ.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>` : '') +
    text(cx, cy + 4, has ? `${Math.round(s.frac * 100)}%` : '–', { size: 11, weight: 600, fill: P.hi, anchor: 'middle' })
  const tx = 80
  if (has) {
    const cd = countdown(s.remaining)
    body += runs(tx, 66, [{ s: cd, size: 24, weight: 600, fill: P.hi }, { s: 'left', dx: 6, size: 12, fill: P.mid }]) +
      text(w - 18, 66, `ends ${fmt.clock(c.lastTs + c.ttlMs)}`, { size: 12, fill: P.mid, anchor: 'end' }) +
      text(tx, 86, `Started ${fmt.clock(c.warmSince || c.lastTs)} · last hit ${fmt.clock(c.lastTs)}`, { size: 11, fill: P.low })
  } else {
    body += text(tx, 66, 'Starts with the first response', { size: 13, fill: P.mid })
  }
  const turnLabel = { ...LABEL, s: turn && turn.running ? 'THIS TURN' : 'LAST TURN' }
  body += turn
    ? runs(tx, 106, [turnLabel, { s: `${fmt.tokens(turn.tokens)} tok`, dx: 10, size: 11.5, weight: 600, fill: P.hi }, { s: '·', dx: 6, size: 11.5, fill: P.low }, { s: fmt.usd(turn.cost), dx: 6, size: 11.5, weight: 600, fill: P.hi }]) +
      text(w - 18, 106, `${turn.requests} req`, { size: 11, fill: P.low, anchor: 'end' })
    : runs(tx, 106, [turnLabel, { s: '–', dx: 10, size: 11.5, fill: P.low }])
  return frame(w, CARD_H, body)
}

// ------------------------------------------------------------------ breakdown

function breakdownSvg(m, w, compact) {
  const series = m.series
  const vals = series.map((d) => (m.metric === 'cost' ? d.cost : d.tokens))
  const max = Math.max(...vals, 0) || 1
  const lab = (v) => (v === 0 ? (m.metric === 'cost' ? '$0' : '0') : m.metric === 'cost' ? fmt.usd(v) : fmt.tokens(v))
  const sel = series.find((d) => d.day === m.day) || { cost: 0, tokens: 0, requests: 0 }
  const rows = ((m.sessionsByDay && m.sessionsByDay[m.day]) || []).slice(0, compact ? 8 : 16)

  const padL = 64, padR = 22, top = 52, ch = compact ? 110 : 150
  const pw = w - padL - padR, bw = pw / series.length
  const y = (v) => top + ch * (1 - v / max)
  let body = label(18, 28, m.metric === 'cost' ? 'DAILY COST' : 'DAILY TOKENS') +
    text(w - 18, 28, `${fmt.shortDay(m.day)} · ${fmt.usd(sel.cost)} · ${fmt.tokens(sel.tokens)} tokens · ${sel.requests} req`, { size: 11.5, weight: 600, fill: P.hi, anchor: 'end' })
  body += [0, 0.5, 1].map((p) => `<line x1="${padL}" x2="${w - padR}" y1="${y(max * p).toFixed(1)}" y2="${y(max * p).toFixed(1)}" stroke="#ffffff" stroke-opacity="${p ? 0.05 : 0.1}"/>` +
    text(padL - 10, y(max * p) + 3.5, lab(max * p), { size: 9.5, fill: P.low, anchor: 'end' })).join('')
  body += series.map((d, i) => {
    const v = vals[i]
    const x = padL + i * bw + bw * 0.18
    const wb = Math.max(2, bw * 0.64)
    const isSel = d.day === m.day
    if (v <= 0) return `<rect x="${x.toFixed(1)}" y="${(top + ch - 2).toFixed(1)}" width="${wb.toFixed(1)}" height="2" rx="1" fill="${isSel ? P.coral : '#2b3039'}"/>`
    const bh = Math.max(3, top + ch - y(v))
    const t = top + ch - bh
    return `<rect x="${x.toFixed(1)}" y="${t.toFixed(1)}" width="${wb.toFixed(1)}" height="${bh.toFixed(1)}" rx="${Math.min(3.5, wb / 2).toFixed(1)}" fill="url(#${isSel ? 'cs' : 'cb'})"/>` +
      (isSel ? text(x + wb / 2, t - 6, lab(v), { size: 9.5, weight: 600, fill: P.coral, anchor: 'middle' }) : '')
  }).join('')
  const xi = [0, Math.floor((series.length - 1) / 2), series.length - 1]
  body += xi.map((i) => text(padL + i * bw + bw / 2, top + ch + 16, fmt.shortDay(series[i].day), { size: 9.5, fill: P.low, anchor: 'middle' })).join('')

  // Sessions on the selected day.
  let sy = top + ch + 44
  body += label(18, sy, `SESSIONS · ${fmt.shortDay(m.day).toUpperCase()}`)
  body += runs(w - 18, sy, [['main', P.blue], ['subagents', P.violet], ['this session', P.coral]].flatMap(([name, color], i) => [
    { s: '●', dx: i ? 14 : 0, size: 8, fill: color }, { s: name, dx: 5, size: 10, fill: P.mid },
  ]), 'end')
  sy += 12
  const key = m.metric === 'cost' ? 'cost' : 'tokens'
  const rmax = Math.max(...rows.map((r) => r[key]), 0) || 1
  const titleW = Math.min(300, w * 0.38), barX = 18 + titleW + 12, valW = 128, barW = Math.max(40, w - barX - valW - 18)
  if (!rows.length) {
    body += text(18, sy + 18, 'No usage recorded on this day.', { size: 12, fill: P.mid })
    sy += 30
  }
  rows.forEach((r, i) => {
    const ry = sy + i * 26
    const cur = r.id === m.currentSessionId
    const total = (r[key] / rmax) * barW
    const sub = key === 'cost' && r.cost > 0 ? total * Math.min(1, (r.subagentCost || 0) / r.cost) : 0
    const title = fmt.truncate(r.title, Math.floor(titleW / 6.4))
    if (i % 2) body += `<rect x="8" y="${ry}" width="${w - 16}" height="26" rx="8" fill="#ffffff" fill-opacity="0.025"/>`
    body += `<circle cx="22" cy="${ry + 13}" r="3" fill="${cur ? P.coral : r.id === '_other' ? P.low : P.blue}"/>` +
      text(32, ry + 17, title, { size: 12, fill: r.id === '_other' ? P.mid : P.hi }) +
      `<rect x="${barX}" y="${ry + 9}" width="${barW}" height="8" rx="4" fill="#2b3039"/>` +
      `<rect x="${barX}" y="${ry + 9}" width="${Math.max(4, total - sub).toFixed(1)}" height="8" rx="4" fill="${cur ? P.coral : P.blue}"/>` +
      (sub > 1 ? `<rect x="${(barX + total - sub).toFixed(1)}" y="${ry + 9}" width="${sub.toFixed(1)}" height="8" rx="4" fill="${P.violet}"/>` : '') +
      text(w - 18, ry + 17, key === 'cost' ? `${fmt.usd(r.cost)} · ${fmt.tokens(r.tokens)}` : `${fmt.tokens(r.tokens)} · ${fmt.usd(r.cost)}`, { size: 11.5, weight: 600, fill: P.mid, anchor: 'end' })
  })
  const h = sy + rows.length * 26 + 16
  return frame(w, Math.round(h), body, `<linearGradient id="cb" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${P.blueDeep}"/><stop offset="1" stop-color="${P.blueLight}"/></linearGradient>
<linearGradient id="cs" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${P.coralDeep}"/><stop offset="1" stop-color="${P.coral}"/></linearGradient>`)
}

function controls(el, m, h) {
  return row(el, [
    el.Button({ key: 'm-cost', label: 'Cost', plain: true, dimColor: m.metric !== 'cost', onPress: () => h.metric('cost') }),
    el.Button({ key: 'm-tok', label: 'Tokens', plain: true, dimColor: m.metric !== 'tokens', onPress: () => h.metric('tokens') }),
    el.Box({ width: 2 }),
    el.Button({ key: 'prev', label: '◄ Prev', plain: true, onPress: h.prevDay }),
    el.Button({ key: 'today', label: 'Today', plain: true, onPress: h.today }),
    el.Button({ key: 'next', label: 'Next ►', plain: true, onPress: h.nextDay }),
    el.Box({ flexGrow: 1 }),
  ], { columnGap: 2 })
}

export function desktopBreakdown(el, m, h, columns, compact) {
  if (!m.series || !m.series.length) {
    return el.Svg({ source: frame(Math.round(columns * PX_PER_COL), 60, label(18, 28, 'DAILY') + text(18, 46, m.histError || 'Reading history…', { size: 12, fill: P.mid })), alt: 'Daily usage: reading history', height: 60 })
  }
  const w = Math.round(Math.max(360, columns * PX_PER_COL))
  return col(el, [
    controls(el, m, h),
    el.Svg({ source: breakdownSvg(m, w, compact), alt: `Daily ${m.metric} for the last ${m.series.length} days, and sessions on ${fmt.shortDay(m.day)}` }),
  ], { rowGap: 1 })
}

// ------------------------------------------------------------------ sites

function cards(el, m, columns, stacked) {
  const total = Math.max(600, columns * PX_PER_COL)
  const avail = total - GAP_PX * 2
  const w1 = Math.round(avail * 0.3), w2 = Math.round(avail * 0.36), w3 = Math.round(avail - w1 - w2)
  const c = m.ctx
  const s = cacheStatus(m.cache, m.now)
  const svg = (source, alt) => el.Svg({ source, alt })
  const usage = svg(usageSvg(m, stacked ? Math.round(total) : w1), `Today across all sessions: ${fmt.usd(m.todayCost)}, ${fmt.tokens(m.todayTokens)} tokens`)
  const ctx = svg(contextSvg(m, stacked ? Math.round(total) : w2), c ? `Context ${fmt.tokens(c.used)} of ${fmt.tokens(c.window)}, soft limit ${fmt.tokens(c.soft)}` : 'Context: waiting for the first response')
  const cache = svg(cacheSvg(m, stacked ? Math.round(total) : w3), m.cache ? `Prompt cache ${s.word}, ${countdown(s.remaining)} left` : 'Prompt cache idle')
  return [usage, ctx, cache]
}

export function desktopBand(el, m, h, columns) {
  const [usage, ctx, cache] = cards(el, m, columns, false)
  return col(el, [
    m.expanded ? desktopBreakdown(el, m, h, columns, true) : null,
    row(el, [
      el.Box({ flexGrow: 1 }),
      el.Button({ key: 'toggle', label: m.expanded ? '▼ Hide breakdown' : '▲ Breakdown', plain: true, onPress: h.toggle }),
    ]),
    row(el, [
      el.Box({ width: '30%', children: [usage] }),
      el.Box({ width: '36%', children: [ctx] }),
      el.Box({ width: '34%', children: [cache] }),
    ], { columnGap: 1 }),
  ], { rowGap: 0 })
}

export function desktopPane(el, m, h, columns) {
  const [usage, ctx, cache] = cards(el, m, columns, true)
  return col(el, [desktopBreakdown(el, m, h, columns, false), usage, ctx, cache], { rowGap: 1 })
}
