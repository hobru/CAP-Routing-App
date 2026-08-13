const cds = require('@sap/cds')
const express = require('express')
const { authenticate } = require('./lib/auth')
const { proxyToBackend } = require('./lib/proxy')

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
  // Buffer the (small) client message so we can record the JSON-RPC method for
  // troubleshooting, then hand the buffered body to the proxy. Responses are
  // never buffered — they stream straight through (SSE-safe).
  if (req.method === 'POST') {
    const { body } = await bufferBody(req)
    req.rawBody = body
    try {
      const json = JSON.parse(body.toString('utf8'))
      req.parsedMcpMethod = Array.isArray(json) ? json.map((m) => m.method).join(',') : json.method
    } catch {
      /* not JSON (or too large) — leave method undefined */
    }
  }
  return proxyToBackend(req, res)
}

/**
 * Mount the MCP router on the bootstrapped Express app.
 * All /mcp traffic is authenticated and then reverse-proxied to the on-prem
 * ABAP MCP server via the BTP destination + Cloud Connector.
 */
module.exports = function mountMcpRouter(app) {
  const router = express.Router()

  router.use(authenticate)

  // MCP Streamable HTTP: POST = client→server messages, GET = server→client
  // SSE stream, DELETE = explicit session termination.
  //
  // The '*' path is a catch-all so that not only the base mount (/mcp) but any
  // sub-path (/mcp/ALL, /mcp/finance, …) is forwarded. Whatever follows /mcp is
  // appended to the configured backendPath, e.g. /mcp/finance →
  // <backendPath>/finance on the ABAP server.
  router.post('*', handleMcp)
  router.get('*', handleMcp)
  router.delete('*', handleMcp)

  app.use('/mcp', router)

  LOG.info('mounted /mcp router')
}
