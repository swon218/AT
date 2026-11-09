import { DartError, dartXmlFromZip, xmlText } from './dartClient.js'

export const dateInKorea = (offset = 0, now = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now + offset * 86_400_000)
export const clean = (value, limit = 240) => typeof value === 'string' && !/^\s*(?:-|N\/A)?\s*$/.test(value) ? value.trim().slice(0, limit) : null
export const receiptNumber = value => typeof value === 'string' && /^\d{14}$/.test(value)
export const officialLink = receipt => receiptNumber(receipt) ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receipt}` : null

export function validDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) return false
  const time = Date.parse(day)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day
}

export function providerDate(value) {
  const parts = typeof value === 'string' && value.match(/^(\d{4})[.\-]?(\d\d)[.\-]?(\d\d)$/)
  const date = parts && parts.slice(1).join('-')
  return validDay(date) ? date : null
}

export function decimal(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text) || text.length > 64) return null
  return text.replaceAll(',', '')
}

function units(value, scale) {
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.')
  const exact = BigInt(whole + fraction.padEnd(scale, '0'))
  return value.startsWith('-') ? -exact : exact
}

function decimals(values, operation) {
  if (values.some(value => value == null)) return null
  const scale = Math.max(...values.map(value => value.split('.')[1]?.length || 0))
  const result = operation(...values.map(value => units(value, scale)))
  if (result === null) return null
  const digits = (result < 0n ? -result : result).toString().padStart(scale + 1, '0')
  return (result < 0n ? '-' : '') + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits)
}
export const subtract = (a, b) => decimals([a, b], (x, y) => x - y)
const add = (a, b) => decimals([a, b], (x, y) => x + y)
function percent(values, operate) {
  if (values.some(value => value == null)) return null
  const scale = Math.max(...values.map(value => value.split('.')[1]?.length || 0))
  const [numerator, denominator] = operate(...values.map(value => units(value, scale)))
  if (denominator <= 0n) return null
  const basisPoints = (numerator * 10000n) / denominator
  return Number(basisPoints) / 100
}

const reportNames = { 사업보고서: '11011', 반기보고서: '11012', 분기보고서: 'quarter' }
const filingTypes = [
  ['periodic', /^(사업|반기|분기)보고서/],
  ['results', /영업\s*\(잠정\)\s*실적|잠정영업실적|영업실적|매출액또는손익구조/],
  ['finance', /증자|감자|사채권\s*발행|사채\s*발행|자금조달/],
  ['ownership', /대량보유|특정증권등\s*소유상황|지분\s*변동/],
  ['treasury', /자기주식|자사주/],
]

export function normalizeFiling(item, corp) {
  const title = clean(item.report_nm)
  const filed_on = providerDate(item.rcept_dt)
  if (item.corp_code !== corp || !title || !filed_on || !receiptNumber(item.rcept_no)) throw new DartError('dart_invalid_response')
  const base = title.replace(/^(\s*\[[^\]]+\]\s*)+/, '')
  const period = base.match(/^(사업보고서|반기보고서|분기보고서)\s*\((\d{4})\.(\d{2})\)$/)
  const periodEnd = period && Number(period[3]) >= 1 && Number(period[3]) <= 12
    ? new Date(Date.UTC(Number(period[2]), Number(period[3]), 0)).toISOString().slice(0, 10) : null
  return {
    receipt: item.rcept_no, corp_code: corp, filed_on, title,
    corrected: /^\s*(\[[^\]]*정정[^\]]*\])/.test(title),
    series: periodEnd ? `${period[1]}:${periodEnd}` : null,
    periodEnd, periodMonth: periodEnd ? Number(period[3]) : null,
    report: periodEnd ? reportNames[period[1]] : null,
    type: filingTypes.find(([, pattern]) => pattern.test(base))?.[0] ?? 'other',
  }
}

export function selectReports(filings, fiscalMonth) {
  const periods = new Map()
  for (const filing of filings) {
    if (!filing.series) continue
    const year = Number(filing.periodEnd.slice(0, 4))
    const annual = filing.report === '11011'
    const offset = (filing.periodMonth - fiscalMonth + 12) % 12
    if ((annual && offset !== 0) || (!annual && (filing.report === '11012' ? offset !== 6 : ![3, 9].includes(offset)))) continue
    const fiscalYear = year + (filing.periodMonth > fiscalMonth ? 1 : 0)
    if (fiscalYear < 2015) continue
    const quarter = annual ? 4 : offset / 3
    const reportCode = { 1: '11013', 2: '11012', 3: '11014', 4: '11011' }[quarter]
    const candidate = { ...filing, fiscalYear, quarter, reportCode }
    if (!periods.has(filing.periodEnd) || filing.receipt > periods.get(filing.periodEnd).receipt) periods.set(filing.periodEnd, candidate)
  }
  return [...periods.values()].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
}

// Scope, statement and XBRL account identity must agree. Non-standard name-only matches are omitted.
const accountMapping = {
  sales: ['IS CIS', 'ifrs-full_Revenue', 'ifrs_Revenue'],
  operating: ['IS CIS', 'dart_OperatingIncomeLoss'],
  net: ['IS CIS', 'ifrs-full_ProfitLoss', 'ifrs_ProfitLoss'],
  assets: ['BS', 'ifrs-full_Assets', 'ifrs_Assets'],
  liabilities: ['BS', 'ifrs-full_Liabilities', 'ifrs_Liabilities'],
  equity: ['BS', 'ifrs-full_Equity', 'ifrs_Equity'],
  cash: ['BS', 'ifrs-full_CashAndCashEquivalents', 'ifrs_CashAndCashEquivalents'],
  borrowings: ['BS', 'ifrs-full_Borrowings'],
  operatingCash: ['CF', 'ifrs-full_CashFlowsFromUsedInOperatingActivities', 'ifrs_CashFlowsFromUsedInOperatingActivities'],
  capex: ['CF', 'ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'],
}
const flows = new Set(['sales', 'operating', 'net', 'operatingCash', 'capex'])
const cashFlows = new Set(['operatingCash', 'capex'])

export function normalizeAccounts(payload, report, corp, scope) {
  if (!payload) return []
  if (!Array.isArray(payload.list) || !payload.list.length || payload.list.some(row =>
    row.rcept_no !== report.receipt || row.reprt_code !== report.reportCode || Number(row.bsns_year) !== report.fiscalYear ||
    (row.corp_code && row.corp_code !== corp))) throw new DartError('dart_report_version')
  return Object.entries(accountMapping).flatMap(([metric, [statements, ...ids]]) => {
    const matches = payload.list.filter(row => statements.split(' ').includes(row.sj_div) && ids.includes(row.account_id) && /^[A-Z]{3}$/.test(row.currency ?? ''))
    if (!matches.length) return []
    const values = matches.map(row => ({
      corp_code: corp, receipt: report.receipt, fiscal_year: report.fiscalYear, report_code: report.reportCode,
      period_end: report.periodEnd, scope, metric, account_id: row.account_id, currency: row.currency,
      amount: decimal(row.thstrm_amount), accumulated: decimal(row.thstrm_add_amount),
      comparison: decimal(report.quarter !== 4 && flows.has(metric) && !cashFlows.has(metric) ? row.frmtrm_q_amount : row.frmtrm_amount),
    }))
    const first = values[0]
    if (values.some(row => ['currency', 'amount', 'accumulated', 'comparison'].some(key => row[key] !== first[key]))) return []
    return [first]
  })
}

function matchingBasis(current, prior) {
  // A verified accounting basis is optional evidence, not implied by a matching account label or a filing without a correction tag.
  return Boolean(current?.accountingBasis && current.accountingBasis === prior?.accountingBasis && !current.corrected && !prior.corrected &&
    current.scope === prior.scope && current.fiscalYear === prior.fiscalYear && current.quarter === prior.quarter + 1)
}

export function financialPeriod(report, previous, annual, financialIndustry = false) {
  const accounts = Object.fromEntries(report.accounts.map(row => [row.metric, row]))
  const prior = Object.fromEntries((previous?.accounts || []).map(row => [row.metric, row]))
  const currencies = new Set(report.accounts.map(row => row.currency))
  const currency = currencies.size === 1 ? [...currencies][0] : null
  const values = {}
  const comparison = {}
  const reasons = {}
  for (const [metric, account] of Object.entries(accounts)) {
    if (!currency) continue
    const mustSubtract = !annual && (cashFlows.has(metric) ? report.quarter > 1 : report.quarter === 4 && flows.has(metric))
    if (mustSubtract) {
      const priorAccount = prior[metric]
      const compatible = matchingBasis(report, previous) && priorAccount?.currency === account.currency && priorAccount.account_id === account.account_id
      values[metric] = compatible
        ? subtract(report.quarter === 4 ? account.amount : account.accumulated ?? account.amount,
          cashFlows.has(metric) ? priorAccount.accumulated ?? priorAccount.amount : priorAccount.accumulated)
        : null
      if (values[metric] == null) reasons[metric] = '비교 가능한 누적 실적과 회계기준을 확인하지 못했습니다.'
    } else {
      values[metric] = account.amount
      comparison[metric] = account.comparison
    }
  }
  for (const metric of ['sales', 'operating', 'net']) {
    const value = values[metric]
    const previousAmount = comparison[metric]
    values[`${metric}Growth`] = financialIndustry ? null : percent([value, previousAmount], (x, y) => [x - y, y])
    if (values[`${metric}Growth`] == null) reasons[`${metric}Growth`] = '전년 동기 기준이 없거나 전년 금액이 0 이하입니다.'
  }
  if (!financialIndustry) {
    values.margin = percent([values.operating, values.sales], (income, sales) => [income, sales])
    if (annual && comparison.equity != null && values.equity != null) {
      const averageBase = add(values.equity, comparison.equity)
      values.roe = percent([values.net, averageBase], (income, sum) => [income * 2n, sum])
    }
    const capex = values.capex?.replace(/^-/, '') ?? null
    values.capex = capex
    values.freeCash = subtract(values.operatingCash, capex)
  } else {
    for (const metric of ['margin', 'roe', 'capex', 'freeCash']) {
      values[metric] = null
      reasons[metric] = '금융업 또는 업종을 확인하지 못해 계산하지 않았습니다.'
    }
  }
  return {
    end: report.periodEnd, year: report.fiscalYear, quarter: annual ? null : report.quarter,
    scope: report.scope, currency, unit: '통화 기본 단위', receipt: report.receipt, filedOn: report.filed_on,
    collectedAt: report.collectedAt, corrected: report.corrected, values, reasons,
    accounts: Object.fromEntries(Object.entries(accounts).map(([metric, row]) => [metric, row.account_id])),
  }
}

const sectionHeadings = {
  summary: /^(?:\d+\.\s*)?사업의\s*개요$/,
  products: /^(?:\d+\.\s*)?주요\s*제품\s*(?:및|·)\s*서비스$/,
  orders: /^(?:\d+\.\s*)?매출\s*(?:및|·)\s*수주상황$/,
  research: /^(?:\d+\.\s*)?주요계약\s*(?:및|·)\s*연구개발활동$/,
}
export const businessParserVersion = 1

export function extractBusiness(bytes, receipt) {
  const xml = dartXmlFromZip(bytes, name => name === `${receipt}.xml` || name === `${receipt}_01.xml`)
  const headings = [...xml.matchAll(/<TITLE\b[^>]*>([\s\S]*?)<\/TITLE>/gi)]
  const results = {}
  const businessStart = headings.findIndex(match => /^(?:Ⅱ|II)\.\s*사업의\s*내용$/.test(xmlText(match[1])))
  if (businessStart < 0) return results
  const end = headings.findIndex((match, index) => index > businessStart && /^(?:[Ⅰ-Ⅻ]+|[IVX]+)\./.test(xmlText(match[1])))
  const section = headings.slice(businessStart + 1, end < 0 ? undefined : end)
  for (const [id, pattern] of Object.entries(sectionHeadings)) {
    const matches = section.filter(match => pattern.test(xmlText(match[1])))
    if (matches.length !== 1) continue
    const heading = matches[0]
    const next = headings[headings.indexOf(heading) + 1]
    const content = xml.slice(heading.index + heading[0].length, next?.index)
      .replace(/<TABLE\b[^>]*>[\s\S]*?<\/TABLE>/gi, '')
    const paragraphs = [...content.matchAll(/<P\b[^>]*>([\s\S]*?)<\/P>/gi)]
      .map(match => xmlText(match[1])).filter(text => text.length >= 25 && !/^(해당사항|해당 사항)\s*없/.test(text))
    if (paragraphs.length) results[id] = { heading: xmlText(heading[1]), excerpt: paragraphs.join(' ').slice(0, 700) }
  }
  return results
}
