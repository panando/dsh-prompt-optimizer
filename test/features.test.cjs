'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const host = require('../src/index.cjs')
const core = require('../src/core.cjs')
const { FEATURES } = require('../src/features.cjs')

function streamOf(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

test('archived features ship disabled', () => {
  assert.equal(FEATURES.projectContext, false)
  assert.equal(FEATURES.prediction, false)
})

test('the Host reports the archived feature flags with the settings snapshot', async () => {
  let route
  const current = {
    automatic: true, route: null,
    projectContextEnabled: true, projectContextDepth: 3,
    maxProjectTreeFiles: 100, maxProjectContextBytes: 16384,
    maxOutputTokens: 2048, timeoutMs: 30000, fewShots: [],
    optimizerPrompt: '', optimizerFewShot: '',
  }
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register(entry) { route = entry; return () => {} } }
      return undefined
    },
  }
  const base = core.resolveConfig({ timeoutMs: 7654 })
  host._testing.registerRoute(
    ctx,
    () => core.applyUserSettings(base, current),
    () => ({
      read: async () => ({ settings: current, writable: true, revision: 1 }),
      replace: async () => ({ settings: current, writable: true, revision: 2 }),
    }),
  )
  const request = new (require('node:events').EventEmitter)()
  request.method = 'POST'
  request.headers = { host: '127.0.0.1:3080' }
  request.destroy = () => {}
  const response = new (require('node:events').EventEmitter)()
  let text = ''
  response.writeHead = () => {}
  response.end = (value = '') => { text += value }
  const pending = route.handler(request, response)
  request.emit('data', Buffer.from(JSON.stringify({ method: 'settings', args: {} })))
  request.emit('end')
  await pending
  const reply = JSON.parse(text)
  assert.deepEqual(reply.features, { projectContext: false, prediction: false })
  assert.equal(reply.defaults.optimizerPrompt.length > 0, true)
})

test('prediction is off: an empty draft is rejected instead of designed', async () => {
  const config = core.resolveConfig({ provider: 'fixture', model: 'fixture-model' })
  let llmCalls = 0
  const session = { id: 's1', events: [], cwd: 'C:/definitely/not/read', model: { provider: 'fixture', model: 'm' } }
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: () => session }
      if (name === 'llm') return { stream: () => { llmCalls += 1; return streamOf([]) } }
      if (name === 'workspace' || name === 'fs') {
        throw new Error('project context must not be read while the feature is off')
      }
      return undefined
    },
  }
  const generate = host._testing.createGenerateStream(ctx, config)
  const result = await generate(
    {
      sessionId: 's1',
      draft: '',
      mode: 'predict',
      trigger: { kind: 'manual' },
      currentCycleSkipped: [],
    },
    () => {},
    undefined,
    () => {},
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DRAFT_REQUIRED')
  assert.equal(llmCalls, 0)
})

test('optimize runs without reading project context', async () => {
  const config = core.resolveConfig({ provider: 'fixture', model: 'fixture-model' })
  const metrics = []
  let captured
  const session = { id: 's1', events: [], cwd: 'C:/definitely/not/read', model: { provider: 'fixture', model: 'm' } }
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: () => session }
      if (name === 'llm') {
        return {
          stream: (options) => {
            captured = options
            return streamOf([
              { type: 'text-delta', text: '展开后的指令' },
              { type: 'finish', reason: { kind: 'stop' } },
            ])
          },
        }
      }
      if (name === 'workspace' || name === 'fs') {
        throw new Error('project context must not be read while the feature is off')
      }
      return undefined
    },
  }
  const generate = host._testing.createGenerateStream(ctx, config, {
    record: (metric) => metrics.push(metric),
  })
  const result = await generate(
    {
      sessionId: 's1',
      draft: '把登录页改成深色',
      mode: 'optimize',
      trigger: { kind: 'manual' },
      currentCycleSkipped: [],
    },
    () => {},
    undefined,
    () => {},
  )
  assert.equal(result.ok, true)
  assert.equal(result.candidate, '展开后的指令')
  assert.equal(captured.system, core.OPTIMIZER_TEMPLATE)
  const metric = metrics.at(-1)
  assert.equal(metric.context.projectBytes, 0)
  assert.equal(metric.context.projectTreeItems, 0)
  assert.equal(metric.context.optimizerTemplate.bytes, 3769)
})
