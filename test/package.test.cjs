'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')

test('package declares an installable DSH bundle and web client', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.keywords.includes('dsh-plugin'), true)
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'], '>=0.2.0-rc.1 <0.3.0')
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh'].optional, true)
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-settings-general',
  ])
  for (const name of manifest.dsh.client.inject) {
    assert.equal(manifest.peerDependencies[name], '>=0.2.0-rc.1 <0.3.0')
    assert.equal(manifest.peerDependenciesMeta[name].optional, true)
  }
  assert.doesNotMatch(patch, /trae|http.?token/i)
})

test('generated host and client artifacts are loadable and self-contained', () => {
  const host = require('../lib/index.cjs')
  assert.equal(host.name, 'dsh-prompt-optimizer')
  assert.equal(typeof host.apply, 'function')
  const client = readFileSync(join(root, 'lib', 'client.cjs'), 'utf8')
  assert.match(client, /window\.__ModuleLoader__\.load/)
  assert.match(client, /id: "dsh-prompt-optimizer"/)
  assert.doesNotMatch(client, /require\("\.\//)
})

test('published package excludes development scripts and research archives', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.files.includes('scripts'), false)
  assert.equal(manifest.files.includes('docs'), false)
  assert.equal(manifest.files.includes('assets'), false)
  assert.equal(manifest.files.includes('lib'), true)
  assert.equal(manifest.files.includes('cordis.patch.yml'), true)
  assert.equal(manifest.files.includes('README.md'), true)
  assert.equal(manifest.files.includes('README.zh-CN.md'), true)
  assert.equal(existsSync(join(root, 'lib', 'trae-provider.cjs')), false)
  assert.equal(existsSync(join(root, 'lib', 'trae-runtime.cjs')), false)
})
