import { createHash } from 'node:crypto'
import { config } from './config.js'
import { companyDart } from './companyDart.js'
import { DartError } from './dartClient.js'
import { clean, dateInKorea, decimal, officialLink, receiptNumber, subtract, validDay } from './dartData.js'

const fields = {
  get_company_profile: ['code'],
  get_company_disclosures: ['code','start_date','end_date','type','page'],
  get_company_financials: ['code','scope','period_type','basis','year','quarter','compare_to_year','metrics'],
  get_company_business: ['code'],
}
const filters = ['all','periodic','results','finance','ownership','treasury','other']
const scopeHash = () => createHash('sha256').update([config.supabaseUrl,config.supabaseSecretKey].join(':')).digest('hex')
const correctionPolicy = '동일 보고기간의 접수번호가 가장 큰 정기보고서 선택. 공시 목록은 최종보고서(last_reprt_at=Y). 서로 다른 보고서 간 회계기준 동일성을 보장하지 않음.'
const errorResult = (code, warnings=[]) => ({status:'error',code,source:'DART · Supabase 저장 스냅샷',warnings})
const moneyMetrics = ['sales','operating','net','assets','liabilities','equity','cash','borrowings','operatingCash','capex','freeCash']
const ratios = ['salesGrowth','operatingGrowth','netGrowth','margin','roe']

function input(tool,args,now) {
  if (!Object.hasOwn(fields,tool) || !args || Object.keys(args).some(key=>!fields[tool].includes(key))) return 'invalid_arguments'
  if (typeof args.code !== 'string' || !/^[0-9][0-9A-Z]{5}$/.test(args.code)) return 'invalid_symbol'
  if (tool==='get_company_disclosures' && (!validDay(args.start_date)||!validDay(args.end_date)||args.start_date>args.end_date||
    args.end_date>dateInKorea(0,now)||args.start_date<'1999-01-01'||Date.parse(args.end_date)-Date.parse(args.start_date)>365*86400000||
    !filters.includes(args.type)||!Number.isInteger(args.page)||args.page<1||args.page>100)) return 'dart_invalid_query'
  if (tool==='get_company_financials') {
    if (!['CFS','OFS'].includes(args.scope)||!['annual','quarterly'].includes(args.period_type)||!['single_period','cumulative'].includes(args.basis)) return 'invalid_arguments'
    for (const year of [args.year,args.compare_to_year]) if (year!=null&&(!Number.isInteger(year)||year<2015||year>Number(dateInKorea(0,now).slice(0,4)))) return 'dart_invalid_query'
    if (args.quarter!=null&&(!Number.isInteger(args.quarter)||args.quarter<1||args.quarter>4)) return 'dart_invalid_query'
    if ((args.period_type==='annual'&&args.quarter!=null)||(args.compare_to_year!=null&&(args.year==null||(args.period_type==='quarterly'&&args.quarter==null)))) return 'incomparable_periods'
    if (args.basis==='cumulative') return 'unsupported_financial_basis'
    if(!Array.isArray(args.metrics)||!args.metrics.length||args.metrics.length>4||new Set(args.metrics).size!==args.metrics.length||args.metrics.some(key=>![...moneyMetrics,...ratios].includes(key))) return 'invalid_arguments'
    if(args.compare_to_year!=null&&args.metrics.some(key=>ratios.includes(key))) return 'unsupported_comparison_metric'
  }
  return null
}

function financialRow(row, scope, period) {
  if (row.scope!==scope||!receiptNumber(row.receipt)||!validDay(row.end)||!validDay(row.filedOn)||
    !Number.isInteger(row.year)||row.year<2015||!(row.currency===null||/^[A-Z]{3}$/.test(row.currency))||
    (period==='annual'?row.quarter!==null:![1,2,3,4].includes(row.quarter))) throw new DartError('dart_invalid_response')
  const values=Object.fromEntries(moneyMetrics.map(key=>[key,decimal(row.values?.[key])]))
  for(const key of ratios) values[key]=Number.isFinite(row.values?.[key])?row.values[key]:null
  return {end:row.end,year:row.year,quarter:row.quarter,scope,currency:row.currency,unit:'통화 기본 단위',
    basis:period==='annual'?'annual':'single_quarter',balance_basis:'period_end',
    report_code:period==='annual'?'11011':({1:'11013',2:'11012',3:'11014',4:'11011'})[row.quarter],
    receipt:row.receipt,filed_on:row.filedOn,collected_at:row.collectedAt||null,corrected:Boolean(row.corrected),url:officialLink(row.receipt),
    values,accounts:row.accounts||{},reasons:row.reasons||{}}
}

