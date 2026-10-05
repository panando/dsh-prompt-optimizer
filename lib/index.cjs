'use strict'

const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { mkdir, readdir, readFile, rename, stat, writeFile } = require('node:fs/promises')
const { homedir } = require('node:os')
const { dirname, join } = require('node:path')
const { promisify } = require('node:util')
const {
  applyUserSettings,
  buildSuggestionInput,
  DEFAULT_OPTIMIZER_FEW_SHOT,
  DEFAULT_OPTIMIZER_PROMPT,
  OPTIMIZER_TEMPLATE,
  optimizerSystemPrompt,
  parseCandidateLine,
  resolveConfig,
  resolveUserSettings,
  systemPrompt,
  userSettingsBase,
  utf8Bytes,
} = require('./core.cjs')
const { FEATURES } = require('./features.cjs')

const RPC_PATH = '/dsh-prompt-optimizer/rpc'
const MAX_RPC_BYTES = 256 * 1024
const MAX_METRICS = 50
const execFileAsync = promisify(execFile)
const PROJECT_SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', '.idea', '.vscode', '.next', '.nuxt', '.turbo',
  'node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.cache',
  '.gradle', '.pytest_cache', '.mypy_cache', '.tox', '.venv', 'venv',
  '__pycache__', 'site-packages', '.pnpm-store', '.npm-cache',
])
const PROJECT_MANIFEST_NAMES = [
  'package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'requirements.txt',
  'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'tsconfig.json',
  'vite.config.ts', 'vite.config.js', 'next.config.ts', 'next.config.js',
  'docker-compose.yml', '.gitignore', 'README.md', 'README.zh.md',
]

function roundMs(value) {
  return Math.round(value * 10) / 10
}

// The built-in optimizer template and its two editable halves, shipped to the
// settings UI so "restore default" always restores the exact default text.
function optimizerTemplateDefaults() {
  return {
    optimizerPrompt: DEFAULT_OPTIMIZER_PROMPT,
    optimizerFewShot: DEFAULT_OPTIMIZER_FEW_SHOT,
    optimizerTemplate: OPTIMIZER_TEMPLATE,
  }
}

function createMetricsStore(ctx, limit = MAX_METRICS) {
  const entries = []
  return {
    record(metric) {
      entries.push(metric)
      if (entries.length > limit) entries.splice(0, entries.length - limit)
      if (ctx && ctx.logger && typeof ctx.logger.info === 'function') {
        try {
          ctx.logger.info(`prompt-optimizer metrics ${JSON.stringify(metric)}`)
        } catch (_loggingFailure) {
          // Performance logging is observational and never changes suggestion generation.
        }
      }
    },
    snapshot() {
      return entries.map((entry) => ({
        ...entry,
        stages: { ...entry.stages, candidateMs: [...entry.stages.candidateMs] },
        context: entry.context === null ? null : { ...entry.context },
        route: entry.route === null ? null : { ...entry.route },
        usage: entry.usage === null ? null : { ...entry.usage },
      }))
    },
  }
}

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function sameOrigin(request) {
  const origin = request.headers && request.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = request.headers && request.headers.host
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_RPC_BYTES) {
        reject(new Error('request-too-large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    request.on('error', reject)
  })
}

function service(ctx, name) {
  return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
}

function sessionEvents(session) {
  if (!session) return []
  if (Array.isArray(session.events)) return session.events
  try {
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    }
  } catch {
    // Fall through to the other session event faces.
  }
  try {
    if (typeof session.ownEvents === 'function') {
      const events = session.ownEvents()
      if (Array.isArray(events)) return events
    }
  } catch {
    // Fall through to an empty event list.
  }
  return []
}

function sessionCwd(session) {
  try {
    if (session && typeof session.header === 'object' && typeof session.header.cwd === 'string') {
      return session.header.cwd
    }
    if (session && typeof session.cwd === 'string') return session.cwd
  } catch {
    // Header lookup is best-effort; no cwd means no project grounding.
  }
  return undefined
}

