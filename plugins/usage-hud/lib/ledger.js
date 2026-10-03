// Turns Claude Code transcript lines (~/.claude/projects/**/*.jsonl) into per-request usage
// records and aggregates them. Pure: the caller feeds it lines, so it runs in the scanner
// (Node) and in tests alike.
//
// Transcript quirks:
//  - One API response is written as several lines (one per content block), each repeating
//    the usage object. Records are keyed on message.id + requestId; the last line wins, since
//    it carries the final output_tokens.
//  - Subagent transcripts live under <session>/subagents/ and carry the parent sessionId.

import { createPricer, normalizeUsage, totalTokens, contextTokens } from './pricing.js'
import { localDay } from './format.js'

export const HOUR = 3_600_000
export const FIVE_MIN = 300_000

function basename(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''
}

export function isHumanPrompt(line) {
  if (line.type !== 'user' || line.isMeta || line.isSidechain) return false
  const c = line.message && line.message.content
  if (typeof c === 'string') return !c.startsWith('<local-command-stdout>') && !c.startsWith('<local-command-caveat>')
  if (Array.isArray(c)) return c.some((b) => b.type === 'text') && !c.some((b) => b.type === 'tool_result')
  return false
}

// Record tuple layout (compact for the on-disk cache):
// [ts, sessionId, model, input, output, cacheRead, cacheWrite5m, cacheWrite1h, sidechain(0|1), speed]
const R = { ts: 0, sid: 1, model: 2, input: 3, output: 4, cacheRead: 5, w5m: 6, w1h: 7, side: 8, speed: 9 }

const usageOf = (r) => ({ input: r[R.input], output: r[R.output], cacheRead: r[R.cacheRead], cacheWrite5m: r[R.w5m], cacheWrite1h: r[R.w1h] })

export class Ledger {
  constructor({ pricer = createPricer(), defaultTtlMs = FIVE_MIN } = {}) {
    this.pricer = pricer
    this.defaultTtlMs = defaultTtlMs
    this.records = new Map()  // key -> tuple
    this.sessions = new Map() // id -> meta
  }

  _session(id) {
    let s = this.sessions.get(id)
    if (!s) {
      s = { id, title: null, aiTitle: null, firstPrompt: null, cwd: null, lastPromptTs: 0, lastActivity: 0 }
      this.sessions.set(id, s)
    }
    return s
  }

  // Feed one raw JSONL line. `file` is used for the session id fallback and subagent detection.
  ingest(raw, file = '') {
    let line
    try { line = JSON.parse(raw) } catch { return false }
    if (!line || typeof line !== 'object') return false
    const sid = line.sessionId || basename(file).replace(/\.jsonl$/, '')
    switch (line.type) {
      case 'custom-title': this._session(sid).title = line.customTitle || null; return true
      case 'ai-title': this._session(sid).aiTitle = line.aiTitle || null; return true
      case 'summary': { const s = this._session(sid); if (!s.aiTitle) s.aiTitle = line.summary; return true }
      case 'user': {
        if (!isHumanPrompt(line)) return false
        const s = this._session(sid)
        const ts = Date.parse(line.timestamp) || 0
        if (ts > s.lastPromptTs) s.lastPromptTs = ts
        if (!s.firstPrompt) {
          const c = line.message.content
          const t = typeof c === 'string' ? c : ((c.find((b) => b.type === 'text') || {}).text || '')
          if (!t.startsWith('<command-')) s.firstPrompt = t.replace(/\s+/g, ' ').trim().slice(0, 80)
        }
        if (!s.cwd && line.cwd) s.cwd = line.cwd
        return true
      }
      case 'assistant': {
        const m = line.message
        if (!m || !m.usage || m.model === '<synthetic>') return false
        const key = `${m.id || ''}:${line.requestId || line.uuid || ''}`
        const ts = Date.parse(line.timestamp) || 0
        const u = normalizeUsage(m.usage)
        const side = line.isSidechain || /[\\/]subagents[\\/]/.test(file) ? 1 : 0
        const prev = this.records.get(key)
        const firstTs = prev ? Math.min(prev[R.ts], ts) || ts : ts
        this.records.set(key, [firstTs, sid, m.model, u.input, u.output, u.cacheRead, u.cacheWrite5m, u.cacheWrite1h, side, m.usage.speed || null])
        const s = this._session(sid)
        if (ts > s.lastActivity) s.lastActivity = ts
        if (!s.cwd && line.cwd) s.cwd = line.cwd
        return true
      }
      default:
        return false
    }
  }

  title(id) {
    const s = this.sessions.get(id)
    if (!s) return id ? id.slice(0, 8) : 'Unknown session'
    return s.title || s.aiTitle || s.firstPrompt || (s.cwd ? basename(s.cwd) : id.slice(0, 8))
  }

  project(id) {
    const s = this.sessions.get(id)
    return s && s.cwd ? basename(s.cwd) : ''
  }

  toJSON() {
    return { v: 1, records: [...this.records], sessions: [...this.sessions.values()] }
  }

