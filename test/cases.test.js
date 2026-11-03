'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const C = require('../dist/lib/cases')
const { normalizeRules } = require('../dist/lib/rules')
const { buildQuestions } = require('../dist/lib/questions')
const { VerdictCache, OverrideStore } = require('../dist/lib/stores')
const { fakeJev } = require('./fakes')

const row = (id, text, base, extra = {}) => ({ id, text, base, final: base, ...extra })

test('makeCase keeps the pre-override verdict, fields, hint and floor', () => {
  const c = C.makeCase('mail', row('1', 'hi', { priority: 'fyi', kind: 'discussion', by: 'jev', confidence: 0.6 }, { fields: { from: 'a' }, floor: 'fyi' }), { priority: 'action' }, '  mine  ', 0)
  assert.deepEqual(c.got, { priority: 'fyi', kind: 'discussion', by: 'jev', confidence: 0.6 })
  assert.deepEqual(c.expected, { priority: 'action' })
  assert.equal(c.note, 'mine')
  assert.deepEqual(c.fields, { from: 'a' })
  assert.equal(c.floor, 'fyi')
  assert.equal(c.at, '1970-01-01T00:00:00.000Z')
  assert.throws(() => C.makeCase('mail', row('1', 'x', null), { priority: 'big' }, '', 0), /priority/)
})

test('one case per source and id, oldest dropped past the cap', () => {
  let cases = []
  cases = C.addCase(cases, { source: 'mail', id: '1', n: 1 }, 2)
  cases = C.addCase(cases, { source: 'jira', id: '1', n: 2 }, 2)
  cases = C.addCase(cases, { source: 'mail', id: '1', n: 3 }, 2)
  assert.deepEqual(cases.map((c) => c.n), [2, 3])
  cases = C.addCase(cases, { source: 'mail', id: '2', n: 4 }, 2)
  assert.deepEqual(cases.map((c) => c.n), [3, 4])
  assert.deepEqual(C.removeCase(cases, 'mail', '1').map((c) => c.n), [4])
})

test('JSONL round trip survives a torn line', () => {
  const cases = [{ id: 'a', source: 'mail' }, { id: 'b', source: 'jira' }]
  const text = C.toJsonl(cases) + '{"id":"c","sou'
  assert.deepEqual(C.parseJsonl(text), cases)
  assert.equal(C.toJsonl([]), '')
})

test('passes: priority must match, kind only when expected, lists allow either', () => {
  assert.ok(C.passes({ priority: 'fyi' }, { priority: 'fyi', kind: 'ack' }))
  assert.ok(!C.passes({ priority: 'fyi', kind: 'request' }, { priority: 'fyi', kind: 'ack' }))
  assert.ok(C.passes({ priority: ['fyi', 'noise'] }, { priority: 'noise' }))
  assert.ok(!C.passes({ priority: 'fyi' }, { error: 'x' }))
  assert.ok(!C.passes({ priority: 'fyi' }, undefined))
})

test('eval re-judges with current rules and questions, skipping cache and overrides', async () => {
  const jev = fakeJev()
  const cache = new VerdictCache()
  const overrides = new OverrideStore()
  overrides.set('mail', 'a', { priority: 'urgent' }, 't')
  const { questions, fingerprint } = buildQuestions({})
  const deps = {
    questions,
    fingerprint,
    rules: normalizeRules([{ source: 'jira', field: 'project', equals: 'OPS', priority: 'action' }]).rules,
    cache,
    overrides,
    jev,
    model: { get: () => 'm', set() {} },
  }
  const cases = [
    { source: 'mail', id: 'a', text: 'meeting notes [read]', expected: { priority: 'fyi' }, note: 'not mine' },
    { source: 'mail', id: 'b', text: 'thanks [noise] [ack]', expected: { priority: 'noise', kind: 'request' } },
    { source: 'jira', id: 'a', text: 'ticket [noise]', fields: { project: 'ops' }, expected: { priority: 'action' } },
    { source: 'jira', id: 'c', text: 'thanks [noise]', floor: 'fyi', expected: { priority: 'fyi' } },
  ]
  const r = await C.evalCases(deps, cases)
  assert.equal(r.total, 4)
  assert.equal(r.passed, 3)
  const fail = r.rows.find((x) => !x.ok)
  assert.equal(fail.id, 'b')
  assert.equal(r.rows.find((x) => x.source === 'jira' && x.id === 'a').got.by, 'rule')
  assert.equal(r.rows.find((x) => x.source === 'mail' && x.id === 'a').got.by, 'jev') // the override is ignored
  assert.equal(cache.size, 0) // and nothing was cached
  assert.equal(jev.calls.length, 2) // one grid per source group
})
