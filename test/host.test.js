'use strict'
// dist/host.js against a fake ctx: the service, the panel and the CLI wired together.
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const { JEV_MISSING } = require('../dist/lib/pipeline')
const { fakeCtx, fakeJev } = require('./fakes')

async function start(opts) {
  const ctx = fakeCtx(opts)
  host.activate(ctx)
  await ctx.sendPanel({ type: 'hello' }) // waits for the state load like every handler does
  return ctx
}

test('jev not available: panel notice, CLI exit 1, classify rejects only when Jev is needed', async () => {
  const jev = fakeJev({ available: false })
  const ctx = await start({ jev, project: { rules: [{ field: 'from', equals: 'a@b', priority: 'noise' }] } })
  const s = ctx.lastState()
  assert.equal(s.jevAvailable, false)
  assert.equal(s.jevMissing, JEV_MISSING)
  assert.equal(ctx.badges.at(-1), 'dot')

  const triage = ctx.provided.triage
  // Fully decided by hint and rule: answered without Jev.
  const ok = await triage.classify('mail', [
    { id: '1', text: 'x', hint: { priority: 'urgent' } },
    { id: '2', text: 'y', fields: { from: 'A@B' } },
  ])
  assert.equal(ok.results['1'].by, 'hint')
  assert.equal(ok.results['2'].by, 'rule')
  await assert.rejects(triage.classify('mail', [{ id: '3', text: 'needs jev' }]), (e) => e.message === JEV_MISSING)

  // classify reads a file (an absolute path here); the fake cli passes the plugin data dir as cwd.
  const itemsFile = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'triage-host-')), 'items.jsonl')
  require('node:fs').writeFileSync(itemsFile, '{"id":"a","text":"needs jev"}\n')
  const r = await ctx.runCli(['classify', itemsFile])
  assert.equal(r.code, 1)
  assert.equal(r.stderr, JEV_MISSING + '\n')
  assert.equal(jev.calls.length, 0)

  // Checked per call: jev enabled later just works, without a restart.
  jev.available = () => true
  const later = await triage.classify('mail', [{ id: '3', text: 'needs jev [action]' }])
  assert.equal(later.results['3'].priority, 'action')
  assert.equal(ctx.lastState().jevAvailable, true)
  assert.equal(ctx.lastState().jevError, null)
})

test('classify, Wrong?, override event, eval and rescore end to end', async () => {
  const jev = fakeJev()
  const ctx = await start({ jev })
  const triage = ctx.provided.triage
  const r = await triage.classify('mail', [{ id: 'm1', text: 'Weekly report [read] [notification]' }, { id: 'm2', text: 'Can you fix login? [action] [request]' }])
  assert.equal(r.results.m1.priority, 'fyi')
  assert.equal(r.stats.asked, 2)
  let rows = ctx.lastState().sources.mail
  assert.deepEqual(rows.map((x) => x.id), ['m2', 'm1']) // newest first
  assert.equal(rows.find((x) => x.id === 'm1').title, 'Weekly report [read] [notification]')

  // Wrong?: an override, a case, a change event.
  await ctx.sendPanel({ type: 'wrong', source: 'mail', id: 'm1', priority: 'noise', note: 'never read these' })
  rows = ctx.lastState().sources.mail
  const m1 = rows.find((x) => x.id === 'm1')
  assert.equal(m1.by, 'override')
  assert.equal(m1.priority, 'noise')
  assert.equal(m1.kind, 'notification')
  assert.equal(m1.hasCase, true)
  assert.deepEqual(ctx.emits.at(-1), { name: 'triage', event: 'change', data: { source: 'mail', ids: ['m1'] } })
  const again = await triage.classify('mail', [{ id: 'm1', text: 'Weekly report [read] [notification]' }])
  assert.equal(again.results.m1.by, 'override')
  assert.equal(again.stats.cached, 1)

  // The case fails with the current settings (Jev still says read); a rule fixes it.
  const cases = await ctx.runCli(['cases', '--json'])
  const c = JSON.parse(cases.stdout)
  assert.deepEqual(c.got.priority, 'fyi')
  assert.deepEqual(c.expected, { priority: 'noise' })
  assert.match((await ctx.runCli(['eval'])).stdout, /0\/1 passed/)
  await ctx.changeSettings({ rules: [{ field: 'text', contains: 'weekly report', priority: 'noise' }] })
  assert.deepEqual(ctx.emits.at(-1).data, { source: 'mail', ids: null })
  assert.match((await ctx.runCli(['eval'])).stdout, /1\/1 passed/)
  assert.deepEqual(ctx.lastState().lastEval.passed, 1)

  // The CLI's wrong does the same as the panel; an unknown id is refused.
  const w = await ctx.runCli(['wrong', 'mail', 'm2', 'urgent/incident', 'prod login'])
  assert.equal(w.code, undefined)
  assert.equal(ctx.lastState().cases, 2)
  assert.equal((await ctx.runCli(['wrong', 'mail', 'zz', 'fyi'])).code, 1)

  // Undo the override: the base verdict comes back.
  await ctx.sendPanel({ type: 'clear', source: 'mail', id: 'm1' })
  assert.equal(ctx.lastState().sources.mail.find((x) => x.id === 'm1').by, 'jev')

  // Improve opens a Claude tab with the case in its prompt.
  await ctx.sendPanel({ type: 'improve', source: 'mail', id: 'm1' })
  assert.equal(ctx.sessionsOpened.length, 1)
  assert.match(ctx.sessionsOpened[0].prompt, /^\[jev-triage-improve\]/)
  assert.match(ctx.sessionsOpened[0].prompt, /never read these/)

  // Rescore forgets the cache and tells the source.
  assert.match((await ctx.runCli(['rescore', 'mail'])).stdout, /forgot 2 cached verdicts of mail/)
  assert.deepEqual(ctx.emits.at(-1).data, { source: 'mail', ids: null })
})

