const assert = require('node:assert/strict')
const test = require('node:test')
const cds = require('@sap/cds')
const { normalizeRoute, resolveRoutes, describeRoutes, getEndpoints } = require('../srv/lib/routes')

test('custom route inherits shared package configuration', () => {
  const route = normalizeRoute(
    { path: '/odata', peek: true },
    {
      destination: 'A4H-Trial',
      backendPath: '/',
      locationId: 'sydn-trial-0814',
      timeout: 120000,
    },
  )

  assert.deepEqual(route, {
    path: '/odata',
    destination: 'A4H-Trial',
    backendPath: '/',
    locationId: 'sydn-trial-0814',
    timeout: 120000,
    peek: true,
    methods: null,
  })
})

test('route can explicitly select the destination root and default SCC location', () => {
  const route = normalizeRoute(
    { path: '/odata', backendPath: '', locationId: '' },
    { backendPath: '/mcp', locationId: 'primary-scc' },
  )

  assert.equal(route.backendPath, '')
  assert.equal(route.locationId, '')
})

/** Run `fn` with a temporary `cds.env.mcp`, restoring the previous value after. */
function withMcpEnv(mcp, fn) {
  const previous = cds.env.mcp
  cds.env.mcp = mcp
  try {
    return fn()
  } finally {
    cds.env.mcp = previous
  }
}

test('grouped destinations flatten into a route table, each route binding its group', () => {
  const routes = withMcpEnv(
    {
      locationId: 'PM4-Sydney',
      timeout: 120000,
      destinations: [
        {
          name: 'pm4-bp-ssl',
          routes: [
            { path: '/mcp', backendPath: '/sap/zmcp2/ZMCPX', peek: true, methods: ['post', 'get', 'delete'] },
            { path: '/odata', backendPath: '/sap/opu/odata/IWBEP' },
          ],
        },
        {
          name: 'other-backend',
          locationId: 'PM4-Tokyo',
          routes: [{ path: '/api2', backendPath: '/sap/zsvc/ZOTHER' }],
        },
      ],
    },
    () => resolveRoutes(),
  )

  assert.equal(routes.length, 3)

  assert.deepEqual(routes[0], {
    path: '/mcp',
    destination: 'pm4-bp-ssl',
    backendPath: '/sap/zmcp2/ZMCPX',
    locationId: 'PM4-Sydney',
    timeout: 120000,
    peek: true,
    methods: ['post', 'get', 'delete'],
  })

  // Second route inherits its group's destination + shared SCC location.
  assert.equal(routes[1].destination, 'pm4-bp-ssl')
  assert.equal(routes[1].backendPath, '/sap/opu/odata/IWBEP')
  assert.equal(routes[1].locationId, 'PM4-Sydney')

  // A different destination group with its own location id.
  assert.equal(routes[2].destination, 'other-backend')
  assert.equal(routes[2].locationId, 'PM4-Tokyo')
})

test('a route may override the destination of its group', () => {
  const routes = withMcpEnv(
    {
      destinations: [
        {
          name: 'group-dest',
          routes: [{ path: '/special', destination: 'route-dest', backendPath: '/x' }],
        },
      ],
    },
    () => resolveRoutes(),
  )

  assert.equal(routes[0].destination, 'route-dest')
})

test('grouped destinations and top-level routes coexist', () => {
  const routes = withMcpEnv(
    {
      destination: 'flat-dest',
      destinations: [{ name: 'grouped-dest', routes: [{ path: '/grouped', backendPath: '/g' }] }],
      routes: [{ path: '/flat', backendPath: '/f' }],
    },
    () => resolveRoutes(),
  )

  const byPath = Object.fromEntries(routes.map((r) => [r.path, r]))
  assert.equal(byPath['/grouped'].destination, 'grouped-dest')
  assert.equal(byPath['/flat'].destination, 'flat-dest')
})

test('destinations supplied as a JSON string (env override) are parsed', () => {
  const routes = withMcpEnv(
    { destinations: JSON.stringify([{ name: 'env-dest', routes: [{ path: '/env', backendPath: '/e' }] }]) },
    () => resolveRoutes(),
  )

  assert.equal(routes.length, 1)
  assert.equal(routes[0].destination, 'env-dest')
  assert.equal(routes[0].path, '/env')
})

test('invalid destinations JSON falls back to the single-route default', () => {
  const routes = withMcpEnv({ destination: 'fallback-dest', backendPath: '/b', destinations: '{ not json' }, () =>
    resolveRoutes(),
  )

  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/mcp')
  assert.equal(routes[0].destination, 'fallback-dest')
})

test('duplicate paths are de-duplicated, grouped destinations winning', () => {
  const routes = withMcpEnv(
    {
      destinations: [{ name: 'grouped-dest', routes: [{ path: '/mcp', backendPath: '/g' }] }],
      routes: [{ path: '/mcp', destination: 'flat-dest', backendPath: '/f' }],
    },
    () => resolveRoutes(),
  )

  assert.equal(routes.length, 1)
  assert.equal(routes[0].destination, 'grouped-dest')
  assert.equal(routes[0].backendPath, '/g')
})

test('describeRoutes returns a non-sensitive view of the route table', () => {
  const config = withMcpEnv(
    {
      locationId: 'PM4-Sydney',
      destinations: [
        { name: 'pm4-bp-ssl', routes: [{ path: '/mcp', backendPath: '/sap/zmcp2/ZMCPX', peek: true }] },
      ],
    },
    () => describeRoutes(),
  )

  assert.deepEqual(config.routes, [
    {
      path: '/mcp',
      destination: 'pm4-bp-ssl',
      backendPath: '/sap/zmcp2/ZMCPX',
      locationId: 'PM4-Sydney',
      methods: 'all',
      peek: true,
    },
  ])
})

test('getEndpoints exposes /health and /config by default', () => {
  const endpoints = withMcpEnv({}, () => getEndpoints())
  assert.deepEqual(endpoints, { health: true, config: true })
})

test('getEndpoints honours boolean flags from package.json', () => {
  const endpoints = withMcpEnv({ exposeHealth: false, exposeConfig: false }, () => getEndpoints())
  assert.deepEqual(endpoints, { health: false, config: false })
})

test('getEndpoints coerces string flags from env overrides', () => {
  // CDS_MCP_EXPOSECONFIG=false arrives as the string "false".
  const endpoints = withMcpEnv({ exposeHealth: 'true', exposeConfig: 'false' }, () => getEndpoints())
  assert.deepEqual(endpoints, { health: true, config: false })

  // Other falsy spellings are also honoured; empty string falls back to default.
  assert.equal(withMcpEnv({ exposeConfig: 'off' }, () => getEndpoints()).config, false)
  assert.equal(withMcpEnv({ exposeConfig: '0' }, () => getEndpoints()).config, false)
  assert.equal(withMcpEnv({ exposeConfig: '' }, () => getEndpoints()).config, true)
})
