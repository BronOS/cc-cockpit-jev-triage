'use strict'
// In-memory stores the host persists: the Jev verdict cache, the person's overrides and the recent
// verdicts the panel lists. Each is a plain class with toJSON/fromJSON so tests run without ctx, and
// each is bounded, since ctx.storage caps a value at 1 MiB and a project at 16 MiB.

const crypto = require('node:crypto')

/**
 * The cache key of a Jev verdict: sha256 over the source, the exact text, the questions fingerprint
 * (which already holds the profile) and the model. Any of them changing means Jev could answer
 * differently, so the old verdict is simply not found. JSON of an array keeps the parts apart
 * ("ab"+"c" and "a"+"bc" do not collide). 32 hex chars (128 bits) keep the stored map small.
 */
function cacheKey(source, text, fingerprint, model) {
  return crypto.createHash('sha256').update(JSON.stringify([source, text, fingerprint, model])).digest('hex').slice(0, 32)
}

// About 100 bytes of JSON an entry: 4000 entries stay near 400 KiB, well under the 1 MiB value limit.
const CACHE_CAP = 4000

class VerdictCache {
  constructor(cap = CACHE_CAP) {
    this.cap = cap
    // Map keeps insertion order; get() and set() move an entry to the end, so the first entry is
    // always the least recently used one and eviction is "delete from the front".
    this.map = new Map()
    this.dirty = false
  }

  get(key) {
    const e = this.map.get(key)
    if (!e) return undefined
    this.map.delete(key)
    this.map.set(key, e)
    return e
  }

  /** entry: { p: priority, k: kind, c: confidence, s: source, t: time } */
  set(key, entry) {
    this.map.delete(key)
    this.map.set(key, entry)
    while (this.map.size > this.cap) this.map.delete(this.map.keys().next().value)
    this.dirty = true
  }

  /** Drop every entry, or only those of one source. Returns how many went. */
  clear(source) {
    let n = 0
    for (const [k, e] of this.map) {
      if (!source || e.s === source) {
        this.map.delete(k)
        n++
      }
    }
    if (n) this.dirty = true
    return n
  }

  get size() {
    return this.map.size
  }

  toJSON() {
    return [...this.map]
  }

  static fromJSON(data, cap) {
    const c = new VerdictCache(cap)
    if (Array.isArray(data)) {
      for (const pair of data) {
        if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[1] && typeof pair[1] === 'object') {
          c.map.set(pair[0], pair[1])
        }
      }
      while (c.map.size > c.cap) c.map.delete(c.map.keys().next().value)
    }
    return c
  }
}

// Per source; ids are at most 256 chars, so 1000 overrides stay under ~350 KiB of JSON.
const OVERRIDE_CAP = 1000

class OverrideStore {
  constructor(cap = OVERRIDE_CAP) {
    this.cap = cap
    this.bySource = new Map() // source -> Map(id -> { priority, kind?, at })
  }

  get(source, id) {
    const m = this.bySource.get(source)
    return m ? m.get(id) : undefined
  }

  set(source, id, verdict, at) {
    let m = this.bySource.get(source)
    if (!m) this.bySource.set(source, (m = new Map()))
    m.delete(id)
    m.set(id, { ...verdict, at })
    // The oldest correction goes first: an item corrected a year ago is long gone from its source.
    while (m.size > this.cap) m.delete(m.keys().next().value)
  }

  clear(source, id) {
    const m = this.bySource.get(source)
    return m ? m.delete(id) : false
  }

  /** Drop every override of a source (ccc triage forget); returns how many there were. */
  forget(source) {
    const m = this.bySource.get(source)
    this.bySource.delete(source)
    return m ? m.size : 0
  }

  /** The sources that hold overrides, for persisting one storage key per source. */
  sources() {
    return [...this.bySource.keys()]
  }

  sourceJSON(source) {
    const m = this.bySource.get(source)
    return m ? [...m] : []
  }

  loadSource(source, data) {
    const m = new Map()
    if (Array.isArray(data)) for (const [id, v] of data) if (typeof id === 'string' && v && v.priority) m.set(id, v)
    this.bySource.set(source, m)
  }
}

// The panel lists the newest verdicts per source. The text is kept (cut at RECENT_TEXT) because
// Wrong? turns a row into a case and the eval must judge the same text Jev saw.
const RECENT_PER_SOURCE = 100
const RECENT_TEXT = 20000

class RecentStore {
  constructor(perSource = RECENT_PER_SOURCE) {
    this.perSource = perSource
    this.bySource = new Map() // source -> array, newest first
  }

  /**
   * row: { id, text, fields?, hint?, floor?, base: verdict before the override, final: what classify
   * returned, at }. The same id again replaces its old row (a source re-classifies its whole list).
   */
  add(source, row) {
    let list = this.bySource.get(source)
    if (!list) this.bySource.set(source, (list = []))
    const i = list.findIndex((r) => r.id === row.id)
    if (i >= 0) list.splice(i, 1)
    const text = typeof row.text === 'string' ? row.text : ''
    list.unshift({ ...row, text: text.slice(0, RECENT_TEXT), truncated: text.length > RECENT_TEXT || undefined })
    if (list.length > this.perSource) list.length = this.perSource
  }

  find(source, id) {
    const list = this.bySource.get(source)
    return list ? list.find((r) => r.id === id) : undefined
  }

  /** Update the final verdict of a listed row after an override or a clear (the panel shows it at once). */
  patch(source, id, fields) {
    const r = this.find(source, id)
    if (r) Object.assign(r, fields)
    return r
  }

  /** Drop a source's listed verdicts (ccc triage forget); returns how many rows there were. */
  forget(source) {
    const list = this.bySource.get(source)
    this.bySource.delete(source)
    return list ? list.length : 0
  }

  sources() {
    return [...this.bySource.keys()].sort()
  }

  list(source) {
    return this.bySource.get(source) || []
  }

  toJSON() {
    return Object.fromEntries(this.bySource)
  }

  static fromJSON(data, perSource) {
    const s = new RecentStore(perSource)
    if (data && typeof data === 'object') {
      for (const [src, list] of Object.entries(data)) {
        if (Array.isArray(list)) s.bySource.set(src, list.filter((r) => r && typeof r.id === 'string').slice(0, s.perSource))
      }
    }
    return s
  }
}

module.exports = { cacheKey, VerdictCache, OverrideStore, RecentStore, CACHE_CAP, OVERRIDE_CAP, RECENT_TEXT }
