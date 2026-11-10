"""Single isolated queue consumer; runs only admin-enqueued jobs. No startup evals."""
import asyncio
from dataclasses import replace
import json
import os
import signal
import httpx
from ai_agent.config import Settings
from .engine import evaluate, metadata


async def main():
    secret=os.getenv('AI_EVAL_SECRET','')
    if len(secret)<32: raise SystemExit('AI_EVAL_SECRET must contain at least 32 characters')
    # Fixed loopback API and bounded settings; no operator-supplied URL or DB path.
    settings=replace(Settings.from_env(),rounds=8,tool_calls=12,seconds=120,max_usd=0.25,tokens=40000)
    stopped=asyncio.Event()
    loop=asyncio.get_running_loop()
    for sig in (signal.SIGTERM,signal.SIGINT):
        try: loop.add_signal_handler(sig,stopped.set)
        except NotImplementedError: pass
    async with httpx.AsyncClient(base_url='http://127.0.0.1:3000/api/internal/eval/',headers={'X-Atlas-Eval':secret},timeout=15,trust_env=False) as client:
        async def call(action,body):
            r=await client.post(action,json=body); r.raise_for_status(); return r.json()
        while not stopped.is_set():
            try:
                info=metadata(settings)
                info.update(key_configured=bool(settings.api_key),worker_version='eval-v1')
                job=await call('claim',info)
                if job:
                    async def heartbeat():
                        while True:
                            await asyncio.sleep(20)
                            try: await call('heartbeat',{'id':job['id'],'lease':job['lease']})
                            except httpx.HTTPError: pass
                    beat=asyncio.create_task(heartbeat())
                    try:
                        try: result=await evaluate(job,settings)
                        except Exception:
                            # Never persist raw exceptions (could contain provider headers).
                            result={'grade':'fail','error':'eval_execution_failed','usage':{'status':'unknown'},'checks':[]}
                        body={'id':job['id'],'lease':job['lease'],'state':'failed' if result.get('status')=='failed' or result.get('error') else 'completed','result':result}
                        # A lost response can retry persistence, NEVER the paid model execution.
                        for attempt in range(3):
                            try: await call('finish',body); break
                            except httpx.HTTPError:
                                if attempt<2: await asyncio.sleep(2)
                    finally:
                        beat.cancel()
                        await asyncio.gather(beat,return_exceptions=True)
                    continue
            except (httpx.HTTPError,ValueError):
                pass
            try: await asyncio.wait_for(stopped.wait(),timeout=5)
            except asyncio.TimeoutError: pass


if __name__=='__main__': asyncio.run(main())