async function collectProjectTree(cwd, config, maxDepth = 3) {
  const files = []
  async function walk(directory, relative, depth = 0) {
    if (files.length >= config.maxProjectTreeFiles) return
    if (depth > maxDepth) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (files.length >= config.maxProjectTreeFiles) return
      const name = entry.name
      if (PROJECT_SKIP_DIRS.has(name)) continue
      const path = relative === '' ? name : `${relative}/${name}`
      if (entry.isDirectory()) {
        await walk(`${directory}/${name}`, path, depth + 1)
        continue
      }
      if (entry.isFile()) files.push(path)
    }
  }
  await walk(cwd, '')
  return files
}

async function collectProjectManifests(cwd) {
  const manifests = {}
  for (const name of PROJECT_MANIFEST_NAMES) {
    const target = `${cwd}/${name}`
    try {
      const info = await stat(target)
      if (!info.isFile() || info.size > 262144) continue
      const text = await readFile(target, 'utf8')
      if (text.length > 0) manifests[name] = text.slice(0, 4096)
    } catch {
      // Missing or unreadable manifests simply do not participate.
    }
  }
  return manifests
}

async function collectProjectGit(cwd) {
  async function run(args) {
    try {
      const result = await execFileAsync('git', ['-C', cwd, ...args], {
        maxBuffer: 256 * 1024,
        timeout: 2000,
        windowsHide: true,
      })
      return String(result.stdout || '').trim().slice(0, 4096)
    } catch {
      return ''
    }
  }
  const [status, recent, diff] = await Promise.all([
    run(['status', '--porcelain']),
    run(['log', '-1', '--format=%h %s']),
    run(['diff', '--stat']),
  ])
  return {
    status,
    recent,
    diff,
  }
}

async function collectProjectContext(ctx, session, config) {
  if (config.projectContextEnabled !== true) return null
  const cwd = sessionCwd(session)
  if (!cwd) return null
  const tree = await collectProjectTree(cwd, config, config.projectContextDepth)
  const manifests = await collectProjectManifests(cwd)
  if (tree.length === 0 && Object.keys(manifests).length === 0) return null
  const git = await collectProjectGit(cwd)
  const project = { cwd, tree, manifests, git }
  const serialized = JSON.stringify(project)
  if (utf8Bytes(serialized) <= config.maxProjectContextBytes) return project
  // Drop the largest manifests first, then the tail of the file tree.
  while (Object.keys(project.manifests).length > 0
    && utf8Bytes(JSON.stringify(project)) > config.maxProjectContextBytes) {
    const entries = Object.entries(project.manifests)
    entries.sort((left, right) => utf8Bytes(left[1]) - utf8Bytes(right[1]))
    delete project.manifests[entries[entries.length - 1][0]]
  }
  while (project.tree.length > 0
    && utf8Bytes(JSON.stringify(project)) > config.maxProjectContextBytes) {
    project.tree.pop()
  }
  return utf8Bytes(JSON.stringify(project)) <= config.maxProjectContextBytes ? project : null
}

