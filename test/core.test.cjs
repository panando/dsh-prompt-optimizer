'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const core = require('../src/core.cjs')

function message(type, text, source = { kind: 'user' }) {
  if (type === 'assistant/message') {
    return {
      type,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text }], source },
      },
    }
  }
  return { type, data: { content: [{ type: 'text', text }], source } }
}

function outcome(sessionId, action, origin, originalText, finalText) {
  return {
    sessionId,
    action,
    origin,
    ...(originalText === undefined ? {} : { originalText }),
    ...(finalText === undefined ? {} : { finalText }),
  }
}

test('resolveConfig supplies the three-tier defaults and rejects invalid limits and routes', () => {
  const config = core.resolveConfig({ shortcut: 'Mod+Shift+Space' })
  assert.equal(config.maxCurrentCycleSkipped, 10)
  assert.equal(config.maxCurrentCycleSkippedBytes, 16384)
  assert.equal(config.maxCurrentTurns, 3)
  assert.equal(config.maxCurrentContextBytes, 16384)
  assert.equal(config.maxCurrentFeedbackBytes, 4096)
  assert.equal(config.maxPreferenceMemoryBytes, 8192)
  assert.equal(config.maxLocalOutcomesBytes, 131072)
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'shortcut'), false)
  assert.equal(config.automatic, true)
  const volatileConfig = core.resolveConfig({
    automatic: { get: () => false },
    maxProjectContextBytes: { get: () => 16384 },
    reasoningEffort: { get: () => 'max' },
  })
  assert.equal(volatileConfig.automatic, false)
  assert.equal(volatileConfig.maxProjectContextBytes, 16384)
  assert.equal(volatileConfig.reasoningEffort, 'max')
  assert.throws(() => core.resolveConfig({ provider: 'deepseek' }), /configured together/)
  assert.throws(() => core.resolveConfig({ maxCurrentCycleSkipped: 0 }), /maxCurrentCycleSkipped/)
  assert.throws(() => core.resolveConfig({ maxCurrentCycleSkippedBytes: 100 }), /maxCurrentCycleSkippedBytes/)
  assert.throws(() => core.resolveConfig({ maxCurrentFeedbackBytes: 100 }), /maxCurrentFeedbackBytes/)
  assert.throws(() => core.resolveConfig({ maxLocalOutcomesBytes: 100 }), /maxLocalOutcomesBytes/)
  assert.throws(() => core.resolveConfig({ timeoutMs: 0 }), /timeoutMs/)
  assert.throws(() => core.resolveConfig({ automatic: 'yes' }), /automatic/)
})

test('resolveConfig loads curated few-shots separately from user settings', () => {
  const config = core.resolveConfig({})
  assert.ok(config.defaultFewShots.length > 0)
  assert.ok(config.defaultFewShots.length <= 16)
  assert.ok(config.defaultFewShots.every((item) => item.enabled === true))
  assert.ok(config.defaultFewShots.some((item) => item.type === 'rewrite'))
  assert.ok(config.defaultFewShots.some((item) => item.type === 'task'))
  assert.deepEqual(core.userSettingsBase(config).fewShots, [])
})

