"""Official company evidence from bounded existing DART DB snapshots, never model arithmetic."""
import re
from .data_source import DataError, read_data

LABELS = {'sales':'매출액','operating':'영업이익','net':'순이익','assets':'자산','liabilities':'부채','equity':'자본',
          'cash':'현금성자산','borrowings':'차입금','operatingCash':'영업현금흐름','capex':'설비투자','freeCash':'잉여현금흐름',
          'salesGrowth':'매출 증감률','operatingGrowth':'영업이익 증감률','netGrowth':'순이익 증감률','margin':'영업이익률','roe':'ROE'}
RATIOS = {'salesGrowth','operatingGrowth','netGrowth','margin','roe'}


async def company_data(tools, args, tool, identify):
    value = await read_data(tools, tool, args, 2)
    if value['status'] == 'error':
        return value
    if value.get('code') != args.code or not re.fullmatch(r'\d{8}', value.get('corp_code','')) or not value.get('name'):
        raise DataError('invalid_data_response')
    tools.resolved[args.code] = {'code':args.code,'name':value['name']}
    metadata = {key:value.get(key) for key in ('code','name','corp_code','source','as_of','collected_at','expires_at','queried_at','stale','cache_hit','memory_cache','correction_policy','warnings')}
    metadata.update(scope='fundamental', data_kind=tool.removeprefix('get_company_'))
    sources = []

    def add(excerpt, extra=None):
        source = {**metadata,**(extra or {}),'excerpt':excerpt[:300]}
        source['id'] = identify('d_',source)
        tools.remember(source)
        sources.append(source)

    label = f"{value['name']}({args.code})"
    if tool == 'get_company_profile' and value.get('profile'):
        profile = value['profile']
        add(f"{label} DART 기업코드 {value['corp_code']}, 법인명 {profile.get('name') or '미확인'}, 시장 {profile.get('market') or '미확인'}, 대표 {profile.get('ceo') or '미확인'}, 결산월 {profile.get('fiscalMonth') or '미확인'}.", {'profile':profile,'body_available':False})
    elif tool == 'get_company_disclosures':
        for item in value.get('items',[])[:30]:
            add(f"{label} 공시 {item['filed_on']} · {item['title']} · 접수 {item['receipt']} · 정정 {'예' if item['corrected'] else '아니요'}. 제목·목록만 확보, 본문 미확보.",item)
    elif tool == 'get_company_business':
        report=value.get('report') or {}
        for section in value.get('sections',[])[:4]:
            add(section['heading']+' · '+section['excerpt'][:260],{**report,'section':section['section'],'body_available':True,'text_scope':'사업보고서 일부 추출 문단'})
    elif tool == 'get_company_financials':
        for row in value.get('items',[])[:8]:
            for metric,amount in row['values'].items():
                if amount is None:
                    continue
                period = f"{row['year']}년 연간" if row['quarter'] is None else f"{row['year']}년 {row['quarter']}분기 단일분기"
                if metric in ('assets','liabilities','equity','cash','borrowings'):
                    period += ' 기말'
                scope = '연결' if row['scope']=='CFS' else '별도'
                unit = '%' if metric in RATIOS else f"{row['currency'] or '통화 미확인'} 기본 단위"
                add(f"{label} {period} {scope} {LABELS[metric]} {amount} {unit}. 보고기간 말 {row['end']}, 접수 {row['receipt']}.",
                    {key:row.get(key) for key in ('year','quarter','end','scope','currency','unit','basis','balance_basis','report_code','receipt','filed_on','collected_at','corrected','url')} | {'scope':'fundamental','financial_scope':row['scope'],'metric':metric,'amount':amount,'body_available':False})
        compared=value.get('comparison')
        if compared:
            for item in compared.get('items',[]):
                if item.get('change') is None:
                    continue
                pct = f"{item['percent']}%" if item.get('percent') is not None else '산출 불가 ('+str(item.get('reason'))+')'
                add(f"{label} {compared['current_year']}년 대 {compared['prior_year']}년, {compared['scope']}·{compared['basis']}·{compared['currency']} {LABELS[item['metric']]} 증감 {item['change']} 기본 단위, 증감률 {pct}. 회계정책 비교 미검증.",
                    {'comparison':compared,'metric':item['metric'],'body_available':False,
                     'url':f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={compared['current_receipt']}",
                     'comparison_url':f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={compared['prior_receipt']}"})
    coverage = {**metadata,'kind':'fundamental','items':len(sources),'incomplete':value['status']=='partial',
                'requested_conditions':args.model_dump(),'available_periods':value.get('available_periods'),
                **{key:value.get(key) for key in ('requested_period','page','pages','total','has_next','page_limit_reached','scope','basis','period_type') if key in value}}
    coverage['financial_scope'] = value.get('scope')
    coverage['scope'] = 'fundamental'
    tools.coverage.append(coverage)
    # Preserve unavailable cells, exact string amounts and comparison reasons separately from citable evidence.
    return {**value,'items':sources,'data_rows':value.get('items'),'coverage':coverage,
            'warnings':value.get('warnings',[])}
