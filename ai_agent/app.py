import asyncio
from datetime import datetime
import hmac
import os
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


def create_app(settings=None, provider=None, tools_factory=None, callback=None):
    s = settings or Settings.from_env()
    if len(s.internal_secret) < 32:
        # Healthy process with explicit unavailable state; never accepts unauthenticated requests.
        configured = False
    else:
        configured = True
    url = urlsplit(s.callback_url)
    if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost') or url.path != '/api/internal/agent/events':
        raise ValueError('Callback must use the fixed loopback event endpoint')
    if provider is not None and os.getenv('NODE_ENV') == 'production':
        raise ValueError('Injected providers are test-only')
    model = provider or OpenAIProvider(s)
    news = NewsSource(s)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    recent = {'state': 'configured' if s.api_key else 'api_key_missing', 'last_success_at': None, 'error_code': None}
    runs, active = {}, set()

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
