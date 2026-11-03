'use strict'
// The two Jev questions (priority and kind, both `choice`), built from the project settings at call
// time. Adapted from the old cockpit's triage-q.json: the same structure and criteria, with the
// person-specific text (name, employer, role) taken out, since that now lives in the project's
// `profile`, which is appended to the priority question (the profile is what makes "is this theirs"
// answerable at all).

const crypto = require('node:crypto')

const DEFAULT_PRIORITY_INSTRUCTIONS =
  'This is one item the person may need to deal with: an email or chat thread, an issue, a review, a ' +
  'notification. Judge its new content, the part marked as new; earlier messages marked as context are ' +
  'context only. When it says whom the new content is addressed to, that decides whose it is. How much ' +
  'does it need the person\'s attention?'

// Keys are Jev's choice names; `read` and `low` become `fyi` and `noise` (vocab.JEV_PRIORITY_MAP).
const DEFAULT_PRIORITY_CRITERIA = {
  urgent:
    'Production is down or broken for customers, or the person is asked for an answer, fix or decision ' +
    'that is needed today.',
  action:
    'The person is asked to do, review, reply to or decide something: a direct message, the person ' +
    '@mentioned or assigned, or a request to a whole group that the person would be expected to pick up. ' +
    'A request addressed to other people is \'read\', not \'action\'.',
  read:
    'Worth the person reading: a request aimed at someone else, a decision, a status update or a ' +
    'discussion about work they are part of, including a reply that carries information; nothing asked ' +
    'of the person directly.',
  low: 'An automated alert, monitoring notification or report that nobody wrote by hand (monitoring, CI, system mail).',
  noise:
    'Nothing to read or do: a bare thanks, \'ok\', \'on it\', acknowledgements with no new information, ' +
    'newsletters, marketing, social chatter.',
}

const DEFAULT_KIND_INSTRUCTIONS = 'What kind of item is this, going by its new content?'

const DEFAULT_KIND_CRITERIA = {
  request: 'Someone asks the person, or their team, to do or answer something.',
  incident: 'Something is broken or failing and people are dealing with it.',
  discussion: 'Conversation about work: planning, updates, decisions, questions to the group.',
  alert: 'An automated monitoring alert (firing or resolved).',
  notification: 'Other automated mail or messages: reports, CI, calendar, system notices, newsletters.',
  ack: 'A short thanks, ok, or acknowledgement with no new information.',
}

const PROFILE_HEADER = '\n\nAbout the person (who they are, what they own, what is not theirs right now):\n'

function str(v) {
  return typeof v === 'string' ? v.trim() : ''
}

// Empty means "the built-in text", per key: a project that rewords one criterion keeps the others, and
// a later release that improves a built-in reaches every project that did not touch it. Unknown keys
// are dropped (the schema forbids them; this is the second line).
function mergeCriteria(defaults, given) {
  const out = {}
  for (const name of Object.keys(defaults)) {
    const v = given && typeof given === 'object' ? str(given[name]) : ''
    out[name] = v || defaults[name]
  }
  return out
}

/**
 * The questions Jev gets for this project's settings, and a fingerprint of them (with the profile)
 * that goes into the cache key: changing a word here rescores everything on the next classify.
 */
function buildQuestions(project) {
  const s = project || {}
  const profile = str(s.profile)
  let priorityInstructions = str(s.priorityInstructions) || DEFAULT_PRIORITY_INSTRUCTIONS
  if (profile) priorityInstructions += PROFILE_HEADER + profile
  const questions = {
    priority: {
      type: 'choice',
      instructions: priorityInstructions,
      criteria: mergeCriteria(DEFAULT_PRIORITY_CRITERIA, s.priorityCriteria),
    },
    kind: {
      type: 'choice',
      instructions: str(s.kindInstructions) || DEFAULT_KIND_INSTRUCTIONS,
      criteria: mergeCriteria(DEFAULT_KIND_CRITERIA, s.kindCriteria),
    },
  }
  return { questions, fingerprint: fingerprint(questions) }
}

// The profile is inside the priority instructions, so hashing the questions covers it too. JSON of a
// freshly built object has a stable key order (insertion order above).
function fingerprint(questions) {
  return crypto.createHash('sha256').update(JSON.stringify(questions)).digest('hex').slice(0, 16)
}

module.exports = {
  DEFAULT_PRIORITY_INSTRUCTIONS,
  DEFAULT_PRIORITY_CRITERIA,
  DEFAULT_KIND_INSTRUCTIONS,
  DEFAULT_KIND_CRITERIA,
  PROFILE_HEADER,
  buildQuestions,
}
