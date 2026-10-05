'use strict'

const { Buffer } = require('node:buffer')
const DEFAULT_FEW_SHOT_RECORDS = require('./default-few-shot-library.json')
const {
  DEFAULT_OPTIMIZER_FEW_SHOT,
  DEFAULT_OPTIMIZER_PROMPT,
  OPTIMIZER_TEMPLATE,
  composeOptimizerTemplate,
  isDefaultOptimizerFewShot,
  isDefaultOptimizerPrompt,
} = require('./optimizer-template.cjs')

const REDACTED = '[REDACTED_SECRET]'
const TRUNCATED = '\n...[truncated]...\n'
const OUTCOME_ACTIONS = new Set(['submitted', 'cycled'])
const OUTCOME_ORIGINS = new Set(['manual', 'suggestion-exact', 'suggestion-edited'])

const DEFAULT_CONFIG = Object.freeze({
  // Prompt optimization expands instructions rather than summarising them, so
  // the accepted candidate is allowed to grow beyond the old 4 KiB plugin limit.
  maxCandidateBytes: 8192,
  maxDraftBytes: 32768,
  maxOptimizerPromptBytes: 65536,
  maxOptimizerFewShotBytes: 65536,
  optimizerPrompt: '',
  optimizerFewShot: '',
  maxCurrentCycleSkipped: 10,
  maxCurrentCycleSkippedBytes: 16384,
  maxCurrentTurns: 3,
  maxCurrentContextBytes: 16384,
  maxCurrentFeedbackBytes: 4096,
  maxPreferenceMemoryBytes: 8192,
  maxHistorySessions: 20,
  maxManualPrompts: 8,
  maxEditedSuggestions: 6,
  maxAcceptedExact: 6,
  maxRejectedSuggestions: 4,
  maxLocalOutcomes: 50,
  maxLocalOutcomesBytes: 131072,
  maxProjectContextBytes: 16384,
  maxProjectTreeFiles: 100,
  projectContextEnabled: true,
  projectContextDepth: 3,
  maxOutputTokens: 2048,
  timeoutMs: 30000,
  automatic: true,
  reasoningEffort: 'off',
  // Curated examples are kept separate from user settings and are merged only
  // when building the model input. This keeps the settings page user-owned.
  defaultFewShots: Object.freeze([]),
  fewShots: Object.freeze([]),
})

const DEFAULT_USER_SETTINGS = Object.freeze({
  automatic: true,
  route: null,
  reasoningEffort: 'off',
  projectContextEnabled: true,
  projectContextDepth: 3,
  maxProjectTreeFiles: 100,
  maxProjectContextBytes: 16384,
  maxOutputTokens: 2048,
  timeoutMs: 30000,
  fewShots: Object.freeze([]),
  // Editable halves of the built-in optimize_user_input system prompt.
  // Empty string means "use the default text"; both empty preserves it exactly.
  optimizerPrompt: '',
  optimizerFewShot: '',
})

function integer(name, value, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`prompt-optimizer: ${name} must be a safe integer >= ${minimum}`)
  }
  return value
}

function unwrapConfigValue(value) {
  return value && typeof value.get === 'function' ? value.get() : value
}

