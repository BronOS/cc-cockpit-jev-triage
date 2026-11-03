'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { classify, chunk, JEV_MISSING } = require('../dist/lib/pipeline')
const { normalizeRules } = require('../dist/lib/rules')
const { buildQuestions } = require('../dist/lib/questions')
const { VerdictCache, OverrideStore } = require('../dist/lib/stores')
const { fakeJev } = require('./fakes')

function deps(over = {}) {
  const { questions, fingerprint } = buildQuestions(over.project || {})
  let model = over.model || 'unknown'
  return {
    questions,
    fingerprint,
    rules: normalizeRules(over.rules || []).rules,
    cache: over.cache === undefined ? new VerdictCache() : over.cache,
    overrides: over.overrides === undefined ? new OverrideStore() : over.overrides,
    jev: over.jev || fakeJev(),
    model: { get: () => model, set: (m) => (model = m) },
    label: 'jev-triage',
    now: () => 1000,
  }
}

test('order: hint, then rule, then jev, then override, then floor', async () => {
  const overrides = new OverrideStore()
  overrides.set('mail', 'o', { priority: 'urgent' }, 't')
  const d = deps({
    overrides,
    rules: [
      { field: 'from', equals: 'alerts@x', priority: 'noise', kind: 'alert' },
      { field: 'from', equals: 'boss@x', priority: 'action' },
    ],
  })
  const { results, stats } = await classify(d, 'mail', [
    { id: 'h', text: 'disk full', hint: { priority: 'fyi', kind: 'alert' } },
    { id: 'hr', text: 'boss alert', hint: { priority: 'fyi', kind: 'alert' }, fields: { from: 'boss@x' } },
    { id: 'r', text: 'ping', fields: { from: 'alerts@x' } },
    { id: 'j', text: 'please review [action] [request]' },
    { id: 'o', text: 'meh [noise] [ack]' },
    { id: 'f', text: 'thanks [noise] [ack]', floor: 'fyi' },
  ])
  assert.deepEqual(results.h, { priority: 'fyi', kind: 'alert', confidence: 1, by: 'hint' })
  // The rule comes after the hint, so it wins; it gives no kind, so the hint's stays.
  assert.deepEqual(results.hr, { priority: 'action', kind: 'alert', confidence: 1, by: 'rule' })
  assert.deepEqual(results.r, { priority: 'noise', kind: 'alert', confidence: 1, by: 'rule' })
  assert.deepEqual(results.j, { priority: 'action', kind: 'request', confidence: 0.9, by: 'jev' })
  // The override replaces the priority and keeps Jev's kind (it gave none).
  assert.deepEqual(results.o, { priority: 'urgent', kind: 'ack', confidence: 1, by: 'override' })
  assert.deepEqual(results.f, { priority: 'fyi', kind: 'ack', confidence: 0.9, by: 'jev', floored: true })
  assert.equal(d.jev.calls.length, 1)
  assert.equal(d.jev.calls[0].items.length, 3) // only j, o and f reach Jev
  assert.equal(d.jev.calls[0].options.label, 'jev-triage')
  assert.equal(stats.hint, 1)
  assert.equal(stats.rule, 2)
  assert.equal(stats.jev, 2)
  assert.equal(stats.override, 1)
  assert.equal(stats.floored, 1)
})

test('read and low map to fyi and noise; confidence is the priority answer\'s', async () => {
  const { results } = await classify(deps(), 'mail', [
    { id: 'a', text: '[read]' },
    { id: 'b', text: '[low] [alert] [unsure]' },
  ])
  assert.equal(results.a.priority, 'fyi')
  assert.equal(results.b.priority, 'noise')
  assert.equal(results.b.kind, 'alert')
  assert.equal(results.b.confidence, 0.3)
})

test('the profile is in the questions jev gets', async () => {
  const d = deps({ project: { profile: 'I own billing.' } })
  await classify(d, 'mail', [{ id: 'a', text: 'x' }])
  assert.match(d.jev.calls[0].questions.priority.instructions, /I own billing\.$/)
  assert.equal(d.jev.calls[0].questions.priority.type, 'choice')
})

test('chunks of 50 per jev.grid call', async () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  const d = deps()
  const items = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, text: `item ${i} [action]` }))
  const { results, stats } = await classify(d, 'mail', items)
  assert.deepEqual(d.jev.calls.map((c) => c.items.length), [50, 50, 20])
  assert.equal(Object.keys(results).length, 120)
  assert.equal(stats.asked, 120)
  assert.equal(stats.tokens, 12000)
})

