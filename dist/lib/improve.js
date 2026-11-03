'use strict'
// The prompt of the Improve button: a new Claude tab gets one wrong verdict, the current settings and
// the steps of the improve loop (adapted from the old cockpit's inbox-improve skill). It travels as
// the tab's starting prompt (ctx.sessions.open), so it carries everything Claude needs and points at
// `ccc` for the rest; nothing is typed into a session.

const { describeRule } = require('./rules')

// The item text can be long (a mail thread); the full text stays in the case, which `ccc triage cases
// --json` prints, so the prompt keeps a readable head only.
const PROMPT_TEXT = 6000

function block(s) {
  return String(s).split('\n').map((l) => '    ' + l).join('\n')
}

/**
 * subject: { source, id, text, got: { priority, kind, by, confidence } | null, expected?, note?,
 *   isCase } ; settings: { profile, rules (normalized), problems, questions }
 */
function improvePrompt(pluginId, subject, settings) {
  const text = subject.text || ''
  const cut = text.length > PROMPT_TEXT ? text.slice(0, PROMPT_TEXT) + '\n[... cut; the full text is in `ccc triage cases --json </dev/null`]' : text
  const got = subject.got
    ? `${subject.got.priority}${subject.got.kind ? '/' + subject.got.kind : ''} by ${subject.got.by}` +
      (subject.got.by === 'jev' ? ` (confidence ${Number(subject.got.confidence || 0).toFixed(2)})` : '')
    : 'unknown'
  const want = subject.expected
    ? `${subject.expected.priority}${subject.expected.kind ? '/' + subject.expected.kind : ''}`
    : 'not said yet: ask the person'
  const rules = settings.rules.length ? settings.rules.map((r) => '- ' + describeRule(r)).join('\n') : '(none)'
  const cfg = `ccc plugin config ${pluginId} --scope project`
  // Starts with a tag, not "/", "!", "#" or "&" (ctx.sessions.open refuses those).
  return `[jev-triage-improve] Improve this project's triage (the ${pluginId} cc-cockpit plugin) for ONE item, together with the person.

## The item
source: ${subject.source}   id: ${subject.id}
triage said: ${got}
the person says it should be: ${want}
their note: ${subject.note ? subject.note : '(none)'}
${subject.isCase ? 'It is recorded as a case (`ccc triage cases </dev/null`).' : 'It is not a case yet: the panel\'s Wrong? records one (or ask the person to press it).'}
text Jev reads:
${block(cut)}

## How triage decides (the last step that applies wins)
1. the source's hint for the item (fix: in the source plugin; a hint skips Jev)
2. project rules, first match wins (field equals/contains, case-insensitive; skips Jev)
3. Jev's two choice questions (priority: urgent/action/read/low/noise, read->fyi, low->noise; kind), with the project profile appended to the priority question
4. the person's override (Wrong? stores one)
then the item's floor raises the priority, never lowers it.

## Current settings (\`ccc plugin config ${pluginId}\`; questions in full: \`ccc triage questions </dev/null\`)
profile:
${block(settings.profile || '(empty)')}
rules:
${rules}${settings.problems.length ? '\nrule problems: ' + settings.problems.join('; ') : ''}

## The session
(\`ccc triage\` reads stdin, so close it on every call but classify: \`</dev/null\`, or it waits 40 s.)
1. Ask, don't assume. Show the item and what triage said in two lines. If the note does not say why, ask the person what it should have been and why; one question. Their "why" decides the layer.
2. Pick the cheapest layer that fixes it, and say which and why in one line:
   - a rule: a sender, project or phrase that always gets the same answer;
   - the profile: who the person is, what they own, what is not theirs right now (most fixes land here). Profile lines are the person's words: propose the line, let them correct it, never invent ownership;
   - the question wording (priorityInstructions, priorityCriteria, kindInstructions, kindCriteria): a definition was wrong for a whole class;
   - the source plugin's text or hint, when Jev lacked a fact code could compute (say so; it is outside this plugin).
3. Before changing anything run \`ccc triage eval </dev/null\` and keep the pass count (the "before").
4. Propose the smallest change in that one layer. Change nothing without the person's OK.
5. Apply it with \`${cfg} <key>=<JSON>\` (profile='"..."', rules='[...]', a whole list or object each time), then run \`ccc triage eval </dev/null\` again. Show both pass counts and every case whose result changed. A change that breaks an older case is not done: fix it, or tell the person the trade-off.
6. Then \`ccc triage rescore ${subject.source} </dev/null\` so the source re-judges its items, and ask the person to look at the item again.

Rules: one item per session; if the fix is clearly broader, say so and ask. A priority only folds an item lower, it never hides it. An eval costs about $0.00004 per case: do not skip it to save money.`
}

module.exports = { improvePrompt, PROMPT_TEXT }