function resolveConfig(input) {
  const source = input && typeof input === 'object'
    ? Object.fromEntries(Object.entries(input).map(([key, value]) => [key, unwrapConfigValue(value)]))
    : {}
  const config = {
    ...DEFAULT_CONFIG,
    ...source,
  }
  // Drop the removed manual-generation shortcut from legacy config snapshots.
  delete config.shortcut
  config.defaultFewShots = normalizeFewShots(
    source.defaultFewShots === undefined ? DEFAULT_FEW_SHOT_RECORDS : source.defaultFewShots,
  )
  config.fewShots = normalizeFewShots(config.fewShots)
  integer('maxCandidateBytes', config.maxCandidateBytes, 1)
  integer('maxDraftBytes', config.maxDraftBytes, 1)
  integer('maxCurrentCycleSkipped', config.maxCurrentCycleSkipped, 1)
  integer('maxCurrentCycleSkippedBytes', config.maxCurrentCycleSkippedBytes, 256)
  integer('maxCurrentTurns', config.maxCurrentTurns, 1)
  integer('maxCurrentContextBytes', config.maxCurrentContextBytes, 256)
  integer('maxCurrentFeedbackBytes', config.maxCurrentFeedbackBytes, 256)
  integer('maxPreferenceMemoryBytes', config.maxPreferenceMemoryBytes, 256)
  integer('maxHistorySessions', config.maxHistorySessions, 0)
  integer('maxManualPrompts', config.maxManualPrompts, 0)
  integer('maxEditedSuggestions', config.maxEditedSuggestions, 0)
  integer('maxAcceptedExact', config.maxAcceptedExact, 0)
  integer('maxRejectedSuggestions', config.maxRejectedSuggestions, 0)
  integer('maxLocalOutcomes', config.maxLocalOutcomes, 0)
  integer('maxLocalOutcomesBytes', config.maxLocalOutcomesBytes, 256)
  integer('maxProjectContextBytes', config.maxProjectContextBytes, 256)
  integer('maxProjectTreeFiles', config.maxProjectTreeFiles, 1)
  integer('projectContextDepth', config.projectContextDepth, 0)
  integer('maxOutputTokens', config.maxOutputTokens, 1)
  integer('timeoutMs', config.timeoutMs, 1)
  if (config.projectContextDepth > 5) {
    throw new TypeError('prompt-optimizer: projectContextDepth must be <= 5')
  }
  if (config.maxProjectTreeFiles > 500) {
    throw new TypeError('prompt-optimizer: maxProjectTreeFiles must be <= 500')
  }
  if (config.maxProjectContextBytes > 131072) {
    throw new TypeError('prompt-optimizer: maxProjectContextBytes must be <= 131072')
  }
  if (config.maxOutputTokens > 16384) {
    throw new TypeError('prompt-optimizer: maxOutputTokens must be <= 16384')
  }
  if (config.timeoutMs > 300000) {
    throw new TypeError('prompt-optimizer: timeoutMs must be <= 300000')
  }
  if (typeof config.automatic !== 'boolean') {
    throw new TypeError('prompt-optimizer: automatic must be a boolean')
  }
  if (!['inherit', 'off', 'low', 'high', 'max'].includes(config.reasoningEffort)) {
    throw new TypeError('prompt-optimizer: reasoningEffort must be inherit, off, low, high, or max')
  }
  if (typeof config.projectContextEnabled !== 'boolean') {
    throw new TypeError('prompt-optimizer: projectContextEnabled must be a boolean')
  }
  if ((config.provider === undefined) !== (config.model === undefined)) {
    throw new TypeError('prompt-optimizer: provider and model must be configured together')
  }
  if (config.provider !== undefined
    && (typeof config.provider !== 'string' || config.provider === ''
      || typeof config.model !== 'string' || config.model === '')) {
    throw new TypeError('prompt-optimizer: provider and model must be non-empty strings')
  }
  return Object.freeze(config)
}

function userSettingsBase(config) {
  return Object.freeze({
    automatic: config.automatic,
    route: config.provider === undefined
      ? null
      : Object.freeze({ provider: config.provider, model: config.model }),
    reasoningEffort: config.reasoningEffort,
    projectContextEnabled: config.projectContextEnabled,
    projectContextDepth: config.projectContextDepth,
    maxProjectTreeFiles: config.maxProjectTreeFiles,
    maxProjectContextBytes: config.maxProjectContextBytes,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    fewShots: normalizeFewShots(config.fewShots),
    optimizerPrompt: typeof config.optimizerPrompt === 'string' ? config.optimizerPrompt : '',
    optimizerFewShot: typeof config.optimizerFewShot === 'string' ? config.optimizerFewShot : '',
  })
}

function normalizeFewShots(value) {
  if (!Array.isArray(value) || value.length > 16) {
    throw new TypeError('prompt-optimizer settings: fewShots must contain at most 16 examples')
  }
  const total = []
  let totalBytes = 0
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || (raw.type !== 'rewrite' && raw.type !== 'task')) {
      throw new TypeError(`prompt-optimizer settings: fewShots[${index}] has an invalid type`)
    }
    const sourceText = raw.type === 'rewrite' ? raw.input : raw.hint
    const field = raw.type === 'rewrite' ? 'input' : 'hint'
    if (typeof sourceText !== 'string' || typeof raw.output !== 'string'
      || typeof raw.enabled !== 'boolean') {
      throw new TypeError(`prompt-optimizer settings: fewShots[${index}] requires enabled, ${field}, and output`)
    }
    const item = {
      id: typeof raw.id === 'string' && raw.id.trim() !== ''
        ? truncateUtf8(raw.id.trim(), 80)
        : `few-shot-${index + 1}`,
      type: raw.type,
      enabled: raw.enabled,
      [field]: truncateUtf8(sourceText.trim(), 2048),
      output: truncateUtf8(raw.output.trim(), 4096),
    }
    if (item[field] === '' || item.output === '') {
      throw new TypeError(`prompt-optimizer settings: fewShots[${index}] text must not be empty`)
    }
    totalBytes += utf8Bytes(JSON.stringify(item))
    if (totalBytes > 96 * 1024) {
      throw new TypeError('prompt-optimizer settings: fewShots exceeds the 96 KiB storage limit')
    }
    total.push(Object.freeze(item))
  }
  return Object.freeze(total)
}

