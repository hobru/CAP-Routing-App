const cds = require('@sap/cds')
const express = require('express')
const { authenticate } = require('./lib/auth')
const { proxyToBackend } = require('./lib/proxy')
const { resolveRoutes } = require('./lib/routes')

const LOG = cds.log('mcp')

// Cap on how much of a POST body we buffer purely to log the JSON-RPC method.
// MCP client→server messages are small; anything larger is streamed unparsed.
const MAX_PEEK_BYTES = 256 * 1024

/** Read the request body into a Buffer (bounded) so we can log the MCP method. */
function bufferBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let overflow = false
    req.on('data', (c) => {
      size += c.length
      if (overflow) return
      if (size > MAX_PEEK_BYTES) {
        overflow = true
        chunks.push(c)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve({ body: Buffer.concat(chunks), overflow }))
    req.on('error', () => resolve({ body: Buffer.concat(chunks), overflow }))
  })
}

async function handleMcp(req, res) {
  const route = req.mcpRoute || {}
  // For MCP routes we buffer the (small) client message so we can record the
  // JSON-RPC method for troubleshooting, then hand the buffered body to the
  // proxy. This is opt-in per route (`peek`) so non-MCP backends (e.g. OData
  // $batch / large writes) stream straight through instead of being buffered in
  // memory. Responses are never buffered — they stream through (SSE-safe).
  if (route.peek && req.method === 'POST') {
    const { body } = await bufferBody(req)
    req.rawBody = body
    try {
      const json = JSON.parse(body.toString('utf8'))
      req.parsedMcpMethod = Array.isArray(json) ? json.map((m) => m.method).join(',') : json.method
    } catch {
      /* not JSON (or too large) — leave method undefined */
    }
  }
  // Never let a proxy failure become an unhandled rejection — that would crash
  // the whole CDS server. Contain it to this single request instead.
  try {
    return await proxyToBackend(req, res)
  } catch (err) {
    LOG.error('mcp handler failed', {
      correlationId: req.correlationId,
      error: err.message,
      stack: err.stack,
    })
    if (!res.headersSent) res.status(502).json({ error: 'proxy_error', detail: err.message })
    else res.end()
  }
}

/**
 * Mount the router(s) on the bootstrapped Express app.
 *
 * Each configured route (see `lib/routes.js`) becomes its own authenticated
 * catch-all mount that reverse-proxies to a backend path via the BTP
 * destination + Cloud Connector. All routes share the same IAS SSO + principal
 * propagation. Example:
 *
 *   /mcp/*   → <destination>/sap/zmcp2/ZMCPX      (MCP, peek on)
 *   /odata/* → <destination>/sap/opu/odata/IWBEP  (OData, streamed)
 *
 * The '*' path is a catch-all so any sub-path (/mcp/ALL, /odata/MY_SRV, …) is
 * forwarded — whatever follows the mount point is appended to that route's
 * backendPath. By default every HTTP verb is accepted (router.all, which also
 * covers OData's MERGE); set a route's `methods` allowlist to restrict it (e.g.
 * keep /mcp to the MCP Streamable HTTP set: POST/GET/DELETE).
 */
module.exports = function mountMcpRouter(app) {
  const routes = resolveRoutes()

  for (const route of routes) {
    const router = express.Router()
    router.use(authenticate)

    const handler = (req, res) => {
      req.mcpRoute = route
      return handleMcp(req, res)
    }

    if (route.methods) {
      for (const method of route.methods) {
        if (typeof router[method] === 'function') router[method]('*', handler)
        else LOG.warn('unsupported HTTP method in route allowlist — skipping', { path: route.path, method })
      }
    } else {
      router.all('*', handler)
    }

    app.use(route.path, router)

    LOG.info('mounted route', {
      path: route.path,
      destination: route.destination,
      backendPath: route.backendPath,
      peek: route.peek,
      methods: route.methods || 'all',
    })
  }
}
