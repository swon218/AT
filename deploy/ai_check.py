"""Read-only status probe. Never calls the model or outputs secrets/prompts."""
import argparse
import json
from pathlib import Path
import urllib.request
from ai_prepare import read_env

p = argparse.ArgumentParser()
p.add_argument('--ai-env', type=Path, required=True)
p.add_argument('--port', type=int, default=8010)
args = p.parse_args()
_, env = read_env(args.ai_env)
request = urllib.request.Request(f'http://127.0.0.1:{args.port}/health', headers={'X-Atlas-Internal': env.get('AI_INTERNAL_SECRET', '')})
try:
    with urllib.request.urlopen(request, timeout=8) as response:
        status = json.load(response)
    print(json.dumps(status, ensure_ascii=False, indent=2))
except Exception:
    raise SystemExit('AI health failed: check loopback port, service and matching internal authentication. No model call made.')
