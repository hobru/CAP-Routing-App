const cds = require('@sap/cds')
const http = require('node:http')
const https = require('node:https')
const { getDestination } = require('@sap-cloud-sdk/connectivity')

const LOG = cds.log('mcp')

// Hop-by-hop headers must not be forwarded (RFC 7230 §6.1).
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

// Request headers we deliberately do NOT forward to the backend.
// The user's IAS bearer is replaced by principal propagation (the Cloud
// Connector mints a per-user X.509), so we strip Authorization.
const DROP_REQUEST_HEADERS = new Set([
  'authorization',
  'host',
  'content-length',
  'connection',
  'x-dev-email',
])

/**
 * Normalise the Cloud SDK proxy headers into a plain object.
 * Newer @sap-cloud-sdk/connectivity returns `headers` as a plain object
 * (Record<string, string>); older versions returned an array of {key, value}.
 * Handle both so principal-propagation / proxy-auth headers are forwarded.
 */
function proxyHeaders(proxyConfiguration) {
  const h = proxyConfiguration?.headers
  if (!h) return {}
  if (Array.isArray(h)) {
    const out = {}
    for (const item of h) out[item.key] = item.value
    return out
  }
  return { ...h }
}

function filterRequestHeaders(reqHeaders) {
  const out = {}
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (DROP_REQUEST_HEADERS.has(k.toLowerCase())) continue
    out[k] = v
  }
  return out
}

/**
 * Resolve the OnPremise destination (with the user JWT for principal
 * propagation) and stream the MCP request through the connectivity proxy to the
 * on-prem ABAP MCP server, piping the response (including SSE) straight back.
 */
async function proxyToBackend(req, res) {
  const started = Date.now()
  const { destination: destinationName, backendPath, timeout } = cds.env.mcp || {}
  const cid = req.correlationId
  const mcpMethod = req.parsedMcpMethod // set by the router when a body is buffered (optional)

  let destination
  try {
    destination = await getDestination({ destinationName, jwt: req.jwt })
    if (!destination) throw new Error(`Destination '${destinationName}' not found`)
  } catch (err) {
    LOG.error('destination resolution failed', {
      correlationId: cid,
      destination: destinationName,
      error: err.message,
    })
    return sendError(res, 502, 'destination_error', err.message)
  }

  // Build the absolute backend target URL. Anything after the /mcp mount point
  // is appended, and the destination's sap-client is added as a query param.
  const subPath = req.url && req.url !== '/' ? req.url : ''
  const base = destination.url.replace(/\/$/, '')
  const target = new URL(base + (backendPath || '') + subPath)
  const sapClient = destination.sapClient || destination.originalProperties?.['sap-client']
  if (sapClient && !target.searchParams.has('sap-client')) {
    target.searchParams.set('sap-client', sapClient)
  }

  const isOnPremise = destination.proxyType === 'OnPremise'
  const proxy = destination.proxyConfiguration
  if (isOnPremise && !proxy) {
    return sendError(res, 502, 'connectivity_error', 'OnPremise destination without connectivity proxy — is the connectivity service bound?')
  }

  const headers = {
    ...filterRequestHeaders(req.headers),
    host: target.host,
    'x-correlation-id': cid,
    ...(isOnPremise ? proxyHeaders(proxy) : {}),
  }

  // SCC tunnel selection: the connectivity proxy must be told the Cloud
  // Connector Location ID, otherwise it looks for an SCC registered under the
  // default (empty) location and fails when the real SCC uses a named location.
  // Prefer an explicit BTP-configured value; fall back to whatever the SDK
  // resolved from the destination.
  const locationId =
    (cds.env.mcp && cds.env.mcp.locationId) ||
    process.env.CDS_MCP_LOCATIONID ||
    destination.cloudConnectorLocationId ||
    destination.originalProperties?.CloudConnectorLocationId ||
    destination.originalProperties?.['CloudConnectorLocationId']
  const LOC_HEADER = 'SAP-Connectivity-SCC-Location_ID'
  const hasLoc = Object.keys(headers).some((k) => k.toLowerCase() === LOC_HEADER.toLowerCase())
  if (isOnPremise && locationId && !hasLoc) headers[LOC_HEADER] = locationId
  if (isOnPremise && !locationId) {
    LOG.warn('no SCC location id resolved — connectivity proxy may not match a tunnel', {
      correlationId: cid,
      destination: destinationName,
    })
  }

  // When the router buffered the body (to log the MCP method), send it with an
  // accurate Content-Length instead of streaming.
  if (Buffer.isBuffer(req.rawBody)) {
    headers['content-length'] = Buffer.byteLength(req.rawBody)
  }

  // For an OnPremise destination we talk to the connectivity proxy in
  // forward-proxy mode (absolute request URI). For an internet destination we
  // connect directly to the target host.
  const useProxy = isOnPremise && proxy
  const agentModule = (useProxy ? proxy.protocol : target.protocol) === 'https:' ? https : http
  const options = useProxy
    ? { host: proxy.host, port: proxy.port, method: req.method, path: target.toString(), headers }
    : {
        host: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: target.pathname + target.search,
        headers,
      }

  LOG.info('mcp request → backend', {
    correlationId: cid,
    method: req.method,
    mcpMethod,
    user: req.principal?.email,
    destination: destinationName,
    proxyType: destination.proxyType,
    target: `${target.origin}${target.pathname}`,
    locationId: headers[LOC_HEADER],
    sessionId: req.headers['mcp-session-id'],
  })

  const upstream = agentModule.request(options, (backendRes) => {
    const outHeaders = {}
    for (const [k, v] of Object.entries(backendRes.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v
    }
    res.writeHead(backendRes.statusCode || 502, outHeaders)
    if (typeof res.flushHeaders === 'function') res.flushHeaders() // start SSE immediately

    backendRes.on('end', () => {
      LOG.info('mcp response ← backend', {
        correlationId: cid,
        status: backendRes.statusCode,
        contentType: backendRes.headers['content-type'],
        durationMs: Date.now() - started,
        user: req.principal?.email,
      })
    })
    backendRes.pipe(res)
  })

  // SSE streams are long-lived: only apply the timeout to non-streaming calls.
  const wantsStream = /text\/event-stream/i.test(req.headers['accept'] || '')
  if (!wantsStream && timeout) upstream.setTimeout(timeout, () => upstream.destroy(new Error('backend timeout')))

  upstream.on('error', (err) => {
    LOG.error('backend request error', {
      correlationId: cid,
      error: err.message,
      durationMs: Date.now() - started,
    })
    if (!res.headersSent) sendError(res, 502, 'backend_error', err.message)
    else res.end()
  })

  // Tear down the upstream connection if the client goes away.
  res.on('close', () => upstream.destroy())

  if (Buffer.isBuffer(req.rawBody)) upstream.end(req.rawBody)
  else req.pipe(upstream)
}

function sendError(res, status, error, detail) {
  res.status(status)
  res.json({ error, detail })
}

module.exports = { proxyToBackend }
