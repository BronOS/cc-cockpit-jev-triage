'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { improvePrompt, PROMPT_TEXT } = require('../dist/lib/improve')
const { normalizeRules } = require('../dist/lib/rules')

test('the improve prompt carries the item, the settings and the loop', () => {
  const p = improvePrompt(
    'bronos.jev-triage',
    { source: 'mail', id: 'm1', text: 'From: Ann\n' + 'x'.repeat(PROMPT_TEXT), got: { priority: 'fyi', kind: 'discussion', by: 'jev', confidence: 0.42 }, expected: { priority: 'action' }, note: 'Ann is my lead', isCase: true },
    { profile: 'I own billing.', rules: normalizeRules([{ field: 'from', equals: 'x@y', priority: 'noise' }]).rules, problems: [] },
  )
  // ctx.sessions.open refuses a prompt starting with / ! # &.
  assert.ok(!/^[/!#&]/.test(p))
  assert.match(p, /triage said: fyi\/discussion by jev \(confidence 0\.42\)/)
  assert.match(p, /should be: action/)
  assert.match(p, /Ann is my lead/)
  assert.match(p, /I own billing\./)
  assert.match(p, /from = "x@y" -> noise/)
  assert.match(p, /ccc triage eval/)
  assert.match(p, /ccc plugin config bronos\.jev-triage --scope project/)
  assert.match(p, /ccc triage rescore mail <\/dev\/null/)
  assert.match(p, /\[\.\.\. cut/)
})
