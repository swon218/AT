import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import { createCompanyDart, registerCompanyDartRoutes } from './companyDart.js'
import { createDartClient, dartXmlFromZip } from './dartClient.js'
import { dateInKorea, financialPeriod, normalizeFiling, selectReports } from './dartData.js'
import { createDartStore } from './dartStore.js'
import { dartFixtureDatabase, fixtureOptions, fixtureTransport, migration, primary, receipt, zipEntry } from '../tests/support/companyDartFixture.js'

test('SQL is repeatable, denies browser roles, serializes leases and budgets, and rejects obsolete workers', async t => {
  const { db, store } = await dartFixtureDatabase()
  t.after(() => db.close())
  await db.exec(migration)
  const key = 'overview:00126380'
  const job = { key, corp_code: primary.corp_code, kind: 'overview', args: {}, lease: randomUUID() }
  const other = { ...job, lease: randomUUID() }
  const claims = await Promise.all([store.work('claim', job), store.work('claim', other)])
  assert.equal(claims.filter(Boolean).length, 1)
  const winner = claims[0] ? job : other
  await db.query("update public.atlas_dart_jobs set lease_until = now() - interval '1 second' where key=$1", [key])
  const next = { ...job, lease: randomUUID() }
  assert.equal(await store.work('claim', next), true)
  assert.equal(await store.work('finish', { key, lease: winner.lease, data: { invalid: true }, ttl: 1 }), false)
  assert.equal(await store.work('finish', { key, lease: next.lease, data: { valid: true }, ttl: 30 }), true)
  await db.exec(migration)
  assert.deepEqual((await store.job(key)).data, { valid: true })
  assert.deepEqual(await Promise.all([store.work('budget', { limit: 2 }), store.work('budget', { limit: 2 }),
    store.work('budget', { limit: 2 })]), [true, true, false])
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query('select * from public.atlas_dart_jobs'), /permission denied/)
    await assert.rejects(db.query('delete from public.atlas_dart_accounts'), /permission denied/)
    await assert.rejects(db.query("select public.atlas_dart_work('budget','{}')"), /permission denied/)
    await db.exec('reset role')
  }
  await db.exec('set role service_role')
  await db.query('select * from public.atlas_dart_jobs')
  await assert.rejects(db.query('delete from public.atlas_dart_accounts'), /permission denied/)
  assert.equal(await store.work('budget', { limit: 4 }), true)
  await db.exec('reset role')
})