function resolveUserSettings(input, fallback = DEFAULT_USER_SETTINGS) {
  const source = input && typeof input === 'object' ? input : {}
  const settings = {
    automatic: source.automatic === undefined ? fallback.automatic : source.automatic,
    route: source.route === undefined ? fallback.route : source.route,
    reasoningEffort: source.reasoningEffort === undefined
      ? fallback.reasoningEffort
      : source.reasoningEffort,
    projectContextEnabled: source.projectContextEnabled === undefined
      ? fallback.projectContextEnabled
      : source.projectContextEnabled,
    projectContextDepth: source.projectContextDepth === undefined
      ? fallback.projectContextDepth
      : source.projectContextDepth,
    maxProjectTreeFiles: source.maxProjectTreeFiles === undefined
      ? fallback.maxProjectTreeFiles
      : source.maxProjectTreeFiles,
    maxProjectContextBytes: source.maxProjectContextBytes === undefined
      ? fallback.maxProjectContextBytes
      : source.maxProjectContextBytes,
    maxOutputTokens: source.maxOutputTokens === undefined
      ? fallback.maxOutputTokens
      : source.maxOutputTokens,
    timeoutMs: source.timeoutMs === undefined
      ? fallback.timeoutMs
      : source.timeoutMs,
    fewShots: source.fewShots === undefined
      ? normalizeFewShots(fallback.fewShots)
      : normalizeFewShots(source.fewShots),
    optimizerPrompt: source.optimizerPrompt === undefined
      ? fallback.optimizerPrompt
      : source.optimizerPrompt,
    optimizerFewShot: source.optimizerFewShot === undefined
      ? fallback.optimizerFewShot
      : source.optimizerFewShot,
  }
  if (typeof settings.automatic !== 'boolean') {
    throw new TypeError('prompt-optimizer settings: automatic must be a boolean')
  }
  if (settings.route !== null
    && (!settings.route || typeof settings.route !== 'object'
      || typeof settings.route.provider !== 'string' || settings.route.provider.trim() === ''
      || typeof settings.route.model !== 'string' || settings.route.model.trim() === '')) {
    throw new TypeError('prompt-optimizer settings: route must be null or a provider/model pair')
  }
  if (!['inherit', 'off', 'low', 'high', 'max'].includes(settings.reasoningEffort)) {
    throw new TypeError('prompt-optimizer settings: reasoningEffort must be inherit, off, low, high, or max')
  }
  if (typeof settings.projectContextEnabled !== 'boolean') {
    throw new TypeError('prompt-optimizer settings: projectContextEnabled must be a boolean')
  }
  for (const [name, value] of [
    ['projectContextDepth', settings.projectContextDepth],
    ['maxProjectTreeFiles', settings.maxProjectTreeFiles],
    ['maxProjectContextBytes', settings.maxProjectContextBytes],
    ['maxOutputTokens', settings.maxOutputTokens],
    ['timeoutMs', settings.timeoutMs],
  ]) {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`prompt-optimizer settings: ${name} must be an integer`)
    }
  }
  for (const [name, value] of [
    ['optimizerPrompt', settings.optimizerPrompt],
    ['optimizerFewShot', settings.optimizerFewShot],
  ]) {
    if (typeof value !== 'string') {
      throw new TypeError(`prompt-optimizer settings: ${name} must be a string`)
    }
  }
  if (utf8Bytes(settings.optimizerPrompt) > DEFAULT_CONFIG.maxOptimizerPromptBytes) {
    throw new TypeError('prompt-optimizer settings: optimizerPrompt is too large')
  }
  if (utf8Bytes(settings.optimizerFewShot) > DEFAULT_CONFIG.maxOptimizerFewShotBytes) {
    throw new TypeError('prompt-optimizer settings: optimizerFewShot is too large')
  }
  return Object.freeze({
    automatic: settings.automatic,
    route: settings.route === null
      ? null
      : Object.freeze({
          provider: settings.route.provider.trim(),
          model: settings.route.model.trim(),
        }),
    reasoningEffort: settings.reasoningEffort,
    projectContextEnabled: settings.projectContextEnabled,
    projectContextDepth: settings.projectContextDepth,
    maxProjectTreeFiles: settings.maxProjectTreeFiles,
    maxProjectContextBytes: settings.maxProjectContextBytes,
    maxOutputTokens: settings.maxOutputTokens,
    timeoutMs: settings.timeoutMs,
    fewShots: settings.fewShots,
    optimizerPrompt: settings.optimizerPrompt,
    optimizerFewShot: settings.optimizerFewShot,
  })
}

