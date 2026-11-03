'use strict'
// The panel: recent verdicts per source, Wrong? (an override plus a case) and Improve (a Claude tab
// for the improve loop) per row, the last eval score, and jev's state. The host owns all state; the
// page renders what it is sent and posts what the person clicks. Item text is never put in innerHTML.

let state = null
let source = '' // the selected source; '' until the first state picks one
let openForm = null // `${source}\0${id}` of the row whose Wrong? form is open, kept across re-renders
let lastError = null

function el(tag, props, ...children) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c)
  return e
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function renderNotices() {
  const box = document.getElementById('notices')
  box.replaceChildren()
  if (!state) return
  if (!state.jevAvailable) box.append(el('div', { class: 'notice', role: 'alert' }, state.jevMissing))
  else if (state.jevError) box.append(el('div', { class: 'notice', role: 'alert' }, `Jev refused the last call: ${state.jevError.message}`))
  if (lastError) box.append(el('div', { class: 'notice', role: 'alert' }, lastError))
}

function wrongForm(row) {
  const pri = el('select', { 'aria-label': 'Right priority' }, ...state.priorities.map((p) => el('option', { value: p, selected: p === row.priority }, p)))
  const kind = el('select', { 'aria-label': 'Right kind' },
    el('option', { value: '' }, `kind: keep ${row.kind || 'none'}`),
    ...state.kinds.map((k) => el('option', { value: k }, k)))
  const note = el('input', { type: 'text', placeholder: 'why (optional, helps Improve)', 'aria-label': 'Note' })
  const form = el('form', { class: 'wrong' }, pri, kind, note,
    el('button', { type: 'submit', class: 'primary' }, 'Save'),
    el('button', { type: 'button', onclick: () => { openForm = null; render() } }, 'Cancel'))
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    ccPanel.post({ type: 'wrong', source, id: row.id, priority: pri.value, kind: kind.value || undefined, note: note.value })
    openForm = null
  })
  setTimeout(() => pri.focus(), 0)
  return form
}

function renderRows() {
  const ul = document.getElementById('rows')
  ul.replaceChildren()
  const rows = (state && state.sources[source]) || []
  document.getElementById('empty').hidden = rows.length > 0
  for (const row of rows) {
    const key = `${source}\0${row.id}`
    const dot = el('span', {
      class: `dot p-${row.priority}${row.by === 'jev' && row.confidence < 0.5 ? ' low' : ''}`,
      title: `${row.priority}, confidence ${row.by === 'jev' ? row.confidence.toFixed(2) : '1'}`,
    })
    const meta = `${row.priority}${row.floored ? '↑' : ''} · ${row.kind || '-'} · ${row.by}${row.by === 'jev' ? ' ' + row.confidence.toFixed(2) : ''} · ${ago(row.at)}`
    const actions = el('div', { class: 'actions' },
      el('button', { type: 'button', onclick: () => { openForm = openForm === key ? null : key; render() } }, 'Wrong?'),
      el('button', { type: 'button', title: 'Open a Claude tab to fix the rules, profile or questions for this item', onclick: () => ccPanel.post({ type: 'improve', source, id: row.id }) }, 'Improve'),
      row.by === 'override' ? el('button', { type: 'button', title: 'Forget your correction', onclick: () => ccPanel.post({ type: 'clear', source, id: row.id }) }, 'Undo') : null,
      row.hasCase ? el('span', { class: 'badge', title: 'Recorded as a case: ccc triage eval checks it' }, 'case') : null)
    ul.append(el('li', { class: 'row' },
      el('div', { class: 'line' }, dot, el('span', { class: 'title', title: row.title }, row.title), el('span', { class: 'meta' }, meta)),
      actions,
      openForm === key ? wrongForm(row) : null))
  }
}

function renderHeader() {
  const sel = document.getElementById('source')
  const names = state ? Object.keys(state.sources) : []
  if (!names.includes(source)) source = names[0] || ''
  sel.replaceChildren(...names.map((n) => el('option', { value: n, selected: n === source }, `${n} (${state.sources[n].length})`)))
  sel.hidden = names.length === 0
  const ev = document.getElementById('eval')
  if (state && state.lastEval) {
    ev.textContent = `eval ${state.lastEval.passed}/${state.lastEval.total} · ${ago(state.lastEval.at)}`
    ev.title = `Last eval: ${state.lastEval.at}`
  } else {
    ev.textContent = state && state.cases ? `${state.cases} cases` : 'no cases'
  }
  document.getElementById('run-eval').disabled = !state || !state.cases
}

function render() {
  renderHeader()
  renderNotices()
  renderRows()
}

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object') return
  if (m.type === 'state') {
    state = m
    lastError = null
    render()
  } else if (m.type === 'error') {
    lastError = m.message
    renderNotices()
  }
})

document.getElementById('source').addEventListener('change', (e) => {
  source = e.target.value
  openForm = null
  render()
})
document.getElementById('run-eval').addEventListener('click', () => {
  document.getElementById('eval').textContent = 'evaluating…'
  ccPanel.post({ type: 'eval' })
})
// The host cannot push before the page connects (ctx.panels.post drops it), so the page asks first.
ccPanel.post({ type: 'hello' })
// Ages ("5m") go stale; a cheap re-render once a minute keeps them honest.
setInterval(() => { if (state && !openForm) render() }, 60000)
