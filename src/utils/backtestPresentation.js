export const BACKTEST_ASSUMPTIONS = {
  costs: '수수료·매도세·슬리피지는 반영하지 않은 모의 계산 결과입니다. 실제 거래 결과와 차이가 있을 수 있습니다.',
  execution: '확정 일봉 종가에서 진입 조건을 판단하고 다음 거래일 시가로 매수합니다. 익절·손절은 실제 매수가를 기준으로 전량 청산하며, 같은 날 다시 매수하지 않습니다.',
  ambiguous: '일봉 내 순서 불명확 · 손절 우선 가정. 고가·저가가 양쪽 기준에 닿으면 손절을 먼저 적용합니다. 갭은 기준 가격이 아닌 실제 시가로 계산하며, 실제 체결 복원이 아닙니다.',
}

export function backtestEventLabel(event) {
  return event.type === 'entry' ? '진입' : event.type === 'take-profit' ? '익절' : event.type === 'stop-loss' ? '손절' : '청산'
}

export function backtestExport({ run, symbol, quality, candles }) {
  return { engineVersion:run.result.version, exportedAt:new Date().toISOString(), assumptions:BACKTEST_ASSUMPTIONS,
    costs:{fee:0,sellTax:0,slippage:0}, symbol, quality:quality || null, strategyName:run.name,
    indicators:run.indicators, settings:run.settings, result:run.result, candles }
}

// One engine event stays one marker, including entry+exit on the same day.
export function backtestChartMarkers(events = [], palette = {}) {
  return events.filter(event => ['entry', 'take-profit', 'stop-loss'].includes(event.type))
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.date.localeCompare(b.event.date) || a.index - b.index)
    .map(({ event }) => ({ id: `backtest-${event.id}`, time: event.date, position: event.type === 'entry' ? 'belowBar' : 'aboveBar',
      shape: event.type === 'entry' ? 'arrowUp' : event.type === 'take-profit' ? 'arrowDown' : 'square',
      color: event.type === 'entry' ? (palette.price || '#8d99ff') : event.type === 'take-profit' ? (palette.up || '#ef5368') : (palette.down || '#4b86ff'),
      text: `${backtestEventLabel(event)} #${event.tradeId}${event.ambiguous ? ' *' : ''}`,
    }))
}
