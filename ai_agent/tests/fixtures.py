"""Test-only providers/data; production app has no env switch to import this module."""
from datetime import datetime
from email.utils import format_datetime
import json
from pathlib import Path
from uuid import uuid4
import httpx
from lab.store import connect, save_rows
from ai_agent.market import expected_sessions
from ai_agent.provider import Turn

NOW = datetime.fromisoformat('2026-10-28T08:00:00+09:00')
USAGE = {'input_tokens': 25, 'output_tokens': 20, 'reasoning_tokens': 4, 'cached_tokens': 0}


def make_lab(path):
    db = connect(path)
    days = expected_sessions('2026-09-01', '2026-10-27')
    for code, name, direction in [('005930', '삼성전자', -1), ('000660', 'SK하이닉스', -1), ('035420', 'NAVER', 1)]:
        rows = [{'date': day, 'open': 300 + direction * i, 'close': 300 + direction * i,
                 'high': 305 + direction * i, 'low': 295 + direction * i, 'volume': 100} for i, day in enumerate(days)]
        save_rows(db, code, name, 'KOSPI', rows, days[0], days[-1], full=True)
    db.close()
    return str(path)


def news_transport(empty_first=False, error=False, positive=False):
    def handler(request):
        if error:
            return httpx.Response(503)
        if empty_first and request.url.params['start'] == '1':
            return httpx.Response(200, json={'total': 11, 'items': []})
        query = request.url.params['query'].split()[0]
        title = query + (' 영업이익 증가' if positive else ' 영업이익 감소')
        item = {'title': title, 'description': query + (' 수익성 개선' if positive else ' 수익성 악화 우려'),
                'originallink': 'https://example.com/news/' + query,
                'pubDate': format_datetime(datetime.fromisoformat('2026-10-28T06:00:00+09:00'))}
        return httpx.Response(200, json={'total': 1, 'items': [item, item]})
    return httpx.MockTransport(handler)


def final(kind='concept', summary='RSI는 상대강도지수로 상승·하락 강도를 비교합니다.', claims=None):
    return {'kind': kind, 'summary': summary, 'sentiment': '자료 부족' if not claims else '혼재',
            'claims': claims or [], 'uncertainty': ['확보된 자료의 범위이며 투자 지시가 아닙니다.']}


class ScriptedProvider:
    def __init__(self, turns):
        self.turns = list(turns)
        self.inputs = []

    async def respond(self, items, instructions, tools, output_limit):
        self.inputs.append(json.loads(json.dumps(items)))
        turn = self.turns.pop(0)
        if isinstance(turn, Exception):
            raise turn
        return turn


def call(name, arguments, call_id=None):
    return Turn([{'type': 'function_call', 'id': 'fc_' + uuid4().hex, 'call_id': call_id or uuid4().hex,
                  'name': name, 'arguments': json.dumps(arguments, ensure_ascii=False)}], '', dict(USAGE))


def answer(value=None):
    return Turn([{'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': json.dumps(value or final(), ensure_ascii=False)}]}],
                json.dumps(value or final(), ensure_ascii=False), dict(USAGE))


