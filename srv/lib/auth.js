const cds = require('@sap/cds')
const xsenv = require('@sap/xsenv')
const { createSecurityContext, IdentityService } = require('@sap/xssec')

const LOG = cds.log('mcp')

const isProduction = (cds.env.profiles || []).includes('production')

let _identityService // lazily created, cached IAS validator

/**
 * Build (once) the IAS validator from the bound `identity` service credentials.
 * Returns null if no identity binding is present (e.g. local dev).
 */
function identityService() {
  if (_identityService !== undefined) return _identityService
  try {
    const { identity } = xsenv.getServices({ identity: { label: 'identity' } })
    _identityService = new IdentityService(identity)
  } catch (err) {
    LOG.warn('no identity service binding found', { error: err.message })
    _identityService = null
  }
  return _identityService
}

/** Extract the raw Bearer token from the Authorization header. */
function bearerToken(req) {
  const h = req.headers['authorization'] || req.headers['Authorization']
  if (!h || Array.isArray(h)) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  return m ? m[1] : undefined
}

/** Decode a JWT payload without verifying the signature (logging/dev only). */
function decodePayload(token) {
  try {
    const part = token.split('.')[1]
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

/** Best available user identifier for principal propagation + logging. */
function principalFromToken(token) {
  const p = token.payload || {}
  return {
    email: token.email || p.mail || p.email || p.user_name,
    sub: p.sub,
    issuer: token.issuer || p.iss,
  }
}

/**
 * Express guard that validates the inbound IAS (Entra-federated) JWT via
 * @sap/xssec and attaches `req.jwt` (raw token, reused for principal
 * propagation) plus `req.principal`.
 *
 * - `production` profile: a signature-verified Bearer token is mandatory.
 * - other profiles (local dev): unauthenticated requests are accepted and a
 *   mock principal is derived from the `x-dev-email` header.
 */
async function authenticate(req, res, next) {
  const token = bearerToken(req)

  if (!token) {
    if (isProduction) return unauthorized(res, req, 'missing_bearer_token')
    const email = req.headers['x-dev-email'] || 'dev.user@example.com'
    req.jwt = undefined
    req.principal = { email, sub: 'dev', issuer: 'local-dev' }
    LOG.warn('DEV auth fallback in use — no token validated', {
      correlationId: req.correlationId,
      email,
    })
    return next()
  }

  const ias = identityService()
  if (!ias) {
    if (isProduction) return unauthorized(res, req, 'no_identity_binding')
    // Dev with a token but no binding: accept unverified so routing is testable.
    req.jwt = token
    req.principal = principalFromToken({ payload: decodePayload(token) })
    LOG.warn('token accepted WITHOUT validation (no identity binding, dev only)', {
      correlationId: req.correlationId,
    })
    return next()
  }

  try {
    const securityContext = await createSecurityContext(ias, { token })
    req.jwt = token
    req.principal = principalFromToken(securityContext.token)
    return next()
  } catch (err) {
    const claims = decodePayload(token)
    LOG.warn('JWT validation failed', {
      correlationId: req.correlationId,
      error: err.message,
      sub: claims?.sub,
      iss: claims?.iss,
    })
    return unauthorized(res, req, 'invalid_token')
  }
}

function unauthorized(res, req, reason) {
  LOG.warn('401 unauthorized', { correlationId: req.correlationId, reason })
  res.status(401)
  res.setHeader('WWW-Authenticate', 'Bearer')
  res.json({ error: 'unauthorized', reason })
}

module.exports = { authenticate, bearerToken, principalFromToken }