function withCatalogTimeout(promise, timeoutMs = 5000) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('catalog-timeout')), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function collectModelCatalog(ctx) {
  const llm = service(ctx, 'llm')
  const groups = []
  const failures = []
  if (llm && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function') await Promise.all(llm.listProviders().map(async (provider) => {
    try {
      const models = await withCatalogTimeout(llm.listModels(provider.id))
      const entries = []
      for (const model of models || []) {
        if (!model || typeof model.id !== 'string' || model.id === '') continue
        let resolved
        try {
          resolved = typeof llm.resolveModelInfo === 'function'
            ? await withCatalogTimeout(llm.resolveModelInfo(provider.id, model.id))
            : model
        } catch {
          resolved = model
        }
        const reasoning = resolved && resolved.reasoning
          ? {
              efforts: Array.isArray(resolved.reasoning.efforts)
                ? resolved.reasoning.efforts.map((effort) => ({
                    id: effort.id,
                    name: effort.name,
                    ...(effort.description === undefined ? {} : { description: effort.description }),
                  }))
                : [],
              ...(resolved.reasoning.defaultEffort === undefined
                ? {}
                : { defaultEffort: resolved.reasoning.defaultEffort }),
            }
          : undefined
        entries.push({
          id: model.id,
          name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(reasoning === undefined ? {} : { reasoning }),
        })
      }
      if (entries.length > 0) {
        groups.push({
          id: provider.id,
          name: typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id,
          models: entries,
        })
      }
    } catch (error) {
      failures.push({
        id: provider.id,
        name: typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }))
  if (groups.length === 0 && failures.length === 0) throw new Error('llm-catalog-unavailable')
  return { groups, failures }
}

function automaticTurnIsCurrent(session, trigger) {
  const events = sessionEvents(session)
  if (!session || events.length === 0 || !trigger || trigger.kind !== 'automatic') return false
  const lifecycle = [...events].reverse()
    .find((event) => event && (event.type === 'turn/start' || event.type === 'turn/end'))
  return Boolean(lifecycle && lifecycle.type === 'turn/end'
    && lifecycle.seq === trigger.endSeq
    && lifecycle.data && lifecycle.data.turn === trigger.turn
    && lifecycle.data.reason && lifecycle.data.reason.kind === 'completed')
}

function resolveRoute(ctx, session, config) {
  const fromSelection = (value) => {
    if (!value || typeof value.provider !== 'string' || value.provider === ''
      || typeof value.model !== 'string' || value.model === '') return undefined
    return {
      provider: value.provider,
      model: value.model,
      ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort !== ''
        ? { reasoningEffort: value.reasoningEffort }
        : {}),
    }
  }

  let selected
  if (config.provider !== undefined && config.model !== undefined) {
    selected = { provider: config.provider, model: config.model }
  } else {
    try {
      const defaults = service(ctx, 'agentDefaultModel')
      if (defaults && typeof defaults.currentSelection === 'function') {
        selected = fromSelection(defaults.currentSelection())
      }
    } catch {
      // 当前选择不可用时继续回退
    }
    if (!selected) {
      try {
        selected = session && typeof session.requestHeader === 'function'
          ? fromSelection(session.requestHeader()?.config)
          : undefined
      } catch {
        selected = undefined
      }
    }
  }
  if (!selected) return undefined
  if (config.reasoningEffort === 'inherit') {
    if (selected.reasoningEffort !== undefined) return selected
    try {
      const inherited = session && typeof session.requestHeader === 'function'
        ? fromSelection(session.requestHeader()?.config)?.reasoningEffort
        : undefined
      return inherited === undefined ? selected : { ...selected, reasoningEffort: inherited }
    } catch {
      return selected
    }
  }
  return { ...selected, reasoningEffort: config.reasoningEffort }
}

