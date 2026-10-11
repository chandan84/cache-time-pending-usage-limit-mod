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

// Text width from Segoe UI advance widths (em), so layouts can test what fits before drawing.
// Generous by a few percent: a fallback font must not overflow either.
const EM = {
  ' ': 0.274, '.': 0.252, ',': 0.252, ':': 0.252, ';': 0.252, '·': 0.252, '$': 0.559, '%': 0.83, '/': 0.39, '-': 0.39,
  '–': 0.5, '…': 0.8, '●': 0.6, '(': 0.3, ')': 0.3, "'": 0.2, '?': 0.45, '_': 0.4, '→': 0.9,
  A: 0.66, B: 0.58, C: 0.63, D: 0.72, E: 0.51, F: 0.49, G: 0.7, H: 0.73, I: 0.27, J: 0.35, K: 0.58, L: 0.47, M: 0.86,
  N: 0.76, O: 0.76, P: 0.56, Q: 0.76, R: 0.6, S: 0.53, T: 0.55, U: 0.7, V: 0.64, W: 0.93, X: 0.61, Y: 0.57, Z: 0.58,
  a: 0.51, b: 0.58, c: 0.46, d: 0.58, e: 0.52, f: 0.3, g: 0.58, h: 0.56, i: 0.24, j: 0.24, k: 0.48, l: 0.24, m: 0.85,
  n: 0.56, o: 0.58, p: 0.58, q: 0.58, r: 0.35, s: 0.43, t: 0.33, u: 0.56, v: 0.48, w: 0.74, x: 0.47, y: 0.48, z: 0.45,
}
export function textW(s, size = 12, weight = 400, spacing = 0) {
  let em = 0
  for (const ch of String(s)) em += EM[ch] ?? (ch >= '0' && ch <= '9' ? 0.559 : 0.6)
  return (em * size * (weight >= 600 ? 1.05 : 1) + spacing * String(s).length) * 1.04
}
const runsW = (parts) => parts.reduce((a, p) => a + (p.dx || 0) + textW(p.s, p.size || 12, p.weight || 400, p.spacing || 0), 0)
// The first candidate no wider than `max` (null when none fits). Candidates are strings, or
// run arrays measured whole.
const fit = (cands, max, measure) => cands.find((c) => c != null && measure(c) <= max) ?? null

function text(x, y, s, { size = 12, weight = 400, fill = P.mid, anchor = 'start', spacing = 0 } = {}) {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc(s)}</text>`
}
const label = (x, y, s) => text(x, y, s, { size: 10, weight: 600, fill: '#8a887f', spacing: 0.9 })
const labelW = (s) => textW(s, 10, 600, 0.9)

// One <text> of styled runs, laid out by the renderer: [{ s, size, weight, fill, dx, spacing }].
function runs(x, y, parts, anchor = 'start') {
  const spans = parts.map((p) => `<tspan${p.dx ? ` dx="${p.dx}"` : ''} font-size="${p.size || 12}" font-weight="${p.weight || 400}" fill="${p.fill || P.mid}"${p.spacing ? ` letter-spacing="${p.spacing}"` : ''}>${esc(p.s)}</tspan>`).join('')
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}">${spans}</text>`
}
const LABEL = { size: 10, weight: 600, fill: '#8a887f', spacing: 0.9 }

// A pill: soft tint of its color behind colored text, optional leading dot.
const PILL = 10.5
const pillW = (s, dot) => textW(s, PILL, 600) + (dot ? 24 : 16)
function pill(xRight, y, s, color, { dot = false } = {}) {
  const w = pillW(s, dot)
  const x = xRight - w
  return `<rect x="${x.toFixed(1)}" y="${y - 12}" width="${w.toFixed(1)}" height="18" rx="9" fill="${color}" fill-opacity="0.16"/>` +
    (dot ? `<circle cx="${(x + 10).toFixed(1)}" cy="${y - 3}" r="3" fill="${color}"/>` : '') +
    text(dot ? x + 17 : x + w / 2, y + 1, s, { size: PILL, weight: 600, fill: color, anchor: dot ? 'start' : 'middle' })
}