test('user settings expose automatic behavior and an atomic model route', () => {
  const baseConfig = core.resolveConfig({
    automatic: false,
    provider: 'profile-provider',
    model: 'profile-model',
    timeoutMs: 9000,
    fewShots: [],
  })
  assert.deepEqual(core.userSettingsBase(baseConfig), {
    automatic: false,
    route: { provider: 'profile-provider', model: 'profile-model' },
    reasoningEffort: 'off',
    projectContextEnabled: true,
    projectContextDepth: 3,
    maxProjectTreeFiles: 100,
    maxProjectContextBytes: 16384,
    maxOutputTokens: 2048,
    timeoutMs: 9000,
    fewShots: [],
    optimizerPrompt: '',
    optimizerFewShot: '',
  })

  const following = core.applyUserSettings(baseConfig, {
    automatic: true,
    route: null,
    reasoningEffort: 'max',
  })
  assert.equal(following.automatic, true)
  assert.equal(Object.prototype.hasOwnProperty.call(following, 'shortcut'), false)
  assert.equal(following.provider, undefined)
  assert.equal(following.model, undefined)
  assert.equal(following.reasoningEffort, 'max')
  assert.equal(following.timeoutMs, 9000)

  const fixed = core.applyUserSettings(baseConfig, {
    automatic: true,
    route: { provider: ' fixed-provider ', model: ' fixed-model ' },
    reasoningEffort: 'low',
  })
  assert.equal(Object.prototype.hasOwnProperty.call(fixed, 'shortcut'), false)
  assert.equal(fixed.provider, 'fixed-provider')
  assert.equal(fixed.model, 'fixed-model')
  assert.equal(fixed.reasoningEffort, 'low')
  assert.throws(() => core.applyUserSettings(baseConfig, {
    automatic: true, route: { provider: 'only-provider' },
  }), /provider\/model pair/)
})

test('redactSecrets removes common credential forms', () => {
  assert.equal(
    core.redactSecrets('sk-abcdefghijklmnop token=secret-value Bearer abcdefghijklmnop'),
    '[REDACTED_SECRET] token=[REDACTED_SECRET] Bearer [REDACTED_SECRET]',
  )
})

test('message extraction keeps only visible text blocks', () => {
  const event = {
    content: [
      { type: 'text', text: 'first' },
      { type: 'image', data: 'ignored' },
      { type: 'text', text: 'second' },
    ],
  }
  assert.equal(core.messageText(event), 'first\nsecond')
})

test('conversation extraction keeps human prompts and nested assistant messages only', () => {
  const events = [
    message('user/message', 'Human request'),
    message('user/message', '<system-reminder>workspace instructions</system-reminder>', {
      kind: 'agent-instructions',
    }),
    message('user/message', 'Runtime policy', { kind: 'plugin', plugin: 'system-prompt' }),
    message('user/message', 'Skill catalog', { kind: 'skill-catalog' }),
    message('assistant/message', 'Agent response', { kind: 'model' }),
  ]
  assert.deepEqual(core.conversationMessages(events), [
    { role: 'user', text: 'Human request' },
    { role: 'assistant', text: 'Agent response' },
  ])
  assert.equal(core.eventMessage(events[4]), events[4].data.message)
})

test('takeRecentWithinBudget prefers the newest items', () => {
  const items = [{ text: 'old' }, { text: 'middle' }, { text: 'new' }]
  const maxBytes = Buffer.byteLength(JSON.stringify(items.slice(1)), 'utf8')
  assert.deepEqual(core.takeRecentWithinBudget(items, 10, maxBytes), items.slice(1))
})

test('normalizeLocalOutcomes accepts only bounded V2 provenance records', () => {
  const config = core.resolveConfig({ maxLocalOutcomes: 3 })
  assert.deepEqual(core.normalizeLocalOutcomes([
    { kind: 'cycled', candidate: 'legacy input is migrated in the browser' },
    outcome('s1', 'submitted', 'manual', undefined, 'typed prompt'),
    outcome('s1', 'submitted', 'suggestion-exact', 'candidate', 'candidate'),
    outcome('s1', 'cycled', 'suggestion-edited', 'original', 'edited draft'),
    outcome('s1', 'cycled', 'manual', undefined, 'invalid'),
  ], config), [
    outcome('s1', 'submitted', 'manual', undefined, 'typed prompt'),
    outcome('s1', 'submitted', 'suggestion-exact', 'candidate', 'candidate'),
    outcome('s1', 'cycled', 'suggestion-edited', 'original', 'edited draft'),
  ])
})

