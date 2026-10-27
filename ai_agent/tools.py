import asyncio
from contextlib import closing
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
import hashlib
import html
import json
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import urlsplit, urlunsplit
import httpx
from .market import KST, market_context
from .schemas import TOOL_MODELS
from .screener import SCREENER, ScanBusy, ScanChanged

PROMPT_VERSION = 'atlas-research-v1'


def stable_id(prefix, data):
    return prefix + hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:24]


def clean(value, length=1000):
    return html.unescape(re.sub(r'<[^>]*>', '', str(value or '')))[:length].strip()


def safe_url(value):
    try:
        p = urlsplit(value)
        if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password:
            return ''
        return urlunsplit((p.scheme, p.netloc, p.path, p.query, ''))[:2000]
    except ValueError:
        return ''


class ToolError(Exception):
    def __init__(self, code, retryable=False):
        self.code, self.retryable = code, retryable


class Budget:
    def __init__(self, settings):
        self.settings = settings
        self.external = 0
        self.articles = 0
        self.codes = set()

    def spend_external(self):
        if self.external >= self.settings.external_requests:
            raise ToolError('external_request_limit')
        self.external += 1


class NewsSource:
    """Bounded public data cache. No conversation, owner, auth header or model reply is cached."""
    def __init__(self, settings, transport=None):
        self.settings, self.transport = settings, transport
        self.cache, self.pending = {}, {}

    async def page(self, query, page, budget):
        s = self.settings
        key = (s.naver_mode, query, page, s.model, PROMPT_VERSION)
        now = time.monotonic()
        for k, (at, _) in list(self.cache.items()):
            if now - at > 60:
                del self.cache[k]
        if key in self.cache:
            return self.cache[key][1]
        if key in self.pending:
            return await asyncio.shield(self.pending[key])
        if len(self.pending) >= 16:
            raise ToolError('news_busy', True)
        async def fetch():
            if not s.naver_id or not s.naver_secret:
                raise ToolError('news_not_configured')
            budget.spend_external()
            hub = s.naver_mode == 'hub'
            url = 'https://naverapihub.apigw.ntruss.com/search/v1/news' if hub else 'https://openapi.naver.com/v1/search/news.json'
            headers = ({'X-NCP-APIGW-API-KEY-ID': s.naver_id, 'X-NCP-APIGW-API-KEY': s.naver_secret} if hub
                       else {'X-Naver-Client-Id': s.naver_id, 'X-Naver-Client-Secret': s.naver_secret})
            try:
                async with httpx.AsyncClient(transport=self.transport, timeout=8, follow_redirects=False, trust_env=False) as client:
                    async with client.stream('GET', url, headers=headers,
                                             params={'query': query, 'display': 10, 'start': 1 + (page - 1) * 10, 'sort': 'date'}) as response:
                        if response.status_code != 200:
                            raise ToolError('news_auth_error' if response.status_code in (401, 403) else 'news_provider_error', response.status_code >= 500)
                        body = b''
                        async for chunk in response.aiter_bytes():
                            body += chunk
                            if len(body) > 256_000:
                                raise ToolError('news_response_too_large')
                        raw = json.loads(body)
                if not isinstance(raw.get('items'), list) or len(raw['items']) > 10:
                    raise ToolError('news_invalid_response')
                data = {'items': raw['items'], 'total': int(raw.get('total', 0)),
                        'fetched_at': datetime.now(KST).isoformat()}
                if len(self.cache) >= 256:
                    self.cache.pop(next(iter(self.cache)))
                self.cache[key] = (time.monotonic(), data)
                return data
            except (httpx.HTTPError, json.JSONDecodeError, ValueError, TypeError):
                raise ToolError('news_connection_failed', True) from None
        task = asyncio.create_task(fetch())
        self.pending[key] = task
        try:
            return await task
        finally:
            self.pending.pop(key, None)