function frame(w, h, body, defs = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#21252d"/><stop offset="1" stop-color="#181b20"/></linearGradient>${defs}</defs>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14" fill="url(#bg)" stroke="#ffffff" stroke-opacity="0.07"/>
${body}</svg>`
}

// ------------------------------------------------------------------ cards

// Each card lays itself out for the width it is given: labels and secondary figures fall back
// to shorter forms, then drop, so nothing overlaps when the band narrows (a pane open beside it).

function usageSvg(m, w) {
  const inner = w - 36
  const vals = (m.series || []).slice(-14).map((d) => d.cost)
  const head = fit(['TODAY · ALL SESSIONS', 'TODAY'], inner, labelW) || 'TODAY'
  const err = m.histError && !(m.series || []).length
  const big = fmt.usd(m.todayCost)
  const bigSize = Math.max(18, Math.min(26, 26 * (inner * 0.6) / textW(big, 26, 600)))
  const tok = `${fmt.tokens(m.todayTokens)} tokens`
  const all = [{ s: 'All time', size: 11, fill: P.low }, { s: fmt.usd(m.totalCost), dx: 5, size: 11, weight: 600, fill: P.mid }]
  const leftW = err ? 0 : Math.max(textW(big, bigSize, 600), textW(tok, 12), runsW(all))
  // The sparkline takes what the figures leave, and drops out when that is too little.
  const sx = Math.round(Math.max(w * 0.5, 18 + leftW + 16)), sw = w - sx - 18, sy = 36, sh = 46
  const showSpark = !err && sw >= 48 && vals.length > 0
  let body = label(18, 28, head) +
    (err
      ? text(18, 62, fmt.truncate(m.histError, Math.floor(inner / 6.5)), { size: 12, fill: P.amber })
      : text(18, 62, big, { size: +bigSize.toFixed(1), weight: 600, fill: P.hi }) + text(18, 82, tok, { size: 12 })) +
    runs(18, 104, all)
  if (showSpark) {
    const max = Math.max(...vals, 0) || 1
    const step = vals.length > 1 ? sw / (vals.length - 1) : sw
    const pts = vals.map((v, i) => [sx + i * step, sy + sh - (v / max) * (sh - 4)])
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
    const last = pts[pts.length - 1]
    body += `<path d="${line} L${(sx + sw).toFixed(1)},${sy + sh} L${sx},${sy + sh} Z" fill="url(#sp)"/>
<path d="${line}" fill="none" stroke="${P.blueLight}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.2" fill="${P.blueLight}" stroke="#1b1e24" stroke-width="1.5"/>` +
      `<line x1="${sx}" x2="${sx + sw}" y1="${sy + sh + 0.5}" y2="${sy + sh + 0.5}" stroke="#ffffff" stroke-opacity="0.06"/>` +
      text(sx + sw, sy + sh + 14, sw >= 70 ? '14 days' : '14d', { size: 9.5, fill: P.low, anchor: 'end' })
  }
  return frame(w, CARD_H, body, `<linearGradient id="sp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.blue}" stop-opacity="0.45"/><stop offset="1" stop-color="${P.blue}" stop-opacity="0"/></linearGradient>`)
}

function contextSvg(m, w) {
  const inner = w - 36
  const c = m.ctx
  const soft = c ? c.soft : m.softLimit || 240_000
  const win = c ? c.window : m.ctxWindow || 1_000_000
  const used = c ? c.used : 0
  const over = used > soft
  const mx = 18, mw = inner, my = 86, mh = 8
  const x = (v) => mx + Math.max(0, Math.min(mw, (v / win) * mw))
  const sx = x(soft)
  const okEnd = x(Math.min(used, soft))

  // Header: the label, and a quiet note on the right (a dot and words, not a chip).
  const pct = `${Math.round((used / win) * 100)}%`
  const dotRun = { s: '●', size: 8, fill: P.amber }
  const notes = !c ? [] : over
    ? [[dotRun, { s: 'Over soft limit', dx: 5, size: 10.5, weight: 500, fill: P.amber }], [dotRun, { s: 'Over', dx: 5, size: 10.5, weight: 500, fill: P.amber }]]
    : [[{ s: `${pct} used`, size: 10.5, weight: 500, fill: P.teal }], [{ s: pct, size: 10.5, weight: 500, fill: P.teal }]]
  const head = fit(['CONTEXT WINDOW', 'CONTEXT'], inner, labelW) || 'CONTEXT'
  const note = fit(notes, inner - labelW(head) - 12, runsW)
  let body = label(18, 28, head) + (note ? runs(w - 18, 28, note, 'end') : '')

  if (!c) {
    body += text(18, 60, fit(['Waiting for the first response', 'Waiting…'], inner, (s) => textW(s, 13)) || '', { size: 13, fill: P.mid })
  } else {
    const fig = [{ s: fmt.tokens(used), size: 26, weight: 600, fill: P.hi }, { s: `/ ${fmt.tokens(win)}`, dx: 7, size: 13, fill: P.low }]
    const lead = runsW(fig) <= inner ? fig : fig.slice(0, 1)
    const free = fit([`${fmt.tokens(Math.max(0, win - used))} free`], inner - runsW(lead) - 14, (s) => textW(s, 12))
    body += runs(18, 60, lead) + (free ? text(w - 18, 60, free, { size: 12, fill: P.mid, anchor: 'end' }) : '')
  }

  // Meter: teal within the soft limit, hatched slate past it. An amber ▼ above the bar points
  // down at the limit, its figure beside it (to the left when the limit sits near the end).
  const limitTxt = fmt.tokens(soft)
  const tri = 5
  const flip = sx + tri + 6 + textW(limitTxt, 10, 600) > w - 10
  body += `<rect x="${mx}" y="${my}" width="${mw}" height="${mh}" rx="4" fill="#2b3039"/>
<g clip-path="url(#mc)">
${used > 0 ? `<rect x="${mx}" y="${my}" width="${(okEnd - mx).toFixed(1)}" height="${mh}" fill="url(#ok)"/>` : ''}
${over ? `<rect x="${sx.toFixed(1)}" y="${my}" width="${(x(used) - sx).toFixed(1)}" height="${mh}" fill="url(#ov)"/>` : ''}
<rect x="${(sx - 0.75).toFixed(1)}" y="${my}" width="1.5" height="${mh}" fill="${P.amber}"/>
</g>
<path d="M${(sx - tri).toFixed(1)},${my - 9} L${(sx + tri).toFixed(1)},${my - 9} L${sx.toFixed(1)},${my - 2.5} Z" fill="${P.amber}" stroke="${P.amber}" stroke-width="1" stroke-linejoin="round"/>` +
    text(flip ? sx - tri - 5 : sx + tri + 5, my - 2.5, limitTxt, { size: 10, weight: 600, fill: P.amber, anchor: flip ? 'end' : 'start' })

  // Footer: distance to (or past) the limit, then the limit itself if there is room.
  const dist = !c ? null : over ? `${fmt.tokens(used - soft)} past ${limitTxt}` : `${fmt.tokens(soft - used)} to ${limitTxt}`
  const distW = dist ? textW(dist, 11) : 0
  const lim = fit([`${limitTxt} soft limit`, `limit ${limitTxt}`], inner - distW - 14, (s) => textW(s, 11))
  if (dist) body += text(18, 108, dist, { size: 11, fill: over ? P.amber : P.low })
  if (lim) body += text(w - 18, 108, lim, { size: 11, fill: P.low, anchor: 'end' })
  return frame(w, CARD_H, body, `<linearGradient id="ok" x1="0" x2="1"><stop offset="0" stop-color="${P.tealDeep}"/><stop offset="1" stop-color="${P.teal}"/></linearGradient>
<pattern id="ov" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${P.slate}"/><rect width="2.5" height="6" fill="#585c66"/></pattern>
<clipPath id="mc"><rect x="${mx}" y="${my}" width="${mw}" height="${mh}" rx="4"/></clipPath>`)
}

function cacheSvg(m, w) {
  const inner = w - 36
  const c = m.cache
  const s = cacheStatus(c, m.now)
  const has = !!(c && c.lastTs)
  const ttlMs = c ? c.ttlMs : m.ttlMs
  const ttl = ttlMs >= 3_600_000 ? '1h TTL' : '5m TTL'
  const turn = m.turn && m.turn.requests ? m.turn : null

  // Header: label, TTL chip and status pill; the label shortens, then the chip goes.
  const pw = pillW(s.word, true)
  const chipW = textW(ttl, 9.5, 600) + 14
  const head = fit(['PROMPT CACHE', 'CACHE'], inner - pw - 10 - chipW - 8, labelW)
  let body = label(18, 28, head || fit(['PROMPT CACHE', 'CACHE'], inner - pw - 10, labelW) || '')
  if (head) {
    const hx = 18 + labelW(head) + 8
    body += `<rect x="${hx.toFixed(1)}" y="16" width="${chipW.toFixed(1)}" height="17" rx="8.5" fill="#2c3039"/>` +
      text(hx + chipW / 2, 28, ttl, { size: 9.5, weight: 600, fill: P.mid, anchor: 'middle' })
  }
  body += pill(w - 18, 28, s.word, s.color, { dot: true })

  // The ticking countdown and drain meter are native elements in the strip above the cards
  // (see liveStrip), which the host updates in place. The image holds only what changes with
  // a request or a status change, so it stays still while the seconds run.
  const fx = 18
  const froom = w - 18 - fx
  if (has) {
    const at = c.lastTs + c.ttlMs
    const zone = fmt.zone(at)
    const big = [{ s: fmt.clock(at), size: 26, weight: 600, fill: s.remaining > 0 ? P.hi : P.mid }, ...(zone ? [{ s: zone, dx: 6, size: 13, weight: 600, fill: P.mid }] : [])]
    const lead = s.remaining > 0 ? 'EXPIRES' : 'EXPIRED'
    const from = fmt.clock(c.warmSince || c.lastTs), hit = fmt.clock(c.lastTs)
    body += label(fx, 52, lead) + runs(fx + labelW(lead) + 10, 54, big)
    const sub = fit([`Started ${from} · last hit ${hit}`, `Since ${from} · hit ${hit}`, `Since ${from}`], froom, (t) => textW(t, 11))
    if (sub) body += text(fx, 78, sub, { size: 11, fill: P.low })
  } else {
    body += text(fx, 60, fit(['Starts with the first response', 'Starts on reply', 'Idle'], froom, (t) => textW(t, 13)) || '', { size: 13, fill: P.mid })
  }

  // Footer: the turn's tokens and cost, then the request count if there is room. Under the
  // figures on a wide card; from the left edge on a narrow one.
  const lab = (long) => ({ ...LABEL, s: long ? (turn && turn.running ? 'THIS TURN' : 'LAST TURN') : 'TURN' })
  if (turn) {
    const tok = fmt.tokens(turn.tokens), usd = fmt.usd(turn.cost)
    const v = (t, dx) => ({ s: t, dx, size: 11.5, weight: 600, fill: P.hi })
    const dot = { s: '·', dx: 6, size: 11.5, fill: P.low }
    const line = fit([
      [lab(true), v(`${tok} tok`, 10), dot, v(usd, 6)],
      [lab(false), v(`${tok} tok`, 8), dot, v(usd, 6)],
      [lab(false), v(tok, 8), dot, v(usd, 6)],
      [lab(false), v(usd, 8)],
    ], froom, runsW) || [v(usd, 0)]
    const req = fit([`${turn.requests} req`], froom - runsW(line) - 12, (t) => textW(t, 11))
    body += runs(fx, 106, line) + (req ? text(w - 18, 106, req, { size: 11, fill: P.low, anchor: 'end' }) : '')
  } else {
    body += runs(fx, 106, [lab(true), { s: '–', dx: 10, size: 11.5, fill: P.low }])
  }
  return frame(w, CARD_H, body)
}

// ------------------------------------------------------------------ breakdown

// The breakdown lays out for its pane: on a narrow one (the usual docked pane) the day's
// summary takes its own line and each session row puts its bar under the title, so the type
// stays full size instead of the whole image scaling down.
function breakdownSvg(m, w, compact) {
  const series = m.series
  const inner = w - 36
  const narrow = w < 520
  const vals = series.map((d) => (m.metric === 'cost' ? d.cost : d.tokens))
  const max = Math.max(...vals, 0) || 1
  const lab = (v) => (v === 0 ? (m.metric === 'cost' ? '$0' : '0') : m.metric === 'cost' ? fmt.usd(v) : fmt.tokens(v))
  const sel = series.find((d) => d.day === m.day) || { cost: 0, tokens: 0, requests: 0 }
  const rows = ((m.sessionsByDay && m.sessionsByDay[m.day]) || []).slice(0, compact ? 8 : 16)
  const AX = 10.5

  // Header: the label, then the selected day's figures beside it, or on a line of their own.
  const head = m.metric === 'cost' ? 'DAILY COST' : 'DAILY TOKENS'
  const day = fmt.shortDay(m.day)
  const sum = [
    { s: day, size: 12, weight: 600, fill: P.coral },
    { s: fmt.usd(sel.cost), dx: 8, size: 12, weight: 600, fill: P.hi },
    { s: `${fmt.tokens(sel.tokens)} tokens`, dx: 8, size: 12, fill: P.mid },
    { s: `${sel.requests} req`, dx: 8, size: 12, fill: P.low },
  ]
  const inline = runsW(sum) <= inner - labelW(head) - 16
  let body = label(18, 28, head)
  let top
  if (inline) {
    body += runs(w - 18, 28, sum, 'end')
    top = 52
  } else {
    body += runs(18, 50, runsW(sum) <= inner ? sum : sum.slice(0, 3))
    top = 72
  }

  const ch = compact ? 110 : narrow ? 130 : 150
  const padL = 18 + Math.max(textW(lab(max), AX), textW(lab(max / 2), AX)) + 10, padR = 18
  const pw = w - padL - padR, bw = pw / series.length
  const y = (v) => top + ch * (1 - v / max)
  body += [0, 0.5, 1].map((p) => `<line x1="${padL}" x2="${w - padR}" y1="${y(max * p).toFixed(1)}" y2="${y(max * p).toFixed(1)}" stroke="#ffffff" stroke-opacity="${p ? 0.05 : 0.1}"/>` +
    text(padL - 8, y(max * p) + 3.5, lab(max * p), { size: AX, fill: P.low, anchor: 'end' })).join('')
  body += series.map((d, i) => {
    const v = vals[i]
    const x = padL + i * bw + bw * 0.18
    const wb = Math.max(2, bw * 0.64)
    const isSel = d.day === m.day
    if (v <= 0) return `<rect x="${x.toFixed(1)}" y="${(top + ch - 2).toFixed(1)}" width="${wb.toFixed(1)}" height="2" rx="1" fill="${isSel ? P.coral : '#2b3039'}"/>`
    const bh = Math.max(3, top + ch - y(v))
    const t = top + ch - bh
    const tag = lab(v), tw = textW(tag, AX, 600)
    const tagX = Math.max(padL + tw / 2, Math.min(w - padR - tw / 2, x + wb / 2))
    return `<rect x="${x.toFixed(1)}" y="${t.toFixed(1)}" width="${wb.toFixed(1)}" height="${bh.toFixed(1)}" rx="${Math.min(3.5, wb / 2).toFixed(1)}" fill="url(#${isSel ? 'cs' : 'cb'})"/>` +
      (isSel ? text(tagX, Math.max(top - 4, t - 6), tag, { size: AX, weight: 600, fill: P.coral, anchor: 'middle' }) : '')
  }).join('')
  const xi = [0, Math.floor((series.length - 1) / 2), series.length - 1]
  body += xi.map((i, k) => text(k === 0 ? padL : k === 2 ? w - padR : padL + i * bw + bw / 2, top + ch + 17, fmt.shortDay(series[i].day), { size: AX, fill: P.low, anchor: k === 0 ? 'start' : k === 2 ? 'end' : 'middle' })).join('')

  // Sessions on the selected day, with the legend beside the heading or under it.
  let sy = top + ch + 46
  const heading = `SESSIONS · ${day.toUpperCase()}`
  const legend = [['main', P.blue], ['subagents', P.violet], ['this session', P.coral]].flatMap(([name, color], i) => [
    { s: '●', dx: i ? 12 : 0, size: 8, fill: color }, { s: name, dx: 5, size: 10.5, fill: P.mid },
  ])
  body += label(18, sy, heading)
  if (runsW(legend) <= inner - labelW(heading) - 16) body += runs(w - 18, sy, legend, 'end')
  else { sy += 18; body += runs(18, sy, legend) }
  sy += 12

  const key = m.metric === 'cost' ? 'cost' : 'tokens'
  const rmax = Math.max(...rows.map((r) => r[key]), 0) || 1
  const figure = (r) => (key === 'cost' ? `${fmt.usd(r.cost)} · ${fmt.tokens(r.tokens)}` : `${fmt.tokens(r.tokens)} · ${fmt.usd(r.cost)}`)
  const valW = Math.max(0, ...rows.map((r) => textW(figure(r), 12, 600)))
  const rh = narrow ? 42 : 28
  if (!rows.length) {
    body += text(18, sy + 18, 'No usage recorded on this day.', { size: 12, fill: P.mid })
    sy += 30
  }
  // Wide: title | bar | figures on one line. Narrow: title and figures, the bar under them.
  const titleMax = narrow ? inner - 14 - valW - 12 : Math.min(300, w * 0.36)
  const barX = narrow ? 32 : 18 + 14 + titleMax + 12
  const barW = narrow ? w - 18 - barX : Math.max(40, w - barX - valW - 30)
  const clip = (s) => {
    let t = String(s || '')
    if (textW(t, 12.5) <= titleMax) return t
    while (t.length > 1 && textW(t + '…', 12.5) > titleMax) t = t.slice(0, -1)
    return t + '…'
  }
  rows.forEach((r, i) => {
    const ry = sy + i * rh
    const cur = r.id === m.currentSessionId
    const total = (r[key] / rmax) * barW
    const sub = key === 'cost' && r.cost > 0 ? total * Math.min(1, (r.subagentCost || 0) / r.cost) : 0
    const by = narrow ? ry + 26 : ry + 10, bh = narrow ? 6 : 8
    if (i % 2) body += `<rect x="8" y="${ry}" width="${w - 16}" height="${rh}" rx="8" fill="#ffffff" fill-opacity="0.025"/>`
    body += `<circle cx="22" cy="${ry + 14}" r="3" fill="${cur ? P.coral : r.id === '_other' ? P.low : P.blue}"/>` +
      text(32, ry + 18.5, clip(r.title), { size: 12.5, fill: r.id === '_other' ? P.mid : P.hi }) +
      `<rect x="${barX.toFixed(1)}" y="${by}" width="${barW.toFixed(1)}" height="${bh}" rx="${bh / 2}" fill="#2b3039"/>` +
      `<rect x="${barX.toFixed(1)}" y="${by}" width="${Math.max(bh, total - sub).toFixed(1)}" height="${bh}" rx="${bh / 2}" fill="${cur ? P.coral : P.blue}"/>` +
      (sub > 1 ? `<rect x="${(barX + total - sub).toFixed(1)}" y="${by}" width="${sub.toFixed(1)}" height="${bh}" rx="${bh / 2}" fill="${P.violet}"/>` : '') +
      text(w - 18, ry + 18.5, figure(r), { size: 12, weight: 600, fill: P.mid, anchor: 'end' })
  })
  const h = sy + rows.length * rh + 14
  return frame(w, Math.round(h), body, `<linearGradient id="cb" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${P.blueDeep}"/><stop offset="1" stop-color="${P.blueLight}"/></linearGradient>
<linearGradient id="cs" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${P.coralDeep}"/><stop offset="1" stop-color="${P.coral}"/></linearGradient>`)
}

