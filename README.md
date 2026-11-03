# Jev triage for cc-cockpit

Requires the Jev plugin (bronos.jev), installed and enabled in the same project.

`bronos.jev-triage` tells source plugins (mail, Jira, chat, Forgejo, calendar) how much each of their
items needs the person: a **priority** (`urgent`, `action`, `fyi`, `noise`) and a **kind** (`request`,
`incident`, `discussion`, `alert`, `notification`, `ack`). Jev judges what nothing else decided; project
rules and the person's corrections sit on top. It provides the `triage` plugin service (v1), a panel of
recent verdicts with **Wrong?** and **Improve**, and `ccc triage`.

Everything is per project: a work project and a personal one have their own profile, rules, cache,
corrections and cases. A closed project triages nothing.

Plain JavaScript, no build step. `npm test` (or `node --test test/`) runs the unit tests (node:test,
no dependencies).

## How a verdict is made

The last step that applies wins:

1. the item's `hint` (the source knows: a Grafana alert is an alert); skips Jev
2. the project's rules, first match wins; skips Jev
3. Jev, for items with neither: one `jev.grid` per 50 items with two `choice` questions. The priority
   question uses five choices (`urgent`, `action`, `read`, `low`, `noise`; `read` becomes `fyi`, `low`
   becomes `noise`), with the project profile appended to its instructions
4. the person's override for that source and id

Then the item's `floor` raises the priority to at least the floor, never lowers it.