class ResearchTools:
    def __init__(self, settings, news=None, now=None, context=None, screener=None):
        self.settings, self.news = settings, news or NewsSource(settings)
        self.now = now or datetime.now(KST)
        self.budget = Budget(settings)
        self.screener = screener or SCREENER
        self.rsi_snapshots = {}
        self.evidence, self.resolved, self.coverage, self.result_sets = {}, {}, [], []
        # Only server-owned messages of this room are passed here. Historical sources remain dated.
        for message in context or []:
            for source in (message.get('answer') or {}).get('sources', [])[:60]:
                if isinstance(source, dict) and str(source.get('id', '')).startswith(('n_', 'r_')):
                    self.evidence[source['id']] = {**source, 'historical': True}
                    if source.get('code') and source.get('name'):
                        self.resolved[source['code']] = {'code': source['code'], 'name': source['name']}
            for result_set in (message.get('answer') or {}).get('result_sets', [])[:3]:
                for source in result_set.get('items', [])[:20]:
                    if str(source.get('id', '')).startswith('r_'):
                        self.evidence[source['id']] = {**source, 'historical': True}
                        self.resolved[source['code']] = source
        self.fresh_ids = set()

    def connect(self):
        path = Path(self.settings.lab_path)
        if not self.settings.lab_path or not path.is_file():
            raise ToolError('lab_data_not_ready')
        db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        deadline = time.monotonic() + self.settings.tool_seconds
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        return db

    async def execute(self, name, arguments):
        if name not in TOOL_MODELS:
            return self.error('forbidden_tool')
        try:
            args = TOOL_MODELS[name].model_validate_json(arguments)
        except ValueError:
            return self.error('invalid_arguments')
        try:
            method = getattr(self, name)
            value = await asyncio.wait_for(method(args), self.settings.tool_seconds)
            value.update(queried_at=self.now.isoformat(), conditions=args.model_dump(), retryable=False)
            value.setdefault('warnings', [])
            value.setdefault('source', 'ATLAS read-only research')
            value.setdefault('as_of', self.now.isoformat())
            return value
        except ToolError as exc:
            return self.error(exc.code, exc.retryable)
        except asyncio.TimeoutError:
            return self.error('tool_timeout', True)
        except ValueError as exc:
            return self.error('calendar_unverified' if str(exc) == 'calendar_unverified' else 'data_unavailable')
        except (sqlite3.Error, OSError):
            return self.error('data_unavailable')

    def error(self, code, retryable=False):
        return {'status': 'error', 'code': code, 'retryable': retryable, 'items': [],
                'queried_at': self.now.isoformat(), 'as_of': None, 'source': 'ATLAS', 'warnings': []}

    def remember(self, value):
        self.evidence[value['id']] = value
        self.fresh_ids.add(value['id'])

    async def resolve_symbol(self, args):
        with closing(self.connect()) as db:
            q = args.query.strip()
            rows = db.execute('SELECT code,name,market FROM symbols WHERE active=1 AND (code=? OR name=?) LIMIT 6', (q, q)).fetchall()
            if not rows:
                rows = db.execute('SELECT code,name,market FROM symbols WHERE active=1 AND instr(name,?)>0 ORDER BY code LIMIT 6', (q,)).fetchall()
            items = [dict(row) for row in rows]
        if len(items) == 1:
            self.resolved[items[0]['code']] = items[0]
        return {'status': 'success' if len(items) == 1 else 'partial' if items else 'empty',
                'items': items, 'ambiguous': len(items) > 1,
                'warnings': ['실험실 수집 종목 목록 기준. 국내 전체 종목 목록이 아닐 수 있습니다.']}

    async def get_market_context(self, args):
        try:
            data = market_context(self.now, self.settings.calendar_through)
        except ValueError:
            raise ToolError('calendar_unverified')
        return {'status': 'success', 'items': [data], 'source': data['calendar_source']}

    async def screen_rsi(self, args):
        ctx = market_context(self.now, self.settings.calendar_through)
        cutoff = ctx['latest_completed']
        try:
            key = (args.market, cutoff)
            # Keep pagination/ranking stable within one analysis. A new analysis can
            # resume public partial progress, but page 2 must not silently rerank page 1.
            if key not in self.rsi_snapshots:
                self.rsi_snapshots[key] = await asyncio.to_thread(self.screener.scan, self.settings, args.market, cutoff)
            scan = self.rsi_snapshots[key]
        except ScanBusy:
            raise ToolError('screen_busy', True)
        except ScanChanged:
            raise ToolError('screen_data_changed', True)
        except FileNotFoundError:
            raise ToolError('lab_data_not_ready')
        matches = []
        for row in scan['items']:
            if row['rsi'] <= args.threshold:
                item = {**row, 'rsi': round(row['rsi'], 4), 'date': cutoff, 'source': 'lab.sqlite / Wilder RSI(14)', 'as_of': cutoff,
                        'queried_at': self.now.isoformat(), 'data_read_at': scan['data_read_at'], 'data_version': scan['data_version']}
                item['excerpt'] = f"{item['name']}({item['code']}) RSI(14)={item['rsi']}, 확정 일봉 {cutoff}"
                item['id'] = stable_id('r_', item)
                matches.append(item)
        matches.sort(key=lambda row: (row['rsi'], row['code']))
        page = matches[(args.page - 1) * args.page_size:args.page * args.page_size]
        for item in page:
            self.remember(item)
            self.resolved[item['code']] = item
        coverage = {'kind': 'rsi', 'market': args.market, 'universe': scan['universe'], 'scanned': scan['scanned'],
                    'valid': scan['valid'], 'excluded': scan['excluded'], 'not_scanned': scan['universe'] - scan['scanned'],
                    'matches': len(matches), 'page': args.page, 'page_size': args.page_size,
                    'returned': len(page), 'as_of': cutoff, 'sort': 'RSI ascending, code ascending',
                    'data_version': scan['data_version'], 'data_read_at': scan['data_read_at'],
                    'calendar_source': ctx['calendar_source'], 'cache_hit': scan['cache_hit'], 'resumed': scan.get('resumed', 0)}
        self.coverage.append(coverage)
        self.result_sets.append({'id': stable_id('s_', [coverage, [x['id'] for x in page]]), 'items': page, 'coverage': coverage})
        return {'status': 'partial' if scan['excluded'] or coverage['not_scanned'] else 'success' if page else 'empty',
                'result_id': stable_id('s_', [coverage, [x['id'] for x in page]]), 'items': page,
                'coverage': coverage, 'as_of': cutoff, 'source': 'lab.sqlite / Wilder RSI(14)',
                'warnings': ['수집된 일부 종목 대상, 실시간 지표 아님. 저장된 최대 2,000봉 전체로 Wilder 초기화.', ctx['warning']]}

    async def get_stock_news(self, args):
        if args.code not in self.resolved:
            raise ToolError('symbol_not_resolved')
        budget = self.budget
        if args.code not in budget.codes and len(budget.codes) >= self.settings.symbols:
            raise ToolError('symbol_limit')
        if budget.articles + 10 > self.settings.articles:
            raise ToolError('article_limit')
        budget.codes.add(args.code)
        ctx = market_context(self.now, self.settings.calendar_through)
        period = ctx[args.period] if args.period in ('today', 'overnight') else {'start': (self.now - timedelta(days=7)).isoformat(), 'end': self.now.isoformat()}
        start, end = (datetime.fromisoformat(period[k]) for k in ('start', 'end'))
        symbol = self.resolved[args.code]
        query = (symbol['name'] + ' ' + args.keyword.strip()).strip()
        raw = await self.news.page(query, args.page, budget)
        budget.articles += len(raw['items'])
        items, seen, rejected, events = [], set(), 0, set()
        for row in raw['items']:
            url = safe_url(row.get('originallink')) or safe_url(row.get('link'))
            try:
                published = parsedate_to_datetime(row.get('pubDate', ''))
            except (ValueError, TypeError):
                rejected += 1
                continue
            if not published.tzinfo or not start <= published <= end:
                rejected += 1
                continue
            title, snippet = clean(row.get('title'), 300), clean(row.get('description'))
            event_key = re.sub(r'\W', '', title).lower()
            if not url or url in seen or event_key in events:
                continue
            seen.add(url); events.add(event_key)
            item = {'id': stable_id('n_', [url, title, snippet, published.isoformat()]),
                    'code': args.code, 'name': symbol['name'], 'title': title, 'snippet': snippet,
                    'url': url, 'published_at': published.astimezone(KST).isoformat(),
                    'collected_at': raw['fetched_at'], 'as_of': self.now.isoformat(),
                    'source': 'Naver News (' + self.settings.naver_mode + ')', 'scope': 'title_and_snippet',
                    'period': period, 'session_segment': 'overnight' if published < datetime.fromisoformat(ctx['market_open']) else 'intraday',
                    'relevance': 'direct_candidate' if symbol['name'] in title + snippet else 'indirect_or_unrelated_review_required'}
            self.remember(item)
            items.append(item)
        coverage = {'kind': 'news', 'code': args.code, 'name': symbol['name'], 'period': period,
                    'query': query, 'page': args.page, 'fetched': len(raw['items']), 'accepted': len(items),
                    'filtered': rejected, 'provider_total_unfiltered': raw['total'],
                    'more_available': args.page < 3 and (args.page * 10) < raw['total'], 'as_of': self.now.isoformat()}
        self.coverage.append(coverage)
        return {'status': 'success' if items else 'empty', 'items': items, 'coverage': coverage,
                'source': 'Naver News', 'warnings': ['제목·검색 요약만 확보. 제공 시각은 원문 발행 시각과 다를 수 있음. 동일 사건은 추가 판단 필요. 검색 전체를 조사한 결과가 아닙니다.']}

    async def get_news_details(self, args):
        if any(i not in self.evidence or not i.startswith('n_') for i in args.article_ids):
            raise ToolError('unknown_article_id')
        return {'status': 'success', 'items': [self.evidence[i] for i in args.article_ids],
                'warnings': ['확보된 제목·요약만 반환합니다. 원문 조회 도구가 아닙니다.']}
