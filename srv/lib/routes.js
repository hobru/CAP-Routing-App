const cds = require('@sap/cds')

const LOG = cds.log('mcp')

/**
 * Resolve the list of proxy routes from configuration.
 *
 * Two shapes are supported, newest first:
 *
 *  1. Multi-route: `cds.mcp.routes` is an array of
 *     `{ path, destination, backendPath, locationId?, timeout?, peek?, methods? }`.
 *     Override the whole array at runtime (no rebuild) with a single JSON env
 *     var, e.g.
 *       cf set-env mcp-router-srv CDS_MCP_ROUTES '[{"path":"/mcp",...}]'
 *     `cds.env` may hand that back as a raw string, so we JSON.parse defensively.
 *
 *  2. Legacy single-route: no `routes` present — synthesize one `/mcp` route
 *     from the flat `destination` / `backendPath` keys (and their
 *     `CDS_MCP_DESTINATION` / `CDS_MCP_BACKENDPATH` env overrides). This keeps
 *     every existing deployment byte-for-byte identical.
 *
 * Per-route `locationId` / `timeout` fall back to the top-level `cds.mcp`
 * values, so a shared Cloud Connector only needs to be configured once.
 */
function resolveRoutes() {
  const mcp = cds.env.mcp || {}

  let routes = mcp.routes
  if (typeof routes === 'string') {
    try {
      routes = JSON.parse(routes)
    } catch (err) {
      LOG.error('CDS_MCP_ROUTES is not valid JSON — ignoring and using the single-route fallback', {
        error: err.message,
      })
      routes = undefined
    }
  }

  if (!Array.isArray(routes) || routes.length === 0) {
    // Legacy / default: one MCP route from the flat config. `peek` on so the
    // JSON-RPC method is still logged for troubleshooting.
    routes = [{ path: '/mcp', destination: mcp.destination, backendPath: mcp.backendPath, peek: true }]
  }

  return routes.map((r) => normalizeRoute(r, mcp)).filter(Boolean)
}

function normalizeRoute(raw, mcp) {
  if (!raw || typeof raw !== 'object') return null

  const rawPath = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : '/mcp'
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`

  let methods = null
  if (Array.isArray(raw.methods) && raw.methods.length) {
    methods = raw.methods.map((m) => String(m).toLowerCase())
  }

  return {
    path,
    destination: raw.destination || mcp.destination,
    backendPath: raw.backendPath != null ? raw.backendPath : (mcp.backendPath || ''),
    locationId: raw.locationId != null ? raw.locationId : mcp.locationId,
    timeout: raw.timeout != null ? raw.timeout : mcp.timeout,
    peek: raw.peek === true,
    methods,
  }
}

module.exports = { normalizeRoute, resolveRoutes }
