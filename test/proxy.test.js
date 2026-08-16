const assert = require('node:assert/strict')
const test = require('node:test')
const { buildTargetUrl } = require('../srv/lib/proxy')

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
