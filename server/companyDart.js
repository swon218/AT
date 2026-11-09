import { randomUUID } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { config } from './config.js'
import { createDartClient, DartError, readDartSymbols } from './dartClient.js'
import { createDartStore } from './dartStore.js'
import {
  businessParserVersion, clean, dateInKorea, decimal, extractBusiness, financialPeriod, normalizeAccounts,
  normalizeFiling, officialLink, providerDate, receiptNumber, selectReports, validDay,
} from './dartData.js'

const day = 86400
const codesJob = { key: 'codes', kind: 'codes', args: {} }
const sections = new Set(['overview', 'financials', 'business', 'shareholders', 'disclosures', 'outlook'])
const filingFilters = new Set(['all', 'periodic', 'results', 'finance', 'ownership', 'treasury', 'other'])
const settings = (env = process.env) => {
  const limit = (name, fallback, low, high) => {
    const n = Number(env[name])
    return Number.isInteger(n) && n >= low && n <= high ? n : fallback
  }
  return {
    budget: limit('DART_DAILY_LIMIT', 500, 1, 10000),
    requests: limit('DART_PUBLIC_PER_MINUTE', 90, 5, 600),
    profileTtl: limit('DART_PROFILE_TTL_SECONDS', day, 60, day * 7),
    filingsTtl: limit('DART_DISCLOSURE_TTL_SECONDS', 900, 60, day),
    historyTtl: limit('DART_HISTORY_TTL_SECONDS', day * 7, 300, day * 30),
    reportTtl: limit('DART_REPORT_TTL_SECONDS', day, 60, day * 7),
  }
}

function responseList(payload) {
  if (!payload) return []
  if (!Array.isArray(payload.list) || !payload.list.length) throw new DartError('dart_invalid_response')
  return payload.list
}

const dayParam = date => date.replaceAll('-', '')
const official = filing => ({
  receipt: filing.receipt, filedOn: filing.filed_on, title: filing.title, type: filing.type, corrected: filing.corrected,
  periodEnd: filing.periodEnd, series: filing.series, url: officialLink(filing.receipt),
})

function parseRequest(query, now) {
  const section = query.section || 'overview'
  const scope = query.scope || 'CFS'
  if (!sections.has(section) || !['CFS', 'OFS'].includes(scope)) throw new DartError('dart_invalid_query')
  if (section !== 'disclosures') return { section, ...(section === 'financials' ? { scope } : {}) }
  const start = query.start ?? dateInKorea(-30, now)
  const end = query.end ?? dateInKorea(0, now)
  const page = Number(query.page ?? 1)
  const type = query.type ?? 'all'
  if (!validDay(start) || !validDay(end) || start > end || end > dateInKorea(0, now) ||
    start < '1999-01-01' || (Date.parse(end) - Date.parse(start)) / 86_400_000 > 365 ||
    !Number.isInteger(page) || page < 1 || page > 100 || !filingFilters.has(type)) throw new DartError('dart_invalid_query')
  return { section, start, end, page, type }
}

function keyFor(corp, args) {
  return [args.section, corp, args.scope, args.start, args.end, args.page].filter(Boolean).join(':')
}

