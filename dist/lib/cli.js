'use strict'
// `ccc triage ...`: parsing and printing only. The work comes in through `deps` (the host wires it to
// the same code the service uses), so the tests drive every subcommand with fakes.

const V = require('./vocab')
const { JEV_MISSING } = require('./pipeline')

const HELP = `triage: priority and kind for items of source plugins, judged by Jev (bronos.jev) with project rules and your corrections

  ccc triage classify [source] [--json] < items.jsonl
        judge items (one JSON object per line: { "id", "text", "hint"?, "floor"?, "fields"? });
        source defaults to "cli". Uses the cache and overrides like a source plugin would, and lists
        the verdicts in the panel. --json prints one { id, priority, kind, confidence, by } per line
  ccc triage eval [--json]        re-judge every case with the current settings (no cache, no overrides);
                                  prints the pass count and the failures
  ccc triage rescore [source]     forget cached Jev verdicts (of one source, or all) and tell sources to
                                  classify again
  ccc triage wrong <source> <id> <priority>[/<kind>] [note...]
                                  what the panel's Wrong? does: store your correction as an override and
                                  record the item (from the recent verdicts) as a case
  ccc triage cases [--json]       the recorded cases (Wrong? adds one)
  ccc triage cases delete <source> <id>
                                  remove one case
  ccc triage questions            the two Jev questions as this project's settings build them
  ccc triage help                 this text

Settings (per project): ccc plugin config bronos.jev-triage --scope project profile='"..."' rules='[...]'
Rules: { "source"?, "field", "equals" | "contains", "priority", "kind"? }; field is one of the item's
fields or "text"; first match wins, case-insensitive. Priorities: ${V.PRIORITIES.join(', ')}.
Kinds: ${V.KINDS.join(', ')}.
`

// The CLI has 30 s in all (exit 124 after); stop waiting a little before so the person gets a message
// instead of a bare timeout. A jev call already running finishes in the host, and its verdicts are
// cached, so running the command again continues from there.
const BUDGET_MS = 27000

function usage(msg) {
  return { stderr: `triage: ${msg}\nrun \`ccc triage help\`\n`, code: 2 }
}

function fail(e) {
  const msg = String((e && e.message) || e)
  return { stderr: (msg === JEV_MISSING ? msg : msg.startsWith('triage:') || msg.startsWith('jev') ? msg : `triage: ${msg}`) + '\n', code: 1 }
}

function withBudget(promise, ms, what) {
  let t
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`triage: ${what} took over ${Math.round(ms / 1000)} s; verdicts done so far are cached, run it again`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}

function parseItems(stdin) {
  const items = []
  const lines = String(stdin || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let v
    try {
      v = JSON.parse(line)
    } catch (e) {
      throw new Error(`line ${i + 1}: not JSON (${e.message})`)
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`line ${i + 1}: expected an object`)
    items.push(v)
  }
  return items
}

function fmtVerdict(r) {
  if (r.error) return `error: ${r.error}`
  const conf = r.by === 'jev' ? r.confidence.toFixed(2) : '1'
  return `${r.priority.padEnd(6)} ${String(r.kind || '-').padEnd(12)} ${r.by.padEnd(8)} ${conf}${r.floored ? ' (floor)' : ''}`
}

function fmtStats(s) {
  const parts = [`${s.items} items`]
  for (const k of ['hint', 'rule', 'jev', 'override']) if (s[k]) parts.push(`${s[k]} ${k}`)
  if (s.cached) parts.push(`${s.cached} from cache`)
  if (s.floored) parts.push(`${s.floored} raised by floor`)
  if (s.errors) parts.push(`${s.errors} errors`)
  if (s.asked) parts.push(`${s.asked} asked Jev, ${s.tokens} tokens${typeof s.cost === 'number' ? `, $${s.cost.toFixed(6)}` : ''}`)
  return parts.join(', ')
}

function fmtWant(w) {
  const p = Array.isArray(w.priority) ? w.priority.join('|') : w.priority
  const k = w.kind ? '/' + (Array.isArray(w.kind) ? w.kind.join('|') : w.kind) : ''
  return p + k
}

