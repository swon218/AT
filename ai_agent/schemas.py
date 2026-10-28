from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from .screen_models import StockScreen


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Resolve(Strict):
    query: str = Field(min_length=1, max_length=60)


class Context(Strict):
    pass


class Screen(Strict):
    threshold: float = Field(ge=0, le=100)
    market: Literal['ALL', 'KOSPI', 'KOSDAQ']
    page: int = Field(ge=1, le=100)
    page_size: int = Field(ge=1, le=20)


class News(Strict):
    code: str = Field(pattern=r'^[0-9][0-9A-Z]{5}$')
    period: Literal['overnight', 'today', 'recent7d']
    page: int = Field(ge=1, le=3)
    keyword: str = Field(max_length=40)


class Details(Strict):
    article_ids: list[str] = Field(min_length=1, max_length=5)


TOOL_MODELS = {'resolve_symbol': Resolve, 'get_market_context': Context, 'screen_rsi': Screen,
               'screen_stocks': StockScreen, 'get_stock_news': News, 'get_news_details': Details}
DESCRIPTIONS = {
    'screen_stocks': 'Shared manual/AI daily-stock screener over the collected lab DB. Build 1..8 conditions with all/any. Metrics: OHLCV, SMA/EMA/RSI(period), Bollinger bands(period,multiplier), volume_sma, MACD(period=fast,slow,signal). Unused period/slow/signal/multiplier=1. Right constant: value set, metric=null, factor=1; right metric: value=null, metric set, factor scales it. Crosses compare previous and latest completed bars. Default daily RSI14, Bollinger20/2, MACD12/26/9; clearly disclose chosen defaults, clarify material ambiguities (e.g. low touch vs close below). snapshot_id=null first, reuse returned snapshot_id for later pages. Conditions cannot access private accounts, execute SQL/code or place orders. Prefer this shared engine for indicator searches; actual coverage/exclusions are mandatory.',
    'resolve_symbol': 'Resolve an exact Korean stock name/code against the collected catalog. Multiple matches require clarification; partial catalog is disclosed.',
    'get_market_context': 'Server KST time, XKRX calendar, overnight/today boundaries and latest completed daily session. No realtime price.',
    'screen_rsi': 'Read-only local daily SQLite; calculate Wilder RSI(14) on completed bars. Sorted RSI ascending, code ascending. Limited collected universe, quality exclusions and pagination. Never realtime.',
    'get_stock_news': 'Search Naver for a previously resolved/screened code, bounded time period and page. Title/snippet only; optional short event keyword, no URL access. Read actual previous results before choosing codes or another page.',
    'get_news_details': 'Read only already acquired article IDs from this room/run. Returns the acquired title/snippet, never fabricated full text or arbitrary URL contents.',
}


def tools_schema():
    tools = []
    for name, model in TOOL_MODELS.items():
        parameters = model.model_json_schema()
        # Include an explicit empty required list for the zero-argument context tool too.
        parameters.setdefault('required', list(parameters.get('properties', {})))
        tools.append(dict(type='function', name=name, description=DESCRIPTIONS[name], parameters=parameters, strict=True))
    return tools


class Claim(Strict):
    text: str = Field(min_length=1, max_length=600)
    evidence_id: str = Field(min_length=1, max_length=100)
    excerpt: str = Field(min_length=4, max_length=300)
    stance: Literal['positive', 'negative', 'neutral']
    relation: Literal['direct', 'indirect']


class Final(Strict):
    kind: Literal['concept', 'research', 'clarification', 'insufficient']
    summary: str = Field(min_length=1, max_length=1800)
    sentiment: Literal['긍정 우세', '부정 우세', '혼재', '중립', '자료 부족']
    claims: list[Claim] = Field(max_length=12)
    uncertainty: list[str] = Field(min_length=1, max_length=8)


class RunInput(Strict):
    request_id: str = Field(pattern=r'^[0-9a-f-]{36}$')
    question: str = Field(min_length=1, max_length=6000)
    context: list[dict] = Field(max_length=12)


class Step(Strict):
    seq: int = Field(ge=1, le=100)
    kind: Literal['model', 'tool', 'validation']
    name: str = Field(max_length=60)
    status: Literal['started', 'success', 'empty', 'partial', 'error']
    arguments: dict
    result: dict
    elapsed_ms: int = Field(ge=0)
