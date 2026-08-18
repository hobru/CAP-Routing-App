const assert = require('node:assert/strict')
const test = require('node:test')
const { buildTargetUrl, resolveLocationId } = require('../srv/lib/proxy')

test('joins a root backend path without producing a double slash', () => {
  const target = buildTargetUrl(
    'http://a4h:50001',
    '/',
    '/sap/opu/odata/IWBEP/GWSAMPLE_BASIC/SalesOrderSet?$top=5',
  )

  assert.equal(
    target.toString(),
    'http://a4h:50001/sap/opu/odata/IWBEP/GWSAMPLE_BASIC/SalesOrderSet?$top=5',
  )
})

test('joins backend and request paths with one separator', () => {
  const target = buildTargetUrl('https://backend.example/', '/sap/opu/odata/', '/MY_SERVICE/$metadata')

  assert.equal(target.toString(), 'https://backend.example/sap/opu/odata/MY_SERVICE/$metadata')
})

// Regression: a route that explicitly opts out of an SCC location id (empty
// string) must NOT inherit the global cds.mcp default. Previously `route.locationId
// || mcp.locationId` treated "" as falsy and sent the wrong tunnel id.
test('an explicit empty route locationId is honoured, not overridden by the global default', () => {
  const saved = process.env.CDS_MCP_LOCATIONID
  delete process.env.CDS_MCP_LOCATIONID
  try {
    const loc = resolveLocationId(
      { path: '/npl/odata', destination: 'npl-ssl', locationId: '' },
      { locationId: 'PM4-Sydney' },
      { cloudConnectorLocationId: 'PM4-Sydney' },
    )
    assert.equal(loc, '')
  } finally {
    if (saved != null) process.env.CDS_MCP_LOCATIONID = saved
  }
})

test('a named route locationId wins over everything else', () => {
  const loc = resolveLocationId(
    { path: '/mcp', locationId: 'PM4-Tokyo' },
    { locationId: 'PM4-Sydney' },
    { cloudConnectorLocationId: 'PM4-Osaka' },
  )
  assert.equal(loc, 'PM4-Tokyo')
})

test('a route without a locationId falls back to the top-level cds.mcp default', () => {
  const saved = process.env.CDS_MCP_LOCATIONID
  delete process.env.CDS_MCP_LOCATIONID
  try {
    const loc = resolveLocationId({ path: '/mcp' }, { locationId: 'PM4-Sydney' }, {})
    assert.equal(loc, 'PM4-Sydney')
  } finally {
    if (saved != null) process.env.CDS_MCP_LOCATIONID = saved
  }
})

test('with nothing configured, the destination cloud-connector location is used', () => {
  const saved = process.env.CDS_MCP_LOCATIONID
  delete process.env.CDS_MCP_LOCATIONID
  try {
    const loc = resolveLocationId({ path: '/mcp' }, {}, { cloudConnectorLocationId: 'PM4-Sydney' })
    assert.equal(loc, 'PM4-Sydney')
  } finally {
    if (saved != null) process.env.CDS_MCP_LOCATIONID = saved
  }
})
