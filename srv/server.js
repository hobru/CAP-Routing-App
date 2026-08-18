const cds = require('@sap/cds')
const { randomUUID } = require('node:crypto')
const mountMcpRouter = require('./mcp-router')
const { resolveRoutes, describeRoutes } = require('./lib/routes')
const { getBuildInfo } = require('./lib/build-info')

const LOG = cds.log('mcp')

/**
 * Attach a correlation id to every request so a single MCP call can be traced
 * end-to-end across the router logs and (via the forwarded header) the backend.
 */
function correlationId(req, res, next) {
  const id =
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    req.headers['x-vcap-request-id'] ||
    randomUUID()
  req.correlationId = id
  res.setHeader('x-correlation-id', id)
  next()
}

// Register custom endpoints at bootstrap, BEFORE CAP mounts its own body
// parsers / protocol adapters, so the /mcp route can stream the raw request
// and response body (required for MCP Streamable HTTP + SSE).
cds.on('bootstrap', (app) => {
  app.use(correlationId)

  // Lightweight liveness probe (unauthenticated) for CF health checks.
  app.get('/health', (_req, res) => {
    res.json({ status: 'UP', service: 'mcp-router', build: getBuildInfo(), ts: new Date().toISOString() })
  })

  // Read-only view of the resolved routing configuration, so operators can see
  // — from a browser or `curl`, without digging through User-Provided Variables
  // in the BTP cockpit — which destination and backend path each public path
  // maps to. Exposes only configuration identifiers (destination names, public
  // paths, backend paths, SCC location ids); never tokens, credentials, or the
  // backend host URL (that lives in the BTP destination and is resolved
  // per-request with the caller's JWT).
  app.get('/config', (_req, res) => {
    res.json({
      service: 'mcp-router',
      build: getBuildInfo(),
      profiles: cds.env.profiles,
      ts: new Date().toISOString(),
      ...describeRoutes(),
    })
  })

  mountMcpRouter(app)

  LOG.info('mcp-router bootstrapped', {
    routes: resolveRoutes().map((r) => `${r.path} → ${r.destination}${r.backendPath}`),
    profiles: cds.env.profiles,
  })
})

module.exports = cds.server
