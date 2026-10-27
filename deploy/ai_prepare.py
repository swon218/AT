"""Provision only AI env entries; preserve all existing configuration. Never prints secrets."""
import argparse
import os
from pathlib import Path
import re
import secrets


def read_env(path):
    text = path.read_text(encoding='utf-8') if path.exists() else ''
    pairs = dict(re.findall(r'^([A-Z_][A-Z0-9_]*)=(.*)$', text, re.M))
    return text, {k: v.strip().strip('\"\'') for k, v in pairs.items()}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--node-env', type=Path, required=True)
    p.add_argument('--ai-env', type=Path, required=True)
    p.add_argument('--origin', required=True)
    p.add_argument('--lab-db', required=True)
    p.add_argument('--node-port', type=int, default=3000)
    p.add_argument('--ai-port', type=int, default=8010)
    args = p.parse_args()
    if args.node_env.resolve() == args.ai_env.resolve():
        raise SystemExit('Separate Node and AI environment files are required')
    if not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]+)?', args.origin):
        raise SystemExit('A verified HTTPS frontend origin is required')
    node_text, node = read_env(args.node_env)
    ai_text, ai = read_env(args.ai_env)
    allowed = {'OPENAI_API_KEY', 'OPENAI_MODEL', 'LAB_DB_PATH', 'AI_INTERNAL_SECRET', 'AI_CALLBACK_URL', 'AI_NAVER_MODE', 'AI_NAVER_CLIENT_ID', 'AI_NAVER_CLIENT_SECRET'}
    if any(k not in allowed and not k.startswith('AI_') for k in ai):
        raise SystemExit('AI env contains non-AI entries: split environment files manually')
    first, second = node.get('AI_INTERNAL_SECRET'), ai.get('AI_INTERNAL_SECRET')
    if first and second and first != second:
        raise SystemExit('Existing internal secrets differ: inspect manually')
    internal = first or second or secrets.token_urlsafe(48)
    cookie = node.get('AI_GUEST_COOKIE_SECRET') or secrets.token_urlsafe(48)
    if min(len(internal), len(cookie)) < 32:
        raise SystemExit('Existing AI secrets must contain at least 32 characters')
    node_values = {'AI_ENABLED': 'true', 'AI_PUBLIC_ORIGIN': args.origin, 'AI_INTERNAL_URL': f'http://127.0.0.1:{args.ai_port}',
                   'AI_INTERNAL_SECRET': internal, 'AI_GUEST_COOKIE_SECRET': cookie, 'AI_GUEST_DAYS': '7'}
    ai_values = {'OPENAI_MODEL': 'gpt-6-luna', 'OPENAI_API_KEY': '', 'AI_INTERNAL_SECRET': internal,
                 'AI_CALLBACK_URL': f'http://127.0.0.1:{args.node_port}/api/internal/agent/events',
                 'LAB_DB_PATH': args.lab_db, 'AI_NAVER_MODE': 'legacy', 'AI_NAVER_CLIENT_ID': '', 'AI_NAVER_CLIENT_SECRET': ''}
    for path, text, previous, values in [(args.node_env, node_text, node, node_values), (args.ai_env, ai_text, ai, ai_values)]:
        changed = False
        for key, value in values.items():
            if key in previous and not previous[key] and value:
                text = re.sub(r'^' + re.escape(key) + r'=.*$', key + '=' + value, text, flags=re.M)
                changed = True
        additions = ''.join(f'{key}={value}\n' for key, value in values.items() if key not in previous)
        if additions or changed:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(path.name + '.ai-tmp')
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as out:
                    out.write(text + ('\n' if text and not text.endswith('\n') else '') + additions)
                os.replace(temporary, path)
            finally:
                if temporary.exists(): temporary.unlink()
    print('AI env entries prepared; existing values preserved. Verify service paths/ownership; no secret values printed.')


if __name__ == '__main__': main()
