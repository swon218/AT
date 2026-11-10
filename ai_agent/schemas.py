from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from .screen_models import IndicatorLookup, StockScreen


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


class AlertProposal(Strict):
    action: Literal['create', 'edit', 'edit_saved']
    rule_id: str | None = Field(pattern=r'^[0-9a-fA-F-]{36}$')
    symbol: str | None = Field(max_length=60)
    basis: Literal['price', 'previous_close', 'same', 'unsupported']
    kind: Literal['price_touch', 'rise_gte', 'fall_lte'] | None
    threshold: float | None = Field(ge=0, le=1_000_000_000)
    expires_on: str | None = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    frequency: Literal['once', 'repeat'] | None


class AlertStatus(Strict):
    symbol: str | None = Field(max_length=60)


TOOL_MODELS = {'resolve_symbol': Resolve, 'get_market_context': Context, 'screen_rsi': Screen,
               'screen_stocks': StockScreen, 'get_stock_indicators': IndicatorLookup, 'get_stock_news': News, 'get_news_details': Details,
               'get_alert_editor': Context, 'propose_alert': AlertProposal, 'get_alert_status': AlertStatus}
METRIC_GUIDE = ('Legacy metrics use period/slow/signal/multiplier (unused fields=1; defaults RSI14, BB20/2, MACD12/26/9). '
                'Advanced metrics use null for unused fields and for defaults: ATR/ATR% 14; DMI/ADX DI14, ADX smoothing14; '
                'stoch K/D 14/3/3; OBV raw has no period, obv_ma SMA20; MFI14; CCI20 HLC3; Supertrend ATR10 ×3. '
                'Specify any user parameters. ATR% uses percent points. Supertrend direction is +1 up or -1 down, '
                'supertrend_flip is +1 up flip, -1 down flip, 0 unchanged. ADX is strength; OBV/MFI are not investor money flow.')

DESCRIPTIONS = {
    'screen_stocks': 'Shared daily screener over collected completed candles. Build 1..8 conditions with all/any. Right constant: value set, metric=null, factor=1; right metric: value=null, metric set, factor scales it. Crosses compare previous and latest values. For an up Supertrend flip use supertrend_flip >= 1. snapshot_id=null first; reuse for later pages. Disclose the effective parameters, exclusions and as-of date. ' + METRIC_GUIDE,
    'get_stock_indicators': 'Read 1..8 indicator outputs for ONE stock code from the same completed daily data and engine as screen_stocks. Resolve a stock name first; clarify ambiguity. Use for values, not for market-wide screens or general explanations. No live/intraday values or browser chart settings. Cite each evidence excerpt and disclose parameters, exclusions and date. ' + METRIC_GUIDE,
    'resolve_symbol': 'Resolve an exact Korean stock name/code against the collected catalog. Multiple matches require clarification; partial catalog is disclosed.',
    'get_market_context': 'Server KST time, XKRX calendar, overnight/today boundaries and latest completed daily session. No realtime price.',
    'screen_rsi': 'Read-only local daily SQLite; calculate Wilder RSI(14) on completed bars. Sorted RSI ascending, code ascending. Limited collected universe, quality exclusions and pagination. Never realtime.',
    'get_stock_news': 'Search Naver for a previously resolved/screened code, bounded time period and page. Title/snippet only; optional short event keyword, no URL access. Read actual previous results before choosing codes or another page.',
    'get_news_details': 'Read only already acquired article IDs from this room/run. Returns the acquired title/snippet, never fabricated full text or arbitrary URL contents.',
    'get_alert_editor': 'Read the current unsaved draft for this room, the member watchlist and saved conditions with their rule IDs. Use before editing or resolving ambiguity.',
    'propose_alert': 'Propose an unsaved draft, even if the named stock is outside the watchlist. Create uses a symbol name/code and rule_id=null; an unlisted stock requires a user confirmation card. Edit amends this room draft. Edit_saved requires an exact symbol and rule_id from get_alert_editor, null if ambiguous. Pass null for unchanged fields. Use price_touch for a two-way KRW target; clarify one-sided price requests. Use previous_close and positive magnitude for bare % fall/rise. Frequency defaults to once; repeat only when requested, null preserves existing. Null expiration on create proposes 7 days. Never add, save, start, cancel or send.',
    'get_alert_status': 'Request a server-authored view of persisted alert rules and recent delivery history for the authenticated member. Use exact symbol or null for all.',
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
    alert_context: dict | None = None


class Step(Strict):
    seq: int = Field(ge=1, le=100)
    kind: Literal['model', 'tool', 'validation']
    name: str = Field(max_length=60)
    status: Literal['started', 'success', 'empty', 'partial', 'error']
    arguments: dict
    result: dict
    elapsed_ms: int = Field(ge=0)
