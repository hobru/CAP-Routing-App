const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')

// Captured once when the module is first loaded (≈ app start / restage time).
// Useful as a coarse "is this a fresh deploy?" signal even when no build stamp
// was generated (e.g. a plain buildpack push that skipped the build script).
const STARTED_AT = new Date().toISOString()

let cached = null

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function mtimeIso(file) {
  try {
    return fs.statSync(file).mtime.toISOString()
  } catch {
    return null
  }
}

/**
 * Normalize a git remote URL to a browsable https base (no trailing `.git`,
 * no embedded credentials, scp-style `git@host:owner/repo` supported).
 * Returns null when it can't be confidently normalized.
 */
function normalizeRepoUrl(raw) {
  if (!raw) return null
  let url = String(raw).trim()
  if (!url) return null
  const scp = url.match(/^[\w.-]+@([\w.-]+):(.+)$/)
  if (scp) url = `https://${scp[1]}/${scp[2]}`
  url = url.replace(/^ssh:\/\//i, 'https://').replace(/^git:\/\//i, 'https://')
  url = url.replace(/\/\/[^/@]+@/, '//')
  url = url.replace(/\.git$/i, '').replace(/\/+$/, '')
  return /^https?:\/\/[^/]+\/.+/.test(url) ? url : null
}

/**
 * Best-effort build/version metadata for the running app, surfaced over the
 * unauthenticated `/config` and `/health` endpoints so operators can confirm
 * the expected build is actually deployed.
 *
 * Preference order:
 *   1. `build-info.json` (stamped at build time by scripts/gen-build-info.js).
 *   2. `BUILD_TIME` / `GIT_COMMIT` / `GIT_BRANCH` / `GIT_REPO_URL` env overrides.
 *   3. `package.json` version + its mtime as a coarse build-time fallback.
 * Always includes `startedAt` (module load time). When a repo URL is known it
 * also derives browsable `branchUrl` / `commitUrl`. Never throws.
 */
function getBuildInfo() {
  if (cached) return { ...cached, startedAt: STARTED_AT }

  const pkg = readJson(path.join(ROOT, 'package.json')) || {}
  const stamp = readJson(path.join(ROOT, 'build-info.json')) || {}

  const commit = stamp.commit || process.env.GIT_COMMIT || null
  const branch = stamp.branch || process.env.GIT_BRANCH || null
  const repo = normalizeRepoUrl(stamp.repo || process.env.GIT_REPO_URL)
  const info = {
    name: stamp.name || pkg.name || null,
    version: stamp.version || pkg.version || null,
    buildTime:
      stamp.buildTime ||
      process.env.BUILD_TIME ||
      mtimeIso(path.join(ROOT, 'build-info.json')) ||
      mtimeIso(path.join(ROOT, 'package.json')) ||
      null,
    commit,
    commitShort: stamp.commitShort || (commit ? String(commit).slice(0, 7) : null),
    branch,
    repo,
    branchUrl: repo && branch ? `${repo}/tree/${encodeURIComponent(branch)}` : null,
    commitUrl: repo && commit ? `${repo}/commit/${commit}` : null,
    nodeVersion: stamp.nodeVersion || process.version,
    stamped: Boolean(stamp.buildTime),
  }

  cached = info
  return { ...info, startedAt: STARTED_AT }
}

module.exports = { getBuildInfo }
