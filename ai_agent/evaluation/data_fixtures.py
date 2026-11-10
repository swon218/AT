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
