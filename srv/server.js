const cds = require('@sap/cds')
const { randomUUID } = require('node:crypto')
const mountMcpRouter = require('./mcp-router')

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
    res.json({ status: 'UP', service: 'mcp-router', ts: new Date().toISOString() })
  })

  mountMcpRouter(app)

  LOG.info('mcp-router bootstrapped', {
    destination: cds.env.mcp?.destination,
    backendPath: cds.env.mcp?.backendPath,
    profiles: cds.env.profiles,
  })
})

module.exports = cds.server
