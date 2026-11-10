"""Isolated synthetic provider data for evaluation. Never wired into the production app."""
from datetime import datetime, timedelta


class FixedResearchData:
    def __init__(self, scenario, now):
        self.scenario, self.now = scenario, now

    async def read(self, tool, args, budget, maximum=1):
        budget.spend_external()
        if self.scenario == 'market_error':
            return {'status':'error','code':'market_auth_error','items':[]}
        stocks = [{'code':'005930','name':'삼성전자','market':'KOSPI'},{'code':'005935','name':'삼성전자우','market':'KOSPI'},
                  {'code':'035420','name':'NAVER','market':'KOSPI'}]
        if tool == 'resolve_market_symbol':
            term = args['query'].replace(' ','').upper().replace('네이버','NAVER')
            rows = [row for row in stocks if term in (row['code'], row['name'].upper())]
            if not rows:
                rows = [row for row in stocks if term in row['name'].upper()]
            return {'status':'success' if len(rows)==1 else 'partial' if rows else 'empty','items':rows,'total':len(rows)}
        if tool.startswith('get_company_'):
            return self.company(tool,args)
        base = {'market':'KRX','currency':'KRW','volume_unit':'shares','provider_at':None,'queried_at':self.now.isoformat(),
                'cache_hit':False,'cache_age_ms':0,'realtime':'unknown','delay':'unknown','warnings':['격리된 합성 시세입니다.']}
        if args['market'] != 'KRX':
            return {'status':'error','code':'unsupported_market','items':[]}
        if tool == 'get_market_quote':
            stock = next((row for row in stocks if row['code']==args['code']),None)
            if not stock:
                return {'status':'error','code':'market_no_data','items':[]}
            return {**base,**stock,'status':'success','market':'KRX','price':1000,'changeAmount':-10,'change':-100/101,
                    'volume':0,'observation':'latest_available','adjusted':'not_applicable','source':'Kiwoom REST ka10001 / evaluation fixture'}
        if tool == 'get_intraday_bars':
            start = datetime.fromisoformat('2026-10-27T09:00:00+09:00')
            bars = [{'time':(start+timedelta(minutes=i)).isoformat(),'open':1000+i,'high':1010+i,'low':990+i,'close':1001+i,'volume':100,'completed':'unknown'} for i in range(5)]
            return {**base,'status':'partial','source':'Kiwoom REST ka10080 / evaluation fixture','items':bars,'provider_at':bars[-1]['time'],
                    'adjusted':True,'requested_period':{'start':args['start_date'],'end':args['end_date']},
                    'returned_period':{'start':bars[0]['time'],'end':bars[-1]['time']},'more_available':True,'invalid_rows':0,'truncated':False}
        return {'status':'error','code':'forbidden_data_tool','items':[]}

    def company(self,tool,args):
        if self.scenario=='fundamental_error':
            return {'status':'error','code':'dart_rate_limit','items':[]}
        base={'status':'success','code':args['code'],'name':'삼성전자','corp_code':'00126380',
              'source':'DART / isolated synthetic evaluation snapshot','as_of':'2026-10-20T00:00:00Z',
              'collected_at':'2026-10-20T00:00:00Z','queried_at':self.now.isoformat(),'stale':False,'cache_hit':True,
              'correction_policy':'같은 보고기간 최신 접수번호 선택','warnings':['평가용 합성 자료 · 운영 수치 아님']}
        if tool=='get_company_profile':
            return {**base,'profile':{'name':'삼성전자','market':'코스피','ceo':None,'fiscalMonth':12}}
        if tool=='get_company_disclosures':
            items=[] if self.scenario=='fundamental_empty' else [{'title':'평가용 사업보고서','receipt':'20260320000001',
                    'filed_on':'2026-03-20','corrected':True,'body_available':False,'url':'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260320000001'}]
            return {**base,'status':'success' if items else 'empty','items':items,'page':args['page'],'pages':1,'total':len(items),
                    'has_next':False,'requested_period':{'start':args['start_date'],'end':args['end_date']}}
        if tool=='get_company_business':
            return {**base,'report':{'receipt':'20260320000001','filed_on':'2026-03-20','period_end':'2025-12-31','url':'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260320000001'},
                    'sections':[{'section':'products','heading':'주요 제품 및 서비스','excerpt':'평가용 합성 제품 설명입니다. 실제 회사의 사업 내용에 대한 근거가 아닙니다.'}]}
        if args['basis']=='cumulative':
            return {'status':'error','code':'unsupported_financial_basis'}
        quarter=args['quarter'] if args['period_type']=='quarterly' else None
        end=f"{args['year'] or 2025}-"+{1:'03-31',2:'06-30',3:'09-30',4:'12-31',None:'12-31'}[quarter]
        row={'year':args['year'] or 2025,'quarter':quarter,'end':end,'scope':args['scope'],'currency':'KRW','unit':'통화 기본 단위',
             'basis':'single_quarter' if quarter else 'annual','receipt':'20260320000001','filed_on':'2026-03-20',
             'collected_at':base['collected_at'],'corrected':True,'url':'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260320000001',
             'values':{metric:('1000' if metric=='sales' else '0' if metric=='operating' else None) for metric in args['metrics']},
             'reasons':{},'accounts':{'sales':'ifrs-full_Revenue','operating':'dart_OperatingIncomeLoss'}}
        return {**base,'items':[row],'comparison':None,'period_type':args['period_type'],'scope':args['scope'],'basis':row['basis']}
