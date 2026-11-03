'use strict'
// Cases: the person's corrections kept as labeled examples (one per source and id), and the eval that
// re-judges all of them with the current settings. The improve loop runs the eval before and after a
// change and shows both pass counts: a fix that breaks an older case is not a fix.

const V = require('./vocab')
const { classify } = require('./pipeline')

// The file is rewritten whole on every add, and the eval sends every case to Jev; 300 keeps an eval
// at about six grid chunks (and well inside the CLI's 30 s).
const CASE_CAP = 300

function parseJsonl(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const c = JSON.parse(line)
      if (c && typeof c === 'object' && typeof c.id === 'string' && typeof c.source === 'string') out.push(c)
    } catch {
      // A torn last line (a crash mid-write) must not lose the other cases.
    }
  }
  return out
}

function toJsonl(cases) {
  return cases.map((c) => JSON.stringify(c)).join('\n') + (cases.length ? '\n' : '')
}

/**
 * Build a case from a recent-verdicts row and the person's answer. `got` is the verdict before any
 * override (what the pipeline itself said), since that is what the eval compares against.
 */
function makeCase(source, row, expected, note, at) {
  const e = V.checkVerdictInput(expected, 'expected')
  const c = {
    id: row.id,
    source,
    text: row.text || '',
    got: row.base ? { priority: row.base.priority, kind: row.base.kind || null, by: row.base.by, confidence: row.base.confidence } : null,
    expected: e,
    note: typeof note === 'string' ? note.trim().slice(0, 2000) : '',
    at: new Date(at).toISOString(),
  }
  // Fields, hint and floor go along so the eval runs the item through the same rules, hint and floor;
  // a rule is the cheapest fix and could not be measured without the fields it matches on.
  if (row.fields && Object.keys(row.fields).length) c.fields = row.fields
  if (row.hint) c.hint = row.hint
  if (row.floor) c.floor = row.floor
  if (row.truncated) c.truncated = true
  return c
}

/** Add (or replace: one case per source and id) and drop the oldest past the cap. */
function addCase(cases, c, cap = CASE_CAP) {
  const out = cases.filter((x) => !(x.source === c.source && x.id === c.id))
  out.push(c)
  return out.length > cap ? out.slice(out.length - cap) : out
}

function removeCase(cases, source, id) {
  return cases.filter((x) => !(x.source === source && x.id === id))
}

function oneOf(want, got) {
  return Array.isArray(want) ? want.includes(got) : want === got
}

/** A case passes when the priority matches and, if a kind is expected, the kind too. A list means either is fine. */
function passes(expected, got) {
  if (!got || got.error) return false
  if (!oneOf(expected.priority, got.priority)) return false
  if (expected.kind !== undefined && expected.kind !== null && !oneOf(expected.kind, got.kind)) return false
  return true
}

/**
 * Re-judge every case with the current questions and rules, bypassing the cache and the overrides
 * (design: the eval measures the settings, not the person's corrections). deps as for classify, minus
 * cache and overrides. Cases are grouped by source because rules can be per source.
 */
async function evalCases(deps, cases) {
  const bySource = new Map()
  for (const c of cases) {
    if (!bySource.has(c.source)) bySource.set(c.source, [])
    bySource.get(c.source).push(c)
  }
  const rows = []
  for (const [source, list] of bySource) {
    const items = list.map((c) => ({ id: c.id, text: c.text, fields: c.fields, hint: c.hint, floor: c.floor }))
    const { results } = await classify({ ...deps, cache: null, overrides: null }, source, items)
    for (const c of list) {
      const got = results[c.id]
      rows.push({ source, id: c.id, ok: passes(c.expected, got), expected: c.expected, got, note: c.note || '', title: V.titleOf(c.text, 80) })
    }
  }
  return { passed: rows.filter((r) => r.ok).length, total: rows.length, rows }
}

/** The cases of every source but `source` (ccc triage forget). */
function forgetSource(cases, source) {
  return cases.filter((x) => x.source !== source)
}

module.exports = { forgetSource, CASE_CAP, parseJsonl, toJsonl, makeCase, addCase, removeCase, passes, evalCases }
