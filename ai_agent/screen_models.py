"""Shared, bounded query contract for the screener UI and model function tool."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)


class Metric(Strict):
    name: Literal['open', 'high', 'low', 'close', 'volume', 'sma', 'ema', 'rsi',
                  'bb_lower', 'bb_middle', 'bb_upper', 'volume_sma', 'macd', 'macd_signal', 'macd_histogram']
    period: int = Field(ge=1, le=500)
    slow: int = Field(ge=1, le=500)
    signal: int = Field(ge=1, le=100)
    multiplier: float = Field(ge=0.1, le=10)

    @model_validator(mode='after')
    def meaningful_parameters(self):
        if self.name in ('open', 'high', 'low', 'close', 'volume') and self.period != 1:
            raise ValueError('price_period_must_be_one')
        if not self.name.startswith('macd') and (self.slow != 1 or self.signal != 1):
            raise ValueError('unused_macd_parameters')
        if self.name.startswith('macd') and self.period >= self.slow:
            raise ValueError('macd_fast_must_be_less_than_slow')
        if not self.name.startswith('bb_') and self.multiplier != 1:
            raise ValueError('unused_band_multiplier')
        return self


ADVANCED_PERIODS = {'atr': 14, 'atr_percent': 14, 'adx': 14, 'plus_di': 14, 'minus_di': 14,
                    'stoch_k': 14, 'stoch_d': 14, 'obv_ma': 20, 'mfi': 14, 'cci': 20,
                    'supertrend': 10, 'supertrend_direction': 10, 'supertrend_flip': 10}


class AdvancedMetric(Strict):
    name: Literal['atr', 'atr_percent', 'adx', 'plus_di', 'minus_di', 'stoch_k', 'stoch_d',
                  'obv', 'obv_ma', 'mfi', 'cci', 'supertrend', 'supertrend_direction', 'supertrend_flip']
    period: int | None = Field(ge=1, le=500)
    adx_period: int | None = Field(ge=1, le=500)
    k_smoothing: int | None = Field(ge=1, le=500)
    d_smoothing: int | None = Field(ge=1, le=500)
    average_type: Literal['SMA', 'EMA'] | None
    source: Literal['close', 'hlc3'] | None
    atr_multiplier: float | None = Field(ge=0.1, le=20)

    @model_validator(mode='after')
    def meaningful_parameters(self):
        defaults = {'period': ADVANCED_PERIODS.get(self.name), 'adx_period': 14 if self.name == 'adx' else None,
                    'k_smoothing': 3 if self.name.startswith('stoch_') else None,
                    'd_smoothing': 3 if self.name == 'stoch_d' else None,
                    'average_type': 'SMA' if self.name == 'obv_ma' else None,
                    'source': 'hlc3' if self.name == 'cci' else None,
                    'atr_multiplier': 3.0 if self.name.startswith('supertrend') else None}
        for field, default in defaults.items():
            value = getattr(self, field)
            if value is not None and default is None:
                raise ValueError('unused_indicator_parameter')
            if value is None and default is not None:
                setattr(self, field, default)
        return self


ScreenMetric = Metric | AdvancedMetric


class IndicatorLookup(Strict):
    code: str = Field(pattern=r'^[0-9][0-9A-Z]{5}$')
    metrics: list[ScreenMetric] = Field(min_length=1, max_length=8)


class Operand(Strict):
    kind: Literal['constant', 'metric']
    value: float | None = Field(ge=-1e12, le=1e12)
    metric: ScreenMetric | None
    factor: float = Field(ge=0.01, le=1000)

    @model_validator(mode='after')
    def valid_operand(self):
        if self.kind == 'constant' and (self.value is None or self.metric is not None or self.factor != 1):
            raise ValueError('invalid_constant_operand')
        if self.kind == 'metric' and (self.metric is None or self.value is not None):
            raise ValueError('invalid_metric_operand')
        return self


class Condition(Strict):
    left: ScreenMetric
    operator: Literal['lt', 'lte', 'gt', 'gte', 'crosses_above', 'crosses_below']
    right: Operand


class StockScreen(Strict):
    market: Literal['ALL', 'KOSPI', 'KOSDAQ']
    match: Literal['all', 'any']
    conditions: list[Condition] = Field(min_length=1, max_length=8)
    sort: Literal['code_asc', 'close_desc']
    page: int = Field(ge=1, le=300)
    page_size: int = Field(ge=1, le=20)
    snapshot_id: str | None = Field(pattern=r'^[0-9a-f]{24}$')