test('normalizeLocalOutcomes disables history at zero and enforces its shared byte budget', () => {
  const records = [
    outcome('s1', 'submitted', 'manual', undefined, 'a'.repeat(80)),
    outcome('s2', 'submitted', 'manual', undefined, 'b'.repeat(80)),
  ]
  assert.deepEqual(core.normalizeLocalOutcomes(
    records,
    core.resolveConfig({ maxLocalOutcomes: 0 }),
  ), [])
  assert.deepEqual(core.normalizeLocalOutcomes(
    records,
    core.resolveConfig({ maxLocalOutcomes: 10, maxLocalOutcomesBytes: 256 }),
  ), [records[1]])
})

test('buildSuggestionInput separates current context, session feedback, and preference memory', () => {
  const config = core.resolveConfig({
    maxCurrentTurns: 3,
    maxManualPrompts: 2,
    maxLocalOutcomes: 20,
  })
  const localOutcomes = [
    outcome('current', 'submitted', 'suggestion-edited', 'Draft it verbosely', 'Current edited final'),
    outcome('current', 'submitted', 'suggestion-exact', 'Current exact', 'Current exact'),
    outcome('current', 'cycled', 'suggestion-exact', 'Rejected current'),
    outcome('history-new', 'submitted', 'suggestion-edited', 'Historical original', 'Historical edited final'),
    outcome('history-new', 'submitted', 'suggestion-exact', 'Historical exact', 'Historical exact'),
    outcome('history-new', 'cycled', 'suggestion-exact', 'Historical rejection'),
  ]
  const input = core.buildSuggestionInput({
    sessionId: 'current',
    draft: 'Please continue with token=super-secret',
    currentCycleSkipped: ['Already shown'],
    localOutcomes,
  }, [
    message('user/message', 'Old current turn'),
    message('assistant/message', 'Old reply', { kind: 'assistant' }),
    message('user/message', 'Current edited final'),
    message('assistant/message', 'Edited reply', { kind: 'assistant' }),
    message('user/message', 'Current exact'),
    message('assistant/message', 'Exact reply', { kind: 'assistant' }),
    message('user/message', 'Current manual'),
    message('user/message', 'Injected workspace instructions'.repeat(1000), {
      kind: 'agent-instructions',
    }),
    message('user/message', 'Injected skill catalog'.repeat(1000), { kind: 'skill-catalog' }),
    message('assistant/message', 'Latest reply', { kind: 'assistant' }),
  ], [
    { sessionId: 'history-new', events: [
      message('user/message', 'Historical manual'),
      message('user/message', 'Historical edited final'),
      message('user/message', 'Historical exact'),
    ] },
    { sessionId: 'history-old', events: [message('user/message', 'Older manual')] },
  ], config)

  assert.equal(input.current.draft, 'Please continue with token=[REDACTED_SECRET]')
  assert.deepEqual(input.current.recentTurns.map((turn) => turn.user.text), [
    'Current edited final', 'Current exact', 'Current manual',
  ])
  assert.deepEqual(input.current.recentTurns.map((turn) => turn.user.origin), [
    'suggestion-edited', 'suggestion-exact', 'manual',
  ])
  assert.deepEqual(input.currentSessionFeedback, {
    editedSuggestions: [{
      original: 'Draft it verbosely', final: 'Current edited final', action: 'submitted',
    }],
    acceptedExact: [{ text: 'Current exact' }],
    rejectedSuggestions: [{ text: 'Rejected current' }],
  })
  assert.deepEqual(input.userPreferenceMemory, {
    manualPrompts: [{ text: 'Older manual' }, { text: 'Historical manual' }],
    editedSuggestions: [{ original: 'Historical original', final: 'Historical edited final' }],
    acceptedExact: [{ text: 'Historical exact' }],
    rejectedSuggestions: [{ text: 'Historical rejection' }],
  })
  assert.deepEqual(Object.keys(input.userPreferenceMemory), [
    'manualPrompts', 'editedSuggestions', 'acceptedExact', 'rejectedSuggestions',
  ])
  assert.deepEqual(input.currentCycleSkipped, ['Already shown'])
})