class AdaptiveProvider:
    """Consumes real tool-call outputs, chooses next codes/pages from those outputs, derives final claims."""
    def __init__(self, mode='composite'):
        self.mode, self.inputs, self.results, self.seen, self.article_ids = mode, [], [], set(), []

    async def respond(self, items, instructions, tools, output_limit):
        self.inputs.append(json.loads(json.dumps(items)))
        if any(tool['name'] == 'delegate_research' for tool in tools):
            if self.mode == 'concept':
                return answer()
            reports = [report for item in items if item.get('type') == 'function_call_output'
                       for report in json.loads(item['output']).get('reports', [])]
            if not reports or self.mode == 'composite' and not any(report['agent'] == 'news' for report in reports):
                agent = 'fundamental' if self.mode == 'fundamental' else 'market' if self.mode == 'market' else 'news' if self.mode in ('news', 'ambiguous') or reports else 'technical'
                return delegation(agent, symbols=[row['code'] for report in reports for row in report.get('matched_symbols', [])], goal='FIXTURE MODE ' + self.mode)
            claims = [claim for report in reports for claim in (report.get('findings') or {}).get('claims', [])]
            clarification = next((report['findings'] for report in reports if report['status'] == 'clarification'), None)
            return answer(clarification or final('research' if claims else 'insufficient', '확보된 자료를 확인했습니다.' if claims else '자료를 확인하지 못했습니다.', claims))
        outputs = [json.loads(x['output']) for x in items if x.get('type') == 'function_call_output']
        self.results.extend(output for output in outputs if output not in self.results)
        if self.mode == 'fundamental':
            if not outputs:
                return call('get_company_profile', {'code':'005930'})
            if not any(output.get('period_type') for output in outputs):
                return call('get_company_financials',{'code':'005930','scope':'CFS','period_type':'annual','basis':'single_period','year':2025,'quarter':None,'compare_to_year':None,'metrics':['sales','operating']})
            claims=[{'text':source['excerpt'],'excerpt':source['excerpt'],'evidence_id':source['id'],'stance':'neutral','relation':'direct'} for output in outputs for source in output.get('items',[]) if source.get('id')]
            return answer(final('research' if claims else 'insufficient','확보된 기업 자료와 한계를 확인했습니다.',claims))
        if self.mode == 'market':
            if not outputs:
                return call('resolve_market_symbol', {'query':'삼성전자'})
            if not outputs[-1].get('values'):
                return call('get_market_quote', {'code':outputs[-1]['items'][0]['code'],'market':'KRX'})
            source = outputs[-1]['items'][0]
            return answer(final('research','조회 가능한 시세와 한계를 확인했습니다.',[{'text':source['excerpt'],'excerpt':source['excerpt'],'evidence_id':source['id'],'stance':'neutral','relation':'direct'}]))
        is_technical = any(tool['name'] == 'screen_rsi' for tool in tools)
        mode = 'rsi' if self.mode == 'composite' and is_technical else self.mode
        assignment = json.loads(items[0]['content']) if items and items[0].get('content', '').startswith('{') else {}
        if self.mode == 'concept':
            return answer()
        if not outputs:
            if mode == 'composite':
                return call('get_stock_news', {'code': assignment['assignment']['symbols'][0], 'period': 'overnight', 'page': 1, 'keyword': ''})
            if mode == 'stock_screen':
                from .test_stock_screen import query, cond
                return call('screen_stocks', query(cond(), cond('close', 'lte', other='sma')).model_dump())
            return call('resolve_symbol', {'query': '삼성' if mode == 'ambiguous' else '삼성전자'}) if mode in ('news', 'ambiguous') else call('screen_rsi', {'threshold': 30, 'market': 'ALL', 'page': 1, 'page_size': 20})
        last = outputs[-1]
        if last['status'] == 'error':
            return answer(final('insufficient', '조회 서비스 오류로 자료를 확인하지 못했습니다.'))
        if last.get('ambiguous'):
            return answer(final('clarification', '어느 종목을 말씀하셨나요? 정확한 이름이나 코드를 알려 주세요.'))
        if self.mode == 'news' and not last.get('coverage'):
            return call('get_stock_news', {'code': last['items'][0]['code'], 'period': 'overnight', 'page': 1, 'keyword': ''})
        screen = next((o for o in outputs if o.get('coverage', {}).get('kind') in ('rsi', 'screen')), None)
        if mode in ('rsi', 'stock_screen') and screen:
            claims = [{'text': row['excerpt'], 'evidence_id': row['id'], 'excerpt': row['excerpt'], 'stance': 'neutral', 'relation': 'direct'} for row in screen['items']]
            return answer(final('research', '확정 일봉에서 조건에 맞는 종목을 확인했습니다.', claims))
        news = [o for o in outputs if o.get('coverage', {}).get('kind') == 'news']
        if news and not news[-1]['items'] and news[-1]['coverage']['more_available']:
            c = news[-1]['coverage']
            return call('get_stock_news', {'code': c['code'], 'period': 'overnight', 'page': c['page'] + 1, 'keyword': ''})
        if mode == 'composite':
            done = {o['coverage']['code'] for o in news}
            remaining = [row for row in assignment.get('verified_symbols', []) if row['code'] in assignment['assignment']['symbols'] and row['code'] not in done]
            if remaining:
                # The code is ONLY obtained from the preceding real RSI result, not a preset script.
                return call('get_stock_news', {'code': remaining[0]['code'], 'period': 'overnight', 'page': 1, 'keyword': ''})
        sources = [i for n in news for i in n['items']]
        if not sources:
            return answer(final('insufficient', '검색한 기간과 페이지에서 관련 기사를 확보하지 못했습니다.'))
        claims = [{'text': i['title'], 'evidence_id': i['id'], 'excerpt': i['title'],
                   'stance': 'negative' if '감소' in i['title'] else 'positive', 'relation': 'direct'} for i in sources]
        return answer(final('research', '확보된 기사에서 관련 요인을 확인했습니다.', claims))


def delegation(agent, symbols=None, goal='격리된 회귀 시나리오 확인'):
    return call('delegate_research', {'tasks': [{'agent': agent, 'goal': goal,
                 'symbols': symbols or [], 'period': None, 'constraints': '고정 데이터만 사용', 'deliverable': '근거와 한계'}]})


class OrchestratedFixture:
    """Supply fixed orchestration turns around legacy tool scenarios, using the production graph."""
    def __init__(self, provider, agent='news'):
        self.provider, self.agent = provider, agent

    async def respond(self, items, instructions, tools, output_limit):
        if not any(tool['name'] == 'delegate_research' for tool in tools):
            return await self.provider.respond(items, instructions, tools, output_limit)
        reports = [report for item in items if item.get('type') == 'function_call_output'
                   for report in json.loads(item['output']).get('reports', [])]
        if reports:
            findings = reports[-1]['findings'] or final('insufficient', '자료를 확인하지 못했습니다.')
            turn = answer(findings)
        else:
            first = self.provider.turns[0] if getattr(self.provider, 'turns', None) else None
            if first is not None and (isinstance(first, Exception) or not first.output or not any(item.get('type') == 'function_call' for item in first.output)):
                return await self.provider.respond(items, instructions, tools, output_limit)
            turn = delegation(self.agent)
        turn.usage = dict.fromkeys(USAGE, 0)
        return turn


def fixture_graph(settings, provider, tools, on_step=None):
    from ai_agent.graph import ResearchGraph
    if not isinstance(provider, AdaptiveProvider):
        names = [item.get('name', '') for turn in getattr(provider, 'turns', []) if isinstance(turn, Turn) for item in turn.output]
        agent = 'alert' if tools.alerts.available or any('alert' in name for name in names) else 'technical' if any(name in ('screen_rsi', 'screen_stocks', 'get_stock_indicators') for name in names) or provider.__class__.__name__ == 'Model' else 'news'
        provider = OrchestratedFixture(provider, agent)
    return ResearchGraph(settings, provider, tools, on_step)
