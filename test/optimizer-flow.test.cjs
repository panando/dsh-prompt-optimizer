'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const host = require('../src/index.cjs')
const core = require('../src/core.cjs')
const { FEATURES } = require('../src/features.cjs')

function fakeCtx(streamImpl) {
  const session = {
    id: 'session-1',
    events: [],
    model: { provider: 'fixture', model: 'fixture-model' },
  }
  return {
    get(name) {
      if (name === 'sessions') return { get: () => session }
      if (name === 'llm') return { stream: streamImpl }
      return undefined
    },
  }
}

function streamOf(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

test('optimize mode feeds the built-in DeepSeek template and returns raw text', async () => {
  const config = core.resolveConfig({ provider: 'fixture', model: 'fixture-model' })
  let captured
  const ctx = fakeCtx((options) => {
    captured = options
    return streamOf([
      { type: 'text-delta', text: '把登录页的背景改成深色，' },
      { type: 'text-delta', text: '并保持现有表单校验逻辑不变。' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })
  const generate = host._testing.createGenerateStream(ctx, config)
  const result = await generate(
    {
      sessionId: 'session-1',
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
  assert.equal(result.candidate, '把登录页的背景改成深色，并保持现有表单校验逻辑不变。')
  assert.equal(captured.system, core.OPTIMIZER_TEMPLATE)
  assert.equal(Buffer.byteLength(captured.system, 'utf8'), 3769)
  assert.deepEqual(JSON.parse(captured.messages[0].content[0].text), {
    user_input: '把登录页改成深色',
    placeholder_map: {},
  })
})

test('optimize mode does not wait for optional historical session hydration', async () => {
  const config = core.resolveConfig({ provider: 'fixture', model: 'fixture-model' })
  let historyCalls = 0
  const ctx = fakeCtx((options) => streamOf([
    { type: 'text-delta', text: 'optimized' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]))
  const baseGet = ctx.get
  ctx.get = (name) => {
    if (name === 'sessionQuery') {
      return {
        listSessions() {
          historyCalls += 1
          return new Promise(() => {})
        },
      }
    }
    return baseGet(name)
  }
  const generate = host._testing.createGenerateStream(ctx, config)
  const result = await Promise.race([
    generate({
      sessionId: 'session-1',
      draft: '优化这个提示词',
      mode: 'optimize',
      trigger: { kind: 'manual' },
      currentCycleSkipped: [],
    }, () => {}, undefined, () => {}),
    new Promise((_, reject) => setTimeout(() => reject(new Error('optimizer timed out')), 500)),
  ])

  assert.equal(result.ok, true)
  assert.equal(historyCalls, 0)
})

test('predict mode keeps the plugin prompt and the structured input',
  { skip: FEATURES.prediction ? false : 'archived: prediction is disabled' }, async () => {
  const config = core.resolveConfig({ provider: 'fixture', model: 'fixture-model' })
  let captured
  const ctx = fakeCtx((options) => {
    captured = options
    return streamOf([
      { type: 'text-delta', text: '{"candidate":"继续把登录页改完"}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })
  const generate = host._testing.createGenerateStream(ctx, config)
  const result = await generate(
    {
      sessionId: 'session-1',
      draft: '把登录页改成深色',
      mode: 'predict',
      trigger: { kind: 'manual' },
      currentCycleSkipped: [],
    },
    () => {},
    undefined,
    () => {},
  )

  assert.equal(result.ok, true)
  assert.equal(result.candidate, '继续把登录页改完')
  assert.notEqual(captured.system, core.OPTIMIZER_TEMPLATE)
  assert.equal(captured.system.includes('prompt design partner'), true)
  const parsed = JSON.parse(captured.messages[0].content[0].text)
  assert.equal(parsed.current.draft, '把登录页改成深色')
})

test('a customized half is used while the other half stays at its default', async () => {
  const config = core.applyUserSettings(
    core.resolveConfig({ provider: 'fixture', model: 'fixture-model' }),
    {
    ...core.resolveUserSettings({}, core.DEFAULT_USER_SETTINGS),
    route: { provider: 'fixture', model: 'fixture-model' },
    optimizerFewShot: '<example>short</example>',
    },
  )
  let captured
  const ctx = fakeCtx((options) => {
    captured = options
    return streamOf([
      { type: 'text-delta', text: 'ok' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })
  const generate = host._testing.createGenerateStream(ctx, config)
  await generate(
    {
      sessionId: 'session-1',
      draft: 'x',
      mode: 'optimize',
      trigger: { kind: 'manual' },
      currentCycleSkipped: [],
    },
    () => {},
    undefined,
    () => {},
  )
  assert.equal(captured.system, `${core.DEFAULT_OPTIMIZER_PROMPT}<example>short</example>`)
})
