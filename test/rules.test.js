'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeRules, matchRule, describeRule } = require('../dist/lib/rules')

test('normalizeRules keeps good rules and explains dropped ones', () => {
  const { rules, problems } = normalizeRules([
    { field: 'from', equals: 'Alerts@Grafana.net', priority: 'noise', kind: 'alert' },
    { field: 'text', contains: 'Invoice', priority: 'fyi' },
    { field: 'from', equals: 'a', contains: 'b', priority: 'fyi' },
    { field: 'from', priority: 'fyi' },
    { field: 'from', equals: 'a', priority: 'high' },
    { field: '', equals: 'a', priority: 'fyi' },
    { field: 'from', equals: 'a', priority: 'fyi', kind: '' },
  ])
  assert.equal(rules.length, 3)
  assert.equal(problems.length, 4)
  assert.equal(rules[0].equals, 'alerts@grafana.net')
  assert.equal(rules[2].kind, null)
  assert.deepEqual(normalizeRules('x').problems, ['rules must be a list'])
  assert.deepEqual(normalizeRules(undefined), { rules: [], problems: [] })
})

test('first match wins, case-insensitive, per source, missing field never matches', () => {
  const { rules } = normalizeRules([
    { source: 'jira', field: 'project', equals: 'OPS', priority: 'action' },
    { field: 'from', equals: 'alerts@grafana.net', priority: 'noise', kind: 'alert' },
    { field: 'text', contains: 'newsletter', priority: 'noise' },
    { field: 'from', contains: 'grafana', priority: 'urgent' },
  ])
  const m = (source, item) => {
    const r = matchRule(rules, source, item)
    return r && r.index
  }
  assert.equal(m('mail', { fields: { from: 'ALERTS@grafana.net ' } }), 1)
  assert.equal(m('mail', { fields: { from: 'ops@grafana.net' } }), 3)
  assert.equal(m('mail', { text: 'Our NEWSLETTER for May' }), 2)
  assert.equal(m('mail', { fields: { project: 'ops' } }), null)
  assert.equal(m('jira', { fields: { project: 'ops' } }), 0)
  assert.equal(m('mail', { text: 'hello' }), null)
  assert.equal(m('mail', {}), null)
})

test('describeRule is one readable line', () => {
  const { rules } = normalizeRules([{ source: 'mail', field: 'from', equals: 'x@y', priority: 'noise', kind: 'alert' }])
  assert.equal(describeRule(rules[0]), 'mail from = "x@y" -> noise/alert')
})
