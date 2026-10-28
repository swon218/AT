import asyncio
from datetime import datetime
import hmac
import os
import sqlite3
import time
from urllib.parse import urlsplit
from fastapi import FastAPI, Header, HTTPException, Request
import httpx
from .config import Settings
from .market import KST, calendar
from .provider import OpenAIProvider
from .runner import Runner
from .schemas import RunInput
from .tools import NewsSource, ResearchTools
from .screen_models import StockScreen
from .screen_engine import SCREEN_ENGINE, ScreenSnapshotChanged
from .screener import ScanBusy, ScanChanged, FingerprintUnavailable


def create_app(settings=None, provider=None, tools_factory=None, callback=None, screen_engine=None, clock=None):
    s = settings or Settings.from_env()
    if len(s.internal_secret) < 32:
        # Healthy process with explicit unavailable state; never accepts unauthenticated requests.
        configured = False
    else:
        configured = True
    url = urlsplit(s.callback_url)
    if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost') or url.path != '/api/internal/agent/events':
        raise ValueError('Callback must use the fixed loopback event endpoint')
    if (provider is not None or clock is not None) and os.getenv('NODE_ENV') == 'production':
        raise ValueError('Injected providers are test-only')
    model = provider or OpenAIProvider(s)
    news = NewsSource(s)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    recent = {'state': 'configured' if s.api_key else 'api_key_missing', 'last_success_at': None, 'error_code': None}
    runs, active = {}, set()
    screens = screen_engine or SCREEN_ENGINE

    async def authorize(x_atlas_internal: str = Header(default='')):
        if not configured or not hmac.compare_digest(x_atlas_internal, s.internal_secret):
            raise HTTPException(401, 'internal_auth_required')

    @app.middleware('http')
    async def size_limit(request: Request, call_next):
        if int(request.headers.get('content-length', '0')) > 128000:
            return __import__('starlette.responses', fromlist=['JSONResponse']).JSONResponse({'detail': 'body_too_large'}, status_code=413)
        return await call_next(request)

    @app.get('/health')
    async def health(x_atlas_internal: str = Header(default='')):
        await authorize(x_atlas_internal)
        return {'ok': True, 'provider': recent, 'model': s.model, 'key_configured': bool(s.api_key),
                'lab_ready': bool(s.lab_path and __import__('pathlib').Path(s.lab_path).is_file()),
                'news_configured': bool(s.naver_id and s.naver_secret)}

    @app.post('/screen')
    async def screen(body: StockScreen, x_atlas_internal: str = Header(default='')):
        await authorize(x_atlas_internal)
        try:
            # Independent from model enablement, API keys, billing and guest AI quota.
            return await asyncio.wait_for(asyncio.to_thread(screens.execute, s, body, clock() if clock else datetime.now(KST)), s.tool_seconds)
        except ScreenSnapshotChanged:
            raise HTTPException(409, 'snapshot_changed') from None
        except ScanChanged:
            raise HTTPException(409, 'screen_data_changed') from None
        except ScanBusy:
            raise HTTPException(503, 'screen_busy') from None
        except FingerprintUnavailable:
            raise HTTPException(503, 'screen_snapshot_unverified') from None
        except (asyncio.TimeoutError, FileNotFoundError):
            raise HTTPException(503, 'screen_data_not_ready') from None
        except sqlite3.OperationalError:
            # A missing/unreadable WAL-index is infrastructure unavailability,
            # never an empty stock result or permission to retry read/write.
            raise HTTPException(503, 'screen_data_not_ready') from None
        except ValueError:
            raise HTTPException(503, 'calendar_unverified') from None

    @app.get('/screen/meta')
    async def screen_meta(x_atlas_internal: str = Header(default='')):
        await authorize(x_atlas_internal)
        def read_meta():
            import sqlite3
            from pathlib import Path
            from contextlib import closing
            path = Path(s.lab_path).resolve()
            if not s.lab_path or not path.is_file(): raise FileNotFoundError()
            with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
                db.execute('PRAGMA query_only=ON'); db.execute('BEGIN')
                end = time.monotonic() + 3
                db.set_progress_handler(lambda: int(time.monotonic() > end), 10000)
                total = db.execute('SELECT count(*) FROM symbols WHERE active=1').fetchone()[0]
                latest = db.execute('SELECT max((SELECT max(date) FROM candles c WHERE c.code=s.code)) FROM symbols s WHERE active=1').fetchone()[0]
                sources = [r[0] for r in db.execute('SELECT DISTINCT source FROM symbols WHERE active=1')]
                quality = bool(db.execute("SELECT 1 FROM sqlite_master WHERE name='current_candle_quality' AND type='view'").fetchone())
            from .market import market_context
            context = market_context(clock() if clock else datetime.now(KST), s.calendar_through)
            return {'available': True, 'universe': total, 'latest_bar': latest, 'cutoff': context['latest_completed'],
                    'sources': sources, 'quality_ready': quality, 'timeframe': '1d', 'max_conditions': 8}
        try:
            return await asyncio.to_thread(read_meta)
        except Exception:
            raise HTTPException(503, 'screen_data_not_ready') from None

    @app.post('/run')
    async def run(body: RunInput, x_atlas_internal: str = Header(default='')):
        await authorize(x_atlas_internal)
        if not s.api_key and provider is None:
            raise HTTPException(503, 'api_key_missing')
        for key, (at, _) in list(runs.items()):
            if time.monotonic() - at > 300:
                del runs[key]
        if body.request_id in runs:
            return runs[body.request_id][1]
        if body.request_id in active or len(active) >= 8:
            raise HTTPException(409, 'run_busy')
        active.add(body.request_id)
        async def emit(step):
            if step['kind'] == 'model' and step['status'] == 'success':
                recent.update(state='recent_success', last_success_at=datetime.now(KST).isoformat(), error_code=None)
            if callback:
                await callback(body.request_id, step)
            else:
                # Fixed callback; no URL or auth context controlled by the model.
                async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
                    response = await client.post(s.callback_url, headers={'X-Atlas-Internal': s.internal_secret},
                                                 json={'request_id': body.request_id, 'step': step})
                    response.raise_for_status()
                    if not response.json().get('accepted'):
                        raise RuntimeError('Request no longer active')
        try:
            tools = tools_factory() if tools_factory else ResearchTools(s, news=news, context=body.context)
            result = await Runner(s, model, tools, emit).run(body.question, body.context)
            if result['error_code'] in ('authentication_error', 'permission_error', 'billing_error', 'billing_or_rate_limit', 'connection_failed', 'provider_error'):
                recent['state'] = result['error_code']
            recent['error_code'] = result['error_code']
            if len(runs) >= 128:
                runs.pop(next(iter(runs)))
            runs[body.request_id] = (time.monotonic(), result)
            return result
        except Exception:
            recent.update(state='connection_failed', error_code='execution_interrupted')
            # Never return raw exceptions/SDK responses; Node conservatively records unknown usage.
            raise HTTPException(502, 'execution_interrupted') from None
        finally:
            active.discard(body.request_id)

    return app


app = create_app()