// All arithmetic is exact decimal/BigInt. Never divide by a zero or negative base.
function comparison(current,prior) {
  if (!current||!prior) return {status:'unavailable',code:'comparison_period_missing',items:[]}
  const compatible=current.scope===prior.scope&&current.currency&&current.currency===prior.currency&&current.basis===prior.basis&&current.quarter===prior.quarter
  const items=moneyMetrics.map(metric=>{
    const a=current.values[metric],b=prior.values[metric]
    if(!compatible) return {metric,change:null,percent:null,reason:'incompatible_scope_currency_or_period'}
    if(!current.accounts[metric]||current.accounts[metric]!==prior.accounts[metric]) return {metric,change:null,percent:null,reason:'account_identity_mismatch'}
    if(a==null||b==null) return {metric,change:null,percent:null,reason:'missing_value'}
    const change=subtract(a,b), scale=Math.max(a.split('.')[1]?.length||0,b.split('.')[1]?.length||0)
    const integer=value=>{
      const [whole,fraction='']=value.replace('-','').split('.')
      return BigInt(whole+fraction.padEnd(scale,'0'))*(value.startsWith('-')?-1n:1n)
    }
    const base=integer(b)
    const points=base>0n?(integer(a)-base)*10000n/base:null
    const magnitude=points===null?null:points<0n?-points:points
    const percent=points===null?null:`${points<0n?'-':''}${magnitude/100n}.${String(magnitude%100n).padStart(2,'0')}`
    return {metric,change,percent,reason:base===0n?'zero_base':base<0n?'negative_base':null}
  })
  return {status:items.every(item=>item.change===null)?'unavailable':'success',current_receipt:current.receipt,prior_receipt:prior.receipt,
    current_year:current.year,prior_year:prior.year,scope:current.scope,currency:current.currency,basis:current.basis,quarter:current.quarter,
    accounting_basis_verified:false,warning:'기간·계정·통화가 일치하는 보고 수치 비교이며 회계정책 일치·재작성 여부의 독립 검증은 미완료입니다.',items}
}