function controls(el, m, h) {
  return row(el, [
    el.Button({ key: 'm-cost', label: 'Cost', plain: true, dimColor: m.metric !== 'cost', onPress: () => h.metric('cost') }),
    el.Button({ key: 'm-tok', label: 'Tokens', plain: true, dimColor: m.metric !== 'tokens', onPress: () => h.metric('tokens') }),
    el.Box({ width: 2 }),
    el.Button({ key: 'prev', label: '‹  Prev', plain: true, onPress: h.prevDay }),
    el.Button({ key: 'today', label: 'Today', plain: true, onPress: h.today }),
    el.Button({ key: 'next', label: 'Next  ›', plain: true, onPress: h.nextDay }),
    el.Box({ flexGrow: 1 }),
  ], { columnGap: 2 })
}

export function desktopBreakdown(el, m, h, columns, compact) {
  if (!m.series || !m.series.length) {
    return el.Svg({ source: frame(Math.round(Math.max(280, columns * PX_PER_COL)), 60, label(18, 28, 'DAILY') + text(18, 46, m.histError || 'Reading history…', { size: 12, fill: P.mid })), alt: 'Daily usage: reading history', height: 60 })
  }
  const w = Math.round(Math.max(280, columns * PX_PER_COL))
  return col(el, [
    controls(el, m, h),
    el.Svg({ source: breakdownSvg(m, w, compact), alt: `Daily ${m.metric} for the last ${m.series.length} days, and sessions on ${fmt.shortDay(m.day)}` }),
  ], { rowGap: 1 })
}