function applyUserSettings(config, input) {
  const settings = resolveUserSettings(input, userSettingsBase(config))
  const next = {
    ...config,
    automatic: settings.automatic,
    reasoningEffort: settings.reasoningEffort,
    projectContextEnabled: settings.projectContextEnabled,
    projectContextDepth: settings.projectContextDepth,
    maxProjectTreeFiles: settings.maxProjectTreeFiles,
    maxProjectContextBytes: settings.maxProjectContextBytes,
    maxOutputTokens: settings.maxOutputTokens,
    timeoutMs: settings.timeoutMs,
    fewShots: settings.fewShots,
    optimizerPrompt: settings.optimizerPrompt,
    optimizerFewShot: settings.optimizerFewShot,
  }
  delete next.shortcut
  if (settings.route === null) {
    delete next.provider
    delete next.model
  } else {
    next.provider = settings.route.provider
    next.model = settings.route.model
  }
  return resolveConfig(next)
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

function jsonBytes(value) {
  return utf8Bytes(JSON.stringify(value))
}

function takePrefixWithinBytes(text, maxBytes) {
  let result = ''
  let bytes = 0
  for (const character of text) {
    const nextBytes = utf8Bytes(character)
    if (bytes + nextBytes > maxBytes) break
    result += character
    bytes += nextBytes
  }
  return result
}

function takeSuffixWithinBytes(text, maxBytes) {
  const characters = Array.from(text)
  let result = ''
  let bytes = 0
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const nextBytes = utf8Bytes(characters[index])
    if (bytes + nextBytes > maxBytes) break
    result = characters[index] + result
    bytes += nextBytes
  }
  return result
}

function truncateUtf8(value, maxBytes) {
  const text = String(value)
  if (maxBytes <= 0) return ''
  if (utf8Bytes(text) <= maxBytes) return text
  const markerBytes = utf8Bytes(TRUNCATED)
  if (maxBytes <= markerBytes) return takePrefixWithinBytes(text, maxBytes)
  const remaining = maxBytes - markerBytes
  const headBytes = Math.floor(remaining * 0.35)
  return takePrefixWithinBytes(text, headBytes)
    + TRUNCATED
    + takeSuffixWithinBytes(text, remaining - headBytes)
}

function redactSecrets(text) {
  return String(text)
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/\b((?:api[_-]?key|token|password)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/\bBearer\s+[^\s,;]{12,}/gi, `Bearer ${REDACTED}`)
}

function messageText(data) {
  if (!data || !Array.isArray(data.content)) return ''
  return data.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function eventMessage(event) {
  if (!event || typeof event !== 'object') return undefined
  if (event.type === 'user/message') return event.data
  if (event.type === 'assistant/message') return event.data && event.data.message
  return undefined
}

function conversationMessages(events) {
  if (!Array.isArray(events)) return []
  const messages = []
  for (const event of events) {
    if (!event || (event.type !== 'user/message' && event.type !== 'assistant/message')) continue
    if (event.type === 'user/message'
      && (!event.data || !event.data.source || event.data.source.kind !== 'user')) continue
    const text = redactSecrets(messageText(eventMessage(event))).trim()
    if (text !== '') messages.push({ role: event.type === 'user/message' ? 'user' : 'assistant', text })
  }
  return messages
}

function directUserPrompts(events) {
  if (!Array.isArray(events)) return []
  const prompts = []
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue
    if (!event.data || !event.data.source || event.data.source.kind !== 'user') continue
    const text = redactSecrets(messageText(event.data)).trim()
    if (text !== '') prompts.push({ text })
  }
  return prompts
}

function takeRecentWithinBudget(items, maxItems, maxBytes) {
  const selected = []
  for (let index = items.length - 1; index >= 0 && selected.length < maxItems; index -= 1) {
    const candidate = [items[index], ...selected]
    if (jsonBytes(candidate) <= maxBytes) selected.unshift(items[index])
  }
  return selected
}

