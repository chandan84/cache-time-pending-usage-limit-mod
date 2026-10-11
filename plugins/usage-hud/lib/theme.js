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

// A live m:ss (h:mm:ss from an hour) countdown. `coarse` shows whole minutes only ("49m", then
// "<1m"), so the band changes once a minute: every redraw makes Desktop's buttons flicker.
export function countdown(ms, coarse = false) {
  if (ms <= 0) return '0:00'
  if (!coarse) return fmt.duration(ms)
  return ms >= 60_000 ? `${Math.ceil(ms / 60_000)}m` : '<1m'
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
// this string changes: every second while the cache counts down, once a minute with
// `tickSeconds: false`, and not at all once it is cold or idle.
export function tickKey(m) {
  const s = cacheStatus(m.cache, m.now)
  const coarse = m.tickSeconds === false
  // Desktop's drain meter is 14 cells, so only a cell's worth of change needs a redraw.
  return `${s.label}|${countdown(s.remaining, coarse)}|${coarse ? Math.round(s.frac * 14) : s.frac}`
}