// ------------------------------------------------------------------ sites

function cards(el, m, columns) {
  // No floor near the real width: a card wider than its slot is scaled down, type and all.
  const total = Math.max(420, columns * PX_PER_COL)
  const avail = total - GAP_PX * 2
  const w1 = Math.round(avail * 0.3), w2 = Math.round(avail * 0.36), w3 = Math.round(avail - w1 - w2)
  const c = m.ctx
  const s = cacheStatus(m.cache, m.now)
  const svg = (source, alt) => el.Svg({ source, alt })
  const usage = svg(usageSvg(m, w1), `Today across all sessions: ${fmt.usd(m.todayCost)}, ${fmt.tokens(m.todayTokens)} tokens`)
  const ctx = svg(contextSvg(m, w2), c ? `Context ${fmt.tokens(c.used)} of ${fmt.tokens(c.window)}, soft limit ${fmt.tokens(c.soft)}` : 'Context: waiting for the first response')
  const cache = svg(cacheSvg(m, w3), m.cache ? `Prompt cache ${s.word}, expires ${fmt.clockZ(m.cache.lastTs + m.cache.ttlMs)}` : 'Prompt cache idle')
  return [usage, ctx, cache]
}

// The live part of the cache card: native Text the host diffs in place, so the seconds can
// tick every redraw without repainting any image. A block-character drain meter stands in for
// the old ring.
const METER_CELLS = 14
function liveStrip(el, m) {
  const c = m.cache
  const s = cacheStatus(c, m.now)
  if (!c || !c.lastTs) return el.Text({ color: P.low, children: ['cache starts with the first response'] })
  if (s.remaining <= 0) return el.Text({ color: P.coral, bold: true, children: ['cache expired · next prompt re-reads context'] })
  const on = Math.max(1, Math.round(s.frac * METER_CELLS))
  return el.Text({
    wrap: 'truncate',
    children: [
      el.Text({ color: P.hi, bold: true, children: [countdown(s.remaining, m.tickSeconds === false)] }),
      el.Text({ color: P.mid, children: [' left  '] }),
      el.Text({ color: s.color, children: ['▰'.repeat(on)] }),
      el.Text({ color: P.track, children: ['▱'.repeat(METER_CELLS - on)] }),
    ],
  })
}

