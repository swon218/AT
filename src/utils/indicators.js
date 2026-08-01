export const INDICATOR_CATALOG = [
  {
    id: 'ma', name: '이동평균선 MA', shortName: 'MA', description: '일정 기간의 종가 평균을 연결해 가격의 추세 방향을 확인합니다.',
    help: {
      overview: '일정 기간의 종가 평균을 선으로 연결한 추세 지표입니다. SMA는 모든 가격에 같은 비중을 주고, EMA는 최근 가격에 더 큰 비중을 주어 변화에 빠르게 반응합니다.',
      inputs: ['종류: 단순이동평균 SMA 또는 지수이동평균 EMA를 선택합니다.', '단기 기간: 빠르게 움직이는 평균선의 봉 개수이며 기본값은 5입니다.', '장기 기간: 큰 추세를 확인하는 평균선의 봉 개수이며 기본값은 20입니다.', '단기선·장기선 색상: 차트에 표시되는 두 이동평균선의 색상입니다.'],
      reading: '단기선이 장기선을 위로 교차하면 골든크로스, 아래로 교차하면 데드크로스라고 합니다. 두 선의 방향과 가격이 선 위 또는 아래에 있는지도 함께 확인합니다.',
      automation: '골든크로스를 매수 후보, 데드크로스를 매도 후보 조건으로 구성할 수 있습니다. 실제 주문 전에는 서버에서 완성된 봉과 교차 여부를 다시 확인해야 합니다.',
      caution: '과거 가격을 평균한 후행 지표이므로 신호가 늦을 수 있습니다. 횡보 구간에서는 잦은 교차로 잘못된 신호가 발생할 수 있어 거래량이나 다른 추세 지표와 함께 확인하는 편이 좋습니다.',
    },
  },
  {
    id: 'bollinger', name: '볼린저밴드', shortName: '볼린저밴드', description: '이동평균을 중심으로 표준편차 범위를 표시해 변동성과 과열 구간을 확인합니다.',
    help: {
      overview: '이동평균선을 중심으로 위아래에 표준편차를 반영한 밴드를 표시합니다. 가격의 상대적인 위치와 시장 변동성이 커지는지 또는 작아지는지 확인하는 지표입니다.',
      inputs: ['기간: 중심선과 표준편차 계산에 사용할 봉의 개수입니다. 기본값은 20입니다.', '표준편차: 상단선과 하단선의 폭을 결정하는 배수입니다. 기본값은 2입니다.', '상단선·중심선·하단선 색상: 각 밴드 선의 표시 색상입니다.'],
      reading: '밴드가 넓어지면 변동성이 커지고, 좁아지면 변동성이 줄어드는 흐름으로 봅니다. 가격이 상단선이나 하단선에 닿았다는 사실만으로 매수·매도를 확정하지는 않습니다.',
      automation: '밴드 돌파, 밴드 안쪽 재진입, 밴드 폭 확대 등을 다른 조건과 조합해 후보 신호로 사용할 수 있습니다. 자동매매에서는 봉 마감 여부와 거래량 조건을 함께 검증하는 것이 안전합니다.',
      caution: '강한 추세에서는 가격이 상단선이나 하단선을 따라 계속 움직일 수 있습니다. 단순히 상단선은 매도, 하단선은 매수로 해석하면 손실 위험이 커질 수 있습니다.',
    },
  },
  {
    id: 'volume-ma', name: '거래량 이동평균', shortName: '거래량 MA', description: '일정 기간의 평균 거래량을 표시해 거래량 증가와 감소 흐름을 확인합니다.',
    help: {
      overview: '일정 기간의 거래량을 평균 내 거래량 막대 위에 선으로 표시합니다. 현재 거래량이 평소보다 많은지 적은지 비교할 때 사용합니다.',
      inputs: ['기간: 평균 거래량 계산에 사용할 봉의 개수입니다. 기본값은 20입니다.', '선 색상: 거래량 영역에 표시되는 평균선의 색상입니다.'],
      reading: '현재 거래량이 이동평균보다 크게 증가하면 시장 참여가 평소보다 활발하다는 뜻으로 볼 수 있습니다. 가격 움직임과 거래량 증가가 함께 나타나는지를 확인하는 것이 중요합니다.',
      automation: '가격 돌파 조건에 거래량이 이동평균의 일정 배수 이상이라는 필터를 더해 신호의 신뢰도를 보완할 수 있습니다.',
      caution: '장 시작과 마감 시간, 공시나 뉴스가 있는 날에는 거래량이 일시적으로 급증할 수 있습니다. 거래량만으로 가격 방향을 판단할 수는 없습니다.',
    },
  },
  {
    id: 'rsi', name: 'RSI', shortName: 'RSI', description: '최근 상승과 하락 강도를 0~100으로 나타내 과매수·과매도 구간을 판단합니다.',
    help: {
      overview: '최근 봉들의 상승폭과 하락폭을 비교해 0부터 100 사이로 나타내는 모멘텀 지표입니다. 가격 움직임이 한쪽으로 지나치게 쏠렸는지 확인할 때 사용합니다.',
      inputs: ['기간: RSI 계산에 사용할 봉의 개수입니다. 기본값은 14입니다.', '하단값: 과매도 참고 기준입니다. 일반적으로 30을 사용합니다.', '상단값: 과매수 참고 기준입니다. 일반적으로 70을 사용합니다.', 'RSI선·상단선·하단선 색상: 차트에 표시되는 각 선의 색상입니다.'],
      reading: 'RSI가 하단값 근처로 내려가면 단기적으로 많이 밀린 상태, 상단값 근처로 올라가면 많이 오른 상태로 해석합니다. 기준선 진입뿐 아니라 기준선 밖에서 다시 안으로 돌아오는 움직임도 함께 봅니다.',
      automation: '현재 자동매매에서는 RSI가 이전 봉에서 하단값보다 위에 있다가 최신 봉에서 하단값 이하로 내려오는 순간 등을 조건 신호로 구성할 수 있습니다.',
      caution: '강한 상승·하락 추세에서는 RSI가 과매수·과매도 구간에 오래 머물 수 있습니다. 다른 추세 지표와 가격 범위 조건을 함께 확인해야 합니다.',
    },
  },
  {
    id: 'macd', name: 'MACD', shortName: 'MACD', description: '단기·장기 지수이동평균의 차이와 시그널선을 이용해 추세 전환을 확인합니다.',
    help: {
      overview: '빠른 지수이동평균과 느린 지수이동평균의 차이를 MACD선으로 나타내고, 그 평균인 시그널선과 비교해 추세와 모멘텀 변화를 확인합니다.',
      inputs: ['단기 기간: 빠른 지수이동평균 기간이며 기본값은 12입니다.', '장기 기간: 느린 지수이동평균 기간이며 기본값은 26입니다.', '시그널 기간: MACD선의 평균 기간이며 기본값은 9입니다.', 'MACD선·시그널선·상승·하락 색상: 선과 히스토그램의 표시 색상입니다.'],
      reading: 'MACD선이 시그널선을 위로 교차하면 상승 모멘텀 강화, 아래로 교차하면 하락 모멘텀 강화의 참고 신호로 봅니다. 0선의 위치와 히스토그램의 확대·축소도 함께 확인합니다.',
      automation: 'MACD선과 시그널선의 교차를 진입·청산 후보 조건으로 사용할 수 있습니다. 직전 봉과 현재 완성 봉의 값을 비교해 실제 교차가 발생했는지 확인해야 합니다.',
      caution: '후행성이 있으며 횡보 구간에서는 교차 신호가 반복될 수 있습니다. 추세 방향과 거래량 같은 추가 조건 없이 단독으로 사용하면 잘못된 신호가 많아질 수 있습니다.',
    },
  },
]