async function historicalEvents(ctx, sessionId, config) {
  const query = service(ctx, 'sessionQuery')
  if (!query || config.maxHistorySessions === 0
    || typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') return []
  try {
    const records = await query.listSessions()
    const lists = []
    for (const record of Array.isArray(records) ? records : []) {
      const id = record && record.header && record.header.id
      if (typeof id !== 'string' || id === sessionId) continue
      try {
        const snapshot = await query.readSession(id)
        if (snapshot && Array.isArray(snapshot.events)) {
          lists.push({ sessionId: id, events: snapshot.events })
        }
      } catch {
        // One unreadable historical session should not block current suggestions.
      }
      if (lists.length >= config.maxHistorySessions) break
    }
    return lists
  } catch {
    return []
  }
}

function normalizeCandidateIdentity(value) {
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US')
}

async function collectCandidate(
  stream,
  abortController,
  config,
  skipped,
  onCandidate,
  instrumentation = {},
  onDelta = () => {},
) {
  let raw = ''
  let outputBytes = 0
  let sawDelta = false
  let finish
  let toolCall = false
  const blocked = new Set(skipped.map(normalizeCandidateIdentity))
  async function acceptText(text) {
    if (text === '') return
    outputBytes += utf8Bytes(text)
    if (outputBytes > config.maxCandidateBytes * 4) {
      abortController.abort()
      throw new Error('model-output-too-large')
    }
    raw += text
    sawDelta = true
    await onDelta(text)
  }

  try {
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (typeof instrumentation.onChunk === 'function') instrumentation.onChunk(chunk)
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        await acceptText(chunk.text)
      } else if (!sawDelta && chunk.type === 'block-end'
        && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
        await acceptText(chunk.block.text)
      } else if (chunk.type === 'tool-call' || chunk.type === 'tool-call-delta'
        || (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call')) {
        toolCall = true
      } else if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
        if (typeof instrumentation.onUsage === 'function') instrumentation.onUsage(chunk.usage)
      } else if (chunk.type === 'finish') {
        finish = chunk.reason
      }
    }
  } finally {
    if (abortController.signal.aborted && stream && typeof stream.return === 'function') {
      try {
        await stream.return()
      } catch {
        // The abort already owns the failure.
      }
    }
  }
  if (toolCall) throw new Error('model-returned-tool-call')
  if (finish && finish.kind && finish.kind !== 'stop') {
    throw new Error(`model-finished-${finish.kind}`)
  }
  const cleaned = raw.trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim()
  if (cleaned === '') throw new Error('model-output-missing-candidate')
  const jsonLike = cleaned.startsWith('{') && cleaned.endsWith('}')
  const candidate = jsonLike ? parseCandidateLine(cleaned, config) : cleaned
  if (blocked.has(normalizeCandidateIdentity(candidate))) {
    throw new Error('model-output-missing-candidate')
  }
  await onCandidate(candidate)
  return candidate
}