test('buildSuggestionInput includes enabled user and curated few-shots within the shared bound', () => {
  const config = core.resolveConfig({
    defaultFewShots: [
      { id: 'curated-disabled', type: 'task', enabled: false, hint: 'skip me', output: 'skip me' },
      { id: 'curated-enabled', type: 'task', enabled: true, hint: 'curated hint', output: 'curated output' },
    ],
    fewShots: [
      { id: 'user-enabled', type: 'rewrite', enabled: true, input: 'user input', output: 'user output' },
      { id: 'user-disabled', type: 'rewrite', enabled: false, input: 'disabled input', output: 'disabled output' },
    ],
  })
  const input = core.buildSuggestionInput({
    sessionId: 'current', draft: 'current request', currentCycleSkipped: [],
  }, [], [], config)
  assert.deepEqual(input.fewShots.map(({ id }) => id), ['user-enabled', 'curated-enabled'])

  const bounded = core.resolveConfig({
    defaultFewShots: [],
    fewShots: Array.from({ length: 8 }, (_, index) => ({
      id: `large-${index + 1}`,
      type: 'task',
      enabled: true,
      hint: `hint-${index + 1}`,
      output: 'x'.repeat(4096),
    })),
  })
  const boundedInput = core.buildSuggestionInput({
    sessionId: 'current', draft: 'current request', currentCycleSkipped: [],
  }, [], [], bounded)
  assert.ok(boundedInput.fewShots.length <= 8)
  assert.ok(Buffer.byteLength(JSON.stringify(boundedInput.fewShots), 'utf8') <= 16 * 1024)
  assert.equal(boundedInput.fewShots[0].id, 'large-1')
})

test('history selection favors the newest sessions and respects the manual-prompt cap', () => {
  const config = core.resolveConfig({ maxManualPrompts: 2 })
  const input = core.buildSuggestionInput({
    sessionId: 'current', draft: '', currentCycleSkipped: [],
  }, [], [
    { sessionId: 'newer', events: [
      message('user/message', 'newer one'), message('user/message', 'newer two'),
    ] },
    { sessionId: 'older', events: [
      message('user/message', 'older one'), message('user/message', 'older two'),
    ] },
  ], config)
  assert.deepEqual(input.userPreferenceMemory.manualPrompts, [
    { text: 'newer one' }, { text: 'newer two' },
  ])
})

test('recent context keeps three turns and truncates oversized UTF-8 text instead of dropping it', () => {
  const config = core.resolveConfig({ maxCurrentTurns: 3, maxCurrentContextBytes: 700 })
  const suffix = '最后结论'
  const events = [
    message('user/message', 'turn one'),
    message('assistant/message', 'reply one', { kind: 'assistant' }),
    message('user/message', 'turn two'),
    message('assistant/message', 'reply two', { kind: 'assistant' }),
    message('user/message', 'turn three'),
    message('user/message', 'Injected context'.repeat(1000), { kind: 'plugin', plugin: 'context' }),
    message('assistant/message', `${'很长的回答'.repeat(1000)}${suffix}`, { kind: 'assistant' }),
  ]
  const turns = core.recentConversationTurns(events, [], 'current', config)
  assert.equal(turns.length, 3)
  assert.ok(Buffer.byteLength(JSON.stringify(turns), 'utf8') <= 700)
  assert.match(turns[2].assistant.text, /\.\.\.\[truncated\]\.\.\./)
  assert.ok(turns[2].assistant.text.endsWith(suffix))
  assert.equal(JSON.stringify(turns).includes('\uFFFD'), false)
})

