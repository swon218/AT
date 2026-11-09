import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { dateInKorea } from '../../server/dartData.js'

export const migration = await readFile(new URL('../../deploy/COMPANY_ANALYSIS_SUPABASE.sql', import.meta.url), 'utf8')
export const fixtureOptions = { budget: 500, requests: 90, profileTtl: 86400, filingsTtl: 900, historyTtl: 604800, reportTtl: 86400 }
const symbols = [
  { symbol: '005930', corp_code: '00126380', name: '검증 기업 가', modified_on: '2025-01-01' },
  { symbol: '000660', corp_code: '00164779', name: '검증 기업 나', modified_on: '2025-01-01' },
]
export const primary = symbols[0]
export const receipt = (year, quarter = 4, corrected = false, corp = primary.corp_code) => {
  const number = String((corp === primary.corp_code ? 1 : 4) + Number(corrected)).padStart(6, '0')
  return quarter === 4 ? `${year + 1}0315${number}` : `${year}${['0515','0814','1114'][quarter - 1]}${number}`
}

export function zipEntry(name, value) {
  const data = Buffer.from(value), filename = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(filename.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(filename.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + data.length, 16)
  return Buffer.concat([local, filename, data, central, filename, end])
}

export async function dartFixtureDatabase() {
  const db = new PGlite()
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;')
  await db.exec(migration)
  const one = async (sql, parameters) => (await db.query(sql, parameters)).rows[0] ?? null
  return { db, store: {
    job: key => one('select * from public.atlas_dart_jobs where key=$1', [key]),
    symbol: code => one('select * from public.atlas_dart_symbols where symbol=$1 and active', [code]),
    accounts: async key => (await db.query('select * from public.atlas_dart_accounts where report_key=$1', [key])).rows,
    due: async limit => (await db.query(`select * from public.atlas_dart_jobs where kind not in ('report','codes')
      and coalesce(expires_at,now())<=now() and coalesce(retry_at,now())<=now() and coalesce(lease_until,now())<=now() limit $1`, [limit])).rows,
    work: async (action, input) => (await one('select public.atlas_dart_work($1,$2::jsonb) as result', [action, JSON.stringify(input)])).result,
  } }
}

export function fixtureTransport() {
  const controls = { calls: [], corrected: false, error: null }
  const report = (corp, year, quarter, corrected = false) => {
    const rcept_no = receipt(year, quarter, corrected, corp)
    const title = { 1: '분기보고서', 2: '반기보고서', 3: '분기보고서', 4: '사업보고서' }[quarter]
    return { corp_code: corp, rcept_no, rcept_dt: rcept_no.slice(0, 8),
      report_nm: `${corrected ? '[기재정정]' : ''}${title} (${year}.${String(quarter * 3).padStart(2, '0')})` }
  }
  const ok = data => Response.json({ status: '000', ...data })
  const transport = async url => {
    const name = url.pathname.split('/').at(-1), params = url.searchParams
    const corp = params.get('corp_code'), company = symbols.find(row => row.corp_code === corp)
    controls.calls.push({ name, corp, scope: params.get('fs_div') })
    if (controls.error) return Response.json({ status: controls.error })
    if (name === 'corpCode.xml') {
      const contents = symbols.map(row => `<list><corp_code>${row.corp_code}</corp_code><corp_name>${row.name}</corp_name><stock_code>${row.symbol}</stock_code><modify_date>20250101</modify_date></list>`).join('')
      return new Response(zipEntry('CORPCODE.xml', `<result>${contents}</result>`))
    }
    if (name === 'document.xml') {
      const no = params.get('rcept_no')
      return new Response(zipEntry(`${no}.xml`, '<!DOCTYPE DOCUMENT SYSTEM "dart3.dtd"><DOCUMENT><TITLE>Ⅱ. 사업의 내용</TITLE><TITLE>1. 사업의 개요</TITLE><P>이 문장은 격리된 자동 테스트를 위한 회사 사업보고서의 합성 예시 본문입니다.</P><TITLE>2. 주요 제품 및 서비스</TITLE><P>검증 전용 제품과 서비스를 제공한다는 테스트의 합성 원문 문단입니다.</P><TITLE>Ⅲ. 재무에 관한 사항</TITLE></DOCUMENT>'))
    }
    if (name === 'company.json') return ok({ corp_name: company?.name, acc_mt: '12', induty_code: '264', corp_cls: 'Y', est_dt: '20000101' })
    if (name === 'list.json' && params.get('pblntf_ty') === 'A') {
      const list = [2021, 2022, 2023, 2024, 2025].flatMap(year => [1, 2, 3, 4].map(quarter => report(corp, year, quarter)))
      if (controls.corrected) list.push(report(corp, 2025, 4, true))
      return ok({ list, total_page: 1, total_count: list.length })
    }
    if (name === 'list.json') {
      const page = Number(params.get('page_no') || 1)
      const date = dateInKorea(-page).replaceAll('-', '')
      const title = page === 2 ? '자기주식 취득 결정' : '영업실적등에대한전망(공정공시)'
      return ok({ list: [{ corp_code: corp, rcept_no: `${date}${corp === primary.corp_code ? '000020' : '000030'}`, rcept_dt: date, report_nm: title }],
        total_page: 2, total_count: 31 })
    }
    const year = Number(params.get('bsns_year'))
    const code = params.get('reprt_code')
    const quarter = { '11013': 1, '11012': 2, '11014': 3, '11011': 4 }[code]
    const rcept_no = receipt(year, quarter, controls.corrected && year === 2025 && quarter === 4, corp)
    if (name === 'fnlttSinglAcntAll.json') {
      const scope = params.get('fs_div')
      const value = scope === 'CFS' ? '9,007,199,254,740,993' : '450000'
      const number = controls.corrected && year === 2025 && quarter === 4 ? '900000' : value
      const account = (account_id, sj_div, thstrm_amount, frmtrm_amount, thstrm_add_amount) =>
        ({ rcept_no, bsns_year: String(year), reprt_code: code, account_id, sj_div, currency: 'KRW',
          thstrm_amount, frmtrm_amount, thstrm_add_amount, frmtrm_q_amount: frmtrm_amount })
      return ok({ list: [
        account('ifrs-full_Revenue', 'IS', number, '400000', '18000000'),
        account('dart_OperatingIncomeLoss', 'IS', '0', '-10'),
        account('ifrs-full_ProfitLoss', 'IS', '50000', '40000'),
        account('ifrs-full_Equity', 'BS', '500000', '300000'),
        account('ifrs-full_Assets', 'BS', '1000000', '800000'),
        account('ifrs-full_CashFlowsFromUsedInOperatingActivities', 'CF', '80000', '60000'),
        account('ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities', 'CF', '-20000', '-20000'),
      ] })
    }
    if (name === 'hyslrSttus.json') return ok({ list: [{ corp_code: corp, rcept_no, nm: '검증 최대주주', relate: '본인', stock_knd: '보통주', trmend_posesn_stock_qota_rt: '35.5' }] })
    if (name === 'alotMatter.json') return ok({ list: [{ corp_code: corp, rcept_no, se: '주당 현금배당금(원)', stock_knd: '보통주', thstrm: '0', stlm_dt: `${year}-12-31` }] })
    if (name === 'accnutAdtorNmNdAdtOpinion.json') return ok({ list: [{ corp_code: corp, rcept_no, adt_opinion: '적정', stlm_dt: `${year}-12-31` }] })
    return Response.json({ status: '013' })
  }
  return { controls, transport }
}
