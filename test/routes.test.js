const assert = require('node:assert/strict')
const test = require('node:test')
const { normalizeRoute } = require('../srv/lib/routes')

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