export function createCompanyDart({ store, transport, now = Date.now, options = settings(), key }) {
  const dart = createDartClient({ key, transport, reserve: () => store.work('budget', { limit: options.budget }) })
  const pending = new Map()
  const ttl = job => {
    if (job.kind === 'disclosures') return job.args.end < dateInKorea(-7, now()) ? options.historyTtl : options.filingsTtl
    if (job.kind === 'overview' || job.kind === 'codes') return options.profileTtl
    if (job.kind === 'outlook') return options.filingsTtl
    return options.reportTtl
  }
  const fresh = row => Date.parse(row?.expires_at) > now()
  const leased = row => Date.parse(row?.lease_until) > now()
  const cooling = row => Date.parse(row?.retry_at) > now()

  function start(job, collect, signal = AbortSignal.timeout(140_000)) {
    if (pending.has(job.key)) return pending.get(job.key)
    const promise = (async () => {
      const lease = randomUUID()
      if (!await store.work('claim', { ...job, lease })) return false
      try {
        const result = await collect(signal)
        signal.throwIfAborted()
        if (!await store.work('finish', { ...result, key: job.key, lease, ttl: result.ttl ?? ttl(job) })) {
          throw new DartError('dart_lease_expired')
        }
      } catch (error) {
        const code = error instanceof DartError ? error.code : signal.aborted ? 'dart_timeout' : 'dart_collection_error'
        await store.work('fail', { key: job.key, lease, error: code, delay: code === 'dart_rate_limit' ? 900 : 60 })
        throw new DartError(code)
      }
      return true
    })()
    pending.set(job.key, promise)
    void promise.finally(() => pending.delete(job.key)).catch(() => {})
    return promise
  }

  async function list(corp, filters, signal) {
    const payload = await dart('list.json', { corp_code: corp, sort: 'date', sort_mth: 'desc', ...filters }, signal)
    const items = [...new Map(responseList(payload).map(item => {
      const filing = normalizeFiling(item, corp)
      return [filing.receipt, filing]
    })).values()]
    if (items.some(item => dayParam(item.filed_on) < filters.bgn_de || dayParam(item.filed_on) > filters.end_de)) {
      throw new DartError('dart_invalid_response')
    }
    if (payload && (!Number.isInteger(Number(payload.total_page)) || Number(payload.total_page) < 1 ||
      !Number.isInteger(Number(payload.total_count)) || Number(payload.total_count) < items.length)) throw new DartError('dart_invalid_response')
    return { items, pages: Number(payload?.total_page || 0), total: Number(payload?.total_count || 0) }
  }

  async function reportList(corp, fiscalMonth, signal) {
    if (!fiscalMonth) return { filings: [], reports: [] }
    const filters = { bgn_de: dayParam(dateInKorea(-6 * 366, now())), end_de: dayParam(dateInKorea(0, now())),
      pblntf_ty: 'A', last_reprt_at: 'N', page_count: 100 }
    const first = await list(corp, { ...filters, page_no: 1 }, signal)
    if (first.pages > 3) throw new DartError('dart_report_range_limit')
    const filings = [...first.items]
    for (let page = 2; page <= first.pages; page++) filings.push(...(await list(corp, { ...filters, page_no: page }, signal)).items)
    return { filings, reports: selectReports(filings, fiscalMonth) }
  }

  async function profile(corp, signal) {
    const data = await dart('company.json', { corp_code: corp }, signal)
    if (!data) return null
    if ((data.corp_code && data.corp_code !== corp) || !clean(data.corp_name)) throw new DartError('dart_invalid_response')
    const fiscalMonth = Number(data.acc_mt)
    return {
      name: clean(data.corp_name), englishName: clean(data.corp_name_eng), ceo: clean(data.ceo_nm),
      market: { Y: '코스피', K: '코스닥', N: '코넥스' }[data.corp_cls] ?? null,
      established: providerDate(data.est_dt), industryCode: clean(data.induty_code),
      fiscalMonth: Number.isInteger(fiscalMonth) && fiscalMonth >= 1 && fiscalMonth <= 12 ? fiscalMonth : null,
    }
  }

  async function getReport(corp, report, scope, signal) {
    const job = { key: `report:${corp}:${scope}:${report.receipt}`, corp_code: corp, kind: 'report', args: { scope, report } }
    let saved = await store.job(job.key)
    if (!fresh(saved)) {
      await start(job, async () => {
        const payload = await dart('fnlttSinglAcntAll.json', {
          corp_code: corp, bsns_year: report.fiscalYear, reprt_code: report.reportCode, fs_div: scope,
        }, signal)
        const accounts = normalizeAccounts(payload, report, corp, scope)
        return { accounts, filings: [report], data: { receipt: report.receipt, available: accounts.length > 0 },
          ttl: accounts.length ? 365 * day : options.reportTtl }
      }, signal)
      saved = await store.job(job.key)
      for (let attempt = 0; !saved?.checked_at && leased(saved) && attempt < 8; attempt++) {
        await wait(2000, undefined, { signal })
        saved = await store.job(job.key)
      }
    }
    if (!saved?.checked_at) throw new DartError(leased(saved) ? 'dart_dependency_busy' : saved?.error_code || 'dart_dependency_busy')
    const accounts = saved.data?.available ? await store.accounts(job.key) : []
    return { ...report, scope, collectedAt: saved.checked_at, accounts }
  }

  async function collectFinancials(corp, reports, scope, industryCode, signal, latestOnly) {
    const annual = reports.filter(report => report.quarter === 4).slice(0, latestOnly ? 1 : 5)
    const quarterly = latestOnly ? [] : reports.slice(0, 8)
    const loaded = new Map()
    for (const report of new Map([...annual, ...quarterly].map(report => [report.receipt, report])).values()) {
      loaded.set(report.receipt, await getReport(corp, report, scope, signal))
    }
    // The provider supplies same-period comparison in the same receipt for income.
    // Q4 and quarterly cash flows requiring cross-report subtraction remain blank without accounting-basis evidence.
    const financialIndustry = !industryCode || /^(?:K|0*6[456])/i.test(industryCode)
    const shape = (rows, isAnnual) => rows.map(report => financialPeriod(loaded.get(report.receipt), null, isAnnual, financialIndustry))
    return { annual: shape(annual, true), quarterly: shape(quarterly, false) }
  }

  async function collectShareholders(corp, reports, signal) {
    const annual = reports.filter(report => report.quarter === 4).slice(0, 5)
    const reportParams = report => ({ corp_code: corp, bsns_year: report.fiscalYear, reprt_code: report.reportCode })
    const latest = reports[0]
    const verified = (payload, report) => {
      const rows = responseList(payload)
      if (rows.some(item => item.corp_code !== corp || item.rcept_no !== report.receipt)) throw new DartError('dart_report_version')
      return rows
    }
    const holders = latest ? verified(await dart('hyslrSttus.json', reportParams(latest), signal), latest)
      .filter(row => clean(row.nm) && clean(row.relate))
      .map(row => ({ name: clean(row.nm), relation: clean(row.relate), shareClass: clean(row.stock_knd),
        beginning: decimal(row.bsis_posesn_stock_qota_rt), ending: decimal(row.trmend_posesn_stock_qota_rt),
        receipt: latest.receipt, periodEnd: latest.periodEnd })) : []
    const dividends = []
    for (const report of annual) {
      const rows = verified(await dart('alotMatter.json', reportParams(report), signal), report)
      for (const row of rows.filter(item => /^주당\s*현금배당금\s*\(원\)$/.test(item.se?.trim()))) {
        if (clean(row.stock_knd)) dividends.push({ year: report.fiscalYear, shareClass: clean(row.stock_knd),
          amount: decimal(row.thstrm), periodEnd: report.periodEnd, receipt: report.receipt,
          settlementOn: providerDate(row.stlm_dt) })
      }
    }
    const ownership = responseList(await dart('majorstock.json', { corp_code: corp }, signal))
      .filter(row => row.corp_code === corp && receiptNumber(row.rcept_no) && providerDate(row.rcept_dt))
      .sort((a, b) => b.rcept_no.localeCompare(a.rcept_no)).slice(0, 12)
      .map(row => ({ receipt: row.rcept_no, filedOn: providerDate(row.rcept_dt), name: clean(row.repror),
        ratio: decimal(row.stkrt), change: decimal(row.stkrt_irds), reason: clean(row.report_resn) }))
    return { holders, dividends, ownership }
  }

  async function collect(job, signal) {
    const corp = job.corp_code
    const { kind, args } = job
    if (kind === 'codes') {
      const bytes = await dart('corpCode.xml', {}, signal)
      if (!bytes) throw new DartError('dart_invalid_archive')
      const symbols = readDartSymbols(bytes)
      const before = (await store.job(job.key))?.data?.count || 0
      if (before && symbols.length < before * .8) throw new DartError('dart_catalog_incomplete')
      return { data: { count: symbols.length }, symbols }
    }
    if (kind === 'disclosures') {
      const page = await list(corp, { bgn_de: dayParam(args.start), end_de: dayParam(args.end), last_reprt_at: 'Y',
        page_no: args.page, page_count: 30 }, signal)
      return { filings: page.items, data: { items: page.items.map(official), pages: page.pages, total: page.total } }
    }
    const recent = ['overview', 'shareholders', 'outlook'].includes(kind)
      ? await list(corp, { bgn_de: dayParam(dateInKorea(kind === 'overview' ? -45 : -365, now())),
        end_de: dayParam(dateInKorea(0, now())), last_reprt_at: 'Y', page_count: 100 }, signal) : { items: [], pages: 0 }
    if (kind === 'outlook') {
      return { filings: recent.items, data: { coverage: recent.pages > 1 ? '최근 공시 첫 100건' : '최근 1년 공시',
        forecasts: recent.items.filter(item => /영업실적등에대한전망|영업실적등에관한전망/.test(item.title.replace(/\s/g, ''))).map(official),
        ir: recent.items.filter(item => /기업설명회\s*\(IR\)|기업설명회\s*개최/i.test(item.title)).map(official) } }
    }
    const company = await profile(corp, signal)
    const { filings, reports } = await reportList(corp, company?.fiscalMonth, signal)
    const allFilings = [...new Map([...recent.items, ...filings].map(item => [item.receipt, item])).values()]
    if (kind === 'financials' || kind === 'overview') {
      const scope = args.scope || 'CFS'
      const financials = await collectFinancials(corp, reports, scope, company?.industryCode, signal, kind === 'overview')
      if (kind === 'financials') return { filings: allFilings, data: financials }
      const latest = reports.find(report => report.quarter === 4)
      const opinions = latest ? responseList(await dart('accnutAdtorNmNdAdtOpinion.json', {
        corp_code: corp, bsns_year: latest.fiscalYear, reprt_code: latest.reportCode,
      }, signal)).filter(row => row.corp_code === corp && row.rcept_no === latest.receipt && clean(row.adt_opinion) &&
        (providerDate(row.stlm_dt) === latest.periodEnd || (!providerDate(row.stlm_dt) && /당기/.test(row.bsns_year))))
        .map(row => ({ name: clean(row.adtor), opinion: clean(row.adt_opinion), receipt: latest.receipt, periodEnd: latest.periodEnd })) : []
      const auditor = [...new Map(opinions.map(row => [JSON.stringify([row.name, row.opinion]), row])).values()]
      return { filings: allFilings, data: { company, latest: financials.annual[0] ?? null,
        recent: recent.items.slice(0, 8).map(official), auditor,
        risk: recent.items.filter(item => /소송.*제기|소송.*판결|유상증자.*결정|사채권.*발행.*결정/.test(item.title)).slice(0, 8).map(official),
        annualReport: latest ? official(latest) : null,
      } }
    }
    if (kind === 'business') {
      const report = reports.find(item => item.quarter === 4)
      if (!report) return { filings: allFilings, data: { report: null, sections: {}, parserVersion: businessParserVersion } }
      const bytes = await dart('document.xml', { rcept_no: report.receipt }, signal)
      const excerpts = bytes ? extractBusiness(bytes, report.receipt) : {}
      return { filings: allFilings, data: { report: official(report), sections: excerpts, parserVersion: businessParserVersion } }
    }
    const shares = await collectShareholders(corp, reports, signal)
    return { filings: allFilings, data: { ...shares, treasury: recent.items.filter(item => item.type === 'treasury').slice(0, 12).map(official) } }
  }

  async function read(symbol, query) {
    const args = parseRequest(query, now())
    const mapping = await store.symbol(symbol)
    if (!mapping) {
      const catalog = await store.job(codesJob.key)
      if (!catalog?.checked_at) throw new DartError(catalog?.error_code || 'dart_catalog_not_ready')
      return { status: 'unsupported' }
    }
    const corp = mapping.corp_code
    const job = { key: keyFor(corp, args), corp_code: corp, kind: args.section, args: { ...args, type: 'all' } }
    const row = await store.job(job.key)
    if (!fresh(row) && !leased(row) && !cooling(row)) {
      if (!key && !row?.checked_at) throw new DartError('dart_key_missing')
      if (key && pending.size < 12) void start(job, signal => collect(job, signal)).catch(() => {})
    }
    const details = { checkedAt: row?.checked_at ?? null, retryAt: row?.retry_at ?? null }
    if (row?.checked_at) {
      let data = row.data
      if (args.section === 'disclosures') {
        data = { ...data, items: data.items.filter(item => args.type === 'all' || item.type === args.type),
          page: args.page, hasNext: args.page < Math.min(100, data.pages), pageLimitReached: args.page === 100 && data.pages > 100 }
      }
      return { ...details, status: fresh(row) ? 'ready' : 'stale', data,
        refreshing: !fresh(row) && (leased(row) || pending.has(job.key)), error: row.error_code || (!key && !fresh(row) ? 'dart_key_missing' : null) }
    }
    if (cooling(row)) return { ...details, status: 'error', error: row.error_code }
    return { ...details, status: 'loading' }
  }

  return {
    read, requestsPerMinute: options.requests,
    async syncCodes() { return start(codesJob, signal => collect(codesJob, signal)) },
    async refresh(limit) {
      let refreshed = 0
      const errors = []
      for (const job of await store.due(limit)) {
        try { if (await start(job, signal => collect(job, signal))) refreshed++ }
        catch (error) {
          errors.push(error instanceof DartError ? error.code : 'dart_collection_error')
          if (errors.at(-1) === 'dart_rate_limit') break
        }
      }
      return { refreshed, errors }
    },
    async drain() { await Promise.allSettled(pending.values()) },
  }
}