// The cache guard's switch: its state is the label, so it reads as an indicator too.
export function guardButton(el, m, h) {
  return el.Button({ key: 'guard', label: m.guard ? 'Cache guard  ● ON' : 'Cache guard  ○ OFF', plain: true, onPress: h.guard })
}

// The band holds the three cards only. Desktop gives the band little height, so the breakdown
// opens on demand in its own pane rather than pushing the cards out of view. A slim strip above
// the cards lines the controls up with them: the breakdown button over the usage card, the
// cache guard under the context card's column, and the live countdown over the cache card.
export function desktopBand(el, m, h, columns) {
  const [usage, ctx, cache] = cards(el, m, columns)
  return col(el, [
    row(el, [
      el.Box({ width: '30%', children: [el.Button({ key: 'toggle', label: m.paneOpen ? 'Hide breakdown  ‹' : 'Breakdown  ›', plain: true, onPress: h.toggle })] }),
      el.Box({ width: '36%', flexDirection: 'row', children: [el.Box({ flexGrow: 1 }), guardButton(el, m, h)] }),
      el.Box({ width: '34%', paddingLeft: 2, alignItems: 'center', children: [liveStrip(el, m)] }),
    ], { columnGap: 1 }),
    row(el, [
      el.Box({ width: '30%', children: [usage] }),
      el.Box({ width: '36%', children: [ctx] }),
      el.Box({ width: '34%', children: [cache] }),
    ], { columnGap: 1 }),
  ], { rowGap: 0 })
}

// The breakdown pane: the cards stay in the band, so the pane holds the breakdown alone.
export function desktopPane(el, m, h, columns) {
  return col(el, [
    desktopBreakdown(el, m, h, columns, false),
    row(el, [el.Box({ flexGrow: 1 }), el.Button({ key: 'close', label: '✕ Close', plain: true, onPress: h.toggle })]),
  ], { rowGap: 1 })
}
