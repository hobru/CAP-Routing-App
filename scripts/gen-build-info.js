#!/usr/bin/env node
/**
 * Stamp build metadata into `build-info.json` at the repo root so the running
 * app can report *which* build is actually deployed (see `/config` and
 * `/health`). Runs at build time — wired into the `build` npm script and the
 * `postinstall` hook, so it fires during `mbt build` (MTA npm builder) and
 * during Cloud Foundry buildpack staging (`npm ci`).
 *
 * It must NEVER fail the install/build: git may be unavailable (e.g. on the
 * buildpack, where there is no `.git`), and the target filesystem may be
 * read-only. Every step is best-effort and the script always exits 0.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')

function readPkg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

function main() {
  const pkg = readPkg()
  const commit = process.env.GIT_COMMIT || git(['rev-parse', 'HEAD'])
  const info = {
    name: pkg.name || null,
    version: pkg.version || null,
    buildTime: process.env.BUILD_TIME || new Date().toISOString(),
    commit: commit || null,
    commitShort: commit ? commit.slice(0, 7) : null,
    branch: process.env.GIT_BRANCH || git(['rev-parse', '--abbrev-ref', 'HEAD']) || null,
    nodeVersion: process.version,
  }

  try {
    fs.writeFileSync(path.join(ROOT, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`)
    console.log(`build-info.json: ${info.version} ${info.commitShort || '(no commit)'} @ ${info.buildTime}`)
  } catch (err) {
    // Read-only filesystem (e.g. at runtime) — nothing to stamp, carry on.
    console.warn(`gen-build-info: could not write build-info.json (${err.message})`)
  }
}

main()