test('the cache answers the same text again, until the questions change', async () => {
  const cache = new VerdictCache()
  const jev = fakeJev()
  const d = deps({ cache, jev })
  await classify(d, 'mail', [{ id: 'a', text: 'hello [action]' }])
  // The model is learned from the answer and the entry is stored under it.
  assert.equal(d.model.get(), 'typesafe/jev-1.13-20260917')
  const again = await classify(d, 'mail', [{ id: 'a', text: 'hello [action]' }, { id: 'b', text: 'new [noise]' }])
  assert.equal(jev.calls.length, 2)
  assert.equal(jev.calls[1].items.length, 1) // only b
  assert.equal(again.stats.cached, 1)
  assert.equal(again.results.a.priority, 'action')
  // Another source does not share the entry.
  await classify(d, 'jira', [{ id: 'a', text: 'hello [action]' }])
  assert.equal(jev.calls.length, 3)
  // A new profile is a new fingerprint: the same text goes to Jev again.
  const d2 = { ...deps({ cache, jev, project: { profile: 'changed' } }), model: d.model }
  await classify(d2, 'mail', [{ id: 'a', text: 'hello [action]' }])
  assert.equal(jev.calls.length, 4)
})

test('item errors stay per item; a refusal rejects the whole call', async () => {
  const d = deps()
  const { results } = await classify(d, 'mail', [
    { id: 'ok', text: '[action]' },
    { id: 'bad', text: '[boom]' },
    { id: 'empty', text: '  ' },
    { id: 'hint', text: '', hint: { priority: 'noise' } },
  ])
  assert.equal(results.ok.priority, 'action')
  assert.match(results.bad.error, /HTTP 500/)
  assert.match(results.empty.error, /no text/)
  assert.equal(results.hint.kind, null)

  const refusing = deps({ jev: fakeJev({ refuse: 'jev: monthly cap of $5 reached' }) })
  await assert.rejects(classify(refusing, 'mail', [{ id: 'a', text: 'x' }]), /jev: monthly cap of \$5 reached/)

  // Every item of a chunk failing is jev refusing too.
  const all = deps()
  all.jev.failAll = 'no API key set'
  await assert.rejects(classify(all, 'mail', [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]), /^Error: jev: no API key set$/)
})

test('chunks done before a refusal are cached', async () => {
  const cache = new VerdictCache()
  const jev = fakeJev()
  const d = deps({ cache, jev })
  let n = 0
  const grid = jev.grid
  jev.grid = async (...a) => {
    if (n++ === 1) throw new Error('jev: request cap reached')
    return grid(...a)
  }
  const items = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, text: `t${i}` }))
  await assert.rejects(classify(d, 'mail', items), /request cap/)
  assert.equal(cache.size, 50)
})

test('jev missing: rejects with the install hint only when an item needs Jev', async () => {
  const jev = fakeJev({ available: false })
  const overrides = new OverrideStore()
  overrides.set('mail', 'o', { priority: 'fyi' }, 't')
  const d = deps({ jev, overrides, rules: [{ field: 'from', equals: 'x', priority: 'noise' }] })
  // Hint and rule decide everything: no Jev needed, no rejection.
  const { results } = await classify(d, 'mail', [
    { id: 'h', text: 'a', hint: { priority: 'urgent' } },
    { id: 'r', text: 'b', fields: { from: 'x' } },
  ])
  assert.equal(results.h.by, 'hint')
  assert.equal(results.r.by, 'rule')
  // An item for Jev, even one the person has overridden, still needs Jev's base verdict.
  await assert.rejects(classify(d, 'mail', [{ id: 'h', text: 'a', hint: { priority: 'urgent' } }, { id: 'j', text: 'c' }]), (e) => e.message === JEV_MISSING)
  assert.equal(jev.calls.length, 0)
  assert.match(JEV_MISSING, /bronos\.jev/)
})

test('jev missing: cached verdicts still come back', async () => {
  const cache = new VerdictCache()
  const jev = fakeJev()
  const d = deps({ cache, jev })
  await classify(d, 'mail', [{ id: 'a', text: 'known [urgent]' }])
  jev.available = () => false
  const { results } = await classify(d, 'mail', [{ id: 'a', text: 'known [urgent]' }])
  assert.equal(results.a.priority, 'urgent')
})

test('call bugs reject before any jev call', async () => {
  const d = deps()
  await assert.rejects(classify(d, 'Mail', []), /source/)
  await assert.rejects(classify(d, 'mail', [{ id: 'a' }, { id: 'a' }]), /duplicate/)
  assert.equal(d.jev.calls.length, 0)
})
