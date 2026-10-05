'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const {
  DEFAULT_OPTIMIZER_FEW_SHOT,
  DEFAULT_OPTIMIZER_PROMPT,
  OPTIMIZER_TEMPLATE,
  composeOptimizerTemplate,
  isDefaultOptimizerFewShot,
  isDefaultOptimizerPrompt,
} = require('../src/optimizer-template.cjs')
const {
  DEFAULT_USER_SETTINGS,
  applyUserSettings,
  resolveConfig,
  resolveUserSettings,
  optimizerSystemPrompt,
} = require('../src/core.cjs')

test('optimizer template halves reassemble into the built-in prompt byte-for-byte', () => {
  assert.equal(DEFAULT_OPTIMIZER_PROMPT + DEFAULT_OPTIMIZER_FEW_SHOT, OPTIMIZER_TEMPLATE)
  assert.equal(composeOptimizerTemplate(), OPTIMIZER_TEMPLATE)
  assert.equal(
    composeOptimizerTemplate(DEFAULT_OPTIMIZER_PROMPT, DEFAULT_OPTIMIZER_FEW_SHOT),
    OPTIMIZER_TEMPLATE,
  )
  assert.equal(
    composeOptimizerTemplate('', ''),
    OPTIMIZER_TEMPLATE,
  )
  assert.equal(OPTIMIZER_TEMPLATE.startsWith('<identity>\r\nYou are DeepSeek AI,'), true)
  assert.equal(Buffer.byteLength(OPTIMIZER_TEMPLATE, 'utf8'), 3769)
  assert.equal(
    createHash('sha256').update(OPTIMIZER_TEMPLATE).digest('hex'),
    '605e5c538f1e0be7c84756949a1a867dcd808c1bd5bb77134a035ea0c67d76c1',
  )
})

test('custom halves replace only their own section', () => {
  const customPrompt = composeOptimizerTemplate('CUSTOM RULES', DEFAULT_OPTIMIZER_FEW_SHOT)
  assert.equal(customPrompt, `CUSTOM RULES\r\n\r\n${DEFAULT_OPTIMIZER_FEW_SHOT}`)

  const customFewShot = composeOptimizerTemplate(DEFAULT_OPTIMIZER_PROMPT, '<example>hi</example>')
  assert.equal(customFewShot, `${DEFAULT_OPTIMIZER_PROMPT}<example>hi</example>`)

  assert.equal(
    composeOptimizerTemplate('P', 'F'),
    'P\r\n\r\nF',
  )
})

test('default detection helpers treat blanks as default', () => {
  assert.equal(isDefaultOptimizerPrompt(''), true)
  assert.equal(isDefaultOptimizerPrompt(DEFAULT_OPTIMIZER_PROMPT), true)
  assert.equal(isDefaultOptimizerPrompt('custom'), false)
  assert.equal(isDefaultOptimizerFewShot('   '), true)
  assert.equal(isDefaultOptimizerFewShot(DEFAULT_OPTIMIZER_FEW_SHOT), true)
  assert.equal(isDefaultOptimizerFewShot('<example>x</example>'), false)
})

test('user settings carry the editable halves and default to the built-in prompt', () => {
  assert.equal(DEFAULT_USER_SETTINGS.optimizerPrompt, '')
  assert.equal(DEFAULT_USER_SETTINGS.optimizerFewShot, '')

  const base = resolveConfig({})
  assert.equal(optimizerSystemPrompt(base), OPTIMIZER_TEMPLATE)

  const custom = applyUserSettings(base, {
    ...resolveUserSettings({}, DEFAULT_USER_SETTINGS),
    optimizerPrompt: 'ONLY THESE RULES',
  })
  assert.equal(custom.optimizerPrompt, 'ONLY THESE RULES')
  assert.equal(
    optimizerSystemPrompt(custom),
    `ONLY THESE RULES\r\n\r\n${DEFAULT_OPTIMIZER_FEW_SHOT}`,
  )

  const restored = applyUserSettings(custom, {
    ...resolveUserSettings({}, DEFAULT_USER_SETTINGS),
    optimizerPrompt: '',
  })
  assert.equal(optimizerSystemPrompt(restored), OPTIMIZER_TEMPLATE)
})

test('settings validation rejects non-string halves', () => {
  assert.throws(
    () => resolveUserSettings({ optimizerPrompt: 42 }, DEFAULT_USER_SETTINGS),
    /optimizerPrompt must be a string/,
  )
  assert.throws(
    () => resolveUserSettings({ optimizerFewShot: null }, DEFAULT_USER_SETTINGS),
    /optimizerFewShot must be a string/,
  )
})
