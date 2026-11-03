# jev-triage (bronos.jev-triage)

Status: design agreed with the user on 2026-11-02. External plugin (its own repo, for the
marketplace), not bundled.

## What it is for

Source plugins (mail, Jira, Chat, Forgejo, calendar: none exist yet) fetch their own items and
show their own panels. They ask this plugin how much each item needs the person: a priority and
a kind, judged by Jev (the `jev` plugin, `bronos.jev`), with rules and the person's corrections
on top. It ports the triage of the user's older cockpit (`~/Projects/cockpit`, scripts in
`~/Projects/claude-config/cockpit/triage/`) into a per-project plugin.

Manifest: `services: { uses: { jev: 1 }, provides: { triage: 1 } }`.

## Vocabulary

- Priority: `urgent`, `action`, `fyi`, `noise`.
- Kind: `request`, `incident`, `discussion`, `alert`, `notification`, `ack`.
- `by`: which step decided: `hint`, `rule`, `jev`, `override`.
- `confidence`: 0..1 (1 for hint, rule and override; Jev's for jev). The panel shows below 0.5
  as a hollow dot.

## The `triage` service (v1)

- `classify(source, items)` -> `{ results: { [id]: { priority, kind, confidence, by } | { error } }, stats }`
  - `source`: a short name of the caller's choice (`mail`, `jira`); results, cache, overrides
    and the panel are grouped by it.
  - item: `{ id, text, hint?: { priority, kind? }, floor?: priority, fields?: { [name]: string } }`.
    `text` is what the source writes for judging (the old `triage_text`): who it is from and to,
    earlier context marked as context, then the new content. `fields` are short plain values
    rules can match (`from`, `lane`, `project`).
  - Bounded: at most 500 items a call (more rejects); text capped (Jev's limit).
- `override(source, id, { priority, kind? })` stores the person's correction; `clear(source, id)`.
- `onChange(listener)` (a service event): `{ source, ids }` after a rescore, an override, or a
  settings change that invalidates verdicts, so sources can call classify again.

## Order (the last step that applies wins)

1. The item's `hint` (a source knows: a Grafana alert is an alert). A hint skips Jev.
2. Rules, first match wins, confidence 1; a match skips Jev.
3. Jev, for items with neither.
4. The person's override for that source and id.

Then `floor` raises the priority to at least the floor, never lowers it (Jira's lower bound).

## Jev

- One `jev.grid` per chunk of 50 items with both questions (`priority` and `kind`, `choice`
  type) in the same grid. Questions have sensible generic defaults; the project's profile text
  is appended to the priority question's instructions at call time.
- Jev's answer for the `priority` choice may use the old five criteria (`urgent`, `action`,
  `read`, `low`, `noise`) mapped to the four priorities (`read` -> `fyi`, `low` -> `noise`);
  keep what the eval shows works best.
- Errors per item come back as `{ error }`; a jev refusal (cap reached, no key) rejects the
  whole call with jev's message, so the source can show it.
- Cache (per project, `ctx.storage`): a verdict is reused while
  `sha256(text + profile + questions + model)` is unchanged. Changing the profile or the
  questions therefore rescores everything on the next classify. Bounded (evict oldest past a
  cap). `ccc triage rescore [source]` clears it.
- Cost, caps and the usage log are jev's; calls carry `label: 'jev-triage'`.

## Project settings (per project: a work project and a personal one judge differently)

- `profile`: free text: who the person is, what they own, what is not theirs right now.
- `rules`: a list of `{ source?, field, equals? | contains?, priority, kind? }` (no regex: the
  app's settings schemas refuse them). `field` is one of the item's `fields`, or `text`.
- `priorityInstructions`, `kindInstructions`: the question wording, defaulting to built-ins.

## Cases and the improve loop (per project)

- The panel lists recent verdicts by source (title from the first line of `text`, priority,
  kind, `by`, confidence dot). **Wrong?** on a verdict asks for the right priority/kind and an
  optional note, stores an override, and records a case `{ id, source, text, got, expected,
  note, at }` (per project, a JSONL in the plugin's data dir; capped).
- **Improve** opens a Claude session (`ctx.sessions.open({ prompt })`) carrying the case, the
  current profile, rules and questions, and instructions in the spirit of the old
  `inbox-improve` skill: ask the person what it should have been and why if the note is thin;
  pick the cheapest layer (a rule, then the profile, then the question wording); run
  `ccc triage eval` before and after and show both pass counts; change nothing without the
  person's OK; apply with `ccc plugin config bronos.jev-triage --scope project ...`; then
  `ccc triage rescore`.
- `ccc triage eval` runs every case through the current settings (bypassing the cache and
  overrides) and prints the pass count and the failures.
- `ccc triage classify <items.jsonl> [source]` reads items as JSONL from a file (not stdin: a cli entry with stdin makes every subcommand wait for it) and prints verdicts: lets the
  person and Claude try it with no source plugin installed.
- `ccc triage cases` lists cases; `ccc triage help`.

## Panel

Recent verdicts per source (newest first, a source filter), Wrong? and Improve per row, the eval
score of the last run, and jev's state when it refuses (no key, cap reached).

## Left out (daemon concepts of the old cockpit)

A global store, agterm, subprocess timeouts and JSONL pipes, app-wide cases, hard-coded
profile text. A closed project triages nothing, by design.