export function createAgentFundamentalData({service=companyDart,now=Date.now,scope=scopeHash,
  configured=()=>Boolean(config.supabaseUrl&&config.supabaseSecretKey),refreshConfigured=()=>Boolean(config.openDartKey)}={}) {
  const cache=new Map(),pending=new Map()
  let lastSuccess=null
  async function fetchSnapshot(tool,args,permit) {
    const section={get_company_profile:'overview',get_company_disclosures:'disclosures',get_company_financials:'financials',get_company_business:'business'}[tool]
    const query={section,...(section==='financials'?{scope:args.scope}:{}),...(section==='disclosures'?{start:args.start_date,end:args.end_date,type:args.type,page:args.page}:{})}
    // AI reads existing snapshots only. It never fans out into a background DART collection
    // outside the request budget. The existing company tab/refresh timer owns collection.
    const saved=await service.read(args.code,query,{refresh:false,includeIdentity:true,beforeRead:permit})
    if(saved.status==='unsupported') return errorResult('dart_company_mapping_missing')
    if(!saved.checkedAt) return errorResult(saved.error||'dart_data_not_collected',['기업 분석 화면과 기존 갱신 작업이 수집한 데이터가 필요합니다. 이번 요청에서는 수집을 실행하지 않았습니다.'])
    if(!['ready','stale'].includes(saved.status)||saved.identity?.code!==args.code||!/^\d{8}$/.test(saved.identity?.corp_code||'')||!clean(saved.identity?.name)||!saved.data) throw new DartError('dart_invalid_response')
    const warnings=['기업 분석 DB에 저장된 DART 자료입니다. 이번 요청에서 DART 신규 수집·갱신을 실행하지 않았습니다.']
    if(saved.status==='stale') warnings.push('만료된 저장 자료입니다. 최신 보고서·정정 반영 여부를 보장하지 않습니다.')
    if(saved.error) warnings.push('기존 수집 상태: '+saved.error)
    const base={status:saved.status==='stale'?'partial':'success',...saved.identity,source:'DART · Supabase 저장 스냅샷',
      as_of:saved.checkedAt,collected_at:saved.checkedAt,expires_at:saved.expiresAt,queried_at:new Date(now()).toISOString(),
      stale:saved.status==='stale',cache_hit:true,collection_triggered:false,correction_policy:correctionPolicy,warnings}
    const data=saved.data
    if(tool==='get_company_profile') {
      const company=data.company
      if(!company) return {...base,status:'empty',profile:null}
      return {...base,profile:Object.fromEntries(['name','englishName','ceo','market','established','industryCode','fiscalMonth'].map(key=>[key,company[key]??null]))}
    }
    if(tool==='get_company_disclosures') {
      if(!Array.isArray(data.items)||data.items.length>30||!Number.isInteger(data.pages)||!Number.isInteger(data.total)) throw new DartError('dart_invalid_response')
      const items=data.items.map(item=>{
        if(!receiptNumber(item.receipt)||!validDay(item.filedOn)||item.filedOn<args.start_date||item.filedOn>args.end_date||!clean(item.title)) throw new DartError('dart_invalid_response')
        return {receipt:item.receipt,filed_on:item.filedOn,title:clean(item.title,180),type:item.type,corrected:Boolean(item.corrected),period_end:item.periodEnd||null,url:officialLink(item.receipt),body_available:false}
      })
      return {...base,status:base.stale||data.hasNext||data.pageLimitReached?'partial':items.length?'success':'empty',items,page:args.page,pages:data.pages,total:data.total,
        has_next:Boolean(data.hasNext),page_limit_reached:Boolean(data.pageLimitReached),requested_period:{start:args.start_date,end:args.end_date},filter:args.type,
        filter_scope:'페이지 수신 후 제목 분류 · 전체 건수와 페이지 수는 모든 유형 기준',warnings:[...warnings,'공시 목록·제목만 확보했습니다. 공시 본문을 읽은 결과가 아닙니다. 유형은 제목 기반 분류이며 페이지·전체 건수는 전체 유형 기준입니다.']}
    }
    if(tool==='get_company_business') {
      const report=data.report
      if(!report) return {...base,status:base.stale?'partial':'empty',sections:[]}
      if(!receiptNumber(report.receipt)||!validDay(report.filedOn)) throw new DartError('dart_invalid_response')
      const sections=Object.entries(data.sections||{}).slice(0,4).map(([section,value])=>({section,heading:clean(value.heading,120),excerpt:clean(value.excerpt,700)})).filter(item=>item.heading&&item.excerpt)
      return {...base,status:base.stale?'partial':sections.length?'success':'empty',report:{receipt:report.receipt,filed_on:report.filedOn,period_end:report.periodEnd,url:officialLink(report.receipt),corrected:Boolean(report.corrected)},sections,
        parser_version:data.parserVersion,warnings:[...warnings,'사업보고서 본문의 수집·추출된 일부 문단만 제공합니다. 표·보고서 전체·임의 공시 본문은 미지원입니다.']}
    }
    const original=data[args.period_type]
    if(!Array.isArray(original)||original.length>(args.period_type==='annual'?5:8)) throw new DartError('dart_invalid_response')
    const rows=original.map(row=>financialRow(row,args.scope,args.period_type))
    const selected=rows.filter(row=>(args.year==null||row.year===args.year)&&(args.quarter==null||row.quarter===args.quarter))
    if(!selected.length&&rows.length) return {...base,status:'error',code:'financial_period_not_available',available_periods:rows.map(({year,quarter,end})=>({year,quarter,end}))}
    const compared=args.compare_to_year!=null?comparison(selected[0],rows.find(row=>row.year===args.compare_to_year&&row.quarter===args.quarter)):null
    if(compared) compared.items=compared.items.filter(item=>args.metrics.includes(item.metric))
    const items=selected.map(row=>({...row,values:Object.fromEntries(args.metrics.map(key=>[key,row.values[key]??null])),
      accounts:Object.fromEntries(args.metrics.map(key=>[key,row.accounts[key]??null])),reasons:Object.fromEntries(args.metrics.filter(key=>row.reasons[key]).map(key=>[key,row.reasons[key]]))}))
    const incomplete=items.some(row=>Object.values(row.values).some(value=>value===null))||(compared&&compared.items.some(item=>item.change===null||item.percent===null))
    return {...base,status:base.stale||incomplete?'partial':items.length?'success':'empty',items,comparison:compared,
      period_type:args.period_type,scope:args.scope,basis:args.period_type==='annual'?'annual':'single_quarter',
      warnings:[...warnings,'최근 연간 최대 5개·분기 최대 8개 저장 보고서 범위입니다. 누적 수치 조회와 검증 없는 분기 차감은 지원하지 않습니다. 일부 계정·4분기 손익·분기 현금흐름은 자료 부족으로 비어 있을 수 있습니다.']}
  }
  return {
    status:()=>({fundamental:{configured:configured(),refresh_configured:refreshConfigured(),last_success_at:lastSuccess,read_mode:'stored_snapshot'}}),
    async read(tool,args,permit=()=>true) {
      const invalid=input(tool,args,now())
      if(invalid) return errorResult(invalid)
      if(!configured()) return errorResult('dart_database_not_configured')
      const key=JSON.stringify([scope(),tool,args]),at=now()
      if(cache.has(key)&&at-cache.get(key).at<5000) return {...cache.get(key).value,memory_cache:true}
      if(pending.has(key)) return pending.get(key)
      if(pending.size>=8) return errorResult('dart_busy')
      const work=(async()=>{
        try {
          const value=await fetchSnapshot(tool,args,permit)
          if(value.status!=='error') {lastSuccess=new Date(now()).toISOString();if(cache.size>=64)cache.delete(cache.keys().next().value);cache.set(key,{at:now(),value})}
          return value
        } catch(error) {return errorResult(error instanceof DartError?error.code:['request_not_active','external_request_limit'].includes(error.safeCode)?error.safeCode:'dart_database_unavailable')}
        finally {pending.delete(key)}
      })()
      pending.set(key,work)
      return work
    },
  }
}
export const agentFundamentalData=createAgentFundamentalData()
