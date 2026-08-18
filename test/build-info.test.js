const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const MODULE_PATH = path.join(ROOT, 'srv', 'lib', 'build-info.js')
const STAMP_PATH = path.join(ROOT, 'build-info.json')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

// Load a *fresh* copy of the module so the once-per-process cache and the
// module-load `startedAt` don't leak between tests.
function freshBuildInfo() {
  delete require.cache[require.resolve(MODULE_PATH)]
  return require(MODULE_PATH).getBuildInfo()
}

test('getBuildInfo reports the package version and a start timestamp', () => {
  const info = freshBuildInfo()
  assert.equal(info.name, pkg.name)
  assert.equal(info.version, pkg.version)
  assert.match(info.startedAt, ISO)
  assert.equal(info.nodeVersion, process.version)
})

test('a build-info.json stamp is honored over env / package fallbacks', () => {
  const backup = fs.existsSync(STAMP_PATH) ? fs.readFileSync(STAMP_PATH) : null
  try {
    fs.writeFileSync(
      STAMP_PATH,
      JSON.stringify({
        name: 'mcp-router',
        version: '9.9.9',
        buildTime: '2020-01-02T03:04:05.000Z',
        commit: 'abcdef1234567890',
        commitShort: 'abcdef1',
        branch: 'release',
        nodeVersion: 'v18.0.0',
      }),
    )
    const info = freshBuildInfo()
    assert.equal(info.version, '9.9.9')
    assert.equal(info.buildTime, '2020-01-02T03:04:05.000Z')
    assert.equal(info.commit, 'abcdef1234567890')
    assert.equal(info.commitShort, 'abcdef1')
    assert.equal(info.branch, 'release')
    assert.equal(info.stamped, true)
  } finally {
    if (backup != null) fs.writeFileSync(STAMP_PATH, backup)
    else fs.rmSync(STAMP_PATH, { force: true })
  }
})

test('falls back to package version + env overrides when no stamp exists', () => {
  const backup = fs.existsSync(STAMP_PATH) ? fs.readFileSync(STAMP_PATH) : null
  const savedTime = process.env.BUILD_TIME
  const savedCommit = process.env.GIT_COMMIT
  const savedBranch = process.env.GIT_BRANCH
  try {
    fs.rmSync(STAMP_PATH, { force: true })
    process.env.BUILD_TIME = '2021-06-07T08:09:10.000Z'
    process.env.GIT_COMMIT = 'feedface00000000'
    process.env.GIT_BRANCH = 'env-branch'

    const info = freshBuildInfo()
    assert.equal(info.version, pkg.version)
    assert.equal(info.buildTime, '2021-06-07T08:09:10.000Z')
    assert.equal(info.commit, 'feedface00000000')
    assert.equal(info.commitShort, 'feedfac')
    assert.equal(info.branch, 'env-branch')
    assert.equal(info.stamped, false)
  } finally {
    restoreEnv('BUILD_TIME', savedTime)
    restoreEnv('GIT_COMMIT', savedCommit)
    restoreEnv('GIT_BRANCH', savedBranch)
    if (backup != null) fs.writeFileSync(STAMP_PATH, backup)
  }
})

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
