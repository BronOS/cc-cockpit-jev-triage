'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Q = require('../dist/lib/questions')

test('built-in questions are two choice questions with jev criteria names', () => {
  const { questions } = Q.buildQuestions({})
  assert.equal(questions.priority.type, 'choice')
  assert.deepEqual(Object.keys(questions.priority.criteria), ['urgent', 'action', 'read', 'low', 'noise'])
  assert.deepEqual(Object.keys(questions.kind.criteria), ['request', 'incident', 'discussion', 'alert', 'notification', 'ack'])
  assert.equal(questions.priority.instructions, Q.DEFAULT_PRIORITY_INSTRUCTIONS)
})

test('the profile is appended to the priority question only', () => {
  const { questions } = Q.buildQuestions({ profile: '  I run the billing service.  ' })
  assert.ok(questions.priority.instructions.endsWith(Q.PROFILE_HEADER + 'I run the billing service.'))
  assert.equal(questions.kind.instructions, Q.DEFAULT_KIND_INSTRUCTIONS)
})

test('wording overrides per key; empty keeps the built-in', () => {
  const { questions } = Q.buildQuestions({
    priorityInstructions: 'Mine?',
    priorityCriteria: { urgent: 'On fire.', action: '', bogus: 'x' },
    kindCriteria: { ack: 'Just ok.' },
  })
  assert.equal(questions.priority.instructions, 'Mine?')
  assert.equal(questions.priority.criteria.urgent, 'On fire.')
  assert.equal(questions.priority.criteria.action, Q.DEFAULT_PRIORITY_CRITERIA.action)
  assert.equal(questions.priority.criteria.bogus, undefined)
  assert.equal(questions.kind.criteria.ack, 'Just ok.')
})

test('the fingerprint follows the profile and the wording, not the rules', () => {
  const a = Q.buildQuestions({}).fingerprint
  assert.equal(Q.buildQuestions({ rules: [{ field: 'x', equals: 'y', priority: 'fyi' }] }).fingerprint, a)
  assert.notEqual(Q.buildQuestions({ profile: 'p' }).fingerprint, a)
  assert.notEqual(Q.buildQuestions({ kindInstructions: 'k' }).fingerprint, a)
  assert.equal(Q.buildQuestions({ profile: 'p' }).fingerprint, Q.buildQuestions({ profile: 'p' }).fingerprint)
})