function normalizeLocalOutcomes(value, config) {
  if (!Array.isArray(value) || config.maxLocalOutcomes === 0) return []
  const outcomes = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const action = typeof raw.action === 'string' ? raw.action : ''
    const origin = typeof raw.origin === 'string' ? raw.origin : ''
    if (!OUTCOME_ACTIONS.has(action) || !OUTCOME_ORIGINS.has(origin)) continue
    if ((origin === 'manual' && action !== 'submitted')
      || (origin === 'suggestion-edited' && typeof raw.finalText !== 'string')) continue
    const originalText = typeof raw.originalText === 'string'
      ? redactSecrets(raw.originalText).trim()
      : undefined
    const finalText = typeof raw.finalText === 'string'
      ? redactSecrets(raw.finalText).trim()
      : undefined
    if (origin !== 'manual' && (originalText === undefined || originalText === '')) continue
    if (action === 'submitted' && (finalText === undefined || finalText === '')) continue
    if (originalText !== undefined && utf8Bytes(originalText) > config.maxCandidateBytes) continue
    if (finalText !== undefined && utf8Bytes(finalText) > config.maxDraftBytes) continue
    outcomes.push({
      sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== ''
        ? raw.sessionId.slice(0, 256)
        : null,
      action,
      origin,
      ...(originalText === undefined || originalText === '' ? {} : { originalText }),
      ...(finalText === undefined || finalText === '' ? {} : { finalText }),
      ...(Number.isFinite(raw.at) ? { at: raw.at } : {}),
    })
  }
  return takeRecentWithinBudget(
    outcomes,
    config.maxLocalOutcomes,
    config.maxLocalOutcomesBytes,
  )
}

function outcomeKey(sessionId, text) {
  return `${sessionId}\u0000${text}`
}

function submittedOriginIndex(outcomes) {
  const index = new Map()
  for (const outcome of outcomes) {
    if (outcome.sessionId === null || outcome.action !== 'submitted' || !outcome.finalText) continue
    index.set(outcomeKey(outcome.sessionId, outcome.finalText), outcome.origin)
  }
  return index
}

function rawConversationTurns(events, outcomes, sessionId) {
  const origins = submittedOriginIndex(outcomes)
  const turns = []
  let current
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || (event.type !== 'user/message' && event.type !== 'assistant/message')) continue
    if (event.type === 'user/message'
      && (!event.data || !event.data.source || event.data.source.kind !== 'user')) continue
    const text = redactSecrets(messageText(eventMessage(event))).trim()
    if (text === '') continue
    if (event.type === 'user/message') {
      const recordedOrigin = origins.get(outcomeKey(sessionId, text))
      current = {
        user: {
          text,
          origin: recordedOrigin || 'manual',
        },
      }
      turns.push(current)
    } else if (current) {
      current.assistant = {
        text: current.assistant ? `${current.assistant.text}\n\n${text}` : text,
      }
    }
  }
  return turns
}

function allocateTurnText(turn, maxBytes) {
  const userBytes = utf8Bytes(turn.user.text)
  const assistantBytes = turn.assistant ? utf8Bytes(turn.assistant.text) : 0
  let assistantBudget = Math.min(assistantBytes, Math.floor(maxBytes * 0.65))
  let userBudget = Math.min(userBytes, maxBytes - assistantBudget)
  let remaining = maxBytes - assistantBudget - userBudget
  const assistantRemainder = Math.min(assistantBytes - assistantBudget, remaining)
  assistantBudget += assistantRemainder
  remaining -= assistantRemainder
  userBudget += Math.min(userBytes - userBudget, remaining)
  return {
    user: {
      ...turn.user,
      text: truncateUtf8(turn.user.text, userBudget),
    },
    ...(turn.assistant ? {
      assistant: { text: truncateUtf8(turn.assistant.text, assistantBudget) },
    } : {}),
  }
}

function allocateRecentTurns(turns, textBudget) {
  const weights = turns.length === 1 ? [1] : turns.length === 2 ? [0.3, 0.7] : [0.15, 0.25, 0.6]
  const fullBytes = turns.map((turn) => (
    utf8Bytes(turn.user.text) + (turn.assistant ? utf8Bytes(turn.assistant.text) : 0)
  ))
  const budgets = weights.map((weight, index) => Math.min(fullBytes[index], Math.floor(textBudget * weight)))
  let remaining = textBudget - budgets.reduce((total, value) => total + value, 0)
  for (let index = turns.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const extra = Math.min(fullBytes[index] - budgets[index], remaining)
    budgets[index] += extra
    remaining -= extra
  }
  return turns.map((turn, index) => allocateTurnText(turn, budgets[index]))
}

