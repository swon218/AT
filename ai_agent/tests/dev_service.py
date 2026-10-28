"""Explicit local test harness. NEVER a production entrypoint or env-selectable provider."""
import argparse
from dataclasses import replace
import os
from pathlib import Path
import tempfile
import uvicorn
from ai_agent.app import create_app
from ai_agent.config import Settings
from ai_agent.tools import NewsSource, ResearchTools
from .fixtures import AdaptiveProvider, NOW, make_lab, news_transport

if __name__ == '__main__':
    if os.getenv('NODE_ENV') != 'test' or os.getenv('ATLAS_TEST_HARNESS') != '1':
        raise RuntimeError('Explicit test environment required')
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--callback-port', type=int, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as directory:
        settings = Settings(api_key='fixture-not-a-real-key', internal_secret='local-fixture-only-' * 3,
                            callback_url=f'http://127.0.0.1:{args.callback_port}/api/internal/agent/events',
                            lab_path=make_lab(Path(directory) / 'fixture.sqlite'))
        class PerRequestProvider:
            async def respond(self, items, instructions, tools, output_limit):
                # Select scenario from the TEST question only; production has no such code path.
                question = next(x['content'] for x in items if x.get('role') == 'user' and not x['content'].startswith('DATED ROOM HISTORY'))
                mode = 'stock_screen' if 'SMA' in question else 'composite' if '뉴스' in question and 'RSI' in question else 'news' if '뉴스' in question else 'rsi' if '이하' in question else 'concept'
                return await AdaptiveProvider(mode).respond(items, instructions, tools, output_limit)
        def tools_factory():
            return ResearchTools(settings, news=NewsSource(replace(settings, naver_id='fixture', naver_secret='fixture'), news_transport()), now=NOW)
        app = create_app(settings, provider=PerRequestProvider(), tools_factory=tools_factory, clock=lambda: NOW)
        uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False, log_level='warning')
