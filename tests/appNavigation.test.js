import test from 'node:test'
import assert from 'node:assert/strict'
import { appRouteUrl, nextAppRoute, readAppRoute } from '../src/utils/appNavigation.js'
import { clearRecoveryUrl, readRecoveryRequest } from '../src/services/passwordRecovery.js'

test('legacy Kakao alert links resolve to the independent page and preserve history anchor', () => {
  for (const search of ['?agent=alerts', '?page=agent&agent=alerts']) {
    const href = `https://atlas.example/${search}#alert-history`
    const route = readAppRoute(href)
    assert.equal(route.page, 'alerts')
    assert.equal(route.agentMode, 'analysis')
    const canonical = appRouteUrl(href, route)
    assert.equal(canonical, '/?page=alerts#alert-history')
    assert.deepEqual(readAppRoute(canonical), route)
  }
})

test('navigation clears obsolete alert mode and anchor while retaining unrelated auth parameters', () => {
  const href = 'https://atlas.example/?agent=alerts&code=auth-return&type=recovery#alert-history'
  const route = nextAppRoute(readAppRoute(href), 'agent', 'trading')
  const url = appRouteUrl(href, route)
  assert.equal(url, '/?agent=trading&code=auth-return&type=recovery&page=agent')
  assert.deepEqual(readAppRoute(url), route)
  assert.equal(new URL(appRouteUrl(url, nextAppRoute(route, 'alerts')), 'https://atlas.example').searchParams.has('agent'), false)
})

test('direct page reloads and history routes keep valid page and agent selection without permitting obsolete modes', () => {
  for (const page of ['dashboard','order','lab','screen','alerts','agent','assets','news','company','admin']) {
    const route = nextAppRoute({ agentMode: 'trading' }, page)
    const parsed = readAppRoute(appRouteUrl('https://atlas.example/', route), route.agentMode)
    assert.deepEqual(parsed, route)
  }
  assert.equal(readAppRoute('/?page=unknown&agent=unknown').page, 'dashboard')
  assert.equal(readAppRoute('/?page=agent&agent=unknown').agentMode, 'analysis')
  assert.equal(nextAppRoute({ agentMode: 'analysis' }, 'agent', 'alerts').agentMode, 'analysis')
})

test('initial route canonicalization preserves recovery data until the existing recovery flow clears it', () => {
  const href = 'https://atlas.example/?auth=reset-password&code=fixture-code#type=recovery&access_token=fixture-token'
  const url = appRouteUrl(href, readAppRoute(href))
  assert.equal(readRecoveryRequest(new URL(url, href).href).requested, true)
  assert.equal(new URL(url, href).hash, new URL(href).hash)
  assert.equal(new URL(url, href).searchParams.get('code'), 'fixture-code')
  assert.equal(clearRecoveryUrl(new URL(url, href).href), '/?page=dashboard')
})
