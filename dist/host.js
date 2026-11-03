'use strict'
// Jev triage (bronos.jev-triage): the `triage` service for source plugins, its panel and `ccc triage`.
// Plain JavaScript run as is (no build). The decisions live in ./lib (pure, covered by test/); this
// file wires them to ctx: storage, the jev service, the panel, the CLI and the service events.
// Docs used: `ccc guide api` (ctx), `ccc guide plugins` (manifest), the jev README (service jev v1).

const fs = require('node:fs')
const path = require('node:path')
const V = require('./lib/vocab')
const { buildQuestions } = require('./lib/questions')
const { normalizeRules } = require('./lib/rules')
const { VerdictCache, OverrideStore, RecentStore } = require('./lib/stores')
const { classify, JEV_MISSING } = require('./lib/pipeline')
const C = require('./lib/cases')
const { improvePrompt } = require('./lib/improve')
const cli = require('./lib/cli')

const PANEL = 'main'
const LABEL = 'jev-triage'

let flush = null // deactivate waits for the pending writes

exports.activate = (ctx) => {
  ctx.log.info('activated')
  // A handle is resolved on every call (ccc guide api), so taking it here is fine even while jev is
  // missing; whether a call would reach jev is asked per call with ctx.services.available.
  const jevHandle = ctx.services.use('jev')

  // ---- state, loaded once per activate (the host restarts often: keep nothing only in memory) ----
  const S = {
    cache: new VerdictCache(),
    overrides: new OverrideStore(),
    recent: new RecentStore(),
    cases: [],
    lastEval: null,
    // jev's last refusal (cap reached, no key), shown by the panel until a call succeeds again.
    jevError: null,
    // The model part of the cache key (design "Cache"). This plugin cannot read jev's settings, and a
    // jev.grid answer (checked against the real service, jev 1.0.0) carries no model, unlike jev.ask;
    // so it stays 'unknown' until jev reports one per result or per grid, and is learned from there.
    // Until then a change of jev's model needs `ccc triage rescore` (README).
    model: 'unknown',
    fingerprint: null,
  }
  const recentFile = () => path.join(ctx.dataDir, 'recent.json')
  const casesFile = () => path.join(ctx.dataDir, 'cases.jsonl')

  const ready = (async () => {
    try {
      S.fingerprint = settingsView().fingerprint
      S.cache = VerdictCache.fromJSON(await ctx.storage.get('cache'))
      S.model = (await ctx.storage.get('model')) || 'unknown'
      S.lastEval = (await ctx.storage.get('lastEval')) || null
      for (const key of await ctx.storage.keys()) {
        if (key.startsWith('overrides:')) S.overrides.loadSource(key.slice('overrides:'.length), await ctx.storage.get(key))
      }
      S.recent = RecentStore.fromJSON(readJson(recentFile()))
      S.cases = C.parseJsonl(readText(casesFile()))
    } catch (e) {
      ctx.log.error('loading state failed, starting empty:', String((e && e.stack) || e))
    }
  })()

  // One write at a time, in order: two classify calls finishing together must not interleave a
  // half-written recent.json, and ctx.storage has no transactions.
  let chain = Promise.resolve()
  function persist(what, fn) {
    chain = chain.then(fn).catch((e) => ctx.log.error(`saving ${what} failed:`, String((e && e.message) || e)))
    return chain
  }
  flush = () => chain

  function saveCache() {
    if (!S.cache.dirty) return
    S.cache.dirty = false
    const data = S.cache.toJSON()
    const model = S.model
    return persist('cache', async () => {
      await ctx.storage.set('cache', data)
      await ctx.storage.set('model', model)
    })
  }
  function saveOverrides(source) {
    const data = S.overrides.sourceJSON(source)
    return persist('overrides', () => (data.length ? ctx.storage.set(`overrides:${source}`, data) : ctx.storage.delete(`overrides:${source}`)))
  }
  function saveRecent() {
    const data = JSON.stringify(S.recent)
    return persist('recent', () => writeAtomic(recentFile(), data))
  }
  function saveCases() {
    const data = C.toJsonl(S.cases)
    return persist('cases', () => writeAtomic(casesFile(), data))
  }

  // ---- settings: read fresh every time (a save replaces ctx.settings whole) ----
  function settingsView() {
    const p = ctx.settings.project || {}
    const { questions, fingerprint } = buildQuestions(p)
    const { rules, problems } = normalizeRules(p.rules)
    return { questions, fingerprint, rules, problems, profile: typeof p.profile === 'string' ? p.profile.trim() : '' }
  }

  function deps(view) {
    return {
      questions: view.questions,
      fingerprint: view.fingerprint,
      rules: view.rules,
      cache: S.cache,
      overrides: S.overrides,
      label: LABEL,
      model: {
        get: () => S.model,
        set: (m) => {
          // Logged because a new model rescores everything (it is in the cache key).
          ctx.log.info(`jev model: ${m} (was ${S.model})`)
          S.model = m
        },
      },
      jev: {
        // Asked per call (fresh each time): jev can be installed or enabled after this activate.
        available: () => ctx.services.available('jev'),
        grid: (items, questions, options) => jevHandle.grid(items, questions, options),
      },
    }
  }

  function knownSources() {
    return [...new Set([...S.recent.sources(), ...S.overrides.sources()])].sort()
  }

  // The service event: sources call classify again for these ids (null: every item of the source).
  function changed(source, ids) {
    try {
      ctx.services.emit('triage', 'change', { source, ids })
    } catch (e) {
      ctx.log.warn('emit change failed:', String((e && e.message) || e))
    }
  }

  // ---- classify, used by the service, the CLI and (with no cache or overrides) the eval ----
  async function runClassify(source, items) {
    await ready
    const view = settingsView()
    for (const p of view.problems) ctx.log.warn('rules:', p)
    let r
    try {
      r = await classify(deps(view), source, items)
      S.jevError = null
    } catch (e) {
      const msg = String((e && e.message) || e)
      if (msg === JEV_MISSING || msg.startsWith('jev')) S.jevError = { message: msg, at: new Date().toISOString() }
      throw e
    } finally {
      // Chunks that finished before a refusal are cached: a retry continues from there.
      saveCache()
      postState()
    }
    for (const row of r.rows) S.recent.add(source, row)
    if (r.rows.length) saveRecent()
    postState()
    return { results: r.results, stats: r.stats }
  }

  async function runEval(cases) {
    await ready
    const r = await C.evalCases(deps(settingsView()), cases)
    const le = (S.lastEval = { passed: r.passed, total: r.total, at: new Date().toISOString() })
    persist('lastEval', () => ctx.storage.set('lastEval', le))
    postState()
    return r
  }

  async function rescore(source) {
    await ready
    const cleared = S.cache.clear(source || undefined)
    saveCache()
    const sources = source ? [source] : knownSources()
    for (const s of sources) changed(s, null)
    return { cleared, sources }
  }

  // The final verdict of a listed row after its override changed: the override (or the base again),
  // then the floor, exactly as classify would do.
  function refreshRow(source, id) {
    const row = S.recent.find(source, id)
    if (!row) return
    const o = S.overrides.get(source, id)
    const v = o ? { priority: o.priority, kind: o.kind || row.base.kind, confidence: 1, by: 'override' } : { ...row.base }
    const p = V.applyFloor(v.priority, row.floor)
    if (p !== v.priority) {
      v.priority = p
      v.floored = true
    }
    row.final = v
    saveRecent()
  }

  async function setOverride(source, id, verdict) {
    await ready
    V.checkSource(source)
    V.checkId(id, 'override')
    const v = V.checkVerdictInput(verdict, 'override')
    S.overrides.set(source, id, v, new Date().toISOString())
    saveOverrides(source)
    refreshRow(source, id)
    changed(source, [id])
    postState()
  }

  async function clearOverride(source, id) {
    await ready
    V.checkSource(source)
    V.checkId(id, 'clear')
    const had = S.overrides.clear(source, id)
    if (had) {
      saveOverrides(source)
      refreshRow(source, id)
      changed(source, [id])
      postState()
    }
    return had
  }

  // Wrong? (panel) and `ccc triage wrong`: the person's answer becomes an override and a case. The
  // case needs the text Jev saw, so only a verdict still in the recent list can be corrected this way.
  async function wrong(source, id, verdict, note) {
    await ready
    const row = S.recent.find(source, id)
    if (!row) throw new Error(`triage: ${source}/${id} is not among the recent verdicts`)
    const expected = V.checkVerdictInput(verdict, 'answer')
    S.cases = C.addCase(S.cases, C.makeCase(source, row, expected, note, Date.now()))
    saveCases()
    await setOverride(source, id, expected)
  }

  // ---- the service (v1) ----
  ctx.services.provide('triage', {
    classify: (source, items) => runClassify(source, items),
    override: (source, id, verdict) => setOverride(source, id, verdict),
    clear: (source, id) => clearOverride(source, id),
  })

  // A change of profile or questions makes every cached key unreachable (they are in the key): drop
  // them now instead of waiting for eviction. Rules are not in the key (they run before the cache) but
  // still change verdicts, so every settings save tells the sources to classify again.
  ctx.onSettingsChange(async () => {
    await ready
    const view = settingsView()
    if (view.fingerprint !== S.fingerprint) {
      S.fingerprint = view.fingerprint
      const n = S.cache.clear()
      saveCache()
      ctx.log.info(`questions or profile changed: forgot ${n} cached verdicts`)
    }
    for (const p of view.problems) ctx.log.warn('rules:', p)
    for (const s of knownSources()) changed(s, null)
    postState()
  })

  // ---- panel ----
  function postState() {
    const jevAvailable = ctx.services.available('jev')
    const caseKeys = new Set(S.cases.map((c) => `${c.source}\u0000${c.id}`))
    const sources = {}
    for (const s of S.recent.sources()) {
      sources[s] = S.recent.list(s).map((r) => ({
        id: r.id,
        title: V.titleOf(r.text),
        priority: r.final.priority,
        kind: r.final.kind || null,
        by: r.final.by,
        confidence: r.final.confidence,
        floored: !!r.final.floored,
        at: r.at,
        hasCase: caseKeys.has(`${s}\u0000${r.id}`),
      }))
    }
    try {
      ctx.badge(PANEL, !jevAvailable || S.jevError ? 'dot' : null)
      ctx.panels.post(PANEL, {
        type: 'state',
        jevAvailable,
        jevMissing: JEV_MISSING,
        jevError: S.jevError,
        lastEval: S.lastEval,
        cases: S.cases.length,
        sources,
        priorities: V.PRIORITIES,
        kinds: V.KINDS,
      })
    } catch (e) {
      ctx.log.warn('posting panel state failed:', String((e && e.message) || e))
    }
  }

  function panelError(message) {
    ctx.panels.post(PANEL, { type: 'error', message: String(message) })
  }

  ctx.panels.onMessage(PANEL, async (m) => {
    try {
      await ready
      if (!m || typeof m !== 'object') return
      if (m.type === 'hello' || m.type === 'refresh') return postState()
      if (m.type === 'wrong') return void (await wrong(m.source, m.id, { priority: m.priority, kind: m.kind || undefined }, m.note))
      if (m.type === 'clear') return void (await clearOverride(m.source, m.id))
      if (m.type === 'improve') {
        const c = S.cases.find((x) => x.source === m.source && x.id === m.id)
        const row = S.recent.find(m.source, m.id)
        if (!c && !row) return panelError('that verdict is no longer listed')
        const subject = c
          ? { source: c.source, id: c.id, text: c.text, got: c.got, expected: c.expected, note: c.note, isCase: true }
          : { source: m.source, id: m.id, text: row.text, got: row.base, isCase: false }
        await ctx.sessions.open({ prompt: improvePrompt(ctx.pluginId, subject, settingsView()) })
        return
      }
      if (m.type === 'eval') {
        if (!S.cases.length) return panelError('no cases yet: Wrong? on a verdict records one')
        await runEval(S.cases)
        return
      }
    } catch (e) {
      panelError((e && e.message) || e)
    }
  })

  // ---- ccc triage ----
  ctx.cli.register('triage', async (argv, call) => {
    await ready
    return cli.run(argv, call, {
      classify: runClassify,
      evaluate: runEval,
      rescore,
      wrong,
      cases: async () => S.cases,
      deleteCase: async (source, id) => {
        const before = S.cases.length
        S.cases = C.removeCase(S.cases, source, id)
        if (S.cases.length === before) return false
        saveCases()
        postState()
        return true
      },
      questions: () => settingsView().questions,
    })
  })
}

exports.deactivate = () => (flush ? flush() : undefined)

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Write a temp file and rename it over the old one, so a crash mid-write leaves the old file whole.
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  await fs.promises.writeFile(tmp, data)
  await fs.promises.rename(tmp, file)
}