test('feedback and preference sections remain inside independent byte budgets', () => {
  const config = core.resolveConfig({
    maxCandidateBytes: 20000,
    maxDraftBytes: 20000,
    maxCurrentFeedbackBytes: 512,
    maxPreferenceMemoryBytes: 640,
    maxLocalOutcomes: 20,
  })
  const long = '好'.repeat(3000)
  const input = core.buildSuggestionInput({
    sessionId: 'current',
    draft: '',
    currentCycleSkipped: [],
    localOutcomes: [
      outcome('current', 'submitted', 'suggestion-edited', long, `${long}编辑`),
      outcome(null, 'submitted', 'suggestion-edited', long, `${long}历史编辑`),
      outcome(null, 'submitted', 'suggestion-exact', long, long),
    ],
  }, [], [], config)
  assert.ok(Buffer.byteLength(JSON.stringify(input.currentSessionFeedback), 'utf8') <= 512)
  assert.ok(Buffer.byteLength(JSON.stringify(input.userPreferenceMemory), 'utf8') <= 640)
})

test('only submitted edits are positive and current-cycle skips replace duplicate session rejections', () => {
  const config = core.resolveConfig({})
  const input = core.buildSuggestionInput({
    sessionId: 'current',
    draft: 'edited but not submitted',
    currentCycleSkipped: [' Ａ\u200b '],
    localOutcomes: [
      outcome('current', 'cycled', 'suggestion-edited', 'A', 'edited but not submitted'),
      outcome('current', 'cycled', 'suggestion-edited', 'B', 'another abandoned edit'),
      outcome('current', 'submitted', 'suggestion-edited', 'C', 'submitted edit'),
    ],
  }, [], [], config)

  assert.deepEqual(input.currentSessionFeedback, {
    editedSuggestions: [{ original: 'C', final: 'submitted edit', action: 'submitted' }],
    acceptedExact: [],
    rejectedSuggestions: [{ text: 'B' }],
  })
  assert.deepEqual(input.currentCycleSkipped, [' Ａ\u200b '])
})

test('current-cycle skips keep only the configured recent suggestions', () => {
  const config = core.resolveConfig({
    maxCurrentCycleSkipped: 10,
    maxCurrentCycleSkippedBytes: 256,
  })
  const input = core.buildSuggestionInput({
    sessionId: 'current',
    draft: '',
    currentCycleSkipped: ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)],
  }, [], [], config)
  assert.deepEqual(input.currentCycleSkipped, ['b'.repeat(100), 'c'.repeat(100)])
})

test('parseCandidateLine enforces one bounded candidate field', () => {
  const config = core.resolveConfig({})
  assert.equal(core.parseCandidateLine('{"candidate":" one "}', config), 'one')
  assert.throws(() => core.parseCandidateLine('not json', config), /not-json/)
  assert.throws(() => core.parseCandidateLine('{"candidate":"one","extra":true}', config), /invalid-line/)
  assert.throws(() => core.parseCandidateLine('{"candidate":2}', config), /invalid-line/)
})

test('systemPrompt states the prediction hierarchy, safety boundaries, and response format', () => {
  const prompt = core.systemPrompt()
  assert.match(prompt, /prompt design partner/)
  assert.match(prompt, /design one prompt that an agent should execute/)
  assert.match(prompt, /user intent is the source of truth/)
  assert.match(prompt, /Do not add new features, refactors, investigations, cleanup, tests, or requirements/)
  assert.match(prompt, /project\.cwd, project\.tree, project\.manifests, and project\.git/)
  assert.match(prompt, /This is intent design, not next-message prediction and not a roadmap/)
  assert.match(prompt, /current\.recentTurns and project evidence only as background/)
  assert.match(prompt, /Never invent files, facts, requirements, permissions, approvals/)
  assert.match(prompt, /The final output must be a self-contained, actionable prompt/)
  assert.match(prompt, /Never end the output with a question, never ask the user for missing details/)
  assert.match(prompt, /Output contract: one direct prompt/)
  const optimize = core.systemPrompt('optimize')
  assert.match(optimize, /preserve the engineer's real intent exactly/)
  assert.match(optimize, /Rewrite only to clarify and operationalize the same request/)
})
