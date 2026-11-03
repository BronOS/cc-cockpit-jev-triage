'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const V = require('../dist/lib/vocab')

test('floor raises, never lowers', () => {
  assert.equal(V.applyFloor('noise', 'action'), 'action')
  assert.equal(V.applyFloor('fyi', 'fyi'), 'fyi')
  assert.equal(V.applyFloor('urgent', 'fyi'), 'urgent')
  assert.equal(V.applyFloor('fyi', undefined), 'fyi')
  assert.equal(V.applyFloor('fyi', 'bogus'), 'fyi')
})

test('jev priority names fold into four', () => {
  assert.equal(V.JEV_PRIORITY_MAP.read, 'fyi')
  assert.equal(V.JEV_PRIORITY_MAP.low, 'noise')
  assert.deepEqual([...new Set(Object.values(V.JEV_PRIORITY_MAP))].sort(), [...V.PRIORITIES].sort())
})

test('checkItems rejects call bugs and reports item problems', () => {
  assert.throws(() => V.checkItems('x'), /array/)
  assert.throws(() => V.checkItems(Array.from({ length: 501 }, (_, i) => ({ id: String(i), text: 'a' }))), /at most 500/)
  assert.throws(() => V.checkItems([{ id: 'a' }, { id: 'a' }]), /duplicate/)
  assert.throws(() => V.checkItems([{ id: '' }]), /id/)
  const p = V.checkItems([
    { id: 'ok', text: 'hi' },
    { id: 'long', text: 'x'.repeat(V.MAX_TEXT + 1) },
    { id: 'hint', text: 'a', hint: { priority: 'high' } },
    { id: 'floor', text: 'a', floor: 'meh' },
    { id: 'fields', text: 'a', fields: { from: 5 } },
  ])
  assert.equal(p.ok, undefined)
  assert.match(p.long, /over the limit/)
  assert.match(p.hint, /priority/)
  assert.match(p.floor, /floor/)
  assert.match(p.fields, /fields.from/)
})

test('source names are short and plain', () => {
  V.checkSource('mail')
  V.checkSource('jira-cloud')
  assert.throws(() => V.checkSource('Mail'), /source/)
  assert.throws(() => V.checkSource(''), /source/)
  assert.throws(() => V.checkSource('a/b'), /source/)
})

test('titleOf takes the first non-empty line', () => {
  assert.equal(V.titleOf('\n  From: Ann\nbody'), 'From: Ann')
  assert.equal(V.titleOf(''), '(no text)')
  assert.equal(V.titleOf('x'.repeat(200), 10).length, 10)
})
