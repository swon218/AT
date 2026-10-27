import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    model: str = 'gpt-6-luna'
    api_key: str = ''
    internal_secret: str = ''
    callback_url: str = 'http://127.0.0.1:3000/api/internal/agent/events'
    lab_path: str = ''
    naver_mode: str = 'legacy'
    naver_id: str = ''
    naver_secret: str = ''
    rounds: int = 8
    tool_calls: int = 12
    external_requests: int = 8
    symbols: int = 6
    articles: int = 60
    screen_symbols: int = 3000
    tokens: int = 40000
    output_tokens: int = 2048
    seconds: int = 120
    tool_seconds: int = 12
    corrections: int = 2
    # Conservative, configurable budget rates, NOT a promise of actual billing.
    input_usd_per_million: float = 1.0
    output_usd_per_million: float = 4.0
    max_usd: float = 0.25
    calendar_through: str = '2026-12-31'

    @classmethod
    def from_env(cls):
        if os.getenv('NODE_ENV') == 'production' and any(
            value and (key.startswith(('KIWOOM_', 'TOSS_', 'NH_', 'KB_', 'kiwoom_', 'toss_')) or key == 'ATLAS_CREDENTIAL_ENCRYPTION_KEY')
            for key, value in os.environ.items()
        ):
            raise ValueError('Broker secrets must not be passed to the AI process')
        result = cls()
        values = {}
        for name, field in cls.__dataclass_fields__.items():
            key = {'model': 'OPENAI_MODEL', 'api_key': 'OPENAI_API_KEY',
                   'internal_secret': 'AI_INTERNAL_SECRET', 'callback_url': 'AI_CALLBACK_URL',
                   'lab_path': 'LAB_DB_PATH', 'naver_mode': 'AI_NAVER_MODE',
                   'naver_id': 'AI_NAVER_CLIENT_ID', 'naver_secret': 'AI_NAVER_CLIENT_SECRET'}.get(name, 'AI_' + name.upper())
            raw = os.getenv(key)
            if raw is not None:
                default = getattr(result, name)
                values[name] = type(default)(raw)
        settings = cls(**values)
        for name in ('rounds', 'tool_calls', 'external_requests', 'symbols', 'articles', 'screen_symbols',
                     'tokens', 'output_tokens', 'seconds', 'tool_seconds', 'corrections',
                     'input_usd_per_million', 'output_usd_per_million', 'max_usd'):
            if getattr(settings, name) <= 0:
                raise ValueError('Invalid AI limit: ' + name)
        if settings.rounds > 12 or settings.tool_calls > 24 or settings.seconds > 120:
            raise ValueError('AI hard limit exceeded')
        if settings.naver_mode not in ('legacy', 'hub'):
            raise ValueError('Invalid AI_NAVER_MODE')
        if os.getenv('AI_PROVIDER', 'openai') != 'openai':
            raise ValueError('Only the OpenAI provider is permitted in the service')
        return settings
