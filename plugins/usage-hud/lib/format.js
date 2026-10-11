// Number and time formatting shared by the hooks module and the scanner.

export function tokens(n) {
  n = n || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K'
  return String(Math.round(n))
}

export function usd(n) {
  n = n || 0
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US')
  if (n >= 100) return '$' + n.toFixed(0)
  if (n >= 1) return '$' + n.toFixed(2)
  return '$' + n.toFixed(3)
}

export function duration(ms) {
  if (ms <= 0) return '0:00'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

export function clock(ts, withSeconds = false) {
  const d = new Date(ts)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return withSeconds ? `${hm}:${String(d.getSeconds()).padStart(2, '0')}` : hm
}

// The viewer's own time zone as a short name: ET, CT, MT, PT for the US zones, otherwise what
// Intl gives (UTC, GMT+1, IST). Empty when the runtime has no Intl.
const US_ZONES = { EST: 'ET', EDT: 'ET', CST: 'CT', CDT: 'CT', MST: 'MT', MDT: 'MT', PST: 'PT', PDT: 'PT' }
export function zone(ts) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date(ts)).find((p) => p.type === 'timeZoneName')
    const name = part ? part.value : ''
    return US_ZONES[name] || name
  } catch {
    return ''
  }
}

// "18:20 ET": the local clock time with its zone.
export function clockZ(ts, withSeconds = false) {
  const z = zone(ts)
  return clock(ts, withSeconds) + (z ? ' ' + z : '')
}

export function localDay(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// "2026-10-03" -> "Oct 3"
export function shortDay(day) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function truncate(s, n) {
  s = String(s || '')
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…'
}