function recentConversationTurns(events, outcomes, sessionId, config) {
  let turns = rawConversationTurns(events, outcomes, sessionId).slice(-config.maxCurrentTurns)
  while (turns.length > 0) {
    if (jsonBytes(turns) <= config.maxCurrentContextBytes) return turns
    const empty = turns.map((turn) => ({
      user: { ...turn.user, text: '' },
      ...(turn.assistant ? { assistant: { text: '' } } : {}),
    }))
    if (jsonBytes(empty) > config.maxCurrentContextBytes) {
      turns = turns.slice(1)
      continue
    }
    let low = 0
    let high = config.maxCurrentContextBytes
    let best = empty
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = allocateRecentTurns(turns, middle)
      if (jsonBytes(candidate) <= config.maxCurrentContextBytes) {
        best = candidate
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return best
  }
  return []
}

function packSections(definitions, maxBytes) {
  const packed = Object.fromEntries(definitions.map(({ name }) => [name, []]))
  for (const { name, items, maxItems } of definitions) {
    const selected = []
    for (let index = items.length - 1; index >= 0 && selected.length < maxItems; index -= 1) {
      const candidate = [items[index], ...selected]
      if (jsonBytes({ ...packed, [name]: candidate }) <= maxBytes) selected.unshift(items[index])
    }
    packed[name] = selected
  }
  return packed
}

function normalizeCandidateIdentity(value) {
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US')
}

function feedbackFor(outcomes, predicate, config, maxBytes, excludedRejections = new Set()) {
  const perTextBytes = Math.min(config.maxCandidateBytes, Math.max(128, Math.floor(maxBytes / 4)))
  const editedSuggestions = []
  const acceptedExact = []
  const rejectedSuggestions = []
  for (const outcome of outcomes) {
    if (!predicate(outcome)) continue
    if (outcome.origin === 'suggestion-edited' && outcome.action === 'submitted'
      && outcome.originalText && outcome.finalText) {
      editedSuggestions.push({
        original: truncateUtf8(outcome.originalText, perTextBytes),
        final: truncateUtf8(outcome.finalText, perTextBytes),
        action: outcome.action,
      })
    }
    if (outcome.origin === 'suggestion-exact' && outcome.action === 'submitted') {
      acceptedExact.push({ text: truncateUtf8(outcome.finalText || outcome.originalText, perTextBytes) })
    }
    if (outcome.action === 'cycled' && outcome.originalText
      && !excludedRejections.has(normalizeCandidateIdentity(outcome.originalText))) {
      rejectedSuggestions.push({ text: truncateUtf8(outcome.originalText, perTextBytes) })
    }
  }
  return packSections([
    { name: 'editedSuggestions', items: editedSuggestions, maxItems: config.maxEditedSuggestions },
    { name: 'acceptedExact', items: acceptedExact, maxItems: config.maxAcceptedExact },
    { name: 'rejectedSuggestions', items: rejectedSuggestions, maxItems: config.maxRejectedSuggestions },
  ], maxBytes)
}

function historicalSession(record) {
  if (!record || typeof record !== 'object' || typeof record.sessionId !== 'string'
    || !Array.isArray(record.events)) return undefined
  return record
}

function preferenceMemory(historicalRecords, outcomes, config) {
  const records = (Array.isArray(historicalRecords) ? historicalRecords : [])
    .map(historicalSession)
    .filter(Boolean)
  const sessionIds = new Set(records.map((record) => record.sessionId))
  const inScope = outcomes.filter((outcome) => (
    outcome.sessionId === null || sessionIds.has(outcome.sessionId)
  ))
  const origins = submittedOriginIndex(inScope)
  const perTextBytes = Math.min(
    config.maxCandidateBytes,
    Math.max(128, Math.floor(config.maxPreferenceMemoryBytes / 4)),
  )
  const manualPrompts = []
  for (const record of [...records].reverse()) {
    for (const prompt of directUserPrompts(record.events)) {
      const origin = origins.get(outcomeKey(record.sessionId, prompt.text))
      if (origin === undefined || origin === 'manual') {
        manualPrompts.push({ text: truncateUtf8(prompt.text, perTextBytes) })
      }
    }
  }
  for (const outcome of inScope) {
    if (outcome.sessionId === null && outcome.origin === 'manual'
      && outcome.action === 'submitted' && outcome.finalText) {
      manualPrompts.push({ text: truncateUtf8(outcome.finalText, perTextBytes) })
    }
  }
  const suggestionFeedback = feedbackFor(
    inScope,
    (outcome) => outcome.origin !== 'manual',
    config,
    config.maxPreferenceMemoryBytes,
  )
  const editedSubmitted = suggestionFeedback.editedSuggestions
    .map(({ original, final }) => ({ original, final }))
  return packSections([
    { name: 'manualPrompts', items: manualPrompts, maxItems: config.maxManualPrompts },
    { name: 'editedSuggestions', items: editedSubmitted, maxItems: config.maxEditedSuggestions },
    { name: 'acceptedExact', items: suggestionFeedback.acceptedExact, maxItems: config.maxAcceptedExact },
    {
      name: 'rejectedSuggestions',
      items: suggestionFeedback.rejectedSuggestions,
      maxItems: config.maxRejectedSuggestions,
    },
  ], config.maxPreferenceMemoryBytes)
}

function buildSuggestionInput(args, currentEvents, historicalRecords, config) {
  const draft = typeof args.draft === 'string' ? args.draft : ''
  const mode = args.mode === 'optimize' ? 'optimize' : 'predict'
  const project = args.project && typeof args.project === 'object'
    ? {
        cwd: typeof args.project.cwd === 'string' ? truncateUtf8(args.project.cwd, 1024) : '',
        tree: Array.isArray(args.project.tree)
          ? args.project.tree.slice(0, 120).map((value) => truncateUtf8(String(value), 256))
          : [],
        manifests: args.project.manifests && typeof args.project.manifests === 'object'
          ? Object.fromEntries(Object.entries(args.project.manifests)
              .slice(0, 12)
              .map(([name, value]) => [String(name).slice(0, 80), truncateUtf8(String(value), 4096)]))
          : {},
        git: args.project.git && typeof args.project.git === 'object'
          ? {
              status: truncateUtf8(String(args.project.git.status || ''), 2048),
              recent: truncateUtf8(String(args.project.git.recent || ''), 256),
              diff: truncateUtf8(String(args.project.git.diff || ''), 2048),
            }
          : {},
      }
    : null
  if (utf8Bytes(draft) > config.maxDraftBytes) throw new Error('draft-too-large')
  const currentCycleSkipped = Array.isArray(args.currentCycleSkipped)
    ? args.currentCycleSkipped.filter((value) => typeof value === 'string').map(redactSecrets)
    : []
  if (currentCycleSkipped.some((value) => utf8Bytes(value) > config.maxCandidateBytes)) {
    throw new Error('skipped-candidate-too-large')
  }
  const outcomes = normalizeLocalOutcomes(args.localOutcomes, config)
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
  const packedCurrentCycleSkipped = takeRecentWithinBudget(
    currentCycleSkipped,
    config.maxCurrentCycleSkipped,
    config.maxCurrentCycleSkippedBytes,
  )
  // User examples take precedence over the curated library while both remain
  // bounded before entering the model context.
  const fewShots = [
    ...normalizeFewShots(config.fewShots || []),
    ...normalizeFewShots(config.defaultFewShots || []),
  ].filter((item) => item.enabled).slice(0, 8)
  while (fewShots.length > 0 && jsonBytes(fewShots) > 16 * 1024) fewShots.pop()
  const currentCycleSkippedIdentities = new Set(
    packedCurrentCycleSkipped.map(normalizeCandidateIdentity),
  )

  return Object.freeze({
    mode,
    originalPrompt: redactSecrets(draft),
    project,
    current: {
      draft: redactSecrets(draft),
      recentTurns: recentConversationTurns(currentEvents, outcomes, sessionId, config),
    },
    currentSessionFeedback: feedbackFor(
      outcomes,
      (outcome) => outcome.sessionId === sessionId,
      config,
      config.maxCurrentFeedbackBytes,
      currentCycleSkippedIdentities,
    ),
    userPreferenceMemory: preferenceMemory(historicalRecords, outcomes, config),
    fewShots: fewShots.map((item) => ({
      ...item,
      ...(item.type === 'rewrite'
        ? { input: redactSecrets(item.input), output: redactSecrets(item.output) }
        : { hint: redactSecrets(item.hint), output: redactSecrets(item.output) }),
    })),
    currentCycleSkipped: packedCurrentCycleSkipped,
  })
}

function systemPrompt(mode = 'predict') {
  const shared = [
    'You are a prompt design partner for a senior software engineer who works with a coding agent.',
    'You do not write the implementation, answer the question, or narrate the repository. You design one prompt that an agent should execute.',
    'The user intent is the source of truth. Treat originalPrompt and current.draft as the exact goal the user is asking for; context may clarify that goal but must never replace, broaden, or redirect it.',
    'Preserve the user\'s target, scope, constraints, language, names, commands, and expected outcome. Add detail only when it makes the same intent more executable.',
    'Do not add new features, refactors, investigations, cleanup, tests, or requirements that the user did not ask for. Prefer the narrowest faithful interpretation over a broader helpful one.',
    'Context is background. Use it to understand the situation, not to echo it, imitate the user, or produce a casual prediction of their next message.',
    'The final output must be a self-contained, actionable prompt in the user\'s language. No JSON wrapper, Markdown fence, label, preface, or commentary.',
    'Never invent files, facts, requirements, permissions, approvals, or instructions that are not supported by the prompt and project evidence.',
    'Never end the output with a question, never ask the user for missing details, and never emit a plan, analysis report, or list of pending confirmations. The output is the prompt itself.',
    'If an input is vague, choose the narrowest faithful interpretation of the user\'s words; use project evidence only to disambiguate. Do not use wording such as "please confirm", "please provide", "向用户确认", or "待确认".',
    'The output is exactly one prompt, not several prompts. Do not add sections, headings, numbered lists, a roadmap, or unrelated improvements.',
    'Output contract: one direct prompt that tells the agent what to do, not a question, confirmation list, or analysis report.',
  ]
  if (mode === 'optimize') {
    return [
      ...shared,
      'Goal: preserve the engineer\'s real intent exactly, then make the prompt precise and executable. originalPrompt and current.draft are the primary evidence and override project context.',
      'Rewrite only to clarify and operationalize the same request. Do not paraphrase the request into a summary, turn it into a generic checklist, or expand it into adjacent work.',
      'Start from the requested outcome and keep every explicit constraint. Do not turn a request to change one thing into a bundle of additional changes.',
      'Use project.cwd, project.tree, project.manifests, and project.git only to bind the same intent to actual files, modules, commands, tests, and current changes.',
      'If the user prompt is broad, choose the narrowest project-supported interpretation and make that interpretation concrete. Do not invent decisions, permissions, files, or requirements.',
      'Output contract: one direct prompt that tells the agent what to do. Do not output "向用户确认", "请提供", "请确认", a confirmation list, an analysis report, or a request for clarification.',
    ].join('\n')
  }
  return [
    ...shared,
    'Goal: infer the engineer\'s most likely next intent and write that as one prompt. This is intent design, not next-message prediction and not a roadmap.',
    'Prefer continuing the user\'s current work and the immediately unfinished goal. Do not introduce a new direction merely because project context makes it possible.',
    'Use the latest human message and the unfinished work as the primary intent; use project context only to make that same intent concrete.',
    'Use project.cwd, project.tree, project.manifests, and project.git as background to understand the actual stack, files, commands, and current changes.',
    'Use current.recentTurns and project evidence only as background to understand what has already happened and what is still missing. Do not imitate chat style, produce a greeting, self-introduction, project summary, or assistant response.',
    'If the draft is empty, choose one concrete next step that continues the user\'s current intent; do not list alternatives. If the draft is non-empty, treat this as optimization and preserve that intent.',
    'Use currentSessionFeedback and userPreferenceMemory only for durable style and workflow habits; evidence never overrides intent or grants permission.',
    'Use input.fewShots only as examples of transformation style. Match the example type, preserve the current request, and never copy example-specific facts or requirements into the new prompt.',
  ].join('\n')
}

/**
 * System prompt for the optimize flow, reassembled from its two editable
 * halves. With both halves left at their defaults this returns the built-in
 * template byte-for-byte.
 */
function optimizerSystemPrompt(config = {}) {
  return composeOptimizerTemplate(config.optimizerPrompt, config.optimizerFewShot)
}

function parseCandidateLine(text, config) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('model-output-line-not-json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).length !== 1 || typeof parsed.candidate !== 'string') {
    throw new Error('model-output-invalid-line')
  }
  const candidate = parsed.candidate.trim()
  if (candidate === '' || utf8Bytes(candidate) > config.maxCandidateBytes) {
    throw new Error('model-output-invalid-candidate')
  }
  return candidate
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_USER_SETTINGS,
  applyUserSettings,
  buildSuggestionInput,
  conversationMessages,
  directUserPrompts,
  eventMessage,
  messageText,
  normalizeLocalOutcomes,
  normalizeFewShots,
  optimizerSystemPrompt,
  OPTIMIZER_TEMPLATE,
  DEFAULT_OPTIMIZER_PROMPT,
  DEFAULT_OPTIMIZER_FEW_SHOT,
  composeOptimizerTemplate,
  isDefaultOptimizerPrompt,
  isDefaultOptimizerFewShot,
  parseCandidateLine,
  recentConversationTurns,
  redactSecrets,
  resolveConfig,
  resolveUserSettings,
  systemPrompt,
  takeRecentWithinBudget,
  truncateUtf8,
  utf8Bytes,
  userSettingsBase,
}