export const INDICATOR_DEFAULTS = {
  ma: { type: 'SMA', shortPeriod: 5, shortColor: '#f4c542', longPeriod: 20, longColor: '#4b86ff' },
  bollinger: { period: 20, multiplier: 2, upperColor: '#a98bff', middleColor: '#7589a8', lowerColor: '#a98bff' },
  'volume-ma': { period: 20, color: '#f4c542' },
  rsi: { period: 14, lower: 30, upper: 70, color: '#35cf9c', upperColor: '#ff5c69', lowerColor: '#4b86ff' },
  macd: { fast: 12, slow: 26, signal: 9, macdColor: '#4b86ff', signalColor: '#ffb84d', positiveColor: '#ff5c69', negativeColor: '#397ff5' },
}

export function createIndicatorConfig(id) {
  return { id, ...structuredClone(INDICATOR_DEFAULTS[id]) }
}

export function indicatorDisplayName(config) {
  if (config.id === 'ma') return `${config.type || 'SMA'} ${config.shortPeriod || config.period || 5}, ${config.longPeriod || 20}`
  if (config.id === 'bollinger') return `볼린저 ${config.period}, ${config.multiplier}`
  if (config.id === 'volume-ma') return `거래량 MA ${config.period}`
  if (config.id === 'rsi') return `RSI ${config.period}`
  if (config.id === 'macd') return `MACD ${config.fast}, ${config.slow}, ${config.signal}`
  return config.id
}