test('collection persists through service recreation, isolates scopes, and refreshes amended periods without destroying good data', async t => {
  const { db, store } = await dartFixtureDatabase()
  t.after(() => db.close())
  const { transport, controls } = fixtureTransport()
  const service = createCompanyDart({ store, transport, key: 'fixture', options: fixtureOptions })
  await assert.rejects(service.read(primary.symbol, {}), { code: 'dart_catalog_not_ready' })
  await service.syncCodes()
  assert.equal((await service.read('099999', {})).status, 'unsupported')
  const params = { section: 'overview' }
  const first = await Promise.all([service.read(primary.symbol, params), service.read(primary.symbol, params)])
  assert.ok(first.every(result => result.status === 'loading'))
  await service.drain()
  const ready = await service.read(primary.symbol, params)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.data.latest.values.sales, '9007199254740993')
  assert.equal(ready.data.latest.values.operating, '0')
  assert.equal(ready.data.latest.values.operatingGrowth, null)
  assert.equal(ready.data.latest.values.roe, 12.5)
  assert.equal(ready.data.latest.values.freeCash, '60000')
  assert.equal(ready.data.auditor[0].opinion, '적정')
  assert.equal(controls.calls.filter(call => call.name === 'fnlttSinglAcntAll.json').length, 1)
  const restart = createCompanyDart({ store, transport: async () => { throw new Error('unexpected network access') }, key: '' })
  assert.deepEqual((await restart.read(primary.symbol, params)).data, ready.data)
  const financial = { section: 'financials', scope: 'CFS' }
  await service.read(primary.symbol, financial)
  await service.drain()
  const consolidated = (await service.read(primary.symbol, financial)).data
  assert.equal(consolidated.annual.length, 5)
  assert.equal(consolidated.quarterly.length, 8)
  assert.equal(consolidated.quarterly[0].quarter, 4)
  assert.equal(consolidated.quarterly[0].values.sales, null)
  assert.equal(consolidated.quarterly[0].values.assets, '1000000')
  await service.read(primary.symbol, { ...financial, scope: 'OFS' })
  await service.drain()
  assert.equal((await service.read(primary.symbol, { ...financial, scope: 'OFS' })).data.annual[0].values.sales, '450000')
  assert.equal((await service.read(primary.symbol, financial)).data.annual[0].values.sales, '9007199254740993')
  controls.corrected = true
  const overviewKey = `overview:${primary.corp_code}`
  const expire = () => db.query("update public.atlas_dart_jobs set expires_at=now()-interval '1 second' where key=$1", [overviewKey])
  await expire()
  const stale = await service.read(primary.symbol, params)
  assert.equal(stale.status, 'stale')
  assert.equal(stale.data.latest.receipt, receipt(2025))
  await service.drain()
  const amended = await service.read(primary.symbol, params)
  assert.equal(amended.data.latest.receipt, receipt(2025, 4, true))
  assert.equal(amended.data.latest.values.sales, '900000')
  assert.equal((await service.read(primary.symbol, financial)).status, 'stale')
  await service.drain()
  const rows = (await db.query("select receipt from public.atlas_dart_filings where series='사업보고서:2025-12-31'")).rows
  assert.equal(rows.length, 2)
  controls.error = '020'
  await expire()
  await service.read(primary.symbol, params)
  await service.drain()
  const afterFailure = await service.read(primary.symbol, params)
  assert.equal(afterFailure.status, 'stale')
  assert.equal(afterFailure.error, 'dart_rate_limit')
  assert.deepEqual(afterFailure.data, amended.data)
  assert.ok(afterFailure.retryAt)
})

