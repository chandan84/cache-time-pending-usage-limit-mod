#!/usr/bin/env node
// Dev tool: render the band (collapsed and expanded) and the pane as an HTML page, using your
// real usage data, to review the Desktop look without a Desktop build that loads mods.
//
//   node tools/preview.mjs [out.html]
//
// Elements map to HTML the way a flex UI draws them: Box -> div (flex), Text -> span,
// Svg -> img, Button -> button. One layout column is drawn 7.2px wide, as the mod assumes.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { band, pane, P } from '../plugins/usage-hud/lib/view.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const snap = JSON.parse(execFileSync(process.execPath, [path.join(here, '../plugins/usage-hud/scripts/scan.mjs'), '--ttl', '1h'], { encoding: 'utf8' }))
const s = snap.session

const now = Date.now()
const model = (expanded, surface) => ({
  surface, now, expanded, metric: 'cost', day: snap.today, currentSessionId: snap.latestSessionId,
  todayCost: snap.todayAgg.cost, todayTokens: snap.todayAgg.tokens, totalCost: snap.total.cost,
  series: snap.series, sessionsByDay: snap.sessionsByDay, histError: null,
  ctx: s ? { used: s.contextTokens, window: s.contextWindow, soft: 240_000 } : null,
  ctxWindow: s ? s.contextWindow : 1_000_000, softLimit: 240_000, ttlMs: s ? s.ttlMs : 3_600_000,
  cache: s ? { lastTs: s.lastRequestTs, warmSince: s.warmSince, ttlMs: s.ttlMs, active: false } : null,
  turn: s ? { ...s.lastTurn, running: false } : null,
})

const mk = (type) => (props) => ({ type, props })
const EL = { Box: mk('Box'), Text: mk('Text'), Button: mk('Button'), Svg: mk('Svg') }
const H = { toggle() {}, metric() {}, prevDay() {}, nextDay() {}, today() {} }
const COL = 7.2
const escH = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;')

function html(n) {
  if (n == null) return ''
  if (typeof n === 'string') return escH(n)
  const p = n.props || {}
  const kids = (p.children || []).map(html).join('')
  if (n.type === 'Text') {
    const st = [p.color && `color:${p.color}`, p.backgroundColor && `background:${p.backgroundColor}`, p.bold && 'font-weight:700', p.dimColor && 'opacity:.55']
    return `<span style="${st.filter(Boolean).join(';')}">${kids}</span>`
  }
  if (n.type === 'Button') return `<button style="${p.dimColor ? 'opacity:.5' : ''}">${escH(p.label)}</button>`
  if (n.type === 'Svg') return `<img alt="${escH(p.alt)}" src="data:image/svg+xml;utf8,${encodeURIComponent(p.source)}"${p.height ? ` height="${p.height}"` : ''}>`
  const st = [
    'display:flex', `flex-direction:${p.flexDirection || 'row'}`,
    p.flexGrow && `flex-grow:${p.flexGrow}`, p.backgroundColor && `background:${p.backgroundColor}`,
    p.paddingX && `padding:${p.paddingY ? p.paddingY * 4 : 6}px ${p.paddingX * COL}px`,
    p.paddingLeft && `padding-left:${p.paddingLeft * COL}px`,
    p.width && `width:${typeof p.width === 'number' ? p.width * COL + 'px' : p.width}`,
    p.columnGap && `column-gap:${p.columnGap * COL}px`, p.rowGap && `row-gap:${p.rowGap * 8}px`,
    p.backgroundColor && 'border-radius:10px', 'align-items:' + (p.flexDirection === 'row' ? 'center' : 'stretch'), 'min-width:0',
  ]
  return `<div style="${st.filter(Boolean).join(';')}">${kids}</div>`
}

const cols = 150
const page = `<!doctype html><meta charset="utf-8"><title>usage-hud preview</title>
<style>
body{margin:0;padding:28px;background:#f4f2ee;font:13px/1.55 Inter,'Segoe UI',system-ui,sans-serif}
h2{font:600 12px Inter,'Segoe UI',sans-serif;color:#77756f;letter-spacing:.06em;text-transform:uppercase;margin:28px 0 10px}
.frame{width:${cols * COL}px;padding:16px;border-radius:14px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.dark{background:#141519}
button{font:inherit;color:${P.blueLight};background:none;border:0;padding:0 4px;cursor:pointer}
span{white-space:pre}
img{max-width:100%;height:auto;display:block}
.prompt{margin-top:10px;border:1px solid #ddd;border-radius:12px;padding:12px;color:#999}
.dark .prompt{border-color:#333}
</style>
<h2>Band · Desktop · light app theme</h2><div class="frame">${html(band(EL, model(false, 'desktop'), H, cols, 30))}<div class="prompt">Reply to Claude…</div></div>
<h2>Band · Desktop · dark app theme</h2><div class="frame dark">${html(band(EL, model(false, 'desktop'), H, cols, 30))}<div class="prompt">Reply to Claude…</div></div>
<h2>Band · Desktop · narrow (breakdown pane open beside it)</h2><div class="frame dark" style="width:${90 * COL}px">${html(band(EL, model(false, 'desktop'), H, 90, 30))}</div>
<h2>Band · Desktop · very narrow</h2><div class="frame dark" style="width:${62 * COL}px">${html(band(EL, model(false, 'desktop'), H, 62, 30))}</div>
<h2>Breakdown pane · Desktop · docked</h2><div class="frame dark" style="width:${50 * COL}px">${html(pane(EL, model(true, 'desktop'), H, 50))}</div>
<h2>Breakdown pane · Desktop · wide</h2><div class="frame dark" style="width:${110 * COL}px">${html(pane(EL, model(true, 'desktop'), H, 110))}</div>`

const out = process.argv[2] || path.join(here, '..', 'preview.html')
fs.writeFileSync(out, page)
console.log(out)