export const configuredCompanyDart = () => createCompanyDart({ key: config.openDartKey, store: createDartStore(config) })

export function registerCompanyDartRoutes(app, { service = configuredCompanyDart(), now = Date.now } = {}) {
  const counts = new Map()
  let minute, total
  app.get('/api/public/company/:symbol', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const current = Math.floor(now() / 60_000)
    if (minute !== current) { minute = current; total = 0; counts.clear() }
    if (total >= service.requestsPerMinute * 5 || (counts.get(request.ip) || 0) >= service.requestsPerMinute) {
      return reply.code(429).header('Retry-After', '60').send({ status: 'error', error: 'dart_request_limit' })
    }
    total++
    counts.set(request.ip, (counts.get(request.ip) || 0) + 1)
    const symbol = request.params.symbol
    if (!/^[0-9][0-9A-Z]{5}$/.test(symbol)) return reply.code(400).send({ status: 'error', error: 'dart_invalid_query' })
    try {
      const result = await service.read(symbol, request.query)
      if (result.status === 'loading') return reply.code(202).header('Retry-After', '3').send(result)
      if (result.status === 'error') return reply.code(result.error === 'dart_rate_limit' ? 429 : 503).send(result)
      return result
    } catch (error) {
      const code = error instanceof DartError ? error.code : 'dart_database_unavailable'
      return reply.code(code === 'dart_invalid_query' ? 400 : 503).send({ status: 'error', error: code })
    }
  })
}