test('a profile change drops the cache; state survives a re-activate', async () => {
  const jev = fakeJev()
  const storage = new Map()
  const ctx = await start({ jev, storage })
  await ctx.provided.triage.classify('mail', [{ id: 'a', text: 'hello' }])
  await ctx.changeSettings({ profile: 'I own billing.' })
  await host.deactivate()
  assert.equal(storage.get('cache').length, 0)
  await ctx.provided.triage.classify('mail', [{ id: 'a', text: 'hello' }])
  await ctx.provided.triage.override('mail', 'a', { priority: 'urgent', kind: 'incident' })
  await host.deactivate()

  // A fresh activate (the host restarts often) finds the cache, the override and the recent list.
  const ctx2 = fakeCtx({ jev, storage, dataDir: ctx.dataDir, project: { profile: 'I own billing.' } })
  host.activate(ctx2)
  await ctx2.sendPanel({ type: 'hello' })
  assert.equal(ctx2.lastState().sources.mail[0].by, 'override')
  const r = await ctx2.provided.triage.classify('mail', [{ id: 'a', text: 'hello' }])
  assert.equal(r.results.a.priority, 'urgent')
  assert.equal(r.stats.cached, 1)
  assert.equal(jev.calls.length, 2)
  await assert.rejects(ctx2.provided.triage.override('mail', 'a', { priority: 'big' }), /priority/)
})

test('a jev refusal shows on the panel until a call succeeds', async () => {
  const jev = fakeJev({ refuse: 'jev: monthly cap of $5 reached' })
  const ctx = await start({ jev })
  await assert.rejects(ctx.provided.triage.classify('mail', [{ id: 'a', text: 'x' }]), /cap/)
  assert.equal(ctx.lastState().jevError.message, 'jev: monthly cap of $5 reached')
  assert.equal(ctx.badges.at(-1), 'dot')
  jev.refuse = null
  await ctx.provided.triage.classify('mail', [{ id: 'a', text: 'x' }])
  assert.equal(ctx.lastState().jevError, null)
  assert.equal(ctx.badges.at(-1), null)
})

test('forget drops a source: listed verdicts, corrections, cases and cache; other sources stay', async () => {
  const jev = fakeJev()
  const ctx = await start({ jev })
  const triage = ctx.provided.triage
  await triage.classify('test', [{ id: 't1', text: 'Weekly report [read] [notification]' }, { id: 't2', text: 'Fix login [action] [request]' }])
  await triage.classify('mail', [{ id: 'm1', text: 'Can you review? [action] [request]' }])
  await ctx.sendPanel({ type: 'wrong', source: 'test', id: 't1', priority: 'noise' })
  await ctx.sendPanel({ type: 'wrong', source: 'mail', id: 'm1', priority: 'urgent' })
  assert.equal(ctx.lastState().cases, 2)

  const r = await ctx.runCli(['forget', 'test'])
  assert.equal(r.code, undefined)
  assert.match(r.stdout, /forgot test: 2 listed verdicts, 1 corrections, 1 cases, 2 cached Jev verdicts/)
  assert.deepEqual(Object.keys(ctx.lastState().sources), ['mail'])
  assert.equal(ctx.lastState().cases, 1)
  // The cache went too: the same text is asked of Jev again.
  const again = await triage.classify('test', [{ id: 't1', text: 'Weekly report [read] [notification]' }])
  assert.equal(again.results.t1.by, 'jev')
  assert.equal(again.stats.asked, 1)

  // The panel's Forget does the same; a bad source name is an error, not a forget of nothing.
  await ctx.sendPanel({ type: 'forget', source: 'test' })
  assert.deepEqual(Object.keys(ctx.lastState().sources), ['mail'])
  await ctx.sendPanel({ type: 'forget', source: 'Bad/Name' })
  assert.deepEqual(Object.keys(ctx.lastState().sources), ['mail'])
  assert.equal((await ctx.runCli(['forget'])).code, 2)
  assert.equal((await ctx.runCli(['forget', 'Bad/Name'])).code, 2)
})
