'use strict'
// Project rules: `{ source?, field, equals? | contains?, priority, kind? }`, first match wins. No
// regexes on purpose: the app refuses `pattern` in settings schemas (ReDoS in its main process), and
// a rule list that only does equals/contains stays readable when the improve loop proposes one.

const { isPriority, isKind } = require('./vocab')

/**
 * Keep the rules that make sense and say why the others were dropped. The settings schema already
 * checks types; what it cannot say (no conditional schemas in the form) is "exactly one of equals and
 * contains", so that is checked here, and a bad rule is skipped rather than failing every classify.
 */
function normalizeRules(raw) {
  const rules = []
  const problems = []
  if (raw === undefined || raw === null) return { rules, problems }
  if (!Array.isArray(raw)) return { rules, problems: ['rules must be a list'] }
  raw.forEach((r, i) => {
    const where = `rule ${i + 1}`
    if (!r || typeof r !== 'object') return problems.push(`${where}: not an object`)
    if (typeof r.field !== 'string' || !r.field.trim()) return problems.push(`${where}: field is missing`)
    const hasEq = typeof r.equals === 'string'
    const hasIn = typeof r.contains === 'string' && r.contains.length > 0
    if (hasEq === hasIn) return problems.push(`${where}: give exactly one of equals and contains`)
    if (!isPriority(r.priority)) return problems.push(`${where}: priority must be urgent, action, fyi or noise`)
    if (r.kind !== undefined && r.kind !== null && r.kind !== '' && !isKind(r.kind)) {
      return problems.push(`${where}: unknown kind ${JSON.stringify(r.kind)}`)
    }
    rules.push({
      index: i,
      source: typeof r.source === 'string' && r.source.trim() ? r.source.trim() : null,
      field: r.field.trim(),
      // Case-insensitive on both sides: mail addresses and Jira project keys arrive in either case,
      // and a rule that silently misses on "Alerts@" is worse than one that matches a little wide.
      equals: hasEq ? r.equals.trim().toLowerCase() : null,
      contains: hasIn ? r.contains.toLowerCase() : null,
      priority: r.priority,
      kind: isKind(r.kind) ? r.kind : null,
    })
  })
  return { rules, problems }
}

function valueOf(item, field) {
  if (field === 'text') return typeof item.text === 'string' ? item.text : undefined
  const f = item.fields
  if (!f || typeof f !== 'object' || !Object.prototype.hasOwnProperty.call(f, field)) return undefined
  return typeof f[field] === 'string' ? f[field] : undefined
}

/** The first rule that matches `item` from `source`, or null. A missing field never matches. */
function matchRule(rules, source, item) {
  for (const r of rules) {
    if (r.source && r.source !== source) continue
    const v = valueOf(item, r.field)
    if (v === undefined) continue
    const low = v.toLowerCase()
    if (r.equals !== null ? low.trim() === r.equals : low.includes(r.contains)) return r
  }
  return null
}

/** One line for the CLI and the improve prompt: `mail from = alerts@x -> noise/alert`. */
function describeRule(r) {
  const test = r.equals !== null ? `= ${JSON.stringify(r.equals)}` : `contains ${JSON.stringify(r.contains)}`
  return `${r.source ? r.source + ' ' : ''}${r.field} ${test} -> ${r.priority}${r.kind ? '/' + r.kind : ''}`
}

module.exports = { normalizeRules, matchRule, describeRule }