  static fromJSON(data, opts) {
    const l = new Ledger(opts)
    if (data && data.v === 1) {
      for (const [k, r] of data.records || []) l.records.set(k, r)
      for (const s of data.sessions || []) l.sessions.set(s.id, s)
    }
    return l
  }

  // Everything the HUD needs, as plain JSON.
  //   days:       length of the daily series (oldest first, zero-filled)
  //   sessionId:  also return that session's live-ish state as `session`
  snapshot({ now = Date.now(), days = 30, sessionId = null, topSessions = 12 } = {}) {
    const today = localDay(now)
    const empty = () => ({ tokens: 0, cost: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    const add = (a, u, cost) => {
      a.tokens += totalTokens(u); a.cost += cost; a.requests++
      a.input += u.input; a.output += u.output; a.cacheRead += u.cacheRead
      a.cacheWrite += u.cacheWrite5m + u.cacheWrite1h
    }
    const dayAgg = new Map()
    const daySess = new Map()
    const total = empty()
    let latest = null // most recent main-thread record across sessions

    for (const r of this.records.values()) {
      const u = usageOf(r)
      const cost = this.pricer.cost(r[R.model], u, r[R.speed])
      const d = localDay(r[R.ts])
      if (!dayAgg.has(d)) dayAgg.set(d, empty())
      add(dayAgg.get(d), u, cost)
      add(total, u, cost)
      if (!daySess.has(d)) daySess.set(d, new Map())
      const sm = daySess.get(d)
      if (!sm.has(r[R.sid])) sm.set(r[R.sid], { ...empty(), subagentCost: 0, lastTs: 0 })
      const sa = sm.get(r[R.sid])
      add(sa, u, cost)
      if (r[R.side]) sa.subagentCost += cost
      if (r[R.ts] > sa.lastTs) sa.lastTs = r[R.ts]
      if (!r[R.side] && (!latest || r[R.ts] > latest[R.ts])) latest = r
    }

    const series = []
    const base = new Date(now)
    base.setHours(12, 0, 0, 0)
    for (let i = days - 1; i >= 0; i--) {
      const dt = new Date(base)
      dt.setDate(base.getDate() - i)
      const d = localDay(dt.getTime())
      series.push({ day: d, ...(dayAgg.get(d) || empty()) })
    }

    const sessionsByDay = {}
    for (const { day } of series) {
      const sm = daySess.get(day)
      if (!sm) continue
      const rows = [...sm.entries()]
        .map(([id, a]) => ({ id, title: this.title(id), project: this.project(id), ...a }))
        .sort((a, b) => b.cost - a.cost)
      const top = rows.slice(0, topSessions)
      const rest = rows.slice(topSessions)
      if (rest.length) {
        const other = { id: '_other', title: `${rest.length} more sessions`, project: '', ...empty(), subagentCost: 0, lastTs: 0 }
        for (const r of rest) { other.tokens += r.tokens; other.cost += r.cost; other.requests += r.requests }
        top.push(other)
      }
      sessionsByDay[day] = top
    }

    return {
      generatedAt: now,
      today,
      todayAgg: dayAgg.get(today) || empty(),
      total,
      series,
      sessionsByDay,
      latestSessionId: latest ? latest[R.sid] : null,
      session: this.sessionState(sessionId || (latest && latest[R.sid])),
    }
  }

  // Cache timing, context and last-turn figures for one session, from its transcript.
  sessionState(id) {
    if (!id) return null
    const main = []
    const all = []
    for (const r of this.records.values()) {
      if (r[R.sid] !== id) continue
      all.push(r)
      if (!r[R.side]) main.push(r)
    }
    if (!main.length) return null
    main.sort((a, b) => a[R.ts] - b[R.ts])
    const s = this.sessions.get(id)

    // TTL as the API actually wrote it; a pure cache read says nothing, so inherit.
    let ttl = this.defaultTtlMs
    let warmSince = main[0][R.ts]
    let prev = null
    for (const r of main) {
      if (r[R.w1h] > 0) ttl = HOUR
      else if (r[R.w5m] > 0) ttl = FIVE_MIN
      if (prev !== null && r[R.ts] - prev > ttl) warmSince = r[R.ts] // expired in between: new warm streak
      prev = r[R.ts]
    }
    const last = main[main.length - 1]
    const lastU = usageOf(last)

    const promptTs = s && s.lastPromptTs ? s.lastPromptTs : main[0][R.ts]
    const turn = { tokens: 0, cost: 0, requests: 0, startTs: promptTs }
    for (const r of all) {
      if (r[R.ts] + 1000 < promptTs) continue
      const u = usageOf(r)
      turn.tokens += totalTokens(u)
      turn.cost += this.pricer.cost(r[R.model], u, r[R.speed])
      turn.requests++
    }

    return {
      id,
      title: this.title(id),
      project: this.project(id),
      model: last[R.model],
      contextTokens: contextTokens(lastU),
      contextWindow: this.pricer.contextWindow(last[R.model]),
      lastRequestTs: last[R.ts],
      warmSince,
      ttlMs: ttl,
      lastTurn: turn,
    }
  }
}
