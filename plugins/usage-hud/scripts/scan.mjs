#!/usr/bin/env node
// Cross-session usage scanner. The hooks module has no Node APIs and `$.fs.read` caps a read
// at 4 MiB with no offset, so the mod runs this script through `$.process.run` to read every
// transcript, including large ones, incrementally.
//
//   node scan.mjs [--session <id>] [--days 30] [--ttl 1h|5m] [--report]
//
// Prints one JSON snapshot (Ledger.snapshot) on stdout, or a text report with --report.
// Parsed state is cached in ~/.claude/usage-hud/scan-cache.json; each run only reads bytes
// appended since the last run.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Ledger, HOUR, FIVE_MIN } from '../lib/ledger.js'
import { createPricer } from '../lib/pricing.js'
import * as f from '../lib/format.js'

const CACHE_VERSION = 2

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt
}

function projectsDirs() {
  const dirs = []
  if (process.env.CLAUDE_CONFIG_DIR) {
    for (const d of process.env.CLAUDE_CONFIG_DIR.split(path.delimiter)) dirs.push(path.join(d, 'projects'))
  }
  dirs.push(path.join(os.homedir(), '.claude', 'projects'))
  return [...new Set(dirs)].filter((d) => fs.existsSync(d))
}

function listTranscripts(root) {
  const out = []
  const walk = (dir, depth) => {
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < 4 && e.name !== 'tool-results' && e.name !== 'memory') walk(p, depth + 1)
      } else if (e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  walk(root, 0)
  return out
}

function cacheFile() {
  return path.join(os.homedir(), '.claude', 'usage-hud', 'scan-cache.json')
}

function loadCache(opts) {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'))
    if (data.v === CACHE_VERSION) return { files: data.files || {}, ledger: Ledger.fromJSON(data.ledger, opts) }
  } catch { /* first run or corrupt: rebuild */ }
  return { files: {}, ledger: new Ledger(opts) }
}

function saveCache(files, ledger) {
  const file = cacheFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, files, ledger: ledger.toJSON() }))
  fs.renameSync(tmp, file) // atomic, so concurrent sessions never read half a cache
}

// Read [offset, size) and ingest complete lines; returns the offset after the last newline.
function tail(file, offset, size, ledger) {
  const fd = fs.openSync(file, 'r')
  try {
    const CHUNK = 8 * 1024 * 1024
    let carry = ''
    let pos = offset
    let committed = offset
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos)
      const buf = Buffer.alloc(len)
      const n = fs.readSync(fd, buf, 0, len, pos)
      if (n <= 0) break
      pos += n
      const text = carry + buf.toString('utf8', 0, n)
      const lines = text.split('\n')
      carry = lines.pop()
      for (const l of lines) if (l.trim()) ledger.ingest(l, file)
      committed = pos - Buffer.byteLength(carry, 'utf8')
    }
    return committed
  } finally {
    fs.closeSync(fd)
  }
}

function scan() {
  const ttl = arg('ttl', '5m') === '1h' ? HOUR : FIVE_MIN
  const opts = { pricer: createPricer(), defaultTtlMs: ttl }
  const cache = loadCache(opts)
  cache.ledger.defaultTtlMs = ttl
  const seen = new Set()
  let changed = false

  for (const root of projectsDirs()) {
    for (const file of listTranscripts(root)) {
      seen.add(file)
      let st
      try { st = fs.statSync(file) } catch { continue }
      const prev = cache.files[file]
      let offset = prev ? prev.offset : 0
      if (prev && st.size < prev.offset) offset = 0 // rewritten: read again (records dedupe by key)
      if (offset >= st.size) continue
      cache.files[file] = { offset: tail(file, offset, st.size, cache.ledger) }
      changed = true
    }
  }
  // Deleted transcripts keep their records (history), but stop being tracked.
  for (const file of Object.keys(cache.files)) if (!seen.has(file)) { delete cache.files[file]; changed = true }
  if (changed) saveCache(cache.files, cache.ledger)
  return cache.ledger
}

function report(s) {
  const lines = []
  lines.push(`Today ${s.today}: ${f.usd(s.todayAgg.cost)} · ${f.tokens(s.todayAgg.tokens)} tokens · ${s.todayAgg.requests} requests`)
  lines.push(`All time: ${f.usd(s.total.cost)} · ${f.tokens(s.total.tokens)} tokens`)
  for (const d of s.series) {
    if (!d.requests) continue
    lines.push(`\n${d.day}  ${f.usd(d.cost).padStart(9)}  ${f.tokens(d.tokens).padStart(7)} tok`)
    for (const r of s.sessionsByDay[d.day] || []) {
      lines.push(`    ${f.usd(r.cost).padStart(9)}  ${f.tokens(r.tokens).padStart(7)}  ${f.truncate(r.title, 60)}`)
    }
  }
  return lines.join('\n')
}

try {
  const ledger = scan()
  const snap = ledger.snapshot({ days: Number(arg('days', 30)), sessionId: arg('session', null) })
  process.stdout.write(process.argv.includes('--report') ? report(snap) + '\n' : JSON.stringify(snap))
} catch (err) {
  process.stdout.write(JSON.stringify({ error: String((err && err.stack) || err) }))
  process.exitCode = 1
}
