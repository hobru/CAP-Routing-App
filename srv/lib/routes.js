const cds = require('@sap/cds')

const LOG = cds.log('mcp')

/**
 * Defensively JSON.parse a config value that may arrive as a raw string.
 *
 * `cds.env` surfaces env-var overrides (e.g. `CDS_MCP_ROUTES`,
 * `CDS_MCP_DESTINATIONS`) as strings, whereas `package.json` values arrive
 * already parsed. Returns `undefined` (and logs) on invalid JSON so the caller
 * can fall back instead of crashing the server.
 */
function parseArrayConfig(value, label) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch (err) {
    LOG.error(`${label} is not valid JSON — ignoring it`, { error: err.message })
    return undefined
  }
}

/**
 * Resolve the list of proxy routes from configuration.
 *
 * Three shapes are supported and can be combined, newest first:
 *
 *  1. Grouped destinations: `cds.mcp.destinations` is an array of
 *     `{ name, backendPath?, locationId?, timeout?, routes: [{ path, backendPath, ... }] }`.
 *     Each group binds one BTP destination and can expose many `routes`, each
 *     with its own public `path` and backend `backendPath`. This is the
 *     recommended shape when proxying to more than one on-prem system. Override
 *     the whole array at runtime (no rebuild) with a single JSON env var:
 *       cf set-env mcp-router-srv CDS_MCP_DESTINATIONS '[{"name":"dest-a","routes":[...]}]'
 *
 *  2. Multi-route: `cds.mcp.routes` is an array of
 *     `{ path, destination, backendPath, locationId?, timeout?, peek?, methods? }`.
 *     Each route may target its own `destination`. Override at runtime with:
 *       cf set-env mcp-router-srv CDS_MCP_ROUTES '[{"path":"/mcp",...}]'
 *
 *  3. Legacy single-route: none of the above present — synthesize one `/mcp`
 *     route from the flat `destination` / `backendPath` keys (and their
 *     `CDS_MCP_DESTINATION` / `CDS_MCP_BACKENDPATH` env overrides). This keeps
 *     every existing deployment byte-for-byte identical.
 *
 * Routes from grouped `destinations` and top-level `routes` are concatenated
 * into a single flat route table, so the two shapes can coexist. Per-route
 * `destination` / `backendPath` / `locationId` / `timeout` fall back to their
 * destination group (when grouped) and then to the top-level `cds.mcp` values,
 * so a shared Cloud Connector only needs to be configured once.
 */
function resolveRoutes() {
  const mcp = cds.env.mcp || {}
  const collected = []

  const destinations = parseArrayConfig(mcp.destinations, 'CDS_MCP_DESTINATIONS')
  if (Array.isArray(destinations)) {
    for (const group of destinations) {
      collected.push(...expandDestinationGroup(group, mcp))
    }
  }

  const routes = parseArrayConfig(mcp.routes, 'CDS_MCP_ROUTES')
  if (Array.isArray(routes)) {
    for (const r of routes) collected.push(normalizeRoute(r, mcp))
  }

  if (collected.length === 0) {
    // Legacy / default: one MCP route from the flat config. `peek` on so the
    // JSON-RPC method is still logged for troubleshooting.
    collected.push(normalizeRoute({ path: '/mcp', destination: mcp.destination, backendPath: mcp.backendPath, peek: true }, mcp))
  }

  // Two routes on the same public `path` would mount twice and shadow each
  // other (Express serves the first match). Keep the first occurrence — grouped
  // `destinations` are collected before top-level `routes`, so the grouped shape
  // wins — and drop later duplicates so an accidental leftover (e.g. a stale
  // package.json `routes` entry when switching to a `CDS_MCP_DESTINATIONS`
  // override) can't silently double-mount a path.
  return dedupeByPath(collected.filter(Boolean))
}

function dedupeByPath(routes) {
  const seen = new Set()
  const out = []
  for (const route of routes) {
    if (seen.has(route.path)) {
      LOG.warn('duplicate route path — keeping the first definition and ignoring the rest', {
        path: route.path,
        ignoredDestination: route.destination,
      })
      continue
    }
    seen.add(route.path)
    out.push(route)
  }
  return out
}

/**
 * Expand one grouped destination into its normalized routes. The group's
 * `name` becomes each route's destination (unless the route overrides it), and
 * the group's `backendPath` / `locationId` / `timeout` act as defaults for its
 * routes before falling back to the top-level `cds.mcp` config.
 */
function expandDestinationGroup(group, mcp) {
  if (!group || typeof group !== 'object') return []

  const groupRoutes = Array.isArray(group.routes) ? group.routes : []
  // Defaults inherited by every route in this group: the group's own values
  // take precedence, with the top-level cds.mcp config as the final fallback.
  const groupDefaults = {
    destination: group.name || group.destination || mcp.destination,
    backendPath: group.backendPath != null ? group.backendPath : mcp.backendPath,
    locationId: group.locationId != null ? group.locationId : mcp.locationId,
    timeout: group.timeout != null ? group.timeout : mcp.timeout,
  }

  return groupRoutes.map((r) => normalizeRoute(r, groupDefaults)).filter(Boolean)
}

/**
 * Non-sensitive view of the resolved route table, safe to expose over an
 * unauthenticated endpoint (see the `/config` route in `srv/server.js`).
 * Contains only configuration identifiers — destination names, public paths,
 * backend paths, SCC location ids — never tokens, credentials, or backend host
 * URLs (those live in the BTP destination, resolved per-request with the user's
 * JWT).
 */
function describeRoutes() {
  const mcp = cds.env.mcp || {}
  return {
    routes: resolveRoutes().map((r) => ({
      path: r.path,
      destination: r.destination || null,
      backendPath: r.backendPath,
      locationId: r.locationId != null ? r.locationId : (mcp.locationId != null ? mcp.locationId : null),
      methods: r.methods || 'all',
      peek: r.peek,
    })),
  }
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

module.exports = { normalizeRoute, resolveRoutes, describeRoutes }
