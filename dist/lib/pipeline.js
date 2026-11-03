'use strict'
// The triage order (design "Order"; the last step that applies wins):
//   1. the item's hint      (skips Jev)
//   2. the first rule match (skips Jev; replaces the hint's priority, and its kind when it gives one)
//   3. Jev                  (only for items with neither; cached per text + questions + model)
//   4. the person's override for that source and id
// then `floor` raises the priority to at least the floor, never lowers it.
// Everything outside (storage, the jev service, the clock) comes in through `deps`, so the tests run it
// with a fake jev and the eval runs it with no cache and no overrides.

const V = require('./vocab')
const { matchRule } = require('./rules')
const { cacheKey } = require('./stores')

// One jev.grid per 50 items (design): a refusal half way (cap reached) then costs at most one chunk's
// work, and the chunks done before it are already cached, so a retry picks up where it stopped.
const CHUNK = 50

// Shown by the panel, printed by the CLI and carried by classify's rejection, word for word, so a
// source plugin can show the person the same fix.
const JEV_MISSING =
  'Needs the Jev plugin (bronos.jev): install it from Settings > Marketplace and enable it in this project.'

function chunk(list, size = CHUNK) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function clamp01(x) {
  return typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0
}

/**
 * Read one item's Jev answer: `{ priority: { choice, confidence, probabilities }, kind: {...} }`, the
 * shape `ccc jev ask` prints for a choice question. Returns a verdict or { error }.
 */
function readAnswer(answers) {
  const p = answers && answers.priority
  const k = answers && answers.kind
  if (!p || typeof p.choice !== 'string') return { error: 'jev gave no priority answer' }
  const priority = V.JEV_PRIORITY_MAP[p.choice]
  if (!priority) return { error: `jev gave an unknown priority ${JSON.stringify(p.choice)}` }
  const kind = k && V.isKind(k.choice) ? k.choice : null
  return { priority, kind, confidence: clamp01(p.confidence) }
}

/**
 * Classify one batch of a source's items.
 * deps: { questions, fingerprint, rules, cache|null, overrides|null, jev: { available(), grid(items,
 *   questions, options) }, model: { get(), set(m) }, label, now() }
 * Resolves { results, stats, rows } (rows feed the recent-verdicts list); rejects for a bad call, for
 * a missing jev when an item needs it, and for a jev refusal (the whole call, with jev's message).
 */
async function classify(deps, source, items) {
  V.checkSource(source)
  const problems = V.checkItems(items)
  const now = deps.now ? deps.now() : Date.now()
  const stats = { items: items.length, hint: 0, rule: 0, jev: 0, cached: 0, override: 0, floored: 0, errors: 0, asked: 0, tokens: 0, cost: null, ms: 0 }
  const results = {}
  const base = {} // id -> verdict before the override
  const needJev = []

  for (const item of items) {
    if (problems[item.id]) {
      results[item.id] = { error: problems[item.id] }
      continue
    }
    let v = null
    if (item.hint) {
      v = { priority: item.hint.priority, kind: V.isKind(item.hint.kind) ? item.hint.kind : null, confidence: 1, by: 'hint' }
    }
    const rule = matchRule(deps.rules || [], source, item)
    if (rule) v = { priority: rule.priority, kind: rule.kind || (v ? v.kind : null), confidence: 1, by: 'rule' }
    if (v) {
      base[item.id] = v
      continue
    }
    if (typeof item.text !== 'string' || !item.text.trim()) {
      results[item.id] = { error: 'no text to judge (and no hint or rule decided it)' }
      continue
    }
    needJev.push(item)
  }

  // Cache first: a hit needs no Jev, so a project whose jev was disabled still gets its known verdicts.
  const model = deps.model ? deps.model.get() : 'unknown'
  const toAsk = []
  for (const item of needJev) {
    const hit = deps.cache && deps.cache.get(cacheKey(source, item.text, deps.fingerprint, model))
    if (hit) {
      base[item.id] = { priority: hit.p, kind: hit.k || null, confidence: clamp01(hit.c), by: 'jev' }
      stats.cached++
    } else {
      toAsk.push(item)
    }
  }

  if (toAsk.length) {
    // Asked per call, never once in activate: jev may be enabled (or disabled) at any time.
    if (!deps.jev || !deps.jev.available()) throw new Error(JEV_MISSING)
    let n = 0
    for (const part of chunk(toAsk)) {
      // Our own ids for jev ("i0".."i49"): a source's id can be any string, jev's may not.
      const gridItems = part.map((item) => ({ id: `i${n++}`, text: item.text }))
      let g
      try {
        g = await deps.jev.grid(gridItems, deps.questions, { label: deps.label || 'jev-triage' })
      } catch (e) {
        // A refusal (cap reached, no API key) rejects the whole call so the source can show it.
        throw new Error(String((e && e.message) || e))
      }
      const res = (g && g.results) || {}
      stats.asked += part.length
      if (g && g.stats) {
        stats.tokens += Number(g.stats.tokens) || 0
        stats.ms += Number(g.stats.ms) || 0
        if (typeof g.stats.cost === 'number') stats.cost = (stats.cost || 0) + g.stats.cost
      }
      let failed = 0
      let firstError = null
      part.forEach((item, i) => {
        const r = res[gridItems[i].id]
        const v = r && !r.error ? readAnswer(r.answers) : { error: r ? String(r.error) : 'jev returned no result' }
        if (v.error) {
          failed++
          firstError = firstError || v.error
          results[item.id] = { error: v.error }
          return
        }
        // jev 1.0.0's grid gives no model (only ask does); take one if a later jev adds it.
        const m = (r && r.model) || (g && g.model) || model
        if (deps.model && m !== model) deps.model.set(m)
        base[item.id] = { ...v, by: 'jev' }
        if (deps.cache) deps.cache.set(cacheKey(source, item.text, deps.fingerprint, m), { p: v.priority, k: v.kind, c: v.confidence, s: source, t: now })
      })
      // Every item of a chunk failing is not a bad item, it is jev refusing (a cap or key problem the
      // grid reports per item): treat it like a rejection, as the design asks.
      if (failed === part.length) throw new Error(firstError.startsWith('jev') ? firstError : `jev: ${firstError}`)
    }
  }

  const rows = []
  for (const item of items) {
    const b = base[item.id]
    if (!b) continue
    let v = { ...b }
    const o = deps.overrides && deps.overrides.get(source, item.id)
    if (o) v = { priority: o.priority, kind: o.kind || v.kind, confidence: 1, by: 'override' }
    const p = V.applyFloor(v.priority, item.floor)
    if (p !== v.priority) {
      v.priority = p
      v.floored = true
      stats.floored++
    }
    stats[v.by]++
    results[item.id] = v
    rows.push({ id: item.id, text: item.text || '', fields: item.fields, hint: item.hint, floor: item.floor, base: b, final: v, at: now })
  }
  stats.errors = Object.values(results).filter((r) => r.error).length
  return { results, stats, rows }
}

module.exports = { classify, readAnswer, chunk, CHUNK, JEV_MISSING }