export function calculateSma(candles, period = 20, field = 'close') {
  let sum = 0
  return candles.flatMap((candle, index) => {
    sum += Number(candle[field] || 0)
    if (index >= period) sum -= Number(candles[index - period][field] || 0)
    return index >= period - 1 ? [{ time: candle.time, value: sum / period }] : []
  })
}

export function calculateEma(candles, period = 20, field = 'close') {
  if (candles.length < period) return []
  const multiplier = 2 / (period + 1)
  let ema = candles.slice(0, period).reduce((sum, candle) => sum + Number(candle[field] || 0), 0) / period
  const result = [{ time: candles[period - 1].time, value: ema }]
  for (let index = period; index < candles.length; index += 1) {
    ema = ((Number(candles[index][field] || 0) - ema) * multiplier) + ema
    result.push({ time: candles[index].time, value: ema })
  }
  return result
}

export function calculateBollinger(candles, period = 20, multiplier = 2) {
  const middle = []
  const upper = []
  const lower = []
  for (let index = period - 1; index < candles.length; index += 1) {
    const window = candles.slice(index - period + 1, index + 1)
    const mean = window.reduce((sum, candle) => sum + candle.close, 0) / period
    const variance = window.reduce((sum, candle) => sum + ((candle.close - mean) ** 2), 0) / period
    const deviation = Math.sqrt(variance) * multiplier
    const time = candles[index].time
    middle.push({ time, value: mean })
    upper.push({ time, value: mean + deviation })
    lower.push({ time, value: Math.max(0, mean - deviation) })
  }
  return { middle, upper, lower }
}

export function calculateRsi(candles, period = 14) {
  if (candles.length <= period) return []
  let gains = 0
  let losses = 0
  for (let index = 1; index <= period; index += 1) {
    const change = candles[index].close - candles[index - 1].close
    gains += Math.max(0, change)
    losses += Math.max(0, -change)
  }
  let averageGain = gains / period
  let averageLoss = losses / period
  const result = []
  const pushValue = (index) => {
    const value = averageLoss === 0 ? 100 : 100 - (100 / (1 + averageGain / averageLoss))
    result.push({ time: candles[index].time, value })
  }
  pushValue(period)
  for (let index = period + 1; index < candles.length; index += 1) {
    const change = candles[index].close - candles[index - 1].close
    averageGain = ((averageGain * (period - 1)) + Math.max(0, change)) / period
    averageLoss = ((averageLoss * (period - 1)) + Math.max(0, -change)) / period
    pushValue(index)
  }
  return result
}

function calculateEmaPoints(points, period) {
  if (points.length < period) return []
  const multiplier = 2 / (period + 1)
  const result = []
  let ema = points.slice(0, period).reduce((sum, point) => sum + point.value, 0) / period
  result.push({ time: points[period - 1].time, value: ema })
  for (let index = period; index < points.length; index += 1) {
    ema = ((points[index].value - ema) * multiplier) + ema
    result.push({ time: points[index].time, value: ema })
  }
  return result
}

export function calculateMacd(candles, fast = 12, slow = 26, signalPeriod = 9) {
  const closePoints = candles.map((candle) => ({ time: candle.time, value: candle.close }))
  const fastMap = new Map(calculateEmaPoints(closePoints, fast).map((point) => [String(point.time), point.value]))
  const slowEma = calculateEmaPoints(closePoints, slow)
  const macd = slowEma.flatMap((point) => {
    const fastValue = fastMap.get(String(point.time))
    return fastValue == null ? [] : [{ time: point.time, value: fastValue - point.value }]
  })
  const signal = calculateEmaPoints(macd, signalPeriod)
  const signalMap = new Map(signal.map((point) => [String(point.time), point.value]))
  const histogram = macd.flatMap((point) => {
    const signalValue = signalMap.get(String(point.time))
    return signalValue == null ? [] : [{ time: point.time, value: point.value - signalValue }]
  })
  return { macd, signal, histogram }
}
