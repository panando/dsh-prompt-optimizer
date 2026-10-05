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
  // The peer range is an explicit enumeration of published harness builds (see
  // the prerelease-coverage test below); every peer entry must be identical.
  const peerRange = manifest.peerDependencies['@deepseek-ai/dsh']
  assert.match(peerRange, /0\.2\.0-rc\.2/)
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh'].optional, true)
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-settings-general',
  ])
  for (const name of manifest.dsh.client.inject) {
    assert.equal(manifest.peerDependencies[name], peerRange)
    assert.equal(manifest.peerDependenciesMeta[name].optional, true)
  }
  assert.doesNotMatch(patch, /trae|http.?token/i)
})

test('generated host and client artifacts are loadable and self-contained', () => {
  const host = require('../lib/index.cjs')
  assert.equal(host.name, 'dsh-prompt-optimizer')
  assert.equal(typeof host.apply, 'function')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const client = readFileSync(join(root, 'lib', 'client.cjs'), 'utf8')
  assert.match(client, /window\.__ModuleLoader__\.load/)
  // The client bundle must self-register under the exact package name; DSH keys
  // its client-module manifest by package specifier and fails web boot when a
  // scoped package declares a different (short) id.
  assert.ok(
    client.includes(`id: ${JSON.stringify(manifest.name)}`),
    `client bundle id must equal package name "${manifest.name}"`,
  )
  assert.doesNotMatch(client, /require\("\.\//)
})

test('peer range covers every published DSH harness prerelease', () => {
  const semver = require('semver')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const peers = manifest.peerDependencies || {}
  // Every version the DSH harness has actually published in the 0.1.5+ line.
  // A peer range without an explicit prerelease comparator on a version's exact
  // major.minor.patch tuple silently excludes that prerelease, which surfaces to
  // users as ERESOLVE. Enumerate the known builds so none are dropped.
  const publishedHarnessVersions = [
    '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3',
    '0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.7-alpha.1', '0.1.7-alpha.2',
    '0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1',
  ]
  for (const [name, range] of Object.entries(peers)) {
    for (const version of publishedHarnessVersions) {
      assert.ok(
        semver.satisfies(version, range),
        `${name} peer range "${range}" excludes published harness ${version}`,
      )
    }
  }
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