async function run(argv, call, deps) {
  const args = argv.filter((a) => a !== '--json')
  const json = argv.includes('--json')
  const [sub, ...rest] = args
  try {
    switch (sub) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        return { stdout: HELP }

      case 'classify': {
        if (rest[0] === '--help') return { stdout: HELP }
        if (rest.length > 1) return usage('classify takes at most one source')
        const source = rest[0] || 'cli'
        if (!V.SOURCE_RE.test(source)) return usage(`source must match ${V.SOURCE_RE}`)
        let items
        try {
          items = parseItems(call.stdin)
        } catch (e) {
          return usage(e.message)
        }
        if (!items.length) return usage('no items on stdin (one JSON object per line); `ccc triage help` shows the shape')
        const { results, stats } = await withBudget(deps.classify(source, items), BUDGET_MS, 'classify')
        const out = items.map((it) => {
          const r = results[it.id] || { error: 'no result' }
          if (json) return JSON.stringify({ id: it.id, ...r })
          return `${String(it.id).padEnd(16)} ${fmtVerdict(r)}  ${r.error ? '' : V.titleOf(it.text, 60)}`
        })
        return { stdout: out.join('\n') + '\n', stderr: json ? '' : fmtStats(stats) + '\n' }
      }

      case 'eval': {
        if (rest.length) return usage('eval takes no arguments')
        const cases = await deps.cases()
        if (!cases.length) return { stdout: 'no cases yet: the panel\'s Wrong? records one per corrected verdict\n' }
        const r = await withBudget(deps.evaluate(cases), BUDGET_MS, 'eval')
        if (json) return { stdout: JSON.stringify(r) + '\n' }
        const lines = r.rows
          .filter((x) => !x.ok)
          .map((x) => `FAIL  ${x.source}/${x.id}  want ${fmtWant(x.expected)}  got ${x.got && !x.got.error ? `${x.got.priority}/${x.got.kind || '-'} by ${x.got.by} ${x.got.by === 'jev' ? x.got.confidence.toFixed(2) : ''}` : 'error: ' + ((x.got && x.got.error) || 'none')}  ${x.title}${x.note ? '  note: ' + x.note : ''}`)
        lines.push(`${r.passed}/${r.total} passed`)
        return { stdout: lines.join('\n') + '\n' }
      }

      case 'rescore': {
        if (rest.length > 1) return usage('rescore takes at most one source')
        if (rest[0] && !V.SOURCE_RE.test(rest[0])) return usage(`source must match ${V.SOURCE_RE}`)
        const r = await deps.rescore(rest[0] || null)
        return { stdout: `forgot ${r.cleared} cached verdicts${rest[0] ? ` of ${rest[0]}` : ''}; told ${r.sources.length ? r.sources.join(', ') : 'no source'} to classify again\n` }
      }

      case 'wrong': {
        if (rest.length < 3) return usage('wrong <source> <id> <priority>[/<kind>] [note...]')
        const [source, id, verdict, ...note] = rest
        const [priority, kind] = verdict.split('/')
        if (!V.isPriority(priority)) return usage(`priority must be one of ${V.PRIORITIES.join(', ')}`)
        if (kind !== undefined && !V.isKind(kind)) return usage(`kind must be one of ${V.KINDS.join(', ')}`)
        await deps.wrong(source, id, { priority, kind }, note.join(' '))
        return { stdout: `override ${source}/${id} = ${priority}${kind ? '/' + kind : ''}; recorded as a case\n` }
      }

      case 'cases': {
        if (rest[0] === 'delete') {
          if (rest.length !== 3) return usage('cases delete <source> <id>')
          const ok = await deps.deleteCase(rest[1], rest[2])
          return ok ? { stdout: `deleted case ${rest[1]}/${rest[2]}\n` } : { stderr: `triage: no case ${rest[1]}/${rest[2]}\n`, code: 1 }
        }
        if (rest.length) return usage('cases [--json] | cases delete <source> <id>')
        const cases = await deps.cases()
        if (json) return { stdout: cases.map((c) => JSON.stringify(c)).join('\n') + (cases.length ? '\n' : '') }
        if (!cases.length) return { stdout: 'no cases yet\n' }
        const lines = cases.map((c) => `${c.at.slice(0, 10)}  ${c.source}/${c.id}  want ${fmtWant(c.expected)}  got ${c.got ? `${c.got.priority}/${c.got.kind || '-'} by ${c.got.by}` : '?'}  ${V.titleOf(c.text, 60)}${c.note ? '  note: ' + c.note : ''}`)
        return { stdout: lines.join('\n') + `\n${cases.length} cases\n` }
      }

      case 'questions':
        return { stdout: JSON.stringify(deps.questions(), null, 2) + '\n' }

      default:
        return usage(`unknown subcommand ${JSON.stringify(sub)}`)
    }
  } catch (e) {
    return fail(e)
  }
}

module.exports = { run, HELP, parseItems, fmtStats }