Each verdict says which step decided (`by`: `hint`, `rule`, `jev`, `override`) and a `confidence`
(1 for hint, rule and override; Jev's own for jev; the panel draws below 0.5 as a hollow dot).

Jev verdicts are cached per project (`ctx.storage`, at most 4000, least recently used dropped first)
under `sha256(source + text + profile and questions + model)`, so changing the profile or the question
wording rescores everything on the next classify. jev's grid does not report its model, so after
changing jev's model setting run `ccc triage rescore`. Cost, caps and the usage log are jev's; calls
carry the label `jev-triage` (`ccc jev usage </dev/null`).

## The `triage` service (v1)

Manifest of a source plugin:

```json
"services": { "uses": { "triage": 1 } }
```

```js
exports.activate = (ctx) => {
  const triage = ctx.services.use('triage')

  async function refresh() {
    if (!ctx.services.available('triage')) return // show "needs Jev triage" instead
    const items = await fetchMyItems() // your own fetch
    const { results, stats } = await triage.classify('mail', items.map((m) => ({
      id: m.id,
      // What Jev reads: who it is from and to, earlier messages marked as context, then the new content.
      text: `Mail from ${m.from}\nTo: ${m.to}\n\nEarlier (context only):\n${m.context}\n\nNew message to judge:\n${m.body}`,
      fields: { from: m.fromAddress, list: m.listId || '' }, // short plain values rules can match
      hint: m.isMonitoring ? { priority: 'noise', kind: 'alert' } : undefined,
      floor: m.starred ? 'action' : undefined,
    })))
    // results[id] = { priority, kind, confidence, by, floored? } or { error }
  }

  // After a rescore, a correction or a settings change: classify those ids again (ids null: all of the source).
  triage.on('change', ({ source, ids }) => { if (source === 'mail') refresh() })
  // Call from a schedule or a command, not during activate (ccc guide api, cycles).
  ctx.schedule(300, refresh)
}
```

- `classify(source, items)` resolves `{ results, stats }`.
  - `source`: a short name of your choice (`^[a-z][a-z0-9-]{0,31}$`, e.g. `mail`, `jira`); results,
    cache, overrides, cases and the panel are grouped by it.
  - item: `{ id, text, hint?: { priority, kind? }, floor?: priority, fields?: { [name]: string } }`.
    Ids are strings of 1..256 characters, unique in the call.
  - At most 500 items a call (more rejects). A text over 200,000 characters (Jev's limit), a bad hint,
    floor or field gets `{ error }` for that item; the rest are judged.
  - `kind` is `null` when no step gave one (a hint or rule without a kind).
  - `stats`: `{ items, hint, rule, jev, override, cached, floored, errors, asked, tokens, cost, ms }`.
  - Rejects for a bad call; with `Needs the Jev plugin (bronos.jev): install it from Settings >
    Marketplace and enable it in this project.` when an item needs Jev and jev is not available
    (items decided by hint, rule or cache still come back while jev is missing, as long as no item
    needs it); and with jev's own message (`jev: ...`, a cap reached, no API key) when jev refuses.
    Show that message to the person.
- `override(source, id, { priority, kind? })` stores the person's correction (a kind left out keeps
  the underlying one); `clear(source, id)` forgets it and resolves whether there was one.
- Event `change`: `{ source, ids }` (ids `null` means every item of the source).

## Settings (per project)

Settings > This project, or from a Claude tab:
`ccc plugin config bronos.jev-triage --scope project <key>=<JSON>`.

- `profile`: free text: who the person is, what they own, what is not theirs right now. Appended to
  the priority question. Most fixes land here.
- `rules`: a list of `{ source?, field, equals | contains, priority, kind? }`. `field` is one of the
  item's `fields` or `text`; give exactly one of `equals` and `contains`; case-insensitive; no regexes
  (the app refuses them in settings). A bad rule is skipped and logged (`ccc plugin logs bronos.jev-triage`).
- `priorityInstructions`, `kindInstructions`: the question wording; empty means the built-in one.
- `priorityCriteria` (`urgent`, `action`, `read`, `low`, `noise`) and `kindCriteria` (one per kind): the
  wording of each choice; an empty line keeps the built-in one.

```sh
ccc plugin config bronos.jev-triage --scope project \
  'profile="Backend developer; I own billing and the deploy pipeline. Not mine: the mobile apps."' \
  'rules=[{"source":"mail","field":"from","equals":"alerts@grafana.net","priority":"noise","kind":"alert"}]'
ccc triage questions   # the questions as Jev gets them
```

## CLI

- `ccc triage classify <items.jsonl> [source] [--json]`: judge items given as JSON lines in a file (the item
  shape above; source defaults to `cli`). Uses the cache and overrides like a source plugin and lists
  the verdicts in the panel, so it lets you try triage with no source plugin installed.
- `ccc triage eval [--json]`: re-judge every case with the current settings (no cache, no overrides);
  prints the failures and the pass count.
- `ccc triage rescore [source]`: forget cached Jev verdicts and tell the sources to classify again.
- `ccc triage wrong <source> <id> <priority>[/<kind>] [note...]`: what the panel's Wrong? does.
- `ccc triage cases [--json]`, `ccc triage cases delete <source> <id>`: the recorded cases.
- `ccc triage forget <source>`: drop a source from the panel with its listed verdicts, your corrections,
  its cases and its cached Jev verdicts (a test source, or a source plugin you removed). The panel's
  Forget button does the same (click twice).
- `ccc triage questions`, `ccc triage help`.

```
$ ccc triage classify items.jsonl test
g1               fyi    alert        hint     1  Grafana alert to ops: [FIRING] disk 92% on db-1
n1               noise  notification rule     1  Mail from Shop newsletter
b1               urgent incident     jev      0.99  Chat, direct message from Ann (team lead)
m1               fyi    ack          jev      0.37  Chat, space 'Mobile', one thread
4 items, 1 hint, 1 rule, 2 jev, 2 asked Jev, 1699 tokens, $0.000071
```

## The panel and the improve loop

The Jev triage panel (right zone) lists the newest verdicts per source (pick the source at the top):
a dot coloured by priority (hollow below 0.5 confidence), the title (the text's first line), priority,
kind, `by` and age. It shows the last eval score, and a notice when jev is missing or refused the last
call (the panel icon then shows a dot).

- **Wrong?** asks for the right priority and kind and an optional note, stores an override, and
  records a case `{ id, source, text, fields?, hint?, floor?, got, expected, note, at }` (one per source
  and id, at most 300, in `cases.jsonl` in the plugin's project data folder). **Undo** forgets an override.
- **Improve** opens a Claude tab carrying the case (or the verdict), the profile, the rules and the
  improve loop: ask the person what it should have been and why if the note is thin; pick the cheapest
  layer (a rule, then the profile, then the question wording; or the source plugin's text or hint);
  run `ccc triage eval` before and after and show both pass counts; change nothing without the
  person's OK; apply with `ccc plugin config bronos.jev-triage --scope project ...`; then
  `ccc triage rescore <source>`.
- **Eval** runs `ccc triage eval` from the panel.

An eval costs about $0.00004 per case (jev usage shows the real figure): do not skip it to save money.

See FRICTION.md for where the cc-cockpit guide fell short while building this.
