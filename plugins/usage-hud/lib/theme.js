// Shared by the terminal (view.js) and Desktop (desktop.js) renderers: the matte palette and
// the time-dependent cache state.

import * as fmt from './format.js'

// Matte palette. Card surfaces are dark in every theme; hues are desaturated mid-tones.
export const P = {
  card: '#1b1e24',
  raised: '#23272f',
  track: '#2f343e',
  zebra: '#20242b',
  hi: '#eceae4',
  mid: '#a6a49c',
  low: '#6d6c67',
  blue: '#6f93db',
  blueDeep: '#34518c',
  blueLight: '#b3c8f2',
  teal: '#4fae98',
  tealDeep: '#2b7465',
  amber: '#d9a54b',
  coral: '#d9785e',
  coralDeep: '#9c4d39',
  violet: '#9a87d6',
  slate: '#6b707c',
}

// The countdown shows whole minutes until the last two, then m:ss. Together with tickKey()
// this keeps the band from redrawing every second: on Desktop each redraw repaints the
// band's SVGs, which read as flicker.
export function countdown(ms) {
  if (ms <= 0) return '0:00'
  return ms >= 120_000 ? `${Math.ceil(ms / 60_000)}m` : fmt.duration(ms)
}

// Counts down from the last request: each request (mid-turn too) re-warms the cache.
export function cacheStatus(cache, now) {
  if (!cache || !cache.lastTs) return { label: 'IDLE', word: 'Idle', color: P.slate, remaining: 0, frac: 0 }
  const remaining = cache.lastTs + cache.ttlMs - now
  if (remaining <= 0) return { label: '○ COLD', word: 'Cold', color: P.coral, remaining: 0, frac: 0 }
  // Whole-percent steps, so the ring's SVG source holds still between minutes.
  const frac = Math.round((remaining / cache.ttlMs) * 100) / 100
  if (remaining < Math.min(5 * 60_000, cache.ttlMs * 0.2)) return { label: '● EXPIRING', word: 'Expiring', color: P.amber, remaining, frac }
  return { label: '● WARM', word: 'Warm', color: P.teal, remaining, frac }
}

// Everything time-dependent the band shows. The hooks module redraws on a timer only when
// this string changes.
export function tickKey(m) {
  const s = cacheStatus(m.cache, m.now)
  return `${s.label}|${countdown(s.remaining)}|${s.frac}`
}
