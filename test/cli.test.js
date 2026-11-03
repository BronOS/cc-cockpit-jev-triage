'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const cli = require('../dist/lib/cli')
const { JEV_MISSING } = require('../dist/lib/pipeline')

const call = (stdin = '') => ({ stdin, cwd: '/', signal: new AbortController().signal })

function deps(over = {}) {
  return {
    classify: async (source, items) => ({
      results: Object.fromEntries(items.map((i) => [i.id, { priority: 'fyi', kind: 'discussion', confidence: 0.75, by: 'jev' }])),
      stats: { items: items.length, hint: 0, rule: 0, jev: items.length, override: 0, cached: 0, floored: 0, errors: 0, asked: items.length, tokens: 10, cost: 0.00001 },
      source,
    }),
    evaluate: async () => ({ passed: 1, total: 2, rows: [{ ok: true }, { ok: false, source: 'mail', id: 'b', expected: { priority: 'noise' }, got: { priority: 'fyi', kind: 'ack', by: 'jev', confidence: 0.5 }, title: 'thanks', note: 'just ack' }] }),
    rescore: async (s) => ({ cleared: 3, sources: s ? [s] : ['mail', 'jira'] }),
    cases: async () => [],
    deleteCase: async () => false,
    questions: () => ({ priority: {}, kind: {} }),
    ...over,
  }
}

test('help and unknown subcommands', async () => {
  assert.match((await cli.run([], call(), deps())).stdout, /ccc triage classify/)
  assert.match((await cli.run(['help'], call(), deps())).stdout, /ccc triage eval/)
  const r = await cli.run(['nope'], call(), deps())
  assert.equal(r.code, 2)
})

// classify reads a file relative to the caller's folder (not stdin: see cli.js).
const fsx = require('node:fs')
const osx = require('node:os')
const pathx = require('node:path')
function itemsDir(files) {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'triage-cli-'))
  for (const [name, text] of Object.entries(files)) fsx.writeFileSync(pathx.join(dir, name), text)
  return { stdin: '', cwd: dir, signal: new AbortController().signal }
}

test('classify reads a JSONL file and prints one line per item plus stats on stderr', async () => {
  let seen
  const d = deps({ classify: async (s, items) => { seen = s; return deps().classify(s, items) } })
  const c = itemsDir({ 'items.jsonl': '{"id":"a","text":"Hello there"}\n\n{"id":"b","text":"x"}\n', 'one.jsonl': '{"id":"a","text":"x"}' })
  const r = await cli.run(['classify', 'items.jsonl', 'mail'], c, d)
  assert.equal(seen, 'mail')
  assert.match(r.stdout, /^a\s+fyi\s+discussion\s+jev\s+0\.75\s+Hello there/m)
  assert.match(r.stderr, /2 items, 2 jev, 2 asked Jev/)
  const j = await cli.run(['classify', 'one.jsonl', '--json'], c, d)
  assert.equal(seen, 'cli')
  assert.deepEqual(JSON.parse(j.stdout), { id: 'a', priority: 'fyi', kind: 'discussion', confidence: 0.75, by: 'jev' })
})

test('classify input errors are usage errors', async () => {
  const c = itemsDir({ 'empty.jsonl': '', 'bad.jsonl': '{"id":"a"}\nnot json', 'ok.jsonl': '{}' })
  assert.equal((await cli.run(['classify'], c, deps())).code, 2)
  assert.equal((await cli.run(['classify', 'empty.jsonl'], c, deps())).code, 2)
  assert.match((await cli.run(['classify', 'missing.jsonl'], c, deps())).stderr, /cannot read missing\.jsonl/)
  assert.match((await cli.run(['classify', '.'], c, deps())).stderr, /is not a file/)
  const bad = await cli.run(['classify', 'bad.jsonl'], c, deps())
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /line 2/)
  assert.equal((await cli.run(['classify', 'ok.jsonl', 'Bad/Name'], c, deps())).code, 2)
})

test('jev missing: the install hint on stderr, exit 1', async () => {
  const r = await cli.run(['classify', 'one.jsonl'], itemsDir({ 'one.jsonl': '{"id":"a","text":"x"}' }), deps({ classify: async () => { throw new Error(JEV_MISSING) } }))
  assert.equal(r.code, 1)
  assert.equal(r.stderr, JEV_MISSING + '\n')
  const e = await cli.run(['eval'], call(), deps({ cases: async () => [{}], evaluate: async () => { throw new Error(JEV_MISSING) } }))
  assert.equal(e.code, 1)
  assert.equal(e.stderr, JEV_MISSING + '\n')
})

test('a jev refusal is printed as jev said it', async () => {
  const r = await cli.run(['classify', 'one.jsonl'], itemsDir({ 'one.jsonl': '{"id":"a","text":"x"}' }), deps({ classify: async () => { throw new Error('jev: monthly cap reached') } }))
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'jev: monthly cap reached\n')
})

test('eval prints failures and the pass count', async () => {
  const none = await cli.run(['eval'], call(), deps())
  assert.match(none.stdout, /no cases yet/)
  const r = await cli.run(['eval'], call(), deps({ cases: async () => [{}, {}] }))
  assert.match(r.stdout, /FAIL  mail\/b  want noise  got fyi\/ack by jev 0\.50  thanks  note: just ack/)
  assert.match(r.stdout, /1\/2 passed\n$/)
})

test('wrong parses priority/kind and the note', async () => {
  let got
  const d = deps({ wrong: async (...a) => { got = a } })
  const r = await cli.run(['wrong', 'mail', 'm1', 'action/request', 'Ann', 'is', 'my', 'lead'], call(), d)
  assert.deepEqual(got, ['mail', 'm1', { priority: 'action', kind: 'request' }, 'Ann is my lead'])
  assert.match(r.stdout, /override mail\/m1 = action\/request/)
  assert.equal((await cli.run(['wrong', 'mail', 'm1', 'high'], call(), d)).code, 2)
  assert.equal((await cli.run(['wrong', 'mail', 'm1', 'fyi/chat'], call(), d)).code, 2)
  assert.equal((await cli.run(['wrong', 'mail'], call(), d)).code, 2)
})

test('rescore, cases and questions', async () => {
  assert.match((await cli.run(['rescore'], call(), deps())).stdout, /forgot 3 cached verdicts; told mail, jira/)
  assert.match((await cli.run(['rescore', 'mail'], call(), deps())).stdout, /of mail; told mail/)
  assert.match((await cli.run(['cases'], call(), deps())).stdout, /no cases yet/)
  const one = [{ id: 'a', source: 'mail', text: 'Hi', expected: { priority: ['fyi', 'noise'], kind: 'ack' }, got: { priority: 'action', kind: null, by: 'jev' }, note: 'n', at: '2026-11-02T00:00:00.000Z' }]
  assert.match((await cli.run(['cases'], call(), deps({ cases: async () => one }))).stdout, /2026-11-02  mail\/a  want fyi\|noise\/ack  got action\/- by jev  Hi  note: n\n1 cases/)
  assert.equal((await cli.run(['cases', 'delete', 'mail', 'x'], call(), deps())).code, 1)
  assert.equal((await cli.run(['cases', 'delete'], call(), deps())).code, 2)
  assert.deepEqual(JSON.parse((await cli.run(['questions'], call(), deps())).stdout), { priority: {}, kind: {} })
})
