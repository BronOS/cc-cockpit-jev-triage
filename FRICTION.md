# Friction log

Each entry is one place where the cc-cockpit guide (`ccc guide`, all topics, and `ccc help`) was not
enough, was ambiguous, or an API was missing, found while building `bronos.jev-triage` from the guide
alone (no app source read), against cc-cockpit 0.6.0 on 2026-11-02. Format: what I needed, what the
guide says, what I did instead. Status: **Open** unless marked.

## cc-cockpit guide and app

- **`settings-secrets`: an array of objects in a settings form.** Open.
  Needed: `rules` is a list of `{ source?, field, equals | contains, priority, kind? }` objects.
  Guide: lists what the form renders for an array of strings, a multi-select array and a nested
  object, but not an array of objects (one group per item? add/remove buttons? reorder, which matters
  for "first match wins"?). Did: declared it as `array` of `object` items and set it through
  `ccc plugin config ... rules='[...]'`, which validated and stored it. How the form shows it is untested.

- **`settings-secrets`: an optional `enum` field.** Open.
  Needed: a rule's `kind` is optional. Guide: "Give such a property a `default`: with none, the form
  shows the first choice as selected and a save stores it", so an optional enum without a default
  silently becomes the first choice. Nothing says how to offer "none". Did: added `""` as the first
  choice with `default: ""` and treat `""` as no kind in the host. Whether `""` shows as an empty,
  selectable option (and inside an array item at all) is untested.

- **`settings-secrets`: no multi-line text field.** Open.
  Needed: `profile` is a paragraph or a short list (who the person is, what they own, what is not
  theirs). Guide: "`string` is a text input"; no `textarea` or ui hint is documented. Did: a plain
  string with `maxLength: 8000`; the README shows setting it with `ccc plugin config`, where `\n` in
  the JSON string works.

- **`cli` / `plugins`: `stdin: true` applies to every subcommand.** Open.
  Needed: only `ccc triage classify` reads stdin; `eval`, `rescore`, `cases`, `questions` read none.
  Guide: `stdin` is per `contributes.cli` entry, and "stdin not closed within 40 s is exit 124, so
  pipe the input or redirect `</dev/null`". From a Claude tab's Bash tool `ccc triage rescore test`
  (and `ccc jev usage`, same cause) waited the full 40 s and failed, while other runs of the same kind
  returned at once: whether stdin is an open pipe depends on how the tool runs the line. Did: every
  `ccc triage` mention in the improve prompt and the README says `</dev/null`. Would help: a
  per-subcommand stdin declaration, or reading stdin only when the handler asks for it.

- **`api`: limits of `ctx.sessions.open({ prompt })`.** Open.
  Needed: Improve passes a long prompt (the case text, settings, the loop). Guide: the prompt "is
  an argument, never typed", refused when it starts with `/ ! # &`, at most 5 a minute; no length
  limit and no word on the default `cwd` when it is left out. Did: cut the item text in the prompt to
  6000 characters (the full text stays in the case, `ccc triage cases --json`) and left `cwd` out,
  assuming the project folder. Not verified live (opening a tab from a test felt too intrusive).

- **`api`: is a promise returned by `deactivate` awaited?** Open.
  Needed: flush pending writes (cache, recent verdicts, cases) before a reload. Guide: "Called when
  the window closes or the plugin reloads; the host is killed 5 s later regardless"; the type is
  `deactivate?(): unknown`. Did: return the pending-writes promise, assuming it is awaited up to the
  5 s. Writes are atomic (temp file + rename), so a cut-off write loses only the latest change.

- **`dev-loop` / `panels`: no way to see a panel from a session.** Open.
  Needed: check that the panel renders and has no script error. Guide: the checklist names causes
  ("its script is inline, or it reaches for the network") but there is no `ccc panel ...` to read a
  panel's console errors or take a snapshot, and `ccc plugin logs` holds only host lines. Did: kept
  the page logic small and the state shape covered by host tests; the panel is not verified visually.

- **`dev-loop`: still no host test kit.** Open (same as bronos.jev's entry).
  Guide: "Test pure logic outside the app; the host API is plain objects." Did: wrote my own fake
  `ctx` (`test/fakes.js`: storage, panels, services with `available`, emit, cli, sessions) from the
  `api` topic, so `dist/host.js` itself is tested with jev present, missing and refusing.

- **Marketplace: no dependency field.** Open.
  Needed: this plugin is useless without `bronos.jev`. Guide (`plugins`, "Publishing in the
  Marketplace"): an index entry has id, name, description, author, repo, version, tag, commit, api,
  owners; there is no `requires` (or dependency) field, so installing jev-triage does not offer to
  install jev, and the app gives no dependency prompt beyond the Plugins page warning
  (`no enabled plugin in this project provides service "jev"`). Did: the README's first line says it
  requires jev, the panel shows "Needs the Jev plugin (bronos.jev): install it from Settings >
  Marketplace and enable it in this project.", and the CLI and `classify` carry the same text.

- **`panels` (small): `defer` for a page script that touches the DOM at load.** Open.
  The walkthrough and the scaffold put `<script src="main.js">` in `<head>`, where the body does not
  exist yet; that works only while the script touches the DOM inside callbacks. Did: `defer`. One
  line in the `panels` topic would save a blank panel.

## jev plugin README (bronos.jev, not the app guide)

- **What `grid` returns per item.** Open. The README shows `g.results.a.answers` and `.error`, and
  `ask` returning `model`; it does not say what one answer of a `choice` question looks like, or that a
  grid result has no `model`. Found with one real call: `answers.<q> = { type: 'choice', choice,
  probabilities: { <name>: p }, confidence }`, and the grid result is `{ results: { id: { answers } },
  stats: { items, errors, tokens, cost, ms } }`, no model. So the triage cache key cannot follow jev's
  model; the README says to run `ccc triage rescore` after changing it.
- **`label` in `grid` options.** Open. The README lists `{ min, skip, workers }`; passing
  `{ label: 'jev-triage' }` works (the usage log shows `bronos.jev-triage/jev-triage`), but is not documented.

## Form submit never fires in a panel (Open)

- Needed: a small form in the panel (Wrong?: priority, kind, note, Save).
- Guide: the panels topic says "no form posts" under the CSP, which reads as "a form cannot POST
  to a URL", not "a form cannot be submitted".
- What happened: the frame is sandboxed without `allow-forms`, so the browser blocks the
  submission before the `submit` event fires; `ev.preventDefault()` in a submit handler never runs,
  and Save silently did nothing (found by the person, not by any test).
- Did instead: a `<div>` with a `type="button"` Save and Enter handled on the input.
- Suggest: say in the panels topic that `<form>` submit events do not fire, and to use buttons.
