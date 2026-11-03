'use strict'
// Fakes shared by the suites: a jev service and a cc-cockpit ctx, written from `ccc guide api` and the
// jev README (the answer shape is what a real `ccc jev ask` printed for a choice question).

const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

/**
 * A fake jev: it answers by keywords in the text. `[urgent]`, `[action]`, `[read]`, `[low]`,
 * `[noise]` pick the priority choice (Jev's five names), `[alert]` etc. the kind; `[unsure]` gives a
 * low confidence; `[boom]` an item error. `refuse` makes every grid reject like a cap reached.
 */
function fakeJev(opts = {}) {
  const calls = []
  const jev = {
    calls,
    available: () => opts.available !== false,
    refuse: opts.refuse || null,
    model: opts.model || 'typesafe/jev-1.13-20260917',
    async grid(items, questions, options) {
      calls.push({ items, questions, options })
      if (jev.refuse) throw new Error(jev.refuse)
      const results = {}
      for (const it of items) {
        if (it.text.includes('[boom]') || jev.failAll) {
          results[it.id] = { error: jev.failAll || 'HTTP 500: upstream' }
          continue
        }
        const p = (it.text.match(/\[(urgent|action|read|low|noise)\]/) || [])[1] || 'read'
        const k = (it.text.match(/\[(request|incident|discussion|alert|notification|ack)\]/) || [])[1] || 'discussion'
        const conf = it.text.includes('[unsure]') ? 0.3 : 0.9
        results[it.id] = {
          answers: {
            priority: { type: 'choice', choice: p, probabilities: { [p]: conf }, confidence: conf },
            kind: { type: 'choice', choice: k, probabilities: { [k]: 1 }, confidence: 1 },
          },
          model: jev.model,
        }
      }
      return { results, stats: { items: items.length, errors: 0, tokens: 100 * items.length, cost: 0.00002 * items.length, ms: 5 } }
    },
  }
  return jev
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jev-triage-test-'))
}

/** A ctx good enough for dist/host.js: in-memory storage, recorded panel posts, events and CLI. */
function fakeCtx({ jev, project = {}, dataDir = tmpDir(), storage } = {}) {
  const store = storage || new Map()
  const panelListeners = []
  const settingsListeners = []
  const ctx = {
    api: 1,
    pluginId: 'bronos.jev-triage',
    projectDir: dataDir,
    dataDir,
    settings: Object.freeze({ project, app: {} }),
    posts: [],
    emits: [],
    badges: [],
    sessionsOpened: [],
    logs: [],
    cliHandler: null,
    provided: {},
    onSettingsChange(fn) {
      settingsListeners.push(fn)
      return () => {}
    },
    async changeSettings(project) {
      ctx.settings = Object.freeze({ project, app: {} })
      for (const fn of settingsListeners) await fn(ctx.settings)
    },
    storage: {
      async get(k) {
        return store.has(k) ? structuredClone(store.get(k)) : undefined
      },
      async set(k, v) {
        store.set(k, structuredClone(v))
      },
      async delete(k) {
        store.delete(k)
      },
      async keys() {
        return [...store.keys()]
      },
    },
    log: {
      info: (...a) => ctx.logs.push(['info', a.join(' ')]),
      warn: (...a) => ctx.logs.push(['warn', a.join(' ')]),
      error: (...a) => ctx.logs.push(['error', a.join(' ')]),
    },
    badge: (panel, v) => ctx.badges.push(v),
    panels: {
      post: (panel, m) => ctx.posts.push(structuredClone(m)),
      onMessage: (panel, fn) => {
        panelListeners.push(fn)
        return () => {}
      },
      show() {},
    },
    async sendPanel(m) {
      for (const fn of panelListeners) await fn(m)
    },
    sessions: {
      async open(o) {
        ctx.sessionsOpened.push(o)
        return { tabId: 't1' }
      },
    },
    cli: {
      register: (name, fn) => {
        ctx.cliHandler = fn
        return () => {}
      },
    },
    async runCli(argv, stdin = '') {
      return ctx.cliHandler(argv, { stdin, cwd: dataDir, signal: new AbortController().signal })
    },
    services: {
      use: (name) => ({ grid: (...a) => jev.grid(...a), on: () => () => {} }),
      provide: (name, impl) => {
        ctx.provided[name] = impl
      },
      emit: (name, event, data) => ctx.emits.push({ name, event, data: structuredClone(data) }),
      available: (name) => name === 'jev' && !!jev && jev.available(),
      caller: () => undefined,
    },
    lastState() {
      return [...ctx.posts].reverse().find((m) => m.type === 'state')
    },
  }
  return ctx
}

module.exports = { fakeJev, fakeCtx, tmpDir }
