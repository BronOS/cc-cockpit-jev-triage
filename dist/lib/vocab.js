'use strict'
// The words every other module shares: priorities, kinds, the floor rule and the input checks of the
// `triage` service. Pure, no ctx, so the node:test suites can cover it directly.

// Highest first; RANK is what `floor` compares.
const PRIORITIES = ['urgent', 'action', 'fyi', 'noise']
const RANK = { noise: 0, fyi: 1, action: 2, urgent: 3 }
const KINDS = ['request', 'incident', 'discussion', 'alert', 'notification', 'ack']
// Which step decided a verdict (design "Order"): the panel shows it, the improve loop reads it to
// pick the layer to fix.
const BY = ['hint', 'rule', 'jev', 'override']

// Jev's priority question keeps the old five criteria (`read` and `low` read better to the model than
// `fyi` and `noise`: "low" is the automated-report class, which the eval of the old cockpit showed
// it separates well from human chatter). They fold into the four priorities here and nowhere else.
const JEV_PRIORITY_MAP = { urgent: 'urgent', action: 'action', read: 'fyi', low: 'noise', noise: 'noise' }

// Limits of one classify call. 500 items is ten jev.grid chunks; more is a caller bug (or a source
// that should page), so the call rejects rather than silently judging a prefix. Text: Jev's own state
// limit (200,000 characters, the jev README); an item over it gets { error } instead of a cut text,
// because cutting either end loses what matters (the header says who it is from, the tail is the new
// content). Ids are storage keys inside maps, but a 256-char cap keeps the override store bounded.
const MAX_ITEMS = 500
const MAX_TEXT = 200000
const MAX_ID = 256
const MAX_FIELDS = 32
const MAX_FIELD_NAME = 64
const MAX_FIELD_VALUE = 2000
// `source` names a group in the results, cache, overrides and the panel; it is also part of storage
// keys, so it stays short and plain.
const SOURCE_RE = /^[a-z][a-z0-9-]{0,31}$/

function isPriority(v) {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(RANK, v)
}

function isKind(v) {
  return typeof v === 'string' && KINDS.includes(v)
}

/** Raise `priority` to at least `floor`, never lower it (Jira's lower bound: an assigned issue is never noise). */
function applyFloor(priority, floor) {
  if (isPriority(floor) && isPriority(priority) && RANK[priority] < RANK[floor]) return floor
  return priority
}

function checkSource(source) {
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) {
    throw new Error(`triage: source must match ${SOURCE_RE} (a short name like "mail"), got ${JSON.stringify(source)}`)
  }
}

function checkId(id, where) {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) {
    throw new Error(`triage: ${where}: id must be a non-empty string of at most ${MAX_ID} characters`)
  }
}

/** `{ priority, kind? }` as the override and the hint take it; throws with a readable reason. */
function checkVerdictInput(v, where) {
  if (!v || typeof v !== 'object') throw new Error(`triage: ${where} must be { priority, kind? }`)
  if (!isPriority(v.priority)) throw new Error(`triage: ${where}.priority must be one of ${PRIORITIES.join(', ')}`)
  if (v.kind !== undefined && v.kind !== null && !isKind(v.kind)) {
    throw new Error(`triage: ${where}.kind must be one of ${KINDS.join(', ')}`)
  }
  return v.kind == null ? { priority: v.priority } : { priority: v.priority, kind: v.kind }
}

/**
 * Check the whole call shape: throws for what is a caller bug (not an array, too many items, a bad or
 * duplicate id, since a result cannot be keyed without one). Per-item content problems (bad hint, text
 * too long) are returned as `problems[id]` so the rest of the batch still gets verdicts.
 */
function checkItems(items) {
  if (!Array.isArray(items)) throw new Error('triage: items must be an array')
  if (items.length > MAX_ITEMS) throw new Error(`triage: at most ${MAX_ITEMS} items a call, got ${items.length}`)
  const seen = new Set()
  const problems = {}
  items.forEach((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`triage: items[${i}] must be an object`)
    checkId(item.id, `items[${i}]`)
    if (seen.has(item.id)) throw new Error(`triage: items[${i}]: duplicate id ${JSON.stringify(item.id)}`)
    seen.add(item.id)
    const p = itemProblem(item)
    if (p) problems[item.id] = p
  })
  return problems
}

function itemProblem(item) {
  if (item.text !== undefined && typeof item.text !== 'string') return 'text must be a string'
  if (typeof item.text === 'string' && item.text.length > MAX_TEXT) {
    return `text is ${item.text.length} characters, over the limit of ${MAX_TEXT}`
  }
  if (item.hint !== undefined) {
    try {
      checkVerdictInput(item.hint, 'hint')
    } catch (e) {
      return e.message.replace(/^triage: /, '')
    }
  }
  if (item.floor !== undefined && !isPriority(item.floor)) return `floor must be one of ${PRIORITIES.join(', ')}`
  if (item.fields !== undefined) {
    if (!item.fields || typeof item.fields !== 'object' || Array.isArray(item.fields)) return 'fields must be an object'
    const names = Object.keys(item.fields)
    if (names.length > MAX_FIELDS) return `at most ${MAX_FIELDS} fields`
    for (const n of names) {
      const v = item.fields[n]
      if (n.length > MAX_FIELD_NAME) return `field name over ${MAX_FIELD_NAME} characters`
      if (typeof v !== 'string') return `fields.${n} must be a string`
      if (v.length > MAX_FIELD_VALUE) return `fields.${n} is over ${MAX_FIELD_VALUE} characters`
    }
  }
  return null
}

/** The panel's title for an item: the first non-empty line of its text, cut short. */
function titleOf(text, max = 120) {
  const line = String(text || '').split('\n').map((s) => s.trim()).find((s) => s.length > 0) || '(no text)'
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

module.exports = {
  PRIORITIES,
  RANK,
  KINDS,
  BY,
  JEV_PRIORITY_MAP,
  MAX_ITEMS,
  MAX_TEXT,
  MAX_ID,
  SOURCE_RE,
  isPriority,
  isKind,
  applyFloor,
  checkSource,
  checkId,
  checkVerdictInput,
  checkItems,
  titleOf,
}