function createGenerateStream(ctx, config, instrumentation = {}) {
  const now = typeof instrumentation.now === 'function' ? instrumentation.now : () => performance.now()
  const record = typeof instrumentation.record === 'function' ? instrumentation.record : () => {}
  return async function generate(args, onCandidate, requestSignal, onDelta = () => {}) {
    const requestStarted = now()
    const metric = {
      requestId: randomUUID(),
      at: Date.now(),
      status: 'error',
      code: null,
      route: null,
      context: null,
      stages: {
        historyMs: null,
        inputBuildMs: null,
        modelFirstChunkMs: null,
        modelFirstReasoningMs: null,
        modelFirstTextMs: null,
        candidateMs: [],
        modelTotalMs: null,
        totalMs: null,
      },
      usage: null,
    }
    let recorded = false
    const finishMetric = (status, code) => {
      if (recorded) return
      recorded = true
      metric.status = status
      metric.code = code
      metric.stages.totalMs = roundMs(now() - requestStarted)
      try {
        record(metric)
      } catch (_metricsFailure) {
        // An instrumentation consumer cannot change the generation result.
      }
    }
    const failure = (code, message) => {
      finishMetric('error', code)
      return { ok: false, code, message }
    }
    const manualTrigger = args && args.trigger && args.trigger.kind === 'manual'
    // Prediction is archived: with the flag off only the optimizer runs, and an
    // empty composer draft is reported instead of designing a next prompt.
    const requestedMode = args && args.mode === 'optimize' ? 'optimize' : 'predict'
    const mode = FEATURES.prediction ? requestedMode : 'optimize'
    const automaticTrigger = args && args.trigger && args.trigger.kind === 'automatic'
      && Number.isSafeInteger(args.trigger.turn) && args.trigger.turn >= 0
      && Number.isSafeInteger(args.trigger.endSeq) && args.trigger.endSeq >= 0
    if (!args || typeof args !== 'object' || typeof args.sessionId !== 'string'
      || typeof args.draft !== 'string' || !Array.isArray(args.currentCycleSkipped)
      || (!manualTrigger && !automaticTrigger)) {
      return failure('BAD_REQUEST', 'sessionId, draft, trigger, and currentCycleSkipped are required')
    }
    if (utf8Bytes(args.draft) > config.maxDraftBytes) {
      return failure('DRAFT_TOO_LARGE', 'The composer draft is too large.')
    }
    const sessions = service(ctx, 'sessions')
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(args.sessionId) : undefined
    if (!session) return failure('SESSION_NOT_LIVE', 'This session is no longer active.')
    if (automaticTrigger && !automaticTurnIsCurrent(session, args.trigger)) {
      return failure('TURN_NOT_COMPLETED', 'The completed turn changed before automatic generation started.')
    }
    const llm = service(ctx, 'llm')
    if (!llm || typeof llm.stream !== 'function') {
      return failure('NO_LLM', 'No Harness model route is available.')
    }
    const route = resolveRoute(ctx, session, config)
    if (!route) return failure('NO_MODEL_ROUTE', 'No model is selected for this session.')
    metric.route = {
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort ?? null,
    }

    let timedOut = false
    const controller = new AbortController()
    const abortForRequest = () => controller.abort()
    if (requestSignal) requestSignal.addEventListener('abort', abortForRequest, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, config.timeoutMs)
    let modelStarted = null
    try {
      // The optimizer contract only uses the raw draft and the placeholder map.
      // It does not consume session history, and asking the SessionQuery service
      // for historical sessions can leave the request open while that optional
      // service is still hydrating.
      const historyStarted = now()
      const history = args.mode === 'optimize'
        ? []
        : await historicalEvents(ctx, args.sessionId, config)
      metric.stages.historyMs = roundMs(now() - historyStarted)
      const inputStarted = now()
      // Project context is archived: collectProjectContext stays available but
      // is not called while FEATURES.projectContext is false.
      const project = FEATURES.projectContext
        ? await collectProjectContext(ctx, session, config)
        : null
      const input = buildSuggestionInput({ ...args, project }, sessionEvents(session), history, config)
      // Optimize mode uses the built-in editable template and the
      // `{ user_input, placeholder_map }` input contract. The composer draft is
      // sent verbatim without adding plugin context.
      const usesOptimizerTemplate = mode === 'optimize'
      const system = usesOptimizerTemplate ? optimizerSystemPrompt(config) : systemPrompt(mode)
      const inputJson = usesOptimizerTemplate
        ? JSON.stringify({ user_input: args.draft, placeholder_map: {} })
        : JSON.stringify(input)
      metric.stages.inputBuildMs = roundMs(now() - inputStarted)
      metric.context = {
        mode,
        optimizerTemplate: usesOptimizerTemplate
          ? {
              bytes: utf8Bytes(system),
              promptCustom: typeof config.optimizerPrompt === 'string'
                && config.optimizerPrompt.trim() !== '',
              fewShotCustom: typeof config.optimizerFewShot === 'string'
                && config.optimizerFewShot.trim() !== '',
            }
          : null,
        systemBytes: utf8Bytes(system),
        inputJsonBytes: utf8Bytes(inputJson),
        totalTextBytes: utf8Bytes(system) + utf8Bytes(inputJson),
        draftBytes: utf8Bytes(input.current.draft),
        recentTurnItems: input.current.recentTurns.length,
        recentTurnsBytes: utf8Bytes(JSON.stringify(input.current.recentTurns)),
        currentEditedItems: input.currentSessionFeedback.editedSuggestions.length,
        currentAcceptedItems: input.currentSessionFeedback.acceptedExact.length,
        currentRejectedItems: input.currentSessionFeedback.rejectedSuggestions.length,
        currentFeedbackBytes: utf8Bytes(JSON.stringify(input.currentSessionFeedback)),
        preferenceManualItems: input.userPreferenceMemory.manualPrompts.length,
        preferenceEditedItems: input.userPreferenceMemory.editedSuggestions.length,
        preferenceAcceptedItems: input.userPreferenceMemory.acceptedExact.length,
        preferenceRejectedItems: input.userPreferenceMemory.rejectedSuggestions.length,
        preferenceMemoryBytes: utf8Bytes(JSON.stringify(input.userPreferenceMemory)),
        fewShotItems: input.fewShots.length,
        fewShotBytes: utf8Bytes(JSON.stringify(input.fewShots)),
        currentCycleSkippedItems: input.currentCycleSkipped.length,
        currentCycleSkippedBytes: utf8Bytes(JSON.stringify(input.currentCycleSkipped)),
        projectBytes: input.project ? utf8Bytes(JSON.stringify(input.project)) : 0,
        projectTreeItems: input.project ? input.project.tree.length : 0,
        projectManifestItems: input.project ? Object.keys(input.project.manifests).length : 0,
      }
      if (mode === 'predict' && input.current.draft.trim() === ''
        && input.current.recentTurns.length === 0 && input.project === null) {
        return failure(
          'NO_USER_CONTEXT',
          'This new session has no previous human message. Add a draft first to use the optimizer.',
        )
      }
      if (!FEATURES.prediction && mode === 'optimize' && args.draft.trim() === '') {
        return failure('DRAFT_REQUIRED', 'Prompt Optimizer optimization requires composer text.')
      }
      modelStarted = now()
      const streamOptions = {
        provider: route.provider,
        model: route.model,
        sessionId: args.sessionId,
        maxTokens: config.maxOutputTokens,
        system,
        messages: [{
          id: `prompt-optimizer-${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text: inputJson }],
          source: { kind: 'plugin', plugin: 'dsh-prompt-optimizer' },
        }],
        signal: controller.signal,
      }
      if (route.reasoningEffort !== undefined) {
        streamOptions.reasoningEffort = route.reasoningEffort
      }
      const stream = llm.stream(streamOptions)
      const candidate = await collectCandidate(
        stream,
        controller,
        config,
        input.currentCycleSkipped,
        async (nextCandidate) => {
          metric.stages.candidateMs[0] = roundMs(now() - modelStarted)
          if (requestSignal && requestSignal.aborted) throw new Error('client-disconnected')
          if (automaticTrigger && !automaticTurnIsCurrent(session, args.trigger)) {
            throw new Error('automatic-turn-changed')
          }
          await onCandidate(nextCandidate)
        },
        {
          onChunk(chunk) {
            const elapsed = roundMs(now() - modelStarted)
            if (metric.stages.modelFirstChunkMs === null) metric.stages.modelFirstChunkMs = elapsed
            if (chunk.type === 'reasoning-delta' && metric.stages.modelFirstReasoningMs === null) {
              metric.stages.modelFirstReasoningMs = elapsed
            }
            if (chunk.type === 'text-delta' && metric.stages.modelFirstTextMs === null) {
              metric.stages.modelFirstTextMs = elapsed
            }
          },
          onUsage(usage) {
            const cacheReadTokens = usage.cacheReadTokens ?? 0
            const cacheWriteTokens = usage.cacheWriteTokens ?? 0
            metric.usage = {
              inputTokens: usage.inputTokens,
              totalInputTokens: usage.inputTokens + cacheReadTokens + cacheWriteTokens,
              outputTokens: usage.outputTokens,
              ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
              ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
              ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
            }
          },
        },
        async (text) => {
          if (requestSignal && requestSignal.aborted) return
          await onDelta(text)
        },
      )
      if (automaticTrigger && !automaticTurnIsCurrent(session, args.trigger)) {
        return failure('TURN_NOT_COMPLETED', 'The completed turn changed before the suggestion was ready.')
      }
      metric.stages.modelTotalMs = roundMs(now() - modelStarted)
      finishMetric('ok', null)
      return { ok: true, requestId: randomUUID(), candidate }
    } catch (error) {
      if (modelStarted !== null) metric.stages.modelTotalMs = roundMs(now() - modelStarted)
      const code = error && error.message === 'automatic-turn-changed'
        ? 'TURN_NOT_COMPLETED'
        : requestSignal && requestSignal.aborted
        ? 'CLIENT_DISCONNECTED'
        : timedOut ? 'TIMEOUT' : 'GENERATION_FAILED'
      return failure(
        code,
        code === 'TURN_NOT_COMPLETED'
          ? 'The completed turn changed before the suggestion was ready.'
          : code === 'CLIENT_DISCONNECTED'
          ? 'The browser stopped this suggestion request.'
          : code === 'TIMEOUT'
          ? 'Prompt Optimizer timed out.'
          : 'Prompt Optimizer could not generate a valid suggestion.',
      )
    } finally {
      clearTimeout(timer)
      if (requestSignal) requestSignal.removeEventListener('abort', abortForRequest)
    }
  }
}

function createGenerateHandler(ctx, config) {
  const generate = createGenerateStream(ctx, config)
  return async (args) => generate(args, async () => {})
}

function writeNdjson(response, event) {
  if (response.destroyed || response.writableEnded) return false
  response.write(`${JSON.stringify(event)}\n`)
  return true
}

function registerRoute(ctx, getConfig, getSettingsBinding) {
  const webServer = service(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('prompt-optimizer: webServer service is unavailable')
  }
  const metrics = createMetricsStore(ctx)
  return webServer.register({
    kind: 'exact',
    path: RPC_PATH,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        json(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' })
        return
      }
      if (!sameOrigin(request)) {
        json(response, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED' })
        return
      }
      let body
      try {
        body = await readJson(request)
      } catch (error) {
        json(response, error && error.message === 'request-too-large' ? 413 : 400, {
          ok: false,
          code: error && error.message === 'request-too-large' ? 'REQUEST_TOO_LARGE' : 'INVALID_JSON',
        })
        return
      }
      if (body.method === 'configuration') {
        const config = getConfig()
        json(response, 200, {
          ok: true,
          automatic: config.automatic,
          route: config.provider === undefined
            ? null
            : { provider: config.provider, model: config.model },
          reasoningEffort: config.reasoningEffort,
          maxCurrentCycleSkipped: config.maxCurrentCycleSkipped,
          maxCurrentCycleSkippedBytes: config.maxCurrentCycleSkippedBytes,
          maxLocalOutcomes: config.maxLocalOutcomes,
          maxLocalOutcomesBytes: config.maxLocalOutcomesBytes,
          projectContextEnabled: config.projectContextEnabled,
          projectContextDepth: config.projectContextDepth,
          maxProjectTreeFiles: config.maxProjectTreeFiles,
          maxProjectContextBytes: config.maxProjectContextBytes,
          maxOutputTokens: config.maxOutputTokens,
          timeoutMs: config.timeoutMs,
        })
        return
      }
      if (body.method === 'model-catalog') {
        try {
          const catalog = await collectModelCatalog(ctx)
          json(response, 200, { ok: true, catalog })
        } catch {
          json(response, 200, { ok: false, code: 'MODELS_UNAVAILABLE' })
        }
        return
      }
      if (body.method === 'settings') {
        const binding = getSettingsBinding()
        if (binding === undefined) {
          json(response, 200, { ok: false, code: 'SETTINGS_UNAVAILABLE' })
          return
        }
        try {
          const result = await binding.read()
          json(response, 200, {
            ok: true,
            settings: result.settings,
            defaults: optimizerTemplateDefaults(),
            features: FEATURES,
            writable: result.writable === true,
            revision: result.revision,
          })
        } catch {
          json(response, 200, { ok: false, code: 'SETTINGS_UNAVAILABLE' })
        }
        return
      }
      if (body.method === 'update-settings') {
        const binding = getSettingsBinding()
        if (binding === undefined) {
          json(response, 200, { ok: false, code: 'SETTINGS_UNAVAILABLE' })
          return
        }
        try {
          const result = await binding.replace(body.args && body.args.settings)
          json(response, 200, {
            ok: true,
            settings: result.settings,
            defaults: optimizerTemplateDefaults(),
            features: FEATURES,
            writable: result.writable === true,
            revision: result.revision,
          })
        } catch {
          json(response, 200, { ok: false, code: 'SETTINGS_REJECTED' })
        }
        return
      }
      if (body.method === 'metrics') {
        json(response, 200, { ok: true, metrics: metrics.snapshot() })
        return
      }
      if (body.method !== 'generate') {
        json(response, 404, { ok: false, code: 'UNKNOWN_METHOD' })
        return
      }
      const config = getConfig()
      const generate = createGenerateStream(ctx, config, {
        record: (metric) => metrics.record(metric),
      })
      response.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      const requestController = new AbortController()
      const abortRequest = () => {
        if (!response.writableEnded) requestController.abort()
      }
      response.on('close', abortRequest)
      try {
        const result = await generate(body.args, async (candidate) => {
          if (!writeNdjson(response, { type: 'candidate', candidate })) {
            requestController.abort()
          }
        }, requestController.signal, async (text) => {
          if (!writeNdjson(response, { type: 'delta', text })) {
            requestController.abort()
          }
        })
        if (!response.destroyed && !response.writableEnded) {
          writeNdjson(response, result.ok
            ? { type: 'done', requestId: result.requestId }
            : { type: 'error', code: result.code, message: result.message })
          response.end()
        }
      } finally {
        response.off('close', abortRequest)
      }
    },
  })
}

function settingsHome(ctx) {
  const profileHome = ctx?.profileContext?.home
  if (typeof profileHome === 'string' && profileHome !== '') return profileHome
  const envHome = process.env.DSH_HOME
  if (typeof envHome === 'string' && envHome !== '') return envHome
  return join(homedir(), '.dsh')
}

function createSettingsBinding(home, baseConfig) {
  const filePath = join(home, 'plugins', 'dsh-prompt-optimizer', 'settings.json')
  let current = userSettingsBase(baseConfig)
  let loaded = false
  let revision = 0
  let tail = Promise.resolve()

  const load = () => {
    const task = tail.then(async () => {
      if (loaded) return
      try {
        current = resolveUserSettings(
          JSON.parse(await readFile(filePath, 'utf8')),
          userSettingsBase(baseConfig),
        )
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      loaded = true
    })
    tail = task.catch(() => {})
    return task
  }

  return {
    get value() {
      return current
    },
    async read() {
      await load()
      return { settings: current, writable: true, revision }
    },
    async replace(value) {
      const next = resolveUserSettings(value, current)
      const task = tail.then(async () => {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
        const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
        await rename(temporary, filePath)
        current = next
        loaded = true
        revision += 1
      })
      tail = task.catch(() => {})
      await task
      return this.read()
    },
  }
}

module.exports = {
  name: 'dsh-prompt-optimizer',
  apply(ctx, inputConfig) {
    const baseConfig = resolveConfig(inputConfig)
    const settingsBinding = typeof ctx.inject === 'function'
      ? createSettingsBinding(settingsHome(ctx), baseConfig)
      : undefined
    if (settingsBinding) void settingsBinding.read().catch(() => {})
    const getConfig = () => settingsBinding === undefined
      ? baseConfig
      : applyUserSettings(baseConfig, settingsBinding.value)
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (hostCtx) => {
        hostCtx.effect(
          () => registerRoute(hostCtx, getConfig, () => settingsBinding),
          'dsh-prompt-optimizer: rpc route',
        )
      })
      return
    }
    return registerRoute(ctx, getConfig, () => settingsBinding)
  },
  _testing: {
    collectCandidate,
    collectModelCatalog,
    collectProjectContext,
    createMetricsStore,
    createGenerateHandler,
    createGenerateStream,
    automaticTurnIsCurrent,
    historicalEvents,
    normalizeCandidateIdentity,
    readJson,
    registerRoute,
    createSettingsBinding,
    settingsHome,
    resolveRoute,
    sameOrigin,
  },
}