test('public routes validate periods, retain page bounds, and distinguish unsupported, setup and provider errors', async t => {
  const { db, store } = await dartFixtureDatabase()
  const { transport, controls } = fixtureTransport()
  const service = createCompanyDart({ store, transport, key: 'fixture', options: fixtureOptions })
  const app = Fastify()
  registerCompanyDartRoutes(app, { service })
  t.after(async () => { await app.close(); await db.close() })
  const route = `/api/public/company/${primary.symbol}`
  assert.equal((await app.inject(`${route}?section=disclosures&start=2026-02-30`)).statusCode, 400)
  assert.equal((await app.inject(`${route}?section=disclosures&page=101`)).statusCode, 400)
  assert.equal((await app.inject(route)).json().error, 'dart_catalog_not_ready')
  await service.syncCodes()
  const url = `${route}?section=disclosures&type=treasury&start=${dateInKorea(-10)}&end=${dateInKorea()}`
  assert.equal((await app.inject(url)).statusCode, 202)
  await service.drain()
  const first = (await app.inject(url)).json()
  assert.equal(first.data.total, 31)
  assert.equal(first.data.items.length, 0)
  assert.equal(first.data.hasNext, true)
  const secondUrl = url + '&page=2'
  assert.equal((await app.inject(secondUrl)).statusCode, 202)
  await service.drain()
  const second = (await app.inject(secondUrl)).json()
  assert.equal(second.data.hasNext, false)
  assert.match(second.data.items[0].url, /^https:\/\/dart\.fss\.or\.kr\//)
  await app.inject(`${route}?section=business`)
  await service.drain()
  const business = (await app.inject(`${route}?section=business`)).json().data
  assert.equal(business.parserVersion, 1)
  assert.match(business.sections.products.excerpt, /검증 전용/)
  await app.inject(`${route}?section=shareholders`)
  await service.drain()
  const shares = (await app.inject(`${route}?section=shareholders`)).json().data
  assert.equal(shares.dividends[0].amount, '0')
  assert.equal(shares.holders[0].shareClass, '보통주')
  controls.error = '012'
  await app.inject(`${route}?section=outlook`)
  await service.drain()
  assert.equal((await app.inject(`${route}?section=outlook`)).json().error, 'dart_ip_restricted')
  assert.equal((await app.inject('/api/public/company/099999')).json().status, 'unsupported')
  const unconfigured = Fastify()
  registerCompanyDartRoutes(unconfigured, { service: { requestsPerMinute: 5, read: () => service.read(primary.symbol, {}) } })
  t.after(() => unconfigured.close())
  for (let i = 0; i < 5; i++) await unconfigured.inject(route)
  assert.equal((await unconfigured.inject(route)).statusCode, 429)
})

test('provider statuses and transport failures cannot expose the credential or turn into empty success', async () => {
  for (const [status, code] of [['010', 'dart_key_invalid'], ['012', 'dart_ip_restricted'], ['020', 'dart_rate_limit'], ['800', 'dart_unavailable']]) {
    const client = createDartClient({ key: 'fixture-secret', reserve: async () => true,
      transport: async () => Response.json({ status, message: 'fixture-secret' }) })
    await assert.rejects(client('company.json', {}), { message: code })
  }
  const empty = createDartClient({ key: 'fixture-secret', reserve: async () => true, transport: async () => Response.json({ status: '013' }) })
  assert.equal(await empty('company.json', {}), null)
  const client = createDartClient({ key: 'fixture-secret', reserve: async () => true,
    transport: async url => { throw new Error(url.href) } })
  await assert.rejects(client('company.json', {}), { message: 'dart_unavailable' })
  const xml = zipEntry('a.xml', '<!DOCTYPE d [<!ENTITY x SYSTEM "https://invalid.example">]><d>&x;</d>')
  assert.throws(() => dartXmlFromZip(xml, () => true), { code: 'dart_invalid_archive' })
  assert.throws(() => dartXmlFromZip(zipEntry('a.xml', 'large'), () => true, 2), { code: 'dart_invalid_archive' })
})

test('Supabase missing schema and permission errors remain distinct from missing data', async t => {
  let error = 'PGRST205'
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: error, message: 'provider details' }, { status: 400 }))
  const store = createDartStore({ supabaseUrl: 'https://fixture.invalid', supabaseSecretKey: 'fixture-only' })
  await assert.rejects(store.symbol('005930'), { code: 'dart_schema_missing' })
  error = '42501'
  await assert.rejects(store.symbol('005930'), { code: 'dart_database_permission' })
})

test('verified cumulative amounts subtract exactly without subtracting balance sheet stocks', () => {
  const annual = normalizeFiling({ corp_code: primary.corp_code, rcept_no: receipt(2025), rcept_dt: '20260315',
    report_nm: '사업보고서 (2025.12)' }, primary.corp_code)
  const q3 = normalizeFiling({ corp_code: primary.corp_code, rcept_no: receipt(2025, 3), rcept_dt: '20251114',
    report_nm: '분기보고서 (2025.09)' }, primary.corp_code)
  const [a, q] = selectReports([annual, q3], 12)
  const row = (metric, amount, accumulated) => ({ metric, account_id: metric, currency: 'KRW', amount, accumulated })
  const current = { ...a, scope: 'CFS', accountingBasis: 'verified-fixture',
    accounts: [row('sales', '9007199254740993.10'), row('assets', '200')] }
  const previous = { ...q, scope: 'CFS', accountingBasis: 'verified-fixture',
    accounts: [row('sales', '2', '9007199254740990.00'), row('assets', '100')] }
  const period = financialPeriod(current, previous, false)
  assert.equal(period.values.sales, '3.10')
  assert.equal(period.values.assets, '200')
  assert.equal(financialPeriod(current, { ...previous, corrected: true }, false).values.sales, null)
  assert.equal(financialPeriod(current, { ...previous, scope: 'OFS' }, false).values.sales, null)
})
