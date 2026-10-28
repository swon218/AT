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


class Operand(Strict):
    kind: Literal['constant', 'metric']
    value: float | None = Field(ge=-1e12, le=1e12)
    metric: Metric | None
    factor: float = Field(ge=0.01, le=1000)

    @model_validator(mode='after')
    def valid_operand(self):
        if self.kind == 'constant' and (self.value is None or self.metric is not None or self.factor != 1):
            raise ValueError('invalid_constant_operand')
        if self.kind == 'metric' and (self.metric is None or self.value is not None):
            raise ValueError('invalid_metric_operand')
        return self


class Condition(Strict):
    left: Metric
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
